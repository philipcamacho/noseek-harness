# Noseek Provider Spike and Gap Report: `llm-pi-ai` vs `llm-deepseek`

> **Document Status:** Complete (Phase 2 Task 2.1)
>
> **Target:** Noseek Whitelabel Plan §1, §2.12, §6 Phase 2
>
> **Audited Packages:** `packages/llm/llm-pi-ai` (`@deepseek-ai/dsh-llm-pi-ai`), `packages/llm/llm-deepseek` (`@deepseek-ai/dsh-llm-deepseek`), `packages/llm/llm` (`@deepseek-ai/dsh-llm`)

---

## 1. Executive Summary

This audit evaluates the LLM provider layer for Noseek Harness. In the upstream DeepSeek Harness distribution, the primary out-of-the-box model route was `deepseek-official` (backed by `@deepseek-ai/dsh-llm-deepseek`). That route injected per-request tracking headers, wrote an anonymous user ID file to `$DSH_HOME/.anonymous-user-id`, and attached telemetry body extensions (`dsh_session_log` carrying the complete multi-megabyte session transcript and `dsh_plugin_packages` carrying the installed plugin inventory).

Under the Noseek Whitelabel Plan:
1. `llm-deepseek` (route `deepseek-official`) is completely quarantined and disabled across all shipped profiles.
2. The vendor-neutral adapter `@deepseek-ai/dsh-llm-pi-ai` serves as the sole engine for both commercial cloud providers (OpenAI, Anthropic, OpenRouter, and DeepSeek) and local/self-hosted engines (Ollama, vLLM, llama.cpp).
3. DeepSeek (`api.deepseek.com`) is supported as an ordinary Bring-Your-Own-Key (BYOK) provider through `llm-pi-ai`, with equal placement, zero telemetry, zero session transcript exfiltration, and zero tracking headers.

This spike confirms that `llm-pi-ai` fully satisfies all functional requirements for cloud and local providers, verifies zero egress on unconfigured endpoints, and documents the feature differences between `llm-deepseek` and `llm-pi-ai`.

---

## 2. Architecture and Capabilities of `llm-pi-ai`

`packages/llm/llm-pi-ai` provides a generic, multi-tenant LLM adapter plugin for the Cordis microkernel. It adapts the `@earendil-works/pi-ai` abstraction layer into DeepSeek Harness's `LlmAdapter` interface (`ctx.llm`).

### 2.1 Built-in Catalog Providers

`packages/llm/llm-pi-ai/src/catalog.ts` and `provider-data.generated.ts` index the built-in providers shipped by `@earendil-works/pi-ai`:
- **OpenAI:** `openai` (`https://api.openai.com/v1`, env `OPENAI_API_KEY`)
- **Anthropic:** `anthropic` (`https://api.anthropic.com`, env `ANTHROPIC_API_KEY`)
- **OpenRouter:** `openrouter` (`https://openrouter.ai/api/v1`, env `OPENROUTER_API_KEY`)
- **DeepSeek:** `deepseek` (`https://api.deepseek.com`, env `DEEPSEEK_API_KEY`)
- **Other Providers:** `together`, `groq`, `mistral`, `google` (Gemini), `xai`, `cerebras`, `fireworks`, etc.

**Catalog Route Mechanism:**
When a route configured under `config.providers[routeKey]` matches an installed catalog provider ID (such as `deepseek`, `openai`, or `anthropic`):
- Endpoint defaults to the official catalog endpoint (`providerDefaultsOf(installed)`).
- Wire protocol is managed by pi-ai's native provider implementation.
- Model capabilities (context window sizes, maximum output tokens, multimodal capabilities) are resolved statically from `@earendil-works/pi-ai/providers/all`.
- Profiles can selectively override or narrow models via `models` (replacing catalog models) or `modelOverrides` (tweaking capacities of specific models).

### 2.2 Local and Self-Hosted Providers (Ollama, vLLM, llama.cpp)

Local inference engines are first-class peers in `llm-pi-ai`. A hand-declared route requires no upstream catalog entry.

#### Protocol Support
In `packages/llm/llm-pi-ai/src/provider.ts`, custom routes support three core protocols:
1. `openai-completions` (OpenAI Chat Completions API `/chat/completions`) — used by Ollama, vLLM, llama.cpp, LocalAI, vLLM OpenAI-compatible server.
2. `openai-responses` (OpenAI Responses API) — supported for modern gateway implementations.
3. `anthropic-messages` (Anthropic Messages API `/v1/messages`) — used by vLLM (with anthropic server) and proxy gateways.

#### Keyless / Unauthenticated Operation
Local inference servers typically require no API key. In `llm-pi-ai`:
- When `apiKeyEnv` is omitted from a provider profile, `resolveApiKey()` resolves to `undefined`.
- `provider.ts` configures `harnessApiKeyAuth()`, which produces `{ auth: {}, source: name }`.
- pi-ai sends requests unauthenticated or with dummy authorization headers without throwing missing-credential errors.

#### Custom BaseURL and Reasoning Dialects
Deployments declare custom endpoints directly:
```yaml
- id: llm-pi-ai
  config:
    providers:
      ollama:
        displayName: Ollama Local
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: deepseek-r1:14b
            name: DeepSeek-R1 (14B)
            contextWindow: 65536
            maxTokens: 16384
      vllm:
        displayName: vLLM Inference Server
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        models:
          - id: Qwen/Qwen2.5-Coder-32B-Instruct
            contextWindow: 32768
            maxTokens: 8192
      llamacpp:
        displayName: llama.cpp Server
        api: openai-completions
        baseURL: http://127.0.0.1:8080/v1
```

The `compat.thinkingFormat` option allows local engines running DeepSeek-R1, Qwen-2.5, or other reasoning architectures to emit reasoning blocks using their native delimiters (`<think>...</think>` or `reasoning_content`).

---

## 3. Feature Comparison: `llm-deepseek` vs `llm-pi-ai`

| Feature / Dimension | `llm-deepseek` (`deepseek-official`) | `llm-pi-ai` (`deepseek`) | Noseek Assessment & Decision |
|---|---|---|---|
| **Thinking / Reasoning Output** | Proprietary Messages SSE parser emitting reasoning chunks. | Native `thinking_start`, `thinking_delta`, `thinking_end` events translated to Harness `StreamChunk` (`reasoning` / `reasoning-delta`). | **Parity.** `llm-pi-ai` fully supports reasoning streams across OpenAI Completions (`reasoning_content`) and Anthropic Messages thinking blocks. |
| **Reasoning Effort Mapping** | Custom parameter handling. | `reasoningEfforts` map per model (`off`, `low`, `medium`, `high`, `max`) or route-level `reasoning` knob. | **Parity.** Supported in `llm-pi-ai`. |
| **Context / Prompt Caching** | Custom header/payload parsing. | `mapUsage` parses `usage.cacheRead` and `usage.cacheWrite`, mapping to `cacheReadTokens` and `cacheWriteTokens` in `TokenUsage`. | **Parity.** Cache read/write metrics are reported when non-zero. |
| **Compaction Headers** | Sends `'x-deepseek-harness-compact': '1'` when `options.purpose === 'compaction'`. | Sends no compaction headers; executes compaction turns as standard prompts. | **Intentional Omission.** Compaction headers were DeepSeek backend-specific flags. Standard prompt calls perform compaction identically. |
| **Telemetry & Transcript Upload** | Injects `dsh_session_log` (multi-MB session history) and `dsh_plugin_packages` into request body via `prepareRequestExtensions`. | Completely absent. Request body only contains standard `messages`, `model`, `stream`, etc. | **Critical Security Invariant.** `llm-pi-ai` eliminates transcript exfiltration by design. |
| **Tracking Headers** | Injects `x-deepseek-harness-user-id` and `x-deepseek-harness-session-id`. Generates `.anonymous-user-id`. | Completely absent. Uses standard HTTP `Authorization` and optional `attributionHeaders()` (`User-Agent`). | **Critical Privacy Invariant.** Tracking headers are eliminated. |
| **Credential Storage** | Resolves `DEEPSEEK_API_KEY` from `$DSH_HOME/.credentials.json` or environment. | Resolves `apiKeyEnv: DEEPSEEK_API_KEY` via `ctx.credentials` or ambient process environment. | **Parity.** Seamlessly shares standard local credential storage. |
| **Endpoint Protocol** | DeepSeek Messages API (`/messages`). | OpenAI Chat Completions API (`/chat/completions`) at `https://api.deepseek.com`. | **Standardization.** Standard OpenAI completions API is DeepSeek's officially supported public API format. |

### 3.1 Thinking & Reasoning Format
In `llm-deepseek`, reasoning streams were parsed from DeepSeek's custom Messages API. In `llm-pi-ai`:
- `packages/llm/llm-pi-ai/src/stream.ts` maps `thinking_start`, `thinking_delta`, and `thinking_end` events into standard Harness `StreamChunk` blocks:
  ```ts
  case 'thinking_start':
    yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
    break
  case 'thinking_delta':
    yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
    break
  case 'thinking_end':
    yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
    break
  ```
- Models declaring `compat.thinkingFormat: 'deepseek'` (the default for the `deepseek` catalog provider) parse `reasoning_content` in SSE streams from `api.deepseek.com` and deliver thinking blocks to the agent UI and loop seamlessly.

### 3.2 Prompt Caching
`llm-pi-ai` accurately reports prompt cache hits and writes via `mapUsage` (`packages/llm/llm-pi-ai/src/stream.ts`):
```ts
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}
```
When `api.deepseek.com` returns cache hits in its completions usage payload, `cacheReadTokens` reflects the saved prompt tokens in the turn summary.

### 3.3 Compaction Headers
`llm-deepseek` set `x-deepseek-harness-compact: 1` on turns initiated by the compaction service. This header was used upstream for internal DeepSeek request routing and prioritization. `llm-pi-ai` omits this header completely. Compaction turns execute as standard LLM completions with no loss of client-side compaction fidelity.

### 3.4 Telemetry and Tracking Invariants
In `llm-deepseek/src/adapter.ts`:
- `x-deepseek-harness-user-id` was derived from `getOrCreateAnonymousUserId()`, creating `.anonymous-user-id` on disk.
- `x-deepseek-harness-session-id` sent the session UUID.
- `prepareRequestExtensions` serialized the entire multi-turn session transcript (prompts, tool calls, bash output, file contents up to 8 MiB) into `dsh_session_log`, and package inventories into `dsh_plugin_packages`.

In `llm-pi-ai`:
- None of these extension hooks exist.
- No anonymous user ID is generated or read.
- Loopback verification (`noseek/audit-privacy.ts`) deterministically verifies that zero `x-deepseek-harness-*` headers and zero `dsh_session_log` / `dsh_plugin_packages` body keys are emitted.

---

## 4. Zero Automatic Egress & Endpoint Probing Audit

A critical security requirement is that `llm-pi-ai` must never automatically probe unconfigured endpoints on boot or profile composition.

### 4.1 In-Memory Catalog Initialization
Inspection of `packages/llm/llm-pi-ai/src/index.ts` and `catalog.ts`:
- `catalogProviders()` lazily indexes built-in providers from static data exported by `@earendil-works/pi-ai/providers/all`.
- `catalogProviderIds()` returns static string keys (`openai`, `anthropic`, `openrouter`, `deepseek`, etc.).
- `directoryEntries()` registers configurable providers using static in-memory metadata (`providerDefaultsOf(installed)`).
- **Result:** Mounting `llm-pi-ai` makes zero network connections.

### 4.2 Model Discovery (`discoverModels`)
Inspection of `packages/llm/llm-pi-ai/src/discovery.ts`:
1. **Catalog Fast Path (Zero Network):**
   ```ts
   if (request.provider !== undefined) {
     const installed = catalogModels(request.provider)
     if (installed.size > 0) {
       return [...installed.values()].map(model => ({ ... }))
     }
   }
   ```
   When the user or UI queries available models for a catalog provider (e.g. `openai`, `deepseek`), `discoverModels` returns models directly from local memory without making any HTTP request.
2. **Explicit User-Initiated Probing Only:**
   The network probe path (`GET {baseURL}/models`) only executes if:
   - The route is a non-catalog provider (custom gateway or local server).
   - An explicit discovery action is triggered (e.g. user clicks "Fetch Available Models" in Settings).
   - A `baseURL` is explicitly provided.
3. **No Background or Automatic Probes:**
   `discoverModels` is registered as a handler on `ctx.llm.registerModelDiscovery()`. It is never called automatically on boot, configuration load, or turn execution.

---

## 5. Error Handling for Unconfigured & Legacy Routes

In `packages/llm/llm/src/index.ts`:
`LlmRuntime.prototype.registration(provider: string)` handles missing adapter lookups. When an unregistered provider is requested:
1. `provider === 'deepseek-official'`:
   Throws `LlmError` with code `NO_ADAPTER`:
   `no adapter registered for provider "deepseek-official"; use the "deepseek" provider via llm-pi-ai instead`
2. `provider === ''` (or whitespace-only):
   Throws `LlmError` with code `NO_ADAPTER`:
   `no adapter registered for provider ""; configure a model provider before starting a turn`
3. Any other unregistered provider:
   Throws `LlmError` with code `NO_ADAPTER`:
   `no adapter registered for provider "<provider>"`

This preserves the `no adapter registered for provider "..."` prefix and `NO_ADAPTER` error code required by existing test suites, while giving immediate and actionable guidance to users migrating from upstream profiles.

---

## 6. Verification and Privacy Gate Outcomes

All aspects of this provider spike have been validated by automated test gates:

1. **Unit Tests (`packages/llm/llm/tests/service.spec.ts`):**
   - Assert `prepareCall` and `stream` with `provider: 'deepseek-official'` throw `NO_ADAPTER` and explicitly name `"deepseek"` via `llm-pi-ai`.
   - Assert `prepareCall` and `stream` with `provider: ''` throw `NO_ADAPTER` and state that a model provider must be configured.
2. **Phase 2 Loopback Gate (`noseek/audit-privacy.ts`):**
   - Composes an active profile with `llm-pi-ai` configured for the `deepseek` route pointing to `http://127.0.0.1:<port>/v1`.
   - Confirms that calling `ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-chat' })` on the composed runtime rejects with an error naming `deepseek` as the replacement.
   - Executes a streaming turn with `DEEPSEEK_API_KEY`.
   - Inspects the captured HTTP request on loopback:
     - Verified `Authorization: Bearer <key>`
     - Verified zero `x-deepseek-harness-*` headers.
     - Verified zero `dsh_session_log` and zero `dsh_plugin_packages` in JSON request body.
3. **Engine Tests (`packages/llm/llm-pi-ai`):**
   - All 434 tests in `packages/llm/llm-pi-ai` pass with 100% success.
