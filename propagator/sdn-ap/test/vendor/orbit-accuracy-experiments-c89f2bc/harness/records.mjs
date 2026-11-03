// FlatBuffer framing for the records the modules take and return. Encoding
// and decoding only: no field is computed here.
import * as flatbuffers from 'flatbuffers';
import * as OMM from 'spacedatastandards.org/lib/js/OMM/main.js';
import { MPE, meanElementSource } from 'spacedatastandards.org/lib/js/MPE/main.js';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/main.js';

export const ELEMENT_FIELDS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'];

export const OMM_TYPE = { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' };
export const OEM_TYPE = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };

// Element sets ({norad, epoch, elements: {MEAN_MOTION, …}}) as one stream of
// size-prefixed $OMM records on the `elements` port.
export function ommFrame(sets, portId = 'elements') {
  const parts = sets.map((s) => {
    const t = new OMM.OMMT();
    t.EPOCH = s.epoch;
    t.NORAD_CAT_ID = s.norad;
    t.MEAN_ELEMENT_THEORY = OMM.meanElementSource.SGP4;
    for (const f of ELEMENT_FIELDS) t[f] = s.elements[f];
    const b = new flatbuffers.Builder(256);
    OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
    return Buffer.from(b.asUint8Array());
  });
  return { portId, payload: Buffer.concat(parts), typeRef: OMM_TYPE };
}

// Element sets as an aligned stream of size-prefixed $MPE records, each padded
// to 8 bytes (analysis/epoch-state's `elements` port).
export function mpeFrame(records, portId = 'elements') {
  const frames = records.map((r) => {
    const b = new flatbuffers.Builder(256);
    const id = r.entityId === undefined ? 0 : b.createString(r.entityId);
    MPE.startMPE(b);
    if (id) MPE.addEntityId(b, id);
    MPE.addEpoch(b, r.epochUnix);
    MPE.addMeanMotion(b, r.MEAN_MOTION);
    MPE.addEccentricity(b, r.ECCENTRICITY);
    MPE.addInclination(b, r.INCLINATION);
    MPE.addRaOfAscNode(b, r.RA_OF_ASC_NODE);
    MPE.addArgOfPericenter(b, r.ARG_OF_PERICENTER);
    MPE.addMeanAnomaly(b, r.MEAN_ANOMALY);
    MPE.addBstar(b, r.BSTAR);
    MPE.addMeanElementTheory(b, r.theory ?? meanElementSource.SGP4);
    MPE.finishSizePrefixedMPEBuffer(b, MPE.endMPE(b));
    return b.asUint8Array();
  });
  const sizes = frames.map((f) => f.length + ((8 - (f.length % 8)) % 8));
  const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let offset = 0;
  frames.forEach((f, i) => { payload.set(f, offset); offset += sizes[i]; });
  return {
    portId,
    payload,
    typeRef: { schemaName: 'MPE.fbs', fileIdentifier: '$MPE', rootTypeName: 'MPE', wireFormat: 'aligned-binary', requiredAlignment: 8, byteLength: payload.byteLength },
  };
}

// A stream of size-prefixed $OEM records (zero-length prefixes are padding).
export function decodeOemStream(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 0; p + 4 <= bytes.length;) {
    const n = view.getUint32(p, true);
    if (n === 0) { p += 4; continue; }
    out.push(OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(bytes.slice(p, p + 4 + n))).unpack());
    p += 4 + n;
  }
  return out;
}
