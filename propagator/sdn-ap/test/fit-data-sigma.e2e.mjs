#!/usr/bin/env node
// E2E (review-0 finding M1): fit weighs the data at their own sigma (SPEC 12.1), not at the 1 km unit of the residual.
// Model truth: the module's own flight of an AP set (caps 31 and 20, NRLMSISE-00 on constant daily rows) with known BTERM
// and AGOM, in GCRF, the 24 h fit arc starting at the set's epoch, so that zero residual is attainable; fit on the
// module's default priors (no FIT table).
// - Precise input. GPS-like (26,560 km, e 0.01, 55 deg, 600 s), AGOM 0.02 m^2/kg: the fitted AGOM within 0.1 % of it
//   (0.6.5, at the 1 km unit: 20 % low, 20.7 of its record sigmas). 700 km sun-synchronous (120 s), BTERM 0.02: within
//   1 % (0.6.5: 0.0023, the band's prior median). Each record states a data sigma under 1 m in OD_DATA_WEIGHTING.
// - Stated accuracy. The GPS-like arc with COVARIANCE_MATRIX_LINES of (0.5 km)^2 on X, Y and Z at every state: the record
//   states 0.5 km (6 digits) and every accepted $ODR row's WEIGHT is 1 / 0.25 per km^2.
// - Noisy input. 1,336 km (120 s), BTERM 0.005 and AGOM 0.02, with 500 m Gaussian noise on each position component
//   (seeded): the stated data sigma within 10 % of 500 m; the arc carries no drag information, so the hold rule holds
//   BTERM at the AP prior's median 0.01 (SPEC 12.1), says so in the record's OD COMMENT and leaves it out of
//   OD_EST_PARAMETERS, and its sigma of ln BTERM is the prior's, ln 10; AGOM is held at the AP prior's 0.01 the same way
//   or, estimated, within two of its sigma of the truth.
// JS only moves bytes and compares numbers the module produced (and adds the seeded noise).
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
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";
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
const revPerDay = (aKm) => Math.sqrt(398600.4418 / aKm ** 3) * 86400 / (2 * Math.PI);
const ORBITS = {
  gps: { n: revPerDay(26560), e: 0.01, i: 55, raan: 80, argp: 30, ma: 10, step: 600 },
  leo700: { n: revPerDay(7078), e: 0.001, i: 98.2, raan: 40, argp: 90, ma: 10, step: 120 },
  leo1336: { n: revPerDay(7714), e: 0.0008, i: 66.04, raan: 120, argp: 270, ma: 10, step: 120 },
};

/** The truth: GCRF states of an AP set over 24 h from its epoch. */
async function truth(orbit, bterm, agom) {
  const o = ORBITS[orbit];
  const set = seedOcm({ epoch: iso(EPOCH), n: o.n, e: o.e, i: o.i, raan: o.raan, argp: o.argp, ma: o.ma, bterm, agom, norad: 99001, msis: true, records: true,
    tesseral: 31, zonal: 20, rows: spw });
  const times = Array.from({ length: 86400 / o.step + 1 }, (_, k) => EPOCH + k * o.step * 1000);
  const r = await h.invoke({ methodId: "propagate", inputs: flight([set], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  const lines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  return lines.map((l, k) => ({ ms: times[k], s: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] }));
}

/** The fit of GCRF states (`covKm2`: each state's stated position variance per component, km^2, or none). */
async function fit(states, covKm2 = 0) {
  const lines = states.map((q) => Object.assign(new LineT(), { EPOCH: iso(q.ms), X: q.s[0], Y: q.s[1], Z: q.s[2], X_DOT: q.s[3], Y_DOT: q.s[4], Z_DOT: q.s[5] }));
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99001, OBJECT_NAME: "M1 E2E" }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines,
    COVARIANCE_MATRIX_LINES: covKm2 > 0 ? lines.map((l) => Object.assign(new CovLineT(), { EPOCH: l.EPOCH, CX_X: covKm2, CY_Y: covKm2, CZ_Z: covKm2 })) : [] });
  const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
  const r = await h.invoke({ methodId: "fit", inputs: [configuration({ theory: "AP", forces: AP_FORCES }), { portId: "space_weather", typeRef: T("SPW"), payload: spwStream(spw) },
    { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  const o = ocmOf(new Uint8Array(r.outputs.find((v) => v.portId === "elements").payload));
  const odr = ODR.getRootAsODR(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs.find((v) => v.portId === "residuals").payload))).unpack();
  const kinds = o.COV_PARAMETER_KINDS ?? [], cov = o.COVARIANCE_DATA ?? [];
  const sigmaOf = (row) => { const at = 6 + row; return Math.sqrt(cov[(at * (at + 1)) / 2 + at]); };
  const weighting = o.ORBIT_DETERMINATION?.OD_DATA_WEIGHTING ?? "";
  return { me: o.MEAN_ELEMENTS, sB: kinds.length > 0 ? sigmaOf(0) : NaN, sS: kinds.length > 1 ? sigmaOf(1) : NaN, weighting,
    sigmaKm: Number(/SIGMA ([0-9.e+-]+) KM/.exec(weighting)?.[1]), weights: new Set(odr.EDITED_OBSERVATIONS.filter((e) => e.ACCEPTED).map((e) => e.WEIGHT)),
    converged: o.ORBIT_DETERMINATION?.FIT_STATISTICS?.CONVERGED, comment: o.ORBIT_DETERMINATION?.COMMENT ?? [],
    estimated: o.ORBIT_DETERMINATION?.OD_EST_PARAMETERS ?? [] };
}

// --- precise input: the data, not the priors, decide
const gps = await truth("gps", 0, 0.02);
const g = await fit(gps);
console.log(`GPS-like, AGOM 0.02: fitted ${g.me.AGOM} (sigma ${g.sS.toExponential(2)}), data sigma ${(1000 * g.sigmaKm).toFixed(4)} m, converged ${g.converged}`);
check(Math.abs(g.me.AGOM / 0.02 - 1) <= 1e-3, `GPS-like: AGOM ${g.me.AGOM}, not 0.02 to 0.1 %`);
check(g.sigmaKm < 1e-3 && g.converged === true, `GPS-like: data sigma ${g.sigmaKm} km, converged ${g.converged}`);
const leo = await fit(await truth("leo700", 0.02, 0));
console.log(`700 km, BTERM 0.02: fitted ${leo.me.BTERM} (sigma ${leo.sB.toExponential(2)}), data sigma ${(1000 * leo.sigmaKm).toFixed(4)} m, converged ${leo.converged}`);
check(Math.abs(leo.me.BTERM / 0.02 - 1) <= 1e-2, `700 km: BTERM ${leo.me.BTERM}, not 0.02 to 1 %`);
check(leo.sigmaKm < 1e-3 && leo.converged === true, `700 km: data sigma ${leo.sigmaKm} km, converged ${leo.converged}`);

// --- stated accuracy: the $OEM's covariance lines are a floor of the data sigma
const stated = await fit(gps, 0.25);
console.log(`GPS-like with (0.5 km)^2 stated: '${stated.weighting}', WEIGHT ${[...stated.weights].join(", ")} per km^2, AGOM ${stated.me.AGOM}`);
check(Math.abs(stated.sigmaKm - 0.5) <= 5e-6 && stated.weights.size === 1 && Math.abs([...stated.weights][0] - 4) <= 4e-12,
  `stated 0.5 km: data sigma ${stated.sigmaKm} km, WEIGHT ${[...stated.weights].join(", ")}`);

// --- noisy input: where the arc cannot see BTERM and AGOM, the priors hold them
let seed = 20261110;
const uniform = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
const noisy = (await truth("leo1336", 0.005, 0.02)).map((q) => ({ ms: q.ms, s: [q.s[0] + 0.5 * gauss(), q.s[1] + 0.5 * gauss(), q.s[2] + 0.5 * gauss(), q.s[3], q.s[4], q.s[5]] }));
const n = await fit(noisy);
const lnSigmaB = n.sB / n.me.BTERM, PRIOR_LN = Math.log(10);
const heldB = n.comment.some((c) => /^prior-limited: BTERM held/.test(c)), heldS = n.comment.some((c) => /^prior-limited: AGOM held/.test(c));
console.log(`1,336 km, 500 m noise: data sigma ${(1000 * n.sigmaKm).toFixed(1)} m; BTERM ${n.me.BTERM}${heldB ? " held" : ""} (sigma of ln ${lnSigmaB.toFixed(3)}, prior ${PRIOR_LN.toFixed(3)}); ` +
  `AGOM ${n.me.AGOM}${heldS ? " held" : ""} (sigma ${n.sS.toExponential(3)}, prior 0.01 +- 0.01); estimated ${n.estimated.join(", ")}`);
check(Math.abs(n.sigmaKm / 0.5 - 1) <= 0.1, `500 m noise: data sigma ${n.sigmaKm} km`);
check(heldB && !n.estimated.includes("DRAG_AREA_OVER_MASS") && Math.abs(n.me.BTERM / 0.01 - 1) <= 1e-9 && Math.abs(lnSigmaB / PRIOR_LN - 1) <= 1e-6,
  `500 m noise: BTERM ${n.me.BTERM}, held ${heldB}, sigma of ln ${lnSigmaB}`);
check(heldS ? !n.estimated.includes("SRP_AREA_OVER_MASS") && Math.abs(n.me.AGOM - 0.01) <= 1e-12 && Math.abs(n.sS / 0.01 - 1) <= 1e-6
  : Math.abs(n.me.AGOM - 0.02) <= 2 * n.sS, `500 m noise: AGOM ${n.me.AGOM}, held ${heldS}, sigma ${n.sS}`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nfit data-sigma E2E: PASS");
process.exit(0);
