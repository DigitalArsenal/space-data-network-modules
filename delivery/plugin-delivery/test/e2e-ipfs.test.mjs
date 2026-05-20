#!/usr/bin/env node
/**
 * End-to-end test: plugin-delivery with IPFS (Helia)
 *
 * Full pipeline:
 *   1. Helia stores a test WASM artifact
 *   2. plugin-delivery WASM fetches it via ipfs.cat host bridge
 *   3. Encrypts with ECIES for the client's X25519 public key
 *   4. hd-wallet-wasm decrypts the envelope through the SDK crypto surface
 *   5. Verify decrypted bytes match original
 *
 * Run: node test/e2e-ipfs.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSdkBrowserShimHarness,
} from "./lib/sdkBrowserShimHarness.mjs";
import {
  decodeGrantResponse,
  decryptRecWrappedKmfContentKeyFrame,
} from "../lib/module-delivery-codec.mjs";
import {
  generateX25519Keypair,
} from "space-data-module-sdk/transport";
import {
  aesGcmDecrypt,
  x25519SharedSecret,
} from "space-data-module-sdk/utils/wasm-crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../dist/isomorphic/module.wasm");

// ── WASM ECIES decrypt helpers ──────────────────────────────────────────────

function fromBase64(b64) {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sha256Bytes(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function storeIpfsBytes(contentStore, bytes) {
  const cid = `bafy-source-${Buffer.from(sha256Bytes(bytes)).toString("hex").slice(0, 24)}`;
  contentStore.set(cid, bytes);
  return cid;
}

async function decryptDeliveredBundle(grant, encryptedBundleBytes, recipientPrivateKey) {
  const wrappedContentKey = grant.wrappedContentKey;
  const shared = await x25519SharedSecret(
    recipientPrivateKey,
    wrappedContentKey.ephemeralPublicKey,
  );
  const contentKey = await decryptRecWrappedKmfContentKeyFrame(
    wrappedContentKey.encryptedPayload,
    shared,
    { context: wrappedContentKey.header?.context },
  );

  const contentIv = encryptedBundleBytes.slice(0, 12);
  const ciphertext = encryptedBundleBytes.slice(12, encryptedBundleBytes.length - 16);
  const tag = encryptedBundleBytes.slice(encryptedBundleBytes.length - 16);
  return aesGcmDecrypt(contentKey, ciphertext, tag, contentIv);
}

// ── Test runner ─────────────────────────────────────────────────────────────

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`${PASS}: ${name}`);
  } catch (err) {
    console.error(`${FAIL}: ${name}`);
    console.error(err);
    failures++;
  }
}

// ── WASM + host bridge loader ───────────────────────────────────────────────

function createDeliveryHarness(wasmBytes, contentStore, operationLog) {
  function dispatch(operation, params) {
    operationLog.push(operation);
    if (operation === "ipfs.cat") {
      let cid = params?.cid ?? "";
      if (!cid && params?.path) cid = params.path.replace(/^\/ipfs\//, "");
      const data = contentStore.get(cid);
      if (!data) throw new Error(`CID not found: ${cid}`);
      return new Uint8Array(data);
    }
    if (operation === "ipfs.add") {
      const raw =
        typeof params?.base64 === "string"
          ? fromBase64(params.base64)
          : typeof params?.data === "string"
            ? fromBase64(params.data)
            : null;
      if (!raw) {
        throw new Error("ipfs.add requires base64 payload");
      }
      const cidStr = `bafy-encrypted-${Buffer.from(sha256Bytes(raw)).toString("hex").slice(0, 24)}`;
      contentStore.set(cidStr, raw);
      return { Hash: cidStr, Size: raw.length };
    }
    if (operation === "host.runtimeTarget") return "node";
    if (operation === "host.listCapabilities") return ["ipfs"];
    if (operation === "host.hasCapability") return params?.capability === "ipfs";
    if (operation === "host.listOperations") return ["ipfs.cat", "ipfs.add"];
    if (operation === "clock.now") return Date.now();
    if (operation === "random.bytes") {
      return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
    }
    throw new Error(`Unsupported operation: ${operation}`);
  }

  return () =>
    createSdkBrowserShimHarness({
      wasmSource: wasmBytes,
      dispatch,
      surface: "direct",
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
    });
}

// ── Check WASM ──────────────────────────────────────────────────────────────

if (!fs.existsSync(WASM_PATH)) {
  console.error(`WASM not found: ${WASM_PATH}\nBuild first: npm run build`);
  process.exit(1);
}

const wasmBytes = fs.readFileSync(WASM_PATH);
console.log(`Loaded plugin-delivery module.wasm (${wasmBytes.length} bytes)\n`);

// ── Tests ───────────────────────────────────────────────────────────────────

let contentStore, createHarness, operationLog;

await test("start in-memory IPFS store", async () => {
  contentStore = new Map();
  operationLog = [];
  createHarness = () => createDeliveryHarness(wasmBytes, contentStore, operationLog)();
});

await test("e2e: deliver_plugin returns GrantResponse metadata and encrypted bundle over IPFS", async () => {
  // 1. Store artifact in Helia
  const artifact = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(512)),
  ]);
  const cidStr = storeIpfsBytes(contentStore, artifact);

  // 2. Client generates keypair
  const { publicKey, privateKey } = await generateX25519Keypair();
  operationLog.length = 0;

  // 3. Invoke deliver_plugin
  const harness = await createHarness();
  const result = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode(cidStr) },
      {
        payload: new TextEncoder().encode(
          JSON.stringify({
            reqId: "req-plugin-delivery-e2e",
            moduleId: "com.orbpro.fastest-path",
            moduleVersion: "1.0.0",
            runtime: "browser",
            abi: "space-data-module-abi",
            entrypoint: "plugin_invoke_stream",
            publicationCid: cidStr,
          }),
        ),
      },
    ],
  });

  assert.ok(result.outputs?.length >= 1, `deliver_plugin failed: ${result.errorMessage}`);
  const grant = decodeGrantResponse(result.outputs[0].payload);
  const encryptedBundleBytes = contentStore.get(grant.bundleDescriptor.cid);
  assert.ok(encryptedBundleBytes, "plugin-delivery should publish an encrypted bundle CID");
  assert.equal(grant.reqId, "req-plugin-delivery-e2e");
  assert.equal(grant.bundleDescriptor.moduleId, "com.orbpro.fastest-path");
  assert.equal(grant.bundleDescriptor.encrypted, true);
  assert.equal(grant.bundleDescriptor.requiredScope, "orbpro:module:use");
  assert.equal(grant.wrappedContentKey.keyMaterialRootType, "REC");
  assert.equal(grant.wrappedContentKey.wrappingAlgorithm, "x25519-hkdf-sha256-aes-256-ctr-rec");
  assert.equal(grant.bundleDescriptor.sizeBytes, encryptedBundleBytes.length);
  assert.deepEqual(grant.bundleDescriptor.contentHash, sha256Bytes(encryptedBundleBytes));

  // 4. Decrypt with hd-wallet-wasm
  const decrypted = await decryptDeliveredBundle(grant, encryptedBundleBytes, privateKey);
  assert.deepEqual(decrypted, artifact, "decrypted bytes must match original IPFS artifact");
  assert.equal(decrypted[0], 0x00);
  assert.equal(decrypted[1], 0x61);
  assert.equal(decrypted[2], 0x73);
  assert.equal(decrypted[3], 0x6d);
  assert.ok(operationLog.includes("ipfs.cat"));
  assert.ok(operationLog.includes("ipfs.add"));
  assert.ok(
    !operationLog.some(
      (operation) =>
        operation.startsWith("http.") ||
        operation.includes("node-info") ||
        operation.includes("orbpro"),
    ),
    "module-delivery publication must stay on IPFS without HTTP/node-info/orbpro broker calls",
  );
});

await test("e2e: large artifact (64 KB)", async () => {
  const artifact = crypto.getRandomValues(new Uint8Array(65536));
  const cidStr = storeIpfsBytes(contentStore, artifact);

  const { publicKey, privateKey } = await generateX25519Keypair();
  operationLog.length = 0;
  const harness = await createHarness();
  const result = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode(cidStr) },
    ],
  });

  assert.ok(result.outputs?.length >= 1, `failed: ${result.errorMessage}`);
  const grant = decodeGrantResponse(result.outputs[0].payload);
  const encryptedBundleBytes = contentStore.get(grant.bundleDescriptor.cid);
  const decrypted = await decryptDeliveredBundle(grant, encryptedBundleBytes, privateKey);
  assert.deepEqual(decrypted, artifact, "64 KB artifact should round-trip");
});

await test("e2e: different clients get different ciphertexts", async () => {
  const artifact = new TextEncoder().encode("shared secret plugin");
  const cidStr = storeIpfsBytes(contentStore, artifact);

  const client1 = await generateX25519Keypair();
  const client2 = await generateX25519Keypair();
  operationLog.length = 0;
  const harness = await createHarness();

  const r1 = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [{ payload: client1.publicKey }, { payload: new TextEncoder().encode(cidStr) }],
  });
  const r2 = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [{ payload: client2.publicKey }, { payload: new TextEncoder().encode(cidStr) }],
  });

  const grant1 = decodeGrantResponse(r1.outputs[0].payload);
  const grant2 = decodeGrantResponse(r2.outputs[0].payload);

  assert.notEqual(
    grant1.bundleDescriptor.cid,
    grant2.bundleDescriptor.cid,
    "different recipients should receive different encrypted bundle CIDs",
  );

  // But both decrypt to the same artifact
  const d1 = await decryptDeliveredBundle(
    grant1,
    contentStore.get(grant1.bundleDescriptor.cid),
    client1.privateKey,
  );
  const d2 = await decryptDeliveredBundle(
    grant2,
    contentStore.get(grant2.bundleDescriptor.cid),
    client2.privateKey,
  );
  assert.deepEqual(d1, artifact);
  assert.deepEqual(d2, artifact);
});

await test("e2e: wrong CID returns error", async () => {
  const { publicKey } = await generateX25519Keypair();
  const harness = await createHarness();
  const result = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode("bafkreinonexistent") },
    ],
  });

  const hasError = result.statusCode !== 0 || result.errorMessage || !result.outputs?.[0]?.payload?.length;
  assert.ok(hasError, "missing CID should produce an error");
});

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
