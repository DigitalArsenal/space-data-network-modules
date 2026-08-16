// Shared test plumbing for the terrain-source lane: a synthetic GeoTIFF
// writer (the DEM container under test, built byte-by-byte so it can carry
// the exact layouts the reader must survive), a quantized-mesh-1.0 decoder
// written straight from the spec, and a minimal FlatBuffer table walker for
// $DTT (field ids from schema/DTT/main.fbs declaration order).

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import zlib from "node:zlib";

// ── synthetic GeoTIFF writer ────────────────────────────────────────────────
//
// Classic little-endian TIFF, single-band Float32, DEFLATE (zlib-wrapped, as
// Adobe-style TIFF compression 8 is), strip or single-tile layout, predictor
// 1 or 3. heightFn(px, py) -> metres.

function predictor3Encode(floatRow) {
  const width = floatRow.length;
  const src = Buffer.alloc(width * 4);
  for (let i = 0; i < width; i++) src.writeFloatLE(floatRow[i], i * 4);
  const planes = Buffer.alloc(width * 4);
  for (let i = 0; i < width; i++) {
    planes[i] = src[i * 4 + 3]; // MSB plane first
    planes[width + i] = src[i * 4 + 2];
    planes[width * 2 + i] = src[i * 4 + 1];
    planes[width * 3 + i] = src[i * 4];
  }
  const out = Buffer.alloc(width * 4);
  out[0] = planes[0];
  for (let i = 1; i < width * 4; i++) out[i] = (planes[i] - planes[i - 1]) & 0xff;
  return out;
}

export function buildGeoTiff({
  width = 64,
  height = 64,
  originLon,
  originLat,
  scaleLon,
  scaleLat,
  heightFn,
  layout = "strip", // "strip" | "tile"
  predictor = 1, // 1 | 3
}) {
  const rows = [];
  for (let py = 0; py < height; py++) {
    const row = new Array(width);
    for (let px = 0; px < width; px++) row[px] = Math.fround(heightFn(px, py));
    rows.push(row);
  }
  let raw;
  if (predictor === 3) {
    raw = Buffer.concat(rows.map(predictor3Encode));
  } else {
    raw = Buffer.alloc(width * height * 4);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        raw.writeFloatLE(rows[py][px], (py * width + px) * 4);
      }
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const SHORT = 3;
  const LONG = 4;
  const DOUBLE = 12;
  const tags = [];
  const tag = (id, type, count, value) => tags.push({ id, type, count, value });

  // Extra data area (pixel scale + tiepoint + pixel data) starts after the
  // header (8) + entry count (2) + entries (12 each) + next-IFD offset (4).
  const entryCount = layout === "tile" ? 13 : 12;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let cursor = 8 + ifdBytes;
  const scaleOffset = cursor;
  cursor += 24;
  const tiepointOffset = cursor;
  cursor += 48;
  const dataOffset = cursor;

  tag(256, SHORT, 1, width);
  tag(257, SHORT, 1, height);
  tag(258, SHORT, 1, 32);
  tag(259, SHORT, 1, 8); // DEFLATE
  if (layout === "tile") {
    tag(277, SHORT, 1, 1);
    tag(317, SHORT, 1, predictor);
    tag(322, SHORT, 1, width);
    tag(323, SHORT, 1, height);
    tag(324, LONG, 1, dataOffset);
    tag(325, LONG, 1, compressed.length);
  } else {
    tag(273, LONG, 1, dataOffset);
    tag(277, SHORT, 1, 1);
    tag(278, SHORT, 1, height);
    tag(279, LONG, 1, compressed.length);
    tag(317, SHORT, 1, predictor);
  }
  tag(339, SHORT, 1, 3); // IEEE float
  tag(33550, DOUBLE, 3, scaleOffset);
  tag(33922, DOUBLE, 6, tiepointOffset);
  tags.sort((a, b) => a.id - b.id);
  assert.equal(tags.length, entryCount);

  const file = Buffer.alloc(dataOffset + compressed.length);
  file.write("II", 0, "latin1");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(8, 4);
  file.writeUInt16LE(entryCount, 8);
  tags.forEach((t, n) => {
    const at = 10 + n * 12;
    file.writeUInt16LE(t.id, at);
    file.writeUInt16LE(t.type, at + 2);
    file.writeUInt32LE(t.count, at + 4);
    if (t.type === SHORT && t.count === 1) file.writeUInt16LE(t.value, at + 8);
    else file.writeUInt32LE(t.value, at + 8);
  });
  file.writeDoubleLE(scaleLon, scaleOffset);
  file.writeDoubleLE(scaleLat, scaleOffset + 8);
  file.writeDoubleLE(0, scaleOffset + 16);
  // Tiepoint: raster (0,0,0) -> model (lon, lat, 0).
  file.writeDoubleLE(0, tiepointOffset);
  file.writeDoubleLE(0, tiepointOffset + 8);
  file.writeDoubleLE(0, tiepointOffset + 16);
  file.writeDoubleLE(originLon, tiepointOffset + 24);
  file.writeDoubleLE(originLat, tiepointOffset + 32);
  file.writeDoubleLE(0, tiepointOffset + 40);
  compressed.copy(file, dataOffset);
  return file;
}

// ── quantized-mesh-1.0 decoder (written from the spec, not from the module,
//    so the two can disagree) ───────────────────────────────────────────────

export function decodeQuantizedMesh(buf) {
  let at = 0;
  const f64 = () => { const v = buf.readDoubleLE(at); at += 8; return v; };
  const f32 = () => { const v = buf.readFloatLE(at); at += 4; return v; };
  const u32 = () => { const v = buf.readUInt32LE(at); at += 4; return v; };
  const u16 = () => { const v = buf.readUInt16LE(at); at += 2; return v; };
  const u8 = () => buf[at++];

  const header = {
    centerX: f64(), centerY: f64(), centerZ: f64(),
    minHeight: f32(), maxHeight: f32(),
    sphereX: f64(), sphereY: f64(), sphereZ: f64(), sphereRadius: f64(),
    occlusionX: f64(), occlusionY: f64(), occlusionZ: f64(),
  };
  const vertexCount = u32();
  const unzig = (arr) => {
    let value = 0;
    for (let i = 0; i < vertexCount; i++) {
      const z = u16();
      value += (z >> 1) ^ -(z & 1);
      arr.push(value);
    }
  };
  const u = [], v = [], h = [];
  unzig(u); unzig(v); unzig(h);

  const wide = vertexCount > 65536;
  const align = wide ? 4 : 2;
  while (at % align !== 0) at++;
  const idx = () => (wide ? u32() : u16());
  const triangleCount = u32();
  const indices = [];
  let highest = 0;
  for (let i = 0; i < triangleCount * 3; i++) {
    const code = idx();
    indices.push(highest - code);
    if (code === 0) highest++;
  }
  const edgeList = () => {
    const n = u32();
    const list = [];
    for (let i = 0; i < n; i++) list.push(idx());
    return list;
  };
  const west = edgeList();
  const south = edgeList();
  const east = edgeList();
  const north = edgeList();

  const extensions = [];
  while (at < buf.length) {
    const id = u8();
    const length = u32();
    extensions.push({ id, bytes: buf.subarray(at, at + length) });
    at += length;
  }
  return { header, vertexCount, u, v, h, triangleCount, indices,
           edges: { west, south, east, north }, extensions, bytesRead: at };
}

// ── minimal FlatBuffer walker for $DTT ─────────────────────────────────────

function tablePos(buf, refPos) {
  const off = buf.readUInt32LE(refPos);
  return off === 0 ? 0 : refPos + off;
}

function fieldPos(buf, pos, fieldId) {
  const vtable = pos - buf.readInt32LE(pos);
  const vo = 4 + 2 * fieldId;
  if (vo >= buf.readUInt16LE(vtable)) return 0;
  const off = buf.readUInt16LE(vtable + vo);
  return off === 0 ? 0 : pos + off;
}

function str(buf, pos, fieldId) {
  const fp = fieldPos(buf, pos, fieldId);
  if (fp === 0) return undefined;
  const sp = fp + buf.readUInt32LE(fp);
  const len = buf.readUInt32LE(sp);
  return buf.subarray(sp + 4, sp + 4 + len).toString("utf8");
}

function bytesVec(buf, pos, fieldId) {
  const fp = fieldPos(buf, pos, fieldId);
  if (fp === 0) return undefined;
  const vp = fp + buf.readUInt32LE(fp);
  const len = buf.readUInt32LE(vp);
  return buf.subarray(vp + 4, vp + 4 + len);
}

const f64At = (buf, pos, id, fb = 0) => { const fp = fieldPos(buf, pos, id); return fp ? buf.readDoubleLE(fp) : fb; };
const u32At = (buf, pos, id, fb = 0) => { const fp = fieldPos(buf, pos, id); return fp ? buf.readUInt32LE(fp) : fb; };
const u64At = (buf, pos, id, fb = 0n) => { const fp = fieldPos(buf, pos, id); return fp ? buf.readBigUInt64LE(fp) : fb; };
const i8At = (buf, pos, id, fb = 0) => { const fp = fieldPos(buf, pos, id); return fp ? buf.readInt8(fp) : fb; };
const u8At = (buf, pos, id, fb = 0) => { const fp = fieldPos(buf, pos, id); return fp ? buf.readUInt8(fp) : fb; };

function payloadRef(buf, pos, fieldId) {
  const fp = fieldPos(buf, pos, fieldId);
  if (fp === 0) return undefined;
  const p = fp + buf.readUInt32LE(fp);
  // DTTPayloadRef fields: CID 0, BYTES 1, SIZE_BYTES 2, DIGEST 3,
  // CONTENT_ENCODING 4, MEDIA_TYPE 5.
  return {
    cid: str(buf, p, 0),
    bytes: bytesVec(buf, p, 1),
    sizeBytes: u64At(buf, p, 2),
    digest: str(buf, p, 3),
    contentEncoding: str(buf, p, 4),
    mediaType: str(buf, p, 5),
  };
}

function provenance(buf, pos, fieldId) {
  const fp = fieldPos(buf, pos, fieldId);
  if (fp === 0) return undefined;
  const p = fp + buf.readUInt32LE(fp);
  // DTTProvenance fields: DATASET_ID 0, DATASET_NAME 1, DATASET_URL 2,
  // DATASET_EPOCH 3, DATASET_CID 4, SOURCE_URL 5, SOURCE_QUERY 6,
  // RETRIEVED_AT 7, LICENSE 8, LICENSE_URL 9, ATTRIBUTION 10.
  return {
    datasetId: str(buf, p, 0),
    datasetName: str(buf, p, 1),
    datasetEpoch: str(buf, p, 3),
    sourceUrl: str(buf, p, 5),
    retrievedAt: str(buf, p, 7),
    license: str(buf, p, 8),
    licenseUrl: str(buf, p, 9),
    attribution: str(buf, p, 10),
  };
}

export function decodeDtt(record) {
  const buf = Buffer.from(record);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "$DTT");
  const pos = tablePos(buf, 0);
  // DTT field ids follow schema/DTT/main.fbs declaration order.
  return {
    tilesetId: str(buf, pos, 0),
    tilingScheme: i8At(buf, pos, 2),
    level: u32At(buf, pos, 3),
    x: u32At(buf, pos, 4),
    y: u32At(buf, pos, 5),
    rowOriginNorth: u8At(buf, pos, 6) !== 0,
    westDeg: f64At(buf, pos, 7),
    southDeg: f64At(buf, pos, 8),
    eastDeg: f64At(buf, pos, 9),
    northDeg: f64At(buf, pos, 10),
    minHeightM: f64At(buf, pos, 11),
    maxHeightM: f64At(buf, pos, 12),
    payloadFormat: i8At(buf, pos, 13),
    payloadFormatVersion: str(buf, pos, 14),
    payload: payloadRef(buf, pos, 15),
    gridWidth: u32At(buf, pos, 16),
    gridHeight: u32At(buf, pos, 17),
    postSpacingM: f64At(buf, pos, 18),
    verticalDatum: i8At(buf, pos, 20),
    verticalDatumName: str(buf, pos, 21),
    dataCoverageFraction: f64At(buf, pos, 26),
    noDataValue: f64At(buf, pos, 27),
    waterMaskKind: i8At(buf, pos, 28),
    waterMask: payloadRef(buf, pos, 29),
    waterMaskWidth: u32At(buf, pos, 30),
    waterMaskHeight: u32At(buf, pos, 31),
    childAvailability: u8At(buf, pos, 35),
    maxLevel: u32At(buf, pos, 36),
    sourceClass: i8At(buf, pos, 37),
    provenance: provenance(buf, pos, 38),
    remarks: str(buf, pos, 42),
  };
}

// Walk a size-prefixed record stream: [uint32 LE length][record] repeated.
export function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    assert.ok(off + len <= buf.length, "a length prefix must not run past the stream");
    records.push(buf.subarray(off, off + len));
    off += len;
  }
  assert.equal(off, buf.length, "the stream must end exactly on a record boundary");
  return records;
}

// ── WGS 84, mirrored independently of the module ───────────────────────────

export function geodeticToEcef(latDeg, lonDeg, height) {
  const a = 6378137.0;
  const b = 6356752.3142451793;
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const e2 = 1 - (b * b) / (a * a);
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return {
    x: (n + height) * Math.cos(lat) * Math.cos(lon),
    y: (n + height) * Math.cos(lat) * Math.sin(lon),
    z: (n * (1 - e2) + height) * Math.sin(lat),
  };
}
