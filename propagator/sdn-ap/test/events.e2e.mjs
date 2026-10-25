#!/usr/bin/env node
// E2E (task modules-sdn-gp-launch-reentry-maneuvers-20261024): maneuvers as boundaries between SDN-AP sets
// (DESIGN 5.1, measurements M22 and M23), their detection (5.1.4), reentry (5.2, M28) and the first set of a
// launch (5.3.1). The reference is FFM-1 (the modules' propagator/ffm) of a LEO state with synthetic burns. An SDN-AP set is
// fitted to the first 48 h of the burn-free reference; the 'maneuver' method carries it across a burn at 48 h; its
// states on days 1 to 3 after the burn are scored against the reference with the same burn, next to the set's own
// burn-free error (the no-maneuver accuracy the map must keep).
//   - M22: impulses of 1 mm/s, 10 cm/s and 1 m/s along V and 1 m/s along U and W: within 10 % (+ 50 m) of the
//     burn-free error on days 1 to 3.
//   - M23: 60-minute 1 m/s burns along V, U and W: the finite-burn map (sinc(dL/2) on the eccentricity-vector, plane
//     and mean-longitude changes) adds no more error than the centroid impulse (days 1-3 summed), and along V stays
//     within 10 % (+ 100 m) of the burn-free error.
//   - Refusals by name: a burn before the set's epoch, no $MNV.
// JS orchestrates and scores; the dynamics, the fit and the maps are the module's.
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameter } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { MNV, MNVT } from "spacedatastandards.org/lib/js/MNV/MNV.js";
import { maneuverStatus } from "spacedatastandards.org/lib/js/MNV/maneuverStatus.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { FRAME_PROBE, jdOf, packOem, rfm, rotate } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { PCF_TYPE, configuration, pcf, withConfiguration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
// every configured method takes a $PCF (the defaults unless a call names its own); THEORY SDNAP selects the SDN-AP fit
const command0 = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
const SDNAP = configuration({ theory: "SDNAP" });
let command = command0;
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const mnvType = { schemaName: "MNV.fbs", fileIdentifier: "$MNV", rootTypeName: "MNV" };
const EPOCH = "2026-10-20T12:00:00.000000";
const epochMs = Date.parse(EPOCH + "Z");
const iso = (s) => new Date(epochMs + s * 1000).toISOString().replace("Z", "000");
const FIT_H = 48, STEP = 300, B = 0.012, AGOM = 0.01;

// the seed state: an SGP4XP set (ISS-like, 420 km) at its epoch
const seed = (() => {
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString(EPOCH);
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  OMM.addMeanMotion(b, 15.5);
  OMM.addEccentricity(b, 0.0005);
  OMM.addInclination(b, 51.6);
  OMM.addRaOfAscNode(b, 120);
  OMM.addArgOfPericenter(b, 90);
  OMM.addMeanAnomaly(b, 30);
  OMM.addNoradCatId(b, 90030);
  OMM.addMeanElementTheory(b, 1);
  OMM.addBstar(b, B);
  OMM.addMeanMotionDdot(b, AGOM);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
})();
const template = (await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: seed }] })).outputs[0].payload;
const y0 = (() => { const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0]; return [L.X, L.Y, L.Z, L.X_DOT, L.Y_DOT, L.Z_DOT]; })();
const ep = jdOf(EPOCH);

// the reference: FFM-1 (the modules' propagator/ffm: EGM2008 70 x 70, DE440 Sun, Moon and planets, NRLMSISE-00 under
// the same space weather as the module, SRP, tides, relativity) in GCRF; burns as restarts: an impulse adds its UVW
// Delta v to the state at its epoch, a finite burn is 30 equal impulses at the midpoints of 60 s pieces. States in
// TEME (km, km/s) at `times` (s from the epoch). SDN_MODULES_ROOT: a built modules checkout with propagator/ffm;
// SDNAP_FFM_ENVIRONMENT: the EOP and space-weather frames; SDNAP_FFM_KERNEL: DE440 (de440s.bsp).
const MODULES = process.env.SDN_MODULES_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
if (!fs.existsSync(path.join(MODULES, "propagator/ffm/plugin-manifest.json"))) {
  throw new Error(`events E2E: no FFM-1 module at ${MODULES}/propagator/ffm; set SDN_MODULES_ROOT to a modules checkout that carries it`);
}
const ENV_FILE = process.env.SDNAP_FFM_ENVIRONMENT ?? "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/environment.json";
const KERNEL = process.env.SDNAP_FFM_KERNEL ?? "/opt/data/sdn-archive/hac/naif-kernels/spk/planets/de440s.bsp";
const catalog = await import(pathToFileURL(path.join(MODULES, "propagator/ffm/catalog.mjs")));
const envmod = await import(pathToFileURL(path.join(MODULES, "analysis/od/scripts/operator-environment.mjs")));
const ffb = await import(pathToFileURL(path.join(MODULES, "node_modules/flatbuffers/mjs/flatbuffers.js")));
const environment = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
const ffmInputs = [envmod.input("kernel", "PRW", catalog.kernelRecord(fs.readFileSync(KERNEL))),
  ...Object.entries(environment.inputs).map(([portId, b64]) => envmod.input(portId, "PRW", new Uint8Array(Buffer.from(b64, "base64"))))];
const ffmDir = path.join(MODULES, "propagator/ffm");
const ffm = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(ffmDir, "dist/isomorphic/module.wasm")), manifest: JSON.parse(fs.readFileSync(path.join(ffmDir, "plugin-manifest.json"), "utf8")), surface: "direct" });
// the module reads the same space weather
const weatherFrame = { portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: new Uint8Array(Buffer.from(environment.inputs.space_weather, "base64")) };
// every call that reads the density carries the weather (each command call is a fresh instance)
const WEATHER_METHODS = new Set(["fit", "propagate", "maneuver", "detect_maneuvers", "reentry", "launch_batch"]);
command = { invoke: (req) => command0.invoke(WEATHER_METHODS.has(req.methodId) && !req.inputs.some((i) => i.portId === "space_weather_table") ? { ...req, inputs: [...req.inputs, weatherFrame] } : req) };
const isoMs = (msx) => new Date(Math.round(msx)).toISOString();
const ffmRun = async (gcrfKm, startMs, sampleMs, cdAm, crAm) => {
  const request = catalog.fullForceRequest({ epoch: isoMs(startMs), state: gcrfKm.map((x) => x * 1000), target: isoMs(sampleMs.at(-1)), cdAm, crAm });
  request.SAMPLE_EPOCHS = sampleMs.map((t) => catalog.instant(isoMs(t)));
  const r = await ffm.invoke({ methodId: "invoke", inputs: [{ portId: "request", typeRef: catalog.TYPE, payload: catalog.encode("EXECUTION_REQUEST", request) }, ...ffmInputs] });
  if (r.statusCode !== 0) throw new Error(`FFM-1: ${r.errorCode} ${r.errorMessage}`);
  const res = catalog.prw.PRW.getSizePrefixedRootAsPRW(new ffb.ByteBuffer(new Uint8Array(r.outputs.find((f) => f.portId === "response").payload))).unpack().EXECUTION_RESULT;
  return res.SAMPLES.map((q) => { const v = q.STATE.STATE; return ["POSITION", "VELOCITY"].flatMap((k) => ["X", "Y", "Z"].map((c) => v[k][c] / 1000)); });
};
const frameAt = (state, msx, mode) => { const j = jdOf(isoMs(msx).replace("Z", "")); return rotate(m, j.whole, j.frac, state, mode).out; };
const uvwAdd = (s6, dv) => {
  const p = m.x.sdnap_alloc(96);
  new Float64Array(m.harness.memory.buffer, p, 9).set([...s6, ...dv]);
  m.x.sdnap_uvw_to_frame(p, p + 24, p + 48, p + 72);
  const d = Array.from(new Float64Array(m.harness.memory.buffer, p + 72, 3));
  m.x.sdnap_free(p);
  return [s6[0], s6[1], s6[2], s6[3] + d[0], s6[4] + d[1], s6[5] + d[2]];
};
// burns: [t0, t1, u, v, w] (s; t1 == t0 an impulse in km/s, else a constant UVW acceleration in km/s^2)
const ffmTruth = async (y0Teme, startMs, sampleS, burns, cdAm, crAm) => {
  const kicks = [];
  for (const [t0, t1, ...q] of burns) {
    if (t1 === t0) kicks.push([t0, q]);
    else { const K = 30, dt = (t1 - t0) / K; for (let k = 0; k < K; ++k) kicks.push([t0 + (k + 0.5) * dt, q.map((x) => x * dt)]); }
  }
  kicks.sort((a, b) => a[0] - b[0]);
  let state = frameAt(y0Teme, startMs, FRAME_PROBE.TEME_TO_GCRF), tc = 0;
  const out = new Array(sampleS.length);
  let next = 0;
  for (const [tk, dv] of [...kicks, [Infinity, null]]) {
    const until = Math.min(tk, sampleS.at(-1));
    const idx = [];
    while (next < sampleS.length && sampleS[next] <= until && sampleS[next] < tk) idx.push(next++);
    const samp = idx.map((k) => sampleS[k]);
    if (Number.isFinite(tk)) samp.push(tk);
    if (samp.length === 0) break;
    const got = samp[0] === tc && samp.length === 1 ? [state] : await ffmRun(state, startMs + tc * 1000, samp.map((s2) => startMs + s2 * 1000), cdAm, crAm);
    idx.forEach((k, j) => { out[k] = got[j]; });
    if (!Number.isFinite(tk)) break;
    state = uvwAdd(got.at(-1), dv);
    tc = tk;
  }
  return out.map((g, k) => frameAt(g, startMs + sampleS[k] * 1000, FRAME_PROBE.GCRF_TO_TEME));
};
const times = Array.from({ length: (FIT_H + 72) * 3600 / STEP + 1 }, (_, k) => k * STEP);
const reference = async (burns) => ffmTruth(y0, epochMs, times, burns, B, AGOM);
const oemOf = (states, from, to, zero = false) => {
  const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
  const b = t.EPHEMERIS_DATA_BLOCK[0];
  b.START_TIME = b.STOP_TIME = b.USEABLE_START_TIME = b.USEABLE_STOP_TIME = null;
  b.REFERENCE_FRAME = rfm("TEME", "both");
  b.EPHEMERIS_DATA_LINES = [];
  times.forEach((s, k) => { if (s >= from && s <= to) b.EPHEMERIS_DATA_LINES.push(new ephemerisDataLineT(iso(s), ...(zero ? [0, 0, 0, 0, 0, 0] : states[k]))); });
  t.EPHEMERIS_DATA_BLOCK = [b];
  return packOem(t);
};
const truth0 = await reference([]);
const fitted = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: oemOf(truth0, 0, FIT_H * 3600) }] });
check(fitted.statusCode === 0, `fit SDNAP of the reference: ${fitted.errorCode}`);
const set = fitted.outputs.find((o) => o.portId === "elements").payload;
// $PCF 1.0: THEORY SDNAP gives an SDN-AP set with MEAN_ELEMENT_THEORY SDNAP (no user-defined theory);
// FIT.DEFAULT_SPAN_HOURS 24 fits the latest 24 h of the same arc; fields the module cannot apply are refused by name
{
  const om = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(set));
  const names = Array.from({ length: om.userDefinedParametersLength() }, (_, k) => om.USER_DEFINED_PARAMETERS(k).PARAM_NAME());
  console.log(`$PCF THEORY SDNAP: MEAN_ELEMENT_THEORY ${om.MEAN_ELEMENT_THEORY()} (SDNAP 4), user-defined THEORY ${names.includes("THEORY") ? "present" : "absent"}`);
  check(om.MEAN_ELEMENT_THEORY() === 4 && !names.includes("THEORY"), `SDN-AP set theory ${om.MEAN_ELEMENT_THEORY()}`);
  const day = await command.invoke({ methodId: "fit", inputs: [configuration({ theory: "SDNAP", fit: { DEFAULT_SPAN_HOURS: 24 } }), { portId: "ephemeris", typeRef: oemType, payload: oemOf(truth0, 0, FIT_H * 3600) }] });
  const dc = day.statusCode === 0 ? OMM.getRootAsOMM(new flatbuffers.ByteBuffer(day.outputs.find((o) => o.portId === "elements").payload)) : null;
  const spanOf = (c) => Number(/span ([\d.]+) h/.exec(c ?? "")?.[1]);
  const epochLag = dc ? (Date.parse(dc.EPOCH().slice(0, 23) + "Z") - epochMs) / 3600e3 : NaN;
  console.log(`$PCF FIT.DEFAULT_SPAN_HOURS 24 on the ${FIT_H} h arc: span ${spanOf(dc?.COMMENT())} h, set epoch ${epochLag.toFixed(3)} h after the arc start (default: span ${spanOf(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(set)).COMMENT())} h)`);
  check(dc !== null && Math.abs(spanOf(dc.COMMENT()) - 24) < 0.01 && Math.abs(epochLag - (FIT_H - 24)) < 0.01, `FIT.DEFAULT_SPAN_HOURS 24: ${day.errorCode} ${dc?.COMMENT()}`);
  const refusals = [
    ["fit", { theory: "FFM" }, "THEORY"],
    ["fit", { theory: "SGP4XP", mean: { ZONAL_MAXIMUM_DEGREE: 30 } }, "MEAN_ELEMENT.ZONAL_MAXIMUM_DEGREE"],
    ["fit", { theory: "SDNAP", forces: { EPHEMERIS_SOURCE: "", ENABLE_DRAG: true } }, "FORCES.ENABLE_DRAG"],
    ["reentry", { reentry: { WINDOW_METHOD: 2 } }, "REENTRY.WINDOW_METHOD"],
    ["detect_maneuvers", { detect: { FALSE_ALARMS_PER_OBJECT_YEAR: 0.1 } }, "MANEUVER_DETECTION.FALSE_ALARMS_PER_OBJECT_YEAR"],
  ];
  for (const [method, options, field] of refusals) {
    const input = method === "reentry" ? { portId: "omm", typeRef: ommType, payload: set } : { portId: "ephemeris", typeRef: oemType, payload: oemOf(truth0, 0, FIT_H * 3600) };
    const r = await command.invoke({ methodId: method, inputs: [configuration(options), input] });
    console.log(`$PCF refusal, ${method} ${JSON.stringify(options)}: ${r.errorCode} ${r.errorMessage}`);
    check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith(field + ":"), `${method} ${field}: ${r.errorCode} ${r.errorMessage}`);
  }
}
const grid = { portId: "grid", typeRef: oemType, payload: oemOf(truth0, FIT_H * 3600 + STEP, (FIT_H + 72) * 3600, true) };
const score = (statesOut, truth) => {
  const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(statesOut)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  const ss = [0, 0, 0], n = [0, 0, 0];
  let j = 0;
  times.forEach((s, k) => {
    if (s <= FIT_H * 3600) return;
    const q = L[j++], r = truth[k];
    const d = Math.min(2, Math.floor((s - FIT_H * 3600 - 1) / 86400));
    ss[d] += (q.X - r[0]) ** 2 + (q.Y - r[1]) ** 2 + (q.Z - r[2]) ** 2;
    n[d] += 1;
  });
  return ss.map((x, d) => Math.sqrt(x / n[d]));
};
const base = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: set }, grid] });
const err0 = score(base.outputs[0].payload, truth0);
console.log(`burn-free: SDN-AP set fitted on ${FIT_H} h, days 1 / 2 / 3 RMS ${err0.map((x) => x.toFixed(3)).join(" / ")} km`);

const mnv = (startS, endS, dv) => {
  const t = new MNVT();
  t.ID = "E2E-BURN";
  t.SAT_NO = 90030;
  t.STATUS = maneuverStatus.PLANNED;
  t.EVENT_START_TIME = iso(startS);
  if (endS > startS) t.EVENT_END_TIME = iso(endS);
  [t.DELTA_VEL_U, t.DELTA_VEL_V, t.DELTA_VEL_W] = dv;
  const b = new flatbuffers.Builder(512);
  MNV.finishMNVBuffer(b, t.pack(b));
  return b.asUint8Array();
};
const across = async (startS, endS, dv) => command.invoke({ methodId: "maneuver", inputs: [{ portId: "omm", typeRef: ommType, payload: set }, { portId: "maneuvers", typeRef: mnvType, payload: mnv(startS, endS, dv) }, grid] });
const tb = FIT_H * 3600;
// M22: impulses at the end of the fit arc
for (const [label, dv] of (process.env.QUICK ? [] : [["V 1 mm/s", [0, 1e-6, 0]], ["V 10 cm/s", [0, 1e-4, 0]], ["V 1 m/s", [0, 1e-3, 0]], ["U 1 m/s", [1e-3, 0, 0]], ["W 1 m/s", [0, 0, 1e-3]]])) {
  const truth = await reference([[tb, tb, ...dv]]);
  const r = await across(tb, tb, dv);
  if (r.statusCode !== 0) { failures.push(`maneuver ${label}: ${r.errorCode} ${r.errorMessage}`); continue; }
  const eph = r.outputs.find((o) => o.portId === "ephemeris").payload;
  const out = MNV.getRootAsMNV(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "maneuvers").payload));
  const err = score(eph, truth);
  const unmapped = score(base.outputs[0].payload, truth);
  console.log(`M22 ${label}: days 1 / 2 / 3 ${err.map((x) => x.toFixed(3)).join(" / ")} km (burn ignored ${unmapped.map((x) => x.toFixed(3)).join(" / ")}); ${out.ALGORITHM()}`);
  check(err.every((x, d) => x <= 1.1 * err0[d] + 0.05), `M22 ${label}: ${err.map((x) => x.toFixed(3))} against ${err0.map((x) => x.toFixed(3))}`);
  check(out.PRE_EVENT() !== null && out.POST_EVENT() !== null && Math.abs(out.DELTA_VEL() - Math.hypot(...dv)) < 1e-12, `M22 ${label}: the $MNV record`);
}
// M23: 60-minute burns of 1 m/s along V, U and W, centered at the end of the fit arc: the finite-burn map adds no more
// error than the centroid impulse (days 1-3 summed), and along V stays within 10 % (+ 100 m) of the burn-free error
for (const [label, axis] of [["V", 1], ["U", 0], ["W", 2]]) {
  const D = 3600, dir = [0, 0, 0];
  dir[axis] = 1e-3;
  const truth = await reference([[tb - D / 2, tb + D / 2, ...dir.map((x) => x / D)]]);
  const finite = await across(tb - D / 2, tb + D / 2, dir);
  const impulse = await across(tb, tb, dir);
  if (finite.statusCode !== 0 || impulse.statusCode !== 0) { failures.push(`M23 ${label}: ${finite.errorCode} ${impulse.errorCode}`); continue; }
  const ef = score(finite.outputs.find((o) => o.portId === "ephemeris").payload, truth);
  const ei = score(impulse.outputs.find((o) => o.portId === "ephemeris").payload, truth);
  const excess = (e) => e.reduce((acc, x, d) => acc + Math.max(0, x - err0[d]), 0);
  console.log(`M23 60 min, 1 m/s ${label}: finite map ${ef.map((x) => x.toFixed(3)).join(" / ")} km, centroid impulse ${ei.map((x) => x.toFixed(3)).join(" / ")} km; excess (days 1-3 summed) finite ${excess(ef).toFixed(3)}, impulse ${excess(ei).toFixed(3)} km`);
  check(excess(ef) <= excess(ei) && (axis !== 1 || ef.every((x, d) => x <= 1.1 * err0[d] + 0.1)), `M23 ${label}: finite ${ef.map((x) => x.toFixed(3))}, impulse ${ei.map((x) => x.toFixed(3))}`);
}
// M24-M27 kind, against FFM-1: the six-element GLR on a 48 h arc with a burn at 30 h (and on the burn-free arc), then
// the joint segment fit (y0, Delta v, t_b over the whole arc): 20 cm/s burns along U, V and W within 5 minutes of the
// burn and within 12 % in Delta v (the SDN-AP theory's own 63-65 m RMS against FFM-1 on the arc sets that floor; on
// the theory's own states the fit returns the burn exactly), no detection on the burn-free arc; a 5 cm/s in-track
// burn reported (the detection floor)
for (const [label, dv] of [["none", null], ["V 20 cm/s", [0, 2e-4, 0]], ["U 20 cm/s", [2e-4, 0, 0]], ["W 20 cm/s", [0, 0, 2e-4]], ["V 5 cm/s", [0, 5e-5, 0]]]) {
  const tb2 = 30 * 3600;
  const truth = dv ? await reference([[tb2, tb2, ...dv]]) : truth0;
  const r = await command.invoke({ methodId: "detect_maneuvers", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: oemOf(truth, 0, FIT_H * 3600) }] });
  if (r.statusCode !== 0) { failures.push(`detect ${label}: ${r.errorCode} ${r.errorMessage}`); continue; }
  const sets = r.outputs.filter((o) => o.portId === "elements").map((o) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(o.payload)));
  const mnvs = r.outputs.filter((o) => o.portId === "maneuvers").map((o) => MNV.getRootAsMNV(new flatbuffers.ByteBuffer(o.payload)));
  if (!dv) {
    console.log(`GLR burn-free arc: ${mnvs.length} detections; ${sets[0]?.COMMENT()}`);
    check(mnvs.length === 0, `GLR false alarm on the burn-free arc: ${sets[0]?.COMMENT()}`);
    continue;
  }
  if (mnvs.length !== 1) { (label === "V 5 cm/s" ? console.log : failures.push.bind(failures))(`GLR ${label}: ${mnvs.length} detections; ${sets[0]?.COMMENT()}`); continue; }
  const e = mnvs[0];
  const dt = (Date.parse(e.EVENT_START_TIME() + "Z") - (epochMs + tb2 * 1000)) / 60000;
  const est = [e.DELTA_VEL_U(), e.DELTA_VEL_V(), e.DELTA_VEL_W()];
  const err = Math.hypot(...est.map((x, c) => x - dv[c])) / Math.hypot(...dv);
  console.log(`GLR ${label}: epoch ${dt.toFixed(1)} min from the burn, dv (${est.map((x) => (1e6 * x).toFixed(2)).join(", ")}) mm/s (error ${(100 * err).toFixed(1)} %); ${e.ALGORITHM()}`);
  if (label !== "V 5 cm/s") check(Math.abs(dt) <= 5 && err <= 0.12, `GLR ${label}: epoch ${dt} min, dv error ${err}`);
}
// long pre-burn arcs (the ISS reboost windows, A12): a burn late in a 72 h arc. The epoch comes from the likelihood
// profiled over the epoch elements and B_eff (held at the burn-free fit, a burn early in the arc stood in for the epoch
// correction); found within 5 min whatever the pre-burn length, the in-track component within 5 % and at least 95 % of
// |Delta v| (the radial part of an in-track estimate trades against the epoch, about V sin(n dt_b))
for (const [label, at, dv] of [["V 1 m/s at 60 h", 60, [0, 1e-3, 0]], ["V 10 m/s at 48 h", 48, [0, 1e-2, 0]], ["V 0.5 m/s at 66 h", 66, [0, 5e-4, 0]]]) {
  const tb2 = at * 3600;
  const truth = await reference([[tb2, tb2, ...dv]]);
  const r = await command.invoke({ methodId: "detect_maneuvers", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: oemOf(truth, 0, 72 * 3600) }] });
  if (r.statusCode !== 0) { failures.push(`detect ${label}: ${r.errorCode} ${r.errorMessage}`); continue; }
  const mnvs = r.outputs.filter((o) => o.portId === "maneuvers").map((o) => MNV.getRootAsMNV(new flatbuffers.ByteBuffer(o.payload)));
  if (mnvs.length !== 1) { failures.push(`GLR long arc ${label}: ${mnvs.length} detections`); continue; }
  const e = mnvs[0];
  const dt = (Date.parse(e.EVENT_START_TIME() + "Z") - (epochMs + tb2 * 1000)) / 60000;
  const est = [e.DELTA_VEL_U(), e.DELTA_VEL_V(), e.DELTA_VEL_W()];
  const share = Math.abs(est[1]) / Math.hypot(...est), vErr = Math.abs(est[1] - dv[1]) / dv[1];
  console.log(`GLR long arc ${label}: epoch ${dt.toFixed(1)} min from the burn, dv (${est.map((x) => (1e6 * x).toFixed(1)).join(", ")}) mm/s (V error ${(100 * vErr).toFixed(1)} %, in-track share ${share.toFixed(3)}); ${e.ALGORITHM()}`);
  check(Math.abs(dt) <= 5 && vErr <= 0.05 && share >= 0.95, `GLR long arc ${label}: epoch ${dt} min, V error ${vErr}, share ${share}`);
}
// the detector's false alarms: eight burn-free FFM-1 arcs of 72 h at 300 s (LEO 350-650 km, i 30-98 deg, B_eff 0.004 to
// 0.04, AGOM 0.005 to 0.03 m^2/kg, seeded): no detection, and the largest Lambda reported (the calibration of the
// threshold on such arcs: one false alarm per object-year)
{
  let sd = 4242;
  const rnd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
  const between = (a, b2) => a + (b2 - a) * rnd();
  const lams = [];
  let alarms = 0;
  for (let k = 0; k < 8; ++k) {
    const el = [6378.137 + between(350, 650), between(0.0002, 0.005), between(30, 98), between(0, 360), between(0, 360), between(0, 360)];
    const bk = between(0.004, 0.04), ak = between(0.005, 0.03);
    const pe = m.x.sdnap_alloc(48), py = m.x.sdnap_alloc(48);
    new Float64Array(m.harness.memory.buffer, pe, 6).set(el);
    m.x.sdnap_insertion_state(ep.whole, ep.frac, pe, 0, py);
    const yk = Array.from(new Float64Array(m.harness.memory.buffer, py, 6));
    [pe, py].forEach((q) => m.x.sdnap_free(q));
    const ts = Array.from({ length: 72 * 3600 / STEP + 1 }, (_, q) => q * STEP);
    const tr = await ffmTruth(yk, epochMs, ts, [], bk, ak);
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const blk = t.EPHEMERIS_DATA_BLOCK[0];
    blk.START_TIME = blk.STOP_TIME = blk.USEABLE_START_TIME = blk.USEABLE_STOP_TIME = null;
    blk.REFERENCE_FRAME = rfm("TEME", "both");
    blk.EPHEMERIS_DATA_LINES = ts.map((s2, q) => new ephemerisDataLineT(iso(s2), ...tr[q]));
    t.EPHEMERIS_DATA_BLOCK = [blk];
    const r = await command.invoke({ methodId: "detect_maneuvers", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: packOem(t) }] });
    if (r.statusCode !== 0) { failures.push(`burn-free arc ${k}: ${r.errorCode} ${r.errorMessage}`); continue; }
    const nm = r.outputs.filter((o) => o.portId === "maneuvers").length;
    const c = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload)).COMMENT();
    lams.push(Number((c.match(/Lambda ([\d.]+)/) || [])[1]));
    alarms += nm;
  }
  console.log(`GLR burn-free FFM-1 arcs: ${alarms} detections on ${lams.length} arcs of 72 h; largest Lambda ${lams.map((x) => x.toFixed(1)).join(", ")}`);
  check(alarms === 0 && lams.length === 8, `GLR false alarms: ${alarms} on ${lams.length} burn-free arcs`);
}
// the detector in the high orbits (task modules-sdn-ap-maneuver-detector-qzss-20261025): QZSS windows read a burn every
// 1.5 days of 1.8 mm/s because the detection statistic, Lambda against the burn-free fit, holds the epoch elements at a
// fit that minimizes position residuals while the test weights element residuals, and an IGSO, geostationary or GPS 72 h
// arc holds 3 to 6 revolutions. On FFM-1 arcs of those orbits (EGM2008 70 x 70, Sun, Moon, planets, SRP; no drag) the
// burn-free-fit form passes the threshold on part of the burn-free arcs; the detection statistic is the smaller of it and
// the profiled Lambda (epoch elements and B_eff re-estimated with and without the burn), which does not.
//   - burn-free: ten arcs per orbit class, no detection; the fit form is reported beside the statistic;
//   - burns at 36 h: 10 mm/s along V and W in a geostationary arc, 10 mm/s along V and 20 mm/s along W in an IGSO arc, 100 mm/s along V in a GPS arc: one detection,
//     its epoch and its Delta v on the burn's axis.
{
  let sd = 9137;
  const rnd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
  const classes = [["GEO", 42164.17, 0.0003, 0.05], ["IGSO", 42164.17, 0.075, 41], ["GPS", 26560, 0.01, 55]];
  const arcOf = async (a, e, inc, angles, burns) => {
    const pe = m.x.sdnap_alloc(48), py = m.x.sdnap_alloc(48);
    new Float64Array(m.harness.memory.buffer, pe, 6).set([a, e, inc, angles[0], angles[1], angles[2]]);
    m.x.sdnap_insertion_state(ep.whole, ep.frac, pe, 0, py);
    const yk = Array.from(new Float64Array(m.harness.memory.buffer, py, 6));
    [pe, py].forEach((q) => m.x.sdnap_free(q));
    const ts = Array.from({ length: 72 * 3600 / STEP + 1 }, (_, q) => q * STEP);
    const tr = await ffmTruth(yk, epochMs, ts, burns, 0, 0.02);
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const blk = t.EPHEMERIS_DATA_BLOCK[0];
    blk.START_TIME = blk.STOP_TIME = blk.USEABLE_START_TIME = blk.USEABLE_STOP_TIME = null;
    blk.REFERENCE_FRAME = rfm("TEME", "both");
    blk.EPHEMERIS_DATA_LINES = ts.map((s2, q) => new ephemerisDataLineT(iso(s2), ...tr[q]));
    t.EPHEMERIS_DATA_BLOCK = [blk];
    return packOem(t);
  };
  const detectOn = async (bytes) => {
    const r = await command.invoke({ methodId: "detect_maneuvers", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: bytes }] });
    if (r.statusCode !== 0) return { error: `${r.errorCode} ${r.errorMessage}` };
    const mnvs = r.outputs.filter((o) => o.portId === "maneuvers").map((o) => MNV.getRootAsMNV(new flatbuffers.ByteBuffer(o.payload)));
    const comment = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload)).COMMENT();
    return { mnvs, comment, lambda: Number(/Lambda ([\d.]+)/.exec(mnvs[0]?.ALGORITHM() ?? comment)?.[1]), fitForm: Number(/burn-free-fit form ([\d.]+)/.exec(comment)?.[1]) };
  };
  for (const [name, a, e, inc] of classes) {
    let alarms = 0, fitFormOver = 0;
    const lams = [], fits = [];
    for (let k = 0; k < 10; ++k) {
      const out = await detectOn(await arcOf(a, e, inc, [360 * rnd(), 360 * rnd(), 360 * rnd()], []));
      if (out.error) { failures.push(`burn-free ${name} arc ${k}: ${out.error}`); continue; }
      alarms += out.mnvs.length;
      lams.push(out.lambda);
      if (out.fitForm !== undefined && !Number.isNaN(out.fitForm)) { fits.push(out.fitForm); if (out.fitForm > 20) fitFormOver += 1; }
    }
    console.log(`GLR burn-free FFM-1 ${name} arcs: ${alarms} detections on ${lams.length} arcs of 72 h; Lambda ${lams.map((x) => x.toFixed(1)).join(", ")}; the burn-free-fit form of the arcs that did not detect ${fits.map((x) => x.toFixed(1)).join(", ")}`);
    check(alarms === 0 && lams.length === 10, `GLR false alarms on burn-free ${name} arcs: ${alarms} of ${lams.length}`);
    // the old statistic alone would have raised false alarms here (the arcs of the orbits whose revolutions are few)
    if (name !== "GPS") check(fitFormOver >= 3, `${name}: the burn-free-fit form passes the threshold on ${fitFormOver} of ${fits.length} arcs (expected at least 3: the case the statistic guards against)`);
  }
  for (const [label, name, [a, e, inc], angles, dv] of [
    ["GEO V 10 mm/s", "GEO", classes[0].slice(1), [80, 200, 100], [0, 1e-5, 0]],
    ["GEO W 10 mm/s", "GEO", classes[0].slice(1), [80, 200, 100], [0, 0, 1e-5]],
    ["IGSO V 10 mm/s", "IGSO", classes[1].slice(1), [150, 270, 0], [0, 1e-5, 0]],
    ["IGSO W 20 mm/s", "IGSO", classes[1].slice(1), [150, 270, 0], [0, 0, 2e-5]],
    ["GPS V 100 mm/s", "GPS", classes[2].slice(1), [10, 20, 30], [0, 1e-4, 0]],
  ]) {
    const tb2 = 36 * 3600;
    const out = await detectOn(await arcOf(a, e, inc, angles, [[tb2, tb2, ...dv]]));
    if (out.error) { failures.push(`${label}: ${out.error}`); continue; }
    if (out.mnvs.length !== 1) { failures.push(`${label}: ${out.mnvs.length} detections; ${out.comment}`); continue; }
    const mv = out.mnvs[0];
    const dt = (Date.parse(mv.EVENT_START_TIME() + "Z") - (epochMs + tb2 * 1000)) / 60000;
    const est = [mv.DELTA_VEL_U(), mv.DELTA_VEL_V(), mv.DELTA_VEL_W()];
    const axis = dv.findIndex((x) => x !== 0), err = Math.abs(est[axis] - dv[axis]) / Math.abs(dv[axis]);
    console.log(`GLR ${label}: Lambda ${out.lambda.toFixed(1)}, epoch ${dt.toFixed(1)} min from the burn, dv (${est.map((x) => (1e6 * x).toFixed(2)).join(", ")}) mm/s (error on the burn's axis ${(100 * err).toFixed(1)} %)`);
    check(Math.abs(dt) <= 90 && err <= 0.25, `GLR ${label}: epoch ${dt} min, error ${err}`);
  }
}
// M28 kind, synthetic: a decaying SDN-AP set (250 km, B_eff 0.02 m^2/kg; NRLMSISE-00 x exp(s) on both sides): the 'reentry' method (averaged until a limit of
// (18) trips, then osculating integration) against the osculating integration of the set's epoch state all the way
// down; the epochs within 5 % of the lifetime and the reference inside the window
{
  const decaying = (() => {
    const b = new flatbuffers.Builder(256);
    const ps = [["SDNAP_B_EFF", "0.02"]].map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(v)));
    const vec = OMM.createUserDefinedParametersVector(b, ps);
    const epoch = b.createString(EPOCH);
    OMM.startOMM(b);
    OMM.addUserDefinedParameters(b, vec);
    OMM.addEpoch(b, epoch);
    OMM.addMeanMotion(b, 16.08);
    OMM.addEccentricity(b, 0.0004);
    OMM.addInclination(b, 51.6);
    OMM.addRaOfAscNode(b, 40);
    OMM.addArgOfPericenter(b, 90);
    OMM.addMeanAnomaly(b, 10);
    OMM.addNoradCatId(b, 90040);
    OMM.addMeanElementTheory(b, 4);
    OMM.addBstar(b, 0.02);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  // through $PCF: REENTRY.ALTITUDE_KM 100, FFM-1's own stop
  const r = await command.invoke({ methodId: "reentry", inputs: [configuration({ reentry: { ALTITUDE_KM: 100 } }), { portId: "omm", typeRef: ommType, payload: decaying }] });
  if (r.statusCode !== 0) failures.push(`reentry: ${r.errorCode} ${r.errorMessage}`);
  else {
    const { RDM } = await import("spacedatastandards.org/lib/js/RDM/RDM.js");
    const d = RDM.getRootAsRDM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "reentry").payload));
    const st = (await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: decaying }] })).outputs[0].payload;
    const L0 = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(st)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
    // FFM-1 from the set's epoch state down to 80 km (60 s samples; 6 h pieces, 20 min below 150 km)
    const height = (g) => { const q = m.x.sdnap_alloc(24); new Float64Array(m.harness.memory.buffer, q, 3).set(g.slice(0, 3)); const h = m.x.sdnap_geodetic_height_km(q); m.x.sdnap_free(q); return h; };
    let state = frameAt([L0.X, L0.Y, L0.Z, L0.X_DOT, L0.Y_DOT, L0.Z_DOT], epochMs, FRAME_PROBE.TEME_TO_GCRF), tc = 0, tref = -1, refAltitude = 80;
    while (tref < 0 && tc < 10 * 86400) {
      const piece = height(state) > 150 ? 6 * 3600 : 1200;
      const samp = Array.from({ length: piece / 60 }, (_, k) => tc + (k + 1) * 60);
      // FFM-1 ends a trajectory at 100 km (its reentry rule): that crossing is the reference epoch (the module's
      // 80 km is minutes later)
      let got;
      try { got = await ffmRun(state, epochMs + tc * 1000, samp.map((s2) => epochMs + s2 * 1000), 0.02, 0.0); } catch (e) {
        const at = /descends below 100 km geodetic altitude .* at (\S+) UTC/.exec(String(e.message));
        if (!at) throw e;
        tref = (Date.parse(at[1].slice(0, 23) + "Z") - epochMs) / 1000;
        refAltitude = 100;
        break;
      }
      let ph = height(state), pt0 = tc;
      for (let k = 0; k < got.length && tref < 0; ++k) {
        const h = height(got[k]);
        if (h <= 80) tref = pt0 + ((ph - 80) / (ph - h)) * (samp[k] - pt0);
        ph = h;
        pt0 = samp[k];
      }
      state = got.at(-1);
      tc = samp.at(-1);
    }
    const py = m.x.sdnap_alloc(48), pl = m.x.sdnap_alloc(16);
    const life = d.ORBIT_LIFETIME();
    const tpred = (Date.parse(d.REENTRY_EPOCH() + "Z") - epochMs) / 1000;
    const w0 = (Date.parse(d.REENTRY_WINDOW_START() + "Z") - epochMs) / 1000, w1 = (Date.parse(d.REENTRY_WINDOW_END() + "Z") - epochMs) / 1000;
    console.log(`M28 250 km, B_eff 0.02, $PCF REENTRY.ALTITUDE_KM ${d.REENTRY_ALTITUDE()}: reentry ${d.REENTRY_EPOCH()}, ${(tpred / 86400).toFixed(3)} d (window ${(w0 / 86400).toFixed(3)} to ${(w1 / 86400).toFixed(3)}), FFM-1 ${(tref / 86400).toFixed(3)} d at ${refAltitude} km (difference ${(100 * (tpred - tref) / tref).toFixed(2)} % of the lifetime); BALLISTIC_COEFF ${d.BALLISTIC_COEFF()} kg/m^2; ${d.COMMENT()}`);
    check(tref > 0 && refAltitude === 100 && d.REENTRY_ALTITUDE() === 100 && Math.abs(tpred - tref) <= 0.01 * tref && tref >= w0 && tref <= w1 && Math.abs(life * 86400 - tpred) < 1 && Math.abs(d.BALLISTIC_COEFF() - 50) < 1e-9, `M28 at 100 km: predicted ${tpred}, reference ${tref} at ${refAltitude} km, window ${w0}..${w1}, RDM altitude ${d.REENTRY_ALTITUDE()}`);
    m.x.sdnap_free(py); m.x.sdnap_free(pl);
  }
}
// C4 from $PCF 1.0.2 REENTRY (SDS 1.268.0): an eccentric decaying SDN-AP set (perigee 250 km, apogee 1,500 km, B_eff
// 0.25 m^2/kg) hands off at its first node by C4 under the defaults (the perigee-pass sawtooth above 0.5 km, e > 0.02),
// and no limit trips within half a day with HANDOFF_SAWTOOTH_KM 1e6 or HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY 0.5 (a
// half-day horizon keeps the call to the averaged phase); a length of 0 and an eccentricity of 1 are refused by name
{
  const eccentric = (() => {
    const a = 6378.137 + (250 + 1500) / 2, e = (1500 - 250) / (2 * a);
    const b = new flatbuffers.Builder(256);
    const epoch = b.createString(EPOCH);
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addMeanMotion(b, (Math.sqrt(398600.4418 / a ** 3) * 86400) / (2 * Math.PI));
    OMM.addEccentricity(b, e);
    OMM.addInclination(b, 63.4);
    OMM.addRaOfAscNode(b, 40);
    OMM.addArgOfPericenter(b, 270);
    OMM.addMeanAnomaly(b, 0);
    OMM.addNoradCatId(b, 90041);
    OMM.addMeanElementTheory(b, 4);
    OMM.addBstar(b, 0.25);
    OMM.addMeanMotionDdot(b, 0.01);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  const halfDay = async (reentry) => command.invoke({ methodId: "reentry", inputs: [configuration({ reentry: { HORIZON_DAYS: 0.5, ...reentry } }), { portId: "omm", typeRef: ommType, payload: eccentric }] });
  const byDefault = await halfDay({});
  const noLength = await halfDay({ HANDOFF_SAWTOOTH_KM: 1e6 });
  const noEccentricity = await halfDay({ HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY: 0.5 });
  console.log(`C4 on an eccentric decaying set (half-day horizon): defaults -> ${byDefault.errorCode} (${String(byDefault.errorMessage).match(/C\d/)?.[0] ?? "no criterion"}); HANDOFF_SAWTOOTH_KM 1e6 -> ${noLength.errorCode}; HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY 0.5 -> ${noEccentricity.errorCode}`);
  check(byDefault.errorCode === "reentry-not-reached" && /0\.000 d after the set's epoch, C4,/.test(String(byDefault.errorMessage)), `C4 by default: ${byDefault.errorCode} ${byDefault.errorMessage}`);
  check(noLength.errorCode === "no-reentry" && noEccentricity.errorCode === "no-reentry", `C4 off by its fields: ${noLength.errorCode} ${noLength.errorMessage} / ${noEccentricity.errorCode} ${noEccentricity.errorMessage}`);
  for (const [reentry, text] of [[{ HANDOFF_SAWTOOTH_KM: 0 }, "REENTRY.HANDOFF_SAWTOOTH_KM: a positive length"],
    [{ HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY: 1 }, "REENTRY.HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY: an eccentricity in [0, 1)"]]) {
    const r = await halfDay(reentry);
    console.log(`$PCF refusal, reentry ${JSON.stringify(reentry)}: ${r.errorCode} ${r.errorMessage}`);
    check(r.errorCode === "configuration-refused" && r.errorMessage === text, `reentry ${JSON.stringify(reentry)}: ${r.errorCode} ${r.errorMessage}`);
  }
}
// the launch cases' insertion: an SDS $LAM INSERTION orbit (TEME osculating a km, e, i, Omega, omega, u deg)
const lamEl = [6778.137, 0.001, 53.0, 100.0, 80.0, 30.0];
const lamType = { schemaName: "LAM.fbs", fileIdentifier: "$LAM", rootTypeName: "LAM" };
const lamOf = async (el) => {
  const { LAM, LAMT } = await import("spacedatastandards.org/lib/js/LAM/LAM.js");
  const { lamInsertionOrbitT } = await import("spacedatastandards.org/lib/js/LAM/lamInsertionOrbit.js");
  const ins = new lamInsertionOrbitT(EPOCH, 600, "TEME", el[0] * 1000, el[1], el[2], el[3], el[4], el[5]);
  ins.PERIAPSIS_ALTITUDE_UNCERTAINTY_M = 2000;
  ins.APOAPSIS_ALTITUDE_UNCERTAINTY_M = 3000;
  ins.ARGUMENT_OF_LATITUDE_UNCERTAINTY_DEG = 0.05;
  ins.RAAN_UNCERTAINTY_DEG = 0.02;
  const t = new LAMT();
  t.MISSION_NAME = "E2E LAUNCH";
  t.REF_FRAME = "TEME";
  t.INSERTION = ins;
  const b = new flatbuffers.Builder(1024);
  LAM.finishLAMBuffer(b, t.pack(b));
  return b.asUint8Array();
};
const lamPayload = await lamOf(lamEl);
// launch (5.3.1, M31 kind, synthetic): the first set from a $LAM insertion orbit (TEME) against the osculating
// integration of the insertion state over the first day: the set's state at its epoch within 1 m of the insertion
// state, day 1 within 1.5 km of FFM-1 (one state, no fit: the first fitted set of 5.3.2 is the refinement)
{
  const el = lamEl;
  const r = await command.invoke({ methodId: "launch_set", inputs: [{ portId: "launch", typeRef: lamType, payload: lamPayload }] });
  if (r.statusCode !== 0) failures.push(`launch_set: ${r.errorCode} ${r.errorMessage}`);
  else {
    const first = r.outputs.find((o) => o.portId === "elements").payload;
    const pe = m.x.sdnap_alloc(48), py = m.x.sdnap_alloc(48);
    new Float64Array(m.harness.memory.buffer, pe, 6).set(el);
    m.x.sdnap_insertion_state(ep.whole, ep.frac, pe, 0, py);
    const yi = Array.from(new Float64Array(m.harness.memory.buffer, py, 6));
    const day = Array.from({ length: 289 }, (_, k) => k * 300);
    const pt = m.x.sdnap_alloc(8), po = m.x.sdnap_alloc(8), pb = m.x.sdnap_alloc(8);
    const truth = await ffmTruth(yi, epochMs, day, [], 0.01, 0.01);
    const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const gb = g.EPHEMERIS_DATA_BLOCK[0];
    gb.START_TIME = gb.STOP_TIME = gb.USEABLE_START_TIME = gb.USEABLE_STOP_TIME = null;
    gb.REFERENCE_FRAME = rfm("TEME", "both");
    gb.EPHEMERIS_DATA_LINES = day.map((s2) => new ephemerisDataLineT(iso(s2), 0, 0, 0, 0, 0, 0));
    g.EPHEMERIS_DATA_BLOCK = [gb];
    const p = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: first }, { portId: "grid", typeRef: oemType, payload: packOem(g) }] });
    const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    const at0 = Math.hypot(L[0].X - yi[0], L[0].Y - yi[1], L[0].Z - yi[2]) * 1000;
    const rms = Math.sqrt(L.reduce((acc, q, k) => acc + (q.X - truth[k][0]) ** 2 + (q.Y - truth[k][1]) ** 2 + (q.Z - truth[k][2]) ** 2, 0) / L.length);
    console.log(`launch: first set at its epoch ${at0.toFixed(4)} m from the insertion state; day 1 RMS ${rms.toFixed(3)} km against FFM-1; ${OMM.getRootAsOMM(new flatbuffers.ByteBuffer(first)).COMMENT()}`);
    check(at0 <= 1.0 && rms <= 1.5, `launch: ${at0} m at epoch, day 1 ${rms} km`);
    // the same insertion as an SDS $BOV burnout vector (Earth-fixed km, km/s at the epoch, the module's GMST rotation):
    // the first set's state at its epoch within 1 m of the insertion state
    const { BOV, BOVT } = await import("spacedatastandards.org/lib/js/BOV/BOV.js");
    const efg = rotate(m, ep.whole, ep.frac, yi, FRAME_PROBE.TEME_TO_EARTH_FIXED).out;
    const bb = new flatbuffers.Builder(256);
    BOV.finishBOVBuffer(bb, new BOVT(...efg, EPOCH, 600).pack(bb));
    const rb = await command.invoke({ methodId: "launch_set", inputs: [{ portId: "burnout", typeRef: { schemaName: "BOV.fbs", fileIdentifier: "$BOV", rootTypeName: "BOV" }, payload: bb.asUint8Array() }] });
    if (rb.statusCode !== 0) failures.push(`launch_set from a $BOV: ${rb.errorCode} ${rb.errorMessage}`);
    else {
      const pb2 = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: rb.outputs.find((o) => o.portId === "elements").payload }, { portId: "grid", typeRef: oemType, payload: packOem(g) }] });
      const Lb = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(pb2.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      const atb = Math.hypot(Lb[0].X - yi[0], Lb[0].Y - yi[1], Lb[0].Z - yi[2]) * 1000;
      console.log(`launch from a $BOV: first set at its epoch ${atb.toFixed(4)} m from the insertion state`);
      check(atb <= 1.0, `launch from a $BOV: ${atb} m at epoch`);
    }
    [pe, py, pt, po, pb].forEach((q) => m.x.sdnap_free(q));
  }
}
// an exactly circular insertion (the 29th of a seeded set of 400 random circular LEO insertions, the one whose start, the
// osculating elements taken as mean, has an eccentricity of exactly 0): launch_set converges, and an SDN-AP set of
// ECCENTRICITY 0 propagates within 1 m of the same set at 1e-12 (the m-daily terms' dG/de is 0 there, not 0 / 0)
{
  const r = await command.invoke({ methodId: "launch_set", inputs: [{ portId: "launch", typeRef: lamType,
    payload: await lamOf([6942.541023250669, 0, 61.837499155662954, 331.5486299805343, 68.3028191048652, 234.95499595999718]) }] });
  console.log(`launch_set, an exactly circular insertion: ${r.statusCode === 0 ? "converged" : `${r.errorCode} ${r.errorMessage}`}`);
  check(r.statusCode === 0, `launch_set of an exactly circular insertion: ${r.errorCode} ${r.errorMessage}`);
  const circular = (ecc) => {
    const b = new flatbuffers.Builder(256);
    const epoch = b.createString(EPOCH);
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addMeanMotion(b, 15.0);
    OMM.addEccentricity(b, ecc);
    OMM.addInclination(b, 61.8375);
    OMM.addRaOfAscNode(b, 331.5);
    OMM.addArgOfPericenter(b, 68.3);
    OMM.addMeanAnomaly(b, 166.6);
    OMM.addBstar(b, 0.01);
    OMM.addMeanMotionDdot(b, 0.01);
    OMM.addNoradCatId(b, 90042);
    OMM.addMeanElementTheory(b, 4);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  };
  const [p0, p1] = [await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: circular(0) }] }),
    await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: circular(1e-12) }] })];
  let max = NaN;
  if (p0.statusCode === 0 && p1.statusCode === 0) {
    const [a, b] = [p0, p1].map((p) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES);
    max = Math.max(...a.map((q, k) => Math.hypot(q.X - b[k].X, q.Y - b[k].Y, q.Z - b[k].Z) * 1e3));
  }
  console.log(`SDN-AP set of ECCENTRICITY 0: ${p0.statusCode === 0 ? `propagates, within ${max.toExponential(2)} m of e 1e-12 over the day` : `${p0.errorCode} ${p0.errorMessage}`}`);
  check(p0.statusCode === 0 && max <= 1.0, `SDN-AP set of ECCENTRICITY 0: ${p0.errorCode} ${p0.errorMessage} (${max} m)`);
}
// launch batch (5.3.3, M31/M32 kind, synthetic against FFM-1): six objects released from a 300 km $LAM insertion with
// separation Delta v up to 30 cm/s per axis and B_eff within 20 % of 0.01 m^2/kg; the batch-joint fit of their first
// 6, 12 and 24 h against per-object fits of the same arcs (fit SDNAP), days 1-3 after each arc: the separations
// relative to the batch mean within 25 mm/s, the joint fit within 10 % of the per-object fits at 24 h (the prior's weight
// falls as each object's own data grow); then every object associated with its own day-2 catalog set (fit SDNAP of
// 30-42 h, given shuffled) by along-track order
{
  const N = 6, END = 96 * 3600;
  const tb = Array.from({ length: END / STEP + 1 }, (_, k) => k * STEP);
  const batchEl = [6678.137, 0.001, 53.0, 100.0, 80.0, 30.0];  // 300 km: DESIGN 5.3.2's low insertion, B_eff identifiable from 6 h
  const batchLam = await lamOf(batchEl);
  const pe = m.x.sdnap_alloc(48), py = m.x.sdnap_alloc(48);
  new Float64Array(m.harness.memory.buffer, pe, 6).set(batchEl);
  m.x.sdnap_insertion_state(ep.whole, ep.frac, pe, 0, py);
  const yi = Array.from(new Float64Array(m.harness.memory.buffer, py, 6));
  [pe, py].forEach((q) => m.x.sdnap_free(q));
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const objs = Array.from({ length: N }, (_, k) => ({ k, dv: [0, 0, 0].map(() => (rnd() - 0.5) * 6e-4), b: 0.01 * (1 + 0.4 * (rnd() - 0.5)) }));
  for (const o of objs) o.truth = await ffmTruth(uvwAdd(yi, o.dv), epochMs, tb, [], o.b, 0.01);
  for (const spanH of [6, 12, 24]) {
  const ARC = spanH * 3600;
  const blockOem = (o, from, to, norad) => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.START_TIME = b.STOP_TIME = b.USEABLE_START_TIME = b.USEABLE_STOP_TIME = null;
    b.REFERENCE_FRAME = rfm("TEME", "both");
    b.OBJECT ??= new CATT();
    b.OBJECT.OBJECT_NAME = `E2E BATCH ${o.k + 1}`;
    b.OBJECT.NORAD_CAT_ID = norad;
    b.EPHEMERIS_DATA_LINES = [];
    tb.forEach((s2, j) => { if (s2 >= from && s2 <= to) b.EPHEMERIS_DATA_LINES.push(new ephemerisDataLineT(iso(s2), ...o.truth[j])); });
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  };
  const gridOem = (() => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.START_TIME = b.STOP_TIME = b.USEABLE_START_TIME = b.USEABLE_STOP_TIME = null;
    b.REFERENCE_FRAME = rfm("TEME", "both");
    b.EPHEMERIS_DATA_LINES = tb.filter((s2) => s2 > ARC && s2 <= ARC + 72 * 3600).map((s2) => new ephemerisDataLineT(iso(s2), 0, 0, 0, 0, 0, 0));
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  })();
  const days = async (ommPayload, o) => {
    const p = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: ommPayload }, { portId: "grid", typeRef: oemType, payload: gridOem }] });
    if (p.statusCode !== 0) return [Infinity, Infinity, Infinity];
    const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    const ss = [0, 0, 0], n = [0, 0, 0];
    let j = 0;
    tb.forEach((s2, k) => {
      if (s2 <= ARC || s2 > ARC + 72 * 3600) return;
      const q = L[j++], r = o.truth[k], d = Math.min(2, Math.floor((s2 - ARC - 1) / 86400));
      ss[d] += (q.X - r[0]) ** 2 + (q.Y - r[1]) ** 2 + (q.Z - r[2]) ** 2;
      n[d] += 1;
    });
    return ss.map((x, d) => Math.sqrt(x / n[d]));
  };
  const arcs = objs.map((o) => ({ portId: "ephemeris", typeRef: oemType, payload: blockOem(o, 0, ARC, 0) }));
  const jb = await command.invoke({ methodId: "launch_batch", inputs: [{ portId: "launch", typeRef: lamType, payload: batchLam }, ...arcs] });
  if (jb.statusCode !== 0) failures.push(`launch_batch: ${jb.errorCode} ${jb.errorMessage}`);
  else {
    const sets = jb.outputs.filter((o) => o.portId === "elements").map((o) => o.payload);
    const joint = [], single = [];
    const beffOf = (payload) => { const x = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(payload)); for (let q = 0; q < x.userDefinedParametersLength(); ++q) { const u = x.USER_DEFINED_PARAMETERS(q); if (u.PARAM_NAME() === "SDNAP_B_EFF") return Number(u.PARAM_VALUE()); } return NaN; };
    for (const o of objs) {
      joint.push(await days(sets[o.k], o));
      const f = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: blockOem(o, 0, ARC, 0) }] });
      const fp = f.statusCode === 0 ? f.outputs.find((q) => q.portId === "elements").payload : null;
      single.push(fp ? await days(fp, o) : [Infinity, Infinity, Infinity]);
      if (spanH === 6) console.log(`  batch object ${o.k + 1}: truth B ${o.b.toFixed(5)}, dv ${o.dv.map((x) => (1e6 * x).toFixed(1)).join(" ")} mm/s; joint B ${beffOf(sets[o.k]).toFixed(5)}, days ${joint.at(-1).map((x) => x.toFixed(2)).join(" ")}; single B ${fp ? beffOf(fp).toFixed(5) : "-"}, days ${single.at(-1).map((x) => x.toFixed(2)).join(" ")}; ${fp ? OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fp)).COMMENT().slice(0, 120) : f.errorMessage}`);
    }
    const mean = (rows) => [0, 1, 2].map((d) => rows.reduce((acc, r) => acc + r[d], 0) / rows.length);
    const mj = mean(joint), ms = mean(single);
    const est = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(sets[0])).COMMENT();
    // the separations relative to the batch mean (the mean is the parent's own velocity, which the fit takes up)
    const dvFit = objs.map((o) => {
      const mm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(sets[o.k])).COMMENT().match(/dv U (-?[\d.]+) V (-?[\d.]+) W (-?[\d.]+) mm\/s/);
      return mm ? [1, 2, 3].map((q) => Number(mm[q])) : [NaN, NaN, NaN];
    });
    const avg = (rows) => [0, 1, 2].map((c) => rows.reduce((acc, r) => acc + r[c], 0) / rows.length);
    const fitMean = avg(dvFit), trueMean = avg(objs.map((o) => o.dv.map((x) => 1e6 * x)));
    const relErr = objs.map((o, k) => Math.hypot(...[0, 1, 2].map((c) => (dvFit[k][c] - fitMean[c]) - (1e6 * o.dv[c] - trueMean[c]))));
    console.log(`launch batch, ${spanH} h arcs: ${N} objects, days 1 / 2 / 3 after them: joint ${mj.map((x) => x.toFixed(3)).join(" / ")} km, per-object fits ${ms.map((x) => x.toFixed(3)).join(" / ")} km; separations relative to the batch mean within ${Math.max(...relErr).toFixed(1)} mm/s; ${est}`);
    check(Math.max(...relErr) <= 25, `launch batch ${spanH} h: relative separations within ${Math.max(...relErr)} mm/s`);
    if (spanH === 24) check(mj.every((x, d) => x <= 1.1 * ms[d]), `launch batch 24 h: joint ${mj} km against per-object ${ms} km`);
    if (spanH === 12) check(mj.every((x, d) => x <= ms[d]), `launch batch 12 h: joint ${mj} km against per-object ${ms} km`);
    // association (6 h arcs): day-2 catalog sets of the same objects with NORAD numbers, in shuffled order
    if (spanH !== 6) continue;
    const cats = [];
    for (const o of objs) {
      const f = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: blockOem(o, 30 * 3600, 42 * 3600, 91001 + o.k) }] });
      if (f.statusCode === 0) cats.push(f.outputs.find((q) => q.portId === "elements").payload);
    }
    const shuffled = [3, 0, 5, 1, 4, 2].map((q) => cats[q]).filter(Boolean);
    const ja = await command.invoke({ methodId: "launch_batch", inputs: [{ portId: "launch", typeRef: lamType, payload: batchLam }, ...arcs, ...shuffled.map((c) => ({ portId: "catalog", typeRef: ommType, payload: c }))] });
    if (ja.statusCode !== 0) failures.push(`launch_batch with catalog: ${ja.errorCode} ${ja.errorMessage}`);
    else {
      const got = ja.outputs.filter((o) => o.portId === "elements").map((o) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(o.payload)).NORAD_CAT_ID());
      const right = got.filter((nr, k) => nr === 91001 + k).length;
      console.log(`launch batch association: ${right} of ${N} objects matched to their own day-2 catalog set by along-track order (${got.join(", ")})`);
      check(right === N, `launch batch association: ${right} of ${N}`);
    }
  }
  }
}
// Lunar segments (item 6): a 100 km polar lunar orbit in FFM-1 about the Moon (GRGM660PRIM to degree 70, the Earth and
// the Sun, SRP), 24 h at 300 s with a 2 cm/s in-track impulse at 12 h (FFM-1 restarted with it), fitted by fit SDNAP.
// The split-half test flags the arc; the burn's epoch is the GLR's arg max and the joint segment fit's post-burn set
// is the result: the segment starts within 1 h of the burn and the fitted in-track dv within 20 %. The same arc without
// the burn is fitted whole.
{
  const E0 = "2026-06-01T00:00:00.000000", e0ms = Date.parse(E0 + "Z"), STEPL = 300, TB = 12 * 3600;
  const isoL = (s) => new Date(e0ms + s * 1000).toISOString().replace("Z", "000");
  const lunarSet = (() => {
    const b = new flatbuffers.Builder(1024);
    const vec = OMM.createUserDefinedParametersVector(b, [OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString("SDNAP_REGIME"), b.createString("MOON"))]);
    const epoch = b.createString(E0), center = b.createString("MOON");
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, center);
    OMM.addMeanMotion(b, 86400 / (2 * Math.PI * Math.sqrt(1838.0 ** 3 / 4902.7998)));
    OMM.addEccentricity(b, 0.01);
    OMM.addInclination(b, 90);
    OMM.addRaOfAscNode(b, 30);
    OMM.addArgOfPericenter(b, 90);
    OMM.addMeanAnomaly(b, 10);
    OMM.addNoradCatId(b, 90043);
    OMM.addMeanElementTheory(b, 4);
    OMM.addUserDefinedParameters(b, vec);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  const lunarBlock = (lines, step) => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.START_TIME = b.STOP_TIME = b.USEABLE_START_TIME = b.USEABLE_STOP_TIME = null;
    b.REFERENCE_FRAME = rfm("GCRF", "both");
    b.CENTER_NAME = "MOON";
    b.EPHEMERIS_DATA_LINES = lines;
    if (step) { b.START_TIME = E0; b.STOP_TIME = isoL(3600); b.STEP_SIZE = step; }
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  };
  const first = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: lunarSet }, { portId: "grid", typeRef: oemType, payload: lunarBlock([], 3600) }] });
  const L0 = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(first.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  const P = catalog.prw;
  const moon = async (st, startMs, sampleMs) => {
    const request = catalog.fullForceRequest({ epoch: isoMs(startMs), state: st.map((x) => x * 1000), target: isoMs(sampleMs.at(-1)), cdAm: 0, crAm: 0.01,
      forces: { CENTRAL_BODY_NAIF_ID: 301, GRAVITY_CHOICE: P.pcfGravitySelection.GRGM660PRIM, GRAVITATIONAL_PARAMETER: 4902.7998069317e9, MAXIMUM_DEGREE: 70, MAXIMUM_ORDER: 70,
        THIRD_BODY_IDS: [10, 399], ENABLE_DRAG: false, SOLID_TIDES: 0, RELATIVITY: 0, EARTH_RADIATION: 0, OCEAN_TIDES: 0, OCEAN_TIDE_MAXIMUM_DEGREE: 0, OCEAN_TIDE_MAXIMUM_ORDER: 0 } });
    request.SAMPLE_EPOCHS = sampleMs.map((t) => catalog.instant(isoMs(t)));
    request.INITIAL.STATE.COORDINATE_SYSTEM_NAME = "ICRF";
    request.INITIAL.COORDINATE_SYSTEM = Object.assign(new P.RFMCoordinateSystemT(), { NAME: "ICRF", AXIS_TYPE: P.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: 301,
      ORIGIN: Object.assign(new P.RFMOriginT(), { KIND: P.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: 301 }) });
    const r = await ffm.invoke({ methodId: "invoke", inputs: [{ portId: "request", typeRef: catalog.TYPE, payload: catalog.encode("EXECUTION_REQUEST", request) }, ffmInputs[0]] });
    if (r.statusCode !== 0) throw new Error(`FFM-1 about the Moon: ${r.errorCode} ${r.errorMessage}`);
    const res = catalog.prw.PRW.getSizePrefixedRootAsPRW(new ffb.ByteBuffer(new Uint8Array(r.outputs.find((f) => f.portId === "response").payload))).unpack().EXECUTION_RESULT;
    return res.SAMPLES.map((q) => { const v = q.STATE.STATE; return ["POSITION", "VELOCITY"].flatMap((k) => ["X", "Y", "Z"].map((c) => v[k][c] / 1000)); });
  };
  const tl = Array.from({ length: 24 * 3600 / STEPL + 1 }, (_, k) => k * STEPL);
  const x0 = [L0.X, L0.Y, L0.Z, L0.X_DOT, L0.Y_DOT, L0.Z_DOT];
  const before = tl.filter((s2) => s2 <= TB);
  const pre = await moon(x0, e0ms, [...before, TB].map((s2) => e0ms + s2 * 1000));
  const whole = await moon(x0, e0ms, tl.map((s2) => e0ms + s2 * 1000));
  const post = await moon(uvwAdd(pre.at(-1), [0, 2e-5, 0]), e0ms + TB * 1000, tl.filter((s2) => s2 > TB).map((s2) => e0ms + s2 * 1000));
  const burned = [...pre.slice(0, before.length), ...post];
  const fitLunar = async (states) => {
    const r = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: lunarBlock(tl.map((s2, j) => new ephemerisDataLineT(isoL(s2), ...states[j]))) }] });
    if (r.statusCode !== 0) return { error: `${r.errorCode} ${r.errorMessage}` };
    const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload));
    let before_s = null;
    for (let q = 0; q < e.userDefinedParametersLength(); ++q) if (e.USER_DEFINED_PARAMETERS(q).PARAM_NAME() === "SDNAP_MANEUVER_BEFORE_SECONDS") before_s = Number(e.USER_DEFINED_PARAMETERS(q).PARAM_VALUE());
    const dvV = Number(/dv U -?[\d.]+ V (-?[\d.]+) W/.exec(e.COMMENT())?.[1]);
    return { before_s, dvV, c: e.COMMENT() };
  };
  const withBurn = await fitLunar(burned), clean = await fitLunar(whole);
  console.log(`lunar 2 cm/s burn at 12 h: ${withBurn.error ?? `segment from ${(withBurn.before_s / 3600).toFixed(3)} h, ${withBurn.c.replace(/^.*?\); /, "")}`}; the same arc without it: ${clean.error ?? (clean.before_s === null ? "fitted whole" : `segment from ${clean.before_s} s`)}`);
  check(withBurn.before_s !== null && Math.abs(withBurn.before_s - TB) <= 3600 && Math.abs(withBurn.dvV - 20) <= 4, `lunar burn: ${withBurn.error ?? withBurn.c}`);
  check(clean.before_s === null && !clean.error, `lunar arc without a burn: ${clean.error ?? clean.c}`);
}
// HEO fit span (item 7): a THEMIS-like orbit (1.05 rev/day, e 0.82, perigee 800 km) in FFM-1, fitted by fit SDNAP over
// 24 and 48 h ending at the same time. Over two revolutions the analytic Jacobian (two-body motion with the J2 drifts)
// leaves the LM short of the minimum; an eccentric block's fits take the theory's finite-difference columns there,
// so the 48 h fit converges (fit RMS within 2x the 24 h fit's, not 6x), and on 144 h of data the default span rule
// keeps the 24 h span that predicts best here
{
  const STEPH = 300, el = [40900, 0.8247, 40, 40, 250, 10];
  const pe = m.x.sdnap_alloc(48), py = m.x.sdnap_alloc(48);
  new Float64Array(m.harness.memory.buffer, pe, 6).set(el);
  m.x.sdnap_insertion_state(ep.whole, ep.frac, pe, 0, py);
  const yh = Array.from(new Float64Array(m.harness.memory.buffer, py, 6));
  [pe, py].forEach((q) => m.x.sdnap_free(q));
  const th = Array.from({ length: (144 + 72) * 3600 / STEPH + 1 }, (_, k) => k * STEPH);
  const truth = await ffmTruth(yh, epochMs, th, [], 0.01, 0.02);
  const STOP = 144 * 3600;
  const heoOem = (from, useable) => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.START_TIME = b.STOP_TIME = null;
    b.USEABLE_START_TIME = useable ? iso(from) : null;
    b.USEABLE_STOP_TIME = iso(STOP);
    b.REFERENCE_FRAME = rfm("TEME", "both");
    b.EPHEMERIS_DATA_LINES = [];
    th.forEach((s2, j) => { if (s2 >= from && s2 <= STOP) b.EPHEMERIS_DATA_LINES.push(new ephemerisDataLineT(iso(s2), ...truth[j])); });
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  };
  const fitHeo = async (from, useable) => {
    const r = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: heoOem(from, useable) }] });
    if (r.statusCode !== 0) return { error: `${r.errorCode} ${r.errorMessage}` };
    const c = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload)).COMMENT();
    return { rms: Number(/fit RMS ([\d.]+) km/.exec(c)[1]), span: Number(/span ([\d.]+) h/.exec(c)[1]), c };
  };
  const day = await fitHeo(STOP - 24 * 3600, true), two = await fitHeo(STOP - 48 * 3600, true), rule = await fitHeo(0, false);
  console.log(`HEO (THEMIS-like) fits: 24 h RMS ${day.rms ?? day.error} km, 48 h RMS ${two.rms ?? two.error} km; the default rule on 144 h: span ${rule.span ?? rule.error} h`);
  check(day.rms > 0 && two.rms > 0 && two.rms <= 2 * day.rms, `HEO 48 h fit: ${two.rms ?? two.error} km against 24 h ${day.rms ?? day.error} km`);
  check(Math.abs(rule.span - 24) < 0.01, `HEO default span: ${rule.span ?? rule.error} h`);
}
// refusals by name
{
  const early = await command.invoke({ methodId: "maneuver", inputs: [{ portId: "omm", typeRef: ommType, payload: set }, { portId: "maneuvers", typeRef: mnvType, payload: mnv(-7 * 86400, -7 * 86400, [0, 1e-3, 0]) }] });
  check(early.statusCode !== 0 && early.errorCode === "maneuver-before-epoch", `a burn before the epoch: ${early.errorCode}`);
  // a missing required port is refused by the SDK's command surface before the module runs
  const none = await command.invoke({ methodId: "maneuver", inputs: [{ portId: "omm", typeRef: ommType, payload: set }] }).catch((e) => ({ statusCode: 400, errorCode: e?.response?.errorCode ?? String(e) }));
  check(none.statusCode !== 0 && (none.errorCode === "missing-required-input" || none.errorCode === "missing-input"), `no $MNV: ${none.errorCode}`);
  // an arc no Earth set holds (a 100 m/s burn inside it): the latest half of the span is fitted instead, down to
  // FIT.MINIMUM_SPAN_HOURS (24 h); with the burn inside that too, refused at fit time by name, not emitted
  const after = await reference([[12 * 3600, 12 * 3600, 0, 0.1, 0]]);
  const half = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: oemOf(after, 0, FIT_H * 3600) }] });
  const halfComment = half.statusCode === 0 ? OMM.getRootAsOMM(new flatbuffers.ByteBuffer(half.outputs.find((o) => o.portId === "elements").payload)).COMMENT() : "";
  console.log(`a 100 m/s burn 12 h into the 48 h arc: ${half.errorCode ?? "fitted"}; ${halfComment.replace(/^.*?; (\d+ states fitted)/, "$1")}`);
  check(half.statusCode === 0 && /span 24\.000 h \(shortened/.test(halfComment), `a burn inside the default span only: ${half.errorCode} ${halfComment}`);
  const torn = await reference([[36 * 3600, 36 * 3600, 0, 0.1, 0]]);
  const bad = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: oemOf(torn, 0, FIT_H * 3600) }] });
  check(bad.statusCode !== 0 && bad.errorCode === "fit-implausible", `a torn arc: ${bad.errorCode} ${bad.errorMessage}`);
  console.log(`refusals: ${early.errorCode}, ${none.errorCode}, ${bad.errorCode} (${bad.errorMessage})`);
}
console.log(failures.length === 0 ? "\nevents E2E: PASS" : `\nevents E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
