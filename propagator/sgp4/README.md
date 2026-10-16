# SGP4 Propagator Plugin

SGP4/SDP4 orbital propagation operations packaged as a canonical `space-data-module-sdk` command-surface plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

Vallado's SGP4/SDP4 (2020-07-13, WGS 72) over OMM element sets, through the
SDS PIV invoke surface (`plugin_invoke_stream`). Methods:

| Method | In | Out |
| --- | --- | --- |
| `ingest_omm` | `omm` (`$OMM`, size-prefixed `$OMM` stream) or `records` (`$REC`) | — |
| `upsert_cat` | `catalog` (`$CAT`) or `records` (`$REC`) | — |
| `propagate_state` | `request` (`PropagatorBatchRequest`), optional `omm`/`records` | `state`: one `PropagatorState` per object |
| `propagate_ephemeris` | `request`, optional `omm`/`records` | `ephemeris`: one SDS `$OEM` per object |
| `catalog_query` | `request` (`CatalogQueryRequest`) | `results` |

Objects with one NORAD number share one entity and its element-set history.

### Naming objects

`entity_handles` index the entities in ingestion order: after ingesting A
and then B, handle 0 is A. `catalog_numbers` (1.2.0) names objects by NORAD
number instead; an unknown number refuses the request (`unknown-object`), and
with handles as well each handle must hold that number (`handle-mismatch`).
Neither: every entity, up to `max_count`.

### Output axes

`output_frame` selects the `propagate_state` axes:

- `ECEF` (default, as in 1.1.0): TEME turned by GMST (IAU 1982), without
  polar motion, m and m/s, velocity relative to the rotating axes.
- `TEME`: SGP4's own axes, m and m/s.
- `ICRF`: GCRF (Earth-centred ICRF axes), as analysis/epoch-state derives it:
  `foundation/frames` `gcrfToTeme` (ERFA `eraPnm06a`, `eraEe06a`) at TT from
  UTC by ERFA's leap-second table, the velocity with the axes' rotation rate
  by a ±600 s central difference. The vendored ERFA is compiled in.

`J2000`, `MCI` and `MCMF` are refused (`unsupported-frame`).

### Trajectories (`propagate_ephemeris`)

One `$OEM` per object: km, km/s, `TIME_SYSTEM` UTC, `CENTER_NAME` EARTH,
`TEMEOFDATE` or `GCRF` axes (`output_frame` TEME or ICRF; Earth-fixed is
refused), samples every `step_seconds` and at the span's end.

- `element_set_blocks`: one block per element set of the object's history,
  propagated from that set alone from the epoch of the set `neighbour_sets`
  earlier to that of the set `neighbour_sets` later (default 2; clamped at the
  ends), and clipped to [`epoch`, `stop_epoch`] when `stop_epoch` is after
  `epoch`. `COMMENT` names the set by its epoch. This is
  `analysis/maneuver-detection` `detect_maneuvers`' input.
- Otherwise one block from `epoch` to `stop_epoch` through the entity's own
  set selection.

### One invocation

`propagate_state` and `propagate_ephemeris` first ingest OMM frames on their
`omm` and `records` ports, as `ingest_omm` does. A command runtime (WasmEdge)
starts every invocation empty, so this is how it propagates.

## Runtime contract

- Embedded manifest exports:
  - `plugin_get_manifest_flatbuffer`
  - `plugin_get_manifest_flatbuffer_size`
- Command bridge export:
  - `plugin_invoke_stream`
- Browser shim export:
  - `wasm_invoke_json`
- Runtime targets:
  - `browser`
  - `wasi`
  - `wasmedge`

## Build

Native tests:

```bash
cmake -S src/cpp -B build
cmake --build build -j4
ctest --test-dir build --output-on-failure
```

Wasm build:

```bash
SDN_LOCAL_EMSDK_DIR=<emsdk 6.0.1> FLATBUFFERS_ROOT=<flatbuffers 25.12.19> bash build.sh
```

The build regenerates the SDS headers from the locked spacedatastandards.org
(`generate-sds-headers.mjs`), the request header from `schemas/StateVector.fbs`
(`generate-local-headers.mjs`), the embedded manifest and the test bindings,
and compiles the vendored ERFA (`higherpop/third_party/erfa`) with
`foundation/frames/src` for the TEME and GCRF answers.

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`
- `dist/browser-shared/module.js`, `dist/browser-shared/module.wasm`

## Verification

```bash
npm test
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
```

`npm test` covers SDK compliance, the browser and browser-shared artifacts,
the PIV contract, the Tudat-derived SGP4 cases (below), and:

- `catalogNumberSelection`: objects named by catalog number equal the same
  element set propagated alone (exactly), after separate ingestions and when
  one stream carries them out of order; mismatched handles and unknown numbers
  are refused; one invocation carries its element sets.
- `gcrfOutput`: Vallado's SGP4-VER sets against pyerfa's GCRF of their t = 0
  TEME rows (`analysis/epoch-state/tests/vallado-verification.json`): within
  2e-5 m and 2e-6 m/s (the fixture's printing; measured 6.9e-6 m,
  6.4e-7 m/s), the rotation alone within 1e-6 m and 1e-7 m/s (measured
  2.4e-8 m, 2.4e-9 m/s).
- `ephemerisOutput`: every `$OEM` state equals its element set propagated
  alone (to the microsecond epochs: < 1 m), block spans and metadata, and
  `detect_maneuvers` reads the result.
- `legacyPropagateState`: 1.1.0 requests return the 1.1.0 artifact's
  responses byte for byte (`tests/fixtures/propagate-state-1.1.0-digests.json`).

`tests/parity.mjs` runs one-invocation cases (each carrying its element sets)
in Chrome, native WasmEdge and Docker WasmEdge and writes
[`conformance/parity.json`](conformance/parity.json).

### Vallado's verification set

`node tests/evidence/vallado/run-vallado.mjs` checks every row of
Vallado's `tcppver.out` (python-sgp4 2.27 sdist, SHA-256
`06d37247...85f9`; 33 sets, 666 TEME rows, WGS-72, improved mode) against
this module, and writes `tests/evidence/vallado/summary-vallado.json`
(pins in `tools.json`). `src/cpp/src/SGP4.cpp` is the file python-sgp4
2.27 ships, line endings aside. Module 1.2.0, `module.wasm` SHA-256
`fe14bc65d1bd8a2827f5e26720af2743ca5132a8b180025a65ed7105b000f347`.
Largest 3D position difference over each set's span (velocity at most
1e-6 m/s in the first three rows, 1.8e-4 m/s in the last):

| Comparison | Near-Earth, 9 sets | Deep space, 23 sets |
| --- | ---: | ---: |
| `SGP4.cpp`, native, Vallado's TLE path, against `tcppver.out` | 7.3 µm | 8.1 µm; 118 µm on 20413 at 1.28e6 min |
| Shipped wasm (`ingest_omm`, `propagate_state` TEME) against that path, at the minutes from epoch the module uses | 0.41 µm | 112 µm (26900 at 9400 min) |
| `SGP4.cpp` in wasm without `-ffast-math`, against the native path | 0.005 µm | 0.23 µm; 37 µm on 20413 at 1.28e6 min |
| Shipped wasm against `tcppver.out`, request = epoch + tsince / 1440 in one Julian-date double | 15.2 cm | 14.6 cm; 9.74 m on 33333 |

- **Printing.** `tcppver.out` prints 1e-8 km and 1e-9 km/s. The native
  path is within half a unit in every component except two rows at
  5.03e-9 km (rounding) and 20413's run 1.28 million minutes from epoch,
  where the 720-minute resonance integration carries rounding to 1.2e-7 km
  (python-sgp4's own test allows 2e-7).
- **Error codes.** The native path stops where `tcppver.out` stops, with
  codes 1, 1, 6, 6, 4, 3, 6 in python-sgp4's order. The module refuses
  33334 at ingestion (code 3 at its epoch) and returns `valid` false at each
  stopping time. `PropagatorState` carries no error code.
- **`-ffast-math`** (CMake flags of `SGP4.cpp`) is the deep-space
  difference: the same wasm build without it agrees with the native path to
  0.23 µm; with it (emcc 4.0.23) the resonant sets (8195, 9880, 21897,
  22674, 26900, 26975) move 28 to 183 µm and 23333 4.1 mm at its epoch, and
  the near-Earth sets reproduce the shipped build's 0.41 µm on the same
  sample. The shipped build (emsdk 6.0.1) moves the same six sets 31 to
  113 µm.
- **Time.** `propagate_state` takes one Julian-date double (40 µs steps
  near JD 2.46e6), and the set's epoch is kept as one double after the ISO
  text: the minutes the module propagates differ from the intended ones by
  up to 19.4 µs, and the epoch by up to 19.8 µs. That is the whole of the
  last row: Vallado's path at the module's minutes reproduces it to the
  micrometre. 33333 (e = 0.995, failing at 25 min) moves 6.5 m per 6 µs at
  20 min while its velocity reads 1 km/s.
- **SGP4-XP.** No US Space Force baseline cases are available here (they
  ship with the Astro Standards packages on Space-Track); `propagator/sgp4-xp/vectors`
  remains the adapter check against the unmodified USSF wasm (2.3 cm).

## Tudat-Derived Verification

The package-local SGP4 regression suite is derived from:

- `testSpiceTLEPropagation` in
  `https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testSpice.cpp`
- `testLambertTargetingIzzo` in
  `https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testMissionSegments.cpp`

The copied cases preserve the same Vallado benchmark, epoch-conversion check,
ISS-like orbit sanity test, plus the Izzo Lambert textbook and hyperbolic
reference cases from Tudat's mission-segments coverage. One adaptation is
intentional: Tudat compares the Vallado benchmark after converting from TEME to
J2000, while this package's public command surface returns TEME state vectors.
The local test therefore uses the same Vallado case against the vendored
`libsgp4` TEME verification vector from `src/cpp/deps/sgp4/SGP4-VER.TLE`, and
keeps the Tudat source links in the test header for provenance.

## hosted-runtime example

A minimal single-plugin flow example lives at:

- `tests/fixtures/hosted-runtime/sgp4.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.propagate.json`

It propagates an ISS GP element over a short horizon and checks that the command bridge returns a non-empty state series.

## License

Apache-2.0.

## Verification sets

<!-- BEGIN GENERATED VERIFICATION SETS -->
[Vallado SGP4-VER](tests/evidence/vallado/) uses `SGP4-VER.TLE` and `tcppver.out` in TEME with WGS-72 and improved mode `i`. Source compares native Vallado with printed states; module compares shipped WASM with native Vallado at the same effective minutes since epoch. Request epoch compares shipped `propagate_state` with printed states at the requested time. Its per-sample position and velocity bound is T + M + P: the native time-shift norm, module norm and 3D printing envelope.

| Comparison | Position (max) | Velocity (max) | Limit | Result |
| --- | --- | --- | --- | --- |
| Source (all) | 0.118 mm | 8.52869e-07 m/s | ≤ 1.000 mm; ≤ 1e-05 m/s | met |
| Module (all) | 0.113 mm | 7.20088e-08 m/s | ≤ 1.000 mm; ≤ 1e-05 m/s | met |
| Request epoch (all) | 9.742 m | 0.00018246 m/s | ≤ T + M + P per sample | not met |
| Request epoch (near-Earth) | 151.767 mm | 0.00018246 m/s | ≤ T + M + P per sample | met |
| Request epoch (deep space) | 9.742 m | 0.000148972 m/s | ≤ T + M + P per sample | not met |

Request-time rounding (maximum shift 19.4 us) accounts for the 15 cm near-Earth and 9.74 m deep-space maxima (set 33333). The 17 samples exceeding the request criterion by up to 0.109 mm carry the native-source residual on set 20413 ([causes](tests/evidence/vallado/causes.json), [report](../hpop/tests/evidence/CONSOLIDATED.md)).

[SGP4-XP](tests/evidence/xp/) checks 640 SGP4/XP sets at 7 times for exact library parity and records 15 Tier B anchors. The XP theory itself has no public reference outside the library; agreement with the library is the available check.

From the repository root:

```sh
UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/hpop/tests/evidence/check-all.mjs
```
<!-- END GENERATED VERIFICATION SETS -->
