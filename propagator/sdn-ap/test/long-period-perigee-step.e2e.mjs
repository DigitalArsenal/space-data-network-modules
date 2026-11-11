#!/usr/bin/env node
// SPEC 9 and 16.10, DigitalArsenal/spacedatanetwork-stack#445: above e0 0.3 the long-period regime's step resolves the
// perigee pass. A THEMIS-like orbit (n 1.0496 rev/day, e 0.822, perigee 900 km, i 10 deg: the one-day class, period
// 1,372 min) against FFM model truth: EGM96 70 x 70, Sun and Moon from DE440, no drag or radiation pressure on either side.
// AP has FORCES 31, 20, a 72 h fit with drag and AGOM pinned at 0, and is flown 7 days on a 10-minute grid.
// The outcome: the day-5 whole-day 3D RMS is within 200 m. Measured 122.9 m. On 0.6.14 (a fixed 38-minute step, RK3
// across a perigee pass of minutes) it was 918.6 m.
// The step does not carry the rest: with Sun and Moon off on both sides it is 120.9 m, and the step there changes nothing.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import {runModelTruth} from './lib/heo-model-truth.mjs';

const MU = 398600.8, RE = 6378.135, n = 1.0496;
const e = +(1 - (RE + 900) / Math.cbrt(MU / (n * 2 * Math.PI / 86400) ** 2)).toFixed(6);
const r = await runModelTruth({name: 'THEMIS-like', n, e, i: 10, raan: 30, argp: 300, ma: 0, drag: false, field: [70, 70], forces: [31, 20],
  hourly: true, gridMinutes: 10});
const days = Object.fromEntries(Object.entries(r.wholeDay).map(([d, v]) => [d, {e: +v.e.toFixed(1), r: +v.r.toFixed(1), t: +v.t.toFixed(1), n: +v.n.toFixed(1)}]));
console.log(JSON.stringify({fixture: {n, e, i: 10, raan: 30, argp: 300, perigeeKm: +r.perigeeKm.toFixed(1)}, fitWrmsM: +(r.fitted.wrms * 1000).toFixed(1), wholeDayM: days, apSha256: r.apSha256}));
assert.ok(r.wholeDay[5].e < 200, `THEMIS-like day 5: ${r.wholeDay[5].e.toFixed(1)} m (measured 122.9 m; 918.6 m on 0.6.14's 38-minute step)`);
console.log('Long-period perigee step E2E: PASS');
process.exit(0);
