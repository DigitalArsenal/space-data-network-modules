#!/usr/bin/env node
// E2E (stack #463, SPEC 12.8, a known defect: test/known-defects.json): under the drag the record's stated sigma of ln BTERM
// is overconfident. The post-fit residual there is the theory's own along-track error, correlated over the arc, and the fit
// weighs it as independent data. On the headline-loop real windows the 72 h fits' median |ln(B_fit / B_numerical)| is 2.7 to
// 11 stated sigmas (#463). The forecast maps the record's whole matrix, BTERM's row included, but under the drag that formal
// variance is negligible beside SPEC 12.5's DRAG noise row, so the stated position sigma barely moves with it; the record's
// statement of the term and a catalog's carried prior take it as it is.
// Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 70 x 70, DE440 Sun and Moon, NRLMSISE-00
// drag at constant weather on both sides (Cd A/m the true BTERM), no SRP, zero EOP, RK78 1e-12 and 300 s, from an osculating
// perigee state; AP FORCES 31,20 with NRLMSISE-00; a 72 h fit under the default prior (FIT unset: the 600 to 2,500 km default of
// a 71 h arc). Made-up near-circular orbits (e 0.001): 800 km at i 50 with a true BTERM of 0.02 (near the 57:4 commensurability
// of #447) and 1,340 km at i 66 with 0.003.
// Asserted: |ln(B_fit / B_true)| at most 2 of the record's stated sigmas of ln BTERM on both. Measured 2026-11-11: 5.14 (0.01912
// against 0.02, sigma 0.0087) and 2.61 (0.00710 against 0.003, sigma 0.33).
//   node test/drag-term-sigma-honesty.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);
const BOUND = 2;
// [name, altitude km, i deg, RAAN deg, true BTERM m^2/kg, measured 2026-11-11 (|z|)]
const CASES = [['800 km, i 50, BTERM 0.02', 800, 50, 77, 0.02, 5.14], ['1,340 km, i 66, BTERM 0.003', 1340, 66, 124, 0.003, 2.61]];
const failures = [];
for (const [name, h, i, raan, B, measured] of CASES) {
  const r = await runModelTruth({name, n: nOf(h), e: 0.001, i, raan, argp: 90, ma: 0, drag: true, bterm: B, fitPolicy: 'default', fitDays: 3, hourly: true, gridMinutes: 60});
  assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const z = Math.abs(Math.log(r.fitted.bterm / B)) / r.fitted.sigmaLog;
  console.log(JSON.stringify({name, fittedBterm: +r.fitted.bterm.toPrecision(4), statedSigmaLnB: +r.fitted.sigmaLog.toPrecision(3), z: +z.toFixed(2), bound: BOUND, measured20261111: measured}));
  if (!(z <= BOUND)) failures.push(`${name}: BTERM ${r.fitted.bterm.toPrecision(4)} against ${B} is ${z.toFixed(2)} stated sigmas of ln BTERM off, above ${BOUND} (#463)`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('drag-term sigma honesty E2E: PASS');
process.exit(0);
