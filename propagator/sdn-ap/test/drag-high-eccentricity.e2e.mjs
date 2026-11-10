#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-drag-high-eccentricity-20261103): AP's drag above e 0.3 (SPEC 16.12) at the
// perigee passages' times, over the whole orbit, with the pass's short-period steps; the band default's median at the
// perigee's altitude above e 0.3 and the carried prior's floor there (SPEC 12.8). Baseline the 0.4.15 release (git
// 4a02a6d90), the module under test this build's dist.
// Model truth as test/lib/heo-model-truth.mjs: FFM EGM96 70x70, Sun and Moon from DE440, NRLMSISE-00 drag at constant
// weather (B = 0.044 m^2/kg, no SRP) on both sides; AP FORCES 31,20 with NRLMSISE-00. Fixtures: Molniya (2 rev/day, e
// 0.74, i 63.4 deg, perigee 541 km), GTO (2.40 rev/day, e 0.72, i 27 deg, 220 km), GTO-500 (2.40 rev/day, e 0.7081,
// 500 km). Day-7 whole-day RMS along-track / radial (m) over the 7 days flown after the arc.
// Acceptance:
// 1. the drag's averaged rates against the module's independent integral over one orbit (sdnap_drag_orbit_check, 20000
//    Simpson points per pass) at days 0, 1, 3 and 7 of each fixture's seeded set: RMS over the six elements at most 0.1 m;
// 2. Molniya, a 72 h arc with BTERM pinned at 0.044 and AGOM at 0, 10-minute grid: along-track at most 80 m (0.4.15
//    printed first);
// 3. Molniya, BTERM fitted the catalog's way (SPEC 12.8): a 7-day arc on the band default (its B within 0.5 % of 0.044),
//    its posterior carried as LOG_NORMAL with the sigma of the log at least 0.005, then the 72 h arc 7 to 10 days after
//    the truth's start: along-track at most 150 m and B within 1 % of 0.044; GTO-500 the same, B within 1 %; the 72 h
//    arc on the model-truth library's Gaussian prior (0.044 +- 0.1) printed with its posterior (SPEC 12.8: that arc
//    does not separate BTERM);
// 4. the drag theory's own error, the seeded set at the truth's B flown 7 days against FFM from AP's epoch state, drag
//    on minus drag off on both sides: along-track no worse than 0.4.15 on each fixture (GTO among them);
// 5. drag off: the seeded drag-off runs and Molniya's 72 h drag-off fit within 0.5 m of 0.4.15 (along-track, radial);
// 6. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const posterior = (text) => {
  const log = /posterior sigma of the log ([0-9.eE+-]+); posterior median ([0-9.eE+-]+)/.exec(text ?? '');
  if (log) return {sigmaLog: Number(log[1]), median: Number(log[2])};
  const g = /posterior ([0-9.eE+-]+) \+- ([0-9.eE+-]+)/.exec(text ?? '');
  return g ? {value: Number(g[1]), sigma: Number(g[2])} : {};
};

if (!isMainThread) {
  const {runModelTruth} = await import('./lib/heo-model-truth.mjs');
  const r = await runModelTruth(workerData.c);
  const w = r.wholeDay ?? {};
  const last = Math.max(0, ...Object.keys(w).map(Number));
  // seeded runs: whole-day RMS from the profile (the library's 'days' carry single samples)
  const rms = (d, k) => { const p = r.profile.filter((q) => q.h > (d - 1) * 24 && q.h <= d * 24); return Math.sqrt(p.reduce((s, q) => s + q[k] ** 2, 0) / p.length); };
  parentPort.postMessage({bterm: r.fitted.bterm, model: r.fitted.bModel, wrms: r.fitted.wrms, last,
    t: last ? w[last].t : rms(7, 't'), r: last ? w[last].r : rms(7, 'r'), dragCheck: r.dragCheck,
    profile: workerData.c.mode === 'seed' ? r.profile.map((q) => [q.h, q.t, q.r]) : undefined});
} else {
  const {wasmPath} = await import('./lib/module.mjs');
  const {scratchRoot} = await import('./lib/scratch.mjs');
  const BASE = '4a02a6d90', scratch = path.join(scratchRoot, 'drag-e2e');
  const modules = fileURLToPath(new URL('../../../', import.meta.url));
  fs.mkdirSync(scratch, {recursive: true});
  const baseline = path.join(scratch, `release-${BASE}.wasm`);
  fs.writeFileSync(baseline, execFileSync('git', ['-C', modules, 'show', `${BASE}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
  const workers = Math.min(12, Number(process.env.SDN_AP_E2E_WORKERS ?? 12), os.availableParallelism());
  const ARMS = [['0.4.15', baseline], ['release', wasmPath]];
  const PIN = {fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: 0.044, sigma: 1e-7}, agomPrior: [0, 1e-10]};
  const GRID = {hourly: true, gridMinutes: 10};
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
  for (const [arm, modulePath] of ARMS) {
    for (const [f, c] of Object.entries(FIXTURES))
      for (const drag of [true, false])
        jobs.push({key: `${arm} ${f} seed ${drag ? 'on' : 'off'}`, c: {name: f, ...c, drag, mode: 'seed', seedGridMin: 10, seedDays: 7, modulePath,
          ...(arm === 'release' && drag ? {dragCheck: 20000} : {})}});
    jobs.push({key: `${arm} Molniya pinned`, c: {name: 'Molniya', ...FIXTURES.Molniya, drag: true, ...GRID, ...PIN, modulePath}});
    jobs.push({key: `${arm} Molniya drag off`, c: {name: 'Molniya', ...FIXTURES.Molniya, drag: false, ...GRID, modulePath}});
  }
  for (const f of ['Molniya', 'GTO-500']) {
    jobs.push({key: `release ${f} 7-day band default`, c: {name: f, ...FIXTURES[f], drag: true, fitDays: 7, ...GRID, forecastDays: 3, fitPolicy: 'default', agomPrior: [0, 1e-10], modulePath: wasmPath}});
    jobs.push({key: `release ${f} 72 h library prior`, c: {name: f, ...FIXTURES[f], drag: true, ...GRID, modulePath: wasmPath}});
  }
  await run(jobs);
  // the catalog's second arc: the 7-day posterior carried (SPEC 12.8)
  const carried = [];
  for (const f of ['Molniya', 'GTO-500']) {
    const p = posterior(results[`release ${f} 7-day band default`].model);
    assert.ok(p.median > 0 && p.sigmaLog > 0, `${f}: the 7-day arc's posterior (${results[`release ${f} 7-day band default`].model})`);
    carried.push({key: `release ${f} 72 h carried`, c: {name: f, ...FIXTURES[f], drag: true, ...GRID, fitStartDays: 7,
      fitPolicy: {form: 'LOG_NORMAL', mean: p.median, sigma: Math.max(p.sigmaLog, 0.005)}, agomPrior: [0, 1e-10], modulePath: wasmPath}});
  }
  await run(carried);
  for (const key of Object.keys(results).sort()) { const {profile, ...rest} = results[key]; console.log(JSON.stringify({run: key, ...rest})); }
  const pct = (b) => (b / 0.044 - 1) * 100;

  // 1. the independent integral
  for (const f of Object.keys(FIXTURES))
    for (const q of results[`release ${f} seed on`].dragCheck) {
      const d = q.theory.map((v, k) => v - q.check[k]), rms = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / 6);
      console.log(JSON.stringify({independentIntegral: f, day: q.day, perOrbitMeters: q.theory, integralMeters: q.check, rms}));
      assert.ok(rms <= 0.1, `${f} day ${q.day}: the drag rates against the independent integral, ${rms} m RMS`);
    }
  // 2. pinned
  console.log(JSON.stringify({molniyaPinned: {at0415: results['0.4.15 Molniya pinned'].t, release: results['release Molniya pinned'].t}}));
  assert.ok(results['release Molniya pinned'].t <= 80, `Molniya pinned: ${results['release Molniya pinned'].t} m along-track`);
  // 3. fitted
  for (const f of ['Molniya', 'GTO-500']) {
    const seven = results[`release ${f} 7-day band default`], three = results[`release ${f} 72 h carried`], lib = results[`release ${f} 72 h library prior`];
    console.log(JSON.stringify({fitted: f, sevenDayB: seven.bterm, sevenDayPct: pct(seven.bterm), carriedB: three.bterm, carriedPct: pct(three.bterm),
      carriedDay7: [three.t, three.r], libraryPriorB: lib.bterm, libraryPriorPct: pct(lib.bterm), libraryPosterior: posterior(lib.model), libraryDay7: [lib.t, lib.r]}));
    assert.ok(Math.abs(pct(three.bterm)) <= 1, `${f}: the carried 72 h arc's B ${three.bterm}`);
    if (f === 'Molniya') {
      assert.ok(Math.abs(pct(seven.bterm)) <= 0.5, `Molniya: the 7-day arc's B ${seven.bterm}`);
      assert.ok(three.t <= 150, `Molniya: the carried 72 h arc's day-7 along-track ${three.t} m`);
    }
  }
  // 4. the drag theory's own error, on minus off
  for (const f of Object.keys(FIXTURES)) {
    const theory = (arm) => {
      const on = results[`${arm} ${f} seed on`].profile, off = results[`${arm} ${f} seed off`].profile;
      const day = on.map((q, k) => [q[0], q[1] - off[k][1], q[2] - off[k][2]]).filter((q) => q[0] > 144 && q[0] <= 168);
      return day.length ? [Math.sqrt(day.reduce((s, q) => s + q[1] ** 2, 0) / day.length), Math.sqrt(day.reduce((s, q) => s + q[2] ** 2, 0) / day.length)] : [NaN, NaN];
    };
    const a = theory('0.4.15'), b = theory('release');
    console.log(JSON.stringify({dragTheoryDay7: f, at0415: a, release: b}));
    assert.ok(b[0] <= a[0], `${f}: the drag theory's day-7 along-track ${b[0]} m against 0.4.15's ${a[0]}`);
  }
  // 5. drag off
  for (const key of [...Object.keys(FIXTURES).map((f) => `${f} seed off`), 'Molniya drag off']) {
    const a = results[`0.4.15 ${key}`], b = results[`release ${key}`];
    console.log(JSON.stringify({dragOff: key, at0415: [a.t, a.r], release: [b.t, b.r]}));
    assert.ok(Math.abs(a.t - b.t) <= 0.5 && Math.abs(a.r - b.r) <= 0.5, `${key}: drag off moved`);
  }
  // 6. XP digest
  execFileSync(process.execPath, [new URL('./conformance.e2e.mjs', import.meta.url).pathname, '--reproduce', new URL('./results/conformance.json', import.meta.url).pathname],
    {stdio: 'inherit', env: {...process.env, SDN_AP_ORACLE_ROOT: process.env.SDN_AP_ORACLE_ROOT ?? '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-closed-modules/packages/sgp4-xp-oracle'}});
  console.log('drag high eccentricity E2E: PASS');
}
