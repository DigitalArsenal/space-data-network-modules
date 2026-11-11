#!/usr/bin/env node
// SPEC 16.18, DigitalArsenal/spacedatanetwork-stack#467: above the eccentricity switch a one-day set carries each slow tesseral
// term in exactly one place: the class's rates (SGP4-XP's 27 terms), the grid (every other term of degree 2 to 12 drifting at
// 1e-2 n or faster), or nowhere (slower than 1e-2 n, or above degree 12).
// 1. sdnap_slow_terms on a THEMIS A-like set (1.0493 rev/day, e 0.825, i 11.9 deg) and on a one-day set just above the switch
//    (1.0496 rev/day, e 0.3001, i 10 deg), tesseral cap 31. Outcome: every slow term has one carrier by the rules above; the
//    class's 27 terms, and only they, are in the rates, with the rates' weight 1 (0 on every other row: no taper above the
//    switch) and every row's size finite and not negative; on the THEMIS A-like set the grid holds terms of degree 5 and up and
//    terms of degree 3 and 4 with |q| above 4, the terms 0.6.18 carried nowhere.
// 2. FFM model truth: a made-up THEMIS A-like set whose fitted mean motion lies in the band (initial elements 1.0426 rev/day,
//    e 0.8246, i 11.9, node 90, perigee 300 deg; fitted 1.0493 rev/day). EGM96 70 x 70, Sun and Moon from DE440, no drag or
//    radiation pressure on either side; a 72 h fit flown 7 days on a 10-minute grid. Outcome: the day-5 whole-day 3D RMS is
//    within 150 m (measured 92.0 m; 475.6 m through 0.6.18).
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {wasmPath} from './lib/module.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';

// the one-day class's terms (l, m, p, q), SPEC 6.1
const CLASS = [[2, 2, 0, 0], [2, 2, 1, 2], [2, 2, 2, 4], [3, 1, 0, -2], [3, 1, 1, 0], [3, 1, 2, 2], [3, 1, 3, 4], [3, 2, 0, -1], [3, 2, 1, 1],
  [3, 2, 2, 3], [3, 3, 0, 0], [3, 3, 1, 2], [3, 3, 2, 4], [4, 1, 0, -3], [4, 1, 1, -1], [4, 1, 2, 1], [4, 1, 3, 3], [4, 2, 0, -2], [4, 2, 1, 0],
  [4, 2, 2, 2], [4, 2, 3, 4], [4, 3, 0, -1], [4, 3, 1, 1], [4, 3, 2, 3], [4, 4, 0, 0], [4, 4, 1, 2], [4, 4, 2, 4]];
const inClass = (r) => CLASS.some(([l, m, p, q]) => r[0] === l && r[1] === m && r[2] === p && r[3] === q);
// from #473 the class's other slow terms are in the rates too, at or above the size cut (0.5 m), to the grid's degree (31)
const expected = (r) => (inClass(r) ? 1 : r[0] > 31 ? 4 : r[7] >= 0.5 ? 1 : 5);
// the rates' weight of a term the class does not carry: the band taper of its rate (the grid holds the rest)
const taper = (x) => (x <= 0.9 ? 1 : x >= 1.1 ? 0 : Math.cos((0.5 * Math.PI * (x - 0.9)) / 0.2) ** 2);

const h = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});
// a row (SPEC 16.18): l, m, p, q, psi-dot / n, carrier, the rates' weight w, the term's size (m)
const ROW = 8, x = h.instance.exports, MAX = 20000, pin = x.sdnap_alloc(32), prow = x.sdnap_alloc(MAX * ROW * 8);
const read = (el) => {
  new Float64Array(h.memory.buffer, pin, 4).set(el);
  const count = x.sdnap_slow_terms(pin, prow, MAX);
  assert.ok(count > 0 && count <= MAX, `sdnap_slow_terms: ${count}`);
  return Array.from({length: count}, (_, k) => Array.from(new Float64Array(h.memory.buffer, prow + ROW * 8 * k, ROW)));
};
const SETS = {'THEMIS A-like': [1.0493, 0.825, 11.9, 31], 'one-day e 0.3001': [1.0496, 0.3001, 10, 31]};
const summary = {};
for (const [name, el] of Object.entries(SETS)) {
  const rows = read(el);
  const wrong = rows.filter((r) => r[5] !== expected(r));
  const by = rows.reduce((o, r) => ({...o, [r[5]]: (o[r[5]] ?? 0) + 1}), {});
  const others = rows.filter((r) => r[5] === 1 && !inClass(r));
  summary[name] = {slowTerms: rows.length, rates: by[1] ?? 0, classTerms: rows.filter(inClass).length, underSizeCut: by[5] ?? 0, aboveDegree12: by[4] ?? 0,
    ratesDegree5Up: others.filter((r) => r[0] >= 5).length, ratesDegree3to4HighQ: others.filter((r) => r[0] <= 4 && Math.abs(r[3]) > 4).length};
  console.log(JSON.stringify({[name]: summary[name]}));
  assert.equal(wrong.length, 0, `${name}: ${wrong.length} terms not where the rules put them: ${JSON.stringify(wrong.slice(0, 3))}`);
  const weight = (r) => (r[5] !== 1 ? 0 : inClass(r) ? 1 : taper(Math.abs(r[4]) / 0.045));
  const badW = rows.filter((r) => Math.abs(r[6] - weight(r)) > 1e-12), badSize = rows.filter((r) => !(Number.isFinite(r[7]) && r[7] >= 0));
  assert.equal(badW.length, 0, `${name}: the rates' weight is 1 on the class's terms, the band taper on the others: ${JSON.stringify(badW.slice(0, 3))}`);
  // a size is finite and not negative (a term of |q| near 50 at e 0.825 has a Hansen coefficient below the quadrature's reach: 0)
  assert.equal(badSize.length, 0, `${name}: every size finite and not negative: ${JSON.stringify(badSize.slice(0, 3))}`);
}
x.sdnap_free(pin);
x.sdnap_free(prow);
await h.close?.();
// from #473 the terms of degree 3 and 4 with |q| above 4 lie under the size cut on this set (the grid held them from #467)
assert.ok(summary['THEMIS A-like'].ratesDegree5Up > 0,
  `THEMIS A-like: the rates hold the terms of degree 5 and up that 0.6.18 carried nowhere (${JSON.stringify(summary['THEMIS A-like'])})`);

const r = await runModelTruth({name: 'THEMIS A-like', n: 1.0426, e: 0.8246, i: 11.9, raan: 90, argp: 300, ma: 0, drag: false, field: [70, 70], forces: [31, 20],
  hourly: true, gridMinutes: 10});
const days = Object.fromEntries(Object.entries(r.wholeDay).map(([d, v]) => [d, {e: +v.e.toFixed(1), r: +v.r.toFixed(1), t: +v.t.toFixed(1), n: +v.n.toFixed(1)}]));
console.log(JSON.stringify({modelTruth: {fittedN: r.fitted.n, fitWrmsM: +(r.fitted.wrms * 1000).toFixed(1), wholeDayM: days, apSha256: r.apSha256}}));
assert.ok(r.wholeDay[5].e <= 150, `THEMIS A-like model truth, day 5: ${r.wholeDay[5].e.toFixed(1)} m (bound 150 m; measured 92.0 m, 475.6 m through 0.6.18)`);
console.log('One-day slow band E2E: PASS');
process.exit(0);
