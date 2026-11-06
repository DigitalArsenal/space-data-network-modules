#!/usr/bin/env node
// Private screening: the noise channel of the S2 response (private-screening/
// PROTOCOL-NOISE.md). Builds private-screening/ (SEAL 4.1.1 and the fork's
// batching API at the pinned commit), runs private_screening_noise (A's reads
// of the response noise for 2088 responses, the dictionary arm, the controls),
// applies the registered estimators and gates, and prints PASS when the verdict
// is "no usable leak" or "leak mitigated by flooding", FAIL otherwise.
//
//   node tests/privateScreeningNoiseChannel.e2e.mjs
// PRIVATE_SCREENING_BUILD_DIR: build directory (default: per-checkout under the
// system temp directory). FLATBUFFERS_HE_SOURCE_DIR: local checkout of the fork
// commit. PRIVATE_SCREENING_CMAKE_ARGS: extra cmake arguments, space separated.
// PRIVATE_SCREENING_NOISE_RUN: an existing driver output to analyze instead of
// running the driver. PRIVATE_SCREENING_WRITE=1 writes results/noise-channel.json
// (never set during the gauntlet).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../private-screening');
const buildDir = process.env.PRIVATE_SCREENING_BUILD_DIR ||
  join(tmpdir(), `private-screening-noise-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);

// Registered constants (PROTOCOL-NOISE.md section 3).
const PERMUTATIONS = 2000, PERM_SEED = 20261106, FOLDS = 5, LAMBDA = 1;
const E1_ALPHA = 0.05 / 7, E1_MIN_DELTA_R2 = 0.01;
const E2_ALPHA = 0.001, E2_MIN_RATE_OVER_CHANCE = 0.03, K = 64;
const C1_THRESHOLD = 0.001;
const POPULATION = 88 + 400 + 1600;
const TARGET_NAMES = ['log2 min distance', 'mean log2 distance', 'close flag', 'mean b_x', 'mean b_y', 'mean b_z', 'mean |b|'];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    process.stderr.write(`${cmd} ${args.join(' ')} failed (${r.status})\n${(r.stdout || '').slice(-3000)}${(r.stderr || '').slice(-3000)}\n`);
    process.exit(1);
  }
  return r.stdout;
}

function runDriver() {
  if (process.env.PRIVATE_SCREENING_NOISE_RUN) return JSON.parse(readFileSync(process.env.PRIVATE_SCREENING_NOISE_RUN, 'utf8'));
  mkdirSync(buildDir, { recursive: true });
  const generator = spawnSync('ninja', ['--version']).status === 0 ? ['-G', 'Ninja'] : [];
  const fork = process.env.FLATBUFFERS_HE_SOURCE_DIR ? [`-DFLATBUFFERS_HE_SOURCE_DIR=${process.env.FLATBUFFERS_HE_SOURCE_DIR}`] : [];
  const extra = (process.env.PRIVATE_SCREENING_CMAKE_ARGS || '').split(' ').filter(Boolean);
  if (!existsSync(join(buildDir, 'CMakeCache.txt'))) run('cmake', ['-S', source, '-B', buildDir, ...generator, '-DCMAKE_BUILD_TYPE=Release', ...fork, ...extra]);
  run('cmake', ['--build', buildDir, '-j', '12', '--target', 'private_screening_noise']);
  return JSON.parse(run(join(buildDir, 'private_screening_noise'), []));
}

// ---- small numerics ----
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, rnd) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); }
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const v of c) s += v / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function binomUpper(k, n, p) { let s = 0; for (let i = k; i <= n; i++) s += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return Math.min(1, s); }
function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }

// Ridge regression of several targets on one design (Cholesky), standardizing on the training rows.
function ridgePredict(Xtr, Ytr, Xte, lambda) {
  const n = Xtr.length, p = Xtr[0].length, m = Ytr[0].length;
  const mu = new Float64Array(p), sg = new Float64Array(p);
  for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += Xtr[i][j]; mu[j] = s / n; let v = 0; for (let i = 0; i < n; i++) v += (Xtr[i][j] - mu[j]) ** 2; sg[j] = Math.sqrt(v / n) || 1; }
  const ym = new Float64Array(m); for (let t = 0; t < m; t++) { let s = 0; for (let i = 0; i < n; i++) s += Ytr[i][t]; ym[t] = s / n; }
  const G = Array.from({ length: p }, () => new Float64Array(p)), R = Array.from({ length: p }, () => new Float64Array(m));
  const z = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) z[j] = (Xtr[i][j] - mu[j]) / sg[j];
    for (let a = 0; a < p; a++) { const za = z[a], Ga = G[a]; for (let b = a; b < p; b++) Ga[b] += za * z[b]; for (let t = 0; t < m; t++) R[a][t] += za * (Ytr[i][t] - ym[t]); }
  }
  for (let a = 0; a < p; a++) { for (let b = 0; b < a; b++) G[a][b] = G[b][a]; G[a][a] += lambda; }
  // Cholesky G = L L^T
  const L = Array.from({ length: p }, () => new Float64Array(p));
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { let s = G[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j]; }
  const beta = Array.from({ length: p }, () => new Float64Array(m));
  for (let t = 0; t < m; t++) {
    const y = new Float64Array(p);
    for (let i = 0; i < p; i++) { let s = R[i][t]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k][i] * beta[k][t]; beta[i][t] = s / L[i][i]; }
  }
  return Xte.map((row) => { const out = new Float64Array(m); for (let t = 0; t < m; t++) out[t] = ym[t]; for (let j = 0; j < p; j++) { const zj = (row[j] - mu[j]) / sg[j]; for (let t = 0; t < m; t++) out[t] += zj * beta[j][t]; } return out; });
}
// Out-of-fold predictions for all targets.
function cvPredict(X, Y, folds) {
  const n = X.length, pred = new Array(n);
  for (let f = 0; f < FOLDS; f++) {
    const tr = [], te = [];
    for (let i = 0; i < n; i++) (folds[i] === f ? te : tr).push(i);
    const out = ridgePredict(tr.map((i) => X[i]), tr.map((i) => Y[i]), te.map((i) => X[i]), LAMBDA);
    te.forEach((i, k) => { pred[i] = out[k]; });
  }
  return pred;
}
function r2(pred, Y, t) {
  const m = mean(Y.map((y) => y[t]));
  let sse = 0, sst = 0;
  for (let i = 0; i < Y.length; i++) { sse += (Y[i][t] - pred[i][t]) ** 2; sst += (Y[i][t] - m) ** 2; }
  return 1 - sse / sst;
}
// Share of a row's steps within a factor of 2 of exp2(l), from its 1/16-octave histogram.
function c1Row(hist, l) {
  const lo = Math.max(0, Math.ceil(16 * (l - 1) - 0.5)), hi = Math.min(hist.length - 1, Math.floor(16 * (l + 1) - 0.5));
  let inn = 0, tot = 0;
  for (let b = 0; b < hist.length; b++) { tot += hist[b]; if (b >= lo && b <= hi) inn += hist[b]; }
  return { inn, tot };
}
function c1Population(rows, lhat) {
  let inn = 0, tot = 0;
  rows.forEach((r, i) => { const c = c1Row(r.hist, lhat[i]); inn += c.inn; tot += c.tot; });
  return inn / tot;
}

// Exact check of the long double noise reading: CRT with big integers.
function exactLog2Linf(dump) {
  const q = dump.q.map(BigInt); const nl = q.length; const Q = q.reduce((a, b) => a * b, 1n);
  const modinv = (a, m) => { let [r0, r1] = [a % m, m], [s0, s1] = [1n, 0n]; while (r1) { const k = r0 / r1; [r0, r1] = [r1, r0 - k * r1]; [s0, s1] = [s1, s0 - k * s1]; } return ((s0 % m) + m) % m; };
  const qhat = q.map((qi) => Q / qi), inv = q.map((qi, j) => modinv(qhat[j] % qi, qi));
  let maxAbs = 0n;
  for (let i = 0; i < dump.n; i++) {
    let v = 0n;
    for (let j = 0; j < nl; j++) v += BigInt(dump.d[i * nl + j]) * inv[j] % q[j] * qhat[j];
    v %= Q; if (v > Q / 2n) v -= Q; if (v < 0n) v = -v;
    if (v > maxAbs) maxAbs = v;
  }
  const sh = Math.max(0, maxAbs.toString(2).length - 53);
  return Math.log2(Number(maxAbs >> BigInt(sh))) + sh;
}

const out = runDriver();
const lines = [];
const check = (name, ok, detail) => { lines.push({ name, ok, detail }); };
const rows = out.rows;
const pop = rows.filter((r) => ['pair', 'g2', 'g3', 'g4'].includes(r.set));
check('population is 88 + 400 + 1600 responses', pop.length === POPULATION, `${pop.length}`);
check('every decrypted response equals its plaintext value (valueMismatches)', out.valueMismatches === 0, `${out.valueMismatches}`);
check('the responder holds no secret key', out.responderHasSecretKey === false, 'false');

// Exact check.
const exactBits = out.exact.length ? exactLog2Linf(out.exact[0]) : NaN;
const pairRow = rows.find((r) => r.set === 'pair' && r.id === 1 && r.rep === 3);
check('long double reading equals the big-integer reading (log2 Linf, lane 0, within 0.001)', Math.abs(exactBits - pairRow.reading[4]) < 0.001, `exact ${exactBits.toFixed(4)}, driver ${pairRow.reading[4].toFixed(4)}`);
check('the budget from the noise polynomial equals the API budget lane 0 (A-B1 block 3)', pairRow.sb === pairRow.reading[1], `polynomial ${pairRow.sb}, SEAL ${pairRow.reading[1]}`);

// ---- E1 ----
const X = pop.map((r) => [...r.reading, ...r.known]);
const XA = pop.map((r) => [...r.known]);
const Y = pop.map((r) => r.target);
const n = pop.length;
const rndF = mulberry32(PERM_SEED + 1);
const order = shuffle([...Array(n).keys()], rndF);
const folds = new Int32Array(n); order.forEach((idx, pos) => { folds[idx] = pos % FOLDS; });
const predFull = cvPredict(X, Y, folds), predA = cvPredict(XA, Y, folds);
const r2Full = TARGET_NAMES.map((_, t) => r2(predFull, Y, t)), r2A = TARGET_NAMES.map((_, t) => r2(predA, Y, t));
const dR2 = r2Full.map((v, t) => v - r2A[t]);
// Null: the 19 reading columns permuted among responses of the same block index w.
const strata = new Map(); pop.forEach((r, i) => { if (!strata.has(r.w)) strata.set(r.w, []); strata.get(r.w).push(i); });
const rnd = mulberry32(PERM_SEED);
const nullD = TARGET_NAMES.map(() => []);
const lhatObs = predFull.map((p) => p[1]), lhatA = predA.map((p) => p[1]);
const c1Obs = c1Population(pop, lhatObs), c1A = c1Population(pop, lhatA);
const c1Null = [];
for (let it = 0; it < PERMUTATIONS; it++) {
  const perm = new Int32Array(n);
  for (const idx of strata.values()) { const sh = shuffle([...idx], rnd); idx.forEach((i, k) => { perm[i] = sh[k]; }); }
  const Xp = pop.map((r, i) => [...pop[perm[i]].reading, ...r.known]);
  const pp = cvPredict(Xp, Y, folds);
  TARGET_NAMES.forEach((_, t) => nullD[t].push(r2(pp, Y, t) - r2A[t]));
  c1Null.push(c1Population(pop, pp.map((p) => p[1])));
}
const e1 = TARGET_NAMES.map((name, t) => {
  const sorted = [...nullD[t]].sort((a, b) => a - b);
  const p = (1 + nullD[t].filter((v) => v >= dR2[t]).length) / (PERMUTATIONS + 1);
  return { target: name, r2Full: r2Full[t], r2KnownOnly: r2A[t], deltaR2: dR2[t], p, nullDelta99: quantile(sorted, 0.99), fires: dR2[t] >= E1_MIN_DELTA_R2 && p <= E1_ALPHA };
});
const c1NullSorted = [...c1Null].sort((a, b) => a - b);
const e1Fires = e1.some((e) => e.fires);

// ---- E2 ----
const sims = rows.filter((r) => r.set === 'dictSim'), tgts = rows.filter((r) => r.set === 'dictTgt');
const nf = sims[0].reading.length;
const byCand = Array.from({ length: K }, () => []); sims.forEach((r) => byCand[r.id].push(r.reading));
const fp = byCand.map((rs) => Array.from({ length: nf }, (_, j) => mean(rs.map((v) => v[j]))));
const pooled = Array.from({ length: nf }, (_, j) => Math.sqrt(mean(byCand.map((rs, c) => { const m = fp[c][j]; return rs.reduce((s, v) => s + (v[j] - m) ** 2, 0) / Math.max(1, rs.length - 1); }))) || 1);
let top1 = 0, rankSum = 0, better = 0, usedPairs = 0, c1Pick = 0, c1Random = 0;
for (const t of tgts) {
  const dist = fp.map((f) => f.reduce((s, v, j) => s + ((v - t.reading[j]) / pooled[j]) ** 2, 0));
  const pick = dist.indexOf(Math.min(...dist));
  const rank = 1 + dist.filter((d) => d < dist[t.id]).length;
  rankSum += rank; if (pick === t.id) top1++;
  const row = out.c1Matrix[t.id], avg = mean(row);
  c1Pick += row[pick]; c1Random += avg;
  if (row[pick] !== avg) { usedPairs++; if (row[pick] > avg) better++; }
}
const T = tgts.length, rate = top1 / T;
const e2TopP = binomUpper(top1, T, 1 / K);
const e2SignP = binomUpper(better, usedPairs, 0.5);
const e2Fires = e2TopP <= E2_ALPHA && rate >= 1 / K + E2_MIN_RATE_OVER_CHANCE && e2SignP <= E2_ALPHA;

// ---- controls ----
const rep = rows.filter((r) => r.set === 'repeat');
const readingNames = ['api budget', 'lane0 budget', 'lane1 budget', 'lane2 budget', 'lane0 log2 Linf', 'lane0 log2 rms', 'lane1 log2 Linf', 'lane2 log2 Linf'];
const readingIdx = [0, 1, 2, 3, 4, 5, 9, 14];
const p2 = readingIdx.map((j, k) => ({ reading: readingNames[k], sdFreshJitter: sd(rep.map((r) => r.reading[j])), sdPopulation: sd(pop.map((r) => r.reading[j])), meanPopulation: mean(pop.map((r) => r.reading[j])) }));
const p1 = out.p1.map((c) => ({ delta: c.delta, valueMismatches: c.valueMismatches, apiBudget: c.reading[0], log2LinfLane0: c.reading[4] }));
const p1Spread = Math.max(...p1.map((c) => c.log2LinfLane0)) - Math.min(...p1.map((c) => c.log2LinfLane0));
const p1Falls = p1[0].apiBudget - p1[p1.length - 1].apiBudget >= 8;
check('P1 slot-constant control decrypts exactly', p1.every((c) => c.valueMismatches === 0), 'ok');

// ---- verdict ----
const leak = e1Fires || e2Fires;
const verdict = leak ? 'leak (flooding arm not run in this build: gate stays)' : 'no usable leak';
const summary = {
  registered: 'private-screening/PROTOCOL-NOISE.md',
  population: { responses: n, pairs: 88, breadth: 400, third: 1600, dictionary: { candidates: K, simsPerCandidate: sims.length / K, targets: T } },
  reading: { api: 'NoiseBudget: one integer per returned block (min over the 3 lanes)', finest: 'per lane noise polynomial d (8192 integers), summarized in 19 numbers', exactCheck: { exactLog2Linf: exactBits, driverLog2Linf: pairRow.reading[4] } },
  e1: { permutations: PERMUTATIONS, alphaPerTarget: E1_ALPHA, minDeltaR2: E1_MIN_DELTA_R2, targets: e1, fires: e1Fires, nullFamilyPassChance: 0.05 },
  e2: { top1: top1, targets: T, rate, chance: 1 / K, binomialP: e2TopP, meanRankOfTruth: rankSum / T, expectedRankUnderNull: (K + 1) / 2, meanC1Pick: c1Pick / T, meanC1RandomPick: c1Random / T, signTestBetter: better, signTestPairs: usedPairs, signP: e2SignP, fires: e2Fires },
  c1: { criterion: 'within a factor of 2 at more than 0.1 % of steps', e1Observed: c1Obs, e1KnownOnly: c1A, e1NullMean: mean(c1Null), e1Null95: quantile(c1NullSorted, 0.95), nullPassChance: c1Null.filter((v) => v > C1_THRESHOLD).length / c1Null.length, e2Pick: c1Pick / T, e2RandomPick: c1Random / T, note: 'passed at the null level by any in-neighbourhood estimate; success counts only when a gate fires' },
  controls: { p1: { rows: p1, log2LinfSpread: p1Spread, registeredExpectationBudgetFalls: p1Falls }, p2 },
  verdict,
};
check('no gate fires on the unflooded response (E1, E2)', !leak, `E1 fires ${e1Fires}, E2 fires ${e2Fires}`);

const f = (v, d = 4) => (typeof v === 'number' ? v.toFixed(d) : String(v));
console.log('Noise channel of the S2 response');
console.log(`population ${n}; reading: API budget (1 integer per block) and the noise polynomial (19 numbers)`);
for (const e of e1) console.log(`E1 ${e.target.padEnd(20)} CV R2 ${f(e.r2Full)} vs known-A-only ${f(e.r2KnownOnly)}; delta ${f(e.deltaR2)}; p ${f(e.p)}; null 99th pct delta ${f(e.nullDelta99)}; fires ${e.fires}`);
console.log(`E2 top-1 ${top1}/${T} = ${f(rate)} (chance ${f(1 / K)}), p ${f(e2TopP)}; mean rank ${f(rankSum / T, 2)} (null ${(K + 1) / 2}); C1 pick ${f(c1Pick / T)} vs random pick ${f(c1Random / T)}, sign test ${better}/${usedPairs} p ${f(e2SignP)}; fires ${e2Fires}`);
console.log(`C1 (record 19 criterion): E1 estimate ${f(c1Obs)}, known-A-only ${f(c1A)}, null mean ${f(mean(c1Null))}; null pass chance ${f(summary.c1.nullPassChance, 3)}`);
console.log(`P1 slot-constant operands |ca-cb| 0..2^23: API budget ${p1.map((c) => c.apiBudget).join(',')}; log2 Linf spread ${f(p1Spread, 3)} bits; registered expectation (budget falls by >= 8): ${p1Falls}`);
for (const p of p2) console.log(`P2 ${p.reading.padEnd(16)} sd fresh jitter ${f(p.sdFreshJitter)}; sd across population ${f(p.sdPopulation)}; mean ${f(p.meanPopulation, 3)}`);
for (const l of lines) console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.name}: ${l.detail}`);
console.log(`verdict: ${verdict}`);

if (process.env.PRIVATE_SCREENING_WRITE === '1') {
  mkdirSync(join(source, 'results'), { recursive: true });
  writeFileSync(join(source, 'results', 'noise-channel.json'), JSON.stringify({ ...summary, checks: lines }, null, 2) + '\n');
}
const ok = lines.every((l) => l.ok);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
