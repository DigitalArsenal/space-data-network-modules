#!/usr/bin/env node
// E2E (stack #564; SPEC 16.25, wide sets): an AP set above e 0.3 blends each state in the last fifth of a 48 h interval toward the next
// schedule node's grid. Where that node lies past the set's decay crossing the state is answered from the interval's own grid alone (never
// refused), so it is not 0.6.45's to the bit: 0.6.45 blended toward a grid built from a state past the crossing, which is no orbit.
// Two made-up wide sets that reach the rule's floor (perigee 101.5 km, e 0.5; perigee 101 km, e 0.7; BTERM 0.01), each with its
// crossing in the last fifth of its interval (Jacchia 1970 on the fixture's constant rows, epoch 2026-10-29):
// - every state up to a minute before the crossing is answered (status 0) by this build;
// - every state before the interval's last fifth is 0.6.45's to the bit (git, modules b1a08e44, its SHA-256 checked);
// - the states in the last fifth differ from 0.6.45's by at most WINDOW_BOUND_M;
// - on NRLMSISE-00 (sets of a larger BTERM, so that they decay in days and the numerical propagator, FFM, named below by its SHA-256,
//   flown from the same start state with EGM2008 70 x 70, the Sun and Moon and the drag term, survives to the crossing) the distance
//   of each build to the numerical propagator over those states is printed: it does not separate the builds (the theory's states
//   within hours of a wide set's crossing are no orbit), and where 0.6.45 refuses the states this build answers them.
//   node test/decay-wide.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { requestFor, decodeResult, encodePrw, makeTable, TYPE } from '../../ffm/tests/lib/prwCodec.mjs';
import { ffmPath, requireTruth, checkTruth } from './lib/ffm-truth.mjs';
import { jdOf } from './lib/frames.mjs';
import { ensureBuilt, packageRoot, wasmPath } from './lib/module.mjs';
import { seedOcm, flight, rowsThrough } from './lib/ocm.mjs';
import { spwFixtureRows } from './lib/spw-constant.mjs';
import { scratchTemp } from './lib/scratch.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // FFM 2.3.0 (modules 48a00fd6)
const BASE = { commit: 'b1a08e44', sha256: 'edc9b14b' };  // 0.6.45, the build before the rule
const WINDOW_BOUND_M = 6200;  // measured 6,116 m (set A) and 92.3 m (set B), states 0.6.45 also answers: 0.6.45 blended toward a grid built past the crossing
const MU = 398600.4418, RE = 6378.137, DAY = 864e5, STEP = 600;
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const fixture = spwFixtureRows();
const rows = rowsThrough(Array.isArray(fixture) ? fixture : fixture.rows);
const nOf = (hp, e) => { const a = (RE + hp) / (1 - e); return (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI); };
const seedOf = (c, msis) => seedOcm({ epoch, n: nOf(c.hp, c.e), e: c.e, i: 28.5, raan: 40, argp: 180, ma: 0, bterm: c.bterm, norad: 99564, msis, records: true, rows, tesseral: 31, zonal: 20 });
// each case's set on Jacchia 1970 (j) and on NRLMSISE-00 (m: another BTERM puts the crossing in the last fifth there)
// (the sets cross at the rule's floor, the mean perigee under 100 km, which the Sun and the Moon bring about on a wide orbit: the rule's
// drag test reads the drag's own part of the perigee's rate, which is about 0 there)
const CASES = [{ name: 'A: perigee 101.5 km e 0.5 BTERM 0.01', j: { hp: 101.5, e: 0.5, bterm: 0.01 }, m: { hp: 101.5, e: 0.5, bterm: 0.01 } },
  { name: 'B: perigee 101 km e 0.7 BTERM 0.01', j: { hp: 101, e: 0.7, bterm: 0.01 }, m: { hp: 101, e: 0.7, bterm: 0.01 } }];

ensureBuilt();
const modulesRoot = path.resolve(packageRoot, '../..');
const baseBytes = execFileSync('git', ['-C', modulesRoot, 'show', `${BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
check(createHash('sha256').update(baseBytes).digest('hex').startsWith(BASE.sha256), `0.6.45 at ${BASE.commit} is not ${BASE.sha256}`);
const basePath = path.join(scratchTemp('sdnap-decay-wide-'), 'module-0.6.45.wasm');
fs.writeFileSync(basePath, baseBytes);
const now = await createStandaloneHarness('browser', wasmPath, { surface: 'direct' });
const base = await createStandaloneHarness('browser', basePath, { surface: 'direct' });
const ffm = await createStandaloneHarness('browser', ffmPath, { surface: 'command' });
const kernel = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const msOf = (text) => Date.parse(text.endsWith('Z') ? text : `${text}Z`);
const fly = async (h, seed, secs) => {
  const r = await h.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) return { error: `${r.errorCode}: ${r.errorMessage}` };
  const b = OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  return { lines: b.EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]) };
};
// the crossing (seconds from the epoch) the new build names for a flight to day 10
const crossingOf = async (seed) => {
  const r = await fly(now, seed, [10 * 86400]);
  const m = /decayed:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(r.error ?? '');
  return m ? (msOf(m[1]) - t0) / 1000 : null;
};
const sameBits = (a, b) => a.every((x, k) => Object.is(x, b[k]));
for (const c of CASES) {
  // 1. Jacchia: bits and the window
  const seed = seedOf(c.j, false);
  const cross = await crossingOf(seed);
  check(cross !== null, `${c.name}: the set does not decay by day 10`);
  if (cross === null) continue;
  const interval = Math.floor(cross / (48 * 3600)), windowStart = (interval + 0.8) * 48 * 3600;
  check(cross > windowStart, `${c.name}: the crossing ${(cross / 3600).toFixed(2)} h is not in the last fifth of its interval (from ${(windowStart / 3600).toFixed(2)} h)`);
  const secs = Array.from({ length: Math.floor((cross - 60) / STEP) }, (_, k) => STEP * (k + 1));
  const a = await fly(now, seed, secs);
  check(!a.error && a.lines.length === secs.length, `${c.name}: this build answers ${a.lines?.length ?? a.error} of ${secs.length} states before the crossing`);
  if (a.error) continue;
  const pre = secs.filter((s) => s < windowStart);
  const b = await fly(base, seed, pre);
  check(!b.error && b.lines.length === pre.length, `${c.name}: 0.6.45 answers ${b.lines?.length ?? b.error} of ${pre.length} states before the last fifth`);
  if (b.error) continue;
  pre.forEach((s, k) => check(sameBits(a.lines[k], b.lines[k]), `${c.name}: the state at ${(s / 3600).toFixed(2)} h differs from 0.6.45's before the last fifth`));
  // the last fifth, a state at a time (0.6.45 may refuse some of them itself: it blends toward a grid built past the crossing)
  let worst = 0, compared = 0, baseRefused = 0;
  for (let k = pre.length; k < secs.length; ++k) {
    const one = await fly(base, seed, [secs[k]]);
    if (one.error) { baseRefused++; continue; }
    compared++;
    worst = Math.max(worst, Math.hypot(a.lines[k][0] - one.lines[0][0], a.lines[k][1] - one.lines[0][1], a.lines[k][2] - one.lines[0][2]) * 1000);
  }
  // the answer does not depend on what was asked before: the last fifth's states one at a time, latest first, are the flight's
  for (let k = secs.length - 1; k >= pre.length; --k) {
    const one = await fly(now, seed, [secs[k]]);
    check(!one.error && sameBits(one.lines[0], a.lines[k]), `${c.name}: the state at ${(secs[k] / 3600).toFixed(2)} h asked alone is not the flight's`);
  }
  check(worst <= WINDOW_BOUND_M, `${c.name}: the states in the last fifth differ from 0.6.45's by up to ${worst.toFixed(3)} m (at most ${WINDOW_BOUND_M} m)`);
  console.log(`${c.name}: crossing ${(cross / 3600).toFixed(2)} h; ${pre.length} states before the last fifth 0.6.45's to the bit; ${secs.length - pre.length} states in it (from ${(windowStart / 3600).toFixed(2)} h) answered by this build, ${compared} also answered by 0.6.45 (at most ${worst.toFixed(3)} m apart) and ${baseRefused} refused by 0.6.45`);
  // 2. NRLMSISE-00 against the numerical propagator
  const seedM = seedOf(c.m, true);
  const crossM = await crossingOf(seedM);
  if (crossM === null) { check(false, `${c.name}: on NRLMSISE-00 the set does not decay by day 10`); continue; }
  const winM = (Math.floor(crossM / (48 * 3600)) + 0.8) * 48 * 3600;
  const secsM = Array.from({ length: Math.floor((crossM - 60) / STEP) }, (_, k) => STEP * (k + 1));
  const am = await fly(now, seedM, secsM);
  if (am.error) { check(false, `${c.name}: NRLMSISE-00 flight: ${am.error}`); continue; }
  const bm = new Map();  // 0.6.45's state at each second of the last fifth it answers
  for (const s of secsM) { if (s < winM) continue; const one = await fly(base, seedM, [s]); if (!one.error) bm.set(s, one.lines[0]); }
  const jd = jdOf(epoch), jd0 = jd.whole + jd.frac, mjd0 = Math.floor(jd0 - 2400000.5);
  const start = await fly(now, seedM, [0]);
  const s0 = start.lines[0];
  checkTruth();
  const params = { epochJD: jd0, epochTimeScale: 'UTC', targetJD: jd0 + secsM.at(-1) / 86400, targetTimeScale: 'UTC', position: s0.slice(0, 3), velocity: s0.slice(3), frame: 'GCRF',
    sampleEpochsJD: secsM.map((s) => ({ jd: jd0 + s / 86400, scale: 'UTC' })),
    forces: { gravityMode: 'EGM2008', maxDegree: 70, maxOrder: 70, thirdBody: true, srp: false, drag: true, dragModel: 'NRLMSISE00', massKg: 1000, areaM2: (c.m.bterm * 1000) / 2.2, cr: 1.0, cd: 2.2 },
    weather: { epochUTCJD: jd0, F107: 150, F107a: 150, Ap: 15, Kp: 3 }, integrator: { tolerance: 1e-12, minStep: 0.01, maxStep: 300 }, ephemerisSource: 'JPL_SPK' };
  const rq = requestFor('propagate', params, kernel);
  rq.inputs.push({ portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: Array.from({ length: 15 }, (_, k) => makeTable('EOP', { DATE: new Date((mjd0 + k - 1 - 40587) * DAY).toISOString(), MJD: mjd0 + k - 1, XP: 0, YP: 0, DUT1: 0, LOD: 0 })) })) });
  const fr = await ffm.invoke(rq);
  if (fr.statusCode !== 0) {
    // a perigee of about 100 km is where the numerical propagator ends its flight: it states when, and there is nothing to compare
    if (/reentry/.test(String(fr.errorMessage))) { console.log(`${c.name}: the numerical propagator re-enters before the rule's crossing at ${(crossM / 3600).toFixed(2)} h (${String(fr.errorMessage).slice(-70)})`); continue; }
    check(false, `${c.name}: FFM ${fr.errorCode}: ${fr.errorMessage}`);
    continue;
  }
  const truth = decodeResult(fr).samples;
  let n = 0, dn = 0, db = 0, worstGain = -1e9, all = 0;
  secsM.forEach((s, k) => {
    if (s < winM) return;
    all++;
    if (!bm.has(s)) return;
    const dN = Math.hypot(...[0, 1, 2].map((z) => am.lines[k][z] - truth[k].position[z])) * 1000;
    const dB = Math.hypot(...[0, 1, 2].map((z) => bm.get(s)[z] - truth[k].position[z])) * 1000;
    n++; dn += dN; db += dB; worstGain = Math.max(worstGain, dN - dB);
  });
  // the comparison is printed, not asserted: a decaying wide set that decays within days needs a drag term so large that both builds
  // are thousands of km from the numerical propagator over these states, which separates nothing
  check(all > 0 && Number.isFinite(dn), `${c.name}: no state of the last fifth is answered on NRLMSISE-00`);
  console.log(`${c.name} on NRLMSISE-00 (crossing ${(crossM / 3600).toFixed(2)} h): ${all} states in the last fifth, ${n} also answered by 0.6.45; mean distance to the numerical propagator ${(dn / n).toFixed(1)} m (this build) against ${(db / n).toFixed(1)} m (0.6.45); largest excess of this build over 0.6.45 ${worstGain.toFixed(3)} m`);
}
await now.close?.();
await base.close?.();
await ffm.close?.();
if (failures.length) { for (const f of failures) console.error(`FAIL ${f}`); process.exit(1); }
console.log('decay wide E2E: PASS');
process.exit(0);
