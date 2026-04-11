#!/usr/bin/env node
/**
 * End-to-end test: plugin-delivery with IPFS (Helia)
 *
 * Full pipeline:
 *   1. Helia stores a test WASM artifact
 *   2. plugin-delivery WASM fetches it via ipfs.cat host bridge
 *   3. Encrypts with ECIES for the client's X25519 public key
 *   4. JS WebCrypto decrypts the envelope
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
} from "../../../../space-data-network/packages/plugin-sdk/src/module-delivery-codec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../dist/isomorphic/module.wasm");

// ── Inline WebCrypto ECIES decrypt ──────────────────────────────────────────

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromBase64(b64) {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

const PKCS8_HEADER = hexToBytes("302e020100300506032b656e04220420");
const SPKI_HEADER = hexToBytes("302a300506032b656e032100");

async function generateX25519KeyPair() {
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: spki.slice(12), privateKey: pkcs8.slice(16) };
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
  const priv = await crypto.subtle.importKey("pkcs8", concat(PKCS8_HEADER, recipientPrivateKey), "X25519", false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey(
    "spki",
    concat(SPKI_HEADER, wrappedContentKey.ephemeralPublicKey),
    "X25519",
    false,
    [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));

  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const wrapKey = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(),
    info: new TextEncoder().encode("orbpro-key-server-artifact-wrap-v1"),
  }, hkdfKey, 256));

  const wrapCk = await crypto.subtle.importKey("raw", wrapKey, "AES-GCM", false, ["decrypt"]);
  const contentKey = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: wrappedContentKey.nonce },
    wrapCk,
    concat(wrappedContentKey.ciphertext, wrappedContentKey.tag),
  ));

  const contentIv = encryptedBundleBytes.slice(0, 12);
  const ciphertext = encryptedBundleBytes.slice(12, encryptedBundleBytes.length - 16);
  const tag = encryptedBundleBytes.slice(encryptedBundleBytes.length - 16);
  const ck = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: contentIv },
    ck,
    concat(ciphertext, tag),
  ));
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
  const { publicKey, privateKey } = await generateX25519KeyPair();
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
            abi: "sdn-abi",
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
  assert.equal(grant.bundleDescriptor.publicationCid, cidStr);
  assert.equal(grant.bundleDescriptor.contentCodec, "application/wasm+encrypted");
  assert.equal(
    grant.bundleDescriptor.encryptionCodec,
    "x25519-hkdf-sha256-aes-256-gcm",
  );
  assert.equal(grant.wrappedContentKey.wrappingAlgorithm, "ecies-x25519-hkdf-sha256-aes-256-gcm");
  assert.equal(grant.bundleDescriptor.sizeBytes, encryptedBundleBytes.length);
  assert.deepEqual(grant.bundleDescriptor.contentHash, sha256Bytes(encryptedBundleBytes));

  // 4. Decrypt with JS WebCrypto
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

  const { publicKey, privateKey } = await generateX25519KeyPair();
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

  const client1 = await generateX25519KeyPair();
  const client2 = await generateX25519KeyPair();
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
  const { publicKey } = await generateX25519KeyPair();
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
