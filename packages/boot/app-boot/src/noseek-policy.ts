/**
 * Noseek Harness whitelabel and quarantine policy enforcement.
 * Zero telemetry, zero exfiltration, zero automatic calls to blocked infrastructure.
 * @module @deepseek-ai/dsh-app-boot/noseek-policy
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from './profile.ts'

/**
 * Row IDs quarantined by Noseek Harness.
 * These rows are forced disabled in the final quarantine layer and cannot be enabled.
 */
export const NOSEEK_QUARANTINED_ROW_IDS: readonly string[] = [
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'session-telemetry-otel',
  'otel',
  'desktop-product-telemetry',
  'product-analytics',
  'deepseek-account',
  'account-controller',
  'ui-settings-account',
  'llm-deepseek',
  'llm-deepseek-account',
  'skill-badge',
] as const

const NOSEEK_QUARANTINED_SET: ReadonlySet<string> = new Set(NOSEEK_QUARANTINED_ROW_IDS)

/**
 * Domain suffixes blocked by Noseek Harness across network egress and profile configuration.
 */
export const NOSEEK_BLOCKED_HOST_SUFFIXES: readonly string[] = [
  'deepseeksvc.com',
  'feishu.cn',
  'myqcloud.com',
  'deepseek.com',
] as const

/**
 * Exact host allowed as an exception for user-configured API endpoints.
 */
export const NOSEEK_ALLOWED_HOST = 'api.deepseek.com'

/**
 * Whether a profile context represents the synthetic `test-profile-bundle` harness
 * used by upstream unit tests to test isolated plugin modules.
 * @param context - optional profile context carrying `startedBundles`.
 * @returns true when the context is the synthetic `test-profile-bundle` unit test fixture.
 */
export function isSyntheticUnitTestBundle(
  context: { readonly startedBundles?: readonly string[] } | undefined,
): boolean {
  return context?.startedBundles?.length === 1 && context.startedBundles[0] === 'test-profile-bundle'
}

/**
 * Check if a normalized hostname is blocked.
 * @param rawHost - candidate hostname.
 * @returns true if the hostname matches a blocked suffix and is not the allowed exception.
 */
function isBlockedHostname(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase()
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host
  if (normalized === NOSEEK_ALLOWED_HOST) {
    return false
  }
  for (const suffix of NOSEEK_BLOCKED_HOST_SUFFIXES) {
    if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
      return true
    }
  }
  return false
}

/**
 * Scan a text string for URLs and candidate hostnames, returning the first blocked host found.
 * @param input - string to inspect.
 * @returns offending blocked host, or undefined if none found.
 */
function scanStringForBlockedHost(input: string): string | undefined {
  if (input.includes('://')) {
    try {
      const url = new URL(input)
      if (isBlockedHostname(url.hostname)) {
        return url.hostname
      }
    } catch {
      // Continue to regex scanning on invalid URL structure
    }
  }

  const matches = input.matchAll(
    /(?:https?:\/\/)?([a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?)+)/g,
  )
  for (const match of matches) {
    const candidate = match[1]?.toLowerCase()
    if (candidate && isBlockedHostname(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Recursively inspect a value (string, object, array, or JsExpr node) for blocked hosts.
 * @param value - value to inspect for blocked hostnames or URLs.
 * @param seen - set of visited objects to prevent cycles.
 * @returns the offending blocked host string if found, or undefined if none found.
 */
export function findBlockedHostInValue(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    return scanStringForBlockedHost(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return undefined
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return undefined
    seen.add(value)

    if (isJsExpr(value)) {
      const found = scanStringForBlockedHost(value.__jsExpr)
      if (found !== undefined) return found
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findBlockedHostInValue(item, seen)
        if (found !== undefined) return found
      }
      return undefined
    }

    for (const [key, prop] of Object.entries(value)) {
      const keyFound = scanStringForBlockedHost(key)
      if (keyFound !== undefined) return keyFound
      const propFound = findBlockedHostInValue(prop, seen)
      if (propFound !== undefined) return propFound
    }
  }
  return undefined
}

/**
 * Whether the input string contains or matches a blocked host.
 * @param input - a URL, hostname, or text containing hostnames.
 * @returns true if any blocked host suffix is present and not the allowed exception.
 */
export function isBlockedHost(input: string): boolean {
  return findBlockedHostInValue(input) !== undefined
}

/**
 * Flatten entries and nested groups in depth-first order.
 * @param entries - composed top-level entries.
 * @returns all entries including group members.
 */
function collectAllRows(entries: readonly EntryOptions[]): EntryOptions[] {
  const result: EntryOptions[] = []
  const visit = (rows: readonly EntryOptions[]): void => {
    for (const row of rows) {
      result.push(row)
      if ((row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group') && Array.isArray(row.config)) {
        visit(row.config as EntryOptions[])
      }
    }
  }
  visit(entries)
  return result
}

/**
 * Emits whole-config replacement patches for default configuration if the target row exists in bundle patches.
 * @param bundlePatches - patches contributed by profile bundles.
 * @returns default override patches for present rows.
 */
export function resolveNoseekDefaultsPatches(bundlePatches: readonly PatchOptions[]): PatchOptions[] {
  const composed = composeEntries([bundlePatches as PatchOptions[]])
  const allRows = collectAllRows(composed)
  const rowsById = new Map<string, EntryOptions>()
  for (const row of allRows) {
    rowsById.set(row.id, row)
  }

  const patches: PatchOptions[] = []

  if (rowsById.has('agent-default-model')) {
    patches.push({
      id: 'agent-default-model',
      config: { provider: '', model: '' },
    })
  }

  if (rowsById.has('acp')) {
    patches.push({
      id: 'acp',
      config: {},
    })
  }

  if (rowsById.has('web')) {
    patches.push({
      id: 'web',
      config: { fetchProvider: 'http' },
    })
  }

  if (rowsById.has('plugin-manager')) {
    patches.push({
      id: 'plugin-manager',
      config: { fallbackRegistries: [] },
    })
  }

  if (rowsById.has('ui-plugin-manager')) {
    patches.push({
      id: 'ui-plugin-manager',
      config: { registryProbeEnabled: false },
    })
  }

  const sensevoice = rowsById.get('speech-to-text-sensevoice')
  if (sensevoice !== undefined) {
    const existingConfig = (typeof sensevoice.config === 'object' && sensevoice.config !== null && !Array.isArray(sensevoice.config))
      ? (sensevoice.config as Record<string, unknown>)
      : {}
    patches.push({
      id: 'speech-to-text-sensevoice',
      config: {
        ...existingConfig,
        modelOrigins: ['https://huggingface.co'],
      },
    })
  }

  if (rowsById.has('ui-brand-official')) {
    patches.push({
      id: 'ui-brand-official',
      disabled: true,
    })
  }

  if (rowsById.has('harness-dev-context')) {
    patches.push({
      id: 'harness-dev-context',
      disabled: true,
    })
  }

  const systemPrompt = rowsById.get('system-prompt')
  if (systemPrompt !== undefined) {
    const existingConfig = (typeof systemPrompt.config === 'object' && systemPrompt.config !== null && !Array.isArray(systemPrompt.config))
      ? (systemPrompt.config as Record<string, unknown>)
      : {}
    const noseekOpener = 'You are an AI agent powered by Noseek Harness.'
    let personaPrefix: unknown
    if (typeof existingConfig.personaPrefix === 'string') {
      const trimmed = existingConfig.personaPrefix.trim()
      if (trimmed === '' || trimmed === noseekOpener) {
        personaPrefix = noseekOpener
      } else if (trimmed.startsWith(noseekOpener)) {
        personaPrefix = existingConfig.personaPrefix
      } else {
        personaPrefix = `${noseekOpener}\n\n${existingConfig.personaPrefix}`
      }
    } else if (existingConfig.personaPrefix !== undefined) {
      personaPrefix = existingConfig.personaPrefix
    } else {
      personaPrefix = noseekOpener
    }

    patches.push({
      id: 'system-prompt',
      config: {
        ...existingConfig,
        includeHarnessIdentity: false,
        personaPrefix,
      },
    })
  }

  return patches
}

/**
 * Generate quarantine patches forcing disabled: true for all quarantined row IDs present in patches.
 * @param patches - patch list to inspect for quarantined row IDs.
 * @returns patch options disabling each present quarantined row.
 */
export function resolveNoseekQuarantinePatches(patches: readonly PatchOptions[]): PatchOptions[] {
  const composed = composeEntries([patches as PatchOptions[]])
  const presentIds = new Set(collectAllRows(composed).map(row => row.id))
  const result: PatchOptions[] = []
  for (const id of NOSEEK_QUARANTINED_ROW_IDS) {
    if (presentIds.has(id)) {
      result.push({ id, disabled: true })
    }
  }
  return result
}

/**
 * Error thrown when a profile composition or modification violates Noseek policy.
 */
export class NoseekPolicyError extends Error {
  /**
   * @param message - diagnostic violation message.
   */
  constructor(message: string) {
    super(message)
    this.name = 'NoseekPolicyError'
  }
}

/**
 * Check whether a list of items appears to be a PatchOptions list rather than EntryOptions list.
 * @param items - candidate items.
 * @returns true if items is a PatchOptions array.
 */
function isPatchList(items: readonly (PatchOptions | EntryOptions)[]): items is readonly PatchOptions[] {
  if (items.length === 0) return false
  const first = items[0]
  if (first === undefined) return false
  if ('insert' in first && Array.isArray(first.insert)) return true
  if (!('name' in first) || typeof first.name !== 'string') return true
  return false
}

/**
 * Evaluates composed entries or patches against Noseek privacy and quarantine policies.
 * @param binName - diagnostic prefix for error messages.
 * @param patchesOrEntries - composed entries or patch list to validate.
 * @throws NoseekPolicyError if any policy violation is detected.
 */
export function assertNoseekPolicy(
  binName: string,
  patchesOrEntries: readonly PatchOptions[] | readonly EntryOptions[],
): void {
  let entries: readonly EntryOptions[]
  if (isPatchList(patchesOrEntries)) {
    const composed = composeEntries([[...patchesOrEntries]])
    if (composed.length === 0 && patchesOrEntries.length > 0) {
      entries = patchesOrEntries.flatMap((p) => {
        if (p.id === undefined) return []
        const rawConfig: unknown = p.config
        return [{
          id: p.id,
          name: (p as { name?: string }).name ?? p.id,
          ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
          ...(rawConfig !== undefined ? { config: rawConfig } : {}),
        }]
      })
    } else {
      entries = composed
    }
  } else {
    entries = patchesOrEntries
  }

  const violations: string[] = []
  const allRows = collectAllRows(entries)

  for (const row of allRows) {
    if (NOSEEK_QUARANTINED_SET.has(row.id) && row.disabled !== true) {
      violations.push(`${binName}: quarantined plugin row "${row.id}" cannot be enabled`)
    }
    if (row.disabled !== true) {
      if (typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)) {
        const conf = row.config as Record<string, unknown>
        if (conf.provider === 'deepseek-official') {
          violations.push(
            `${binName}: row "${row.id}" selects provider "deepseek-official"; use "deepseek" via llm-pi-ai instead`,
          )
        }
        if (conf.searchProvider === 'deepseek-official') {
          violations.push(
            `${binName}: row "${row.id}" selects searchProvider "deepseek-official"; use "deepseek" via llm-pi-ai instead`,
          )
        }
      }
      const blockedHost = findBlockedHostInValue(row.config)
      if (blockedHost !== undefined) {
        violations.push(`${binName}: row "${row.id}" config contains blocked host "${blockedHost}"`)
      }
    }
  }

  if (violations.length > 0) {
    throw new NoseekPolicyError(violations.join('\n'))
  }
}

/**
 * Assert that a plugin row ID is not in the quarantined list.
 * @param id - entry id to check.
 * @throws NoseekPolicyError if the plugin is quarantined.
 */
export function assertPluginNotQuarantined(id: string): void {
  if (NOSEEK_QUARANTINED_SET.has(id)) {
    throw new NoseekPolicyError(`quarantined plugin row "${id}" cannot be enabled`)
  }
}
