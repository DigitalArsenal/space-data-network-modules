#!/usr/bin/env node
/**
 * End-to-end test: client-decrypt round-trip with Helia IPFS
 *
 * Full pipeline using both plugin-delivery and client-decrypt WASMs:
 *   1. Helia stores a test artifact
 *   2. plugin-delivery WASM fetches from IPFS and encrypts for client
 *   3. client-decrypt WASM decrypts the envelope
 *   4. Verify decrypted bytes match original
 *
 * Also tests JS WebCrypto encrypt → C++ WASM decrypt cross-validation.
 *
 * Requires plugin-delivery WASM — set PLUGIN_DELIVERY_WASM env var or
 * have space-data-network-plugin-delivery cloned as a sibling directory.
 *
 * Run: node test/e2e-roundtrip.test.mjs
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
  createBrowserModuleHarness,
} from "../node_modules/space-data-module-sdk/src/testing/browserModuleHarness.js";

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
const DECRYPT_WASM_PATH = path.resolve(__dirname, "../dist/client-decrypt.wasm");

// Resolve plugin-delivery WASM
function findDeliveryWasm() {
  if (process.env.PLUGIN_DELIVERY_WASM) return process.env.PLUGIN_DELIVERY_WASM;
  const sibling = path.resolve(__dirname, "../../space-data-network-plugin-delivery/dist/plugin-delivery.wasm");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}
const DELIVERY_WASM_PATH = findDeliveryWasm();

// ── Inline WebCrypto helpers ────────────────────────────────────────────────

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
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

async function encryptArtifact(plaintext, recipientPublicKey, wrapInfo = "orbpro-key-server-artifact-wrap-v1") {
  const ephemeral = await generateX25519KeyPair();
  const priv = await crypto.subtle.importKey("pkcs8", concat(PKCS8_HEADER, ephemeral.privateKey), "X25519", false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("spki", concat(SPKI_HEADER, recipientPublicKey), "X25519", false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));

  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const wrapKey = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: hkdfSalt,
    info: new TextEncoder().encode(wrapInfo),
  }, hkdfKey, 256));

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapIV = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIV },
    await crypto.subtle.importKey("raw", wrapKey, "AES-GCM", false, ["encrypt"]),
    contentKey,
  ));

  const contentIV = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: contentIV },
    await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]),
    plaintext,
  ));

  return {
    keyEncryption: {
      scheme: "ecies-x25519-hkdf-sha256-aes-256-gcm",
      ephemeralPublicKeyHex: bytesToHex(ephemeral.publicKey),
      hkdfSaltB64: toBase64(hkdfSalt),
      wrapIvB64: toBase64(wrapIV),
      wrappedKeyB64: toBase64(wrapped.slice(0, 32)),
      wrappedKeyTagB64: toBase64(wrapped.slice(32)),
    },
    contentEncryption: {
      algorithm: "aes-256-gcm",
      ivB64: toBase64(contentIV),
      tagB64: toBase64(enc.slice(enc.length - 16)),
      ciphertextB64: toBase64(enc.slice(0, enc.length - 16)),
    },
  };
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

// ── Plugin-delivery harness (with IPFS host bridge) ─────────────────────────

function createDeliveryHarness(wasmBytes, contentStore) {
  return async () => {
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
      if (operation === "random.bytes") return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
      throw new Error(`Unsupported: ${operation}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasi = createBrowserWasiShim({ args: [], env: {} });
    const importObject = { ...wasi.imports };
    let instance = null;
    const bridge = createJsonHostcallBridge({ dispatch, getMemory: () => instance.exports.memory });
    Object.assign(importObject, bridge.imports);
    instance = await WebAssembly.instantiate(wasmModule, importObject);
    if (instance.exports.memory) wasi.setMemory(instance.exports.memory);
    if (instance.exports._initialize) instance.exports._initialize();

    return {
      invoke({ methodId, inputs }) {
        const reqBytes = encodePluginInvokeRequest({ methodId, inputs: (inputs || []).map((i) => ({ payload: i.payload })) });
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
        if (!outPtr || outLen === 0) return { statusCode: 1, errorMessage: "null", outputs: [] };
        const outBytes = new Uint8Array(instance.exports.memory.buffer, outPtr, outLen).slice();
        free(outPtr, outLen);
        return decodePluginInvokeResponse(outBytes);
      },
    };
  };
}

// ── Check WASMs ─────────────────────────────────────────────────────────────

if (!fs.existsSync(DECRYPT_WASM_PATH)) {
  console.error(`client-decrypt WASM not found: ${DECRYPT_WASM_PATH}\nBuild first: npm run build`);
  process.exit(1);
}

const decryptWasm = fs.readFileSync(DECRYPT_WASM_PATH);
console.log(`client-decrypt WASM: ${decryptWasm.length} bytes`);

const hasDeliveryWasm = DELIVERY_WASM_PATH && fs.existsSync(DELIVERY_WASM_PATH);
if (hasDeliveryWasm) {
  console.log(`plugin-delivery WASM: ${fs.statSync(DELIVERY_WASM_PATH).size} bytes`);
} else {
  console.log("plugin-delivery WASM not found — skipping cross-plugin tests");
  console.log("Set PLUGIN_DELIVERY_WASM or clone space-data-network-plugin-delivery as sibling");
}
console.log();

// ── Tests ───────────────────────────────────────────────────────────────────

let decryptHarness;

await test("load client-decrypt WASM", async () => {
  decryptHarness = await createBrowserModuleHarness({
    wasmSource: decryptWasm,
    surface: "direct",
  });
  assert.ok(decryptHarness);
});

await test("e2e: JS encrypt → C++ WASM decrypt (orbpro info)", async () => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const artifact = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(256)),
  ]);

  const envelope = await encryptArtifact(artifact, publicKey, "orbpro-key-server-artifact-wrap-v1");
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await decryptHarness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  assert.deepEqual(result.outputs[0].payload, artifact);
});

await test("e2e: JS encrypt → C++ WASM decrypt (plugin info)", async () => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const artifact = crypto.getRandomValues(new Uint8Array(1024));

  const envelope = await encryptArtifact(artifact, publicKey, "plugin-key-server-artifact-wrap-v1");
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await decryptHarness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  assert.deepEqual(result.outputs[0].payload, artifact);
});

// ── Cross-plugin tests (require plugin-delivery WASM) ───────────────────────

if (hasDeliveryWasm) {
  let helia, heliaUfs, contentStore;

  await test("start Helia node (in-memory)", async () => {
    helia = await createHelia({
      blockstore: new MemoryBlockstore(),
      datastore: new MemoryDatastore(),
      start: false,
    });
    heliaUfs = unixfs(helia);
    contentStore = new Map();
  });

  await test("e2e: plugin-delivery encrypts → client-decrypt decrypts (IPFS round-trip)", async () => {
    const artifact = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...crypto.getRandomValues(new Uint8Array(512)),
    ]);

    const cid = await heliaUfs.addBytes(artifact);
    const cidStr = cid.toString();
    const chunks = [];
    for await (const chunk of heliaUfs.cat(cid)) chunks.push(chunk);
    const fetched = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { fetched.set(c, off); off += c.length; }
    contentStore.set(cidStr, fetched);

    const deliveryWasm = fs.readFileSync(DELIVERY_WASM_PATH);
    const deliveryHarness = await createDeliveryHarness(deliveryWasm, contentStore)();

    const { publicKey, privateKey } = await generateX25519KeyPair();

    // Server encrypts
    const deliverResult = deliveryHarness.invoke({
      methodId: "deliver_plugin",
      inputs: [
        { payload: publicKey },
        { payload: new TextEncoder().encode(cidStr) },
      ],
    });
    assert.ok(deliverResult.outputs?.length >= 1, `deliver failed: ${deliverResult.errorMessage}`);

    // Client decrypts (C++ → C++)
    const decryptResult = await decryptHarness.invoke({
      methodId: "decrypt_artifact",
      inputs: [
        { payload: deliverResult.outputs[0].payload },
        { payload: privateKey },
      ],
    });
    assert.ok(decryptResult.outputs?.length >= 1);
    assert.deepEqual(decryptResult.outputs[0].payload, artifact,
      "C++ decrypt of C++ encrypted IPFS artifact must match original");
  });

  await test("e2e: large artifact cross-plugin (64 KB)", async () => {
    const artifact = crypto.getRandomValues(new Uint8Array(65536));
    const cid = await heliaUfs.addBytes(artifact);
    const cidStr = cid.toString();
    const chunks = [];
    for await (const chunk of heliaUfs.cat(cid)) chunks.push(chunk);
    const fetched = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { fetched.set(c, off); off += c.length; }
    contentStore.set(cidStr, fetched);

    const deliveryWasm = fs.readFileSync(DELIVERY_WASM_PATH);
    const deliveryHarness = await createDeliveryHarness(deliveryWasm, contentStore)();
    const { publicKey, privateKey } = await generateX25519KeyPair();

    const dr = deliveryHarness.invoke({
      methodId: "deliver_plugin",
      inputs: [{ payload: publicKey }, { payload: new TextEncoder().encode(cidStr) }],
    });
    assert.ok(dr.outputs?.length >= 1, `failed: ${dr.errorMessage}`);

    const cr = await decryptHarness.invoke({
      methodId: "decrypt_artifact",
      inputs: [{ payload: dr.outputs[0].payload }, { payload: privateKey }],
    });
    assert.deepEqual(cr.outputs[0].payload, artifact, "64 KB cross-plugin round-trip");
  });

  if (helia) await helia.stop();
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (decryptHarness?.destroy) await decryptHarness.destroy();

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
