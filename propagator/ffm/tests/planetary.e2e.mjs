#!/usr/bin/env node
// E2E: FFM about the Moon and Mars, scored against NAIF's reconstructed trajectories, on the shipped artifact.
//
//   node propagator/ffm/tests/planetary.e2e.mjs
//
// The requests are typed $PRW execution requests (PCFForceModel.CENTRAL_BODY_NAIF_ID, GRAVITY_CHOICE GRGM660PRIM or
// SPHERICAL_HARMONICS for Mars's MRO120F, ATMOSPHERE_MODEL EXPONENTIAL for Mars's atmosphere) with the DE440 kernel as the
// `kernel` input. Truth is the states of NAIF's reconstructed SPKs (tests/fixtures/planetary, hashes and derivation in
// scripts/planetary-sources.json): LRO about the Moon, MRO and MAVEN about the Mars system barycenter (the SPKs' center;
// FFM takes the barycenter for Mars's center, which Phobos and Deimos displace by under 0.2 m). JS builds requests, reads
// results, solves the small normal equations of the fit and subtracts; every trajectory is integrated by the module.
// This is conformance tooling: it lives only under tests/ and says so (graph/checks/no-js-physics).
//
//   1. LRO, two windows: the state and the radiation-pressure coefficient fitted to the first day, predicted over the next
//      three, error by day; and the same arc at field degrees 2 to 360 (one window), so the field shows in the error;
//   2. MRO and MAVEN: state, radiation pressure and drag (Mars's banded exponential atmosphere) fitted to the first day,
//      predicted over three, error by day;
//   3. refusals by name: what is the Earth's and what lies outside an embedded model's span;
//   4. lane parity: the browser and native WasmEdge answers are identical bytes for a Moon and a Mars request.
//
// Bars are the measured error with a margin (reported next to each); they guard against regressions, not against the
// truth's own uncertainty (reconstructed ephemerides are fits to tracking data, and FFM has no maneuvers, no
// Phobos/Deimos and the atmosphere is one mean profile).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { destroyLanes, dist, KERNELS, MARS, MOON, readTruth, request, run } from './lib/planetary.mjs';
import { sds } from './lib/prwCodec.mjs';
import fs from 'node:fs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };
const kernel = (name) => fs.readFileSync(new URL(name, KERNELS));
const KERNEL_2026 = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const KERNEL_2018 = kernel('de440-2018-04-11_2018-05-17.bsp'), KERNEL_2021 = kernel('de440-2021-01-21_2021-02-17.bsp');

// ---- the fit: Gauss-Newton on the initial state and scale factors of the radiation-pressure and drag coefficients ----------
// Positions every FIT_STEP seconds over the fit day; the Jacobian by forward differences of the module's own trajectories.
const FIT_STEP = 600, DAY = 86400;
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

async function propagate(ctx, state, scales, target, sampleIndices) {
  const { truth, center, forces, kernel: kernelBytes, lane: kind } = ctx;
  const f = { ...forces };
  if (f.srp) f.srp = { cr: f.srp.cr * scales.srp };
  if (f.drag) f.drag = { cd: f.drag.cd * scales.drag };
  const exec = request({ center, epoch: truth.epochs[0], initial: state, target, samples: sampleIndices.map((k) => truth.epochs[k]), forces: f });
  const out = await run(kind, exec, kernelBytes);
  if (out.error) throw new Error(out.error);
  return out;
}
async function fit(ctx, fitIndices) {
  const { truth, forces } = ctx;
  const names = ['srp', 'drag'].filter((n) => forces[n]);
  let state = [...truth.states[0]], scales = { srp: 1, drag: 1 };
  const observe = async (s, sc) => (await propagate(ctx, s, sc, truth.epochs[fitIndices.at(-1)], fitIndices)).samples;
  const residual = (samples) => fitIndices.flatMap((k, i) => [0, 1, 2].map((c) => (samples[i][c] - truth.states[k][c]) * 1000));
  let rms = Infinity, best = null;
  for (let iteration = 0; iteration < 5; ++iteration) {
    const base = await observe(state, scales), e = residual(base);
    const now = Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length);
    const improved = !best || now < best.fitRms;
    if (improved) best = { state: [...state], scales: { ...scales }, fitRms: now };
    if (iteration > 0 && now > rms * 0.98) break;
    rms = now;
    const columns = [];
    for (let p = 0; p < 6; ++p) { const s = [...state]; s[p] += STEPS[p]; columns.push(residual(await observe(s, scales)).map((v, i) => (v - e[i]) / STEPS[p])); }
    for (const n of names) { const sc = { ...scales, [n]: scales[n] + 0.05 }; columns.push(residual(await observe(state, sc)).map((v, i) => (v - e[i]) / 0.05)); }
    const np = columns.length;
    const N = Array.from({ length: np }, (_, i) => Array.from({ length: np }, (_, j) => columns[i].reduce((a, v, k) => a + v * columns[j][k], 0)));
    const g = columns.map((c) => -c.reduce((a, v, k) => a + v * e[k], 0));
    for (let i = 0; i < np; ++i) N[i][i] *= 1 + 1e-9;
    const delta = solve(N, g);
    state = state.map((v, i) => v + delta[i]);
    names.forEach((n, i) => { scales[n] = Math.min(8, Math.max(0.05, scales[n] + delta[6 + i])); });
  }
  return best;
}
// Error by day: the fitted state propagated over the whole window, compared with every truth state.
async function byDay(ctx, solution, days) {
  const all = Array.from({ length: Math.round(days * DAY / ctx.truth.stepSeconds) }, (_, k) => k + 1);
  const out = await propagate(ctx, solution.state, solution.scales, ctx.truth.epochs[all.at(-1)], all);
  const perDay = [];
  for (let d = 0; d < days; ++d) {
    const rows = all.map((k, i) => ({ k, e: dist(out.samples[i], ctx.truth.states[k]) })).filter(({ k }) => k > d * DAY / ctx.truth.stepSeconds && k <= (d + 1) * DAY / ctx.truth.stepSeconds);
    perDay.push({ rms: Math.sqrt(rows.reduce((a, r) => a + r.e * r.e, 0) / rows.length), max: Math.max(...rows.map((r) => r.e)) });
  }
  return perDay;
}
const fitIndices = (truth) => Array.from({ length: DAY / FIT_STEP }, (_, k) => (k + 1) * FIT_STEP / truth.stepSeconds);
const fmt = (rows) => rows.map((r, d) => `day ${d + 1} rms ${r.rms.toFixed(1)} m (max ${r.max.toFixed(1)})`).join('; ');

const MOON_GM = 4902.7998069317;     // GRGM660PRIM's own GM (its PDS header), km^3/s^2
const MARS_GM = 42828.3748574;       // the GM of Mars alone in the MRO120F label, km^3/s^2

// ---- 1. LRO -------------------------------------------------------------------------------------------------------
console.log('1. LRO about the Moon (GRGM660PRIM, DE440 libration, Sun and Earth, radiation pressure)');
const lroForces = (degree) => ({ gm: MOON_GM, degree, order: degree, thirdBodies: [10, 399], massKg: 1100, areaM2: 12, srp: { cr: 1.3 } });
const results = { lro: {}, sweep: [], mro: {}, maven: {} };
for (const name of ['lro-2026-03-20', 'lro-2026-03-27']) {
  const truth = readTruth(`${name}.json`);
  const ctx = { truth, center: MOON, forces: lroForces(100), kernel: KERNEL_2026, lane: 'browser' };
  const solution = await fit(ctx, fitIndices(truth));
  const days = await byDay(ctx, solution, 4);
  results.lro[name] = { fitRms: solution.fitRms, scales: solution.scales, days };
  console.log(`  ${name} degree 100: fit rms ${solution.fitRms.toFixed(1)} m, SRP scale ${solution.scales.srp.toFixed(2)}; ${fmt(days)}`);
  // Measured 19.6 and 3.5 m (fit) and 117, 293, 516 m (window 1) on days 2 to 4; the bars are about twice the worse window.
  check(solution.fitRms < 40, `${name}: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 40 m`);
  check(days[0].rms < 70 && days[1].rms < 250 && days[2].rms < 600 && days[3].rms < 1100, `${name}: prediction errors ${fmt(days)} exceed the 70, 250, 600 and 1100 m bars`);
}
{
  const truth = readTruth('lro-2026-03-20.json');
  console.log('  the field in the error (same window, fitted at each degree):');
  for (const degree of [2, 20, 100, 200]) {
    const ctx = { truth, center: MOON, forces: lroForces(degree), kernel: KERNEL_2026, lane: 'browser' };
    const solution = await fit(ctx, fitIndices(truth));
    const days = await byDay(ctx, solution, 2);
    results.sweep.push({ degree, fitRms: solution.fitRms, day2: days[1].rms });
    console.log(`    degree ${String(degree).padStart(3)}: fit rms ${solution.fitRms.toFixed(1)} m, day-2 prediction rms ${days[1].rms.toFixed(1)} m`);
  }
  const [low, mid, high] = results.sweep;
  // Measured day-2 errors 29 215, 1 581, 117 and 115 m at degrees 2, 20, 100 and 200: the field is what the error is made of up to
  // about degree 100, and beyond it the unmodeled forces and the truth's own fit are.
  check(low.day2 > 10 * mid.day2 && mid.day2 > 5 * high.day2 && low.fitRms > 50 * high.fitRms, `error does not fall with the field's degree: ${JSON.stringify(results.sweep)}`);
}

// ---- 2. MRO and MAVEN ---------------------------------------------------------------------------------------------
console.log('2. MRO and MAVEN about Mars (MRO120F in its own axes, banded exponential atmosphere, Sun, Earth, Moon, Jupiter)');
{
  const truth = readTruth('mro-2018-05-12.json');
  const ctx = { truth, center: MARS, forces: { gm: MARS_GM, degree: 120, order: 120, thirdBodies: [10, 399, 301, 5], massKg: 1150, areaM2: 15, srp: { cr: 1.3 }, drag: { cd: 2.2 } }, kernel: KERNEL_2018, lane: 'browser' };
  const solution = await fit(ctx, fitIndices(truth));
  const days = await byDay(ctx, solution, 4);
  results.mro = { fitRms: solution.fitRms, scales: solution.scales, days };
  console.log(`  MRO ${truth.start.slice(0, 10)}: fit rms ${solution.fitRms.toFixed(1)} m, SRP scale ${solution.scales.srp.toFixed(2)}, drag scale ${solution.scales.drag.toFixed(2)}; ${fmt(days)}`);
  // Measured 0.4 m (fit) and 0.7, 1.9, 10.2, 27.2 m on days 1 to 4; the bars are about two to three times that.
  check(solution.fitRms < 2, `MRO: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 2 m`);
  check(days[0].rms < 3 && days[1].rms < 6 && days[2].rms < 30 && days[3].rms < 80, `MRO: prediction errors ${fmt(days)} exceed the 3, 6, 30 and 80 m bars`);
}
{
  const truth = readTruth('maven-2021-02-12.json');
  const ctx = { truth, center: MARS, forces: { gm: MARS_GM, degree: 120, order: 120, thirdBodies: [10, 399, 301, 5], massKg: 1900, areaM2: 20, srp: { cr: 1.3 }, drag: { cd: 2.2 } }, kernel: KERNEL_2021, lane: 'browser' };
  const solution = await fit(ctx, fitIndices(truth));
  const days = await byDay(ctx, solution, 4);
  results.maven = { fitRms: solution.fitRms, scales: solution.scales, days };
  console.log(`  MAVEN ${truth.start.slice(0, 10)}: fit rms ${solution.fitRms.toFixed(1)} m, SRP scale ${solution.scales.srp.toFixed(2)}, drag scale ${solution.scales.drag.toFixed(2)}; ${fmt(days)}`);
  // Measured 3.0 m (fit) and 5.7, 16.5, 82, 160 m on days 1 to 4; the bars are about two to three times that.
  check(solution.fitRms < 10, `MAVEN: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 10 m`);
  check(days[0].rms < 20 && days[1].rms < 45 && days[2].rms < 200 && days[3].rms < 400, `MAVEN: prediction errors ${fmt(days)} exceed the 20, 45, 200 and 400 m bars`);
}

// ---- 3. refusals by name ------------------------------------------------------------------------------------------
console.log('3. Refusals by name');
{
  const truth = readTruth('lro-2026-03-20.json');
  const base = (center, forces, extra = {}) => request({ center, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[12], forces, ...extra });
  const refused = async (label, exec, pattern, kernelBytes = KERNEL_2026) => {
    const out = await run('browser', exec, kernelBytes);
    check(out.error && pattern.test(out.error), `${label}: expected ${pattern}, got ${out.error ?? 'a result'}`);
    console.log(`  ${label}: ${out.error?.slice(0, 110)}`);
  };
  const moon = lroForces(20);
  await refused('drag about the Moon', base(MOON, { ...moon, drag: { cd: 2.2 } }), /unsupported-atmosphere/);
  await refused('EGM2008 about the Moon', base(MOON, { ...moon, gravity: sds.pcfGravitySelection.EGM2008 }), /unsupported-gravity/);
  await refused('GRGM660PRIM about the Earth', base(399, { ...moon, gravity: sds.pcfGravitySelection.GRGM660PRIM }), /unsupported-gravity/);
  await refused('the Moon as its own third body', base(MOON, { ...moon, thirdBodies: [10, 301] }), /unsupported-third-body/);
  await refused('a body with no embedded field', base(599, moon), /unsupported-central-body/);
  await refused('a degree beyond the field', base(MOON, lroForces(661)), /unsupported-gravity/);
  await refused('a state about the wrong body', request({ center: MARS, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[12], forces: { ...moon, extra: { CENTRAL_BODY_NAIF_ID: MOON } } }), /unsupported-frame/);
  const stm = base(MOON, moon); stm.INCLUDE_STM = true;
  await refused('the transition matrix about the Moon', stm, /unsupported-configuration/);
  const analytical = base(MOON, { ...moon, extra: { EPHEMERIS_SOURCE: 'Analytical' } });
  await refused('no kernel about the Moon', analytical, /missing-kernel/);
  const old = base(MOON, moon); old.INITIAL = request({ center: MOON, epoch: -3.0e8, initial: truth.states[0], target: -3.0e8 + 600, forces: moon }).INITIAL;
  old.TARGET_EPOCH = request({ center: MOON, epoch: -3.0e8, initial: truth.states[0], target: -3.0e8 + 600, forces: moon }).TARGET_EPOCH;
  await refused('an epoch before the lunar libration (1990)', old, /orientation-out-of-range/);
  const surface = [1737.4 + 5, 0, 0, 0, 0.1, 0.05];   // 5 km above the surface, almost at rest: it falls
  await refused('impact on the Moon', request({ center: MOON, epoch: truth.epochs[0], initial: surface, target: truth.epochs[0] + 3600, forces: { ...moon, thirdBodies: [] } }), /impact/);
}

// ---- 4. lane parity -----------------------------------------------------------------------------------------------
console.log('4. Lane parity: the browser and native WasmEdge give the same bits');
{
  const cases = [
    ['Moon', MOON, readTruth('lro-2026-03-20.json'), KERNEL_2026, lroForces(8)],
    ['Mars', MARS, readTruth('mro-2018-05-12.json'), KERNEL_2018, { gm: MARS_GM, degree: 8, order: 8, thirdBodies: [10, 399], massKg: 1150, areaM2: 15, srp: { cr: 1.3 }, drag: { cd: 2.2 } }],
  ];
  for (const [label, center, truth, kernelBytes, forces] of cases) {
    const exec = request({ center, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[24], samples: [6, 12, 18].map((k) => truth.epochs[k]), forces });
    const a = await run('browser', exec, kernelBytes), b = await run('wasmedge', exec, kernelBytes);
    const same = !a.error && !b.error && JSON.stringify([a.final, ...a.samples]) === JSON.stringify([b.final, ...b.samples]);
    check(same, `${label}: browser and WasmEdge differ (${a.error ?? b.error ?? 'values'})`);
    console.log(`  ${label}: ${same ? 'identical' : 'DIFFERENT'} (${createHash('sha256').update(JSON.stringify(a.final)).digest('hex').slice(0, 16)})`);
  }
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} planetary E2E ${JSON.stringify({ lro: Object.fromEntries(Object.entries(results.lro).map(([k, v]) => [k, v.days.map((d) => +d.rms.toFixed(1))])), sweep: results.sweep.map((s) => ({ degree: s.degree, day2: +s.day2.toFixed(1) })), mro: results.mro.days?.map((d) => +d.rms.toFixed(1)), maven: results.maven.days?.map((d) => +d.rms.toFixed(1)) })}`);
await destroyLanes();
process.exit(failures.length ? 1 : 0);
