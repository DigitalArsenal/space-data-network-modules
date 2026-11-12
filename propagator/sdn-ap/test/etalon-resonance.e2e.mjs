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
// GE re-pinned at 0.6.21 (SPEC 16.15 and 16.16; stack #486): 53.297 > 61.62 m at day 3 (131.0 > 149.3 m at day 5), old path
// 64.231 > 73.14 m. These fits state no FORCES.ECOM2. Measured cause: against the numerical propagator's own sphere-only
// fit and forecast of the same windows (FFM 70 x 70, cone shadow, AGOM solved, no ECOM2), AP moves from 10.2 to 5.9 m at
// day 3 and from 24.8 to 10.7 m at day 5: closer on 26 of the 30 windows scored at day 3 and on 27 of the 32 at day 5,
// farther on none (the rest are windows the change leaves bit for bit). The numerical sphere is itself 64.2 m from the
// truth at day 3, so the old figure was AP's in-season radiation error offsetting the satellites' non-spherical
// radiation, which a sphere does not carry. With Y0 solved on the same windows, day 3 goes from 23.4 to 11.5 m. The
// move is 16.16's: 16.15 alone leaves the median where 0.6.20 has it.
// 0.6.22 (AP's own Sun and Moon, SPEC 16.17, stack #446), 0.6.21 > 0.6.22 in m: Etalon-1 4.25 > 3.54, Etalon-2 5.31 >
// 4.84, LAGEOS-1 7.170 > 7.114, LAGEOS-2 6.924 > 6.798, LARES-2 8.714 > 8.660, IG 13.448 > 7.602, GE 61.623 > 65.188;
// old path Etalon-1 6.57 > 6.88, Etalon-2 7.62 > 7.51, LAGEOS-1 7.873 > 7.599, LAGEOS-2 6.721 > 6.781, LARES-2 9.706 >
// 9.752, IG 15.621 > 14.609, GE 73.136 > 76.553. GE without FORCES.ECOM2 rises the way it did at 0.6.21 (stack #486): the
// old Moon's error, like section 4's sunlit-arc rate before 16.16, had been offsetting the satellites' non-spherical
// radiation, which a sphere does not carry (0.6.20 > the Moon alone: 53.297 > 57.922 m; the two moves add); with Y0
// solved on the same windows, day 3 goes from 11.5 to 9.8 m.
// 0.6.49 (the output table keeps a line whole, SPEC 16.1, stack #572), re-pinned to this build; 0.6.45 > 0.6.49 in m:
// Etalon-1 3.540 > 3.702, Etalon-2 4.843 > 4.366, LAGEOS-1 7.077 > 6.697, LAGEOS-2 6.744 > 6.064, LARES-2 8.649 > 8.018,
// IG 7.597 > 7.670, GE 65.087 > 65.087 (LAGEOS-2 left the 0.5 m band around the 0.6.22 pin, 6.798, on the better side).
const EXPECTED = {
  etalon: {'ETALON 1': {baseline: 23.37, value: 3.70}, 'ETALON 2': {baseline: 32.76, value: 4.37}},
  nonregression: {'LAGEOS 1': 6.697, 'LAGEOS 2': 6.064, 'LARES-2': 8.018, IG: 7.670, GE: 65.087},
};
// OLD on the old path, as the fit lane re-pinned it at 0.6.13 (stack issue 324: every object here is above the drag,
// perigee 5,600 km and up, and now fitted at the data's own sigma, SPEC 12.1; 0.6.11 > 0.6.13 in m: Etalon-1 6.719 >
// 6.568, Etalon-2 7.743 > 7.618, LAGEOS-1 7.826 > 7.805, LAGEOS-2 6.773 > 6.729, LARES-2 9.737 > 9.712, IG 17.095 >
// 15.768, GE 45.863 > 45.437; none rose); re-pinned at 0.6.49 (stack #572), 0.6.45 > 0.6.49 in m: Etalon-1 6.873 > 6.259,
// Etalon-2 7.510 > 6.907, LAGEOS-1 7.603 > 6.946, LAGEOS-2 6.745 > 6.246, LARES-2 9.729 > 9.331, IG 14.610 > 14.797,
// GE 76.450 > 76.450 (LAGEOS-1 left the 0.5 m band around the 0.6.22 pin, 7.599, on the better side)
const OLD = {
  etalon: {'ETALON 1': {baseline: 26.64, value: 6.26}, 'ETALON 2': {baseline: 36.39, value: 6.91}},
  nonregression: {'LAGEOS 1': 6.946, 'LAGEOS 2': 6.246, 'LARES-2': 9.331, IG: 14.797, GE: 76.450},
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
