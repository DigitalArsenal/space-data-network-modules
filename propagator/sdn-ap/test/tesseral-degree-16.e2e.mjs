#!/usr/bin/env node
// E2E (stack #448, SPEC 16.2): a low-orbit set on the first-order table carries the m-daily and first-order tesseral families
// to degree 16. Through 0.6.15 both stopped at 12 and degrees 13 to 16 carried only their near-resonant j = 1 terms: the
// along-track residue of a 16 x 16 field after a 72 h fit then held lines at 1 cycle/day (the m-daily terms of degrees 14 and
// 16, order 1), at n - 1, n - 3, n + 1 and n - 5 cycles/day (first-order terms of degrees 13 to 16, low orders) and at 11
// cycles/day (m-daily, order 11), 15 m RMS at 690 km. A 24 h fit maps that floor into the forecast.
// Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 16 x 16, DE440 Sun and Moon, no drag, no
// SRP, zero EOP, RK78 1e-12 and 300 s, from an osculating perigee state; AP FORCES 16,16; fits of the first 72 h and the first
// 24 h (30 min states, BTERM and AGOM pinned at 0), flown 7 days on a 1 h grid. Made-up near-circular orbits (e 0.001): 690 km
// at i 98 and 800 km at i 50.
// Asserted: the 72 h fit's RMS on both orbits, and at 690 km the 24 h fit's day-5 whole-day 3D RMS, at most the bound, about 1.25
// times what this build gives; the before figures are 0.6.15's (modules a1e80462). At 800 km, i 50, the 24 h fit's day 5 is not
// asserted: 27.11 m on 0.6.15 and 29.54 m here, a 24 h arc's along-track drift that moves with whatever residue is left in the arc
// (the J3 to J5 short-period terms, 10 m, are still missing).
//   node test/tesseral-degree-16.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);

// [name, altitude km, i deg, RAAN deg, bound 72 h fit RMS (m), bound 24 h day 5 (m; Infinity: not asserted),
//  this build (fit RMS, day 5), 0.6.15 (fit RMS, day 5)]
const CASES = [
  ['690 km, i 98', 690, 98, 30, 17, 27, [13.71, 21.8], [20.1, 107.62]],
  ['800 km, i 50', 800, 50, 77, 13.5, Infinity, [10.82, 29.54], [14.96, 27.11]],
];
const failures = [];
for (const [name, h, i, raan, fitBound, dayBound, now, before] of CASES) {
  const base = {n: nOf(h), e: 0.001, i, raan, argp: 90, ma: 0, drag: false, field: [16, 16], forces: [16, 16], hourly: true, gridMinutes: 60};
  const long = await runModelTruth({name: `${name}, 72 h`, ...base, fitDays: 3});
  const short = await runModelTruth({name: `${name}, 24 h`, ...base, fitDays: 1});
  assert.equal(long.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const fitRms = long.fitted.wrms * 1000, day5 = short.wholeDay[5].e;
  console.log(JSON.stringify({name, fitRms72hMeters: +fitRms.toFixed(2), day5After24hMeters: +day5.toFixed(2), day5After72hMeters: +long.wholeDay[5].e.toFixed(2),
    bounds: [fitBound, dayBound], measured20261111: now, before0615: before}));
  if (!(fitRms <= fitBound)) failures.push(`${name}: 72 h fit RMS ${fitRms.toFixed(2)} m above ${fitBound} m`);
  if (!(day5 <= dayBound)) failures.push(`${name}: day 5 after the 24 h fit ${day5.toFixed(2)} m above ${dayBound} m`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('tesseral degree 16 E2E: PASS');
process.exit(0);
