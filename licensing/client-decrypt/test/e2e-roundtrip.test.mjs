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
 * Also tests hd-wallet-wasm encrypt → C++ WASM decrypt cross-validation.
 *
 * Requires plugin-delivery WASM — set PLUGIN_DELIVERY_WASM env var or
 * have space-data-network-plugin-delivery cloned as a sibling directory.
 *
 * Run: node test/e2e-roundtrip.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";
import {
  generateX25519Keypair,
} from "space-data-module-sdk/transport";
import {
  aesGcmEncrypt,
  hkdfBytes,
  randomBytes,
  x25519SharedSecret,
} from "space-data-module-sdk/utils/wasm-crypto";
import {
  createSdkBrowserShimHarness,
} from "./lib/sdkBrowserShimHarness.mjs";
import {
  decodeGrantResponse,
} from "../../../delivery/plugin-delivery/lib/module-delivery-codec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECRYPT_WASM_PATH = path.resolve(__dirname, "../dist/isomorphic/module.wasm");

// Resolve plugin-delivery WASM
function findDeliveryWasm() {
  if (process.env.PLUGIN_DELIVERY_WASM) return process.env.PLUGIN_DELIVERY_WASM;
  const monorepoIsomorphic = path.resolve(
    __dirname,
    "../../plugin-delivery/dist/isomorphic/module.wasm",
  );
  if (fs.existsSync(monorepoIsomorphic)) return monorepoIsomorphic;
  const monorepoLegacy = path.resolve(__dirname, "../../plugin-delivery/dist/plugin-delivery.wasm");
  if (fs.existsSync(monorepoLegacy)) return monorepoLegacy;
  const sibling = path.resolve(__dirname, "../../space-data-network-plugin-delivery/dist/plugin-delivery.wasm");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}
const DELIVERY_WASM_PATH = findDeliveryWasm();

// ── Inline WASM crypto helpers ──────────────────────────────────────────────

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64) {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function storeIpfsBytes(contentStore, bytes) {
  const cid = `bafy-source-${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
  contentStore.set(cid, bytes);
  return cid;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function generateX25519KeyPair() {
  return generateX25519Keypair();
}

async function encryptArtifact(plaintext, recipientPublicKey, wrapInfo = "orbpro-key-server-artifact-wrap-v1") {
  const ephemeral = await generateX25519KeyPair();
  const shared = await x25519SharedSecret(ephemeral.privateKey, recipientPublicKey);

  const hkdfSalt = await randomBytes(32);
  const wrapKey = await hkdfBytes(
    shared,
    hkdfSalt,
    new TextEncoder().encode(wrapInfo),
    32,
  );

  const contentKey = await randomBytes(32);
  const wrapIV = await randomBytes(12);
  const wrapped = await aesGcmEncrypt(wrapKey, contentKey, wrapIV);

  const contentIV = await randomBytes(12);
  const encrypted = await aesGcmEncrypt(contentKey, plaintext, contentIV);

  return {
    keyEncryption: {
      scheme: "ecies-x25519-hkdf-sha256-aes-256-gcm",
      ephemeralPublicKeyHex: bytesToHex(ephemeral.publicKey),
      hkdfSaltB64: toBase64(hkdfSalt),
      wrapIvB64: toBase64(wrapIV),
      wrappedKeyB64: toBase64(wrapped.ciphertext),
      wrappedKeyTagB64: toBase64(wrapped.tag),
    },
    contentEncryption: {
      algorithm: "aes-256-gcm",
      ivB64: toBase64(contentIV),
      tagB64: toBase64(encrypted.tag),
      ciphertextB64: toBase64(encrypted.ciphertext),
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
  function dispatch(operation, params) {
    if (operation === "ipfs.cat") {
      let cid = params?.cid ?? "";
      if (!cid && params?.path) cid = params.path.replace(/^\/ipfs\//, "");
      const data = contentStore.get(cid);
      if (!data) throw new Error(`CID not found: ${cid}`);
      return new Uint8Array(data);
    }
    if (operation === "ipfs.add") {
      // Copy: hostcall segments are views into wasm guest memory.
      const raw =
        params?.content instanceof Uint8Array
          ? new Uint8Array(params.content)
          : null;
      if (!raw) throw new Error("ipfs.add requires content bytes");
      const cid = `bafy-encrypted-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
      contentStore.set(cid, raw);
      return { Hash: cid, Size: raw.length };
    }
    if (operation === "host.runtimeTarget") return "node";
    if (operation === "host.listCapabilities") return ["ipfs"];
    if (operation === "host.hasCapability") return params?.capability === "ipfs";
    if (operation === "host.listOperations") return ["ipfs.cat", "ipfs.add"];
    if (operation === "clock.now") return Date.now();
    if (operation === "random.bytes") {
      return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
    }
    throw new Error(`Unsupported: ${operation}`);
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

await test("e2e: hd-wallet-wasm encrypt → C++ WASM decrypt (orbpro info)", async () => {
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

await test("e2e: hd-wallet-wasm encrypt → C++ WASM decrypt (plugin info)", async () => {
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
  let contentStore;

  await test("start in-memory IPFS store", async () => {
    contentStore = new Map();
  });

  await test("e2e: plugin-delivery encrypts → client-decrypt decrypts (IPFS round-trip)", async () => {
    const artifact = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...crypto.getRandomValues(new Uint8Array(512)),
    ]);

    const cidStr = storeIpfsBytes(contentStore, artifact);

    const deliveryWasm = fs.readFileSync(DELIVERY_WASM_PATH);
    const deliveryHarness = await createDeliveryHarness(deliveryWasm, contentStore)();
    const crossPluginDecryptHarness = await createDeliveryHarness(decryptWasm, contentStore)();

    const { publicKey, privateKey } = await generateX25519KeyPair();

    // Server encrypts
    const deliverResult = await deliveryHarness.invoke({
      methodId: "deliver_plugin",
      inputs: [
        { payload: publicKey },
        { payload: new TextEncoder().encode(cidStr) },
        {
          payload: new TextEncoder().encode(
            JSON.stringify({
              reqId: "req-cross-plugin",
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
    assert.ok(deliverResult.outputs?.length >= 1, `deliver failed: ${deliverResult.errorMessage}`);
    const grant = decodeGrantResponse(deliverResult.outputs[0].payload);
    assert.equal(grant.bundleDescriptor.moduleId, "com.orbpro.fastest-path");
    assert.equal(grant.bundleDescriptor.encrypted, true);
    assert.ok(contentStore.has(grant.bundleDescriptor.cid));

    // Client decrypts (C++ → C++)
    try {
      const decryptResult = await crossPluginDecryptHarness.invoke({
        methodId: "decrypt_artifact",
        inputs: [
          { payload: deliverResult.outputs[0].payload },
          { payload: privateKey },
        ],
      });
      assert.ok(decryptResult.outputs?.length >= 1);
      assert.deepEqual(
        decryptResult.outputs[0].payload,
        artifact,
        "C++ decrypt of C++ encrypted IPFS artifact must match original",
      );
    } finally {
      await crossPluginDecryptHarness.destroy();
    }
  });

  await test("e2e: large artifact cross-plugin (64 KB)", async () => {
    const artifact = crypto.getRandomValues(new Uint8Array(65536));
    const cidStr = storeIpfsBytes(contentStore, artifact);

    const deliveryWasm = fs.readFileSync(DELIVERY_WASM_PATH);
    const deliveryHarness = await createDeliveryHarness(deliveryWasm, contentStore)();
    const crossPluginDecryptHarness = await createDeliveryHarness(decryptWasm, contentStore)();
    const { publicKey, privateKey } = await generateX25519KeyPair();

    const dr = await deliveryHarness.invoke({
      methodId: "deliver_plugin",
      inputs: [{ payload: publicKey }, { payload: new TextEncoder().encode(cidStr) }],
    });
    assert.ok(dr.outputs?.length >= 1, `failed: ${dr.errorMessage}`);

    try {
      const cr = await crossPluginDecryptHarness.invoke({
        methodId: "decrypt_artifact",
        inputs: [{ payload: dr.outputs[0].payload }, { payload: privateKey }],
      });
      assert.deepEqual(cr.outputs[0].payload, artifact, "64 KB cross-plugin round-trip");
    } finally {
      await crossPluginDecryptHarness.destroy();
    }
  });

}

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (decryptHarness?.destroy) await decryptHarness.destroy();

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
