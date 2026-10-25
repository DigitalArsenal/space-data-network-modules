#!/usr/bin/env node
// The candidate process-noise models of orbit-accuracy-experiments C1 (experiments/sdn-ap-covariance-calibration,
// PLAN 3 and 4), fitted on the fit set and chosen on the validation set from the module's own decomposition of P(t)
// (test/covariance-realism.mjs --decompose): per sample the error e, P0 = J P_p J^T + F (noise off), the floor F and
// the unit-noise matrices B_k (k = eccentricity vector, inclination vector, mean longitude, drag n-dot), and per window
// the fit residuals' RMS and along-track lag autocorrelations. A candidate's covariance, position block:
//
//   P = k (P0 - F) + f_F w F + w sum_k z_k^2 g_k(d) B_k
//
// - M0: k = 1, f_F = 1, w = 1, g_k = 1 (today's SPEC 12.5);
// - M1: g_k(d) = (h(d) / d)^2 for k = 0, 1, 2, h(d) = tau sqrt(2 (d/tau - 1 + exp(-d/tau))) (Gauss-Markov rate errors;
//   the drag column unchanged);
// - M2: k = 1 + 2 sum of the along-track autocorrelations over the lags before the first that is not positive (at most
//   20), f_F fitted;
// - M3: w = (r / r_reg)^beta, r the window's fit-residual RMS, r_reg the regime's median r over the fit set; with
//   M1 alone or with M1 + M2 (C1 amendment A2).
//
// Sizes z = (s_e, s_i, s_l, c |n-dot_ng| n) and f_F by maximum likelihood on the fit set (Gaussian negative
// log-likelihood of e under P, every sample of days 1 to 3), per theory and regime; the choice on the validation set
// (most cells inside the band, then the smaller sum of |ln(mean d^2/3)| + |coverage - 0.95| / 0.05, then fewer
// parameters). Statistics on the module's numbers only.
//
//   node test/covariance-candidates.mjs --theory SDNAP --fit FIT.jsonl --validation VALIDATION.jsonl --out FILE
import fs from "node:fs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const THEORY = arg("theory", "SDNAP");
const read = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const fitSet = read(arg("fit"));
const validationSet = read(arg("validation"));
const OUT = arg("out", null);
const BAND = { mean: [0.8, 1.25], coverage: [0.93, 0.97] }, CHI2_3_95 = 7.814727903251178, LEAD_DAYS = 3;
const TAUS = [0.5, 1, 2, 4], BETAS = [0, 0.5, 1];

function d2AndLogDet(L, e) {
  const [a, b, c, d, f, g] = L;
  const det = a * (c * g - f * f) - b * (b * g - f * d) + d * (b * f - c * d);
  if (!(det > 0)) return null;
  const i00 = (c * g - f * f) / det, i01 = (d * f - b * g) / det, i02 = (b * f - c * d) / det;
  const i11 = (a * g - d * d) / det, i12 = (b * d - a * f) / det, i22 = (a * c - b * b) / det;
  return { d2: e[0] * (i00 * e[0] + i01 * e[1] + i02 * e[2]) + e[1] * (i01 * e[0] + i11 * e[1] + i12 * e[2]) + e[2] * (i02 * e[0] + i12 * e[1] + i22 * e[2]), logDet: Math.log(det) };
}
const h = (d, tau) => tau * Math.sqrt(2 * (d / tau - 1 + Math.exp(-d / tau)));
function kFactor(rho) {
  let sum = 0;
  for (const r of rho) { if (!(r > 0)) break; sum += r; }
  return 1 + 2 * sum;
}
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };

// window-level constants of a candidate: k, w
const rReg = Object.fromEntries(["drag", "above"].map((regime) => [regime, median(fitSet.filter((w) => w.regime === regime).map((w) => w.residuals.rms))]));
function covariance(win, s, cand, th) {
  const k = cand.m2 ? kFactor(win.residuals.rho) : 1;
  const w = cand.m3 ? (win.residuals.rms / rReg[win.regime]) ** cand.beta : 1;
  const fF = cand.m2 ? th.fF : 1;
  const z = [th.s_e, th.s_i, th.s_l, th.c * Math.abs(win.ngRate) * win.nDay];
  const g = cand.m1 ? (h(s.lead, cand.tau) / s.lead) ** 2 : 1;
  return s.P0.map((p0, j) => k * (p0 - s.F[j]) + fF * w * s.F[j] + w * z.reduce((acc, zk, kk) => acc + zk * zk * (kk < 3 ? g : 1) * s.B[kk][j], 0));
}
function nll(wins, cand, th) {
  let sum = 0;
  for (const win of wins) for (const s of win.samples) {
    const r = d2AndLogDet(covariance(win, s, cand, th), s.e);
    if (!r) return Infinity;
    sum += r.logDet + r.d2;
  }
  return sum;
}
/** Maximum likelihood of the sizes (log10 coordinate search from common starts, as the harness's calibration). */
function fitSizes(wins, cand, regime) {
  const names = ["s_e", "s_i", "s_l", ...(regime === "drag" ? ["c"] : []), ...(cand.m2 ? ["fF"] : [])];
  const toTh = (lg) => ({ s_e: 10 ** lg.s_e, s_i: 10 ** lg.s_i, s_l: 10 ** lg.s_l, c: regime === "drag" ? 10 ** lg.c : 0, fF: cand.m2 ? 10 ** lg.fF : 1 });
  let best = null;
  for (const start of [-9, -8, -7, -6, -5]) {
    let lg = { s_e: start, s_i: start, s_l: start, c: -1, fF: 0 };
    let v = nll(wins, cand, toTh(lg));
    for (let step = 1; step >= 1 / 128; step /= 2) {
      let moved = true;
      while (moved) {
        moved = false;
        for (const n of names) for (const dir of [1, -1]) {
          const trial = { ...lg, [n]: lg[n] + dir * step };
          const tv = nll(wins, cand, toTh(trial));
          if (tv < v) { lg = trial; v = tv; moved = true; }
        }
      }
    }
    if (!best || v < best.v) best = { lg, v };
  }
  return { th: toTh(best.lg), nll: best.v };
}
function cells(wins, cand, th) {
  const out = {};
  for (let day = 1; day <= LEAD_DAYS; ++day) {
    const d2 = [];
    for (const win of wins) for (const s of win.samples) if (s.lead > day - 1 && s.lead <= day) {
      const r = d2AndLogDet(covariance(win, s, cand, th), s.e);
      if (r) d2.push(r.d2);
    }
    if (!d2.length) continue;
    const mean = d2.reduce((a, b) => a + b, 0) / d2.length / 3;
    const coverage = d2.filter((x) => x <= CHI2_3_95).length / d2.length;
    out[day] = { samples: d2.length, meanD2Over3: +mean.toPrecision(4), coverage95: +coverage.toPrecision(4),
      inside: mean >= BAND.mean[0] && mean <= BAND.mean[1] && coverage >= BAND.coverage[0] && coverage <= BAND.coverage[1] };
  }
  return out;
}
const score = (cs) => Object.values(cs).reduce((acc, c) => acc + Math.abs(Math.log(c.meanD2Over3)) + Math.abs(c.coverage95 - 0.95) / 0.05, 0);

const candidates = [{ name: "M0", order: 0 }];
for (const tau of TAUS) candidates.push({ name: `M1 tau ${tau}`, order: 1, m1: true, tau });
// C1 amendment A2: M1 + M3 without M2, ranked between M1 and M1 + M2
for (const tau of TAUS) for (const beta of BETAS.filter((b) => b > 0)) candidates.push({ name: `M1+M3 tau ${tau} beta ${beta}`, order: 1.5, m1: true, m3: true, tau, beta });
for (const tau of TAUS) candidates.push({ name: `M1+M2 tau ${tau}`, order: 2, m1: true, m2: true, tau });
for (const tau of TAUS) for (const beta of BETAS) candidates.push({ name: `M1+M2+M3 tau ${tau} beta ${beta}`, order: 3, m1: true, m2: true, m3: true, tau, beta });

const report = { experiment: "C1 (orbit-accuracy-experiments experiments/sdn-ap-covariance-calibration)", theory: THEORY, created: new Date().toISOString(),
  fitWindows: fitSet.length, validationWindows: validationSet.length, rReg, regimes: {} };
for (const regime of ["drag", "above"]) {
  const fitWins = fitSet.filter((w) => w.regime === regime), valWins = validationSet.filter((w) => w.regime === regime);
  if (!fitWins.length) continue;
  const rows = [];
  for (const cand of candidates) {
    const { th, nll: v } = fitSizes(fitWins, cand, regime);
    const val = cells(valWins, cand, th);
    const inside = Object.values(val).filter((c) => c.inside).length;
    rows.push({ candidate: cand.name, order: cand.order, tau: cand.tau ?? null, beta: cand.beta ?? null, m2: !!cand.m2, m3: !!cand.m3,
      sizes: Object.fromEntries(Object.entries(th).map(([k, x]) => [k, +x.toPrecision(4)])), fitNll: v, validation: val, insideValidation: inside, validationScore: +score(val).toFixed(4) });
    console.log(`${THEORY} ${regime} ${cand.name}: fit NLL ${v.toFixed(1)}, validation ${inside}/${Object.keys(val).length} inside, score ${score(val).toFixed(3)}`);
  }
  rows.sort((a, b) => b.insideValidation - a.insideValidation || a.validationScore - b.validationScore || a.order - b.order);
  report.regimes[regime] = { fitWindows: fitWins.length, validationWindows: valWins.length, chosen: rows[0], candidates: rows };
  console.log(`${THEORY} ${regime} CHOSEN: ${rows[0].candidate} (${rows[0].insideValidation}/3 validation cells inside)`);
}
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
