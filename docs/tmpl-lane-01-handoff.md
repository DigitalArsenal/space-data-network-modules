# TMPL lane 01 coordinator handoff — 2026-09-15

## Status

Implementation and numerical/runtime verification are delivered on **`tmpl/lane-01`**.
**The lane is not fully accepted:** HPOP still needs SDK build migration and
ratified replacements for its pre-existing noncompliant manifest identities.
No schema was invented. The coordinator owns landing; this branch is not merged.

Private worktree: `/Users/tj/software/worktrees/modules-lane-01`.
Base: `283026f` (fetched `origin/main` at lane start).

Implementation commits:

```text
399e79fe3bf6468733898f3f13ce3e888397bf94 Add buffered SPK Chebyshev states and DE440 reference validation
ae50de2967b492d99488fc3ee988768d003b10d3 Use optional JPL kernel bytes for eclipse body positions
3ee027b2847962ffee569ad1d003e1a786c687bd Route HPOP force ephemerides through scoped kernel input
```

The subsequent handoff-only commit records this report. The final response names
its SHA and the verified remote branch tip.

## Implemented

- Buffer-backed SPK 2/3 Chebyshev evaluation, including differentiated type 2
  velocities, NAIF record-boundary rules, both byte orders, bounded metadata,
  finite-value/size checks, priority and coverage refusal.
- `spk::Kernel::state` / `state_et`: target-minus-centre NAIF chains in geometric
  ICRF/J2000 km and km/s, using the nearest common ancestor (including Moon/Earth).
- HPOP `invoke` kernel port for `ephemeris` and `propagate`, all nine supported
  third-body forces and SRP, actual source reporting, explicit Analytical fallback,
  and removal of the filesystem loader's false-success stub.
- Events eclipse/intrusion kernel lookup, UTC→TT→TDB conversion, trajectory
  frame/time/centre validation, and a verified NCD source receipt.
- DE metadata inspection without whole-kernel materialization. Sample-only
  `read_container` refuses coefficient-only kernels explicitly; mixed kernels
  retain discrete segments.
- Reproducible, SHA256-pinned full-kernel downloader and a committed 114,688-byte
  CSPICE excerpt for 2026. No kernel is embedded in any WASM.

See [integration contract](de440-integration.md) and the
[authoritative numerical report and monthly comparison table](de440-validation.md).

## Authoritative tests and measured errors

All ephemeris comparisons use geometric ICRF/J2000 states, TDB epochs, km and
km/s. Same-kernel Euclidean bounds are **1e-6 km / 1e-9 km/s**; these bound
implementation/interpolation error, not physical ephemeris uncertainty.

| Authority / case | Count | Maximum position error km | Maximum velocity error km/s |
| --- | ---: | ---: | ---: |
| NAIF CSPICE N0067, published DE440s, native reader | 238 | 0 | 0 |
| Same oracle, committed 2026 excerpt | 221 | 0 | 0 |
| HPOP native monthly Sun/Moon states | 24 | 0 | 0 |
| HPOP built WASM invoke, JPL body states | 12 | 1.4901161193847656e-8 | 1.7763568394002505e-15 |
| Public JPL Horizons **DE441** vs DE440 | 48 | 0.0024503268843673186 | 6.913231791605064e-9 |

Horizons identifies DE441 in the preserved API responses. Its separate 0.01 km /
1e-7 km/s comparison is a cross-release check; it is not substituted for the
strict same-DE440 oracle. Sources, query URLs, exact epochs, units, frames,
time scales, tolerances and rationale are committed with the fixtures.

Additional physics evidence:

- 372 SPK closed-form/endian/chain/malformed-input checks; ASan/UBSan: zero failures.
- Nine actual HPOP third-body forces vs CSPICE body positions and independent
  Newtonian differential gravity: max **2.7745692215067836e-22 km/s²**.
- SRP using the kernel Sun vs photon-momentum equation: **0 km/s²**.
- Force comparison bound: **1e-18 km/s²**, with input GM constants stated.

The monthly 2026 table records the actual retained HPOP fallback: Sun error
5.56 million–302.44 million km; Moon 314.125–4,868.037 km. The unusually large
Sun error includes the existing erroneous mean-longitude coefficient; it is
not represented as generic VSOP87 accuracy. Kernel mode removes these errors.
Analytical fallback was deliberately retained and is labelled as such.

## Exact build and test receipts

Commands below run from the worktree root unless a subshell changes directory.

### SDK builds

```sh
node files/orbit-products/build.mjs --unsigned
```
```text
Unsigned local validation build (--unsigned); no signing key read.
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.202.0
```

```sh
node propagator/events/build.mjs
```
```text
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.202.0 over the 335-parameter catalog and 248 vendored ERFA sources
```

### HPOP diagnostic build — SDK build law remains unmet

```sh
env SDN_FLATBUFFERS_INCLUDE_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/flatbuffers/include \
SDN_LOCAL_EMSDK_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules/propagator/hpop/deps/emsdk \
bash propagator/hpop/build.sh
```
```text
[100%] Built target hpop_wasm
=== Build Complete ===
```

### Focused and regression tests

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test files/orbit-products/tests/*.test.mjs
```
```text
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ skipped 0
```

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test propagator/events/tests/*.test.mjs
```
```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
ℹ skipped 0
```

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test propagator/hpop/tests/kernel_invoke.test.mjs propagator/hpop/tests/de440_force.test.mjs
```
```text
PASS HPOP WASM CSPICE states=12 position_error_km=1.4901161193847656e-8 velocity_error_km_s=1.7763568394002505e-15
PASS DE440 force cases=10 failures=0
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ skipped 0
```

```sh
PATH="$HOME/.wasmedge/bin:$PATH" npm --prefix propagator/hpop test
```
```text
ℹ tests 27
ℹ pass 26
ℹ fail 1
ℹ skipped 0
```
The sole failure is `built artifact passes SDK compliance checks`, described below.

### Required sdk_compat checks

```sh
(cd files/orbit-products && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs)
(cd propagator/events && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs)
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs)
```
```text
orbit-products: tests 2; pass 2; fail 0; skipped 0
 events:       tests 2; pass 2; fail 0; skipped 0
 HPOP:         tests 10; pass 9; fail 1; skipped 0
```

### Tri-runtime parity (SDK harness; WasmEdge 0.16.4 native and container)

```sh
node files/orbit-products/tests/de440-parity.mjs
node propagator/events/tests/kernel-parity.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/kernel-parity.mjs
```
```text
parity PASS fixture=TMPL lane01 orbit-products DE440 module=4bc2b512b0ac26d6 comparisons=15
3 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane01 events module=c6f2cf1845099d89 comparisons=20
4 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane01 HPOP diagnostic CMake artifact module=be374f69201c1718 comparisons=30
6 case(s) byte-identical across 3 lane(s).
```
Browser lane is Chrome/V8; other lanes are native WasmEdge and container WasmEdge.
Missing local `esbuild` was provisioned in the private workspace before the
successful browser parity run. No runtime lanes were skipped.

Artifact SHA256:

```text
4bc2b512b0ac26d61ca48b94a220e120c0d7ad307af98c051b5924455d4ed0da  files/orbit-products/dist/isomorphic/module.wasm
c6f2cf1845099d89dddaec7f9ca14621a1617e1814b3d850753a77d02e327a87  propagator/events/dist/isomorphic/module.wasm
be374f69201c17187c413c7ac0846b5387a5b90c762b8ade74df32ffe8b2306c  propagator/hpop/dist/isomorphic/module.wasm
```

## Blockers, limits and skipped work

1. **HPOP SDK build migration is unfinished.** Its existing CMake build uses
   multiple C++ translation units and its legacy bridge/browser ABI. The SDK
   compiler accepts one source translation unit and generates its bridge. This
   diagnostic artifact passes numerical/runtime tests but does not satisfy the
   user's SDK-build acceptance law. No compliance claim is made for it.
2. **HPOP legacy schema identities are noncompliant.** Baseline `283026f` and
   final artifacts, checked with the same installed SDK 0.8.18, produce the same
   11 error code/location pairs. Codes include `missing-canonical-file-identifier`,
   `missing-aligned-file-identifier` and `paired-type-identity-mismatch`.
   Ratification/contract migration is required; this lane does not invent SDS
   schemas. Baseline comparison: `baselineErrors=11 currentErrors=11 identical=true`.
3. Kernel input is exposed on HPOP `invoke`, not its legacy resident trajectory
   methods. Persistent source-aware cache semantics were not added.
4. Orbit-products was rebuilt in explicit unsigned local mode to avoid reading
   credentials; normal signing remains the coordinator's build/publication step.
5. No whole-stack/SDK-wide test suite, production deployment, publication,
   main-branch merge or stack pin change was attempted. Scope was one lane.

## Workspace and commit hygiene

Only the private component worktree was edited. The full 32 MB kernel and Python
cache are ignored; the small excerpt and reference vectors are tracked.
`git diff --check` passed. No credentials were read, no deployment occurred.

The graph claim command with the assigned protocol generation returned
`no such task: tmpl-lane-01`. Every commit used the explicitly authorized override:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 01 (owner goal 2026-09-15)"
```

The guard reported that its currently selected claim belonged to an unrelated
scope; the override was recorded by the hook. The coordinator owns integration.
The clean worktree is retained because the branch has not landed.

## Exact files changed

```text
docs/de440-integration.md
docs/de440-validation.md
files/orbit-products/build.mjs
files/orbit-products/dist/isomorphic/module.wasm
files/orbit-products/src/daf.hpp
files/orbit-products/src/kernel_frame.hpp
files/orbit-products/src/orbit_products_module.cpp
files/orbit-products/src/spk_kernel.hpp
files/orbit-products/src/spk_read.hpp
files/orbit-products/tests/de440-fixture.mjs
files/orbit-products/tests/de440-parity.mjs
files/orbit-products/tests/de440_reference.test.mjs
files/orbit-products/tests/de440_reference_native.cpp
files/orbit-products/tests/fixtures/de440/.gitignore
files/orbit-products/tests/fixtures/de440/README.md
files/orbit-products/tests/fixtures/de440/cspice-de440.csv
files/orbit-products/tests/fixtures/de440/cspice-metadata.json
files/orbit-products/tests/fixtures/de440/de440-2026.bsp
files/orbit-products/tests/fixtures/de440/download.py
files/orbit-products/tests/fixtures/de440/excerpt-metadata.json
files/orbit-products/tests/fixtures/de440/extract_2026.py
files/orbit-products/tests/fixtures/de440/generate_references.py
files/orbit-products/tests/fixtures/de440/horizons-responses.json
files/orbit-products/tests/fixtures/de440/horizons.csv
files/orbit-products/tests/orbit_products_module.test.mjs
files/orbit-products/tests/sdk_compat.test.mjs
files/orbit-products/tests/spk_chebyshev.test.mjs
files/orbit-products/tests/spk_chebyshev_native.cpp
propagator/events/build.mjs
propagator/events/dist/build-provenance.json
propagator/events/dist/isomorphic/module.wasm
propagator/events/dist/plugin-manifest.json
propagator/events/generate-sds-headers.mjs
propagator/events/package-lock.json
propagator/events/package.json
propagator/events/plugin-manifest.json
propagator/events/src/events_module.cpp
propagator/events/src/generated/sds/NCD_generated.h
propagator/events/src/generated/sds/OEM_generated.h
propagator/events/tests/kernel-fixture.mjs
propagator/events/tests/kernel-parity.mjs
propagator/events/tests/sdk_compat.test.mjs
propagator/hpop/README.md
propagator/hpop/build.sh
propagator/hpop/dist/browser/module.js
propagator/hpop/dist/browser/module.wasm
propagator/hpop/dist/isomorphic/module.wasm
propagator/hpop/generate-kernel-header.mjs
propagator/hpop/lib/astrodynamics.cpp
propagator/hpop/lib/astrodynamics.h
propagator/hpop/lib/astrodynamics_types.h
propagator/hpop/lib/ephemeris.cpp
propagator/hpop/lib/ephemeris.h
propagator/hpop/plugin-manifest.json
propagator/hpop/src/cpp/CMakeLists.txt
propagator/hpop/src/cpp/generated/plugin_manifest_bytes.h
propagator/hpop/src/cpp/generated/sds/NCD_generated.h
propagator/hpop/src/cpp/include/hpop/kernel_scope.h
propagator/hpop/src/cpp/src/plugin_entrypoints.cpp
propagator/hpop/src/cpp/src/plugin_invoke_bridge.cpp
propagator/hpop/src/cpp/src/plugin_runtime.cpp
propagator/hpop/tests/de440_force.test.mjs
propagator/hpop/tests/de440_force_native.cpp
propagator/hpop/tests/kernel-parity.mjs
propagator/hpop/tests/kernel_invoke.test.mjs
docs/tmpl-lane-01-handoff.md
```
