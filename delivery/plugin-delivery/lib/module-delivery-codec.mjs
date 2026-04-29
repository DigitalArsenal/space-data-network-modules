import { Builder, ByteBuffer } from "flatbuffers";
import {
  getWasmWallet,
  hkdfBytes as wasmHkdfBytes,
} from "space-data-module-sdk/utils/wasm-crypto";

import {
  ENC,
  KDF,
  KeyExchange,
  LGR,
  PLG,
  SymmetricAlgo,
  licensingGrantMessageType,
} from "../../../../spacedatastandards.org/lib/js/LGR/main.js";
import {
  keyMaterialAlgorithm,
  keyMaterialEncoding,
  keyMaterialRole,
} from "../../../../spacedatastandards.org/lib/js/KMF/main.js";
import { KMF as RecordKMF } from "../../../../spacedatastandards.org/lib/js/REC/KMF.js";
import { REC } from "../../../../spacedatastandards.org/lib/js/REC/REC.js";
import { Record } from "../../../../spacedatastandards.org/lib/js/REC/Record.js";
import { RecordType } from "../../../../spacedatastandards.org/lib/js/REC/RecordType.js";

export const GRANT_RESPONSE_FILE_IDENTIFIER = "$LGR";
export const GRANT_PAYLOAD_CONTEXT = "space-data-network/module-delivery/grant/v1";
const KMF_KEY_BYTES_FIELD_ID = 4;

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array();
}

function cloneBytes(value) {
  return toUint8Array(value).slice();
}

function createByteVector(builder, value, createVector) {
  const bytes = toUint8Array(value);
  return bytes.length > 0 ? createVector.call(null, builder, bytes) : 0;
}

function createString(builder, value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? builder.createString(text) : 0;
}

function numberFromUint64(value) {
  return Number(value ?? 0n);
}

function firstNonEmptyBytes(...values) {
  for (const value of values) {
    const bytes = toUint8Array(value);
    if (bytes.length > 0) {
      return bytes;
    }
  }
  return new Uint8Array();
}

function buildPluginDescriptor(builder, payload = {}) {
  const descriptor = payload.bundleDescriptor ?? {};
  const moduleId = String(descriptor.moduleId ?? payload.moduleId ?? "module");
  const moduleVersion = String(descriptor.moduleVersion ?? payload.moduleVersion ?? "1.0.0");
  const contentHash = firstNonEmptyBytes(
    descriptor.encryptedWasmHash,
    descriptor.encryptedContentHash,
    descriptor.contentHash,
  );
  const wasmHash = firstNonEmptyBytes(descriptor.wasmHash);
  const pluginIdOffset = builder.createString(moduleId);
  const nameOffset = builder.createString(moduleId);
  const versionOffset = builder.createString(moduleVersion);
  const wasmHashOffset = createByteVector(builder, wasmHash, PLG.createWasmHashVector);
  const wasmCidOffset = createString(builder, descriptor.cid);
  const encryptedWasmHashOffset = createByteVector(
    builder,
    contentHash,
    PLG.createEncryptedWasmHashVector,
  );
  const requiredScopeOffset = createString(
    builder,
    descriptor.requiredScope ?? "orbpro:module:use",
  );
  const keyIdOffset = createString(
    builder,
    descriptor.keyId ?? "publication-content",
  );
  const allowedDomain = String(payload.grantedDomain ?? descriptor.allowedDomain ?? "localhost");
  const allowedDomainOffset = createString(builder, allowedDomain);
  const allowedDomainsOffset = allowedDomainOffset
    ? PLG.createAllowedDomainsVector(builder, [allowedDomainOffset])
    : 0;

  PLG.startPLG(builder);
  PLG.addPluginId(builder, pluginIdOffset);
  PLG.addName(builder, nameOffset);
  PLG.addVersion(builder, versionOffset);
  PLG.addWasmHash(builder, wasmHashOffset);
  PLG.addWasmSize(builder, BigInt(Number(descriptor.wasmSize ?? 0)));
  PLG.addWasmCid(builder, wasmCidOffset);
  PLG.addEncryptedWasmHash(builder, encryptedWasmHashOffset);
  PLG.addEncryptedWasmSize(
    builder,
    BigInt(Number(descriptor.sizeBytes ?? descriptor.encryptedWasmSize ?? 0)),
  );
  PLG.addEncrypted(builder, descriptor.encrypted ?? true);
  PLG.addRequiredScope(builder, requiredScopeOffset);
  PLG.addKeyId(builder, keyIdOffset);
  PLG.addAllowedDomains(builder, allowedDomainsOffset);
  PLG.addMaxGrantTimeoutMs(
    builder,
    BigInt(Number(descriptor.maxGrantTimeoutMs ?? payload.grantedTimeoutMs ?? 0)),
  );
  return PLG.endPLG(builder);
}

function buildWrappedContentKeyHeader(builder, wrapped = {}) {
  const header = wrapped.header ?? {};
  const ephemeralPublicKey = firstNonEmptyBytes(
    header.ephemeralPublicKey,
    wrapped.ephemeralPublicKey,
    wrapped.providerEphemeralPublicKey,
  );
  const nonceStart = firstNonEmptyBytes(header.nonceStart, wrapped.nonce, wrapped.iv);
  const recipientKeyId = firstNonEmptyBytes(
    header.recipientKeyId,
    wrapped.recipientKeyIdBytes,
  );
  const schemaHash = firstNonEmptyBytes(header.schemaHash, wrapped.schemaHash);
  const ephemeralPublicKeyOffset = ENC.createEphemeralPublicKeyVector(
    builder,
    ephemeralPublicKey,
  );
  const nonceStartOffset = ENC.createNonceStartVector(builder, nonceStart);
  const recipientKeyIdOffset = createByteVector(
    builder,
    recipientKeyId,
    ENC.createRecipientKeyIdVector,
  );
  const contextOffset = createString(builder, header.context ?? GRANT_PAYLOAD_CONTEXT);
  const schemaHashOffset = createByteVector(
    builder,
    schemaHash,
    ENC.createSchemaHashVector,
  );
  const rootTypeOffset = createString(
    builder,
    header.rootType ?? wrapped.keyMaterialRootType ?? "REC",
  );

  ENC.startENC(builder);
  ENC.addKeyExchange(builder, KeyExchange.X25519);
  ENC.addSymmetric(builder, SymmetricAlgo.AES_256_CTR);
  ENC.addKeyDerivation(builder, KDF.HKDF_SHA256);
  ENC.addEphemeralPublicKey(builder, ephemeralPublicKeyOffset);
  ENC.addNonceStart(builder, nonceStartOffset);
  ENC.addRecipientKeyId(builder, recipientKeyIdOffset);
  ENC.addContext(builder, contextOffset);
  ENC.addSchemaHash(builder, schemaHashOffset);
  ENC.addRootType(builder, rootTypeOffset);
  return ENC.endENC(builder);
}

export function encodeGrantResponse(payload = {}) {
  const builder = new Builder(2048);
  const descriptorOffset = buildPluginDescriptor(builder, payload);
  const wrapped = payload.wrappedContentKey ?? {};
  const wrappedHeaderOffset = buildWrappedContentKeyHeader(builder, wrapped);
  const wrappedPayload = firstNonEmptyBytes(
    wrapped.encryptedPayload,
    wrapped.ciphertext,
  );
  const wrappedPayloadOffset = LGR.createWrappedContentKeyPayloadVector(
    builder,
    wrappedPayload,
  );
  const verifierPublicKeyOffset = createByteVector(
    builder,
    payload.grantVerifierPublicKey,
    LGR.createGrantVerifierPubkeyVector,
  );
  const signatureOffset = createByteVector(
    builder,
    payload.providerSignature ?? payload.grantSignature,
    LGR.createProviderSignatureVector,
  );
  const capabilityTokenOffset = createByteVector(
    builder,
    payload.capabilityToken,
    LGR.createCapabilityTokenVector,
  );
  const requestIdOffset = createString(builder, payload.reqId ?? "deliver_plugin");
  const moduleIdOffset = createString(
    builder,
    payload.moduleId ?? payload.bundleDescriptor?.moduleId ?? "module",
  );
  const moduleVersionOffset = createString(
    builder,
    payload.moduleVersion ?? payload.bundleDescriptor?.moduleVersion,
  );
  const requestedDomainOffset = createString(
    builder,
    payload.requestedDomain ?? payload.grantedDomain,
  );
  const grantedDomainOffset = createString(builder, payload.grantedDomain ?? "localhost");
  const requiredScopeOffset = createString(
    builder,
    payload.requiredScope ?? payload.bundleDescriptor?.requiredScope,
  );
  const grantStatusOffset = createString(
    builder,
    payload.grantStatus ?? payload.entitlementStatus ?? "granted",
  );

  LGR.startLGR(builder);
  LGR.addMessageType(builder, licensingGrantMessageType.Granted);
  LGR.addRequestId(builder, requestIdOffset);
  LGR.addModuleId(builder, moduleIdOffset);
  LGR.addModuleVersion(builder, moduleVersionOffset);
  LGR.addRequestedDomain(builder, requestedDomainOffset);
  LGR.addRequestedTimeoutMs(builder, BigInt(Number(payload.requestedTimeoutMs ?? payload.grantedTimeoutMs ?? 0)));
  LGR.addGrantedDomain(builder, grantedDomainOffset);
  LGR.addGrantedTimeoutMs(builder, BigInt(Number(payload.grantedTimeoutMs ?? 0)));
  LGR.addExpiresAt(builder, BigInt(Number(payload.expiresAtMs ?? 0)));
  LGR.addRequiredScope(builder, requiredScopeOffset);
  LGR.addGrantStatus(builder, grantStatusOffset);
  LGR.addCapabilityToken(builder, capabilityTokenOffset);
  LGR.addModuleDescriptor(builder, descriptorOffset);
  LGR.addWrappedContentKeyHeader(builder, wrappedHeaderOffset);
  LGR.addWrappedContentKeyPayload(builder, wrappedPayloadOffset);
  LGR.addGrantVerifierPubkey(builder, verifierPublicKeyOffset);
  LGR.addProviderSignature(builder, signatureOffset);
  const root = LGR.endLGR(builder);
  LGR.finishLGRBuffer(builder, root);
  return builder.asUint8Array();
}

function decodeDescriptor(descriptor) {
  if (!descriptor) {
    throw new Error("grant response is missing the SDS PLG descriptor");
  }
  const encrypted = descriptor.ENCRYPTED();
  const contentHash = encrypted
    ? cloneBytes(descriptor.encryptedWasmHashArray() ?? descriptor.wasmHashArray())
    : cloneBytes(descriptor.wasmHashArray());
  const sizeBytes = encrypted && descriptor.ENCRYPTED_WASM_SIZE() > 0n
    ? numberFromUint64(descriptor.ENCRYPTED_WASM_SIZE())
    : numberFromUint64(descriptor.WASM_SIZE());
  return {
    cid: descriptor.WASM_CID() ?? "",
    contentHash,
    sizeBytes,
    moduleId: descriptor.PLUGIN_ID() ?? "",
    moduleVersion: descriptor.VERSION() ?? undefined,
    keyId: descriptor.KEY_ID() ?? undefined,
    requiredScope: descriptor.REQUIRED_SCOPE() ?? undefined,
    allowedDomains: Array.from(
      { length: descriptor.allowedDomainsLength?.() ?? 0 },
      (_, index) => descriptor.ALLOWED_DOMAINS(index),
    ).filter(Boolean),
    maxGrantTimeoutMs: numberFromUint64(descriptor.MAX_GRANT_TIMEOUT_MS()),
    encrypted,
  };
}

function decodeWrappedContentKey(header, payload) {
  if (!header) {
    throw new Error("grant response is missing the SDS ENC wrapped key header");
  }
  const encryptedPayload = cloneBytes(payload);
  const providerEphemeralPublicKey = cloneBytes(header.ephemeralPublicKeyArray());
  const nonceStart = cloneBytes(header.nonceStartArray());
  const recipientKeyIdBytes = cloneBytes(header.recipientKeyIdArray());
  return {
    wrappingAlgorithm: "x25519-hkdf-sha256-aes-256-ctr-rec",
    recipientKeyIdBytes,
    providerEphemeralPublicKey,
    ephemeralPublicKey: providerEphemeralPublicKey,
    nonce: nonceStart,
    iv: nonceStart,
    ciphertext: encryptedPayload,
    tag: new Uint8Array(),
    encryptedPayload,
    keyMaterialRootType: header.ROOT_TYPE() ?? "REC",
    header: {
      version: header.VERSION(),
      keyExchange: "X25519",
      symmetric: "AES_256_CTR",
      keyDerivation: "HKDF_SHA256",
      ephemeralPublicKey: providerEphemeralPublicKey,
      nonceStart,
      recipientKeyId: recipientKeyIdBytes,
      context: header.CONTEXT() ?? undefined,
      schemaHash: cloneBytes(header.schemaHashArray()),
      rootType: header.ROOT_TYPE() ?? undefined,
    },
  };
}

export function decodeGrantResponse(messageBytes) {
  const bytes = toUint8Array(messageBytes);
  const bb = new ByteBuffer(bytes);
  if (!LGR.bufferHasIdentifier(bb)) {
    throw new Error("expected $LGR FlatBuffer");
  }
  const grant = LGR.getRootAsLGR(bb);
  const payload = grant.wrappedContentKeyPayloadArray() ?? new Uint8Array();
  return {
    reqId: grant.REQUEST_ID() ?? "",
    moduleId: grant.MODULE_ID() ?? "",
    moduleVersion: grant.MODULE_VERSION() ?? undefined,
    requestedDomain: grant.REQUESTED_DOMAIN() ?? undefined,
    requestedTimeoutMs: numberFromUint64(grant.REQUESTED_TIMEOUT_MS()),
    grantedDomain: grant.GRANTED_DOMAIN() ?? "",
    grantedTimeoutMs: numberFromUint64(grant.GRANTED_TIMEOUT_MS()),
    expiresAtMs: numberFromUint64(grant.EXPIRES_AT()),
    requiredScope: grant.REQUIRED_SCOPE() ?? undefined,
    grantStatus: grant.GRANT_STATUS() ?? undefined,
    capabilityToken: cloneBytes(grant.capabilityTokenArray()),
    grantVerifierPublicKey: cloneBytes(grant.grantVerifierPubkeyArray()),
    providerSignature: cloneBytes(grant.providerSignatureArray()),
    bundleDescriptor: decodeDescriptor(grant.MODULE_DESCRIPTOR()),
    wrappedContentKey: decodeWrappedContentKey(
      grant.WRAPPED_CONTENT_KEY_HEADER(),
      payload,
    ),
  };
}

async function hkdfBytes(inputKeyMaterial, info, outputLength) {
  return wasmHkdfBytes(
    inputKeyMaterial,
    new Uint8Array(),
    info,
    outputLength,
  );
}

async function deriveFlatbufferFieldBytes(
  masterKey,
  label,
  fieldId,
  recordIndex,
  outputLength,
) {
  const info = new Uint8Array(label.length + 6);
  info.set(new TextEncoder().encode(label), 0);
  const offset = label.length;
  info[offset] = (fieldId >> 8) & 0xff;
  info[offset + 1] = fieldId & 0xff;
  info[offset + 2] = (recordIndex >> 24) & 0xff;
  info[offset + 3] = (recordIndex >> 16) & 0xff;
  info[offset + 4] = (recordIndex >> 8) & 0xff;
  info[offset + 5] = recordIndex & 0xff;
  return hkdfBytes(masterKey, info, outputLength);
}

async function cryptFlatbufferVectorInPlace(bytes, payloadKey, fieldId, recordIndex) {
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
  const wallet = await getWasmWallet();
  const encrypted = wallet.aesCtr.encrypt(fieldKey, bytes, fieldIv);
  bytes.set(encrypted);
}

export async function buildRecWrappedKmfContentKeyFrame(
  contentKey,
  sharedSecret,
  options = {},
) {
  const keyBytes = toUint8Array(contentKey);
  const builder = new Builder(256);
  const versionOffset = builder.createString("1.0");
  const keyIdOffset = builder.createString(options.keyId ?? "publication-content");
  const keyBytesOffset = RecordKMF.createKeyBytesVector(builder, keyBytes);
  const kmfOffset = RecordKMF.createKMF(
    builder,
    keyIdOffset,
    options.role ?? keyMaterialRole.PublicationContent,
    options.algorithm ?? keyMaterialAlgorithm.Aes256Gcm,
    keyMaterialEncoding.RawBytes,
    keyBytesOffset,
    options.version ?? 1,
    BigInt(Number(options.expiresAtMs ?? 0)),
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
  const rec = REC.getRootAsREC(new ByteBuffer(encryptedPayload));
  const record = rec.RECORDS(0, new Record());
  const kmf = record?.value(new RecordKMF());
  const keyBytesView = kmf?.keyBytesArray();
  if (!keyBytesView) {
    throw new Error("REC KMF key bytes missing");
  }
  const payloadKey = await hkdfBytes(
    toUint8Array(sharedSecret),
    new TextEncoder().encode(options.context ?? GRANT_PAYLOAD_CONTEXT),
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

export async function decryptRecWrappedKmfContentKeyFrame(
  encryptedPayload,
  sharedSecret,
  options = {},
) {
  const payload = cloneBytes(encryptedPayload);
  const rec = REC.getRootAsREC(new ByteBuffer(payload));
  const record = rec.RECORDS(0, new Record());
  const kmf = record?.value(new RecordKMF());
  const keyBytesView = kmf?.keyBytesArray();
  if (!keyBytesView) {
    throw new Error("REC KMF key bytes missing");
  }
  const payloadKey = await hkdfBytes(
    toUint8Array(sharedSecret),
    new TextEncoder().encode(options.context ?? GRANT_PAYLOAD_CONTEXT),
    32,
  );
  await cryptFlatbufferVectorInPlace(
    keyBytesView,
    payloadKey,
    KMF_KEY_BYTES_FIELD_ID,
    0,
  );
  return keyBytesView.slice();
}
