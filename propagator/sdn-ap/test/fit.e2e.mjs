#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-write-20261103): fit writes one typed $OCM per block, and nothing else.
// - On the inputs of the 0.4.0 fixtures (test/lib/fixture-inputs.mjs): 24 h of propagator/ffm's 550 km trajectory,
//   fitted under AP's forces (gravity caps 31 and 20, NRLMSISE-00 on daily $SPW rows) and under stock SGP4XP (Jacchia
//   1970 on the theory's flux model), fit returns exactly two outputs, 'elements', an $OCM, then 'residuals', its $ODR
//   (SPEC 17.4).
// - MEAN_ELEMENTS printed against test/fixtures/ap-fit-0.4.0.omm and xp-fit-0.4.0.omm (the 0.4.18 dist's $OMM: BTERM in
//   BSTAR, AGOM in MEAN_MOTION_DDOT), the epoch equal; the fitted record flown 7 days within FIT_BOUND of the reference
//   record (SGP4XP: the stored record, 0.6.4's fit, those elements bit for bit; AP: 0.6.36's fit, ap-fit-0.6.36.ocm, history
//   at FIT_BOUND); MEAN_ELEMENT_THEORY AP (5) and SGP4XP (1).
// - OD_DYNAMIC_PARAMETERS: DRAG_AREA_OVER_MASS and SRP_AREA_OVER_MASS, VALUE bit-equal to BTERM and AGOM.
// - FIT_STATISTICS: FIT_STATES as the 0.4.0 COMMENT states them, FIT_RMS_KM within FIT_BOUND.rmsM of it, ITERATIONS
//   printed beside its; CONVERGED true (the 0.4.0 COMMENT states no convergence: a set was emitted only on a converged or
//   iteration-limited fit).
// - WEATHER_SOURCE THEORY_FLUX_MODEL (XP) and RECORDS (AP); the AP record's SPACE_WEATHER rows equal the supplied rows
//   field for field over the span, the day before the arc through the epoch's day plus FIT.WEATHER_HORIZON_DAYS (30):
//   2026-09-30 to 2026-10-31; rows one day short are refused weather-rows-short:2026-10-31; the XP record has none.
// - assertNoUserDefined on both records; a fit $PCF with ENABLE_DRAG is configuration-refused FORCES.ENABLE_DRAG; one
//   without ATMOSPHERE_MODEL is configuration-refused FORCES.ATMOSPHERE_MODEL.
// - No addParameter, USER_DEFINED_PARAMETERS or $OBD writer remains in src/fit_oem.inc.
// - Against the 0.6.3 dist (git, modules 03ee86234, its SHA-256 checked; 0.6.4's fits of these arcs are 0.6.3's): each
//   fit's $ODR names its own $OCM (RUN_ID and OCM_CONTENT_ID are the CID of its $OCM's bytes); each stored record's
//   sdnap_covariance_at at every fixture grid time (state and covariance, 42 doubles a time) and its propagate $OEM in
//   EME2000 and TEME every 6 h for 7 days within FLIGHT_BOUND on this build and on 0.6.3 (byte identity until 0.6.5), the
//   AP record's (ap-fit-0.6.36.ocm, 0.6.36's fit; 0.6.4's states EGM-96 and is refused, SPEC 16.2) against 0.6.36's flight
//   of it (ap-fit-0.6.36-0.6.36.cov, ap-fit-0.6.36.eme2000-0.6.36.oem, ap-fit-0.6.36.teme-0.6.36.oem; history at
//   FLIGHT_BOUND). With
//   SDNAP_EXAMPLES set to the published examples (each <id>.ocm and <id>.json), every set flies on both builds at every epoch
//   of its window, with sdnap_covariance_at at every 12th epoch; a set outside the band 0.6.4's switch moves (class 0 by the
//   SPEC 6 bands of its mean motion with 0.05 < e <= 0.3) and at e 0.3 or below within EXAMPLE_BOUND, a set in the band or
//   above e 0.3 measured and printed (nothing masked).
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import fs from "node:fs";
import { recordReference } from "./lib/record.mjs";
import { scratchTemp } from "./lib/scratch.mjs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { ODR } from "spacedatastandards.org/lib/js/ODR/ODR.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/PRW/prwDynamicParameter.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath, packageRoot } from "./lib/module.mjs";
import { configuration, MSIS_FORCES, XP_FORCES } from "./lib/pcf.mjs";
import { inputs, spwRows, GRID } from "./lib/fixture-inputs.mjs";
import { oemDistance } from "./lib/oem-distance.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)));
const ommOf = (bytes) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(bytes)).unpack();
const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();

const { arc, rows } = inputs();
const AP_FORCES = { ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const fit = (config, spw = rows.bytes) => h.invoke({ methodId: "fit", inputs: [
  { portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config, ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });

const cases = [
  { name: "AP", fixture: "ap-fit-0.4.0.omm", stored: "ap-fit-0.6.39.ocm", config: configuration({ theory: "AP", forces: AP_FORCES }), spw: rows.bytes, theory: 5, weather: pcfWeatherSource.RECORDS,
    fitReference: "ap-fit-0.6.39.ocm",
    recorded: { version: "0.6.36", cov: "ap-fit-0.6.36-0.6.36.cov", [pcfOutputFrame.EME2000]: "ap-fit-0.6.36.eme2000-0.6.36.oem", [pcfOutputFrame.TEME]: "ap-fit-0.6.36.teme-0.6.36.oem" } },
  { name: "XP", fixture: "xp-fit-0.4.0.omm", stored: "xp-fit-0.6.4.ocm", config: configuration({ theory: "SGP4XP", forces: XP_FORCES }), spw: null, theory: 1, weather: pcfWeatherSource.THEORY_FLUX_MODEL },
];
// The fit and the flight apart (no byte identity through a fit). The fit: this build's fitted record flown 7 days (EPOCHS,
// TEME) against the stored record (0.6.4's fit, MEAN_ELEMENTS bit-equal to the 0.4.0 $OMM) flown by this build, within
// FIT_BOUND[theory] m, and FIT_RMS within FIT_BOUND.rmsM of the 0.4.0 COMMENT's. 0.6.5 (24d7d75f) moved AP's fit: 26 against
// 28 iterations, FIT_RMS 41.127 against 41.130 m, 7.3 cm along the fixture grid and 2.10 m at 7 days on EPOCHS (the fit
// stops inside its tolerance); SGP4XP's fit is unchanged. The flight: the stored records flown by this build and by BEFORE
// within FLIGHT_BOUND (0.6.5's speed changes: AP 4.7 mm and 1.1e-4 of a line's largest covariance entry over EPOCHS' 7 days,
// SPEC 16.8; SGP4XP 0.099 mm in EME2000, 0.6.6's GCRF from 6 h nodes, SPEC 16.4, and byte-equal in TEME). 0.6.21 (SPEC
// 16.15 and 16.16, stack #464 and #472) moves the AP record's covariance against 0.6.3, and its flight is recorded from
// 0.6.21, the bounds kept. Against 0.6.3, 0.6.20 / 0.6.21: sdnap_covariance_at 0.839 / 0.839 mm, covariance 7.2e-5 /
// 9.217e-3 of a time's largest entry; propagate EME2000 0.720 / 0.720 mm, 1.12e-4 / 2.222e-3; TEME 0.740 / 0.740 mm,
// 1.12e-4 / 2.202e-3. Why: the record's correlations between AGOM and the state are 0.6.4's fit's, and 16.16 moves its
// along-track response to AGOM at 48 h from 1380.7 to 823.7 m per m^2/kg; a fit made and flown by 0.6.21 flies to 0.6.4's
// numbers within 7.1e-5 (covariance.e2e.mjs). 0.6.22 (AP's own Sun and Moon, SPEC 16.17, stack #446) records the AP
// record's flight from itself (the 0.6.21 files went), the bounds kept: against 0.6.21's, sdnap_covariance_at 34.755 mm,
// covariance 2.19e-5; propagate EME2000 and TEME 121.993 mm, 138.608 um/s, covariance 2.03e-5. AP's fit: against the
// stored record (0.6.4's fit) until 0.6.21; the Moon moves the fit of the 550 km arc to 3.182 m from it at 7 days (both
// flown by 0.6.22; 0.89 m on 0.6.19), so from 0.6.22 AP's fit is compared with 0.6.22's own fit (ap-fit-0.6.22.ocm),
// both flown by this build, the bound kept. The published
// examples (SDNAP_EXAMPLES) flown by both builds within EXAMPLE_BOUND, measured 2026-11-10: at most 9.6 mm and 1.2e-3
// (next-china-space-station-css); the sets above e 0.3 measured and printed (THEMIS 0.95 m at most), none in the band.
// 0.6.25 (the slow set, SPEC 16.18) moves the fit, which now carries the slow tesseral terms at 550 km: 17.7 m and 19.4
// mm/s from 0.6.22's fit (both flown by 0.6.25), FIT_RMS 40.049 against 41.126 m. Against the fixture's own truth
// (propagator/ffm's 550 km trajectory) the error 48 to 72 h past the arc goes from 114 m (0.6.24) to 43 m, over the arc
// 24.0 to 23.9 m. So the own fit is 0.6.25's (ap-fit-0.6.25.ocm; 0.6.22's went), the bounds kept.
// 0.6.27 (the slow set's terms of q other than 0, SPEC 16.18) moves the fit: 77.4 m and 45.1 mm/s from 0.6.25's fit
// (both flown by 0.6.27), FIT_RMS 40.260 against 40.049 m. Against the fixture's own truth (propagator/ffm's 550 km
// trajectory) the error 48 to 72 h past the arc stays at 43 m, and over the arc it goes from 23.9 to 24.1 m. So the own
// fit is 0.6.27's (ap-fit-0.6.27.ocm; 0.6.25's went), the bounds kept.
// 0.6.36 (the field EGM2008 in place of EGM-96, SPEC 16.2) moves the fit: 154.6 m and 133.1 mm/s from 0.6.27's fit
// (both flown by 0.6.36), FIT_RMS 40.153 against 40.260 m. Against the fixture's own truth (propagator/ffm's 550 km
// trajectory) the error 48 to 72 h past the arc goes from 43 to 42 m, and over the arc from 24.1 to 24.3 m. So the own
// fit is 0.6.36's (ap-fit-0.6.36.ocm; 0.6.27's went), the bounds kept. The field moves the stored record's flight too,
// against 0.6.22's: sdnap_covariance_at
// 7,140.576 mm, covariance 5.29e-3; propagate EME2000 and TEME over 7 days 20,136.651 mm, 21,823.483 um/s, covariance
// 4.74e-3. 0.6.36 refuses a record whose GRAVITY_MODEL is not the embedded field (SPEC 16.2): 0.6.4's fit states EGM-96
// (asserted below), so from 0.6.36 AP's stored record is 0.6.36's own fit (ap-fit-0.6.36.ocm), recorded with its flight
// (the 0.6.22 files went), the bounds kept; the reference fit is the same record.
// 0.6.39 (SPEC 12.4, stack #551: an AP set's epoch floor put on and taken off at the two-body state of its own mean
// elements) refuses the covariance of an AP record written before it (cov-floor-at-theory-state; its states fly), 0.6.36's
// fit among them. So from 0.6.39 the stored record is 0.6.39's own fit of the same inputs (ap-fit-0.6.39.ocm: 0.6.36's mean
// elements bit for bit, its COVARIANCE_DATA's state block carrying the floor at the two-body state), and its flight is
// held against 0.6.36's flight of 0.6.36's fit, which it equals to rounding (a set's own flight is as it was); 0.6.36's fit
// flies its states as 0.6.36 flew them, its covariance refused by name.
const FIT_BOUND = { AP: 3, XP: 0.001, rmsM: 0.01 };
const FLIGHT_BOUND = { posM: 0.01, covOfLargest: 2e-4 };
const EXAMPLE_BOUND = { posM: 0.05, covOfLargest: 2.5e-3 };
const records = {}, stored = {};
for (const c of cases) {
  const r = await fit(c.config, c.spw);
  check(r.statusCode === 0, `${c.name} fit: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode !== 0) continue;
  check(r.outputs.length === 2 && r.outputs[0].portId === "elements" && r.outputs[0].typeRef?.fileIdentifier === "$OCM" &&
    r.outputs[1].portId === "residuals" && r.outputs[1].typeRef?.fileIdentifier === "$ODR",
    `${c.name}: outputs ${r.outputs.map((o) => `${o.portId}:${o.typeRef?.fileIdentifier}`).join(", ")}`);
  const bytes = new Uint8Array(r.outputs[0].payload);
  check(String.fromCharCode(...bytes.subarray(4, 8)) === "$OCM", `${c.name}: not an $OCM`);
  try { assertNoUserDefined(bytes); } catch (e) { check(false, `${c.name}: ${e.message}`); }
  const ocm = ocmOf(bytes), was = ommOf(fixture(c.fixture)), me = ocm.MEAN_ELEMENTS;
  records[c.name] = ocm;
  // the twelve: EPOCH, the six elements, BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT, BTERM, AGOM
  const pairs = [["EPOCH", me.EPOCH, was.EPOCH], ["MEAN_MOTION", me.MEAN_MOTION, was.MEAN_MOTION], ["ECCENTRICITY", me.ECCENTRICITY, was.ECCENTRICITY],
    ["INCLINATION", me.INCLINATION, was.INCLINATION], ["RA_OF_ASC_NODE", me.RA_OF_ASC_NODE, was.RA_OF_ASC_NODE],
    ["ARG_OF_PERICENTER", me.ARG_OF_PERICENTER, was.ARG_OF_PERICENTER], ["MEAN_ANOMALY", me.MEAN_ANOMALY, was.MEAN_ANOMALY],
    ["BSTAR", me.BSTAR, 0], ["MEAN_MOTION_DOT", me.MEAN_MOTION_DOT, 0], ["MEAN_MOTION_DDOT", me.MEAN_MOTION_DDOT, 0],
    ["BTERM", me.BTERM, was.BSTAR], ["AGOM", me.AGOM, was.MEAN_MOTION_DDOT]];
  // the fit stops inside its tolerance (no byte identity through a fit): the fields printed against 0.4.0's, the epoch
  // equal, the fitted record flown against the stored record (0.6.4's fit, its elements 0.4.0's bit for bit) below
  const moved = pairs.filter(([, got, want]) => !Object.is(got, want));
  console.log(`${c.name}: ${12 - moved.length} of 12 fields bit-equal to 0.4.0's${moved.length ? `; ${moved.map(([f, got, want]) => `${f} ${got} (0.4.0 ${want})`).join(", ")}` : ""}`);
  check(Object.is(me.EPOCH, was.EPOCH), `${c.name} EPOCH: ${me.EPOCH} against the 0.4.0 ${was.EPOCH}`);
  stored[c.name] = { fitted: bytes, record: new Uint8Array(fixture(c.stored)), reference: new Uint8Array(fixture(c.fitReference ?? c.stored)) };
  check(me.MEAN_ELEMENT_THEORY === c.theory, `${c.name}: MEAN_ELEMENT_THEORY ${me.MEAN_ELEMENT_THEORY}, expected ${c.theory}`);
  const dyn = ocm.ORBIT_DETERMINATION?.OD_DYNAMIC_PARAMETERS ?? [];
  const drag = dyn.find((p) => p.PARAMETER === prwDynamicParameter.DRAG_AREA_OVER_MASS), srp = dyn.find((p) => p.PARAMETER === prwDynamicParameter.SRP_AREA_OVER_MASS);
  check(dyn.length === 2 && drag && srp && Object.is(drag.VALUE, me.BTERM) && Object.is(srp.VALUE, me.AGOM) && drag.SOLVED_FOR && srp.SOLVED_FOR,
    `${c.name}: OD_DYNAMIC_PARAMETERS ${JSON.stringify(dyn.map((p) => [p.PARAMETER, p.VALUE, p.SOLVED_FOR]))}`);
  const st = ocm.ORBIT_DETERMINATION?.FIT_STATISTICS ?? {};
  const comment = String(was.COMMENT);
  const states = Number(/(\d+) states fitted/.exec(comment)?.[1]), rms = /fit RMS ([\d.]+) km/.exec(comment)?.[1], iterations = Number(/(\d+) iterations/.exec(comment)?.[1]);
  check(st.FIT_STATES === states, `${c.name}: FIT_STATES ${st.FIT_STATES} against the 0.4.0 ${states}`);
  // AP's FIT_RMS against its reference fit's from 0.6.25 (the slow set: 41.126 to 40.049 m; history at FIT_BOUND), XP's
  // against the 0.4.0 COMMENT's
  const rmsPinned = c.fitReference ? ocmOf(new Uint8Array(fixture(c.fitReference))).ORBIT_DETERMINATION.FIT_STATISTICS.FIT_RMS_KM : Number(rms);
  check(Math.abs(1000 * (st.FIT_RMS_KM - rmsPinned)) <= FIT_BOUND.rmsM, `${c.name}: FIT_RMS_KM ${st.FIT_RMS_KM} against ${c.fitReference ? c.fitReference : `the 0.4.0`}'s ${rmsPinned} (within ${FIT_BOUND.rmsM} m)`);
  console.log(`${c.name}: FIT_RMS ${(1000 * st.FIT_RMS_KM).toFixed(4)} m (0.4.0 ${(1000 * Number(rms)).toFixed(3)}), ITERATIONS ${st.ITERATIONS} (0.4.0 ${iterations})`);
  check(st.CONVERGED === true, `${c.name}: CONVERGED ${st.CONVERGED}`);
  check(st.FIT_START === "2026-10-01T00:00:00.000000" && st.FIT_STOP === "2026-10-02T00:00:00.000000", `${c.name}: arc ${st.FIT_START} to ${st.FIT_STOP}`);
  check(typeof st.PCF_CID === "string" && st.PCF_CID.startsWith("b"), `${c.name}: PCF_CID ${st.PCF_CID}`);
  check(ocm.PERTURBATIONS?.WEATHER_SOURCE === c.weather, `${c.name}: WEATHER_SOURCE ${ocm.PERTURBATIONS?.WEATHER_SOURCE}`);
  check(ocm.METADATA?.NORAD_CAT_ID === 90400 && ocm.METADATA?.OBJECT_DESIGNATOR === "90400" && ocm.METADATA?.INTERNATIONAL_DESIGNATOR === "2026-904A",
    `${c.name}: METADATA ${ocm.METADATA?.NORAD_CAT_ID} ${ocm.METADATA?.OBJECT_DESIGNATOR} ${ocm.METADATA?.INTERNATIONAL_DESIGNATOR}`);
  check(ocm.ORB_AVERAGING === "BROUWER" && (ocm.STATE_DATA ?? []).length === 0, `${c.name}: ORB_AVERAGING ${ocm.ORB_AVERAGING}, ${ocm.STATE_DATA?.length} state values`);
  check((ocm.PROVENANCE?.PRODUCER ?? "") === `com.spacedatanetwork.sdn-ap-propagator ${JSON.parse(fs.readFileSync(`${packageRoot}plugin-manifest.json`, "utf8")).version}`, `${c.name}: PRODUCER ${ocm.PROVENANCE?.PRODUCER}`);
}
const ap = records.AP, xp = records.XP;
if (ap && xp) {
  check(ap.TRAJ_REF_FRAME?.NAME === "TEMEOFEPOCH" && ap.TRAJ_FRAME_EPOCH === ap.MEAN_ELEMENTS.EPOCH, `AP frame ${ap.TRAJ_REF_FRAME?.NAME} ${ap.TRAJ_FRAME_EPOCH}`);
  check(xp.TRAJ_REF_FRAME?.NAME === "TEMEOFDATE" && !xp.TRAJ_FRAME_EPOCH, `XP frame ${xp.TRAJ_REF_FRAME?.NAME}`);
  check(ap.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE === 31 && ap.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE === 20, "AP caps");
  check(ap.PERTURBATIONS.ATMOSPHERIC_MODEL?.YEAR === 2000 && xp.PERTURBATIONS.ATMOSPHERIC_MODEL?.YEAR === 1970, "ATMOSPHERIC_MODEL years");
  // the rows over the span, field for field
  const span = rows.values.filter((v) => v.DATE >= "2026-09-30" && v.DATE <= "2026-10-31");
  const got = (ap.PERTURBATIONS.SPACE_WEATHER ?? []).map((r) => ({ DATE: r.DATE, F107_OBS: r.F107_OBS, F107_OBS_CENTER81: r.F107_OBS_CENTER81, AP_AVG: r.AP_AVG, F107_DATA_TYPE: r.F107_DATA_TYPE }));
  check(span.length === 32 && JSON.stringify(got) === JSON.stringify(span), `AP SPACE_WEATHER: ${got.length} rows, ${got[0]?.DATE} to ${got.at(-1)?.DATE}, against ${span.length}`);
  check(ap.PERTURBATIONS.SW_DATA_EPOCH === "2026-10-01" && /^DAILY/.test(ap.PERTURBATIONS.SW_INTERP_METHOD ?? ""), `AP SW_DATA_EPOCH ${ap.PERTURBATIONS.SW_DATA_EPOCH}`);
  check((xp.PERTURBATIONS.SPACE_WEATHER ?? []).length === 0, "the XP record carries SPACE_WEATHER");
  console.log(`AP: n ${ap.MEAN_ELEMENTS.MEAN_MOTION}, BTERM ${ap.MEAN_ELEMENTS.BTERM}, fit RMS ${ap.ORBIT_DETERMINATION.FIT_STATISTICS.FIT_RMS_KM} km, ${ap.PERTURBATIONS.SPACE_WEATHER.length} rows; ` +
    `XP: n ${xp.MEAN_ELEMENTS.MEAN_MOTION}, BTERM ${xp.MEAN_ELEMENTS.BTERM}, fit RMS ${xp.ORBIT_DETERMINATION.FIT_STATISTICS.FIT_RMS_KM} km`);
}

// 0.6.4 against 0.6.3 on these low-eccentricity fits: the same bytes, PRODUCER's version aside
const BEFORE = { version: "0.6.3", commit: "03ee8623437f8c85900cabc0cc2a35b9288f4e36", sha256: "aa3ed22aa61a3a514e06619b9bff4aa1b1051d704dc32cd360b5c572b2c57f4e" };
// The band 0.6.4 moves (SPEC 16.11, the switch by class): class 0 by the SPEC 6 bands of the mean motion (resonance.inc band_of,
// rad/min) with 0.05 < e <= 0.3. Sets above e 0.3 fly the grid on both builds; both kinds are flown on both and counted apart.
const bandOf = (revPerDay) => {
  const n = revPerDay * 2 * Math.PI / 1440;
  if (n > 0.0035003818 && n < 0.0052505727) return 1;
  if (n >= 0.0070007636 && n <= 0.0105011454) return 2;
  if (n > 0.0105011454 && n <= 0.015751718) return 3;
  if (n >= 0.0052505727 && n <= 0.007875859) return 4;
  return 0;
};
const movedBand = (me) => bandOf(me.MEAN_MOTION) === 0 && me.ECCENTRICITY > 0.05 && me.ECCENTRICITY <= 0.3;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforeBytes = execFileSync("git", ["-C", packageRoot, "show", `${BEFORE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
check(sha256(beforeBytes) === BEFORE.sha256, `sdn-ap ${BEFORE.version} at ${BEFORE.commit.slice(0, 9)} is ${sha256(beforeBytes)}`);
const scratch = scratchTemp("sdn-ap-fit-e2e-");
const beforePath = path.join(scratch, `module-${BEFORE.version}.wasm`);
fs.writeFileSync(beforePath, beforeBytes);
const before = await createStandaloneHarness("browser", beforePath, { surface: "direct" });
const now = JSON.parse(fs.readFileSync(`${packageRoot}plugin-manifest.json`, "utf8")).version;
const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
const asVersion = (bytes, v) => { const b = Buffer.from(bytes); for (let at = b.indexOf(producer(now)); at >= 0; at = b.indexOf(producer(now), at + 1)) producer(v).copy(b, at); return b; };
const asBefore = (bytes) => asVersion(bytes, BEFORE.version);
// CIDv1, raw codec, sha2-256, base32 lower case with the 'b' prefix
const cidOf = (bytes) => {
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "b";
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
};
// $ODR fields that name the producing version's own $OCM (its CID), excluded from the value comparison
const ODR_NAMES_OCM = ["RUN_ID", "OCM_CONTENT_ID"];
const odrOf = (bytes) => ODR.getRootAsODR(new flatbuffers.ByteBuffer(bytes)).unpack();
// every leaf value of a against b (Object.is for numbers); returns [compared, first difference or null]
const sameValues = (a, b, at = "ODR") => {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) { a = Array.from(a ?? []); b = Array.from(b ?? []); }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return [0, `${at}.length ${a?.length} | ${b?.length}`];
    let n = 0;
    for (let i = 0; i < a.length; i += 1) { const [m, d] = sameValues(a[i], b[i], `${at}[${i}]`); n += m; if (d) return [n, d]; }
    return [n, null];
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    let n = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const [m, d] = sameValues(a[k], b[k], `${at}.${k}`); n += m; if (d) return [n, d]; }
    return [n, null];
  }
  return Object.is(a, b) ? [1, null] : [0, `${at} ${a} | ${b}`];
};
let odrValues = 0;
const minutes = [];
for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) minutes.push(t);
const covarianceAt = (harness, ocmBytes, times = minutes) => {
  const x = harness.instance.exports, mem = () => harness.memory.buffer;
  const po = x.sdnap_alloc(ocmBytes.length), pm = x.sdnap_alloc(8 * times.length), pout = x.sdnap_alloc(8 * 42 * times.length);
  new Uint8Array(mem(), po, ocmBytes.length).set(ocmBytes);
  new Float64Array(mem(), pm, times.length).set(times);
  const status = x.sdnap_covariance_at(po, ocmBytes.length, pm, times.length, pout);
  const out = Buffer.from(mem().slice(pout, pout + 8 * 42 * times.length));
  x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
  return { status, out };
};
const EPOCHS = Array.from({ length: 29 }, (_, k) => new Date(Date.parse("2026-10-02T00:00:00Z") + k * 6 * 3600e3).toISOString().replace("Z", ""));
const flight = (harness, ocmBytes, frame) => harness.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocmBytes },
  configuration({ output: { FRAME: frame, EPOCHS } })] });
// sdnap_covariance_at of one record by two builds: the largest position (m) and, of a time's covariance, the largest
// difference against that time's largest entry
const covDistance = (a, b) => {
  const x = new Float64Array(a.buffer, a.byteOffset, a.length / 8), y = new Float64Array(b.buffer, b.byteOffset, b.length / 8);
  let posM = 0, covOfLargest = 0;
  for (let o = 0; o < x.length; o += 42) {
    posM = Math.max(posM, 1000 * Math.hypot(x[o] - y[o], x[o + 1] - y[o + 1], x[o + 2] - y[o + 2]));
    let largest = 0;
    for (let j = 6; j < 42; j += 1) largest = Math.max(largest, Math.abs(y[o + j]));
    for (let j = 6; j < 42; j += 1) covOfLargest = Math.max(covOfLargest, Math.abs(x[o + j] - y[o + j]) / largest);
  }
  return { posM, covOfLargest, bitEqual: a.equals(b) };
};
for (const c of cases) {
  const s = stored[c.name];
  if (!s) continue;
  // the fit: this build's fitted record against the reference record (SGP4XP: the stored record; AP: 0.6.36's fit), both
  // flown by this build; its $ODR names its own $OCM
  const refName = c.fitReference ? "0.6.39's fit" : "the stored (0.6.4's fit)";
  const [pf, ps] = [await flight(h, s.fitted, pcfOutputFrame.TEME), await flight(h, s.reference, pcfOutputFrame.TEME)];
  check(pf.statusCode === 0 && ps.statusCode === 0, `${c.name}: propagate the fitted and the reference record: ${pf.errorCode ?? "ok"} | ${ps.errorCode ?? "ok"}`);
  if (pf.statusCode === 0 && ps.statusCode === 0) {
    const d = oemDistance(new Uint8Array(pf.outputs[0].payload), new Uint8Array(ps.outputs[0].payload));
    console.log(`${c.name} fit: this build's record against ${refName} over 7 days: ${(1000 * d.posM).toFixed(2)} mm, ${(1000 * d.velMmS).toFixed(2)} um/s`);
    check(d.posM <= FIT_BOUND[c.name], `${c.name} fit: ${d.posM} m from ${refName}'s flight (within ${FIT_BOUND[c.name]} m)`);
  }
  const r2 = await fit(c.config, c.spw);
  if (r2.statusCode === 0) {
    const ocm2 = new Uint8Array(r2.outputs[0].payload), d2 = odrOf(new Uint8Array(r2.outputs[1].payload));
    for (const f of ODR_NAMES_OCM) check(d2[f] === cidOf(ocm2), `${c.name} $ODR ${f}: ${d2[f]}, its $OCM is ${cidOf(ocm2)}`);
  }
  // the flight: the stored record flown by this build and by BEFORE (XP), or against its recorded flight (AP, 0.6.36's)
  const rec = c.recorded, against = rec ? `${rec.version}'s recorded flight` : BEFORE.version;
  const [a2, a1] = [covarianceAt(h, s.record), rec ? { status: 0, out: fixture(rec.cov) } : covarianceAt(before, s.record)];
  const cd = covDistance(a2.out, a1.out);
  console.log(`${c.name} flight of the stored record, sdnap_covariance_at at ${minutes.length} times, ${now} against ${against}: ${cd.bitEqual ? "bit-equal" : `${(1000 * cd.posM).toFixed(3)} mm, covariance ${cd.covOfLargest.toExponential(2)} of a time's largest entry`}`);
  check(a2.status === 0 && a1.status === 0 && cd.posM <= FLIGHT_BOUND.posM && cd.covOfLargest <= FLIGHT_BOUND.covOfLargest,
    `${c.name} sdnap_covariance_at of the stored record: ${now} (${a2.status}) against ${against} (${a1.status}) ${JSON.stringify(cd)} (within ${JSON.stringify(FLIGHT_BOUND)})`);
  for (const frame of [pcfOutputFrame.EME2000, pcfOutputFrame.TEME]) {
    const p2 = await flight(h, s.record, frame), p1 = rec ? { statusCode: 0, outputs: [{ payload: fixture(rec[frame]) }] } : await flight(before, s.record, frame);
    const ok = p2.statusCode === 0 && p1.statusCode === 0;
    if (rec && p2.statusCode === 0) recordReference(`ap-fit-0.6.39.${frame === pcfOutputFrame.EME2000 ? "eme2000" : "teme"}`, "oem", new Uint8Array(p2.outputs[0].payload));
    const d = ok ? oemDistance(asVersion(new Uint8Array(p2.outputs[0].payload), rec ? rec.version : BEFORE.version), new Uint8Array(p1.outputs[0].payload)) : null;
    if (d) console.log(`${c.name} flight of the stored record, propagate ${pcfOutputFrame[frame]} at ${EPOCHS.length} epochs over 7 days, ${now} against ${against}: ${d.bytesEqual ? "byte-equal (PRODUCER's version aside)" : `${(1000 * d.posM).toFixed(3)} mm, ${(1000 * d.velMmS).toFixed(3)} um/s, covariance ${d.covOfLargest.toExponential(2)}`}`);
    check(ok && d.posM <= FLIGHT_BOUND.posM && d.covOfLargest <= FLIGHT_BOUND.covOfLargest,
      `${c.name} propagate (${pcfOutputFrame[frame]}) of the stored record: ${now} ${p2.statusCode ? p2.errorCode : "ok"} against ${against} ${p1.statusCode ? p1.errorCode : "ok"} ${JSON.stringify(d)}`);
  }
}

// the published examples' sets (SDNAP_EXAMPLES: the experiments' results/ap-truth/compare/examples, each <id>.ocm the $OCM
// AP flew and <id>.json its window): each flown on both builds in TEME at every epoch of its window (propagate $OEM
// byte-identical, PRODUCER's version aside) and sdnap_covariance_at at every 12th epoch (42 doubles a time, bit-identical)
const EXAMPLES = process.env.SDNAP_EXAMPLES;
if (!EXAMPLES) console.log("examples: SDNAP_EXAMPLES not given, the published examples not flown");
else {
  // every set flown on both builds over its window and measured (nothing masked): the sets outside the band 0.6.4 moved
  // and at e 0.3 and below within EXAMPLE_BOUND (the flight of fixed elements); the band's sets and those above e 0.3
  // measured and printed, set by set (0.6.4's switch and 0.6.3's grid fly them differently by design; the band's 6:1
  // orbits are DigitalArsenal/spacedatanetwork-stack#393)
  const ids = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".ocm")).map((f) => f.slice(0, -4)).sort();
  let within = 0, outside = 0, epochsFlown = 0;
  const reported = [];
  for (const id of ids) {
    const d = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${id}.json`), "utf8")), set = new Uint8Array(fs.readFileSync(path.join(EXAMPLES, `${id}.ocm`)));
    const me = ocmOf(set).MEAN_ELEMENTS, kind = me.ECCENTRICITY > 0.3 ? "e above 0.3" : movedBand(me) ? "the band" : null;
    const t0 = Date.parse(d.start), setMs = Date.parse(`${me.EPOCH.slice(0, 23)}Z`);
    const epochs = d.epochsSeconds.map((s) => new Date(t0 + 1000 * s).toISOString().replace("Z", ""));
    const times = d.epochsSeconds.filter((_, k) => k % 12 === 0).map((s) => (t0 + 1000 * s - setMs) / 60000);
    const fly = (harness) => harness.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: set },
      configuration({ output: { FRAME: pcfOutputFrame.TEME, EPOCHS: epochs } })] });
    const [p2, p1] = [await fly(h), await fly(before)];
    check(p2.statusCode === 0 && p1.statusCode === 0, `example ${id} propagate: ${now} ${p2.errorCode ?? "ok"} | ${BEFORE.version} ${p1.errorCode ?? "ok"}`);
    if (p2.statusCode !== 0 || p1.statusCode !== 0) continue;
    const pd = oemDistance(asBefore(new Uint8Array(p2.outputs[0].payload)), new Uint8Array(p1.outputs[0].payload));
    const [a2, a1] = [covarianceAt(h, set, times), covarianceAt(before, set, times)];
    const cd = covDistance(a2.out, a1.out);
    epochsFlown += epochs.length;
    if (kind) { reported.push(`${id} (${kind}, n ${me.MEAN_MOTION.toFixed(3)}, e ${me.ECCENTRICITY.toFixed(3)}): ${pd.posM.toFixed(4)} m`); continue; }
    outside += 1;
    const ok = pd.posM <= EXAMPLE_BOUND.posM && cd.covOfLargest <= EXAMPLE_BOUND.covOfLargest;
    if (ok) within += 1;
    check(ok, `example ${id}: ${now} against ${BEFORE.version} ${(1000 * pd.posM).toFixed(3)} mm, covariance ${cd.covOfLargest.toExponential(2)} (within ${JSON.stringify(EXAMPLE_BOUND)})`);
  }
  console.log(`examples: ${within} of ${outside} sets outside the band and at e 0.3 and below within ${JSON.stringify(EXAMPLE_BOUND)} of ${BEFORE.version} ` +
    `(${epochsFlown} epochs flown); measured, not bounded: ${reported.length ? reported.join("; ") : "none"}`);
  check(outside > 0 && within === outside, `examples: ${within} of ${outside} sets within the bound`);
}
fs.rmSync(scratch, { recursive: true, force: true });

// refusals by name
const refused = (label, r, code, field = null) =>
  check(r.statusCode !== 0 && r.errorCode === code && (field === null || String(r.errorMessage).startsWith(field)),
    `${label}: expected ${code}${field ? ` ${field}` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
const short = spwRows({ days: 33 });  // 2026-09-28 .. 2026-10-30
refused("0.6.4's AP fit (GRAVITY_MODEL EGM-96 with gravity terms)", await h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array(fixture("ap-fit-0.6.4.ocm")) }] }), "gravity-model-mismatch");
refused("rows one day short", await fit(configuration({ theory: "AP", forces: AP_FORCES }), short.bytes), "weather-rows-short:2026-10-31");
refused("ENABLE_DRAG", await fit(configuration({ theory: "AP", forces: { ...AP_FORCES, ENABLE_DRAG: true } })), "configuration-refused", "FORCES.ENABLE_DRAG");
refused("no ATMOSPHERE_MODEL", await fit(configuration({ theory: "SGP4XP" }), null), "configuration-refused", "FORCES.ATMOSPHERE_MODEL");

// the writer
const source = fs.readFileSync(`${packageRoot}src/fit_oem.inc`, "utf8");
for (const word of ["addParameter", "USER_DEFINED_PARAMETERS", "OBDBuilder", "$OBD"]) check(!source.includes(word), `src/fit_oem.inc still names ${word}`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nfit $OCM E2E: PASS");
process.exit(0);
