# FRED Plugin

Federal Reserve Economic Data queries packaged as a canonical `space-data-module-sdk` command-surface plugin for `sdn-flow`, WasmEdge, and browser runtimes.

## What it does

This plugin exposes FRED computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "parseJson",
  "params": {
    "input": "{\"observations\":[{\"date\":\"2025-01-02\",\"value\":\"4.33\"}]}"
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `validate`
- `parseJson`

These operations route the repo's existing FRED JSON validation and parsing logic through the canonical SDK command bridge.

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

- `dist/fred_wasm.js`
- `dist/fred_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/fred_wasm.js`
- WasmEdge command invoke smoke via `dist/fred_wasm.wasm`
- an `sdn-flow` example contract check

## sdn-flow example

A minimal single-plugin flow example lives at:

- `tests/fixtures/sdn-flow/fred.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.parse.json`

It parses a minimal FRED observations response and checks the resulting record summary.

## License

Apache-2.0.
