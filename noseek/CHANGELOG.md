# Noseek Changelog

This changelog records all upstream release syncs, architectural updates, and quarantine enhancements in the Noseek Harness distribution.

---

## [Unreleased] - Phase 0 Foundation

**Upstream Base:** `dsh-v0.2.1-alpha.1`

### Architectural Decisions & Setup
- **Whitelabel Plan Revision (`noseek/WHITELABEL_PLAN.md`):**
  - Designed boot quarantine and defaults layers to disable telemetry and China egress at runtime.
  - Discovered and addressed additional China egress vectors: npmmirror fallback registries, registry speed probes, and voice download mirrors (`hf-mirror.com`).
  - Replaced proposed in-process fetch hook with containerized hermetic network test (`docker run --network none` / `unshare -n` with local DNS monitoring).
  - Adopted tag-based upstream sync strategy (`dsh-v*`) over tracking unstable `master`.
- **Equal Provider Treatment (BYOK):**
  - Restored DeepSeek as an equal peer provider via generic `llm-pi-ai` adapter (unmounting proprietary `llm-deepseek` adapter to eliminate tracking headers and body uploads).
  - Added disclosure notice for all China-hosted endpoints in the provider catalog.
- **Plugin Management:**
  - Preserved standard npm plugin installation (`registry.npmjs.org`).
  - Disabled mainland China fallback registries (`registry.npmmirror.com`) and latency probes by default.
- **Repository Hygiene & Merge Sustainability:**
  - Restored upstream root `README.md` to avoid bilingual translation pairing gate breakages and repetitive merge conflicts.
  - Relocated public Noseek documentation to `.github/README.md`.
  - Created fork delta ledger (`noseek/DELTA.md`) and enforcement script (`noseek/check-delta.sh`).
  - Created agent guidelines (`noseek/AGENTS.md`) and sync automation protocol (`.agents/skills/noseek-upstream-sync/SKILL.md`).
