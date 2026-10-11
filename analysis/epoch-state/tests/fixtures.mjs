// Inputs shared by the epoch-state tests and its parity run: Vallado's verification set as $MPE and $OMM streams.
import fs from "node:fs";

import * as flatbuffers from "flatbuffers";
import { MPE, meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/main.js";

export const FIXTURE = JSON.parse(fs.readFileSync(new URL("./vallado-verification.json", import.meta.url), "utf8"));

export const mpeType = (byteLength) => ({
  schemaName: "MPE.fbs",
  fileIdentifier: "$MPE",
  rootTypeName: "MPE",
  wireFormat: "aligned-binary",
  requiredAlignment: 8,
  byteLength,
});
export const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM", wireFormat: "flatbuffer" };

export const jsonFrame = (portId, value) => ({
  portId,
  payload: new TextEncoder().encode(JSON.stringify(value)),
  typeRef: { schemaName: "application/json" },
});

export function encodeMpe(record) {
  const builder = new flatbuffers.Builder(256);
  const entityId = record.entityId === undefined ? 0 : builder.createString(record.entityId);
  MPE.startMPE(builder);
  if (entityId) MPE.addEntityId(builder, entityId);
  MPE.addEpoch(builder, record.epochUnix);
  MPE.addMeanMotion(builder, record.MEAN_MOTION);
  MPE.addEccentricity(builder, record.ECCENTRICITY);
  MPE.addInclination(builder, record.INCLINATION);
  MPE.addRaOfAscNode(builder, record.RA_OF_ASC_NODE);
  MPE.addArgOfPericenter(builder, record.ARG_OF_PERICENTER);
  MPE.addMeanAnomaly(builder, record.MEAN_ANOMALY);
  MPE.addBstar(builder, record.BSTAR);
  MPE.addMeanElementTheory(builder, record.theory ?? meanElementSource.SGP4);
  MPE.finishSizePrefixedMPEBuffer(builder, MPE.endMPE(builder));
  return builder.asUint8Array();
}

// Size-prefixed buffers concatenated, each padded to 8 bytes with a
// zero-length prefix.
function stream(records) {
  const frames = records.map(encodeMpe);
  const padded = frames.map((frame) => frame.length + ((8 - (frame.length % 8)) % 8));
  const bytes = new Uint8Array(padded.reduce((a, b) => a + b, 0));
  let offset = 0;
  frames.forEach((frame, i) => {
    bytes.set(frame, offset);
    offset += padded[i];
  });
  return bytes;
}

// Size-prefixed buffers concatenated, each padded to 8 bytes with a
// zero-length prefix.
export function mpeStream(records) {
  const frames = records.map(encodeMpe);
  const padded = frames.map((frame) => frame.length + ((8 - (frame.length % 8)) % 8));
  const bytes = new Uint8Array(padded.reduce((a, b) => a + b, 0));
  let offset = 0;
  frames.forEach((frame, i) => {
    bytes.set(frame, offset);
    offset += padded[i];
  });
  return bytes;
}

export function encodeOmm(record, overrides = {}) {
  const omm = new OMMT();
  Object.assign(omm, {
    EPOCH: record.epochIso.replace(/Z$/, ""),
    NORAD_CAT_ID: record.entityId.startsWith("NORAD:") ? record.satnum : 0,
    OBJECT_ID: record.entityId.startsWith("NORAD:") ? "" : record.entityId,
    OBJECT_NAME: `VALLADO ${record.satnum}`,
    MEAN_ELEMENT_THEORY: meanElementSource.SGP4,
    MEAN_MOTION: record.MEAN_MOTION,
    ECCENTRICITY: record.ECCENTRICITY,
    INCLINATION: record.INCLINATION,
    RA_OF_ASC_NODE: record.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: record.ARG_OF_PERICENTER,
    MEAN_ANOMALY: record.MEAN_ANOMALY,
    BSTAR: record.BSTAR,
    ...overrides,
  });
  const builder = new flatbuffers.Builder(512);
  OMM.finishSizePrefixedOMMBuffer(builder, omm.pack(builder));
  return builder.asUint8Array();
}
export const ommStream = (records, overridesFor = () => ({})) =>
  Buffer.concat(records.map((record, i) => Buffer.from(encodeOmm(record, overridesFor(record, i)))));
