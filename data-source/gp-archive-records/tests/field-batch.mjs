// Field batch encoder for the build_mpe / build_cat input (format in
// src/gp_archive_records_module.cpp and README.md). Values: strings as
// Uint8Array (kept exactly) or JS strings (UTF-8), doubles as numbers or as
// 16-hex-digit IEEE-754 bit patterns, uint32 as numbers.

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

export function encodeFieldBatch(fields, records) {
  const parts = [];
  const u8 = (v) => parts.push(Uint8Array.of(v));
  const u16 = (v) => parts.push(Uint8Array.of(v & 0xff, v >>> 8));
  const u32 = (v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    parts.push(b);
  };
  parts.push(new TextEncoder().encode("GPAF"));
  u16(1);
  u16(fields.length);
  for (const [name] of fields) {
    const b = new TextEncoder().encode(name);
    u8(b.length);
    parts.push(b);
  }
  u32(records.length);
  for (const record of records) {
    for (const [name, kind] of fields) {
      const value = record[name];
      if (kind === "string") {
        const b = typeof value === "string" ? new TextEncoder().encode(value) : value;
        u32(b.length);
        parts.push(b);
      } else if (kind === "double") {
        const b = new Uint8Array(8);
        if (typeof value === "string") new DataView(b.buffer).setBigUint64(0, BigInt(`0x${value}`), true);
        else new DataView(b.buffer).setFloat64(0, value, true);
        parts.push(b);
      } else {
        u32(value);
      }
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
