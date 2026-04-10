import assert from "node:assert/strict";
import fs from "node:fs";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);

function uniqueImportModules(inspection) {
  return Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
}

function readFlatbufferFileIdentifier(bytes) {
  return Buffer.from(bytes.subarray(4, 8)).toString("ascii");
}

function readFlatbufferVectorField(bytes, fieldIndex) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rootTableOffset = view.getUint32(0, true);
  const vtableOffset = rootTableOffset - view.getUint32(rootTableOffset, true);
  const fieldOffsetLocation = vtableOffset + 4 + fieldIndex * 2;
  if (fieldOffsetLocation + 2 > bytes.byteLength) {
    return null;
  }
  const fieldOffset = view.getUint16(fieldOffsetLocation, true);
  if (fieldOffset === 0) {
    return null;
  }
  const fieldLocation = rootTableOffset + fieldOffset;
  const vectorOffset = view.getUint32(fieldLocation, true);
  const vectorLocation = fieldLocation + vectorOffset;
  const vectorLength = view.getUint32(vectorLocation, true);
  return bytes.slice(vectorLocation + 4, vectorLocation + 4 + vectorLength);
}

function makeRuntimeConfig() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  const dek = randomBytes(32);
  return {
    privateKey,
    publicKey,
    dek,
    json: {
      privateKeyHex: privateKey.toString("hex"),
      dekHex: dek.toString("hex"),
      activeKeyVersion: 7,
      expiresAtMs: Date.now() + 60_000,
      challengeTtlMs: 30_000,
      maxClockSkewMs: 5_000,
    },
  };
}

async function configureRuntime(harness, config) {
  const response = await harness.invoke({
    methodId: "configure_runtime",
    inputs: [
      {
        portId: "config",
        payload: textEncoder.encode(JSON.stringify(config.json)),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "status");
  return JSON.parse(textDecoder.decode(response.outputs[0].payload));
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the sdn-abi profile and canonical exports", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = uniqueImportModules(inspection);

  assert.equal(inspection.profile, "sdn-abi");
  assert.deepEqual(importedModuleNames, ["sdn_host", "wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("browser direct surface configures runtime and serves broker protocol responses", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const config = makeRuntimeConfig();
  const status = await configureRuntime(harness, config);
  assert.equal(status.keyVersion, 7);
  assert.equal(status.publicKeyHex, config.publicKey.toString("hex"));
  assert.equal(typeof status.expiresAtMs, "number");
  assert.ok(status.expiresAtMs > Date.now());

  const publicKeyResponse = await harness.invoke({
    methodId: "get_public_key",
    inputs: [],
  });
  assert.equal(publicKeyResponse.statusCode, 0);
  assert.equal(publicKeyResponse.outputs.length, 1);
  assert.equal(publicKeyResponse.outputs[0].portId, "response");
  assert.equal(readFlatbufferFileIdentifier(publicKeyResponse.outputs[0].payload), "OBPK");
  const encodedPublicKey = readFlatbufferVectorField(publicKeyResponse.outputs[0].payload, 0);
  assert.deepEqual(Buffer.from(encodedPublicKey), config.publicKey);

  const challengeResponse = await harness.invoke({
    methodId: "request_challenge",
    inputs: [
      {
        portId: "request",
        payload: textEncoder.encode(JSON.stringify({ keyVersion: 7 })),
      },
    ],
  });
  assert.equal(challengeResponse.statusCode, 0);
  assert.equal(challengeResponse.outputs.length, 1);
  const challenge = JSON.parse(textDecoder.decode(challengeResponse.outputs[0].payload));
  assert.equal(challenge.keyVersion, 7);
  assert.equal(challenge.challengeId.length, 32);
  assert.equal(challenge.challengeToken.length, 64);
  assert.ok(challenge.expiresAtMs > Date.now());

  const rotationResponse = await harness.invoke({
    methodId: "check_key_rotation",
    inputs: [],
  });
  assert.equal(rotationResponse.statusCode, 0);
  const rotationStatus = JSON.parse(textDecoder.decode(rotationResponse.outputs[0].payload));
  assert.equal(rotationStatus.initialized, true);
  assert.equal(rotationStatus.keyVersion, 7);
  assert.equal(rotationStatus.needsRotation, false);
});

test("browser command surface accepts runtime configuration", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const config = makeRuntimeConfig();
  const status = await configureRuntime(harness, config);
  assert.equal(status.keyVersion, 7);
  assert.equal(status.publicKeyHex, config.publicKey.toString("hex"));
});

test("built artifact loads through the WasmEdge server path", async (t) => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  if (inspection.profile === "sdn-abi") {
    t.skip("Raw WasmEdge loading does not provide the sdn_host bridge for sdn-abi artifacts.");
    return;
  }

  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const config = makeRuntimeConfig();
  const response = await harness.invoke({
    methodId: "configure_runtime",
    inputs: [
      {
        portId: "config",
        payload: textEncoder.encode(JSON.stringify(config.json)),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const status = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(status.keyVersion, 7);
});
