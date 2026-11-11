#!/usr/bin/env node
// E2E (stack #433 part C, SPEC 12.5 "The geosynchronous class fitted to data far worse than its precise orbits"): a
// one-day set above the drag fitted at a data sigma of at least the threshold (0.151 km AP, 0.066 km SGP4XP: where
// every scaled s_e, s_i, s_l reaches the ABOVE row's) and at most 2.91 km, over a span of 0.9 to 1.05 times 24 h or
// 72 h, states every size as the geosynchronous SIGMA row's proportion times that sigma, share 0; elsewhere the ABOVE
// row.
// Model truth: the module's own flight of a geostationary set (n 1.0027 rev/day, e 0.0002, i 0.05, AGOM 0.015; AP caps
// 31 and 20, NRLMSISE-00 on constant daily rows; SGP4XP stock), in GCRF at 300 s, the arc ending at the cutoff, fitted
// on the default priors; a stated COVARIANCE_MATRIX_LINES puts the fit's data sigma (12.1) where the case needs it.
// 1. Stated 300 m over 72 h and 24 h, AP and SGP4XP: s_e, s_i, s_l and s_d are the row's per-km proportions times the
//    record's data sigma to 1e-5 (the record writes the sigma to six digits); NON_GRAVITATIONAL_SHARE 0.
// 2. Stated 50 m (AP) and 30 m (SGP4XP), under their thresholds, and 300 m over 48 h: the ABOVE row, s_d 0.
// 3. Every record flies with its covariance (propagate, COVARIANCE_MATRIX_LINES at 7 days).
// JS only moves bytes and compares numbers the module produced.
//   node test/covariance-geo-sigma-row.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
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
// SPEC 12.5's rows (src/covariance.inc kGsoSigmaAP, kGsoSigmaXP: per km of data sigma) and the ABOVE rows
const PER_KM = { AP: [1.8443393922366117e-05, 1.5194136674001825e-05, 3.141503657789266e-05, 6.571123466646167e-05],
  SGP4XP: [5.876802799646972e-06, 3.504351587051805e-05, 4.0198815288144715e-06, 1.2262905073802155e-05] };
const ABOVE = { AP: [9.696153866117182e-07, 8.153112791954473e-07, 4.753573962018311e-06], SGP4XP: [2.308e-07, 3.752e-07, 2.666e-07] };
const GEO = { n: 1.0027, e: 0.0002, i: 0.05, raan: 80, argp: 30, ma: 10, agom: 0.015, bterm: 0 };
const seedOf = (theory, epochMs) => theory === "AP"
  ? seedOcm({ epoch: iso(epochMs), ...GEO, norad: 99434, msis: true, records: true, tesseral: 31, zonal: 20, rows: spw })
  : seedOcm({ epoch: iso(epochMs), ...GEO, norad: 99434 });
async function fly(record, times) {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
}
async function fitOf(theory, hours, sigmaM) {
  const start = CUTOFF - hours * HOUR;
  const times = Array.from({ length: hours * 12 + 1 }, (_, k) => start + k * 300000);
  const lines = (await fly(seedOf(theory, start), times)).EPHEMERIS_DATA_LINES;
  const v = (sigmaM / 1000) ** 2;
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99434, OBJECT_NAME: "COVARIANCE GEO SIGMA ROW E2E" }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines,
    COVARIANCE_MATRIX_LINES: lines.map((l) => Object.assign(new CovLineT(), { EPOCH: l.EPOCH, CX_X: v, CY_Y: v, CZ_Z: v })) });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const config = theory === "AP" ? configuration({ theory: "AP", forces: AP_FORCES }) : configuration({ theory: "SGP4XP", forces: XP_FORCES });
  const r = await h.invoke({ methodId: "fit", inputs: [config, ...(theory === "AP" ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spwStream(spw) }] : []),
    { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  const record = new Uint8Array(r.outputs.find((x) => x.portId === "elements").payload);
  const o = ocmOf(record);
  const flown = await fly(record, [CUTOFF + 7 * DAY]);
  return { model: noiseOf(record), share: o.COV_PROPAGATION?.NON_GRAVITATIONAL_SHARE,
    sigmaKm: Number(/SIGMA ([0-9.e+-]+) KM/.exec(o.ORBIT_DETERMINATION?.OD_DATA_WEIGHTING ?? "")?.[1]), covLines: flown.COVARIANCE_MATRIX_LINES?.length ?? 0 };
}
const same = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1e-300);

for (const [name, theory, hours, sigmaM, want] of [
  ["AP, 72 h, 300 m", "AP", 72, 300, "SIGMA"],
  ["AP, 24 h, 300 m", "AP", 24, 300, "SIGMA"],
  ["AP, 72 h, 50 m", "AP", 72, 50, "ABOVE"],
  ["AP, 48 h, 300 m", "AP", 48, 300, "ABOVE"],
  ["SGP4XP, 72 h, 300 m", "SGP4XP", 72, 300, "SIGMA"],
  ["SGP4XP, 72 h, 30 m", "SGP4XP", 72, 30, "ABOVE"],
]) {
  const f = await fitOf(theory, hours, sigmaM);
  const [se, si, sl, sd] = f.model.noise;
  console.log(`${name}: regime ${f.model.regime}, data sigma ${(1000 * f.sigmaKm).toFixed(3)} m, noise s_e ${se} s_i ${si} s_l ${sl} s_d ${sd}, share ${f.share}; ` +
    `7-day covariance lines ${f.covLines}`);
  check(f.model.regime === "ABOVE", `${name}: regime ${f.model.regime}`);
  if (want === "SIGMA") {
    const exp = PER_KM[theory].map((p) => p * f.sigmaKm);
    const worst = Math.max(...[se, si, sl, sd].map((x, k) => Math.abs(x / exp[k] - 1)));
    check(worst <= 1e-5 && f.share === 0, `${name}: noise ${se} ${si} ${sl} ${sd}, not the SIGMA row's ${exp.join(" ")} (worst ${worst}); share ${f.share}`);
    check(se > ABOVE[theory][0] && si > ABOVE[theory][1] && sl > ABOVE[theory][2], `${name}: a scaled size under the ABOVE row's`);
  } else {
    const row = ABOVE[theory];
    check(same(se, row[0]) && same(si, row[1]) && same(sl, row[2]) && sd === 0 && f.share === 0, `${name}: noise ${se} ${si} ${sl} ${sd}, not the ABOVE row`);
  }
  check(f.covLines === 1, `${name}: the record flown 7 days gives ${f.covLines} covariance lines`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ncovariance geosynchronous SIGMA row E2E: PASS");
process.exit(0);
