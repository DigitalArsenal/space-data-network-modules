// The fit of the planetary E2E and its degree sweep: Gauss-Newton on the initial state and on scale factors of the
// radiation-pressure and drag coefficients, to NAIF's reconstructed states, every trajectory integrated by the module.
// Conformance tooling under tests/ only (graph/checks/no-js-physics): JS builds requests, solves the small normal
// equations and subtracts.
import { dist, request, run } from './planetary.mjs';

// ---- the fit: Gauss-Newton on the initial state and scale factors of the radiation-pressure and drag coefficients ----------
// Positions every FIT_STEP seconds over the fit day; the Jacobian by forward differences of the module's own trajectories.
export const FIT_STEP = 600, DAY = 86400;
const STEPS = [1e-3, 1e-3, 1e-3, 1e-6, 1e-6, 1e-6];       // km and km/s
const solve = (A, b) => {                                  // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
};

export async function propagate(ctx, state, scales, target, sampleIndices) {
  const { truth, center, forces, kernel: kernelBytes, lane: kind } = ctx;
  const f = { ...forces };
  if (f.srp) f.srp = { cr: f.srp.cr * scales.srp };
  if (f.drag) f.drag = { cd: f.drag.cd * scales.drag };
  const exec = request({ center, epoch: truth.epochs[0], initial: state, target, samples: sampleIndices.map((k) => truth.epochs[k]), forces: f });
  const out = await run(kind, exec, kernelBytes);
  if (out.error) throw new Error(out.error);
  return out;
}
// Levenberg-Marquardt: a step is taken only when it lowers the one-day residual, so the result is the fit's own minimum and
// not where an undamped Gauss-Newton happened to stop (which varied the day-2 error from degree to degree by more than the
// field does). The Jacobian is rebuilt after each accepted step; a rejected step raises the damping and retries.
export async function fit(ctx, fitIndices) {
  const { truth, forces } = ctx;
  const names = ['srp', 'drag'].filter((n) => forces[n]);
  let state = [...truth.states[0]], scales = { srp: 1, drag: 1 };
  const observe = async (s, sc) => (await propagate(ctx, s, sc, truth.epochs[fitIndices.at(-1)], fitIndices)).samples;
  const residual = (samples) => fitIndices.flatMap((k, i) => [0, 1, 2].map((c) => (samples[i][c] - truth.states[k][c]) * 1000));
  const rmsOf = (e) => Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length);
  let e = residual(await observe(state, scales)), rms = rmsOf(e), lambda = 1e-3;
  for (let iteration = 0; iteration < 12; ++iteration) {
    const columns = [];
    for (let p = 0; p < 6; ++p) { const s = [...state]; s[p] += STEPS[p]; columns.push(residual(await observe(s, scales)).map((v, i) => (v - e[i]) / STEPS[p])); }
    for (const n of names) { const sc = { ...scales, [n]: scales[n] + 0.05 }; columns.push(residual(await observe(state, sc)).map((v, i) => (v - e[i]) / 0.05)); }
    const np = columns.length;
    const N = Array.from({ length: np }, (_, i) => Array.from({ length: np }, (_, j) => columns[i].reduce((a, v, k) => a + v * columns[j][k], 0)));
    const g = columns.map((c) => -c.reduce((a, v, k) => a + v * e[k], 0));
    let accepted = false;
    for (let attempt = 0; attempt < 6 && !accepted; ++attempt) {
      const damped = N.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const delta = solve(damped, g);
      const trialState = state.map((v, i) => v + delta[i]);
      const trialScales = { ...scales };
      names.forEach((n, i) => { trialScales[n] = Math.min(8, Math.max(0.05, scales[n] + delta[6 + i])); });
      const trial = residual(await observe(trialState, trialScales)), trialRms = rmsOf(trial);
      if (trialRms < rms) {
        const gain = (rms - trialRms) / rms;
        state = trialState; scales = trialScales; e = trial; rms = trialRms; lambda = Math.max(1e-9, lambda / 4); accepted = true;
        if (gain < 1e-3) return { state, scales, fitRms: rms };
      } else lambda *= 8;
    }
    if (!accepted) break;
  }
  return { state, scales, fitRms: rms };
}
// Error by day: the fitted state propagated over the whole window, compared with every truth state.
export async function byDay(ctx, solution, days) {
  const all = Array.from({ length: Math.round(days * DAY / ctx.truth.stepSeconds) }, (_, k) => k + 1);
  const out = await propagate(ctx, solution.state, solution.scales, ctx.truth.epochs[all.at(-1)], all);
  const perDay = [];
  for (let d = 0; d < days; ++d) {
    const rows = all.map((k, i) => ({ k, e: dist(out.samples[i], ctx.truth.states[k]) })).filter(({ k }) => k > d * DAY / ctx.truth.stepSeconds && k <= (d + 1) * DAY / ctx.truth.stepSeconds);
    perDay.push({ rms: Math.sqrt(rows.reduce((a, r) => a + r.e * r.e, 0) / rows.length), max: Math.max(...rows.map((r) => r.e)) });
  }
  return perDay;
}
export const fitIndices = (truth) => Array.from({ length: DAY / FIT_STEP }, (_, k) => (k + 1) * FIT_STEP / truth.stepSeconds);
export const fmt = (rows) => rows.map((r, d) => `day ${d + 1} rms ${r.rms.toFixed(1)} m (max ${r.max.toFixed(1)})`).join('; ');

