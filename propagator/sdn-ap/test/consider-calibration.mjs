#!/usr/bin/env node
// The kappa table of SPEC 12.1 (fit::kKappaNodes), measured on the project's own controlled truth. For each calibration
// orbit (made up, none of them an evaluation case: the review's test orbits and the accuracy study's objects) and each
// epoch: propagator/ffm's flight (EGM96 70 x 70 below a = 9,000 km, 31 x 31 above; the Sun and the Moon from DE440; no
// drag, no radiation pressure; Earth orientation as AP assumes it) of 11 days at 300 s from the state of an AP set; then
// every window of 1, 2, 3 and 5 days ending on a whole day of it fitted by this module under AP's forces (caps 31 and 20,
// NRLMSISE-00 on constant rows) with BTERM and AGOM pinned at 0 and the consider block free
// (sdnap_fit_consider_calibration): the data sigma and the five rate errors c of each window (sdnap_fit_consider_last).
// Per orbit and arc, pooled over epochs and windows (the referee's definitions, addendum 2):
//   kappa_n = rms(c_n) / rms(sigma)   kappa_e = rms(|c_e|) / rms(sigma)   kappa_i = rms(|c_i|) / rms(sigma)
// with |c_e|, |c_i| the magnitudes of the eccentricity- and inclination-vector rates. Each orbit and epoch runs in its own
// process (CALIBRATION_JOBS at a time, default 8). Writes test/results/consider-calibration.json (every window, the table,
// the builds' SHA-256) and prints the C++ table.
// A measurement tool, not a test. --check runs the whole tool on a tiny case (one orbit, one epoch, 1-day windows of a
// 2-day truth) in one process, writes nothing, and fails unless both windows gave a positive sigma and finite, positive
// kappas.
//   node test/consider-calibration.mjs [orbit,...]     (a subset prints its table and writes nothing)
//   node test/consider-calibration.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM, OEMT } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { CATT } from 'spacedatastandards.org/lib/js/OEM/CAT.js';
import { ephemerisDataBlockT as Block } from 'spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js';
import { ephemerisDataLineT as Line } from 'spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js';
import { timingStandard } from 'spacedatastandards.org/lib/js/OEM/timingStandard.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { pcfAtmosphereFamily } from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import { pcfWeatherSource } from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import { ensureBuilt, wasmPath } from './lib/module.mjs';
import { configuration, prior, pcfPriorForm } from './lib/pcf.mjs';
import { T, seedOcm, rowsThrough, spwStream, flight } from './lib/ocm.mjs';
import { packOem, rfm } from './lib/frames.mjs';
import { ffmTruth, ffmProvenance } from './lib/ffm-truth.mjs';
import { scratchDir } from './lib/scratch.mjs';

/** The calibration orbits: semi-major axis km, eccentricity, inclination, node, argument of perigee, mean anomaly (deg). */
export const ORBITS = [
  { id: 'leo-400-28', el: [6778, 0.0010, 28.5, 15, 40, 0] },
  { id: 'leo-550-53', el: [6928, 0.0012, 53.0, 140, 80, 0] },
  { id: 'leo-650-98', el: [7028, 0.0010, 97.9, 250, 120, 0] },
  { id: 'leo-750-74', el: [7128, 0.0011, 74.0, 300, 200, 0] },
  { id: 'leo-900-99', el: [7278, 0.0010, 99.0, 60, 30, 0] },
  { id: 'leo-1100-89', el: [7478, 0.0009, 89.0, 190, 310, 0] },
  { id: 'leo-1500-52', el: [7878, 0.0010, 52.0, 330, 90, 0] },
  { id: 'leo-e04-63', el: [7450, 0.0400, 63.0, 80, 250, 0] },
  { id: 'leo-2500-70', el: [8878, 0.0010, 70.0, 210, 0, 0] },
  { id: 'meo-5000-110', el: [11378, 0.0040, 110.0, 120, 60, 0] },
  { id: 'meo-10000-45', el: [16378, 0.0020, 45.0, 30, 270, 0] },
  { id: 'meo-23000-40', el: [23000, 0.0020, 40.0, 280, 150, 0] },
  { id: 'meo-27900-52', el: [27900, 0.0030, 52.0, 100, 20, 0] },
  { id: 'geo-2', el: [42164, 0.0004, 2.0, 70, 100, 0] },
  { id: 'geo-30', el: [42164, 0.0020, 30.0, 160, 220, 0] },
  { id: 'geo-e07-43', el: [42164, 0.0700, 43.0, 220, 270, 0] },
  { id: 'heo-e72-63', el: [26560, 0.7200, 63.4, 330, 270, 0] },
  { id: 'gto-e73-20', el: [24400, 0.7300, 20.0, 120, 180, 0] },
];
export const EPOCHS = ['2026-06-20', '2026-07-25', '2026-08-29', '2026-10-03'];
export const ARCS_DAYS = [1, 2, 3, 5];
const DAY = 86400000, STEP_S = 300, TRUTH_DAYS = 11, MU = 398600.4418;
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const self = fileURLToPath(import.meta.url);

/** The windows of one orbit and epoch: every arc of `arcs` days ending on a whole day of a `truthDays` truth. */
export async function windowsOf(orbit, epoch, truthDays = TRUTH_DAYS, arcs = ARCS_DAYS) {
  const h = await createStandaloneHarness('browser', wasmPath, { surface: 'direct' });
  const x = h.instance.exports, mem = () => h.memory.buffer;
  x.sdnap_fit_consider_calibration(1);
  const forces = { EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
    ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00, WEATHER_SOURCE: pcfWeatherSource.RECORDS };
  const cfg = configuration({ forces, fit: { DRAG_PRIOR: prior(0, 1e-12), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED, SRP_PRIOR: prior(0, 1e-12), SRP_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED } });
  const [a, e, i, raan, argp, ma] = orbit.el, n = Math.sqrt(MU / a ** 3) * 86400 / (2 * Math.PI);
  const t0 = Date.parse(`${epoch}T00:00:00Z`), rowsW = [];
  for (let k = -3; k <= TRUTH_DAYS + 35; k++) rowsW.push({ DATE: new Date(t0 + k * DAY).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: 0 });
  const spw = rowsThrough(rowsW);
  // the truth's start: the state of an AP set of these mean elements at the epoch (GCRF)
  const seed = seedOcm({ epoch: iso(t0), n, e, i, raan, argp, ma, norad: 99001, msis: true, records: true, tesseral: 31, zonal: 20, rows: spw });
  const s = await h.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: [iso(t0)], FRAME: pcfOutputFrame.GCRF } }) });
  const l0 = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(s.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  const times = Array.from({ length: truthDays * 86400 / STEP_S + 1 }, (_, k) => t0 + k * STEP_S * 1000);
  const truth = await ffmTruth([l0.X, l0.Y, l0.Z, l0.X_DOT, l0.Y_DOT, l0.Z_DOT], t0, times, a < 9000 ? 70 : 31);
  const per = 86400 / STEP_S, windows = [];
  for (const arc of arcs)
    for (let end = arc; end <= truthDays; end++) {
      const k0 = (end - arc) * per, k1 = end * per, lines = [];
      for (let k = k0; k <= k1; k++) lines.push(Object.assign(new Line(), { EPOCH: iso(times[k]), X: truth[k][0], Y: truth[k][1], Z: truth[k][2], X_DOT: truth[k][3], Y_DOT: truth[k][4], Z_DOT: truth[k][5] }));
      const blk = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99001 }), CENTER_NAME: 'EARTH', REFERENCE_FRAME: rfm('GCRF'), TIME_SYSTEM: timingStandard.UTC,
        START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
      const r = await h.invoke({ methodId: 'fit', inputs: [cfg, { portId: 'space_weather', typeRef: T('SPW'), payload: spwStream(spw) },
        { portId: 'ephemeris', typeRef: T('OEM'), payload: packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [blk] })) }] });
      if (r.statusCode !== 0) { console.error(`${orbit.id} ${epoch} ${arc} d to day ${end}: ${r.errorCode} ${r.errorMessage}`); continue; }
      const p = x.sdnap_alloc(96);
      const rc = x.sdnap_fit_consider_last(p);
      const c = Array.from(new Float64Array(mem(), p, 12));
      x.sdnap_free(p);
      if (rc !== 0) continue;
      windows.push({ orbit: orbit.id, epoch, arcDays: arc, endDay: end, revolutions: +(arc * n).toFixed(3), sigmaM: 1000 * c[0],
        cn: 1000 * c[1], ce: [1000 * c[2], 1000 * c[3]], ci: [1000 * c[4], 1000 * c[5]] });
    }
  await h.close?.();
  return windows;
}

/** Per orbit and arc: the kappas of the pooled windows. */
export function tableOf(orbits, windows) {
  return orbits.map((orbit) => {
    const [a, e, i] = orbit.el, arcs = [];
    for (const arc of ARCS_DAYS) {
      const w = windows.filter((q) => q.orbit === orbit.id && q.arcDays === arc);
      if (!w.length) continue;
      const s = rms(w.map((q) => q.sigmaM));
      arcs.push({ arcDays: arc, revolutions: w[0].revolutions, windows: w.length, sigmaM: +s.toFixed(4),
        kappaN: rms(w.map((q) => q.cn)) / s, kappaE: rms(w.map((q) => Math.hypot(...q.ce))) / s, kappaI: rms(w.map((q) => Math.hypot(...q.ci))) / s,
        cnMeanM: w.reduce((t, q) => t + q.cn, 0) / w.length });
    }
    return { orbit: orbit.id, aKm: a, e, incDeg: i, arcs };
  });
}

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [self, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')}: exit ${code}`))));
});

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--windows') {
    // one orbit and epoch, its windows to a file (the parent's worker)
    const [id, epoch, out] = rest;
    const windows = await windowsOf(ORBITS.find((q) => q.id === id), epoch);
    fs.writeFileSync(out, JSON.stringify(windows));
    console.error(`${id} ${epoch}: ${windows.length} windows`);
    process.exit(0);
  }
  ensureBuilt();
  if (mode === '--check') {
    const orbit = ORBITS.find((q) => q.id === 'leo-1500-52');
    const windows = await windowsOf(orbit, EPOCHS[0], 2, [1]);
    const arcs = tableOf([orbit], windows)[0].arcs;
    const ok = windows.length === 2 && windows.every((w) => w.sigmaM > 0) && arcs.length === 1
      && ['kappaN', 'kappaE', 'kappaI'].every((k) => Number.isFinite(arcs[0][k]) && arcs[0][k] > 0);
    console.log(`--check: ${windows.length} windows; ${JSON.stringify(arcs[0] ?? null)}: ${ok ? 'pass' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
  }
  const only = mode ? new Set(mode.split(',')) : null;
  const orbits = ORBITS.filter((q) => !only || only.has(q.id));
  const dir = scratchDir('consider-calibration', sha(wasmPath).slice(0, 16));
  const jobs = orbits.flatMap((orbit) => EPOCHS.map((epoch) => ({ orbit, epoch, out: path.join(dir, `${orbit.id}-${epoch}.json`) })));
  // the slow eccentric orbits first
  jobs.sort((p, q) => q.orbit.el[1] - p.orbit.el[1]);
  const pending = jobs.filter((j) => !fs.existsSync(j.out));
  const width = Math.max(1, +(process.env.CALIBRATION_JOBS ?? 8));
  await Promise.all(Array.from({ length: Math.min(width, pending.length) }, async () => {
    while (pending.length) { const j = pending.shift(); await run(['--windows', j.orbit.id, j.epoch, j.out]); }
  }));
  const windows = jobs.flatMap((j) => JSON.parse(fs.readFileSync(j.out, 'utf8')));
  const table = tableOf(orbits, windows);
  const out = { module: { wasm: wasmPath.split('/').slice(-3).join('/'), sha256: sha(wasmPath) }, truth: { ...ffmProvenance(), stepSeconds: STEP_S, days: TRUTH_DAYS,
    gravity: 'EGM96 70 x 70 below a = 9,000 km, 31 x 31 above', thirdBodies: 'Sun, Moon (DE440 excerpt)', drag: false, radiationPressure: false },
    epochs: EPOCHS, arcsDays: ARCS_DAYS, table, windows };
  if (!only) fs.writeFileSync(new URL('./results/consider-calibration.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  for (const r of table) {
    const f = (k) => r.arcs.map((q) => +q[k].toPrecision(3)).join(', ');
    console.log(`    {${r.aKm.toFixed(1)}, ${r.e}, ${r.incDeg}, ${r.arcs.length}, {${r.arcs.map((q) => q.arcDays).join(', ')}}, {${f('kappaN')}}, {${f('kappaE')}}, {${f('kappaI')}}},  // ${r.orbit}: sigma ${r.arcs.map((q) => q.sigmaM.toFixed(2)).join(' / ')} m; revolutions ${r.arcs.map((q) => q.revolutions).join(' / ')}`);
  }
  process.exit(0);
}
