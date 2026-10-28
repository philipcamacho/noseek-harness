/**
 * Noseek policy unit tests: blocked host checking, defaults layer,
 * quarantine layer, boot refusal, and plugin manager assertions.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  NOSEEK_QUARANTINED_ROW_IDS,
  isBlockedHost,
  findBlockedHostInValue,
  resolveNoseekDefaultsPatches,
  resolveNoseekQuarantinePatches,
  NoseekPolicyError,
  assertNoseekPolicy,
  assertPluginNotQuarantined,
  readProfilePatches,
  boot,
  type Profile,
  type ProfileContext,
} from '../src/index.ts'

describe('Noseek Host Matching (§5.2)', () => {
  const positiveCases = [
    'dsh-otel-collector.deepseeksvc.com',
    'platform.deepseek.com',
    'download.deepseek.com',
    'download-test.deepseek.com',
    'cdn.deepseek.com',
    'api-docs.deepseek.com',
    'trtgsjkv6r.feishu.cn',
    'x.cos.ap-beijing.myqcloud.com',
    'deepseek.com',
  ]

  const negativeCases = [
    'api.deepseek.com',
    'https://api.deepseek.com/v1',
    'deepseek.com.example.org',
    'notdeepseek.com',
  ]

  it.each(positiveCases)('identifies %s as a blocked host', (host) => {
    expect(isBlockedHost(host)).toBe(true)
    expect(findBlockedHostInValue(host)).toBeDefined()
  })

  it.each(negativeCases)('identifies %s as NOT a blocked host', (host) => {
    expect(isBlockedHost(host)).toBe(false)
    expect(findBlockedHostInValue(host)).toBeUndefined()
  })

  it('matches URLs with paths, ports, and protocols', () => {
    expect(isBlockedHost('https://platform.deepseek.com/v1/chat')).toBe(true)
    expect(isBlockedHost('http://dsh-otel-collector.deepseeksvc.com:8080/v1/logs')).toBe(true)
    expect(isBlockedHost('https://trtgsjkv6r.feishu.cn/form/123')).toBe(true)
    expect(isBlockedHost('https://x.cos.ap-beijing.myqcloud.com/downloads/file.zip')).toBe(true)

    // Allowed exception
    expect(isBlockedHost('https://api.deepseek.com:443/v1/chat/completions')).toBe(false)
    expect(isBlockedHost('http://api.deepseek.com/v1')).toBe(false)
  })

  it('finds blocked hosts in nested structures and JsExpr nodes', () => {
    expect(findBlockedHostInValue({
      endpoint: 'https://dsh-otel-collector.deepseeksvc.com/v1/logs',
    })).toBe('dsh-otel-collector.deepseeksvc.com')

    expect(findBlockedHostInValue([
      'https://api.deepseek.com/v1',
      { mirror: 'https://download.deepseek.com/app' },
    ])).toBe('download.deepseek.com')

    expect(findBlockedHostInValue({
      __jsExpr: "process.env.OTEL_URL ?? 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'",
    })).toBe('dsh-otel-collector.deepseeksvc.com')

    // Allowed host in expression
    expect(findBlockedHostInValue({
      __jsExpr: "process.env.BASE_URL ?? 'https://api.deepseek.com/v1'",
    })).toBeUndefined()

    // Circular reference handling
    const circular: Record<string, unknown> = { name: 'test' }
    circular.self = circular
    expect(findBlockedHostInValue(circular)).toBeUndefined()

    circular.bad = 'https://platform.deepseek.com'
    expect(findBlockedHostInValue(circular)).toBe('platform.deepseek.com')

    // Primitives
    expect(findBlockedHostInValue(null)).toBeUndefined()
    expect(findBlockedHostInValue(undefined)).toBeUndefined()
    expect(findBlockedHostInValue(123)).toBeUndefined()
    expect(findBlockedHostInValue(true)).toBeUndefined()
  })
})

describe('Noseek Defaults Layer (resolveNoseekDefaultsPatches)', () => {
  it('emits replacement patches only for present bundle rows', () => {
    const bundlePatches: PatchOptions[] = [
      {
        insert: [
          { id: 'agent-default-model', name: 'agent-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
          { id: 'acp', name: 'acp-app', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          { id: 'web', name: 'web', config: { fetchProvider: 'http', searchProvider: 'deepseek-official' } },
          { id: 'plugin-manager', name: 'plugin-manager', config: { fallbackRegistries: ['https://registry.npmmirror.com/'] } },
          { id: 'ui-plugin-manager', name: 'ui-plugin-manager', config: { registryProbeEnabled: true } },
          { id: 'speech-to-text-sensevoice', name: 'sensevoice', config: { dataRoot: '/custom/data', modelOrigins: ['https://hf-mirror.com'] } },
          { id: 'ui-brand-official', name: 'brand' },
          { id: 'harness-dev-context', name: 'dev-context' },
          { id: 'system-prompt', name: 'system-prompt', config: { personaPrefix: 'You are a coding agent.' } },
          { id: 'other-plugin', name: 'other', config: { foo: 'bar' } },
        ],
      },
    ]

    const defaults = resolveNoseekDefaultsPatches(bundlePatches)

    expect(defaults).toEqual([
      { id: 'agent-default-model', config: { provider: '', model: '' } },
      { id: 'acp', config: {} },
      { id: 'web', config: { fetchProvider: 'http' } },
      { id: 'plugin-manager', config: { fallbackRegistries: [] } },
      { id: 'ui-plugin-manager', config: { registryProbeEnabled: false } },
      { id: 'speech-to-text-sensevoice', config: { dataRoot: '/custom/data', modelOrigins: ['https://huggingface.co'] } },
      { id: 'ui-brand-official', disabled: true },
      { id: 'harness-dev-context', disabled: true },
      {
        id: 'system-prompt',
        config: {
          includeHarnessIdentity: false,
          personaPrefix: 'You are an AI agent powered by Noseek Harness.\n\nYou are a coding agent.',
        },
      },
    ])
  })

  it('omits patches for rows that are not present in the bundle composition', () => {
    const bundlePatches: PatchOptions[] = [
      {
        insert: [
          { id: 'web', name: 'web', config: { searchProvider: 'deepseek-official' } },
        ],
      },
    ]

    const defaults = resolveNoseekDefaultsPatches(bundlePatches)
    expect(defaults).toEqual([
      { id: 'web', config: { fetchProvider: 'http' } },
    ])
  })

  it('returns empty array when bundle composition is empty', () => {
    expect(resolveNoseekDefaultsPatches([])).toEqual([])
  })

  it('disables ui-brand-official and harness-dev-context when present', () => {
    const bundlePatches: PatchOptions[] = [
      {
        insert: [
          { id: 'ui-brand-official', name: '@deepseek-ai/dsh-client-ui-brand-official' },
          { id: 'harness-dev-context', name: '@deepseek-ai/dsh-harness-dev-context' },
        ],
      },
    ]

    const defaults = resolveNoseekDefaultsPatches(bundlePatches)
    expect(defaults).toEqual([
      { id: 'ui-brand-official', disabled: true },
      { id: 'harness-dev-context', disabled: true },
    ])
  })

  describe('system-prompt handling in defaults layer', () => {
    it('sets includeHarnessIdentity: false and prepends Noseek opener while preserving mode personaPrefix and other fields', () => {
      const bundlePatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'system-prompt',
              name: '@deepseek-ai/dsh-system-prompt',
              config: {
                personaPrefix: 'You are a coding agent powered by the {{model}} model.',
                personaSuffix: 'Be concise.',
                includeRuntimeContext: true,
                toolOrder: ['tool_bash', '<unlisted-tools>'],
              },
            },
          ],
        },
      ]

      const defaults = resolveNoseekDefaultsPatches(bundlePatches)
      expect(defaults).toEqual([
        {
          id: 'system-prompt',
          config: {
            includeHarnessIdentity: false,
            personaPrefix: 'You are an AI agent powered by Noseek Harness.\n\nYou are a coding agent powered by the {{model}} model.',
            personaSuffix: 'Be concise.',
            includeRuntimeContext: true,
            toolOrder: ['tool_bash', '<unlisted-tools>'],
          },
        },
      ])
    })

    it('sets personaPrefix to Noseek opener when existing personaPrefix is empty or undefined', () => {
      const emptyPatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'system-prompt',
              name: '@deepseek-ai/dsh-system-prompt',
              config: { personaPrefix: '' },
            },
          ],
        },
      ]

      expect(resolveNoseekDefaultsPatches(emptyPatches)).toEqual([
        {
          id: 'system-prompt',
          config: {
            includeHarnessIdentity: false,
            personaPrefix: 'You are an AI agent powered by Noseek Harness.',
          },
        },
      ])

      const noPrefixPatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'system-prompt',
              name: '@deepseek-ai/dsh-system-prompt',
            },
          ],
        },
      ]
      expect(resolveNoseekDefaultsPatches(noPrefixPatches)).toEqual([
        {
          id: 'system-prompt',
          config: {
            includeHarnessIdentity: false,
            personaPrefix: 'You are an AI agent powered by Noseek Harness.',
          },
        },
      ])
    })

    it('does not duplicate opener if personaPrefix already starts with Noseek opener', () => {
      const bundlePatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'system-prompt',
              name: '@deepseek-ai/dsh-system-prompt',
              config: {
                personaPrefix: 'You are an AI agent powered by Noseek Harness.\n\nCustom instructions.',
              },
            },
          ],
        },
      ]

      const defaults = resolveNoseekDefaultsPatches(bundlePatches)
      expect(defaults).toEqual([
        {
          id: 'system-prompt',
          config: {
            includeHarnessIdentity: false,
            personaPrefix: 'You are an AI agent powered by Noseek Harness.\n\nCustom instructions.',
          },
        },
      ])
    })

    it('preserves !!js expressions on sdk-minimal personaPrefix and preserves other config', () => {
      const jsExpr = { __jsExpr: "process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" }
      const bundlePatches: PatchOptions[] = [
        {
          insert: [
            {
              id: 'system-prompt',
              name: '@deepseek-ai/dsh-system-prompt',
              config: {
                includeHarnessIdentity: false,
                includeRuntimeContext: false,
                personaPrefix: jsExpr,
              },
            },
          ],
        },
      ]

      const defaults = resolveNoseekDefaultsPatches(bundlePatches)
      expect(defaults).toEqual([
        {
          id: 'system-prompt',
          config: {
            includeHarnessIdentity: false,
            includeRuntimeContext: false,
            personaPrefix: jsExpr,
          },
        },
      ])
    })
  })
})

describe('Noseek Quarantine Layer (resolveNoseekQuarantinePatches)', () => {
  it('disables all quarantined rows present in patches', () => {
    const patches: PatchOptions[] = [
      {
        insert: NOSEEK_QUARANTINED_ROW_IDS.map(id => ({
          id,
          name: `pkg-${id}`,
          disabled: false,
        })),
      },
    ]

    const quarantinePatches = resolveNoseekQuarantinePatches(patches)
    expect(quarantinePatches).toHaveLength(NOSEEK_QUARANTINED_ROW_IDS.length)
    for (const patch of quarantinePatches) {
      expect(patch.disabled).toBe(true)
      expect(NOSEEK_QUARANTINED_ROW_IDS).toContain(patch.id)
    }
  })

  it('disables quarantined rows present inside groups', () => {
    const patches: PatchOptions[] = [
      {
        insert: [
          {
            id: 'my-group',
            name: 'cordis:group',
            group: true,
            config: [
              { id: 'session-log-deepseek', name: 'session-log', disabled: false },
            ],
          },
        ],
      },
    ]

    const quarantinePatches = resolveNoseekQuarantinePatches(patches)
    expect(quarantinePatches).toEqual([
      { id: 'session-log-deepseek', disabled: true },
    ])
  })

  it('omits rows that are not present in the composition', () => {
    const patches: PatchOptions[] = [
      {
        insert: [
          { id: 'agent-loop', name: 'agent-loop' },
        ],
      },
    ]

    expect(resolveNoseekQuarantinePatches(patches)).toEqual([])
  })
})

describe('Noseek Boot and Policy Assertions (assertNoseekPolicy)', () => {
  it('throws NoseekPolicyError when a quarantined row is enabled', () => {
    const entries: EntryOptions[] = [
      { id: 'session-log-deepseek', name: 'session-log', disabled: false },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(NoseekPolicyError)
    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(
      'dsh: quarantined plugin row "session-log-deepseek" cannot be enabled',
    )
  })

  it('passes when a quarantined row has disabled: true', () => {
    const entries: EntryOptions[] = [
      { id: 'session-log-deepseek', name: 'session-log', disabled: true },
      { id: 'agent-loop', name: 'agent-loop' },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).not.toThrow()
  })

  it('throws when provider is deepseek-official', () => {
    const entries: EntryOptions[] = [
      { id: 'agent-default-model', name: 'agent-model', config: { provider: 'deepseek-official', model: 'flash' } },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(NoseekPolicyError)
    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(
      'dsh: row "agent-default-model" selects provider "deepseek-official"; use "deepseek" via llm-pi-ai instead',
    )
  })

  it('throws when searchProvider is deepseek-official', () => {
    const entries: EntryOptions[] = [
      { id: 'web', name: 'web', config: { searchProvider: 'deepseek-official' } },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(NoseekPolicyError)
    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(
      'dsh: row "web" selects searchProvider "deepseek-official"; use "deepseek" via llm-pi-ai instead',
    )
  })

  it('throws when config contains a blocked host', () => {
    const entries: EntryOptions[] = [
      { id: 'custom-otel', name: 'otel', config: { endpoint: 'https://dsh-otel-collector.deepseeksvc.com/v1/logs' } },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(NoseekPolicyError)
    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(
      'dsh: row "custom-otel" config contains blocked host "dsh-otel-collector.deepseeksvc.com"',
    )
  })

  it('aggregates multiple violations into one error with one line per violation', () => {
    const entries: EntryOptions[] = [
      { id: 'session-log-deepseek', name: 'session-log', disabled: false },
      { id: 'web', name: 'web', config: { searchProvider: 'deepseek-official' } },
      { id: 'contact', name: 'contact', config: { url: 'https://trtgsjkv6r.feishu.cn/feedback' } },
    ]

    expect(() => { assertNoseekPolicy('dsh', entries) }).toThrow(NoseekPolicyError)
    try {
      assertNoseekPolicy('dsh', entries)
    } catch (error) {
      expect(error).toBeInstanceOf(NoseekPolicyError)
      const lines = (error as Error).message.split('\n')
      expect(lines).toHaveLength(3)
      expect(lines[0]).toContain('quarantined plugin row "session-log-deepseek" cannot be enabled')
      expect(lines[1]).toContain('row "web" selects searchProvider "deepseek-official"')
      expect(lines[2]).toContain('row "contact" config contains blocked host "trtgsjkv6r.feishu.cn"')
    }
  })

  it('evaluates PatchOptions arrays including insert layers', () => {
    const patches: PatchOptions[] = [
      {
        insert: [
          { id: 'session-log-deepseek', name: 'session-log', disabled: false },
        ],
      },
    ]

    expect(() => { assertNoseekPolicy('dsh', patches) }).toThrow(NoseekPolicyError)
  })
})

describe('assertPluginNotQuarantined', () => {
  it.each(NOSEEK_QUARANTINED_ROW_IDS)('throws NoseekPolicyError for quarantined row %s', (id) => {
    expect(() => { assertPluginNotQuarantined(id) }).toThrow(NoseekPolicyError)
    expect(() => { assertPluginNotQuarantined(id) }).toThrow(`quarantined plugin row "${id}" cannot be enabled`)
  })

  it('allows non-quarantined rows', () => {
    expect(() => { assertPluginNotQuarantined('agent-loop') }).not.toThrow()
    expect(() => { assertPluginNotQuarantined('llm-pi-ai') }).not.toThrow()
    expect(() => { assertPluginNotQuarantined('web-search-deepseek') }).not.toThrow()
  })
})

describe('readProfilePatches integration with Noseek layers', () => {
  it('applies defaults after bundle patches and forces quarantine at the end', () => {
    const context: ProfileContext = {
      name: 'test',
      dir: '/tmp/test-profile',
      patchPath: '/tmp/test-profile/cordis.patch.yml',
      installAnchor: '/tmp/test-profile/package.json',
      cwd: '/tmp',
      home: '/tmp/home',
      startedBundles: [],
      overlays: [
        // A user overlay attempting to re-enable a quarantined row
        { id: 'session-log-deepseek', disabled: false },
      ],
      telemetryDisabledEnv: '1',
    }

    const initialProfile: Profile = {
      name: 'test',
      dir: '/tmp/test-profile',
      patchPath: '/tmp/test-profile/cordis.patch.yml',
      layers: [
        {
          packageName: 'base-bundle',
          packageDir: '/tmp/base-bundle',
          patchPaths: ['/tmp/base-bundle/cordis.patch.yml'],
          patches: [
            {
              insert: [
                { id: 'session-log-deepseek', name: 'session-log' },
                { id: 'agent-default-model', name: 'agent-model', config: { provider: 'deepseek-official', model: 'flash' } },
              ],
            },
          ],
        },
      ],
      patches: [],
      skippedBundles: [],
    }

    const patches = readProfilePatches('dsh', context, initialProfile)

    // Verify defaults patch is included
    const defaultsPatch = patches.find(p => p.id === 'agent-default-model')
    expect(defaultsPatch).toBeDefined()
    expect(defaultsPatch?.config).toEqual({ provider: '', model: '' })

    // Verify quarantine patch is appended at the very end and forces disabled: true
    const lastQuarantine = patches.findLast(p => p.id === 'session-log-deepseek')
    expect(lastQuarantine).toEqual({ id: 'session-log-deepseek', disabled: true })

    // And assertNoseekPolicy passes on the final composed patches
    expect(() => { assertNoseekPolicy('dsh', patches) }).not.toThrow()
  })
})

describe('boot rejection on Noseek policy violation', () => {
  it('refuses boot when a quarantined plugin is passed enabled in patches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noseek-boot-test-'))
    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, '[]\n', 'utf8')

    try {
      await expect(boot('dsh', configPath, [
        {
          insert: [
            { id: 'session-log-deepseek', name: 'session-log', disabled: false },
          ],
        },
      ])).rejects.toThrow(NoseekPolicyError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses boot when a config selects deepseek-official provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noseek-boot-test-'))
    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, '[]\n', 'utf8')

    try {
      await expect(boot('dsh', configPath, [
        {
          insert: [
            { id: 'model', name: 'model-plugin', config: { provider: 'deepseek-official' } },
          ],
        },
      ])).rejects.toThrow(/selects provider "deepseek-official"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses boot when a config contains a blocked host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noseek-boot-test-'))
    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, '[]\n', 'utf8')

    try {
      await expect(boot('dsh', configPath, [
        {
          insert: [
            { id: 'otel', name: 'otel-plugin', config: { endpoint: 'https://dsh-otel-collector.deepseeksvc.com' } },
          ],
        },
      ])).rejects.toThrow(/contains blocked host "dsh-otel-collector\.deepseeksvc\.com"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
