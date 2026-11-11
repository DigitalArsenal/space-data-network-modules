#!/usr/bin/env node
// E2E (stack #433, SPEC 12.5 "Above the drag, by class"): a set above the drag takes its class's process noise only
// inside the class's calibrated condition, and the record states it; elsewhere the ABOVE row stands.
// Model truth: the module's own flights of sets with a known AGOM (AP: caps 31 and 20, NRLMSISE-00 on constant daily
// rows; SGP4XP: stock), in GCRF at 300 s, the arc ending at the cutoff; fitted on the module's default priors (no FIT
// table). A stated COVARIANCE_MATRIX_LINES puts the fit's data sigma (12.1: not below the block's stated sigma) where
// the case needs it.
// 1. LAGEOS class (n 6.386 rev/day, e 0.0045), 72 h, stated 2.6 m: AP's record states the LAGEOS row (s_e, s_i, s_l)
//    exactly and s_d = k |AGOM| / a (a in Earth radii, from the record's MEAN_MOTION) to 1e-5, NON_GRAVITATIONAL_SHARE 0. Stated 5 m (above the calibrated
//    2.43 to 2.76 m): the ABOVE row. The same orbit fitted over 24 h (outside the calibrated 64.8 to 75.6 h): the ABOVE
//    row. SGP4XP over 72 h with 65 m stated: SGP4XP's LAGEOS row.
// 2. HEO (n 0.4 rev/day, e 0.6), 72 h, stated 100 m: AP's and SGP4XP's HEO rows; stated 5 km (above the calibrated
//    7.67 m to 4.22 km): the ABOVE row. Medium Earth orbit (GPS-like), 72 h, stated 3 m: the ABOVE row (the class has
//    no row).
// 3. Every record above flies with its covariance (propagate, COVARIANCE_MATRIX_LINES at 7 days), so a stated s_d above
//    the drag is read back.
// JS only moves bytes and compares numbers the module produced.
//   node test/covariance-above-classes.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as LineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { covarianceMatrixLineT as CovLineT } from "spacedatastandards.org/lib/js/OEM/covarianceMatrixLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { T, AP_FORCES, ocmOf, seedOcm, rowsThrough, spwStream, flight, noiseOf } from "./lib/ocm.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const HOUR = 3600000, DAY = 86400000, CUTOFF = Date.parse("2026-09-04T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const rows = [];
for (let k = -6; k <= 45; k++) rows.push({ DATE: new Date(CUTOFF + k * DAY).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: 0 });
const spw = rowsThrough(rows);
const KE = 0.07436691613317342;  // er^1.5 / min, the theory's
const aEr = (n) => (KE / (n * 2 * Math.PI / 1440)) ** (2 / 3);
// SPEC 12.5's rows (src/covariance.inc kAboveAP, kAboveXP) and the ABOVE rows (kNoiseAP[1], kNoiseXP[1])
const ROW = {
  AP: { LAGEOS: [1.1374623058968726e-08, 8.083584088270014e-08, 3.831472309446551e-09, 1.415e-05],
    HEO: [6.357465071432782e-06, 8.153112791954473e-07, 4.753573962018311e-06, 2.401038715861921e-09],
    ABOVE: [9.696153866117182e-07, 8.153112791954473e-07, 4.753573962018311e-06] },
  SGP4XP: { LAGEOS: [2.463673468245377e-07, 6.564224575525169e-07, 5.502200043625398e-08, 3.216e-05],
    HEO: [6.406459698609395e-06, 8.962738267352311e-07, 2.666e-07, 1.667570181154198e-08],
    ABOVE: [2.308e-07, 3.752e-07, 2.666e-07] },
};
const ORBITS = {
  lageos: { n: 6.386, e: 0.0045, i: 109.8, raan: 40, argp: 120, ma: 10, agom: 0.0007, bterm: 0.001 },
  heo: { n: 0.4, e: 0.6, i: 28.5, raan: 60, argp: 180, ma: 10, agom: 0.01, bterm: 0.01 },
  gps: { n: 2.0057, e: 0.01, i: 55, raan: 80, argp: 30, ma: 10, agom: 0.02, bterm: 0 },
};
const seedOf = (o, theory, epochMs) => theory === "AP"
  ? seedOcm({ epoch: iso(epochMs), n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: o.ma, bterm: o.bterm, agom: o.agom, norad: 99433, msis: true, records: true, tesseral: 31, zonal: 20, rows: spw })
  : seedOcm({ epoch: iso(epochMs), n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: o.ma, bterm: o.bterm, agom: o.agom, norad: 99433 });
async function fly(record, times) {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
}
/** The fit of the orbit's own flight over `hours` before CUTOFF, `sigmaM` stated per component; the record and its noise. */
async function fitOf(o, theory, hours, sigmaM) {
  const start = CUTOFF - hours * HOUR;
  const times = Array.from({ length: hours * 12 + 1 }, (_, k) => start + k * 300000);
  const lines = (await fly(seedOf(o, theory, start), times)).EPHEMERIS_DATA_LINES;
  const v = (sigmaM / 1000) ** 2;
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99433, OBJECT_NAME: "COVARIANCE ABOVE CLASSES E2E" }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines,
    COVARIANCE_MATRIX_LINES: lines.map((l) => Object.assign(new CovLineT(), { EPOCH: l.EPOCH, CX_X: v, CY_Y: v, CZ_Z: v })) });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const config = theory === "AP" ? configuration({ theory: "AP", forces: AP_FORCES }) : configuration({ theory: "SGP4XP", forces: XP_FORCES });
  const r = await h.invoke({ methodId: "fit", inputs: [config, ...(theory === "AP" ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spwStream(spw) }] : []),
    { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  const record = new Uint8Array(r.outputs.find((x) => x.portId === "elements").payload);
  const o2 = ocmOf(record);
  const flown = await fly(record, [CUTOFF + 7 * DAY]);
  return { record, model: noiseOf(record), me: o2.MEAN_ELEMENTS, share: o2.COV_PROPAGATION?.NON_GRAVITATIONAL_SHARE,
    sigmaKm: Number(/SIGMA ([0-9.e+-]+) KM/.exec(o2.ORBIT_DETERMINATION?.OD_DATA_WEIGHTING ?? "")?.[1]), covLines: flown.COVARIANCE_MATRIX_LINES?.length ?? 0 };
}
const same = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1e-300);

for (const [name, o, theory, hours, sigmaM, want] of [
  ["LAGEOS class, AP, 72 h, 2.6 m", ORBITS.lageos, "AP", 72, 2.6, "LAGEOS"],
  ["LAGEOS class, AP, 72 h, 5 m", ORBITS.lageos, "AP", 72, 5, "ABOVE"],
  ["LAGEOS class, AP, 24 h, 2.6 m", ORBITS.lageos, "AP", 24, 2.6, "ABOVE"],
  ["LAGEOS class, SGP4XP, 72 h, 65 m", ORBITS.lageos, "SGP4XP", 72, 65, "LAGEOS"],
  ["HEO, AP, 72 h, 100 m", ORBITS.heo, "AP", 72, 100, "HEO"],
  ["HEO, AP, 72 h, 5 km", ORBITS.heo, "AP", 72, 5000, "ABOVE"],
  ["HEO, SGP4XP, 72 h, 100 m", ORBITS.heo, "SGP4XP", 72, 100, "HEO"],
  ["medium Earth orbit, AP, 72 h, 3 m", ORBITS.gps, "AP", 72, 3, "ABOVE"],
]) {
  const f = await fitOf(o, theory, hours, sigmaM);
  const [se, si, sl, sd] = f.model.noise;
  const row = ROW[theory][want];
  console.log(`${name}: regime ${f.model.regime}, data sigma ${(1000 * f.sigmaKm).toFixed(3)} m, noise s_e ${se} s_i ${si} s_l ${sl} s_d ${sd}, share ${f.share}, AGOM ${f.me.AGOM}; ` +
    `7-day covariance lines ${f.covLines}`);
  check(f.model.regime === "ABOVE", `${name}: regime ${f.model.regime}`);
  check(same(se, row[0]) && same(si, row[1]) && same(sl, row[2]), `${name}: noise ${se} ${si} ${sl}, not the ${want} row ${row.slice(0, 3).join(" ")}`);
  if (want === "ABOVE") check(sd === 0 && f.share === 0, `${name}: the ABOVE row's s_d ${sd} and share ${f.share}, not 0`);
  // the record's MEAN_MOTION and AGOM reproduce the module's s_d to about 5e-7 relative (the record's mean motion is not
  // the row's to the last digit), so to 1e-5
  else check(Math.abs(sd / (row[3] * Math.abs(f.me.AGOM) / aEr(f.me.MEAN_MOTION)) - 1) <= 1e-5 && f.share === 0,
    `${name}: s_d ${sd}, not k |AGOM| / a = ${row[3] * Math.abs(f.me.AGOM) / aEr(f.me.MEAN_MOTION)}; share ${f.share}`);
  check(f.covLines === 1, `${name}: the record flown 7 days gives ${f.covLines} covariance lines`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ncovariance above-classes E2E: PASS");
process.exit(0);
