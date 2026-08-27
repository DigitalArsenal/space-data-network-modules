// The $DTT record reader the pyramid tools share.
//
// Lifted verbatim out of verify.mjs, which had the only hand-written one, so
// the VERIFIER and the IPFS PUBLISHER cannot disagree about what a record
// says. That mattered the moment the pyramid stopped being a record stream the
// node serves from and became a directory of files: the publisher decides what
// bytes each `.terrain` file holds by reading exactly the fields the verifier
// asserts against, and two readers would have been two answers.
//
// Field ids follow schema/DTT/main.fbs declaration order. FlatBuffers is read
// by hand rather than through the generated bindings because these tools also
// read streams produced by OTHER builds, and a generated reader pinned to one
// schema edition silently mis-parses a record written by another.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

// ── size-prefixed record framing: [u32 LE length][record] ───────────────────
//
// A zero length is the store's own "no records here" padding — every reader
// treats it as alignment — so it is skipped rather than read as a record.
export function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    offset += 4;
    if (length === 0) continue;
    assert.ok(offset + length <= buf.length, "a length prefix must not run past the stream");
    records.push(buf.subarray(offset, offset + length));
    offset += length;
  }
  assert.equal(offset, buf.length, "the stream ends exactly on a record boundary");
  return records;
}

// ── a hand-written $DTT reader (field ids follow schema/DTT/main.fbs) ───────
export function readDtt(record) {
  const buf = Buffer.from(record);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "$DTT", "every record is a $DTT");
  const pos = buf.readUInt32LE(0);
  const table = (p) => {
    const vtable = p - buf.readInt32LE(p);
    return (id) => {
      const vo = 4 + 2 * id;
      if (vo >= buf.readUInt16LE(vtable)) return 0;
      const off = buf.readUInt16LE(vtable + vo);
      return off === 0 ? 0 : p + off;
    };
  };
  const at = table(pos);
  const u32 = (id) => { const p = at(id); return p ? buf.readUInt32LE(p) : 0; };
  const f64 = (id) => { const p = at(id); return p ? buf.readDoubleLE(p) : 0; };
  const i8 = (id) => { const p = at(id); return p ? buf.readInt8(p) : 0; };
  const u8 = (id) => { const p = at(id); return p ? buf.readUInt8(p) : 0; };
  const strAt = (p) => {
    if (!p) return undefined;
    const sp = p + buf.readUInt32LE(p);
    return buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
  };
  const str = (id) => strAt(at(id));
  // DTTPayloadRef: 0 CID, 1 BYTES, 2 SIZE_BYTES, 3 DIGEST, 4 CONTENT_ENCODING,
  // 5 MEDIA_TYPE. CID and CONTENT_ENCODING are read here and not in verify's
  // original because the IPFS lane turns on both: the file's bytes are the
  // payload DECODED per CONTENT_ENCODING, and a record that already names a
  // CID is one whose bytes are addressed rather than carried.
  const payload = (id) => {
    const p0 = at(id);
    if (!p0) return null;
    const p = p0 + buf.readUInt32LE(p0);
    const pat = table(p);
    const bytesAt = pat(1);
    let bytes = null;
    if (bytesAt) {
      const vp = bytesAt + buf.readUInt32LE(bytesAt);
      bytes = buf.subarray(vp + 4, vp + 4 + buf.readUInt32LE(vp));
    }
    const sizeAt = pat(2);
    return {
      cid: strAt(pat(0)),
      bytes,
      sizeBytes: sizeAt ? Number(buf.readBigUInt64LE(sizeAt)) : 0,
      digest: strAt(pat(3)),
      contentEncoding: strAt(pat(4)),
      mediaType: strAt(pat(5)),
    };
  };
  return {
    tilesetId: str(0),
    level: u32(3),
    x: u32(4),
    y: u32(5),
    westDeg: f64(7),
    southDeg: f64(8),
    eastDeg: f64(9),
    northDeg: f64(10),
    minHeightM: f64(11),
    maxHeightM: f64(12),
    payload: payload(15),
    gridWidth: u32(16),
    gridHeight: u32(17),
    sourcePostSpacingM: f64(19),
    verticalAccuracyM: f64(23),
    accuracyConfidence: f64(24),
    dataCoverageFraction: f64(26),
    waterMask: payload(29),
    waterMaskKind: i8(28),
    waterMaskWidth: u32(30),
    waterMaskHeight: u32(31),
    childAvailability: u8(35),
    maxLevel: u32(36),
    etag: str(40),
  };
}

// ── PROVENANCE, verbatim ───────────────────────────────────────────────────
//
// The tileset catalogue record has to carry the SAME lineage and licence the
// tiles carry — a directory CID published under different terms than its own
// contents would be a redistribution nobody granted — so the publisher reads
// it off a tile rather than re-deriving it from a config file that may have
// moved since the run. Field ids follow DTTProvenance declaration order.
export function readDttProvenance(record) {
  const buf = Buffer.from(record);
  const pos = buf.readUInt32LE(0);
  const table = (p) => {
    const vtable = p - buf.readInt32LE(p);
    return (id) => {
      const vo = 4 + 2 * id;
      if (vo >= buf.readUInt16LE(vtable)) return 0;
      const off = buf.readUInt16LE(vtable + vo);
      return off === 0 ? 0 : p + off;
    };
  };
  const at = table(pos);
  const provAt = at(38);
  if (!provAt) return { raw: {}, attribution: undefined };
  const p = provAt + buf.readUInt32LE(provAt);
  const pat = table(p);
  const strAt = (q) => {
    if (!q) return undefined;
    const sp = q + buf.readUInt32LE(q);
    return buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
  };
  const boolAt = (q) => (q ? buf.readUInt8(q) !== 0 : false);
  const names = [
    "DATASET_ID", "DATASET_NAME", "DATASET_URL", "DATASET_EPOCH", "DATASET_CID",
    "SOURCE_URL", "SOURCE_QUERY", "RETRIEVED_AT", "LICENSE", "LICENSE_URL",
    "ATTRIBUTION",
  ];
  const raw = {};
  names.forEach((name, id) => {
    const value = strAt(pat(id));
    if (value !== undefined) raw[name] = value;
  });
  if (boolAt(pat(11))) raw.NON_COMMERCIAL_ONLY = true;
  if (boolAt(pat(12))) raw.SHARE_ALIKE = true;
  // NATIVE_ID (13), SOURCE_URL (5) and SOURCE_QUERY (6) name the ONE GRANULE a
  // tile was cut from. They are read for a tile and dropped by the caller for
  // a tileset: a pyramid is cut from thousands of granules and a record that
  // names one of them as its source is not imprecise, it is false.
  return { raw, attribution: raw.ATTRIBUTION };
}
