#!/usr/bin/env node
// E2E (stack #447, SPEC 16.2, a known defect: test/known-defects.json): at 690 and 800 km the gravity field above degree 31 adds 35
// to 70 m at day 5 after a 72 h fit. The made-up orbits sit near second- and higher-order commensurabilities with the Earth's
// rotation (29:2 at 690 km; 57:4 and 14:1 at 800 km), and AP has no family for the j >= 2 terms. Raising the zonal tail to degree
// 70 or the near-resonant j = 1 family's cap to 70 does not cure it (the lane's scratch builds, #447).
// Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 70 x 70, DE440 Sun and Moon, no drag, no SRP,
// zero EOP, RK78 1e-12 and 300 s, from an osculating perigee state; AP FORCES 31,20 (the headline fits'); a 72 h fit (30 min states,
// BTERM and AGOM pinned at 0), 7 days flown on a 1 h grid. Made-up near-circular orbits (e 0.001): 690 km and 800 km at i 50.
// Asserted: the day-5 whole-day 3D RMS at most about twice what the same orbit gives on a 31 x 31 field against FORCES 31,31.
// Measured 2026-11-11 on #448's candidate: 51.71 m (31 x 31: 13.37 m) and 113.10 m (31 x 31: 20.03 m).
//   node test/low-orbit-commensurability.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);
// [name, altitude km, i deg, RAAN deg, bound (m, day 5), measured 2026-11-11 (70 x 70, 31 x 31)]
const CASES = [['690 km, i 50', 690, 50, 77, 30, [51.71, 13.37]], ['800 km, i 50', 800, 50, 77, 45, [113.10, 20.03]]];
const failures = [];
for (const [name, h, i, raan, bound, measured] of CASES) {
  const r = await runModelTruth({name, n: nOf(h), e: 0.001, i, raan, argp: 90, ma: 0, drag: false, field: [70, 70], forces: [31, 20], fitDays: 3, hourly: true, gridMinutes: 60});
  assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const d5 = r.wholeDay[5];
  console.log(JSON.stringify({name, day5Meters: +d5.e.toFixed(2), day5AlongMeters: +d5.t.toFixed(2), bound, measured20261111: measured}));
  if (!(d5.e <= bound)) failures.push(`${name}: day 5 ${d5.e.toFixed(2)} m above ${bound} m (the field above degree 31 near a commensurability, #447)`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('low-orbit commensurability E2E: PASS');
process.exit(0);
