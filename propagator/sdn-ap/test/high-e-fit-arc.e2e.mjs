#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-high-e-fit-arc-20261103): above e 0.3 with the perigee in the drag (SPEC
// 12.8) the fit takes the longest arc the ephemeris holds up to 7 days when no drag prior is stated, and BTERM's posterior
// width counts one independent sample per revolution (the RMS floor) with the determination naming an arc shorter than 7
// days as not separating the coefficient. Baseline the 0.4.16 release (git 1ec779200), the module under test this build.
// Model truth as test/lib/heo-model-truth.mjs (FFM EGM96 70x70, Sun and Moon from DE440, NRLMSISE-00 at constant weather,
// B = 0.044 m^2/kg, no SRP; AP FORCES 31,20 with NRLMSISE-00; AGOM pinned at 0); Molniya (2 rev/day, e 0.74, perigee 541
// km) and GTO-500 (2.40 rev/day, e 0.7081, 500 km); 7 days flown after the arc on a 10-minute grid, day-7 whole-day RMS.
// Acceptance:
// 1. a 7-day ephemeris with no USEABLE times and no drag prior: the fit takes the 7 days, BTERM within 0.5 % of 0.044 and
//    day-7 along-track at most 150 m on both fixtures;
// 2. only 72 h with no drag prior, and 72 h on the model-truth library's Gaussian prior (0.044 +- 0.1): the determination
//    names the coefficient not separable on the arc, and the true 0.044 lies within one posterior sigma on both fixtures;
// 3. printed: 5-day arcs on both priors, and the 7-day posterior carried into the next 72 h arc (sigma of the log 0.005);
// 4. e at most 0.3 (near-circular SWOT- and Sentinel-3-like sets and an e 0.25 set, drag on, and a drag-off Molniya fit):
//    the fitted $OMM byte-identical to 0.4.16's, except the drag-off Molniya, whose set is identical and whose
//    determination text gains nothing;
// 5. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const posterior = (text) => {
  const log = /posterior sigma of the log ([0-9.eE+-]+); posterior median ([0-9.eE+-]+)/.exec(text ?? '');
  if (log) return {sigmaLog: Number(log[1]), median: Number(log[2])};
  const g = /posterior ([0-9.eE+-]+) \+- ([0-9.eE+-]+)/.exec(text ?? '');
  return g ? {value: Number(g[1]), sigma: Number(g[2])} : {};
};
// the truth inside one posterior sigma
const covers = (p, b) => (p.sigmaLog ? Math.abs(Math.log(0.044 / p.median)) <= p.sigmaLog : Math.abs(0.044 - p.value) <= p.sigma);

if (!isMainThread) {
  const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
  const r = await runModelTruth(workerData.c);
  const w = r.wholeDay ?? {}, last = Math.max(0, ...Object.keys(w).map(Number));
  parentPort.postMessage({bterm: r.fitted.bterm, model: r.fitted.bModel, t: last ? w[last].t : null, r: last ? w[last].r : null, omm: r.omm});
} else {
  const {wasmPath} = await import('./lib/module.mjs');
  const BASE = '1ec779200', scratch = '/Users/tj/software/terrain-work/body-look/codex-apfix-d9/arc-e2e';
  const modules = fileURLToPath(new URL('../../../', import.meta.url));
  fs.mkdirSync(scratch, {recursive: true});
  const baseline = path.join(scratch, `release-${BASE}.wasm`);
  fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
  const workers = Math.min(12, Number(process.env.SDN_AP_E2E_WORKERS ?? 12), os.availableParallelism());
  const GRID = {hourly: true, gridMinutes: 10, agomPrior: [0, 1e-10]};
  const results = {};
  const run = (jobs) => {
    let next = 0;
    return Promise.all(Array.from({length: Math.min(workers, jobs.length)}, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        results[job.key] = await new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {workerData: {c: job.c}});
          w.on('message', (m) => w.terminate().then(() => resolve(m)));
          w.on('error', reject);
        });
      }
    }));
  };
  const jobs = [];
  for (const [f, c] of Object.entries(FIXTURES)) {
    const base = {name: f, ...c, drag: true, ...GRID, modulePath: wasmPath};
    jobs.push({key: `${f} 7 d no prior`, c: {...base, fitDays: 7, fitUseable: false, fitPolicy: 'default'}});
    jobs.push({key: `${f} 72 h no prior`, c: {...base, fitDays: 3, fitUseable: false, fitPolicy: 'default'}});
    jobs.push({key: `${f} 72 h wide`, c: {...base, fitDays: 3, fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: 0.044, sigma: 0.1}}});
    jobs.push({key: `${f} 5 d no prior`, c: {...base, fitDays: 5, fitUseable: false, fitPolicy: 'default'}});
    jobs.push({key: `${f} 5 d wide`, c: {...base, fitDays: 5, fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: 0.044, sigma: 0.1}}});
    jobs.push({key: `${f} 7 d band default`, c: {...base, fitDays: 7, forecastDays: 3, fitPolicy: 'default'}});
  }
  const LOW = {
    'SWOT-like': {n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0, drag: true},
    'Sentinel-3-like': {n: 14.26, e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0, drag: true},
    'e 0.25': {n: 6, e: 0.25, i: 50, raan: 10, argp: 30, ma: 0, drag: true},
    'Molniya drag off': {...FIXTURES.Molniya, drag: false},
  };
  for (const [f, c] of Object.entries(LOW))
    for (const [arm, modulePath] of [['0.4.16', baseline], ['release', wasmPath]])
      jobs.push({key: `${arm} ${f}`, c: {name: f, ...c, hourly: true, gridMinutes: 60, modulePath}});
  await run(jobs);
  const carried = [];
  for (const f of Object.keys(FIXTURES)) {
    const p = posterior(results[`${f} 7 d band default`].model);
    carried.push({key: `${f} 72 h carried`, c: {name: f, ...FIXTURES[f], drag: true, ...GRID, fitStartDays: 7,
      fitPolicy: {form: 'LOG_NORMAL', mean: p.median, sigma: Math.max(p.sigmaLog, 0.005)}, modulePath: wasmPath}});
  }
  await run(carried);
  const pct = (b) => (b / 0.044 - 1) * 100;
  for (const key of Object.keys(results).sort()) {
    const {omm, ...rest} = results[key];
    console.log(JSON.stringify({run: key, ...rest, bPct: pct(rest.bterm), posterior: posterior(rest.model)}));
  }
  for (const f of Object.keys(FIXTURES)) {
    const seven = results[`${f} 7 d no prior`];
    assert.ok(/span 168\.000 h \(above e 0\.3 with drag/.test(Buffer.from(seven.omm, 'base64').toString('latin1')), `${f}: the 7-day arc taken`);
    assert.ok(!/not separable/.test(seven.model), `${f}: 7 days separate the coefficient`);
    assert.ok(Math.abs(pct(seven.bterm)) <= 0.5, `${f}: 7-day B ${seven.bterm}`);
    assert.ok(seven.t <= 150, `${f}: 7-day arc, day-7 along-track ${seven.t} m`);
    for (const k of ['72 h no prior', '72 h wide']) {
      const r = results[`${f} ${k}`];
      assert.ok(/drag coefficient not separable on this arc/.test(r.model), `${f} ${k}: the determination names it (${r.model})`);
      assert.ok(covers(posterior(r.model), r.bterm), `${f} ${k}: 0.044 within one sigma (${r.model})`);
    }
  }
  for (const f of Object.keys(LOW)) {
    const a = results[`0.4.16 ${f}`], b = results[`release ${f}`];
    console.log(JSON.stringify({lowE: f, identical: a.omm === b.omm, modelAt0416: a.model, model: b.model}));
    assert.equal(b.omm, a.omm, `${f}: the fitted set byte-identical to 0.4.16's`);
    assert.equal(b.model, a.model, `${f}: the determination text unchanged`);
  }
  execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
    {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
  console.log('high-e fit arc E2E: PASS');
}
