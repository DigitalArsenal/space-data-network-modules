import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
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
import { KMF as RecordKMF } from "../../../../spacedatastandards.org/lib/js/REC/KMF.js";
import { REC } from "../../../../spacedatastandards.org/lib/js/REC/REC.js";
import { Record } from "../../../../spacedatastandards.org/lib/js/REC/Record.js";
import { RecordType } from "../../../../spacedatastandards.org/lib/js/REC/RecordType.js";
import {
  encodeGrantResponse,
} from "../../../delivery/plugin-delivery/lib/module-delivery-codec.mjs";
import {
  encryptBytesForRecipient,
} from "space-data-module-sdk/transport";
import {
  encryptBytesForRecipient as encryptBytesForRecipientFromWorkspace,
} from "../../../../space-data-module-sdk/src/transport/index.js";

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

const PKCS8_HEADER = hexToBytes("302e020100300506032b656e04220420");
const SPKI_HEADER = hexToBytes("302a300506032b656e032100");
const GRANT_PAYLOAD_CONTEXT = "space-data-network/module-delivery/grant/v1";
const KMF_KEY_BYTES_FIELD_ID = 4;

async function generateX25519KeyPair() {
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKey: spki.slice(12),
    privateKey: pkcs8.slice(16),
  };
}

async function deriveX25519Secret(privateKeyBytes, publicKeyBytes) {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    concat(PKCS8_HEADER, privateKeyBytes),
    "X25519",
    false,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "spki",
    concat(SPKI_HEADER, publicKeyBytes),
    "X25519",
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: publicKey },
      privateKey,
      256,
    ),
  );
}

async function hkdfBytes(inputKeyMaterial, info, outputLength) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    inputKeyMaterial,
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info,
      },
      keyMaterial,
      outputLength * 8,
    ),
  );
}

async function deriveFlatbufferFieldBytes(
  payloadKey,
  label,
  fieldId,
  recordIndex,
  outputLength,
) {
  const labelBytes = new TextEncoder().encode(label);
  const info = new Uint8Array(labelBytes.length + 2 + 4);
  info.set(labelBytes, 0);
  const view = new DataView(info.buffer);
  view.setUint16(labelBytes.length, fieldId, false);
  view.setUint32(labelBytes.length + 2, recordIndex >>> 0, false);
  return hkdfBytes(payloadKey, info, outputLength);
}

async function cryptFlatbufferVectorInPlace(
  bytes,
  payloadKey,
  fieldId,
  recordIndex,
) {
  const fieldKey = await deriveFlatbufferFieldBytes(
    payloadKey,
    "flatbuffers-field",
    fieldId,
    recordIndex,
    32,
  );
  const fieldIv = await deriveFlatbufferFieldBytes(
    payloadKey,
    "flatbuffers-iv",
    fieldId,
    recordIndex,
    16,
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fieldKey,
    "AES-CTR",
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-CTR",
      counter: fieldIv,
      length: 128,
    },
    cryptoKey,
    bytes,
  );
  bytes.set(new Uint8Array(encrypted));
}

async function buildRecWrappedKmfContentKeyFrame(contentKey, sharedSecret) {
  const builder = new Builder(256);
  const versionOffset = builder.createString("1.0.0");
  const keyIdOffset = builder.createString("test-protected-publication-key");
  const keyBytesOffset = RecordKMF.createKeyBytesVector(builder, contentKey);
  const kmfOffset = RecordKMF.createKMF(
    builder,
    keyIdOffset,
    keyMaterialRole.DecryptKey,
    keyMaterialAlgorithm.X25519Private,
    keyMaterialEncoding.RawBytes,
    keyBytesOffset,
    0,
    0n,
  );
  const standardOffset = builder.createString("KMF");
  const recordOffset = Record.createRecord(
    builder,
    RecordType.KMF,
    kmfOffset,
    standardOffset,
  );
  const recordsOffset = REC.createRecordsVector(builder, [recordOffset]);
  const recOffset = REC.createREC(builder, versionOffset, recordsOffset);
  REC.finishRECBuffer(builder, recOffset);

  const encryptedPayload = builder.asUint8Array();
  const rec = REC.getRootAsREC(new flatbuffers.ByteBuffer(encryptedPayload));
  const record = rec.RECORDS(0, new Record());
  const kmf = record?.value(new RecordKMF());
  const keyBytesView = kmf?.keyBytesArray();
  if (!keyBytesView) {
    throw new Error("REC KMF fixture key bytes missing");
  }
  const payloadKey = await hkdfBytes(
    sharedSecret,
    new TextEncoder().encode(GRANT_PAYLOAD_CONTEXT),
    32,
  );
  await cryptFlatbufferVectorInPlace(
    keyBytesView,
    payloadKey,
    KMF_KEY_BYTES_FIELD_ID,
    0,
  );
  return encryptedPayload;
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
  const wrappedContentKeyRaw =
    wrapContentKeyAsRawKmf || wrapContentKeyAsRecKmf
      ? wrapContentKeyAsRecKmf
        ? await buildRecWrappedKmfContentKeyFrame(contentKey, sharedSecret)
        : buildRawKmfContentKeyFrame(contentKey)
      : new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: wrapIv },
            await crypto.subtle.importKey("raw", wrapKey, "AES-GCM", false, ["encrypt"]),
            contentKey,
          ),
        );

  const wrappedKey = wrapContentKeyAsRawKmf || wrapContentKeyAsRecKmf
    ? wrappedContentKeyRaw
    : wrappedContentKeyRaw.slice(0, 32);
  const wrappedTag = wrapContentKeyAsRawKmf || wrapContentKeyAsRecKmf
    ? new Uint8Array()
    : wrappedContentKeyRaw.slice(32);
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
        wrappingAlgorithm: wrapContentKeyAsRecKmf
          ? "x25519-hkdf-sha256-aes-256-ctr-rec"
          : wrapContentKeyAsRawKmf
            ? "ecies-x25519-hkdf-sha256-aes-256-ctr-rec"
            : "ecies-x25519-hkdf-sha256-aes-256-gcm",
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

test("package entrypoint decrypts protected publications with raw KMF grant keys", async (t) => {
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

  const decrypted = await decryptor.decryptArtifact({
    payload: fixture.grantResponseBytes,
    privateKey,
    encryptedBundleBytes: fixture.encryptedBundleBytes,
  });

  assert.deepEqual(decrypted, plaintext);
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
