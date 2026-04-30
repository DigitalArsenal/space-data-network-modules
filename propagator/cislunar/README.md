# Cislunar Propagation Plugin

CR3BP propagation and cislunar trajectory design operations packaged as a canonical `space-data-module-sdk` command-surface plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

This plugin exposes cislunar computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "computeLagrangePoints",
  "params": {
    "mu": 0.0121505856
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `propagateCR3BP`
- `computeLagrangePoints`
- `jacobiConstant`
- `computePeriodicOrbit`
- `richardsonHaloGuess`
- `computeNRHO`
- `computeTransfer`
- `estimateStationKeeping`
- `coordinateTransform`

These operations route the repo's existing CR3BP propagation, periodic orbit, transfer, and coordinate transform helpers through the canonical SDK command bridge.

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

- `dist/cislunar_wasm.js`
- `dist/cislunar_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/cislunar_wasm.js`
- WasmEdge command invoke smoke via `dist/cislunar_wasm.wasm`
- a hosted-runtime example contract check

## hosted-runtime example

A minimal single-plugin flow example lives at:

- `tests/fixtures/hosted-runtime/cislunar.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.lagrange.json`

It exercises `computeLagrangePoints` for the Earth-Moon mass ratio.

## License

Apache-2.0.
