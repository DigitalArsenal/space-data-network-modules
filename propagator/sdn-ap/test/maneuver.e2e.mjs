#!/usr/bin/env node
// E2E (task modules-sdn-ap-remove-sdnap-theory-20261025): maneuvers as boundaries between SGP4XP sets (DESIGN 5.1).
// The 'maneuver' method carries an SGP4XP set across the burns of $MNV records. Every number compared here is the
// module's: the pre-burn state from `propagate` of the set, the post-burn state from `propagate` of the post-burn
// set (or the grid the maneuver method writes), and the UVW to TEME rotation from sdnap_uvw_to_frame.
// - An impulse of 1 mm/s, 10 cm/s or 1 m/s along V, and 1 m/s along U and W, at 24 h: at the burn epoch the post set's
//   state is the pre-burn state to 1 um (position) and its velocity the pre-burn velocity plus the Delta v (UVW axes
//   of the pre-burn state, rotated to TEME) to 5e-9 km/s (the inverse map's best-iterate bound is 1e-6 km, 1e-9 km/s).
// - A finite burn of 10 and of 60 minutes (1 m/s along V): the eccentricity-vector and plane increments are those of
//   the impulse at the centroid scaled by sinc(dL/2), dL = n D (15): the post set's eccentricity-vector increment over
//   the pre-burn set's mean elements is sinc(dL/2) of the impulse set's, within 1e-3 relative (sinc 0.981 for 10
//   minutes, 0.442 for 60).
// - The $MNV record: PRE_EVENT and POST_EVENT states, DELTA_VEL, the CHARACTERIZATION from the Delta v direction.
// - The fit of an arc across a burn (the grid the maneuver method writes): FIT.DEFAULT_SPAN_HOURS 24 fits the latest
//   24 h; a 100 m/s burn 12 h into a 48 h arc: the default span is shortened to the 24 h that holds one set; a 100 m/s
//   burn 36 h in: no set holds the arc (fit-implausible).
// - $PCF refusals by name; refusals of the maneuver method: a burn before the epoch, no $MNV.
// JS orchestrates and compares; the dynamics, the fit and the maps are the module's.
//   node test/maneuver.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { MNV, MNVT } from "spacedatastandards.org/lib/js/MNV/MNV.js";
import { maneuverStatus } from "spacedatastandards.org/lib/js/MNV/maneuverStatus.js";
import { maneuverCharacterization } from "spacedatastandards.org/lib/js/MNV/maneuverCharacterization.js";
import { packOem, rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration, withConfiguration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x, mem = () => m.harness.memory.buffer;
const command = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const mnvType = { schemaName: "MNV.fbs", fileIdentifier: "$MNV", rootTypeName: "MNV" };
const EPOCH = "2026-10-20T12:00:00.000000";
const epochMs = Date.parse(EPOCH + "Z");
const iso = (s) => new Date(epochMs + s * 1000).toISOString().replace("Z", "000");
const norm = (a) => Math.hypot(...a);

// the seed: an SGP4XP set (ISS-like, 420 km)
const seed = (() => {
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString(EPOCH);
  OMM.startOMM(b); OMM.addEpoch(b, epoch); OMM.addMeanMotion(b, 15.5); OMM.addEccentricity(b, 0.0005); OMM.addInclination(b, 51.6);
  OMM.addRaOfAscNode(b, 120); OMM.addArgOfPericenter(b, 90); OMM.addMeanAnomaly(b, 30); OMM.addNoradCatId(b, 90030);
  OMM.addMeanElementTheory(b, 1); OMM.addBstar(b, 0.012); OMM.addMeanMotionDdot(b, 0.01);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
})();
/** A TEME grid $OEM of explicit epochs (s from the epoch). */
const grid = (seconds) => {
  const block = new ephemerisDataBlockT();
  block.CENTER_NAME = "EARTH"; block.REFERENCE_FRAME = rfm("TEME", "both"); block.TIME_SYSTEM = timingStandard.UTC;
  block.START_TIME = iso(seconds[0]); block.STOP_TIME = iso(seconds.at(-1));
  block.EPHEMERIS_DATA_LINES = seconds.map((s) => new ephemerisDataLineT(iso(s)));
  const o = new OEMT(); o.CCSDS_OEM_VERS = 3.0; o.ORIGINATOR = "maneuver E2E"; o.EPHEMERIS_DATA_BLOCK = [block];
  const b = new flatbuffers.Builder(1 << 16); OEM.finishOEMBuffer(b, o.pack(b));
  return { portId: "grid", typeRef: oemType, payload: b.asUint8Array() };
};
const linesOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const stateOf = (L) => [L.X, L.Y, L.Z, L.X_DOT, L.Y_DOT, L.Z_DOT];
const propagate = async (omm, seconds) => {
  const r = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: omm }, grid(seconds)] });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return linesOf(r.outputs[0].payload).map(stateOf);
};
const mnv = (startS, endS, dv) => {
  const t = new MNVT();
  t.ID = "E2E-BURN"; t.SAT_NO = 90030; t.STATUS = maneuverStatus.PLANNED;
  t.EVENT_START_TIME = iso(startS);
  if (endS > startS) t.EVENT_END_TIME = iso(endS);
  [t.DELTA_VEL_U, t.DELTA_VEL_V, t.DELTA_VEL_W] = dv;
  const b = new flatbuffers.Builder(512);
  MNV.finishMNVBuffer(b, t.pack(b));
  return { portId: "maneuvers", typeRef: mnvType, payload: b.asUint8Array() };
};
const across = async (omm, startS, endS, dv, seconds) =>
  command.invoke({ methodId: "maneuver", inputs: [{ portId: "omm", typeRef: ommType, payload: omm }, mnv(startS, endS, dv), ...(seconds ? [grid(seconds)] : [])] });
/** A UVW vector of the state (r, v) in TEME, from the module. */
const uvwToTeme = (s6, uvw) => {
  const p = x.sdnap_alloc(96);
  new Float64Array(mem(), p, 9).set([...s6, ...uvw]);
  x.sdnap_uvw_to_frame(p, p + 24, p + 48, p + 72);
  const d = Array.from(new Float64Array(mem(), p + 72, 3));
  x.sdnap_free(p);
  return d;
};

const tb = 24 * 3600;
const [pre] = await propagate(seed, [tb]);

// --- impulses
for (const [label, dv] of [["V 1 mm/s", [0, 1e-6, 0]], ["V 10 cm/s", [0, 1e-4, 0]], ["V 1 m/s", [0, 1e-3, 0]], ["U 1 m/s", [1e-3, 0, 0]], ["W 1 m/s", [0, 0, 1e-3]]]) {
  const r = await across(seed, tb, tb, dv, [0, tb, tb + 86400]);
  if (r.statusCode !== 0) { failures.push(`impulse ${label}: ${r.errorCode} ${r.errorMessage}`); continue; }
  const post = linesOf(r.outputs.find((o) => o.portId === "ephemeris").payload).map(stateOf);
  const want = uvwToTeme(pre, dv);
  const dr = norm([0, 1, 2].map((k) => post[1][k] - pre[k]));
  const dvErr = norm([0, 1, 2].map((k) => post[1][3 + k] - pre[3 + k] - want[k]));
  const setPost = r.outputs.find((o) => o.portId === "elements").payload;
  const [back] = await propagate(setPost, [tb]);
  const dBack = norm(back.map((v, k) => v - post[1][k]));
  console.log(`impulse ${label}: at the burn, position ${(dr * 1e6).toExponential(2)} mm and velocity ${(dvErr * 1e6).toExponential(2)} mm/s from pre-burn + dv; the post set re-propagated ${dBack.toExponential(2)} km/(km/s) from the grid's state`);
  check(dr <= 1e-6 && dvErr <= 5e-9, `impulse ${label}: dr ${dr} km, dv error ${dvErr} km/s`);
  check(dBack <= 1e-9, `impulse ${label}: the post set and the grid differ by ${dBack}`);
  const out = MNV.getRootAsMNV(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "maneuvers").payload));
  check(out.PRE_EVENT() !== null && out.POST_EVENT() !== null && Math.abs(out.DELTA_VEL() - norm(dv)) < 1e-12, `impulse ${label}: the $MNV record`);
  if (label === "V 1 m/s") check(out.CHARACTERIZATION() === maneuverCharacterization.ORBIT_RAISING, `V 1 m/s characterized ${out.CHARACTERIZATION()}`);
  if (label === "W 1 m/s") check(out.CHARACTERIZATION() === maneuverCharacterization.OUT_OF_PLANE, `W 1 m/s characterized ${out.CHARACTERIZATION()}`);
}

// --- finite burns, against the impulse at the same centroid
{
  // the pre-burn set's own mean elements at the burn epoch (the module's)
  const jd = Date.parse(EPOCH + "Z") / 86400000 + 2440587.5, whole = Math.floor(jd - 0.5) + 0.5;
  m.init([{ epochWhole: whole, epochFrac: jd - whole, meanMotion: 15.5, ecc: 0.0005, inc: 51.6, raan: 120, argp: 90, ma: 30, bterm: 0.012, agom: 0.01, norad: 90030, theory: 4 }]);
  const q = x.sdnap_alloc(48);
  if (x.sdnap_mean_elements_at(0, tb / 60, q) !== 0) throw new Error("mean elements of the pre-burn set");
  const [, e0, , raan0, argp0] = Array.from(new Float64Array(mem(), q, 6));
  x.sdnap_free(q);
  const rad = Math.PI / 180;
  const evec = (e, raan, argp) => [e * Math.cos((raan + argp) * rad), e * Math.sin((raan + argp) * rad)];
  const e00 = evec(e0, raan0, argp0);
  const increment = (setBytes) => {
    const o = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(setBytes));
    const v = evec(o.ECCENTRICITY(), o.RA_OF_ASC_NODE(), o.ARG_OF_PERICENTER());
    return norm([v[0] - e00[0], v[1] - e00[1]]);
  };
  const dv = [0, 1e-3, 0];
  const imp = await across(seed, tb, tb, dv);
  const iInc = increment(imp.outputs.find((o) => o.portId === "elements").payload);
  const n = 15.5 * 2 * Math.PI / 86400;  // rad/s, the argument of sinc only
  for (const D of [600, 3600]) {
    const fin = await across(seed, tb - D / 2, tb + D / 2, dv);
    if (fin.statusCode !== 0 || imp.statusCode !== 0) { failures.push(`finite burn ${D} s: ${fin.errorCode} ${imp.errorCode}`); continue; }
    const fInc = increment(fin.outputs.find((o) => o.portId === "elements").payload);
    const half = 0.5 * n * D, sinc = Math.sin(half) / half;
    console.log(`finite burn ${D / 60} min (1 m/s along V): the post set's eccentricity-vector increment is ${(fInc / iInc).toFixed(5)} of the impulse's; sinc(dL/2) = ${sinc.toFixed(5)}`);
    check(Math.abs(fInc / iInc / sinc - 1) <= 1e-3, `finite burn ${D} s: ${fInc / iInc} against sinc ${sinc}`);
  }
}

// --- the fit of an arc across a burn: the grid the maneuver method writes is the data
const arcAcross = async (burnS, dv) => {
  const seconds = Array.from({ length: 48 * 60 + 1 }, (_, k) => k * 60);
  const r = await across(seed, burnS, burnS, dv, seconds);
  if (r.statusCode !== 0) throw new Error(`arc across a burn: ${r.errorCode} ${r.errorMessage}`);
  const data = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "ephemeris").payload)).unpack();
  const blk = data.EPHEMERIS_DATA_BLOCK[0];
  blk.REFERENCE_FRAME = rfm("TEME", "both");
  return packOem(data);
};
const fitCall = (options, payload) => command.invoke({ methodId: "fit", inputs: [configuration(options), { portId: "ephemeris", typeRef: oemType, payload }] });
const spanOf = (c) => Number(/span ([\d.]+) h/.exec(c ?? "")?.[1]);
const commentOf = (r) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload)).COMMENT();
{
  const calm = await arcAcross(30 * 24 * 3600, [0, 0, 0]);  // a burn far beyond the arc: none inside it
  const full = await fitCall({}, calm);
  const day = await fitCall({ theory: "SGP4XP", fit: { DEFAULT_SPAN_HOURS: 24 } }, calm);
  check(full.statusCode === 0 && day.statusCode === 0, `fit of a calm arc: ${full.errorCode} ${day.errorCode}`);
  if (day.statusCode === 0) {
    console.log(`$PCF FIT.DEFAULT_SPAN_HOURS 24 on the 48 h arc: span ${spanOf(commentOf(day))} h (default: ${spanOf(commentOf(full))} h)`);
    check(Math.abs(spanOf(commentOf(day)) - 24) < 0.01, `FIT.DEFAULT_SPAN_HOURS 24: ${commentOf(day)}`);
  }
  const soft = await fitCall({}, await arcAcross(12 * 3600, [0, 0.1, 0]));
  const softComment = soft.statusCode === 0 ? commentOf(soft) : "";
  console.log(`a 100 m/s burn 12 h into the 48 h arc: ${soft.errorCode ?? "fitted"}; ${softComment.replace(/^.*?; (\d+ states fitted)/, "$1")}`);
  check(soft.statusCode === 0 && /span 24\.000 h \(shortened/.test(softComment), `a burn inside the default span only: ${soft.errorCode} ${softComment}`);
  const torn = await fitCall({}, await arcAcross(36 * 3600, [0, 0.1, 0]));
  console.log(`a 100 m/s burn 36 h into the 48 h arc: ${torn.errorCode} ${torn.errorMessage}`);
  check(torn.statusCode !== 0 && torn.errorCode === "fit-implausible", `a torn arc: ${torn.errorCode} ${torn.errorMessage}`);
}

// --- $PCF refusals by name
{
  const calm = await arcAcross(30 * 24 * 3600, [0, 0, 0]);
  const refusals = [
    [{ theory: "FFM" }, "THEORY"],
    [{ theory: "SDNAP" }, "THEORY"],
    [{ theory: "SGP4XP", mean: { ZONAL_MAXIMUM_DEGREE: 30 } }, "MEAN_ELEMENT.ZONAL_MAXIMUM_DEGREE"],
    [{ theory: "SGP4XP", forces: { EPHEMERIS_SOURCE: "", ENABLE_DRAG: true } }, "FORCES.ENABLE_DRAG"],
  ];
  for (const [options, field] of refusals) {
    const r = await fitCall(options, calm);
    console.log(`$PCF refusal, fit ${JSON.stringify(options)}: ${r.errorCode} ${r.errorMessage}`);
    check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith(field + ":"), `fit ${field}: ${r.errorCode} ${r.errorMessage}`);
  }
}

// --- refusals of the maneuver method
{
  const early = await across(seed, -7 * 86400, -7 * 86400, [0, 1e-3, 0]);
  check(early.statusCode !== 0 && early.errorCode === "maneuver-before-epoch", `a burn before the epoch: ${early.errorCode}`);
  // a missing required port is refused by the SDK's command surface before the module runs
  const none = await command.invoke({ methodId: "maneuver", inputs: [{ portId: "omm", typeRef: ommType, payload: seed }] }).catch((e) => ({ statusCode: 400, errorCode: e?.response?.errorCode ?? String(e) }));
  check(none.statusCode !== 0 && (none.errorCode === "missing-required-input" || none.errorCode === "missing-input"), `no $MNV: ${none.errorCode}`);
  const sdnap = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(seed)).unpack();
  sdnap.MEAN_ELEMENT_THEORY = 4;
  const sb = new flatbuffers.Builder(256); OMM.finishOMMBuffer(sb, sdnap.pack(sb));
  const gone = await across(sb.asUint8Array(), tb, tb, [0, 1e-3, 0]);
  check(gone.statusCode !== 0 && gone.errorCode === "invalid-omm", `an SDNAP set: ${gone.errorCode}`);
  console.log(`refusals: ${early.errorCode}, ${none.errorCode}, ${gone.errorCode}`);
}

console.log(failures.length === 0 ? "\nmaneuver E2E: PASS" : `\nmaneuver E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
