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
const SCV_TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
  wireFormat: "flatbuffer",
  requiredAlignment: 8,
});

test("manifest declares the SDK-compliant sensor model contract", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateManifestWithStandards(manifest);
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  assert.equal(manifest.pluginId, "sensor-model");
  assert.deepEqual(manifest.invokeSurfaces, ["direct", "command"]);
  assert.equal(manifest.runtimeTargets.includes("browser"), true);
  assert.equal(manifest.runtimeTargets.includes("wasmedge"), true);

  assert.equal(manifest.methods.length, 1);
  const method = manifest.methods[0];
  assert.equal(method.methodId, "evaluate_sensor_shape");
  assert.equal(method.inputPorts.length, 1);
  assert.equal(method.outputPorts.length, 1);
  assert.equal(method.inputPorts[0].portId, "sensor");
  assert.equal(method.outputPorts[0].portId, "result");

  const inputTypes = method.inputPorts[0].acceptedTypeSets[0].allowedTypes;
  const outputTypes = method.outputPorts[0].acceptedTypeSets[0].allowedTypes;
  assert.deepEqual(inputTypes, [SCV_TYPE_REF]);
  assert.deepEqual(outputTypes, [SCV_TYPE_REF]);
  assert.deepEqual(
    manifest.schemasUsed.map(
      ({ schemaName, fileIdentifier, rootTypeName, wireFormat, requiredAlignment }) => ({
        schemaName,
        fileIdentifier,
        rootTypeName,
        wireFormat,
        requiredAlignment,
      }),
    ),
    [SCV_TYPE_REF],
  );
});

test("built artifact exposes direct invoke and command compatibility exports", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(inspection.profile, "standalone");
  for (const exportName of [
    "_start",
    "plugin_invoke_stream",
    "plugin_alloc",
    "plugin_free",
    "evaluate_sensor_shape",
  ]) {
    assert.ok(
      inspection.exports.includes(exportName),
      `expected ${exportName} export`,
    );
  }
});

test("built artifact carries the dev module signature", async () => {
  const signature = await verifyModuleArtifact(fs.readFileSync(WASM_PATH), {
    trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
    requireSignature: true,
  });
  assert.equal(signature.publicKeyHex, DEV_MODULE_SIGNER_PUBLIC_KEY_HEX);
});
