#!/usr/bin/env node
// E2E (stack #419, SPEC 6 and 16.11): a class-0 set at the exact 8:1 commensurability with the Earth's rotation (8.05
// rev/day at e 0.25, where its order-8 harmonics drift slower than 1e-3 n). The first-order table and the grid both leave
// those harmonics out and no class carries them in the rates: a known defect (test/known-defects.json), kept apart from
// test/class0-commensurability.e2e.mjs so that test stays strict.
// Truth and fit as that test's: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256: EGM2008 70 x 70, DE440
// Sun and Moon, NRLMSISE-00 at constant weather, B 0.044 m^2/kg, no SRP, zero EOP, RK78 1e-12 and 300 s); a 72 h fit with the
// library's drag prior; 7 days flown on a 1 h grid; i 50, RAAN 10, argp 30, M 0.
// Asserted: the day-7 whole-day along-track RMS at most 250 m, what its neighbours meet on 0.6.11 (7.95: 94 m, 8.0: 220 m,
// 8.1: 150 m). Measured 2026-11-10: 1,272 m on 0.6.11, 6,090 m on 0.6.9.
//   node test/class0-exact-resonance.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
// the bound's truth: FFM 2.3.0 (propagator/ffm/dist/isomorphic/module.wasm); another build is refused
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const n = 8.05, e = 0.25, bound = 250;
const r = await runModelTruth({name: `class 0 n ${n} e ${e}`, n, e, i: 50, raan: 10, argp: 30, ma: 0, drag: true, hourly: true, gridMinutes: 60});
assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
const d7 = r.wholeDay[7];
console.log(JSON.stringify({n, e, day7AlongTrackMeters: +d7.t.toFixed(2), day7RadialMeters: +d7.r.toFixed(2), bound, measured0611: 1271.87, measured069: 6089.86}));
if (!(d7.t <= bound)) {
  console.error(`FAIL n ${n} e ${e}: day-7 along-track ${d7.t.toFixed(2)} m above ${bound} m (the exact 8:1 resonance is carried nowhere, #419)`);
  process.exit(1);
}
console.log('class-0 exact resonance E2E: PASS');
process.exit(0);
