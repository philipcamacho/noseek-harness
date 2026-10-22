# Noseek Harness

A telemetry-free, vendor-neutral distribution of DeepSeek Harness — the role Chromium plays for Chrome.

> **Project Goal:** Noseek Harness creates a privacy-conscious, vendor-neutral open-source distribution of the harness.
>
> **Status: Phase 0 (plan only).** The boot quarantine and defaults layers defined in the plan have not landed yet. Running `pnpm dsh web` currently boots upstream profiles with their default routes. See [**`noseek/WHITELABEL_PLAN.md`**](../noseek/WHITELABEL_PLAN.md) for the complete roadmap.

---

## Key Principles

- **Zero Telemetry & Exfiltration by Default:** Disables background metrics, OpenTelemetry collectors, product analytics, silent session transcript uploads (`dsh_session_log`), plugin package inventory uploads (`dsh_plugin_packages`), and tracking headers (`x-deepseek-harness-*`).
- **Zero Automatic China Outbound Calls:** Cuts off automatic outbound calls to Chinese infrastructure (`deepseeksvc.com`, `download.deepseek.com`, `feishu.cn`, Tencent Cloud COS). Disables automatic registry speed probes and fallback mirrors to `registry.npmmirror.com` and `hf-mirror.com`.
- **Equal Provider Treatment & BYOK (Bring Your Own Key):** All providers — local models (Ollama, vLLM, llama.cpp) and cloud APIs (OpenAI, Anthropic, OpenRouter, and DeepSeek) — are treated equally via standard API clients (`llm-pi-ai`). DeepSeek is not preselected, but users who wish to use the DeepSeek API can configure their key freely.
- **Plugin Ecosystem Support:** Installing plugins from the official npm registry (`registry.npmjs.org`) remains supported. Mainland China mirrors and probes are disabled by default.
- **Unbranded UI & Neutral Slots:** Replaces proprietary logos, wordmarks, and hardcoded branding with customizable, neutral assets.
- **Microkernel Architecture:** Built on [Cordis](https://github.com/cordiverse/cordis) with an "everything-is-a-plugin" design.

---

> [!IMPORTANT]
> ### Notice on China-Hosted Model Providers
> The underlying model catalog includes endpoints operated in mainland China or by Chinese companies (such as DeepSeek `api.deepseek.com`, Alibaba Cloud `aliyuncs.com`, Moonshot `moonshot.cn`, MiniMax `minimaxi.com`, and Zhipu `bigmodel.cn`).
>
> In Noseek Harness, **none of these providers are selected by default**. You are completely free to configure and use them if you wish. Be aware that selecting any cloud provider transmits your prompts, code, and session context to that provider under their respective terms of service and jurisdiction. For strict air-gapped privacy, use local models (Ollama / vLLM / llama.cpp).

---

## Quickstart

### Prerequisites

- **Node.js:** `^22.19.0 || >=24.0.0`
- **Package Manager:** `pnpm@11.7.0` (managed via `corepack enable` or installed globally)

```sh
git clone git@github.com:philipcamacho/noseek-harness.git
cd noseek-harness
pnpm install
pnpm run build
```

---

### Running the Web UI

Launch the Web UI on `http://127.0.0.1:3080`:

```sh
pnpm dsh web
```

> **Note:** During Phase 0 development, ensure you run with an isolated home directory (`DSH_HOME=/tmp/noseek-preview`) and `DSH_TELEMETRY_DISABLED=1` until Phase 1 boot quarantine lands.

For live development with hot-module reloading (HMR) for client plugins:

```sh
pnpm run dev:web
```

---

### Running & Building the Desktop App (Electron)

The Desktop application wraps the harness in an Electron shell with native directory pickers, background execution, and system tray support.

#### Development & Local Launch

```sh
pnpm run dev:desktop
```

To run immediately after building without recompiling:

```sh
pnpm run start:desktop
```

#### Packaging Desktop Binaries

- Current OS: `pnpm run package:desktop`
- Unpacked directory only (quick smoke test): `pnpm run package:desktop:dir`
- macOS (ARM64): `pnpm run package:desktop:mac:arm64`
- macOS (x64): `pnpm run package:desktop:mac:x64`
- Windows (x64): `pnpm run package:desktop:win:x64:unsigned`

Binaries are generated under `apps/desktop/.desktop-build/targets/<target>/dist/`.

---

## Documentation & Fork Architecture

- [**Whitelabel & Telemetry Elimination Plan**](../noseek/WHITELABEL_PLAN.md) — Architectural inventory, quarantine layers, network gates, and phase milestones.
- [**Fork Delta Ledger (DELTA.md)**](../noseek/DELTA.md) — Strict ledger tracking every modified upstream file and conflict resolution instructions.
- [**Fork Changelog (CHANGELOG.md)**](../noseek/CHANGELOG.md) — Log of upstream release merges and architectural updates.
- [**Agent Guidelines for Noseek**](../noseek/AGENTS.md) — Standing orders and conventions for AI assistants working on this fork.
- [**Upstream Sync Skill**](../.agents/skills/noseek-upstream-sync/SKILL.md) — Systematic process for syncing upstream release tags (`dsh-v*`).

---

## Upstream & Acknowledgements

Noseek Harness is an independent, community-driven downstream distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), powered by [Cordis](https://github.com/cordiverse/cordis).

Noseek Harness is **not affiliated with, endorsed by, or sponsored by DeepSeek-AI**. All DeepSeek trademarks belong to their respective owners.
