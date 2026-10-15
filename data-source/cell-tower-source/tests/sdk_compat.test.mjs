// data-source/cell-tower-source SDK compliance on the typed contracts (1.0):
// every port names exactly ONE concrete FlatBuffer type, the artifact passes the
// SDK's standards validation, and it imports nothing but the hostcall bridge and
// WASI (it makes no hostcall: capabilities none).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";

import { MANIFEST_PATH, STANDARDS_ROOT, WASM_PATH } from "./helpers.mjs";

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

test("cell-tower-source artifact passes SDK compliance with typed ports only", async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(type.wireFormat, "flatbuffer", port.portId);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "route.request": "$HTQ", "route.requests": "HREQ", "route.decision": "$APR", "route.availability": "$DAV",
    "route.catalog": "$QRP", "route.credential": "$APR",
    "parse.responses": "HRSP", "parse.job": "$APR", "parse.reports": "$TBS", "parse.resume": "$IRM",
    "deconflict.job": "$APR", "deconflict.reports": "$TBS", "deconflict.records": "$TBS",
    "deconflict.decision": "$APR", "deconflict.availability": "$DAV",
  });
  assert.deepEqual(manifest.capabilities, []);
});

test("the built artifact embeds this manifest's plugin id and version", () => {
  const embedded = embeddedPlgManifest(new WebAssembly.Module(fs.readFileSync(WASM_PATH)));
  assert.equal(embedded?.pluginId, manifest.pluginId);
  assert.equal(embedded?.version, manifest.version);
});

test("cell-tower-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(WASM_PATH)));
  const modules = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  for (const m of modules) assert.ok(["space_data_module_host", "wasi_snapshot_preview1"].includes(m), m);
});
