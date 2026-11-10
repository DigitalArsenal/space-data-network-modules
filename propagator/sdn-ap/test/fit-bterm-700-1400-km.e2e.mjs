#!/usr/bin/env node
// Its read windows' scores carry the rotation of the pinned foundation/frames 0.2.0 (its TEME, DigitalArsenal/
// spacedatanetwork-stack#389) at the object's radius: the module's TEME output reaches the truth's GCRF through it (#386
// moves the scoring to the module's own GCRF).
// Registration (2026-11-03, modules-sdn-ap-fit-bterm-700-1400-km-20261103): the fit's BTERM prior at 800-1400 km
// (SPEC 12.8). Baseline the 0.4.11 release (git a0f33bc54), the module under test this build's dist.
// Model truth: FFM EGM96 70x70, Sun and Moon from DE440, NRLMSISE-00 drag at constant weather on both sides (no SRP); AP
// FORCES 31,20 with NRLMSISE-00; 72 h fits from an osculating perigee; 7 days flown on a 2-minute grid; day-3 3D RMS.
// Acceptance:
// 1. the default path (FIT.DRAG_PRIOR unset): at most 300 m on the SWOT-like (n 13.905 rev/day, 891 km, i 77.6 deg) and
//    the Sentinel-3-like (n 14.26 rev/day, 814 km, i 98.65 deg) orbits with a true BTERM of 0.044 m^2/kg; 0.4.11's
//    values printed first;
// 2. the per-object prior path (FIT.DRAG_PRIOR LOG_NORMAL, median the true BTERM, sigma of the log 0.3): at most 30 m on
//    both;
// 3. Sentinel-3-like with a true BTERM of 0.01: no worse than 0.4.11 by more than 2 m (both printed);
// 4. the read AP6 altimetry windows (DO; descriptive, read windows are controls): the paired day-3 AP minus archived FFM
//    (resume-ffm F72) median per object at 0.4.11 and here, printed; no object worse by more than 10 m on its scored
//    windows (amended after the first run: a window where FFM's own day-3 error exceeds 10 km holds a maneuver or a
//    broken arc, as Sentinel-6B's commissioning windows do at 1.9 to 2,626 km, and is printed but not scored);
// 5. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4'); // the model truth: FFM 2.2.1 (modules 9cb02c8e)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {reproduceConformance} from './lib/conformance-step.mjs';
import {fileURLToPath} from 'node:url';

if (!isMainThread) {
  const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
  const r = await runModelTruth(workerData.c);
  const sigma = /posterior sigma of the log ([0-9.eE+-]+)/.exec(r.fitted.bModel ?? '');
  parentPort.postMessage({day3: r.wholeDay[3].e, day5: r.wholeDay[5].e, bterm: r.fitted.bterm, sigmaLog: sigma ? Number(sigma[1]) : null});
} else {
  const {wasmPath} = await import('./lib/module.mjs');
  const {archive} = await import('./lib/regime-windows.mjs');
  const {scratchRoot} = await import('./lib/scratch.mjs');
  const BASE = 'a0f33bc54', scratch = path.join(scratchRoot, 'fit-bterm');
  const modules = fileURLToPath(new URL('../../../', import.meta.url));
  fs.mkdirSync(scratch, {recursive: true});
  const baseline = path.join(scratch, `release-${BASE}.wasm`);
  fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
  const workers = Math.min(12, Number(process.env.SDN_AP_E2E_WORKERS ?? 12), os.availableParallelism());

  const FIXTURES = {
    'SWOT-like 0.044': {name: 'SWOT-like', n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0, drag: true, bterm: 0.044},
    'Sentinel-3-like 0.044': {name: 'Sentinel-3-like', n: 14.26, e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0, drag: true, bterm: 0.044},
    'Sentinel-3-like 0.01': {name: 'Sentinel-3-like', n: 14.26, e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0, drag: true, bterm: 0.01},
  };
  const jobs = [];
  for (const [f, c] of Object.entries(FIXTURES))
    for (const [arm, modulePath] of [['0.4.11', baseline], ['release', wasmPath]])
      jobs.push({key: `${arm} ${f} default`, kind: 'fixture', c: {...c, hourly: true, gridMinutes: 2, fitPolicy: 'default', modulePath}});
  for (const f of ['SWOT-like 0.044', 'Sentinel-3-like 0.044'])
    jobs.push({key: `release ${f} per-object`, kind: 'fixture',
      c: {...FIXTURES[f], hourly: true, gridMinutes: 2, fitPolicy: {form: 'LOG_NORMAL', mean: FIXTURES[f].bterm, sigma: 0.3}, modulePath: wasmPath}});
  for (let index = 0; index < 10; ++index) jobs.push({key: `DO ${index}`, kind: 'windows', index});

  const results = {}, rows = [];
  let next = 0;
  await Promise.all(Array.from({length: workers}, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await new Promise((resolve, reject) => {
        const w = job.kind === 'fixture'
          ? new Worker(new URL(import.meta.url), {workerData: {c: job.c}})
          : new Worker(new URL('./lib/regime-windows.mjs', import.meta.url), {workerData: {regimeWindows: true, group: 'DO', index: job.index, modulePaths: [baseline, wasmPath]}});
        w.on('message', (m) => {
          if (job.kind === 'fixture') { results[job.key] = m; w.terminate().then(resolve); }
          else if (m.row) rows.push(m.row);
          else if (m.error) { w.terminate(); reject(new Error(m.error)); }
          else if (m.done) w.terminate().then(resolve);
        });
        w.on('error', reject);
      });
    }
  }));

  for (const key of Object.keys(results).sort()) console.log(JSON.stringify({fixture: key, ...results[key]}));
  const read = (dir) => {
    const out = new Map();
    for (const f of fs.readdirSync(dir).filter((f) => /^rows-\d+\.jsonl$/.test(f)))
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) { const r = JSON.parse(line); out.set(r.key, r); }
    return out;
  };
  const ffm = read(path.join(archive, 'resume-ffm'));
  const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
  const d3 = (a) => (a?.ok && a.days?.['3'] ? 1000 * a.days['3'].e : null);
  const objects = {};
  for (const name of [...new Set(rows.map((r) => r.key.split('|')[1]))].sort()) {
    const v = rows.filter((r) => r.key.split('|')[1] === name && !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null && d3(ffm.get(r.key)?.arms?.F72) !== null);
    if (!v.length) continue;
    const f = (r) => d3(ffm.get(r.key).arms.F72), scored = v.filter((r) => f(r) < 10000);
    for (const r of v.filter((r) => !(f(r) < 10000)))
      console.log(JSON.stringify({excludedWindow: r.key, ffmDay3Meters: f(r), apDay3At0411: d3(r.arms[0]), apDay3Here: d3(r.arms[1])}));
    objects[name] = {n: v.length, pairedAt0411: median(v.map((r) => d3(r.arms[0]) - f(r))), pairedHere: median(v.map((r) => d3(r.arms[1]) - f(r))),
      scored: scored.length, scoredAt0411: scored.length ? median(scored.map((r) => d3(r.arms[0]) - f(r))) : null,
      scoredHere: scored.length ? median(scored.map((r) => d3(r.arms[1]) - f(r))) : null};
    console.log(JSON.stringify({readWindows: name, ...objects[name]}));
  }
  const all = rows.filter((r) => !r.error && d3(r.arms[0]) !== null && d3(r.arms[1]) !== null && d3(ffm.get(r.key)?.arms?.F72) !== null);
  console.log(JSON.stringify({readWindows: 'all', n: all.length,
    pairedAt0411: median(all.map((r) => d3(r.arms[0]) - d3(ffm.get(r.key).arms.F72))), pairedHere: median(all.map((r) => d3(r.arms[1]) - d3(ffm.get(r.key).arms.F72)))}));
  if (process.env.SDN_AP_FIT_BTERM_REPORT) fs.writeFileSync(process.env.SDN_AP_FIT_BTERM_REPORT, JSON.stringify({results, objects}, null, 2) + '\n');

  for (const f of ['SWOT-like 0.044', 'Sentinel-3-like 0.044']) {
    assert.ok(results[`release ${f} default`].day3 <= 300, `${f}: default path day 3 ${results[`release ${f} default`].day3} m`);
    assert.ok(results[`release ${f} per-object`].day3 <= 30, `${f}: per-object prior day 3 ${results[`release ${f} per-object`].day3} m`);
  }
  assert.ok(results['release Sentinel-3-like 0.01 default'].day3 <= results['0.4.11 Sentinel-3-like 0.01 default'].day3 + 2,
    'Sentinel-3-like 0.01: no worse than 0.4.11 by more than 2 m');
  assert.ok(Object.keys(objects).length >= 9, 'the altimetry objects replayed');
  for (const [name, o] of Object.entries(objects))
    if (o.scored) assert.ok(o.scoredHere - o.scoredAt0411 <= 10, `${name}: no more than 10 m worse than 0.4.11 on its scored windows`);
  reproduceConformance();
  console.log('fit BTERM 700-1400 km E2E: PASS');
}
