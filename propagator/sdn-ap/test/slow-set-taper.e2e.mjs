#!/usr/bin/env node
// E2E (stack #477, SPEC 16.18, the low table's part): a slow-set record whose terms sit in the band's taper, so their weight
// moves with the state as drag raises the mean motion. Its output is continuous through the taper, and the same state comes
// out in any order of requests.
// Fixture: a strong-drag low orbit (i 53, e 0.001, RAAN 40, argp 90, M 0; BTERM 0.01 m^2/kg; NRLMSISE-00 on constant rows,
// F10.7 150 / Ap 15; FORCES 31,20; epoch 2026-10-29 00:00 UTC). Its mean motion is chosen by the diagnostic so that the j = 1,
// order-15 family's band taper (the rates' weight) is 0.9 at the epoch (15.9175 rev/day, about 290 km; the family's rate there
// is about 0.04 n). Over 7 days drag raises n by 0.033 rev/day, which moves that weight from 0.90 to 0.63 (measured 2026-11-11).
// With BTERM 0.05 the orbit decays to where the detector below reads up to 13 m on day 6.5 with or without the slow set, so
// the fixture keeps the decay moderate.
// Asserted:
// - the diagnostic lists the family's terms in the rates with a weight strictly between 0 and 1 at the epoch, and the weight at
//   the mean motion of day 7 (vis-viva, averaged over one revolution) is at least 0.2 lower;
// - continuity: in 14 windows (every 12 h from day 0.5 to day 7), each 600 s either side at 10 s, the jump detector of
//   test/egrid-continuity (the second difference of position less h^2 times the two-body acceleration, against the mean of its
//   neighbours) reads at most 0.08 m, that test's 10 s bound. A step in the weight would show as a kink;
// - order: from the epoch store (load_epochs), 400 times over the 7 days give bit-identical states ascending, descending and
//   shuffled.
//   node test/slow-set-taper.e2e.mjs
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { openModule, wasmPath } from './lib/module.mjs';
import { seedOcm, flight, rowsThrough, T } from './lib/ocm.mjs';
import { spwFixtureRows } from './lib/spw-constant.mjs';

const MU = 398600.4415, epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const I = 53, E = 0.001;

// the mean motion at which the j = 1, order-15 family's weight is 0.9 (the diagnostic, by bisection on n)
const m = await openModule();
const MAX = 40000, COLS = 8, inp = m.x.sdnap_alloc(32), out = m.x.sdnap_alloc(MAX * COLS * 8);
const family = (n) => {
  new Float64Array(m.harness.memory.buffer, inp, 4).set([n, E, I, 31]);
  const count = m.x.sdnap_slow_terms(inp, out, MAX);
  const v = new Float64Array(m.harness.memory.buffer, out, Math.max(0, count) * COLS);
  const rows = [];
  for (let k = 0; k < count; ++k) if (v[COLS * k + 1] === 15 && v[COLS * k] - 2 * v[COLS * k + 2] + v[COLS * k + 3] === 1 && v[COLS * k + 3] === 0)
    rows.push({ l: v[COLS * k], carrier: v[COLS * k + 5], w: v[COLS * k + 6], size: v[COLS * k + 7] });
  return rows;
};
const wOf = (n) => { const r = family(n).filter((t) => t.carrier === 1); return r.length ? r[0].w : 0; };
let lo = 15.8, hi = 16.1;  // the order-15 family's band edge at i 53 lies between (weight 1 at lo, 0 at hi; about 290 km)
assert.ok(wOf(lo) === 1 && wOf(hi) === 0, `the bracket: weight ${wOf(lo)} at ${lo}, ${wOf(hi)} at ${hi} rev/day`);
for (let k = 0; k < 40; ++k) { const mid = 0.5 * (lo + hi); if (wOf(mid) > 0.9) lo = mid; else hi = mid; }
const n = 0.5 * (lo + hi);
const fam = family(n).filter((t) => t.carrier === 1);
assert.ok(fam.length > 0 && fam.every((t) => t.w > 0 && t.w < 1), `the family in the rates inside the taper at n ${n.toFixed(5)} (${fam.length} terms, weight ${fam[0]?.w})`);

const seed = seedOcm({ epoch, n, e: E, i: I, raan: 40, argp: 90, ma: 0, bterm: 0.01, norad: 99477, msis: true, records: true,
  rows: rowsThrough(spwFixtureRows()), tesseral: 31, zonal: 20, slow: true });
const h = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const flyFull = async (secs) => {
  const r = await h.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  assert.equal(r.statusCode, 0, `propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack()
    .EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
const fly = async (secs) => (await flyFull(secs)).map((l) => [l.X, l.Y, l.Z]);
// the mean motion's change over the 7 days (vis-viva, averaged over one revolution at each end) and the weight it moves to
const meanN = async (s0) => {
  const lines = await flyFull(Array.from({ length: 90 }, (_, j) => s0 + j * 60));
  const a = lines.reduce((acc, l) => acc + 1 / (2 / Math.hypot(l.X, l.Y, l.Z) - (l.X_DOT ** 2 + l.Y_DOT ** 2 + l.Z_DOT ** 2) / MU), 0) / lines.length;
  return Math.sqrt(MU / a ** 3) * 86400 / (2 * Math.PI);
};
const dn = (await meanN(7 * 86400 - 5400)) - (await meanN(0));
const wEnd = wOf(n + dn);
assert.ok(fam[0].w - wEnd >= 0.2, `the weight moves through the taper: ${fam[0].w.toFixed(3)} to ${wEnd.toFixed(3)} (n up ${dn.toFixed(4)} rev/day)`);
let worst = 0, at = 0;
for (let w = 1; w <= 14; ++w) {
  const c = w * 43200, step = 10, st = await fly(Array.from({ length: 121 }, (_, j) => c - 600 + j * step));
  const d = [];
  for (let q = 1; q < st.length - 1; ++q) {
    const r = st[q], r3 = Math.hypot(...r) ** 3;
    d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + step * step * MU * r[z] / r3) * 1000));
  }
  for (let q = 1; q + 1 < d.length; ++q) {
    const v = Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z])));
    if (v > worst) { worst = v; at = c / 86400; }
  }
}
await h.close?.();
assert.ok(worst <= 0.08, `the 10 s jump detector reads ${worst.toExponential(3)} m (day ${at.toFixed(2)}; at most 0.08 m)`);

// order: the epoch store, ascending, descending and shuffled
const hs = await createStandaloneHarness('browser', wasmPath, { surface: 'direct' });
const xs = hs.instance.exports;
const prefixed = (b) => { const o = Buffer.alloc(4 + b.length); o.writeUInt32LE(b.length, 0); Buffer.from(b).copy(o, 4); return o; };
const load = async () => {
  const r = await hs.invoke({ methodId: 'load_epochs', inputs: [{ portId: 'ocm', typeRef: T('OCM'), payload: prefixed(seed) }] });
  assert.equal(r.statusCode, 0, `load_epochs ${r.errorCode}: ${r.errorMessage}`);
};
const o6 = xs.sdnap_alloc(48);
const state = (ms) => {  // ms after the epoch; the UTC Julian date as test/set-caches splits it
  const d = (t0 + ms) / 86400000;
  assert.equal(xs.sdnap_epochs_set_at(0, 0, Math.floor(d) + 2440587.5, d - Math.floor(d), o6), 0);
  return Array.from(new Float64Array((hs.memory ?? xs.memory).buffer, o6, 6));
};
const times = Array.from({ length: 400 }, (_, k) => Math.round(k * 7 * 86400000 / 400 + 997 * (k % 7)));
const same = (a, b) => a.every((v, q) => Object.is(v, b[q]));
await load();
const asc = times.map(state);
await load();
const desc = new Array(times.length);
for (let k = times.length - 1; k >= 0; --k) desc[k] = state(times[k]);
await load();
const order = times.map((_, k) => k).sort((a, b) => ((a * 7919) % 401) - ((b * 7919) % 401));
const shuf = new Array(times.length);
for (const k of order) shuf[k] = state(times[k]);
const differDesc = asc.filter((s, k) => !same(s, desc[k])).length, differShuf = asc.filter((s, k) => !same(s, shuf[k])).length;
assert.equal(differDesc, 0, `descending against ascending: ${differDesc} of ${times.length} states differ`);
assert.equal(differShuf, 0, `shuffled against ascending: ${differShuf} of ${times.length} states differ`);
console.log(JSON.stringify({ meanMotion: +n.toFixed(6), familyTerms: fam.length, weightAtEpoch: +fam[0].w.toFixed(4), meanMotionRiseRevDay: +dn.toFixed(4),
  weightAtDay7: +wEnd.toFixed(4), detectorM: +worst.toExponential(3), detectorDay: +at.toFixed(2), orderStates: times.length }));
console.log('slow-set taper E2E: PASS');
process.exit(0);
