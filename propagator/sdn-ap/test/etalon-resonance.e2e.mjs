#!/usr/bin/env node
// Scored on each module's own GCRF output since 2026-11-10 (#386). Until then the module's TEME output reached the truth's
// GCRF through the pinned foundation/frames 0.2.0, whose TEME is not the standard one (#389): that old path is still flown
// and asserted beside the score. The figures below are the new path's on 0.6.14, the old path's in brackets (the 0.6.13
// re-pin, stack issue 324). The TEME output through this checkout's foundation/frames 0.3.0 lands within 1 mm of the
// module's GCRF output (4.7 µm measured; the 0.4.7 baseline 1.28 mm, printed).
// Registration (2026-11-03; re-scoped by the coordinator after the measurement): exploratory replay of the AP6 windows of
// the 2026-11-03 gap diagnosis, already read: GD (Etalon-1/2, LAGEOS-1/2, LARES-2), IG and GE (GFZ MGEX), 72 h arcs, AP
// FORCES; baseline the 0.4.7 release (git dcae63613), the module under test this build's dist. Acceptance, the measured
// values with margin (re-measured at 0.4.9, whose AP sets keep full precision, SPEC 16.9): Etalon-1 paired day-3 AP
// minus FFM (archived resume-ffm F72) 23.37 [26.64] m at the baseline and 4.21 [6.57] m here (0.4.11: the third bodies'
// short-period terms by quadrature, SPEC 5.4; [10.12] m at 0.4.9), Etalon-2 32.76 [36.39] and 5.31 [7.62] m ([9.74] m at
// 0.4.9), each within 1 m; medians here LAGEOS-1 7.17 [7.81], LAGEOS-2 6.80 [6.73], LARES-2 8.70 [9.71], IG 13.45 [15.62]
// and GE 53.30 [64.23] m (IG and GE on 0.6.19, the one-day resonant tail), each within 0.5 m; every number printed;
// default-FORCES digest bit-exact. Unread-window
// confirmation is a separate experiments task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {fileURLToPath} from 'node:url';
import {archive} from './lib/regime-windows.mjs';
import {wasmPath} from './lib/module.mjs';

const {scratchRoot} = await import('./lib/scratch.mjs');
const BASE = 'dcae63613', scratch = path.join(scratchRoot, 'etalon');
const modules = fileURLToPath(new URL('../../../', import.meta.url));
fs.mkdirSync(scratch, {recursive: true});
const baseline = path.join(scratch, `release-${BASE}.wasm`);
fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
const read = (dir) => {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => /^rows-\d+\.jsonl$/.test(f)))
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) { const r = JSON.parse(line); out.set(r.key, r); }
  return out;
};
const ffm = read(path.join(archive, 'resume-ffm'));
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const rows = (await Promise.all(['GD', 'IG', 'GE'].flatMap((group) => Array.from({length: {GD: 5, IG: 16, GE: 10}[group]}, (_, index) => new Promise((resolve, reject) => {
  const out = [];
  const worker = new Worker(new URL('./lib/regime-windows.mjs', import.meta.url), {workerData: {regimeWindows: true, group, index, modulePaths: [baseline, wasmPath]}});
  worker.on('message', (msg) => {
    if (msg.row) out.push(msg.row);
    else if (msg.error) { worker.terminate(); reject(new Error(msg.error)); }
    else if (msg.done) worker.terminate().then(() => resolve(out));
  });
  worker.on('error', reject);
}))))).flat().sort((a, b) => a.key.localeCompare(b.key));
// each figure twice (#386): on the modules' own GCRF output (days, the score) and on the old path (daysOld: TEME through
// the pinned foundation/frames 0.2.0, #389, the path of the registration); FFM's archived F72 is GCRF throughout
const d3 = (a, field = 'days') => (a?.ok && a[field]?.['3'] ? 1000 * a[field]['3'].e : null);
const f3 = (key) => d3(ffm.get(key)?.arms.F72);
const both = (r) => !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null;
const objectOf = (r) => r.key.split('|')[1];
const summarize = (field) => {
  const etalon = {}, nonregression = {};
  for (const name of ['ETALON 1', 'ETALON 2']) {
    const v = rows.filter((r) => r.group === 'GD' && objectOf(r) === name && both(r) && f3(r.key) !== null);
    if (field === 'days') for (const r of v) console.log(JSON.stringify({window: r.key, ffmMeters: f3(r.key), baselineMinusFfm: d3(r.arms[0]) - f3(r.key), apMinusFfm: d3(r.arms[1]) - f3(r.key),
      oldPath: {baselineMinusFfm: d3(r.arms[0], 'daysOld') - f3(r.key), apMinusFfm: d3(r.arms[1], 'daysOld') - f3(r.key)}}));
    etalon[name] = {n: v.length, baselinePairedMinusFfmMeters: median(v.map((r) => d3(r.arms[0], field) - f3(r.key))), pairedMinusFfmMeters: median(v.map((r) => d3(r.arms[1], field) - f3(r.key)))};
  }
  for (const [name, pick] of [['LAGEOS 1', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 1'], ['LAGEOS 2', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 2'],
    ['LARES-2', (r) => r.group === 'GD' && objectOf(r) === 'LARES-2'], ['IG', (r) => r.group === 'IG'], ['GE', (r) => r.group === 'GE']]) {
    const v = rows.filter((r) => pick(r) && both(r));
    nonregression[name] = {n: v.length, baselineMedianMeters: median(v.map((r) => d3(r.arms[0], field))), medianMeters: median(v.map((r) => d3(r.arms[1], field)))};
  }
  return {etalon, nonregression};
};
const {etalon, nonregression} = summarize('days'), old = summarize('daysOld');
// the module under test (the last arm) is held to 1 mm; the earlier builds (per-state matrix, gmst()'s rounding: up to
// 1.5 mm at the geostationary radius, SPEC 16.4) are printed
const frames030Meters = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(-1).filter((a) => a.ok).map((a) => a.frames030Meters)));
const frames030MetersEarlierBuilds = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(0, -1).filter((a) => a.ok).map((a) => a.frames030Meters)));
console.log(JSON.stringify({exploratory: true, etalon, nonregression, oldPath: old, frames030Meters, frames030MetersEarlierBuilds}));
if (process.env.SDN_AP_ETALON_REPORT) fs.writeFileSync(process.env.SDN_AP_ETALON_REPORT, JSON.stringify({exploratory: true, etalon, nonregression, oldPath: old, frames030Meters}, null, 2) + '\n');
// on the modules' own GCRF output (2026-11-11, 0.6.14); OLD: the same replay on the old path. IG and GE re-pinned at
// 0.6.19 (the one-day class's resonant tail, stack #434; these fits state no FORCES.ECOM2, and with only a sphere AP now
// sits where a numerical propagator with only a sphere does: SPEC 16.13), 0.6.14 > 0.6.19 in m: IG 13.013 > 13.448,
// GE 35.277 > 53.297; old path IG 15.768 > 15.621, GE 45.437 > 64.231
const EXPECTED = {
  etalon: {'ETALON 1': {baseline: 23.37, value: 4.21}, 'ETALON 2': {baseline: 32.76, value: 5.31}},
  nonregression: {'LAGEOS 1': 7.170, 'LAGEOS 2': 6.800, 'LARES-2': 8.698, IG: 13.448, GE: 53.297},
};
// OLD on the old path, as the fit lane re-pinned it at 0.6.13 (stack issue 324: every object here is above the drag,
// perigee 5,600 km and up, and now fitted at the data's own sigma, SPEC 12.1; 0.6.11 > 0.6.13 in m: Etalon-1 6.719 >
// 6.568, Etalon-2 7.743 > 7.618, LAGEOS-1 7.826 > 7.805, LAGEOS-2 6.773 > 6.729, LARES-2 9.737 > 9.712, IG 17.095 >
// 15.768, GE 45.863 > 45.437; none rose)
const OLD = {
  etalon: {'ETALON 1': {baseline: 26.64, value: 6.57}, 'ETALON 2': {baseline: 36.39, value: 7.62}},
  nonregression: {'LAGEOS 1': 7.805, 'LAGEOS 2': 6.729, 'LARES-2': 9.712, IG: 15.621, GE: 64.231},
};
if (!process.argv.includes('--measure')) {
  for (const [label, want, got] of [['', EXPECTED, {etalon, nonregression}], ['old path: ', OLD, old]]) {
    for (const [name, w] of Object.entries(want.etalon)) {
      assert.ok(Math.abs(got.etalon[name].baselinePairedMinusFfmMeters - w.baseline) <= 1, `${label}${name}: baseline paired day-3 AP minus FFM within 1 m of ${w.baseline} m`);
      assert.ok(Math.abs(got.etalon[name].pairedMinusFfmMeters - w.value) <= 1, `${label}${name}: paired day-3 AP minus FFM within 1 m of ${w.value} m`);
    }
    for (const [name, w] of Object.entries(want.nonregression))
      assert.ok(Math.abs(got.nonregression[name].medianMeters - w) <= 0.5, `${label}${name}: median day-3 error within 0.5 m of ${w} m`);
  }
  assert.ok(frames030Meters <= 1e-3, `foundation/frames 0.3.0 on the TEME output within ${frames030Meters} m of the module's GCRF output (1 mm)`);
  reproduceConformance();
  console.log('Etalon resonance E2E: PASS');
}
