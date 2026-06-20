import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectModule,
  validateArtifactWithStandards,
  validateManifestWithStandards,
} from "space-data-module-sdk";
import { verifyModuleArtifact } from "space-data-module-sdk/bundle";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const DEV_MODULE_SIGNER_PUBLIC_KEY_HEX =
  "cf4625795484d8efe18860141cfdeaaaed7bbee9209488405b6ddeac7543fe78";

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
    "sensor coverage input must use the explicit SDS SCV type ref",
  );
  assert.equal(
    outputTypes.some((typeRef) => typeRef.acceptsAnyFlatbuffer === true),
    false,
    "sensor coverage output must use the explicit SDS SCV type ref",
  );
  assert.deepEqual(
    inputTypes,
    [
      {
        schemaName: "SCV/main.fbs",
        fileIdentifier: "$SCV",
        rootTypeName: "SCV",
        wireFormat: "flatbuffer",
        requiredAlignment: 8,
      },
    ],
  );
  assert.deepEqual(
    outputTypes,
    [
      {
        schemaName: "SCV/main.fbs",
        fileIdentifier: "$SCV",
        rootTypeName: "SCV",
        wireFormat: "flatbuffer",
        requiredAlignment: 8,
      },
    ],
  );
  assert.equal(
    JSON.stringify(manifest).includes("SensorCoverageCompatibilityJson"),
    false,
    "sensor coverage is SCV-only and must not advertise JSON compatibility",
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

test("built artifact carries a trusted SDS module signature", async () => {
  const signature = await verifyModuleArtifact(fs.readFileSync(WASM_PATH), {
    trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
    requireSignature: true,
  });
  assert.equal(signature.publicKeyHex, DEV_MODULE_SIGNER_PUBLIC_KEY_HEX);
});
