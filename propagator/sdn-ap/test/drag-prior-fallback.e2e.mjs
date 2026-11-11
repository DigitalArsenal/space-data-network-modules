#!/usr/bin/env node
// Its read windows are scored on each module's own GCRF output since 2026-11-10 (#386); the old path (TEME through the
// pinned foundation/frames 0.2.0, whose TEME is not the standard one, #389) is printed beside it. In low orbit the two
// differ by about 2 m; every bound held. The TEME output through this checkout's foundation/frames 0.3.0 lands within
// 1 mm of the module's GCRF output.
// Registration (2026-11-03, modules-sdn-ap-drag-prior-fallback-20261103): the fit's per-window drag diagnostics and the
// drag prior's fall-back (SPEC 12.8). Baselines 0.4.11 (git a0f33bc54) and 0.4.17 (git 3c8fcb5c), the module under test
// this build's dist.
// Model truth (test/lib/heo-model-truth.mjs): FFM EGM96 70x70, Sun and Moon from DE440, NRLMSISE-00 drag at constant
// weather on both sides (no SRP); AP FORCES 31,20 with NRLMSISE-00; 72 h fits from an osculating perigee, 7 days flown on
// a 2-minute grid, day-3 whole-day 3D RMS. Read windows (test/lib/regime-windows.mjs): AP6's altimetry group DO, 72 h
// arcs, as AP8 flew them (AP72); the windows were read by AP8 and its diagnosis.
// Restated with the default of a 71 h arc whose perigee is at 600 to 2,500 km (SPEC 12.8: median 0.008 under 10 ln 10, no
// fall-back). Every arc this test fits is such an arc, so the fall-back it was registered for no longer runs on them (it
// stands for an orbit above e 0.3); the acceptance holds what the new default does instead, the 0.4.18 figures in brackets.
// Measured 2026-11-11 on that default with the fit at the data's own sigma (SPEC 12.1, stack #489) and BTERM stated by
// SPEC 12.8's width 1; the figures of the default at 1 km (stack #39 as first drafted) after "1 km".
// Acceptance:
// 1. DO: Sentinel-3A 2025-10-15 at or below 0.33 km at day 3 and Sentinel-3B 2025-10-25 at or below 1.40 km at day 7, the
//    two windows the fall-back had returned to 0.4.11 (0.087 and 0.113 km) and the new default takes back to 0.4.17's
//    (0.312 and 1.335 km): measured 0.286 and 1.090 km (1 km: 0.314 and 1.344), losses the pull request names;
// 2. DO: the median paired day-3 change against 0.4.11 at or below -70 % on HY-2C and on HY-2D (measured -90.9 % and
//    -91.0 %; 1 km: -85 and -92 %); on SWOT and Jason-3 at or below 0.4.17's (measured -93.0 against -48.3 % and -84.5
//    against -68.9 %; 1 km: -47.9 and -73.2 %);
// 3. DO: SARAL and CryoSat-2 (600-800 km, inside the new default): the median paired day-3 change against 0.4.11 at
//    most +5 % (measured -24.7 % and -7.9 %; 1 km: -34.7 and +1.4 %; formerly bit for bit with 0.4.17, outside the old rule);
// 4. model truth, SWOT-like 0.044: a 0.5 m/s along-track step 12 h after the arc's end, its states in the fit's $OEM after
//    USEABLE_STOP_TIME and the arc's states the step-free run's, gives the step-free fit's BTERM bit for bit; the same
//    step 36 h into the arc, on SWOT-like and Sentinel-3-like, leaves the record stating an arc it does not fit (fit RMS
//    above 10 km; measured 28.2 and 28.0 km) and BTERM undetermined: its formal sigma of the log at least 10 (the
//    prior's 10 ln 10), named in the width entry, and the stated one width 1's cap, 1.09 [0.4.18: the fall-back to the
//    band median];
// 5. model truth on the default path: SWOT-like and Sentinel-3-like with a true BTERM of 0.044 at most 100 and 72 m at
//    day 3 (measured 15.3 and 20.4 m; 1 km: 94.3 and 67.3 m) [0.4.17 81.4 and 63.0 m];
// 6. default-FORCES XP digest bit-exact.
// Printed: every fixture's fitted BTERM, posterior sigma of the log, fit RMS and drag path (the derivation of B, k and the
// band median RMS); per object the DO medians at days 1, 2, 3 and 7; every DO window that takes the fall-back and why;
// the mean fit time per arm on the DO arcs.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
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
  // SPEC 12.8's width entry, where the record states BTERM by width 1 (its formal sigma of ln where the cap binds)
  const {ocmOf} = await import('./lib/ocm.mjs');
  const widthEntry = (ocmOf(new Uint8Array(Buffer.from(r.omm, 'base64'))).COV_REALISM ?? []).map((c) => c.MODEL_ID).find((t) => t?.startsWith('sdn-ap drag-term width ')) ?? null;
  const formal = widthEntry ? /formal sigma of ln ([0-9.eE+-]+)/.exec(widthEntry) : null;
  parentPort.postMessage({widthEntry, formalSigmaLog: formal ? Number(formal[1]) : null,
    day3: r.wholeDay[3].e, bterm: r.fitted.bterm, sigmaLog: sigma ? Number(sigma[1]) : null, wrmsKm: r.fitted.wrms,
    path: /drag prior: ([^;]*); arc/.exec(r.fitted.bModel ?? '')?.[1] ?? null, step: /along-track step test.*$/.exec(r.fitted.bModel ?? '')?.[0] ?? null,
    comment: r.fitted.comment});
} else {
  const {wasmPath} = await import('./lib/module.mjs');
  const {scratchRoot} = await import('./lib/scratch.mjs');
  const scratch = path.join(scratchRoot, 'drag-prior-fallback');
  const modules = fileURLToPath(new URL('../../../', import.meta.url));
  fs.mkdirSync(scratch, {recursive: true});
  const release = (sha) => {
    const file = path.join(scratch, `release-${sha}.wasm`);
    fs.writeFileSync(file, execFileSync('git', ['-C', modules, 'show', `${sha}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26}));
    return file;
  };
  const W0411 = release('a0f33bc54'), W0417 = release('3c8fcb5c');
  const workers = Math.min(12, Number(process.env.SDN_AP_E2E_WORKERS ?? 12), os.availableParallelism());

  const ORBITS = {
    'SWOT-like': {n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0},
    'Sentinel-3-like': {n: 14.26, e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0},
    'Jason-like': {n: 12.8096, e: 0.0008, i: 66.04, raan: 100, argp: 90, ma: 0},
  };
  const fixture = (name, bterm, modulePath, extra = {}) => ({name, ...ORBITS[name], drag: true, bterm, hourly: true, gridMinutes: 2, fitPolicy: 'default', modulePath, ...extra});
  const STEP = [{days: 1.5, deltaV: [0, 0.0005, 0], frame: 'RTN'}], AFTER = [{days: 3.5, deltaV: [0, 0.0005, 0], frame: 'RTN'}];
  const jobs = [];
  for (const [arm, w] of [['0.4.17', W0417], ['release', wasmPath]])
    for (const name of Object.keys(ORBITS)) for (const b of [0.044, 0.01, 0.001]) jobs.push({key: `${arm} ${name} ${b}`, kind: 'fixture', c: fixture(name, b, w)});
  for (const name of ['SWOT-like', 'Sentinel-3-like']) jobs.push({key: `release ${name} 0.044 step in the arc`, kind: 'fixture', c: fixture(name, 0.044, wasmPath, {maneuvers: STEP})});
  jobs.push({key: 'release SWOT-like 0.044 tail', kind: 'fixture', c: fixture('SWOT-like', 0.044, wasmPath, {fitTailStates: 720})});
  jobs.push({key: 'release SWOT-like 0.044 tail stepped', kind: 'fixture', c: fixture('SWOT-like', 0.044, wasmPath, {fitTailStates: 720, tailManeuvers: AFTER})});
  for (let index = 0; index < 10; ++index) jobs.push({key: `DO ${index}`, kind: 'windows', index});

  const results = {}, rows = [];
  let next = 0;
  await Promise.all(Array.from({length: workers}, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await new Promise((resolve, reject) => {
        const w = job.kind === 'fixture'
          ? new Worker(new URL(import.meta.url), {workerData: {c: job.c}})
          : new Worker(new URL('./lib/regime-windows.mjs', import.meta.url), {workerData: {regimeWindows: true, group: 'DO', index: job.index, modulePaths: [W0411, W0417, wasmPath]}});
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

  for (const key of Object.keys(results).sort()) console.log(JSON.stringify({fixture: key, ...results[key], comment: undefined}));
  const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
  // #386: days, the modules' own GCRF output (the score); daysOld, the old path (TEME through the pinned frames 0.2.0)
  const day = (a, k, field = 'days') => (a?.ok && a[field]?.[k] ? a[field][k].e : null);
  const name = (r) => r.key.split('|')[1], cutoff = (r) => r.key.split('|')[2];
  const objects = {};
  for (const o of [...new Set(rows.map(name))].sort()) {
    const v = rows.filter((r) => name(r) === o && !r.error);
    const out = {n: v.length};
    for (const k of ['1', '2', '3', '7']) {
      const p = v.filter((r) => day(r.arms[0], k) !== null && day(r.arms[1], k) !== null && day(r.arms[2], k) !== null);
      out[`day${k}`] = p.length ? {n: p.length, at0411: median(p.map((r) => day(r.arms[0], k))), at0417: median(p.map((r) => day(r.arms[1], k))),
        here: median(p.map((r) => day(r.arms[2], k))), change0417: median(p.map((r) => day(r.arms[1], k) / day(r.arms[0], k) - 1)),
        changeHere: median(p.map((r) => day(r.arms[2], k) / day(r.arms[0], k) - 1)),
        oldPath: {at0411: median(p.map((r) => day(r.arms[0], k, 'daysOld'))), here: median(p.map((r) => day(r.arms[2], k, 'daysOld'))),
          changeHere: median(p.map((r) => day(r.arms[2], k, 'daysOld') / day(r.arms[0], k, 'daysOld') - 1))}} : null;
    }
    out.fallBack = v.filter((r) => /drag prior: fall-back/.test(r.arms[2]?.comment ?? '')).length;
    objects[o] = out;
    console.log(JSON.stringify({object: o, ...out}));
  }
  for (const r of rows.filter((r) => /drag prior: fall-back/.test(r.arms[2]?.comment ?? '')).sort((a, b) => a.key.localeCompare(b.key)))
    console.log(JSON.stringify({fallBack: r.key, why: /drag prior: ([^;]*)/.exec(r.arms[2].comment)[1], day3: [0, 1, 2].map((a) => day(r.arms[a], '3'))}));
  const fitMs = [0, 1, 2].map((a) => { const t = rows.filter((r) => r.arms[a]?.ok).map((r) => r.arms[a].fitMs); return t.reduce((s, x) => s + x, 0) / t.length; });
  console.log(JSON.stringify({meanFitMsPer72hArc: {'0.4.11': fitMs[0], '0.4.17': fitMs[1], release: fitMs[2]}, windows: rows.filter((r) => r.arms[2]?.ok).length}));
  if (process.env.SDN_AP_DRAG_FALLBACK_REPORT) fs.writeFileSync(process.env.SDN_AP_DRAG_FALLBACK_REPORT, JSON.stringify({results, objects, rows}, null, 1) + '\n');

  // 1
  const at = (o, c) => rows.find((r) => name(r) === o && cutoff(r).startsWith(c));
  const s3a = day(at('SENTINEL 3A', '2025-10-15')?.arms[2], '3'), s3b = day(at('SENTINEL 3B', '2025-10-25')?.arms[2], '7');
  // the module under test (the last arm) is held to 1 mm; the earlier builds (per-state matrix, gmst()'s rounding: up to
  // 1.5 mm at the geostationary radius, SPEC 16.4) are printed
  const frames030Meters = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(-1).filter((a) => a.ok).map((a) => a.frames030Meters)));
  const frames030MetersEarlierBuilds = Math.max(...rows.flatMap((r) => (r.arms ?? []).slice(0, -1).filter((a) => a.ok).map((a) => a.frames030Meters)));
  console.log(JSON.stringify({sentinel3a20251015day3Km: s3a, sentinel3b20251025day7Km: s3b, frames030Meters, frames030MetersEarlierBuilds,
    oldPath: {sentinel3a20251015day3Km: day(at('SENTINEL 3A', '2025-10-15')?.arms[2], '3', 'daysOld'), sentinel3b20251025day7Km: day(at('SENTINEL 3B', '2025-10-25')?.arms[2], '7', 'daysOld')}}));
  assert.ok(frames030Meters <= 1e-3, `foundation/frames 0.3.0 on the TEME output within ${frames030Meters} m of the module's GCRF output (1 mm)`);
  assert.ok(s3a !== null && s3a <= 0.33, `Sentinel-3A 2025-10-15 day 3 ${s3a} km`);
  assert.ok(s3b !== null && s3b <= 1.40, `Sentinel-3B 2025-10-25 day 7 ${s3b} km`);
  // 2
  for (const o of ['HAIYANG 2C', 'HAIYANG 2D']) assert.ok(objects[o].day3.changeHere <= -0.70, `${o}: day-3 median change ${objects[o].day3.changeHere}`);
  for (const o of ['SWOT', 'JASON 3'])
    assert.ok(objects[o].day3.changeHere <= objects[o].day3.change0417, `${o}: day-3 median change ${objects[o].day3.changeHere} against 0.4.17's ${objects[o].day3.change0417}`);
  // 3
  for (const o of ['SARAL', 'CRYOSAT 2']) {
    assert.equal(rows.filter((r) => name(r) === o && !r.error).length, 15, `${o}: 15 windows`);
    assert.ok(objects[o].day3.changeHere <= 0.05, `${o}: day-3 median change ${objects[o].day3.changeHere} against 0.4.11 (at most +5 %)`);
  }
  // 4
  assert.equal(results['release SWOT-like 0.044 tail stepped'].bterm, results['release SWOT-like 0.044 tail'].bterm, 'a step after the arc leaves BTERM');
  for (const o of ['SWOT-like', 'Sentinel-3-like']) {
    const r = results[`release ${o} 0.044 step in the arc`];
    assert.ok(r.wrmsKm > 10, `${o}: a step in the arc leaves a fit RMS of ${r.wrmsKm} km (above 10 km)`);
    assert.ok(r.formalSigmaLog >= 10, `${o}: a step in the arc leaves BTERM undetermined (formal sigma of the log ${r.formalSigmaLog}; entry ${r.widthEntry})`);
    assert.ok(Math.abs(r.sigmaLog - 1.09) <= 1e-9, `${o}: the record states the width rule's cap, 1.09 (stated ${r.sigmaLog})`);
  }
  // 5
  assert.ok(results['release SWOT-like 0.044'].day3 <= 100, `SWOT-like 0.044: day 3 ${results['release SWOT-like 0.044'].day3} m`);
  assert.ok(results['release Sentinel-3-like 0.044'].day3 <= 72, `Sentinel-3-like 0.044: day 3 ${results['release Sentinel-3-like 0.044'].day3} m`);
  // 6
  reproduceConformance();
  console.log('drag prior fall-back E2E: PASS');
}
