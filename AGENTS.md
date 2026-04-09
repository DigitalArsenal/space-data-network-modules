# AGENTS.md

## Upstream Authority

The canonical module contract lives in
[`space-data-module-sdk/AGENTS.md`](../space-data-module-sdk/AGENTS.md).
That document is the source of truth for manifest schemas, invoke ABI,
compliance rules, build toolchains, isomorphic artifact layout, capability
vocabulary, and verification recipes. Everything in this repository must
conform to the SDK contract. If something here disagrees with the SDK, the SDK
wins.

Read [`space-data-module-sdk/docs/browser-wasmedge-isomorphic.md`](../space-data-module-sdk/docs/browser-wasmedge-isomorphic.md)
for the isomorphic artifact contract: one `dist/isomorphic/module.wasm` that
loads unchanged in both browser and WasmEdge.

## When Working In This Repository

When creating, migrating, retrofitting, or verifying a package under
`packages/`:

1. Read the SDK AGENTS.md first.
2. Follow the SDK's canonical build and publication rules.
3. Use `dist/isomorphic/module.wasm` as the single compiled artifact path.
4. Verify with `node --test tests/sdk_compat.test.mjs` after building.

## Build Rules (Inherited From SDK)

- One isomorphic `.wasm` artifact per package: `dist/isomorphic/module.wasm`.
- Exports: `plugin_alloc`, `plugin_free`, `plugin_invoke_stream`,
  `plugin_get_manifest_flatbuffer`, `plugin_get_manifest_flatbuffer_size`.
- `plugin-manifest.json` is the authoring source; embedded manifest bytes are
  the runtime source of truth.
- No Cesium `TaskProcessor` or Cesium-specific data structures.
- Build through repo-local `deps/emsdk`, not Homebrew or machine-global
  Emscripten.

## What Belongs Here

- Individual SDN module packages and their published `dist/` outputs.
- Plugin-specific C++/WASM source, manifests, build scripts, and tests.
- Each plugin is a standalone, isomorphic WASM module that runs on both
  WasmEdge (server) and browser (via `browserModuleHarness` + WASI shim).

## What Does Not Belong Here

- SDK internals — those live in `space-data-module-sdk`.
- Application-specific host behavior — that belongs in the host repo (OrbPro,
  `sdn-js`, Go SDN).
- Flow composition and runtime orchestration — those belong in `sdn-flow`.
