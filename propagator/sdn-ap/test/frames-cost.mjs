#!/usr/bin/env node
// SPEC 19.7, cost of the frames (a measurement, not an assertion). Process CPU time; the kinds alternate round by round in one process, so read the ratios.
//  (1) a frame of N objects through sdnap_frames_at against the same through the module's SGP4 (sdnap_epochs_at on SGP4 records), microseconds a state and the ratio;
//  (2) a refill row of a low set (one cold set, one cell) before and after 20 wide sets were flown through sdnap_epochs_set_at in the same instance, and the
//      instance's bytes at each step.
//   node test/frames-cost.mjs [--objects 20000] [--rounds 9]
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
const N = arg("--objects", 20000), ROUNDS = arg("--rounds", 9);
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };  // ms
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const share = (n, p) => Math.round((n * p) / 100);
const out = { loadAvg: os.loadavg(), objects: N };

// ---- (1) frame against SGP4
{
  const low = share(N, 85), plan = [["leo500", Math.round(low * 0.3)], ["leo830", Math.round(low * 0.53)], ["drag300", low - Math.round(low * 0.3) - Math.round(low * 0.53)], ["meo", share(N, 5)], ["geo", share(N, 5)], ["ecc", N - low - 2 * share(N, 5)]];
  const f = await openFrames();
  await f.load(population(plan, 20261113, 48));
  const need = (f.open(1e9), f.stats()[STAT.table]);
  f.close();
  assert(f.open(N * 1100 + need + (1 << 20)) === 0);
  const t = EPOCH_MS + 3600e3;
  let due = f.refill(t, 180, 5000); while (due > 0) due = f.refill(t, 180, 5000);
  const x = f.x, pl = x.sdnap_alloc(48 * N), st = x.sdnap_alloc(4 * N), [w, fr] = f.jd(t);
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
    frames: () => { for (let j = 1; j <= 5; j++) x.sdnap_frames_at(w, fr + (j * 1) / 86400, 0, N, 0, pl, st); return 5 * N; },
  };
  const res = { sgp4: [], frames: [] };
  for (let r = 0; r < ROUNDS; r++) for (const k of r % 2 ? ["frames", "sgp4"] : ["sgp4", "frames"]) { const c0 = cpu(); const n = kinds[k](); res[k].push(((cpu() - c0) * 1000) / n); }
  out.frame = { sgp4UsPerState: +med(res.sgp4).toFixed(4), framesUsPerState: +med(res.frames).toFixed(4), ratioToSgp4: +med(res.frames.map((v, r) => v / res.sgp4[r])).toFixed(3) };
}

// ---- (2) the residue of wide sets in one instance
{
  const M = Math.min(N, 40);
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
function assert(c) { if (!c) throw new Error("assertion"); }
