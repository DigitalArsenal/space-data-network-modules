# SGP4 Propagator Plugin

FFM (Full Force Model) is defined by [FFM-1](../ffm/FFM.md).

SGP4/SDP4 orbital propagation operations packaged as a canonical `space-data-module-sdk` command-surface plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

SGP4/SDP4 (the clean-room base `foundation/sgp4-str3`: Spacetrack Report No. 3 with the corrections AIAA 2006-6753
documents; WGS 72, improved mode) over OMM element sets, through the
SDS PIV invoke surface (`plugin_invoke_stream`). Methods:

| Method | In | Out |
| --- | --- | --- |
| `ingest_omm` | `omm` (`$OMM`, size-prefixed `$OMM` stream) or `records` (`$REC`) | — |
| `upsert_cat` | `catalog` (`$CAT`) or `records` (`$REC`) | — |
| `propagate_state` | `request` (`PropagatorBatchRequest`), optional `omm`/`records` | `state`: one `PropagatorState` per object |
| `propagate_ephemeris` | `request`, optional `omm`/`records` | `ephemeris`: one SDS `$OEM` per object |
| `catalog_query` | `request` (`CatalogQueryRequest`) | `results` |

Objects with one NORAD number share one entity and its element-set history.

### Catalog records (`$CAT`)

The catalog keeps each `$CAT` as a FlatBuffer (1.3.0): a direct `$CAT`
byte for byte, one carried in a `$REC` re-finished as its own `$CAT`. A
`$CAT` is verified against the origin it was finished at (1.3.1): a root
buffer as is, a frame finished behind a 4-byte size prefix (every frame of
a size-prefixed stream, and one sliced out of it) as size-prefixed, then
re-finished as its own `$CAT`. The
direct-call pair `plugin_get_cat_record_flatbuffer_size` /
`plugin_get_cat_record_flatbuffer` answers that FlatBuffer by NORAD number.
Records enter only as FlatBuffers (`upsert_cat`,
`plugin_catalog_upsert_cat_flatbuffer_stream`).

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
- `gcrfOutput`: the SGP4-VER sets (AIAA 2006-6753) against pyerfa's GCRF of their published t = 0
  TEME rows (`analysis/epoch-state/tests/vallado-verification.json`): within
  2e-5 m and 2e-6 m/s (the fixture's printing), the rotation alone within 1e-6 m and 1e-7 m/s.
- `ephemerisOutput`: every `$OEM` state equals its element set propagated
  alone (to the microsecond epochs: < 1 m), block spans and metadata, and
  `detect_maneuvers` reads the result.
- `legacyPropagateState`: 1.1.0-layout requests return this release's
  responses byte for byte (`tests/fixtures/propagate-state-digests.json`).

`tests/parity.mjs` runs one-invocation cases (each carrying its element sets)
in Chrome and native WasmEdge (the owner waived the Docker leg on 2026-10-22) and writes
[`conformance/parity.json`](conformance/parity.json).

### The module against its base

`node tests/evidence/str3/run-str3.mjs` propagates 13 element sets (the seven SGP4-VER sets, the module's test sets and
four regimes more: GPS, 24-hour resonant GEO, 12-hour resonant Molniya, a decaying LEO) through the built module
(`ingest_omm`, `propagate_state` in TEME) from a day before epoch to ten days after, and holds every state to
`foundation/sgp4-str3` built natively without `-ffast-math` at the minutes from epoch the module computes
(`library_states.cpp`). It writes [`summary-str3.json`](tests/evidence/str3/summary-str3.json):

| Regime | Sets | States | Largest position difference | Largest velocity difference |
| --- | ---: | ---: | ---: | ---: |
| Near-Earth | 6 | 72 | 3.67 µm | 4.5e-09 m/s |
| Deep space, 12-hour and other | 5 | 60 | 6.29 µm | 5.5e-09 m/s |
| 24-hour (GEO) | 2 | 24 | 0.90 µm | 6.6e-11 m/s |

The differences are the module's `-ffast-math` build of the same code.

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

Request-time rounding (maximum shift 19.4 us) accounts for the 15 cm near-Earth and 9.74 m deep-space maxima (set 33333). The 17 samples exceeding the request criterion by up to 0.109 mm carry the native-source residual on set 20413 ([causes](tests/evidence/vallado/causes.json), [report](../ffm/tests/evidence/CONSOLIDATED.md)).

[SGP4-XP](tests/evidence/xp/) checks 640 SGP4/XP sets at 7 times for exact library parity and records 15 Tier B anchors. The XP theory itself has no public reference outside the library; agreement with the library is the available check.

From the repository root:

```sh
UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/ffm/tests/evidence/check-all.mjs
```
<!-- END GENERATED VERIFICATION SETS -->
