---
description: "默认 harness 主目录变更为 ~/.noseek，且 deepseek-official 路由被替换为基于 llm-pi-ai 的标准 deepseek 提供商。"
kind: upgrade-guide
---

# 默认主目录变更为 ~/.noseek 且 deepseek-official 路由被替换

[English](guide.md) | 中文

## 变更

默认 harness 主目录从 `~/.dsh` 变更为 `~/.noseek`。`DSH_HOME_DIR_NAME` 现在解析为 `.noseek`，未配置的主目录由 `dshHomeDisplay` 报告为 `~/.noseek`。`$DSH_HOME` 环境变量及显式配置路径继续拥有对默认根目录的覆盖优先级。存储在 `~/.dsh` 下的现有数据、配置文件和凭据不会被自动迁移或读取。

`deepseek-official` 模型路由与搜索提供商路由已被移除。引用了提供商 `deepseek-official` 或搜索提供商 `deepseek-official` 的 profile 和配置不再受支持。DeepSeek 模型与搜索现改用 `llm-pi-ai` 中的通用 `deepseek` 提供商进行标准 BYOK 目录集成，在不携带专有 session 日志或追踪标头的情况下直接与 `api.deepseek.com` 通信。

## 迁移

1. 如果您在 `~/.dsh` 中拥有自定义 profile、patch 或配置，请将其复制或移动到 `~/.noseek`，或设置 `export DSH_HOME="$HOME/.dsh"` 以保留先前的目录。
2. 在 profile 配置、`cordis.yml` 和 `--patch` 覆盖层中，将 `provider: deepseek-official` 替换为 `llm-pi-ai` 下的 `provider: deepseek`。
3. 在 web 搜索配置中，将 `searchProvider: deepseek-official` 替换为显式配置的搜索提供商或使用标准抓取。
4. 确认在未设置 `$DSH_HOME` 时 `resolveDshHome()` 解析为 `~/.noseek`，并验证 DeepSeek 模型请求通过 `llm-pi-ai` 提供商执行。
