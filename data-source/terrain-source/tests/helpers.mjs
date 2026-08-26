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

// General little-endian TIFF writer: single-band Float32 (the elevation lane)
// or single-band uint8 (the categorical water-body lane), strip or TILED
// layout with a REAL multi-chunk grid, predictor 1/2/3, DEFLATE or none.
//
// The multi-chunk grid is the point: a single-chunk granule cannot tell a
// windowed decoder from a whole-granule one, so every windowing assertion in
// this suite is written against a granule with many internal chunks.
export function buildGeoTiff({
  width = 64,
  height = 64,
  originLon,
  originLat,
  scaleLon,
  scaleLat,
  heightFn, // (px, py) -> metres, float32 lane
  classFn, // (px, py) -> 0..255 category, uint8 lane
  layout = "strip", // "strip" | "tile"
  predictor = 1, // 1 | 2 (uint8) | 3 (float32)
  tileWidth, // layout "tile": internal tile grid (default: the whole image)
  tileHeight,
  rowsPerStrip, // layout "strip" (default: the whole image)
  compression = 8, // 8 = DEFLATE, 1 = none
}) {
  const isMask = typeof classFn === "function";
  const sampleBytes = isMask ? 1 : 4;

  const sampleAt = (px, py) => {
    const cx = Math.min(Math.max(px, 0), width - 1);
    const cy = Math.min(Math.max(py, 0), height - 1);
    return isMask ? classFn(cx, cy) & 0xff : Math.fround(heightFn(cx, cy));
  };

  // One chunk of chunkW x chunkH samples starting at (x0, y0), predictor-encoded.
  const chunkBytes = (x0, y0, chunkW, chunkH) => {
    const rowBytes = chunkW * sampleBytes;
    const out = Buffer.alloc(rowBytes * chunkH);
    for (let r = 0; r < chunkH; r++) {
      const raw = Buffer.alloc(rowBytes);
      for (let c = 0; c < chunkW; c++) {
        const v = sampleAt(x0 + c, y0 + r);
        if (isMask) raw[c] = v;
        else raw.writeFloatLE(v, c * 4);
      }
      let encoded;
      if (!isMask && predictor === 3) {
        const planes = Buffer.alloc(rowBytes);
        for (let c = 0; c < chunkW; c++) {
          planes[c] = raw[c * 4 + 3]; // MSB plane first
          planes[chunkW + c] = raw[c * 4 + 2];
          planes[chunkW * 2 + c] = raw[c * 4 + 1];
          planes[chunkW * 3 + c] = raw[c * 4];
        }
        encoded = Buffer.alloc(rowBytes);
        encoded[0] = planes[0];
        for (let i = 1; i < rowBytes; i++) encoded[i] = (planes[i] - planes[i - 1]) & 0xff;
      } else if (isMask && predictor === 2) {
        encoded = Buffer.alloc(rowBytes);
        encoded[0] = raw[0];
        for (let i = 1; i < rowBytes; i++) encoded[i] = (raw[i] - raw[i - 1]) & 0xff;
      } else {
        encoded = raw;
      }
      encoded.copy(out, r * rowBytes);
    }
    return compression === 8 ? zlib.deflateSync(out, { level: 6 }) : out;
  };

  const chunks = [];
  const tw = layout === "tile" ? (tileWidth ?? width) : width;
  const th = layout === "tile" ? (tileHeight ?? height) : (rowsPerStrip ?? height);
  if (layout === "tile") {
    const across = Math.ceil(width / tw);
    const down = Math.ceil(height / th);
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) chunks.push(chunkBytes(tx * tw, ty * th, tw, th));
    }
  } else {
    for (let y0 = 0; y0 < height; y0 += th) {
      chunks.push(chunkBytes(0, y0, width, Math.min(th, height - y0)));
    }
  }

  const SHORT = 3;
  const LONG = 4;
  const DOUBLE = 12;
  // Tag values are either inline (<= 4 bytes) or an offset into the extra area.
  const tags = [];
  const tag = (id, type, values) => tags.push({ id, type, values: [].concat(values) });

  tag(256, LONG, width);
  tag(257, LONG, height);
  tag(258, SHORT, isMask ? 8 : 32);
  tag(259, SHORT, compression);
  tag(277, SHORT, 1);
  if (layout === "tile") {
    tag(317, SHORT, predictor);
    tag(322, SHORT, tw);
    tag(323, SHORT, th);
    tag(324, LONG, chunks.map(() => 0)); // offsets, patched below
    tag(325, LONG, chunks.map((c) => c.length));
  } else {
    tag(273, LONG, chunks.map(() => 0)); // offsets, patched below
    tag(278, LONG, th);
    tag(279, LONG, chunks.map((c) => c.length));
    tag(317, SHORT, predictor);
  }
  tag(339, SHORT, isMask ? 1 : 3);
  tag(33550, DOUBLE, [scaleLon, scaleLat, 0]);
  tag(33922, DOUBLE, [0, 0, 0, originLon, originLat, 0]);
  tags.sort((a, b) => a.id - b.id);

  const typeSize = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
  const ifdBytes = 2 + tags.length * 12 + 4;
  // Extra area: out-of-line tag values first, then the chunk data.
  let cursor = 8 + ifdBytes;
  for (const t of tags) {
    const bytes = typeSize[t.type] * t.values.length;
    if (bytes > 4) {
      t.offset = cursor;
      cursor += bytes;
    }
  }
  const chunkOffsets = [];
  for (const c of chunks) {
    chunkOffsets.push(cursor);
    cursor += c.length;
  }
  const offsetTag = tags.find((t) => t.id === (layout === "tile" ? 324 : 273));
  offsetTag.values = chunkOffsets;

  const file = Buffer.alloc(cursor);
  file.write("II", 0, "latin1");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(8, 4);
  file.writeUInt16LE(tags.length, 8);
  const writeValues = (t, at) => {
    t.values.forEach((v, i) => {
      if (t.type === SHORT) file.writeUInt16LE(v, at + i * 2);
      else if (t.type === LONG) file.writeUInt32LE(v, at + i * 4);
      else file.writeDoubleLE(v, at + i * 8);
    });
  };
  tags.forEach((t, n) => {
    const at = 10 + n * 12;
    file.writeUInt16LE(t.id, at);
    file.writeUInt16LE(t.type, at + 2);
    file.writeUInt32LE(t.values.length, at + 4);
    const bytes = typeSize[t.type] * t.values.length;
    if (bytes > 4) {
      file.writeUInt32LE(t.offset, at + 8);
      writeValues(t, t.offset);
    } else {
      writeValues(t, at + 8);
    }
  });
  chunks.forEach((c, i) => c.copy(file, chunkOffsets[i]));
  return file;
}

// The water-body granule the mask lane classifies: single-band uint8, source
// convention 0 = no water and any non-zero class a water body.
export function buildWaterTiff(options) {
  return buildGeoTiff({ ...options, heightFn: undefined });
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
