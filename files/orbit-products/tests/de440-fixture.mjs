// Wire encoding only. The checked-in 2026 excerpt contains unchanged NAIF
// DE440 coefficient records; provenance and CSPICE references live beside it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fb from 'flatbuffers';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js';

export const excerptPath = new URL('./fixtures/de440/de440-2026.bsp', import.meta.url);
export const excerptSha256 = 'e612a95953ca8211c629bdb632d4c7483cc339f0e963592bd8cae4a7d24ad7ef';
export const ncdType = { schemaName: 'NCD.fbs', fileIdentifier: '$NCD', rootTypeName: 'NCD' };

export function kernelFrame({ hashOverride } = {}) {
  const bytes = readFileSync(excerptPath);
  const b = new fb.Builder(1024);
  const sha = b.createString(hashOverride ?? createHash('sha256').update(bytes).digest('hex'));
  NCD.startNCD(b);
  NCD.addFormat(b, ncdContainerFormat.SPK_DAF);
  NCD.addSourceByteLength(b, BigInt(bytes.length));
  NCD.addSourceSha256(b, sha);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return Buffer.concat([b.asUint8Array(), bytes]);
}

export function kernelRequest(methodId = 'describe_container', frameOptions = {}) {
  return { methodId, inputs: [{ portId: 'container', typeRef: ncdType,
    payload: kernelFrame(frameOptions) }] };
}

export function de440Cases() {
  return [
    ['de440-describe', kernelRequest()],
    ['de440-no-coefficient-materialization', kernelRequest('read_container')],
    ['de440-bad-descriptor-hash', kernelRequest('describe_container', { hashOverride: '0'.repeat(64) })],
  ];
}
