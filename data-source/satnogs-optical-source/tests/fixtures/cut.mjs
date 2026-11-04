#!/usr/bin/env node
// Cuts the E2E fixture from a captured SatNOGS Optical dump: the rows of one object in one session's measurements.parquet,
// every column, written as a Parquet file (one row group, PLAIN values, uncompressed data pages v1, every column optional as
// in the source). Values are copied, never edited; the source's satnogs_optical key-value metadata is kept verbatim.
//   node tests/fixtures/cut.mjs <measurements.parquet> <NORAD> <out.parquet>
import fs from 'node:fs';
import { readParquet } from '../parquet.mjs';

const [source, norad, out] = process.argv.slice(2);
const file = readParquet(source);
const keep = file.columns.correlation_object_norad_id.map((v, i) => (v === Number(norad) ? i : -1)).filter((i) => i >= 0);

// Thrift compact protocol writer (the subset FileMetaData and PageHeader need).
class Writer {
  constructor() { this.bytes = []; this.last = [0]; }
  varint(v) { let x = BigInt(v); do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; this.bytes.push(b); } while (x); }
  zigzag(v) { const x = BigInt(v); this.varint(x >= 0n ? x << 1n : ((-x) << 1n) - 1n); }
  header(id, type) { const d = id - this.last[this.last.length - 1]; if (d > 0 && d < 16) this.bytes.push((d << 4) | type); else { this.bytes.push(type); this.zigzag(id); } this.last[this.last.length - 1] = id; }
  i32(id, v) { this.header(id, 5); this.zigzag(v); }
  i64(id, v) { this.header(id, 6); this.zigzag(v); }
  bool(id, v) { this.header(id, v ? 1 : 2); }
  bin(id, v) { const b = typeof v === 'string' ? Buffer.from(v) : v; this.header(id, 8); this.varint(b.length); this.bytes.push(...b); }
  struct(id, fill) { this.header(id, 12); this.last.push(0); fill(this); this.bytes.push(0); this.last.pop(); }
  list(id, type, items, put) { this.header(id, 9); this.bytes.push(items.length < 15 ? (items.length << 4) | type : 0xf0 | type); if (items.length >= 15) this.varint(items.length); for (const x of items) put(this, x); }
  done() { this.bytes.push(0); return Buffer.from(this.bytes); }
}
const elem = (w, fill) => { w.last.push(0); fill(w); w.bytes.push(0); w.last.pop(); };

const meta = (() => {
  const raw = fs.readFileSync(source);
  const len = raw.readUInt32LE(raw.length - 8);
  return raw.subarray(raw.length - 8 - len, raw.length - 8);
})();
// The source schema, re-read for the physical types (readParquet decodes values, not the schema).
const { schema } = (() => {
  const b = new Uint8Array(meta); let p = 0;
  const vi = () => { let r = 0n, s = 0n; for (;;) { const x = b[p++]; r |= BigInt(x & 0x7f) << s; s += 7n; if (!(x & 0x80)) return r; } };
  const zz = () => { const v = vi(); return Number((v >> 1n) ^ -(v & 1n)); };
  const val = (t) => { if (t === 1 || t === 2) return t === 1; if (t === 3) return b[p++]; if (t >= 4 && t <= 6) return zz(); if (t === 7) { p += 8; return 0; } if (t === 8) { const n = Number(vi()); const s = b.subarray(p, p + n); p += n; return Buffer.from(s).toString(); } if (t === 9) { const h = b[p++]; let n = h >> 4; if (n === 15) n = Number(vi()); return Array.from({ length: n }, () => val(h & 15)); } if (t === 12) return st(); throw new Error(`type ${t}`); };
  const st = () => { const o = {}; let last = 0; for (;;) { const h = b[p++]; if (!h) return o; const id = h >> 4 ? last + (h >> 4) : zz(); last = id; o[id] = val(h & 15); } };
  return { schema: st()[2] };
})();
const leaves = schema.slice(1);

const pages = [];
let offset = 4;
const chunks = leaves.map((s) => {
  const name = s[4]; const values = keep.map((i) => file.columns[name][i]);
  const n = values.length;
  const groups = Math.ceil(n / 8);
  const levels = [(groups << 1) | 1, ...Array.from({ length: groups }, (_, g) => values.slice(g * 8, g * 8 + 8).reduce((a, v, k) => a | ((v === null ? 0 : 1) << k), 0))];
  const present = values.filter((v) => v !== null);
  const parts = [];
  if (s[1] === 0) parts.push(Buffer.from(Array.from({ length: Math.ceil(present.length / 8) }, (_, g) => present.slice(g * 8, g * 8 + 8).reduce((a, v, k) => a | ((v ? 1 : 0) << k), 0))));
  for (const v of s[1] === 0 ? [] : present) {
    if (s[1] === 1) { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); }
    else if (s[1] === 2) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); }
    else if (s[1] === 5) { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); }
    else if (s[1] === 6) { const t = Buffer.from(v); const b = Buffer.alloc(4); b.writeUInt32LE(t.length); parts.push(b, t); }
    else throw new Error(`physical type ${s[1]}`);
  }
  const levelBytes = Buffer.from(levels);
  const lenPrefix = Buffer.alloc(4); lenPrefix.writeUInt32LE(levelBytes.length);
  const body = Buffer.concat([lenPrefix, levelBytes, ...parts]);
  const h = new Writer();
  h.i32(1, 0); h.i32(2, body.length); h.i32(3, body.length);
  h.struct(5, (d) => { d.i32(1, n); d.i32(2, 0); d.i32(3, 3); d.i32(4, 3); });
  const page = Buffer.concat([h.done(), body]);
  const at = offset; offset += page.length; pages.push(page);
  return { name, type: s[1], n, at, size: page.length };
});

const f = new Writer();
f.i32(1, 1);
f.list(2, 12, schema, (w, s) => elem(w, (e) => {
  if (s[1] !== undefined) e.i32(1, s[1]);
  if (s[3] !== undefined) e.i32(3, s[3]);
  e.bin(4, s[4]);
  if (s[5] !== undefined) e.i32(5, s[5]);
  if (s[6] !== undefined) e.i32(6, s[6]);
  if (s[10] && s[10][1]) e.struct(10, (l) => l.struct(1, () => {}));
  if (s[10] && s[10][8]) e.struct(10, (l) => l.struct(8, (t) => { t.bool(1, s[10][8][1]); t.struct(2, (u) => u.struct(s[10][8][2][1] ? 1 : s[10][8][2][2] ? 2 : 3, () => {})); }));
}));
f.i64(3, keep.length);
f.list(4, 12, [0], (w) => elem(w, (g) => {
  g.list(1, 12, chunks, (cw, c) => elem(cw, (cc) => {
    cc.i64(2, c.at);
    cc.struct(3, (m) => { m.i32(1, c.type); m.list(2, 5, [0, 3], (lw, x) => lw.zigzag(x)); m.list(3, 8, [c.name], (lw, x) => { const b = Buffer.from(x); lw.varint(b.length); lw.bytes.push(...b); }); m.i32(4, 0); m.i64(5, c.n); m.i64(6, c.size); m.i64(7, c.size); m.i64(9, c.at); });
  }));
  g.i64(2, chunks.reduce((a, c) => a + c.size, 0));
  g.i64(3, keep.length);
}));
f.list(5, 12, [['satnogs_optical', file.keyValue.satnogs_optical]], (w, [k, v]) => elem(w, (e) => { e.bin(1, k); e.bin(2, v); }));
f.bin(6, 'data-source/satnogs-optical-source tests/fixtures/cut.mjs');
const footer = f.done();
const len = Buffer.alloc(4); len.writeUInt32LE(footer.length);
fs.writeFileSync(out, Buffer.concat([Buffer.from('PAR1'), ...pages, footer, len, Buffer.from('PAR1')]));
console.log(`${keep.length} rows of NORAD ${norad} from ${source} -> ${out}`);
