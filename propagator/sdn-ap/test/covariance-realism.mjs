#!/usr/bin/env node
// Covariance realism of SDN-AP (SPEC 12) on laser-ranged precise orbits, and the fit of its process noise.
//
// Each window: the module's `fit` (THEORY SDNAP, or SGP4XP with --theory SGP4XP) on 24 h of a GCRF reference ephemeris (USEABLE_START_TIME to
// USEABLE_STOP_TIME), then its `propagate` of the fitted $OMM onto the reference epochs of the next 3 days every
// 30 min in GCRF, states and covariance lines both from the module. The script compares the module's numbers with the
// reference: e = model - reference, d^2 = e^T P^-1 e on the 3 x 3 position block, against chi-square(3): mean d^2 / 3
// (1), the share inside the 95 % ellipsoid (d^2 <= 7.815) and the median d^2 (2.366), per day of lead.
//
//   --set held-out     the experiment's windows (rows/slr-high.jsonl: LAGEOS-1/2, Etalon-1/2; rows/slr-low.jsonl: Ajisai,
//                      Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2) and LAGEOS-1 over 2026-02-01 .. 2026-05-31,
//                      scored with the module as built; LAGEOS-1 is its own row (never in a fit of the process noise)
//   --set calibration  windows of 2026-02-01 .. 2026-05-31 on the same satellites but LAGEOS-1 (none of the held-out
//                      dates): the
//                      process noise (SPEC 12.5: s_e, s_i, s_l and, in the drag regime, c) fitted per regime by maximum
//                      likelihood (the Gaussian negative log-likelihood of e under P, position block), from five
//                      propagations of each set (noise off, then each size alone at 1e-6: P is linear in the squared
//                      sizes); prints the constants for src/covariance.inc
//
//   --set fit | validation | c1-held-out   the sets of orbit-accuracy-experiments C1 (experiments/sdn-ap-covariance-
//                      calibration, PLAN 2 and amendment A1): fit 2026-02-01 .. 05-31 and validation 2025-11-01 .. 2026-01-31,
//                      2026-06-01 .. 08-31 on Ajisai, Starlette, LARETS, WESTPAC, LARES, LARES-2, LAGEOS-2, Etalon-1/2;
//                      c1-held-out: LAGEOS-1 and Stella on those dates (by object) and the experiment windows (by time).
//                      c1-held-out is scored once, with the chosen model built into the module (PLAN 5).
//   --decompose FILE   with fit or validation: one JSON line per window, every sample's error e, P0 (noise off), the
//                      four unit-noise matrices B, the floor F (SPEC 12.4, its UVW R rotated into the state's frame by
//                      the module's sdnap_uvw_to_frame) and the window's fit-residual statistics (RMS r, along-track lag
//                      autocorrelations), for test/covariance-candidates.mjs
//   node test/covariance-realism.mjs --theory SDNAP --set calibration --out test/results/covariance-calibration-sdnap.json
//   node test/covariance-realism.mjs --theory SGP4XP --set calibration --out test/results/covariance-calibration-sgp4xp.json
//   node test/covariance-realism.mjs --theory SDNAP --set held-out --out test/results/covariance-realism-sdnap.json
//   node test/covariance-realism.mjs --theory SGP4XP --set held-out --out test/results/covariance-realism-sgp4xp.json
//
// Reference: /opt/data/sdn-archive/reference-states/reference (ILRS combination and NSGF analysis-centre orbits as GCRF
// $OEM, made by analysis/reference-states). Space weather: the experiment's GFZ table (space-weather-history.prw).
// JS moves bytes and does statistics on the module's numbers; it computes no orbit and no frame.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SET = arg("set", "held-out");
const THEORY = arg("theory", "SDNAP");
const OUT = arg("out", null);
const LIMIT = Number(arg("limit", "0"));
const DECOMPOSE = arg("decompose", null);
if (SET === "c1-held-out" && DECOMPOSE) throw new Error("c1-held-out is scored once with the built model, never decomposed (C1 PLAN 5)");
const ARCHIVE = process.env.SDN_ARCHIVE ?? "/opt/data/sdn-archive";
const REFERENCE = path.join(ARCHIVE, "reference-states/reference");
const ROWS = path.join(ARCHIVE, "sdn-gp-starlink-ffm-match/rows");
const WEATHER = path.join(ARCHIVE, "sdn-gp-starlink-ffm-match/environment/space-weather-history.prw");
const DAY = 86400000, SAMPLE = 1800000, FIT = DAY, LEAD_DAYS = 3, UNIT = 1e-6;
const CHI2_3_95 = 7.814727903251178, CHI2_3_MEDIAN = 2.365973884375338;

const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const CONFIG = configuration({ theory: THEORY });
const weather = { portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: new Uint8Array(fs.readFileSync(WEATHER)) };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const ms = (text) => Date.parse(text.endsWith("Z") ? text : `${text}Z`);
const iso = (t) => new Date(t).toISOString().replace("Z", "");

// --- reference series
const readReference = (file) => OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(fs.readFileSync(file)))).unpack().EPHEMERIS_DATA_BLOCK[0];
const oemFile = (dir) => path.join(REFERENCE, dir, fs.readdirSync(path.join(REFERENCE, dir)).find((f) => f.endsWith(".oem")));
const seriesCache = new Map();
function series(dirs) {
  const key = dirs.join(",");
  if (seriesCache.has(key)) return seriesCache.get(key);
  const byEpoch = new Map();
  let head = null;
  for (const d of dirs) {
    const b = readReference(oemFile(d));
    head ??= b;
    for (const L of b.EPHEMERIS_DATA_LINES) byEpoch.set(L.EPOCH, L);
  }
  const lines = [...byEpoch.values()].sort((a, b) => ms(a.EPOCH) - ms(b.EPOCH));
  const s = { head, lines, t: Float64Array.from(lines, (L) => ms(L.EPOCH)) };
  seriesCache.set(key, s);
  return s;
}
const highDirs = (target) => fs.readdirSync(REFERENCE).filter((d) => d.startsWith(`ilrsa.orb.${target}.`)).sort();
const HIGH = { 8820: "lageos1", 22195: "lageos2", 19751: "etalon1", 20026: "etalon2" };
const LEO = { AJISAI: "ajisai", STARLETTE: "starlette", STELLA: "stella", LARETS: "larets", WESTPAC: "westpac", LARES: "lares", "LARES-2": "lares2" };

// C1 (orbit-accuracy-experiments experiments/sdn-ap-covariance-calibration, PLAN 2 and A1)
const C1 = {
  fitObjects: { leo: ["AJISAI", "STARLETTE", "LARETS", "WESTPAC", "LARES", "LARES-2"], high: ["lageos2", "etalon1", "etalon2"] },
  heldObjects: { leo: ["STELLA"], high: ["lageos1"] },
  fit: [[Date.UTC(2026, 1, 1), Date.UTC(2026, 5, 1)]],
  validation: [[Date.UTC(2025, 10, 1), Date.UTC(2026, 1, 1)], [Date.UTC(2026, 5, 1), Date.UTC(2026, 8, 1)]],
};
/** C1 windows of objects over date ranges: high orbits every 9 days from each range's start, LEO every second arc. */
function c1Windows(objects, ranges, set) {
  const out = [];
  const byNorad = Object.fromEntries(Object.entries(HIGH).map(([n, t]) => [t, Number(n)]));
  for (const target of objects.high)
    for (const [from, to] of ranges)
      for (let t = from; t + FIT + LEAD_DAYS * DAY <= to; t += 9 * DAY)
        out.push({ set: `${set}-high`, family: target, label: `${target} ${iso(t)}`, dirs: highDirs(target), start: t, norad: byNorad[target] });
  for (const name of objects.leo) {
    const target = LEO[name];
    const arcs = fs.readdirSync(REFERENCE).filter((d) => d.startsWith(`nsgf.orb.${target}.`)).sort();
    for (let k = 0; k < arcs.length; k += 2) {
      const a = arcs[k].split(".")[3];
      const t = Date.UTC(2000 + +a.slice(0, 2), +a.slice(2, 4) - 1, +a.slice(4, 6));
      if (!ranges.some(([from, to]) => t >= from && t < to)) continue;
      out.push({ set: `${set}-leo`, family: name, label: `${name} arc ${a}`, dirs: [arcs[k]], start: series([arcs[k]]).t[0] });
    }
  }
  return out;
}

/** Windows { set, family, label, dirs, start } of the chosen set. */
function windowsOf(set) {
  if (set === "fit") return c1Windows(C1.fitObjects, C1.fit, "fit");
  if (set === "validation") return c1Windows(C1.fitObjects, C1.validation, "validation");
  if (set === "c1-held-out") {
    // by object (A1: the fit and validation dates), then by time (the experiment windows, every object)
    return [...c1Windows(C1.heldObjects, [...C1.validation.slice(0, 1), ...C1.fit, ...C1.validation.slice(1)], "object"),
      ...windowsOf("held-out").filter((w) => w.set !== "lageos1-2026").map((w) => ({ ...w, set: `time-${w.set}` }))];
  }
  const out = [];
  if (set === "held-out") {
    for (const r of fs.readFileSync(path.join(ROWS, "slr-high.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse))
      out.push({ set: r.norad === 8820 ? "lageos1" : "high", family: r.id.replace(/ \(\d+\)$/, ""), label: `${r.id} ${r.startUtc}`, dirs: highDirs(HIGH[r.norad]), start: ms(r.startUtc) });
    for (const r of fs.readFileSync(path.join(ROWS, "slr-low.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse)) {
      const [, name, arc] = /^(.*) arc (\d{6})/.exec(r.id);
      const dir = fs.readdirSync(REFERENCE).find((d) => d.startsWith(`nsgf.orb.${LEO[name]}.${arc}.`));
      out.push({ set: "leo", family: name, label: `${r.id} ${r.startUtc}`, dirs: [dir], start: ms(r.startUtc) });
    }
  }
  // the calibration period: LAGEOS-1 is never fitted (it is held out, scored here as its own set)
  const from = Date.UTC(2026, 1, 1), to = Date.UTC(2026, 5, 1);
  for (const [norad, target] of Object.entries(HIGH)) {
    if ((set === "held-out") !== (target === "lageos1")) continue;
    const dirs = highDirs(target);
    for (let t = from; t + FIT + LEAD_DAYS * DAY <= to; t += 9 * DAY)
      out.push({ set: set === "held-out" ? "lageos1-2026" : "high", family: target, label: `${target} ${iso(t)}`, dirs, start: t, norad: Number(norad) });
  }
  if (set === "held-out") return out;
  for (const [name, target] of Object.entries(LEO)) {
    const arcs = fs.readdirSync(REFERENCE).filter((d) => d.startsWith(`nsgf.orb.${target}.`)).sort()
      .filter((d) => { const a = d.split(".")[3]; const t = Date.UTC(2000 + +a.slice(0, 2), +a.slice(2, 4) - 1, +a.slice(4, 6)); return t >= from && t < to; });
    for (let k = 0; k < arcs.length; k += 2) {
      const s = series([arcs[k]]);
      out.push({ set: "leo", family: name, label: `${name} arc ${arcs[k].split(".")[3]}`, dirs: [arcs[k]], start: s.t[0] });
    }
  }
  return out;
}

// --- module calls
function oemBytes(head, lines, useStart, useStop, frame = "GCRF") {
  const block = new ephemerisDataBlockT();
  block.OBJECT = head.OBJECT;
  block.CENTER_NAME = "EARTH";
  block.REFERENCE_FRAME = rfm(frame);
  block.TIME_SYSTEM = timingStandard.UTC;
  block.START_TIME = lines[0].EPOCH;
  block.STOP_TIME = lines.at(-1).EPOCH;
  if (useStart) block.USEABLE_START_TIME = useStart;
  if (useStop) block.USEABLE_STOP_TIME = useStop;
  block.EPHEMERIS_DATA_LINES = lines.map((L) => new ephemerisDataLineT(L.EPOCH, L.X, L.Y, L.Z, L.X_DOT, L.Y_DOT, L.Z_DOT));
  const o = new OEMT();
  o.CCSDS_OEM_VERS = 3.0;
  o.ORIGINATOR = "SDN-AP covariance realism";
  o.EPHEMERIS_DATA_BLOCK = [block];
  const b = new flatbuffers.Builder(1 << 20);
  OEM.finishOEMBuffer(b, o.pack(b));
  return b.asUint8Array();
}
async function call(methodId, inputs) {
  const r = await command.invoke({ methodId, inputs: [CONFIG, weather, ...inputs] });
  if (r.statusCode !== 0) throw new Error(`${methodId}: ${r.errorCode} ${r.errorMessage}`);
  return r.outputs;
}
/** The $OMM with USER_DEFINED_SDNAP_COV_NOISE replaced (bytes in, bytes out; the module reads it). */
function withNoise(ommBytes, noise) {
  const t = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(ommBytes)).unpack();
  const p = t.USER_DEFINED_PARAMETERS.find((u) => u.PARAM_NAME === "SDNAP_COV_NOISE");
  p.PARAM_VALUE = noise.map((v) => v.toPrecision(17)).join(" ");
  const b = new flatbuffers.Builder(4096);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
const userDefined = (bytes) => Object.fromEntries(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack().USER_DEFINED_PARAMETERS.map((u) => [u.PARAM_NAME, u.PARAM_VALUE]));
async function propagated(ommBytes, gridBytes) {
  const [out] = await call("propagate", [{ portId: "omm", typeRef: ommType, payload: ommBytes }, { portId: "grid", typeRef: oemType, payload: gridBytes }]);
  const blk = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(out.payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  if (blk.COVARIANCE_MATRIX_LINES.length !== blk.EPHEMERIS_DATA_LINES.length) throw new Error("propagate: no covariance lines");
  return blk;
}
const pos3 = (c) => [c.CX_X, c.CY_X, c.CY_Y, c.CZ_X, c.CZ_Y, c.CZ_Z];  // lower triangle xx, yx, yy, zx, zy, zz

// --- 3 x 3 symmetric algebra (lower triangles)
function d2AndLogDet(L, e) {
  const [a, b, c, d, f, g] = L;  // [[a b d] [b c f] [d f g]]
  const det = a * (c * g - f * f) - b * (b * g - f * d) + d * (b * f - c * d);
  if (!(det > 0)) return null;
  const i00 = (c * g - f * f) / det, i01 = (d * f - b * g) / det, i02 = (b * f - c * d) / det;
  const i11 = (a * g - d * d) / det, i12 = (b * d - a * f) / det, i22 = (a * c - b * b) / det;
  const d2 = e[0] * (i00 * e[0] + i01 * e[1] + i02 * e[2]) + e[1] * (i01 * e[0] + i11 * e[1] + i12 * e[2]) + e[2] * (i02 * e[0] + i12 * e[1] + i22 * e[2]);
  return { d2, logDet: Math.log(det) };
}

// --- the module's UVW axes of a state (sdnap_uvw_to_frame, sdnap_frame_to_uvw): direct exports, no frame math here
const direct = DECOMPOSE ? await openModule() : null;
function uvwCall(name, r, v, vec) {
  const x = direct.x, p = x.sdnap_alloc(96);
  const f = () => new Float64Array(direct.harness.memory.buffer, p, 12);
  f().set([...r, ...v, ...vec, 0, 0, 0]);
  x[name](p, p + 24, p + 48, p + 72);
  const out = Array.from(f().subarray(9, 12));
  x.sdnap_free(p);
  return out;
}
/** The floor F (SPEC 12.4) position block at a state, lower triangle: M R M^T, M's columns the U, V, W axes. */
function floorAt(R6, r, v) {
  const [uu, vu, vv, wu, wv, ww] = R6;
  const R = [[uu, vu, wu], [vu, vv, wv], [wu, wv, ww]];
  const M = [0, 1, 2].map((a) => uvwCall("sdnap_uvw_to_frame", r, v, [a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0]));  // M[a] = axis a in the frame
  const F = (i, j) => { let sum = 0; for (let a = 0; a < 3; ++a) for (let b = 0; b < 3; ++b) sum += M[a][i] * R[a][b] * M[b][j]; return sum; };
  return [F(0, 0), F(1, 0), F(1, 1), F(2, 0), F(2, 1), F(2, 2)];
}
/** The fit residuals' statistics over the arc: 3D RMS r (km) and the along-track lag autocorrelations (lags 1..20). */
function residualStats(fitBlock, fitLines) {
  const along = [];
  let sum = 0;
  fitLines.forEach((L, k) => {
    const m = fitBlock.EPHEMERIS_DATA_LINES[k];
    const e = [m.X - L.X, m.Y - L.Y, m.Z - L.Z];
    sum += e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
    along.push(uvwCall("sdnap_frame_to_uvw", [m.X, m.Y, m.Z], [m.X_DOT, m.Y_DOT, m.Z_DOT], e)[1]);
  });
  const mean = along.reduce((a, b) => a + b, 0) / along.length;
  const c = along.map((a) => a - mean);
  const c0 = c.reduce((a, b) => a + b * b, 0);
  const rho = [];
  for (let j = 1; j <= 20; ++j) { let cj = 0; for (let k = j; k < c.length; ++k) cj += c[k] * c[k - j]; rho.push(cj / c0); }
  return { rms: Math.sqrt(sum / fitLines.length), rho, samples: fitLines.length };
}

// --- one window: samples { lead (days), e (km), P0, B (lower triangles) }
async function runWindow(w, calibrate) {
  const s = series(w.dirs);
  const fitLines = [], heldLines = [];
  let mark = w.start + FIT + SAMPLE;
  for (let k = 0; k < s.lines.length; ++k) {
    const t = s.t[k];
    if (t >= w.start && t <= w.start + FIT) fitLines.push(s.lines[k]);
    else if (t > w.start + FIT && t <= w.start + FIT + LEAD_DAYS * DAY + 1 && t >= mark - 1) {
      heldLines.push(s.lines[k]);
      mark = t + SAMPLE;
    }
  }
  if (fitLines.length < 48 || heldLines.length < 10) return { skipped: "too few reference states" };
  const fitted = await call("fit", [{ portId: "ephemeris", typeRef: oemType, payload: oemBytes(s.head, fitLines, fitLines[0].EPOCH, fitLines.at(-1).EPOCH) }]);
  const omm = fitted.find((o) => o.portId === "elements").payload;
  const ud = userDefined(omm);
  if (ud.SDNAP_COV_NOISE === undefined) return { skipped: "no covariance" };
  const tA = Number(ud.SDNAP_COV_NOISE.split(" ")[4]);
  const grid = oemBytes(s.head, heldLines, null, null);
  const fitEnd = ms(fitLines.at(-1).EPOCH);
  // calibration: P is P0 + sum_k s_k^2 B_k (s_e, s_i, s_l, s_d); each B_k from a propagation at s_k = UNIT alone
  const P = await propagated(calibrate || DECOMPOSE ? withNoise(omm, [0, 0, 0, 0, tA, 0]) : omm, grid);
  const units = calibrate || DECOMPOSE ? await Promise.all([0, 1, 2, 3].map((k) => propagated(withNoise(omm, [...[0, 1, 2, 3].map((j) => (j === k ? UNIT : 0)), tA, 0]), grid))) : [];
  const samples = heldLines.map((L, k) => {
    const m = P.EPHEMERIS_DATA_LINES[k];
    const e = [m.X - L.X, m.Y - L.Y, m.Z - L.Z];
    const P0 = pos3(P.COVARIANCE_MATRIX_LINES[k]);
    const B = units.map((u) => pos3(u.COVARIANCE_MATRIX_LINES[k]).map((v, j) => (v - P0[j]) / (UNIT * UNIT)));
    const F = DECOMPOSE ? floorAt(ud.SDNAP_COV_FLOOR_UVW.split(" ").map(Number), [m.X, m.Y, m.Z], [m.X_DOT, m.Y_DOT, m.Z_DOT]) : undefined;
    return { lead: (ms(L.EPOCH) - fitEnd) / DAY, e, P0, B, F };
  });
  const residuals = DECOMPOSE ? residualStats(await propagated(withNoise(omm, [0, 0, 0, 0, tA, 0]), oemBytes(s.head, fitLines, null, null)), fitLines) : undefined;
  const drag = ud.SDNAP_COV_REGIME === "DRAG";
  const nDay = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(omm)).MEAN_MOTION() * 2 * Math.PI;
  return { samples, regime: drag ? "drag" : "above", ngRate: Number(ud.SDNAP_COV_NG_RATE), nDay, noise: ud.SDNAP_COV_NOISE, residuals,
    arcEndDays: tA / 1440, fitEndFromEpochDays: (fitEnd - ms(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(omm)).EPOCH())) / DAY };
}

// --- statistics
function dayStats(list) {
  const out = {};
  for (let day = 1; day <= LEAD_DAYS; ++day) {
    const d2 = [], rms = [];
    const windows = new Set();
    for (const { w, s } of list)
      if (s.lead > day - 1 && s.lead <= day) {
        const r = d2AndLogDet(s.P, s.e);
        if (!r) continue;
        d2.push(r.d2);
        rms.push(s.e[0] ** 2 + s.e[1] ** 2 + s.e[2] ** 2);
        windows.add(w);
      }
    if (!d2.length) continue;
    d2.sort((a, b) => a - b);
    const mean = d2.reduce((a, b) => a + b, 0) / d2.length;
    out[day] = {
      windows: windows.size, samples: d2.length,
      meanD2Over3: +(mean / 3).toPrecision(4),
      coverage95: +(d2.filter((x) => x <= CHI2_3_95).length / d2.length).toPrecision(4),
      medianD2: +d2[Math.floor(d2.length / 2)].toPrecision(4),
      positionRmsKm: +Math.sqrt(rms.reduce((a, b) => a + b, 0) / rms.length).toPrecision(4),
    };
  }
  return out;
}

const windows = windowsOf(SET).slice(0, LIMIT > 0 ? LIMIT : undefined);
const calibrate = SET === "calibration";
const results = [];
let skipped = 0;
for (const [k, w] of windows.entries()) {
  try {
    const r = await runWindow(w, calibrate);
    if (r.skipped) { ++skipped; console.log(`${w.label}: skipped (${r.skipped})`); continue; }
    results.push({ w, ...r });
    const last = r.samples.at(-1);
    console.log(`[${k + 1}/${windows.length}] ${w.label}: ${r.samples.length} samples, day-${Math.ceil(last.lead)} |e| ${Math.hypot(...last.e).toFixed(3)} km, r_ng ${r.ngRate.toExponential(2)}/day`);
  } catch (error) {
    ++skipped;
    console.log(`${w.label}: failed (${error.message})`);
  }
}

if (DECOMPOSE) {
  fs.writeFileSync(DECOMPOSE, results.map((r) => JSON.stringify({ set: r.w.set, family: r.w.family, label: r.w.label, regime: r.regime, ngRate: r.ngRate, nDay: r.nDay,
    residuals: r.residuals, arcEndDays: r.arcEndDays, fitEndFromEpochDays: r.fitEndFromEpochDays, samples: r.samples })).join("\n") + "\n");
  console.log(`decomposition: ${results.length} windows, ${skipped} skipped -> ${DECOMPOSE}`);
  process.exit(0);
}
const DUMP = arg("dump", null);  // the samples (e, P, lead) as JSON lines, for study
if (DUMP) fs.writeFileSync(DUMP, results.map((r) => JSON.stringify({ set: r.w.set, family: r.w.family, label: r.w.label, regime: r.regime, ngRate: r.ngRate, nDay: r.nDay, samples: r.samples })).join("\n") + "\n");
const report = { task: "modules-sdn-ap-covariance-20261025", set: SET, theory: THEORY, created: new Date().toISOString(), moduleSha256: createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex"), windows: results.length, skipped, sampleMinutes: SAMPLE / 60000, fitHours: FIT / 3600000 };
if (calibrate) {
  // maximum likelihood per regime of (s_e, s_i, s_l, c): s_d = c |r_ng| n per window
  const sizes = (r, th) => [th[0], th[1], th[2], th[3] * Math.abs(r.ngRate) * r.nDay];
  const covOf = (s, sz) => s.P0.map((v, j) => v + sz.reduce((acc, z, k) => acc + z * z * s.B[k][j], 0));
  const nll = (rs, th) => {
    let sum = 0;
    for (const r of rs) {
      const sz = sizes(r, th);
      for (const s of r.samples) {
        const d = d2AndLogDet(covOf(s, sz), s.e);
        if (!d) return Infinity;
        sum += d.logDet + d.d2;
      }
    }
    return sum;
  };
  report.processNoise = {};
  report.inSample = {};
  const constants = {};
  for (const regime of ["drag", "above"]) {
    const rs = results.filter((r) => r.regime === regime);
    if (!rs.length) continue;
    const active = regime === "drag" ? [0, 1, 2, 3] : [0, 1, 2];
    // log10 of each size (-inf: off), coordinate search from a grid of common starts
    let best = null;
    for (const start of [-9, -8, -7, -6, -5]) {
      let lg = [start, start, start, regime === "drag" ? -1 : -Infinity];
      let v = nll(rs, lg.map((x) => 10 ** x));
      for (let step = 1; step >= 1 / 256; step /= 2) {
        let moved = true;
        while (moved) {
          moved = false;
          for (const k of active)
            for (const dir of [1, -1]) {
              const trial = lg.slice();
              trial[k] += dir * step;
              const tv = nll(rs, trial.map((x) => 10 ** x));
              if (tv < v) { lg = trial; v = tv; moved = true; }
            }
        }
      }
      if (!best || v < best.v) best = { lg, v };
    }
    const th = best.lg.map((x) => 10 ** x);
    constants[regime] = th;
    report.processNoise[regime] = { s_e: +th[0].toPrecision(4), s_i: +th[1].toPrecision(4), s_l: +th[2].toPrecision(4), c: +th[3].toPrecision(4), negativeLogLikelihood: best.v, windows: rs.length, samples: rs.reduce((a, r) => a + r.samples.length, 0) };
    console.log(`process noise, ${regime} regime: s_e ${th[0].toPrecision(4)}/day, s_i ${th[1].toPrecision(4)}/day, s_l ${th[2].toPrecision(4)}, c ${th[3].toPrecision(4)} (NLL ${best.v.toFixed(1)}, ${rs.length} windows)`);
  }
  report.processNoise.model = "rate errors constant from the arc end: eccentricity vector s_e/day, inclination vector s_i/day, mean longitude s_l n, n-dot c |n-dot_ng| (drag regime)";
  const at = (r) => r.samples.map((s) => ({ w: r.w.label, s: { ...s, P: covOf(s, sizes(r, constants[r.regime])) } }));
  for (const set of ["high", "leo"]) {
    const rs = results.filter((r) => r.w.set === set);
    report.inSample[set] = { all: dayStats(rs.flatMap(at)), byObject: Object.fromEntries([...new Set(rs.map((r) => r.w.family))].map((f) => [f, dayStats(rs.filter((r) => r.w.family === f).flatMap(at))])) };
  }
} else {
  const at = (r) => r.samples.map((s) => ({ w: r.w.label, s: { ...s, P: s.P0 } }));
  report.realism = {};
  for (const set of ["lageos1", "lageos1-2026", "high", "leo"]) {
    const rs = results.filter((r) => r.w.set === set);
    if (!rs.length) continue;
    report.realism[set] = { all: dayStats(rs.flatMap(at)), byObject: Object.fromEntries([...new Set(rs.map((r) => r.w.family))].map((f) => [f, dayStats(rs.filter((r) => r.w.family === f).flatMap(at))])) };
  }
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(calibrate ? report.inSample : report.realism).map(([k, v]) => [k, v.all])), null, 1));
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
process.exit(0);
