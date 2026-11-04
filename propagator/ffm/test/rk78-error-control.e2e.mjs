#!/usr/bin/env node
// E2E (modules-ffm-rk78-error-control-20261104): a requested RK78 bounds the error of every step by its tolerance, so a flight at a
// 300 s maximum step converges with the tolerance; a requested fixed GAUSS_JACKSON_8 grid is flown as named.
//
// Oracle: the two-body problem in 60-digit arithmetic (tests/lib/keplerReference.mjs), a test oracle computed in JS: the exact
// state of a Kepler orbit at any time; it integrates nothing. Every flight is the shipped artifact's (invoke, browser lane; one
// flight repeated in native WasmEdge for lane parity). JS builds requests, reads results and subtracts.
// Units km, km/s, s; GCRF axes; point-mass gravity with GRAVITATIONAL_PARAMETER 398600.4418e9 m^3/s^2 (mu 398600.4418 km^3/s^2).
// Integrator settings as the FFM-losses study flew them: INITIAL_STEP_SECONDS 60, MINIMUM_STEP_SECONDS 1e-3, ABSOLUTE_TOLERANCES
// tolerance x 1000 (m, m/s), RELATIVE_TOLERANCE tolerance.
//
//   (a) a LAGEOS-like Kepler orbit (a 12270 km, e 0.0045, i 109.84 deg: period 3.76 h) flown 10 days by RK78 at
//       MAXIMUM_STEP_SECONDS 300 with tolerances 1e-8, 1e-10 and 1e-12: the largest position error against the oracle at days
//       1, 3, 7 and 10 falls with the tolerance and is below 1 m at 1e-10 (the record's bar: 1e-10 of the 12270 km radius is
//       1.2 m, so the bar holds the 10-day error to the requested relative tolerance of the state);
//   (b) LAGEOS 1 at 2025-11-19T00:00:00Z (test/fixtures/lageos1-ilrsa-20251119.mjs, the ILRS combination orbit), flown two-body
//       to 2025-11-29T00:00:00Z (day 7 after the study's 2025-11-22 cutoff, 10 days from the state) at MAXIMUM_STEP_SECONDS
//       300 and at 30, both at 1e-10: the along-track difference (30 s minus 300 s, along the 300 s velocity, as the study
//       measured it) is below 1 m;
//   (c) the orbit of (a) asking for GAUSS_JACKSON_8 at INITIAL_STEP_SECONDS 60 is flown on that fixed grid: ACCEPTED_STEPS is
//       10 days / 60 s = 14400 at tolerance 1e-8 and at 1e-12, and the two flights' states are identical (a fixed grid takes no
//       tolerance); its error against the oracle is reported.
//
//   node propagator/ffm/test/rk78-error-control.e2e.mjs
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { decodePrw, encodePrw, execution, makeTable, sds, TYPE } from '../tests/lib/prwCodec.mjs';
import { orbit as keplerOrbit } from '../tests/lib/keplerReference.mjs';
import { EPOCH as LAGEOS_EPOCH, STATE as LAGEOS_STATE } from './fixtures/lageos1-ilrsa-20251119.mjs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MU = 398600.4418;
const DAY = 86400;
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };

const lanes = {};
const lane = async (kind) => (lanes[kind] ??= await createStandaloneHarness(kind, WASM, { surface: kind === 'browser' ? 'direct' : 'command', enableThreads: true }));
const instant = (iso, scale) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard[scale], EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: iso });
// TT seconds after 2023-02-25T00:00:00 TT as an ISO 8601 label on TT (nanoseconds).
const isoTT = (seconds) => {
  const nanos = Math.round(seconds * 1e9), total = Math.floor(nanos / 1e9), frac = nanos - total * 1e9;
  const day = Math.floor(total / DAY), rest = total - day * DAY;
  const pad = (x) => String(x).padStart(2, '0');
  return `${new Date(Date.UTC(2023, 1, 25 + day)).toISOString().slice(0, 10)}T${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}.${String(frac).padStart(9, '0')}`;
};

// One flight: the request's samples, ACCEPTED_STEPS at the last, and the wall time of the invoke.
async function fly({ kind = 'browser', position, velocity, epoch, scale, samples, algorithm = 'RK78', tolerance, maxStep, initialStep = 60 }) {
  const exec = execution({ epochJD: 2460000.5, targetJD: 2460001.5, position, velocity, epochTimeScale: scale,
    forces: { mu: MU, gravityMode: 'POINT_MASS', j2: false, centralBody: true },
    integrator: { initialStep, minStep: 1e-3, maxStep, tolerance, maxSteps: 5_000_000 } });
  exec.INITIAL.STATE.EPOCH = epoch; exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = scale;
  exec.INTEGRATOR.ALGORITHM = sds.pcfIntegratorAlgorithm[algorithm];
  exec.SAMPLE_EPOCHS = samples.map((iso) => instant(iso, scale));
  exec.TARGET_EPOCH = instant(samples.at(-1), scale);
  const h = await lane(kind), started = performance.now();
  const r = await h.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }] });
  const ms = performance.now() - started;
  if (r.statusCode !== 0) return { error: `${r.errorCode ?? ''}: ${r.errorMessage ?? ''}` };
  const result = decodePrw(r.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT;
  const states = result.SAMPLES.map((s) => { const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY; return [p.X, p.Y, p.Z, v.X, v.Y, v.Z].map((x) => x / 1000); });
  return { states, steps: Number(result.SAMPLES.at(-1).ACCEPTED_STEPS), rejected: Number(result.SAMPLES.at(-1).REJECTED_STEPS), ms };
}
const metres = (a, b) => 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (x) => x.toExponential(3);

// (a) ---------------------------------------------------------------------------------------------------------------------
const ORBIT = { a: 12270, e: 0.0045, i: 109.84 * Math.PI / 180, raan: 1.2, argp: 2.5, meanAnomaly0: 0.3 };
const ref = keplerOrbit({ ...ORBIT, mu: MU });
const DAYS = [1, 3, 7, 10];
const truth = DAYS.map((d) => ref.state(d * DAY));
const kepler = { position: ref.state(0).position, velocity: ref.state(0).velocity, epoch: isoTT(0), scale: 'TT', samples: DAYS.map((d) => isoTT(d * DAY)) };
console.log(`(a) LAGEOS-like Kepler orbit, period ${(ref.period_s / 3600).toFixed(2)} h, 10 days, RK78 at max step 300 s`);
const largest = {};
let parityStates = null;
for (const tolerance of [1e-8, 1e-10, 1e-12]) {
  const f = await fly({ ...kepler, tolerance, maxStep: 300 });
  check(!f.error, `(a) tolerance ${tolerance}: ${f.error}`);
  if (f.error) continue;
  const errors = f.states.map((s, k) => metres(s, truth[k].position));
  largest[tolerance] = Math.max(...errors);
  if (tolerance === 1e-10) parityStates = f.states;
  console.log(`  tolerance ${tolerance.toExponential(0)}: position error m ${errors.map((e, k) => `d${DAYS[k]} ${fmt(e)}`).join(' ')}; largest ${fmt(largest[tolerance])}; ${f.steps} steps, ${f.rejected} rejected, ${f.ms.toFixed(0)} ms`);
}
check(largest[1e-8] > largest[1e-10] && largest[1e-10] > largest[1e-12], `(a) the error does not fall with the tolerance: ${largest[1e-8]} ${largest[1e-10]} ${largest[1e-12]} m`);
check(largest[1e-10] < 1, `(a) the error at 1e-10 is ${largest[1e-10]} m, not below 1 m`);
const thirty = await fly({ ...kepler, tolerance: 1e-10, maxStep: 30 });
if (!thirty.error) console.log(`  max step 30 s at 1e-10 (the converged flight): largest ${fmt(Math.max(...thirty.states.map((s, k) => metres(s, truth[k].position))))} m; ${thirty.steps} steps, ${thirty.ms.toFixed(0)} ms`);
const native = await fly({ ...kepler, kind: 'wasmedge', tolerance: 1e-10, maxStep: 300 });
check(!native.error, `(a) WasmEdge: ${native.error}`);
const same = !native.error && parityStates && native.states.every((s, k) => s.every((x, j) => Object.is(x, parityStates[k][j])));
console.log(`  lane parity (tolerance 1e-10, browser and native WasmEdge): ${same ? 'identical states' : 'DIFFERENT'}`);
check(same, '(a) the browser and WasmEdge states differ');

// (b) ---------------------------------------------------------------------------------------------------------------------
console.log(`(b) LAGEOS 1 at ${LAGEOS_EPOCH} (ILRS combination), two-body to 2025-11-29T00:00:00Z at 1e-10`);
const lageos = { position: LAGEOS_STATE.slice(0, 3), velocity: LAGEOS_STATE.slice(3), epoch: LAGEOS_EPOCH, scale: 'UTC', samples: ['2025-11-29T00:00:00.000000Z'], tolerance: 1e-10 };
const coarse = await fly({ ...lageos, maxStep: 300 }), fine = await fly({ ...lageos, maxStep: 30 });
check(!coarse.error && !fine.error, `(b) ${coarse.error ?? ''} ${fine.error ?? ''}`);
if (!coarse.error && !fine.error) {
  const a = coarse.states[0], b = fine.states[0], speed = Math.hypot(a[3], a[4], a[5]);
  const along = [0, 1, 2].reduce((q, k) => q + (b[k] - a[k]) * 1000 * a[3 + k] / speed, 0);
  console.log(`  30 s minus 300 s at day 7: along-track ${along.toFixed(4)} m, |dr| ${metres(a, b).toFixed(4)} m; 300 s: ${coarse.steps} steps ${coarse.ms.toFixed(0)} ms, 30 s: ${fine.steps} steps ${fine.ms.toFixed(0)} ms`);
  check(Math.abs(along) < 1, `(b) along-track difference ${along} m, not below 1 m`);
}

// (c) ---------------------------------------------------------------------------------------------------------------------
console.log('(c) the orbit of (a) asking for GAUSS_JACKSON_8 at INITIAL_STEP_SECONDS 60');
const grid = {};
for (const tolerance of [1e-8, 1e-12]) {
  const f = await fly({ ...kepler, algorithm: 'GAUSS_JACKSON_8', tolerance, maxStep: 300, initialStep: 60 });
  check(!f.error, `(c) tolerance ${tolerance}: ${f.error}`);
  if (f.error) continue;
  grid[tolerance] = f;
  console.log(`  tolerance ${tolerance.toExponential(0)}: ${f.steps} steps; position error m ${f.states.map((s, k) => `d${DAYS[k]} ${fmt(metres(s, truth[k].position))}`).join(' ')}; ${f.ms.toFixed(0)} ms`);
  check(f.steps === 14400, `(c) tolerance ${tolerance}: ${f.steps} steps, not the 14400 of the 60 s grid`);
}
check(grid[1e-8] && grid[1e-12] && grid[1e-8].states.every((s, k) => s.every((x, j) => Object.is(x, grid[1e-12].states[k][j]))), '(c) the tolerance changed a fixed-grid flight');

await Promise.all(Object.values(lanes).map((h) => h.destroy?.()));
if (failures.length) { console.log(`\nFAIL ${failures.length}`); process.exit(1); }
console.log(`\nPASS RK78 at max step 300 s: largest 10-day error ${fmt(largest[1e-8])} / ${fmt(largest[1e-10])} / ${fmt(largest[1e-12])} m at 1e-8 / 1e-10 / 1e-12; LAGEOS 1 300 s against 30 s below 1 m along-track at day 7; GAUSS_JACKSON_8 flown on its 60 s grid`);
