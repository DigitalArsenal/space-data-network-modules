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
// - The prior forms ($PCF 1.0.6 FIT.DRAG_PRIOR_FORM, SRP_PRIOR_FORM; task modules-sgp4xp-fit-lognormal-drag-20261026), on
//   a real window from before plan XM's period: NASA's ISS file of 2025-01-23, its first 24 h (the local archive,
//   SDNAP_ISS_ARCHIVE; operator data, never committed; SHA-256 pinned). The default GAUSSIAN_SIGNED prior ends at
//   BTERM <= 0 there; LOG_NORMAL N(ln 0.01, ln 10) estimates ln BTERM, ends > 0 and fits better. The $OBD states each
//   prior as used; the covariance is the ln-space posterior carried to B by the Jacobian (sqrt(C_BB) = B x the posterior
//   sigma of ln B within 1e-12), and an unobserved AGOM's is marked prior-limited (posterior sigma of the log > 0.5).
//   The two-line lattice never steps a term its prior pins within one unit of its last digit (AGOM 0.01 under
//   0.01 +- 1e-9 and +- 1e-6), and the default prior keeps main's sets byte for byte. LOG_NORMAL without its prior, its
//   sigma or a positive median, and a form outside the enumeration, are refused by name; the raw export sdnap_fit takes
//   drag_log.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { odMethod } from "spacedatastandards.org/lib/js/OBD/odMethod.js";
import { PCFGaussianPriorT } from "spacedatastandards.org/lib/js/PCF/PCFGaussianPrior.js";
import { FRAME_PROBE, jdOf, oemInFrame, packOem, rfm, rotate } from "./lib/frames.mjs";
import { THEORY, elementRows, openModule, wasmPath } from "./lib/module.mjs";
import { configuration, pcfPriorForm, prior, withConfiguration } from "./lib/pcf.mjs";

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

// --- the prior forms ($PCF 1.0.6 FIT.DRAG_PRIOR_FORM and SRP_PRIOR_FORM; task modules-sgp4xp-fit-lognormal-drag-20261026)
{
  // the default prior keeps main's sets byte for byte (the $OMM of main 348636447's build; the $OBD now states the prior)
  const shaOf = (r) => createHash("sha256").update(Buffer.from(r.outputs.find((o) => o.portId === "elements").payload)).digest("hex");
  const MAIN = { teme: "81a81b54c2a49c235830d1beb4ce1388baeca5a507e43119c813812fc5ae89c9", iss: "cc06072aed2f050172f476d81952898bdf0d365df717a1330adf1d03eb552d30" };
  const temeDefault = shaOf(await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: oemInFrame(m, source, "TEME", null) }] }));
  console.log(`default prior: the TEME set's $OMM ${temeDefault.slice(0, 12)} (main ${MAIN.teme.slice(0, 12)})`);
  check(temeDefault === MAIN.teme, `the default fit of the TEME set differs from main: ${temeDefault}`);
  // a real window from before plan XM's period (2026-01-01 to 07-31): NASA's ISS trajectory file of 2025-01-23, its first
  // 24 h at 240 s (EME2000), read from the local archive (operator data, never committed) and pinned by its SHA-256
  const file = path.join(process.env.SDNAP_ISS_ARCHIVE ?? "/opt/data/sdn-archive/hac/nasa-iss-oem-archive", "2025-01-23", "ISS.OEM_J2K_EPH.txt");
  if (!fs.existsSync(file)) {
    console.log(`ISS window: NOT MEASURED (no ${file}; SDNAP_ISS_ARCHIVE names the local NASA ISS archive)`);
  } else {
    const text = fs.readFileSync(file);
    const digest = createHash("sha256").update(text).digest("hex");
    check(digest === "7a4e22ef7dcf7d3774505f415d1090de3f822aeab7008733ff499ebcebb23105", `ISS window: ${file} is ${digest}`);
    const all = [];
    let inData = false;
    for (const raw of text.toString("utf8").split(/\r?\n/)) {
      const l = raw.trim();
      if (l === "META_STOP") { inData = true; continue; }
      if (!inData || !l || l.startsWith("COMMENT")) continue;
      const w = l.split(/\s+/);
      if (w.length >= 7) all.push({ EPOCH: w[0], X: +w[1], Y: +w[2], Z: +w[3], X_DOT: +w[4], Y_DOT: +w[5], Z_DOT: +w[6] });
    }
    const t0 = Date.parse(`${all[0].EPOCH}Z`);
    const day = all.filter((l) => Date.parse(`${l.EPOCH}Z`) <= t0 + 86400000);
    const issOem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [Object.assign(new ephemerisDataBlockT(), {
      OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 25544, OBJECT_ID: "1998-067A", OBJECT_NAME: "ISS" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("EME2000", "both"),
      TIME_SYSTEM: timingStandard.UTC, START_TIME: day[0].EPOCH, STOP_TIME: day.at(-1).EPOCH, USEABLE_START_TIME: day[0].EPOCH, USEABLE_STOP_TIME: day.at(-1).EPOCH,
      EPHEMERIS_DATA_LINES: day.map((l) => Object.assign(new ephemerisDataLineT(), l)) })] }));
    const issFit = async (label, fitTable) => {
      const r = await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: issOem }, configuration(fitTable ? { fit: fitTable } : {})] });
      if (r.statusCode !== 0) { failures.push(`ISS ${label}: ${r.errorCode} ${r.errorMessage}`); return null; }
      const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "elements").payload)).unpack();
      const obd = OBD.getRootAsOBD(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "determination").payload)).unpack();
      const user = Object.fromEntries((omm.USER_DEFINED_PARAMETERS ?? []).map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
      console.log(`ISS 2025-01-22/23, ${day.length} states, ${label}: BTERM ${omm.BSTAR}, AGOM ${omm.MEAN_MOTION_DDOT}, fit RMS ${(obd.WRMS * 1e3).toFixed(1)} m\n  ${obd.BALLISTIC_COEFF_MODEL}\n  ${obd.AGOM_MODEL}`);
      return { omm, obd, user };
    };
    const posteriorOf = (model) => Number((/posterior sigma of the log ([0-9.eE+-]+)/.exec(model) ?? [])[1]);
    const diagonalOf = (row) => Number(String(row ?? "").trim().split(/\s+/).at(-1));
    const LN = { DRAG_PRIOR: prior(0.01, Math.LN10), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL };
    const gauss = await issFit("GAUSSIAN_SIGNED (the default prior 0 +- 0.05)", null);
    const ln = await issFit("LOG_NORMAL drag N(ln 0.01, ln 10)", LN);
    if (gauss && ln) {
      // the trap the default falls in on this window, and the log that cannot fall in it
      check(gauss.omm.BSTAR <= 0, `ISS: the default prior ends at BTERM ${gauss.omm.BSTAR} > 0 (the window no longer shows the trap)`);
      check(ln.omm.BSTAR > 0 && ln.obd.WRMS < gauss.obd.WRMS, `ISS LOG_NORMAL: BTERM ${ln.omm.BSTAR}, RMS ${ln.obd.WRMS} against ${gauss.obd.WRMS}`);
      check(/^BTERM \(SGP4XP\), log-normal prior, estimated as its natural log \(never <= 0\): median 0\.01 m\^2\/kg, sigma of the log 2\.30258509; posterior sigma of the log /.test(ln.obd.BALLISTIC_COEFF_MODEL),
        `ISS LOG_NORMAL $OBD BALLISTIC_COEFF_MODEL: ${ln.obd.BALLISTIC_COEFF_MODEL}`);
      check(gauss.obd.BALLISTIC_COEFF_MODEL === "BTERM (SGP4XP), Gaussian prior 0 +- 0.05 m^2/kg", `ISS default $OBD BALLISTIC_COEFF_MODEL: ${gauss.obd.BALLISTIC_COEFF_MODEL}`);
      // SPEC 12: the ln-space posterior carried to B by the Jacobian, sigma_B = B sigma_lnB; the drag is observed here
      const sB = posteriorOf(ln.obd.BALLISTIC_COEFF_MODEL), cBB = diagonalOf(ln.user.SDNAP_COV_DRAG);
      const identity = Math.abs(Math.sqrt(cBB) / (ln.omm.BSTAR * sB) - 1);
      console.log(`ISS LOG_NORMAL covariance: sqrt(C_BB) ${Math.sqrt(cBB).toExponential(6)} m^2/kg = B x posterior sigma of ln B (${sB.toExponential(6)}) within ${identity.toExponential(2)}`);
      check(sB > 0 && sB <= 0.5 && identity <= 1e-12 && !/prior-limited/.test(ln.obd.BALLISTIC_COEFF_MODEL), `ISS LOG_NORMAL covariance: sigma_lnB ${sB}, identity ${identity}`);
    }
    // AGOM over one day of the ISS is effectively unobserved: its log-normal posterior stays near the prior's sigma, and the
    // covariance is marked prior-limited
    const both = await issFit("LOG_NORMAL drag and SRP N(ln 0.01, ln 10)", { ...LN, SRP_PRIOR: prior(0.01, Math.LN10), SRP_PRIOR_FORM: pcfPriorForm.LOG_NORMAL });
    if (both) {
      const sA = posteriorOf(both.obd.AGOM_MODEL), cAA = diagonalOf(both.user.SDNAP_COV_AGOM);
      const identity = Math.abs(Math.sqrt(cAA) / (both.omm.MEAN_MOTION_DDOT * sA) - 1);
      console.log(`ISS LOG_NORMAL AGOM: posterior sigma of ln AGOM ${sA.toFixed(4)}; sqrt(C_AA) = AGOM x it within ${identity.toExponential(2)}`);
      check(both.omm.MEAN_MOTION_DDOT > 0 && both.omm.BSTAR > 0 && sA > 0.5 && /; covariance prior-limited \(posterior sigma of the log > 0\.5\)$/.test(both.obd.AGOM_MODEL) && identity <= 1e-12,
        `ISS LOG_NORMAL AGOM: ${both.omm.MEAN_MOTION_DDOT}, sigma_lnA ${sA}, identity ${identity}, ${both.obd.AGOM_MODEL}`);
    }
    // the two-line lattice never steps a term its prior pins within one unit of its last digit (AGOM 0.01: a unit of 1e-6):
    // AGOM under SRP_PRIOR 0.01 +- 1e-9 or +- 1e-6 is the representable 0.01 exactly; just above the unit the search steps it
    for (const [sigma, held] of [[1e-9, true], [1e-6, true], [1.0000001e-6, false]]) {
      const r = await issFit(`LOG_NORMAL drag, SRP_PRIOR 0.01 +- ${sigma}`, { ...LN, SRP_PRIOR: prior(0.01, sigma) });
      if (r) check((r.omm.MEAN_MOTION_DDOT === 0.01) === held, `ISS SRP_PRIOR 0.01 +- ${sigma}: AGOM ${r.omm.MEAN_MOTION_DDOT}, expected ${held ? "0.01 exactly" : "a stepped value"}`);
    }
    const issDefault = shaOf(await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: issOem }] }));
    console.log(`default prior: the ISS window's $OMM ${issDefault.slice(0, 12)} (main ${MAIN.iss.slice(0, 12)})`);
    check(issDefault === MAIN.iss, `the default fit of the ISS window differs from main: ${issDefault}`);
  }
  // refused by name: a LOG_NORMAL prior needs its prior, its sigma and a median > 0; a form outside the enumeration
  const refusal = async (label, fitTable, field) => {
    const r = await command.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: oemType, payload: source }, configuration({ fit: fitTable })] });
    const ok = r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith(`${field}: `);
    console.log(`fit, ${label}: ${r.statusCode === 0 ? "accepted" : `${r.errorCode} (${String(r.errorMessage).split(":")[0]})`}`);
    check(ok, `fit ${label}: expected configuration-refused ${field}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
  };
  await refusal("DRAG_PRIOR_FORM LOG_NORMAL without DRAG_PRIOR", { DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL }, "FIT.DRAG_PRIOR");
  await refusal("LOG_NORMAL with a prior without its sigma", { DRAG_PRIOR: new PCFGaussianPriorT(), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL }, "FIT.DRAG_PRIOR.SIGMA");
  await refusal("LOG_NORMAL with a median <= 0", { DRAG_PRIOR: prior(-0.01, 1), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL }, "FIT.DRAG_PRIOR.MEAN");
  await refusal("SRP_PRIOR_FORM LOG_NORMAL without SRP_PRIOR", { SRP_PRIOR_FORM: pcfPriorForm.LOG_NORMAL }, "FIT.SRP_PRIOR");
  await refusal("DRAG_PRIOR_FORM 7", { DRAG_PRIOR_FORM: 7 }, "FIT.DRAG_PRIOR_FORM");
  // the raw export sdnap_fit (fit::Options, 56 bytes) with drag_log: from BTERM 0.003 to the source set's 0.01; a start <= 0
  // is refused (status -3)
  {
    const lines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(source)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
    const ep = jdOf("2026-10-20T12:00:00.000000");
    const minutes = new Float64Array(lines.map((l) => { const t = jdOf(l.EPOCH); return ((t.whole - ep.whole) + (t.frac - ep.frac)) * 1440; }));
    const positions = new Float64Array(lines.flatMap((l) => [l.X, l.Y, l.Z]));
    const rawFit = (bterm) => {
      const row = elementRows([{ epochWhole: ep.whole, epochFrac: ep.frac, meanMotion: 15.06, ecc: 0.0002, inc: 53, raan: 120, argp: 90, ma: 30, bterm, agom: 0.01, norad: 90001, theory: THEORY.SGP4XP }]);
      const options = new DataView(new ArrayBuffer(56));
      options.setInt32(0, 1, true);                      // fit_drag
      options.setFloat64(8, Math.log(0.01), true);       // the prior of ln B: the log of the median 0.01 m^2/kg
      options.setFloat64(16, Math.LN10, true);           // and its sigma, ln 10
      options.setInt32(48, 1, true);                     // drag_log
      const ptr = (bytes) => { const p = m.x.sdnap_alloc(bytes.byteLength); new Uint8Array(m.harness.memory.buffer, p, bytes.byteLength).set(new Uint8Array(bytes.buffer ?? bytes)); return p; };
      const pr = ptr(row), pm = ptr(minutes), pp = ptr(positions), po = ptr(options), ps = m.x.sdnap_alloc(32);
      const rc = m.x.sdnap_fit(pr, pm, pp, lines.length, po, ps);
      const stats = Array.from(new Float64Array(m.harness.memory.buffer, ps, 4));
      const fitted = new Float64Array(m.harness.memory.buffer, pr, 14)[11];
      for (const p of [pr, pm, pp, po, ps]) m.x.sdnap_free(p);
      return { rc, stats, fitted };
    };
    const good = rawFit(0.003), bad = rawFit(0);
    console.log(`sdnap_fit with drag_log: from BTERM 0.003 -> ${good.fitted} (rc ${good.rc}, status ${good.stats[0]}, RMS ${(good.stats[2] * 1e3).toFixed(3)} m); from 0 -> rc ${bad.rc}, status ${bad.stats[0]}`);
    check(good.rc === 0 && good.stats[0] >= 0 && good.fitted > 0 && Math.abs(good.fitted / 0.01 - 1) <= 1e-3, `sdnap_fit drag_log: rc ${good.rc}, status ${good.stats[0]}, BTERM ${good.fitted}`);
    check(bad.rc !== 0 && bad.stats[0] === -3, `sdnap_fit drag_log from BTERM 0: rc ${bad.rc}, status ${bad.stats[0]}`);
  }
}

console.log(failures.length === 0 ? "\nfit E2E: PASS" : `\nfit E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
