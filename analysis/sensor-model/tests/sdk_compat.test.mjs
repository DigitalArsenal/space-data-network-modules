import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBrowserModuleHarness,
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
  assert.deepEqual(
    manifest.invokeSurfaces,
    ["direct"],
    "sensor-model must expose direct invoke only; command mode would reintroduce stdin/request-byte transport for sensor semantics",
  );
  assert.deepEqual(manifest.runtimeTargets, ["browser"]);

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

test("built artifact exposes the canonical direct invoke surface only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(inspection.profile, "standalone");
  assert.equal(
    inspection.exports.includes("_start"),
    false,
    "sensor-model must not export command-mode _start",
  );
  for (const exportName of [
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

test("built artifact imports shared memory for browser direct invoke", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.deepEqual(
    inspection.imports.filter((entry) => entry.kind === "memory"),
    [{ module: "env", name: "memory", kind: "memory" }],
  );

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  t.after(() => {
    harness.destroy();
  });

  assert.equal(harness.memory.buffer instanceof SharedArrayBuffer, true);
  assert.equal(typeof harness.instance.exports.plugin_invoke_stream, "function");
  await assert.rejects(
    harness.invokeRaw(new Uint8Array([0, 1, 2, 3])),
    /raw direct invoke is disabled/i,
    "sensor-model browser compatibility must disable raw request-byte invoke",
  );
});

test("built artifact carries the dev module signature", async () => {
  const signature = await verifyModuleArtifact(fs.readFileSync(WASM_PATH), {
    trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
    requireSignature: true,
  });
  assert.equal(signature.publicKeyHex, DEV_MODULE_SIGNER_PUBLIC_KEY_HEX);
});
