#!/usr/bin/env node
// E2E (stack #393, SPEC 16.11): a class-0 set above the eccentricity switch near an m:1 commensurability with the Earth's
// rotation. Above the switch the first-order tesseral families are a grid; 0.6.3 to 0.6.10 left every harmonic of the slow
// band (angle drifting slower than 0.045 n) out of it, which in low orbit nothing else carries (the table holds degree 13
// and up there, the shallow set q = 0, w = j = 1 only): kilometers a week at 4, 5, 6, 7 and 8 revolutions a day.
// Truth: test/lib/heo-model-truth.mjs as high-e-fit-arc's low-e cases fly it (FFM 2.3.0, named below by its SHA-256; 2.2.1
// gave the same figures to the last digit:
// EGM96 70 x 70, DE440 Sun and Moon, NRLMSISE-00 at constant weather, B 0.044 m^2/kg, no SRP, zero EOP, RK78 1e-12 and
// 300 s); a 72 h fit with the library's drag prior; 7 days flown on a 1 h grid; i 50, RAAN 10, argp 30, M 0.
// Asserted: the day-7 whole-day along-track RMS at most the bound. The bounds are about twice what this build gives (the
// 2026-11-10 measurement in the comment), the before figure 0.6.9's (main c0819777, the fault).
//   e 0.25 at 4, 5, 6, 7 and 8 rev/day: the commensurabilities (8.0 limited by the 8:1 resonance's own shoulder);
//   e 0.25 at 4.5 (9:2, moved by the fix too: its j = 2 harmonics were in the band) and 6.5 (off every band: unchanged);
//   6.0 at e 0.35, above the 0.3 switch, wrong from 0.6.3 on (the grid's first release).
//   node test/class0-commensurability.e2e.mjs
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
// the bounds' truth: FFM 2.3.0 (propagator/ffm/dist/isomorphic/module.wasm); another build is refused
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);

// [n rev/day, e, bound (m, day-7 along-track RMS), this build, 0.6.9]
const CASES = [
  [4.0, 0.25, 15, 6.42, 2317.87],
  [5.0, 0.25, 25, 11.44, 4462.86],
  [6.0, 0.25, 60, 29.08, 5864.49],
  [7.0, 0.25, 60, 27.39, 178.34],
  [8.0, 0.25, 450, 220.21, 2663.29],
  [4.5, 0.25, 15, 5.38, 47.13],
  [6.5, 0.25, 85, 42.12, 42.12],
  [6.0, 0.35, 320, 158.82, 14623.4],
];
const failures = [];
for (const [n, e, bound, now, before] of CASES) {
  const r = await runModelTruth({name: `class 0 n ${n} e ${e}`, n, e, i: 50, raan: 10, argp: 30, ma: 0, drag: true, hourly: true, gridMinutes: 60});
  assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const d7 = r.wholeDay[7];
  console.log(JSON.stringify({n, e, day7AlongTrackMeters: +d7.t.toFixed(2), day7RadialMeters: +d7.r.toFixed(2), bound, measured20261110: now, before069: before}));
  if (!(d7.t <= bound)) failures.push(`n ${n} e ${e}: day-7 along-track ${d7.t.toFixed(2)} m above ${bound} m`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('class-0 commensurability E2E: PASS');
process.exit(0);
