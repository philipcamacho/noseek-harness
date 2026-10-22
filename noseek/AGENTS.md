# Noseek Agent Guidelines

This document provides standing instructions for AI agents working within the Noseek Harness fork. Root [AGENTS.md](../AGENTS.md) delegates here.

---

## 1. Core Fork Invariants

1. **Zero Automatic China Outbound Egress:** No profile or default configuration may trigger network traffic to Chinese infrastructure (including `deepseeksvc.com`, `download.deepseek.com`, `feishu.cn`, Tencent Cloud COS, `registry.npmmirror.com`, and `hf-mirror.com`).
2. **Zero Telemetry and Body Exfiltration by Default:** Keep `session-log-deepseek` (`dsh_session_log`), `plugin-package-inventory-deepseek` (`dsh_plugin_packages`), OTel exporters, and product analytics disabled in the final quarantine layer.
3. **Equal Treatment of Providers (BYOK):** Cloud providers (OpenAI, Anthropic, OpenRouter, and DeepSeek) and local engines (Ollama, vLLM, llama.cpp) are supported as equal peers through `llm-pi-ai`.
   - Never preselect DeepSeek or any other provider by default.
   - If a user chooses to configure DeepSeek API credentials, that request is routed through standard API calls without tracking headers or body uploads.
4. **Standard Plugin Registry Support:** Installing plugins from `registry.npmjs.org` is fully supported. Automatic speed probes and fallback mirrors to `npmmirror` remain disabled by default.
5. **No Package Scope Renames:** Keep `@deepseek-ai/dsh-*` package names. Do not invent `@noseek/*` namespaces.

---

## 2. Fork Delta Discipline

To minimize merge conflicts when tracking upstream releases:

1. **New Files Over Edits:** Place new features, quarantine logic, tests, and documentation in new files (e.g., under `noseek/` or new workspace packages like `packages/boot/noseek-policy/`). New files never conflict.
2. **One-Line Hooks for Upstream Files:** If modifying an existing upstream file is unavoidable, keep the change to a minimal 1-line hook or delegation call.
3. **The Delta Ledger is Mandatory:** Every modified or deleted upstream file MUST be registered in [DELTA.md](DELTA.md).
   - If you touch an upstream file, add/update its row in `DELTA.md`.
   - Run `noseek/check-delta.sh` to verify that all diffs against the upstream base tag are accounted for.
4. **Preserve Upstream Documentation:** Do not edit upstream `README.md`, `README.zh.md`, or translations to document Noseek features. All Noseek-specific documentation belongs in `.github/README.md` or `noseek/`.

---

## 3. Upstream Sync Protocol

Follow the [noseek-upstream-sync skill](../.agents/skills/noseek-upstream-sync/SKILL.md) whenever syncing from upstream:
- Always merge official release tags (`dsh-v*`), not arbitrary commits on `master`.
- Run pre-merge diff inspections to detect new hosts, network calls, profiles, or workflows.
- Resolve merge conflicts using [DELTA.md](DELTA.md) as the authority on fork-specific behavior.
- Run `pnpm run audit:privacy` and the hermetic network gate.
- **Never weaken a privacy gate to pass a test.** If a check fails, report the regression.
- Record the sync in [CHANGELOG.md](CHANGELOG.md).
