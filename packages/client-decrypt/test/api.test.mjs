import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import clientDecrypt, {
  createClientDecrypt,
  isomorphicWasmPath,
} from "../index.js";
import {
  encodeGrantResponse,
} from "../../plugin-delivery/lib/module-delivery-codec.mjs";

function hexToBytes(hex) {
  const normalized = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concat(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function sha256Bytes(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

const PKCS8_HEADER = hexToBytes("302e020100300506032b656e04220420");
const SPKI_HEADER = hexToBytes("302a300506032b656e032100");

async function generateX25519KeyPair() {
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKey: spki.slice(12),
    privateKey: pkcs8.slice(16),
  };
}

async function buildGrantResponseFixture(plaintext, recipientPublicKey) {
  const ephemeral = await generateX25519KeyPair();
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedContent = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: contentIv },
      await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]),
      plaintext,
    ),
  );

  const ephemeralPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    concat(PKCS8_HEADER, ephemeral.privateKey),
    "X25519",
    false,
    ["deriveBits"],
  );
  const recipientPublicCryptoKey = await crypto.subtle.importKey(
    "spki",
    concat(SPKI_HEADER, recipientPublicKey),
    "X25519",
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: recipientPublicCryptoKey },
      ephemeralPrivateKey,
      256,
    ),
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const wrapKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("space-data-network/module-delivery/wrap/v1"),
      },
      hkdfKey,
      256,
    ),
  );
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedContentKeyRaw = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wrapIv },
      await crypto.subtle.importKey("raw", wrapKey, "AES-GCM", false, ["encrypt"]),
      contentKey,
    ),
  );

  const ciphertext = encryptedContent.slice(0, encryptedContent.length - 16);
  const contentTag = encryptedContent.slice(encryptedContent.length - 16);
  const wrappedKey = wrappedContentKeyRaw.slice(0, 32);
  const wrappedTag = wrappedContentKeyRaw.slice(32);
  const encryptedBundleBytes = concat(contentIv, ciphertext, contentTag);
  const bundleHash = sha256Bytes(encryptedBundleBytes);
  const bundleCid = `bafy-api-${Buffer.from(bundleHash).toString("hex").slice(0, 24)}`;

  return {
    bundleCid,
    encryptedBundleBytes,
    grantResponseBytes: encodeGrantResponse({
      reqId: "req-client-decrypt-api",
      grantedDomain: "localhost",
      grantedTimeoutMs: 30000,
      expiresAtMs: 60000,
      grantVerifierPublicKey: recipientPublicKey,
      bundleDescriptor: {
        cid: bundleCid,
        contentHash: bundleHash,
        sizeBytes: encryptedBundleBytes.length,
        moduleId: "com.orbpro.fastest-path",
        moduleVersion: "1.0.0",
        runtime: "browser",
        abi: "sdn-abi",
        entrypoint: "plugin_invoke_stream",
        publicationCid: "bafy-publication-api",
        contentCodec: "application/wasm+encrypted",
        encryptionCodec: "x25519-hkdf-sha256-aes-256-gcm",
      },
      wrappedContentKey: {
        wrappingAlgorithm: "ecies-x25519-hkdf-sha256-aes-256-gcm",
        recipientPublicKey,
        ephemeralPublicKey: ephemeral.publicKey,
        nonce: wrapIv,
        ciphertext: wrappedKey,
        tag: wrappedTag,
      },
    }),
  };
}

test("package entrypoint exposes the awaited client-decrypt API", async (t) => {
  assert.equal(typeof createClientDecrypt, "function");
  assert.equal(clientDecrypt.createClientDecrypt, createClientDecrypt);
  assert.equal(clientDecrypt.isomorphicWasmPath.href, isomorphicWasmPath.href);

  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(96)),
  ]);
  const fixture = await buildGrantResponseFixture(plaintext, publicKey);
  const contentStore = new Map([[fixture.bundleCid, fixture.encryptedBundleBytes]]);

  const decryptor = await createClientDecrypt({
    dispatch(operation, params) {
      if (operation === "ipfs.cat") {
        const cid = params?.cid ?? "";
        const bytes = contentStore.get(cid);
        if (!bytes) {
          throw new Error(`CID not found: ${cid}`);
        }
        return bytes;
      }
      if (operation === "host.runtimeTarget") return "node";
      if (operation === "host.listCapabilities") return ["ipfs"];
      if (operation === "host.hasCapability") return params?.capability === "ipfs";
      if (operation === "host.listOperations") return ["ipfs.cat"];
      throw new Error(`Unsupported operation: ${operation}`);
    },
  });
  t.after(async () => {
    await decryptor.destroy();
  });

  const decrypted = await decryptor.decryptArtifact(fixture.grantResponseBytes, privateKey);
  assert.deepEqual(decrypted, plaintext);
});

test("package entrypoint avoids literal node: imports so browser bundlers can parse it", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

  assert.equal(source.includes("node:"), false);
});

test("package entrypoint accepts prefetched encrypted bundle bytes for awaited browser delivery", async (t) => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(128)),
  ]);
  const fixture = await buildGrantResponseFixture(plaintext, publicKey);
  const operations = [];

  const decryptor = await createClientDecrypt({
    dispatch(operation) {
      operations.push(operation);
      if (operation === "host.runtimeTarget") return "node";
      if (operation === "host.listCapabilities") return [];
      if (operation === "host.hasCapability") return false;
      if (operation === "host.listOperations") return [];
      throw new Error(`Unsupported operation: ${operation}`);
    },
  });
  t.after(async () => {
    await decryptor.destroy();
  });

  const decrypted = await decryptor.decryptArtifact({
    payload: fixture.grantResponseBytes,
    privateKey,
    encryptedBundleBytes: fixture.encryptedBundleBytes,
  });

  assert.deepEqual(decrypted, plaintext);
  assert.equal(operations.includes("ipfs.cat"), false);
});
