#!/usr/bin/env node
// E2E (stack #477, SPEC 16.1, the band guard): in the low table above degree 12, the output table takes each term's rate at
// the epoch and 8 days on at the set's own drag rate at the epoch (e and i held), keeps the smaller share of the two and none
// where the rate changes sign. For n in that range the table holds no term whose rate passes zero (the evaluator divides by
// the current rate). A flight before the epoch, past 8 days, or decaying faster than the epoch's rate is outside what the
// guard covers (SPEC 16.1 gives the measured readings there).
// Fixture: #498's grid-hp200-e0.01-i55 as a seeded AP set (perigee 200 km, e 0.01, i 55, RAAN 93.4, argp 127.6, M 37.8;
// BTERM 0.022, a typical satellite's drag term; FORCES 31,20 with the slow set and the solid tide; Jacchia 1970 on the
// fixture rows; epoch 2026-10-29 00:00 UTC). Drag takes the rate of terms inside the band's edge at the epoch through zero
// at 101.07 h (on the case's fitted record, the m = 48, j = 3 terms of degree 53 to 69).
// Flown every 60 s for eight days, or to the set's decay crossing (SPEC 16.25, stack #564: the call answers the epochs before
// it and its block's COMMENT names it; before 0.6.46, the most whole days the module flew before it refused). The jump detector
// is |d_k - (d_(k-1) + d_(k+1))/2|, d the second difference of position less h^2 times the two-body acceleration
// (mu 398600.4415 km^3/s^2): half the fourth difference of the states. One state displaced by delta reads 3 delta (the
// fourth difference's 6 delta, halved); a block of states displaced together by delta reads 1.5 delta at its edge; smooth
// content falls as h^4.
// Asserted: the flight reaches past the crossing (CROSSING_H), and the detector reads at most BOUND_M (30 m) over it.
// Measured 2026-11-12, the set flown 5 days (refused after, at 147 km):
// - without the guard (git fefd9be4, wasm f1b29eff): 1,970 km at 101.07 h, where the terms' rate passes zero;
// - with it (git 258d824d, wasm 01f8fd18; and git 9855dadd, wasm 302ec561, with sdn-ap 0.6.39 merged in): 2.98 m at
//   105.15 h, the drag near 190 km.
// Every number comes from the built module's own calls (propagate). JS only moves bytes and compares numbers the module
// produced.
//   node test/fast-side-band-guard.e2e.mjs
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { wasmPath } from './lib/module.mjs';
import { seedOcm, flight, rowsThrough } from './lib/ocm.mjs';
import { spwFixtureRows } from './lib/spw-constant.mjs';

const MU = 398600.4415, H = 60, BOUND_M = 30, CROSSING_H = 101.07;
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const fixture = spwFixtureRows();
const rows = rowsThrough(Array.isArray(fixture) ? fixture : fixture.rows);
const seed = seedOcm({ epoch, n: 16.0288063746, e: 0.01, i: 55, raan: 93.4, argp: 127.6, ma: 37.8, bterm: 0.022, norad: 99498,
  records: true, rows, tesseral: 31, zonal: 20, slow: true, solidTides: true });
const h = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const fly = async (secs) => {
  const r = await h.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) return { error: `${r.errorCode}: ${r.errorMessage}` };
  const b = OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  return { lines: b.EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z]), decayed: /^decayed:(\S+);/.exec(b.COMMENT ?? '')?.[1] ?? null };
};
const failures = [];
// the span the set reaches: whole days down from eight while the flight is refused
let st = null, days = 8, refusal = null, decayed = null;
for (; days >= 1; --days) {
  const f = await fly(Array.from({ length: (days * 86400) / H + 1 }, (_, j) => j * H));
  if (f.lines) { st = f.lines; decayed = f.decayed; break; }
  refusal = f.error;
}
const flownH = st === null ? 0 : ((st.length - 1) * H) / 3600;
let worst = 0, at = 0, lowKm = null;
if (st === null) failures.push(`the set is refused at every span from 8 days to 1 (${refusal})`);
else {
  if (!(flownH > CROSSING_H)) failures.push(`the flight reaches ${flownH.toFixed(2)} h, short of the crossing at ${CROSSING_H} h`);
  const d = [];
  for (let q = 1; q < st.length - 1; ++q) {
    const r = st[q], r3 = Math.hypot(...r) ** 3;
    d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + H * H * MU * r[z] / r3) * 1000));
  }
  for (let q = 1; q + 1 < d.length; ++q) {
    const v = Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z])));
    if (v > worst) { worst = v; at = (q + 1) * H; }
  }
  lowKm = Math.min(...st.map((r) => Math.hypot(...r))) - 6378.137;
  if (!(worst <= BOUND_M)) failures.push(`the jump detector reads ${worst.toExponential(3)} m at ${(at / 3600).toFixed(3)} h (at most ${BOUND_M} m)`);
}
await h.close?.();
console.log(JSON.stringify({ flownH: +flownH.toFixed(3), decayedAt: decayed, lowestKm: lowKm === null ? null : +lowKm.toFixed(1), detectorM: +worst.toExponential(3), atH: +(at / 3600).toFixed(3) }));
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('fast-side band guard E2E: PASS');
process.exit(0);
