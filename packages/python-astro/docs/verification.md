# Lane 09 verification and handoff

**Status: partial delivery; Python execution blocked.** This lane produces an
installable artifact wheel, not completed astrodynamics wrappers. See
[dependencies](dependencies.md) for the upstream publication/runtime blockers.

## Scope and provenance

- Branch: `tmpl/python-astro`; private worktree `modules-python-astro`.
- Module artifact baseline: `283026f506f0d24e15834a6e438f19f6f984abe1`.
- Package version: `0.1.0.dev0+modules.283026f506f0.a8f1b808f6222`.
- Only `packages/python-astro/` has tracked changes. No canonical module checkout, physics,
  module artifact, schema, stack gitlink, or other lane's directory is edited.
- macOS arm64; Python 3.14.7; Node 25.4.0; published SDK 0.8.18 and JS SDS
  1.202.0 for baseline checks; native/container WasmEdge 0.16.4.
- Exact-scope `graphctl claim tmpl-python-astro --agent codex-lane09 --paths
  modules:packages/python-astro` failed with `no such task: tmpl-python-astro`
  after applying the coordinator's generation. Commits use the explicitly
  authorized `GRAPH_PROTOCOL_GENERATION=main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f`
  and `GRAPH_GUARD_OVERRIDE="TMPL parity lane python-astro (owner goal 2026-09-15)"`.
  The branch is pushed for the coordinator; it is not merged to main.
  The hook identified an unrelated active terrain task and logged the supplied
  override to the stack graph audit log; none of that task's paths were staged.

## Python distribution

Commands run from `packages/python-astro` in an isolated virtual environment:

```sh
python -m build
# Successfully built spacedatanetwork_astro-0.1.0.dev0+modules.283026f506f0.a8f1b808f6222.tar.gz
# and spacedatanetwork_astro-0.1.0.dev0+modules.283026f506f0.a8f1b808f6222-py3-none-any.whl
PYTHONPATH=src python -m unittest discover -s tests -v
# Ran 6 tests ... OK
python -m pip install dist/*.whl
# Successfully installed spacedatanetwork-astro-0.1.0.dev0+modules.283026f506f0.a8f1b808f6222
python -m spacedatanetwork_astro verify
# PASS: 9 module artifacts match the lock (0.1.0.dev0+modules.283026f506f0.a8f1b808f6222)
python -m spacedatanetwork_astro doctor
# BLOCKED: this prerelease provides artifact access only. (exit 2)
```

The build creates the sdist first and builds the wheel from that sdist in an
isolated build environment. All 21 WASM/manifest/provenance members match the
artifact lock and source revision. Builds enforce aggregate version/digest
consistency and reject unpinned staged files; the backend verifies the final
wheel inventory and hashes as well. Tests include same-length corruption,
version drift, invalid module identifiers and unpinned build inputs.

These are packaging checks. They contain no physics and cannot establish
numerical correctness or Python runtime compatibility. The existing C++ modules
were not rebuilt: this lane packages their committed SDK outputs unchanged.
Linux/Windows builds are documented but not run.

## Existing SDK compatibility and numerical checks

Reproduce with native WasmEdge on PATH:

```sh
python scripts/verify_existing_modules.py \
  --output-dir /tmp/lane09-existing-module-checks \
  --runtime-bin "$HOME/.wasmedge/bin"
# exit 1: existing failures listed below
```

The script runs each command in the named module directory with
`node --test --test-reporter=tap`; it records hashes before/after and requires
at least one passing test with no skips for complete coverage. Every artifact
was unchanged. Results below are from the final native-enabled run; an initial
run without the WasmEdge directory on PATH also failed to launch HPOP and
skipped Lambert's runtime checks.

| Module | Test argument | Literal TAP totals |
| --- | --- | --- |
| SGP4 | `tests/sdk_compat.test.mjs` | `# pass 7`, `# fail 0`, `# skipped 0` |
| HPOP | `tests/sdk_compat.test.mjs` | `# pass 9`, `# fail 1`, `# skipped 0` |
| Conjunction | `tests/sdk_compat.test.mjs` | `# pass 9`, `# fail 1`, `# skipped 0` |
| Time | `tests/sdk_compat.test.mjs` | `# pass 4`, `# fail 0`, `# skipped 0` |
| Frames | `tests/sdk_compat.test.mjs` | `# pass 5`, `# fail 0`, `# skipped 0` |
| Lambert | `tests/sdk-compat.test.mjs` | `# pass 14`, `# fail 2`, `# skipped 0` |
| Access | `test/manifestContract.test.mjs` | `# pass 0`, `# fail 1`, `# skipped 0` |
| Estimation | `tests/conformance.test.mjs` (recorded evidence) | `# pass 1`, `# fail 0`, `# skipped 0` |

There is no root `tests/sdk_compat.test.mjs`. Estimation and events have no
module-specific compatibility suite under that name. Alternate paths are
reported explicitly rather than silently treating missing suites as passes.
Exact commands, TAP output and pre/post artifact hashes are retained in
`docs/evidence/existing-module-checks.json` and adjacent logs. Validation
dependencies were installed in an isolated temporary npm prefix; no shared
dependency installation was modified.

Failure details:

- HPOP manifest compliance: `missing-aligned-file-identifier` and
  `paired-type-identity-mismatch` (resident/trajectory types).
- Conjunction manifest compliance: `missing-canonical-root-type-name` and
  `paired-type-identity-mismatch`.
- Lambert: native server-path and numerical determinism tests return
  `WasmEdge command harness exited with code 1`.
- Access manifest test imports `../../../spacedatastandards.org/lib/js/ACW/main.js`
  from the sibling checkout layout. That path is unavailable in this private
  worktree (`ERR_MODULE_NOT_FOUND`); this lane does not create shared sibling
  aliases or rewrite another module's tests.

### Authoritative reference cases

[authoritative-vectors.md](authoritative-vectors.md) records each existing
expected value, source, units, frame/time metadata, tolerance, rationale and
any provenance gap. `scripts/verify_existing_modules.py` contains the exact
commands and test-name filters. No expected values were generated by this lane.

| Existing case | Result | Scope of evidence |
| --- | --- | --- |
| SGP4 Vallado/Tudat radius | `# pass 1`, `# fail 0` | Existing browser artifact; error asserted below 0.01 m |
| HPOP Tudat two-body history | `# pass 2`, `# fail 0` | Browser harness and native WasmEdge; asserted position ≤0.0005 km and velocity ≤0.0000005 km/s |
| Estimation native conformance | `# pass 1`, `# fail 0` | Native C++ suite; not Python or WASM invocation |
| Conjunction SOCRATES replay | `# pass 0`, `# fail 1` | Fails import of sibling SDS `node_modules/flatbuffers/mjs/flatbuffers.js`; no numerical result |
| Access Orekit inverse AER | `# pass 1`, `# fail 0` | Legacy JS entry/artifact, angles <1e-10 rad, range <1e-10 × max(1, range in m) |
| Events analytic node crossings | `# pass 1`, `# fail 0` | Existing WASM test; asserted root error <0.001 s |
| Lambert circular quarter orbit | `# pass 1`, `# fail 0` | Browser harness; components within 1e-6 km/s |
| Time Orekit UTC→TAI | `# pass 1`, `# fail 0` | Exact output timestamp; delta within 1e-12 s of 32 s |
| Frames Basilisk PCI→PCPF | `# pass 1`, `# fail 0` | Exact [1,3,-2] output for the supplied integer DCM |

**Measured numerical errors through Python: unavailable.** No Python physics
ran because there is no usable published runtime SDK/binding combination.
The existing JS/native tests do not print successful residuals; their asserted
bounds above must not be reported as measured maxima. Exact timestamp/vector
assertions for time and frames pass, but do not validate a Python wrapper.

## Three-runtime command error-path parity

```sh
python scripts/verify_parity.py \
  --output-dir /tmp/lane09-parity \
  --wasmedge-binary "$HOME/.wasmedge/bin/wasmedge"
# exit 1: seven module checks pass, access and conjunction fail
```

For each packaged artifact, this invokes the SDK CLI:

```sh
node <sdk>/bin/space-data-module.js parity \
  --wasm src/spacedatanetwork_astro/artifacts/<module>/module.wasm \
  --fixture <sdk>/parity/sdk-command.json \
  --wasmedge-binary "$HOME/.wasmedge/bin/wasmedge" \
  --lanes browser,wasmedge,docker-wasmedge --json --timeout-sec 15
```

The SDK fixture covers empty stdin, malformed stdin, and a truncated PIV header
at thread counts 1, 2, 4 and 8. All three lanes are requested and none is skipped.
This is command error-path parity, **not numerical propagation parity**. The
SDK's canonical payload handling is identical for every lane, including any
publication trailer stripping; the original packaged artifact hash is recorded.

| Packaged module | SDK CLI exit | Receipt `ok` |
| --- | --- | --- |
| propagator/sgp4 | 0 | `true` |
| propagator/hpop | 0 | `true` |
| analysis/estimation | 0 | `true` |
| analysis/conjunction-assessment | 2 | `false` |
| analysis/access | 2 | `false` |
| propagator/events | 0 | `true` |
| analysis/lambert-izzo | 0 | `true` |
| foundation/time | 0 | `true` |
| foundation/frames | 0 | `true` |

Both failed modules report 24 class divergences: browser `trap` versus native
and container WasmEdge `guest-error` (exit 1). Their existing runtime surfaces
require work in their owning lanes. Lambert's passing malformed-input receipt
does not override its failing valid-invoke/native numerical tests above.

The Docker runtime is `space-data-module-sdk/parity-wasmedge:0.16.4`, arm64,
image ID `sha256:184d7fb56d1dea58d41290cc4c845c77a40260f17e827b235b43f999882da903`.
Full SDK receipts and commands are in `docs/evidence/parity/`. An initial
attempt failed browser setup because the shared SDK installation lacked
`esbuild`; the final receipts use the same published SDK 0.8.18 in a private
npm prefix with esbuild 0.20.2 installed.

## Remaining work

- Implement all nine runtime-backed wrappers and NumPy marshalling after the
  Python dependencies are usable. This delivery exposes only artifact access.
- Add Python numerical tests importing shared expected-value fixtures, and the
  requested executable SGP4 + HPOP propagation example.
- Resolve existing manifest, private-worktree test-import, and runtime failures
  in the owning lanes, then produce numerical parity evidence across all three
  runtimes on exactly the packaged bytes.
- Rebuild the wheel for final artifacts after the coordinator lands the other
  lanes; this prerelease is locked to the starting module revision.
- Publication is a separate release lane; this branch performs no PyPI upload.
