import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectModule,
  validateArtifactWithStandards,
  validateManifestWithStandards,
} from "space-data-module-sdk";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("manifest declares the launch-ascent analysis contract", async () => {
  const manifest = readManifest();
  const report = await validateManifestWithStandards(manifest);
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const method = manifest.methods.find(
    (entry) => entry.methodId === "simulate_launch_ascent",
  );
  assert.ok(method);
  assert.equal(method.inputPorts[0].portId, "ascent");
  assert.equal(method.outputPorts[0].portId, "launch");
  assert.deepEqual(method.outputPorts[0].acceptedTypeSets[0].allowedTypes, [
    { schemaName: "LAM.fbs", fileIdentifier: "$LAM", rootTypeName: "LAM" },
  ]);
});

test("built artifact exposes the canonical isomorphic command surface", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(inspection.profile, "standalone");
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("simulate_launch_ascent"));
});
