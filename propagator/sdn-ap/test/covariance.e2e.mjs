#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-export-cov-20261103): the covariance side of fit's $OCM and the one $OMM export.
// - fit of the 0.4.0 XP fixture's inputs (test/lib/fixture-inputs.mjs) writes COVARIANCE_DATA 8 x 8 LTM CARTPV in the
//   record's TRAJ_REF_FRAME, COV_PARAMETER_KINDS [DRAG_AREA_OVER_MASS, SRP_AREA_OVER_MASS] with COV_PARAMETERS and
//   COV_UNITS, COV_PROPAGATION (six named floor doubles, the noise, the share and the rate) and COV_REALISM[0]
//   (SourceModel, the noise model, its regime, Uncalibrated).
// - sdnap_covariance_at of that $OCM at every time of the fixture grid reproduces the 0.4.0 numbers
//   (test/fixtures/xp-fit-0.4.0.cov) to the last bit: state and covariance, 42 doubles a time.
// - Each floor field equals, by name, the 0.4.0 SDNAP_COV_FLOOR_UVW of xp-fit-0.4.0.omm; the noise fields its
//   SDNAP_COV_NOISE and SDNAP_COV_NG_RATE; |NOISE_NON_GRAVITATIONAL_RAD_DAY2 - NON_GRAVITATIONAL_SHARE x
//   |NON_GRAVITATIONAL_RATE_PER_DAY| x n| <= 1e-12 relative (n in rad/day).
// - The AP fit (gravity caps 31 and 20, NRLMSISE-00 on the fixture rows, the DRAG regime) writes the 0.6.1 DRAG row of
//   SPEC 12.5 (s_e, s_i, s_l, c bit for bit; NOISE_NON_GRAVITATIONAL_RAD_DAY2 = c |rate| n); sdnap_covariance_at of the
//   stored AP record (ap-fit-0.6.4.ocm) at the fixture grid within AP_COV_FLIGHT of 0.6.4's numbers (ap-fit-0.6.4.cov),
//   and this build's own AP fit within AP_COV_FIT of the slow set's fit's numbers (ap-fit-slow.cov); its epoch covariance
//   and floors within AP_COV_FIT of that fit (ap-fit-slow.ocm) (the SGP4XP table and numbers are unchanged).
// - export_omm of the XP $OCM equals xp-fit-0.4.0.omm with USER_DEFINED_PARAMETERS, COMMENT and
//   USER_DEFINED_EPOCH_TIMESTAMP / MICROSECONDS removed and PROVENANCE carried, BTERM and AGOM in their own fields
//   (the 0.4.0 set's BSTAR and MEAN_MOTION_DDOT moved there): the two records packed by one builder are byte-equal;
//   assertNoUserDefined on it; export_omm of the AP $OCM is theory-not-exportable:AP; garbage is invalid-ocm; under an
//   optional $PCF THEORY SGP4 the XP set is configuration-refused (THEORY admits only its own sets).
// JS only moves bytes and compares numbers the module produced.
//   node test/covariance.e2e.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/PRW/prwDynamicParameter.js";
import { covarianceRule } from "spacedatastandards.org/lib/js/CVR/covarianceRule.js";
import { covarianceCalibration } from "spacedatastandards.org/lib/js/CVR/covarianceCalibration.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, MSIS_FORCES, XP_FORCES } from "./lib/pcf.mjs";
import { inputs, GRID } from "./lib/fixture-inputs.mjs";

/// SPEC 12.5's AP DRAG row (0.6.1).
const AP_DRAG = { s_e: 1.8579913326733934e-7, s_i: 1.12761105007012e-6, s_l: 7.647194501793458e-7, c: 0.112126311682426 };
/// The AP covariance, the flight of fixed elements and the fit apart. Until 2026-11-10 the SHA-256 of the own fit's
/// COVARIANCE_DATA, floors and sdnap_covariance_at (f65830a2..., recorded on 0.6.1, held through 0.6.4). 0.6.5 (24d7d75f,
/// the analytic/SIMD covariance Jacobian and its other speed changes, SPEC 16.8) moves sdnap_covariance_at of the stored
/// record (test/fixtures/ap-fit-0.6.4.ocm, 0.6.4's fit) by 2.904 mm and 7.2e-5 of a time's largest covariance entry; this
/// build's own fit stops 7.3 cm away (the fit inside its tolerance) and its covariance 1.4e-4 of the largest entry away,
/// its epoch covariance 5.6e-4 of the stored record's largest entry and its floors 1.45e-4 relative.
/// 0.6.18 (the per-set caches, SPEC 9) records the own fit's epoch covariance and floors from itself
/// (test/fixtures/ap-fit-0.6.18.ocm, its fit of the 0.4.0 inputs), the bounds kept. The epoch covariance comes from central
/// differences of the theory over steps of 1e-7 in the elements; against the stored 0.6.4 record it moved 2.29e-3 of the
/// largest entry. Which value is right, by a fresh-bake reference of 0.6.18's sources (every tesseral, resonance and m-daily
/// bake taken at the state on every call), the epoch covariance as the largest difference over the largest entry:
///   0.6.17 against the reference 1.74e-3; 0.6.18 against the reference 4.8e-5; 0.6.17 against 0.6.18 1.74e-3.
/// The fit lane's measurement (stack #456) on the same fixture: 0.6.15 against 0.6.18 at today's steps 1.74e-3, both at
/// steps ten times larger 1.66e-4; each against itself at the larger steps, 0.6.15 1.57e-3 and 0.6.18 3.3e-6. The
/// step-sensitive partials are the older builds': their cells put non-smooth changes into the differences.
/// 0.6.NN (the slow set, SPEC 16.18) moves the own fit, which now carries the slow tesseral terms at 550 km: 17.8 m from the
/// stored record's covariance flight, its covariance 6.2e-2 of the largest entry, its epoch covariance 5.2e-2 and floors 0.25
/// relative from 0.6.18's. Against the fixture's own truth (propagator/ffm's 550 km trajectory) the fit's error 48 to 72 h past
/// the arc goes from 114 m (0.6.20) to 43 m. The own fit is pinned to this build's (test/fixtures/ap-fit-slow.ocm, its
/// sdnap_covariance_at at the grid ap-fit-slow.cov), the bounds kept.
const AP_COV_FLIGHT = { posM: 0.004, velMmS: 0.004, covOfLargest: 1e-4 };
const AP_COV_FIT = { posM: 0.1, covOfLargest: 2.5e-4, epoch: 7.5e-4, floors: 2.5e-4 };

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = h.instance.exports;
const mem = () => h.memory.buffer;
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)));
const { arc, rows } = inputs();
const fit = async (config, spw = null) => {
  const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config,
    ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
  check(r.statusCode === 0, `fit: ${r.errorCode} ${r.errorMessage}`);
  return r.statusCode === 0 ? new Uint8Array(r.outputs[0].payload) : null;
};
const exportOmm = (ocm) => h.invoke({ methodId: "export_omm", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocm }] });

const xpBytes = await fit(configuration({ theory: "SGP4XP", forces: XP_FORCES }));
if (!xpBytes) { console.error(failures.join("\n")); process.exit(1); }
const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(xpBytes)).unpack();
const was = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fixture("xp-fit-0.4.0.omm"))).unpack();
const user = Object.fromEntries(was.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
const numbers = (text) => text.trim().split(/\s+/).map(Number);

// --- the covariance's shape
check(ocm.COV_SIZE === 8 && ocm.COVARIANCE_DATA.length === 36 && ocm.COV_TYPE === "CARTPV" && ocm.COV_ORDERING === 0,
  `COV_SIZE ${ocm.COV_SIZE}, ${ocm.COVARIANCE_DATA.length} values, COV_TYPE ${ocm.COV_TYPE}, COV_ORDERING ${ocm.COV_ORDERING}`);
check(JSON.stringify(ocm.COV_PARAMETER_KINDS) === JSON.stringify([prwDynamicParameter.DRAG_AREA_OVER_MASS, prwDynamicParameter.SRP_AREA_OVER_MASS]),
  `COV_PARAMETER_KINDS ${JSON.stringify(ocm.COV_PARAMETER_KINDS)}`);
check(JSON.stringify(ocm.COV_PARAMETERS) === JSON.stringify(["DRAG_AREA_OVER_MASS", "SRP_AREA_OVER_MASS"]) && ocm.COV_UNITS.length === 8,
  `COV_PARAMETERS ${JSON.stringify(ocm.COV_PARAMETERS)}, COV_UNITS ${JSON.stringify(ocm.COV_UNITS)}`);
check(ocm.COV_REF_FRAME?.NAME === ocm.TRAJ_REF_FRAME?.NAME, `COV_REF_FRAME ${ocm.COV_REF_FRAME?.NAME} against TRAJ_REF_FRAME ${ocm.TRAJ_REF_FRAME?.NAME}`);
const cvr = ocm.COV_REALISM?.[0];
check(ocm.COV_REALISM?.length === 1 && cvr.RULE === covarianceRule.SourceModel && cvr.CALIBRATION === covarianceCalibration.Uncalibrated &&
  cvr.REGIME === user.SDNAP_COV_REGIME && /process noise/.test(cvr.MODEL_ID ?? ""), `COV_REALISM ${JSON.stringify(cvr)}`);

// --- COV_PROPAGATION, field by field against the 0.4.0 rows
const cp = ocm.COV_PROPAGATION;
const floor = numbers(user.SDNAP_COV_FLOOR_UVW), noise = numbers(user.SDNAP_COV_NOISE);
["FLOOR_UU_KM2", "FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_WU_KM2", "FLOOR_WV_KM2", "FLOOR_WW_KM2"].forEach((name, k) =>
  check(Object.is(cp[name], floor[k]), `${name} ${cp[name]} against the 0.4.0 ${floor[k]}`));
["NOISE_ECCENTRICITY_PER_DAY", "NOISE_INCLINATION_PER_DAY", "NOISE_MEAN_MOTION_RELATIVE", "NOISE_NON_GRAVITATIONAL_RAD_DAY2", "NOISE_START_MINUTES"].forEach((name, k) =>
  check(Object.is(cp[name], noise[k]), `${name} ${cp[name]} against the 0.4.0 ${noise[k]}`));
check(Object.is(cp.NON_GRAVITATIONAL_RATE_PER_DAY, Number(user.SDNAP_COV_NG_RATE)), `NON_GRAVITATIONAL_RATE_PER_DAY ${cp.NON_GRAVITATIONAL_RATE_PER_DAY}`);
const n = ocm.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
const want = cp.NON_GRAVITATIONAL_SHARE * Math.abs(cp.NON_GRAVITATIONAL_RATE_PER_DAY) * n;
const rel = Math.abs(cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 - want) / Math.max(Math.abs(want), Number.MIN_VALUE);
check(rel <= 1e-12, `the noise invariant: ${rel} relative`);

// --- the propagated covariance against the 0.4.0 numbers, to the last bit
const minutes = [];
for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) minutes.push(t);
const po = x.sdnap_alloc(xpBytes.length), pm = x.sdnap_alloc(8 * minutes.length), pout = x.sdnap_alloc(8 * 42 * minutes.length);
new Uint8Array(mem(), po, xpBytes.length).set(xpBytes);
new Float64Array(mem(), pm, minutes.length).set(minutes);
const status = x.sdnap_covariance_at(po, xpBytes.length, pm, minutes.length, pout);
check(status === 0, `sdnap_covariance_at: ${status}`);
const got = Buffer.from(mem().slice(pout, pout + 8 * 42 * minutes.length)), recorded = fixture("xp-fit-0.4.0.cov");
const gotF = new Float64Array(got.buffer, got.byteOffset, got.length / 8), recF = new Float64Array(recorded.buffer, recorded.byteOffset, recorded.length / 8);
let differ = 0;
for (let k = 0; k < recF.length; k++) if (!Object.is(gotF[k], recF[k])) differ++;
console.log(`sdnap_covariance_at at ${minutes.length} grid times: ${differ} of ${recF.length} doubles differ from the 0.4.0 numbers`);
check(got.length === recorded.length && differ === 0, `the propagated covariance differs from the 0.4.0 numbers in ${differ} doubles`);
x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);

// --- export_omm
const exported = await exportOmm(xpBytes);
check(exported.statusCode === 0 && exported.outputs.length === 1 && exported.outputs[0].portId === "omm", `export_omm: ${exported.errorCode} ${exported.errorMessage}`);
if (exported.statusCode === 0) {
  const bytes = new Uint8Array(exported.outputs[0].payload);
  try { assertNoUserDefined(bytes); } catch (e) { check(false, e.message); }
  const expected = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fixture("xp-fit-0.4.0.omm"))).unpack();
  expected.USER_DEFINED_PARAMETERS = [];
  expected.COMMENT = null;
  expected.USER_DEFINED_EPOCH_TIMESTAMP = 0;
  expected.USER_DEFINED_MICROSECONDS = 0;
  expected.PROVENANCE = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(xpBytes)).PROVENANCE().unpack();
  expected.BTERM = expected.BSTAR;
  expected.AGOM = expected.MEAN_MOTION_DDOT;
  expected.BSTAR = 0;
  expected.MEAN_MOTION_DDOT = 0;
  const pack = (t) => { const b = new flatbuffers.Builder(2048); OMM.finishOMMBuffer(b, t.pack(b)); return Buffer.from(b.asUint8Array()); };
  const mine = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
  const same = pack(mine).equals(pack(expected));
  console.log(`export_omm: ${bytes.length} B, the 0.4.0 set less its list, COMMENT and epoch fields: ${same ? "byte-equal" : "differs"} (one builder); raw against the 0.4.0 bytes less those fields: ${Buffer.from(bytes).equals(pack(expected)) ? "equal" : "other layout"}`);
  const text = (t) => JSON.stringify(t, (k, v) => (typeof v === "bigint" ? String(v) : v));
  if (!same) check(false, `export_omm differs from the 0.4.0 set: ${text(mine)} against ${text(expected)}`);
}
const apBytes = await fit(configuration({ theory: "AP", forces: { ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31,
  HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20, WEATHER_SOURCE: pcfWeatherSource.RECORDS } }), rows.bytes);
const refused = (label, r, code) => check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
if (apBytes) {
  refused("export_omm of the AP set", await exportOmm(apBytes), "theory-not-exportable:AP");
  const ap = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(apBytes)).unpack(), acp = ap.COV_PROPAGATION;
  check(Object.is(acp.NOISE_ECCENTRICITY_PER_DAY, AP_DRAG.s_e) && Object.is(acp.NOISE_INCLINATION_PER_DAY, AP_DRAG.s_i) &&
    Object.is(acp.NOISE_MEAN_MOTION_RELATIVE, AP_DRAG.s_l) && Object.is(acp.NON_GRAVITATIONAL_SHARE, AP_DRAG.c) && ap.COV_REALISM?.[0]?.REGIME === "DRAG",
    `the AP set's noise ${JSON.stringify(acp)} (regime ${ap.COV_REALISM?.[0]?.REGIME}) is not SPEC 12.5's DRAG row`);
  const an = ap.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI, awant = acp.NON_GRAVITATIONAL_SHARE * Math.abs(acp.NON_GRAVITATIONAL_RATE_PER_DAY) * an;
  check(Math.abs(acp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 - awant) <= 1e-12 * Math.max(Math.abs(awant), Number.MIN_VALUE), "the AP set's noise invariant");
  // sdnap_covariance_at at the fixture grid against 0.6.4's numbers of the stored record (test/fixtures/ap-fit-0.6.4.cov):
  // the stored record itself (the flight of fixed elements and covariance) within AP_COV_FLIGHT, this build's own fit within
  // AP_COV_FIT; the own fit's epoch covariance and floors against 0.6.18's fit (ap-fit-0.6.18.ocm) within AP_COV_FIT.epoch
  // and AP_COV_FIT.floors
  const storedCov = new Float64Array(fixture("ap-fit-0.6.4.cov").buffer.slice(0)), fitCov = new Float64Array(fixture("ap-fit-slow.cov").buffer.slice(0));
  const covAt = (bytes, reference) => {
    const qo = x.sdnap_alloc(bytes.length), qm = x.sdnap_alloc(8 * minutes.length), qout = x.sdnap_alloc(8 * 42 * minutes.length);
    new Uint8Array(mem(), qo, bytes.length).set(bytes);
    new Float64Array(mem(), qm, minutes.length).set(minutes);
    const status = x.sdnap_covariance_at(qo, bytes.length, qm, minutes.length, qout);
    const got = new Float64Array(mem().slice(qout, qout + 8 * 42 * minutes.length));
    x.sdnap_free(qo); x.sdnap_free(qm); x.sdnap_free(qout);
    const d = { status, posM: 0, velMmS: 0, covOfLargest: 0, differ: 0 };
    for (let k = 0; k < minutes.length; k += 1) {
      const o = 42 * k;
      d.posM = Math.max(d.posM, 1000 * Math.hypot(got[o] - reference[o], got[o + 1] - reference[o + 1], got[o + 2] - reference[o + 2]));
      d.velMmS = Math.max(d.velMmS, 1e6 * Math.hypot(got[o + 3] - reference[o + 3], got[o + 4] - reference[o + 4], got[o + 5] - reference[o + 5]));
      let largest = 0;
      for (let j = 6; j < 42; j += 1) largest = Math.max(largest, Math.abs(reference[o + j]));
      for (let j = 6; j < 42; j += 1) d.covOfLargest = Math.max(d.covOfLargest, Math.abs(got[o + j] - reference[o + j]) / largest);
      for (let j = 0; j < 42; j += 1) if (!Object.is(got[o + j], reference[o + j])) d.differ += 1;
    }
    return d;
  };
  const storedBytes = new Uint8Array(fixture("ap-fit-0.6.4.ocm"));
  const flightD = covAt(storedBytes, storedCov), fitD = covAt(apBytes, fitCov);
  const floors = ["FLOOR_UU_KM2", "FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_WU_KM2", "FLOOR_WV_KM2", "FLOOR_WW_KM2"];
  const recorded = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(fixture("ap-fit-slow.ocm")))).unpack();
  const floorRel = Math.max(...floors.map((f) => Math.abs(acp[f] - recorded.COV_PROPAGATION[f]) / Math.abs(recorded.COV_PROPAGATION[f])));
  const epochLargest = Math.max(...recorded.COVARIANCE_DATA.map(Math.abs));
  const epochRel = Math.max(...ap.COVARIANCE_DATA.map((v, k) => Math.abs(v - recorded.COVARIANCE_DATA[k]))) / epochLargest;
  console.log(`AP set: DRAG row s_e ${acp.NOISE_ECCENTRICITY_PER_DAY}, s_i ${acp.NOISE_INCLINATION_PER_DAY}, s_l ${acp.NOISE_MEAN_MOTION_RELATIVE}, c ${acp.NON_GRAVITATIONAL_SHARE}`);
  console.log(`sdnap_covariance_at against 0.6.4's of the stored record: the stored record ${flightD.differ} of ${42 * minutes.length} doubles differ, position ${(1000 * flightD.posM).toFixed(3)} mm, covariance ${flightD.covOfLargest.toExponential(2)} of a time's largest entry; ` +
    `this build's fit against the slow set's fit ${(1000 * fitD.posM).toFixed(2)} mm, ${fitD.covOfLargest.toExponential(2)}; its epoch covariance ${epochRel.toExponential(2)} of that record's largest entry, its floors ${floorRel.toExponential(2)} relative`);
  check(flightD.status === 0 && flightD.posM <= AP_COV_FLIGHT.posM && flightD.velMmS <= AP_COV_FLIGHT.velMmS && flightD.covOfLargest <= AP_COV_FLIGHT.covOfLargest,
    `sdnap_covariance_at of the stored AP record moved: ${JSON.stringify(flightD)} against ${JSON.stringify(AP_COV_FLIGHT)}`);
  check(fitD.status === 0 && fitD.posM <= AP_COV_FIT.posM && fitD.covOfLargest <= AP_COV_FIT.covOfLargest && epochRel <= AP_COV_FIT.epoch && floorRel <= AP_COV_FIT.floors,
    `this build's AP fit's covariance moved: ${JSON.stringify(fitD)}, epoch ${epochRel}, floors ${floorRel} against ${JSON.stringify(AP_COV_FIT)}`);
}
refused("export_omm of garbage", await exportOmm(new Uint8Array(64)), "invalid-ocm");
const exportUnder = (theory) => h.invoke({ methodId: "export_omm", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: xpBytes }, configuration({ theory })] });
check((await exportUnder("SGP4XP")).statusCode === 0, "export_omm under THEORY SGP4XP");
refused("export_omm of the XP set under THEORY SGP4", await exportUnder("SGP4"), "configuration-refused");

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ncovariance and export_omm E2E: PASS");
process.exit(0);
