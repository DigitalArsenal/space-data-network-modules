#!/usr/bin/env node
// E2E (task modules-sdn-gp-propagator-20261023): the fit command's input frames and its $OBD.
// - GCRF: the module's TEME -> GCRF rotation (IAU 2006/2000A through the pinned ERFA) on the TEME example of
//   Vallado, Crawford, Hujsak and Kelso 2006 (AIAA 2006-6753, 2004-04-06 07:51:28.386009 UTC) must give the
//   published GCRF position within 1 cm.
// - One SGP4XP set is propagated (propagate: $OMM -> TEME $OEM, 1 day at 60 s). The same states, rotated by the
//   module into GCRF and into the Earth-fixed frame (sdnap_frame_probe: the fit's own rotations), are fitted
//   through the command surface; the GCRF and ITRF fits must reproduce the TEME fit within 1 m over the day.
// - Every fit returns one $OMM ('elements') and one $OBD ('determination'); the $OBD's SAT_NO, method, states
//   accepted, iterations and WRMS must equal the $OMM's (its NORAD_CAT_ID and COMMENT statistics).
// - Frames are read from the block's metadata, never assumed: GCRF declared by the enumeration alone fits as GCRF;
//   a block with no REFERENCE_FRAME is refused (reference-frame-undeclared); an enumeration and NAME that disagree
//   are refused (reference-frame-conflict).
// - propagate on a 'grid' template: 4 days at 600 s in TEME, GCRF and EME2000 (the span is the grid's, not one
//   day); the GCRF states equal the TEME states through the module's TEME -> GCRF rotation within 1 mm; the EME2000
//   states fitted back (declared EME2000) reproduce the TEME fit within 1 m; a 4-day ephemeris is fitted over its
//   latest 48 h or 72 h (the span rule, validated on the latest 24 h); a size-prefixed $OMM propagates as the plain
//   one.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameter } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { odMethod } from "spacedatastandards.org/lib/js/OBD/odMethod.js";
import { FRAME_PROBE, jdOf, oemInFrame, packOem, rfm, rotate } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration, withConfiguration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();

// --- Vallado et al. 2006, TEME -> GCRF
{
  const teme = [5094.18016210, 6127.64465950, 6380.34453270, -4.746131487, 0.785818041, 5.531931288];
  const gcrf = [5102.508958, 6123.011401, 6378.136928];
  const t = jdOf("2004-04-06T07:51:28.386009");
  const { status, out } = rotate(m, t.whole, t.frac, teme, FRAME_PROBE.TEME_TO_GCRF);
  const dr = Math.hypot(out[0] - gcrf[0], out[1] - gcrf[1], out[2] - gcrf[2]) * 1e3;
  console.log(`TEME -> GCRF, Vallado et al. 2006 example: |dr| ${dr.toFixed(4)} m (status ${status})`);
  check(status === 0 && dr <= 0.01, `Vallado 2006 TEME -> GCRF: ${dr} m`);
}

// --- one SGP4XP set, propagated, then fitted in three frames
// every configured method takes a $PCF; THEORY SDNAP selects the SDN-AP fit
const command = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
const SDNAP = configuration({ theory: "SDNAP" });
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const ommBytes = (() => {
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString("2026-10-20T12:00:00.000000");
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  OMM.addMeanMotion(b, 15.06);
  OMM.addEccentricity(b, 0.0002);
  OMM.addInclination(b, 53);
  OMM.addRaOfAscNode(b, 120);
  OMM.addArgOfPericenter(b, 90);
  OMM.addMeanAnomaly(b, 30);
  OMM.addBstar(b, 0.01);
  OMM.addMeanMotionDdot(b, 0.01);
  OMM.addNoradCatId(b, 90001);
  OMM.addMeanElementTheory(b, 1);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
})();
const propagate = async (payload) => {
  const r = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload }] });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return r.outputs[0].payload;
};
const source = await propagate(ommBytes);
const fit = async (label, payload, spanDays = 1) => {
  const cpu = process.cpuUsage();
  const r = await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload }] });
  const seconds = process.cpuUsage(cpu).user / 1e6;
  if (r.statusCode !== 0) throw new Error(`fit ${label}: ${r.errorCode} ${r.errorMessage}`);
  const omm = r.outputs.filter((o) => o.portId === "elements");
  const obd = r.outputs.filter((o) => o.portId === "determination");
  check(omm.length === 1 && obd.length === 1, `fit ${label}: ${omm.length} $OMM, ${obd.length} $OBD`);
  const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(omm[0].payload));
  const d = OBD.getRootAsOBD(new flatbuffers.ByteBuffer(obd[0].payload));
  const c = /(\d+) states fitted, (\d+) held out; fit RMS ([\d.]+) km.*; (\d+) iterations/.exec(e.COMMENT());
  check(c !== null, `fit ${label}: COMMENT ${e.COMMENT()}`);
  check(e.NORAD_CAT_ID() === 90001 && d.SAT_NO() === 90001 && d.ORIG_OBJECT_ID() === "2026-901A", `fit ${label}: object ids`);
  check(d.METHOD() === odMethod.BATCH_LEAST_SQUARES, `fit ${label}: method ${d.METHOD()}`);
  check(d.NUM_ACCEPTED_OBS() === +c[1] && d.NUM_ITERATIONS() === +c[4], `fit ${label}: $OBD counts ${d.NUM_ACCEPTED_OBS()}/${d.NUM_ITERATIONS()} vs ${c[1]}/${c[4]}`);
  check(Math.abs(d.WRMS() - +c[3]) <= 5e-7, `fit ${label}: $OBD WRMS ${d.WRMS()} vs ${c[3]}`);
  check(Math.abs(d.FIT_SPAN() - spanDays) <= 1e-9 && d.BEST_PASS_WRMS() <= d.FIRST_PASS_WRMS(), `fit ${label}: spans or passes (${d.FIT_SPAN()} d)`);
  console.log(`fit ${label}: ${c[1]} states, RMS ${(+c[3] * 1e3).toFixed(3)} m, ${c[4]} iterations; $OBD ${d.START_TIME()} .. ${d.END_TIME()}, first/best/WRMS ${(d.FIRST_PASS_WRMS() * 1e3).toFixed(3)}/${(d.BEST_PASS_WRMS() * 1e3).toFixed(3)}/${(d.WRMS() * 1e3).toFixed(3)} m; CPU ${seconds.toFixed(2)} s`);
  return omm[0].payload;
};
const states = async (ommPayload) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(await propagate(ommPayload))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const teme = await states(await fit("TEME", oemInFrame(m, source, "TEME", null)));
for (const [label, mode] of [["GCRF", FRAME_PROBE.TEME_TO_GCRF], ["ITRF", FRAME_PROBE.TEME_TO_EARTH_FIXED]]) {
  const other = await states(await fit(label, oemInFrame(m, source, label, mode)));
  let max = 0;
  for (let k = 0; k < teme.length; ++k) max = Math.max(max, Math.hypot(other[k].X - teme[k].X, other[k].Y - teme[k].Y, other[k].Z - teme[k].Z) * 1e3);
  console.log(`${label} fit vs TEME fit over the day: max |dr| ${max.toExponential(3)} m (${other.length} states)`);
  check(other.length === teme.length && max <= 1.0, `${label} fit vs TEME fit: ${max} m`);
}

// --- frames from the block's metadata, never assumed
{
  const byEnum = await states(await fit("GCRF (enumeration only)", oemInFrame(m, source, "GCRF", FRAME_PROBE.TEME_TO_GCRF, undefined, "enum")));
  let max = 0;
  for (let k = 0; k < teme.length; ++k) max = Math.max(max, Math.hypot(byEnum[k].X - teme[k].X, byEnum[k].Y - teme[k].Y, byEnum[k].Z - teme[k].Z) * 1e3);
  console.log(`GCRF by enumeration only vs TEME fit: max |dr| ${max.toExponential(3)} m`);
  check(max <= 1.0, `GCRF by enumeration vs TEME fit: ${max} m`);
  const code = async (method, payload) => {
    const r = await command.invoke(method === "fit SDNAP"
      ? { methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload }] }
      : { methodId: method, inputs: [{ portId: "ephemeris", typeRef: oemType, payload }] });
    return r.statusCode === 0 ? "accepted" : r.errorCode;
  };
  const conflict = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oemInFrame(m, source, "GCRF", null, undefined, "enum"))).unpack();
  conflict.EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME.NAME = "TEME";
  const elsewhere = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oemInFrame(m, source, "GCRF", null, undefined, "both"))).unpack();
  for (const method of ["fit", "fit SDNAP"]) {
    // fit (SGP4XP) is geocentric; fit SDNAP fits Earth- and Moon-centred blocks, nothing else
    elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME = method === "fit" ? "MOON" : "MARS";
    const centre = await code(method, packOem(elsewhere));
    console.log(`${method}: CENTER_NAME ${elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME} -> ${centre}`);
    check(centre === "unsupported-center", `${method} with a ${elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME}-centred block: ${centre}`);
    const undeclared = await code(method, oemInFrame(m, source, null, null));
    const disagree = await code(method, packOem(conflict));
    console.log(`${method}: no REFERENCE_FRAME -> ${undeclared}; enumeration GCRF with NAME TEME -> ${disagree}`);
    check(undeclared === "reference-frame-undeclared", `${method} without a frame: ${undeclared}`);
    check(disagree === "reference-frame-conflict", `${method} with conflicting frames: ${disagree}`);
  }
}

// --- propagate on a grid template (the grid's span decides), TEME / GCRF / EME2000; the default 48 h fit span
{
  const grid = (frame) => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(source)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.EPHEMERIS_DATA_LINES = [];
    b.START_TIME = "2026-10-20T12:00:00.000000";
    b.STOP_TIME = "2026-10-24T12:00:00.000000";
    b.STEP_SIZE = 600;
    b.REFERENCE_FRAME = rfm(frame, "both");
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  };
  const run = async (frame, omm = ommBytes) => {
    const r = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: omm }, { portId: "grid", typeRef: oemType, payload: grid(frame) }] });
    if (r.statusCode !== 0) throw new Error(`propagate on a ${frame} grid: ${r.errorCode} ${r.errorMessage}`);
    return r.outputs[0].payload;
  };
  const temeBytes = await run("TEME");
  const tl = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(temeBytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  console.log(`TEME grid: ${tl.length} states, ${tl[0].EPOCH} .. ${tl[tl.length - 1].EPOCH}`);
  check(tl.length === 577 && tl[tl.length - 1].EPOCH === "2026-10-24T12:00:00.000000", `TEME grid: ${tl.length} states to ${tl[tl.length - 1].EPOCH}`);
  const gl = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(await run("GCRF"))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  let max = 0;
  for (let k = 0; k < tl.length; ++k) {
    const t = jdOf(tl[k].EPOCH);
    const { out } = rotate(m, t.whole, t.frac, [tl[k].X, tl[k].Y, tl[k].Z, tl[k].X_DOT, tl[k].Y_DOT, tl[k].Z_DOT], FRAME_PROBE.TEME_TO_GCRF);
    max = Math.max(max, Math.hypot(gl[k].X - out[0], gl[k].Y - out[1], gl[k].Z - out[2]) * 1e6);
  }
  console.log(`GCRF grid vs TEME grid rotated by the module: max |dr| ${max.toExponential(3)} mm`);
  check(gl.length === tl.length && max <= 1.0, `GCRF grid: ${max} mm`);
  // the span rule: 48 h, or 72 h when it predicts the latest 24 h at least 10 % better (the 96 h of data cannot
  // cover 120 h + 24 h); the $OBD's FIT_SPAN follows the COMMENT's span
  const probe = await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: oemInFrame(m, temeBytes, "TEME", null) }] });
  const probeSpan = Number(/span ([\d.]+) h/.exec(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(probe.outputs.find((o) => o.portId === "elements").payload)).COMMENT())[1]);
  const temeFitBytes = await fit("TEME, 4 days", oemInFrame(m, temeBytes, "TEME", null), probeSpan / 24);
  const fromTeme = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(temeFitBytes));
  const span = /span ([\d.]+) h \((default \(FIT.DEFAULT_SPAN_HOURS\)|extended: better on the latest tail)\)/.exec(fromTeme.COMMENT());
  console.log(`4-day TEME ephemeris: ${fromTeme.COMMENT().replace(/^.*?; (\d+ states fitted)/, "$1")}`);
  // the span rule: 48 h, extended to 72 h (the 96 h of data cannot cover 120 h) as the fit stays within the rule
  const spanOk = span !== null && ((Math.abs(+span[1] - 48) <= 1e-6 && span[2].startsWith("default") && /^.*?289 states fitted/.test(fromTeme.COMMENT())) ||
    (Math.abs(+span[1] - 72) <= 1e-6 && span[2].startsWith("extended") && /^.*?433 states fitted/.test(fromTeme.COMMENT())));
  check(spanOk, `span rule: ${fromTeme.COMMENT()}`);
  const a = await states(await fit("EME2000, 4 days", oemInFrame(m, await run("EME2000"), "EME2000", null, undefined, "both"), probeSpan / 24));
  const b = await states(temeFitBytes);
  let dmax = 0;
  for (let k = 0; k < a.length; ++k) dmax = Math.max(dmax, Math.hypot(a[k].X - b[k].X, a[k].Y - b[k].Y, a[k].Z - b[k].Z) * 1e3);
  console.log(`EME2000 grid fitted back vs the TEME fit: max |dr| ${dmax.toExponential(3)} m`);
  check(a.length === b.length && dmax <= 1.0, `EME2000 fit vs TEME fit: ${dmax} m`);
  const prefixed = new Uint8Array(ommBytes.length + 4);
  new DataView(prefixed.buffer).setUint32(0, ommBytes.length, true);
  prefixed.set(ommBytes, 4);
  const same = Buffer.compare(Buffer.from(await run("TEME", prefixed)), Buffer.from(temeBytes)) === 0;
  console.log(`size-prefixed $OMM: ${same ? "the same $OEM bytes" : "DIFFERENT bytes"}`);
  check(same, "size-prefixed $OMM propagates differently");
  const lunar = (() => {
    const b = new flatbuffers.Builder(256);
    const epoch = b.createString("2026-10-20T12:00:00.000000"), centre = b.createString("MOON");
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, centre);
    OMM.addMeanMotion(b, 11.9);
    OMM.addEccentricity(b, 0.02);
    OMM.addInclination(b, 90);
    OMM.addNoradCatId(b, 90009);
    OMM.addMeanElementTheory(b, 1);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  for (const method of ["propagate", "ingest_omm"]) {
    const r = await command.invoke({ methodId: method, inputs: [{ portId: "omm", typeRef: ommType, payload: lunar }] });
    console.log(`${method}: CENTER_NAME MOON -> ${r.statusCode === 0 ? "accepted" : r.errorCode}`);
    check(r.statusCode !== 0 && r.errorCode === "unsupported-center", `${method} with a Moon-centred $OMM: ${r.errorCode}`);
  }
}

// --- SDN-AP (theory 16) through fit SDNAP: a truth propagated from an SDN-AP set (B_eff 0.02 m^2/kg, tauc 2e-8 and
// taus -1e-8 m/s^2, AGOM 0.01) is fitted with a B prior of 0.1 +- 0.01 m^2/kg; B_eff, tauc, taus and kappa = 1 - B_eff/B
// must come back, and the fitted set (read back by propagate as theory 16) must reproduce the truth.
const sdnapOmm = (fields, user) => {
  const b = new flatbuffers.Builder(1024);
  const epoch = b.createString("2026-10-20T12:00:00.000000");
  const params = Object.entries(user).filter(([k]) => k !== "THEORY").map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(String(v))));
  const vec = OMM.createUserDefinedParametersVector(b, params);
  OMM.startOMM(b);
  OMM.addEpoch(b, epoch);
  for (const [k, v] of Object.entries(fields)) OMM[`add${k}`](b, v);
  OMM.addNoradCatId(b, 90002);
  OMM.addMeanElementTheory(b, user.THEORY === "SDN-AP" ? 4 : 1);
  OMM.addUserDefinedParameters(b, vec);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
};
const truthOmm = sdnapOmm({ MeanMotion: 15.3, Eccentricity: 0.0008, Inclination: 53, RaOfAscNode: 120, ArgOfPericenter: 90, MeanAnomaly: 30, Bstar: 0.02, MeanMotionDdot: 0.01 },
  { THEORY: "SDN-AP", SDNAP_TAUC: 2e-8, SDNAP_TAUS: -1e-8, SDNAP_ARC_END_MIN: 1440 });
const truthOem = await propagate(truthOmm);
const priorOmm = sdnapOmm({ MeanMotion: 15.3 }, { THEORY: "SDN-AP", SDNAP_B: 0.1, SDNAP_B_SIGMA: 0.01 });
{
  const cpu = process.cpuUsage();
  const r = await command.invoke({ methodId: "fit", inputs: [SDNAP, 
    { portId: "ephemeris", typeRef: oemType, payload: oemInFrame(m, truthOem, "TEME", null) },
    { portId: "prior", typeRef: ommType, payload: priorOmm }] });
  const seconds = process.cpuUsage(cpu).user / 1e6;
  if (r.statusCode !== 0) failures.push(`fit SDNAP: ${r.errorCode} ${r.errorMessage}`);
  else {
    const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload));
    const ud = {};
    for (let k = 0; k < e.userDefinedParametersLength(); ++k) { const q = e.USER_DEFINED_PARAMETERS(k); ud[q.PARAM_NAME()] = Number(q.PARAM_VALUE()); }
    const rms = Number(/fit RMS ([\d.]+) km/.exec(e.COMMENT())[1]);
    console.log(`fit SDNAP: B_eff ${ud.SDNAP_B_EFF.toPrecision(6)} (truth 0.02), tauc ${ud.SDNAP_TAUC.toExponential(4)} (2e-8), taus ${ud.SDNAP_TAUS.toExponential(4)} (-1e-8), kappa ${ud.SDNAP_KAPPA.toFixed(5)} +- ${ud.SDNAP_KAPPA_SIGMA.toFixed(5)} (0.8), RMS ${(rms * 1e3).toFixed(3)} m; CPU ${seconds.toFixed(2)} s`);
    check(Math.abs(ud.SDNAP_B_EFF - 0.02) < 2e-3, `fit SDNAP B_eff ${ud.SDNAP_B_EFF}`);
    check(Math.abs(ud.SDNAP_KAPPA - 0.8) < 0.03 && ud.SDNAP_KAPPA_SIGMA > 0, `fit SDNAP kappa ${ud.SDNAP_KAPPA} +- ${ud.SDNAP_KAPPA_SIGMA}`);
    const back = await states(r.outputs.find((o) => o.portId === "elements").payload);
    const truthStates = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(truthOem)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    let max = 0;
    for (let k = 0; k < truthStates.length; ++k) max = Math.max(max, Math.hypot(back[k].X - truthStates[k].X, back[k].Y - truthStates[k].Y, back[k].Z - truthStates[k].Z) * 1e3);
    console.log(`fit SDNAP set read back as theory 16 against the truth over the day: max |dr| ${max.toExponential(3)} m`);
    check(max < 5.0 && rms * 1e3 < 5.0, `fit SDNAP reproduction: max ${max} m, RMS ${rms * 1e3} m`);
  }
}

// --- B_eff free by default; the 2c.2 rule opt-in: a heavy-drag truth (B_eff 1.0 m^2/kg) fitted with no prior keeps
// B_eff near 1.0 and no LOWERING flag; with a prior carrying USER_DEFINED_SDNAP_TAU0_RULE = 1 the set is flagged
// and carries tau0 instead
{
  const heavyOmm = sdnapOmm({ MeanMotion: 15.3, Eccentricity: 0.0008, Inclination: 53, RaOfAscNode: 120, ArgOfPericenter: 90, MeanAnomaly: 30, Bstar: 1.0, MeanMotionDdot: 0.0 },
    { THEORY: "SDN-AP", SDNAP_ARC_END_MIN: 1440 });
  const heavyOem = oemInFrame(m, await propagate(heavyOmm), "TEME", null);
  const paramsOf = (r) => {
    const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload));
    const u = {};
    for (let k = 0; k < e.userDefinedParametersLength(); ++k) { const q = e.USER_DEFINED_PARAMETERS(k); u[q.PARAM_NAME()] = Number(q.PARAM_VALUE()); }
    return u;
  };
  const free = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: heavyOem }] });
  const rule = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: heavyOem },
    { portId: "prior", typeRef: ommType, payload: sdnapOmm({ MeanMotion: 15.3 }, { THEORY: "SDN-AP", SDNAP_TAU0_RULE: 1 }) }] });
  if (free.statusCode !== 0 || rule.statusCode !== 0) failures.push(`heavy-drag fits: ${free.errorCode} / ${rule.errorCode}`);
  else {
    const f = paramsOf(free), g = paramsOf(rule);
    console.log(`B_eff 1.0 truth: default B_eff ${f.SDNAP_B_EFF.toPrecision(5)}, LOWERING ${f.SDNAP_LOWERING ?? 0}; 2c.2 opt-in: B_eff ${g.SDNAP_B_EFF}, tau0 ${g.SDNAP_TAU0.toExponential(3)} m/s^2, LOWERING ${g.SDNAP_LOWERING ?? 0}`);
    check(Math.abs(f.SDNAP_B_EFF - 1.0) < 0.02 && !f.SDNAP_LOWERING, `default fit: B_eff ${f.SDNAP_B_EFF}, LOWERING ${f.SDNAP_LOWERING}`);
    check(g.SDNAP_LOWERING === 1 && g.SDNAP_B_EFF === 0 && g.SDNAP_TAU0 < 0, `2c.2 opt-in: B_eff ${g.SDNAP_B_EFF}, tau0 ${g.SDNAP_TAU0}, LOWERING ${g.SDNAP_LOWERING}`);
  }
}

// --- Moon-centred SDN-AP (2h.1): a lunar set (100 km polar, GRGM660PRIM and the DE440 PA orientation pinned) through
// propagate on a 24 h ICRF grid, fitted back by fit SDNAP from that Moon-centred $OEM, and the fitted set propagated
// again: the round trip within 20 m over the day; the $OMM and $OEM carry CENTER_NAME MOON and ICRF axes
{
  const lunarOmm = (() => {
    const b = new flatbuffers.Builder(1024);
    const params = [["SDNAP_REGIME", "MOON"]].map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(v)));
    const vec = OMM.createUserDefinedParametersVector(b, params);
    const epoch = b.createString("2026-06-01T00:00:00.000000"), centre = b.createString("MOON");
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, centre);
    OMM.addMeanMotion(b, 86400 / (2 * Math.PI * Math.sqrt(1838.0 ** 3 / 4902.7998)));
    OMM.addEccentricity(b, 0.01);
    OMM.addInclination(b, 90);
    OMM.addRaOfAscNode(b, 30);
    OMM.addArgOfPericenter(b, 90);
    OMM.addMeanAnomaly(b, 10);
    OMM.addNoradCatId(b, 90010);
    OMM.addMeanElementTheory(b, 4);
    OMM.addUserDefinedParameters(b, vec);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  const lunarGrid = (() => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(source)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.EPHEMERIS_DATA_LINES = [];
    b.START_TIME = "2026-06-01T00:00:00.000000";
    b.STOP_TIME = "2026-06-02T00:00:00.000000";
    b.STEP_SIZE = 300;
    b.REFERENCE_FRAME = rfm("GCRF", "both");
    b.CENTER_NAME = "MOON";  // the template names the set's centre
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  })();
  {
    // a template that names another centre is refused by name
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(lunarGrid)).unpack();
    t.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME = "EARTH";
    const r = await command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: lunarOmm }, { portId: "grid", typeRef: oemType, payload: packOem(t) }] });
    console.log(`lunar set on an EARTH grid: ${r.statusCode === 0 ? "accepted" : r.errorCode}`);
    check(r.statusCode !== 0 && r.errorCode === "grid-center-mismatch", `lunar set on an EARTH grid: ${r.errorCode}`);
  }
  const prop = async (omm) => command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: omm }, { portId: "grid", typeRef: oemType, payload: lunarGrid }] });
  const p1 = await prop(lunarOmm);
  if (p1.statusCode !== 0) failures.push(`lunar propagate: ${p1.errorCode} ${p1.errorMessage}`);
  else {
    const traj = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p1.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const f = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: p1.outputs[0].payload }] });
    if (f.statusCode !== 0) failures.push(`lunar fit SDNAP: ${f.errorCode} ${f.errorMessage}`);
    else {
      const fitted = f.outputs.find((o) => o.portId === "elements").payload;
      const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fitted));
      const p2 = await prop(fitted);
      const back = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p2.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      let max = 0;
      traj.EPHEMERIS_DATA_LINES.forEach((L, k) => { max = Math.max(max, Math.hypot(back[k].X - L.X, back[k].Y - L.Y, back[k].Z - L.Z) * 1e3); });
      console.log(`lunar round trip: ${traj.EPHEMERIS_DATA_LINES.length} states, centre ${traj.CENTER_NAME} / ${e.CENTER_NAME()}, axes ${traj.REFERENCE_FRAME.NAME}; ${e.COMMENT().replace(/^.*?; (\d+ states)/, "$1")}; refit vs truth max |dr| ${max.toFixed(3)} m`);
      check(traj.CENTER_NAME === "MOON" && e.CENTER_NAME() === "MOON" && traj.REFERENCE_FRAME.NAME === "ICRF", "lunar centre or axes");
      check(max <= 20.0, `lunar round trip: ${max} m`);
      // a maneuver-like break at 12 h (the second half from a set whose mean motion is 2e-4 higher): the fit must
      // segment (the latest clean segment: USER_DEFINED_SDNAP_MANEUVER_BEFORE_SECONDS from 12 h to 18 h) instead of
      // absorbing the break
      const altered = (() => {
        const t = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(lunarOmm)).unpack();
        t.MEAN_MOTION *= 1.0002;
        const b = new flatbuffers.Builder(1024);
        OMM.finishOMMBuffer(b, t.pack(b));
        return b.asUint8Array();
      })();
      const p3 = await prop(altered);
      const second = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p3.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      const stitched = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p1.outputs[0].payload)).unpack();
      const lines = stitched.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      for (let k = 145; k < lines.length; ++k) lines[k] = second[k];
      const fm = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: packOem(stitched) }] });
      if (fm.statusCode !== 0) failures.push(`lunar maneuver fit: ${fm.errorCode} ${fm.errorMessage}`);
      else {
        const em = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fm.outputs.find((o) => o.portId === "elements").payload));
        const u = {};
        for (let k = 0; k < em.userDefinedParametersLength(); ++k) { const q = em.USER_DEFINED_PARAMETERS(k); u[q.PARAM_NAME()] = Number(q.PARAM_VALUE()); }
        console.log(`lunar break at 12 h: ${em.COMMENT().replace(/^.*?\); (\d+ states)/, "$1")}; maneuver before ${u.SDNAP_MANEUVER_BEFORE_SECONDS} s`);
        check(u.SDNAP_MANEUVER_BEFORE_SECONDS >= 43200 && u.SDNAP_MANEUVER_BEFORE_SECONDS <= 64800, `lunar maneuver segmentation: ${u.SDNAP_MANEUVER_BEFORE_SECONDS}`);
      }
    }
  }
}

// --- SDN-AP segment sets (2h.2 / 2h.3 / 2h.5): an NRHO-like Moon-centred set (apolune 70,300 km: beyond the averaged
// theory's reach), an Earth orbit reaching the Moon (apogee 425,000 km) and a thrusting Sun-centred cruise set, each
// through propagate on an ICRF grid of its centre, fitted back by fit SDNAP (routed by the reach rule to a segment
// fit) and propagated again: the round trip within 20 m; the sets carry SEMI_MAJOR_AXIS, GM and the regime; a grid of
// another centre and the batch refuse them by name
{
  const segmentSet = ({ centre, gm, a, e, i, raan, argp, ma, params }) => {
    const b = new flatbuffers.Builder(1024);
    const ps = [...params].map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(String(v))));
    const vec = OMM.createUserDefinedParametersVector(b, ps);
    const epoch = b.createString("2026-06-01T00:00:00.000000"), c = b.createString(centre);
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, c);
    OMM.addSemiMajorAxis(b, a);
    OMM.addGm(b, gm);
    OMM.addMeanMotion(b, (Math.sqrt(gm / Math.abs(a) ** 3) * 86400) / (2 * Math.PI));
    OMM.addEccentricity(b, e);
    OMM.addInclination(b, i);
    OMM.addRaOfAscNode(b, raan);
    OMM.addArgOfPericenter(b, argp);
    OMM.addMeanAnomaly(b, ma);
    OMM.addNoradCatId(b, 90020);
    OMM.addMeanElementTheory(b, 4);
    OMM.addUserDefinedParameters(b, vec);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  };
  const gridOf = (centre, days, step) => {
    const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(source)).unpack();
    const b = t.EPHEMERIS_DATA_BLOCK[0];
    b.EPHEMERIS_DATA_LINES = [];
    b.START_TIME = "2026-06-01T00:00:00.000000";
    b.STOP_TIME = new Date(Date.parse("2026-06-01T00:00:00Z") + days * 86400e3).toISOString().replace("Z", "000");
    b.STEP_SIZE = step;
    b.REFERENCE_FRAME = rfm("GCRF", "both");
    b.CENTER_NAME = centre;
    t.EPHEMERIS_DATA_BLOCK = [b];
    return packOem(t);
  };
  const cases = [
    { label: "NRHO-like (MOON)", centre: "MOON", regime: "CISLUNAR", wrong: "EARTH", days: 4, step: 900,
      set: { centre: "MOON", gm: 4902.79980693169, a: 37000, e: 0.9, i: 88, raan: 30, argp: 90, ma: 180, params: [["SDNAP_REGIME", "CISLUNAR"], ["SDNAP_AGOM", 0.01]] } },
    { label: "cislunar (EARTH)", centre: "EARTH", regime: "CISLUNAR", wrong: "MOON", days: 4, step: 900,
      set: { centre: "EARTH", gm: 398600.4418, a: 250000, e: 0.7, i: 28.5, raan: 40, argp: 10, ma: 20, params: [["SDNAP_REGIME", "CISLUNAR"], ["SDNAP_AGOM", 0.01]] } },
    { label: "cruise (SUN)", centre: "SUN", regime: "HELIO", wrong: "EARTH", days: 30, step: 21600,
      set: { centre: "SUN", gm: 1.32712440018e11, a: 2.244e8, e: 0.2, i: 23.4, raan: 5, argp: 60, ma: 40, params: [["SDNAP_REGIME", "HELIO"], ["SDNAP_BETA", 1e-5], ["SDNAP_RTN_T", 5e-8]] } },
  ];
  for (const c of cases) {
    const omm = segmentSet(c.set), grid = gridOf(c.centre, c.days, c.step);
    const prop = async (o, g = grid) => command.invoke({ methodId: "propagate", inputs: [{ portId: "omm", typeRef: ommType, payload: o }, { portId: "grid", typeRef: oemType, payload: g }] });
    const wrong = await prop(omm, gridOf(c.wrong, 1, 3600));
    check(wrong.statusCode !== 0 && wrong.errorCode === "grid-center-mismatch", `${c.label} on a ${c.wrong} grid: ${wrong.errorCode}`);
    const p1 = await prop(omm);
    if (p1.statusCode !== 0) { failures.push(`${c.label} propagate: ${p1.errorCode} ${p1.errorMessage}`); continue; }
    const traj = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p1.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const f = await command.invoke({ methodId: "fit", inputs: [SDNAP, { portId: "ephemeris", typeRef: oemType, payload: p1.outputs[0].payload }] });
    if (f.statusCode !== 0) { failures.push(`${c.label} fit SDNAP: ${f.errorCode} ${f.errorMessage}`); continue; }
    const fitted = f.outputs.find((o) => o.portId === "elements").payload;
    const e = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fitted));
    const u = {};
    for (let k = 0; k < e.userDefinedParametersLength(); ++k) u[e.USER_DEFINED_PARAMETERS(k).PARAM_NAME()] = e.USER_DEFINED_PARAMETERS(k).PARAM_VALUE();
    const p2 = await prop(fitted);
    if (p2.statusCode !== 0) { failures.push(`${c.label} propagate of the fitted set: ${p2.errorCode} ${p2.errorMessage}`); continue; }
    const back = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p2.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const byEpoch = new Map(back.EPHEMERIS_DATA_LINES.map((L) => [L.EPOCH, L]));
    let max = 0, n = 0;
    for (const L of traj.EPHEMERIS_DATA_LINES) { const q = byEpoch.get(L.EPOCH); if (!q) continue; ++n; max = Math.max(max, Math.hypot(q.X - L.X, q.Y - L.Y, q.Z - L.Z) * 1e3); }
    console.log(`${c.label}: ${traj.EPHEMERIS_DATA_LINES.length} states; set ${e.CENTER_NAME()} ${u.SDNAP_REGIME}, a ${e.SEMI_MAJOR_AXIS().toFixed(1)} km, GM ${e.GM()}; ${e.COMMENT().replace(/^.*?\); /, "")}; round trip max |dr| ${max.toFixed(3)} m over ${n}`);
    check(traj.CENTER_NAME === c.centre && back.CENTER_NAME === c.centre && e.CENTER_NAME() === c.centre && traj.REFERENCE_FRAME.NAME === "ICRF", `${c.label}: centre or axes`);
    check(e.MEAN_ELEMENT_THEORY() === 4 && u.THEORY === undefined && u.SDNAP_REGIME === c.regime && e.GM() > 0 && e.SEMI_MAJOR_AXIS() !== 0, `${c.label}: regime ${u.SDNAP_REGIME}`);
    check(n >= traj.EPHEMERIS_DATA_LINES.length / 4 && max <= 20.0, `${c.label} round trip: ${max} m over ${n}`);
    if (c.centre === "EARTH") {
      const r = await command.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: ommType, payload: fitted }] });
      check(r.statusCode !== 0 && r.errorCode === "unsupported-theory", `a segment set in the batch: ${r.errorCode}`);
    }
  }
}

console.log(failures.length === 0 ? "\nfit E2E: PASS" : `\nfit E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
