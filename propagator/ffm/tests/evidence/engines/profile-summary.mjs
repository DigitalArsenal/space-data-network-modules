#!/usr/bin/env node
// Self and inclusive time by function from V8 .cpuprofile files (node
// --cpu-prof), for a WebAssembly build that keeps its name section.
//
//   node tests/evidence/engines/profile-summary.mjs <profile.cpuprofile ...> [--top 40] [--match TEXT]
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '40' }, match: { type: 'string' } } });
const self = new Map(), inclusive = new Map();
let total = 0;
for (const file of positionals) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const dt = (p.endTime - p.startTime) / p.samples.length / 1e6;
  for (const id of p.samples) {
    const n = byId.get(id);
    const name = (x) => x.callFrame.functionName || `(${x.callFrame.url.split('/').pop()}:${x.callFrame.lineNumber})`;
    self.set(name(n), (self.get(name(n)) ?? 0) + dt);
    total += dt;
    const seen = new Set();
    for (let k = id; k !== undefined; k = parent.get(k)) {
      const f = name(byId.get(k));
      if (seen.has(f)) continue;
      seen.add(f);
      inclusive.set(f, (inclusive.get(f) ?? 0) + dt);
    }
  }
}
const top = Number(o.top);
const rows = (m) => [...m.entries()].filter(([k]) => !o.match || k.includes(o.match)).sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`total sampled ${total.toFixed(2)} s\n\nself time:`);
for (const [k, v] of rows(self)) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${v.toFixed(2).padStart(8)} s  ${k}`);
console.log('\ninclusive time:');
for (const [k, v] of rows(inclusive)) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${v.toFixed(2).padStart(8)} s  ${k}`);
