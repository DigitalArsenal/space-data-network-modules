#!/usr/bin/env node
// E2E (stack #423, SPEC 19): the display segments of the element store's rows. 3,000 made-up sets, SGP4XP and (every
// fifth) SGP4, the low-orbit-heavy mix of test/segments-bench.mjs; segments of 8 coefficients, 4 a row, 1 m and 1 mm/s:
// - every row is built (status 0) or counted as one no division of its period holds (status -10), and those rows
//   alone answer sdnap_segments_at with status 2 (the caller flies the theory): none dropped, none shown beyond the
//   tolerance;
// - at 50 instants inside every row's segments, each built row's position within 1 m of the theory's own
//   (sdnap_propagate_soa), in TEME and Earth-fixed;
// - the velocity is the derivative of the segment's positions: within 0.1 mm/s of their central difference over
//   +-0.1 s inside a segment; where two segments meet, the position steps by at most 2 m (each holds 1 m; the step
//   is printed);
// - outside a row's segments (before the store's epoch and after its last segment) status 1;
// - the same output, bit for bit, built on no pool thread and on 4, and built in one call or in three batches of 1,000
//   into one segment store (the digest of a catalog step);
// - 808 bytes a set (4 segments of 192 bytes and 40 of row state);
// - built again at tolerances under the theory's own rounding (a nanometer, a nanometer a second), the rows no
//   division holds are counted (-10) and answer status 2, every other row status 0.
// Made-up orbits only. JS only moves bytes and compares numbers the module produced.
//   node test/segments.e2e.mjs
import { createHash } from "node:crypto";
import { openModule, THEORY } from "./lib/module.mjs";

const N = 3000, PER_ROW = 4, COEF = 8, EPOCH = 2461328.5;
const MU = 398600.4418, RE = 6378.137;
let seed = 20261110;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rev = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const sets = [];
for (let k = 0; k < N; k++) {
  const u = rnd();
  let a, e, i;
  if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }
  else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }
  else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }
  else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }
  else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }
  const sgp4 = k % 5 === 0;
  sets.push({ epochWhole: EPOCH, epochFrac: 0, meanMotion: rev(a), ecc: e, inc: i, raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(),
    bterm: a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01, agom: 0.01, bstar: sgp4 && a < RE + 2000 ? 1e-4 : 0, norad: 100000 + k, theory: sgp4 ? THEORY.SGP4 : THEORY.SGP4XP });
}
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

/** A module with `threads` pool threads, its segments built in batches of `batch`: its exports, memory and status. */
async function built(threads, batch) {
  const m = await openModule({ threads });
  const x = m.x, mem = () => m.harness.memory.buffer;
  const status = x.sdnap_alloc(4 * N), out = x.sdnap_alloc(48 * N), out2 = x.sdnap_alloc(48 * N), info = x.sdnap_alloc(64);
  for (let off = 0; off < N; off += batch) {
    m.init(sets.slice(off, off + batch));
    const rc = x.sdnap_segments_build(EPOCH, 0, N, off, PER_ROW, COEF, 1, 1, status + 4 * off);
    check(rc === 0, `build (threads ${threads}, batch ${batch}, offset ${off}): ${rc}`);
  }
  if (batch !== N) m.init(sets);  // the theory of every row again, for the comparisons
  return { x, mem, status, out, out2, info, buildStatus: new Int32Array(mem(), status, N).slice() };
}
const digestAt = (h, s) => { h.x.sdnap_segments_at(EPOCH, s / 86400, 0, N, 0, h.out, h.status); return createHash("sha256").update(new Uint8Array(h.mem(), h.out, 48 * N)).digest("hex"); };

const A = await built(0, N), B = await built(4, N), C = await built(4, 1000);

// every row built or counted; coverage
const counts = {};
A.buildStatus.forEach((s) => { counts[s] = (counts[s] ?? 0) + 1; });
check(Object.keys(counts).every((s) => s === "0" || s === "-10"), `build statuses other than 0 and -10: ${JSON.stringify(counts)}`);
let cover = Infinity, last = 0;
const lens = new Float64Array(N);
for (let k = 0; k < N; k++) {
  A.x.sdnap_segments_row(k, A.info);
  const [, len, n] = new Float64Array(A.mem(), A.info, 3);
  lens[k] = len;
  if (A.buildStatus[k] === 0) { cover = Math.min(cover, len * n); last = Math.max(last, len * n); }
}
check(Number.isFinite(cover) && cover > 600, `the shortest coverage is ${cover} s`);

// the theory's own states at 50 instants inside every row's segments
const times = Array.from({ length: 50 }, (_, k) => (cover * (k + 0.5)) / 50);
let worstTeme = 0, worstEcef = 0, worstV = 0, status2 = 0, status2Wrong = 0;
for (const s of times) {
  for (const [frame, scale] of [[0, 1000], [3, 1]]) {
    A.x.sdnap_segments_at(EPOCH, s / 86400, 0, N, frame, A.out, A.status);
    A.x.sdnap_propagate_soa(EPOCH, s / 86400, 0, N, frame, A.out2, 0);
    const P = new Float64Array(A.mem(), A.out, 6 * N), Q = new Float64Array(A.mem(), A.out2, 6 * N), S = new Int32Array(A.mem(), A.status, N);
    for (let k = 0; k < N; k++) {
      if (frame === 0 && S[k] === 2) status2++;
      if ((S[k] === 2) !== (A.buildStatus[k] === -10)) status2Wrong++;
      if (S[k] !== 0) continue;
      const d = Math.hypot(P[k] - Q[k], P[N + k] - Q[N + k], P[2 * N + k] - Q[2 * N + k]) * scale;  // m
      if (frame === 0) worstTeme = Math.max(worstTeme, d); else worstEcef = Math.max(worstEcef, d);
    }
  }
  // the velocity against the central difference of the segments' own positions over +-0.1 s (TEME, km and km/s)
  const at = (t) => { A.x.sdnap_segments_at(EPOCH, t / 86400, 0, N, 0, A.out, A.status); return new Float64Array(A.mem(), A.out, 6 * N).slice(); };
  const [m1, z, p1] = [at(s - 0.1), at(s), at(s + 0.1)];
  for (let k = 0; k < N; k++) {
    if (A.buildStatus[k] !== 0) continue;
    const inSeg = s - Math.floor(s / lens[k]) * lens[k];
    if (inSeg < 0.2 || inSeg > lens[k] - 0.2) continue;  // the difference would straddle two segments
    const dv = Math.hypot((p1[k] - m1[k]) / 0.2 - z[3 * N + k], (p1[N + k] - m1[N + k]) / 0.2 - z[4 * N + k], (p1[2 * N + k] - m1[2 * N + k]) / 0.2 - z[5 * N + k]);
    worstV = Math.max(worstV, dv * 1e6);  // mm/s
  }
}
// the step where one segment hands over to the next (each interpolates the theory on its own): at each row's first
// three joins, 1 microsecond each side
let worstJoin = 0;
for (let j = 1; j < PER_ROW; j++) {
  const side = (d) => { const o = new Float64Array(6 * N); for (let k = 0; k < N; k++) o[k] = j * lens[k] + d; return o; };
  const pos = (d) => {
    const at = side(d), r = new Float64Array(3 * N);
    for (let k = 0; k < N; k++) {
      if (A.buildStatus[k] !== 0) continue;
      A.x.sdnap_segments_at(EPOCH, at[k] / 86400, k, 1, 0, A.out, A.status);
      const P = new Float64Array(A.mem(), A.out, 6);
      r[k] = P[0]; r[N + k] = P[1]; r[2 * N + k] = P[2];
    }
    return r;
  };
  const [a, b] = [pos(-1e-6), pos(1e-6)];
  for (let k = 0; k < N; k++) if (A.buildStatus[k] === 0) worstJoin = Math.max(worstJoin, Math.hypot(a[k] - b[k], a[N + k] - b[N + k], a[2 * N + k] - b[2 * N + k]) * 1000);
}
check(worstJoin <= 2, `a step of ${worstJoin} m where two segments meet (each holds 1 m)`);
check(worstTeme <= 1, `a segment's TEME position ${worstTeme} m from the theory's (over 1 m)`);
check(worstEcef <= 1, `a segment's Earth-fixed position ${worstEcef} m from the theory's (over 1 m)`);
check(worstV <= 0.1, `a segment's velocity ${worstV} mm/s from its positions' derivative (over 0.1 mm/s)`);
check(status2Wrong === 0, `${status2Wrong} answers with status 2 on a built row, or without it on a row without segments`);

// outside the segments
for (const s of [-60, last + 60]) {
  A.x.sdnap_segments_at(EPOCH, s / 86400, 0, N, 0, A.out, A.status);
  const S = new Int32Array(A.mem(), A.status, N);
  check(Array.from(S).every((v, k) => v === (A.buildStatus[k] === 0 ? 1 : 2)), `at ${s} s from the store's epoch a built row does not answer status 1`);
}

// one output whatever the threads and the batches
const digests = [A, B, C].map((h) => times.slice(0, 3).map((s) => digestAt(h, s)).join(","));
check(digests[0] === digests[1], "the segments built on 4 pool threads differ from those built on none");
check(digests[0] === digests[2], "the segments built in three batches differ from those built in one call");
const perSet = A.x.sdnap_segments_bytes() / N;
check(perSet === 808, `${perSet} bytes a set, not 808`);

// rows no division holds, made so by tolerances (a nanometer, a nanometer a second) under the theory's own rounding:
// each counted (-10) and answering status 2, every other row status 0
A.x.sdnap_segments_build(EPOCH, 0, N, 0, PER_ROW, COEF, 1e-9, 1e-6, A.status);
const tight = new Int32Array(A.mem(), A.status, N).slice();
A.x.sdnap_segments_at(EPOCH, times[0] / 86400, 0, N, 0, A.out, A.status);
const tightAt = new Int32Array(A.mem(), A.status, N).slice();
const noDivision = tight.filter((s) => s === -10).length;
check(noDivision > 0 && Array.from(tight).every((s, k) => (s === -10 ? tightAt[k] === 2 : s === 0 && tightAt[k] === 0)),
  `at a nanometer: ${noDivision} rows without segments, and their answers are not all status 2`);

console.log(JSON.stringify({ rows: N, buildStatus: counts, coverS: Math.round(cover), worstTemeM: +worstTeme.toFixed(4), worstEcefM: +worstEcef.toFixed(4),
  worstVelocityFromPositionsMms: +worstV.toFixed(5), worstJoinStepM: +worstJoin.toFixed(4), status2Answers: status2, bytesPerSet: perSet, rowsWithoutSegmentsAtANanometer: noDivision }));
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`SEGMENTS FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("SEGMENTS PASS: every row built or counted, positions within 1 m of the theory in TEME and Earth-fixed, velocity the positions' derivative, status 1 outside, one output on any threads and batches, 808 bytes a set");
process.exit(0);
