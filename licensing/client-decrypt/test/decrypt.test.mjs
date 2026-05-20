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

async function generateX25519KeyPair() {
  return generateX25519Keypair();
}

async function encryptArtifact(
  plaintext,
  recipientPublicKey,
  wrapInfo = "orbpro-key-server-artifact-wrap-v1",
) {
  const ephemeral = await generateX25519KeyPair();
  const sharedSecret = await x25519SharedSecret(
    ephemeral.privateKey,
    recipientPublicKey,
  );

  const hkdfSalt = await randomBytes(32);
  const wrapKey = await hkdfBytes(
    sharedSecret,
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
  const ephemeral = await generateX25519KeyPair();
  const contentKey = await randomBytes(32);
  const contentIv = await randomBytes(12);
  const encryptedContent = await aesGcmEncrypt(contentKey, plaintext, contentIv);

  const sharedSecret = await x25519SharedSecret(
    ephemeral.privateKey,
    recipientPublicKey,
  );
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
        wrappingAlgorithm: "x25519-hkdf-sha256-aes-256-ctr-rec",
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
  hkdfBytes,
  randomBytes,
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

await test("decrypt_artifact: round-trip with orbpro info string", async () => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new TextEncoder().encode(
    "hello from standalone decryption test",
  );

  const envelope = await encryptArtifact(
    plaintext,
    publicKey,
    "orbpro-key-server-artifact-wrap-v1",
  );
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await harness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  assert.ok(result.outputs?.length >= 1, "should have at least one output");
  const decrypted = result.outputs[0].payload;
  assert.ok(decrypted instanceof Uint8Array, "output should be Uint8Array");
  assert.deepEqual(
    decrypted,
    plaintext,
    "decrypted bytes should match original plaintext",
  );
});

await test("decrypt_artifact: round-trip with plugin info string", async () => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new TextEncoder().encode(
    "plugin-key-server test payload",
  );

  const envelope = await encryptArtifact(
    plaintext,
    publicKey,
    "plugin-key-server-artifact-wrap-v1",
  );
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await harness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  const decrypted = result.outputs[0].payload;
  assert.deepEqual(decrypted, plaintext);
});

await test("decrypt_artifact: binary WASM-like payload", async () => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(256)),
  ]);

  const envelope = await encryptArtifact(plaintext, publicKey);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await harness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  const decrypted = result.outputs[0].payload;
  assert.deepEqual(
    decrypted,
    plaintext,
    "binary payload should survive ECIES round-trip",
  );
  assert.equal(decrypted[0], 0x00);
  assert.equal(decrypted[1], 0x61);
  assert.equal(decrypted[2], 0x73);
  assert.equal(decrypted[3], 0x6d);
});

await test("decrypt_artifact: wrong private key returns error", async () => {
  const { publicKey } = await generateX25519KeyPair();
  const { privateKey: wrongPrivKey } = await generateX25519KeyPair();
  const plaintext = new TextEncoder().encode("secret");

  const envelope = await encryptArtifact(plaintext, publicKey);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await harness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: wrongPrivKey }],
  });

  const hasError =
    result.status !== 0 ||
    result.errorMessage ||
    !result.outputs?.[0]?.payload?.length;
  assert.ok(hasError, "wrong key should produce an error or empty output");
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
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = crypto.getRandomValues(new Uint8Array(65536));

  const envelope = await encryptArtifact(plaintext, publicKey);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const result = await harness.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: envelopeBytes }, { payload: privateKey }],
  });

  assert.deepEqual(
    result.outputs[0].payload,
    plaintext,
    "64 KB payload should decrypt correctly",
  );
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (harness?.destroy) {
  await harness.destroy();
}

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) {
  process.exit(1);
}
