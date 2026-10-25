#!/usr/bin/env node
// E2E (task modules-sdn-ap-covariance-20261025): the propagated covariance of an SGP4XP fit (SPEC 12).
// - fit (THEORY SGP4XP) of 24 h of an SGP4XP trajectory writes COVARIANCE (21 values, TEME, positive definite),
//   COV_REFERENCE_FRAME TEME and USER_DEFINED_SDNAP_COV_DRAG (the BTERM) / _AGOM, _FLOOR_UVW, _NOISE, _NG_RATE,
//   _REGIME.
// - sdnap_covariance_at round-trips it: at the epoch the state is propagate's within 1 mm and the covariance the
//   set's COVARIANCE within 1e-6 relative (Frobenius).
// - propagate of that set writes one covariance line per state: in TEME equal to sdnap_covariance_at at the same
//   times (1e-9 relative); in GCRF the same matrices rotated (position trace equal within 1e-9 relative).
// - The process noise is the one documented: a mean-longitude rate error s_l = 1e-6 (SDNAP_COV_NOISE "0 0 1e-6 0") adds
//   (a s_l n d)^2 of in-track variance d = 2 days after the arc within 10 %; the position covariance grows to 3 days.
// - A set without COVARIANCE: sdnap_covariance_at -2 and no covariance lines; an SGP4 set -4; a consider row of the
//   wrong length -6, and propagate refuses it (invalid-covariance).
// JS only moves bytes and compares numbers the module produced.
//   node test/covariance.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { packOem, rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x;
const mem = () => m.harness.memory.buffer;
const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const FIT = configuration({ theory: "SGP4XP" });
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const invoke = async (methodId, inputs) => {
  const r = await command.invoke({ methodId, inputs: [FIT, ...inputs] });
  return r;
};
const ommOf = (fields, user = []) => {
  const b = new flatbuffers.Builder(512);
  const epoch = b.createString("2026-10-20T12:00:00.000000");
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  for (const [k, v] of Object.entries(fields)) OMM[`add${k}`](b, v);
  OMM.addNoradCatId(b, 90001);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
};
const repack = (bytes, edit) => {
  const t = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
  edit(t);
  const b = new flatbuffers.Builder(4096);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
};
const gridOf = (frame, start, stop, step, epochs = null) => {
  const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(source)).unpack();
  const blk = g.EPHEMERIS_DATA_BLOCK[0];
  blk.REFERENCE_FRAME = rfm(frame);
  blk.START_TIME = start; blk.STOP_TIME = stop; blk.STEP_SIZE = step;
  blk.EPHEMERIS_DATA_LINES = epochs ? blk.EPHEMERIS_DATA_LINES.filter((L) => epochs.includes(L.EPOCH)) : [];
  return packOem(g);
};
/** sdnap_covariance_at: { status, rows: [{ state: 6, P: 36 }] }. */
const covarianceAt = (omm, minutes) => {
  const po = x.sdnap_alloc(omm.length), pm = x.sdnap_alloc(8 * Math.max(1, minutes.length)), pout = x.sdnap_alloc(8 * 42 * Math.max(1, minutes.length));
  new Uint8Array(mem(), po, omm.length).set(omm);
  new Float64Array(mem(), pm, minutes.length).set(minutes);
  const status = x.sdnap_covariance_at(po, omm.length, pm, minutes.length, pout);
  const all = Array.from(new Float64Array(mem(), pout, 42 * minutes.length));
  x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
  return { status, rows: minutes.map((_, k) => ({ state: all.slice(42 * k, 42 * k + 6), P: all.slice(42 * k + 6, 42 * k + 42) })) };
};
const lower = (P) => { const o = []; for (let i = 0; i < 6; ++i) for (let j = 0; j <= i; ++j) o.push(P[i * 6 + j]); return o; };
const lineLower = (c) => [c.CX_X, c.CY_X, c.CY_Y, c.CZ_X, c.CZ_Y, c.CZ_Z, c.CX_DOT_X, c.CX_DOT_Y, c.CX_DOT_Z, c.CX_DOT_X_DOT, c.CY_DOT_X, c.CY_DOT_Y, c.CY_DOT_Z, c.CY_DOT_X_DOT, c.CY_DOT_Y_DOT, c.CZ_DOT_X, c.CZ_DOT_Y, c.CZ_DOT_Z, c.CZ_DOT_X_DOT, c.CZ_DOT_Y_DOT, c.CZ_DOT_Z_DOT];
const relDiff = (a, b) => Math.hypot(...a.map((v, k) => v - b[k])) / Math.hypot(...b);

// --- the truth: an SGP4XP set over 4 days at 60 s (TEME)
const truthSet = ommOf({ MeanMotion: 15.06, Eccentricity: 0.0002, Inclination: 53, RaOfAscNode: 120, ArgOfPericenter: 90, MeanAnomaly: 30, Bstar: 0.01, MeanMotionDdot: 0.01, MeanElementTheory: 1 });
const source = (await command.invoke({ methodId: "propagate", inputs: [configuration({}), { portId: "omm", typeRef: ommType, payload: truthSet }] })).outputs[0].payload;
const traj = await (async () => {
  const r = await command.invoke({ methodId: "propagate", inputs: [configuration({}), { portId: "omm", typeRef: ommType, payload: truthSet },
    { portId: "grid", typeRef: oemType, payload: gridOf("TEME", "2026-10-20T12:00:00.000000", "2026-10-24T12:00:00.000000", 60) }] });
  if (r.statusCode !== 0) throw new Error(`truth: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack();
})();
const fitInput = (() => {
  const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(packOem(traj))).unpack();
  const blk = t.EPHEMERIS_DATA_BLOCK[0];
  const cat = new CATT(); cat.NORAD_CAT_ID = 90001; cat.OBJECT_ID = "2026-901A"; cat.OBJECT_NAME = "SDN-AP COVARIANCE E2E";
  blk.OBJECT = cat;
  blk.REFERENCE_FRAME = rfm("TEME");
  blk.EPHEMERIS_DATA_LINES = blk.EPHEMERIS_DATA_LINES.slice(0, 1441);
  blk.USEABLE_START_TIME = blk.EPHEMERIS_DATA_LINES[0].EPOCH;
  blk.USEABLE_STOP_TIME = blk.EPHEMERIS_DATA_LINES.at(-1).EPOCH;
  return packOem(t);
})();
const fitted = await invoke("fit", [{ portId: "ephemeris", typeRef: oemType, payload: fitInput }]);
if (fitted.statusCode !== 0) throw new Error(`fit: ${fitted.errorCode} ${fitted.errorMessage}`);
const omm = fitted.outputs.find((o) => o.portId === "elements").payload;
const set = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(omm)).unpack();
const ud = Object.fromEntries(set.USER_DEFINED_PARAMETERS.map((u) => [u.PARAM_NAME, u.PARAM_VALUE]));
console.log(`fit: ${set.COMMENT.replace(/^.*?; /, "")}`);
console.log(`  COVARIANCE ${set.COVARIANCE.length} values, frame ${set.COV_REFERENCE_FRAME?.NAME}; sigma x/y/z ${[0, 2, 5].map((k) => (Math.sqrt(set.COVARIANCE[k]) * 1e3).toFixed(2)).join("/")} m; noise ${ud.SDNAP_COV_NOISE}, r_ng ${ud.SDNAP_COV_NG_RATE}/day`);
check(set.COVARIANCE.length === 21 && set.COV_REFERENCE_FRAME?.NAME === "TEME", "COVARIANCE and its frame");
const P0 = []; { let k = 0; for (let i = 0; i < 6; ++i) for (let j = 0; j <= i; ++j) { P0[i * 6 + j] = P0[j * 6 + i] = set.COVARIANCE[k++]; } }
// positive definite: Cholesky of the 6 x 6 (JS checks the module's matrix)
{
  const L = Array(36).fill(0); let pd = true;
  for (let j = 0; j < 6 && pd; ++j) {
    let d = P0[j * 6 + j]; for (let k = 0; k < j; ++k) d -= L[j * 6 + k] ** 2;
    if (!(d > 0)) { pd = false; break; }
    L[j * 6 + j] = Math.sqrt(d);
    for (let i = j + 1; i < 6; ++i) { let s = P0[i * 6 + j]; for (let k = 0; k < j; ++k) s -= L[i * 6 + k] * L[j * 6 + k]; L[i * 6 + j] = s / L[j * 6 + j]; }
  }
  check(pd, "COVARIANCE positive definite");
}
for (const name of ["SDNAP_COV_DRAG", "SDNAP_COV_AGOM", "SDNAP_COV_FLOOR_UVW", "SDNAP_COV_NOISE", "SDNAP_COV_NG_RATE", "SDNAP_COV_REGIME"])
  check(ud[name] !== undefined, `USER_DEFINED ${name}`);
check(ud.SDNAP_COV_DRAG?.split(" ").length === 7 && ud.SDNAP_COV_AGOM?.split(" ").length === 8, "consider row lengths");
check(set.MEAN_ELEMENT_THEORY === 1 && ud.SDNAP_COV_TAUC === undefined && ud.SDNAP_B_EFF === undefined, "an SGP4XP set with no SDN-AP terms");

// --- round trip at the epoch
const arcEnd = Number(ud.SDNAP_COV_NOISE.split(" ")[4]);
check(arcEnd === 1440, `noise start ${arcEnd} vs the arc end 1440 min`);
const times = [0, 1440, 2880, 4320];
const at = covarianceAt(omm, times);
check(at.status === 0, `sdnap_covariance_at: ${at.status}`);
const teme = await invoke("propagate", [{ portId: "omm", typeRef: ommType, payload: omm }, { portId: "grid", typeRef: oemType, payload: gridOf("TEME", set.EPOCH, iso(set.EPOCH, 4320), 86400) }]);
check(teme.statusCode === 0, `propagate TEME: ${teme.errorCode}`);
const blk = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(teme.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
{
  const L = blk.EPHEMERIS_DATA_LINES[0];
  const dr = Math.hypot(L.X - at.rows[0].state[0], L.Y - at.rows[0].state[1], L.Z - at.rows[0].state[2]) * 1e3;
  const rt = relDiff(lower(at.rows[0].P), set.COVARIANCE);
  console.log(`round trip at the epoch: state ${dr.toExponential(2)} m from propagate's, covariance ${rt.toExponential(2)} relative`);
  check(dr <= 1e-3 && rt <= 1e-6, `epoch round trip: ${dr} m, ${rt}`);
}
check(blk.COVARIANCE_MATRIX_LINES.length === blk.EPHEMERIS_DATA_LINES.length && blk.COV_REFERENCE_FRAME?.NAME === "TEME", `TEME covariance lines: ${blk.COVARIANCE_MATRIX_LINES.length}`);
let worst = 0;
blk.COVARIANCE_MATRIX_LINES.forEach((c, k) => { worst = Math.max(worst, relDiff(lineLower(c), lower(at.rows[k].P))); });
console.log(`propagate's TEME covariance lines against sdnap_covariance_at: worst ${worst.toExponential(2)} relative`);
check(worst <= 1e-9, `TEME lines vs export: ${worst}`);
const trace = (P) => P[0] + P[7] + P[14];
console.log(`position sigma (sqrt trace) at 0, 1, 2, 3 days: ${at.rows.map((r) => (Math.sqrt(trace(r.P)) * 1e3).toFixed(1)).join(", ")} m`);
check(trace(at.rows[3].P) > trace(at.rows[0].P), "the covariance grows over 3 days");
{
  const gcrf = await invoke("propagate", [{ portId: "omm", typeRef: ommType, payload: omm }, { portId: "grid", typeRef: oemType, payload: gridOf("GCRF", set.EPOCH, iso(set.EPOCH, 4320), 86400) }]);
  const g = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(gcrf.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  let w = 0;
  g.COVARIANCE_MATRIX_LINES.forEach((c, k) => { const t = blk.COVARIANCE_MATRIX_LINES[k]; w = Math.max(w, Math.abs(c.CX_X + c.CY_Y + c.CZ_Z - (t.CX_X + t.CY_Y + t.CZ_Z)) / (t.CX_X + t.CY_Y + t.CZ_Z)); });
  console.log(`GCRF covariance lines: position trace against TEME's, worst ${w.toExponential(2)} relative`);
  check(gcrf.statusCode === 0 && g.COV_REFERENCE_FRAME?.NAME === "GCRF" && g.COVARIANCE_MATRIX_LINES.length === 4 && w <= 1e-9, `GCRF lines: ${w}`);
}

// --- the process noise as documented
{
  const sl = 1e-6;
  const edit = (value) => repack(omm, (t) => { t.USER_DEFINED_PARAMETERS.find((u) => u.PARAM_NAME === "SDNAP_COV_NOISE").PARAM_VALUE = value; });
  const t = arcEnd + 2880;
  const a0 = covarianceAt(edit(`0 0 0 0 ${arcEnd}`), [t]).rows[0], a1 = covarianceAt(edit(`0 0 ${sl} 0 ${arcEnd}`), [t]).rows[0];
  const r = a0.state.slice(0, 3), v = a0.state.slice(3);
  const vn = Math.hypot(...v), V = v.map((c) => c / vn);
  const proj = (P) => { let s = 0; for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) s += V[i] * P[i * 6 + j] * V[j]; return s; };
  const added = proj(a1.P) - proj(a0.P);
  const a = Math.hypot(...r), nDay = set.MEAN_MOTION * 2 * Math.PI, d = 2;
  const expected = (a * sl * nDay * d) ** 2;
  console.log(`process noise s_l = 1e-6, 2 days after the arc: in-track variance added ${(added * 1e6).toFixed(2)} m^2, (a s_l n d)^2 = ${(expected * 1e6).toFixed(2)} m^2`);
  check(Math.abs(added / expected - 1) <= 0.1, `process noise in-track: ${added} vs ${expected}`);
}

// --- refusals
{
  const plain = repack(omm, (t) => { t.COVARIANCE = []; t.COV_REFERENCE_FRAME = null; });
  check(covarianceAt(plain, [0]).status === -2, "no COVARIANCE: -2");
  const p = await invoke("propagate", [{ portId: "omm", typeRef: ommType, payload: plain }]);
  const b = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  check(p.statusCode === 0 && b.COVARIANCE_MATRIX_LINES.length === 0 && b.COV_REFERENCE_FRAME === null, "no COVARIANCE: no covariance lines");
  const sgp4 = ommOf({ MeanMotion: 15.06, Eccentricity: 0.0002, Inclination: 53, RaOfAscNode: 120, ArgOfPericenter: 90, MeanAnomaly: 30, Bstar: 1e-4, MeanElementTheory: 0 });
  check(covarianceAt(sgp4, [0]).status === -4, "SGP4 set: -4");
  const bad = repack(omm, (t) => { t.USER_DEFINED_PARAMETERS.find((u) => u.PARAM_NAME === "SDNAP_COV_DRAG").PARAM_VALUE = "1 2 3"; });
  check(covarianceAt(bad, [0]).status === -6, "malformed consider row: -6");
  const pb = await invoke("propagate", [{ portId: "omm", typeRef: ommType, payload: bad }]);
  check(pb.statusCode !== 0 && pb.errorCode === "invalid-covariance", `malformed consider row: propagate ${pb.errorCode}`);
}

function iso(epoch, minutes) { return new Date(Date.parse(`${epoch}Z`) + minutes * 60000).toISOString().replace("Z", ""); }

console.log(failures.length === 0 ? "\ncovariance E2E: PASS" : `\ncovariance E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
