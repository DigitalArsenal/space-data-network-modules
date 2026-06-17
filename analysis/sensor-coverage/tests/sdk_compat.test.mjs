import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectModule,
  validateArtifactWithStandards,
  validateManifestWithStandards,
} from "space-data-module-sdk";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);

test("manifest declares the sensor coverage analysis contract", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateManifestWithStandards(manifest);
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.equal(manifest.pluginId, "sensor-coverage-analysis");
  assert.equal(manifest.runtimeTargets.includes("browser"), true);
  assert.equal(manifest.runtimeTargets.includes("wasmedge"), true);
  assert.deepEqual(
    manifest.invokeSurfaces,
    ["direct", "command"],
    "browser coverage must advertise direct invoke while retaining command compatibility",
  );
  assert.equal(manifest.methods[0].methodId, "compute_sensor_coverage");
  const method = manifest.methods[0];
  const inputTypes =
    method.inputPorts[0].acceptedTypeSets[0].allowedTypes;
  const outputTypes =
    method.outputPorts[0].acceptedTypeSets[0].allowedTypes;
  assert.equal(
    inputTypes.some((typeRef) => typeRef.acceptsAnyFlatbuffer === true),
    false,
    "sensor coverage input must use explicit SDS/compatibility type refs",
  );
  assert.equal(
    outputTypes.some((typeRef) => typeRef.acceptsAnyFlatbuffer === true),
    false,
    "sensor coverage output must use explicit SDS/compatibility type refs",
  );
  assert.deepEqual(
    inputTypes.map((typeRef) => typeRef.fileIdentifier).sort(),
    ["$SCV", "JSON"],
  );
  assert.deepEqual(
    outputTypes.map((typeRef) => typeRef.fileIdentifier).sort(),
    ["$SCV", "JSON"],
  );
  assert.equal(
    manifest.schemasUsed.some(
      (typeRef) =>
        typeRef.schemaName === "SCV/main.fbs" &&
        typeRef.fileIdentifier === "$SCV",
    ),
    true,
  );
});

test("built artifact exposes the canonical direct invoke and command compatibility surfaces", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(inspection.profile, "standalone");
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("compute_sensor_coverage"));
});
