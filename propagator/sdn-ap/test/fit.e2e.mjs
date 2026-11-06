#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-write-20261103): fit writes one typed $OCM per block, and nothing else.
// - On the inputs of the 0.4.0 fixtures (test/lib/fixture-inputs.mjs): 24 h of propagator/ffm's 550 km trajectory,
//   fitted under AP's forces (gravity caps 31 and 20, NRLMSISE-00 on daily $SPW rows) and under stock SGP4XP (Jacchia
//   1970 on the theory's flux model), fit returns exactly two outputs, 'elements', an $OCM, then 'residuals', its $ODR
//   (SPEC 17.4).
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
// - 0.6.4 (SPEC 16.11's tesseral switch by class: class 0 sets fly the grid above e 0.05) against the 0.6.3 dist (git, modules
//   03ee86234, its SHA-256 checked), on these
//   low-eccentricity fits: each fit's $OCM is byte-identical once PRODUCER's version is read as 0.6.3; each fit's $ODR
//   names its own $OCM (RUN_ID and OCM_CONTENT_ID are the CID of that version's $OCM bytes, so they differ by PRODUCER
//   alone) and, those two fields excluded, every decoded value of the two $ODR is identical (Object.is); each set's
//   sdnap_covariance_at at every fixture grid time (state and covariance, 42 doubles a time) and its propagate $OEM in
//   EME2000 and TEME every 6 h for 7 days are byte-identical (the $OEM with PRODUCER's version read likewise). With
//   SDNAP_EXAMPLES set to the published examples (each <id>.ocm and <id>.json), every set outside the band the switch moves
//   (class 0 by the SPEC 6 bands of its mean motion with 0.05 < e <= 0.3; the 56 published sets are all outside it) flies
//   byte-identical on both builds at every epoch of its window and its sdnap_covariance_at at every 12th epoch is
//   bit-identical; a set above e 0.3 (the grid's on both) or in the band (the grid's on 0.6.4 alone) flies on both and is
//   counted apart (masked), its count stated.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit.e2e.mjs
import fs from "node:fs";
import os from "node:os";
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
  check((ocm.PROVENANCE?.PRODUCER ?? "").startsWith("com.spacedatanetwork.sdn-ap-propagator 0.6.4"), `${c.name}: PRODUCER ${ocm.PROVENANCE?.PRODUCER}`);
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-ap-fit-e2e-"));
const beforePath = path.join(scratch, `module-${BEFORE.version}.wasm`);
fs.writeFileSync(beforePath, beforeBytes);
const before = await createStandaloneHarness("browser", beforePath, { surface: "direct" });
const now = JSON.parse(fs.readFileSync(`${packageRoot}plugin-manifest.json`, "utf8")).version;
const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
const asBefore = (bytes) => { const b = Buffer.from(bytes); for (let at = b.indexOf(producer(now)); at >= 0; at = b.indexOf(producer(now), at + 1)) producer(BEFORE.version).copy(b, at); return b; };
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
let identical = 0, flown = 0;
for (const c of cases) {
  const [r2, r1] = [await fit(c.config, c.spw), await before.invoke({ methodId: "fit", inputs: [
    { portId: "ephemeris", typeRef: T("OEM"), payload: arc }, c.config, ...(c.spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: c.spw }] : [])] })];
  if (r2.statusCode !== 0 || r1.statusCode !== 0) { check(false, `${c.name}: fit on ${now} ${r2.errorCode}, on ${BEFORE.version} ${r1.errorCode}`); continue; }
  check(r2.outputs.length === r1.outputs.length, `${c.name}: ${r2.outputs.length} outputs on ${now}, ${r1.outputs.length} on ${BEFORE.version}`);
  const [ocm2, ocm1] = [new Uint8Array(r2.outputs[0].payload), new Uint8Array(r1.outputs[0].payload)];
  const ocmSame = asBefore(ocm2).equals(Buffer.from(ocm1));
  check(ocmSame, `${c.name} fit ${r2.outputs[0].portId}: ${now} differs from ${BEFORE.version}`);
  if (ocmSame) identical += 1;
  const [d2, d1] = [odrOf(new Uint8Array(r2.outputs[1].payload)), odrOf(new Uint8Array(r1.outputs[1].payload))];
  const named = [[now, d2, ocm2], [BEFORE.version, d1, ocm1]].every(([v, d, o]) => ODR_NAMES_OCM.every((f) => {
    const ok = d[f] === cidOf(o);
    check(ok, `${c.name} $ODR ${f} on ${v}: ${d[f]}, its $OCM is ${cidOf(o)}`);
    return ok;
  }));
  for (const f of ODR_NAMES_OCM) { delete d2[f]; delete d1[f]; }
  const [compared, first] = sameValues(d2, d1);
  check(first === null, `${c.name} fit ${r2.outputs[1].portId}: ${now} differs from ${BEFORE.version} at ${first}`);
  if (named && first === null) { identical += 1; odrValues += compared; }
  const set = new Uint8Array(r1.outputs[0].payload);
  const [a2, a1] = [covarianceAt(h, set), covarianceAt(before, set)];
  check(a2.status === 0 && a1.status === 0 && a2.out.equals(a1.out), `${c.name} sdnap_covariance_at: ${now} (${a2.status}) differs from ${BEFORE.version} (${a1.status})`);
  if (a2.status === 0 && a2.out.equals(a1.out)) identical += 1;
  for (const frame of [pcfOutputFrame.EME2000, pcfOutputFrame.TEME]) {
    const [p2, p1] = [await flight(h, set, frame), await flight(before, set, frame)];
    const same = p2.statusCode === 0 && p1.statusCode === 0 && asBefore(new Uint8Array(p2.outputs[0].payload)).equals(Buffer.from(new Uint8Array(p1.outputs[0].payload)));
    check(same, `${c.name} propagate (${pcfOutputFrame[frame]}): ${now} ${p2.statusCode ? p2.errorCode : "ok"} differs from ${BEFORE.version} ${p1.statusCode ? p1.errorCode : "ok"}`);
    if (same) { identical += 1; flown += EPOCHS.length; }
  }
}
console.log(`${now} against ${BEFORE.version} (${BEFORE.sha256.slice(0, 8)}): ${identical} of 10 products identical (fit $OCM, ` +
  `sdnap_covariance_at at ${minutes.length} times, propagate $OEM at ${flown} epochs byte-identical, PRODUCER's version aside; ` +
  `fit $ODR ${odrValues} decoded values identical, ${ODR_NAMES_OCM.join(" and ")} excluded: each is the CID of its own version's $OCM)`);
check(identical === 10, `${identical} of 10 products identical to ${BEFORE.version}`);

// the published examples' sets (SDNAP_EXAMPLES: the experiments' results/ap-truth/compare/examples, each <id>.ocm the $OCM
// AP flew and <id>.json its window): each flown on both builds in TEME at every epoch of its window (propagate $OEM
// byte-identical, PRODUCER's version aside) and sdnap_covariance_at at every 12th epoch (42 doubles a time, bit-identical)
const EXAMPLES = process.env.SDNAP_EXAMPLES;
if (!EXAMPLES) console.log("examples: SDNAP_EXAMPLES not given, the published examples not flown");
else {
  const ids = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".ocm")).map((f) => f.slice(0, -4)).sort();
  let same = 0, epochsFlown = 0, timesCovered = 0, wide = 0, moved = 0;
  for (const id of ids) {
    const d = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${id}.json`), "utf8")), set = new Uint8Array(fs.readFileSync(path.join(EXAMPLES, `${id}.ocm`)));
    const me = ocmOf(set).MEAN_ELEMENTS;
    if (me.ECCENTRICITY > 0.3 || movedBand(me)) {  // SPEC 16.11: the grid's on both (above 0.3) or on 0.6.4 alone (the band); flies on both, masked
      const fly = (harness) => harness.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: set },
        configuration({ output: { FRAME: pcfOutputFrame.TEME, EPOCHS: [new Date(Date.parse(d.start)).toISOString().replace("Z", "")] } })] });
      const [p2, p1] = [await fly(h), await fly(before)];
      check(p2.statusCode === 0 && p1.statusCode === 0, `example ${id} (${me.ECCENTRICITY > 0.3 ? "e above 0.3" : "the band"}) propagate: ${p2.errorCode ?? "ok"} | ${p1.errorCode ?? "ok"}`);
      if (me.ECCENTRICITY > 0.3) wide += 1; else moved += 1;
      continue;
    }
    const t0 = Date.parse(d.start), setMs = Date.parse(`${ocmOf(set).MEAN_ELEMENTS.EPOCH.slice(0, 23)}Z`);
    const epochs = d.epochsSeconds.map((s) => new Date(t0 + 1000 * s).toISOString().replace("Z", ""));
    const times = d.epochsSeconds.filter((_, k) => k % 12 === 0).map((s) => (t0 + 1000 * s - setMs) / 60000);
    const fly = (harness) => harness.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: set },
      configuration({ output: { FRAME: pcfOutputFrame.TEME, EPOCHS: epochs } })] });
    const [p2, p1] = [await fly(h), await fly(before)];
    const flownSame = p2.statusCode === 0 && p1.statusCode === 0 && asBefore(new Uint8Array(p2.outputs[0].payload)).equals(Buffer.from(new Uint8Array(p1.outputs[0].payload)));
    check(flownSame, `example ${id} propagate: ${now} ${p2.statusCode ? p2.errorCode : "ok"} differs from ${BEFORE.version} ${p1.statusCode ? p1.errorCode : "ok"}`);
    const [a2, a1] = [covarianceAt(h, set, times), covarianceAt(before, set, times)];
    const covSame = a2.status === 0 && a1.status === 0 && a2.out.equals(a1.out);
    check(covSame, `example ${id} sdnap_covariance_at: ${now} (${a2.status}) differs from ${BEFORE.version} (${a1.status})`);
    if (flownSame && covSame) { same += 1; epochsFlown += epochs.length; timesCovered += times.length; }
  }
  const low = ids.length - wide - moved;
  console.log(`examples: ${same} of ${low} sets outside the band identical on ${now} and ${BEFORE.version} (propagate $OEM at ${epochsFlown} ` +
    `epochs byte-identical, PRODUCER's version aside; sdnap_covariance_at at ${timesCovered} times bit-identical)` +
    (same === low ? ": 0 difference" : `; ${low - same} differ`) + `; ${wide} above e 0.3 and ${moved} in the band (class 0, 0.05 < e <= 0.3) flown on both, masked`);
  check(low > 0 && same === low, `examples: ${same} of ${low} sets outside the band identical to ${BEFORE.version}`);
}
fs.rmSync(scratch, { recursive: true, force: true });

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
