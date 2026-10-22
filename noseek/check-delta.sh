#!/usr/bin/env bash
set -euo pipefail

# Check that every modified upstream file is documented in noseek/DELTA.md

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BASE_TAG="${1:-dsh-v0.2.1-alpha.1}"
LEDGER="noseek/DELTA.md"

if [ ! -f "$LEDGER" ]; then
  echo "Error: $LEDGER does not exist!" >&2
  exit 1
fi

echo "Checking fork delta against base tag: $BASE_TAG..."

# Files changed compared to upstream base tag
CHANGED_FILES=$(git diff --name-only "$BASE_TAG" 2>/dev/null || true)

ERRORS=0

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Skip noseek-owned files/directories
  case "$file" in
    noseek/*|.github/README.md|.agents/skills/noseek-upstream-sync/*)
      continue
      ;;
  esac

  # Verify if file is recorded in the ledger
  if ! grep -Fq "\`$file\`" "$LEDGER"; then
    echo "ERROR: Upstream file '$file' is modified but not listed in $LEDGER!" >&2
    ERRORS=$((ERRORS + 1))
  fi
done <<< "$CHANGED_FILES"

if [ "$ERRORS" -gt 0 ]; then
  echo "Delta check failed: $ERRORS unledgered upstream file(s) found." >&2
  exit 1
fi

echo "Delta check passed: All modified upstream files are accounted for in $LEDGER."
