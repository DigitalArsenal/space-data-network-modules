#!/usr/bin/env node
// E2E (SPEC 16.14): AP's solid Earth tide, through the built module.
// - Model truth: FFM (EGM2008 70 x 70, Sun and Moon from DE440) from an AP-consistent state at 2026-09-01, flown 8 days
//   without the solid tide and with FFM's (FORCES.SOLID_TIDES IERS_2010: IERS 2010 section 6.2, steps 1 and 2), on two
//   near-circular low orbits where the tide is the largest theory item at day 5 (1,490 km at 108 deg, 1,340 km at 66
//   deg). AP is fitted through `fit` over the first 72 h (the headline's tesseral 31, zonal 20) and flown hourly to day 5
//   after the arc. Asserted: with FORCES.SOLID_TIDES IERS_2010 on the tide truth the record states
//   PERTURBATIONS.SOLID_TIDES_MODEL "IERS 2010", has no "not modeled" COMMENT line, and its day-5 error is within SLACK_M
//   of AP's error without the term on the truth without the tide; without the switch the record's OD COMMENT says "solid
//   Earth tide: not modeled (FORCES.SOLID_TIDES NONE)" and its day-5 error on the tide truth is at least TERM_M away
//   from that level.
// - FORCES.SOLID_TIDES NONE written on the wire is the field unset: the same flight, the same record bytes but the
//   $PCF's CID. (A comparison with an older build would hold AP's theory fixed forever; the landing's own evidence
//   compares builds: a set without the switch flies bit for bit as before.)
// - The long-period regime (an inclined geosynchronous orbit, i 55 deg, where a covariance's moved sets step in pairs
//   and fly the tide as the nominal does): the tide record's stated position sigma at day 5 is within COV_RATIO of the
//   same record's flown without the tide. The tide does not make the stated covariance smaller.
// - Refusals by name: fit with FORCES.SOLID_TIDES IERS_2010 without gravity terms, or with another value
//   (configuration-refused, the field named); a flight of a record whose SOLID_TIDES_MODEL is other text
//   (solid-tides-unsupported), and of an SGP4XP set or an AP set without gravity caps that states it
//   (elements-other-theory).
// JS moves bytes and takes RMS values; every state, fit and refusal is the module's or FFM's.
//   node test/solid-tides.e2e.mjs
import assert from "node:assert/strict";
import { requireTruth, ffmPath, checkTruth } from "./lib/ffm-truth.mjs";
requireTruth("ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934"); // the model truth: FFM 2.3.0 (modules 48a00fd6)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as fb from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as Block } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as Line } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfSolidTideModel } from "spacedatastandards.org/lib/js/PCF/pcfSolidTideModel.js";
import { PCFForceModel } from "spacedatastandards.org/lib/js/PCF/PCFForceModel.js";
import { openModule, wasmPath, THEORY } from "./lib/module.mjs";
import { packOem, rfm, jdOf, rotate, FRAME_PROBE } from "./lib/frames.mjs";
import { configuration, prior, pcfPriorForm } from "./lib/pcf.mjs";
import { seedOcm, flight, ocmOf } from "./lib/ocm.mjs";
import { execution, nativeInput, encodePrw, makeTable, decodeResult, TYPE } from "../../ffm/tests/lib/prwCodec.mjs";
import { scratchRoot } from "./lib/scratch.mjs";

// Bounds, measured 2026-11-11 on this build (the printed rows): day 5 with the term on the tide truth 32.36 and 12.95 m
// against AP's own 32.73 and 13.04 m without the tide (bound SLACK_M); without the term 138.65 and 75.15 m, 105.9 and
// 62.1 m away from it (bound TERM_M); the long-period record's day-5 sigma with and without the tide 6,350.4982 and
// 6,350.4987 m (bound COV_RATIO).
const SLACK_M = 2, TERM_M = 30, COV_RATIO = 0.01;
const ORBITS = [
  { name: "1,490 km, i 108", altKm: 1490, e: 0.001, i: 108, raan: 15, argp: 90, ma: 0 },
  { name: "1,340 km, i 66", altKm: 1340, e: 0.001, i: 66, raan: 93, argp: 90, ma: 0 },
  { name: "inclined geosynchronous", altKm: 35786, e: 0.0002, i: 55, raan: 300, argp: 0, ma: 0, longPeriod: true },
];
const epoch = "2026-09-01T00:00:00.000", t0 = Date.parse(`${epoch}Z`), DAY = 86400000, RE = 6378.1363, KE = 0.074366859954178854;
// the fit arc every 10 min over the first 72 h, then hourly through day 8 (day 5 after the arc: 7 to 8 days)
const ARC = 433;
const times = [...Array(ARC)].map((_, k) => k / 144).concat([...Array(120)].map((_, k) => 3 + (k + 1) / 24));
const scratch = path.join(scratchRoot, "solid-tides");
fs.mkdirSync(scratch, { recursive: true });
const type = (n) => ({ schemaName: `${n}.fbs`, fileIdentifier: `$${n}`, rootTypeName: n });
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const kernel = fs.readFileSync(new URL("../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp", import.meta.url));
let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log(`FAIL ${what}`); } };

const m = await openModule();
const x = m.x, p = x.sdnap_alloc(256), a = (off, n) => new Float64Array(m.harness.memory.buffer, p + off, n), jd = jdOf(epoch);
const h = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const invoke = (methodId, inputs) => h.invoke({ methodId, inputs });
const ok = async (methodId, inputs) => { const r = await invoke(methodId, inputs); assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs; };

const GRAVITY = { HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20 };
const forces = (tides) => ({ EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, ...GRAVITY, ...(tides ? { SOLID_TIDES: pcfSolidTideModel.IERS_2010 } : {}) });
function oemOf(lines) {
  const b = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99003, OBJECT_NAME: "SYNTHETIC TIDE" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"),
    TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [b] }));
}
// BTERM and AGOM held at 0 (the truth has neither): the fit measures the theory alone
const FIT = { DRAG_PRIOR: prior(0, 1e-10), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED, SRP_PRIOR: prior(0, 1e-10), SRP_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED };
const fitWith = async (lines, f) => {
  const out = await ok("fit", [configuration({ theory: "AP", forces: f, fit: FIT }), { portId: "ephemeris", typeRef: type("OEM"), payload: oemOf(lines) }]);
  return new Uint8Array(out.find((v) => v.portId === "elements").payload);
};
const fit = (lines, tides) => fitWith(lines, forces(tides));
const fly = async (record, lines) => {
  const out = await ok("propagate", flight([record], { output: { EPOCHS: lines.map((L) => L.EPOCH), FRAME: pcfOutputFrame.GCRF } }));
  return new Uint8Array(out.find((v) => v.portId === "ephemeris").payload);
};
const blockOf = (bytes) => OEM.getRootAsOEM(new fb.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0];
const repack = (t) => { const b = new fb.Builder(8192); OCM.finishOCMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
const NOT_MODELED = "solid Earth tide: not modeled (FORCES.SOLID_TIDES NONE)";

async function truthOf(o, initial, tides) {
  const params = { epochJD: jd.whole, epochTimeScale: "UTC", targetJD: jd.whole + times.at(-1), targetTimeScale: "UTC", position: initial.slice(0, 3), velocity: initial.slice(3),
    frame: "GCRF", sampleEpochsJD: times.map((d) => ({ jd: jd.whole + d, scale: "UTC" })), ephemerisSource: "JPL_SPK",
    forces: { gravityMode: "EGM2008", maxDegree: 70, maxOrder: 70, thirdBody: true, srp: false, drag: false, massKg: 1000, areaM2: 10 },
    integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 } };
  checkTruth();
  const key = createHash("sha256").update(fs.readFileSync(ffmPath)).update(JSON.stringify({ params, tides })).update(kernel).digest("hex");
  const file = path.join(scratch, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const req = execution(params, true);
  if (tides) req.FORCES.SOLID_TIDES = pcfSolidTideModel.IERS_2010;
  const ffm = await createStandaloneHarness("browser", ffmPath, { surface: "command" });
  const r = await ffm.invoke({ methodId: "invoke", inputs: [
    { portId: "request", typeRef: TYPE, payload: encodePrw("EXECUTION_REQUEST", req) },
    { portId: "kernel", typeRef: TYPE, payload: nativeInput(kernel) },
    { portId: "earth_orientation", typeRef: TYPE, payload: encodePrw("EARTH_ORIENTATION", makeTable("PRWEarthOrientation", { ROWS: Array.from({ length: 12 }, (_, k) =>
      makeTable("EOP", { DATE: `${iso(t0 + (k - 1) * DAY)}Z`, MJD: jd.whole - 2400000.5 + k - 1, TAI_MINUS_UTC_SECONDS: 37 })) })) }] });
  assert.equal(r.statusCode, 0, `FFM: ${r.errorCode}: ${r.errorMessage}`);
  const samples = decodeResult(r).samples;
  assert.equal(samples.length, times.length);
  await ffm.close?.();
  const lines = samples.map((s, k) => ({ EPOCH: iso(t0 + times[k] * DAY), r: s.position, v: s.velocity }));
  fs.writeFileSync(file, JSON.stringify(lines));
  return lines;
}
const linesOf = (truth) => truth.map((s) => Object.assign(new Line(), { EPOCH: s.EPOCH, X: s.r[0], Y: s.r[1], Z: s.r[2], X_DOT: s.v[0], Y_DOT: s.v[1], Z_DOT: s.v[2] }));
// the RMS of the 3D error (m) of a record against a truth over day `d` after the arc (24 hourly states)
const dayError = async (record, truth, d) => {
  const day = linesOf(truth).slice(ARC + (d - 1) * 24, ARC + d * 24), got = blockOf(await fly(record, day)).EPHEMERIS_DATA_LINES;
  return 1000 * Math.sqrt(day.reduce((s, L, k) => s + (got[k].X - L.X) ** 2 + (got[k].Y - L.Y) ** 2 + (got[k].Z - L.Z) ** 2, 0) / day.length);
};
// the record's stated 1-sigma position (m, the square root of the covariance's trace) at the arc's end plus `d` days
const statedSigma = async (record, truth, d) => {
  const L = linesOf(truth)[ARC + d * 24 - 1], c = blockOf(await fly(record, [L])).COVARIANCE_MATRIX_LINES?.[0];
  return c ? 1000 * Math.sqrt(c.CX_X + c.CY_Y + c.CZ_Z) : NaN;
};

let firstTideRecord = null, firstLines = null;
for (const o of ORBITS) {
  const n = KE * Math.pow(RE / (RE + o.altKm), 1.5) * 1440 / (2 * Math.PI);
  m.init([{ epochWhole: jd.whole, epochFrac: jd.frac, meanMotion: n, ecc: o.e, inc: o.i, raan: o.raan, argp: o.argp, ma: o.ma, norad: 99003, theory: THEORY.SGP4XP }]);
  assert.equal(x.sdnap_mean_elements_at(0, 0, p), 0);
  a(0, 6).set([a(0, 1)[0], o.e, o.i, o.raan, o.argp, o.argp]);
  assert.equal(x.sdnap_state_of_elements(jd.whole, jd.frac, p, 0, p + 48), 0);
  const initial = rotate(m, jd.whole, jd.frac, Array.from(a(48, 6)), FRAME_PROBE.TEME_TO_GCRF);
  assert.equal(initial.status, 0);
  const plain = await truthOf(o, initial.out, false), tidal = await truthOf(o, initial.out, true);
  const arcOf = (truth) => linesOf(truth).slice(0, ARC);
  const withTerm = await fit(arcOf(tidal), true), without = await fit(arcOf(tidal), false);
  const tw = ocmOf(withTerm), tn = ocmOf(without);
  check(tw.PERTURBATIONS.SOLID_TIDES_MODEL === "IERS 2010" && !tw.ORBIT_DETERMINATION.COMMENT.includes(NOT_MODELED),
    `${o.name}: with FORCES.SOLID_TIDES the record states SOLID_TIDES_MODEL IERS 2010 (${tw.PERTURBATIONS.SOLID_TIDES_MODEL}) and no "not modeled" line`);
  check(tn.PERTURBATIONS.SOLID_TIDES_MODEL === null && tn.ORBIT_DETERMINATION.COMMENT.includes(NOT_MODELED),
    `${o.name}: without it no SOLID_TIDES_MODEL (${tn.PERTURBATIONS.SOLID_TIDES_MODEL}) and the OD COMMENT says "${NOT_MODELED}"`);
  if (o.longPeriod) {
    // the moved sets of the long-period regime fly the tide: the stated sigma barely moves with it
    const stripped = ocmOf(withTerm);
    stripped.PERTURBATIONS.SOLID_TIDES_MODEL = null;
    const sw = await statedSigma(withTerm, tidal, 5), so = await statedSigma(repack(stripped), tidal, 5);
    console.log(JSON.stringify({ orbit: o.name, day5SigmaM: { withTide: sw, theSameRecordWithout: so } }));
    check(Number.isFinite(sw) && Number.isFinite(so) && Math.abs(sw / so - 1) <= COV_RATIO, `${o.name}: day-5 sigma ${sw} m with the tide against ${so} m without (bound ${COV_RATIO * 100} %)`);
    continue;
  }
  const level = await dayError(await fit(arcOf(plain), false), plain, 5);
  const day5With = await dayError(withTerm, tidal, 5), day5Without = await dayError(without, tidal, 5);
  console.log(JSON.stringify({ orbit: o.name, day5: { levelWithoutTideM: level, tideTruthWithTermM: day5With, tideTruthWithoutTermM: day5Without } }));
  check(Math.abs(day5With - level) <= SLACK_M, `${o.name}: day 5 ${day5With.toFixed(2)} m with the term against AP's ${level.toFixed(2)} m without the tide (slack ${SLACK_M} m)`);
  check(Math.abs(day5Without - level) >= TERM_M, `${o.name}: without the term ${day5Without.toFixed(2)} m, at least ${TERM_M} m from ${level.toFixed(2)} m`);
  if (!firstTideRecord) {
    firstTideRecord = withTerm;
    firstLines = arcOf(tidal);
    // FORCES.SOLID_TIDES NONE on the wire (the builder made to write it at its default) is the field unset
    const addSolidTides = PCFForceModel.addSolidTides;
    PCFForceModel.addSolidTides = (b, v) => { const was = b.force_defaults; b.forceDefaults(true); addSolidTides(b, v); b.forceDefaults(was); };
    const onWire = configuration({ theory: "AP", forces: { ...forces(false), SOLID_TIDES: pcfSolidTideModel.NONE }, fit: FIT }).payload;
    PCFForceModel.addSolidTides = addSolidTides;
    check(Buffer.compare(Buffer.from(onWire), Buffer.from(configuration({ theory: "AP", forces: forces(false), fit: FIT }).payload)) !== 0, "FORCES.SOLID_TIDES NONE is on the wire");
    const out = await ok("fit", [{ portId: "configuration", typeRef: type("PCF"), payload: onWire }, { portId: "ephemeris", typeRef: type("OEM"), payload: oemOf(firstLines) }]);
    const written = new Uint8Array(out.find((v) => v.portId === "elements").payload);
    const after = linesOf(tidal).slice(ARC, ARC + 48);
    const sameFlight = Buffer.compare(Buffer.from(await fly(written, after)), Buffer.from(await fly(without, after))) === 0;
    const strip = (bytes) => { const t = ocmOf(bytes); t.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID = null; return repack(t); };
    const sameRecord = Buffer.compare(Buffer.from(strip(written)), Buffer.from(strip(without))) === 0;
    console.log(JSON.stringify({ writtenNone: { flightsIdentical: sameFlight, recordsIdenticalButTheCid: sameRecord } }));
    check(sameFlight && sameRecord, `FORCES.SOLID_TIDES NONE written: flights identical ${sameFlight}, records identical but the CID ${sameRecord}`);
  }
}

// refusals by name: fit
for (const [label, f] of [["IERS_2010 without gravity terms", { EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, SOLID_TIDES: pcfSolidTideModel.IERS_2010 }],
  ["a value that is not a model", { ...forces(false), SOLID_TIDES: 2 }]]) {
  const r = await invoke("fit", [configuration({ theory: "UNSPECIFIED", forces: f }), { portId: "ephemeris", typeRef: type("OEM"), payload: oemOf(firstLines) }]);
  check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith("FORCES.SOLID_TIDES:"), `fit, ${label}: ${r.statusCode === 0 ? "fitted" : `${r.errorCode} ${r.errorMessage}`}`);
}
// refusals by name: flight
const refused = async (label, record, code) => {
  const r = await invoke("propagate", flight([record], { output: { EPOCHS: [iso(t0 + 4 * DAY)], FRAME: pcfOutputFrame.GCRF } }));
  check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? "a flight" : r.errorCode}`);
};
const other = ocmOf(firstTideRecord);
other.PERTURBATIONS.SOLID_TIDES_MODEL = "IERS 2003";
await refused("SOLID_TIDES_MODEL IERS 2003", repack(other), "solid-tides-unsupported");
const el = { epoch, n: 12.5, e: 0.001, i: 66, raan: 77, argp: 90, ma: 0, norad: 99003 };
const xp = ocmOf(seedOcm(el));
xp.PERTURBATIONS.SOLID_TIDES_MODEL = "IERS 2010";
await refused("the tide on an SGP4XP set", repack(xp), "elements-other-theory");
await refused("the tide on an AP set without gravity caps", seedOcm({ ...el, solidTides: true }), "elements-other-theory");

x.sdnap_free(p);
m.destroy();
await h.close?.();
if (failures) {
  console.log(`solid tides E2E: FAIL (${failures})`);
  process.exit(1);
}
console.log("solid tides E2E: PASS");
