#!/usr/bin/env node
// SPEC 19.7, cost of the frames (a measurement, not an assertion). Process CPU time; the kinds alternate round by round in one process, so read the ratios.
//  (1) a frame of N objects through sdnap_frames_at (TEME and Earth-fixed) against the same through the module's SGP4 (sdnap_epochs_at on SGP4 records, TEME and
//      Earth-fixed), microseconds a state and the ratio;
//  (2) a refill row (one cold set, one cell) by class and by the window's distance from the epoch (0, 2, 5 and 10 days): median and 95th percentile in milliseconds,
//      the AP states a row flew, and how many of a class's rows halved;
//  (3) a refill row of a low set before and after 20 wide sets were flown through sdnap_epochs_set_at in the same instance, and the instance's bytes at each step.
//   node test/frames-cost.mjs [--objects 20000] [--rounds 9] [--rows 20] [--skip-frame] [--skip-rows] [--skip-wide]
import os from "node:os";
import * as flatbuffers from "flatbuffers";
import { OCM, OCMT } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { HeaderT } from "spacedatastandards.org/lib/js/OCM/Header.js";
import { MetadataT } from "spacedatastandards.org/lib/js/OCM/Metadata.js";
import { OCMMeanElementsT } from "spacedatastandards.org/lib/js/OCM/OCMMeanElements.js";
import { PerturbationsT } from "spacedatastandards.org/lib/js/OCM/Perturbations.js";
import { RFMT } from "spacedatastandards.org/lib/js/OCM/RFM.js";
import { RFMUnion } from "spacedatastandards.org/lib/js/OCM/RFMUnion.js";
import { CelestialFrameWrapperT } from "spacedatastandards.org/lib/js/OCM/CelestialFrameWrapper.js";
import { CelestialFrame } from "spacedatastandards.org/lib/js/OCM/CelestialFrame.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { population, openFrames, EPOCH, EPOCH_MS, DAY, revPerDay, STAT } from "./lib/frame-cells.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const flag = (k) => process.argv.includes(k);
const N = arg("--objects", 20000), ROUNDS = arg("--rounds", 9), ROWS = arg("--rows", 20);
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };  // ms
const quantile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const med = (a) => quantile(a, 0.5);
const share = (n, p) => Math.round((n * p) / 100);
const out = { loadAvg: os.loadavg(), objects: N };
const fail = (m) => { throw new Error(m); };

// ---- (1) frame against SGP4
if (!flag("--skip-frame")) {
  const low = share(N, 85), plan = [["leo500", Math.round(low * 0.3)], ["leo830", Math.round(low * 0.53)], ["drag300", low - Math.round(low * 0.3) - Math.round(low * 0.53)], ["meo", share(N, 5)], ["geo", share(N, 5)], ["ecc", N - low - 2 * share(N, 5)]];
  const f = await openFrames();
  await f.load(population(plan, 20261113, 48));
  if (f.open(N * 900 + N * 32 + (1 << 20)) !== 0) fail("open");
  const t = EPOCH_MS + 3600e3;
  if (f.fill(t, 180, 5000).due !== 0) fail("the fill did not complete");
  const x = f.x, pl = x.sdnap_alloc(48 * N), st = x.sdnap_alloc(4 * N), [w, fr] = f.jd(t);
  { const q = f.at(t); const served = q.status.filter((s) => s === 0).length; if (served !== N) fail(`${served} of ${N} objects are served: the timed frames would not be full frames`); }
  // SGP4 records of the module (MEAN_ELEMENT_THEORY SGP4), the same count
  const g = await openFrames();
  const tt = new OCMT();
  tt.HEADER = Object.assign(new HeaderT(), { CCSDS_OCM_VERS: "3.0", ORIGINATOR: "SDN" });
  tt.METADATA = Object.assign(new MetadataT(), { NORAD_CAT_ID: 90001, TIME_SYSTEM: "UTC" });
  tt.CENTER_NAME = "EARTH";
  tt.TRAJ_REF_FRAME = new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE), 0, "TEMEOFDATE");
  tt.ORB_AVERAGING = "KOZAI";
  tt.MEAN_ELEMENTS = Object.assign(new OCMMeanElementsT(), { MEAN_ELEMENT_THEORY: 0, EPOCH, MEAN_MOTION: revPerDay(6878.137), ECCENTRICITY: 0.001, INCLINATION: 97.4, RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 30, MEAN_ANOMALY: 0, BSTAR: 1e-4 });
  tt.PERTURBATIONS = Object.assign(new PerturbationsT(), { GRAVITY_MODEL: "WGS-72", WEATHER_SOURCE: pcfWeatherSource.NONE });
  const recs = [];
  for (let k = 0; k < N; k++) { tt.METADATA.NORAD_CAT_ID = 100000 + k; tt.MEAN_ELEMENTS.RA_OF_ASC_NODE = (k * 0.0173) % 360; tt.MEAN_ELEMENTS.MEAN_ANOMALY = (k * 0.311) % 360; const b = new flatbuffers.Builder(2048); OCM.finishOCMBuffer(b, tt.pack(b)); recs.push(b.asUint8Array().slice()); }
  await g.load(null, recs);
  const gx = g.x, gpl = gx.sdnap_alloc(48 * N), gst = gx.sdnap_alloc(4 * N), [gw, gf] = g.jd(EPOCH_MS + 60e3);
  gx.sdnap_epochs_at(gw, gf, 0, N, 0, gpl, gst, 0);
  const kinds = {
    sgp4: () => { for (let j = 1; j <= 5; j++) gx.sdnap_epochs_at(gw, gf + (j * 60) / 86400, 0, N, 0, gpl, gst, 0); return 5 * N; },
    sgp4Ecef: () => { for (let j = 1; j <= 5; j++) gx.sdnap_epochs_at(gw, gf + (j * 60) / 86400, 0, N, 3, gpl, gst, 0); return 5 * N; },
    frames: () => { for (let j = 1; j <= 5; j++) x.sdnap_frames_at(w, fr + (j * 1) / 86400, 0, N, 0, pl, st); return 5 * N; },
    framesEcef: () => { for (let j = 1; j <= 5; j++) x.sdnap_frames_at(w, fr + (j * 1) / 86400, 0, N, 3, pl, st); return 5 * N; },
  };
  const names = Object.keys(kinds), res = Object.fromEntries(names.map((k) => [k, []]));
  for (let r = 0; r < ROUNDS; r++) for (let j = 0; j < names.length; j++) { const k = names[(j + r) % names.length]; const c0 = cpu(); const n = kinds[k](); res[k].push(((cpu() - c0) * 1000) / n); }
  { // every timed frame was served: the last call of each kind is read back
    x.sdnap_frames_at(w, fr, 0, N, 0, pl, st); const s = new Int32Array(f.mem(), st, N);
    if (s.some((v) => v !== 0)) fail("a timed frame holds objects that are not served");
  }
  { // a refill that finds nothing to do (the cells hold the clock and its look-ahead), the clock advancing 16 ms a call, at N places: the cost of the scan
    const c = [];
    for (let k = 0; k < 9; k++) { const c0 = cpu(); const r = f.refill(t + 1000 + k * 16, 180, 8); c.push(cpu() - c0); if (r.rc !== 0) fail("refill"); }
    out.idleRefillMs = +med(c).toFixed(2);
  }
  const ratio = (a, b) => +med(res[a].map((v, r) => v / res[b][r])).toFixed(3);
  out.frame = { usPerState: Object.fromEntries(names.map((k) => [k, +med(res[k]).toFixed(4)])), teme: { ratioToSgp4: ratio("frames", "sgp4") }, earthFixed: { ratioToSgp4: ratio("framesEcef", "sgp4Ecef") } };
}

// ---- (2) a refill row by class and distance
if (!flag("--skip-rows")) {
  const classes = ["leo500", "leo830", "drag300", "ecc", "meo", "geo"];
  out.rows = {};
  for (const kind of classes) {
    const pop = population([[kind, ROWS]], 41, 1440);
    const f = await openFrames();
    await f.load(pop);
    for (const d of [0, 2, 5, 10]) {
      f.close();
      if (f.open(4e6) !== 0) fail("open");
      const ms = [], states = [];
      let halved = 0;
      for (let i = 0; i < pop.length; i++) {
        const s0 = f.stats();
        const c0 = cpu();
        f.refill(EPOCH_MS + pop[i].epochOffsetMs + d * DAY + 600e3, 0, 1, [i]);
        ms.push(cpu() - c0);
        const s1 = f.stats();
        halved += s1[STAT.split] > s0[STAT.split] ? 1 : 0;
        states.push(160 * (1 + (s1[STAT.split] - s0[STAT.split])));
      }
      out.rows[`${kind}@${d}d`] = { medianMs: +med(ms).toFixed(3), p95Ms: +quantile(ms, 0.95).toFixed(3), rowsThatHalved: halved, apStatesWorstRow: Math.max(...states) };
    }
  }
  // the refill CPU of 100,000 objects of the recipe's mix (30 % 500 km, 53 % 830 km and 17 % strong drag of its 85 % low; 5 % medium, 5 % geosynchronous, 5 % eccentric):
  // 1.25 rows an hour of a 48-minute window for each object, at each class's median row; and the first fill, one row an object
  const W = { leo500: 0.255, leo830: 0.4505, drag300: 0.1445, meo: 0.05, geo: 0.05, ecc: 0.05 };
  out.mix = {};
  for (const d of [0, 2, 5, 10]) {
    const rowMs = Object.entries(W).reduce((a, [k, w]) => a + w * out.rows[`${k}@${d}d`].medianMs, 0);
    out.mix[`${d}d`] = { meanRowMs: +rowMs.toFixed(3), coreSecondsAnHourAt100000: +((100000 * 1.25 * rowMs) / 1000).toFixed(0), firstFillSecondsAt100000: +((100000 * rowMs) / 1000).toFixed(0) };
  }
}

// ---- (3) the residue of wide sets in one instance
if (!flag("--skip-wide")) {
  const M = 40;
  const pop = population([["leo500", M / 2], ["leo830", M / 2], ["wide", 20]], 20261113, 48);
  const f = await openFrames();
  await f.load(pop);
  const t = EPOCH_MS + 2 * DAY + 600e3;
  const rows = () => {
    f.close(); f.open(4e6);
    const ms = [];
    for (let i = 0; i < M; i++) { const c0 = cpu(); f.refill(t, 0, 1, [i]); ms.push(cpu() - c0); }
    return med(ms);
  };
  const bytes = () => f.mem().byteLength;
  const b0 = bytes(), before = rows(), b1 = bytes();
  const p = f.x.sdnap_alloc(64);
  for (let i = M; i < M + 20; i++) f.ap(i, t);
  f.x.sdnap_epochs_stats(p);
  const storeBytes = new Float64Array(f.mem(), p, 8)[7];
  const b2 = bytes(), after = rows(), b3 = bytes();
  out.wide = { rowMedianMsBefore: +before.toFixed(3), rowMedianMsAfter: +after.toFixed(3), instanceBytes: { start: b0, afterRows: b1, afterWideFlown: b2, afterRowsAgain: b3 }, storeBytesAfterWide: storeBytes };
}
console.log(JSON.stringify(out, null, 1));
