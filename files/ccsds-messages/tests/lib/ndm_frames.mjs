// The frames the module takes and gives, for the tests: a size-prefixed $NCD followed by the
// message's exact bytes, and the SDS record on the message's own port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import * as flatbuffers from "flatbuffers";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";

// ncdContainerFormat (NCD.fbs): the CCSDS_<M>_KVN and CCSDS_<M>_XML members.
export const FORMAT = {
  OEM: [7, 8], AEM: [9, 10], TDM: [11, 12], OMM: [13, 14], OPM: [15, 16],
  OCM: [17, 18], CDM: [19, 20], APM: [21, 22], ACM: [23, 24], RDM: [25, 26],
};
export const PORT = {
  OMM: "elements", OEM: "ephemeris", OPM: "state", OCM: "orbit", CDM: "conjunction",
  APM: "attitude_state", ACM: "attitude_data", RDM: "reentry", AEM: "attitude", TDM: "tracking",
};
export const KVN_FORMAT = (type) => FORMAT[type][0];
export const XML_FORMAT = (type) => FORMAT[type][1];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// [u32le n][$NCD, n bytes][bytes]; with no bytes, the descriptor alone. `declare: false` leaves out the
// length and hash the descriptor would state of the bytes behind it.
export function ncdFrame(bytes, format, { declare = true } = {}) {
  const b = new flatbuffers.Builder(512);
  const sha = bytes && declare ? b.createString(sha256(bytes)) : 0;
  NCD.startNCD(b);
  if (format !== undefined) NCD.addFormat(b, format);
  if (bytes && declare) {
    NCD.addSourceByteLength(b, BigInt(bytes.length));
    NCD.addSourceSha256(b, sha);
  }
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const d = b.asUint8Array();
  if (!bytes) return d;
  const f = new Uint8Array(d.length + bytes.length);
  f.set(d);
  f.set(bytes, d.length);
  return f;
}
export const ncdInput = (portId, f) => ({ portId, typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: f.byteLength }, payload: f });
export const recordInput = (type, p) => ({ portId: PORT[type], typeRef: { schemaName: `${type}.fbs`, fileIdentifier: `$${type}`, rootTypeName: type, wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: p.byteLength }, payload: p });

// The invoke requests of the two methods.
export const read = (type, bytes, format) => ({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", ncdFrame(bytes, format))] });
export const write = (type, record, format) => ({
  methodId: `write_${type.toLowerCase()}`,
  inputs: format === undefined ? [recordInput(type, record)] : [recordInput(type, record), ncdInput("descriptor", ncdFrame(undefined, format))],
});

export const ok = (r) => { assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`); return r; };
export const out = (response, port) => {
  const f = response.outputs.find((o) => o.portId === port);
  assert.ok(f, `no output on ${port}; got ${response.outputs.map((o) => o.portId)}`);
  return f.payload;
};
// A frame the module wrote: its descriptor and the message bytes behind it.
export function split(frame) {
  const n = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  const bb = new flatbuffers.ByteBuffer(frame.subarray(0, 4 + n));
  bb.setPosition(4);
  return { descriptor: NCD.getRootAsNCD(bb), body: frame.subarray(4 + n) };
}
export function descriptorOf(payload) {
  const bb = new flatbuffers.ByteBuffer(payload);
  bb.setPosition(4);
  return NCD.getRootAsNCD(bb);
}
