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
// - The SDN-AP theory was removed: an $OMM naming its number (MEAN_ELEMENT_THEORY 4) is refused by propagate and
//   ingest_omm (invalid-omm), a fit with THEORY 3 by configuration-refused, and an ElementRow of theory 16 is
//   held refused.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
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
// every configured method takes a $PCF
const command = withConfiguration(await createStandaloneHarness("browser", wasmPath, { surface: "command" }));
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
    const r = await command.invoke({ methodId: method, inputs: [{ portId: "ephemeris", typeRef: oemType, payload }] });
    return r.statusCode === 0 ? "accepted" : r.errorCode;
  };
  const conflict = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oemInFrame(m, source, "GCRF", null, undefined, "enum"))).unpack();
  conflict.EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME.NAME = "TEME";
  const elsewhere = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(oemInFrame(m, source, "GCRF", null, undefined, "both"))).unpack();
  for (const method of ["fit"]) {
    // fit (SGP4XP) is geocentric
    elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME = "MOON";
    const center = await code(method, packOem(elsewhere));
    console.log(`${method}: CENTER_NAME ${elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME} -> ${center}`);
    check(center === "unsupported-center", `${method} with a ${elsewhere.EPHEMERIS_DATA_BLOCK[0].CENTER_NAME}-centered block: ${center}`);
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
    const epoch = b.createString("2026-10-20T12:00:00.000000"), center = b.createString("MOON");
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addCenterName(b, center);
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
    check(r.statusCode !== 0 && r.errorCode === "unsupported-center", `${method} with a Moon-centered $OMM: ${r.errorCode}`);
  }
}

// --- the SDN-AP theory is gone: a set that names it, and a fit that asks for it, are refused by name
{
  const sdnapOmm = (() => {
    const b = new flatbuffers.Builder(256);
    const epoch = b.createString("2026-10-20T12:00:00.000000");
    OMM.startOMM(b);
    OMM.addEpoch(b, epoch);
    OMM.addMeanMotion(b, 15.06);
    OMM.addEccentricity(b, 0.0002);
    OMM.addInclination(b, 53);
    OMM.addNoradCatId(b, 90010);
    OMM.addMeanElementTheory(b, 4);  // the number of the removed theory
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  })();
  for (const method of ["propagate", "ingest_omm"]) {
    const r = await command.invoke({ methodId: method, inputs: [{ portId: "omm", typeRef: ommType, payload: sdnapOmm }] });
    console.log(`${method}: MEAN_ELEMENT_THEORY 4 -> ${r.statusCode === 0 ? "accepted" : r.errorCode}`);
    check(r.statusCode !== 0 && r.errorCode === "invalid-omm", `${method} with an $OMM of the removed theory: ${r.errorCode}`);
  }
  const fitted = await command.invoke({ methodId: "fit", inputs: [configuration({ theory: 3 }), { portId: "ephemeris", typeRef: oemType, payload: source }] });
  console.log(`fit: THEORY 3 -> ${fitted.statusCode === 0 ? "accepted" : fitted.errorCode}`);
  check(fitted.statusCode !== 0 && fitted.errorCode === "configuration-refused", `fit with the removed THEORY 3: ${fitted.errorCode}`);
  const rows = new Uint8Array(112);
  new DataView(rows.buffer).setInt32(108, 16, true);  // theory 16 in an ElementRow
  const p = m.x.sdnap_alloc(112);
  new Uint8Array(m.harness.memory.buffer, p, 112).set(rows);
  const held = m.x.sdnap_init_elements(p, 1), err = m.x.sdnap_init_error(0);
  m.x.sdnap_free(p);
  console.log(`sdnap_init_elements: a theory 16 row -> held ${held}, init error ${err}`);
  check(held === 1 && err !== 0, `a theory 16 row: held ${held}, init error ${err}`);
}

console.log(failures.length === 0 ? "\nfit E2E: PASS" : `\nfit E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
