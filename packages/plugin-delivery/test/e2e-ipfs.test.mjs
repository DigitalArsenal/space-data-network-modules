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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { MemoryBlockstore } from "blockstore-core/memory";
import { MemoryDatastore } from "datastore-core/memory";

import {
  createBrowserWasiShim,
} from "../node_modules/space-data-module-sdk/src/host/wasiShim.js";
import {
  createJsonHostcallBridge,
} from "../node_modules/space-data-module-sdk/src/host/abi.js";
import {
  encodePluginInvokeRequest,
  decodePluginInvokeResponse,
} from "../node_modules/space-data-module-sdk/src/invoke/codec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../dist/plugin-delivery.wasm");

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

async function decryptEciesEnvelope(envelopeJson, recipientPrivateKey) {
  const env = typeof envelopeJson === "string" ? JSON.parse(envelopeJson) : envelopeJson;
  const ke = env.keyEncryption;
  const ce = env.contentEncryption;

  const ephemeralPub = hexToBytes(ke.ephemeralPublicKeyHex);
  const priv = await crypto.subtle.importKey("pkcs8", concat(PKCS8_HEADER, recipientPrivateKey), "X25519", false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("spki", concat(SPKI_HEADER, ephemeralPub), "X25519", false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));

  const hkdfSalt = fromBase64(ke.hkdfSaltB64);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const wrapKey = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: hkdfSalt,
    info: new TextEncoder().encode("orbpro-key-server-artifact-wrap-v1"),
  }, hkdfKey, 256));

  const wrappedKey = fromBase64(ke.wrappedKeyB64);
  const wrappedTag = fromBase64(ke.wrappedKeyTagB64);
  const wrapCk = await crypto.subtle.importKey("raw", wrapKey, "AES-GCM", false, ["decrypt"]);
  const contentKey = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ke.wrapIvB64) }, wrapCk, concat(wrappedKey, wrappedTag),
  ));

  const ct = fromBase64(ce.ciphertextB64);
  const tag = fromBase64(ce.tagB64);
  const ck = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ce.ivB64) }, ck, concat(ct, tag),
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

function createDeliveryHarness(wasmBytes, contentStore) {
  function dispatch(operation, params) {
    if (operation === "ipfs.cat") {
      let cid = params?.cid ?? "";
      if (!cid && params?.path) cid = params.path.replace(/^\/ipfs\//, "");
      const data = contentStore.get(cid);
      if (!data) throw new Error(`CID not found: ${cid}`);
      return new Uint8Array(data);
    }
    if (operation === "host.runtimeTarget") return "node";
    if (operation === "host.listCapabilities") return ["ipfs"];
    if (operation === "host.hasCapability") return params?.capability === "ipfs";
    if (operation === "host.listOperations") return ["ipfs.cat"];
    if (operation === "clock.now") return Date.now();
    if (operation === "random.bytes") {
      return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
    }
    throw new Error(`Unsupported operation: ${operation}`);
  }

  return async () => {
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasi = createBrowserWasiShim({ args: [], env: {} });
    const importObject = { ...wasi.imports };
    let instance = null;
    const bridge = createJsonHostcallBridge({
      dispatch,
      getMemory: () => instance.exports.memory,
    });
    Object.assign(importObject, bridge.imports);
    instance = await WebAssembly.instantiate(wasmModule, importObject);
    if (instance.exports.memory) wasi.setMemory(instance.exports.memory);
    if (instance.exports._initialize) instance.exports._initialize();

    return {
      invoke({ methodId, inputs }) {
        const reqBytes = encodePluginInvokeRequest({
          methodId,
          inputs: (inputs || []).map((i) => ({ payload: i.payload })),
        });
        const alloc = instance.exports.plugin_alloc;
        const free = instance.exports.plugin_free;
        const invoke = instance.exports.plugin_invoke_stream;
        const inPtr = alloc(reqBytes.length);
        new Uint8Array(instance.exports.memory.buffer, inPtr, reqBytes.length).set(reqBytes);
        const outLenPtr = alloc(4);
        const outPtr = invoke(inPtr, reqBytes.length, outLenPtr);
        free(inPtr, reqBytes.length);
        const outLen = new DataView(instance.exports.memory.buffer).getUint32(outLenPtr, true);
        free(outLenPtr, 4);
        if (!outPtr || outLen === 0) {
          return { statusCode: 1, errorMessage: "invoke returned null", outputs: [] };
        }
        const outBytes = new Uint8Array(instance.exports.memory.buffer, outPtr, outLen).slice();
        free(outPtr, outLen);
        return decodePluginInvokeResponse(outBytes);
      },
    };
  };
}

// ── Check WASM ──────────────────────────────────────────────────────────────

if (!fs.existsSync(WASM_PATH)) {
  console.error(`WASM not found: ${WASM_PATH}\nBuild first: npm run build`);
  process.exit(1);
}

const wasmBytes = fs.readFileSync(WASM_PATH);
console.log(`Loaded plugin-delivery.wasm (${wasmBytes.length} bytes)\n`);

// ── Tests ───────────────────────────────────────────────────────────────────

let helia, heliaUfs, contentStore, createHarness;

await test("start Helia node (in-memory)", async () => {
  helia = await createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    start: false,
  });
  heliaUfs = unixfs(helia);
  contentStore = new Map();
  createHarness = createDeliveryHarness(wasmBytes, contentStore);
});

await test("e2e: deliver_plugin encrypts IPFS artifact, JS decrypts it", async () => {
  // 1. Store artifact in Helia
  const artifact = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(512)),
  ]);
  const cid = await heliaUfs.addBytes(artifact);
  const cidStr = cid.toString();

  // Pre-fetch into sync store
  const chunks = [];
  for await (const chunk of heliaUfs.cat(cid)) chunks.push(chunk);
  const fetched = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { fetched.set(c, off); off += c.length; }
  contentStore.set(cidStr, fetched);

  // 2. Client generates keypair
  const { publicKey, privateKey } = await generateX25519KeyPair();

  // 3. Invoke deliver_plugin
  const harness = await createHarness();
  const result = harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode(cidStr) },
    ],
  });

  assert.ok(result.outputs?.length >= 1, `deliver_plugin failed: ${result.errorMessage}`);
  const envelopeStr = new TextDecoder().decode(result.outputs[0].payload);
  const envelope = JSON.parse(envelopeStr);
  assert.equal(envelope.keyEncryption.scheme, "ecies-x25519-hkdf-sha256-aes-256-gcm");

  // 4. Decrypt with JS WebCrypto
  const decrypted = await decryptEciesEnvelope(envelope, privateKey);
  assert.deepEqual(decrypted, artifact, "decrypted bytes must match original IPFS artifact");
  assert.equal(decrypted[0], 0x00);
  assert.equal(decrypted[1], 0x61);
  assert.equal(decrypted[2], 0x73);
  assert.equal(decrypted[3], 0x6d);
});

await test("e2e: large artifact (64 KB)", async () => {
  const artifact = crypto.getRandomValues(new Uint8Array(65536));
  const cid = await heliaUfs.addBytes(artifact);
  const cidStr = cid.toString();

  const chunks = [];
  for await (const chunk of heliaUfs.cat(cid)) chunks.push(chunk);
  const fetched = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { fetched.set(c, off); off += c.length; }
  contentStore.set(cidStr, fetched);

  const { publicKey, privateKey } = await generateX25519KeyPair();
  const harness = await createHarness();
  const result = harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode(cidStr) },
    ],
  });

  assert.ok(result.outputs?.length >= 1, `failed: ${result.errorMessage}`);
  const decrypted = await decryptEciesEnvelope(
    new TextDecoder().decode(result.outputs[0].payload), privateKey,
  );
  assert.deepEqual(decrypted, artifact, "64 KB artifact should round-trip");
});

await test("e2e: different clients get different ciphertexts", async () => {
  const artifact = new TextEncoder().encode("shared secret plugin");
  const cid = await heliaUfs.addBytes(artifact);
  const cidStr = cid.toString();
  const chunks = [];
  for await (const chunk of heliaUfs.cat(cid)) chunks.push(chunk);
  const fetched = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { fetched.set(c, off); off += c.length; }
  contentStore.set(cidStr, fetched);

  const client1 = await generateX25519KeyPair();
  const client2 = await generateX25519KeyPair();
  const harness = await createHarness();

  const r1 = harness.invoke({
    methodId: "deliver_plugin",
    inputs: [{ payload: client1.publicKey }, { payload: new TextEncoder().encode(cidStr) }],
  });
  const r2 = harness.invoke({
    methodId: "deliver_plugin",
    inputs: [{ payload: client2.publicKey }, { payload: new TextEncoder().encode(cidStr) }],
  });

  const env1 = new TextDecoder().decode(r1.outputs[0].payload);
  const env2 = new TextDecoder().decode(r2.outputs[0].payload);

  // Envelopes must differ (fresh ephemeral keys each time)
  assert.notEqual(env1, env2, "envelopes for different clients must differ");

  // But both decrypt to the same artifact
  const d1 = await decryptEciesEnvelope(env1, client1.privateKey);
  const d2 = await decryptEciesEnvelope(env2, client2.privateKey);
  assert.deepEqual(d1, artifact);
  assert.deepEqual(d2, artifact);
});

await test("e2e: wrong CID returns error", async () => {
  const { publicKey } = await generateX25519KeyPair();
  const harness = await createHarness();
  const result = harness.invoke({
    methodId: "deliver_plugin",
    inputs: [
      { payload: publicKey },
      { payload: new TextEncoder().encode("bafkreinonexistent") },
    ],
  });

  const hasError = result.statusCode !== 0 || result.errorMessage || !result.outputs?.[0]?.payload?.length;
  assert.ok(hasError, "missing CID should produce an error");
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (helia) await helia.stop();

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
