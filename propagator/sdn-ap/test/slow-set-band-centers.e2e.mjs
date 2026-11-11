#!/usr/bin/env node
// E2E (stack #477, SPEC 16.18, the low table's part): low orbits at the centers of the commensurability bands, where the
// slow set carries the k:j families the shallow set and the output table did not (through 0.6.20: the shallow set j = 1,
// q = 0 to degree 31; the table nothing slower than 1e-3 n).
// Truth: test/lib/heo-model-truth.mjs (FFM 2.3.0, named below by its SHA-256): EGM96 70 x 70, DE440 Sun and Moon, no drag,
// no SRP, zero EOP, RK78 1e-12 and 300 s; e 0.001, RAAN 40, argp 90, M 0 at 2026-10-29 00:00 UTC; a 72 h fit with the
// coefficients pinned (FORCES 31,20), 7 days flown on a 1 h grid.
// Asserted: the day-5 whole-day 3D RMS at most the bound, about 1.5 times this build's (the 2026-11-11 measurement below);
// 0.6.20's figure (main 234469f3) beside it.
//   i 53 at 340 and 480 km, i 97.6 at 400 and 860 km: the four worst heights of the 300 to 1,500 km scan that are band
//   centers (SPEC 16.18).
//   node test/slow-set-band-centers.e2e.mjs
import assert from 'node:assert/strict';
import { requireTruth } from './lib/ffm-truth.mjs';
import { runModelTruth } from './lib/heo-model-truth.mjs';
// the bounds' truth: FFM 2.3.0 (propagator/ffm/dist/isomorphic/module.wasm); another build is refused
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const RE = 6378.1363, KE = 0.074366859954178854;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);

// [i deg, height km, bound (m, day-5 3D RMS), this build, 0.6.20]
const CASES = [
  [53, 340, 270, 177.6, 1585.6],
  [53, 480, 155, 102.3, 994.8],
  [97.6, 400, 325, 216.2, 1910.7],
  [97.6, 860, 50, 32.6, 641.3],
];
const failures = [];
for (const [i, h, bound, now, before] of CASES) {
  const r = await runModelTruth({ name: `band center ${h} km i ${i}`, n: nOf(h), e: 0.001, i, raan: 40, argp: 90, ma: 0, drag: false, hourly: true, gridMinutes: 60 });
  assert.equal(r.ffmSha256, FFM_SHA256, 'the truth flown by the named FFM build');
  const d5 = r.wholeDay[5];
  console.log(JSON.stringify({ i, heightKm: h, meanMotion: +nOf(h).toFixed(4), day5Meters: +d5.e.toFixed(1), day5AlongTrackMeters: +d5.t.toFixed(1), bound, measured20261111: now, main0620: before }));
  if (!(d5.e <= bound)) failures.push(`${h} km i ${i}: day-5 ${d5.e.toFixed(1)} m above ${bound} m`);
}
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('slow-set band-centers E2E: PASS');
process.exit(0);
