#!/usr/bin/env node
// E2E (stack #503, SPEC 16.20): the field's census, sdnap_field_census. For a set of epoch mean elements whose record states
// the tesseral degree 31 (a fit's record, with the slow set), it lists every tesseral term (l, m, p, q) of the embedded field,
// order 1 to 70, degree to 70, |q| up to 4 (12 above e 0.3), whose size over the 5-day forecast reaches 0.5 m, with the
// weights the carriers a set of these elements builds hold of it (the rates, the family grid, the output table, the m-daily
// family). The rule (TESSERAL-PARTITION, stack #503): every such term is carried exactly once, in every class, on both sides
// of every switch. The sweep: low orbit at five heights, three inclinations and e 0 to 0.05; class 0 above its switch;
// the one-day, half-day, eight-hour and sixteen-hour classes on both sides of their switch; the 1,100-minute limit.
// Asserted:
// - no term is carried twice (code 30), and a term's weights are in [0, 1.001];
// - every term carried nowhere (codes 20 to 24) belongs to a known hole below, each named with its issue; a hole that no set
//   of the sweep shows any more fails the test (remove it when its pull request lands);
// - the census of a set is the same twice (no state carried between calls) and returns -1 for elements it refuses.
// Printed: per band the ten largest terms carried nowhere, with their hole.
//   node test/field-census.e2e.mjs
import assert from 'node:assert/strict';
import { openModule } from './lib/module.mjs';

const m = await openModule();
const x = m.x;
const MAX = 200000, COLS = 10, CUT = 0.5;
const inp = x.sdnap_alloc(6 * 8), out = x.sdnap_alloc(MAX * COLS * 8);
/** The census's rows for mean motion n (rev/day), e, i (deg), the record's tesseral degree cap. */
function census(n, e, i, cap = 31) {
  new Float64Array(m.harness.memory.buffer, inp, 5).set([n, e, i, cap, CUT]);
  const count = x.sdnap_field_census(inp, out, MAX);
  if (count < 0) return null;
  assert.ok(count <= MAX, `${count} rows fit`);
  const v = new Float64Array(m.harness.memory.buffer, out, count * COLS).slice();
  return Array.from({ length: count }, (_, k) => ({ l: v[COLS * k], m: v[COLS * k + 1], p: v[COLS * k + 2], q: v[COLS * k + 3],
    rate: v[COLS * k + 4], code: v[COLS * k + 5], wr: v[COLS * k + 6], total: v[COLS * k + 7], size: v[COLS * k + 8], periodDays: v[COLS * k + 9] }));
}
// The branch a set's epoch elements give it (res::band_of, tess::wide_set, the 1,100-minute limit), in rev/day.
const classOf = (n) => (n > 0.802 && n < 1.2034 ? 1 : n >= 1.6045 && n <= 2.4068 ? 2 : n > 2.4068 && n <= 3.6101 ? 3 : n >= 1.2034 && n <= 1.805 ? 4 : 0);
const branchOf = (n, e) => {
  const cls = classOf(n), longPeriod = 1440 / n >= 1100, wide = e > (cls === 0 ? 0.05 : 0.3);
  return { cls, longPeriod, wide, lowTable: cls === 0 && !longPeriod && !wide };
};
const SLOW = 1.3 * 0.045;  // the slow set's selection band, in n
const slowRate = (t) => Math.abs(t.rate) < SLOW;
const tableSide = (t) => Math.abs(t.rate) >= 1.1 * 0.045;  // the low table: the output table holds a term from 1.1 bands

// Known holes: the terms the theory carries nowhere today, each with the issue that closes it.
const HOLES = [
  { issue: 'stack #477', what: 'the low table: terms the output table holds by rate but not by degree (above 12, the m-daily terms too)',
    test: (b, t) => b.lowTable && t.code === 20 && tableSide(t) },
  { issue: 'stack #477', what: 'the low table: the band taper\'s complement (1 - w) of a slow term above the output table\'s degree',
    test: (b, t) => b.lowTable && t.code === 24 },
  { issue: 'stack #503', what: 'the low table: fast terms of |q| 2 or more (the output table holds |q| up to 1)',
    test: (b, t) => b.lowTable && t.code === 22 && tableSide(t) },
  { issue: 'stack #503', what: 'a carrier\'s own size cut measures the term below the census (the output table counts the eccentricity vector\'s part radially; terms under 1 m)',
    test: (b, t) => t.code === 23 && t.size < 2 * CUT },
  { issue: 'stack #503', what: 'the low table: the slow set\'s cut measures a term through the mean motion and the eccentricity vector, not through the inclination (dF/di)',
    test: (b, t) => b.lowTable && t.code === 23 && !tableSide(t) },
  { issue: 'stack #474', what: 'the one-day class above its switch: terms under its floor or above the grid\'s degree',
    test: (b, t) => b.cls === 1 && b.wide && (t.code === 20 || t.code === 21) },
  { issue: 'stack #497', what: 'above the switch, every class: terms above the grid\'s degree 12',
    test: (b, t) => b.wide && (t.code === 20 || t.code === 24) },
  // from 0.6.28 the wide slow list carries the slow band above the switch outside low orbit: the hole is low orbit's alone
  { issue: 'stack #473', what: 'above the switch in low orbit: slow terms the grid leaves out and no rate carries',
    test: (b, t) => b.wide && b.cls === 0 && !b.longPeriod && t.code === 21 },
  { issue: 'stack #511', what: 'outside the low table below the switch: terms the output table\'s degree, q range or band floor leaves out and the class\'s rates do not carry',
    test: (b, t) => !b.lowTable && !b.wide && t.code >= 20 && t.code <= 22 },
];

const SETS = [];
const nOf = (hpKm, e) => { const a = (6378.137 + hpKm) / (1 - e); return 86400 / (2 * Math.PI * Math.sqrt(a ** 3 / 398600.4418)); };
for (const hp of [300, 500, 800, 1400, 2000])
  for (const i of [0.5, 55, 98])
    for (const e of [0, 0.02, 0.05]) SETS.push({ band: 'low table', name: `${hp} km, e ${e}, i ${i}`, n: nOf(hp, e), e, i });
for (const hp of [300, 1000])
  for (const e of [0.051, 0.1, 0.3, 0.6, 0.9])
    for (const i of [55, 98]) SETS.push({ band: 'class 0 above its switch', name: `perigee ${hp} km, e ${e}, i ${i}`, n: nOf(hp, e), e, i });
for (const [n, label] of [[1.0027, 'one-day'], [2.006, 'half-day'], [3.0, 'eight-hour'], [1.5, 'sixteen-hour']])
  for (const e of [0.001, 0.29, 0.31, 0.7])
    for (const i of [10, 63.4]) SETS.push({ band: label, name: `${n} rev/day, e ${e}, i ${i}`, n, e, i });
// an eccentric synchronous set with a low perigee (THEMIS-like, stack #474)
SETS.push({ band: 'one-day', name: '1.0027 rev/day, e 0.82, i 10', n: 1.0027, e: 0.82, i: 10 });
for (const n of [1.30, 1.32, 0.7]) SETS.push({ band: 'class 0, period near 1,100 min', name: `${n} rev/day, e 0.01, i 55`, n, e: 0.01, i: 55 });

const seen = new Map(HOLES.map((h) => [h, 0]));
const unknown = [], worst = {};
let rowsTotal = 0;
const t0 = performance.now();
for (const s of SETS) {
  const rows = census(s.n, s.e, s.i);
  assert.ok(rows, `${s.name}: the census answers`);
  rowsTotal += rows.length;
  const b = branchOf(s.n, s.e);
  for (const t of rows) {
    assert.ok(t.wr >= 0 && t.total >= 0 && t.total <= 1.001 || t.code === 30, `${s.name}: weights in range`);
    assert.notEqual(t.code, 30, `${s.name}: (${t.l}, ${t.m}, ${t.p}, ${t.q}) is carried twice (weights sum ${t.total})`);
    assert.ok(t.rate === 0 || Math.abs(t.periodDays * Math.abs(t.rate) * s.n - 1) < 1e-6, `${s.name}: the period column is 1 / (|psi-dot / n| n)`);
    if (t.code < 20) continue;
    const h = HOLES.find((k) => k.test(b, t));
    if (!h) { unknown.push({ set: s.name, band: s.band, wide: b.wide, ...t }); continue; }
    seen.set(h, seen.get(h) + 1);
    h.largestM = Math.max(h.largestM ?? 0, t.size);
    (worst[s.band] ??= []).push({ set: s.name, hole: h.issue, l: t.l, m: t.m, p: t.p, q: t.q, j: t.l - 2 * t.p + t.q,
      rateOverN: +t.rate.toPrecision(3), periodDays: +t.periodDays.toPrecision(3), code: t.code, sizeM: +t.size.toPrecision(3) });
  }
}
const ms = performance.now() - t0;
// the same census twice; and a refusal
const again = census(SETS[1].n, SETS[1].e, SETS[1].i), first = census(SETS[1].n, SETS[1].e, SETS[1].i);
assert.deepEqual(again, first, 'the census of a set is the same twice');
assert.equal(census(15, 1.2, 55), null, 'e above 1 is refused');

for (const [band, list] of Object.entries(worst)) {
  list.sort((a, b) => b.sizeM - a.sizeM);
  console.log(JSON.stringify({ band, nowhere: list.length, largest: list.slice(0, 10) }));
}
console.log(JSON.stringify({ sets: SETS.length, rows: rowsTotal, ms: Math.round(ms), holes: HOLES.map((h) => ({ issue: h.issue, what: h.what, terms: seen.get(h), largestM: +(h.largestM ?? 0).toPrecision(3) })) }));
unknown.sort((a, b) => b.size - a.size);
const groups = {};
for (const t of unknown) {
  const g = `${t.band}${t.wide ? ' above its switch' : ''}, code ${t.code}${Math.abs(t.rate) < SLOW ? ', slow' : ''}`;
  (groups[g] ??= []).push(t);
}
for (const [g, list] of Object.entries(groups))
  console.log(JSON.stringify({ unknown: g, terms: list.length, largest: list.slice(0, 3).map((t) => ({ set: t.set, l: t.l, m: t.m, p: t.p, q: t.q, rateOverN: +t.rate.toPrecision(3), sizeM: +t.size.toPrecision(3) })) }));
assert.equal(unknown.length, 0, `terms carried nowhere outside the known holes: ${unknown.length}, the largest ${JSON.stringify(unknown.slice(0, 5))}`);
for (const [h, k] of seen) assert.ok(k > 0, `the known hole "${h.what}" (${h.issue}) shows no term: remove it`);
console.log('field census E2E: PASS');
process.exit(0);
