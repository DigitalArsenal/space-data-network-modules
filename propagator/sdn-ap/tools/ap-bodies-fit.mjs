#!/usr/bin/env node
// AP's Sun and Moon series (SPEC 16.14): a least-squares fit to DE440, written to src/ap_bodies_series.inc; and the
// stored DE440 samples test/ap-bodies.e2e.mjs checks the module against (test/fixtures/de440-bodies-2010-2035.json).
//
//   node tools/ap-bodies-fit.mjs fit <de440s.bsp> [--from 1990] [--to 2060] [--step 0.61]
//   node tools/ap-bodies-fit.mjs samples <de440s.bsp> [--from 2010] [--to 2035] [--step 23.37]
//
// The kernel is NAIF's de440s.bsp (files/orbit-products/tests/fixtures/de440/download.py fetches it), checked by its
// SHA-256. Samples at TT every --step days. DE440's geocentric Moon (301 - 399) and the Sun as seen from the
// Earth-Moon barycenter (10 - 3) are turned from ICRF to the mean ecliptic and equinox of date by IAU 2006 precession
// (Fukushima-Williams angles, as ERFA's eraPfw06; the frame bias included), and their longitude (from the mean
// longitude F + Omega, or F - D + Omega for the Sun), latitude and distance fitted, each as a quadratic in
// tau = T - 0.25 (T in Julian centuries TT from J2000) plus sin and cos of integer combinations of the fundamental
// arguments (IERS Conventions 2010 eq. 5.43 and 5.44; Meeus 1998 ch. 47's A2 and A3), the largest also times tau.
// Pass 0 finds the largest terms of the main problem; pass 1 fits every candidate with those modulated by tau; pass 2
// keeps the terms above the thresholds and fits them again. Deterministic: the same kernel gives the same bytes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const KERNEL_SHA256 = "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const [mode, kernelPath] = process.argv.slice(2);
const opt = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
if (!["fit", "samples"].includes(mode) || !kernelPath) {
  console.error("usage: node tools/ap-bodies-fit.mjs fit|samples <de440s.bsp> [--from Y] [--to Y] [--step D]");
  process.exit(2);
}
const AS = Math.PI / 180 / 3600, TC = 0.25, TWO_PI = 2 * Math.PI;

// --- DE440 (SPK type 2, Chebyshev position records) --------------------------------------------------------------
const kernel = fs.readFileSync(kernelPath);
const kernelSha = createHash("sha256").update(kernel).digest("hex");
if (kernelSha !== KERNEL_SHA256) throw new Error(`${kernelPath}: sha256 ${kernelSha}, expected DE440s ${KERNEL_SHA256}`);
const segments = [];
{
  const ND = kernel.readInt32LE(8), NI = kernel.readInt32LE(12), size = ND + Math.floor((NI + 1) / 2);
  for (let rec = kernel.readInt32LE(76); rec > 0;) {
    const base = (rec - 1) * 1024, next = kernel.readDoubleLE(base), count = kernel.readDoubleLE(base + 16);
    for (let s = 0; s < count; s++) {
      const at = base + 24 + s * size * 8, ints = at + ND * 8, last = kernel.readInt32LE(ints + 20), end = (last - 4) * 8;
      segments.push({ et0: kernel.readDoubleLE(at), et1: kernel.readDoubleLE(at + 8), target: kernel.readInt32LE(ints), center: kernel.readInt32LE(ints + 4),
        type: kernel.readInt32LE(ints + 12), first: kernel.readInt32LE(ints + 16), init: kernel.readDoubleLE(end), len: kernel.readDoubleLE(end + 8),
        rsize: kernel.readDoubleLE(end + 16), n: kernel.readDoubleLE(end + 24) });
    }
    rec = next;
  }
}
function position(target, center, et) {
  const s = segments.find((q) => q.target === target && q.center === center && q.et0 <= et && et <= q.et1);
  if (!s || s.type !== 2) throw new Error(`no type 2 segment ${target} / ${center} at ${et}`);
  const k = Math.min(s.n - 1, Math.floor((et - s.init) / s.len)), r0 = (s.first - 1 + k * s.rsize) * 8;
  const mid = kernel.readDoubleLE(r0), rad = kernel.readDoubleLE(r0 + 8), deg = (s.rsize - 2) / 3 - 1, x = (et - mid) / rad;
  const T = [1, x];
  for (let j = 2; j <= deg; j++) T.push(2 * x * T[j - 1] - T[j - 2]);
  return [0, 1, 2].map((c) => { let v = 0; for (let j = 0; j <= deg; j++) v += kernel.readDoubleLE(r0 + 16 + (c * (deg + 1) + j) * 8) * T[j]; return v; });
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const moonGcrf = (et) => sub(position(301, 3, et), position(399, 3, et));
const sunEmbGcrf = (et) => sub(position(10, 0, et), position(3, 0, et));
const sunGcrf = (et) => sub(sunEmbGcrf(et), position(399, 3, et));
/** TDB seconds past J2000 at TT seconds past J2000 (TDB - TT to 2 us). */
const etOfTt = (tt) => { const g = (357.53 + 0.98560028 * (tt / 86400)) * Math.PI / 180; return tt + 0.001657 * Math.sin(g + 0.01671 * Math.sin(g)); };

// --- IAU 2006: GCRS -> mean ecliptic and equinox of date ------------------------------------------------------------
const Rx = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, s], [0, -s, c]]; };
const Rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, s, 0], [-s, c, 0], [0, 0, 1]]; };
const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const apply = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function eclipticOfDate(t) {
  const gamb = (-0.052928 + (10.556378 + (0.4932044 + (-0.00031238 + (-0.000002788 + 0.0000000260 * t) * t) * t) * t) * t) * AS;
  const phib = (84381.412819 + (-46.811016 + (0.0511268 + (0.00053289 + (-0.000000440 - 0.0000000176 * t) * t) * t) * t) * t) * AS;
  const psib = (-0.041775 + (5038.481484 + (1.5584175 + (-0.00018522 + (-0.000026452 - 0.0000000148 * t) * t) * t) * t) * t) * AS;
  return mul(Rz(-psib), mul(Rx(phib), Rz(gamb)));
}

// --- fundamental arguments (as src/ap_bodies.inc apb_fundamentals) --------------------------------------------------
const NAMES = ["D", "l", "lp", "F", "Om", "Ve", "E", "Ma", "J", "Sa", "A2", "A3"];
const NF = NAMES.length, IDX = Object.fromEntries(NAMES.map((n, i) => [n, i]));
const asr = (x) => (x % 1296000) * AS;
function fundamentals(T) {
  return [
    asr(1072260.703692 + T * (1602961601.2090 + T * (-6.3706 + T * (0.006593 + T * (-0.00003169))))),
    asr(485868.249036 + T * (1717915923.2178 + T * (31.8792 + T * (0.051635 + T * (-0.00024470))))),
    asr(1287104.793048 + T * (129596581.0481 + T * (-0.5532 + T * (0.000136 + T * (-0.00001149))))),
    asr(335779.526232 + T * (1739527262.8478 + T * (-12.7512 + T * (-0.001037 + T * (0.00000417))))),
    asr(450160.398036 + T * (-6962890.5431 + T * (7.4722 + T * (0.007702 + T * (-0.00005939))))),
    (3.176146697 + 1021.3285546211 * T) % TWO_PI,
    (1.753470314 + 628.3075849991 * T) % TWO_PI,
    (6.203480913 + 334.0612426700 * T) % TWO_PI,
    (0.599546497 + 52.9690962641 * T) % TWO_PI,
    (0.874016757 + 21.3299104960 * T) % TWO_PI,
    ((53.09 + 479264.290 * T) % 360) * Math.PI / 180,
    ((313.45 + 481266.484 * T) % 360) * Math.PI / 180,
  ];
}
const T_OF = (year) => (Date.UTC(year, 0, 1) - Date.UTC(2000, 0, 1, 12)) / 86400e3 / 36525;

if (mode === "samples") {
  // DE440's geocentric Moon and Sun (GCRF, km) at UTC instants (TT = UTC + 69.184 s from 2017; earlier, the leap
  // seconds of IERS Bulletin C), for the E2E
  const from = opt("--from", 2010), to = opt("--to", 2035), step = opt("--step", 23.37);
  const leaps = [[Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35], [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37]];
  const rows = [];
  for (let ms = Date.UTC(from, 0, 1, 3, 17); ms < Date.UTC(to + 1, 0, 1); ms += step * 86400e3) {
    let dat = 33;
    for (const [t, v] of leaps) if (ms >= t) dat = v;
    const et = etOfTt((ms - Date.UTC(2000, 0, 1, 12)) / 1000 + dat + 32.184);
    const jd = ms / 86400e3 + 2440587.5, whole = Math.floor(jd - 0.5) + 0.5;
    const r = (v) => v.map((x) => Number(x.toFixed(6)));
    rows.push({ utc: new Date(Math.round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z"), whole, frac: Number((jd - whole).toFixed(12)), moon: r(moonGcrf(et)), sun: r(sunGcrf(et)) });
  }
  const out = path.join(packageRoot, "test", "fixtures", `de440-bodies-${from}-${to}.json`);
  fs.writeFileSync(out, JSON.stringify({ source: "NAIF de440s.bsp", sha256: KERNEL_SHA256, frame: "GCRF (ICRF), km, geometric, geocentric",
    bodies: { moon: "301 - 399", sun: "10 - 3 - (399 - 3)" }, time: "UTC; TDB = UTC + leap seconds + 32.184 s + TDB - TT", rows }, null, 0) + "\n");
  console.log(out, rows.length, "rows");
  process.exit(0);
}

// --- fit ----------------------------------------------------------------------------------------------------------
const from = opt("--from", 1990), to = opt("--to", 2060), step = opt("--step", 0.61);
const T0 = T_OF(from), T1 = T_OF(to + 1);
const samples = [];
for (let T = T0; T < T1; T += step / 36525) {
  const et = etOfTt(T * 36525 * 86400), f = fundamentals(T), P = eclipticOfDate(T);
  const ys = [];
  for (const [v, L] of [[apply(P, moonGcrf(et)), f[3] + f[4]], [apply(P, sunEmbGcrf(et)), f[3] - f[0] + f[4]]]) {
    const r = Math.hypot(...v);
    let dl = Math.atan2(v[1], v[0]) - L;
    dl -= TWO_PI * Math.round(dl / TWO_PI);
    ys.push(dl / AS, Math.asin(v[2] / r) / AS, r);
  }
  samples.push({ T, f, y: ys });
}
console.error(`${samples.length} samples, TT ${from}-${to}, every ${step} d`);

const vec = (o) => { const v = new Array(NF).fill(0); for (const [k, m] of Object.entries(o)) v[IDX[k]] = m; return v; };
const key = (v) => v.join(",");
const canon = (v) => (v.find((x) => x !== 0) < 0 ? v.map((x) => -x) : v);
const order = (v) => v.reduce((s, x) => s + Math.abs(x), 0);
const rate0 = (() => {
  const a = fundamentals(TC + 1e-6), b = fundamentals(TC - 1e-6);
  return a.map((x, k) => { let d = x - b[k]; d -= TWO_PI * Math.round(d / TWO_PI); return d / 2e-6; });
})();
const rate = (v) => v.reduce((s, m, k) => s + m * rate0[k], 0);
/** Candidates slower than 50 years (the quadratic carries them over the span) or within 2 pi / (3 span) of a
 * lower-order one's rate (not separable over the span) are dropped. */
function separable(list) {
  const span = (to + 1 - from) / 100, kept = [];
  for (const v of [...list].sort((p, q) => order(p) - order(q) || key(p).localeCompare(key(q)))) {
    const w = Math.abs(rate(v));
    if (w < TWO_PI / 0.5 || kept.some((u) => Math.abs(Math.abs(rate(u)) - w) < TWO_PI / (3 * span))) continue;
    kept.push(v);
  }
  return kept;
}
function moonCandidates(mainOnly) {
  const even = new Map(), odd = new Map();
  const put = (v, both = false) => {
    if (v.every((x) => x === 0)) return;
    const c = canon(v);
    if (both || c[IDX.F] % 2 === 0) even.set(key(c), c);
    if (both || c[IDX.F] % 2 !== 0) odd.set(key(c), c);
  };
  for (let D = -6; D <= 6; D++) for (let l = -4; l <= 4; l++) for (let lp = -3; lp <= 3; lp++) for (let F = -4; F <= 4; F++) {
    const o = Math.abs(D) + Math.abs(l) + Math.abs(lp) + Math.abs(F);
    if (mainOnly ? o > 4 : o > 8 || (o === 8 && (Math.abs(lp) > 1 || Math.abs(F) > 2))) continue;
    put(vec({ D, l, lp, F }));
    if (!mainOnly && o <= 3) for (const Om of [-1, 1]) put(vec({ D, l, lp, F, Om }), true);
  }
  if (!mainOnly) {
    put(vec({ Om: 2 }));
    for (const s of [-1, 0, 1]) for (const t of [-1, 0, 1]) { put(vec({ A2: 1, F: s, l: t }), true); put(vec({ A3: 1, F: s, l: t }), true); }
    const lunar = [{}, { l: 1 }, { l: -1 }, { D: 1 }, { D: -1 }, { D: 2 }, { D: -2 }, { D: 2, l: -1 }, { D: -2, l: 1 }, { F: 1 }, { F: -1 }, { lp: 1 }, { lp: -1 }];
    for (const P of ["Ve", "Ma", "J", "Sa"]) for (let a = 1; a <= 3; a++) for (let b = -4; b <= 4; b++) {
      if (b === 0 || a + Math.abs(b) > 5) continue;
      for (const lu of a + Math.abs(b) <= 3 ? lunar : [{}]) put(vec({ E: a, [P]: b, ...lu }), true);
    }
  }
  return { even: separable(even.values()), odd: separable(odd.values()) };
}
function sunCandidates() {
  const all = new Map();
  const put = (v) => { const c = canon(v); all.set(key(c), c); };
  for (let k = 1; k <= 5; k++) put(vec({ lp: k }));
  for (const P of ["Ve", "Ma", "J", "Sa"]) for (let a = -4; a <= 4; a++) for (let b = -6; b <= 6; b++) if (b !== 0 && Math.abs(a) + Math.abs(b) <= 9) put(vec({ E: a, [P]: b }));
  for (const a of [1, 2]) for (const b of [-2, -1, 1, 2]) { for (const c of [-2, -1, 1, 2]) put(vec({ E: a, Ve: b, J: c })); put(vec({ E: a, J: b, Sa: -b })); }
  return separable(all.values());
}

// design rows: [1, tau, tau^2 | sin, cos per argument | tau sin, tau cos per modulated argument]
function design(args, tmod) {
  const NA = args.length, N = 3 + 2 * NA + 2 * tmod.length;
  return { N, args, tmod, row(s, out) {
    const tau = s.T - TC;
    out[0] = 1; out[1] = tau; out[2] = tau * tau;
    for (let a = 0; a < NA; a++) { let th = 0; const v = args[a]; for (let k = 0; k < NF; k++) if (v[k]) th += v[k] * s.f[k]; out[3 + 2 * a] = Math.sin(th); out[4 + 2 * a] = Math.cos(th); }
    tmod.forEach((a, q) => { out[3 + 2 * NA + 2 * q] = tau * out[3 + 2 * a]; out[4 + 2 * NA + 2 * q] = tau * out[4 + 2 * a]; });
  } };
}
function lsq(dsg, coords) {
  const N = dsg.N, A = new Float64Array(N * N), B = coords.map(() => new Float64Array(N)), row = new Float64Array(N);
  for (const s of samples) {
    dsg.row(s, row);
    for (let i = 0; i < N; i++) { const ri = row[i], o = i * N; for (let j = i; j < N; j++) A[o + j] += ri * row[j]; }
    coords.forEach((c, k) => { const y = s.y[c], b = B[k]; for (let i = 0; i < N; i++) b[i] += row[i] * y; });
  }
  for (let j = 0; j < N; j++) {
    let d = A[j * N + j];
    for (let k = 0; k < j; k++) d -= A[k * N + j] ** 2;
    if (!(d > 0)) throw new Error(`normal equations singular at column ${j}`);
    d = Math.sqrt(d);
    A[j * N + j] = d;
    for (let i = j + 1; i < N; i++) { let s = A[j * N + i]; for (let k = 0; k < j; k++) s -= A[k * N + j] * A[k * N + i]; A[j * N + i] = s / d; }
  }
  return B.map((b) => {
    const x = Float64Array.from(b);
    for (let i = 0; i < N; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= A[k * N + i] * x[k]; x[i] = s / A[i * N + i]; }
    for (let i = N - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < N; k++) s -= A[i * N + k] * x[k]; x[i] = s / A[i * N + i]; }
    return x;
  });
}
function residual(dsg, x, c) {
  const row = new Float64Array(dsg.N);
  let ss = 0, mx = 0;
  for (const s of samples) { dsg.row(s, row); let p = 0; for (let i = 0; i < dsg.N; i++) p += row[i] * x[i]; const e = s.y[c] - p; ss += e * e; mx = Math.max(mx, Math.abs(e)); }
  return { rms: Math.sqrt(ss / samples.length), max: mx };
}
const amp = (x, a) => Math.hypot(x[3 + 2 * a], x[4 + 2 * a]);
// thresholds: arcsec (longitude, latitude), km (distance); a term is modulated by tau above 25 times its threshold
const THRESHOLD = { 0: 0.15, 1: 0.12, 2: 0.15, 3: 0.06, 4: 0.06, 5: 25 };
const MOD_FACTOR = 25;
const fits = {};
function fitGroup(args0, coords, preMod) {
  const tmod1 = args0.map((v, a) => [v, a]).filter(([v]) => preMod.has(key(v))).map(([, a]) => a);
  const d1 = design(args0, tmod1), xs = lsq(d1, coords);
  coords.forEach((c, ci) => {
    const r1 = residual(d1, xs[ci], c);
    const keep = args0.map((v, a) => [v, amp(xs[ci], a)]).filter(([, A]) => A >= THRESHOLD[c]).sort((p, q) => q[1] - p[1] || key(p[0]).localeCompare(key(q[0])));
    const args = keep.map(([v]) => v), tmod = keep.map(([, A], a) => [a, A]).filter(([, A]) => A >= MOD_FACTOR * THRESHOLD[c]).map(([a]) => a);
    const d2 = design(args, tmod), [x2] = lsq(d2, [c]), r2 = residual(d2, x2, c);
    console.error(`coordinate ${c}: ${args0.length} candidates (rms ${r1.rms.toPrecision(3)}), ${args.length} kept, ${tmod.length} by tau: rms ${r2.rms.toPrecision(3)}, max ${r2.max.toPrecision(3)}`);
    fits[c] = { poly: Array.from(x2.slice(0, 3)), args, coef: args.map((v, a) => [x2[3 + 2 * a], x2[4 + 2 * a], 0, 0]), rms: r2.rms, max: r2.max, kept: args.length };
    tmod.forEach((a, q) => { fits[c].coef[a][2] = x2[3 + 2 * args.length + 2 * q]; fits[c].coef[a][3] = x2[4 + 2 * args.length + 2 * q]; });
  });
}
// pass 0: the main problem alone, for the terms pass 1 modulates by tau
const main = moonCandidates(true), preMod = new Set();
for (const [args, coords] of [[main.even, [0, 2]], [main.odd, [1]]]) {
  const xs = lsq(design(args, []), coords);
  coords.forEach((c, ci) => args.forEach((v, a) => { if (amp(xs[ci], a) >= MOD_FACTOR * THRESHOLD[c]) preMod.add(key(v)); }));
}
const moon = moonCandidates(false);
fitGroup(moon.even, [0, 2], preMod);
fitGroup(moon.odd, [1], preMod);
const sunPre = new Set([1, 2, 3].map((k) => key(vec({ lp: k }))));
fitGroup(sunCandidates(), [3, 4, 5], sunPre);

// --- src/ap_bodies_series.inc -------------------------------------------------------------------------------------
const argList = [], argIndex = new Map(), coefs = [];
for (let c = 0; c < 6; c++) fits[c].args.forEach((v, a) => {
  const k = key(v);
  if (!argIndex.has(k)) { argIndex.set(k, argList.length); argList.push(v); }
  coefs.push([argIndex.get(k), c, ...fits[c].coef[a]]);
});
const maxOf = NAMES.map((_, k) => Math.max(k < 5 ? 2 : 1, ...argList.map((v) => Math.abs(v[k]))));
const nonzero = argList.map((v) => v.map((m, k) => [k, m]).filter(([, m]) => m !== 0));
if (nonzero.some((z) => z.length > 5)) throw new Error("an argument has more than five fundamental arguments");
const num = (x) => (x === 0 ? "0.0" : (Object.is(x, -0) ? "0.0" : x.toPrecision(17).replace(/(\.\d*?)0+(e|$)/, "$1$2").replace(/\.(e|$)/, ".0$1")));
const label = { 0: "Moon longitude - (F + Omega), arcsec", 1: "Moon latitude, arcsec", 2: "Moon distance, km",
  3: "barycenter Sun longitude - (F - D + Omega), arcsec", 4: "barycenter Sun latitude, arcsec", 5: "barycenter Sun distance, km" };
const lines = [
  "// AP's Sun and Moon series (SPEC 16.14), generated by tools/ap-bodies-fit.mjs: do not edit.",
  `// Least squares on NAIF de440s.bsp (sha256 ${KERNEL_SHA256}),`,
  `// TT ${from}-01-01 to ${to + 1}-01-01 every ${step} d (${samples.length} samples); fundamental arguments ${NAMES.join(", ")}.`,
  ...[0, 1, 2, 3, 4, 5].map((c) => `// ${label[c]}: ${fits[c].kept} terms, fit residual RMS ${fits[c].rms.toPrecision(3)}, largest ${fits[c].max.toPrecision(3)}.`),
  `inline constexpr int kApbFund = ${NF};`,
  `inline constexpr int kApbMaxMultOf[kApbFund] = {${maxOf.join(", ")}};`,
  `inline constexpr int kApbMaxMult = ${Math.max(...maxOf)};`,
  `inline constexpr double kApbTc = ${num(TC)};`,
  `inline constexpr double kApbPoly[6][3] = {${[0, 1, 2, 3, 4, 5].map((c) => `{${fits[c].poly.map(num).join(", ")}}`).join(", ")}};`,
  `inline constexpr int kApbArgs = ${argList.length};`,
  "inline constexpr ApbArg kApbArg[kApbArgs] = {",
  ...nonzero.map((z) => `    {${z.length}, {${[...z.map(([k]) => k), ...new Array(5 - z.length).fill(0)].join(", ")}}, {${[...z.map(([, m]) => m), ...new Array(5 - z.length).fill(0)].join(", ")}}},`),
  "};",
  `inline constexpr int kApbCoefs = ${coefs.length};`,
  "inline constexpr ApbCoef kApbCoef[kApbCoefs] = {",
  ...coefs.map(([a, c, s, co, ts, tc]) => `    {${a}, ${c}, ${num(s)}, ${num(co)}, ${num(ts)}, ${num(tc)}},`),
  "};",
  "",
];
const out = path.join(packageRoot, "src", "ap_bodies_series.inc");
fs.writeFileSync(out, lines.join("\n"));
console.log(out, argList.length, "arguments,", coefs.length, "coefficient records");
