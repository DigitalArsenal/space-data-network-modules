#!/usr/bin/env node
/**
 * Integration test: client-decrypt WASM module (standalone repo)
 *
 * Verifies the C++ Crypto++ ECIES decryption matches the WASM crypto
 * encryption end-to-end via the space-data-module-sdk browser harness.
 *
 * Run: node test/decrypt.test.mjs
 * Prereqs: npm install && npm run build
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../dist/isomorphic/module.wasm");

// ── Inline artifact-crypto fixtures using hd-wallet-wasm via SDK ────────────


function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

async function secp256k1SharedSecretRawX(privateKey, publicKey) {
  const wallet = await getWasmWallet();
  const shared = wallet.curves.secp256k1.ecdh(privateKey, publicKey);
  if (shared.length === 32) return shared;
  const out = new Uint8Array(32);
  out.set(shared, 32 - shared.length);
  return out;
}

async function generateSecp256k1KeyPair() {
  const privateKey = await randomBytes(32);
  return { privateKey, publicKey: await secp256k1PublicKey(privateKey) };
}

async function generateX25519KeyPair() {
  return generateX25519Keypair();
}

function fromBase64(b64) {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function sha256Bytes(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

async function buildGrantResponseFixture(
  plaintext,
  recipientPublicKey,
  metadata = {},
) {
  const keyExchange = metadata.keyExchange ?? "x25519";
  const contentKey = await randomBytes(32);
  const contentIv = await randomBytes(12);
  const encryptedContent = await aesGcmEncrypt(contentKey, plaintext, contentIv);

  let ephemeral;
  let sharedSecret;
  let wrappingAlgorithm;
  if (keyExchange === "secp256k1") {
    const ephPriv = await randomBytes(32);
    ephemeral = { privateKey: ephPriv, publicKey: await secp256k1PublicKey(ephPriv) };
    sharedSecret = await secp256k1SharedSecretRawX(ephPriv, recipientPublicKey);
    wrappingAlgorithm = "secp256k1-hkdf-sha256-aes-256-ctr-rec";
  } else {
    ephemeral = await generateX25519KeyPair();
    sharedSecret = await x25519SharedSecret(ephemeral.privateKey, recipientPublicKey);
    wrappingAlgorithm = "x25519-hkdf-sha256-aes-256-ctr-rec";
  }
  const wrapIv = await randomBytes(12);
  const wrappedContentKeyPayload = await buildRecWrappedKmfContentKeyFrame(
    contentKey,
    sharedSecret,
  );

  const ciphertext = encryptedContent.ciphertext;
  const contentTag = encryptedContent.tag;
  const packedEncryptedBundle = concat(contentIv, ciphertext, contentTag);
  const bundleHash = sha256Bytes(packedEncryptedBundle);
  const bundleCid =
    metadata.bundleCid ??
    `bafy-test-${Buffer.from(bundleHash).toString("hex").slice(0, 24)}`;

  return {
    bundleCid,
    packedEncryptedBundle,
    grantResponseBytes: encodeGrantResponse({
      reqId: metadata.reqId ?? "req-client-decrypt-fixture",
      grantedDomain: metadata.grantedDomain ?? "localhost",
      grantedTimeoutMs: metadata.grantedTimeoutMs ?? 30000,
      expiresAtMs: metadata.expiresAtMs ?? 60000,
      grantVerifierPublicKey: recipientPublicKey,
      bundleDescriptor: {
        cid: bundleCid,
        contentHash: bundleHash,
        sizeBytes: packedEncryptedBundle.length,
        moduleId: metadata.moduleId ?? "com.orbpro.client-decrypt-fixture",
        moduleVersion: metadata.moduleVersion ?? "1.0.0",
        runtime: metadata.runtime ?? "browser",
        abi: metadata.abi ?? "space-data-module-abi",
        entrypoint: metadata.entrypoint ?? "plugin_invoke_stream",
        publicationCid: metadata.publicationCid ?? "bafy-publication-fixture",
        contentCodec: metadata.contentCodec ?? "application/wasm+encrypted",
        encryptionCodec:
          metadata.encryptionCodec ?? "x25519-hkdf-sha256-aes-256-gcm",
      },
      wrappedContentKey: {
        wrappingAlgorithm,
        recipientPublicKey,
        ephemeralPublicKey: ephemeral.publicKey,
        nonce: wrapIv,
        ciphertext: wrappedContentKeyPayload,
        tag: new Uint8Array(),
        keyMaterialRootType: "REC",
      },
    }),
  };
}

// ── Browser harness loader ──────────────────────────────────────────────────

import {
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";
import {
  generateX25519Keypair,
} from "space-data-module-sdk/transport";
import {
  aesGcmEncrypt,
  getWasmWallet,
  hkdfBytes,
  randomBytes,
  secp256k1PublicKey,
  x25519SharedSecret,
} from "space-data-module-sdk/utils/wasm-crypto";
import {
  createSdkBrowserShimHarness,
} from "./lib/sdkBrowserShimHarness.mjs";
import {
  buildRecWrappedKmfContentKeyFrame,
  encodeGrantResponse,
} from "../../../delivery/plugin-delivery/lib/module-delivery-codec.mjs";

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

// ── Check WASM exists ───────────────────────────────────────────────────────

if (!fs.existsSync(WASM_PATH)) {
  console.error(`\nWASM not found: ${WASM_PATH}`);
  console.error("Build it first: npm run build");
  process.exit(1);
}

const wasmBytes = fs.readFileSync(WASM_PATH);
console.log(`Loaded ${path.basename(WASM_PATH)} (${wasmBytes.length} bytes)\n`);

// ── Tests ───────────────────────────────────────────────────────────────────

let harness;

// Decrypt a plaintext through the SDS $LGR grant path (the v1 envelope) using a
// shim harness with the encrypted bundle prefetched (no host IPFS).
async function decryptViaGrant(plaintext, keyExchange = "x25519") {
  const recipient =
    keyExchange === "secp256k1"
      ? await generateSecp256k1KeyPair()
      : await generateX25519KeyPair();
  const fixture = await buildGrantResponseFixture(plaintext, recipient.publicKey, {
    keyExchange,
  });
  const shimHarness = await createSdkBrowserShimHarness({
    wasmSource: wasmBytes,
    surface: "direct",
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    dispatch(operation, params) {
      if (operation === "host.runtimeTarget") return "browser";
      if (operation === "host.listCapabilities") return [];
      if (operation === "host.hasCapability") return false;
      if (operation === "host.listOperations") return [];
      if (operation === "clock.now") return Date.now();
      if (operation === "random.bytes") {
        return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
      }
      throw new Error(`Unsupported operation: ${operation}`);
    },
  });
  try {
    const result = await shimHarness.invoke({
      methodId: "decrypt_artifact",
      inputs: [
        { payload: fixture.grantResponseBytes },
        { payload: recipient.privateKey },
        { payload: fixture.packedEncryptedBundle },
      ],
    });
    return result.outputs?.[0]?.payload ?? null;
  } finally {
    await shimHarness.destroy();
  }
}

await test("load client-decrypt module.wasm via browser harness", async () => {
  harness = await createBrowserModuleHarness({
    wasmSource: wasmBytes,
    surface: "direct",
  });
  assert.ok(harness, "harness should be created");
  assert.ok(
    typeof harness.invoke === "function",
    "harness should expose invoke()",
  );
});

await test("decrypt_artifact: X25519 SDS grant round-trip", async () => {
  const plaintext = new TextEncoder().encode(
    "hello from standalone decryption test",
  );
  const decrypted = await decryptViaGrant(plaintext, "x25519");
  assert.ok(decrypted instanceof Uint8Array, "output should be Uint8Array");
  assert.deepEqual(decrypted, plaintext, "decrypted bytes should match");
});

await test("decrypt_artifact: secp256k1 SDS grant round-trip (unified ECIES)", async () => {
  const plaintext = new TextEncoder().encode(
    "secp256k1 unified-ECIES cross-runtime payload",
  );
  const decrypted = await decryptViaGrant(plaintext, "secp256k1");
  assert.deepEqual(decrypted, plaintext, "secp256k1 grant should decrypt");
});

await test("decrypt_artifact: binary WASM-like payload", async () => {
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(256)),
  ]);
  const decrypted = await decryptViaGrant(plaintext, "x25519");
  assert.deepEqual(decrypted, plaintext, "binary payload should round-trip");
  assert.equal(decrypted[0], 0x00);
  assert.equal(decrypted[3], 0x6d);
});

await test("decrypt_artifact: wrong private key returns error", async () => {
  const plaintext = new TextEncoder().encode("secret");
  const recipient = await generateX25519KeyPair();
  const wrong = await generateX25519KeyPair();
  const fixture = await buildGrantResponseFixture(plaintext, recipient.publicKey, {
    keyExchange: "x25519",
  });
  const shimHarness = await createSdkBrowserShimHarness({
    wasmSource: wasmBytes,
    surface: "direct",
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 4 * 1024 * 1024,
    dispatch(operation, params) {
      if (operation === "host.runtimeTarget") return "browser";
      if (operation === "host.listCapabilities") return [];
      if (operation === "host.hasCapability") return false;
      if (operation === "host.listOperations") return [];
      if (operation === "clock.now") return Date.now();
      if (operation === "random.bytes") {
        return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
      }
      throw new Error(`Unsupported operation: ${operation}`);
    },
  });
  try {
    const result = await shimHarness.invoke({
      methodId: "decrypt_artifact",
      inputs: [
        { payload: fixture.grantResponseBytes },
        { payload: wrong.privateKey },
        { payload: fixture.packedEncryptedBundle },
      ],
    });
    const hasError =
      result.status !== 0 ||
      result.errorMessage ||
      !result.outputs?.[0]?.payload?.length ||
      !arraysEqual(result.outputs[0].payload, plaintext);
    assert.ok(hasError, "wrong key should not recover the plaintext");
  } finally {
    await shimHarness.destroy();
  }
});

await test(
  "decrypt_artifact: consumes module-delivery GrantResponse bytes over IPFS without HTTP",
  async () => {
    const { publicKey, privateKey } = await generateX25519KeyPair();
    const plaintext = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...crypto.getRandomValues(new Uint8Array(192)),
    ]);
    const fixture = await buildGrantResponseFixture(plaintext, publicKey);
    const contentStore = new Map([
      [fixture.bundleCid, fixture.packedEncryptedBundle],
    ]);
    const operations = [];

    const shimHarness = await createSdkBrowserShimHarness({
      wasmSource: wasmBytes,
      surface: "direct",
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
      dispatch(operation, params) {
        operations.push(operation);
        if (operation === "ipfs.cat") {
          const cid = params?.cid ?? "";
          const bytes = contentStore.get(cid);
          if (!bytes) {
            throw new Error(`CID not found: ${cid}`);
          }
          return bytes;
        }
        if (operation === "host.runtimeTarget") return "browser";
        if (operation === "host.listCapabilities") return ["ipfs"];
        if (operation === "host.hasCapability") {
          return params?.capability === "ipfs";
        }
        if (operation === "host.listOperations") return ["ipfs.cat"];
        if (operation === "clock.now") return Date.now();
        if (operation === "random.bytes") {
          return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
        }
        throw new Error(`Unsupported operation: ${operation}`);
      },
    });

    try {
      const result = await shimHarness.invoke({
        methodId: "decrypt_artifact",
        inputs: [
          { payload: fixture.grantResponseBytes },
          { payload: privateKey },
        ],
      });

      assert.deepEqual(
        result.outputs[0].payload,
        plaintext,
        "GrantResponse/IPFS flow should decrypt the packed bundle bytes",
      );
      assert.ok(operations.includes("ipfs.cat"));
      assert.ok(
        !operations.some(
          (operation) =>
            operation.startsWith("http.") ||
            operation.includes("node-info") ||
            operation.includes("orbpro"),
        ),
        "GrantResponse flow must stay on IPFS and not use HTTP/node-info/orbpro broker calls",
      );
    } finally {
      await shimHarness.destroy();
    }
  },
);

await test(
  "decrypt_artifact: accepts prefetched encrypted bundle bytes for awaited browser delivery",
  async () => {
    const { publicKey, privateKey } = await generateX25519KeyPair();
    const plaintext = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...crypto.getRandomValues(new Uint8Array(192)),
    ]);
    const fixture = await buildGrantResponseFixture(plaintext, publicKey);
    const operations = [];

    const shimHarness = await createSdkBrowserShimHarness({
      wasmSource: wasmBytes,
      surface: "direct",
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
      dispatch(operation, params) {
        operations.push(operation);
        if (operation === "host.runtimeTarget") return "browser";
        if (operation === "host.listCapabilities") return [];
        if (operation === "host.hasCapability") return false;
        if (operation === "host.listOperations") return [];
        if (operation === "clock.now") return Date.now();
        if (operation === "random.bytes") {
          return crypto.getRandomValues(new Uint8Array(params?.length ?? 32));
        }
        throw new Error(`Unsupported operation: ${operation}`);
      },
    });

    try {
      const result = await shimHarness.invoke({
        methodId: "decrypt_artifact",
        inputs: [
          { payload: fixture.grantResponseBytes },
          { payload: privateKey },
          { payload: fixture.packedEncryptedBundle },
        ],
      });

      assert.deepEqual(
        result.outputs[0].payload,
        plaintext,
        "GrantResponse/prefetched bundle flow should decrypt without host IPFS access",
      );
      assert.equal(operations.includes("ipfs.cat"), false);
    } finally {
      await shimHarness.destroy();
    }
  },
);

await test("decrypt_artifact: large payload (64 KB)", async () => {
  const plaintext = crypto.getRandomValues(new Uint8Array(65536));
  const decrypted = await decryptViaGrant(plaintext, "x25519");
  assert.deepEqual(decrypted, plaintext, "64 KB payload should decrypt");
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (harness?.destroy) {
  await harness.destroy();
}

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) {
  process.exit(1);
}
