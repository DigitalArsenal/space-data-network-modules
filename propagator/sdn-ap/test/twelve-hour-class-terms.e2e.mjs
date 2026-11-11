#!/usr/bin/env node
// Its read windows are scored on each module's own GCRF output since 2026-11-10 (#386); the old path (TEME through the
// pinned foundation/frames 0.2.0, whose TEME is not the standard one, #389) is printed and held to the same rule beside it.
// The rule compares two builds on one path, so no bound moved. The TEME output through this checkout's foundation/frames
// 0.3.0 lands within 1 mm of the module's GCRF output.
// Registration (2026-11-03): the 12-hour class's tesseral terms on an Etalon-like synthetic orbit (n 2.13 rev/day,
// e 0.0007, i 64.9 deg, node 0, 90, 180 and 270 deg) with no Sun or Moon: FFM EGM96 70x70 without third bodies against
// a test build of this module with both mass ratios 0 (tesseral 31, zonal 20; 72 h fits, 7 days flown hourly).
// Acceptance: day-7 cross-track RMS under 5 m and along-track RMS under 10 m at each node. Exploratory, the already-read
// AP6 windows: Etalon-1/2 paired day-3 AP minus FFM (archived resume-ffm F72) printed per window before (0.4.8, git
// 48539c3ff) and after; LAGEOS-1/2, LARES-2 and IG medians no more than 1 m above 0.4.8's, GE's pinned from 0.6.20 (the
// one-day resonant tail, below), printed. Default-FORCES
// digest bit-exact. Unread-window confirmation is a separate experiments task.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {fileURLToPath} from 'node:url';
import {archive} from './lib/regime-windows.mjs';
import {wasmPath} from './lib/module.mjs';
import {runSyntheticTruth} from './lib/synthetic-truth.mjs';

const {scratchRoot} = await import('./lib/scratch.mjs');
const BASE = '48539c3ff', scratch = path.join(scratchRoot, 'twelve-hour');
const modules = fileURLToPath(new URL('../../../', import.meta.url)), packageRoot = path.join(modules, 'propagator/sdn-ap');
fs.mkdirSync(scratch, {recursive: true});

// The test build: this checkout's sources with the Sun's and the Moon's mass ratios 0.
const tree = path.join(scratch, 'no-bodies'), copy = path.join(tree, 'propagator/sdn-ap');
fs.rmSync(tree, {recursive: true, force: true});
fs.cpSync(packageRoot, copy, {recursive: true, filter: (p) => !/\/(node_modules|test|dist)(\/|$)/.test(p.slice(packageRoot.length))});
const source = path.join(copy, 'src/xp_theory.inc');
let text = fs.readFileSync(source, 'utf8');
for (const [a, b] of [['constexpr double kSunMass = 332946.038;', 'constexpr double kSunMass = 0.0;'], ['constexpr double kMoonMass = 0.012300034;', 'constexpr double kMoonMass = 0.0;']]) {
  assert.equal(text.split(a).length, 2, `one ${a}`);
  text = text.replace(a, b);
}
fs.writeFileSync(source, text);
fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copy, 'node_modules'));
fs.symlinkSync(path.join(modules, 'foundation'), path.join(tree, 'foundation'));
try {
  execFileSync(process.execPath, ['build.mjs'], {cwd: copy, stdio: 'ignore', env: {...process.env, SPACE_DATA_NETWORK_MODULES_ROOT: modules, SDNAP_DIST_DIR: path.join(tree, 'dist')}});
} finally {
  fs.unlinkSync(path.join(copy, 'node_modules'));
  fs.unlinkSync(path.join(tree, 'foundation'));
}
const noBodies = path.join(tree, 'dist/isomorphic/module.wasm');

const synthetic = [];
for (const raan of [0, 90, 180, 270]) {
  const r = await runSyntheticTruth({name: `etalon-like node ${raan}`, n: 2.13, e: 0.0007, i: 64.9, raan, argp: 0, ma: 0, drag: false,
    thirdBody: false, tesseral: 31, zonal: 20, modulePath: noBodies});
  const row = {raan, days: Object.fromEntries([1, 3, 7].map((d) => [d, {crossTrack: r.days[d].n, alongTrack: r.days[d].t, radial: r.days[d].r}]))};
  synthetic.push(row);
  console.log(JSON.stringify({synthetic: row}));
}

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
// #386: days, the modules' own GCRF output (the score); daysOld, the old path (TEME through the pinned frames 0.2.0)
const d3 = (a, field = 'days') => (a?.ok && a[field]?.['3'] ? 1000 * a[field]['3'].e : null);
const f3 = (key) => d3(ffm.get(key)?.arms.F72);
const both = (r) => !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null;
const objectOf = (r) => r.key.split('|')[1];
const etalon = {}, others = {};
for (const name of ['ETALON 1', 'ETALON 2']) {
  const v = rows.filter((r) => r.group === 'GD' && objectOf(r) === name && both(r) && f3(r.key) !== null);
  for (const r of v) console.log(JSON.stringify({window: r.key, ffmMeters: f3(r.key), beforeMinusFfm: d3(r.arms[0]) - f3(r.key), afterMinusFfm: d3(r.arms[1]) - f3(r.key)}));
  etalon[name] = {n: v.length, beforePairedMinusFfmMeters: median(v.map((r) => d3(r.arms[0]) - f3(r.key))), afterPairedMinusFfmMeters: median(v.map((r) => d3(r.arms[1]) - f3(r.key))),
    oldPath: {beforePairedMinusFfmMeters: median(v.map((r) => d3(r.arms[0], 'daysOld') - f3(r.key))), afterPairedMinusFfmMeters: median(v.map((r) => d3(r.arms[1], 'daysOld') - f3(r.key)))}};
}
for (const [name, pick] of [['LAGEOS 1', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 1'], ['LAGEOS 2', (r) => r.group === 'GD' && objectOf(r) === 'LAGEOS 2'],
  ['LARES-2', (r) => r.group === 'GD' && objectOf(r) === 'LARES-2'], ['IG', (r) => r.group === 'IG'], ['GE', (r) => r.group === 'GE']]) {
  const v = rows.filter((r) => pick(r) && both(r));
  others[name] = {n: v.length, beforeMedianMeters: median(v.map((r) => d3(r.arms[0]))), afterMedianMeters: median(v.map((r) => d3(r.arms[1]))),
    oldPath: {beforeMedianMeters: median(v.map((r) => d3(r.arms[0], 'daysOld'))), afterMedianMeters: median(v.map((r) => d3(r.arms[1], 'daysOld')))}};
}
// the module under test (the last arm) is held to 1 mm; the earlier builds (per-state matrix, gmst()'s rounding: up to
// 1.5 mm at the geostationary radius, SPEC 16.4) are printed
const frames030Meters = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(-1).filter((a) => a.ok).map((a) => a.frames030Meters)));
const frames030MetersEarlierBuilds = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(0, -1).filter((a) => a.ok).map((a) => a.frames030Meters)));
const summary = {synthetic, exploratory: {etalon, others, frames030Meters, frames030MetersEarlierBuilds}};
console.log(JSON.stringify(summary));
if (process.env.SDN_AP_TWELVE_HOUR_REPORT) fs.writeFileSync(process.env.SDN_AP_TWELVE_HOUR_REPORT, JSON.stringify(summary, null, 2) + '\n');
if (!process.argv.includes('--measure')) {
  for (const s of synthetic) {
    assert.ok(s.days[7].crossTrack < 5, `node ${s.raan}: day-7 cross-track RMS ${s.days[7].crossTrack} m under 5 m`);
    assert.ok(s.days[7].alongTrack < 10, `node ${s.raan}: day-7 along-track RMS ${s.days[7].alongTrack} m under 10 m`);
  }
  // GE: from 0.6.20 the one-day class carries its resonant gravity above degree 4 (stack #434). These fits state no
  // FORCES.ECOM2, so AP then sits where a numerical propagator with only a sphere does on these satellites, above 0.4.8's
  // median, which the missing gravity had partly cancelled (SPEC 16.13; the row is fitted with Y0 solved, day-3 median
  // 23.4 m). Pinned to the measured value instead (2026-11-11: 53.297 m, old path 64.231 m), within 0.5 m.
  const GE_PIN = {afterMedianMeters: 53.297, oldPath: 64.231};
  for (const [name, v] of Object.entries(others)) {
    if (name === 'GE') {
      assert.ok(Math.abs(v.afterMedianMeters - GE_PIN.afterMedianMeters) <= 0.5, `GE: median day-3 error within 0.5 m of ${GE_PIN.afterMedianMeters} m`);
      assert.ok(Math.abs(v.oldPath.afterMedianMeters - GE_PIN.oldPath) <= 0.5, `old path: GE: median day-3 error within 0.5 m of ${GE_PIN.oldPath} m`);
      continue;
    }
    assert.ok(v.afterMedianMeters - v.beforeMedianMeters <= 1, `${name}: median day-3 error at most 1 m above 0.4.8's`);
    assert.ok(v.oldPath.afterMedianMeters - v.oldPath.beforeMedianMeters <= 1, `old path: ${name}: median day-3 error at most 1 m above 0.4.8's`);
  }
  assert.ok(frames030Meters <= 1e-3, `foundation/frames 0.3.0 on the TEME output within ${frames030Meters} m of the module's GCRF output (1 mm)`);
  reproduceConformance();
  console.log('twelve-hour class terms E2E: PASS');
}
