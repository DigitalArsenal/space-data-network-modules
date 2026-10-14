// Input streams for build_mpe / build_cat: size-prefixed $MPE / $CAT records
// built with the SDS JavaScript bindings (SPACE_DATA_STANDARDS_ROOT lib/js), in
// a layout that is deliberately NOT archive encoding v1 (fields added in
// reverse, frames unpadded), so the module has to re-build them.
// Values: strings as Uint8Array (kept exactly) or JS strings (UTF-8), doubles
// as numbers or 16-hex-digit IEEE-754 bit patterns, uint32 as numbers.
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as flatbuffers from "flatbuffers";

const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT;
if (!standardsRoot) throw new Error("Set SPACE_DATA_STANDARDS_ROOT to the spacedatastandards.org checkout.");
const sds = (family) => import(pathToFileURL(path.join(standardsRoot, "lib", "js", family, "main.js")).href);
export const { MPE, meanElementSource } = await sds("MPE");
export const { CAT } = await sds("CAT");

export const MPE_FIELDS = [
  ["ENTITY_ID", "string"],
  ["EPOCH", "double"],
  ["MEAN_MOTION", "double"],
  ["ECCENTRICITY", "double"],
  ["INCLINATION", "double"],
  ["RA_OF_ASC_NODE", "double"],
  ["ARG_OF_PERICENTER", "double"],
  ["MEAN_ANOMALY", "double"],
  ["BSTAR", "double"],
];

export const CAT_FIELDS = [
  ["OBJECT_ID", "string"],
  ["NORAD_CAT_ID", "uint32"],
  ["OBJECT_NAME", "string"],
];

const asDouble = (value) => {
  if (typeof value !== "string") return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${value}`));
  return view.getFloat64(0);
};

// SDS field name -> generated JS adder (ENTITY_ID -> addEntityId).
export const adder = (name) =>
  `add${name.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase())}`;

// One size-prefixed record. `omit` leaves fields out; `extra(builder, Table)`
// adds more before the end.
export function encodeRecord(Table, fields, record, { omit = [], forceDefaults = true, extra } = {}) {
  const b = new flatbuffers.Builder(256);
  b.forceDefaults(forceDefaults);
  const strings = {};
  for (const [name, kind] of [...fields].reverse()) {
    if (kind === "string" && !omit.includes(name)) strings[name] = b.createString(record[name]);
  }
  Table[`start${Table.name}`](b);
  for (const [name, kind] of [...fields].reverse()) {
    if (omit.includes(name)) continue;
    const value = kind === "string" ? strings[name] : kind === "double" ? asDouble(record[name]) : record[name];
    Table[adder(name)](b, value);
  }
  extra?.(b, Table);
  b.finishSizePrefixed(Table[`end${Table.name}`](b), `$${Table.name}`);
  return b.asUint8Array();
}

// Concatenated size-prefixed records, unpadded.
export function encodeStream(Table, fields, records, options) {
  const frames = records.map((record) => encodeRecord(Table, fields, record, options));
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
