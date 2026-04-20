# SGP4 Propagator Plugin

SGP4/SDP4 orbital propagation operations packaged as a canonical `space-data-module-sdk` command-surface plugin for `sdn-flow`, WasmEdge, and browser runtimes.

## What it does

This plugin exposes SGP4 computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "propagateGP",
  "params": {
    "gpJson": "[{\"OBJECT_NAME\":\"ISS (ZARYA)\",\"NORAD_CAT_ID\":25544}]",
    "durationDays": 0.05,
    "stepSeconds": 300
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `epochToJd`
- `propagateToEpoch`
- `propagateGP`
- `solveLambert`

These operations route the repo's existing GP parser, SGP4 propagator, and Lambert solver through the canonical SDK command bridge.

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
bash build.sh
```

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
npm test
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/browser/module.js`
- WasmEdge command invoke smoke via `dist/isomorphic/module.wasm`
- an `sdn-flow` example contract check
- Tudat-derived SGP4 regression coverage in `tests/tudat_wasm_derived.test.mjs`

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

## sdn-flow example

A minimal single-plugin flow example lives at:

- `tests/fixtures/sdn-flow/sgp4.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.propagate.json`

It propagates an ISS GP element over a short horizon and checks that the command bridge returns a non-empty state series.

## License

Apache-2.0.
