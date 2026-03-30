# Browser Shared-Memory Contract

Use this reference when editing browser shims and browser harnesses.

## Browser expectations

- Browser execution uses the same shared-memory invoke surface as WasmEdge.
- The JS layer is only responsible for loading the module, allocating memory, writing FlatBuffer bytes, invoking exports, and decoding the result.
- Do not introduce a JSON-first browser ABI when the package can use the command-surface ABI directly.
- Do not introduce Cesium `TaskProcessor`, Cesium worker plumbing, or Cesium-specific data structures.

## Worker/bootstrap expectations

- The package `dist/` output must include the browser bootstrap assets required by the Emscripten pthread build.
- Browser tests should assert those assets exist when the Emscripten build emits them.
- Browser documentation or test setup should note that SharedArrayBuffer requires cross-origin isolation.

## Test expectations

Every package browser harness should still prove:

- manifest exports are present
- browser bootstrap loads
- command invoke smoke passes
- the browser path is not using a Cesium-side worker adapter
