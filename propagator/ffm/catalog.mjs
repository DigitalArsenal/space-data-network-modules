// Node kernel encoding; configuration records also work in browsers.
import { createHash } from 'node:crypto';
import { encode, prw as P } from './catalog-configuration.mjs';
export * from './catalog-configuration.mjs';
const table = (name, fields = {}) => Object.assign(new P[`${name}T`](), fields);

// The kernel input: a PRW NATIVE_INPUT with the bytes' SHA-256.
export function kernelRecord(bytes) {
  return encode('NATIVE_INPUT', table('PRWNativeInput', {
    DESCRIPTOR: table('NCD', { FORMAT: P.ncdContainerFormat.SPK_DAF, SOURCE_BYTE_LENGTH: BigInt(bytes.length),
      SOURCE_SHA256: createHash('sha256').update(bytes).digest('hex') }),
    CONTENT: bytes,
  }));
}

