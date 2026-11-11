#!/usr/bin/env node
// E2E (stack #446, SPEC 5 and 16.17): the one-day class's floor with the Earth's gravity matched on both sides was AP's
// analytic Moon. A known defect (test/known-defects.json) through 0.6.19, kept apart from test/one-day-resonant-tail.e2e.mjs
// so that test stays strict; it passes from AP's own Sun and Moon (SPEC 16.17): day 7 0.94 to 2.03 m at the six nodes
// (median 1.24 m), the Y0 found -3.8e-11 to +3.3e-11 m/s^2 (day 7 with it 1.2 to 7.7 m).
// Model truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256; EGM96 4 x 4, DE440 Sun and Moon, no
// radiation pressure, no drag, zero EOP, RK78 1e-12 and 300 s); AP FORCES 4,0; made-up inclined geosynchronous sets at
// 2026-10-29 00:00 UTC (n 1.0027379 rev/day, e 0.003, i 55 deg, argument of perigee 270, ascending node at longitudes 0, 60,
// ..., 300 deg); a 72 h fit; 7 days flown on a 1 h grid.
// Asserted at every node:
// - the day-7 whole-day 3D RMS at most 5 m. Measured 2026-11-11: 5.4 to 25.9 m (median 16.5 m) on this build; 1.2 to
//   2.3 m with the Moon off on both sides (Sun on), 4.8 to 27.1 m with the Sun off, and 1.2 to 2.5 m in a scratch build
//   that takes DE440's Moon in place of SPEC 5's (Brown's main terms evaluated at UTC: 58 to 69 arcsec off DE440 on
//   average, 98 at most, which is about 2e-9 m/s^2 of the Moon's pull at this radius);
// - the same arc fitted under $PCF FORCES.ECOM2 finds |Y0| at most 5e-11 m/s^2 (the truth has no radiation pressure).
//   Measured: -2.7e-10 to +1.0e-10 on this build (four of six nodes above the bound; day 7 12 to 58 m with it against 5 to
//   26 m without), at most 3.7e-11 with DE440's Moon. This is what SPEC 16.13's lift of the one-day hold accepts until
//   #446 is fixed.
//   node test/one-day-moon-floor.e2e.mjs
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {ocmOf} from './lib/ocm.mjs';
import {prwDynamicParameter} from 'spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js';
// the bound's truth: FFM 2.3.0 (propagator/ffm/dist/isomorphic/module.wasm); another build is refused
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const bound = 5, y0Bound = 5e-11;
// Greenwich mean sidereal time at the harness's epoch (IAU 1982; it only places the nodes in longitude)
const jd = Date.parse('2026-10-29T00:00:00Z') / 86400000 + 2440587.5;
const gmst = (((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360) + 360) % 360;
let failed = 0;
for (const lon of [0, 60, 120, 180, 240, 300]) {
  const set = {n: 1.0027379, e: 0.003, i: 55, raan: (((lon + gmst) % 360) + 360) % 360, argp: 270, ma: 0, drag: false, hourly: true, gridMinutes: 60, field: [4, 4], forces: [4, 0]};
  const r = await runModelTruth({...set, name: `inclined geosynchronous node ${lon}, 4x4`});
  // the same arc fitted under $PCF FORCES.ECOM2: the truth has no radiation pressure, so the Y0 found is what the Moon's
  // error leaks into it (SPEC 16.13)
  const y = await runModelTruth({...set, name: `inclined geosynchronous node ${lon}, 4x4, ECOM2`, ecom2: true});
  if (r.ffmSha256 !== FFM_SHA256 || y.ffmSha256 !== FFM_SHA256) throw new Error('the truth was not flown by the named FFM build');
  const entry = ocmOf(Buffer.from(y.omm, 'base64')).ORBIT_DETERMINATION?.OD_DYNAMIC_PARAMETERS?.find((q) => q.PARAMETER === prwDynamicParameter.ECOM2_Y0);
  const d7 = r.wholeDay[7], y0 = entry?.SOLVED_FOR ? entry.VALUE : NaN;
  console.log(JSON.stringify({nodeLongitude: lon, day7Meters: +d7.e.toFixed(2), alongTrack: +d7.t.toFixed(2), crossTrack: +d7.n.toFixed(2), radial: +d7.r.toFixed(2), bound,
    ecom2: {y0Found: y0, day7Meters: +y.wholeDay[7].e.toFixed(2), y0Bound}}));
  if (!(d7.e <= bound)) {
    console.error(`FAIL node ${lon}: day-7 ${d7.e.toFixed(2)} m above ${bound} m with the field matched (AP's analytic Moon, #446)`);
    failed++;
  }
  if (!(Math.abs(y0) <= y0Bound)) {
    console.error(`FAIL node ${lon}: a Y0 of ${y0} m/s^2 found on a truth without radiation pressure (above ${y0Bound}: the Moon's error leaking into it, #446)`);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('one-day Moon floor E2E: PASS');
process.exit(0);
