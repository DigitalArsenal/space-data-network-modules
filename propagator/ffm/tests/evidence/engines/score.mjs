#!/usr/bin/env node
// The engine benchmark's tables from the drivers' outputs in <work dir>
// (ffm.json, orekit.json, gmat.json, tudat.json, nyx.json, basilisk*.json):
// CPU seconds per object-day with each engine's integrator, tolerance and
// step; microseconds per force evaluation where the engine reports its
// evaluations; and the largest 3D position difference over the 3 days from
// FFM's converged run of the same orbit and force tier (RKDP87, relative
// tolerance 1e-14, steps <= 120 s), and from the engine's own run at that
// setting (its integration error at the looser settings).
//
//   node tests/evidence/engines/score.mjs <work dir> [--json summary.json]
//
// Arithmetic on recorded numbers only.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'string' } } });
const work = path.resolve(positionals[0]);
const plan = JSON.parse(fs.readFileSync(path.join(work, 'plan.json'), 'utf8'));
const files = fs.readdirSync(work).filter((f) => /^(ffm|orekit|gmat|tudat|nyx|basilisk[\w-]*)\.json$/.test(f));
const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')));
const rows = docs.flatMap((d) => d.results.map((r) => ({ ...r, version: d.version, runtime: d.runtime,
  key: `${r.engine}${r.algorithm ? ` ${r.algorithm}` : ''}` })));
const maxDiff = (a, b) => {
  if (!a || !b) return null;
  let m = 0;
  for (let i = 1; i < Math.min(a.length, b.length); ++i) {
    if (Math.abs(a[i][0] - b[i][0]) > 1e-3) throw new Error(`sample ${i}: ${a[i][0]} vs ${b[i][0]}`);
    m = Math.max(m, Math.hypot(a[i][1] - b[i][1], a[i][2] - b[i][2], a[i][3] - b[i][3]));
  }
  return m;
};
const find = (key, orbit, tier, integrator) => rows.find((r) => r.key === key && r.orbit === orbit && r.tier === tier && r.integrator === integrator);
const REF = 'tol1e-14-max120s';
for (const r of rows) {
  r.vsFfm = maxDiff(r.samples, find('FFM RKDP87', r.orbit, r.tier, REF)?.samples);
  r.vsOwn = r.integrator === REF ? null : maxDiff(r.samples, find(r.key, r.orbit, r.tier, REF)?.samples);
  r.evaluations ??= r.evaluations3d ?? null;
  r.usPerEvaluation ??= r.evaluations && r.cpuS3d ? null : null;
}

const fmt = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x >= 1000 ? x.toFixed(0) : x >= 100 ? x.toFixed(1) : x.toFixed(d));
const m = (x) => (x === null || x === undefined ? '—' : x < 0.001 ? '<0.001' : x >= 1000 ? `${(x / 1000).toFixed(1)} km` : x.toFixed(3));
const ORDER = ['FFM RK78', 'FFM RKDP87', 'Orekit', 'GMAT', 'Tudat', 'Nyx', 'Basilisk'];
const keys = [...new Set(rows.map((r) => r.key))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
const integrators = [...new Set(rows.map((r) => r.integrator))];
const lines = [];
for (const tier of plan.tiers) {
  for (const integ of integrators) {
    const present = keys.filter((k) => plan.orbits.some((orbit) => find(k, orbit, tier, integ)));
    if (!present.length) continue;
    lines.push(`\n### ${tier}, ${integ}\n`);
    lines.push(`| Engine | method | ${plan.orbits.map((x) => `${x} CPU-s/obj-day`).join(' | ')} | LEO400 us/eval | max 3-day |dr| from FFM ref, m (${plan.orbits.join(', ')}) | own integration error vs own ${REF}, m (LEO400, GPS) |`);
    lines.push(`|${'---|'.repeat(5 + plan.orbits.length)}`);
    for (const k of present) {
      const cells = plan.orbits.map((orbit) => find(k, orbit, tier, integ));
      const leo = cells[0];
      lines.push(`| ${k} | ${(cells.find(Boolean)?.method ?? '').replace(/\|/g, '/')} | ${cells.map((c) => fmt(c?.cpuSPerObjectDay, 4)).join(' | ')} | ${fmt(leo?.usPerEvaluation, 2)} | ${cells.map((c) => m(c?.vsFfm)).join(', ')} | ${m(leo?.vsOwn)}, ${m(cells[2]?.vsOwn)} |`);
    }
  }
}
console.log(lines.join('\n'));
if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ plan: { epochUtc: plan.epochUtc, days: plan.days, tiers: plan.tiers, integrators: plan.integrators },
  engines: docs.map((d) => ({ engine: d.engine, version: d.version, runtime: d.runtime })),
  rows: rows.map(({ samples, ...r }) => r) }, null, 1)}\n`);
