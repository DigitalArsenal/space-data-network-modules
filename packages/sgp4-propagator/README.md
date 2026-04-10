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

- `dist/sgp4_wasm.js`
- `dist/sgp4_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/sgp4_wasm.js`
- WasmEdge command invoke smoke via `dist/sgp4_wasm.wasm`
- an `sdn-flow` example contract check

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
