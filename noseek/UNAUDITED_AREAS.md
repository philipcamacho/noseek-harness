# Technical Audit: Unaudited Areas (`python/`, `native/`, `vendor/`)

This document records the technical audit mandated by **§2.14** and **Phase 1 Action 6** of [`noseek/WHITELABEL_PLAN.md`](WHITELABEL_PLAN.md).

Prior to this audit, `python/`, `native/`, and `vendor/` were marked as unreviewed for outbound network egress, remote tracking endpoints, and telemetry calls. This report provides an exhaustive, code-level review of each area, cataloging all file paths, I/O patterns, network interfaces, and confirming compatibility with Noseek's zero-automatic-egress privacy boundary.

---

## Executive Summary

| Subsystem | File Paths Audited | External Egress / Network Calls | Telemetry / Tracking | Privacy Status |
| :--- | :--- | :--- | :--- | :--- |
| **Python SDK & Runtime** | `python/sdk/src/deepseek_harness/**`<br>`python/sdk-runtime/**`<br>`python/sdk/tests/**` | **None** (Communicates exclusively via `stdio` JSON-RPC pipes with local runtime subprocess) | **None** | **Safe / Hermetic** |
| **Native System Addon** | `native/system/packages/entry/src/**`<br>`native/system/scripts/**` | **None** (Only uses kernel syscalls for POSIX `flock` and Linux Landlock sandbox confinement) | **None** | **Safe / Hermetic** |
| **Vendored Cordis** | `vendor/{cordis,cosmokit,group,hmr,include,loader,logger-console,schemastery,timer}/**` | **None** (Purely in-memory dependency injection and local file system operations) | **None** | **Safe / Hermetic** |

> [!NOTE]
> §2.14 of `WHITELABEL_PLAN.md` initially hypothesized that *"the Python SDK makes HTTP calls in `python/sdk/src/deepseek_harness/client.py`"*.
> This audit determined that this assumption was incorrect: `client.py` does **not** make HTTP calls. It manages a local child process using `subprocess.Popen` and exchanges JSON-RPC messages strictly over `stdin` and `stdout` pipes.

---

## 1. Audit of `python/` (Python SDK and Bundled Runtime)

### 1.1 Scope and Components
The `python/` tree contains two packages:
1. `python/sdk/`: The user-facing Python SDK (`deepseek_harness`), providing programmatic session control, office file parsing, and tool integration.
2. `python/sdk-runtime/`: Packaging scripts for bundling platform-specific native binaries into wheel distributions (`deepseek-harness-runtime-bin`).

### 1.2 File-by-File Analysis

#### `python/sdk/src/deepseek_harness/client.py`
- **Transport Mechanism**:
  - Launches the runtime process using `subprocess.Popen` (lines 75–86):
    ```python
    self._proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=None if self.config.cwd is None else str(Path(self.config.cwd).resolve()),
        env=env,
        bufsize=1,
    )
    ```
  - Communication is strictly standard I/O IPC over pipes (`stdin.write()` line 397; reader loop reading lines from `stdout` line 412).
  - Protocol: Standard line-delimited JSON-RPC 2.0.
- **Network / Socket Inspection**:
  - No `socket`, `http.client`, `urllib`, `requests`, `httpx`, or `aiohttp` imports.
  - No network sockets or network connections opened.
- **Configuration & Environment**:
  - Default profile: `self.config.profile = "sdk"`.
  - Enforces explicit `DSH_HOME`: Lines 587–596 enforce that `dsh_home` must be explicitly configured or provided in `os.environ["DSH_HOME"]`, refusing to fall back implicitly to `~/.dsh`.
  - Pass-through CLI flags: Passes `--profile <profile>` and `--patch <path>` to the subprocess command line.

#### `python/sdk/src/deepseek_harness/api.py`
- High-level object model (`Harness`, `HarnessSession`).
- Delegates all operations to an underlying `HarnessClient` instance (`session_prompt`, `initialize`, `resume_session`, etc.).
- Contains zero network or I/O calls.

#### `python/sdk/src/deepseek_harness/office.py`
- Synchronous document text extractor and renderer for office formats (DOCX, PPTX, XLSX, PDF).
- Explicitly documented: *"Calls are synchronous and do not create agents, sessions, or model requests."*
- Operates strictly on local file buffers in memory. Zero external egress.

#### `python/sdk/src/deepseek_harness/models.py` & `errors.py`
- Pydantic models for JSON-RPC structures (`InitializeResponse`, `ContentBlock`, `UserQuestionRequest`, etc.) and exception classes (`JsonRpcError`, `TransportClosedError`).
- Purely declarative; zero I/O.

#### `python/sdk-runtime/src/deepseek_harness_runtime/_resources.py`
- Resolves file path to the locally installed executable `node_modules/.bin/dsh`.
- Zero network I/O.

#### `python/sdk/tests/`
- `manual_sdk_agent_smoke.py`: Contains a local test fixture using Python's standard library `ThreadingHTTPServer(("127.0.0.1", 0))` to mock an LLM completion endpoint on localhost for manual verification. Sets `DSH_TELEMETRY_DISABLED: "1"`.
- `test_smoke_model.py`: Uses `urllib.request` to test connection against a mocked local loopback server and tests that `DEEPSEEK_BASE_URL="https://api.invalid"` raises expected communication failures when network access is prevented.
- All other tests (`test_client.py`, `test_approval.py`, `test_resume.py`, `test_working_directory.py`, etc.) test local subprocess pipes and JSON-RPC serialization.

### 1.3 Privacy Conclusion for `python/`
The Python SDK is fully hermetic at the Python layer. It contacts no network destinations, exposes no telemetry, and issues no HTTP requests. All external network egress is governed entirely by the underlying `dsh` runtime process it spawns, which is subject to Noseek's base and quarantine layers (`packages/bundle/sdk-minimal`).

---

## 2. Audit of `native/` (`@deepseek-ai/node-addon-system`)

### 2.1 Scope and Components
`native/system/` contains the native C and TypeScript implementations for:
1. `flock`: Cross-platform non-blocking file locking via POSIX `flock(2)`.
2. `landlock-run`: Linux filesystem sandbox confinement launcher via Linux Landlock kernel syscalls.

### 2.2 File-by-File Analysis

#### `native/system/packages/entry/src/flock.c`
- Node-API v8 native C binding for POSIX `flock(fd, LOCK_EX | LOCK_NB)`.
- Includes: `<node_api.h>`, `<errno.h>`, `<limits.h>`, `<stdlib.h>`, `<sys/file.h>`.
- Syscalls used: Purely `flock(request->fd, LOCK_EX | LOCK_NB)`.
- No socket, network, or communication syscalls.

#### `native/system/packages/entry/src/main.c` (`landlock-run`)
- Standalone self-restricting launcher binary written in C11.
- Purpose: Establishes filesystem confinement on Linux using the kernel's Landlock Linux Security Module (LSM).
- Includes: `<errno.h>`, `<fcntl.h>`, `<stdint.h>`, `<stdio.h>`, `<stdlib.h>`, `<string.h>`, `<sys/prctl.h>`, `<sys/stat.h>`, `<sys/syscall.h>`, `<unistd.h>`.
- Syscalls used:
  - `syscall(__NR_landlock_create_ruleset, ...)`
  - `syscall(__NR_landlock_add_rule, ...)`
  - `prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)`
  - `syscall(__NR_landlock_restrict_self, ...)`
  - `execv(cmd_argv[0], cmd_argv)`
- Network / Socket Inspection:
  - The Landlock rule attributes configured in `main.c` manipulate filesystem access flags only (`LANDLOCK_ACCESS_FS_*`).
  - No socket creation, TCP, UDP, or network syscalls exist in `main.c`.

#### `native/system/packages/entry/src/index.ts` & `flock.ts`
- TypeScript wrappers:
  - `index.ts`: Resolves the absolute path to the prebuilt `landlock-run` binary from platform optional packages and constructs `--ro <path>` and `--rw <path>` arguments.
  - `flock.ts`: Asynchronously invokes `tryLockExclusive(fd)` through the Node-API binding.
- Zero network I/O, zero HTTP requests, zero telemetry.

### 2.3 Privacy Conclusion for `native/`
`native/` contains purely local operating system primitives (file locking and process filesystem restriction). It performs zero socket operations, contains no telemetry, and contacts no external hosts.

---

## 3. Audit of `vendor/` (Vendored Cordis Packages)

### 3.1 Scope and Components
`vendor/` contains 9 rescoped packages derived from the Cordis microkernel ecosystem:
1. `vendor/cordis`: In-memory plugin kernel, service dependency injection, and event lifecycle.
2. `vendor/cosmokit`: In-memory utilities (cloning, time parsing, binary conversion, string manipulation).
3. `vendor/schemastery`: Schema validation, declaration, and serialization.
4. `vendor/logger-console`: Console output formatting and ANSI color management.
5. `vendor/group`: Hierarchical plugin grouping.
6. `vendor/hmr`: In-process Hot Module Replacement using local file watching.
7. `vendor/include`: YAML file inclusion directive resolver using local filesystem reads.
8. `vendor/timer`: In-memory timer management (`setTimeout`, `setInterval`, debounce, throttle).
9. `vendor/loader`: Local YAML configuration loader and local plugin module resolver.

### 3.2 Network and Egress Analysis
- **Node.js Built-in Network Module Check**:
  - Scanned all source files across all 9 packages for `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`, and `node:dns`.
  - Result: **0 occurrences**.
- **Web API Check**:
  - Scanned for `fetch`, `WebSocket`, `XMLHttpRequest`.
  - Result: **0 occurrences**.
- **External Endpoints & URLs**:
  - Only URLs present in the entire `vendor/` tree are documentation references in source comments (e.g., links to Node.js ESM documentation, StackOverflow discussions on `ArrayBuffer`, and esbuild GitHub issues).
- **Filesystem I/O**:
  - `vendor/loader/src/index.ts` and `vendor/include/src/index.ts` read local configuration files via `node:fs` / `node:fs/promises`.
  - `vendor/hmr/src/index.ts` observes local directory changes using `node:fs.watch`.
  - None of the file operations traverse or resolve remote network paths.

### 3.3 Privacy Conclusion for `vendor/`
All packages in `vendor/` are strictly local, in-memory infrastructure components. They contain no network call sites, no telemetry, and no egress capability.

---

## 4. Overall Verification Summary

The technical audit across `python/`, `native/`, and `vendor/` confirms that:
1. None of these components possess independent telemetry exporters, analytics ping mechanisms, or China-hosted endpoints.
2. None of these components bypass the Noseek runtime privacy gate or quarantine layer.
3. The Python SDK, native addon system, and vendored Cordis framework operate entirely within local boundaries (stdio pipes, local kernel syscalls, and in-memory execution).
