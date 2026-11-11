#!/usr/bin/env node
// Timing benchmark (a prototype, not a test): the display segments (src/segments.inc) against the direct batch path
// (sdnap_propagate_soa), on N made-up sets, a low-orbit-heavy mix (70 % low orbit 300 to 1,500 km, 10 % MEO, 8 %
// geosynchronous, 7 % transfer orbits at e 0.5 to 0.75, 5 % Molniya; seeded, the same on every run), as stock SGP4XP
// rows or (--ap) AP rows (tesseral 31, zonal 20, the theory's own flux model). The sets load in batches of --batch
// (a worker's way: load, build the batch's segments, replace with the next), the segments of all N kept. Prints each
// batch's load and build times, the bytes per set, each catalog step's time at STEPS instants over all N, the
// segments' miss against the theory's direct output for the last batch at 20 of them, and a digest of one step's
// output (the same digest on any thread count is the pool's determinism). For drawing and screening many objects;
// nothing here is the theory's accuracy. Made-up orbits only.
//   node test/segments-bench.mjs [--n 100000] [--batch 100000] [--ap] [--threads 15] [--per-row 4] [--coef 8]
//     [--tol-m 1] [--tol-mms 1] [--steps 200]
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const mod = await import("./lib/module.mjs");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 100000), BATCH = Math.min(N, arg("batch", N)), AP = process.argv.includes("--ap"), THREADS = arg("threads", 15), PER_ROW = arg("per-row", 4),
  COEF = arg("coef", 8), TOLM = arg("tol-m", 1), TOLMMS = arg("tol-mms", 1), STEPS = arg("steps", 200);
const MU = 398600.4418, RE = 6378.137;
// --rows i,j,...: print these rows' outcome (class, perigee, division, misses at the checks)
const ROWS = process.argv.includes("--rows") ? process.argv[process.argv.indexOf("--rows") + 1].split(",").map(Number) : [];
let seed = 20261110;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rev = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const EPOCH_WHOLE = 2461328.5, EPOCH_FRAC = 0;  // 2026-10-15T00:00Z
const sets = [];
for (let k = 0; k < N; k++) {
  const u = rnd();
  let a, e, i;
  // (the class label takes no draw: the mix is the same as before it was added)
  const cls = u < 0.70 ? "low" : u < 0.80 ? "MEO" : u < 0.88 ? "GEO" : u < 0.95 ? "transfer" : "Molniya";
  if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }
  else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }
  else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }
  else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }
  else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }
  sets.push({ cls, a, epochWhole: EPOCH_WHOLE, epochFrac: EPOCH_FRAC, meanMotion: rev(a), ecc: e, inc: i, raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(),
    bterm: a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01, agom: 0.01, norad: 100000 + k, theory: mod.THEORY.SGP4XP });
}
const m = await mod.openModule({ threads: THREADS });
const x = m.x, mem = () => m.harness.memory.buffer;
const status = x.sdnap_alloc(4 * N), out = x.sdnap_alloc(48 * N), out2 = x.sdnap_alloc(48 * N), info = x.sdnap_alloc(64);
const batches = [];
let storePerSet = 0, memPerSet = 0;
const memBefore = mem().byteLength;
for (let off = 0; off < N; off += BATCH) {
  const part = sets.slice(off, off + BATCH);
  if (AP && typeof x.sdnap_segments_select !== "function") throw new Error("--ap: this build has no AP selection for the element store (the prototype branch segments-display-prototype has it)");
  if (AP) x.sdnap_segments_select(31, 20);
  const l0 = performance.now(), lc0 = process.cpuUsage();
  m.init(part);
  const loadMs = performance.now() - l0, lc = process.cpuUsage(lc0);
  storePerSet = x.sdnap_store_bytes() / part.length;
  // the module's memory grows to hold the first batch (it never shrinks): its growth per set bounds a loaded set
  if (off === 0) memPerSet = (mem().byteLength - memBefore) / part.length;
  const b0 = performance.now(), bc0 = process.cpuUsage();
  const rc = x.sdnap_segments_build(EPOCH_WHOLE, EPOCH_FRAC, N, off, PER_ROW, COEF, TOLM, TOLMMS, status + 4 * off);
  const buildMs = performance.now() - b0, bc = process.cpuUsage(bc0);
  if (rc !== 0) throw new Error(`build ${rc}`);
  batches.push({ off, n: part.length, loadMs, loadCpuS: (lc.user + lc.system) / 1e6, buildMs, buildCpuS: (bc.user + bc.system) / 1e6 });
}
const st = new Int32Array(mem(), status, N).slice();
const codes = {}; st.forEach((s) => { codes[s] = (codes[s] ?? 0) + 1; });
const div = {};
let minCover = Infinity, segPerSecond = 0, worstM = 0, worstMms = 0;
// rows no division held: segments_at gives them status 2 and the caller flies their theory (counted, never dropped)
const noDivision = [];
for (let k = 0; k < N; k++) {
  x.sdnap_segments_row(k, info);
  const [d, len, built, wm, wv] = new Float64Array(mem(), info, 5);
  div[d] = (div[d] ?? 0) + 1;
  if (built > 0) { minCover = Math.min(minCover, len * built); segPerSecond += 1 / len; worstM = Math.max(worstM, wm); worstMms = Math.max(worstMms, wv); }
  if (ROWS.includes(k)) console.log(JSON.stringify({ row: k, cls: sets[k].cls, perigeeKm: Math.round(sets[k].a * (1 - sets[k].ecc) - RE), e: +sets[k].ecc.toFixed(4), status: st[k],
    division: d, missM: +wm.toFixed(4), missMms: +wv.toFixed(4) }));
  if (built === 0 && st[k] === -10) noDivision.push({ row: k, cls: sets[k].cls, altitudeKm: Math.round(sets[k].a * (1 - sets[k].ecc) - RE), e: +sets[k].ecc.toFixed(3), finestMissM: +wm.toFixed(3), finestMissMms: +wv.toFixed(3) });
}
const sum = (f) => batches.reduce((a, b) => a + b[f], 0);
console.log(JSON.stringify({ N, batch: BATCH, theory: AP ? "AP (tesseral 31, zonal 20)" : "SGP4XP", threads: m.threads, perRow: PER_ROW, coef: COEF, tolM: TOLM, tolMms: TOLMMS,
  loadWallS: +(sum("loadMs") / 1000).toFixed(2), loadCpuS: +sum("loadCpuS").toFixed(2), buildWallS: +(sum("buildMs") / 1000).toFixed(2), buildCpuS: +sum("buildCpuS").toFixed(2),
  theoryRecordBytesPerSet: Math.round(storePerSet), memoryGrowthPerLoadedSet: Math.round(memPerSet), memoryMB: Math.round(mem().byteLength / 1048576), segmentBytesPerSet: +(x.sdnap_segments_bytes() / N).toFixed(1), status: codes, divisions: div,
  // rows the theory refused at load (status 1): where they fall in their batch, by class
  refusedRows: (() => { const r = []; st.forEach((s, k) => { if (s === 1) r.push(k); }); return { count: r.length, first: r[0] ?? null, last: r.at(-1) ?? null,
    firstInBatch: r.length ? Math.min(...r.map((k) => k % BATCH)) : null, byClass: r.reduce((o, k) => ((o[sets[k].cls] = (o[sets[k].cls] ?? 0) + 1), o), {}) }; })(),
  noDivisionRows: noDivision.length, noDivisionByClass: noDivision.reduce((o, r) => ((o[r.cls] = (o[r.cls] ?? 0) + 1), o), {}), noDivisionSample: noDivision.slice(0, 8),
  minCoverS: +minCover.toFixed(1), segmentsPerSecondRealTime: +segPerSecond.toFixed(1), worstAtChecksM: +worstM.toFixed(4), worstAtChecksMms: +worstMms.toFixed(4) }));
const times = Array.from({ length: STEPS }, (_, k) => (minCover * (k + 0.5)) / STEPS);
const step = (fn) => { const ms = []; for (const s of times) { const a = performance.now(); fn(s); ms.push(performance.now() - a); } ms.sort((p, q) => p - q);
  return { medianMs: +ms[Math.floor(ms.length / 2)].toFixed(3), p99Ms: +ms[Math.min(ms.length - 1, Math.floor(0.99 * ms.length))].toFixed(3), minMs: +ms[0].toFixed(3) }; };
const segTeme = step((s) => x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, 0, N, 0, out, status));
const segEcef = step((s) => x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, 0, N, 3, out, status));
const last = batches.at(-1);
const direct = step((s) => x.sdnap_propagate_soa(EPOCH_WHOLE, s / 86400, 0, last.n, 0, out2, 0));
x.sdnap_segments_at(EPOCH_WHOLE, times[0] / 86400, 0, N, 0, out, status);
const digest = createHash("sha256").update(new Uint8Array(mem(), out, 48 * N)).digest("hex").slice(0, 16);
console.log(JSON.stringify({ catalogStep: { segmentsTeme: segTeme, segmentsEcef: segEcef, [`directTheoryLastBatchOf${last.n}`]: direct }, digest }));
const pm = [], vm = [];
for (const s of times.filter((_, k) => k % Math.max(1, Math.floor(STEPS / 20)) === 0)) {
  x.sdnap_segments_at(EPOCH_WHOLE, s / 86400, last.off, last.n, 0, out, status);
  x.sdnap_propagate_soa(EPOCH_WHOLE, s / 86400, 0, last.n, 0, out2, 0);
  const n = last.n, A = new Float64Array(mem(), out, 6 * n), B = new Float64Array(mem(), out2, 6 * n), S = new Int32Array(mem(), status, n);
  for (let k = 0; k < n; k++) {
    if (S[k] !== 0) continue;
    pm.push(Math.hypot(A[k] - B[k], A[n + k] - B[n + k], A[2 * n + k] - B[2 * n + k]) * 1000);
    vm.push(Math.hypot(A[3 * n + k] - B[3 * n + k], A[4 * n + k] - B[4 * n + k], A[5 * n + k] - B[5 * n + k]) * 1e6);
  }
}
const q = (v, p) => { const s = Float64Array.from(v).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(JSON.stringify({ againstTheoryLastBatch: { states: pm.length, positionM: { median: +q(pm, 0.5).toFixed(4), p99: +q(pm, 0.99).toFixed(4), max: +q(pm, 1).toFixed(4) },
  velocityAgainstTheoryVelocityMms: { median: +q(vm, 0.5).toFixed(2), p99: +q(vm, 0.99).toFixed(2), max: +q(vm, 1).toFixed(2) } } }));
process.exit(0);
