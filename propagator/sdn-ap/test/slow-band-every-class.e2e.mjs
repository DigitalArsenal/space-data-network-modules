#!/usr/bin/env node
// SPEC 16.11 and 16.18, DigitalArsenal/spacedatanetwork-stack#473: above its eccentricity switch every class, low orbit included,
// carries the field's terms of degree 2 to 31, each once: the slow share of a term in the rates (the class's own terms, in low
// orbit the shallow set's, every other at or above the size cut of 0.5 m, with the band taper of its rate as its weight) and
// the fast share on the grid, whose families are built when one of their terms reaches 0.2 m there. Before, the grid left each
// family's whole slow band out and no rate carried it (from #467 the one-day class kept it on the grid down to 1e-2 n), the rates
// and the grid stopped at degree 12, and in low orbit the grid kept the band down to 1e-3 n and nothing carried the rest.
// 1. sdnap_slow_terms, cap 31, on one set of each class above its switch: class 0 (0.40 rev/day, e 0.9, i 55 deg), one-day
//    (1.0027 rev/day, e 0.82, i 10: exactly synchronous), half-day (2.25 rev/day, e 0.73, i 27), eight-hour (2.42 rev/day,
//    e 0.7, i 55), sixteen-hour (1.5 rev/day, e 0.6, i 63.4) and low orbit (12.9945 rev/day, e 0.1, i 98). Outcome: every slow
//    term of degree 2 to 31 is in the rates (the class's own or the shallow set's, or at or above the size cut, with the band
//    taper as its weight) or under the size cut; none is carried nowhere; each set carries slow terms beyond its class's.
// 2. sdnap_wide_families, degree 31, on the same sets: a family is built exactly when its largest term on the grid reaches
//    0.2 m, and every set builds fewer families than the degree holds.
// 3. FFM model truth on a made-up class 0 set at e 0.9 (initial elements 0.40 rev/day, e 0.9, i 55, node 63, perigee 234.5,
//    M 274.2 deg): EGM96 70 x 70, the Sun and Moon on both sides, no drag or radiation. The set is fitted to the forecast's
//    own 5 days on a 10-minute grid (the best record), so what remains is what the theory cannot represent. Outcome: the
//    largest distance over the 5 days is within BOUND_M (measured MEASURED_M; 2,691.4 m before #473).
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';

const CUT_M = 0.5, FAMILY_CUT_M = 0.2, DEGREE = 31, BOUND_M = 300;
const taper = (x) => (x <= 0.9 ? 1 : x >= 1.1 ? 0 : Math.cos((0.5 * Math.PI * (x - 0.9)) / 0.2) ** 2);
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
const ROW = 8, x = h.instance.exports, MAX = 60000, pin = x.sdnap_alloc(32), prow = x.sdnap_alloc(MAX * ROW * 8);
const SETS = {'class 0': [0.40, 0.9, 55], 'one-day': [1.0027, 0.82, 10], 'half-day': [2.25, 0.73, 27], 'eight-hour': [2.42, 0.7, 55],
  'sixteen-hour': [1.5, 0.6, 63.4], 'low orbit': [12.9945, 0.1, 98]};
const summary = {};
for (const [name, el] of Object.entries(SETS)) {
  new Float64Array(h.memory.buffer, pin, 4).set([...el, DEGREE]);
  const count = x.sdnap_slow_terms(pin, prow, MAX);
  assert.ok(count > 0 && count <= MAX, `${name}: sdnap_slow_terms ${count}`);
  const rows = Array.from({length: count}, (_, k) => Array.from(new Float64Array(h.memory.buffer, prow + ROW * 8 * k, ROW)));
  // in the rates: the class's own (weight 1), in low orbit the shallow set's (q = 0, w = j = 1, orders 2 and up, any size), or a
  // term at or above the cut, each but the class's with the band taper as its weight; else under the cut
  const shallow = (r) => name === 'low orbit' && r[0] - 2 * r[2] === 1 && r[3] === 0 && r[1] >= 2;
  const wrong = rows.filter((r) => !(r[5] === 1 ? r[6] === 1 || ((r[7] >= CUT_M || shallow(r)) && Math.abs(r[6] - taper(Math.abs(r[4]) / 0.045)) < 1e-12) : r[5] === 5 && r[7] < CUT_M));
  // the grid's families: built exactly when the largest term's share on the grid reaches the family cut
  new Float64Array(h.memory.buffer, pin, 4).set([...el, DEGREE]);
  const fam = x.sdnap_wide_families(pin, prow, MAX);
  assert.ok(fam > 0 && fam <= MAX, `${name}: sdnap_wide_families ${fam}`);
  const fr = Array.from({length: fam}, (_, k) => Array.from(new Float64Array(h.memory.buffer, prow + 4 * 8 * k, 4)));
  const famWrong = fr.filter((f) => (f[2] >= FAMILY_CUT_M) !== (f[3] === 1));
  summary[name] = {slowTerms: count, rates: rows.filter((r) => r[5] === 1).length, underSizeCut: rows.filter((r) => r[5] === 5).length,
    nowhere: rows.filter((r) => r[5] === 4 || r[5] === 0).length, families: fam, built: fr.filter((f) => f[3] === 1).length,
    largestLeftOffM: +Math.max(0, ...fr.filter((f) => f[3] !== 1).map((f) => f[2])).toFixed(4)};
  assert.equal(wrong.length, 0, `${name}: ${wrong.length} terms of degree 2 to ${DEGREE} not where the rule puts them: ${JSON.stringify(wrong.slice(0, 3))}`);
  assert.equal(summary[name].nowhere, 0, `${name}: no slow term of degree 2 to ${DEGREE} carried nowhere`);
  assert.equal(famWrong.length, 0, `${name}: ${famWrong.length} families built or left off against the cut: ${JSON.stringify(famWrong.slice(0, 3))}`);
  assert.ok(summary[name].built < fam, `${name}: the cut leaves families off (${summary[name].built} of ${fam})`);
}
// class 0 has no class terms: every term in its rates is one this rule carries
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
