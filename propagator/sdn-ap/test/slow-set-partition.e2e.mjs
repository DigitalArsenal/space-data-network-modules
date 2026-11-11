#!/usr/bin/env node
// E2E (stack #477, SPEC 16.18, the low table's part): where each slow tesseral term is carried, by the diagnostic
// sdnap_slow_terms. For a set inside each measured commensurability band (epoch mean elements, the stated tesseral degree 31)
// it lists every term of j = 1 to 6, |q| up to 4, orders and degrees to 70 whose own angle rate is inside 1.3 shallow bands,
// with its carrier (1 the rates, 3 the output table, 0 nowhere under the table's 1e-3 n floor, 4 nowhere above the slow set's
// degree, 5 nowhere under the size cut), the rates' weight w and the term's size (along-track amplitude through the mean
// motion, m).
// Asserted:
// - each (l, m, p, q) is listed once (in one place), and w is in [0, 1] (the table holds 1 - w of a term the rates carry);
// - the rule as it lands (q = 0): every q = 0 term whose size reaches 0.5 m is in the rates, every q = 0 term in the rates beyond
//   the shallow set's own (j = 1 to degree 31) reaches 0.5 m, and no q != 0 term is in the rates;
// - the named terms: at 550 km (i 87.35, 15:1) the second harmonic, order 30 at j = 2, degree 30 (the term main carried nowhere:
//   1.2 km at day 5 with the field at 31 x 31), is in the rates; at 891 km (SWOT-like, 14:1) order 14 at j = 1 is carried to
//   degree 35 at least and order 28 at j = 2 to degree 34 at least (where the 0.5 m cut ends each series);
// - a set the slow set leaves alone selects nothing beyond the shallow set's own (a LAGEOS-like set at 6.39 rev/day), and a
//   set outside the low table returns -1 (geostationary; a low orbit above its eccentricity switch, e 0.06).
// Printed: per set the count in the rates beyond the shallow set's, and the q != 0 terms the landing leaves on the output table
// or nowhere, with their sizes (stack #477's open part).
//   node test/slow-set-partition.e2e.mjs
import assert from 'node:assert/strict';
import { openModule } from './lib/module.mjs';

const m = await openModule();
const x = m.x;
const MAX = 40000, COLS = 8;
const inp = x.sdnap_alloc(4 * 8), out = x.sdnap_alloc(MAX * COLS * 8);
/** The diagnostic's rows for mean motion n (rev/day), e, i (deg), tesseral degree cap. */
function listing(n, e, i, cap = 31) {
  new Float64Array(m.harness.memory.buffer, inp, 4).set([n, e, i, cap]);
  const count = x.sdnap_slow_terms(inp, out, MAX);
  if (count < 0) return null;
  assert.ok(count <= MAX, `${count} rows fit`);
  const v = new Float64Array(m.harness.memory.buffer, out, count * COLS).slice();
  return Array.from({ length: count }, (_, k) => ({ l: v[COLS * k], m: v[COLS * k + 1], p: v[COLS * k + 2], q: v[COLS * k + 3],
    rate: v[COLS * k + 4], carrier: v[COLS * k + 5], w: v[COLS * k + 6], size: v[COLS * k + 7] }));
}
const j = (t) => t.l - 2 * t.p + t.q;
const SETS = {
  '550 km, i 87.35 (15:1)': [15.055, 0.001, 87.35],
  '891 km, SWOT-like (14:1)': [13.905, 0.0001, 77.6],
  '814 km, Sentinel-3-like (57:4)': [14.26, 0.0011, 98.65],
  '880 km, i 97.6 (14:1)': [14.04, 0.001, 97.6],
  '420 km, i 87.3 (31:2)': [15.489, 0.001, 87.3],
  '500 km, i 87.7 (61:4)': [15.219, 0.001, 87.7],
};
const report = {};
for (const [name, [n, e, i]] of Object.entries(SETS)) {
  const rows = listing(n, e, i);
  assert.ok(rows && rows.length > 0, `${name}: the low table lists slow terms`);
  const keys = new Set();
  for (const t of rows) {
    const k = `${t.l},${t.m},${t.p},${t.q}`;
    assert.ok(!keys.has(k), `${name}: (l, m, p, q) = (${k}) is listed once`);
    keys.add(k);
    assert.ok(t.w >= 0 && t.w <= 1, `${name}: (${k}) weight ${t.w} in [0, 1]`);
    if (t.q === 0 && t.size >= 0.5) assert.equal(t.carrier, 1, `${name}: (${k}) q = 0, ${t.size.toFixed(2)} m, is in the rates`);
    if (t.q !== 0) assert.notEqual(t.carrier, 1, `${name}: (${k}) q != 0 is not in the rates as this lands`);
    const own = j(t) === 1 && t.q === 0 && t.l <= 31;
    if (t.carrier === 1 && !own) assert.ok(t.size >= 0.5, `${name}: (${k}) in the rates beyond the shallow set's reaches 0.5 m (${t.size})`);
  }
  const extra = rows.filter((t) => t.carrier === 1 && !(j(t) === 1 && t.q === 0 && t.l <= 31));
  const open = rows.filter((t) => t.q !== 0 && t.size >= 0.5).sort((a, b) => b.size - a.size);
  report[name] = { rows: rows.length, inRatesBeyondShallow: extra.length,
    qNonzeroLeft: open.length, largestLeft: open.slice(0, 3).map((t) => ({ l: t.l, m: t.m, q: t.q, rateOverN: +t.rate.toPrecision(3), carrier: t.carrier, sizeM: +t.size.toPrecision(3) })) };
}
{
  const rows = listing(...SETS['550 km, i 87.35 (15:1)']);
  const t = rows.find((r) => r.l === 30 && r.m === 30 && r.q === 0 && j(r) === 2);
  assert.ok(t && t.carrier === 1, '550 km: order 30 at j = 2, degree 30 (15:1 second harmonic) is in the rates');
}
{
  const rows = listing(...SETS['891 km, SWOT-like (14:1)']);
  const top = (mm, jj) => Math.max(...rows.filter((r) => r.m === mm && j(r) === jj && r.q === 0 && r.carrier === 1).map((r) => r.l));
  // measured 2026-11-11: to degree 35 and 34 (the 0.5 m cut ends each series there; main carried order 14 to 31 and order 28
  // nowhere)
  assert.ok(top(14, 1) >= 35, `891 km: order 14 at j = 1 to degree ${top(14, 1)}`);
  assert.ok(top(28, 2) >= 34, `891 km: order 28 at j = 2 to degree ${top(28, 2)}`);
}
{
  const rows = listing(6.39, 0.0045, 109.8);
  const extra = (rows ?? []).filter((t) => t.carrier === 1 && !(j(t) === 1 && t.q === 0 && t.l <= 31));
  assert.equal(extra.length, 0, `LAGEOS-like: nothing in the rates beyond the shallow set's (${extra.length})`);
}
assert.equal(listing(1.0027, 0.0003, 0.05), null, 'geostationary: outside the low table (-1)');
assert.equal(listing(14.0, 0.06, 98), null, 'a low orbit at e 0.06: above its switch, outside the low table (-1)');
for (const [name, r] of Object.entries(report)) console.log(JSON.stringify({ set: name, ...r }));
console.log('slow-set partition E2E: PASS');
