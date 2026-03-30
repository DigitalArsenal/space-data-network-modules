---
name: building-space-data-network-plugins
description: Use when creating, migrating, retrofitting, or verifying Space Data Network plugins in this repo family
---

# Building Space Data Network Plugins

## Overview

This repo family has one plugin contract:

- Emscripten pthreads for the browser artifact by default
- WASI threads for the standalone WasmEdge artifact
- shared-memory FlatBuffer request and response flow
- embedded manifest exports inside the `.wasm`
- no Cesium `TaskProcessor`
- no Cesium-specific data structures

Use this skill whenever work touches a package under `packages/` or creates a new `space-data-network-plugin-*` repo.

## Workflow

1. Read [pthread-build-contract.md](references/pthread-build-contract.md).
2. Read [browser-shared-memory.md](references/browser-shared-memory.md) before touching browser harnesses or JS shims.
3. Read [retrofit-checklist.md](references/retrofit-checklist.md) before migrating or retrofitting a package.
4. Keep one ABI across browser and WasmEdge: manifest exports plus `plugin_alloc`, `plugin_free`, and `plugin_invoke_stream`.
5. Verify native tests when present, then `bash build.sh`, then `node --test tests/sdk_compat.test.mjs`.

## Rules

- Treat the browser Emscripten pthread build and the standalone WASI threads build as a matched pair.
- The browser path is a thin shim over the same shared-memory invoke surface used by WasmEdge.
- Do not introduce Cesium `TaskProcessor`, Cesium workers, or Cesium payload adapters.
- Prefer package-local build/test patterns already proven in migrated packages, but update them to match the pthread contract.
- Keep `plugin-manifest.json` as the authoring source and the embedded manifest bytes as the runtime source of truth.
- Require at least one `sdn-flow` example under `tests/fixtures/sdn-flow/`.
- Do not assume the direct WasmEdge CLI can execute an Emscripten pthread artifact. The standalone artifact must be built for WASI threads or an equivalent non-JS host runtime.
- If a package runtime still depends on exceptions and JSON-first request parsing, treat that as retrofit work before enabling a standalone threaded WasmEdge artifact.

## When Updating A Package

- Update `src/cpp/CMakeLists.txt`.
- Update `build.sh`.
- Update browser harness expectations in `tests/sdk_compat.test.mjs`.
- Keep or add an `sdn-flow` example fixture.
- Re-run verification before commit and push.
