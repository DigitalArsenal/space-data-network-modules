import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeModuleConfig } from 'space-data-module-sdk/runtime-contracts';
import { extractPublicationRecordCollection, encodeEncRecord } from 'space-data-module-sdk/transport';
import { encodeRecipientKey, encodeFileContent, decodeFileContent } from '../../../client-decrypt/index.js';

export { decodeFileContent, encodeFileContent };
export const typeRef = code => ({ schemaName: code === 'MCFG' ? 'ModuleConfig.fbs' : `${code}.fbs`, fileIdentifier: code === 'MCFG' ? 'MCFG' : `$${code}`, rootTypeName: code === 'MCFG' ? 'ModuleConfig' : code, wireFormat: 'flatbuffer' });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function sealRequest(files, privateKey, context, names) {
  return { methodId: 'seal', inputs: [
    ...files.map((bytes, i) => ({ portId: 'file', streamId: i, typeRef: typeRef('FIL'), payload: encodeFileContent(bytes) })),
    { portId: 'release_key', typeRef: typeRef('KMF'), payload: encodeRecipientKey(privateKey) },
    { portId: 'options', typeRef: typeRef('MCFG'), payload: encodeModuleConfig({ context, names }) },
  ] };
}
export function checkLayout(bytes, plainLength, expectedContext) {
  const b = Buffer.from(bytes);
  assert.equal(b.subarray(-4).toString(), '$REC');
  const trailerLength = b.readUInt32LE(b.length - 8);
  const trailerStart = b.length - 8 - trailerLength;
  assert.equal(trailerStart, plainLength + 16, 'ciphertext || 16-byte tag || REC || u32le || $REC');
  assert.equal(b.subarray(trailerStart + 4, trailerStart + 8).toString(), '$REC');
  const parsed = extractPublicationRecordCollection(bytes);
  assert.equal(parsed.enc.context, expectedContext, 'reader refuses a publication swapped to another name');
  assert.equal(parsed.enc.keyExchange, 'X25519');
  assert.equal(parsed.enc.symmetric, 'AES_256_GCM');
  assert.equal(parsed.enc.keyDerivation, 'HKDF_SHA256');
  assert.equal(parsed.enc.ephemeralPublicKey.length, 32);
  assert.equal(parsed.enc.nonceStart.length, 12);
  assert.equal(parsed.payloadBytes.length, plainLength + 16);
  return { parsed, trailerStart, trailerLength, aad: encodeEncRecord(parsed.enc) };
}
