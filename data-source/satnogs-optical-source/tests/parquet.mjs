// A Parquet reader for the E2E harness (a file-format reader, not physics): the footer (Thrift compact protocol), one or
// more row groups, data pages v1 and v2, PLAIN and RLE_DICTIONARY values, RLE/bit-packed definition levels, UNCOMPRESSED
// and SNAPPY pages. Flat schemas only (the SatNOGS Optical measurements file: every column optional, no repetition).
// Authority: the Apache Parquet format specification (parquet.thrift, Encodings.md).
import fs from 'node:fs';

class Thrift {
  constructor(bytes, at = 0) { this.b = bytes; this.p = at; }
  varint() { let r = 0n, s = 0n; for (;;) { const x = this.b[this.p++]; r |= BigInt(x & 0x7f) << s; s += 7n; if (!(x & 0x80)) return r; } }
  zigzag() { const v = this.varint(); return (v >> 1n) ^ -(v & 1n); }
  value(type) {
    switch (type) {
      case 1: return true;
      case 2: return false;
      case 3: return (this.b[this.p++] << 24) >> 24;
      case 4: case 5: case 6: { const v = this.zigzag(); return type === 6 ? v : Number(v); }
      case 7: { const d = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8).getFloat64(0, true); this.p += 8; return d; }
      case 8: { const n = Number(this.varint()); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
      case 9: case 10: {
        const h = this.b[this.p++]; let n = h >> 4; const t = h & 15;
        if (n === 15) n = Number(this.varint());
        const out = [];
        for (let i = 0; i < n; i++) out.push(t === 1 || t === 2 ? this.b[this.p++] === 1 : this.value(t));
        return out;
      }
      case 12: return this.struct();
      default: throw new Error(`parquet: Thrift type ${type} is not read`);
    }
  }
  struct() {
    const o = {}; let last = 0;
    for (;;) {
      const h = this.b[this.p++];
      if (h === 0) return o;
      const delta = h >> 4; const id = delta ? last + delta : Number(this.zigzag());
      last = id; o[id] = this.value(h & 15);
    }
  }
}

// Snappy raw block format (google/snappy format_description.txt).
function unsnappy(src) {
  let p = 0, n = 0, s = 0;
  for (;;) { const x = src[p++]; n |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) break; }
  const out = new Uint8Array(n); let o = 0;
  while (p < src.length) {
    const tag = src[p++]; const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) { const k = len - 59; len = 0; for (let i = 0; i < k; i++) len |= src[p++] << (8 * i); }
      len += 1; out.set(src.subarray(p, p + len), o); p += len; o += len; continue;
    }
    let len, off;
    if (kind === 1) { len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
    else if (kind === 2) { len = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { len = (tag >> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
    if (!off || off > o) throw new Error('parquet: corrupt snappy copy');
    for (let i = 0; i < len; i++, o++) out[o] = out[o - off];
  }
  if (o !== n) throw new Error('parquet: snappy length mismatch');
  return out;
}

// RLE / bit-packed hybrid (Encodings.md), `count` values of `width` bits.
function hybrid(bytes, at, end, width, count) {
  const out = new Array(count); let i = 0, p = at;
  const byteWidth = (width + 7) >> 3;
  while (i < count && p < end) {
    let h = 0, s = 0; for (;;) { const x = bytes[p++]; h += (x & 0x7f) * 2 ** s; s += 7; if (!(x & 0x80)) break; }
    if (h % 2 === 0) {
      const run = h / 2; let v = 0; for (let k = 0; k < byteWidth; k++) v += bytes[p++] * 2 ** (8 * k);
      for (let k = 0; k < run && i < count; k++) out[i++] = v;
    } else {
      const groups = (h - 1) / 2; let bit = 0; const base = p;
      for (let k = 0; k < groups * 8; k++) {
        let v = 0;
        for (let b = 0; b < width; b++, bit++) v += ((bytes[base + (bit >> 3)] >> (bit & 7)) & 1) * 2 ** b;
        if (i < count) out[i++] = v;
      }
      p = base + groups * width;
    }
  }
  if (i !== count) throw new Error('parquet: short RLE run');
  return out;
}

const decoder = new TextDecoder();
function plain(type, bytes, at, count, typeLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(count); let p = at;
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 0: out[i] = ((bytes[at + (i >> 3)] >> (i & 7)) & 1) === 1; break;
      case 1: out[i] = view.getInt32(p, true); p += 4; break;
      case 2: out[i] = view.getBigInt64(p, true); p += 8; break;
      case 4: out[i] = view.getFloat32(p, true); p += 4; break;
      case 5: out[i] = view.getFloat64(p, true); p += 8; break;
      case 6: { const n = view.getUint32(p, true); p += 4; out[i] = bytes.subarray(p, p + n); p += n; break; }
      case 7: out[i] = bytes.subarray(p, p + typeLength); p += typeLength; break;
      default: throw new Error(`parquet: physical type ${type} is not read`);
    }
  }
  return out;
}

function inflate(codec, bytes) {
  if (codec === 0) return bytes;
  if (codec === 1) return unsnappy(bytes);
  throw new Error(`parquet: compression codec ${codec} is not read`);
}

// Reads every column of a flat Parquet file: { rows, columns: { name: values[] }, keyValue: { key: value } }. Strings
// (BYTE_ARRAY with a STRING annotation) decode to text, INT64 timestamps stay BigInt (their unit is in `units`), null for
// an undefined value.
export function readParquet(path) {
  const file = new Uint8Array(fs.readFileSync(path));
  const tail = decoder.decode(file.subarray(file.length - 4));
  if (tail !== 'PAR1' || decoder.decode(file.subarray(0, 4)) !== 'PAR1') throw new Error(`parquet: ${path} is not a Parquet file`);
  const length = new DataView(file.buffer).getUint32(file.length - 8, true);
  const meta = new Thrift(file, file.length - 8 - length).struct();
  const schema = meta[2];
  const leaves = schema.slice(1);
  if (leaves.some((s) => s[5] || s[3] === 2)) throw new Error('parquet: only flat, non-repeated schemas are read');
  const names = leaves.map((s) => decoder.decode(s[4]));
  const isString = leaves.map((s) => s[6] === 0 || (s[10] && s[10][1] !== undefined));
  const units = {};
  leaves.forEach((s, k) => {
    const t = s[10] && s[10][8];
    if (t) units[names[k]] = t[2] && (t[2][1] ? 'ms' : t[2][2] ? 'us' : t[2][3] ? 'ns' : '');
  });
  const columns = Object.fromEntries(names.map((n) => [n, []]));
  for (const group of meta[4]) {
    group[1].forEach((chunk, k) => {
      const m = chunk[3]; const type = m[1]; const codec = m[4]; const total = Number(m[5]);
      const optional = leaves[k][3] === 1;
      let p = Number(m[11] ?? m[9]); const out = columns[names[k]];
      let dictionary = null, read = 0;
      while (read < total) {
        const t = new Thrift(file, p); const h = t.struct(); p = t.p;
        const compressed = h[3]; const body = file.subarray(p, p + compressed); p += compressed;
        if (h[1] === 2) { const d = h[7]; dictionary = plain(type, inflate(codec, body), 0, d[1], leaves[k][2]); continue; }
        let levels, values, n, encoding, at;
        if (h[1] === 0) {
          const d = h[5]; n = d[1]; encoding = d[2];
          values = inflate(codec, body); at = 0;
          if (optional) {
            const len = new DataView(values.buffer, values.byteOffset).getUint32(0, true);
            levels = hybrid(values, 4, 4 + len, 1, n); at = 4 + len;
          }
        } else if (h[1] === 3) {
          const d = h[8]; n = d[1]; encoding = d[4];
          const defLen = d[5], repLen = d[6];
          if (repLen) throw new Error('parquet: repetition levels are not read');
          if (optional) levels = hybrid(body, 0, defLen, 1, n);
          const compressedValues = d[7] === undefined ? true : d[7];
          values = compressedValues ? inflate(codec, body.subarray(defLen)) : body.subarray(defLen); at = 0;
        } else throw new Error(`parquet: page type ${h[1]} is not read`);
        const present = levels ? levels.reduce((a, v) => a + v, 0) : n;
        let decoded;
        if (encoding === 0) decoded = plain(type, values, at, present, leaves[k][2]);
        else if (encoding === 8 || encoding === 2) {
          const width = values[at];
          decoded = hybrid(values, at + 1, values.length, width, present).map((i) => dictionary[i]);
        } else if (encoding === 3 && type === 0) {
          const len = new DataView(values.buffer, values.byteOffset + at).getUint32(0, true);
          decoded = hybrid(values, at + 4, at + 4 + len, 1, present).map((v) => v === 1);
        } else throw new Error(`parquet: encoding ${encoding} is not read`);
        let j = 0;
        for (let i = 0; i < n; i++) {
          if (levels && levels[i] === 0) { out.push(null); continue; }
          const v = decoded[j++];
          out.push(isString[k] && v instanceof Uint8Array ? decoder.decode(v) : v);
        }
        read += n;
      }
    });
  }
  const keyValue = Object.fromEntries((meta[5] ?? []).map((e) => [decoder.decode(e[1]), e[2] ? decoder.decode(e[2]) : null]));
  return { rows: Number(meta[3]), columns, units, keyValue };
}
