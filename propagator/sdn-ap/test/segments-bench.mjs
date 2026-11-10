#!/usr/bin/env node
// Timing benchmark (a prototype, not a test): the display segments (src/segments.inc) against the direct batch path
// (sdnap_propagate_soa), on N made-up SGP4XP sets, a low-orbit-heavy mix (70 % low orbit 300 to 1,500 km, 10 % MEO,
// 8 % geosynchronous, 7 % transfer orbits at e 0.5 to 0.75, 5 % Molniya; seeded, the same on every run). Prints the
// build's wall and CPU time, the bytes per set, each catalog step's time at STEPS instants, and the segments' miss
// against the theory's direct output at 20 of them. For drawing and screening many objects; nothing here is the
// theory's accuracy. Made-up orbits only.
//   node test/segments-bench.mjs [--n 100000] [--threads 15] [--per-row 4] [--coef 8] [--tol-m 1] [--tol-mms 1] [--steps 200]
import { performance } from "node:perf_hooks";
const mod = await import("./lib/module.mjs");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 100000), THREADS = arg("threads", 15), PER_ROW = arg("per-row", 4), COEF = arg("coef", 8), TOLM = arg("tol-m", 1), TOLMMS = arg("tol-mms", 1), STEPS = arg("steps", 200);
const MU = 398600.4418, RE = 6378.137;
// a seeded generator: the same mix on every run
let seed = 20261110;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rev = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const EPOCH_WHOLE = 2461328.5, EPOCH_FRAC = 0;  // 2026-10-15T00:00Z
const sets = [];
for (let k = 0; k < N; k++) {
  const u = rnd();
  let a, e, i;
  if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }             // low orbit, 300 to 1,500 km
  else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }           // MEO
  else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }                // geosynchronous
  else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }  // transfer
  else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }                                                    // Molniya
  sets.push({ epochWhole: EPOCH_WHOLE, epochFrac: EPOCH_FRAC, meanMotion: rev(a), ecc: e, inc: i, raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(),
    bterm: a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01, agom: 0.01, norad: 100000 + k, theory: mod.THEORY.SGP4XP });
}
const m = await mod.openModule({ threads: THREADS });
const x = m.x, mem = () => m.harness.memory.buffer;
m.init(sets);
const status = x.sdnap_alloc(4 * N), out = x.sdnap_alloc(48 * N), out2 = x.sdnap_alloc(48 * N), info = x.sdnap_alloc(64);
const t0 = performance.now(), cpu0 = process.cpuUsage();
const rc = x.sdnap_segments_build(EPOCH_WHOLE, EPOCH_FRAC, PER_ROW, COEF, TOLM, TOLMMS, status);
const buildMs = performance.now() - t0, cpu = process.cpuUsage(cpu0);
if (rc !== 0) throw new Error(`build ${rc}`);
const st = new Int32Array(mem(), status, N).slice();
const codes = {}; st.forEach((s) => { codes[s] = (codes[s] ?? 0) + 1; });
const div = {}, rows = [];
let minCover = Infinity, segPerSecond = 0, worstM = 0, worstMms = 0;
for (let k = 0; k < N; k++) {
  x.sdnap_segments_row(k, info);
  const [d, len, built, wm, wv] = new Float64Array(mem(), info, 5);
  div[d] = (div[d] ?? 0) + 1;
  if (built > 0) { minCover = Math.min(minCover, len * built); segPerSecond += 1 / len; worstM = Math.max(worstM, wm); worstMms = Math.max(worstMms, wv); }
}
const bytes = x.sdnap_segments_bytes();
console.log(JSON.stringify({ N, threads: m.threads, perRow: PER_ROW, coef: COEF, tolM: TOLM, tolMms: TOLMMS, buildWallMs: +buildMs.toFixed(1), buildCpuS: +((cpu.user + cpu.system) / 1e6).toFixed(2), status: codes, divisions: div,
  bytesPerSet: +(bytes / N).toFixed(1), storeBytes: x.sdnap_store_bytes(), minCoverS: +minCover.toFixed(1), segmentsPerSecondRealTime: +segPerSecond.toFixed(1), worstAtChecksM: +worstM.toFixed(4), worstAtChecksMms: +worstMms.toFixed(4) }));
// the catalog step at STEPS instants inside every row's segments; the direct path at the same instants
const times = Array.from({ length: STEPS }, (_, k) => (minCover * (k + 0.5)) / STEPS);
const step = (fn) => { const ms = []; for (const s of times) { const a = performance.now(); fn(s); ms.push(performance.now() - a); } ms.sort((p, q) => p - q); return { medianMs: +ms[Math.floor(ms.length / 2)].toFixed(3), p95Ms: +ms[Math.floor(0.95 * ms.length)].toFixed(3), minMs: +ms[0].toFixed(3) }; };
const segTeme = step((s) => x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, 0, N, 0, out, status));
const segEcef = step((s) => x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, 0, N, 3, out, status));
const direct = step((s) => x.sdnap_propagate_soa(EPOCH_WHOLE, s / 86400, 0, N, 0, out2, 0));
console.log(JSON.stringify({ catalogStep: { segmentsTeme: segTeme, segmentsEcef: segEcef, directTheory: direct } }));
// the segments against the theory's direct output at 20 of those instants, every row
let pm = [], vm = [];
for (const s of times.filter((_, k) => k % Math.max(1, Math.floor(STEPS / 20)) === 0)) {
  x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, 0, N, 0, out, status);
  x.sdnap_propagate_soa(EPOCH_WHOLE, s / 86400, 0, N, 0, out2, 0);
  const A = new Float64Array(mem(), out, 6 * N), B = new Float64Array(mem(), out2, 6 * N), S = new Int32Array(mem(), status, N);
  for (let k = 0; k < N; k++) {
    if (S[k] !== 0) continue;
    pm.push(Math.hypot(A[k] - B[k], A[N + k] - B[N + k], A[2 * N + k] - B[2 * N + k]) * 1000);
    vm.push(Math.hypot(A[3 * N + k] - B[3 * N + k], A[4 * N + k] - B[4 * N + k], A[5 * N + k] - B[5 * N + k]) * 1e6);
  }
}
const q = (v, p) => { const s = Float64Array.from(v).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(JSON.stringify({ againstTheory: { states: pm.length, positionM: { median: +q(pm, 0.5).toFixed(4), p99: +q(pm, 0.99).toFixed(4), max: +q(pm, 1).toFixed(4) },
  velocityAgainstTheoryVelocityMms: { median: +q(vm, 0.5).toFixed(2), p99: +q(vm, 0.99).toFixed(2), max: +q(vm, 1).toFixed(2) } } }));
process.exit(0);
