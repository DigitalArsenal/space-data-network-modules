#!/usr/bin/env node
// Registration (2026-11-03): exploratory replay of the AP6 windows of the 2026-11-03 gap diagnosis, already read: GD
// (Etalon-1/2, LAGEOS-1/2, LARES-2), IG and GE (GFZ MGEX), 72 h arcs, AP FORCES. Baseline: the 0.4.7 release (git
// dcae63613). Acceptance: on Etalon-1 and Etalon-2 the median paired day-3 AP minus FFM (archived resume-ffm F72) falls
// to at most half the baseline's, printed per window; the LAGEOS-1, LAGEOS-2, LARES-2, IG and GE median day-3 errors rise
// by at most 1 m; default-FORCES digest bit-exact. Unread-window confirmation is a separate experiments task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {archive} from './lib/regime-windows.mjs';
import {wasmPath} from './lib/module.mjs';

const BASE = 'dcae63613', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/etalon';
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
if (!process.argv.includes('--measure')) {
  for (const [name, v] of Object.entries(etalon)) assert.ok(v.pairedMinusFfmMeters <= v.baselinePairedMinusFfmMeters / 2, `${name}: paired day-3 AP minus FFM at most half the baseline's`);
  for (const [name, v] of Object.entries(nonregression)) assert.ok(v.medianMeters - v.baselineMedianMeters <= 1, `${name}: median day-3 error rises by at most 1 m`);
  execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
    {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
  console.log('Etalon resonance E2E: PASS');
}
