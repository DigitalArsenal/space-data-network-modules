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
// - export_omm of the XP $OCM equals xp-fit-0.4.0.omm with USER_DEFINED_PARAMETERS, COMMENT and
//   USER_DEFINED_EPOCH_TIMESTAMP / MICROSECONDS removed and PROVENANCE carried, BTERM in BSTAR and AGOM in
//   MEAN_MOTION_DDOT (OMM 1.276.0 has no BTERM or AGOM field): the two records packed by one builder are byte-equal;
//   assertNoUserDefined on it; export_omm of the AP $OCM is theory-not-exportable:AP; garbage is invalid-ocm.
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
if (apBytes) refused("export_omm of the AP set", await exportOmm(apBytes), "theory-not-exportable:AP");
refused("export_omm of garbage", await exportOmm(new Uint8Array(64)), "invalid-ocm");

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ncovariance and export_omm E2E: PASS");
process.exit(0);
