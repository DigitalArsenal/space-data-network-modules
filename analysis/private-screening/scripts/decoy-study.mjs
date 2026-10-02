#!/usr/bin/env node
// How well decoy orbits hide a real one, measured on real histories.
//
//   node scripts/decoy-study.mjs [--archive DIR] [--from 2026-08-02] [--to 2026-08-29]
//     [--hpop-from 2026-08-09] [--hpop-days 14] [--objects 3000] [--seed 1]
//     [--generators independent,rotated,resampled,chained,aligned] [--donors population|regime]
//     [--per-target 1] [--relative] [--views gp,gp-28d,hpop] [--reuse-features]
//     [--workers N] [--out DIR]
//
// 1. Population: LEO payloads (perigee below 2,000 km, e below 0.1) with SGP4
//    element sets through [from, to], a seeded random sample of --objects.
//    Each is a target, and the others are the public catalog.
// 2. Decoys: --per-target per target per generator (decoys).
// 3. GP view: features of the element sets over the HPOP days (gp) or the
//    whole span (gp-28d).
// 4. HPOP view: every history as its owner would publish it. Each day's
//    window starts from the latest element set (analysis/epoch-state GCRF
//    state, propagator/hpop resident): 8 states over one orbit from the
//    window start and the state at the next window's start.
// 5. distinguish, per view and generator. --relative compares each target's
//    candidates with each other (for copies of one orbit); with many decoys
//    per target the report adds the real one's rank within its own set.
// --reuse-features reruns the distinguisher on the features of a previous
// run. Element sets and features stay on this machine; decoy-study.json
// holds aggregates only.
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
  views: { type: 'string', default: 'gp,gp-28d,hpop' },
  'per-target': { type: 'string', default: '1' },
  relative: { type: 'boolean', default: false },
  'reuse-features': { type: 'boolean', default: false },
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
const viewNames = args.views.split(',');
const perTarget = Number(args['per-target']);
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
    json('options', { generator: g, window: span, seed, donors: args.donors, perTarget })]);
  decoys[g] = res.objects;
  generation[g] = res.report;
  console.log(`decoys ${g}: ${res.report.decoys} (${res.report.refused} refused)`);
}

const report = { kind: 'decoy-indistinguishability', version: 1,
  population: { from: args.from, to: args.to, eligible: eligible.length, sampled: reals.length, classes, seed,
    selection: 'OBJECT_TYPE PAYLOAD, perigee below 2,000 km, e below 0.1, at least 14 element sets, the first within 2 days of the start and the last within 2 days of the end' },
  hpopDays: { from: args['hpop-from'], days: hpopDays }, donors: args.donors, perTarget, relative: args.relative, generation, views: {} };

// ── HPOP: each day's window starts from the latest element set (at most 3
// days old): 8 states over one orbit from the window start, and the state at
// the next window's start. ──
const hpopRun = { windows: 0, propagated: 0, failed: 0, seconds: 0 };
async function withWindows(histories) {
  const seeds = [], plans = [];
  histories.forEach((h, index) => {
    for (let k = 0; k < hpopDays; ++k) {
      const start = hpopSpan[0] + k * 86400;
      let j = -1;
      for (let m = 0; m < h.t.length && h.t[m] <= start; ++m) j = m;
      if (j < 0 || h.t[j] < start - 3 * 86400) continue;
      const key = seeds.length;
      seeds.push({ key, epoch: h.t[j], values: FIELDS.slice(1).map((f) => h[f][j]) });
      const period = 86400 / h.n[j];
      plans.push({ key, index, start, times: [...Array.from({ length: 8 }, (_, s) => start + (s * period) / 8), start + 86400] });
    }
  });
  const states = await epochStates(seeds);
  const iso = (t) => new Date(Math.round(t * 1000)).toISOString();
  const arcs = plans.filter((p) => states.has(p.key)).map((p) => ({ arc: p.key, norad: p.key, seed: states.get(p.key), targets: p.times.map(iso) }));
  const { results, seconds } = await propagateArcs(arcs, { variants: ['state'], workers: Number(args.workers) });
  const byKey = new Map(results.map((r) => [r.arc, r.samples]));
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const windows = histories.map(() => []);
  let failed = 0;
  for (const p of plans) {
    const samples = byKey.get(p.key);
    if (!samples || samples.some((x) => !x.state)) { ++failed; continue; }
    windows[p.index].push({ t: p.start, samples: samples.slice(0, 8).map((x, j) => [p.times[j], ...x.state.map(round)]),
      end: [p.times[8], ...samples[8].state.map(round)] });
  }
  hpopRun.windows += plans.length, hpopRun.propagated += arcs.length, hpopRun.failed += failed, hpopRun.seconds += seconds;
  console.log(`HPOP: ${histories.length} histories, ${arcs.length} windows in ${seconds.toFixed(0)} s, ${failed} failed or refused`);
  return histories.map((h, k) => ({ id: h.id, target: h.target, role: h.role, generator: h.generator, cls: h.cls, windows: windows[k] }));
}

// ── features and the distinguisher, per view and generator. Features run on
// the real histories (the catalog) with at most CHUNK decoys a call. ──
const CHUNK = 4000;
const strip = (r) => ({ ...r, features: r.features.map(({ name, aloneAuc, separation, gainShare }) => ({ name, aloneAuc, separation, gainShare })) });
let hpopReals = null;
async function features(view, g, window) {
  const file = path.join(out, `features-${view}-${g}.json`);
  if (args['reuse-features']) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const hpop = view === 'hpop';
  if (hpop && !hpopReals) hpopReals = await withWindows(reals);
  const real = hpop ? hpopReals : reals;
  let f = null;
  for (let at = 0; at < decoys[g].length; at += CHUNK) {
    const part = decoys[g].slice(at, at + CHUNK);
    const chunk = await call('features', [json('histories', { objects: [...real, ...(hpop ? await withWindows(part) : part)] }),
      json('options', { view: hpop ? 'hpop' : 'gp', window })]);
    if (!f) f = chunk;
    else f.rows.push(...chunk.rows.filter((r) => r.role === 'decoy')), f.counts.histories += part.length, f.counts.tooFewPoints += chunk.counts.tooFewPoints;
  }
  fs.writeFileSync(file, JSON.stringify(f));
  return f;
}
const neff = (list, n) => list?.find((x) => x.n === n)?.nEffective;
async function views(name, window) {
  const rows = {};
  for (const g of generators) {
    const f = await features(name, g, window);
    const options = { seed, relative: args.relative };
    const result = await call('distinguish', [json('features', f), json('options', options)]);
    // An adversary who does not search public histories for a replayed sequence.
    const noReplay = await call('distinguish', [json('features', f), json('options', { ...options, exclude: ['sequenceMatch'] })]);
    rows[g] = { counts: f.counts, ...strip(result), withoutSequenceMatch: strip(noReplay) };
    console.log(`${name} ${g}: AUC ${result.auc.toFixed(3)}, eps >= ${(result.epsilon.epsilonLowerBound95 ?? NaN).toFixed(2)}, ` +
      `N_eff at N=10/100/1000: ${[10, 100, 1000].map((n) => neff(result.first, n)?.toFixed(1)).join('/')}; top: ` +
      result.features.slice(0, 3).map((x) => `${x.name} ${(100 * x.gainShare).toFixed(0)}%`).join(', ') +
      `; without sequenceMatch AUC ${noReplay.auc.toFixed(3)}, N_eff(100) ${neff(noReplay.first, 100)?.toFixed(1)}`);
    const w = result.withinTarget;
    if (w?.targets) console.log(`  within each target's set (${w.targets} sets, ${w.fewestDecoys}+ decoys): rank KS ${w.rankKs.toFixed(3)}, ` +
      `histogram ${w.rankHistogram.join(' ')}; N_eff at N=10/100/1000/10000 (standardized): ` +
      [10, 100, 1000, 10000].map((n) => neff(w.firstStandardized, n)?.toFixed(0)).join('/'));
  }
  report.views[name] = { window: window.map((t) => new Date(t * 1000).toISOString()), generators: rows };
}
for (const name of viewNames) await views(name, name === 'gp-28d' ? span : hpopSpan);
if (viewNames.includes('hpop') && !args['reuse-features'])
  report.hpop = { ...hpopRun, seconds: Math.round(hpopRun.seconds),
    product: 'analysis/epoch-state GCRF state at the latest element set, propagated by propagator/hpop resident (point mass and degree/order 20 field)' };
await harness.destroy();
fs.writeFileSync(path.join(out, 'decoy-study.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(`${out}/decoy-study.json`);
