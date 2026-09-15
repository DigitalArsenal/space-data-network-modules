# Lane09 second-pass verification — 2026-09-15

## Outcome

Python ctypes executes all nine committed C++ WASM artifacts through WasmEdge
0.16.4. The fresh installed wheel passes **36 tests and2194 subtests**, including all9
authoritative numerical cases; generated imports, runtime
ownership, real pthread execution, packaging integrity, NumPy marshalling and
stream framing are tested. The two original distribution blockers are resolved.

**The wider lane gate is not wholly green.** The SDK command-parity harness
rejects access/conjunction's legacy Emscripten profiles in its browser lane;
clean main has the existing compliance/layout failures, and an events source
build regression. No alternate artifact or Python physics masks these failures.

## Revisions and artifact identity

- Modules baseline: `e4612363998bd1c732aaab2b242de0015104f096`.
- Artifact set SHA256: `f1dde329812d7404eba8f1969b6aae38c00b4a30088f40d01e2ffaebb0de7160`.
- SDS immutable generated source: `b76da41467e260c83b3432ba7f34a1eb05cc7ac7`,1.217.0.
- Full4505-file `lib/py` manifest SHA256:
  `2040dce21fb7725099876b50b19c5fb37e4b6b403c48ac54a83b90e46077653a`.
- Python:3.14, macOS arm64; native WasmEdge library:0.16.4.

`artifacts.lock.json` hashes each complete artifact including any publication
trailer. The runtime verifies those bytes and strips a trailer only to give the
WASM executable payload to the engine, matching the SDK loader. The distribution
does not substitute the conjunction recovery/single-thread artifact.

## Python tests

Commands from the modules root (the build venv supplies `python`):

```sh
PYTHONPATH=packages/python-astro/src:packages/python-astro python -m pytest -q -s packages/python-astro/tests/test_numerical.py
# 9 passed
PYTHONPATH=packages/python-astro/src:packages/python-astro python -m pytest -q -s packages/python-astro/tests -k 'not numerical'
# 25 passed, 9 deselected, 2194 subtests passed
```

See [authoritative-vectors.md](authoritative-vectors.md) for all sources,
frames, time scales, tolerances, rationales and measured errors. The packaged
wheel is also tested from a fresh venv with no source-package PYTHONPATH; its
receipt is `evidence/second-pass-installed-wheel.log`:

```sh
# From packages/python-astro, after installing the wheel into a fresh venv:
PYTHONPATH=/Users/tj/software/worktrees/modules-python-astro/packages/python-astro /private/tmp/lane09-python-wheel-secondpass-20260915/bin/python -m pytest -q -s tests
# 36 passed, 2194 subtests passed in 59.07s
```

The initial combined test attempt failed4 REC import subtests because its venv
lacked cryptography. That is preserved in `second-pass-python.log`. Adding the
explicit cryptography46.0.4 runtime dependency resolves it; it is not a missing
SDS symbol or a skipped/expected-failure test.

Additional checks cover all9 artifact identities/instantiations, exact native
version and C-value layout, separate memories, bounds,100 repeated allocation/
invoke/free failures without memory-page growth, PIV malformed envelopes,
absolute guest alignment through32768 bytes, serialized teardown, generated RFM unions, catalog replacement and NumPy array marshalling.
The conjunction runtime test requested2 workers and observed3 guest threads.

## Build and SDK compatibility

Clean-main baseline and all exact commands/environment/logs are in
[evidence/second-pass-baseline/README.md](evidence/second-pass-baseline/README.md)
and `build-checks.json`. Eight builds complete; events fails. Modules use
SDK-backed build scripts and repo-local EMSDK.

| Module | Build command | Build | SDK check summary |
| --- | --- | --- | --- |
| SGP4 | `bash build.sh` | PASS | `node --test tests/sdk_compat.test.mjs`:7pass,0fail |
| HPOP | `bash build.sh` | PASS | `node --test tests/sdk_compat.test.mjs`:9pass,1fail |
| Estimation | `node build.mjs` | PASS | no sdk_compat suite; `tests/conformance.test.mjs`:1pass,0fail |
| Conjunction | `bash build.sh` | PASS | `node --test tests/sdk_compat.test.mjs`:9pass,1fail |
| Access | `node build.js --force` | PASS | `node --test test/manifestContract.test.mjs`:0pass,1fail; layout-adapted5pass,0fail |
| Events | `node build.mjs` | FAIL | committed artifact `tests/sdk_compat.test.mjs`:2pass,0fail |
| Lambert | `node build.mjs` | PASS | `node --test tests/sdk-compat.test.mjs`:14pass,2fail |
| Time | `node build.mjs` | PASS | `node --test tests/sdk_compat.test.mjs`:4pass,0fail |
| Frames | `node build.mjs` | PASS | `node --test tests/sdk_compat.test.mjs`:5pass,0fail |

Rebuilt SGP4/HPOP/estimation/Lambert/time are byte-identical to main. Rebuilt
access/conjunction/frames differ; the Python package retains the original
committed artifacts. Build schemas were supplied from the canonical SDS working
tree, which later proved dirty in RFM. The baseline receipt states this explicitly;
these three rebuilds are not exact distributed-byte verification. Python
vendoring uses immutable Git objects and is unaffected by that dirt.

### Exact pre-existing clean-main failures

All four first-pass counts reproduce on clean `e461236` committed artifacts:

1. HPOP9/1: `built artifact passes SDK compliance checks`; missing-canonical-file-identifier,
   missing-aligned-file-identifier, paired-type-identity-mismatch.
2. Conjunction9/1: same test name; missing-canonical-root-type-name,
   missing-canonical-file-identifier, paired-type-identity-mismatch.
3. Lambert14/2: `built artifact loads through the WasmEdge server path when available`
   and `built artifact returns deterministic circular benchmark output in browser
   and WasmEdge`; both `WasmEdge command harness exited with code 1.`
4. Access0/1: hardcoded sibling `spacedatastandards.org/lib/js/ACW/main.js`
   cannot be imported from the private worktree (`ERR_MODULE_NOT_FOUND`). Its
   test passes5/0 with a test-only import-layout adapter.

New clean-main build failure: events amalgamation omits lane08's new
`iau_body_models.hpp`, producing `fatal error: 'iau_body_models.hpp' file not found`.
Committed events WASM still passes its numerical Python and SDK tests.

## Three-runtime parity

```sh
python packages/python-astro/scripts/verify_parity.py \
  --output-dir packages/python-astro/docs/evidence/second-pass-parity \
  --wasmedge-binary /Users/tj/.wasmedge/bin/wasmedge
```

This is the SDK's `sdk-command.json` error-path fixture, across browser/V8,
native WasmEdge and container WasmEdge, each at widths1,2,4,8. It compares command
exit classes/response bytes; it is **not** a nine-engine numerical cross-runtime
accuracy test. Exact artifact hashes/commands are in `parity-checks.json`.

```text
propagator/sgp4 [SDK three-runtime error paths]: exit 0
propagator/hpop [SDK three-runtime error paths]: exit 0
analysis/estimation [SDK three-runtime error paths]: exit 0
analysis/conjunction-assessment [SDK three-runtime error paths]: exit 2
analysis/access [SDK three-runtime error paths]: exit 2
propagator/events [SDK three-runtime error paths]: exit 0
analysis/lambert-izzo [SDK three-runtime error paths]: exit 0
foundation/time [SDK three-runtime error paths]: exit 0
foundation/frames [SDK three-runtime error paths]: exit 0
```

Access/conjunction browser lanes trap because the SDK browser command harness
supports standalone WASI/space_data_module_host profiles, while these are legacy
Emscripten artifacts. Server lanes report guest errors, causing class mismatch.
The identical seven-pass/two-fail pattern was recorded in the first pass.

## Distribution and remaining work

The wheel build validates each WASM/binding against its lock and verifies the
resulting wheel inventory. It produces `py3-none-macosx_11_0_arm64`; a source
distribution is also built. See README for documented Linux/Windows recipes;
those OS executions and the unused wasi.thread-spawn callback remain untested.

The20-line `examples/sgp4_hpop.py` runs. Advanced estimation and events expose
generated request objects, while common inputs have NumPy helpers. HPOP's
manifest-only InvokeRequest/InvokeResponse and absent trajectory `.fbs` sources
are documented in dependencies.md; no schema was invented.

The frames baseline build automatically invoked its repository development
signer through an existing layout symlink. No key contents were printed, copied,
or packaged; this unexpected invocation is disclosed in the baseline receipt.
No further signing, deployment, publication or main-branch integration occurred.

Work is on `tmpl/python-astro`; the coordinator lands it. Commits use the owner's
explicit `GRAPH_PROTOCOL_GENERATION=main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f`
and `GRAPH_GUARD_OVERRIDE="TMPL parity lane python-astro (owner goal 2026-09-15)"`
authorization. The dirty baseline worktree is retained for audit.
