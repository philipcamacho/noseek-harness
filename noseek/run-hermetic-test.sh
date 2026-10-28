#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Docker requested via env or flag
if [[ "${DOCKER_HERMETIC:-0}" == "1" ]] || [[ "${1:-}" == "--docker" ]]; then
  if command -v docker >/dev/null 2>&1; then
    echo "[run-hermetic-test] Running in Docker with --network none..."
    exec docker run --rm -it --network none -v "$REPO_ROOT:/workspace" -w /workspace node:24-alpine sh -c "pnpm exec tsx noseek/hermetic-network-test.ts"
  else
    echo "[run-hermetic-test] Docker requested but not found. Falling back to host runner." >&2
  fi
fi

OS="$(uname -s)"
if [[ "$OS" == "Linux" ]]; then
  STRACE_LOG="$(mktemp -t hermetic-strace-XXXXXX.log)"
  export STRACE_LOG

  # Check if unshare is available with network namespace support
  UNSHARE_CMD=""
  if command -v unshare >/dev/null 2>&1; then
    if unshare -rn true 2>/dev/null; then
      UNSHARE_CMD="unshare -rn"
    fi
  fi

  # Check if strace is available
  STRACE_CMD=""
  if command -v strace >/dev/null 2>&1; then
    STRACE_CMD="strace -f -e trace=connect -o $STRACE_LOG"
  fi

  echo "[run-hermetic-test] Linux detected (unshare='${UNSHARE_CMD:-none}', strace='${STRACE_CMD:-none}')"

  cleanup() {
    rm -f "$STRACE_LOG"
  }
  trap cleanup EXIT

  if [[ -n "$UNSHARE_CMD" ]]; then
    # Bring up loopback interface inside the unshare network namespace
    $UNSHARE_CMD sh -c "ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true; ${STRACE_CMD:+$STRACE_CMD} pnpm exec tsx $SCRIPT_DIR/hermetic-network-test.ts"
  elif [[ -n "$STRACE_CMD" ]]; then
    $STRACE_CMD pnpm exec tsx "$SCRIPT_DIR/hermetic-network-test.ts"
  else
    pnpm exec tsx "$SCRIPT_DIR/hermetic-network-test.ts"
  fi
else
  # macOS / other: run with loopback guard inside the process
  echo "[run-hermetic-test] macOS / non-Linux host ($OS) detected: running with process-level loopback guard."
  pnpm exec tsx "$SCRIPT_DIR/hermetic-network-test.ts" "$@"
fi
