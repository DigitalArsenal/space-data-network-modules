import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createCipheriv,
  createECDH,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "../../../tests/lib/sdkBrowserShimHarness.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const KEY_SERVER_WASM_PATH = new URL(
  "../../protection-key-server/dist/isomorphic/module.wasm",
  import.meta.url,
);

function uniqueImportModules(inspection) {
  return Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
}

function makeAesGcmPayload(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

function exportEd25519PublicKeyRaw(publicKey) {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return spkiDer.subarray(spkiDer.length - 32);
}

function makeSignedPayload(content) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, content, privateKey);
  const lengthTrailer = Buffer.allocUnsafe(4);
  lengthTrailer.writeUInt32LE(content.length, 0);
  return {
    publicKey: exportEd25519PublicKeyRaw(publicKey),
    signedPayload: Buffer.concat([content, signature, lengthTrailer]),
  };
}

function makeKeyServerConfig() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  const dek = randomBytes(32);
  return {
    dek,
    json: {
      privateKeyHex: privateKey.toString("hex"),
      dekHex: dek.toString("hex"),
      activeKeyVersion: 9,
      expiresAtMs: Date.now() + 60_000,
      challengeTtlMs: 30_000,
      maxClockSkewMs: 5_000,
    },
  };
}

function createDefaultHostDispatch() {
  return (operation, params) => {
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    throw new Error(`Unsupported operation: ${operation}`);
  };
}

function configureKeyServerSync(harness, config) {
  const response = harness.invokeSync({
    methodId: "configure_runtime",
    inputs: [
      {
        portId: "config",
        payload: textEncoder.encode(JSON.stringify(config.json)),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
}

function createProtocolDispatch(keyServerHarness) {
  return (operation, params) => {
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    if (operation !== "protocol.request") {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    const payload = params?.payloadBase64
      ? Buffer.from(params.payloadBase64, "base64")
      : new Uint8Array();

    if (params?.protocolId === "/orbpro/public-key/1.0.0") {
      const response = keyServerHarness.invokeSync({
        methodId: "get_public_key",
        inputs: [],
      });
      return response.outputs[0].payload;
    }
    if (params?.protocolId === "/orbpro/challenge/1.0.0") {
      const response = keyServerHarness.invokeSync({
        methodId: "request_challenge",
        inputs: [{ portId: "request", payload }],
      });
      return response.outputs[0].payload;
    }
    if (params?.protocolId === "/orbpro/key-broker/1.0.0") {
      const response = keyServerHarness.invokeSync({
        methodId: "handle_key_request",
        inputs: [{ portId: "request", payload }],
      });
      return response.outputs[0].payload;
    }

    throw new Error(`Unsupported protocol: ${params?.protocolId}`);
  };
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

test("manifest scopes DEK retrieval to hosted WasmEdge runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  assert.deepEqual(manifest.runtimeTargets, ["wasmedge"]);
  assert.equal(manifest.capabilities.includes("protocol_dial"), true);
});

test("built artifact exposes the module-host-abi profile and canonical exports", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const importedModuleNames = uniqueImportModules(inspection);

  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("browser direct surface decrypts AES-256-GCM payloads", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const plaintext = Buffer.from("license-payload:alpha", "utf8");
  const key = randomBytes(32);
  const ciphertext = makeAesGcmPayload(plaintext, key);
  const response = await harness.invoke({
    methodId: "decrypt",
    inputs: [
      { portId: "ciphertext", payload: ciphertext },
      { portId: "key", payload: key },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "plaintext");
  assert.deepEqual(Buffer.from(response.outputs[0].payload), plaintext);
});

test("browser direct surface verifies appended Ed25519 signatures", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const content = Buffer.from("signed-license-content", "utf8");
  const { publicKey, signedPayload } = makeSignedPayload(content);
  const response = await harness.invoke({
    methodId: "verify",
    inputs: [
      { portId: "signed_content", payload: signedPayload },
      { portId: "public_key", payload: publicKey },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const result = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(result.valid, true);
  assert.equal(result.contentLength, content.length);
});

test("browser direct surface decrypts and verifies protected content", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const content = Buffer.from("combined-decrypt-verify", "utf8");
  const { publicKey, signedPayload } = makeSignedPayload(content);
  const dek = randomBytes(32);
  const protectedContent = makeAesGcmPayload(signedPayload, dek);
  const response = await harness.invoke({
    methodId: "decrypt_and_verify",
    inputs: [
      { portId: "protected_content", payload: protectedContent },
      { portId: "dek", payload: dek },
      { portId: "signer_key", payload: publicKey },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.deepEqual(Buffer.from(response.outputs[0].payload), content);
});

test("direct space_data_module_host harness retrieves the DEK through the local key broker protocol", async (t) => {
  const keyServerHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: KEY_SERVER_WASM_PATH,
    dispatch: createDefaultHostDispatch(),
  });
  t.after(() => {
    keyServerHarness.destroy();
  });

  const keyServerConfig = makeKeyServerConfig();
  configureKeyServerSync(keyServerHarness, keyServerConfig);

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: ISOMORPHIC_WASM_PATH,
    dispatch: createProtocolDispatch(keyServerHarness),
    surface: "direct",
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const response = await clientHarness.invoke({
    methodId: "get_dek",
    inputs: [
      {
        portId: "request",
        payload: textEncoder.encode(JSON.stringify({ target: "ipfs://local-test", keyVersion: 9 })),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const result = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(result.keyVersion, 9);
  assert.deepEqual(Buffer.from(result.dekBase64, "base64"), keyServerConfig.dek);
  assert.ok(result.expiresAtMs > Date.now());
});

test("command space_data_module_host harness retrieves the DEK through the local key broker protocol", async (t) => {
  const keyServerHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: KEY_SERVER_WASM_PATH,
    dispatch: createDefaultHostDispatch(),
  });
  t.after(() => {
    keyServerHarness.destroy();
  });

  const keyServerConfig = makeKeyServerConfig();
  configureKeyServerSync(keyServerHarness, keyServerConfig);

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: ISOMORPHIC_WASM_PATH,
    dispatch: createProtocolDispatch(keyServerHarness),
    surface: "command",
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const response = await clientHarness.invoke({
    methodId: "get_dek",
    inputs: [
      {
        portId: "request",
        payload: textEncoder.encode(JSON.stringify({ target: "ipfs://local-test", keyVersion: 9 })),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const result = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(result.keyVersion, 9);
  assert.deepEqual(Buffer.from(result.dekBase64, "base64"), keyServerConfig.dek);
});
