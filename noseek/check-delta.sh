#!/usr/bin/env bash
set -euo pipefail

# Check that every modified or deleted upstream file is documented in noseek/DELTA.md,
# and that every ledger row in noseek/DELTA.md still differs from the upstream base.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

resolve_base_ref() {
  if [ -n "${1:-}" ]; then
    echo "$1"
    return
  fi
  if git rev-parse --verify upstream/master >/dev/null 2>&1; then
    git merge-base HEAD upstream/master
    return
  fi
  local merge_parent
  merge_parent="$(git log --merges -n 1 --format="%P" | awk '{print $2}')"
  if [ -n "$merge_parent" ]; then
    echo "$merge_parent"
    return
  fi
  echo "dsh-v0.2.1-alpha.1"
}

BASE_REF="$(resolve_base_ref "${1:-}")"
LEDGER="noseek/DELTA.md"

if [ ! -f "$LEDGER" ]; then
  echo "Error: $LEDGER does not exist!" >&2
  exit 1
fi

echo "Checking fork delta against upstream base: $BASE_REF..."

# Upstream files modified or deleted compared to upstream base
CHANGED_UPSTREAM_FILES="$(git diff --diff-filter=MD --name-only "$BASE_REF" 2>/dev/null || true)"

# Extract ledger rows from the "Modified Upstream Files" table in noseek/DELTA.md
LEDGER_FILES="$(awk '
  /^## Modified Upstream Files/ { in_table=1; next }
  /^## / { if (in_table) exit }
  in_table && /^\| `[^`]+`/ {
    line=$0
    sub(/^\| `/, "", line)
    sub(/`.*/, "", line)
    print line
  }
' "$LEDGER")"

ERRORS=0

while IFS= read -r file; do
  [ -z "$file" ] && continue

  if ! echo "$LEDGER_FILES" | grep -Fxq "$file"; then
    echo "ERROR: Upstream file '$file' differs from $BASE_REF but is not listed in $LEDGER!" >&2
    ERRORS=$((ERRORS + 1))
  fi
done <<< "$CHANGED_UPSTREAM_FILES"

while IFS= read -r ledger_file; do
  [ -z "$ledger_file" ] && continue

  if ! echo "$CHANGED_UPSTREAM_FILES" | grep -Fxq "$ledger_file"; then
    echo "ERROR: Ledger row '$ledger_file' in $LEDGER does not differ from $BASE_REF!" >&2
    ERRORS=$((ERRORS + 1))
  fi
done <<< "$LEDGER_FILES"

if [ "$ERRORS" -gt 0 ]; then
  echo "Delta check failed: $ERRORS ledger discrepancy(ies) found." >&2
  exit 1
fi

echo "Delta check passed: All modified upstream files match $LEDGER."
