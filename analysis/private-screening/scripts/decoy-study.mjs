#!/usr/bin/env node
// How well decoy orbits hide a real one, measured on real histories.
//
//   node scripts/decoy-study.mjs [--archive DIR] [--from 2026-08-02] [--to 2026-08-29]
//     [--hpop-from 2026-08-09] [--hpop-days 14] [--objects 3000] [--seed 1]
//     [--generators independent,rotated,resampled,chained,aligned] [--donors population|regime]
//     [--workers N] [--skip-hpop | --reuse-hpop] [--out DIR]
//
// 1. Population: LEO payloads (perigee below 2,000 km, e below 0.1) with SGP4
//    element sets through [from, to], a seeded random sample of --objects.
//    Each is a target, and the others are the public catalog.
// 2. Decoys: one per target per generator (decoys), drawn from the others.
// 3. GP view: features of the element sets over the HPOP days.
// 4. HPOP view: every history as its owner would publish it. Each day's
//    window starts from the latest element set (analysis/epoch-state GCRF
//    state, propagator/hpop resident): 8 states over one orbit from the
//    window start and the state at the next window's start.
// 5. distinguish, per view and generator.
// Element sets and features stay on this machine; decoy-study.json holds
// aggregates only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { readSets, shiftDay } from '../../gp-error-model/scripts/archive.mjs';
import { epochStates, propagateArcs, unixSeconds } from '../../gp-error-model/scripts/hpop.mjs';

const { values: args } = parseArgs({ options: {
  archive: { type: 'string', default: '/opt/data/sdn-archive/spacetrack/gp_history/by-creation' },
  from: { type: 'string', default: '2026-08-02' }, to: { type: 'string', default: '2026-08-29' },
  'hpop-from': { type: 'string', default: '2026-08-09' }, 'hpop-days': { type: 'string', default: '14' },
  objects: { type: 'string', default: '3000' }, seed: { type: 'string', default: '1' },
  generators: { type: 'string', default: 'independent,rotated,resampled,chained,aligned' },
  donors: { type: 'string', default: 'population' },
  workers: { type: 'string', default: String(Math.max(1, Math.min(12, os.availableParallelism() - 2))) },
  'skip-hpop': { type: 'boolean', default: false },
  'reuse-hpop': { type: 'boolean', default: false },
  out: { type: 'string', default: path.join(os.homedir(), '.cache', 'sdn-private-screening', 'decoy-study') },
} });
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const day = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;
const span = [day(args.from), day(shiftDay(args.to, 1))];
const hpopDays = Number(args['hpop-days']);
const hpopSpan = [day(args['hpop-from']), day(args['hpop-from']) + hpopDays * 86400];
if (!(hpopSpan[0] - 3 * 86400 >= span[0] && hpopSpan[1] <= span[1])) throw new Error('the HPOP days need 3 days of history before them, inside [from, to]');
const generators = args.generators.split(',');
const seed = Number(args.seed);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm')),
  manifest: JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
const json = (portId, value) => ({ portId, payload: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
async function call(methodId, inputs) {
  const r = await harness.invoke({ methodId, inputs });
  if (r.statusCode !== 0) throw new Error(`${methodId}: ${r.errorCode}: ${r.errorMessage}`);
  return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
}

// ── 1. population ──
const names = new Map();
const sets = readSets(args.archive, args.from, args.to, (norad, g) => {
  if (g.OBJECT_TYPE !== 'PAYLOAD' || !(Number(g.PERIAPSIS) < 2000) || !(Number(g.ECCENTRICITY) < 0.1)) return false;
  names.set(norad, g.OBJECT_NAME ?? '');
  return true;
});
const byObject = new Map();
for (let k = 0; k < sets.norad.length; ++k) {
  const t = unixSeconds(sets.epoch[k]);
  if (!(t >= span[0] && t < span[1])) continue;
  if (!byObject.has(sets.norad[k])) byObject.set(sets.norad[k], new Map());
  const list = byObject.get(sets.norad[k]);
  // Epochs within a second are one element set republished: the later copy wins.
  list.set(Math.round(t), [t, ...sets.values.map((v) => v[k])]);
}
const cls = (name) => (/^STARLINK/.test(name) ? 'starlink' : /^ONEWEB/.test(name) ? 'oneweb' : 'other');
const eligible = [...byObject.entries()].filter(([, list]) => {
  const t = [...list.values()].map((s) => s[0]);
  return t.length >= 14 && Math.min(...t) <= span[0] + 2 * 86400 && Math.max(...t) >= span[1] - 2 * 86400;
}).map(([norad]) => norad).sort((a, b) => a - b);
let state = seed >>> 0;   // mulberry32
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
for (let k = eligible.length - 1; k > 0; --k) {
  const j = Math.floor(random() * (k + 1));
  [eligible[k], eligible[j]] = [eligible[j], eligible[k]];
}
const chosen = eligible.slice(0, Number(args.objects)).sort((a, b) => a - b);
const FIELDS = ['t', 'n', 'e', 'i', 'raan', 'argp', 'ma', 'bstar'];
const reals = chosen.map((norad) => {
  const rows = [...byObject.get(norad).values()].sort((a, b) => a[0] - b[0]);
  return { id: String(norad), target: String(norad), role: 'real', cls: cls(names.get(norad)),
    ...Object.fromEntries(FIELDS.map((f, k) => [f, rows.map((r) => r[k])])) };
});
const classes = reals.reduce((m, r) => ((m[r.cls] = (m[r.cls] ?? 0) + 1), m), {});
console.log(`population: ${eligible.length} eligible LEO payloads, ${reals.length} sampled ${JSON.stringify(classes)}`);
fs.writeFileSync(path.join(out, 'population.json'), JSON.stringify({ objects: reals }));

// ── 2. decoys ──
const decoys = {};
const generation = {};
for (const g of generators) {
  const res = await call('decoys', [json('population', { objects: reals }),
    json('options', { generator: g, window: span, seed, donors: args.donors })]);
  decoys[g] = res.objects.map((o) => ({ ...o }));
  generation[g] = res.report;
  console.log(`decoys ${g}: ${res.report.decoys} (${res.report.refused} refused)`);
}

// ── 3. GP view ──
const report = { kind: 'decoy-indistinguishability', version: 1,
  population: { from: args.from, to: args.to, eligible: eligible.length, sampled: reals.length, classes, seed,
    selection: 'OBJECT_TYPE PAYLOAD, perigee below 2,000 km, e below 0.1, at least 14 element sets, the first within 2 days of the start and the last within 2 days of the end' },
  hpopDays: { from: args['hpop-from'], days: hpopDays }, donors: args.donors, generation, views: {} };
const strip = (r) => ({ ...r, features: r.features.map(({ name, aloneAuc, separation, gainShare }) => ({ name, aloneAuc, separation, gainShare })) });
async function views(name, histories, window) {
  const rows = {};
  for (const g of generators) {
    const f = await call('features', [json('histories', { objects: [...histories.real, ...histories[g]] }),
      json('options', { view: name.startsWith('gp') ? 'gp' : 'hpop', window })]);
    fs.writeFileSync(path.join(out, `features-${name}-${g}.json`), JSON.stringify(f));
    const result = await call('distinguish', [json('features', f), json('options', { seed })]);
    // An adversary who does not search public histories for a replayed sequence.
    const noReplay = await call('distinguish', [json('features', f), json('options', { seed, exclude: ['sequenceMatch'] })]);
    rows[g] = { counts: f.counts, ...strip(result), withoutSequenceMatch: strip(noReplay) };
    const first = Object.fromEntries(result.first.map((x) => [x.n, x.nEffective]));
    console.log(`${name} ${g}: AUC ${result.auc.toFixed(3)}, eps >= ${(result.epsilon.epsilonLowerBound95 ?? NaN).toFixed(2)}, ` +
      `N_eff at N=10/100/1000: ${[10, 100, 1000].map((n) => first[n]?.toFixed(1)).join('/')}; top: ` +
      result.features.slice(0, 3).map((x) => `${x.name} ${(100 * x.gainShare).toFixed(0)}%`).join(', ') +
      `; without sequenceMatch AUC ${noReplay.auc.toFixed(3)}, N_eff(100) ${noReplay.first.find((x) => x.n === 100)?.nEffective?.toFixed(1)}`);
  }
  report.views[name] = { window: window.map((t) => new Date(t * 1000).toISOString()), generators: rows };
}
await views('gp', { real: reals, ...decoys }, hpopSpan);
await views('gp-28d', { real: reals, ...decoys }, span);

// ── 4. HPOP view ──
const windowsFile = path.join(out, 'hpop-windows.json');
if (!args['skip-hpop'] && args['reuse-hpop']) {
  const cached = JSON.parse(fs.readFileSync(windowsFile, 'utf8'));
  report.hpop = cached.report;
  await views('hpop', cached.histories, hpopSpan);
} else if (!args['skip-hpop']) {
  const all = [...reals, ...generators.flatMap((g) => decoys[g])];
  const seeds = [], plans = [];
  all.forEach((h, index) => {
    for (let k = 0; k < hpopDays; ++k) {
      const start = hpopSpan[0] + k * 86400;
      let j = -1;
      for (let m = 0; m < h.t.length && h.t[m] <= start; ++m) j = m;
      if (j < 0 || h.t[j] < start - 3 * 86400) continue;
      const key = seeds.length;
      seeds.push({ key, epoch: h.t[j], values: FIELDS.slice(1).map((f) => h[f][j]) });
      const period = 86400 / h.n[j];
      const times = [...Array.from({ length: 8 }, (_, s) => start + (s * period) / 8), start + 86400];
      plans.push({ key, index, start, times });
    }
  });
  console.log(`HPOP view: ${all.length} histories, ${plans.length} windows`);
  const states = await epochStates(seeds);
  const iso = (t) => new Date(Math.round(t * 1000)).toISOString();
  const arcs = plans.filter((p) => states.has(p.key)).map((p) => ({ arc: p.key, norad: p.key, seed: states.get(p.key), targets: p.times.map(iso) }));
  const { results, seconds } = await propagateArcs(arcs, { variants: ['state'], workers: Number(args.workers) });
  const byKey = new Map(results.map((r) => [r.arc, r.samples]));
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const windows = all.map(() => []);
  let failed = 0;
  for (const p of plans) {
    const samples = byKey.get(p.key);
    if (!samples || samples.some((s) => !s.state)) { ++failed; continue; }
    windows[p.index].push({ t: p.start, samples: samples.slice(0, 8).map((s, j) => [p.times[j], ...s.state.map(round)]),
      end: [p.times[8], ...samples[8].state.map(round)] });
  }
  console.log(`HPOP: ${arcs.length} windows propagated in ${seconds.toFixed(0)} s, ${failed} failed or refused`);
  report.hpop = { windows: plans.length, propagated: arcs.length, failed, seconds: Math.round(seconds),
    product: 'analysis/epoch-state GCRF state at the latest element set, propagated by propagator/hpop resident (point mass and degree/order 20 field)' };
  const hpop = { real: reals.map((r, k) => ({ id: r.id, target: r.target, role: 'real', cls: r.cls, windows: windows[k] })) };
  let at = reals.length;
  for (const g of generators) {
    hpop[g] = decoys[g].map((d) => ({ id: d.id, target: d.target, role: 'decoy', generator: g, windows: windows[at++] }));
  }
  fs.writeFileSync(windowsFile, JSON.stringify({ report: report.hpop, histories: hpop }));
  await views('hpop', hpop, hpopSpan);
}
await harness.destroy();
fs.writeFileSync(path.join(out, 'decoy-study.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(`${out}/decoy-study.json`);
