# Maneuver Planning Plugin

Classical orbital maneuver and ROE targeting operations packaged as a canonical `space-data-module-sdk` command-surface plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

This plugin exposes maneuver computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "hohmannTransfer",
  "params": {
    "r1": 6778000.0,
    "r2": 42164000.0,
    "mu": 398600441800000.0
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `hohmannTransfer`
- `biEllipticTransfer`
- `solveLambert`
- `solveLambertMinDV`
- `phasingManeuver`
- `planeChange`
- `combinedManeuver`
- `computeCAM`
- `computeApproach`

These operations mirror the repo’s existing maneuver math and targeting helpers and are routed through the canonical SDK command bridge.

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

- `dist/maneuver_wasm.js`
- `dist/maneuver_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/maneuver_wasm.js`
- WasmEdge command invoke smoke via `dist/maneuver_wasm.wasm`
- a hosted-runtime example contract check

## hosted-runtime example

A minimal single-plugin flow example lives at:

- `tests/fixtures/hosted-runtime/maneuver.single-plugin.flow.json`

It binds a manual trigger to the plugin’s canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.hohmann.json`

It exercises a Hohmann transfer from LEO-like radius to GEO.

## License

Apache-2.0.
