// files/orbit-products `read_container`: an ephemeris container (SPK types 8, 9 and 13, Code-500, STK, SP3) into an $OEM,
// plus its $NCD descriptor. Host side only: builds the framed input ([u32le n][$NCD][container bytes]) and decodes the answer;
// the segment evaluation is the module's.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import { openModule } from './modules.mjs';
import { readOem, blockLines } from './sds.mjs';

const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const { NCD } = await import(pathToFileURL(path.join(standards, 'lib/js/NCD/NCD.js')));
const { ncdContainerFormat } = await import(pathToFileURL(path.join(standards, 'lib/js/NCD/ncdContainerFormat.js')));
const NCD_TYPE = { schemaName: 'NCD.fbs', fileIdentifier: '$NCD', rootTypeName: 'NCD' };

function frameOf(bytes, format) {
  const b = new flatbuffers.Builder(1024);
  const sha = b.createString(crypto.createHash('sha256').update(bytes).digest('hex'));
  NCD.startNCD(b);
  NCD.addFormat(b, format);
  NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
  NCD.addSourceSha256(b, sha);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const descriptor = b.asUint8Array();
  const out = new Uint8Array(descriptor.byteLength + bytes.byteLength);
  out.set(descriptor, 0);
  out.set(bytes, descriptor.byteLength);
  return { portId: 'container', typeRef: NCD_TYPE, payload: out };
}

export async function openContainers(modules) { return openModule(modules, 'files/orbit-products', { fresh: true }); }

/** { oem (decoded), segments: [{type, target, ...}], error } for an SPK file. */
export async function readSpk(mod, file, method = 'read_container') {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const response = await mod.response(method, [frameOf(bytes, ncdContainerFormat.SPK_DAF)]);
  if (response.statusCode !== 0) return { error: `${response.errorCode}: ${String(response.errorMessage).slice(0, 240)}` };
  const out = {};
  for (const o of response.outputs) out[o.portId] = Buffer.from(o.payload);
  const descriptor = out.descriptor ? NCD.getSizePrefixedRootAsNCD(new flatbuffers.ByteBuffer(new Uint8Array(out.descriptor))) : null;
  const segments = [];
  for (let i = 0; descriptor && i < descriptor.segmentsLength(); i += 1) {
    const s = descriptor.SEGMENTS(i);
    segments.push({ type: s.SEGMENT_TYPE(), degree: s.POLYNOMIAL_DEGREE(), frame: s.FRAME_NAIF_ID() });
  }
  return { oem: out.ephemeris ? readOem(out.ephemeris) : null, segments, timeSystem: descriptor?.NATIVE_TIME_SYSTEM(), frameName: descriptor?.NATIVE_FRAME_NAME() };
}
export { blockLines };
