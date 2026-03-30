# Pthread Plugin Contract Design

**Date:** 2026-03-29

## Goal

Define the default build and runtime contract for all Space Data Network plugins so new plugins and migrated plugins target the same multithreaded execution model across browser harnesses and WasmEdge:

- Emscripten pthreads by default
- shared-memory FlatBuffer request and response flow
- embedded manifest exports
- no Cesium `TaskProcessor` integration
- no Cesium-specific data structures in plugin inputs, outputs, or browser bootstraps

This design also covers the retrofit of the already-migrated packages in this super-repo.

## Scope

In scope:

- Add a repo-local Codex skill to the super-repo
- Add repo-level Codex instructions so the skill is discoverable
- Encode the default pthread/shared-memory build contract in the skill and its references
- Retrofit the currently migrated packages under `packages/` to match the contract
- Re-run the package verification matrix and push the package repos plus the super-repo

Out of scope:

- Migrating the still-pending plugin repos not yet added under `packages/`
- Introducing Cesium compatibility layers, task processors, or JSON-first alternate ABIs

## Current State

The super-repo currently catalogs six migrated packages:

- `packages/maneuver`
- `packages/cislunar`
- `packages/od`
- `packages/sgp4-propagator`
- `packages/atmosphere`
- `packages/fred`

Those packages already pass the SDK/browser/WasmEdge compatibility smoke tests, but their current wasm builds remain single-threaded Emscripten configurations. They expose the correct command-surface manifest/invoke contract, but they do not yet establish pthread-enabled browser worker assets or a standardized shared-memory build contract for future plugin work.

The super-repo currently has no repo-local Codex skill wiring.

During implementation investigation, a critical runtime constraint became clear:

- an Emscripten pthread build remains browser/JS-host oriented and imports Emscripten thread host functions such as `emscripten_check_blocking_allowed`
- the direct WasmEdge CLI path used by the current smoke harness cannot satisfy those imports
- therefore a single Emscripten artifact cannot be the full threaded answer for both browser and WasmEdge

## Requirements

### Runtime contract

Every plugin in this repo family must:

- ship a browser artifact built with Emscripten pthread support enabled by default
- ship a standalone WasmEdge artifact built for WASI threads rather than the Emscripten JS thread host
- use one shared-memory request/response path centered on the canonical plugin invoke surface
- embed the plugin manifest in the wasm artifact
- keep the browser shim as a thin wrapper around the same invoke surface used by WasmEdge
- avoid Cesium `TaskProcessor`, Cesium worker bootstraps, and Cesium-specific payload shapes

### Browser contract

Browser execution must:

- assume cross-origin isolation is required for pthread support
- ship the worker assets or worker-capable bootstrap needed by Emscripten pthreads
- avoid any external orchestration layer beyond normal Emscripten/browser threading requirements

### WasmEdge contract

WasmEdge execution must:

- use a WASI-threads-compatible standalone artifact, not the browser-targeted Emscripten pthread artifact
- keep the command invoke surface stable
- avoid browser-only assumptions in the core invoke path

### Skill contract

The repo-local Codex skill must:

- trigger when a user asks to create, migrate, or retrofit an SDN plugin in this repo family
- direct Codex to use pthread-enabled shared-memory plugin builds by default
- include concrete file-level expectations for `plugin-manifest.json`, `build.sh`, `src/cpp/CMakeLists.txt`, browser shim behavior, and test coverage
- include a retrofit checklist for existing packages

## Approaches Considered

### 1. Skill only

Create one repo-local skill and stop there.

Pros:

- fastest to ship
- establishes the rule for future work

Cons:

- existing migrated packages remain out of contract
- invites drift between “documented” and “actually shipping”

### 2. Skill plus references

Create one repo-local skill plus reference files and templates, but postpone package retrofits.

Pros:

- stronger guidance than a bare skill
- easier future migrations

Cons:

- still leaves current packages inconsistent
- pushes the riskiest work into a later cleanup phase

### 3. Skill plus immediate retrofit

Create one repo-local skill, add supporting reference files and repo instructions, then retrofit the already-migrated packages now.

Pros:

- aligns documentation and shipped artifacts immediately
- gives one verified pattern for future migrations
- satisfies the “100% done” requirement for the current migrated set

Cons:

- highest initial implementation cost

## Decision

Use approach 3.

The authoritative standard should live in the super-repo as a repo-local Codex skill, and the existing migrated packages should be brought into line with that standard immediately.

## Repo Structure Design

Add the following to the super-repo:

- `AGENTS.md`
- `skills/building-space-data-network-plugins/SKILL.md`
- `skills/building-space-data-network-plugins/references/pthread-build-contract.md`
- `skills/building-space-data-network-plugins/references/browser-shared-memory.md`
- `skills/building-space-data-network-plugins/references/retrofit-checklist.md`

`AGENTS.md` will point Codex to the repo-local skill when work involves plugin creation, migration, retrofit, harness compliance, or wasm build configuration in this repo family.

The skill itself will stay concise and procedural. Detailed build rules and checklists will live in the reference files so the skill remains searchable and cheap to load.

## Build Contract Design

For browser-targeted plugin builds:

- pthread support is the default, not an opt-in variant
- the compile and link stages must both carry the threading configuration
- the browser artifact must support Emscripten’s pthread worker model without any Cesium task-processing layer
- the browser wasm export surface must remain compatible with the SDK harness and browser-side `sdn-flow` integration
- the package build should emit the browser bootstrap assets needed by the browser harness

For WasmEdge-targeted builds:

- the standalone artifact should be produced with a WASI threads toolchain such as `wasi-sdk`
- the standalone artifact must keep the canonical plugin invoke contract over stdin/stdout or exported invoke functions
- the standalone artifact cannot depend on Emscripten JS thread host imports
- current exception-heavy JSON-first runtimes may require additional refactoring before they can use the WASI threads path cleanly

The build contract reference will describe the expected flag categories instead of hard-coding one fragile copy-paste command. The implementation will then translate that into the shared CMake/build patterns used by the migrated packages.

## ABI Design

The canonical plugin ABI remains the command-surface invoke contract already adopted in the migrated packages:

- manifest embedded in the wasm
- `plugin_get_manifest_flatbuffer`
- `plugin_get_manifest_flatbuffer_size`
- `plugin_alloc`
- `plugin_free`
- `plugin_invoke_stream`

The browser shim may expose convenience helpers, but those helpers must be wrappers over the same shared-memory invoke path. There is no separate Cesium ABI and no Cesium-shaped payload conversion layer.

Legacy JSON helpers may temporarily remain only where needed to avoid breaking already-checked-in smoke tests during the retrofit, but the skill will define them as compatibility shims rather than the target architecture. The target architecture is shared-memory FlatBuffer invocation without a JSON-first runtime dependency on the standalone WasmEdge path.

## Retrofit Plan

Retrofit the six migrated packages in this order:

1. `packages/maneuver`
2. `packages/cislunar`
3. `packages/od`
4. `packages/sgp4-propagator`
5. `packages/atmosphere`
6. `packages/fred`

For each package:

- update `src/cpp/CMakeLists.txt` to the pthread-aware contract
- update `build.sh` so browser artifacts and standalone wasm are emitted in the correct shape
- update browser-harness glue as needed so it uses the same shared-memory invoke path
- separate the browser-targeted Emscripten artifact from the WasmEdge-targeted WASI threads artifact
- remove or isolate exception-heavy JSON-first runtime dependencies from the standalone threaded path
- update tests and fixture coverage to assert the pthread/browser/WasmEdge contract
- rerun native tests when present plus wasm/sdk/browser/WasmEdge verification
- commit and push the package repo

After all package repos are updated:

- update the super-repo README to document the new pthread/shared-memory standard
- update submodule pointers
- commit and push the super-repo

## Testing Design

Each retrofitted package should verify:

- native tests where the package already has them
- `bash build.sh`
- `node --test tests/sdk_compat.test.mjs`
- browser harness smoke
- WasmEdge command smoke
- at least one `sdn-flow` example under `tests/fixtures/sdn-flow/`

The repo-local skill should also instruct future Codex instances to preserve that matrix for new plugins.

## Risks And Controls

### Threaded browser requirements

Risk:

- browser pthread support requires the correct worker/bootstrap setup and cross-origin isolation

Control:

- encode those requirements directly in the skill references and in the package test expectations

### Drift between packages

Risk:

- package-specific build edits diverge over time

Control:

- define one authoritative repo-local skill and one retrofit checklist

### Partial migration

Risk:

- only some migrated packages adopt the threaded contract

Control:

- treat the current six-package set as one bounded retrofit batch and push only after all are updated and verified

## Success Criteria

This work is complete when:

- the super-repo contains a discoverable repo-local Codex skill for building and migrating SDN plugins
- the skill clearly encodes pthread-only shared-memory FlatBuffer expectations
- the six currently migrated packages conform to that contract
- package repos and the super-repo are pushed with updated verification evidence
