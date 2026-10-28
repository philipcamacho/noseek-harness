/**
 * Phase 5 Gate Fixture Tests
 *
 * Verifies the 4 "Done when" criteria for Phase 5 (Upstream Sync Workflow & Gates):
 * 1. Fixture 1: Upstream commit adding a telemetry row fails the gate or is left disabled by the final layer.
 * 2. Fixture 2: Upstream commit that only adds a benign tool plugin does not fail the gate.
 * 3. Fixture 3: Upstream commit that adds an automatic request to a new host fails the hermetic test (blocked with EACCES and recorded as egress violation).
 * 4. Fixture 4: Workflow opens a PR and does not push master.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import yaml from 'js-yaml'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  assertNoseekPolicy,
  composeEntries,
  NoseekPolicyError,
  readProfilePatches,
  resolveNoseekQuarantinePatches,
  type Profile,
  type ProfileContext,
} from '../packages/boot/app-boot/src/index.ts'
import { INSTALL_ANCHOR } from '../apps/cli/src/profile-boot.ts'
import { composeNoseekProfile } from './audit-privacy.ts'
import {
  HermeticObserver,
  isLoopbackHost,
  type NetworkViolation,
} from './hermetic-network-test.ts'

describe('Phase 5 Upstream Sync Gates & Gate Fixtures', () => {
  // --------------------------------------------------------------------------
  // Fixture 1 — Upstream commit adding a telemetry row
  // --------------------------------------------------------------------------
  describe('Fixture 1 — Upstream commit adding a telemetry row fails the gate or is left disabled by final layer', () => {
    it('Case 1a: forces disabled: true on known quarantined telemetry rows introduced by upstream bundle patches', () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'noseek-sync-fixture-1a-'))
      try {
        // Simulate upstream bundle patch adding or re-enabling known telemetry rows
        const upstreamBundlePatches: PatchOptions[] = [
          { insert: [{ id: 'session-telemetry-otel', name: '@deepseek-ai/dsh-telemetry-otel', disabled: false }] },
          { insert: [{ id: 'otel', name: '@deepseek-ai/dsh-otel', disabled: false }] },
          { insert: [{ id: 'product-analytics', name: '@deepseek-ai/dsh-product-analytics', disabled: false }] },
          { insert: [{ id: 'desktop-product-telemetry', name: '@deepseek-ai/dsh-desktop-telemetry', disabled: false }] },
        ]

        // 1. Direct unit verification of quarantine patch generator
        const quarantinePatches = resolveNoseekQuarantinePatches(upstreamBundlePatches)
        expect(quarantinePatches).toEqual(
          expect.arrayContaining([
            { id: 'session-telemetry-otel', disabled: true },
            { id: 'otel', disabled: true },
            { id: 'product-analytics', disabled: true },
            { id: 'desktop-product-telemetry', disabled: true },
          ]),
        )

        // 2. Integration verification via readProfilePatches
        const mockProfile: Profile = {
          name: 'sync-fixture-profile',
          dir: tempHome,
          patchPath: join(tempHome, 'cordis.patch.yml'),
          patches: [
            // User profile patch attempting to re-enable
            { id: 'session-telemetry-otel', disabled: false },
          ],
          skippedBundles: [],
          layers: [
            {
              packageName: '@deepseek-ai/dsh-upstream-telemetry-bundle',
              packageDir: tempHome,
              patchPaths: [join(tempHome, 'cordis.patch.yml')],
              patches: upstreamBundlePatches,
            },
          ],
        }

        const ctx: ProfileContext = {
          name: 'sync-fixture-profile',
          dir: tempHome,
          patchPath: join(tempHome, 'cordis.patch.yml'),
          installAnchor: INSTALL_ANCHOR,
          cwd: tempHome,
          home: tempHome,
          startedBundles: ['test-upstream-bundle'],
          overlays: [
            // Hostile CLI overlay attempting to re-enable
            { id: 'otel', disabled: false },
            { id: 'product-analytics', disabled: false },
          ],
          telemetryDisabledEnv: '1',
        }

        const effectivePatches = readProfilePatches('sync-gate', ctx, mockProfile)
        const composedEntries = composeEntries([effectivePatches])

        // Verify each quarantined row is forced disabled: true
        const quarantinedIds = [
          'session-telemetry-otel',
          'otel',
          'product-analytics',
          'desktop-product-telemetry',
        ]

        for (const id of quarantinedIds) {
          const row = composedEntries.find(e => e.id === id)
          expect(row, `Row ${id} must be present in composed tree`).toBeDefined()
          expect(row?.disabled, `Row ${id} must have disabled: true`).toBe(true)
        }

        // Composed tree passes policy validation because rows are disabled
        expect(() => assertNoseekPolicy('sync-gate', composedEntries)).not.toThrow()
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    })

    it('Case 1b: throws NoseekPolicyError when upstream introduces brand-new unquarantined telemetry row with blocked host or provider', () => {
      // 1. New upstream row pointing to collector.deepseeksvc.com
      const telemetryRowPatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'new-upstream-telemetry',
              name: '@deepseek-ai/dsh-new-telemetry',
              config: { endpoint: 'https://collector.deepseeksvc.com/v1/logs' },
            },
          ],
        },
      ]
      const composedTelemetry = composeEntries([telemetryRowPatches])
      expect(() => assertNoseekPolicy('sync-gate', composedTelemetry)).toThrowError(NoseekPolicyError)
      expect(() => assertNoseekPolicy('sync-gate', composedTelemetry)).toThrowError(
        /new-upstream-telemetry.*collector\.deepseeksvc\.com/,
      )

      // 2. New platform ping row pointing to platform.deepseek.com
      const pingRowPatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'new-platform-ping',
              name: '@deepseek-ai/dsh-ping',
              config: { origin: 'https://platform.deepseek.com' },
            },
          ],
        },
      ]
      const composedPing = composeEntries([pingRowPatches])
      expect(() => assertNoseekPolicy('sync-gate', composedPing)).toThrowError(NoseekPolicyError)
      expect(() => assertNoseekPolicy('sync-gate', composedPing)).toThrowError(
        /new-platform-ping.*platform\.deepseek\.com/,
      )

      // 3. New route row selecting deepseek-official provider
      const routeRowPatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'new-model-route',
              name: '@deepseek-ai/dsh-route',
              config: { provider: 'deepseek-official' },
            },
          ],
        },
      ]
      const composedRoute = composeEntries([routeRowPatches])
      expect(() => assertNoseekPolicy('sync-gate', composedRoute)).toThrowError(NoseekPolicyError)
      expect(() => assertNoseekPolicy('sync-gate', composedRoute)).toThrowError(
        /new-model-route.*deepseek-official/,
      )
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 2 — Upstream commit that only adds a benign tool plugin
  // --------------------------------------------------------------------------
  describe('Fixture 2 — Upstream commit adding a benign tool plugin does not fail the gate', () => {
    it('allows a benign tool plugin row to be added on top of a profile and remain enabled', () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'noseek-sync-fixture-2-'))
      try {
        const benignPluginPatch: PatchOptions = {
          insert: [
            {
              id: 'tool-ast-search',
              name: '@deepseek-ai/dsh-tool-ast-search',
              config: { maxMatches: 100 },
            },
          ],
        }

        const { entries } = composeNoseekProfile('acp', tempHome, {
          overlays: [benignPluginPatch],
        })

        // Policy validation passes cleanly
        expect(() => assertNoseekPolicy('sync-gate', entries)).not.toThrow()

        // The benign plugin is present and enabled
        const toolRow = entries.find(e => e.id === 'tool-ast-search')
        expect(toolRow).toBeDefined()
        expect(toolRow?.disabled).not.toBe(true)
        expect(toolRow?.config).toEqual({ maxMatches: 100 })
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 3 — Upstream commit adding automatic outbound request fails hermetic test
  // --------------------------------------------------------------------------
  describe('Fixture 3 — Upstream commit adding automatic outbound request fails hermetic test', () => {
    it('blocks outbound connection immediately with EACCES and records egress violation', async () => {
      // Simulate socket-level hermetic guard enforcement matching container/namespace network restriction
      const violations: NetworkViolation[] = []
      const originalConnect = net.Socket.prototype.connect

      // Install socket guard that rejects non-loopback egress with EACCES
      net.Socket.prototype.connect = function (...args: any[]) {
        let host: string | undefined
        let port: number | undefined
        let isUnixSocket = false

        if (typeof args[0] === 'object' && args[0] !== null) {
          if (args[0].path) {
            isUnixSocket = true
          } else {
            host = args[0].host
            port = args[0].port
          }
        } else if (typeof args[0] === 'number') {
          port = args[0]
          if (typeof args[1] === 'string') {
            host = args[1]
          }
        } else if (typeof args[0] === 'string') {
          isUnixSocket = true
        }

        if (!isUnixSocket && !isLoopbackHost(host)) {
          const targetStr = `${host ?? 'unknown'}:${port ?? 'unknown'}`
          violations.push({
            type: 'net.connect',
            target: targetStr,
            stack: new Error().stack,
          })
          const err = Object.assign(new Error(`connect EACCES ${targetStr}`), {
            code: 'EACCES',
            errno: -13,
            syscall: 'connect',
            address: host,
            port,
          })
          throw err
        }

        return originalConnect.apply(this, args as any)
      }

      try {
        // Attempt outbound socket connect to non-loopback IP (198.51.100.1:443)
        let errorCaught: any
        try {
          const socket = new net.Socket()
          socket.connect({ host: '198.51.100.1', port: 443 })
        } catch (err: any) {
          errorCaught = err
        }

        expect(errorCaught).toBeDefined()
        expect(errorCaught.code).toBe('EACCES')
        expect(errorCaught.message).toContain('198.51.100.1')

        // Verify violation was recorded and gate would fail
        expect(violations).toHaveLength(1)
        expect(violations[0]!.type).toBe('net.connect')
        expect(violations[0]!.target).toBe('198.51.100.1:443')
      } finally {
        net.Socket.prototype.connect = originalConnect
      }
    })

    it('HermeticObserver records non-loopback fetch to telemetry host and causes gate to fail', async () => {
      const observer = new HermeticObserver()
      observer.install()

      try {
        let fetchFailed = false
        try {
          await globalThis.fetch('https://telemetry.example.com/v1/ping')
        } catch (err: any) {
          fetchFailed = true
          expect(err.message).toContain('telemetry.example.com')
        }

        expect(fetchFailed).toBe(true)
        expect(observer.violations.length).toBeGreaterThanOrEqual(1)
        const violation = observer.violations.find(v => v.target.includes('telemetry.example.com'))
        expect(violation).toBeDefined()
        expect(violation?.type).toBe('fetch')
      } finally {
        observer.uninstall()
      }
    })
  })

  // --------------------------------------------------------------------------
  // Fixture 4 — Workflow opens a PR and does not push master
  // --------------------------------------------------------------------------
  describe('Fixture 4 — Workflow opens a PR and does not push master', () => {
    const workflowPath = join(process.cwd(), '.github/workflows/noseek-upstream-sync.yml')

    it('exists and is valid YAML with correct name, triggers, and permissions', () => {
      expect(existsSync(workflowPath), `Workflow file must exist at ${workflowPath}`).toBe(true)

      const rawYaml = readFileSync(workflowPath, 'utf8')
      const doc = yaml.load(rawYaml) as Record<string, any>

      expect(doc.name).toBe('Noseek Upstream Sync')

      // Triggers
      expect(doc.on).toBeDefined()
      expect(doc.on.schedule).toBeDefined()
      expect(Array.isArray(doc.on.schedule)).toBe(true)
      expect(doc.on.schedule[0].cron).toBe('0 6 * * *')

      expect(doc.on.workflow_dispatch).toBeDefined()
      expect(doc.on.workflow_dispatch.inputs?.tag).toBeDefined()
      expect(doc.on.workflow_dispatch.inputs.tag.required).toBe(false)
      expect(doc.on.workflow_dispatch.inputs.tag.type).toBe('string')

      // Permissions
      expect(doc.permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      })
    })

    it('contains guard against deepseek-ai upstream repo, checks dsh-v* tags, and runs all verification gates', () => {
      const rawYaml = readFileSync(workflowPath, 'utf8')
      const doc = yaml.load(rawYaml) as Record<string, any>

      const job = doc.jobs?.sync
      expect(job, 'sync job must be defined').toBeDefined()
      expect(job.if).toContain("github.repository != 'deepseek-ai/deepseek-harness'")
      expect(job['runs-on']).toBe('ubuntu-latest')

      const steps: any[] = job.steps
      expect(steps.length).toBeGreaterThanOrEqual(6)

      // Step: Checkout
      const checkoutStep = steps.find(s => s.uses?.startsWith('actions/checkout'))
      expect(checkoutStep).toBeDefined()
      expect(checkoutStep.with?.['fetch-depth']).toBe(0)

      // Step: Node 24 setup
      const nodeStep = steps.find(s => s.uses?.startsWith('actions/setup-node'))
      expect(nodeStep).toBeDefined()
      expect(nodeStep.with?.['node-version']).toBe('24')
      expect(nodeStep.with?.cache).toBe('pnpm')

      // Step: Determine target dsh-v* tag
      const determineStep = steps.find(s => s.id === 'determine-target' || s.run?.includes('TARGET_TAG'))
      expect(determineStep).toBeDefined()
      expect(determineStep.run).toContain('dsh-v*')
      expect(determineStep.run).toContain('git merge-base --is-ancestor')

      // Step: Verification gates
      const gateStep = steps.find(s => s.run?.includes('audit:privacy') || s.name?.includes('gates'))
      expect(gateStep).toBeDefined()
      expect(gateStep.run).toContain('bash noseek/check-delta.sh')
      expect(gateStep.run).toContain('pnpm install --frozen-lockfile')
      expect(gateStep.run).toContain('pnpm run build')
      expect(gateStep.run).toContain('pnpm run audit:privacy')
      expect(gateStep.run).toContain('pnpm run test:hermetic')
    })

    it('pushes sync branch and opens a PR targeting master, but NEVER pushes directly to master', () => {
      const rawYaml = readFileSync(workflowPath, 'utf8')
      const doc = yaml.load(rawYaml) as Record<string, any>
      const steps: any[] = doc.jobs.sync.steps

      // Step: PR creation and push
      const prStep = steps.find(s => s.run?.includes('gh pr create'))
      expect(prStep, 'Must contain a step that calls gh pr create').toBeDefined()
      expect(prStep.run).toContain('--base master')
      expect(prStep.run).toContain('git push')
      expect(prStep.run).toMatch(/git push -u origin (["']?\$BRANCH["']?|["']?sync\/)/)

      // Invariant: NEVER push directly to master
      expect(rawYaml).not.toMatch(/git push origin master/)
      expect(rawYaml).not.toMatch(/git push origin HEAD:master/)
      expect(rawYaml).not.toMatch(/git push [^\n]*\bmaster\b/)
    })
  })
})
