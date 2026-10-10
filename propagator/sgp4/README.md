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
