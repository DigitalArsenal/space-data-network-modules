// Inputs shared by the epoch-state tests and its parity run: Vallado's verification set as $MPE and $OMM streams.
import fs from "node:fs";

import * as flatbuffers from "flatbuffers";
import { MPE, meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/main.js";

export const FIXTURE = JSON.parse(fs.readFileSync(new URL("./vallado-verification.json", import.meta.url), "utf8"));

export const mpeType = () => ({ schemaName: "MPE.fbs", fileIdentifier: "$MPE", rootTypeName: "MPE", wireFormat: "flatbuffer" });
export const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM", wireFormat: "flatbuffer" };

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

// $PRW window requests and reports, through flatc (flatc-wasm) and the SDS tree's own schema: the JSON bindings of
// the published packages predate the WINDOW_REQUEST / WINDOW_REPORT arms.
import path from "node:path";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";

const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL("../node_modules/spacedatastandards.org/", import.meta.url));
let flatcReady;
async function flatc() {
  flatcReady ??= (async () => {
    const f = await createFlatc();
    for (const dir of ["/schemas", "/in", "/out"]) f.FS.mkdir(dir);
    for (const family of fs.readdirSync(path.join(STANDARDS_ROOT, "schema"))) {
      const schema = path.join(STANDARDS_ROOT, "schema", family, "main.fbs");
      if (!fs.existsSync(schema)) continue;
      f.FS.mkdir(`/schemas/${family}`);
      f.FS.writeFile(`/schemas/${family}/main.fbs`, fs.readFileSync(schema, "utf8"));
    }
    return f;
  })();
  return flatcReady;
}
let serial = 0;

/** One $PRW (plain) from its JSON form. */
export async function encodePrw(value) {
  const f = await flatc();
  const name = `prw${serial++}`;
  f.FS.writeFile(`/in/${name}.json`, JSON.stringify(value));
  if (f.callMain(["-b", "--no-warnings", "-I", "/schemas", "-o", "/out", "/schemas/PRW/main.fbs", `/in/${name}.json`]) !== 0) throw new Error("flatc -b PRW failed");
  return new Uint8Array(f.FS.readFile(`/out/${name}.bin`));
}

/** The JSON form of one size-prefixed $PRW. */
export async function decodePrw(bytes) {
  const f = await flatc();
  const name = `prw${serial++}`;
  f.FS.writeFile(`/in/${name}.bin`, bytes);
  if (f.callMain(["-t", "--no-warnings", "--strict-json", "--defaults-json", "--size-prefixed", "-I", "/schemas", "-o", "/out", "/schemas/PRW/main.fbs", "--", `/in/${name}.bin`]) !== 0) {
    throw new Error("flatc -t PRW failed");
  }
  return JSON.parse(f.FS.readFile(`/out/${name}.json`, { encoding: "utf8" }));
}

export const prwType = { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW", wireFormat: "flatbuffer" };
export const utc = (iso) => ({ TIME_SYSTEM: "UTC", EPOCH_FORMAT: "ISO8601", ISO8601: iso });

/** The $PRW WINDOW_REQUEST of the detector's queries ({set, start, stop, step_s}). */
export const windowRequest = (queries, extra = {}) =>
  encodePrw({
    WINDOW_REQUEST: {
      QUERIES: queries.map((q, i) => ({ SEQUENCE: i, SET_INDEX: q.set, OBJECT_KEY: q.object ?? "", START: utc(q.start), STOP: utc(q.stop), STEP_SECONDS: q.step_s })),
      ...extra,
    },
  });
