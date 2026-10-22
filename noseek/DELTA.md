# Noseek Fork Delta Ledger

This ledger records every upstream file modified or deleted in the `noseek-harness` fork relative to the upstream base release (`dsh-v0.2.1-alpha.1`).

Whenever an upstream file is modified, its presence in this ledger is mandatory. The `noseek/check-delta.sh` script enforces that all differences against upstream are accounted for.

---

## Modified Upstream Files

| File Path | Category | Reason for Modification | Conflict Resolution Strategy | Verification / Test |
|---|---|---|---|---|
| `AGENTS.md` | Pointer | Injects 1-line delegation to `noseek/AGENTS.md` and sync skill for AI assistants. | Ensure line 3 retains the Noseek blockquote pointer below `# AGENTS.md`. | `pnpm run verify-md-links` |

---

## Noseek-Owned Files (Non-Conflicting)

These files are owned by the Noseek distribution and do not exist in upstream:

- `.github/README.md`: Public-facing repository README rendered by GitHub. Keeps root `README.md` clean for upstream syncs and translation pairing gates.
- `noseek/WHITELABEL_PLAN.md`: Comprehensive whitelabel architecture, quarantine inventory, network isolation gates, and execution phases.
- `noseek/AGENTS.md`: Standing orders, fork invariants, and delta discipline for agents working in this repository.
- `noseek/DELTA.md`: This delta ledger.
- `noseek/CHANGELOG.md`: Chronological log of upstream tag merges and fork adjustments.
- `noseek/check-delta.sh`: Verification script ensuring no unledgered upstream files are modified.
- `.agents/skills/noseek-upstream-sync/SKILL.md`: Operational skill guiding agents and contributors through upstream release tag syncs.
