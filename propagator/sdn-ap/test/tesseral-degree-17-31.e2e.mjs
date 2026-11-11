#!/usr/bin/env node
// E2E (stack #454, SPEC 16.2, a known defect: test/known-defects.json): in low orbit AP carries the m-daily and first-order
// tesseral families to degree 16 (#448); degrees 17 to 31 carry only their near-resonant j = 1 terms. On a 31 x 31 field they
// leave 5 to 11 m of the 72 h fit's RMS at 690 to 800 km. The scratch arrays of tess::sp_terms and the m-daily table hold
// degree 16 at most; the fix resizes them.
// Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 16 x 16 and 31 x 31, DE440 Sun and Moon, no
// drag, no SRP, zero EOP, RK78 1e-12 and 300 s, from an osculating perigee state; AP FORCES 16,16 and 31,31; 72 h fits (30 min
// states, BTERM and AGOM pinned at 0). Made-up near-circular orbits (e 0.001) away from the 29:2 commensurability of #447: 690 km
// at i 108 and 800 km at i 98.
// Asserted: the share of degrees 17 to 31, sqrt(RMS(31 x 31)^2 - RMS(16 x 16)^2), at most 3 m on both. Measured 2026-11-11 on
// #448's candidate: 7.95 m (13.94 against 16.05 m) and 6.88 m (13.21 against 14.89 m).
//   node test/tesseral-degree-17-31.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);
const BOUND = 3;
// [name, altitude km, i deg, RAAN deg, measured 2026-11-11 (share, m)]
const CASES = [['690 km, i 108', 690, 108, 171, 7.95], ['800 km, i 98', 800, 98, 30, 6.88]];
const failures = [];
for (const [name, h, i, raan, measured] of CASES) {
  const base = {n: nOf(h), e: 0.001, i, raan, argp: 90, ma: 0, drag: false, fitDays: 3, hourly: true, gridMinutes: 60};
  const low = await runModelTruth({name: `${name}, 16 x 16`, ...base, field: [16, 16], forces: [16, 16]});
  const full = await runModelTruth({name: `${name}, 31 x 31`, ...base, field: [31, 31], forces: [31, 31]});
  assert.equal(full.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const a = low.fitted.wrms * 1000, b = full.fitted.wrms * 1000, share = Math.sqrt(Math.max(0, b * b - a * a));
  console.log(JSON.stringify({name, fitRms16Meters: +a.toFixed(2), fitRms31Meters: +b.toFixed(2), degree17to31Meters: +share.toFixed(2), bound: BOUND, measured20261111: measured}));
  if (!(share <= BOUND)) failures.push(`${name}: degrees 17 to 31 leave ${share.toFixed(2)} m of the 72 h fit RMS, above ${BOUND} m (#454)`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('tesseral degree 17 to 31 E2E: PASS');
process.exit(0);
