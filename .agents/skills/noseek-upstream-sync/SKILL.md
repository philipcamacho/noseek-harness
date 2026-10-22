---
name: noseek-upstream-sync
description: Use when syncing changes from upstream deepseek-harness into the Noseek fork, merging a new upstream release tag (dsh-v*), reviewing upstream diffs for new telemetry or egress endpoints, resolving merge conflicts with DELTA.md, and validating privacy gates.
---

# Noseek Upstream Sync Protocol

This skill guides maintainers and AI agents through merging upstream `deepseek-harness` releases into the `noseek-harness` fork while preserving all privacy guarantees and minimizing merge conflicts.

---

## 1. Preflight & Target Selection

1. **Verify Clean Working Tree:**
   ```sh
   git status --short
   ```

2. **Fetch Upstream Release Tags:**
   ```sh
   git fetch upstream --tags
   ```

3. **Identify Target Tag:**
   Always sync against official release tags (`dsh-v*`), never against untagged commits on upstream `master`.
   Find the latest tag that is ahead of the current base:
   ```sh
   git tag --list 'dsh-v*' --sort=v:refname | tail -5
   ```

4. **Create Sync Branch:**
   ```sh
   git checkout -b sync/<tag-name> master
   ```

---

## 2. Pre-Merge Diff Reconnaissance

Before running `git merge`, thoroughly inspect the upstream diff between the last merged tag and the new target tag:

```sh
git diff <previous-tag>..<new-tag> --stat
```

Pay special attention to:
- **New Outbound Endpoints & Hostnames:**
  Search the incoming diff for URL patterns (`https?://`) outside unit tests. Check whether any new host belongs to Chinese infrastructure or unadvertised analytics services.
- **New Plugins & Cordis Patch Rows:**
  Inspect incoming edits to `cordis.patch.yml` files and `PROFILE_TEMPLATES`. If upstream mounts new telemetry, analytics, or platform plugins, add them to the quarantine list in [noseek/WHITELABEL_PLAN.md](file:///Users/philipcamacho/Documents/Git-Repos/noseek-harness/noseek/WHITELABEL_PLAN.md).
- **New or Changed Network Call Sites:**
  Inspect additions of `fetch(`, `http.request`, WebSocket connections, or background child process spawners.
- **Dependency & Workflow Changes:**
  Check `package.json`, `pnpm-lock.yaml`, and `.github/workflows/`. Ensure upstream automation workflows carry appropriate repository guards.

---

## 3. Merge & Conflict Resolution

1. **Merge the Tag:**
   ```sh
   git merge <new-tag> --no-commit
   ```

2. **Resolve Conflicts with `noseek/DELTA.md`:**
   Consult [noseek/DELTA.md](file:///Users/philipcamacho/Documents/Git-Repos/noseek-harness/noseek/DELTA.md) for every conflicted upstream file. The ledger defines:
   - Why the upstream file was modified.
   - The minimal hook or delta that must be preserved.
   - The conflict resolution strategy for that specific file.

3. **Verify Upstream Doc Cleanliness:**
   Ensure root `README.md` and `README.zh.md` match upstream exactly. Do not keep fork-specific documentation in upstream doc files. Fork documentation belongs in `.github/README.md` and `noseek/`.

---

## 4. Run Verification Gates

Run the local gates to verify that privacy invariants and repository health hold:

1. **Check Fork Delta Ledger:**
   ```sh
   bash noseek/check-delta.sh <new-tag>
   ```
   Ensures every modified upstream file is documented in `noseek/DELTA.md`.

2. **Run Privacy Audit & Gates:**
   ```sh
   pnpm run audit:privacy
   ```

3. **Run Typecheck & Doc Checks:**
   ```sh
   pnpm run typecheck
   pnpm run test:docs
   ```

> [!CAUTION]
> **Never weaken a privacy gate to make a sync pass.** If a gate fails, either add a quarantine entry for the offending new component or pause and report the issue.

---

## 5. Update Documentation & Open PR

1. **Update `noseek/DELTA.md`:**
   Record any adjusted hooks, updated line ranges, or new files.

2. **Record Entry in `noseek/CHANGELOG.md`:**
   Document the merged tag, summary of upstream changes, newly quarantined items, and gate verification results.

3. **Commit and Open Pull Request:**
   ```sh
   git commit -m "sync(upstream): merge <tag-name>"
   git push origin sync/<tag-name>
   ```
   Open a pull request targeting `master`. Never push directly to `master`.
