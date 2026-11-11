#!/usr/bin/env node
// Its read windows' scores carry the rotation of the pinned foundation/frames 0.2.0 (its TEME, DigitalArsenal/
// spacedatanetwork-stack#389) at the object's radius: the module's TEME output reaches the truth's GCRF through it (#386
// moves the scoring to the module's own GCRF).
// Registration (2026-11-03; re-scoped by the coordinator after the measurement): exploratory replay of the AP6 windows of
// the 2026-11-03 gap diagnosis, already read: GD (Etalon-1/2, LAGEOS-1/2, LARES-2), IG and GE (GFZ MGEX), 72 h arcs, AP
// FORCES; baseline the 0.4.7 release (git dcae63613), the module under test this build's dist. Acceptance, the measured
// values with margin (re-measured at 0.4.9, whose AP sets keep full precision, SPEC 16.9): Etalon-1 paired day-3 AP
// minus FFM (archived resume-ffm F72) 26.64 m at the baseline and 6.64 m here (0.4.11: the third bodies' short-period
// terms by quadrature, SPEC 5.4; 10.12 m at 0.4.9), Etalon-2 36.39 and 7.58 m (9.74 m at 0.4.9), each within 1 m;
// medians here LAGEOS-1 7.81, LAGEOS-2 6.78, LARES-2 9.73, IG 17.10 and GE 45.86 m, each within 0.5 m; every number
// printed; default-FORCES digest bit-exact. Unread-window confirmation is a separate experiments task.
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
const d3 = (a) => (a?.ok && a.days['3'] ? 1000 * a.days['3'].e : null);
const f3 = (key) => d3(ffm.get(key)?.arms.F72);
const both = (r) => !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null;
const objectOf = (r) => r.key.split('|')[1];
const etalon = {}, nonregression = {};
for (const name of ['ETALON 1', 'ETALON 2']) {
  const v = rows.filter((r) => r.group === 'GD' && objectOf(r) === name && both(r) && f3(r.key) !== null);
  for (const r of v) console.log(JSON.stringify({window: r.key, ffmMeters: f3(r.key), baselineMinusFfm: d3(r.arms[0]) - f3(r.key), apMinusFfm: d3(r.arms[1]) - f3(r.key)}));
  etalon[name] = {n: v.length, baselinePairedMinusFfmMeters: median(v.map((r) => d3(r.arms[0]) - f3(r.key))), pairedMinusFfmMeters: median(v.map((r) => d3(r.arms[1]) - f3(r.key)))};
}
for (const [name, pick] of [['LAGEOS 1', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 1'], ['LAGEOS 2', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 2'],
  ['LARES-2', (r) => r.group === 'GD' && objectOf(r) === 'LARES-2'], ['IG', (r) => r.group === 'IG'], ['GE', (r) => r.group === 'GE']]) {
  const v = rows.filter((r) => pick(r) && both(r));
  nonregression[name] = {n: v.length, baselineMedianMeters: median(v.map((r) => d3(r.arms[0]))), medianMeters: median(v.map((r) => d3(r.arms[1])))};
}
console.log(JSON.stringify({exploratory: true, etalon, nonregression}));
if (process.env.SDN_AP_ETALON_REPORT) fs.writeFileSync(process.env.SDN_AP_ETALON_REPORT, JSON.stringify({exploratory: true, etalon, nonregression}, null, 2) + '\n');
// Re-pinned 2026-11-10 at 0.6.14 (stack issue 324: every object here is above the drag, perigee 5,600 km and up, and now
// fitted at the data's own sigma, SPEC 12.1), 0.6.11 > 0.6.14 in m: Etalon-1 6.719 > 6.568, Etalon-2 7.743 > 7.618, LAGEOS-1
// 7.826 > 7.805, LAGEOS-2 6.773 > 6.729, LARES-2 9.737 > 9.712, IG 17.095 > 15.768, GE 45.863 > 45.437; none rose.
const EXPECTED = {
  etalon: {'ETALON 1': {baseline: 26.64, value: 6.57}, 'ETALON 2': {baseline: 36.39, value: 7.62}},
  nonregression: {'LAGEOS 1': 7.805, 'LAGEOS 2': 6.729, 'LARES-2': 9.712, IG: 15.768, GE: 45.437},
};
if (!process.argv.includes('--measure')) {
  for (const [name, want] of Object.entries(EXPECTED.etalon)) {
    assert.ok(Math.abs(etalon[name].baselinePairedMinusFfmMeters - want.baseline) <= 1, `${name}: baseline paired day-3 AP minus FFM within 1 m of ${want.baseline} m`);
    assert.ok(Math.abs(etalon[name].pairedMinusFfmMeters - want.value) <= 1, `${name}: paired day-3 AP minus FFM within 1 m of ${want.value} m`);
  }
  for (const [name, want] of Object.entries(EXPECTED.nonregression))
    assert.ok(Math.abs(nonregression[name].medianMeters - want) <= 0.5, `${name}: median day-3 error within 0.5 m of ${want} m`);
  reproduceConformance();
  console.log('Etalon resonance E2E: PASS');
}
