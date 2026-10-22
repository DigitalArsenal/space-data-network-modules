import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { locateEmbeddedPlgManifest, validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";

const wasmPath = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));

test("terrain-source-watch passes SDK artifact compliance and exports the canonical ABI", async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath, standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const inspected = await inspectModule(fs.readFileSync(wasmPath));
  for (const name of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspected.exports.includes(name), name);
  }
  assert.deepEqual(manifest.capabilities, ["clock"]);
});

test("the embedded manifest retains the declared WasmEdge runtime and typed methods", () => {
  const embedded = locateEmbeddedPlgManifest(fs.readFileSync(wasmPath)).decoded;
  assert.deepEqual(embedded.runtimeTargets, manifest.runtimeTargets);
  assert.deepEqual(embedded.methods.map((m) => m.methodId), ["plan", "diff"]);
  assert.deepEqual(embedded.capabilities.map((c) => c.name), ["clock"]);
});
