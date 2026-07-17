# Phase 4 — sensor-coverage WASM pthread architecture audit

Artifact under audit: `analysis/sensor-coverage/dist/isomorphic/module.wasm`
sha256 `0e676f674ec5c3aaee4f9d8b020006970cbf8982c57cec917fd807de527b7ae8`
(232,763 bytes on disk; 229,923 bytes loadable wasm + 2,840-byte signed
publication trailer).

Auditor scope: **evidence + recommendation only.** No production source,
manifest, or build config was modified; the wasm was not rebuilt. One new
test file was added (`tests/artifact_contract.test.mjs`) and this report.

Toolchain observed locally: `emcc`/`em++` 4.0.23-git at `/opt/homebrew/bin`
(Homebrew system emscripten). **No repo-local emsdk** exists for this module
(it builds through `scripts/build-sdk-compiled-module.mjs` →
`sdk.compileModuleFromSource`, which requires a system/local emsdk for
shared-memory builds — `resolveCompileOptions`, build-sdk-compiled-module.mjs
:122-127). The committed artifact predates this checkout; the version that
produced it is not recorded in-tree. Record: **whatever emsdk produced it
emitted the emscripten pthread-runtime scaffolding described below.**

---

## 1. Exact compiler flag set the SDK produces for this module

Inputs (package.json `sdnModuleCompile`): `importedMemory: true`,
`sharedMemory: true`, `initialMemoryBytes: 67108864` (64 MiB),
`maximumMemoryBytes: 2147483648` (2 GiB). Manifest `runtimeTargets:
["browser"]`.

Thread-model resolution (compileModule.js):
- `resolveThreadModel({manifest})` — runtimeTargets `["browser"]` →
  `ModuleThreadModel.SINGLE_THREAD` (:190-191).
- `usesPthreadCompileFlags({sharedMemory:true})` → **true** regardless of
  thread model, because `sharedMemory === true` (:98-103). This is the crux:
  the artifact is single-thread by thread-model but still gets `-pthread` +
  `SHARED_MEMORY` because it opts into shared memory for zero-copy output.
- `requiresSystemEmscripten(SINGLE_THREAD, {sharedMemory:true})` → **true**
  (:199-204) → compiled via `compileWithSystemEmscripten` (not emception).
- `noEntry: includeCommandMain !== true` → **true** (manifest has no command
  surface; `invokeSurfaces: ["direct"]`) → `--no-entry` (STANDALONE reactor).

Per-source compile args (`buildSourceCompilerArgs`, :146-162):
```
-O3  -mbulk-memory  -DNDEBUG  -pthread
```

Link args (`buildCompilerArgs`, :105-143), reconstructed for
`{importedMemory:true, sharedMemory:true, threadModel:SINGLE_THREAD,
noEntry:true}`:
```
em++ -O3 --no-entry -mbulk-memory -pthread \
     -s STANDALONE_WASM=1 \
     -s IMPORTED_MEMORY=1 \
     -s SHARED_MEMORY=1 \
     -s ALLOW_MEMORY_GROWTH=1 \
     -Wl,--export=plugin_alloc -Wl,--export=plugin_free \
     -Wl,--export=plugin_invoke_stream \
     -Wl,--export=plugin_get_manifest_flatbuffer \
     -Wl,--export=plugin_get_manifest_flatbuffer_size \
     -Wl,--export=compute_sensor_coverage
```
Notes:
- `-pthread` + `SHARED_MEMORY=1` pull in emscripten's **pthread-enabled libc
  runtime scaffolding** (TLS init, main-thread registration, mailbox
  proxying) even though no application code spawns a thread. That scaffolding
  is the source of the `env::_emscripten_*` imports inventoried in §2.
- `ALLOW_MEMORY_GROWTH=1` is added because `threadModel !==
  EMSCRIPTEN_PTHREADS` (:123-124).
- The SDK sets **no** `INITIAL_MEMORY`/`MAXIMUM_MEMORY` flags (grep of
  `src/compiler/` finds none). The artifact's declared import limits
  (min 256 pages / 16 MiB, max 32768 pages / 2 GiB — see §2) are emscripten's
  **defaults** for a `SHARED_MEMORY` build; they are NOT derived from
  `sdnModuleCompile.initialMemoryBytes`. The 64 MiB `initialMemoryBytes` value
  governs the **host-supplied** `WebAssembly.Memory` at load time
  (`createBrowserModuleHarness`), not the artifact's declared minimum.
- Manifest embedding: `appendWasmCustomSection(..., SDS_MANIFEST_SECTION_NAME
  = "sds.manifest", ...)` (compileModule.js:843-847; constant in
  bundle/constants.js:8). See §1a for what the shipped artifact actually
  carries.

### 1a. Packaged assets + how the manifest is actually carried

`dist/` contains exactly one file: `dist/isomorphic/module.wasm`. **There are
no packaged browser worker assets** (no `dist/browser/` glue `.js`, no worker
shim) — unlike the reference pthread module conjunction-assessment, whose
`build.sh` emits three artifacts including a `dist/browser` pthread adapter
with `USE_PTHREADS=1 PTHREAD_POOL_SIZE=8`. sensor-coverage ships a single
standalone wasm loaded directly by the SDK/browser harness.

Section walk of the **loadable** wasm (publication trailer stripped via
`toLoadableWasmBytes`): 11 standard sections (type, import, function, table,
global, export, start, element, datacount, code, data) and **zero custom
sections**. The `"sds.manifest"` named record is present only inside the
2,840-byte signed publication trailer (alongside `sds.signature`, `$REC`,
and a `$PLG` copy). The **canonical runtime manifest is baked into the data
segment as a `$PLG` FlatBuffer** and returned by the
`plugin_get_manifest_flatbuffer` export (see §1b).

### 1b. Manifest fields (decoded from the running artifact)

Instantiated the artifact under Node's `WebAssembly` via the SDK browser
harness, called `plugin_get_manifest_flatbuffer_size()` /
`plugin_get_manifest_flatbuffer()`, copied the bytes out of shared memory and
decoded with the SDK `decodePluginManifest`:

```
file_identifier @4..8 : "$PLG"     (ptr=5856, size=1452)
pluginId             : sensor-coverage-analysis
version              : 0.1.0
pluginFamily         : analysis
runtimeTargets       : ["browser"]
invokeSurfaces       : ["direct"]
capabilities         : []
abiVersion           : 1
methods              : ["compute_sensor_coverage"]
method[0] input type : {schemaName:"SCV/main.fbs", fileIdentifier:"$SCV",
                        rootTypeName:"SCV", wireFormat:"flatbuffer",
                        requiredAlignment:8}
```
This matches the on-disk `plugin-manifest.json` exactly. The runtime-returned
manifest is the honest source of truth: **browser-only, direct-invoke-only,
no capabilities.**

---

## 2. Import / export / memory inventory (SDK `inspectModule`)

Profile classification: **`standalone`** (`detectArtifactProfile`,
browserModuleHarness.js:132-166).

Import namespaces: `["env", "wasi_snapshot_preview1"]`.

WASI imports (functions): `clock_time_get`, `fd_close`, `fd_write`,
`fd_seek`, `proc_exit`.

`env` imports (9 total — 1 memory + 8 functions):
```
env::memory                                   [memory]  (shared)
env::emscripten_check_blocking_allowed        [function]
env::_emscripten_receive_on_main_thread_js    [function]
env::_emscripten_init_main_thread_js          [function]
env::_emscripten_thread_mailbox_await         [function]
env::_emscripten_thread_set_strongref         [function]
env::emscripten_exit_with_live_runtime        [function]
env::_emscripten_notify_mailbox_postmessage   [function]
env::_emscripten_thread_cleanup               [function]
```
Every one of these 8 functions is in the SDK's
`STANDALONE_SHARED_MEMORY_ENV_STUBS` allowlist
(browserModuleHarness.js:68-84). The artifact imports a **strict subset** of
the allowlist (it does not import the mutex/cond stubs
`pthread_mutex_lock/unlock`, `pthread_cond_wait/broadcast`, `__get_tp`,
`__do_set_thread_state`, `emscripten_thread_sleep`). Because every `env`
import is in the allowlist, `usesOnlyStandaloneSharedMemoryEnvImports` is
true, so `detectArtifactProfile` skips the "emscripten" branch (guarded at
:140) and returns `standalone` (:161-163).

Memory import (binary-parsed limits section, flags byte = 0x03):
```
env::memory  shared=true  min=256 pages (16 MiB)  max=32768 pages (2 GiB)
```

Exports (20): `compute_sensor_coverage`, `plugin_alloc`, `plugin_free`,
`plugin_invoke_stream`, `plugin_get_manifest_flatbuffer`,
`plugin_get_manifest_flatbuffer_size`, `__indirect_function_table`,
`_emscripten_tls_init`, `pthread_self`, `_initialize`,
`_emscripten_thread_init`, `_emscripten_thread_crashed`,
`_emscripten_run_js_on_main_thread`, `_emscripten_thread_free_data`,
`_emscripten_thread_exit`, `_emscripten_check_mailbox`,
`emscripten_stack_set_limits`, `_emscripten_stack_restore`,
`_emscripten_stack_alloc`, `emscripten_stack_get_current`. No `_start`
(reactor).

---

## 2 (binary evidence). No thread-spawn

- `hasPthreadCreateImport` = **false**. No import named `pthread_create` or
  `__pthread_create_js` exists (the entire import set is listed above).
- **No thread-spawn export.** The `pthread_*`/`_emscripten_thread_*` exports
  are TLS/lifecycle entry points (`pthread_self`, `_emscripten_thread_init`,
  `_emscripten_thread_exit`, `_emscripten_thread_crashed`,
  `_emscripten_check_mailbox`, …) that a host worker would call to *service*
  a spawned thread — none of them *create* one, and there is no importer to
  drive them because nothing spawns. `compute_sensor_coverage` is the only
  application export.
- Source corroboration (verified context, spot-checked against
  `tests/behavior.test.mjs` which greps `src/cpp/module.cpp`): no
  `pthread_create`, `std::thread`, or OpenMP. Shared memory is used solely as
  the **zero-copy output mechanism** (`append_shared_memory_region`); the SCV
  result declares module-owned regions marked `SHARED()==true`,
  `MUTABLE()==false` (asserted in behavior.test.mjs).

inspectModule + the import list are conclusive; strings/disassembly not
required.

---

## 3. Browser loader audit — can a stubbed thread call corrupt results?

**Two loaders stub these imports:**

1. SDK `createBrowserModuleHarness` (browserModuleHarness.js). Gate:
   `addStandaloneSharedMemoryEnvStubs` (:107-125) installs stubs **only if**
   `usesOnlyStandaloneSharedMemoryEnvImports(envImports)` (:100-105) — i.e.
   only if *every* `env` import is in the allowlist. Stub semantics
   (:68-84): all return `0` or are no-ops.

2. OrbPro `packages/orbpro-integration/sdkEnvFallbackHarness.js`
   `createEnvStubs()` (:168-195). Same 8 housekeeping stubs as no-ops, **plus
   `__pthread_create_js: () => 6`** — i.e. it returns a non-zero errno
   (EAGAIN-class) so that *if* a module ever tried to spawn a thread,
   `pthread_create` **fails hard** rather than silently succeeding with a
   phantom worker. (That harness was written for conjunction-assessment on
   emsdk 3.1.51; sensor-coverage does not import `__pthread_create_js`, so the
   guard is dormant here — but it documents the project's fail-closed intent.)

**Empirical bring-up trace.** Raw-instantiated the artifact with
call-counting wrappers on all 8 env stubs + WASI. During `_initialize()` only
**two** stubs fire, once each: `_emscripten_init_main_thread_js` and
`_emscripten_thread_mailbox_await`. During `plugin_get_manifest_flatbuffer`,
**zero** stubs fire. The other six env imports are never called at load or
manifest time.

**Can any stub corrupt results?** No. Analysis of each imported stub:

| import | stub | role | single-thread correctness of no-op/0 |
|---|---|---|---|
| `_emscripten_init_main_thread_js` | 0 | register the main thread | main thread already running; TLS set by `_emscripten_tls_init`. No-op correct. |
| `_emscripten_thread_mailbox_await` | 0 | block for a cross-thread mailbox msg | zero workers → nothing to await. No-op correct. |
| `_emscripten_notify_mailbox_postmessage` | 0 | wake a worker's mailbox | zero workers → nothing to notify. No-op correct. |
| `_emscripten_receive_on_main_thread_js` | 0 | run a proxied call *from* a worker on main | zero workers → never invoked with a real proxied call. Return value unused. |
| `_emscripten_thread_set_strongref` | 0 | GC strongref a worker | zero workers. No-op correct. |
| `_emscripten_thread_cleanup` | 0 | tear down a finished worker | zero workers. No-op correct. |
| `emscripten_check_blocking_allowed` | 0 | assert blocking is permitted | main-thread reactor; 0 = allowed. No-op correct. |
| `emscripten_exit_with_live_runtime` | 0 | keep runtime alive past `main` | reactor never returns from `main`. No-op correct. |

**Key property:** *none* of these functions returns a value that
`compute_sensor_coverage` consumes as data. They are fire-and-forget
lifecycle/notification hooks whose only observable effects exist in a
**multi-worker topology this binary never creates** (it imports no
thread-spawn primitive). A no-op is therefore the *semantically correct*
behavior for a single main thread, not merely a tolerated degradation. This
is the exact opposite of the dangerous case — a module that *does* call
`pthread_create` and expects real parallelism: there a "success"-returning
stub would create a phantom thread whose assigned work never runs → **silent
missing results**. sensor-coverage cannot enter that path.

**Independent confirmation:** the committed `tests/behavior.test.mjs` (35
tests, all green in this audit) drives **real** `compute_sensor_coverage`
invocations through exactly these SDK stubs and asserts exact numeric
outputs (e.g. `TOTAL_WINDOWS()==2`, `RASTER_PRODUCTS().CELL_COUNT()==24`,
finite/unit-length packed geometry). Correct results through the stub env =
no corruption, demonstrated end-to-end.

**Fail-closed for a single-thread build — met.** Two independent guards:
- *Loader gate (SDK):* if a future rebuild introduced any `env` import
  outside the allowlist (e.g. `pthread_create`, `__pthread_create_js`),
  `usesOnlyStandaloneSharedMemoryEnvImports` → false, so
  `detectArtifactProfile` classifies it `emscripten` (the `hasPthreads`
  branch, :144-149) and `createBrowserModuleHarness` **refuses to load it**
  (the reference conjunction-assessment sdk_compat.test.mjs:254-263 shows the
  browser harness rejecting a threaded artifact with "Browser harness only
  supports standalone WASI…"). The gate is a closed set; drift fails loud.
- *Spawn guard (OrbPro):* any accidental thread spawn resolves to
  `__pthread_create_js → 6` (failure), not a silent phantom worker.

The one residual assumption: fail-closed depends on the allowlist staying a
*closed* set (no one adding `pthread_create` to
`STANDALONE_SHARED_MEMORY_ENV_STUBS`). That is an SDK-level invariant, out of
this artifact's scope; the new contract test pins the artifact's import set so
any drift in the **artifact** is caught here.

---

## 4. WasmEdge real-invocation attempt

**Blocked: WasmEdge is not installed on this host.**
- `command -v wasmedge` → not on PATH; `spawnSync("wasmedge",["--version"])`
  → `status:null error:ENOENT` (this is exactly the SDK's
  `isWasmEdgeAvailable()` probe, isomorphicHarness.mjs:31-34 — it returns
  false, so the standalone harness would `t.skip`).
- No WasmEdge C API present either (`/usr/local/include/wasmedge`,
  `/opt/homebrew/include/wasmedge`, `libwasmedge*` — none found), so
  `buildWasmEdgeEmscriptenPthreadRunner` (used by conjunction-assessment's
  `wasmedgePthreadRunner.mjs`) cannot build a runner here.

**Context:** WasmEdge is *not part of this module's declared contract* —
`runtimeTargets` is `["browser"]` only, which the SDK maps to
`SINGLE_THREAD`; the WasmEdge-threaded lane exists for modules that declare
`wasmedge` (e.g. conjunction-assessment's `dist/isomorphic`). The correct
"real invocation" path for sensor-coverage is the **browser/isomorphic loader
under a JS `WebAssembly` engine**, which this audit exercised:

- **Instantiated** `dist/isomorphic/module.wasm` under Node
  `WebAssembly.instantiate` (via `createBrowserModuleHarness`, shared
  `WebAssembly.Memory` initial 64 MiB / max 2 GiB) — success, only the
  stubbed env housekeeping + shared memory supplied. `memory.buffer instanceof
  SharedArrayBuffer` = true.
- **Drove `plugin_get_manifest_flatbuffer`** — returned the `$PLG` manifest
  decoded in §1b (ptr=5856, size=1452), exit/no-trap.
- **Drove `compute_sensor_coverage`** — the committed behavior suite runs a
  minimal single-sensor SCV request plus metric/swath/multi-sensor variants
  through the direct-invoke surface: `node --test tests/behavior.test.mjs` →
  **35 pass / 0 fail** (exit 0). Real compute, exact results, under the same
  single-thread stub env a browser COI page uses.

Commands + exit codes:
```
$ command -v wasmedge                       # (no output) — not installed
$ node -e '…spawnSync wasmedge --version…'  # status:null error:ENOENT
$ node --test tests/behavior.test.mjs       # exit 0 — 35 pass / 0 fail
$ node --test tests/artifact_contract.test.mjs   # exit 0 (see §6)
```

---

## 5. Architecture recommendation

**Recommendation: keep the artifact single-thread canonical, and label it
honestly. Retain shared memory ONLY as the zero-copy output mechanism it
actually is.**

Evidence supporting single-thread-canonical:
- The binary contains **no parallelism**: no `pthread_create`/`std::thread`/
  OpenMP in source, no thread-spawn import or export, and the compute is
  fully sequential (behavior suite is deterministic).
- The `-pthread` + `SHARED_MEMORY` flags are a **side effect of opting into
  shared memory for zero-copy output** (`usesPthreadCompileFlags` triggers on
  `sharedMemory===true`), not a parallel-compute design. The resulting
  `env::_emscripten_*` imports are inert pthread-runtime scaffolding, safely
  stubbed (§3).
- Shared `env.memory` earns its keep independently of threading: the SCV
  result publishes module-owned, immutable, `SHARED()==true` regions the host
  reads without a copy (verified in behavior.test.mjs). That is the honest,
  load-bearing reason for `SharedArrayBuffer` — **not** worker parallelism.

**Honest labeling actions (documentation/contract only, no rebuild):**
- Describe the artifact as *single-thread, shared-memory-for-zero-copy-output*
  wherever its "SharedArrayBuffer + pthreads" nature is referenced, so the
  shared memory is not mistaken for in-module parallelism. The pthread-runtime
  imports/exports are scaffolding, not a compute thread pool.
- The new `tests/artifact_contract.test.mjs` pins this contract (profile
  standalone, no spawn import, shared memory min/max, allowlisted
  housekeeping only, browser/direct manifest) so any accidental drift toward
  a real- or fake-threaded build fails in CI.

**Do NOT convert this artifact to actual pthreads as part of Phase 4.** Real
in-module parallelism is already scoped as a separate task:

> **C6 — SDN SDK module parallelization paradigm: SharedArrayBuffer +
> pthreads** (ORBPRO_SENSOR_COVERAGE_LOOP.md:846-864, owner directive
> 2026-07-17). Scope: compile sensor-coverage with wasm threads (`-pthread`,
> SAB-backed memory, **thread pool**) so the coverage cells loop parallelizes
> *inside* the module isomorphically; audit the SDK harness + COI loader for
> threaded-module loading; prototype a `-pthread` build with the cells loop
> parallelized; verify **browser (COI) + WasmEdge parity**; roll the pattern
> into the module SDK as standard. Test target: speedup ≈ cores on the 30 km
> grid, physics gate 6/6, module tests green in both harnesses, non-threaded
> fallback refused/gated.

Phase 4's job is the honest baseline (this report + contract pin). C6 owns
the real-pthreads conversion (thread pool, EMSCRIPTEN_PTHREADS thread model,
WasmEdge wasi-threads story, speedup benchmark). **No overlap:** when C6
lands, the artifact will legitimately import `pthread_create`, resolve to
`EMSCRIPTEN_PTHREADS`, declare `wasmedge` in `runtimeTargets`, and this
single-thread contract test will *correctly* fail and be replaced by C6's
threaded contract tests.

---

## 6. New contract test

Added `tests/artifact_contract.test.mjs` (node --test, sdk_compat.test.mjs
style). It pins the honest single-thread contract and fails on any drift:
- `inspectModule(...).profile === "standalone"`.
- No pthread-spawn **import** (`pthread_create` / `__pthread_create_js`) and
  no pthread-spawn **export**.
- `env.memory` import is **shared** with min=256 pages (16 MiB) / max=32768
  pages (2 GiB) — parsed from the binary import section.
- Every non-memory `env` import is within the SDK stub allowlist (mirrored
  from browserModuleHarness.js:68-84), and the artifact is accepted by
  `createBrowserModuleHarness` (which enforces the real allowlist).
- On-disk + runtime-embedded manifest both declare `runtimeTargets:
  ["browser"]` and `invokeSurfaces: ["direct"]`.

Run against the current artifact (sha256 `0e676f67…7b7ae8`, unchanged by this
audit):
```
$ node --test tests/artifact_contract.test.mjs
# exit 0 — tests 6, pass 6, fail 0
```
