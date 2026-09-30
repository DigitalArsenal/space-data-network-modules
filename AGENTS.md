# AGENTS.md

## Design principles

Before any code or structural change, read the stack's design principles and follow their hard rule (refactor to the principle first, then change behavior): `../../../docs/policies/design-principles.md` inside the spacedatanetwork-stack checkout, or https://github.com/DigitalArsenal/spacedatanetwork-stack/blob/main/docs/policies/design-principles.md.

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

Packages are organized by family subfolder (e.g., `propagator/`, `analysis/`,
`basilisk/`, `shaders/`, `licensing/`, `delivery/`). When creating, migrating,
retrofitting, or verifying a package under any family subfolder:

1. Read the SDK AGENTS.md first.
2. Follow the SDK's canonical build and publication rules.
3. Use `dist/isomorphic/module.wasm` as the primary compiled SDK artifact path.
   Conjunction-assessment also ships
   `dist/isomorphic-singlethread/module.wasm` as a Node recovery-test artifact
   because its primary isomorphic artifact is pthread-enabled for WasmEdge.
4. Verify with `node --test tests/sdk_compat.test.mjs` after building.

## Authoritative Tests Are Required

Do not mark a module complete unless it has authoritative tests based on public
standards examples, published numerical values, upstream Basilisk expected
values, or closed-form physics cases with independently calculated results.

Every numerical test must state source, units, reference frame, epoch or time
scale, tolerance, and the tolerance rationale. Golden outputs generated only by
the new module do not count.

For Basilisk-wide planning or standards-map changes:

```sh
npm run generate:basilisk-plan
npm run check:basilisk-plan
```

## Local Validation Data For Agents

Do not rediscover the conjunction validation datasets from scratch or hardcode
machine-specific paths. Large local validation data belongs in the
conjunction-assessment module's ignored test-data directory:

- `analysis/conjunction-assessment/tests/data/`
- Detailed layout: `analysis/conjunction-assessment/tests/data/README.md`

Place SOCRATES/CelesTrak catalog files directly under
`analysis/conjunction-assessment/tests/data/`, including
`socrates_current.csv`, `socrates_full.csv`, `socrates_maxprob.csv`,
`socrates_minrange_current.csv`, `socrates_norad_ids.txt`, and
`socrates_gp/gp_*.json`.

Place Aerospace IVV archive files under
`analysis/conjunction-assessment/tests/data/aerospace-archives/`.

The Aerospace archive root contains:

- `AerospaceIVVDataset_20251009a.tar.gz`
- `AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz`
- `IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz`
- `IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz`
- `Conjunction_Screening_Testset_Users_Guide.pdf`

The Aerospace extracted replay layout, when needed, is still
`analysis/conjunction-assessment/tests/data/aerospace-ivv/` by default or
whatever `AEROSPACE_IVV_EXTRACTED_ROOT` points to. The archive smoke tests use
`tests/data/aerospace-archives/` directly and do not require extraction.

## Build Rules (Inherited From SDK)

- One isomorphic `.wasm` artifact per package: `dist/isomorphic/module.wasm`.
- Exports: `plugin_alloc`, `plugin_free`, `plugin_invoke_stream`,
  `plugin_get_manifest_flatbuffer`, `plugin_get_manifest_flatbuffer_size`.
- `plugin-manifest.json` is the authoring source; embedded manifest bytes are
  the runtime source of truth.
- No Cesium `TaskProcessor` or Cesium-specific data structures.
- Build through repo-local `deps/emsdk`, not Homebrew or machine-global
  Emscripten.
- Never invoke `emcc`, `em++`, `emcmake`, or `emar` from PATH unless PATH has
  already been populated by sourcing a repo-local `deps/emsdk/emsdk_env.sh`.
- If a package build script still uses system Emscripten or Homebrew-managed
  Emscripten, fix the script before continuing. That is a repo bug, not an
  acceptable fallback.

## What Belongs Here

- Individual SDN module packages and their published `dist/` outputs.
- Module-specific C++/WASM source, manifests, build scripts, and tests.
- Basilisk-derived runtime seeds, module plans, standards maps, and thin
  wrappers that use `../basilisk` as the upstream source of truth.
- Each module is a standalone, isomorphic WASM module that runs on both
  WasmEdge (server) and browser (via `browserModuleHarness` + WASI shim).

## What Does Not Belong Here

- SDK internals — those live in `space-data-module-sdk`.
- Application-specific host behavior — that belongs in the host repo (OrbPro,
  `sdn-js`, Go SDN).
- Flow composition and runtime orchestration belong in host repos such as OrbPro and Space Data Network.
