import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { Builder } from "flatbuffers";
import clientDecrypt, {
  createClientDecrypt,
  isomorphicWasmPath,
} from "../index.js";
import {
  KMF,
  keyMaterialAlgorithm,
  keyMaterialEncoding,
  keyMaterialRole,
} from "../../../../spacedatastandards.org/lib/js/KMF/main.js";
import {
  buildRecWrappedKmfContentKeyFrame,
  encodeGrantResponse,
} from "../../../delivery/plugin-delivery/lib/module-delivery-codec.mjs";
import {
  encryptBytesForRecipient,
  generateX25519Keypair,
} from "space-data-module-sdk/transport";
import {
  aesGcmEncrypt,
  randomBytes,
  x25519SharedSecret,
} from "space-data-module-sdk/utils/wasm-crypto";
import {
  encryptBytesForRecipient as encryptBytesForRecipientFromWorkspace,
} from "../../../../space-data-module-sdk/src/transport/index.js";

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

function fromBase64(base64Text) {
  return Uint8Array.from(Buffer.from(base64Text, "base64"));
}

function buildRawKmfContentKeyFrame(keyBytes) {
  const builder = new Builder(128 + keyBytes.length);
  const keyIdOffset = builder.createString("test-protected-publication-key");
  const keyBytesOffset = KMF.createKeyBytesVector(builder, keyBytes);
  const root = KMF.createKMF(
    builder,
    keyIdOffset,
    keyMaterialRole.DecryptKey,
    keyMaterialAlgorithm.X25519Private,
    keyMaterialEncoding.RawBytes,
    keyBytesOffset,
    0,
    0n,
  );
  KMF.finishKMFBuffer(builder, root);
  return builder.asUint8Array();
}

async function generateX25519KeyPair() {
  return generateX25519Keypair();
}

async function buildGrantResponseFixture(plaintext, recipientPublicKey) {
  const ephemeral = await generateX25519KeyPair();
  const contentKey = await randomBytes(32);
  const contentIv = await randomBytes(12);
  const encryptedContent = await aesGcmEncrypt(
    contentKey,
    plaintext,
    contentIv,
  );
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

async function buildProtectedPublicationGrantResponseFixture(
  plaintext,
  recipientPublicKey,
  options = {},
) {
  const {
    context = "orbpro.plugin/com.orbpro.client-decrypt-protected",
    encrypt = encryptBytesForRecipient,
    wrapContentKeyAsRawKmf = false,
    wrapContentKeyAsRecKmf = false,
  } = options;
  const ephemeral = await generateX25519KeyPair();
  const publicationRecipient = await generateX25519KeyPair();
  const contentKey = publicationRecipient.privateKey;
  const protectedEnvelope = await encrypt({
    plaintext,
    recipientPublicKey: publicationRecipient.publicKey,
    context,
  });
  const encryptedBundleBytes = fromBase64(protectedEnvelope.protectedBlobBase64);

  const sharedSecret = await x25519SharedSecret(
    ephemeral.privateKey,
    recipientPublicKey,
  );
  const wrapIv = await randomBytes(12);
  const wrappedKey = wrapContentKeyAsRawKmf
    ? buildRawKmfContentKeyFrame(contentKey)
    : await buildRecWrappedKmfContentKeyFrame(contentKey, sharedSecret);
  const bundleHash = sha256Bytes(encryptedBundleBytes);
  const bundleCid = `bafy-protected-${Buffer.from(bundleHash).toString("hex").slice(0, 24)}`;

  return {
    bundleCid,
    encryptedBundleBytes,
    grantResponseBytes: encodeGrantResponse({
      reqId: "req-client-decrypt-protected-publication",
      grantedDomain: "localhost",
      grantedTimeoutMs: 30000,
      expiresAtMs: 60000,
      grantVerifierPublicKey: recipientPublicKey,
      bundleDescriptor: {
        cid: bundleCid,
        contentHash: bundleHash,
        sizeBytes: encryptedBundleBytes.length,
        moduleId: "com.orbpro.client-decrypt-protected",
        moduleVersion: "1.0.0",
        runtime: "browser",
        abi: "sdn-abi",
        entrypoint: "plugin_invoke_stream",
        publicationCid: "bafy-publication-protected",
        contentCodec: "application/wasm+encrypted",
        encryptionCodec: "x25519-hkdf-sha256-aes-256-ctr-rec",
      },
      wrappedContentKey: {
        wrappingAlgorithm: "x25519-hkdf-sha256-aes-256-ctr-rec",
        recipientPublicKey,
        ephemeralPublicKey: ephemeral.publicKey,
        nonce: wrapIv,
        ciphertext: wrappedKey,
        tag: new Uint8Array(),
        keyMaterialRootType: wrapContentKeyAsRawKmf ? "KMF" : "REC",
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

test("package entrypoint decrypts SDK protected publication bundles", async (t) => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(160)),
  ]);
  const fixture = await buildProtectedPublicationGrantResponseFixture(plaintext, publicKey);
  assert.deepEqual(Array.from(fixture.encryptedBundleBytes.slice(-4)), [36, 82, 69, 67]);

  const decryptor = await createClientDecrypt({
    dispatch(operation) {
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
});

test("package entrypoint decrypts protected publication bundles created with current SDS schemas", async (t) => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      SensorVolumeVS: "#version 300 es\nvoid main() {}",
    }),
  );
  const fixture = await buildProtectedPublicationGrantResponseFixture(
    plaintext,
    publicKey,
    {
      context: "orbpro.plugin/com.orbpro.sensor-shaders/glsl-bundle",
      encrypt: encryptBytesForRecipientFromWorkspace,
    },
  );
  assert.deepEqual(Array.from(fixture.encryptedBundleBytes.slice(-4)), [36, 82, 69, 67]);

  const decryptor = await createClientDecrypt({
    dispatch(operation) {
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
});

test("package entrypoint rejects protected publications with raw KMF grant keys", async (t) => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(192)),
  ]);
  const fixture = await buildProtectedPublicationGrantResponseFixture(
    plaintext,
    publicKey,
    {
      wrapContentKeyAsRawKmf: true,
    },
  );

  const decryptor = await createClientDecrypt({
    dispatch(operation) {
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

  await assert.rejects(
    () =>
      decryptor.decryptArtifact({
        payload: fixture.grantResponseBytes,
        privateKey,
        encryptedBundleBytes: fixture.encryptedBundleBytes,
      }),
    /REC payload is invalid|wrapped content key/i,
  );
});

test("package entrypoint decrypts protected publications with SDK REC-wrapped KMF grant keys", async (t) => {
  const { publicKey, privateKey } = await generateX25519KeyPair();
  const plaintext = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...crypto.getRandomValues(new Uint8Array(224)),
  ]);
  const fixture = await buildProtectedPublicationGrantResponseFixture(
    plaintext,
    publicKey,
    {
      wrapContentKeyAsRecKmf: true,
    },
  );

  const decryptor = await createClientDecrypt({
    dispatch(operation) {
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
});
