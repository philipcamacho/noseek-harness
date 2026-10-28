/**
 * Noseek Harness Privacy Audit Gate
 *
 * Verifies that:
 * 1. Shipped profiles (acp, web, desktop, headless, sdk, sdk-minimal) in default
 *    composition have all 12 quarantined rows disabled, default routes never select
 *    deepseek-official, and plugin registries/probes have safe defaults.
 * 2. Hostile overrides (via home cordis.patch.yml or --patch overlays) cannot re-enable
 *    quarantined rows (quarantine layer overrides with disabled: true).
 * 3. Hostile attempts to select deepseek-official or inject blocked hosts are rejected
 *    by policy validation (assertNoseekPolicy).
 * 4. User selection of llm-pi-ai deepseek provider (including https://api.deepseek.com)
 *    composes cleanly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  assertNoseekPolicy as assertBootNoseekPolicy,
  composeEntries,
  findBlockedHostInValue,
  initProfile,
  isBlockedHost,
  loadProfile,
  NOSEEK_BLOCKED_HOST_SUFFIXES,
  NOSEEK_QUARANTINED_ROW_IDS,
  NoseekPolicyError,
  PROFILE_PATCH_FILENAME,
  readProfilePatches,
  resolveProfileDir,
  type ProfileContext,
} from '../packages/boot/app-boot/src/index.ts'
import { PROFILE_TEMPLATES } from '../packages/util/official-bundles/src/index.ts'
import { INSTALL_ANCHOR } from '../apps/cli/src/profile-boot.ts'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '../packages/llm/llm/src/index.ts'
import * as LlmPiAi from '../packages/llm/llm-pi-ai/src/index.ts'
import SystemPrompt, { renderPrompt } from '../packages/core/system-prompt/src/index.ts'

export {
  findBlockedHostInValue,
  isBlockedHost,
  NOSEEK_BLOCKED_HOST_SUFFIXES as BLOCKED_SUFFIXES,
  NoseekPolicyError as NoseekPolicyViolationError,
}

export const QUARANTINED_ROWS = new Set(NOSEEK_QUARANTINED_ROW_IDS)

/**
 * Assert that a list of composed entries conforms to the Noseek privacy policy.
 * @param entries - composed entry options to validate.
 */
export function assertNoseekPolicy(entries: readonly EntryOptions[]): void {
  assertBootNoseekPolicy('audit', entries)
}

/**
 * Compose a profile under a temporary home with optional home patch and overlays,
 * using `readProfilePatches` which injects the Noseek defaults and quarantine layers.
 * @param profileName - shipped profile name (`acp`, `web`, `desktop`, `headless`, `sdk`, `sdk-minimal`).
 * @param home - temporary harness home directory.
 * @param options - optional home patch YAML content and `--patch` overlays.
 * @returns composed entries and ordered patches.
 */
export function composeNoseekProfile(
  profileName: string,
  home: string,
  options?: {
    homePatchContent?: string
    overlays?: PatchOptions[]
  },
): { entries: EntryOptions[]; patches: PatchOptions[] } {
  const homePatchFile = join(home, PROFILE_PATCH_FILENAME)
  if (options?.homePatchContent !== undefined) {
    writeFileSync(homePatchFile, options.homePatchContent)
  } else {
    rmSync(homePatchFile, { force: true })
  }

  const templateName = profileName === 'desktop' ? 'web' : profileName
  const dir = resolveProfileDir(profileName, home)
  initProfile(dir, PROFILE_TEMPLATES[templateName]!.bundles)
  const profile = loadProfile('audit', templateName, INSTALL_ANCHOR, home)

  const ctx: ProfileContext = {
    name: profileName,
    dir,
    patchPath: profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    cwd: home,
    home,
    startedBundles: profile.layers.map(l => l.packageName),
    overlays: options?.overlays ?? [],
    telemetryDisabledEnv: '1',
  }

  const patches = readProfilePatches('audit', ctx, profile)
  const entries = composeEntries([patches])
  return { entries, patches }
}

interface ProfileAuditResult {
  profile: string
  defaultCompositionPassed: boolean
  quarantineOverrideProtected: boolean
  deepseekOfficialRejected: boolean
  blockedHostsRejected: boolean
  piAiDeepseekAccepted: boolean
  details: string[]
}

/**
 * Run the privacy audit across all shipped profiles.
 * @returns true when every check passes across all profiles.
 */

/** Recorded HTTP request on the loopback mock server. */
interface LoopbackRecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: any
}

/**
 * Phase 2 Verification Step:
 * 1. Verifies that a composed profile with llm-pi-ai configured for the deepseek route
 *    pointing its baseURL to a local loopback HTTP server (http://127.0.0.1:<port>/v1)
 *    completes a streaming LLM call using DEEPSEEK_API_KEY.
 * 2. Asserts that the captured HTTP request on the loopback server:
 *    - Contains NO x-deepseek-harness-* headers (x-deepseek-harness-user-id,
 *      x-deepseek-harness-session-id, x-deepseek-harness-compact).
 *    - Contains NO dsh_session_log or dsh_plugin_packages fields in the JSON request body.
 *    - Contains a user-agent header that starts with noseek-harness/ and does not contain
 *      deepseek-harness or deepseek-ai/deepseek-harness.
 *    - Contains an assembled system prompt in the request body with "Noseek Harness" and NO
 *      "DeepSeek Harness" or "deepseek-ai/deepseek-harness".
 * 3. Verifies that calling ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-chat' })
 *    on the composed runtime rejects with an error naming deepseek as the replacement.
 */
export async function verifyPhase2DeepseekLoopback(): Promise<{ passed: boolean; details: string[] }> {
  const details: string[] = []
  let passed = true

  const recordedRequests: LoopbackRecordedRequest[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      let body: any = raw
      try {
        body = JSON.parse(raw)
      } catch {}
      recordedRequests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(
        'data: {"id":"chatcmpl-phase2","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"Phase 2 verified"},"finish_reason":null}]}\n\n',
      )
      res.write(
        'data: {"id":"chatcmpl-phase2","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n',
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })

  const port = (server.address() as AddressInfo).port
  const tempHome = mkdtempSync(join(tmpdir(), 'noseek-audit-phase2-'))
  const previousKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key-phase2-audit'

  let ctx: Context | undefined
  try {
    const homePatchContent = [
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek',
      '    model: deepseek-chat',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      `        baseURL: http://127.0.0.1:${port}/v1`,
      '        apiKeyEnv: DEEPSEEK_API_KEY',
      '        models:',
      '          - id: deepseek-chat',
    ].join('\n')

    const { entries } = composeNoseekProfile('acp', tempHome, { homePatchContent })
    assertNoseekPolicy(entries)

    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const piAiEntry = entries.find(e => e.id === 'llm-pi-ai')
    await ctx.plugin(LlmPiAi, piAiEntry?.config)

    // Assemble system prompt from composed entries
    let systemText = ''
    const sysPromptEntry = entries.find(e => e.id === 'system-prompt')
    if (sysPromptEntry?.config) {
      await ctx.plugin(SystemPrompt, sysPromptEntry.config)
      ctx.systemPrompt.variable('model', () => 'deepseek-chat')
      ctx.systemPrompt.variable('provider', () => 'deepseek')
      const assembly = await ctx.systemPrompt.assemble({})
      systemText = renderPrompt(assembly)
    }

    // Check 1: prepareCall with deepseek-official rejects naming deepseek replacement
    let prepareCallRejectedAsExpected = false
    try {
      await ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-chat' })
    } catch (err: unknown) {
      const msg = (err as Error).message
      const code = (err as any).code
      if (code === 'NO_ADAPTER' && msg.includes('deepseek') && msg.includes('llm-pi-ai')) {
        prepareCallRejectedAsExpected = true
        details.push(`prepareCall('deepseek-official') rejected as expected: "${msg}"`)
      } else {
        throw new Error(`prepareCall('deepseek-official') failed with unexpected error (${code}): "${msg}"`)
      }
    }
    if (!prepareCallRejectedAsExpected) {
      throw new Error("prepareCall('deepseek-official') unexpectedly succeeded without error")
    }

    // Check 2: Streaming LLM call via deepseek provider using DEEPSEEK_API_KEY
    const chunks: any[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [
        ...(systemText ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemText }] }] : []),
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'Audit Phase 2 loopback stream' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const finishChunk = chunks.find(c => c.type === 'finish')
    if (finishChunk?.reason?.kind !== 'stop') {
      throw new Error(`Streaming LLM call failed to complete cleanly: ${JSON.stringify(finishChunk)}`)
    }
    details.push('Streaming call via llm-pi-ai deepseek completed successfully')

    // Check 3: Inspect captured request on loopback server
    if (recordedRequests.length === 0) {
      throw new Error('No HTTP request was received by the loopback server')
    }
    const captured = recordedRequests[0]!

    // Verify Authorization header
    if (captured.headers.authorization !== 'Bearer test-deepseek-key-phase2-audit') {
      throw new Error(`Authorization header mismatch: received "${captured.headers.authorization}"`)
    }
    details.push('Captured request authorization header verified with DEEPSEEK_API_KEY')

    // Verify NO x-deepseek-harness-* headers
    const forbiddenHeaderNames = [
      'x-deepseek-harness-user-id',
      'x-deepseek-harness-session-id',
      'x-deepseek-harness-compact',
    ]
    for (const h of forbiddenHeaderNames) {
      if (captured.headers[h] !== undefined) {
        throw new Error(`Forbidden header "${h}" was found on loopback request: ${captured.headers[h]}`)
      }
    }
    const allHarnessHeaders = Object.keys(captured.headers).filter(k => k.toLowerCase().startsWith('x-deepseek-harness'))
    if (allHarnessHeaders.length > 0) {
      throw new Error(`Found unexpected x-deepseek-harness-* headers: ${allHarnessHeaders.join(', ')}`)
    }
    details.push('Zero x-deepseek-harness-* headers confirmed on loopback request')

    // Verify NO dsh_session_log or dsh_plugin_packages in JSON request body
    if (captured.body && typeof captured.body === 'object') {
      if ('dsh_session_log' in captured.body) {
        throw new Error('Forbidden field "dsh_session_log" present in JSON request body')
      }
      if ('dsh_plugin_packages' in captured.body) {
        throw new Error('Forbidden field "dsh_plugin_packages" present in JSON request body')
      }
    }
    details.push('Zero dsh_session_log / dsh_plugin_packages in JSON request body confirmed')

    // Verify user-agent header
    const userAgent = (captured.headers['user-agent'] ?? '').toString()
    if (!userAgent.startsWith('noseek-harness/')) {
      throw new Error(`User-Agent header does not start with "noseek-harness/": "${userAgent}"`)
    }
    if (userAgent.includes('deepseek-harness') || userAgent.includes('deepseek-ai/deepseek-harness')) {
      throw new Error(`User-Agent header contains prohibited deepseek harness attribution: "${userAgent}"`)
    }
    details.push(`User-Agent header verified: "${userAgent}"`)

    // Verify system prompt / messages in captured body
    const bodyStr = JSON.stringify(captured.body)
    if (bodyStr.includes('DeepSeek Harness') || bodyStr.includes('deepseek-ai/deepseek-harness')) {
      throw new Error('Prohibited "DeepSeek Harness" branding found in request body')
    }
    if (!bodyStr.includes('Noseek Harness')) {
      throw new Error('Expected "Noseek Harness" prompt identity not found in request body')
    }
    details.push('Zero "DeepSeek Harness" and verified "Noseek Harness" in loopback turn body')
  } catch (err: unknown) {
    passed = false
    details.push(`Phase 2 Loopback verification FAILED: ${(err as Error).message}`)
  } finally {
    if (ctx) {
      await ctx.fiber.dispose().catch(() => {})
    }
    await new Promise<void>(resolve => server.close(() => resolve())).catch(() => {})
    rmSync(tempHome, { recursive: true, force: true })
    if (previousKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = previousKey
    } else {
      delete process.env.DEEPSEEK_API_KEY
    }
  }

  return { passed, details }
}

export async function runPrivacyAudit(): Promise<boolean> {
  const tempHome = mkdtempSync(join(tmpdir(), 'noseek-audit-home-'))
  const profiles = ['acp', 'web', 'desktop', 'headless', 'sdk', 'sdk-minimal']
  const results: ProfileAuditResult[] = []
  let allPassed = true

  console.log('='.repeat(70))
  console.log('NOSEEK HARNESS PRIVACY AUDIT')
  console.log('Auditing shipped profiles across default and hostile configurations...')
  console.log('='.repeat(70))

  try {
    for (const profileName of profiles) {
      const details: string[] = []
      let defaultCompositionPassed = true
      let quarantineOverrideProtected = true
      let deepseekOfficialRejected = true
      let blockedHostsRejected = true
      let piAiDeepseekAccepted = true

      // --- 1. Default Composition ---
      let defaultEntries: EntryOptions[] = []
      try {
        const { entries } = composeNoseekProfile(profileName, tempHome)
        defaultEntries = entries

        // Verify quarantined rows have disabled: true whenever present
        for (const id of QUARANTINED_ROWS) {
          const row = entries.find(e => e.id === id)
          if (row !== undefined && row.disabled !== true) {
            throw new Error(`Quarantined row "${id}" is present but disabled is not true`)
          }
        }

        // Verify ui-brand-official is disabled when present
        const brandRow = entries.find(e => e.id === 'ui-brand-official')
        if (brandRow !== undefined && brandRow.disabled !== true) {
          throw new Error('ui-brand-official is present but disabled is not true')
        }

        // Verify harness-dev-context is disabled when present
        const devContextRow = entries.find(e => e.id === 'harness-dev-context')
        if (devContextRow !== undefined && devContextRow.disabled !== true) {
          throw new Error('harness-dev-context is present but disabled is not true')
        }

        // Verify system-prompt configuration
        const sysPrompt = entries.find(e => e.id === 'system-prompt')
        if (sysPrompt === undefined) {
          throw new Error('system-prompt row is missing from profile composition')
        }
        const sysConf = (sysPrompt.config ?? {}) as Record<string, unknown>
        if (sysConf.includeHarnessIdentity !== false) {
          throw new Error(`system-prompt includeHarnessIdentity is not false in ${profileName}`)
        }
        const sysConfStr = JSON.stringify(sysConf)
        if (sysConfStr.includes('DeepSeek Harness') || sysConfStr.includes('deepseek-ai/deepseek-harness')) {
          throw new Error(`system-prompt config contains "DeepSeek Harness" in ${profileName}`)
        }

        // Verify routes never select deepseek-official
        const adm = entries.find(e => e.id === 'agent-default-model')
        if (adm?.config && (adm.config as Record<string, unknown>).provider === 'deepseek-official') {
          throw new Error('agent-default-model selects prohibited "deepseek-official"')
        }
        const acp = entries.find(e => e.id === 'acp')
        if (acp?.config && (acp.config as Record<string, unknown>).provider === 'deepseek-official') {
          throw new Error('acp selects prohibited "deepseek-official"')
        }
        const web = entries.find(e => e.id === 'web')
        if (web?.config && (web.config as Record<string, unknown>).searchProvider === 'deepseek-official') {
          throw new Error('web selects prohibited searchProvider "deepseek-official"')
        }

        // Verify registry defaults
        const pm = entries.find(e => e.id === 'plugin-manager')
        if (pm?.config) {
          const registries = (pm.config as Record<string, unknown>).fallbackRegistries
          if (!Array.isArray(registries) || registries.length > 0) {
            throw new Error('plugin-manager fallbackRegistries is not empty')
          }
        }
        const uipm = entries.find(e => e.id === 'ui-plugin-manager')
        if (uipm?.config) {
          const probe = (uipm.config as Record<string, unknown>).registryProbeEnabled
          if (probe !== false) {
            throw new Error('ui-plugin-manager registryProbeEnabled is not false')
          }
        }

        // Must satisfy assertNoseekPolicy
        assertNoseekPolicy(entries)
        details.push('Default composition: PASSED (all quarantined rows disabled, safe routes & registries, safe system prompt & brand)')
      } catch (err: unknown) {
        defaultCompositionPassed = false
        details.push(`Default composition: FAILED - ${(err as Error).message}`)
      }

      // --- 2. Hostile Quarantine Override (home patch + --patch overlay) ---
      try {
        const hostileHomePatch = `- id: session-log-deepseek\n  disabled: false\n`
        const hostileOverlays: PatchOptions[] = [
          { id: 'session-log-deepseek', disabled: false },
          { id: 'otel', disabled: false },
          { id: 'product-analytics', disabled: false },
        ]
        const { entries } = composeNoseekProfile(profileName, tempHome, {
          homePatchContent: hostileHomePatch,
          overlays: hostileOverlays,
        })
        for (const id of ['session-log-deepseek', 'otel', 'product-analytics']) {
          const row = entries.find(e => e.id === id)
          if (row !== undefined && row.disabled !== true) {
            throw new Error(`Quarantined row "${id}" was re-enabled by hostile overlay`)
          }
        }
        assertNoseekPolicy(entries)
        details.push('Quarantine protection: PASSED (hostile re-enable overridden by final quarantine layer)')
      } catch (err: unknown) {
        quarantineOverrideProtected = false
        details.push(`Quarantine protection: FAILED - ${(err as Error).message}`)
      }

      // --- 3. Hostile Selection of deepseek-official ---
      try {
        const hasAdm = defaultEntries.some(e => e.id === 'agent-default-model')
        const hostileAdmOverlay: PatchOptions = hasAdm
          ? { id: 'agent-default-model', config: { provider: 'deepseek-official' } }
          : { insert: [{ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official' } }] }

        let rejectedAdm = false
        try {
          const { entries } = composeNoseekProfile(profileName, tempHome, {
            overlays: [hostileAdmOverlay],
          })
          assertNoseekPolicy(entries)
        } catch {
          rejectedAdm = true
        }

        const hasWeb = defaultEntries.some(e => e.id === 'web')
        const hostileWebOverlay: PatchOptions = hasWeb
          ? { id: 'web', config: { searchProvider: 'deepseek-official' } }
          : { insert: [{ id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } }] }

        let rejectedWeb = false
        try {
          const { entries } = composeNoseekProfile(profileName, tempHome, {
            overlays: [hostileWebOverlay],
          })
          assertNoseekPolicy(entries)
        } catch {
          rejectedWeb = true
        }

        if (!rejectedAdm || !rejectedWeb) {
          throw new Error(`Failed to reject deepseek-official: admRejected=${rejectedAdm}, webRejected=${rejectedWeb}`)
        }
        details.push('Hostile route rejection: PASSED (attempting deepseek-official rejected by policy)')
      } catch (err: unknown) {
        deepseekOfficialRejected = false
        details.push(`Hostile route rejection: FAILED - ${(err as Error).message}`)
      }

      // --- 4. Hostile Blocked Hosts in Config ---
      try {
        const blockedUrls = [
          'https://dsh-otel-collector.deepseeksvc.com/v1/logs',
          'https://platform.deepseek.com',
          'https://trtgsjkv6r.feishu.cn',
        ]
        const hasAdm = defaultEntries.some(e => e.id === 'agent-default-model')
        const targetRowId = hasAdm
          ? 'agent-default-model'
          : (defaultEntries.find(e => !e.disabled && !QUARANTINED_ROWS.has(e.id))?.id ?? 'system-prompt')

        for (const url of blockedUrls) {
          let rejected = false
          try {
            const { entries } = composeNoseekProfile(profileName, tempHome, {
              overlays: [{ id: targetRowId, config: { endpointUrl: url } }],
            })
            assertNoseekPolicy(entries)
          } catch {
            rejected = true
          }
          if (!rejected) {
            throw new Error(`Blocked host URL "${url}" on row "${targetRowId}" was not rejected by policy`)
          }
        }
        details.push('Blocked host rejection: PASSED (blocked host URLs on enabled rows rejected by policy)')
      } catch (err: unknown) {
        blockedHostsRejected = false
        details.push(`Blocked host rejection: FAILED - ${(err as Error).message}`)
      }

      // --- 5. Valid BYOK Selection of llm-pi-ai deepseek Provider ---
      try {
        const hasAdm = defaultEntries.some(e => e.id === 'agent-default-model')
        const homePatchContent = [
          ...(hasAdm
            ? [
                '- id: agent-default-model',
                '  config:',
                '    provider: deepseek',
                '    model: deepseek-chat',
              ]
            : []),
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          '      deepseek:',
          '        baseUrl: https://api.deepseek.com',
          '        apiKeyEnv: DEEPSEEK_API_KEY',
        ].join('\n')

        const { entries } = composeNoseekProfile(profileName, tempHome, {
          homePatchContent,
        })
        assertNoseekPolicy(entries)
        details.push('Valid DeepSeek via pi-ai: PASSED (composed cleanly without policy error)')
      } catch (err: unknown) {
        piAiDeepseekAccepted = false
        details.push(`Valid DeepSeek via pi-ai: FAILED - ${(err as Error).message}`)
      }

      const profilePassed =
        defaultCompositionPassed &&
        quarantineOverrideProtected &&
        deepseekOfficialRejected &&
        blockedHostsRejected &&
        piAiDeepseekAccepted

      if (!profilePassed) {
        allPassed = false
      }

      results.push({
        profile: profileName,
        defaultCompositionPassed,
        quarantineOverrideProtected,
        deepseekOfficialRejected,
        blockedHostsRejected,
        piAiDeepseekAccepted,
        details,
      })
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }

  // --- Phase 2: llm-pi-ai DeepSeek Loopback & deepseek-official Refusal Verification ---
  console.log('\n--- PHASE 2: LLM-PI-AI DEEPSEEK LOOPBACK VERIFICATION ---')
  const phase2 = await verifyPhase2DeepseekLoopback()
  for (const d of phase2.details) {
    console.log(`  - ${d}`)
  }
  if (!phase2.passed) {
    allPassed = false
  }

  console.log('\n--- AUDIT RESULTS SUMMARY ---')
  console.log(`\nPhase 2 Loopback Gate -> ${phase2.passed ? 'PASS' : 'FAIL'}`)
  for (const d of phase2.details) {
    console.log(`  - ${d}`)
  }
  for (const r of results) {
    const status =
      r.defaultCompositionPassed &&
      r.quarantineOverrideProtected &&
      r.deepseekOfficialRejected &&
      r.blockedHostsRejected &&
      r.piAiDeepseekAccepted
        ? 'PASS'
        : 'FAIL'
    console.log(`\nProfile: [${r.profile.toUpperCase()}] -> ${status}`)
    for (const d of r.details) {
      console.log(`  - ${d}`)
    }
  }

  console.log('='.repeat(70))
  if (allPassed) {
    console.log('PRIVACY AUDIT SUCCESSFUL: All 6 profiles passed all privacy gates.')
    console.log('='.repeat(70))
  } else {
    console.error('PRIVACY AUDIT FAILED: One or more privacy gates did not pass.')
    console.log('='.repeat(70))
  }

  return allPassed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrivacyAudit()
    .then(passed => {
      process.exit(passed ? 0 : 1)
    })
    .catch(err => {
      console.error('Fatal error during privacy audit:', err)
      process.exit(1)
    })
}
