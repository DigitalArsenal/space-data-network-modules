#!/usr/bin/env node
// E2E: every FFM integrator and every event kind, selected through the FlatBuffer request
// (PCFIntegratorSettings.ALGORITHM, PRWExecutionRequest.EVENTS) and run on the shipped
// artifact in the browser lane and in native WasmEdge.
//
// Truth is the two-body problem in 60-digit arithmetic (tests/lib/keplerReference.mjs): the exact
// state at any time, and the exact epoch of every event of a Kepler orbit. Nothing here
// integrates; JS builds requests, reads results and subtracts.
//
//   1. event epochs: each event function, located inside each integrator, on a LEO, a GEO and an
//      e = 0.7 orbit, at three step settings, against the closed-form epochs (bar 1e-6 s at
//      tolerance 1e-12, and the same epoch whatever the step);
//   2. accuracy: each integrator over 10 orbits against the exact state, with the stage
//      evaluations spent;
//   3. actions and filters: STOP, RECORD, CONTINUE and the crossing direction;
//   4. refusals by name: reduced-force solvers, unknown values, velocity-dependent forces for the
//      Nystrom pair, events on a method without a continuous extension;
//   5. one LEO case against the committed Orekit 13.1 DormandPrince853 reference;
//   6. lane parity: the browser and WasmEdge answers are identical;
//   7. eclipse against the sampled-ephemeris locator; 8. closest approach to a second trajectory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { decodePrw, encodePrw, execution, makeTable, sds, TYPE } from './lib/prwCodec.mjs';
import { orbit as keplerOrbit } from './lib/keplerReference.mjs';
import * as flatbuffers from 'flatbuffers';
import { createHash } from 'node:crypto';
import { REFERENCE as OREKIT, requestInputs as orekitInputs, score as orekitScore, toleranceFor as orekitBar } from './lib/orekitCases.mjs';

process.env.PATH = `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}`;
const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MU = 398600.4418;                      // km^3/s^2, the request's GRAVITATIONAL_PARAMETER / 1e9
const EPOCH_JD = 2460000.5;                  // 2023-02-25T00:00:00 TT
const EPOCH_ISO = '2023-02-25T00:00:00.000000000';
const BAR_S = 1e-6;                          // the acceptance bar on every event epoch
// Tolerance 1e-12 is a relative local error at the LEO radius; the other orbits keep the same
// absolute local error (a relative tolerance scales it with the radius), so the three orbits
// ask the integrators for the same accuracy in meters.
const REFERENCE_RADIUS_KM = 6900;
const toleranceFor = (orbit) => 1e-12 * REFERENCE_RADIUS_KM / orbit.a;
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };

// ----------------------------------------------------------------------------- orbits
const ORBITS = {
  LEO: { a: 6900, e: 0.01, i: 0.9006, raan: 0.4, argp: 0.9, meanAnomaly0: 0.7, steps: { fixed: [1, 2, 4], adaptive: [[10, 60], [30, 180], [60, 600]] }, fixedMaxStep: 4 },
  GEO: { a: 42164.17, e: 0.01, i: 0.0873, raan: 1.1, argp: 2.2, meanAnomaly0: 2.3, steps: { fixed: [2, 4, 8], adaptive: [[100, 600], [300, 1800], [600, 6000]] }, fixedMaxStep: 8 },
  E07: { a: 26560, e: 0.7, i: 1.1070, raan: 2.0, argp: 4.7124, meanAnomaly0: 3.5, steps: { fixed: [1, 2, 4], adaptive: [[10, 60], [30, 180], [60, 600]] }, fixedMaxStep: 4 },
};
for (const o of Object.values(ORBITS)) o.ref = keplerOrbit({ ...o, mu: MU });

// The integrators with a continuous extension, and how many derivative evaluations one of their
// accepted steps costs (stages not reused from the previous step).
const ENGINE = [
  ['RK4', 4, true], ['RKF45', 6, false], ['COWELL', 6, false], ['RKF78', 13, false], ['RK78', 13, false],
  ['RKDP87', 13, false], ['DOPRI5', 6, false], ['RK65', 8, false], ['RKV98', 16, false], ['RKN1210', 17, false], ['BS', 48, false],
];
// The Fehlberg 7(8) pair's embedded estimate trails its true error by about an order of magnitude
// (part 2 measures it against RKDP87 at the same tolerance), so it is asked for a tenth of the
// tolerance in part 1 to meet the same bar.
const TOLERANCE_FACTOR = { RKF78: 0.1, RK78: 0.1 };
const FIXED_STEP_ONLY = [['ABM', 2], ['GAUSS_JACKSON_8', 1]];

// ----------------------------------------------------------------------------- requests
const isoTT = (seconds) => {
  const nanos = Math.round(seconds * 1e9), total = Math.floor(nanos / 1e9), frac = nanos - total * 1e9;
  const day = Math.floor(total / 86400), rest = total - day * 86400;
  const hh = Math.floor(rest / 3600), mm = Math.floor((rest % 3600) / 60), ss = rest % 60;
  const d = new Date(Date.UTC(2023, 1, 25 + day));
  return `${d.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(frac).padStart(9, '0')}`;
};
const exactSeconds = (s) => Math.round(s * 1e9) / 1e9;
const ttInstant = (seconds) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.TT, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: isoTT(seconds) });

function build({ orbit, span, algorithm, initial, max, rel = toleranceFor(orbit), absM = 1e-9, events = [], forces = {} }) {
  const s0 = orbit.ref.state(0);
  const exec = execution({
    epochJD: EPOCH_JD, targetJD: EPOCH_JD + 1, position: s0.position, velocity: s0.velocity, epochTimeScale: 'TT',
    forces: { mu: MU, gravityMode: 'POINT_MASS', j2: false, centralBody: true, ...forces },
    integrator: { initialStep: initial, minStep: 1e-6, maxStep: max, relTolerance: rel, absTolerance: absM / 1000, maxSteps: 5_000_000 },
  });
  exec.INITIAL.STATE.EPOCH = EPOCH_ISO; exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = 'TT';
  exec.TARGET_EPOCH = ttInstant(exactSeconds(span));
  exec.INTEGRATOR.ALGORITHM = typeof algorithm === 'number' ? algorithm : sds.pcfIntegratorAlgorithm[algorithm];
  exec.INTEGRATOR.ABSOLUTE_TOLERANCES = Array(6).fill(absM);
  exec.INTEGRATOR.RELATIVE_TOLERANCE = rel;
  exec.EVENTS = events;
  return [{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }];
}
const spec = (kind, fields = {}) => makeTable('PCFEventDefinition', { KIND: sds.pcfEventKind[kind], DIRECTION: sds.pcfEventDirection.ANY, ACTION: sds.pcfEventAction.RECORD, ...fields });
const unit = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const vec3 = (v) => makeTable('FRMVector3', { X: v[0], Y: v[1], Z: v[2] });
// A reverse Polish program: [operation] or [operation, argument] terms.
const program = (terms) => makeTable('PCFExpression', { TERMS: terms.map(([op, argument]) => makeTable('PCFExpressionTerm', {
  OPERATION: sds.pcfExpressionOperation[op],
  ...(op === 'CONSTANT' ? { VALUE: argument } : {}), ...(op === 'PARAMETER' ? { PARAMETER: sds.pceParameter[argument] } : {}) })) });

const lanes = {};
async function lane(kind) {
  if (!lanes[kind]) lanes[kind] = await createStandaloneHarness(kind, WASM, { surface: kind === 'browser' ? 'direct' : 'command', enableThreads: true });
  return lanes[kind];
}
async function run(kind, inputs) {
  const h = await lane(kind);
  const response = await h.invoke({ methodId: 'invoke', inputs });
  if (response.statusCode !== 0) return { error: `${response.errorCode ?? ''}: ${response.errorMessage ?? ''}`, statusCode: response.statusCode };
  return { result: decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT };
}
const position = (sample) => { const p = sample.STATE.STATE.POSITION; return [p.X / 1000, p.Y / 1000, p.Z / 1000]; };
const distanceM = (a, b) => 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ----------------------------------------------------------------------------- closed-form epochs
// Every event of a Kepler orbit is a true anomaly: the perifocal angle nu from which the epoch
// follows. The exact epochs of a function after t = 0 are those anomalies, one orbit apart.
function expectedEpochs(orbit, nus, span) {
  const T = orbit.ref.period_s, out = [];
  for (const nu of nus) {
    let t = orbit.ref.timeOfTrueAnomaly(nu, 0);
    for (; t < span; t += T) out.push(t);
  }
  return out.sort((a, b) => a - b);
}
// Roots of f(exact state) in (0, span): a scan of the exact orbit for sign changes, each bisected.
function exactRoots(orbit, f, span) {
  const roots = [], n = Math.ceil(span / (orbit.ref.period_s / 100));
  let previous = f(orbit.ref.state(0)), tPrevious = 0;
  for (let k = 1; k <= n; k++) {
    const t = Math.min(span, k * span / n), value = f(orbit.ref.state(t));
    if (previous < 0 !== value < 0) {
      let lo = tPrevious, hi = t, fLo = previous;
      for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi), fm = f(orbit.ref.state(mid)); if (fm < 0 === fLo < 0) { lo = mid; fLo = fm; } else hi = mid; }
      roots.push(0.5 * (lo + hi));
    }
    previous = value; tPrevious = t;
  }
  return roots;
}
const wrap = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
function eventTable(orbit) {
  const P = orbit.ref.P, Q = orbit.ref.Q, w = orbit.argp;
  const normal = unit([0.3, -0.4, 0.8]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nu0 = Math.atan2(-dot(P, normal), dot(Q, normal));            // r . n = 0 in the orbit plane
  return [
    { name: 'periapsis', event: spec('APSIS', { DIRECTION: sds.pcfEventDirection.INCREASING }), nus: [0] },
    { name: 'apoapsis', event: spec('APSIS', { DIRECTION: sds.pcfEventDirection.DECREASING }), nus: [Math.PI] },
    { name: 'ascending node', event: spec('PLANE_CROSSING', { DIRECTION: sds.pcfEventDirection.INCREASING }), nus: [wrap(-w)] },
    { name: 'descending node', event: spec('PLANE_CROSSING', { DIRECTION: sds.pcfEventDirection.DECREASING }), nus: [wrap(Math.PI - w)] },
    { name: 'plane through the origin', event: spec('PLANE_CROSSING', { PLANE_NORMAL: vec3(normal) }), nus: [wrap(nu0), wrap(nu0 + Math.PI)] },
    { name: 'true anomaly 1.0', event: spec('TRUE_ANOMALY', { ANGLE_RAD: 1.0 }), nus: [1.0] },
    { name: 'argument of latitude 2.0', event: spec('ARGUMENT_OF_LATITUDE', { ANGLE_RAD: 2.0 }), nus: [wrap(2.0 - w)] },
    { name: 'latitude maximum', event: spec('LATITUDE_EXTREMUM', { DIRECTION: sds.pcfEventDirection.DECREASING }), nus: [wrap(Math.PI / 2 - w)] },
    { name: 'latitude minimum', event: spec('LATITUDE_EXTREMUM', { DIRECTION: sds.pcfEventDirection.INCREASING }), nus: [wrap(3 * Math.PI / 2 - w)] },
    // The x coordinate reaches 0.3 a: roots of the exact orbit, found by bisection on the 60-digit state.
    { name: 'expression: x equals 0.3 a', event: spec('EXPRESSION', { EXPRESSION: program([['PARAMETER', 'POSITION_X'], ['CONSTANT', 0.3 * orbit.a * 1000], ['SUBTRACT']]) }),
      exact: (state) => state.position[0] - 0.3 * orbit.a },
    // z / r = sin i sin(pi/4): the argument of latitude is pi/4 or 3 pi/4.
    { name: 'expression: z / r', event: spec('EXPRESSION', { EXPRESSION: program([['PARAMETER', 'POSITION_Z'], ['PARAMETER', 'POSITION_MAGNITUDE'], ['DIVIDE'], ['CONSTANT', Math.sin(orbit.i) * Math.sin(Math.PI / 4)], ['SUBTRACT']]) }),
      nus: [wrap(Math.PI / 4 - w), wrap(3 * Math.PI / 4 - w)] },
  ];
}

// ----------------------------------------------------------------------------- 1. event epochs
const summary = [];
const parity = new Map();
async function part1() {
  console.log('\n1. Event epochs inside every integrator (bar 1e-6 s, tolerance 1e-12, three step settings, eleven event functions)');
  for (const [name, , fixed] of ENGINE) {
    let worst = 0, spread = 0, events = 0;
    for (const [orbitName, orbit] of Object.entries(ORBITS)) {
      const span = 2.35 * orbit.ref.period_s;
      const table = eventTable(orbit);
      const expected = table.map((row) => row.exact ? exactRoots(orbit, row.exact, span) : expectedEpochs(orbit, row.nus, span));
      const settings = fixed ? orbit.steps.fixed.map((h) => [h, h]) : orbit.steps.adaptive;
      const found = [];
      for (const [initial, max] of settings) {
        const inputs = build({ orbit, span, algorithm: name, initial, max, rel: toleranceFor(orbit) * (TOLERANCE_FACTOR[name] ?? 1), events: table.map((row) => row.event) });
        const out = await run('browser', inputs);
        if (out.error) { check(false, `${name} ${orbitName}: ${out.error}`); continue; }
        const r = out.result;
        parity.set(`${name}|${orbitName}|${initial}`, { inputs, browser: r });
        const epochs = table.map((_, k) => r.EVENTS.filter((e) => e.EVENT_INDEX === k).map((e) => e.ELAPSED_SECONDS));
        found.push(epochs);
        table.forEach((row, k) => {
          check(epochs[k].length === expected[k].length, `${name} ${orbitName} ${row.name}: ${epochs[k].length} events, expected ${expected[k].length}`);
          epochs[k].forEach((t, j) => {
            const error = Math.abs(t - expected[k][j]);
            worst = Math.max(worst, error); events++;
            check(error < BAR_S, `${name} ${orbitName} ${row.name} #${j}: ${error.toExponential(2)} s`);
          });
        });
      }
      // The same epoch whatever the step.
      for (let k = 0; k < table.length; k++) for (let j = 0; j < (found[0]?.[k]?.length ?? 0); j++) {
        const values = found.map((f) => f[k][j]).filter((v) => v !== undefined);
        spread = Math.max(spread, Math.max(...values) - Math.min(...values));
      }
    }
    check(spread < BAR_S, `${name}: epochs move by ${spread.toExponential(2)} s with the step`);
    summary.push({ name, worst, spread, events });
    console.log(`  ${name.padEnd(8)} ${String(events).padStart(4)} events  worst error ${worst.toExponential(2)} s  step spread ${spread.toExponential(2)} s`);
  }
}

// ----------------------------------------------------------------------------- 2. accuracy
async function part2() {
  console.log('\n2. Accuracy over 10 orbits against the exact Kepler state, stage evaluations spent');
  const methods = [...ENGINE.map(([n, s, f]) => [n, s, f]), ...FIXED_STEP_ONLY.map(([n, s]) => [n, s, true])];
  const unique = methods.filter(([n]) => !['COWELL', 'RK78'].includes(n));   // aliases of RKF45 and RKF78
  for (const [orbitName, orbit] of Object.entries(ORBITS)) {
    const span = exactSeconds(10 * orbit.ref.period_s);
    const truth = orbit.ref.state(span);
    console.log(`  ${orbitName}: a = ${orbit.a} km, e = ${orbit.e}, 10 orbits = ${span.toFixed(0)} s`);
    for (const [name, stages, fixed] of unique) {
      const rows = [];
      for (const rel of fixed ? [null] : [1e-9, 1e-12]) {  // tolerances at the LEO radius
        const small = { ABM: 0.25, GAUSS_JACKSON_8: 0.5 }[name];
        const step = fixed ? (small ? small * (orbit.fixedMaxStep / 4) : orbit.steps.fixed[0]) : orbit.steps.adaptive[2][0];
        const inputs = build({ orbit, span, algorithm: name, initial: step, max: fixed ? step : orbit.steps.adaptive[2][1], rel: (rel ?? 1e-12) * REFERENCE_RADIUS_KM / orbit.a });
        const out = await run('browser', inputs);
        if (out.error) { rows.push(`${rel ?? 'fixed'}: ${out.error.slice(0, 70)}`); check(false, `${name} ${orbitName}: ${out.error}`); continue; }
        const sample = out.result.FINAL_SAMPLE;
        const error = distanceM(position(sample), truth.position);
        const evaluations = Number(sample.ACCEPTED_STEPS + sample.REJECTED_STEPS) * stages;
        rows.push(`${rel ? `tol ${rel}` : `step ${step} s`}: ${error.toExponential(2)} m, ${evaluations} evaluations`);
        if (rel === 1e-12 || fixed && !small) check(error < 10, `${name} ${orbitName}: ${error} m over 10 orbits`);
      }
      console.log(`    ${name.padEnd(16)} ${rows.join('   |   ')}`);
    }
  }
}

// ----------------------------------------------------------------------------- 3. actions
async function part3() {
  console.log('\n3. Actions and crossing directions');
  const orbit = ORBITS.E07, T = orbit.ref.period_s;
  const peri = (k) => orbit.ref.timeOfTrueAnomaly(0, 0) + k * T;
  // STOP at the second periapsis: the final sample is the event.
  let out = await run('browser', build({ orbit, span: 5 * T, algorithm: 'RKV98', initial: 30, max: 600,
    events: [spec('APSIS', { DIRECTION: sds.pcfEventDirection.INCREASING, ACTION: sds.pcfEventAction.STOP, OCCURRENCE: 2 })] }));
  const r = out.result;
  check(r.STOPPED_BY_EVENT === 0, 'STOP did not end the propagation');
  check(Math.abs(r.ELAPSED_SECONDS - peri(1)) < BAR_S, `STOP at ${r.ELAPSED_SECONDS}, expected ${peri(1)}`);
  const truth = orbit.ref.state(peri(1));
  check(distanceM(position(r.FINAL_SAMPLE), truth.position) < 0.01, 'the final sample is not the state at the event');
  check(r.EVENTS.length === 1 && r.EVENTS[0].EVENT_INDEX === 0, 'STOP is reported once');
  console.log(`  STOP at the 2nd periapsis: epoch error ${Math.abs(r.ELAPSED_SECONDS - peri(1)).toExponential(2)} s, state error ${distanceM(position(r.FINAL_SAMPLE), truth.position).toExponential(2)} m`);
  // CONTINUE counts without reporting; RECORD reports; the direction filter selects.
  out = await run('browser', build({ orbit, span: 3.5 * T, algorithm: 'DOPRI5', initial: 30, max: 300, events: [
    spec('APSIS', { ACTION: sds.pcfEventAction.CONTINUE }),
    spec('APSIS', { DIRECTION: sds.pcfEventDirection.DECREASING }),
    spec('APSIS', { DIRECTION: sds.pcfEventDirection.INCREASING }),
  ] }));
  const q = out.result;
  check(q.EVENT_OCCURRENCES.join() === '7,3,4', `occurrences ${q.EVENT_OCCURRENCES.join()}, expected 7,3,4`);
  check(!q.EVENTS.some((e) => e.EVENT_INDEX === 0), 'CONTINUE reported an event');
  check(q.EVENTS.filter((e) => e.EVENT_INDEX === 1).every((e) => e.DIRECTION === sds.pcfEventDirection.DECREASING), 'direction filter (decreasing)');
  check(q.EVENTS.filter((e) => e.EVENT_INDEX === 2).every((e) => e.DIRECTION === sds.pcfEventDirection.INCREASING), 'direction filter (increasing)');
  console.log(`  CONTINUE counted ${q.EVENT_OCCURRENCES[0]}, DECREASING ${q.EVENT_OCCURRENCES[1]}, INCREASING ${q.EVENT_OCCURRENCES[2]}`);
  // Backward propagation locates the same events.
  const backward = build({ orbit, span: -1.2 * T, algorithm: 'RKDP87', initial: 30, max: 300, events: [spec('APSIS', { DIRECTION: sds.pcfEventDirection.INCREASING })] });
  out = await run('browser', backward);
  if (out.error) check(false, `backward: ${out.error}`);
  else {
    const hits = out.result.EVENTS.map((e) => e.ELAPSED_SECONDS);
    const want = [peri(0) - T];
    check(hits.length === 1 && Math.abs(hits[0] - want[0]) < BAR_S, `backward periapsis ${hits} expected ${want}`);
    console.log(`  backward 1.2 orbits: periapsis at ${hits[0]} s, error ${Math.abs(hits[0] - want[0]).toExponential(2)} s`);
  }
}

// ----------------------------------------------------------------------------- 4. refusals
async function part4() {
  console.log('\n4. Refusals by name');
  const orbit = ORBITS.LEO, span = 600;
  const refused = async (label, inputs, pattern) => {
    const out = await run('browser', inputs);
    check(out.error !== undefined && pattern.test(out.error), `${label}: ${out.error ?? 'accepted'}`);
    console.log(`  ${label}: ${out.error ?? 'ACCEPTED'}`);
  };
  for (const name of ['ENCKE', 'EQUINOCTIAL_VOP', 'GAUSS_VOP'])
    await refused(`${name} selected`, build({ orbit, span, algorithm: name, initial: 10, max: 60 }), new RegExp(`${name} integrates a reduced force model`));
  await refused('DOPRI853 selected', build({ orbit, span, algorithm: 'DOPRI853', initial: 10, max: 60 }), /DOPRI853 \(Dormand-Prince 8\(5,3\)\) is not run by FFM/);
  for (const name of ['DROMO', 'STIEFEL'])
    await refused(`${name} selected`, build({ orbit, span, algorithm: name, initial: 10, max: 60 }), new RegExp(`${name} does not reach the requested epoch`));
  await refused('unknown ALGORITHM 200', build({ orbit, span, algorithm: 200, initial: 10, max: 60 }), /ALGORITHM 200 names no solver/);
  await refused('RKN1210 with drag', build({ orbit, span, algorithm: 'RKN1210', initial: 10, max: 60, forces: { drag: true, cd: 2.2, area: 10 } }), /depends on velocity/);
  await refused('events on ABM', build({ orbit, span, algorithm: 'ABM', initial: 1, max: 1, events: [spec('APSIS')] }), /no continuous extension/);
  await refused('events with an STM', (() => {
    const inputs = build({ orbit, span, algorithm: 'RKV98', initial: 10, max: 60, events: [spec('APSIS')] });
    const exec = decodePrw(inputs[0].payload).EXECUTION_REQUEST; exec.INCLUDE_STM = true;
    return [{ ...inputs[0], payload: encodePrw('EXECUTION_REQUEST', exec) }];
  })(), /plain state propagation/);
  await refused('expression that leaves two numbers', build({ orbit, span, algorithm: 'RKV98', initial: 10, max: 60, events: [spec('EXPRESSION', { EXPRESSION: program([['CONSTANT', 1], ['CONSTANT', 2]]) })] }), /leaves exactly one number/);
  await refused('expression naming a parameter it does not evaluate', build({ orbit, span, algorithm: 'RKV98', initial: 10, max: 60, events: [spec('EXPRESSION', { EXPRESSION: program([['PARAMETER', 'BETA_ANGLE']]) })] }), /BETA_ANGLE is not evaluated inside the integration/);
  await refused('unspecified event kind', build({ orbit, span, algorithm: 'RKV98', initial: 10, max: 60, events: [spec('UNSPECIFIED')] }), /not an event kind of this build/);
}


// ----------------------------------------------------------------------------- 5. Orekit
// The committed Orekit 13.1 reference (DormandPrince853, steps <= 10 s): LEO at 400 km, 24 h, point
// mass, the case the repo runs at tolerance 1e-15. The new pairs integrate the same request.
async function part5() {
  console.log('\n5. One LEO case against Orekit 13.1 DormandPrince853 (LEO400 point mass, 24 h, tolerance 1e-15)');
  const c = OREKIT.cases.find((x) => x.orbit === 'LEO400' && x.forces.startsWith('F0'));
  const bar = orekitBar(c);
  for (const name of ['RK78', 'RKDP87', 'DOPRI5', 'RK65', 'RKV98', 'RKN1210', 'BS']) {
    const inputs = orekitInputs(c, { tolerance: 1e-15, edit: (exec) => { exec.INTEGRATOR.ALGORITHM = sds.pcfIntegratorAlgorithm[name]; } });
    const response = await (await lane('browser')).invoke({ methodId: 'invoke', inputs });
    if (response.statusCode !== 0) { check(false, `${name} against Orekit: ${response.errorMessage}`); continue; }
    const { worst } = orekitScore(c, response);
    check(worst <= bar, `${name} differs from Orekit by ${worst} m (bar ${bar} m)`);
    console.log(`  ${name.padEnd(8)} largest 3D difference over the 24 h arc ${worst.toExponential(2)} m (bar ${bar} m)`);
  }
}

// ----------------------------------------------------------------------------- 7. eclipse
// Umbra and penumbra entry and exit located on the integrated state, against the sampled-ephemeris
// locator of propagator/events on a 10 s sample of the same dynamics. Both read the same DE440
// kernel, so the Sun is the same Sun.
const KERNEL = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const EVENTS_WASM = new URL('../../events/dist/isomorphic/module.wasm', import.meta.url);
const ECLIPSE_BASE_TT = '2026-08-02T00:01:09.184000000';       // 2026-08-02T00:00:00 UTC
const ECLIPSE_BASE_UTC = Date.UTC(2026, 7, 2, 0, 0, 0);
const ttAt = (seconds) => {                                    // TT label of base + seconds (< 1 day)
  const nanos = Math.round((69.184 + seconds) * 1e9), total = Math.floor(nanos / 1e9), frac = nanos - total * 1e9;
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  return `2026-08-02T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(frac).padStart(9, '0')}`;
};
const utcAt = (seconds) => new Date(ECLIPSE_BASE_UTC + seconds * 1000).toISOString().replace('Z', '');
async function part7() {
  console.log('\n7. Eclipse: located on the integrated state against propagator/events on a 10 s sample');
  const { NCD } = await import('spacedatastandards.org/lib/js/NCD/NCD.js');
  const { EVL, EVLT, EVLEventLocationRequestT, EVLEclipseConfigurationT } = await import('spacedatastandards.org/lib/js/EVL/main.js');
  const { PCEEvaluationContextT } = await import('spacedatastandards.org/lib/js/PCE/main.js');
  const { RFMT, CelestialFrameWrapperT } = await import('spacedatastandards.org/lib/js/RFM/main.js');
  const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await import('spacedatastandards.org/lib/js/OEM/main.js');
  const { nativeInput } = await import('./lib/prwCodec.mjs');
  const orbit = { ...ORBITS.LEO, raan: 2.0, i: 0.9006 };
  orbit.ref = keplerOrbit({ ...orbit, mu: MU });
  const span = 10 * Math.floor(2 * orbit.ref.period_s / 10);       // the samples cover [0, span]
  const kernelInput = { portId: 'kernel', typeRef: TYPE, payload: nativeInput(KERNEL) };
  const withKernel = (inputs) => [...inputs, kernelInput];
  const make = (events, samples) => {
    const s0 = orbit.ref.state(0);
    const exec = execution({ epochJD: EPOCH_JD, targetJD: EPOCH_JD + 1, position: s0.position, velocity: s0.velocity, epochTimeScale: 'TT',
      forces: { mu: MU, gravityMode: 'POINT_MASS', j2: false, centralBody: true },
      integrator: { initialStep: 10, minStep: 1e-6, maxStep: 60, relTolerance: 1e-12, absTolerance: 1e-12, maxSteps: 5_000_000 } }, true);
    exec.INITIAL.STATE.EPOCH = ECLIPSE_BASE_TT; exec.INITIAL.STATE.EPOCH_TIME_SYSTEM = 'TT';
    exec.INTEGRATOR.ALGORITHM = sds.pcfIntegratorAlgorithm.RKDP87;
    exec.INTEGRATOR.ABSOLUTE_TOLERANCES = Array(6).fill(1e-9);
    const tt = (seconds) => makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.TT, EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: ttAt(seconds) });
    exec.TARGET_EPOCH = tt(span);
    exec.EVENTS = events;
    if (samples) exec.SAMPLE_EPOCHS = Array.from({ length: Math.floor(span / 10) + 1 }, (_, k) => tt(10 * k));
    return withKernel([{ portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) }]);
  };
  const located = (await run('browser', make([spec('UMBRA'), spec('PENUMBRA')], false)));
  if (located.error) { check(false, `eclipse events: ${located.error}`); return; }
  const sampled = (await run('browser', make([], true)));
  if (sampled.error) { check(false, `eclipse samples: ${sampled.error}`); return; }
  const ffm = (k) => located.result.EVENTS.filter((e) => e.EVENT_INDEX === k).map((e) => ({ t: e.ELAPSED_SECONDS, entry: e.DIRECTION === sds.pcfEventDirection.DECREASING }));
  // The 10 s sample of the same dynamics as an $OEM (kilometers, UTC, GCRF).
  const builder = new flatbuffers.Builder(1 << 22);
  const block = new ephemerisDataBlockT();
  block.TIME_SYSTEM = 11; block.REFERENCE_FRAME = new RFMT(1, new CelestialFrameWrapperT(1)); block.CENTER_NAIF_ID = 399;
  block.EPHEMERIS_DATA_LINES = [];
  const line = (t, p, v) => { const row = new ephemerisDataLineT(); Object.assign(row, { EPOCH: utcAt(t), X: p[0], Y: p[1], Z: p[2], X_DOT: v[0], Y_DOT: v[1], Z_DOT: v[2] }); block.EPHEMERIS_DATA_LINES.push(row); };
  sampled.result.SAMPLES.forEach((sample, k) => {          // SAMPLES[k] is the state at 10 k seconds
    const p = sample.STATE.STATE.POSITION, v = sample.STATE.STATE.VELOCITY;
    line(10 * k, [p.X / 1000, p.Y / 1000, p.Z / 1000], [v.X / 1000, v.Y / 1000, v.Z / 1000]);
  });
  const oem = new OEMT(); oem.EPHEMERIS_DATA_BLOCK = [block];
  OEM.finishOEMBuffer(builder, oem.pack(builder));
  const ephemeris = builder.asUint8Array().slice();
  const kernelFrame = (() => {
    const b = new flatbuffers.Builder(1024);
    const sha = b.createString(createHash('sha256').update(KERNEL).digest('hex'));
    NCD.startNCD(b); NCD.addFormat(b, 1); NCD.addSourceByteLength(b, BigInt(KERNEL.length)); NCD.addSourceSha256(b, sha);
    NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
    return Buffer.concat([b.asUint8Array(), KERNEL]);
  })();
  const eventsHarness = await createStandaloneHarness('browser', EVENTS_WASM, { surface: 'direct', enableThreads: true });
  const type = (family) => ({ schemaName: `${family}.fbs`, fileIdentifier: `$${family}`, rootTypeName: family });
  const sampledEvents = async (region) => {
    const b = new flatbuffers.Builder(1024);
    const request = new EVLEventLocationRequestT();
    request.LOCATOR_CLASS = 1; request.CONTEXT = new PCEEvaluationContextT(); request.CONTEXT.CENTRAL_BODY_ID = 399;
    request.SCAN_START_EPOCH = utcAt(0); request.SCAN_STOP_EPOCH = utcAt(span); request.EPOCH_TIME_SYSTEM = 'UTC';
    request.SCAN_STEP_SECONDS = 30; request.REFINEMENT_TOLERANCE_SECONDS = 1e-6;
    request.ECLIPSE_CONFIGURATION = new EVLEclipseConfigurationT();
    Object.assign(request.ECLIPSE_CONFIGURATION, { OCCULTING_BODY_IDS: [399], ILLUMINATING_BODY_ID: 10, REPORT_UMBRA: region === 'UMBRA', REPORT_PENUMBRA: region === 'PENUMBRA', REPORT_ANTUMBRA: false });
    const evl = new EVLT(); evl.LOCATION_REQUEST = request;
    EVL.finishEVLBuffer(b, evl.pack(b));
    const response = await eventsHarness.invoke({ methodId: 'locate_events', inputs: [
      { portId: 'request', typeRef: type('EVL'), payload: b.asUint8Array().slice() },
      { portId: 'ephemeris', typeRef: type('OEM'), payload: ephemeris },
      { portId: 'kernel', typeRef: type('NCD'), payload: kernelFrame }] });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    const report = EVL.getRootAsEVL(new flatbuffers.ByteBuffer(response.outputs.find((o) => o.portId === 'report').payload)).unpack().EVENT_REPORT;
    if (report.STATUS !== 1) throw new Error(`EVL status ${report.STATUS}: ${report.ERROR_MESSAGE}`);
    const seconds = (iso) => (Date.parse(`${iso}Z`) - ECLIPSE_BASE_UTC) / 1000;
    return report.EVENTS.flatMap((e) => [{ t: seconds(e.START_EPOCH), entry: true }, ...(e.STOP_EPOCH ? [{ t: seconds(e.STOP_EPOCH), entry: false }] : [])]);
  };
  for (const [k, region] of [[0, 'UMBRA'], [1, 'PENUMBRA']]) {
    const mine = ffm(k), theirs = await sampledEvents(region);
    check(mine.length > 0 && mine.length === theirs.length, `${region}: ${mine.length} events inside the integrator, ${theirs.length} on the sample`);
    let worst = 0;
    mine.forEach((m, j) => { if (theirs[j]) { check(m.entry === theirs[j].entry, `${region} #${j}: entry and exit disagree`); worst = Math.max(worst, Math.abs(m.t - theirs[j].t)); } });
    check(worst < 1e-3, `${region}: epochs differ by ${worst} s`);
    console.log(`  ${region.padEnd(9)} ${mine.length} boundaries (entry and exit), worst difference ${worst.toExponential(2)} s (bar 1e-3 s); first entry at ${mine[0]?.t.toFixed(3)} s`);
  }
  await eventsHarness.destroy?.();
}

// ----------------------------------------------------------------------------- 8. closest approach
// The second trajectory is the same Kepler orbit 600 s later: by symmetry about the apse line the range
// between them is least at apoapsis + 300 s and greatest at periapsis + 300 s (every orbit), exact epochs.
async function part8() {
  console.log('\n8. Closest approach to a second trajectory ($OEM on the second_trajectory port)');
  const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await import('spacedatastandards.org/lib/js/OEM/main.js');
  const orbit = ORBITS.E07, T = orbit.ref.period_s, shift = 600, span = 2.4 * T, SPACING = 5;
  const builder = new flatbuffers.Builder(1 << 22);
  const block = new ephemerisDataBlockT();
  block.TIME_SYSTEM = sds.timingStandard.TT; block.EPHEMERIS_DATA_LINES = [];
  for (let t = 0; t <= span + SPACING; t += SPACING) {
    const { position, velocity } = orbit.ref.state(t - shift);
    const row = new ephemerisDataLineT();
    Object.assign(row, { EPOCH: isoTT(t), X: position[0], Y: position[1], Z: position[2], X_DOT: velocity[0], Y_DOT: velocity[1], Z_DOT: velocity[2] });
    block.EPHEMERIS_DATA_LINES.push(row);
  }
  const message = new OEMT(); message.EPHEMERIS_DATA_BLOCK = [block];
  OEM.finishOEMBuffer(builder, message.pack(builder));
  const second = { portId: 'second_trajectory', typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' }, payload: builder.asUint8Array().slice() };
  const approach = (direction) => spec('CLOSEST_APPROACH', { DIRECTION: direction, SECOND_TRAJECTORY_PORT: 'second_trajectory' });
  const inputs = [...build({ orbit, span, algorithm: 'RKV98', initial: 30, max: 600, rel: toleranceFor(orbit),
    events: [approach(sds.pcfEventDirection.INCREASING), approach(sds.pcfEventDirection.DECREASING)] }), second];
  const each = (k) => { const out = []; for (let t = k; t < span; t += T) out.push(t); return out; };
  const nearest = orbit.ref.timeOfTrueAnomaly(Math.PI, 0) + shift / 2, farthest = orbit.ref.timeOfTrueAnomaly(0, 0) + shift / 2;
  const expected = [each(nearest), each(farthest)];
  let reference = null;
  for (const kind of ['browser', 'wasmedge']) {
    const out = await run(kind, inputs);
    if (out.error) { check(false, `closest approach on ${kind}: ${out.error}`); continue; }
    const found = [0, 1].map((k) => out.result.EVENTS.filter((e) => e.EVENT_INDEX === k).map((e) => e.ELAPSED_SECONDS));
    [0, 1].forEach((k) => {
      check(found[k].length === expected[k].length, `closest approach #${k}: ${found[k].length} events, expected ${expected[k].length}`);
      found[k].forEach((t, j) => check(Math.abs(t - expected[k][j]) < BAR_S, `closest approach #${k}.${j}: ${Math.abs(t - expected[k][j]).toExponential(2)} s`));
    });
    const worst = Math.max(...[0, 1].flatMap((k) => found[k].map((t, j) => Math.abs(t - expected[k][j]))));
    console.log(`  ${kind.padEnd(8)} minimum range at apoapsis + 300 s and maximum at periapsis + 300 s: worst epoch error ${worst.toExponential(2)} s`);
    if (reference) check(JSON.stringify(found) === JSON.stringify(reference), 'closest approach differs between lanes');
    reference = reference ?? found;
  }
  const refused = await run('browser', build({ orbit, span, algorithm: 'RKV98', initial: 30, max: 600, events: [approach(sds.pcfEventDirection.ANY)] }));
  check(refused.error && /missing-second-trajectory/.test(refused.error), `no second trajectory: ${refused.error ?? 'accepted'}`);
  console.log(`  without the input: ${refused.error}`);
}

// ----------------------------------------------------------------------------- 6. parity
async function part6() {
  console.log('\n6. Lane parity: browser and native WasmEdge give the same bits');
  let compared = 0;
  for (const [key, { inputs, browser }] of parity) {
    if (!/\|(1|10|100|2)$/.test(key) && compared >= 24) continue;
    const out = await run('wasmedge', inputs);
    if (out.error) { check(false, `${key} on WasmEdge: ${out.error}`); continue; }
    const same = JSON.stringify(out.result.EVENTS.map((e) => [e.ELAPSED_SECONDS, e.STATE.STATE.POSITION.X, e.STATE.STATE.POSITION.Y, e.STATE.STATE.POSITION.Z])) ===
      JSON.stringify(browser.EVENTS.map((e) => [e.ELAPSED_SECONDS, e.STATE.STATE.POSITION.X, e.STATE.STATE.POSITION.Y, e.STATE.STATE.POSITION.Z])) &&
      JSON.stringify(position(out.result.FINAL_SAMPLE)) === JSON.stringify(position(browser.FINAL_SAMPLE));
    check(same, `${key}: browser and WasmEdge differ`);
    compared++;
  }
  console.log(`  ${compared} requests compared; Docker leg waived by the owner (2026-10-22)`);
}

const only = process.argv.slice(2);
const wanted = (n) => only.length === 0 || only.includes(n);
if (wanted('1')) await part1();
if (wanted('2')) await part2();
if (wanted('3')) await part3();
if (wanted('4')) await part4();
if (wanted('5')) await part5();
if (wanted('7')) await part7();
if (wanted('8')) await part8();
if (wanted('6')) await part6();
for (const h of Object.values(lanes)) await h.destroy?.();
console.log(failures.length ? `\nFAIL ${failures.length} checks` : '\nPASS integrator-events');
process.exit(failures.length ? 1 : 0);
