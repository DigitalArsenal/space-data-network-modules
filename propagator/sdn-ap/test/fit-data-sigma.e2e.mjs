#!/usr/bin/env node
// E2E (stack issues 324, 489): above the drag the fit weighs the data at their own sigma and the record's covariance uses
// that same sigma (SPEC 12.1); under the drag on a 24 h arc AP's fit weighs them at their own sigma too, the along-track
// at that sigma times sqrt(tau / dt), and SGP4XP's keeps 1 km.
// Model truth: the module's own flight of an AP set (caps 31 and 20, NRLMSISE-00 on constant daily rows) with a known
// AGOM, in GCRF, the 24 h fit arc starting at the set's epoch, so that zero residual is attainable; fit on the module's
// default priors (no FIT table).
// 1. Precise input above the drag. GPS-like (26,560 km, e 0.01, 55 deg) and geostationary (42,164 km), AGOM 0.02 m^2/kg,
//    states every 600 s: the fitted AGOM within 0.1 % of it, the record states a data sigma under 1 m and the regime
//    ABOVE, and the day after the arc stays within 1 m of the truth's own flight. (0.6.10, at 1 km: 31 % and 16 % low,
//    50 m and 76 m off within that day.)
// 2. One weighting for the estimate and the covariance. The GPS-like arc with COVARIANCE_MATRIX_LINES of (0.5 km)^2 on
//    X, Y and Z at every state, a stated sigma the fit does not go below: the record states 0.5 km, every accepted $ODR
//    row's WEIGHT is 4 per km^2, and AGOM is pulled toward its prior (0 +- 0.1 m^2/kg on an arc under 36 h) by what the
//    record's own covariance says: a Gaussian prior of mean 0 and variance P0 with a posterior variance P gives the
//    estimate x (1 - P / P0) of a true x, so the fitted AGOM is 0.02 (1 - sigma_S^2 / 0.01) within 1 % of 0.02, sigma_S
//    the record's AGOM sigma. (0.6.10 fits AGOM 31 % low whatever is stated, while its covariance, divided by the
//    scatter that pull leaves, implies 0.0 %.)
// 3. The line is the theory's own: circular sets at 2,400 km and 2,600 km, AGOM 0.02. The first record states the
//    regime DRAG and, on this 24 h arc, the along-track weighting (radial and cross-track at the data sigma, every
//    accepted $ODR WEIGHT 1 / that sigma^2, the along-track at sigma sqrt(tau / dt), tau at least 0.181 periods and the
//    factor sqrt(tau P / dt) to 1e-3, P the record's period); the second its data sigma and ABOVE. A 700 km set states the
//    along-track weighting too. SGP4XP's fit of the 700 km arc (stock forces) states UNIT WEIGHTS at 1 km, as before.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit-data-sigma.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as LineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { covarianceMatrixLineT as CovLineT } from "spacedatastandards.org/lib/js/OEM/covarianceMatrixLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { ODR } from "spacedatastandards.org/lib/js/ODR/ODR.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, fitConfiguration } from "./lib/pcf.mjs";
import { T, AP_FORCES, ocmOf, seedOcm, rowsThrough, spwStream, flight } from "./lib/ocm.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const DAY = 86400000, EPOCH = Date.parse("2026-09-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const rows = [];
for (let k = -3; k <= 45; k++) rows.push({ DATE: new Date(EPOCH + k * DAY).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: 0 });
const spw = rowsThrough(rows);
const RE = 6378.135;
const revPerDay = (aKm) => Math.sqrt(398600.4418 / aKm ** 3) * 86400 / (2 * Math.PI);
const ORBITS = {
  gps: { n: revPerDay(26560), e: 0.01, i: 55, raan: 80, argp: 30, ma: 10, step: 600, agom: 0.02, bterm: 0 },
  geo: { n: revPerDay(42164), e: 0.0003, i: 0.05, raan: 70, argp: 20, ma: 10, step: 600, agom: 0.02, bterm: 0 },
  below: { n: revPerDay(RE + 2400), e: 0.0005, i: 60, raan: 40, argp: 90, ma: 10, step: 300, agom: 0.02, bterm: 0.002 },
  above: { n: revPerDay(RE + 2600), e: 0.0005, i: 60, raan: 40, argp: 90, ma: 10, step: 300, agom: 0.02, bterm: 0.002 },
  leo700: { n: revPerDay(RE + 700), e: 0.001, i: 98.2, raan: 40, argp: 90, ma: 10, step: 120, agom: 0.02, bterm: 0.02 },
};
const UNIT = "UNIT WEIGHTS: A PRIORI SIGMA 1 KM PER TEME POSITION COMPONENT";

const seedOf = (o) => seedOcm({ epoch: iso(EPOCH), n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: o.ma, bterm: o.bterm, agom: o.agom, norad: 99001,
  msis: true, records: true, tesseral: 31, zonal: 20, rows: spw });
/** GCRF states of a record at the given times. */
async function fly(record, times) {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  const lines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  return lines.map((l, k) => ({ ms: times[k], s: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] }));
}
/** The truth: GCRF states of the orbit's seed set over 24 h from its epoch. */
const truth = (o) => fly(seedOf(o), Array.from({ length: 86400 / o.step + 1 }, (_, k) => EPOCH + k * o.step * 1000));

/** The fit of GCRF states (`covKm2`: each state's stated position variance per component, km^2, or none). */
async function fit(states, covKm2 = 0, theory = "AP") {
  const lines = states.map((q) => Object.assign(new LineT(), { EPOCH: iso(q.ms), X: q.s[0], Y: q.s[1], Z: q.s[2], X_DOT: q.s[3], Y_DOT: q.s[4], Z_DOT: q.s[5] }));
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99001, OBJECT_NAME: "FIT DATA SIGMA E2E" }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines,
    COVARIANCE_MATRIX_LINES: covKm2 > 0 ? lines.map((l) => Object.assign(new CovLineT(), { EPOCH: l.EPOCH, CX_X: covKm2, CY_Y: covKm2, CZ_Z: covKm2 })) : [] });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  // SGP4XP (stock forces) reads the theory's own flux model: no space_weather rows
  const r = await h.invoke({ methodId: "fit", inputs: theory === "AP"
    ? [configuration({ theory: "AP", forces: AP_FORCES }), { portId: "space_weather", typeRef: T("SPW"), payload: spwStream(spw) }, { portId: "ephemeris", typeRef: T("OEM"), payload: oem }]
    : [fitConfiguration({}), { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  const record = new Uint8Array(r.outputs.find((v) => v.portId === "elements").payload);
  const o = ocmOf(record);
  const odr = ODR.getRootAsODR(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs.find((v) => v.portId === "residuals").payload))).unpack();
  const kinds = o.COV_PARAMETER_KINDS ?? [], cov = o.COVARIANCE_DATA ?? [];
  const sigmaOf = (kind) => { const row = kinds.indexOf(kind); if (row < 0) return NaN; const at = 6 + row; return Math.sqrt(cov[(at * (at + 1)) / 2 + at]); };
  const od = o.ORBIT_DETERMINATION ?? {}, weighting = od.OD_DATA_WEIGHTING ?? "";
  return { record, me: o.MEAN_ELEMENTS, sigmaAgom: sigmaOf(prwDynamicParameter.SRP_AREA_OVER_MASS), weighting, regime: o.COV_REALISM?.[0]?.REGIME,
    sigmaKm: Number(/SIGMA ([0-9.e+-]+) KM/.exec(weighting)?.[1]), weightedRms: od.WEIGHTED_RMS,
    weights: new Set(odr.EDITED_OBSERVATIONS.filter((e) => e.ACCEPTED).map((e) => e.WEIGHT)), converged: od.FIT_STATISTICS?.CONVERGED };
}

// --- 1. precise input above the drag: the data, not the priors, decide
for (const name of ["gps", "geo"]) {
  const o = ORBITS[name], states = await truth(o), f = await fit(states);
  const next = Array.from({ length: 24 }, (_, k) => EPOCH + DAY + (k + 1) * 3600000);
  const a = await fly(seedOf(o), next), b = await fly(f.record, next);
  const worst = Math.max(...a.map((q, k) => Math.hypot(q.s[0] - b[k].s[0], q.s[1] - b[k].s[1], q.s[2] - b[k].s[2]))) * 1000;
  console.log(`${name}: AGOM ${o.agom} fitted ${f.me.AGOM} (record sigma ${f.sigmaAgom.toExponential(2)}), data sigma ${(1000 * f.sigmaKm).toFixed(4)} m, regime ${f.regime}, ` +
    `weighted RMS ${f.weightedRms.toFixed(3)}, converged ${f.converged}; the day after the arc within ${worst.toFixed(3)} m`);
  check(Math.abs(f.me.AGOM / o.agom - 1) <= 1e-3, `${name}: AGOM ${f.me.AGOM}, not ${o.agom} to 0.1 %`);
  check(f.sigmaKm < 1e-3 && f.regime === "ABOVE" && f.converged === true, `${name}: data sigma ${f.sigmaKm} km, regime ${f.regime}, converged ${f.converged}`);
  check(f.weights.size === 1 && Math.abs([...f.weights][0] * f.sigmaKm ** 2 - 1) <= 1e-5, `${name}: $ODR WEIGHT ${[...f.weights].join(", ")} is not 1 / sigma^2 of ${f.sigmaKm} km`);
  check(worst <= 1, `${name}: ${worst.toFixed(3)} m from the truth's flight in the day after the arc (bound 1 m)`);
}

// --- 2. one weighting: with a stated sigma the estimate is pulled by what the record's covariance says
{
  const o = ORBITS.gps, f = await fit(await truth(o), 0.25), P0 = 0.1 ** 2;
  const expected = o.agom * (1 - f.sigmaAgom ** 2 / P0);
  console.log(`gps with (0.5 km)^2 stated: '${f.weighting}', WEIGHT ${[...f.weights].join(", ")} per km^2; AGOM ${f.me.AGOM}, record sigma ${f.sigmaAgom.toExponential(4)}: ` +
    `the covariance implies ${expected.toFixed(6)} (${(100 * (f.me.AGOM - expected) / o.agom).toFixed(2)} % of the truth apart)`);
  check(Math.abs(f.sigmaKm - 0.5) <= 5e-6 && f.weights.size === 1 && Math.abs([...f.weights][0] - 4) <= 4e-12, `stated 0.5 km: data sigma ${f.sigmaKm} km, WEIGHT ${[...f.weights].join(", ")}`);
  check(f.sigmaAgom > 0.01 && f.sigmaAgom < 0.1, `stated 0.5 km: the record's AGOM sigma ${f.sigmaAgom} is not between the arc's and the prior's`);
  check(Math.abs(f.me.AGOM - expected) <= 0.01 * o.agom, `stated 0.5 km: AGOM ${f.me.AGOM}, the record's covariance implies ${expected} (1 % of ${o.agom} allowed)`);
}

// --- 3. the line is the theory's 2,500 km; under the drag on this 24 h arc AP weighs the along-track at sigma sqrt(tau / dt)
for (const [name, regime] of [["below", "DRAG"], ["above", "ABOVE"], ["leo700", "DRAG"]]) {
  const f = await fit(await truth(ORBITS[name]));
  console.log(`${name}: regime ${f.regime}, '${f.weighting}', WEIGHT ${[...f.weights].map((w) => w.toPrecision(6)).join(", ")} per km^2`);
  check(f.regime === regime, `${name}: regime ${f.regime}, expected ${regime}`);
  if (regime === "DRAG") {
    const m = /^RADIAL AND CROSS-TRACK SIGMA ([0-9.e+-]+) KM, .*; ALONG-TRACK ([0-9.e+-]+) KM, THAT SIGMA TIMES SQRT\(TAU \/ DT\) = ([0-9.e+-]+), TAU ([0-9.e+-]+) PERIODS, DT ([0-9.e+-]+) S$/.exec(f.weighting);
    const sigma = m ? Number(m[1]) : NaN, factor = m ? Number(m[3]) : NaN, tau = m ? Number(m[4]) : NaN, dt = m ? Number(m[5]) : NaN;
    const periodS = 86400 / f.me.MEAN_MOTION;
    check(m && factor > 1 && tau >= 0.181 && Math.abs(factor / Math.sqrt((tau * periodS) / dt) - 1) <= 1e-3 && Math.abs(Number(m[2]) / (sigma * factor) - 1) <= 1e-4,
      `${name}: under the drag AP's record states '${f.weighting}'`);
    check(f.weights.size === 1 && Math.abs([...f.weights][0] * sigma ** 2 - 1) <= 1e-5, `${name}: $ODR WEIGHT ${[...f.weights].join(", ")} is not 1 / sigma^2 of ${sigma} km`);
  } else check(/^EQUAL WEIGHTS: SIGMA /.test(f.weighting) && f.sigmaKm < 1e-3, `${name}: above the drag the record states '${f.weighting}'`);
}
// SGP4XP under the drag on a short arc keeps 1 km (stack #489: its records are those of the version before)
{
  const f = await fit(await truth(ORBITS.leo700), 0, "SGP4XP");
  console.log(`leo700, SGP4XP: '${f.weighting}', WEIGHT ${[...f.weights].join(", ")} per km^2`);
  check(f.weighting === UNIT && f.weights.size === 1 && [...f.weights][0] === 1, `leo700, SGP4XP: under the drag the record states '${f.weighting}', WEIGHT ${[...f.weights].join(", ")}`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nfit data-sigma E2E: PASS");
process.exit(0);
