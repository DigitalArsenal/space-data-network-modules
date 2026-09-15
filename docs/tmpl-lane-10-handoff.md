# TMPL lane 10 — baseline compliance triage and Access migration

## Delivery and acceptance

**Partial delivery; the lane is NOT fully accepted.** Access is migrated and
passes its build, numerical, SDK, compliance, and three-runtime gates.
Conjunction fixture imports are repaired. HPOP and Conjunction canonical
builds remain blocked by missing registered schema contracts. No schema was
invented, no assertions/tolerances were loosened, and no new skip was added.

Branch: **`tmpl/lane-10`**, based on **`12ea8023a097bf68b8ad183dc99f0597d4fa311d`**.
Private worktree: `/Users/tj/software/worktrees/modules-lane-10`.

Implementation commits:

- `6e763d2a38dc328a207296e3cef61342ce7f4f86` — SDK Access build, adapters, artifacts, tests.
- `3c76d39043f890765d7439ffab2fc39c60d75bcd` — portable Conjunction fixture dependencies/imports.

The following receipt commit contains this report, reproductions, logs, and
[exact changed-file inventory](evidence/tmpl-lane-10/files.txt). The final response
identifies that commit. Push only: the coordinator owns integration. No stack pin
or main-branch merge is included; retain the unlanded worktree.

## Root causes and dispositions

### Access — fixed

1. `test/manifestContract.test.mjs` imported FlatBuffers and SDS from fixed
   sibling checkout paths. In a private worktree it failed during import,
   before testing any manifest assertion. It now uses pinned npm dependencies.
2. `build.js` used the OrbPro Emscripten helper and produced a browser JS-dependent
   artifact: imports included `env.__assert_fail`, `env.__cxa_throw`, and heap
   helpers. It had no `_start` and declared only direct invocation. Merely adding
   a browser target could not make this binary command-portable.
3. New `build.mjs` calls SDK `compileModuleFromSource`, uses explicit
   `wasi-sequential` with an ordered-sample justification, generates `$ACW`
   bindings from SDS 1.217.0, and exposes direct plus command surfaces.
   `build.js` delegates to it. All three distributed WASM copies are identical.
4. The original C++ ACW evaluator is shared with a small SDK method adapter.
   SDK code owns PIV validation, command framing, allocation, and manifest
   exports. Browser JS only maps the existing C functions and memory views.
   The six before/after ACW payloads match exactly.
5. Obsolete PMAN sidecars, build-cache hash, and the old artifact's publication
   record were removed. Legacy metadata now points to the embedded `$PLG`.
   The build is unsigned and reads no signing key.
6. One exact error expectation changed because the SDK enforces the declared
   required port before dispatch: `missing-required-input` / `Missing required
   input port: request`. The assertion remains exact. Physics tolerances did
   not change.

### HPOP — schema blocker; artifact/source unchanged

The basic SDK checker reproduces **11 errors**: five missing canonical file
identifiers, three missing aligned identifiers, three paired identity mismatches.
The compiler's stronger standards preflight finds **27 errors** (also twelve
unresolved references and four known-identity mismatches).

`orbpro.hpop.InvokeRequest/InvokeResponse` have no schema/file identifier and
carry JSON bytes; `src/cpp/src/plugin_runtime.cpp:470` parses that JSON. The batch
and prepare/describe-trajectory request identities also lack registered source
contracts. The legacy PropagatorState identity conflicts with the SDK catalog.
Neither the installed SDS package nor the canonical SDS schema tree provided
those missing HPOP request definitions. A new four-byte label would misdescribe
the payload rather than repair it.

There is no `build.mjs`; existing `build.sh`/CMake bypasses the SDK compiler and
supplies its own bridge. A minimal `compileModuleFromSource` call with this
manifest fails **before compiling C++**, so translating its compilation units
cannot produce a compliant artifact until the schema contract is resolved.
Per the stop-on-missing-standard law, migration stops here. **No SDK-produced
HPOP after-artifact exists**, and no claim of successful build migration or
before/after migration proof is made. The committed baseline artifact remains
byte-for-byte unchanged and its existing numerical/parity tests were run.

### Conjunction — fixture imports fixed; schema/build/serialization blocked

- The SOCRATES/PIV helpers also required a sibling SDS checkout and its private
  `node_modules`. They now resolve published SDS and FlatBuffers; SDK, SDS, and
  test dependencies are recorded in the package lock. The focused seven tests
  pass, including all three SOCRATES pairs with original tolerances.
- Basic compliance finds **54 errors**: 27 missing roots, 23 mismatched peers,
  four missing identifiers. Standards preflight adds 30 unresolved references,
  for **84 errors**. The local `schemas/Conjunction*.fbs` definitions are not
  registered SDK/SDS identities. `text/plain` and `text/xml` ports at manifest
  lines 323/379/401/457 declare raw text as canonical FlatBuffers without a
  schema identifier or root. Root-name edits alone cannot resolve this.
- `src/cpp/CMakeLists.txt:23-25,55-65` combines Emscripten `-pthread` with
  `STANDALONE_WASM`. The primary artifact imports `__pthread_create_js` and
  Emscripten mailbox hooks rather than the sanctioned wasi-threads contract.
  The browser command harness correctly rejects it; native/container command
  failure classes differ. There is no `build.mjs`, and SDK manifest preflight
  blocks a canonical rebuild before compilation.
- Nine additional full-suite failures reproduce an existing PIV serialization
  error. At `src/cpp/src/plugin_invoke_bridge.cpp:630-646`, the type reference
  leaves its wire format at the FlatBuffer default while TAB can declare
  aligned-binary. SDK `src/invoke/codec.js:838-841` correctly rejects the mismatch.
  This is module output corruption, not a reason to relax SDK decoding. It was
  present in the baseline log too. No CMake-only replacement artifact was
  shipped to work around the blocked canonical build.

### SDK defect — reported, not patched

**Runtime-profile validation coverage gap**, SDK 0.8.18:
`src/compliance/pluginCompliance.js:2443`, especially `2480-2529`, checks exports
and embedded manifest bytes but does not reject browser-incompatible imports.
The same routine/line positions exist in the read-only canonical SDK checkout
`1362cccb044fcc945b7e8356b5392359e6f543e3`.

Minimal reproduction, using the original Access bytes directly from base Git:

```sh
node docs/tmpl-lane-10-sdk-runtime-profile-repro.mjs
```
```text
REPRODUCED SDK compliance false positive: report.ok=true; browser=WebAssembly.instantiate(): Import #0 "env": module is not an object or function
```

Exit 1 deliberately reports the reproduced defect. The manifest explicitly
allows browser/direct execution. The public standards-aware artifact validator
accepts it, then the public browser loader rejects it. No SDK source was edited.
The new Access artifact passes both validation and real runtime execution.

## Before / after

Counts below are **pass / fail / skipped**. Baseline is `12ea8023`.

| Gate | Access before → after | HPOP before → after | Conjunction before → after |
| --- | --- | --- | --- |
| `node build.mjs` | absent → **PASS** | absent → **FAIL: absent; preflight 27 errors** | absent → **FAIL: absent; preflight 84 errors** |
| Existing SDK/manifest test | 0/1/0 import failure → **5/0/0** | 9/1/0 → **9/1/0** | 9/1/0 → **9/1/0** |
| Canonical `tests/sdk_compat.test.mjs` | absent → **6/0/0** | same row above | same row above |
| `npm test` | 10/1/0 → **17/0/0** | 26/1/0 → **26/1/0** | 21/15/5 → **39/10/8** |
| Standards-aware artifact check | PASS (false runtime assurance) → **PASS** | 27 errors → **27 errors** | 84 errors → **84 errors** |
| SDK three-runtime command errors | **FAIL → PASS** | **PASS → PASS, unchanged bytes** | **FAIL → FAIL** |
| Numerical three-runtime fixture | not previously documented → **9 cases PASS, including 6 Orekit cases** | **6 kernel cases PASS, unchanged bytes** | focused singlethread SOCRATES **7 tests PASS**; primary tri-runtime remains FAIL |

Conjunction's test counts increase because previously unimportable files now
execute. Its eight existing data-dependent skips are **blocked evidence**, not
passes: five extracted Aerospace checks, two Aerospace archive checks, one full
local SOCRATES catalog check. The canonical local data directory contains only
README; the small committed SOCRATES fixture was available and tested. No
missing-data skip or tolerance was added by this lane. Whole-lane acceptance
requires these data-dependent checks too.

## Authoritative numerical evidence

| Case and authority | Measured maximum error | Unchanged bound |
| --- | --- | --- |
| Access: six Orekit inverse topocentric cases, primary SDK WASM | **4.731326441742567e-12 rad** elevation | **1e-10 rad** |
| HPOP: 12 CSPICE/DE440 WASM body states | **1.4901161193847656e-8 km**, **1.7763568394002505e-15 km/s** | **1e-6 km**, **1e-9 km/s** |
| HPOP: nine DE440/Newtonian third-body cases | **2.7745692215067836e-22 km/s²** | **1e-18 km/s²** |
| HPOP: photon-momentum SRP with kernel Sun | **0 km/s²** | **1e-18 km/s²** |
| HPOP: six Tudat two-body samples, browser + WasmEdge | **0.00016767248213213478 km**, **1.8106498228867084e-7 km/s** | **5e-4 km**, **5e-7 km/s** |
| HPOP: nine Tudat high-fidelity samples, browser + WasmEdge | **2.282644259155471 km**, **0.0022793698050217388 km/s** | **60 km**, **0.05 km/s** (existing broad perturbation envelope) |

Access source: [Orekit 13.1.2 TopocentricFrameTest](https://www.orekit.org/site-orekit-13.1.2/xref-test/org/orekit/frames/TopocentricFrameTest.html),
`testGetTopocentricCoordinatesValues` / `testInverseGetTopocentricCoordinates`.
Radians/metres, ECEF, equatorial WGS84 station at longitude zero, fixed samples
at JD 2460400.5 TT and +60 seconds. The 1e-10-rad bound accounts for double
precision cancellation when adding metre-scale ranges to Earth's radius and
libm rounding. The tests send actual `$ACW` frames into WASM; host geometry
helpers are not the numerical oracle.

HPOP DE440 source/units/frame/time/tolerances are preserved in
[de440-validation.md](de440-validation.md) and the pinned CSPICE metadata:
geometric ICRF/J2000, TDB, km/km/s; interpolation/arithmetic bounds, not physical
uncertainty. Tudat source is pinned at
[`c998d240` propagation tests](https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs).
The existing fixture uses geocentric inertial Cartesian state, km/km/s, epoch
JD 2451545.0; it does not explicitly label its time scale. This pre-existing
metadata limitation and broad high-fidelity tolerance are not promoted to new
precision claims. Measured logs retain every sample and original assertions.

Conjunction source: committed CelesTrak SOCRATES Plus top-three window captured
2026-03-10 (`tests/fixtures/socrates/reference.top3.json` and its GP records).
SGP4 TEME geometry, UTC TCA, scalar miss distance and relative speed:

| Pair | Absolute TCA error s | Miss error m | Relative-speed error m/s |
| --- | ---: | ---: | ---: |
| 61721–67298 | 0.00072 | 4.178 | 0.100 |
| 47935–49179 | 0.00032 | 0.303 | 0.304 |
| 48282–58288 | 0.00028 | 0.131 | 0.479 |

Bounds: 0.010 s for these NLRV pairs; 5 m accommodates the SOCRATES CSV's
quantized range; 5 m/s is the existing speed regression bound. All 3 pairs are
recovered with zero extras. Pc remains the existing explicitly advisory
same-family comparison, not independent probability validation. Full rationale:
`tests/lib/caParityTolerances.mjs` and `docs/a2.8a-ca-parity-ground-truth.md`.

## Exact commands and receipts

Run the first four commands from each module directory. Node v25.4.0;
published SDK **0.8.18**, SDS **1.217.0**, flatc **26.1.32**; native and SDK
container WasmEdge **0.16.4**. Required WasmEdge PATH:
`export PATH="$HOME/.wasmedge/bin:$PATH"`.

```sh
node build.mjs
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
```

Access:
```text
Built dist/isomorphic/module.wasm through SDK; compliance PASS (unsigned local build).
sdk_compat: tests 6; pass 6; fail 0; skipped 0
npm test: tests 17; pass 17; fail 0; skipped 0
[compliance] PASS: access manifest and dist/isomorphic/module.wasm
```

HPOP (`check:compliance` script does not exist; use the standards reproduction):
```text
node build.mjs: MODULE_NOT_FOUND (exit 1)
sdk_compat: tests 10; pass 9; fail 1; skipped 0 (exit 1)
npm test: tests 27; pass 26; fail 1; skipped 0 (exit 1)
```

Conjunction:
```text
node build.mjs: MODULE_NOT_FOUND (exit 1)
sdk_compat: tests 10; pass 9; fail 1; skipped 0 (exit 1)
npm test: tests 57; pass 39; fail 10; skipped 8 (exit 1)
[compliance] failed: .../analysis/conjunction-assessment/plugin-manifest.json (exit 1)
```

From the worktree root:
```sh
node docs/tmpl-lane-10-repro.mjs
node analysis/access/tests/parity.mjs
node propagator/hpop/tests/kernel-parity.mjs
node --test propagator/hpop/tests/kernel_invoke.test.mjs propagator/hpop/tests/de440_force.test.mjs
(cd analysis/conjunction-assessment && node --test tests/socratesScreenCatalogParity.test.mjs tests/pivInvokeContract.test.mjs)
```
```text
standards reproduction: HPOP 27 errors; conjunction 84 errors; access 0 errors (exit 1)
parity PASS fixture=lane10 access Orekit and command errors module=405c3e212e8a38bc lanes=[browser(36 runs), wasmedge(36 runs), docker-wasmedge(36 runs)] comparisons=174
  9 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane01 HPOP diagnostic CMake artifact module=be374f69201c1718 comparisons=30
  6 case(s) byte-identical across 3 lane(s).
HPOP CSPICE/force tests: tests 3; pass 3; fail 0; skipped 0
Conjunction SOCRATES/PIV: tests 7; pass 7; fail 0; skipped 0
```
The parity lines above omit elapsed timings; exact unabridged output is in the
[receipt directory](evidence/tmpl-lane-10/). Browser is real Chrome, not Node's
WASM engine. Access fixture includes all SDK error cases and thread counts
1/2/4/8. Standalone SDK error fixture commands for each original artifact:

```sh
node analysis/access/node_modules/space-data-module-sdk/bin/space-data-module.js parity \
  --wasm <module>/dist/isomorphic/module.wasm \
  --fixture analysis/access/node_modules/space-data-module-sdk/parity/sdk-command.json \
  --lanes browser,wasmedge,docker-wasmedge \
  --wasmedge-binary "$HOME/.wasmedge/bin/wasmedge" --timeout-sec 15
```
```text
HPOP: parity PASS fixture=sdk-command-parity ... 3 case(s) byte-identical across 3 lane(s).
Conjunction: parity FAIL fixture=sdk-command-parity ... browser class "trap" vs WasmEdge/container class "guest-error".
Original Access: parity FAIL with the same class divergence.
```
For original Access, `--wasm` pointed to the saved base artifact; its SHA is below.
The Python package parity script drives this same SDK fixture; Python package
artifacts/locks were not changed by this lane, so its pinned old Access bytes
must be repinned by its owner after integration.

Reproduce the Access before/after comparison without a golden from the new code:
```sh
git show 12ea8023:analysis/access/dist/isomorphic/module.wasm > /tmp/lane10-before.wasm
git show 12ea8023:analysis/access/dist/access.mjs > /tmp/lane10-before.mjs
node analysis/access/tests/compare-artifacts.mjs /tmp/lane10-before.wasm /tmp/lane10-before.mjs
```
```text
PASS: 6 identical ACW payloads on identical inputs
```

Artifact SHA256:
```text
98315481714d59fb2ba03cc032b6ca7764a32b3847c59cd0eaac5675cd73401a  Access before
405c3e212e8a38bcb202deee17fb8fa31e0c0d02770391613a1d243842ca876d  Access after
be374f69201c17187c413c7ac0846b5387a5b90c762b8ade74df32ffe8b2306c  HPOP unchanged
acfedd6de4baaaae7d9265f7be992f2fe522afaa6f5dc739a20fbe2b6206fc72  Conjunction unchanged
```

## Remaining work / workspace hygiene

1. SDS/SDK owners must register or ratify actual HPOP and Conjunction payload
   contracts, including text transport. Then migrate those two C++ builds through
   SDK and fix Conjunction PIV wire metadata; preserve physics with baseline
   comparisons. No claim that these modules now meet canonical build rules.
2. Supply the missing Aerospace/full-catalog datasets and rerun the eight
   data-dependent Conjunction checks. This lane does not count their skips as passes.
3. SDK owner should close the runtime-profile compliance gap using the supplied
   reproduction. No SDK patch was made here.
4. Python artifact locks/distributions and any publication/signature renewal are
   downstream owner work. Access's unsigned artifact replaces the old development
   publication sidecar; no signing/deployment was performed.
5. `git diff --check` passed. Changes are confined to this private worktree's
   Access module, Conjunction package/tests, and lane-10 reports. HPOP files were
   not edited. Canonical checkouts and other lane directories were not edited.

Graph claim attempt returned `no such task: tmpl-lane-10`. Each commit used the
explicitly authorized override, which the hook logged against an unrelated
currently selected claim:
```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 10 (owner goal 2026-09-15)"
```
