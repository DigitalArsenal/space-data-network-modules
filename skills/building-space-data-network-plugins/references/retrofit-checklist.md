# Retrofit Checklist

Use this checklist whenever retrofitting an existing package under `packages/`.

## Package files

- `plugin-manifest.json`
- `build.sh`
- `src/cpp/CMakeLists.txt`
- `src/cpp/src/plugin_entrypoints.cpp`
- `src/cpp/src/plugin_invoke_bridge.cpp`
- `tests/sdk_compat.test.mjs`
- `tests/fixtures/sdn-flow/*.json`
- `README.md`

## Required outcomes

- pthread-enabled Emscripten browser build by default
- standalone WASI threads build for WasmEdge
- embedded manifest exports preserved
- shared-memory FlatBuffer invoke surface preserved
- no Cesium `TaskProcessor` or Cesium-shaped browser glue
- browser shim still works
- WasmEdge smoke still works
- `sdn-flow` example still works
- standalone path no longer depends on exception-heavy JSON-first runtime code

## Verification order

1. Run native tests if the package has them.
2. Run `bash build.sh`.
3. Run `node --test tests/sdk_compat.test.mjs`.
4. Check generated browser artifacts in `dist/`.
5. Check that the standalone WasmEdge artifact imports only the runtime it should.
6. Commit the package.
7. Push to the `digitalarsenal` remote.

## Super-repo follow-through

- Update the package submodule pointer.
- Update the root `README.md` if the package status text changes.
- Commit and push the super-repo after all changed packages verify cleanly.
