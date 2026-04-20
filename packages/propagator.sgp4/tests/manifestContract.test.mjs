// Verifies that the SGP4 wasm artifact exposes the SDK 0.8.0 invoke surface,
// OrbPro's direct-call surface, and an embedded PluginManifest whose identity
// matches the authored `plugin-manifest.json`. If this test drifts from the
// manifest the build is wired up incorrectly (manifest bytes baked in by
// `generate-manifest-header.mjs` didn't match what the plugin reports at
// runtime), so failures here should be treated as hard errors.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectModule } from "space-data-module-sdk";
import { decodePluginManifest } from "space-data-module-sdk/manifest";

import { loadRawSgp4Module } from "./lib/invokeStreamHelper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const manifestJsonPath = path.join(packageRoot, "plugin-manifest.json");

test("SGP4 wasm artifact exports the SDK 0.8.0 invoke surface alongside OrbPro direct-call exports", async () => {
  const wasmBytes = await readFile(wasmPath);
  const { exports } = await inspectModule(wasmBytes);
  const exportSet = new Set(exports);

  for (const required of [
    "plugin_invoke_stream",
    "plugin_get_input_frame",
    "plugin_push_output_typed",
    "plugin_set_error",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "plugin_alloc",
    "plugin_free",
  ]) {
    assert.ok(
      exportSet.has(required),
      `expected SDK 0.8.0 export ${required}`,
    );
  }

  for (const required of [
    "plugin_stream_invoke",
    "plugin_init",
    "plugin_init_omm",
    "plugin_destroy",
    "plugin_propagate",
    "plugin_propagate_batch",
    "plugin_propagate_path",
    "get_satellite_count",
  ]) {
    assert.ok(
      exportSet.has(required),
      `expected OrbPro direct-call export ${required}`,
    );
  }
});

test("SGP4 embedded manifest identity matches plugin-manifest.json", async () => {
  const module = await loadRawSgp4Module();
  try {
    const size = module._plugin_get_manifest_flatbuffer_size();
    assert.ok(size > 0, "embedded manifest should have non-zero size");
    const pointer = module._plugin_get_manifest_flatbuffer();
    assert.ok(pointer > 0, "embedded manifest pointer should be non-zero");
    const bytes = new Uint8Array(module.HEAPU8.slice(pointer, pointer + size));

    const runtimeManifest = decodePluginManifest(bytes);
    const authoredManifest = JSON.parse(
      await readFile(manifestJsonPath, "utf8"),
    );

    assert.equal(runtimeManifest.pluginId, "com.orbpro.sgp4");
    assert.equal(runtimeManifest.pluginId, authoredManifest.pluginId);
    assert.equal(runtimeManifest.name, authoredManifest.name);
    assert.equal(runtimeManifest.version, authoredManifest.version);

    const runtimeMethodIds = runtimeManifest.methods
      .map((method) => method.methodId)
      .sort();
    const authoredMethodIds = authoredManifest.methods
      .map((method) => method.methodId)
      .sort();
    assert.deepEqual(runtimeMethodIds, authoredMethodIds);
  } finally {
    module._plugin_destroy();
  }
});
