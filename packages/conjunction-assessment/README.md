# Conjunction Assessment Plugin

Conjunction assessment and collision probability analysis packaged as a canonical `space-data-module-sdk` command-surface plugin for `sdn-flow`, WasmEdge, and browser runtimes.

## What it does

This plugin exposes conjunction assessment computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "assess",
  "params": {
    "object1": { "line1": "...", "line2": "..." },
    "object2": { "line1": "...", "line2": "..." },
    "start_jd": 2460000.5,
    "duration_days": 7.0
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `assess` -- full conjunction assessment for a TLE pair
- `screen` -- screen multiple TLE pairs for conjunctions

These operations route the conjunction assessment engine through the canonical SDK command bridge.

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

- `dist/conjunction_assessment_wasm.js`
- `dist/conjunction_assessment_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/conjunction_assessment_wasm.js`
- WasmEdge command invoke smoke via `dist/conjunction_assessment_wasm.wasm`
- an `sdn-flow` example contract check

## sdn-flow example

A minimal single-plugin flow example lives at:

- `tests/fixtures/sdn-flow/conjunction.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## License

MIT.
