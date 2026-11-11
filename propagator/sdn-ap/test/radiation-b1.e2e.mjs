#!/usr/bin/env node
// E2E (SPEC 16.B1): ECOM2's once-per-revolution terms B1 cos and B1 sin, through the built module.
// - Model truth: FFM (EGM96 20 x 20, Sun and Moon from DE440, a cannonball of AGOM 0.022, the solid tide) from an
//   AP-consistent state at 2026-10-01 (eclipse season), flown 10 days with the sphere alone and with the sphere plus
//   ECOM2 Y0 -1.5e-9, B1 cos 8e-9 and B1 sin 4e-9 m/s^2 (C020-like), on a geostationary orbit (i 0.05 deg) and an
//   inclined geosynchronous one (i 55 deg). AP is fitted over the first 72 h through `fit` under the table's forces
//   (tesseral 31, zonal 20, the solid tide) with $PCF FORCES.ECOM2 and without, and flown hourly for 7 days.
// - The theory: the record fitted to the B1 truth with FORCES.ECOM2 stating the truth's Y0, B1 cos and B1 sin flies the
//   B1 truth within THEORY_SLACK_M of the sphere record's error on the sphere truth at day 7; the sphere record, without
//   the terms, is at least TERM_SIZE times that far from the B1 truth.
// - The rule: on the B1 truth the record carries ECOM2_B1_COS and ECOM2_B1_SIN SOLVED_FOR (B1 sin within B1S_TOLERANCE
//   of the stated value; B1 cos is the AGOM direction near beta 0 and is reported, not bounded), its OD COMMENT says so,
//   and its day-7 error is at most 1 / B1_GAIN of the fit without FORCES.ECOM2. On the sphere truth B1 is held: no
//   ECOM2_B1 entry, the OD COMMENT Y0's alone.
// - Refusals by name: a flight of a record with ECOM2_B1_COS on an SGP4XP set (elements-other-theory), twice
//   (parameter-repeated:ECOM2_B1_COS), in other UNITS (parameter-invalid:ECOM2_B1_SIN), beside ECOM2_B3_COS
//   (parameter-not-modeled:ECOM2_B3_COS); a fit stating FORCES.ECOM2.B3_COS_M_S2 (configuration-refused, the field
//   named); a raw SGP4XP row with bstar or mean_motion_ddot not 0 is held refused by sdnap_init_elements.
// JS moves bytes and takes RMS values; every state, fit and refusal is the module's or FFM's.
//   node test/radiation-b1.e2e.mjs
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
import { OCMDynamicParameterT } from "spacedatastandards.org/lib/js/OCM/OCMDynamicParameter.js";
import { OrbitDeterminationT } from "spacedatastandards.org/lib/js/OCM/OrbitDetermination.js";
import { prwDynamicParameter as PD } from "spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as Block } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as Line } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfSolidTideModel } from "spacedatastandards.org/lib/js/PCF/pcfSolidTideModel.js";
import { PCFEcom2T } from "spacedatastandards.org/lib/js/PCF/PCFEcom2.js";
import { pcfRadiationPressureFamily } from "spacedatastandards.org/lib/js/PCF/pcfRadiationPressureFamily.js";
import { openModule, wasmPath, THEORY } from "./lib/module.mjs";
import { packOem, rfm, jdOf, rotate, FRAME_PROBE } from "./lib/frames.mjs";
import { configuration } from "./lib/pcf.mjs";
import { seedOcm, flight, ocmOf } from "./lib/ocm.mjs";
import { execution, nativeInput, encodePrw, makeTable, decodeResult, TYPE } from "../../ffm/tests/lib/prwCodec.mjs";
import { scratchRoot } from "./lib/scratch.mjs";

// Bounds, measured on this build (the printed rows; SPEC 16.B1): B1 sin within 0.022e-9 and 0.028e-9 of the truth's;
// with the terms stated 7.7 and 9.3 m against the sphere record's 9.3 and 4.7 m; the sphere record 46 and 280 times its
// level from the B1 truth; under the rule 20 and 82 times better than without FORCES.ECOM2.
const B1S_TOLERANCE = 0.1e-9, B1_GAIN = 5, THEORY_SLACK_M = 6, TERM_SIZE = 5;
const TERMS = { Y0_M_S2: -1.5e-9, B1_COS_M_S2: 8e-9, B1_SIN_M_S2: 4e-9 };
const AGOM = 0.022;
const epoch = "2026-10-01T00:00:00.000", t0 = Date.parse(`${epoch}Z`), DAY = 86400000, ARC = 145;
const jdn = t0 / DAY + 2440587.5, gmst = (((280.46061837 + 360.98564736629 * (jdn - 2451545.0)) % 360) + 360) % 360;
const ORBITS = [
  { name: "geostationary", n: 1.0027379, e: 0.0002, i: 0.05, raan: gmst, argp: 0, ma: 0 },
  { name: "inclined geosynchronous", n: 1.0027379, e: 0.003, i: 55, raan: (gmst + 120) % 360, argp: 270, ma: 0 },
];
const scratch = path.join(scratchRoot, "radiation-b1");
fs.mkdirSync(scratch, { recursive: true });
const type = (n) => ({ schemaName: `${n}.fbs`, fileIdentifier: `$${n}`, rootTypeName: n });
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const times = [...Array(ARC)].map((_, k) => k / 48).concat([...Array(168)].map((_, k) => 3 + (k + 1) / 24));
const kernel = fs.readFileSync(new URL("../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp", import.meta.url));
let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log(`FAIL ${what}`); } };

const m = await openModule();
const x = m.x, p = x.sdnap_alloc(256), a = (off, n) => new Float64Array(m.harness.memory.buffer, p + off, n), jd = jdOf(epoch);
const h = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const invoke = (methodId, inputs) => h.invoke({ methodId, inputs });
const ok = async (methodId, inputs) => { const r = await invoke(methodId, inputs); assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs; };

const forces = (ecom2) => ({ EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31,
  HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20, SOLID_TIDES: pcfSolidTideModel.IERS_2010, ...(ecom2 ? { ECOM2: Object.assign(new PCFEcom2T(), ecom2) } : {}) });
function oemOf(lines) {
  const b = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99003, OBJECT_NAME: "SYNTHETIC B1" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"),
    TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [b] }));
}
const fit = async (lines, ecom2) => {
  const out = await ok("fit", [configuration({ theory: "AP", forces: forces(ecom2) }), { portId: "ephemeris", typeRef: type("OEM"), payload: oemOf(lines) }]);
  return new Uint8Array(out.find((v) => v.portId === "elements").payload);
};
const fly = async (record, lines) => {
  const out = await ok("propagate", flight([record], { output: { EPOCHS: lines.map((L) => L.EPOCH), FRAME: pcfOutputFrame.GCRF } }));
  return OEM.getRootAsOEM(new fb.ByteBuffer(out.find((v) => v.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
const entry = (record, kind) => ocmOf(record).ORBIT_DETERMINATION?.OD_DYNAMIC_PARAMETERS?.find((q) => q.PARAMETER === kind) ?? null;
const repack = (t) => { const b = new fb.Builder(8192); OCM.finishOCMBuffer(b, t.pack(b)); return b.asUint8Array().slice(); };
const param = (kind, value, units = "m/s**2") => Object.assign(new OCMDynamicParameterT(), { NAME: PD[kind], VALUE: value, UNITS: units, SOLVED_FOR: false, PARAMETER: kind });

// FFM model truth: the cannonball of AGOM and, with `terms`, ECOM2's Y0, B1 cos and B1 sin; the solid tide
async function truthOf(initial, terms) {
  const params = { epochJD: jd.whole, epochTimeScale: "UTC", targetJD: jd.whole + times.at(-1), targetTimeScale: "UTC", position: initial.slice(0, 3), velocity: initial.slice(3),
    frame: "GCRF", sampleEpochsJD: times.map((d) => ({ jd: jd.whole + d, scale: "UTC" })), ephemerisSource: "JPL_SPK",
    forces: { gravityMode: "EGM96", maxDegree: 20, maxOrder: 20, thirdBody: true, srp: true, drag: false, massKg: 1000, areaM2: 1000, cr: AGOM },
    integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 } };
  checkTruth();
  const key = createHash("sha256").update(fs.readFileSync(ffmPath)).update(JSON.stringify({ params, terms, tides: true })).update(kernel).digest("hex");
  const file = path.join(scratch, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const req = execution(params, true);
  req.FORCES.SOLID_TIDES = pcfSolidTideModel.IERS_2010;
  if (terms) {
    req.FORCES.RADIATION_PRESSURE_MODEL = pcfRadiationPressureFamily.CANNONBALL;
    req.FORCES.ECOM2 = makeTable("PCFEcom2", terms);
  }
  const ffm = await createStandaloneHarness("browser", ffmPath, { surface: "command" });
  const r = await ffm.invoke({ methodId: "invoke", inputs: [
    { portId: "request", typeRef: TYPE, payload: encodePrw("EXECUTION_REQUEST", req) },
    { portId: "kernel", typeRef: TYPE, payload: nativeInput(kernel) },
    { portId: "earth_orientation", typeRef: TYPE, payload: encodePrw("EARTH_ORIENTATION", makeTable("PRWEarthOrientation", { ROWS: Array.from({ length: 14 }, (_, k) =>
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
// the day-7 RMS of the 3D error (m) of a record against a truth's last 24 h
const day7 = async (record, truth) => {
  const after = linesOf(truth).slice(ARC), flown = await fly(record, after), last = after.slice(-24), got = flown.slice(-24);
  return 1000 * Math.sqrt(last.reduce((s, L, k) => s + (got[k].X - L.X) ** 2 + (got[k].Y - L.Y) ** 2 + (got[k].Z - L.Z) ** 2, 0) / last.length);
};
const withTerms = (record) => { const t = ocmOf(record); const d = t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS.filter((q) => ![PD.ECOM2_Y0, PD.ECOM2_B1_COS, PD.ECOM2_B1_SIN].includes(q.PARAMETER));
  d.push(param(PD.ECOM2_Y0, TERMS.Y0_M_S2), param(PD.ECOM2_B1_COS, TERMS.B1_COS_M_S2), param(PD.ECOM2_B1_SIN, TERMS.B1_SIN_M_S2));
  t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS = d; return repack(t); };

let heldRecord = null;
for (const o of ORBITS) {
  m.init([{ epochWhole: jd.whole, epochFrac: jd.frac, meanMotion: o.n, ecc: o.e, inc: o.i, raan: o.raan, argp: o.argp, ma: o.ma, agom: AGOM, norad: 99003, theory: THEORY.SGP4XP }]);
  assert.equal(x.sdnap_mean_elements_at(0, 0, p), 0);
  a(0, 6).set([a(0, 1)[0], o.e, o.i, o.raan, o.argp, o.argp]);
  assert.equal(x.sdnap_state_of_elements(jd.whole, jd.frac, p, 0, p + 48), 0);
  const initial = rotate(m, jd.whole, jd.frac, Array.from(a(48, 6)), FRAME_PROBE.TEME_TO_GCRF);
  assert.equal(initial.status, 0);
  const sphere = await truthOf(initial.out, null), b1 = await truthOf(initial.out, TERMS);
  const arcOf = (truth) => linesOf(truth).slice(0, ARC);

  // the theory: the record fitted to the B1 truth with FORCES.ECOM2 stating the truth's terms (B1's start, prior mean
  // and held value; the fit's mean state then carries B1's once-per-revolution part at the epoch, about 2 B1 / n^2 in a,
  // which a sphere record with the terms written in after its fit does not) against the B1 truth; the sphere truth's
  // record, without the terms, against the B1 truth
  const onSphere = await fit(arcOf(sphere), {}), stated = await fit(arcOf(b1), { ...TERMS });
  const sphereLevel = await day7(onSphere, sphere), theory = await day7(stated, b1), noTerms = await day7(onSphere, b1);
  const sc = entry(stated, PD.ECOM2_B1_COS), ss = entry(stated, PD.ECOM2_B1_SIN);
  console.log(JSON.stringify({ orbit: o.name, theory: { sphereLevelM: sphereLevel, statedOnB1TruthM: theory, statedB1: [sc?.VALUE, ss?.VALUE, ss?.SOLVED_FOR], sphereRecordOnB1TruthM: noTerms } }));
  check(theory <= sphereLevel + THEORY_SLACK_M, `${o.name}: the record fitted with the truth's terms stated flies the B1 truth at ${theory.toFixed(2)} m, against the sphere record's ${sphereLevel.toFixed(2)} m on the sphere truth`);
  check(noTerms >= TERM_SIZE * sphereLevel, `${o.name}: without the terms ${noTerms.toFixed(2)} m, at least ${TERM_SIZE} x ${sphereLevel.toFixed(2)} m`);

  // the rule on the sphere truth: B1 held
  const comment = (rec) => ocmOf(rec).ORBIT_DETERMINATION.COMMENT.find((c) => /^radiation: ECOM2/.test(c)) ?? "";
  check(entry(onSphere, PD.ECOM2_B1_COS) === null && entry(onSphere, PD.ECOM2_B1_SIN) === null && /^radiation: ECOM2 Y0 solved/.test(comment(onSphere)),
    `${o.name} sphere truth: B1 held, no ECOM2_B1 entry (${comment(onSphere)})`);
  if (o === ORBITS[0]) heldRecord = onSphere;

  // the rule on the B1 truth: solved
  const record = await fit(arcOf(b1), {}), plain = await fit(arcOf(b1), null);
  const c = entry(record, PD.ECOM2_B1_COS), s = entry(record, PD.ECOM2_B1_SIN), y = entry(record, PD.ECOM2_Y0);
  const withB1 = await day7(record, b1), without = await day7(plain, b1);
  console.log(JSON.stringify({ orbit: o.name, b1Truth: { y0: y?.VALUE, b1c: c?.VALUE, b1s: s?.VALUE, solved: s?.SOLVED_FOR, day7WithM: withB1, day7WithoutEcom2M: without, comment: comment(record) } }));
  check(c !== null && s !== null && c.SOLVED_FOR === true && s.SOLVED_FOR === true && s.UNITS === "m/s**2", `${o.name}: ECOM2_B1_COS and ECOM2_B1_SIN solved (${JSON.stringify(s)})`);
  check(s !== null && Math.abs(s.VALUE - TERMS.B1_SIN_M_S2) <= B1S_TOLERANCE, `${o.name}: B1 sin ${s?.VALUE} within ${B1S_TOLERANCE} of ${TERMS.B1_SIN_M_S2}`);
  check(/^radiation: ECOM2 Y0, B1 cos and B1 sin solved/.test(comment(record)), `${o.name}: the OD COMMENT says B1 is solved (${comment(record)})`);
  check(withB1 <= without / B1_GAIN, `${o.name}: day 7 ${withB1.toFixed(2)} m with B1 against ${without.toFixed(2)} m without FORCES.ECOM2`);
}

// flight refusals by name
const refused = async (label, record, code) => {
  const r = await invoke("propagate", flight([record], { output: { EPOCHS: [iso(t0 + 4 * DAY)], FRAME: pcfOutputFrame.GCRF } }));
  check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? "a flight" : r.errorCode}`);
};
const edited = (bytes, edit) => { const t = ocmOf(bytes); edit(t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS); return repack(t); };
const held = withTerms(heldRecord);
await refused("ECOM2_B1_COS twice", edited(held, (d) => d.push(param(PD.ECOM2_B1_COS, 1e-9))), "parameter-repeated:ECOM2_B1_COS");
await refused("ECOM2_B1_SIN in km/s**2", edited(held, (d) => { d.find((q) => q.PARAMETER === PD.ECOM2_B1_SIN).UNITS = "km/s**2"; }), "parameter-invalid:ECOM2_B1_SIN");
await refused("ECOM2_B3_COS beside B1", edited(held, (d) => d.push(param(PD.ECOM2_B3_COS, 1e-9))), "parameter-not-modeled:ECOM2_B3_COS");
const o0 = ORBITS[0];
const xp = ocmOf(seedOcm({ epoch, n: o0.n, e: o0.e, i: o0.i, raan: o0.raan, argp: o0.argp, ma: o0.ma, agom: AGOM, norad: 99003 }));
xp.ORBIT_DETERMINATION = Object.assign(new OrbitDeterminationT(), { OD_DYNAMIC_PARAMETERS: [param(PD.ECOM2_B1_COS, 1e-9)] });
await refused("ECOM2_B1_COS on an SGP4XP set", repack(xp), "elements-other-theory");
// fit refusal by name
{
  const short = linesOf(await truthOf((() => { m.init([{ epochWhole: jd.whole, epochFrac: jd.frac, meanMotion: o0.n, ecc: o0.e, inc: o0.i, raan: o0.raan, argp: o0.argp, ma: o0.ma, agom: AGOM, norad: 99003, theory: THEORY.SGP4XP }]);
    x.sdnap_mean_elements_at(0, 0, p); a(0, 6).set([a(0, 1)[0], o0.e, o0.i, o0.raan, o0.argp, o0.argp]); x.sdnap_state_of_elements(jd.whole, jd.frac, p, 0, p + 48);
    return rotate(m, jd.whole, jd.frac, Array.from(a(48, 6)), FRAME_PROBE.TEME_TO_GCRF).out; })(), null)).slice(0, 49);
  const r = await invoke("fit", [configuration({ theory: "AP", forces: forces({ B3_COS_M_S2: 1e-9 }) }), { portId: "ephemeris", typeRef: type("OEM"), payload: oemOf(short) }]);
  check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith("FORCES.ECOM2.B3_COS_M_S2"), `FORCES.ECOM2.B3_COS_M_S2: ${r.statusCode === 0 ? "fitted" : `${r.errorCode} ${r.errorMessage}`}`);
}
// the raw-row boundary: an SGP4XP row with SGP4's B* or second derivative is held refused
{
  const row = { epochWhole: jd.whole, epochFrac: jd.frac, meanMotion: o0.n, ecc: o0.e, inc: o0.i, raan: o0.raan, argp: o0.argp, ma: o0.ma, agom: AGOM, norad: 99003, theory: THEORY.SGP4XP };
  m.init([row, { ...row, bstar: 1e-9 }, { ...row, nddot: 1e-9 }]);
  check(m.initError(0) === 0 && m.initError(1) !== 0 && m.initError(2) !== 0, `sdnap_init_elements: init errors ${m.initError(0)}, ${m.initError(1)}, ${m.initError(2)} (the second states bstar, the third mean_motion_ddot)`);
}
x.sdnap_free(p);
m.destroy();
await h.close?.();
if (failures) {
  console.log(`radiation B1 E2E: FAIL (${failures})`);
  process.exit(1);
}
console.log("radiation B1 E2E: PASS");
