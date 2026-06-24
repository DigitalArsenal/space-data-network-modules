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

test("manifest declares the sensor coverage analysis contract", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateManifestWithStandards(manifest);
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.equal(manifest.pluginId, "sensor-coverage-analysis");
  assert.deepEqual(manifest.runtimeTargets, ["browser"]);
  assert.deepEqual(
    manifest.invokeSurfaces,
    ["direct"],
    "sensor coverage must expose direct invoke only; command mode would reintroduce a copy-based request path",
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
  const declaredTypes = manifest.methods.flatMap((declaredMethod) =>
    [...declaredMethod.inputPorts, ...declaredMethod.outputPorts].flatMap((port) =>
      port.acceptedTypeSets.flatMap((typeSet) => typeSet.allowedTypes),
    ),
  );
  assert.equal(
    declaredTypes.every(
      (typeRef) =>
        typeRef.schemaName === "SCV/main.fbs" &&
        typeRef.fileIdentifier === "$SCV" &&
        typeRef.rootTypeName === "SCV" &&
        typeRef.wireFormat === "flatbuffer",
    ),
    true,
    "sensor coverage must advertise only canonical SDS SCV FlatBuffer ports",
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

test("built artifact exposes the canonical direct invoke surface only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(inspection.profile, "standalone");
  assert.equal(inspection.exports.includes("_start"), false);
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("compute_sensor_coverage"));
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
    "sensor coverage browser compatibility must disable raw request-byte invoke",
  );
});

test("built artifact carries a trusted SDS module signature", async () => {
  const signature = await verifyModuleArtifact(fs.readFileSync(WASM_PATH), {
    trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
    requireSignature: true,
  });
  assert.equal(signature.publicKeyHex, DEV_MODULE_SIGNER_PUBLIC_KEY_HEX);
});
