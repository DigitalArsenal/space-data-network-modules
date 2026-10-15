import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { openHarness, orbit, sds, solve, state, system, t } from "./lib/tbp.mjs";

// The typed answers against the JSON-era module (0.1.0): tests/fixtures/legacy-json-outputs.json holds the requests
// and responses of the legacy artifact, captured before the conversion. Units on the $TBP wire are the standard's
// (km, km/s, deg); the core works in m, m/s, rad, so the expected values are the legacy ones scaled the same way.
//
// Counts, flags and lengths are compared exactly. Floating-point values are compared to TOLERANCE (relative, floor
// 1): the legacy artifact was built by emsdk 6.0.1 with -O3 -flto -ffast-math, a floating-point model whose
// last-bit results depend on that compiler's reassociation and inlining. The SDK compiler builds the same core
// source strictly (IEEE, no fast-math; clang ignores '#pragma float_control' on wasm), so values differ from the
// legacy ones in the last bits (worst seen 3.7e-12 relative, along the one-period halo trajectories; printed after the run). The wire itself loses nothing:
// every double travels as an IEEE double.
const LEGACY = JSON.parse(fs.readFileSync(new URL("./fixtures/legacy-json-outputs.json", import.meta.url), "utf8"));
const { tbpProblem, tbpStatus, tbpOrbitFamily, tbpTransferKind, tbpConversionDirection, rfmLibrationPoint } = sds;

const wireSystem = (s) =>
  system({
    NAME: s.name,
    MASS_RATIO: s.mu,
    PRIMARY_MASS_KG: s.m1,
    SECONDARY_MASS_KG: s.m2,
    CHARACTERISTIC_LENGTH_KM: s.l_star / 1000,
    CHARACTERISTIC_TIME_S: s.t_star,
  });
const muOnly = (mu) => system({ MASS_RATIO: mu });
const stateOf = (o) => [o.x, o.y, o.z, o.vx, o.vy, o.vz];
const wireStateOf = (s) => [s.X, s.Y, s.Z, s.VX, s.VY, s.VZ];
const km = (values) => values.map((v) => v / 1000);
const TOLERANCE = 1e-9;
let worst = 0;
function near(actual, expected, label) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label} length`);
    expected.forEach((e, i) => near(actual[i], e, `${label}[${i}]`));
    return;
  }
  const relative = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
  worst = Math.max(worst, relative);
  assert.ok(relative <= TOLERANCE, `${label}: ${actual} vs legacy ${expected} (relative ${relative})`);
}
test.after(() => console.log(`# worst relative difference from the legacy artifact: ${worst.toExponential(3)}`));
const solved = (answer) => assert.equal(answer.STATUS, tbpStatus.Solved, `${answer.ERROR_CODE} ${answer.ERROR_MESSAGE}`);

test("LibrationPoints and JacobiConstant equal the legacy answers", async (tc) => {
  const h = await openHarness(tc);
  const lagrange = LEGACY.lagrange;
  const points = await solve(h, { PROBLEM: tbpProblem.LibrationPoints, SYSTEM: muOnly(lagrange.request.params.mu) });
  solved(points);
  assert.equal(points.LIBRATION_POINTS.length, 5);
  lagrange.response.forEach((legacy, i) => {
    const p = points.LIBRATION_POINTS[i];
    assert.equal(p.POINT, rfmLibrationPoint[legacy.point], "rfmLibrationPoint L1 = 1 (the module's L1 was 0)");
    near([p.X, p.Y, p.Z], legacy.position, `L${i + 1} position`);
    near(p.JACOBI, legacy.jacobi, `L${i + 1} jacobi`);
  });

  const jacobi = LEGACY.jacobi;
  const answer = await solve(h, { PROBLEM: tbpProblem.JacobiConstant, SYSTEM: muOnly(jacobi.request.params.mu), STATE: state(jacobi.request.params.state) });
  solved(answer);
  near(answer.JACOBI, jacobi.response.jacobi, "jacobi");
});

test("HaloFirstGuess equals the legacy Richardson guesses", async (tc) => {
  const h = await openHarness(tc);
  for (const key of ["haloGuessNorth", "haloGuessSouth"]) {
    const { request, response } = LEGACY[key];
    const answer = await solve(h, {
      PROBLEM: tbpProblem.HaloFirstGuess,
      SYSTEM: muOnly(request.params.mu),
      ORBITS: [orbit({ FAMILY: request.params.northern ? tbpOrbitFamily.HaloNorthern : tbpOrbitFamily.HaloSouthern, LIBRATION_POINT: request.params.point + 1, AMPLITUDE: request.params.Az })],
    });
    solved(answer);
    const [guess] = answer.ORBITS;
    assert.equal(guess.CORRECTED, false);
    near(wireStateOf(guess.INITIAL_STATE), stateOf(response), key);
  }
});

test("Propagation equals the legacy trajectory sample for sample", async (tc) => {
  const h = await openHarness(tc);
  const { request, response } = LEGACY.propagate;
  const o = request.params.options;
  const answer = await solve(h, {
    PROBLEM: tbpProblem.Propagation,
    SYSTEM: muOnly(request.params.mu),
    PROPAGATION: t.propagation({ INITIAL_STATE: state(stateOf(request.params.state)), DURATION: o.duration, STEP: o.stepSize, OUTPUT_POINTS: o.outputPoints }),
  });
  solved(answer);
  near(answer.TRAJECTORY.JACOBI, response.jacobi, "jacobi");
  near(answer.TRAJECTORY.TIMES, response.times, "times");
  near(answer.TRAJECTORY.STATES, response.states.flat(), "states");
  assert.equal(answer.TRAJECTORY.STATE_TRANSITION.length, 0, "no STM unless asked");
});

test("PeriodicOrbit (the JPL halo queries) and NearRectilinearHalo equal the legacy corrections", async (tc) => {
  const h = await openHarness(tc);
  for (const key of Object.keys(LEGACY).filter((k) => /^halo\d+$/.test(k))) {
    const { request, response } = LEGACY[key];
    const c = request.params.config;
    const answer = await solve(h, {
      PROBLEM: tbpProblem.PeriodicOrbit,
      SYSTEM: wireSystem(request.params.system),
      ORBITS: [orbit({ FAMILY: tbpOrbitFamily.HaloNorthern, LIBRATION_POINT: c.point + 1, AMPLITUDE: c.amplitude, TOLERANCE: c.tolerance, MAX_ITERATIONS: c.maxIterations })],
    });
    solved(answer);
    const [o] = answer.ORBITS;
    assert.equal(o.CONVERGED, response.converged);
    assert.equal(o.ITERATIONS, response.iterations);
    near(o.PERIOD, response.period, `${key} period`);
    near(o.JACOBI, response.jacobi, `${key} jacobi`);
    near(wireStateOf(o.INITIAL_STATE), stateOf(response.initialState), `${key} initial state`);
    near(o.TRAJECTORY.STATES, response.trajectory.flat(), `${key} one-period trajectory`);
    assert.equal(o.PERIOD_S, o.PERIOD * request.params.system.t_star);
  }

  const { request, response } = LEGACY.nrho;
  const c = request.params.config;
  const answer = await solve(h, {
    PROBLEM: tbpProblem.NearRectilinearHalo,
    SYSTEM: wireSystem(request.params.system),
    ORBITS: [orbit({ LIBRATION_POINT: c.point + 1, PERILUNE_ALTITUDE_KM: c.perilune_km, APOLUNE_ALTITUDE_KM: c.apolune_km, TOLERANCE: c.tolerance, MAX_ITERATIONS: c.maxIterations })],
  });
  const [o] = answer.ORBITS;
  assert.equal(o.CONVERGED, response.converged);
  assert.equal(answer.STATUS, response.converged ? tbpStatus.Solved : tbpStatus.NotConverged);
  assert.equal(o.FAMILY, tbpOrbitFamily.NearRectilinearHalo);
  near(o.PERIOD, response.period, "nrho period");
  near(o.JACOBI, response.jacobi, "nrho jacobi");
  near(wireStateOf(o.INITIAL_STATE), stateOf(response.initialState), "nrho initial state");
});

test("Transfer burns, total and time of flight equal the legacy answers (m/s -> km/s)", async (tc) => {
  const h = await openHarness(tc);
  for (const [key, kind, inclinationDeg] of [["transferLowEnergy", tbpTransferKind.LowEnergy, 0], ["transferFreeReturn", tbpTransferKind.FreeReturn, 30]]) {
    const { request, response } = LEGACY[key];
    const c = request.params.config;
    assert.equal(inclinationDeg * 0.017453292519943295, c.inclination);
    const answer = await solve(h, {
      PROBLEM: tbpProblem.Transfer,
      SYSTEM: wireSystem(request.params.system),
      TRANSFER: t.transfer({ KIND: kind, PARKING_ALTITUDE_KM: c.parkingAlt / 1000, TARGET_ALTITUDE_KM: c.targetAlt / 1000, INCLINATION_DEG: inclinationDeg }),
    });
    solved(answer);
    const tr = answer.TRANSFER;
    assert.equal(tr.KIND, kind);
    assert.equal(tr.CONVERGED, response.converged);
    near(tr.TOTAL_DELTA_V_KM_S, response.dvTotal / 1000, `${key} total`);
    near(tr.TIME_OF_FLIGHT_S, response.tof, `${key} tof`);
    assert.deepEqual(tr.BURNS.map((b) => b.NAME), ["departure", "arrival"]);
    near(tr.BURNS[0].DELTA_V, km(response.dvDepart), `${key} departure`);
    near(tr.BURNS[1].DELTA_V, km(response.dvArrive), `${key} arrival`);
    assert.equal(tr.BURNS[0].AXES, sds.mplAxes.Inertial);
    assert.equal(tr.BURNS[1].OFFSET_S, tr.TIME_OF_FLIGHT_S);
  }
});

test("StationKeeping budget equals the legacy answer (m/s -> km/s)", async (tc) => {
  const h = await openHarness(tc);
  const { request, response } = LEGACY.stationKeeping;
  const p = request.params;
  const answer = await solve(h, {
    PROBLEM: tbpProblem.StationKeeping,
    SYSTEM: muOnly(p.mu),
    STATION_KEEPING: t.stationKeeping({
      ORBIT: orbit({ INITIAL_STATE: state(stateOf(p.orbit.initialState)), PERIOD: p.orbit.period, JACOBI: p.orbit.jacobi }),
      NAVIGATION_ERROR_KM: p.config.navError,
      EXECUTION_ERROR_FRACTION: p.config.maneuverError,
      CYCLES: p.config.numCycles,
    }),
  });
  solved(answer);
  const sk = answer.STATION_KEEPING;
  near(sk.ANNUAL_DELTA_V_KM_S, response.annualDV / 1000, "annual");
  near(sk.MEAN_CYCLE_DELTA_V_KM_S, response.meanCycleDV / 1000, "mean");
  near(sk.MAX_CYCLE_DELTA_V_KM_S, response.maxCycleDV / 1000, "max");
  near(sk.CYCLE_DELTA_V_KM_S, km(response.cycleDVs), "cycles");
  assert.equal(sk.BOUNDED, response.stable);
});

test("FrameConversion equals the legacy coordinate transforms (m -> km)", async (tc) => {
  const h = await openHarness(tc);
  const toInertial = LEGACY.toInertial;
  const p = toInertial.request.params;
  const a = await solve(h, {
    PROBLEM: tbpProblem.FrameConversion,
    SYSTEM: wireSystem(p.system),
    FRAME_CONVERSION: t.frameConversion({ DIRECTION: tbpConversionDirection.SynodicToInertial, ELAPSED_S: p.epoch_s, SYNODIC: state(stateOf(p.state)) }),
  });
  solved(a);
  near(a.FRAME_CONVERSION.INERTIAL, km(toInertial.response), "inertial");

  const toSynodic = LEGACY.toSynodic;
  const q = toSynodic.request.params;
  const b = await solve(h, {
    PROBLEM: tbpProblem.FrameConversion,
    SYSTEM: wireSystem(q.system),
    FRAME_CONVERSION: t.frameConversion({ DIRECTION: tbpConversionDirection.InertialToSynodic, ELAPSED_S: q.epoch_s, INERTIAL: km(toInertial.response) }),
  });
  solved(b);
  near(wireStateOf(b.FRAME_CONVERSION.SYNODIC), stateOf(toSynodic.response), "synodic");
});
