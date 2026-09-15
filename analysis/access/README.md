# Access analysis

The canonical build uses SDK `compileModuleFromSource` and its
`wasi-sequential` profile. The module processes ordered trajectory samples and
exports both direct PIV and command invocation. One byte-identical WASM file is
used in Chrome/V8, native WasmEdge, and container WasmEdge. Browser JS adapts
legacy C export names and memory views; the existing C++ evaluator computes ACW.

```sh
npm ci --ignore-scripts
node build.mjs
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
```

The build generates ACW C++ headers from the pinned published SDS package and
uses the SDK's configured WASI clang toolchain. It does not sign or publish.
`node build.js` and `npm run build` invoke the same canonical build.

The parity command requires Chrome, native WasmEdge, and Docker with the SDK's
pinned WasmEdge image. It checks six Orekit inverse-coordinate cases and all
three SDK command error fixtures at thread counts 1, 2, 4, and 8. The numerical
test documents source, units, frame, TT epoch, and the unchanged 1e-10 rad bound
in `tests/orekit-fixture.mjs`. There is no missing-runtime success path.

The SDK now enforces the manifest's required input port before calling the
method. An empty valid PIV request returns `missing-required-input` with
`Missing required input port: request`; malformed command bytes are handled by
the shared SDK command bridge.
