import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards, validateManifestWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { STANDARDS_ROOT } from "./sds.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));

test("every port names one concrete SDS type", async () => {
  const report = await validateManifestWithStandards(manifest, { standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = manifest.methods;
  assert.equal(method.methodId, "compute_covariance");
  const types = (ports) => Object.fromEntries(ports.map((p) => {
    assert.equal(p.acceptedTypeSets.length, 1);
    assert.equal(p.acceptedTypeSets[0].allowedTypes.length, 1);
    const [type] = p.acceptedTypeSets[0].allowedTypes;
    assert.equal(type.acceptsAnyFlatbuffer, undefined);
    assert.equal(type.wireFormat, "flatbuffer");
    return [p.portId, type.fileIdentifier];
  }));
  assert.deepEqual(types(method.inputPorts), { covariance: "$SBC" });
  assert.deepEqual(types(method.outputPorts), { covariance: "$OCM", diagnostics: "$SBC" });
});

test("the artifact passes SDK compliance and imports only WASI", async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.ok(inspection.exports.includes("compute_covariance"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).filter((m) => m !== "wasi_snapshot_preview1" && m !== "wasi"), []);
});
