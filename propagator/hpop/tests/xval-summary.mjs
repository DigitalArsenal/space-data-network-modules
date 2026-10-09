#!/usr/bin/env node
// The cross-validation table: for every case of fixtures/xval/xval-cases.json,
// the largest 3D position difference over 24 h between HPOP (the shipped
// WASM through the SDK's browser harness) and each reference tool, and
// between every pair of tools (the spread among established codes).
//
//   node tests/xval-summary.mjs [out.json]
//
// Prints Markdown tables (docs/cross-validation.md quotes them) and writes the
// numbers as JSON (default tests/evidence/xval/summary.json).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { residentHarness, wasmPath } from './lib/residentRuntime.mjs';
import { CASES, TOOLS, difference, hpopInputs, hpopSamples } from './lib/xvalCases.mjs';

const out = process.argv[2] ?? new URL('./evidence/xval/summary.json', import.meta.url).pathname;
const harness = await residentHarness('browser');
const rows = [];
try {
  for (const name of CASES) {
    const row = { case: name, hpop: {}, pairs: {} };
    const runs = new Map();  // one HPOP run per distinct request (GMAT drag is Jacchia-Roberts)
    for (const tool of TOOLS) {
      const c = tool.cases.get(name);
      if (!c) continue;
      const key = c.atmosphere ?? 'NRLMSISE00';
      if (!runs.has(key)) {
        const response = await harness.invoke({ methodId: 'invoke', inputs: hpopInputs(c) });
        if (response.statusCode !== 0) throw new Error(`${name}: ${response.errorCode}: ${response.errorMessage}`);
        runs.set(key, hpopSamples(c, response));
      }
      row.hpop[tool.id] = { ...difference(runs.get(key), c.samples), ...(c.atmosphere ? { atmosphere: c.atmosphere } : {}) };
    }
    for (let i = 0; i < TOOLS.length; ++i) for (let j = i + 1; j < TOOLS.length; ++j) {
      const a = TOOLS[i].cases.get(name), b = TOOLS[j].cases.get(name);
      if (!a || !b || (a.atmosphere ?? 'NRLMSISE00') !== (b.atmosphere ?? 'NRLMSISE00')) continue;
      row.pairs[`${TOOLS[i].id}/${TOOLS[j].id}`] = difference(a.samples, b.samples);
    }
    rows.push(row);
    console.error(`${name} done`);
  }
} finally {
  await harness.destroy();
}

const m = (x) => (x === undefined ? 'n/a' : x.worst < 1 ? `${(x.worst * 1000).toFixed(x.worst < 0.01 ? 2 : 1)} mm` : `${x.worst.toFixed(x.worst < 100 ? 2 : 0)} m`);
const pairIds = [...new Set(rows.flatMap((r) => Object.keys(r.pairs)))];
console.log(`| Case | ${TOOLS.map((t) => `HPOP - ${t.label}`).join(' | ')} |`);
console.log(`|---|${TOOLS.map(() => '---:').join('|')}|`);
for (const r of rows) console.log(`| ${r.case} | ${TOOLS.map((t) => `${m(r.hpop[t.id])}${r.hpop[t.id]?.atmosphere ? ' (JR)' : ''}`).join(' | ')} |`);
console.log();
console.log(`| Case | ${pairIds.join(' | ')} | Spread |`);
console.log(`|---|${pairIds.map(() => '---:').join('|')}|---:|`);
for (const r of rows) {
  const spread = Math.max(...Object.values(r.pairs).map((p) => p.worst));
  console.log(`| ${r.case} | ${pairIds.map((p) => m(r.pairs[p])).join(' | ')} | ${m({ worst: spread })} |`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({
  about: 'Largest 3D position difference (m) over 24 h, hourly samples; HPOP (browser harness) against each tool, and tool against tool. tests/xval-summary.mjs.',
  hpopWasmSha256: createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
  tools: Object.fromEntries(TOOLS.map((t) => [t.id, t.set.source])),
  rows,
}, null, 1)}\n`);
