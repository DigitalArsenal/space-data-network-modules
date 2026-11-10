#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-export-cov-20261103): the covariance side of fit's $OCM and the one $OMM export.
// - fit of the 0.4.0 XP fixture's inputs (test/lib/fixture-inputs.mjs) writes COVARIANCE_DATA 8 x 8 LTM CARTPV in the
//   record's TRAJ_REF_FRAME, COV_PARAMETER_KINDS [DRAG_AREA_OVER_MASS, SRP_AREA_OVER_MASS] with COV_PARAMETERS and
//   COV_UNITS, COV_PROPAGATION (six named floor doubles, the noise, the share and the rate) and COV_REALISM[0]
//   (SourceModel, the noise model, its regime, Uncalibrated).
// - sdnap_covariance_at of that $OCM at every time of the fixture grid reproduces the recorded numbers
//   (test/fixtures/xp-fit-data-sigma.cov, test/record-fit-fixtures.mjs) to the last bit: state and covariance, 42 doubles
//   a time.
// - Each COV_PROPAGATION field (the floor, the noise, the share and the rate) equals, by name, that of the recorded set
//   test/fixtures/xp-fit-data-sigma.ocm; |NOISE_NON_GRAVITATIONAL_RAD_DAY2 - NON_GRAVITATIONAL_SHARE x
//   |NON_GRAVITATIONAL_RATE_PER_DAY| x n| <= 1e-12 relative (n in rad/day). The recorded set is SPEC 12.1's data-sigma fit
//   (its numbers moved from the 0.4.0 set's with the weighting; fit.e2e.mjs states why they are the better ones).
// - The AP fit (gravity caps 31 and 20, NRLMSISE-00 on the fixture rows, the DRAG regime) writes the 0.6.1 DRAG row of
//   SPEC 12.5 (s_e, s_i, s_l, c bit for bit; NOISE_NON_GRAVITATIONAL_RAD_DAY2 = c |rate| n) and its covariance is pinned:
//   the SHA-256 of COVARIANCE_DATA, the six floor doubles and sdnap_covariance_at of the AP set at the fixture grid
//   (AP_COVARIANCE_SHA256, recorded with SPEC 12.1's AP estimator: consider rates, the hold rule; the SGP4XP noise table
//   is unchanged).
// - export_omm of the XP $OCM equals test/fixtures/xp-fit-data-sigma.omm (export_omm of the recorded set) with
//   PROVENANCE that of the $OCM exported: the two records packed by one builder are byte-equal;
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
import { createHash } from "node:crypto";

/// SPEC 12.5's AP DRAG row (0.6.1) and the pinned AP covariance numbers.
const AP_DRAG = { s_e: 1.8579913326733934e-7, s_i: 1.12761105007012e-6, s_l: 7.647194501793458e-7, c: 0.112126311682426 };
const AP_COVARIANCE_SHA256 = "03a9c8df9bdcc8e4c114bfc39fb9e1634c8f1e513b9bc918936a6d311eaae359";

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
const recordedSet = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(fixture("xp-fit-data-sigma.ocm"))).unpack();

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
  cvr.REGIME === recordedSet.COV_REALISM?.[0]?.REGIME && /process noise/.test(cvr.MODEL_ID ?? ""), `COV_REALISM ${JSON.stringify(cvr)}`);

// --- COV_PROPAGATION, field by field against the recorded set's
const cp = ocm.COV_PROPAGATION, rcp = recordedSet.COV_PROPAGATION;
for (const name of ["FLOOR_UU_KM2", "FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_WU_KM2", "FLOOR_WV_KM2", "FLOOR_WW_KM2", "NOISE_ECCENTRICITY_PER_DAY",
  "NOISE_INCLINATION_PER_DAY", "NOISE_MEAN_MOTION_RELATIVE", "NOISE_NON_GRAVITATIONAL_RAD_DAY2", "NOISE_START_MINUTES", "NON_GRAVITATIONAL_SHARE",
  "NON_GRAVITATIONAL_RATE_PER_DAY"])
  check(Object.is(cp[name], rcp[name]), `${name} ${cp[name]} against the recorded ${rcp[name]}`);
const n = ocm.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
const want = cp.NON_GRAVITATIONAL_SHARE * Math.abs(cp.NON_GRAVITATIONAL_RATE_PER_DAY) * n;
const rel = Math.abs(cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 - want) / Math.max(Math.abs(want), Number.MIN_VALUE);
check(rel <= 1e-12, `the noise invariant: ${rel} relative`);

// --- the propagated covariance against the recorded numbers, to the last bit
const minutes = [];
for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) minutes.push(t);
const po = x.sdnap_alloc(xpBytes.length), pm = x.sdnap_alloc(8 * minutes.length), pout = x.sdnap_alloc(8 * 42 * minutes.length);
new Uint8Array(mem(), po, xpBytes.length).set(xpBytes);
new Float64Array(mem(), pm, minutes.length).set(minutes);
const status = x.sdnap_covariance_at(po, xpBytes.length, pm, minutes.length, pout);
check(status === 0, `sdnap_covariance_at: ${status}`);
const got = Buffer.from(mem().slice(pout, pout + 8 * 42 * minutes.length)), recorded = fixture("xp-fit-data-sigma.cov");
const gotF = new Float64Array(got.buffer, got.byteOffset, got.length / 8), recF = new Float64Array(recorded.buffer, recorded.byteOffset, recorded.length / 8);
let differ = 0;
for (let k = 0; k < recF.length; k++) if (!Object.is(gotF[k], recF[k])) differ++;
console.log(`sdnap_covariance_at at ${minutes.length} grid times: ${differ} of ${recF.length} doubles differ from the recorded numbers`);
check(got.length === recorded.length && differ === 0, `the propagated covariance differs from the recorded numbers in ${differ} doubles`);
x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);

// --- export_omm
const exported = await exportOmm(xpBytes);
check(exported.statusCode === 0 && exported.outputs.length === 1 && exported.outputs[0].portId === "omm", `export_omm: ${exported.errorCode} ${exported.errorMessage}`);
if (exported.statusCode === 0) {
  const bytes = new Uint8Array(exported.outputs[0].payload);
  try { assertNoUserDefined(bytes); } catch (e) { check(false, e.message); }
  const expected = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(fixture("xp-fit-data-sigma.omm"))).unpack();
  expected.PROVENANCE = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(xpBytes)).PROVENANCE().unpack();
  const pack = (t) => { const b = new flatbuffers.Builder(2048); OMM.finishOMMBuffer(b, t.pack(b)); return Buffer.from(b.asUint8Array()); };
  const mine = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
  const same = pack(mine).equals(pack(expected));
  console.log(`export_omm: ${bytes.length} B, the recorded set with this $OCM's PROVENANCE: ${same ? "byte-equal" : "differs"} (one builder)`);
  const text = (t) => JSON.stringify(t, (k, v) => (typeof v === "bigint" ? String(v) : v));
  if (!same) check(false, `export_omm differs from the recorded set: ${text(mine)} against ${text(expected)}`);
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
  const qo = x.sdnap_alloc(apBytes.length), qm = x.sdnap_alloc(8 * minutes.length), qout = x.sdnap_alloc(8 * 42 * minutes.length);
  new Uint8Array(mem(), qo, apBytes.length).set(apBytes);
  new Float64Array(mem(), qm, minutes.length).set(minutes);
  const aStatus = x.sdnap_covariance_at(qo, apBytes.length, qm, minutes.length, qout);
  check(aStatus === 0, `sdnap_covariance_at of the AP set: ${aStatus}`);
  const floorAp = ["FLOOR_UU_KM2", "FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_WU_KM2", "FLOOR_WV_KM2", "FLOOR_WW_KM2"].map((f) => acp[f]);
  const digest = createHash("sha256").update(Buffer.from(Float64Array.from(ap.COVARIANCE_DATA).buffer)).update(Buffer.from(Float64Array.from(floorAp).buffer))
    .update(Buffer.from(mem().slice(qout, qout + 8 * 42 * minutes.length))).digest("hex");
  console.log(`AP set: DRAG row s_e ${acp.NOISE_ECCENTRICITY_PER_DAY}, s_i ${acp.NOISE_INCLINATION_PER_DAY}, s_l ${acp.NOISE_MEAN_MOTION_RELATIVE}, c ${acp.NON_GRAVITATIONAL_SHARE}; covariance SHA-256 ${digest} (pinned ${AP_COVARIANCE_SHA256})`);
  check(digest === AP_COVARIANCE_SHA256, `the AP covariance numbers ${digest} differ from the pinned ${AP_COVARIANCE_SHA256}`);
  x.sdnap_free(qo); x.sdnap_free(qm); x.sdnap_free(qout);
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
