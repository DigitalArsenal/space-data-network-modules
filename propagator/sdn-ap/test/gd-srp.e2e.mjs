#!/usr/bin/env node
// Registration (2026-11-03): exploratory replay of the AP6 windows of the 2026-11-03 gap diagnosis, already read: GD
// (LAGEOS-1/2, Etalon-1/2, LARES-2), IG and GE (GFZ MGEX), 72 h arcs, AP FORCES. Baseline: the 0.4.7 release (git
// dcae63613). Acceptance: the median paired day-3 AP minus FFM (archived resume-ffm F72) on GD falls by at least 5.4 m
// from the baseline's, printed per window; IG and GE median day-3 errors rise by at most 1 m; default-FORCES digest
// bit-exact. With --sensitivity, AGOM held at 0 and at 0.001 m^2/kg ($PCF FIT.SRP_PRIOR) and the module's own
// TEME-to-GCRF rotation are printed beside the baseline. Unread-window confirmation is a separate experiments task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {archive} from './lib/regime-windows.mjs';
import {wasmPath} from './lib/module.mjs';

const BASE = 'dcae63613', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/gd-srp';
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
const run = (groups, modulePaths, extra = {}) => Promise.all(groups.flatMap((group) => Array.from({length: {GD: 5, IG: 16, GE: 10}[group]}, (_, index) => new Promise((resolve, reject) => {
  const rows = [];
  const worker = new Worker(new URL('./lib/regime-windows.mjs', import.meta.url), {workerData: {regimeWindows: true, group, index, modulePaths, ...extra}});
  worker.on('message', (msg) => {
    if (msg.row) rows.push(msg.row);
    else if (msg.error) { worker.terminate(); reject(new Error(msg.error)); }
    else if (msg.done) worker.terminate().then(() => resolve(rows));
  });
  worker.on('error', reject);
})))).then((parts) => parts.flat().sort((a, b) => a.key.localeCompare(b.key)));
const d3 = (a) => (a?.ok && a.days['3'] ? 1000 * a.days['3'].e : null);
const f3 = (key) => d3(ffm.get(key)?.arms.F72);
const rows = await run(['GD', 'IG', 'GE'], [baseline, wasmPath]);
const gd = rows.filter((r) => r.group === 'GD' && !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null && f3(r.key) !== null);
for (const r of gd) console.log(JSON.stringify({gd: r.key, ffmMeters: f3(r.key), baselineMeters: d3(r.arms[0]), apMeters: d3(r.arms[1]), baselineMinusFfm: d3(r.arms[0]) - f3(r.key), apMinusFfm: d3(r.arms[1]) - f3(r.key)}));
const before = median(gd.map((r) => d3(r.arms[0]) - f3(r.key))), after = median(gd.map((r) => d3(r.arms[1]) - f3(r.key)));
const groups = Object.fromEntries(['IG', 'GE'].map((g) => {
  const v = rows.filter((r) => r.group === g && !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null);
  return [g, {n: v.length, baselineMedianMeters: median(v.map((r) => d3(r.arms[0]))), medianMeters: median(v.map((r) => d3(r.arms[1])))}];
}));
const summary = {exploratory: true, gd: {n: gd.length, baselinePairedMinusFfmMeters: before, pairedMinusFfmMeters: after, gainMeters: before - after}, ...groups};
console.log(JSON.stringify(summary));
if (process.argv.includes('--sensitivity')) {
  for (const [name, extra] of [['agom0', {fit: {srpPrior: {mean: 0, sigma: 1e-9}}}], ['agom0.001', {fit: {srpPrior: {mean: 0.001, sigma: 1e-9}}}], ['moduleFrames', {moduleFrames: true}]]) {
    const s = (await run(['GD'], [wasmPath], extra)).filter((r) => !r.error && d3(r.arms[0]) !== null && f3(r.key) !== null);
    console.log(JSON.stringify({sensitivity: name, n: s.length, pairedMinusFfmMeters: median(s.map((r) => d3(r.arms[0]) - f3(r.key)))}));
  }
}
if (!process.argv.includes('--measure') && !process.argv.includes('--sensitivity')) {
  assert.ok(before - after >= 5.4, 'GD paired day-3 AP minus FFM falls by at least 5.4 m');
  for (const g of ['IG', 'GE']) assert.ok(groups[g].medianMeters - groups[g].baselineMedianMeters <= 1, `${g} median day-3 error rises by at most 1 m`);
  execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
    {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
  console.log('GD SRP E2E: PASS');
}
