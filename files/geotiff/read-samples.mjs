// Host I/O only. The shared WASM reads layout, codecs, scale/offset and masks.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

export const root = fileURLToPath(new URL('.', import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', import.meta.url)));
export const wasmPath = fileURLToPath(new URL('dist/isomorphic/module.wasm', import.meta.url));
export function descriptor(size) {
  const b = new flatbuffers.Builder(128), name = b.createString('Planetary raster');
  NCD.startNCD(b); NCD.addFormat(b, 255); NCD.addProviderDefinedFormatName(b, name);
  NCD.addSourceByteLength(b, BigInt(size));
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return b.asUint8Array();
}
export function rangesFrame(ranges) {
  const out = Buffer.alloc(4 + ranges.reduce((n, r) => n + 12 + r.bytes.length, 0));
  out.writeUInt32LE(ranges.length); let at = 4;
  for (const r of ranges) {
    out.writeBigUInt64LE(BigInt(r.offset), at); out.writeUInt32LE(r.bytes.length, at + 8);
    out.set(r.bytes, at + 12); at += 12 + r.bytes.length;
  }
  return out;
}
export const rawRef = { acceptsAnyFlatbuffer: true };
export const ncdRef = { schemaName: 'NCD.fbs', fileIdentifier: '$NCD', rootTypeName: 'NCD' };
export const doubles = (bytes) => Array.from(new Float64Array(Uint8Array.from(bytes).buffer));
export async function createReader() {
  return createBrowserModuleHarness({wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct'});
}
export async function readWindow(harness, file, window) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  const read = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
        offset + length > size || length > 64 * 1024 * 1024) throw new Error('invalid requested source range');
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error('short source read');
    return {offset, bytes};
  };
  try {
    const ranges = [read(0, Math.min(16384, size))];
    for (let round = 0; round < 32; ++round) {
      if (ranges.reduce((n, r) => n + r.bytes.length, 0) > 128 * 1024 * 1024) throw new Error('source window exceeds 128 MiB');
      const response = await harness.invoke({methodId: 'samples', inputs: [
        {portId: 'descriptor', typeRef: ncdRef, payload: descriptor(size)},
        {portId: 'ranges', typeRef: rawRef, payload: rangesFrame(ranges)},
        {portId: 'request', typeRef: rawRef, payload: new Uint8Array(new Float64Array([1, ...window]).buffer)},
      ]});
      if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
      const out = new Map(response.outputs.map((o) => [o.portId, Uint8Array.from(o.payload)]));
      if (!out.has('need')) return {layout: doubles(out.get('layout')), values: doubles(out.get('values')), valid: out.get('valid'), response};
      const need = doubles(out.get('need'));
      for (let i = 0; i < need.length; i += 2) ranges.push(read(need[i], need[i + 1]));
    }
    throw new Error('source ranges did not converge');
  } finally {fs.closeSync(fd);}
}
