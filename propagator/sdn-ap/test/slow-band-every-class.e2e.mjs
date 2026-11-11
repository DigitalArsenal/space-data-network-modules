#!/usr/bin/env node
// SPEC 16.18, DigitalArsenal/spacedatanetwork-stack#473: above its eccentricity switch, outside low orbit, every class carries
// in its rates each slow tesseral term of degree 2 to 12 that its own class terms do not, at or above the size cut (0.5 m).
// Before this, the grid left each family's whole slow band (slower than 0.045 n) out and no rate carried it (from #467 the
// one-day class kept it on the grid down to 1e-2 n).
// 1. sdnap_slow_terms, tesseral cap 31, on one set of each such class: class 0 (0.40 rev/day, e 0.9, i 55 deg), one-day
//    (1.0027 rev/day, e 0.82, i 10: exactly synchronous), half-day (2.25 rev/day, e 0.73, i 27), eight-hour (2.42 rev/day,
//    e 0.7, i 55) and sixteen-hour (1.5 rev/day, e 0.6, i 63.4). Outcome: every slow term of degree 2 to 12 is in the rates
//    (the class's own, or at or above the size cut, with the band taper as its weight) or under the size cut; none is
//    carried nowhere at or above it, and each set carries slow terms beyond its class's.
// 2. FFM model truth on a made-up class 0 set at e 0.9 (initial elements 0.40 rev/day, e 0.9, i 55, node 63, perigee 234.5,
//    M 274.2 deg): EGM96 70 x 70, the Sun and Moon on both sides, no drag or radiation. The set is fitted to the forecast's
//    own 5 days on a 10-minute grid (the best record), so what remains is what the theory cannot represent. Outcome: the
//    largest distance over the 5 days is within BOUND_M (measured 242.7 m; 2,691.4 m before #473).
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';

const CUT_M = 0.5, BOUND_M = 300;
const taper = (x) => (x <= 0.9 ? 1 : x >= 1.1 ? 0 : Math.cos((0.5 * Math.PI * (x - 0.9)) / 0.2) ** 2);
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const ROW = 8, x = h.instance.exports, MAX = 40000, pin = x.sdnap_alloc(32), prow = x.sdnap_alloc(MAX * ROW * 8);
const SETS = {'class 0': [0.40, 0.9, 55], 'one-day': [1.0027, 0.82, 10], 'half-day': [2.25, 0.73, 27], 'eight-hour': [2.42, 0.7, 55],
  'sixteen-hour': [1.5, 0.6, 63.4]};
const summary = {};
for (const [name, el] of Object.entries(SETS)) {
  new Float64Array(h.memory.buffer, pin, 4).set([...el, 31]);
  const count = x.sdnap_slow_terms(pin, prow, MAX);
  assert.ok(count > 0 && count <= MAX, `${name}: sdnap_slow_terms ${count}`);
  const rows = Array.from({length: count}, (_, k) => Array.from(new Float64Array(h.memory.buffer, prow + ROW * 8 * k, ROW)));
  const low = rows.filter((r) => r[0] <= 12);
  // in the rates: the class's own (weight 1) or a term at or above the cut (weight the band taper); else under the cut
  const wrong = low.filter((r) => !(r[5] === 1 ? r[6] === 1 || (r[7] >= CUT_M && Math.abs(r[6] - taper(Math.abs(r[4]) / 0.045)) < 1e-12) : r[5] === 5 && r[7] < CUT_M));
  summary[name] = {slowTerms: count, rates: rows.filter((r) => r[5] === 1).length, underSizeCut: rows.filter((r) => r[5] === 5).length,
    aboveDegree12: rows.filter((r) => r[5] === 4).length, nowhereAtOrAboveCut: low.filter((r) => r[5] !== 1 && r[7] >= CUT_M).length};
  assert.equal(wrong.length, 0, `${name}: ${wrong.length} terms of degree 2 to 12 not where the rule puts them: ${JSON.stringify(wrong.slice(0, 3))}`);
  assert.equal(summary[name].nowhereAtOrAboveCut, 0, `${name}: no slow term of degree 2 to 12 at or above the cut carried nowhere`);
}
// class 0 has no class terms: every term in its rates is one this change carries
assert.ok(summary['class 0'].rates > 0, `class 0: slow terms in the rates (${JSON.stringify(summary['class 0'])})`);
console.log(JSON.stringify({census: summary}));
x.sdnap_free(pin);
x.sdnap_free(prow);
await h.close?.();

const r = await runModelTruth({name: 'class 0, e 0.9', n: 0.40, e: 0.9, i: 55, raan: 63, argp: 234.5, ma: 274.2, drag: false, field: [70, 70], forces: [31, 20],
  hourly: true, gridMinutes: 10, forecastDays: 5, fitOnForecast: true});
const D = Math.max(...r.profile.map((q) => q.e));
console.log(JSON.stringify({modelTruth: {largestM: +D.toFixed(1), wholeDayM: Object.fromEntries(Object.entries(r.wholeDay).map(([d, v]) => [d, +v.e.toFixed(1)])),
  fitWrmsM: +(r.fitted.wrms * 1000).toFixed(1)}}));
assert.ok(D <= BOUND_M, `class 0, e 0.9: the largest distance over 5 days ${D.toFixed(1)} m (bound ${BOUND_M} m)`);
console.log('Slow band in every class E2E: PASS');
process.exit(0);
