#!/usr/bin/env node
// E2E (task modules-sdn-ap-osculating-opm-input-20261025): osculating input (SPEC 13), on synthetic $OPM records.
// - opm_set: a GEO, an HEO, a MEO and a LEO record (EME2000 Keplerian blocks, TRUE_ANOMALY, GM 398600.4418) give SDN-AP
//   sets (MEAN_ELEMENT_THEORY SDNAP, USER_DEFINED_SDNAP_SOURCE OSCULATING_OPM, the source elements, frame, GM, the
//   conversion); each set propagated to its epoch (EME2000 grid) reproduces the record's own state within 1 m.
// - The same records as state vectors, and in GCRF and TEME (rotated by the module), give the same sets (mean motion,
//   e, i within 1e-9 relative or degree).
// - propagate takes 'opm' frames directly: the same $OEM bytes as opm_set then propagate.
// - Forces: MASS with DRAG_AREA / DRAG_COEFF and SOLAR_RAD_AREA / SOLAR_RAD_COEFF give B = C_D A/m and AGOM = C_R A/m
//   (SDNAP_FORCES RECORD); without them the LAUNCH priors (B_eff 0.01 m^2/kg below a 2,500 km perigee, else 0; AGOM
//   0.01; SDNAP_FORCES REGIME_DEFAULT).
// - A COVARIANCE in EME2000 is carried rotated to TEME (position trace equal within 1e-12 relative) and
//   sdnap_covariance_at returns it at the epoch; a record without one gets none.
// - Refused by name: no-elements, unknown-frame, missing-gm, unsupported-time-system, unsupported-center.
// - sdnap_osculating_elements_about and sdnap_kepler_at: the elements of kepler_at(state, one period) are the state's
//   (a within 1e-9 relative, the anomaly within 1e-7 deg).
// - The committed derived sets (test/fixtures/opm/vimpel-derived-20261012.opm.gz, test/opm-derive.mjs): every 500th of
//   the stream through opm_set, each set at its epoch within 1 m of the record's own state, with the credit in COMMENT.
// JS only moves bytes and compares numbers the module produced.
//   node test/opm.e2e.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OPM, OPMT } from "spacedatastandards.org/lib/js/OPM/OPM.js";
import { FRAME_PROBE, jdOf, packOem, rfm, rotate } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x, mem = () => m.harness.memory.buffer;
const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const SDNAP = configuration({ theory: "SDNAP" });
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const opmType = { schemaName: "OPM.fbs", fileIdentifier: "$OPM", rootTypeName: "OPM" };
const GM = 398600.4418, EPOCH = "2026-10-12T22:37:45.000Z";
const opmBytes = (fields) => {
  const t = Object.assign(new OPMT(), { CCSDS_OPM_VERS: "2.0", ORIGINATOR: "SDN-AP OPM E2E", CENTER_NAME: "EARTH", REF_FRAME: "EME2000", TIME_SYSTEM: "UTC", EPOCH, GM }, fields);
  const b = new flatbuffers.Builder(1024);
  OPM.finishSizePrefixedOPMBuffer(b, t.pack(b));
  return b.asUint8Array();
};
const opmIn = (payload) => ({ portId: "opm", typeRef: opmType, payload });
const opmSet = async (payload, config = SDNAP) => command.invoke({ methodId: "opm_set", inputs: [config, opmIn(payload)] });
const setOf = (r) => OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack();
const ud = (t) => Object.fromEntries(t.USER_DEFINED_PARAMETERS.map((u) => [u.PARAM_NAME, u.PARAM_VALUE]));
const p = x.sdnap_alloc(512), f64 = (o, n) => new Float64Array(mem(), p + o, n);
const deg = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

// a set's state at the record's epoch, through propagate on an explicit-epoch grid in `frame`
async function epochState(ommPayload, frame = "EME2000") {
  const g = await command.invoke({ methodId: "propagate", inputs: [SDNAP, { portId: "omm", typeRef: ommType, payload: ommPayload }, { portId: "grid", typeRef: oemType, payload: gridAt(frame, [EPOCH.replace("Z", "")]) }] });
  if (g.statusCode !== 0) throw new Error(`propagate: ${g.errorCode} ${g.errorMessage}`);
  const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(g.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
  return [L.X, L.Y, L.Z, L.X_DOT, L.Y_DOT, L.Z_DOT];
}
function gridAt(frame, epochs) {
  const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(baseOem)).unpack();
  const b = t.EPHEMERIS_DATA_BLOCK[0];
  b.REFERENCE_FRAME = rfm(frame);
  b.EPHEMERIS_DATA_LINES = epochs.map((e) => new ephemerisDataLineT(e));
  b.START_TIME = epochs[0]; b.STOP_TIME = epochs.at(-1); b.STEP_SIZE = 0;
  return packOem(t);
}
// a template $OEM (one state) from the module, for the grids
const baseOem = await (async () => {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(EPOCH.replace("Z", ""));
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addMeanMotion(b, 1.0027); OMM.addEccentricity(b, 0.0002); OMM.addInclination(b, 0.1); OMM.addNoradCatId(b, 90002); OMM.addMeanElementTheory(b, 1);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  const r = await command.invoke({ methodId: "propagate", inputs: [configuration({}), { portId: "omm", typeRef: ommType, payload: b.asUint8Array() }] });
  const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack();
  t.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES = t.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.slice(0, 1);
  return packOem(t);
})();

const cases = [
  { label: "GEO", el: { SEMI_MAJOR_AXIS: 42166.3, ECCENTRICITY: 0.000187, INCLINATION: 0.158, RA_OF_ASC_NODE: 97.791, ARG_OF_PERICENTER: 108.347, TRUE_ANOMALY: 247.353 } },
  { label: "HEO", el: { SEMI_MAJOR_AXIS: 24974.9, ECCENTRICITY: 0.68526, INCLINATION: 34.018, RA_OF_ASC_NODE: 243.148, ARG_OF_PERICENTER: 189.804, TRUE_ANOMALY: 170.3 } },
  { label: "MEO", el: { SEMI_MAJOR_AXIS: 26560.0, ECCENTRICITY: 0.012, INCLINATION: 55.1, RA_OF_ASC_NODE: 12.0, ARG_OF_PERICENTER: 40.0, TRUE_ANOMALY: 300.0 } },
  { label: "LEO", el: { SEMI_MAJOR_AXIS: 7078.0, ECCENTRICITY: 0.0011, INCLINATION: 98.2, RA_OF_ASC_NODE: 200.0, ARG_OF_PERICENTER: 90.0, TRUE_ANOMALY: 10.0 } },
];
for (const c of cases) {
  const kep = opmBytes({ OBJECT_NAME: `OPM E2E ${c.label}`, ...c.el });
  const r = await opmSet(kep);
  if (r.statusCode !== 0) { failures.push(`${c.label} opm_set: ${r.errorCode} ${r.errorMessage}`); continue; }
  const set = setOf(r), u = ud(set);
  check(set.MEAN_ELEMENT_THEORY === 4 && u.SDNAP_SOURCE === "OSCULATING_OPM" && u.SDNAP_SOURCE_ELEMENTS === "KEPLERIAN" && u.SDNAP_SOURCE_FRAME === "EME2000" &&
    Number(u.SDNAP_SOURCE_GM) === GM && u.SDNAP_CONVERSION === "INVERSE_MAP" && u.SDNAP_FORCES === "REGIME_DEFAULT", `${c.label}: provenance rows ${JSON.stringify(u)}`);
  // the set at its epoch against the record's state (the module's conversion of the record, through a state OPM below)
  const s = await epochState(r.outputs[0].payload);
  f64(0, 6).set(s);
  check(x.sdnap_osculating_elements_about(p, p + 24, GM, p + 48) === 0, `${c.label}: elements of the epoch state`);
  const back = Array.from(f64(48, 8));
  const dA = Math.abs(back[0] - c.el.SEMI_MAJOR_AXIS) * 1e3, dNu = deg(back[5], c.el.TRUE_ANOMALY);
  const dang = Math.max(deg(back[2], c.el.INCLINATION), c.el.INCLINATION > 1 ? deg(back[3], c.el.RA_OF_ASC_NODE) : 0);
  console.log(`${c.label}: set n ${set.MEAN_MOTION.toFixed(8)} rev/day, e ${set.ECCENTRICITY.toFixed(6)} (record e ${c.el.ECCENTRICITY}); epoch state back to the record's elements: a ${dA.toExponential(2)} m, angles ${dang.toExponential(2)} deg, true anomaly ${dNu.toExponential(2)} deg; ${u.SDNAP_CONVERSION_STEPS} inverse-map steps; B_eff ${set.BSTAR}, AGOM ${set.MEAN_MOTION_DDOT}`);
  check(dA <= 1.0 && dang <= 1e-6 && (c.el.ECCENTRICITY < 0.001 || dNu <= 1e-5), `${c.label}: epoch state ${dA} m, ${dang} deg, nu ${dNu}`);
  const perigeeKm = c.el.SEMI_MAJOR_AXIS * (1 - c.el.ECCENTRICITY) - 6378.137;  // the record's own numbers: which default applies
  check(perigeeKm < 2500 ? set.BSTAR === 0.01 : set.BSTAR === 0, `${c.label}: regime default B_eff ${set.BSTAR} (perigee ${perigeeKm.toFixed(0)} km)`);
  check(set.MEAN_MOTION_DDOT === 0.01, `${c.label}: default AGOM ${set.MEAN_MOTION_DDOT}`);
  // the same orbit as a state vector, and in GCRF and TEME
  const variants = [["state, EME2000", { REF_FRAME: "EME2000", X: s[0], Y: s[1], Z: s[2], X_DOT: s[3], Y_DOT: s[4], Z_DOT: s[5] }]];
  const t = jdOf(EPOCH.replace("Z", ""));
  for (const [frame, mode] of [["GCRF", FRAME_PROBE.TEME_TO_GCRF], ["TEME", null]]) {
    const teme = await epochState(r.outputs[0].payload, "TEME");
    const st = mode === null ? teme : rotate(m, t.whole, t.frac, teme, mode).out;
    variants.push([`state, ${frame}`, { REF_FRAME: frame, X: st[0], Y: st[1], Z: st[2], X_DOT: st[3], Y_DOT: st[4], Z_DOT: st[5] }]);
  }
  for (const [label, fields] of variants) {
    const rv = await opmSet(opmBytes({ OBJECT_NAME: `OPM E2E ${c.label}`, ...fields }));
    if (rv.statusCode !== 0) { failures.push(`${c.label} ${label}: ${rv.errorCode} ${rv.errorMessage}`); continue; }
    const sv = setOf(rv);
    const dn = Math.abs(sv.MEAN_MOTION / set.MEAN_MOTION - 1), di = deg(sv.INCLINATION, set.INCLINATION);
    check(dn <= 1e-9 && Math.abs(sv.ECCENTRICITY - set.ECCENTRICITY) <= 1e-9 && di <= 1e-7 && ud(sv).SDNAP_SOURCE_ELEMENTS === "STATE", `${c.label} ${label}: n ${dn}, e, i ${di}`);
  }
  // propagate with the 'opm' frame directly: the same $OEM as opm_set + propagate
  const g = { portId: "grid", typeRef: oemType, payload: gridAt("EME2000", [EPOCH.replace("Z", ""), "2026-10-13T22:37:45.000", "2026-10-15T22:37:45.000"]) };
  const direct = await command.invoke({ methodId: "propagate", inputs: [SDNAP, opmIn(kep), g] });
  const viaSet = await command.invoke({ methodId: "propagate", inputs: [SDNAP, { portId: "omm", typeRef: ommType, payload: r.outputs[0].payload }, g] });
  const same = direct.statusCode === 0 && Buffer.compare(Buffer.from(direct.outputs[0].payload), Buffer.from(viaSet.outputs[0].payload)) === 0;
  check(same, `${c.label}: propagate 'opm' vs opm_set + propagate: ${direct.errorCode}`);
}

// forces from the record
{
  const r = await opmSet(opmBytes({ ...cases[3].el, MASS: 100, DRAG_AREA: 1, DRAG_COEFF: 2.2, SOLAR_RAD_AREA: 2, SOLAR_RAD_COEFF: 1.3 }));
  const set = setOf(r), u = ud(set);
  console.log(`forces from the record: B_eff ${set.BSTAR}, AGOM ${set.MEAN_MOTION_DDOT} (${u.SDNAP_FORCES})`);
  check(Math.abs(set.BSTAR - 0.022) <= 1e-15 && Math.abs(set.MEAN_MOTION_DDOT - 0.026) <= 1e-15 && u.SDNAP_FORCES === "RECORD", "forces from MASS and the areas");
  const r2 = await opmSet(opmBytes({ ...cases[3].el, MASS: 50, DRAG_AREA: 1, SOLAR_RAD_AREA: 1 }));
  const s2 = setOf(r2);
  check(Math.abs(s2.BSTAR - 2.2 / 50) <= 1e-15 && Math.abs(s2.MEAN_MOTION_DDOT - 1.0 / 50) <= 1e-15, `default coefficients: ${s2.BSTAR} ${s2.MEAN_MOTION_DDOT}`);
}

// covariance
{
  const C = [1e-2, 1e-3, 2e-2, 1e-4, 2e-4, 3e-2, 1e-6, 2e-6, 3e-6, 1e-8, 2e-6, 1e-6, 4e-6, 1e-9, 2e-8, 3e-6, 2e-6, 1e-6, 1e-9, 1e-9, 3e-8];
  const r = await opmSet(opmBytes({ ...cases[0].el, COV_REF_FRAME: "EME2000", COVARIANCE: C }));
  const set = setOf(r), u = ud(set);
  const tr = (v) => v[0] + v[2] + v[5];
  const dtr = Math.abs(tr(set.COVARIANCE) / tr(C) - 1);
  const po = x.sdnap_alloc(r.outputs[0].payload.length), pm = x.sdnap_alloc(8), pout = x.sdnap_alloc(8 * 42);
  new Uint8Array(mem(), po, r.outputs[0].payload.length).set(r.outputs[0].payload);
  new Float64Array(mem(), pm, 1).set([0]);
  const st = x.sdnap_covariance_at(po, r.outputs[0].payload.length, pm, 1, pout);
  const P = Array.from(new Float64Array(mem(), pout + 48, 36));
  const lower = []; for (let i = 0; i < 6; ++i) for (let j = 0; j <= i; ++j) lower.push(P[i * 6 + j]);
  const rt = Math.hypot(...lower.map((v, k) => v - set.COVARIANCE[k])) / Math.hypot(...set.COVARIANCE);
  console.log(`covariance: TEME position trace vs EME2000's ${dtr.toExponential(2)}; sdnap_covariance_at at the epoch ${st}, ${rt.toExponential(2)} relative; noise ${u.SDNAP_COV_NOISE}`);
  check(set.COVARIANCE.length === 21 && set.COV_REFERENCE_FRAME?.NAME === "TEME" && dtr <= 1e-12 && st === 0 && rt <= 1e-9 && u.SDNAP_COV_NOISE?.split(" ").length === 6, "covariance carried");
  const none = setOf(await opmSet(opmBytes(cases[0].el)));
  check(none.COVARIANCE.length === 0, "no covariance made");
}

// refusals
for (const [label, fields, code] of [
  ["no elements", { SEMI_MAJOR_AXIS: 0 }, "no-elements"],
  ["ITRF", { ...cases[0].el, REF_FRAME: "ITRF" }, "unknown-frame"],
  ["no GM", { ...cases[0].el, GM: 0 }, "missing-gm"],
  ["TAI", { ...cases[0].el, TIME_SYSTEM: "TAI" }, "unsupported-time-system"],
  ["Moon", { ...cases[0].el, CENTER_NAME: "MOON" }, "unsupported-center"],
]) {
  const r = await opmSet(opmBytes(fields));
  check(r.statusCode !== 0 && r.errorCode === code, `${label}: ${r.errorCode}`);
}
const empty = await command.invoke({ methodId: "propagate", inputs: [SDNAP] });
check(empty.statusCode !== 0 && empty.errorCode === "missing-omm", `propagate with neither: ${empty.errorCode}`);

// the committed derived sets
{
  const bytes = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/opm/vimpel-derived-20261012.opm.gz", import.meta.url)));
  const recs = [];
  for (let off = 0; off + 4 <= bytes.length; off += 4 + bytes.readUInt32LE(off)) recs.push(new Uint8Array(bytes.subarray(off, off + 4 + bytes.readUInt32LE(off))));
  let worst = 0, n = 0, credited = 0;
  for (let k = 0; k < recs.length; k += 500) {
    const rec = OPM.getSizePrefixedRootAsOPM(new flatbuffers.ByteBuffer(recs[k])).unpack();
    const r = await opmSet(recs[k]);
    if (r.statusCode !== 0) { failures.push(`derived ${rec.OBJECT_NAME}: ${r.errorCode} ${r.errorMessage}`); continue; }
    const g = await command.invoke({ methodId: "propagate", inputs: [SDNAP, { portId: "omm", typeRef: ommType, payload: r.outputs[0].payload }, { portId: "grid", typeRef: oemType, payload: gridAt("EME2000", [rec.EPOCH.replace("Z", "")]) }] });
    const L = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(g.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
    worst = Math.max(worst, Math.hypot(L.X - rec.X, L.Y - rec.Y, L.Z - rec.Z) * 1e3);
    credited += rec.COMMENT?.startsWith("Derived from JSC Vimpel orbit data (spacedata.vimpel.ru)") ? 1 : 0;
    ++n;
  }
  console.log(`committed derived sets: ${recs.length} records; ${n} through opm_set, worst epoch state ${worst.toExponential(2)} m; credited ${credited}`);
  check(recs.length > 13000 && n >= 20 && worst <= 1.0 && credited === n, `derived sets: ${n}, ${worst} m, ${credited} credited`);
}

// the exports: one period of two-body motion returns the elements
{
  let worstA = 0, worstM = 0;
  for (const c of cases) {
    const s = await epochState((await opmSet(opmBytes(c.el))).outputs[0].payload);
    f64(0, 6).set(s);
    x.sdnap_osculating_elements_about(p, p + 24, GM, p + 48);
    const e0 = Array.from(f64(48, 8));
    x.sdnap_kepler_at(p, p + 24, GM, e0[7], p + 112);
    x.sdnap_osculating_elements_about(p + 112, p + 136, GM, p + 160);
    const e1 = Array.from(f64(160, 8));
    worstA = Math.max(worstA, Math.abs(e1[0] / e0[0] - 1)); worstM = Math.max(worstM, deg(e1[6], e0[6]));
  }
  console.log(`sdnap_kepler_at over one period: a ${worstA.toExponential(2)} relative, mean anomaly ${worstM.toExponential(2)} deg`);
  check(worstA <= 1e-9 && worstM <= 1e-7, `kepler round trip ${worstA} ${worstM}`);
}

console.log(failures.length === 0 ? "\nopm E2E: PASS" : `\nopm E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
