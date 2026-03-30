# Pthread Build Contract

Use this reference when editing `src/cpp/CMakeLists.txt`, `build.sh`, and wasm packaging.

## Required build shape

- Build two runtime artifacts:
  - browser artifact: Emscripten pthread output
  - standalone artifact: WASI threads output for WasmEdge
- Keep the canonical export surface available for SDK and `sdn-flow` harnesses:
  - `plugin_alloc`
  - `plugin_free`
  - `plugin_invoke_stream`
  - `plugin_get_manifest_flatbuffer`
  - `plugin_get_manifest_flatbuffer_size`
- Emit the browser bootstrap assets needed by the browser harness.
- Emit a standalone `.wasm` that does not depend on Emscripten JS thread-host imports.

## Browser Emscripten settings

Start from these categories and translate them into the package-local CMake pattern:

- `-pthread`
- `-s USE_PTHREADS=1`
- `-s PTHREAD_POOL_SIZE=<expression>`
- `-s STANDALONE_WASM=1`
- `-s FILESYSTEM=0` unless the package truly needs it
- `-s MALLOC=mimalloc` when allocator contention is expected under threads

## Standalone WasmEdge settings

For the standalone artifact:

- use a WASI threads toolchain such as `wasi-sdk`
- target `wasm32-wasip1-threads` or the active WASI threads target supported by the toolchain
- pass `-pthread` on the standalone build path too
- keep stdin/stdout command invocation or exported invoke functions intact
- avoid Emscripten JS thread imports such as `emscripten_check_blocking_allowed`

## Important constraints

- Per the Emscripten pthread docs, browser pthread builds require cross-origin isolation headers.
- Per the Emscripten pthread docs, a single binary cannot transparently fall back from threaded to non-threaded mode. Treat the browser pthread artifact as its own target, not the same target as WasmEdge.
- Per the Emscripten pthread docs, `ALLOW_MEMORY_GROWTH` with pthreads is tricky and should not be the default plugin pattern. Use fixed initial memory unless a package proves otherwise.
- Direct WasmEdge CLI execution is not a valid host for an Emscripten pthread artifact because the browser-targeted artifact imports JS-side thread host functions.
- Current exception-heavy JSON-first runtimes may need refactoring before they can use the standalone WASI threads path.
- `PROXY_TO_PTHREAD` is browser-specific and should be used only when the browser bootstrap truly needs main-thread blocking avoidance. It is not the default requirement for command-surface plugins.

## CMake checklist

- Thread flags appear in both compile and link configuration for the browser and standalone paths.
- Browser/runtime exports remain stable.
- Package-specific libraries stay unchanged unless the threaded build forces a real fix.
- Native test targets remain available outside the Emscripten path.
