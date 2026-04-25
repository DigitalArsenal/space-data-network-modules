import { Builder, ByteBuffer } from "flatbuffers";

const GRANT_RESPONSE_FILE_IDENTIFIER = "SDGS";

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array();
}

function createByteVector(builder, value) {
  const bytes = toUint8Array(value);
  return bytes.length > 0 ? builder.createByteVector(bytes) : 0;
}

function createString(builder, value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? builder.createString(text) : 0;
}

function addUint64Field(builder, slot, value) {
  const numeric = Number(value);
  builder.addFieldInt64(
    slot,
    BigInt(Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0),
    BigInt(0),
  );
}

function createBundleDescriptor(builder, descriptor = {}) {
  const cidOffset = createString(builder, descriptor.cid);
  const contentHashOffset = createByteVector(builder, descriptor.contentHash);
  const moduleIdOffset = createString(builder, descriptor.moduleId);
  const moduleVersionOffset = createString(builder, descriptor.moduleVersion);
  const runtimeOffset = createString(builder, descriptor.runtime);
  const abiOffset = createString(builder, descriptor.abi);
  const entrypointOffset = createString(builder, descriptor.entrypoint);
  const publicationCidOffset = createString(builder, descriptor.publicationCid);
  const contentCodecOffset = createString(builder, descriptor.contentCodec);
  const encryptionCodecOffset = createString(builder, descriptor.encryptionCodec);

  builder.startObject(12);
  builder.addFieldInt32(0, 1, 1);
  builder.addFieldOffset(1, cidOffset, 0);
  builder.addFieldOffset(2, contentHashOffset, 0);
  addUint64Field(builder, 3, descriptor.sizeBytes);
  builder.addFieldOffset(4, moduleIdOffset, 0);
  builder.addFieldOffset(5, moduleVersionOffset, 0);
  builder.addFieldOffset(6, runtimeOffset, 0);
  builder.addFieldOffset(7, abiOffset, 0);
  builder.addFieldOffset(8, entrypointOffset, 0);
  builder.addFieldOffset(9, publicationCidOffset, 0);
  builder.addFieldOffset(10, contentCodecOffset, 0);
  builder.addFieldOffset(11, encryptionCodecOffset, 0);
  return builder.endObject();
}

function createWrappedContentKey(builder, wrapped = {}) {
  const wrappingAlgorithmOffset = createString(builder, wrapped.wrappingAlgorithm);
  const recipientKeyIdOffset = createString(builder, wrapped.recipientKeyId);
  const recipientPublicKeyOffset = createByteVector(builder, wrapped.recipientPublicKey);
  const ephemeralPublicKeyOffset = createByteVector(
    builder,
    wrapped.ephemeralPublicKey || wrapped.providerEphemeralPublicKey,
  );
  const nonceOffset = createByteVector(builder, wrapped.nonce || wrapped.iv);
  const ciphertextOffset = createByteVector(builder, wrapped.ciphertext);
  const tagOffset = createByteVector(builder, wrapped.tag);

  builder.startObject(8);
  builder.addFieldInt32(0, 1, 1);
  builder.addFieldOffset(1, wrappingAlgorithmOffset, 0);
  builder.addFieldOffset(2, recipientKeyIdOffset, 0);
  builder.addFieldOffset(3, recipientPublicKeyOffset, 0);
  builder.addFieldOffset(4, ephemeralPublicKeyOffset, 0);
  builder.addFieldOffset(5, nonceOffset, 0);
  builder.addFieldOffset(6, ciphertextOffset, 0);
  builder.addFieldOffset(7, tagOffset, 0);
  return builder.endObject();
}

export function encodeGrantResponse(payload = {}) {
  const builder = new Builder(1024);
  const bundleDescriptorOffset = createBundleDescriptor(builder, payload.bundleDescriptor);
  const wrappedContentKeyOffset = createWrappedContentKey(builder, payload.wrappedContentKey);
  const reqIdOffset = createString(builder, payload.reqId);
  const entitlementStatusOffset = createString(
    builder,
    payload.entitlementStatus || payload.grantStatus || "granted",
  );
  const capabilityTokenOffset = createString(builder, payload.capabilityToken);
  const grantedDomainOffset = createString(builder, payload.grantedDomain);
  const grantSignatureOffset = createByteVector(builder, payload.grantSignature);
  const verifierPublicKeyOffset = createByteVector(builder, payload.grantVerifierPublicKey);

  builder.startObject(11);
  builder.addFieldInt32(0, 1, 1);
  builder.addFieldOffset(1, reqIdOffset, 0);
  builder.addFieldOffset(2, entitlementStatusOffset, 0);
  builder.addFieldOffset(3, capabilityTokenOffset, 0);
  addUint64Field(builder, 4, payload.expiresAtMs);
  builder.addFieldOffset(5, grantedDomainOffset, 0);
  addUint64Field(builder, 6, payload.grantedTimeoutMs);
  builder.addFieldOffset(7, grantSignatureOffset, 0);
  builder.addFieldOffset(8, verifierPublicKeyOffset, 0);
  builder.addFieldOffset(9, bundleDescriptorOffset, 0);
  builder.addFieldOffset(10, wrappedContentKeyOffset, 0);
  const root = builder.endObject();
  builder.finish(root, GRANT_RESPONSE_FILE_IDENTIFIER);
  return builder.asUint8Array();
}

function getRootTable(bytes, identifier) {
  const buffer = toUint8Array(bytes);
  const bb = new ByteBuffer(buffer);
  if (!bb.__has_identifier(identifier)) {
    throw new Error(`expected ${identifier} FlatBuffer`);
  }
  return { bb, pos: bb.readInt32(bb.position()) + bb.position() };
}

function tableField(table, vtableOffset) {
  const offset = table.bb.__offset(table.pos, vtableOffset);
  return offset ? { bb: table.bb, pos: table.bb.__indirect(table.pos + offset) } : null;
}

function stringField(table, vtableOffset) {
  const offset = table.bb.__offset(table.pos, vtableOffset);
  return offset ? table.bb.__string(table.pos + offset) : undefined;
}

function bytesField(table, vtableOffset) {
  const offset = table.bb.__offset(table.pos, vtableOffset);
  if (!offset) return new Uint8Array();
  const vectorStart = table.bb.__vector(table.pos + offset);
  const vectorLength = table.bb.__vector_len(table.pos + offset);
  return new Uint8Array(
    table.bb.bytes().buffer,
    table.bb.bytes().byteOffset + vectorStart,
    vectorLength,
  ).slice();
}

function uint64Field(table, vtableOffset) {
  const offset = table.bb.__offset(table.pos, vtableOffset);
  if (!offset) return 0;
  const value = table.bb.readUint64(table.pos + offset);
  return Number(value);
}

function decodeBundleDescriptor(table) {
  return {
    cid: stringField(table, 6) || "",
    contentHash: bytesField(table, 8),
    sizeBytes: uint64Field(table, 10),
    moduleId: stringField(table, 12) || "",
    moduleVersion: stringField(table, 14),
    runtime: stringField(table, 16),
    abi: stringField(table, 18),
    entrypoint: stringField(table, 20),
    publicationCid: stringField(table, 22),
    contentCodec: stringField(table, 24),
    encryptionCodec: stringField(table, 26),
  };
}

function decodeWrappedContentKey(table) {
  return {
    wrappingAlgorithm: stringField(table, 6) || "",
    recipientKeyId: stringField(table, 8),
    recipientPublicKey: bytesField(table, 10),
    ephemeralPublicKey: bytesField(table, 12),
    nonce: bytesField(table, 14),
    ciphertext: bytesField(table, 16),
    tag: bytesField(table, 18),
  };
}

export function decodeGrantResponse(messageBytes) {
  const grant = getRootTable(messageBytes, GRANT_RESPONSE_FILE_IDENTIFIER);
  const bundleDescriptor = tableField(grant, 22);
  const wrappedContentKey = tableField(grant, 24);
  if (!bundleDescriptor || !wrappedContentKey) {
    throw new Error("grant response is missing required module-delivery tables");
  }
  return {
    reqId: stringField(grant, 6) || "",
    entitlementStatus: stringField(grant, 8),
    capabilityToken: stringField(grant, 10),
    expiresAtMs: uint64Field(grant, 12),
    grantedDomain: stringField(grant, 14) || "",
    grantedTimeoutMs: uint64Field(grant, 16),
    grantSignature: bytesField(grant, 18),
    grantVerifierPublicKey: bytesField(grant, 20),
    bundleDescriptor: decodeBundleDescriptor(bundleDescriptor),
    wrappedContentKey: decodeWrappedContentKey(wrappedContentKey),
  };
}
