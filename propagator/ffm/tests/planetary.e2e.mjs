#!/usr/bin/env node
// E2E: FFM about the Moon and Mars, scored against NAIF's reconstructed trajectories, on the shipped artifact.
//
//   node propagator/ffm/tests/planetary.e2e.mjs
//
// The requests are typed $PRW execution requests (PCFForceModel.CENTRAL_BODY_NAIF_ID, GRAVITY_CHOICE GRGM660PRIM for the Moon's
// field and MRO120F for Mars's, ATMOSPHERE_MODEL MARS_EXPONENTIAL for Mars's atmosphere, THIRD_BODY_MAXIMUM_DEGREE and _ORDER for
// the third body's field) with the DE440 kernel as the `kernel` input. Truth is the states of NAIF's reconstructed SPKs (tests/fixtures/planetary, hashes and derivation in
// scripts/planetary-sources.json): LRO about the Moon, MRO and MAVEN about the Mars system barycenter (the SPKs' center;
// FFM takes the barycenter for Mars's center, which Phobos and Deimos displace by under 0.2 m). JS builds requests, reads
// results, solves the small normal equations of the fit and subtracts; every trajectory is integrated by the module.
// This is conformance tooling: it lives only under tests/ and says so (graph/checks/no-js-physics).
//
//   0. the embedded fields, the two bodies' axes and the third-body harmonic term against oracles that share no code with FFM
//      (tests/fixtures/planetary/oracles.json, written by make-oracles.py): CSPICE's lunar libration frame, the PDS tables'
//      float64 coefficients through an independent Legendre recursion and potential differences, an independent evaluation of MRO120F's
//      label formula; the C++ is the module's own sources built natively;
//   1. LRO, two windows: the state and the radiation-pressure coefficient fitted to the first day, predicted over the next
//      three, error by day; and the same arc at field degrees 2, 20, 60 and 150 (one window), so the field shows in the error;
//   2. MRO and MAVEN: state, radiation pressure and drag (Mars's banded exponential atmosphere) fitted to the first day,
//      predicted over three, error by day;
//   3. the third body's field through the wire (THIRD_BODY_MAXIMUM_DEGREE and _ORDER): the Earth's harmonics on a lunar orbiter and
//      the Moon's on a high Earth orbiter move a short arc by what the module's own term gives, integrated twice along the path;
//   4. the whole lunar field through the gravity_field input ($SHC, GRGM660PRIM to degree 660, built from the pinned PDS table): where
//      it overlaps the embedded field (degree 150) the two give the same orbit, a low orbit moves by what degrees 151 to 660 add and
//      the difference converges with the degree, and the input is read only for a request that selects that field;
//   5. refusals by name: a field or atmosphere asked for about a body that is not its own (the Earth's SPHERICAL_HARMONICS and
//      EXPONENTIAL stand for no other body's), the third body's field where there is none, and what lies outside an embedded
//      model's span;
//   6. lane parity: the browser and native WasmEdge answers are identical bytes for a Moon and a Mars request.
//
// Bars are the measured error with a margin (reported next to each); they guard against regressions, not against the
// truth's own uncertainty (reconstructed ephemerides are fits to tracking data, and FFM has no maneuvers, no
// Phobos/Deimos and the atmosphere is one mean profile).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { destroyLanes, grgm660primField, KERNELS, MARS, MOON, readTruth, request, run, shc, smallField } from './lib/planetary.mjs';
import { physicsUnits } from '../lib/units.mjs';
import { byDay, fit, fitIndices, fmt } from './lib/planetaryFit.mjs';
import { sds } from './lib/prwCodec.mjs';
import { buildNative, run as runNative } from './lib/nativeBuild.mjs';
import fs from 'node:fs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };
const kernel = (name) => fs.readFileSync(new URL(name, KERNELS));
const KERNEL_2026 = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const KERNEL_2018 = kernel('de440-2018-04-11_2018-05-17.bsp'), KERNEL_2021 = kernel('de440-2021-01-21_2021-02-17.bsp');

const MOON_GM = 4902.7998069317;     // GRGM660PRIM's own GM (its PDS header), km^3/s^2
const MARS_GM = 42828.3748574;       // the GM of Mars alone in the MRO120F label, km^3/s^2

// The module's own third-body term, built natively (tests/third_body_harmonics_native.cpp): section 0 checks it against oracles,
// section 3 uses it to predict what the wire's THIRD_BODY_MAXIMUM_DEGREE does to a trajectory.
const third = buildNative('third-body', ['tests/third_body_harmonics_native.cpp', '../../third_party/hwm14/hwm14.cpp', '../../third_party/hwm14/hwm14_data.cpp', '../../third_party/nrlmsise00/nrlmsise-00.c', '../../third_party/nrlmsise00/nrlmsise-00_data.c',
  ...physicsUnits.map((n) => `lib/${n}.cpp`)]);
const DE440_2026 = new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url).pathname;

// ---- 0. fields, axes and the third-body term against independent oracles ----------------------------------------------
console.log('0. Embedded fields, axes and the third-body harmonic term against independent oracles');
{
  const oracles = JSON.parse(fs.readFileSync(new URL('./fixtures/planetary/oracles.json', import.meta.url), 'utf8'));
  const lib = ['planetary_fields', 'ffm_gravity', 'time_convert'].map((n) => `lib/${n}.cpp`);
  const planetary = await buildNative('planetary', ['tests/planetary_native.cpp', ...lib]);
  try {
    // Axes. The Moon's libration frame against CSPICE (pxform J2000 -> MOON_PA_DE440): bar 1e-9 on every element, measured 4e-11
    // (the two read the same Chebyshev records; the difference is the driver's instant, a single-double Julian date, 4e-5 s at
    // JD 2.46e6, times the Moon's 2.7e-6 rad/s). Mars's label model against a separate implementation of the same formula: 5e-9,
    // measured 1.0e-9 (the same instant quantization times Mars's 7.1e-5 rad/s; the formulas agree to roundoff), and against
    // IAU_MARS (a different, independent estimate of the pole and spin) within 1.5 arcsec of pole and 3.5 of rotation, measured 0.8 and 2.5.
    const ets = oracles.rotation.epochsTdbSeconds;
    for (const [body, key] of [[301, 'moon'], [499, 'mars']]) {
      const lines = (await runNative(planetary.binary, ['rotation', body, ...ets])).trim().split('\n');
      const worst = Math.max(...lines.flatMap((line, i) => line.split(' ').slice(1).map((v, j) => Math.abs(Number(v) - oracles.rotation[key][i][j]))));
      check(worst < (key === 'moon' ? 1e-9 : 5e-9), `${key} axes differ from the oracle by ${worst}`);
      console.log(`  ${key} axes: largest element difference ${worst.toExponential(1)} over ${ets.length} epochs`);
    }
    check(oracles.rotation.marsVsIau.every((x) => x.poleArcsec < 1.5 && x.rotationArcsec < 3.5), 'MRO120F axes drift from IAU_MARS by more than 1.5 / 3.5 arcsec');
    // Fields. The harmonic acceleration at body-fixed positions against the independent evaluation: relative 5e-8, measured 1.9e-8
    // at most (the tables are float32, relative 6e-8 per coefficient; the oracle differences the potential over 8 m).
    for (const f of oracles.fields) {
      const lines = (await runNative(planetary.binary, ['gravity', f.body, f.degree, f.order, f.tesseral, ...f.points.flat()])).trim().split('\n');
      const worst = Math.max(...lines.map((line, i) => { const a = line.split(' ').map(Number), b = f.acceleration[i]; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.hypot(...b); }));
      check(worst < 5e-8, `field ${f.body} ${f.degree}x${f.order}: relative difference ${worst}`);
      console.log(`  field of ${f.body === 301 ? 'GRGM660PRIM' : 'MRO120F'} ${f.degree}x${f.order} (tesseral ${f.tesseral}): ${f.points.length} points, relative difference ${worst.toExponential(1)}`);
    }
    // Extended third-body gravity: the Moon's harmonics on a GEO satellite minus their value at the Earth's center, against the
    // oracle (relative 1e-6, measured 3e-8), and its size against the Moon's point-mass tide it adds to.
    const thirdBinary = await third;
    {
      for (const t of oracles.thirdBody) {
        const out = (await runNative(thirdBinary.binary, [DE440_2026, t.central, t.degree, t.degree, t.etTdb, ...t.satellite])).trim().split('\n').map((l) => l.split(' ').map(Number));
        const [h, pm] = out, norm = (v) => Math.hypot(...v);
        const diff = norm(h.map((v, i) => v - t.harmonic[i])) / norm(t.harmonic), ratio = norm(h) / norm(pm);
        check(diff < 1e-6, `third body, degree ${t.degree}: relative difference ${diff}`);
        check(ratio > 1e-9 && ratio < 1e-6, `third body, degree ${t.degree}: harmonic/point-mass ${ratio} is outside 1e-9..1e-6`);
        console.log(`  Moon's harmonics (degree ${t.degree}) on a GEO satellite: ${(norm(h) * 1000).toExponential(2)} m/s^2 against the point-mass tide ${(norm(pm) * 1000).toExponential(2)} m/s^2 (ratio ${ratio.toExponential(1)}), oracle difference ${diff.toExponential(1)}`);
      }
      const lunar = (await runNative(thirdBinary.binary, [DE440_2026, 301, 4, 4, 8.3e8, 1838, 0, 0])).trim().split('\n').map((l) => l.split(' ').map(Number));
      const ratio = Math.hypot(...lunar[0]) / Math.hypot(...lunar[1]);
      check(ratio > 1e-9 && ratio < 1e-5, `Earth's harmonics on a lunar orbiter: harmonic/point-mass ${ratio} is outside 1e-9..1e-5`);
      console.log(`  Earth's harmonics (degree 4) on a lunar orbiter: ${(Math.hypot(...lunar[0]) * 1000).toExponential(2)} m/s^2 against the point-mass tide ${(Math.hypot(...lunar[1]) * 1000).toExponential(2)} m/s^2 (ratio ${ratio.toExponential(1)})`);
    }
  } finally { planetary.dispose(); }
}

// ---- 1. LRO -------------------------------------------------------------------------------------------------------
console.log('1. LRO about the Moon (GRGM660PRIM to its embedded degree 150, DE440 libration, Sun and Earth, radiation pressure)');
const lroForces = (degree) => ({ gm: MOON_GM, degree, order: degree, thirdBodies: [10, 399], massKg: 1100, areaM2: 12, srp: { cr: 1.3 } });
const results = { lro: {}, sweep: [], mro: {}, maven: {} };
for (const name of ['lro-2026-03-20', 'lro-2026-03-27']) {
  const truth = readTruth(`${name}.json`);
  const ctx = { truth, center: MOON, forces: lroForces(150), kernel: KERNEL_2026, lane: 'browser' };
  const solution = await fit(ctx, fitIndices(truth));
  const days = await byDay(ctx, solution, 4);
  results.lro[name] = { fitRms: solution.fitRms, scales: solution.scales, days };
  console.log(`  ${name} degree 150: fit rms ${solution.fitRms.toFixed(1)} m, SRP scale ${solution.scales.srp.toFixed(2)}; ${fmt(days)}`);
  // Measured 11.2 and 2.4 m (fit) and, on days 1 to 4 of the worse window (03-20), 21.7, 24.4, 94.4 and 230.1 m; the bars are
  // about twice the worse window.
  check(solution.fitRms < 25, `${name}: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 25 m`);
  check(days[0].rms < 45 && days[1].rms < 50 && days[2].rms < 190 && days[3].rms < 460, `${name}: prediction errors ${fmt(days)} exceed the 45, 50, 190 and 460 m bars`);
}
{
  const truth = readTruth('lro-2026-03-20.json');
  console.log('  the field in the error (same window, fitted at each degree):');
  for (const degree of [2, 20, 60, 150]) {
    const ctx = { truth, center: MOON, forces: lroForces(degree), kernel: KERNEL_2026, lane: 'browser' };
    const solution = await fit(ctx, fitIndices(truth));
    const days = await byDay(ctx, solution, 2);
    results.sweep.push({ degree, fitRms: solution.fitRms, day2: days[1].rms });
    console.log(`    degree ${String(degree).padStart(3)}: fit rms ${solution.fitRms.toFixed(1)} m, day-2 prediction rms ${days[1].rms.toFixed(1)} m`);
  }
  const [d2, d20, d60, d150] = results.sweep;
  // Measured day-2 errors 15 249, 1 446, 60.7 and 24.4 m (fit 4 429, 637, 29.5 and 11.2 m) at degrees 2, 20, 60 and 150: the field is
  // what the error is made of up to about degree 60, and past it the unmodeled forces and the truth's own fit are. The bars are
  // about half the measured ratios.
  check(d2.day2 > 5 * d20.day2 && d20.day2 > 10 * d60.day2 && d60.day2 > 1.5 * d150.day2 && d2.fitRms > 5 * d20.fitRms && d20.fitRms > 10 * d60.fitRms && d60.fitRms > 1.5 * d150.fitRms,
    `error does not fall with the field's degree: ${JSON.stringify(results.sweep)}`);
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
  // Measured 0.4 m (fit) and 1.1, 2.3, 4.1, 6.5 m on days 1 to 4; the bars are about twice that.
  check(solution.fitRms < 1, `MRO: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 1 m`);
  check(days[0].rms < 2.5 && days[1].rms < 5 && days[2].rms < 9 && days[3].rms < 14, `MRO: prediction errors ${fmt(days)} exceed the 2.5, 5, 9 and 14 m bars`);
}
{
  const truth = readTruth('maven-2021-02-12.json');
  const ctx = { truth, center: MARS, forces: { gm: MARS_GM, degree: 120, order: 120, thirdBodies: [10, 399, 301, 5], massKg: 1900, areaM2: 20, srp: { cr: 1.3 }, drag: { cd: 2.2 } }, kernel: KERNEL_2021, lane: 'browser' };
  const solution = await fit(ctx, fitIndices(truth));
  const days = await byDay(ctx, solution, 4);
  results.maven = { fitRms: solution.fitRms, scales: solution.scales, days };
  console.log(`  MAVEN ${truth.start.slice(0, 10)}: fit rms ${solution.fitRms.toFixed(1)} m, SRP scale ${solution.scales.srp.toFixed(2)}, drag scale ${solution.scales.drag.toFixed(2)}; ${fmt(days)}`);
  // Measured 2.5 m (fit) and 4.4, 23.7, 161.7, 316.6 m on days 1 to 4 (the drag of a periapsis near 150 km is what the days
  // past the first are made of); the bars are about twice that.
  check(solution.fitRms < 6, `MAVEN: one-day fit rms ${solution.fitRms.toFixed(1)} m is not below 6 m`);
  check(days[0].rms < 10 && days[1].rms < 50 && days[2].rms < 320 && days[3].rms < 640, `MAVEN: prediction errors ${fmt(days)} exceed the 10, 50, 320 and 640 m bars`);
}

// The Earth as a central body, point mass with the Sun and the Moon: the request the third-body field of an Earth orbiter rides on.
const EARTH_FORCES = { gm: 398600.4418, degree: 2, order: 2, gravity: sds.pcfGravitySelection.POINT_MASS, thirdBodies: [10, 301], massKg: 1000, areaM2: 10 };

// ---- 3. the third body's field through the wire ------------------------------------------------------------------------
console.log("3. The third body's field through the wire (THIRD_BODY_MAXIMUM_DEGREE and THIRD_BODY_MAXIMUM_ORDER)");
{
  const thirdBinary = await third;
  const truth = readTruth('lro-2026-03-20.json');
  const t0 = truth.epochs[0];
  // Two paired requests that differ only in the field: the same state and the same steps, so the difference of their final
  // states is the field's doing. A short arc answers to the term alone: the orbit's response to a small acceleration is its
  // double integral for as long as the arc is short against the orbital period, so the prediction integrates the module's own
  // term (evaluated natively, tests/third_body_harmonics_native.cpp) along the path twice: dr(T) = int_0^T (T - s) a(s) ds.
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const cases = [
    { label: "Earth's harmonics (degree 4) on a lunar orbiter", center: MOON, initial: truth.states[0], span: 600, degree: 4, bar: 0.08,
      forces: { ...lroForces(8), thirdBodies: [10, 399] } },
    { label: "Moon's harmonics (degree 2) on a high Earth orbit", center: 399, initial: [1e5, 0, 0, 0, 1.9965 * c30, 1.9965 * s30], span: 3600, degree: 2, bar: 0.08,
      forces: EARTH_FORCES },
  ];
  for (const c of cases) {
    const step = 30, times = Array.from({ length: c.span / step }, (_, k) => t0 + (k + 1) * step);
    const exec = (field) => request({ center: c.center, epoch: t0, initial: c.initial, target: t0 + c.span, samples: times, integrator: { absM: 1e-10, rel: 1e-14, initial: 5, max: 30 },
      forces: { ...c.forces, extra: field ? { THIRD_BODY_MAXIMUM_DEGREE: c.degree, THIRD_BODY_MAXIMUM_ORDER: c.degree } : {} } });
    const without = await run('browser', exec(false), KERNEL_2026), withField = await run('browser', exec(true), KERNEL_2026);
    check(!without.error && !withField.error, `${c.label}: ${without.error ?? withField.error}`);
    if (without.error || withField.error) continue;
    // the module's term at the start and at each sample of the path with the field, km/s^2 -> m/s^2
    const states = [c.initial, ...withField.samples], when = [t0, ...times];
    const out = (await runNative(thirdBinary.binary, [DE440_2026, c.center, c.degree, c.degree, ...states.flatMap((state, k) => [when[k], ...state.slice(0, 3)])])).trim().split('\n');
    const accel = states.map((_, k) => out[3 * k].split(' ').map((v) => Number(v) * 1000));
    // trapezoid over the path of (T - s) a(s)
    const T = c.span, predicted = [0, 0, 0];
    for (let k = 0; k < states.length; ++k) {
      const s = when[k] - t0, w = (k === 0 || k === states.length - 1 ? 0.5 : 1) * step;
      for (let i = 0; i < 3; ++i) predicted[i] += w * (T - s) * accel[k][i];
    }
    const measured = [0, 1, 2].map((i) => (withField.final[i] - without.final[i]) * 1000);
    const norm = (v) => Math.hypot(...v), error = norm(measured.map((v, i) => v - predicted[i])) / norm(predicted);
    check(norm(predicted) > 1e-8 && norm(measured) > 1e-8, `${c.label}: the field did not move the orbit (measured ${norm(measured)} m, predicted ${norm(predicted)} m)`);
    check(error < c.bar, `${c.label}: the orbit moved by ${measured.map((v) => v.toExponential(3))} m, the term integrated twice gives ${predicted.map((v) => v.toExponential(3))} m (difference ${error})`);
    console.log(`  ${c.label}, ${c.span} s: the field moves the orbit by ${(norm(measured) * 1e6).toFixed(2)} um; the module's term integrated twice gives ${(norm(predicted) * 1e6).toFixed(2)} um (relative difference ${error.toExponential(1)})`);
  }
}

// ---- 4. the whole lunar field through the gravity_field input -----------------------------------------------------------------
console.log('4. The whole lunar field (GRGM660PRIM to degree 660) through the gravity_field input ($SHC)');
const FIELD = grgm660primField();
{
  const truth = readTruth('lro-2026-03-27.json');
  const t0 = truth.epochs[0];
  const norm = (a, b) => 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // Where the supplied field and the embedded one overlap (degree 100, one day of LRO) they give the same orbit: the embedded
  // tables are float32 (relative 6e-8), the supplied record float64. Measured 0.02 m.
  const day = (degree) => request({ center: MOON, epoch: t0, initial: truth.states[0], target: t0 + 86400, forces: lroForces(degree), integrator: { absM: 1e-8, rel: 1e-13 } });
  const embedded = await run('browser', day(100), KERNEL_2026), supplied = await run('browser', day(100), KERNEL_2026, FIELD);
  check(!embedded.error && !supplied.error, `degree 100 over a day: ${embedded.error ?? supplied.error}`);
  if (!embedded.error && !supplied.error) {
    const d = norm(embedded.final, supplied.final);
    check(d < 0.2, `the supplied field and the embedded one differ by ${d} m over a day at degree 100`);
    console.log(`  degree 100, one day of LRO: the supplied field and the embedded field end ${d.toFixed(3)} m apart`);
  }
  // A low orbit (20 km over the surface, polar, two hours): the degrees past the embedded 150 move it by tens of meters and the
  // answer converges as the degree rises (each difference to degree 660 is smaller than the one before).
  const radius = 1737.4 + 20, speed = Math.sqrt(MOON_GM / radius);
  const low = (degree, field) => run('browser', request({ center: MOON, epoch: t0, initial: [radius, 0, 0, 0, 0, speed], target: t0 + 7200,
    forces: { ...lroForces(degree), srp: undefined, areaM2: 10 }, integrator: { absM: 1e-8, rel: 1e-13, max: 60 } }), KERNEL_2026, field);
  const ends = {};
  for (const degree of [150, 300, 450, 660]) {
    const out = await low(degree, degree > 150 ? FIELD : undefined);
    check(!out.error, `low orbit at degree ${degree}: ${out.error}`);
    ends[degree] = out.final;
  }
  if (Object.values(ends).every(Boolean)) {
    const gain = norm(ends[660], ends[150]), tail300 = norm(ends[660], ends[300]), tail450 = norm(ends[660], ends[450]);
    check(gain > 10, `degrees 151 to 660 moved a 20 km orbit by only ${gain} m`);
    check(tail300 < gain / 5 && tail450 < tail300 / 3, `the orbit does not converge with the degree: ${gain}, ${tail300}, ${tail450} m from degree 660 at 150, 300, 450`);
    console.log(`  20 km polar orbit, two hours: degree 660 against 150 ${gain.toFixed(1)} m, against 300 ${tail300.toFixed(2)} m, against 450 ${tail450.toFixed(2)} m`);
  }
}

// ---- 5. refusals by name ------------------------------------------------------------------------------------------
console.log('5. Refusals by name');
{
  const truth = readTruth('lro-2026-03-20.json');
  const base = (center, forces, extra = {}) => request({ center, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[12], forces, ...extra });
  const refused = async (label, exec, pattern, kernelBytes = KERNEL_2026, field) => {
    const out = await run('browser', exec, kernelBytes, field);
    check(out.error && pattern.test(out.error), `${label}: expected ${pattern}, got ${out.error ?? 'a result'}`);
    console.log(`  ${label}: ${out.error?.slice(0, 110)}`);
  };
  const moon = lroForces(20), mars = { gm: MARS_GM, degree: 20, order: 20, thirdBodies: [10, 399], massKg: 1150, areaM2: 15 };
  const G = sds.pcfGravitySelection, A = sds.pcfAtmosphereFamily, field = (degree, order = degree) => ({ extra: { THIRD_BODY_MAXIMUM_DEGREE: degree, THIRD_BODY_MAXIMUM_ORDER: order } });
  // A field or an atmosphere belongs to its body and is selected by its own name; asked for about another body it is refused
  // (SPHERICAL_HARMONICS and EXPONENTIAL are the Earth's, not the central body's own).
  await refused('SPHERICAL_HARMONICS about the Moon', base(MOON, { ...moon, gravity: G.SPHERICAL_HARMONICS }), /unsupported-gravity: SPHERICAL_HARMONICS, EGM2008 and EGM96 are the Earth's fields/);
  await refused('SPHERICAL_HARMONICS about Mars', base(MARS, { ...mars, gravity: G.SPHERICAL_HARMONICS }), /unsupported-gravity: SPHERICAL_HARMONICS, EGM2008 and EGM96 are the Earth's fields/);
  await refused('EGM2008 about the Moon', base(MOON, { ...moon, gravity: G.EGM2008 }), /unsupported-gravity: SPHERICAL_HARMONICS, EGM2008 and EGM96 are the Earth's fields/);
  await refused('MRO120F about the Moon', base(MOON, { ...moon, gravity: G.MRO120F }), /unsupported-gravity: MRO120F is Mars's field/);
  await refused('MRO120F about the Earth', base(399, { ...moon, gravity: G.MRO120F }), /unsupported-gravity: MRO120F is Mars's field/);
  await refused('GRGM660PRIM about Mars', base(MARS, { ...mars, gravity: G.GRGM660PRIM }), /unsupported-gravity: GRGM660PRIM is the Moon's field/);
  await refused('GRGM660PRIM about the Earth', base(399, { ...moon, gravity: G.GRGM660PRIM }), /unsupported-gravity: GRGM660PRIM is the Moon's field/);
  await refused('EXPONENTIAL drag about Mars', base(MARS, { ...mars, drag: { cd: 2.2 }, atmosphere: A.EXPONENTIAL }), /unsupported-atmosphere: About Mars select ATMOSPHERE_MODEL MARS_EXPONENTIAL/);
  await refused('NRLMSISE00 drag about Mars', base(MARS, { ...mars, drag: { cd: 2.2 }, atmosphere: A.NRLMSISE00 }), /unsupported-atmosphere: About Mars select ATMOSPHERE_MODEL MARS_EXPONENTIAL/);
  await refused('MARS_EXPONENTIAL about the Earth', base(399, { ...EARTH_FORCES, atmosphere: A.MARS_EXPONENTIAL }), /unsupported-atmosphere: MARS_EXPONENTIAL is Mars's atmosphere/);
  await refused('MARS_EXPONENTIAL about the Moon', base(MOON, { ...moon, atmosphere: A.MARS_EXPONENTIAL }), /unsupported-atmosphere: MARS_EXPONENTIAL is Mars's atmosphere/);
  await refused('drag about the Moon', base(MOON, { ...moon, drag: { cd: 2.2 } }), /unsupported-atmosphere: FFM has no atmosphere model for Moon/);
  await refused('the Moon as its own third body', base(MOON, { ...moon, thirdBodies: [10, 301] }), /unsupported-third-body/);
  await refused('a body with no embedded field', base(599, moon), /unsupported-central-body/);
  await refused('a degree beyond the embedded field', base(MOON, lroForces(151)), /unsupported-gravity: GRGM660PRIM is embedded to degree 150 of its 660/);
  await refused('a degree past the embedded field without the gravity_field input', base(MOON, lroForces(151)), /unsupported-gravity: GRGM660PRIM is embedded to degree 150 of its 660; the request names degree 151 \(two through 150 are available; the gravity_field input carries the whole field\)/);
  await refused('a degree past the published field with it', base(MOON, lroForces(661)), /unsupported-gravity: GRGM660PRIM is a field of degree 660; the request names degree 661/, KERNEL_2026, FIELD);
  const bad = async (label, edit, pattern, degree = 4) => refused(label, base(MOON, lroForces(degree)), pattern, KERNEL_2026, await smallField(edit));
  await refused('bytes that are not a $SHC', base(MOON, lroForces(4)), /invalid-gravity-field: gravity_field is not a valid \$SHC/, KERNEL_2026, new Uint8Array(64));
  await bad('the field of another body', { CENTRAL_BODY_NAIF_ID: 499 }, /invalid-gravity-field: the set is the field of NAIF body 499, the request flies about 301/);
  await bad('the field of another model', { MODEL_NAME: 'GRGM1200A' }, /invalid-gravity-field: the request selects GRGM660PRIM; the set is GRGM1200A/);
  await bad('an unnormalized set', { NORMALIZATION: (await shc()).shcNormalization.UNNORMALIZED }, /invalid-gravity-field: the set is not fully normalized/);
  await bad('a set of lower degree than the request', {}, /unsupported-gravity: the supplied GRGM660PRIM is of degree 4 and order 4; the request names degree 5 and order 5/, 5);
  await bad('a set with a coefficient missing', { DEGREES: [2, 2, 2, 3], ORDERS: [0, 1, 2, 0], C: [1e-6, 1e-6, 1e-6, 1e-6], S: [0, 0, 0, 0], MAX_DEGREE: 4, MAX_ORDER: 4 }, /invalid-gravity-field: coefficient \(3, 1\) is missing/, 3);
  await bad('a set with a coefficient twice', { DEGREES: [2, 2, 2, 2], ORDERS: [0, 1, 2, 2], C: [1e-6, 1e-6, 1e-6, 1e-6], S: [0, 0, 0, 0] }, /invalid-gravity-field: coefficient \(2, 2\) appears twice/, 2);
  await bad('a set with arrays of different lengths', { C: [1e-6] }, /invalid-gravity-field: DEGREES, ORDERS, C and S must be present and of one length/);
  await bad('a set with no GM', { GM: 0 }, /invalid-gravity-field: GM and REFERENCE_RADIUS must be positive and finite/);
  await refused('a gravity_field about the Earth', base(399, { ...EARTH_FORCES }), /unsupported-environment: gravity_field is the harmonic field of a request about the Moon or Mars/, KERNEL_2026, FIELD);
  await refused('a gravity_field with a point-mass Moon', base(MOON, { ...moon, gravity: G.POINT_MASS }), /unsupported-environment: gravity_field is the harmonic field of a request about the Moon or Mars/, KERNEL_2026, FIELD);
  await refused('a gravity_field of the Moon about Mars', base(MARS, mars), /invalid-gravity-field: the set is the field of NAIF body 301, the request flies about 499/, KERNEL_2018, FIELD);
  await refused('a degree beyond the embedded field of Mars', base(MARS, { ...mars, degree: 121, order: 121 }), /unsupported-gravity: MRO120F is a field of degree 120; the request names degree 121/);
  await refused('a state about the wrong body', request({ center: MARS, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[12], forces: { ...moon, gravity: G.POINT_MASS, extra: { CENTRAL_BODY_NAIF_ID: MOON } } }), /unsupported-frame/);
  // The third body's field (THIRD_BODY_MAXIMUM_DEGREE and _ORDER): where there is none, where it is not asked for, and past what is embedded.
  await refused('a third-body field about Mars', base(MARS, { ...mars, ...field(4) }), /unsupported-third-body: No third body of Mars has an embedded harmonic field/);
  await refused('third-body degree 1', base(MOON, { ...moon, ...field(1, 0) }), /invalid-forces: THIRD_BODY_MAXIMUM_DEGREE is 0 \(the third bodies are point masses\) or two and up/);
  await refused('third-body order without degree', base(MOON, { ...moon, extra: { THIRD_BODY_MAXIMUM_ORDER: 2 } }), /invalid-presence: THIRD_BODY_MAXIMUM_ORDER requires THIRD_BODY_MAXIMUM_DEGREE/);
  await refused('third-body order above the degree', base(MOON, { ...moon, ...field(4, 5) }), /unsupported-gravity: THIRD_BODY_MAXIMUM_ORDER must be between zero and THIRD_BODY_MAXIMUM_DEGREE/);
  await refused('a third-body field without third bodies', base(MOON, { ...moon, thirdBodies: [], ...field(4) }), /invalid-forces: THIRD_BODY_MAXIMUM_DEGREE requires ENABLE_THIRD_BODY/);
  await refused('the Earth not among the Moon\'s third bodies', base(MOON, { ...moon, thirdBodies: [10], ...field(4) }), /unsupported-third-body: THIRD_BODY_MAXIMUM_DEGREE is the Earth's field about the Moon; list the Earth \(399\)/);
  await refused('the Moon not among the Earth\'s third bodies', base(399, { ...EARTH_FORCES, thirdBodies: [10], ...field(2) }), /unsupported-third-body: THIRD_BODY_MAXIMUM_DEGREE is the Moon's field about the Earth; list the Moon \(301\)/);
  await refused('a third-body field beyond the Earth\'s embedded field', base(MOON, { ...moon, ...field(71) }), /unsupported-gravity: THIRD_BODY_MAXIMUM_DEGREE names degree 71; the Earth's EGM2008 is embedded to degree 70/);
  await refused('a third-body field beyond the Moon\'s embedded field', base(399, { ...EARTH_FORCES, ...field(151) }), /unsupported-gravity: THIRD_BODY_MAXIMUM_DEGREE names degree 151; the Moon's GRGM660PRIM is embedded to degree 150/);
  await refused('a third-body field without the kernel', base(399, { ...EARTH_FORCES, extra: { EPHEMERIS_SOURCE: 'Analytical', THIRD_BODY_MAXIMUM_DEGREE: 2, THIRD_BODY_MAXIMUM_ORDER: 2 } }), /missing-kernel: THIRD_BODY_MAXIMUM_DEGREE reads the planetary kernel/);
  const earlyEarth = request({ center: 399, epoch: -3.0e8, initial: [1e5, 0, 0, 0, 1.9965, 0], target: -3.0e8 + 600, forces: { ...EARTH_FORCES, ...field(2) } });
  await refused('the Moon\'s field on an Earth orbit before the lunar libration (1990)', earlyEarth, /orientation-out-of-range: The Moon's embedded orientation model covers/);
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

// ---- 6. lane parity -----------------------------------------------------------------------------------------------
console.log('6. Lane parity: the browser and native WasmEdge give the same bits');
{
  const cases = [
    ['Moon', MOON, readTruth('lro-2026-03-20.json'), KERNEL_2026, lroForces(8)],
    ['Mars', MARS, readTruth('mro-2018-05-12.json'), KERNEL_2018, { gm: MARS_GM, degree: 8, order: 8, thirdBodies: [10, 399], massKg: 1150, areaM2: 15, srp: { cr: 1.3 }, drag: { cd: 2.2 } }],
    ['Moon with the gravity_field input', MOON, readTruth('lro-2026-03-20.json'), KERNEL_2026, lroForces(160), FIELD],
  ];
  for (const [label, center, truth, kernelBytes, forces, field] of cases) {
    const exec = request({ center, epoch: truth.epochs[0], initial: truth.states[0], target: truth.epochs[24], samples: [6, 12, 18].map((k) => truth.epochs[k]), forces });
    const a = await run('browser', exec, kernelBytes, field), b = await run('wasmedge', exec, kernelBytes, field);
    const same = !a.error && !b.error && JSON.stringify([a.final, ...a.samples]) === JSON.stringify([b.final, ...b.samples]);
    check(same, `${label}: browser and WasmEdge differ (${a.error ?? b.error ?? 'values'})`);
    console.log(`  ${label}: ${same ? 'identical' : 'DIFFERENT'} (${createHash('sha256').update(JSON.stringify(a.final)).digest('hex').slice(0, 16)})`);
  }
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} planetary E2E ${JSON.stringify({ lro: Object.fromEntries(Object.entries(results.lro).map(([k, v]) => [k, v.days.map((d) => +d.rms.toFixed(1))])), sweep: results.sweep.map((s) => ({ degree: s.degree, day2: +s.day2.toFixed(1) })), mro: results.mro.days?.map((d) => +d.rms.toFixed(1)), maven: results.maven.days?.map((d) => +d.rms.toFixed(1)) })}`);
await destroyLanes();
process.exit(failures.length ? 1 : 0);
