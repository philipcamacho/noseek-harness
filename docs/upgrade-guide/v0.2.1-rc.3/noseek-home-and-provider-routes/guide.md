---
description: "The default harness home directory changes to ~/.noseek and deepseek-official routes are replaced by the standard deepseek provider via llm-pi-ai."
kind: upgrade-guide
---

# Default home directory is ~/.noseek and deepseek-official routes are replaced

English | [中文](guide.zh.md)

## Change

The default harness home directory moves from `~/.dsh` to `~/.noseek`. `DSH_HOME_DIR_NAME` now evaluates to `.noseek`, and `dshHomeDisplay` reports `~/.noseek` for the unconfigured home. The `$DSH_HOME` environment variable and explicit configuration paths continue to override the default root. Existing data, profiles, and credentials stored under `~/.dsh` are not automatically migrated or read.

The `deepseek-official` model route and search provider route are removed. Profiles and configurations that referenced provider `deepseek-official` or search provider `deepseek-official` are no longer supported. DeepSeek models and search now use standard bring-your-own-key catalog integration through the generic `deepseek` provider in `llm-pi-ai`, which contacts `api.deepseek.com` without proprietary session logging or tracking headers.

## Migration

1. If you have custom profiles, patches, or settings in `~/.dsh`, copy or move them to `~/.noseek`, or set `export DSH_HOME="$HOME/.dsh"` to retain the previous directory.
2. In profile configurations, `cordis.yml`, and `--patch` overlays, replace `provider: deepseek-official` with `provider: deepseek` under `llm-pi-ai`.
3. In web search configurations, replace `searchProvider: deepseek-official` with an explicit configured search provider or use standard fetch.
4. Confirm that `resolveDshHome()` resolves to `~/.noseek` when `$DSH_HOME` is unset, and verify that DeepSeek model requests execute through the `llm-pi-ai` provider.
