#!/usr/bin/env node
// Compares the WebAssembly module sections of two atmosphere dists after
// dropping the custom sections (sds.* metadata and the signature trailer).
// Usage: node compare-dist-sections.mjs <old.wasm> <new.wasm>
// Exit 0 when every non-custom section is byte-identical, 1 otherwise.
import { readFileSync } from 'node:fs';

const NAMES = {
  0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory',
  6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data',
  12: 'datacount', 13: 'tag',
};

function leb(b, p) {
  let r = 0, s = 0, x;
  do { x = b[p.i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
  return r;
}

export function sections(path) {
  let b = readFileSync(path);
  // Publication trailer: record collection, u32le length, magic "$REC".
  if (b.length >= 8 && b.subarray(b.length - 4).toString('latin1') === '$REC') {
    b = b.subarray(0, b.length - 8 - b.readUInt32LE(b.length - 8));
  }
  const p = { i: 8 };
  const out = [];
  while (p.i < b.length) {
    const id = b[p.i++];
    const size = leb(b, p);
    const start = p.i;
    let name = NAMES[id] ?? `id${id}`;
    if (id === 0) {
      const q = { i: start };
      const n = leb(b, q);
      name = `custom:${b.subarray(q.i, q.i + n).toString('utf8')}`;
    }
    out.push({ id, name, size, bytes: b.subarray(start, start + size) });
    p.i = start + size;
  }
  return out;
}

function codeBodies(sec) {
  const p = { i: 0 };
  const count = leb(sec, p);
  const bodies = [];
  for (let k = 0; k < count; k++) {
    const n = leb(sec, p);
    bodies.push(sec.subarray(p.i, p.i + n));
    p.i += n;
  }
  return bodies;
}

if (process.argv[1] && process.argv[1].endsWith('compare-dist-sections.mjs')) {
  const [a, b] = process.argv.slice(2);
  const sa = sections(a).filter((s) => s.id !== 0);
  const sb = sections(b).filter((s) => s.id !== 0);
  let differs = false;
  for (const s of [...sections(a), ...sections(b)].filter((x) => x.id === 0)) void s;
  const ids = [...new Set([...sa, ...sb].map((s) => s.id))].sort((x, y) => x - y);
  for (const id of ids) {
    const x = sa.find((s) => s.id === id);
    const y = sb.find((s) => s.id === id);
    const same = x && y && Buffer.compare(x.bytes, y.bytes) === 0;
    console.log(`${NAMES[id]}: old=${x?.size ?? '-'} new=${y?.size ?? '-'} ${same ? 'identical' : 'DIFFERENT'}`);
    if (!same) {
      differs = true;
      if (id === 10 && x && y) {
        const ba = codeBodies(x.bytes), bb = codeBodies(y.bytes);
        let diff = 0;
        const n = Math.max(ba.length, bb.length);
        const list = [];
        for (let k = 0; k < n; k++) {
          if (!ba[k] || !bb[k] || Buffer.compare(ba[k], bb[k]) !== 0) { diff++; if (list.length < 40) list.push(k); }
        }
        console.log(`  functions old=${ba.length} new=${bb.length} differing bodies=${diff} first indices=${list.join(',')}`);
      }
    }
  }
  console.log('custom sections old:', sections(a).filter((s) => s.id === 0).map((s) => `${s.name}(${s.size})`).join(' '));
  console.log('custom sections new:', sections(b).filter((s) => s.id === 0).map((s) => `${s.name}(${s.size})`).join(' '));
  process.exit(differs ? 1 : 0);
}
