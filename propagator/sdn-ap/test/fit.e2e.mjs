#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-write-20261103): fit writes one typed $OCM per block, and nothing else.
// - On the inputs of the 0.4.0 fixtures (test/lib/fixture-inputs.mjs): 24 h of propagator/ffm's 550 km trajectory,
//   fitted under AP's forces (gravity caps 31 and 20, NRLMSISE-00 on daily $SPW rows) and under stock SGP4XP (Jacchia
//   1970 on the theory's flux model), fit returns exactly one output, 'elements', an $OCM.
// - MEAN_ELEMENTS equal, bit for bit, the elements of test/fixtures/ap-fit-0.4.0.omm and xp-fit-0.4.0.omm (the 0.4.18
//   dist's $OMM: BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT); MEAN_ELEMENT_THEORY AP (5) and SGP4XP (1).
// - OD_DYNAMIC_PARAMETERS: DRAG_AREA_OVER_MASS and SRP_AREA_OVER_MASS, VALUE bit-equal to BTERM and AGOM.
// - FIT_STATISTICS: FIT_STATES, FIT_RMS_KM, ITERATIONS as the 0.4.0 COMMENT states them; CONVERGED true (the 0.4.0
//   COMMENT states no convergence: a set was emitted only on a converged or iteration-limited fit).
// - WEATHER_SOURCE THEORY_FLUX_MODEL (XP) and RECORDS (AP); the AP record's SPACE_WEATHER rows equal the supplied rows
//   field for field over the span, the day before the arc through the epoch's day plus FIT.WEATHER_HORIZON_DAYS (30):
//   2026-09-30 to 2026-10-31; rows one day short are refused weather-rows-short:2026-10-31; the XP record has none.
// - assertNoUserDefined on both records; a fit $PCF with ENABLE_DRAG is configuration-refused FORCES.ENABLE_DRAG; one
//   without ATMOSPHERE_MODEL is configuration-refused FORCES.ATMOSPHERE_MODEL.
// - No addParameter, USER_DEFINED_PARAMETERS or $OBD writer remains in src/fit_oem.inc.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/PRW/prwDynamicParameter.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath, packageRoot } from "./lib/module.mjs";
import { configuration, MSIS_FORCES, XP_FORCES } from "./lib/pcf.mjs";
import { inputs, spwRows } from "./lib/fixture-inputs.mjs";

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
  { name: "AP", fixture: "ap-fit-0.4.0.omm", config: configuration({ theory: "AP", forces: AP_FORCES }), spw: rows.bytes, theory: 5, weather: pcfWeatherSource.RECORDS },
  { name: "XP", fixture: "xp-fit-0.4.0.omm", config: configuration({ theory: "SGP4XP", forces: XP_FORCES }), spw: null, theory: 1, weather: pcfWeatherSource.THEORY_FLUX_MODEL },
];
const records = {};
for (const c of cases) {
  const r = await fit(c.config, c.spw);
  check(r.statusCode === 0, `${c.name} fit: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode !== 0) continue;
  check(r.outputs.length === 1 && r.outputs[0].portId === "elements" && r.outputs[0].typeRef?.fileIdentifier === "$OCM",
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
  for (const [field, got, want] of pairs) check(Object.is(got, want), `${c.name} ${field}: ${got} against the 0.4.0 ${want}`);
  check(me.MEAN_ELEMENT_THEORY === c.theory, `${c.name}: MEAN_ELEMENT_THEORY ${me.MEAN_ELEMENT_THEORY}, expected ${c.theory}`);
  const dyn = ocm.ORBIT_DETERMINATION?.OD_DYNAMIC_PARAMETERS ?? [];
  const drag = dyn.find((p) => p.PARAMETER === prwDynamicParameter.DRAG_AREA_OVER_MASS), srp = dyn.find((p) => p.PARAMETER === prwDynamicParameter.SRP_AREA_OVER_MASS);
  check(dyn.length === 2 && drag && srp && Object.is(drag.VALUE, me.BTERM) && Object.is(srp.VALUE, me.AGOM) && drag.SOLVED_FOR && srp.SOLVED_FOR,
    `${c.name}: OD_DYNAMIC_PARAMETERS ${JSON.stringify(dyn.map((p) => [p.PARAMETER, p.VALUE, p.SOLVED_FOR]))}`);
  const st = ocm.ORBIT_DETERMINATION?.FIT_STATISTICS ?? {};
  const comment = String(was.COMMENT);
  const states = Number(/(\d+) states fitted/.exec(comment)?.[1]), rms = /fit RMS ([\d.]+) km/.exec(comment)?.[1], iterations = Number(/(\d+) iterations/.exec(comment)?.[1]);
  check(st.FIT_STATES === states, `${c.name}: FIT_STATES ${st.FIT_STATES} against the 0.4.0 ${states}`);
  check(st.FIT_RMS_KM?.toFixed(6) === rms, `${c.name}: FIT_RMS_KM ${st.FIT_RMS_KM} against the 0.4.0 ${rms}`);
  check(st.ITERATIONS === iterations, `${c.name}: ITERATIONS ${st.ITERATIONS} against the 0.4.0 ${iterations}`);
  check(st.CONVERGED === true, `${c.name}: CONVERGED ${st.CONVERGED}`);
  check(st.FIT_START === "2026-10-01T00:00:00.000000" && st.FIT_STOP === "2026-10-02T00:00:00.000000", `${c.name}: arc ${st.FIT_START} to ${st.FIT_STOP}`);
  check(typeof st.PCF_CID === "string" && st.PCF_CID.startsWith("b"), `${c.name}: PCF_CID ${st.PCF_CID}`);
  check(ocm.PERTURBATIONS?.WEATHER_SOURCE === c.weather, `${c.name}: WEATHER_SOURCE ${ocm.PERTURBATIONS?.WEATHER_SOURCE}`);
  check(ocm.METADATA?.NORAD_CAT_ID === 90400 && ocm.METADATA?.OBJECT_DESIGNATOR === "90400" && ocm.METADATA?.INTERNATIONAL_DESIGNATOR === "2026-904A",
    `${c.name}: METADATA ${ocm.METADATA?.NORAD_CAT_ID} ${ocm.METADATA?.OBJECT_DESIGNATOR} ${ocm.METADATA?.INTERNATIONAL_DESIGNATOR}`);
  check(ocm.ORB_AVERAGING === "BROUWER" && (ocm.STATE_DATA ?? []).length === 0, `${c.name}: ORB_AVERAGING ${ocm.ORB_AVERAGING}, ${ocm.STATE_DATA?.length} state values`);
  check((ocm.PROVENANCE?.PRODUCER ?? "").startsWith("com.spacedatanetwork.sdn-ap-propagator 0.5.0"), `${c.name}: PRODUCER ${ocm.PROVENANCE?.PRODUCER}`);
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

// refusals by name
const refused = (label, r, code, field = null) =>
  check(r.statusCode !== 0 && r.errorCode === code && (field === null || String(r.errorMessage).startsWith(field)),
    `${label}: expected ${code}${field ? ` ${field}` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
const short = spwRows({ days: 33 });  // 2026-09-28 .. 2026-10-30
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
