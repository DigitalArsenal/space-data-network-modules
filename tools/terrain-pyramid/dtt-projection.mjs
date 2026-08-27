// tools/terrain-pyramid/dtt-projection.mjs — the ONE place a $DTT JSON
// projection becomes a $DTT record.
//
// WHY THIS FILE EXISTS. The serving module's /tileset.json route and this
// directory's tileset-catalogue.json were described as "the same projection",
// and they were not: the builder's emitted RETRIEVED_AT, GENERATED_AT and
// PROCESSOR and serialized through the published SDS builder; the module's
// omitted RETRIEVED_AT (which DTTProvenance marks `required`) and dropped
// PAYLOAD entirely when no CID was configured (which DTT marks `required`).
// Both projections carried IDL-EXACT KEYS and neither could become a record —
// building them threw "field 18 must be set" and "field 34 must be set" — and
// nothing in either suite had ever tried, so an unbuildable document answered
// 200 and passed 100 tests.
//
// A canonical-JSON form that cannot become the FlatBuffer form is not a record
// in two forms, which is the premise the dual-format signing law rests on. So
// this projector is the gate both sides run through:
//
//   - it REFUSES a key that is not a field of the standard (that is what
//     "IDL-exact keys" has to mean to be worth asserting),
//   - it maps enum names to their wire ordinals rather than accepting numbers,
//   - and the caller then hands the result to writeFB, which is what actually
//     enforces `required`.
//
// It takes the SDS module as an argument rather than importing it: this file
// lives in tools/ and its two callers resolve `spacedatastandards.org` from
// different package roots.

const ENUM_FIELDS = {
  TILING_SCHEME: "dttTilingScheme",
  PAYLOAD_FORMAT: "dttPayloadFormat",
  VERTICAL_DATUM: "dttVerticalDatum",
  SOURCE_CLASS: "dttSourceClass",
  WATER_MASK_KIND: "dttWaterMask",
};
const PAYLOAD_REF_FIELDS = new Set(["PAYLOAD", "WATER_MASK", "VERTEX_NORMALS", "LAND_COVER"]);
const PROVENANCE_FIELDS = new Set(["PROVENANCE", "WATER_MASK_PROVENANCE"]);
// uint64 in the IDL; the builder wants a BigInt and silently mis-encodes a
// Number that happens to fit.
const U64_FIELDS = new Set(["SIZE_BYTES"]);

function assign(target, source, where) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (!(key in target)) {
      throw new Error(
        `${where}.${key} is not a field of the standard — the projection is not IDL-exact`,
      );
    }
    target[key] = U64_FIELDS.has(key) ? BigInt(value) : value;
  }
  return target;
}

/**
 * Build a $DTT record object from a canonical-JSON $DTT projection.
 * Throws on any key the IDL does not define or any enum name it does not.
 * The `required` fields are enforced by writeFB, not here.
 */
export function buildDttRecord(sds, json) {
  const S = sds.standards.DTT;
  const record = new S.DTTT();
  for (const [key, value] of Object.entries(json)) {
    if (value === undefined || value === null) continue;
    if (!(key in record)) {
      throw new Error(`DTT.${key} is not a field of the standard — the projection is not IDL-exact`);
    }
    if (key in ENUM_FIELDS) {
      const table = S[ENUM_FIELDS[key]];
      const ordinal = typeof value === "string" ? table[value] : value;
      if (ordinal === undefined) {
        throw new Error(`DTT.${key}: ${JSON.stringify(value)} is not a ${ENUM_FIELDS[key]} value`);
      }
      record[key] = ordinal;
      continue;
    }
    if (PAYLOAD_REF_FIELDS.has(key)) {
      record[key] = assign(new S.DTTPayloadRefT(), value, `DTT.${key}`);
      continue;
    }
    if (PROVENANCE_FIELDS.has(key)) {
      record[key] = assign(new S.DTTProvenanceT(), value, `DTT.${key}`);
      continue;
    }
    record[key] = value;
  }
  return record;
}

/**
 * The proof: the projection serializes as a $DTT. Returns the wire bytes, so a
 * caller can write them beside the JSON as the record's other form.
 */
export function writeDttRecord(sds, json) {
  return sds.writeFB(buildDttRecord(sds, json));
}
