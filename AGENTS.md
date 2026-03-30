# AGENTS.md

When working in this repository on any of the following:

- creating a new Space Data Network plugin
- migrating a `Friends-Of-Lobsternaut/*-sdn-plugin` repo into a `DigitalArsenal/space-data-network-plugin-*` repo
- retrofitting an existing package under `packages/`
- changing wasm build settings, browser harnesses, WasmEdge compatibility, or `sdn-flow` examples

use the repo-local skill at [skills/building-space-data-network-plugins/SKILL.md](skills/building-space-data-network-plugins/SKILL.md).

That skill is the authoritative contract for:

- pthread-enabled Emscripten builds by default
- shared-memory FlatBuffer plugin invoke paths
- embedded manifest exports
- zero Cesium `TaskProcessor` or Cesium-specific data structures
- required SDK/browser/WasmEdge/`sdn-flow` verification
