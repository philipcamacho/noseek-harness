# Noseek Harness

A clean, whitelabeled, zero-telemetry, and vendor-neutral agent harness.

> **Project Goal:** Noseek Harness creates a 100% unbranded, private, and vendor-neutral open-source distribution of the harness — serving the same role to DeepSeek Harness that **Chromium** serves to Google Chrome.

For the full architectural deep dive, telemetry audit, plugin feasibility analysis, and phased implementation roadmap, see [**`WHITELABEL_PLAN.md`**](WHITELABEL_PLAN.md).

---

## Key Principles

- **Zero Telemetry & Exfiltration:** Eliminates all background tracking, OpenTelemetry collectors, product analytics, silent session transcript uploads (`dsh_session_log`), plugin inventory exfiltration (`dsh_plugin_packages`), and per-request user/session tracking headers (`x-deepseek-harness-*`).
- **Zero China Outbound Calls:** Completely cuts off communication with Chinese infrastructure (`deepseek.com`, `deepseeksvc.com`, `feishu.cn`, and Tencent Cloud COS).
- **Vendor-Neutral & BYOK:** Unlocks the harness for first-class local models (Ollama, vLLM, llama.cpp) and BYOK (Bring Your Own Key) providers (OpenAI, Anthropic, OpenRouter) using secure local keychain storage.
- **Unbranded UI & Neutral Slots:** Replaces all proprietary logos, wordmarks, and hardcoded fish art with clean, customizable, and whitelabeled assets.
- **Microkernel Architecture:** Built on [Cordis](https://github.com/cordiverse/cordis) with an "everything-is-a-plugin" design.

> **Privacy boundary:** Noseek guarantees zero egress to DeepSeek and Chinese infrastructure. Any LLM provider the user configures (OpenAI, Anthropic, OpenRouter) will still receive prompts and code as part of normal operation. For full air-gapped privacy, use local models.

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

For live development with hot-module reloading (HMR) for client plugins:

```sh
pnpm run dev:web
```

---

### Running & Building the Desktop App (Electron)

The Desktop application wraps the harness in an Electron shell with local native directory pickers, background execution, and system tray support.

#### 1. Development & Local Launch

To compile the native libraries, assemble the desktop runtime bundle, and launch the Electron application:

```sh
pnpm run dev:desktop
```

If the packages are already built and you want to launch the desktop shell immediately without rebuilding:

```sh
pnpm run start:desktop
```

#### 2. Packaging Standalone Desktop Binaries

To produce standalone release executables / installers:

* **Package for your current operating system:**
  ```sh
  pnpm run package:desktop
  ```

* **Package unpacked directory only (fast verification without creating installers):**
  ```sh
  pnpm run package:desktop:dir
  ```

* **Platform-specific targets:**
  * **macOS (Apple Silicon / ARM64):**
    ```sh
    pnpm run package:desktop:mac:arm64
    # Or unpacked app bundle:
    pnpm run package:desktop:mac:arm64:dir
    ```
  * **macOS (Intel / x64):**
    ```sh
    pnpm run package:desktop:mac:x64
    # Or unpacked app bundle:
    pnpm run package:desktop:mac:x64:dir
    ```
  * **Windows (x64):**
    ```sh
    # Unsigned executable:
    pnpm run package:desktop:win:x64:unsigned
    # Or unpacked directory:
    pnpm run package:desktop:win:x64:dir
    ```

Packaged installers and `.app` / `.exe` bundles are generated in `apps/desktop/.desktop-build/targets/<target>/dist/`.

---

## Documentation & Architecture

- [**Whitelabel & Telemetry Elimination Plan**](WHITELABEL_PLAN.md) — Comprehensive inventory of endpoints, branding, plugin feasibility, upstream sync strategy, and phased roadmap.
- [**Agent Guidelines**](AGENTS.md) — Architectural rules, coding standards, and standing orders for AI assistants and contributors.
- [**Desktop Shell Documentation**](apps/desktop/README.md) — Deep dive into the Electron lifecycle, embedded runtime, and packaging pipeline.
- [**Development Guide**](docs/development.md) — Full repository tooling, scripts, and build workflows.
- [**Architecture Overview**](docs/architecture.md) — Cordis plugin composition, host runner, and client layer.
- [**Safety Notice**](SAFETY.md) — Execution bounds and sandbox permissions.

---

## Upstream & Acknowledgements

Noseek Harness is an independent, community-driven distribution downstream from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), powered by [Cordis](https://github.com/cordiverse/cordis).
