import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { openHarness, orbit, requestFrame, sds, solve, state, system, t, TBP_TYPE } from "./lib/tbp.mjs";

// End-to-end behaviour of the $TBP surface on the built artifact (SDK browser harness, direct and command surfaces).
const { tbpProblem, tbpStatus, tbpOrbitFamily, tbpConversionDirection, rfmLibrationPoint } = sds;
const MU = 0.0121505856;
const EARTH_MOON = system({
  NAME: "Earth-Moon",
  PRIMARY_BODY_ID: 399,
  SECONDARY_BODY_ID: 301,
  MASS_RATIO: MU,
  PRIMARY_MASS_KG: 5.972e24,
  SECONDARY_MASS_KG: 7.348e22,
  CHARACTERISTIC_LENGTH_KM: 384_400,
  CHARACTERISTIC_TIME_S: 375_190.25852,
});
const HALO_AUTHORITIES = JSON.parse(fs.readFileSync(new URL("../vectors/jpl-halo-authority.json", import.meta.url), "utf8"));

function jacobiConstant([x, y, z, vx, vy, vz], mu) {
  const r1 = Math.sqrt((x + mu) ** 2 + y * y + z * z);
  const r2 = Math.sqrt((x - 1 + mu) ** 2 + y * y + z * z);
  return 2 * ((1 - mu) / r1 + mu / r2 + 0.5 * (x * x + y * y)) - (vx * vx + vy * vy + vz * vz);
}
const sixAt = (flat, i) => flat.slice(i * 6, i * 6 + 6);

for (const surface of ["direct", "command"]) {
  test(`Earth-Moon libration points keep textbook geometry and stability (${surface})`, async (tc) => {
    const h = await openHarness(tc, surface);
    const answer = await solve(h, { ID: "lp-1", PROBLEM: tbpProblem.LibrationPoints, SYSTEM: EARTH_MOON });
    assert.equal(answer.STATUS, tbpStatus.Solved);
    assert.equal(answer.ID, "lp-1");
    assert.equal(answer.PRODUCER, "cislunar-propagator");
    assert.equal(answer.PROBLEM, tbpProblem.LibrationPoints);
    assert.equal(answer.SYSTEM.NAME, "Earth-Moon");
    assert.equal(answer.SYSTEM.SECONDARY_BODY_ID, 301);
    const [l1, l2, l3, l4, l5] = answer.LIBRATION_POINTS;
    assert.deepEqual(answer.LIBRATION_POINTS.map((p) => p.POINT), [1, 2, 3, 4, 5].map((n) => rfmLibrationPoint[`L${n}`]));
    assert.ok(Math.abs(l1.X - 0.8369151258197124) < 1e-9);
    assert.ok(l2.X > 1 && l3.X < -1);
    assert.ok(Math.abs(l4.X - (0.5 - MU)) < 1e-12 && Math.abs(l4.Y - Math.sqrt(3) / 2) < 1e-12);
    assert.ok(Math.abs(l5.Y + Math.sqrt(3) / 2) < 1e-12);
    assert.ok(Math.abs(l4.JACOBI - l5.JACOBI) < 1e-12);
    // Collinear points: one real saddle pair (+-lambda) and two centres; L4/L5 (mu below Routh's value): centres only.
    for (const p of [l1, l2, l3]) {
      assert.equal(p.STABLE, false);
      const real = p.EIGENVALUES_REAL.filter((v) => Math.abs(v) > 1e-6).sort((a, b) => a - b);
      assert.equal(real.length, 2);
      assert.ok(Math.abs(real[0] + real[1]) < 1e-9, "the saddle pair is +-lambda");
    }
    assert.ok(Math.abs(l1.EIGENVALUES_REAL.reduce((m, v) => Math.max(m, Math.abs(v)), 0) - 2.932) < 1e-3, "Earth-Moon L1 saddle rate ~2.932");
    for (const p of [l4, l5]) {
      assert.equal(p.STABLE, true);
      assert.ok(p.EIGENVALUES_REAL.every((v) => Math.abs(v) < 1e-9), "L4/L5 eigenvalues are imaginary");
    }
  });
}

test("JPL halo periods and Jacobi constants; monodromy and Floquet multipliers of the corrected orbit", async (tc) => {
  const h = await openHarness(tc);
  assert.equal(HALO_AUTHORITIES.authority, "NASA/JPL Three-Body Periodic Orbits API");
  let worstJacobi = 0;
  let worstPeriod = 0;
  for (const authority of HALO_AUTHORITIES.queries) {
    const answer = await solve(h, {
      PROBLEM: tbpProblem.PeriodicOrbit,
      SYSTEM: system({ ...EARTH_MOON, MASS_RATIO: HALO_AUTHORITIES.massRatio }),
      ORBITS: [orbit({ FAMILY: tbpOrbitFamily.HaloNorthern, LIBRATION_POINT: authority.librationPoint, AMPLITUDE: authority.moduleAmplitude, TOLERANCE: 1e-10, MAX_ITERATIONS: 100 })],
    });
    assert.equal(answer.STATUS, tbpStatus.Solved);
    const [o] = answer.ORBITS;
    assert.equal(o.CONVERGED, true);
    assert.equal(o.CORRECTED, true);
    assert.equal(o.LIBRATION_POINT, authority.librationPoint);
    worstJacobi = Math.max(worstJacobi, Math.abs(o.JACOBI - authority.record.jacobi) / Math.abs(authority.record.jacobi));
    worstPeriod = Math.max(worstPeriod, Math.abs(o.PERIOD - authority.record.period) / Math.abs(authority.record.period));
    assert.equal(o.MONODROMY.length, 36);
    assert.equal(o.FLOQUET_REAL.length, 6);
    const moduli = o.FLOQUET_REAL.map((re, i) => Math.hypot(re, o.FLOQUET_IMAGINARY[i])).sort((a, b) => a - b);
    // A periodic orbit of a Hamiltonian system: a pair at 1, the rest in reciprocal pairs; halo orbits about the
    // Earth-Moon L1/L2 are unstable (one large multiplier).
    assert.ok(Math.abs(moduli.reduce((p, m) => p * m, 1) - 1) < 1e-4, `multipliers ${moduli}`);
    assert.ok(moduli.filter((m) => Math.abs(m - 1) < 1e-3).length >= 2, `a pair of unit multipliers ${moduli}`);
    assert.ok(o.STABILITY_INDEX > 1 && o.STABLE === false);
    assert.equal(o.TRAJECTORY.STATES.length, o.TRAJECTORY.TIMES.length * 6);
    const last = sixAt(o.TRAJECTORY.STATES, o.TRAJECTORY.TIMES.length - 1);
    const first = [o.INITIAL_STATE.X, o.INITIAL_STATE.Y, o.INITIAL_STATE.Z, o.INITIAL_STATE.VX, o.INITIAL_STATE.VY, o.INITIAL_STATE.VZ];
    assert.ok(Math.hypot(...last.slice(0, 3).map((v, i) => v - first[i])) < 1e-3, "one period closes on itself");
  }
  assert.ok(worstJacobi <= 1e-4 && worstPeriod <= 1e-4, `JPL jacobi ${worstJacobi} period ${worstPeriod}`);
  tc.diagnostic(`JPL halo worst_jacobi_relative=${worstJacobi.toExponential(6)} worst_period_relative=${worstPeriod.toExponential(6)}`);
});

test("Propagation conserves the Jacobi constant and carries the state transition matrix when asked", async (tc) => {
  const h = await openHarness(tc);
  const request = (stm) => ({
    PROBLEM: tbpProblem.Propagation,
    SYSTEM: EARTH_MOON,
    PROPAGATION: t.propagation({ INITIAL_STATE: state([0.8, 0, 0, 0, 0.1, 0]), DURATION: 0.05, STEP: 0.001, OUTPUT_POINTS: 51, STATE_TRANSITION: stm }),
  });
  const plain = (await solve(h, request(false))).TRAJECTORY;
  const withStm = (await solve(h, request(true))).TRAJECTORY;
  const n = plain.TIMES.length;
  assert.equal(n, 51);
  const j0 = jacobiConstant(sixAt(plain.STATES, 0), MU);
  assert.ok(Math.abs(plain.JACOBI - j0) < 1e-12);
  assert.ok(Math.abs(jacobiConstant(sixAt(plain.STATES, n - 1), MU) - j0) < 1e-5);
  assert.deepEqual(withStm.STATES, plain.STATES, "asking for the STM leaves the states unchanged");
  assert.equal(withStm.STATE_TRANSITION.length, n * 36);
  assert.deepEqual(withStm.STATE_TRANSITION.slice(0, 36), Array.from({ length: 36 }, (_, k) => (k % 7 === 0 ? 1 : 0)), "identity at time 0");
  // The STM predicts a perturbed propagation to first order.
  const eps = 1e-7;
  const perturbed = (await solve(h, { ...request(false), PROPAGATION: t.propagation({ ...request(false).PROPAGATION, INITIAL_STATE: state([0.8 + eps, 0, 0, 0, 0.1, 0]) }) })).TRAJECTORY;
  const phi = withStm.STATE_TRANSITION.slice((n - 1) * 36);
  const end = sixAt(plain.STATES, n - 1);
  const endPerturbed = sixAt(perturbed.STATES, n - 1);
  for (let i = 0; i < 6; i += 1) assert.ok(Math.abs(end[i] + phi[i * 6] * eps - endPerturbed[i]) < 1e-11, `row ${i}`);
});

test("Richardson guesses mirror across the synodic plane; NRHO is reported as its own family", async (tc) => {
  const h = await openHarness(tc);
  const guess = async (family) =>
    (await solve(h, { PROBLEM: tbpProblem.HaloFirstGuess, SYSTEM: EARTH_MOON, ORBITS: [orbit({ FAMILY: family, LIBRATION_POINT: rfmLibrationPoint.L2, AMPLITUDE: 0.01 })] })).ORBITS[0];
  const north = await guess(tbpOrbitFamily.HaloNorthern);
  const south = await guess(tbpOrbitFamily.HaloSouthern);
  assert.ok(north.INITIAL_STATE.Z > 0 && south.INITIAL_STATE.Z < 0);
  assert.equal(north.INITIAL_STATE.X, south.INITIAL_STATE.X);
  assert.equal(north.INITIAL_STATE.Z, -south.INITIAL_STATE.Z);
  assert.equal(north.CORRECTED, false);
  const nrho = await solve(h, { PROBLEM: tbpProblem.NearRectilinearHalo, SYSTEM: EARTH_MOON, ORBITS: [orbit({ LIBRATION_POINT: rfmLibrationPoint.L2 })] });
  const [o] = nrho.ORBITS;
  assert.equal(o.FAMILY, tbpOrbitFamily.NearRectilinearHalo);
  assert.equal(o.PERILUNE_ALTITUDE_KM, 3500, "default perilune");
  assert.equal(o.APOLUNE_ALTITUDE_KM, 70000, "default apolune");
  assert.equal(nrho.STATUS, o.CONVERGED ? tbpStatus.Solved : tbpStatus.NotConverged);
});

test("FrameConversion round-trips synodic -> inertial -> synodic", async (tc) => {
  const h = await openHarness(tc);
  const synodic = [0.8, 0.1, 0.02, 0, 0.15, 0.01];
  const there = await solve(h, { PROBLEM: tbpProblem.FrameConversion, SYSTEM: EARTH_MOON, FRAME_CONVERSION: t.frameConversion({ DIRECTION: tbpConversionDirection.SynodicToInertial, ELAPSED_S: 12_345, SYNODIC: state(synodic) }) });
  assert.equal(there.FRAME_CONVERSION.INERTIAL.length, 6);
  assert.ok(Math.abs(Math.hypot(...there.FRAME_CONVERSION.INERTIAL.slice(0, 3)) - 384_400 * Math.hypot(0.8, 0.1, 0.02)) < 1e-6, "km");
  const back = await solve(h, { PROBLEM: tbpProblem.FrameConversion, SYSTEM: EARTH_MOON, FRAME_CONVERSION: t.frameConversion({ DIRECTION: tbpConversionDirection.InertialToSynodic, ELAPSED_S: 12_345, INERTIAL: there.FRAME_CONVERSION.INERTIAL }) });
  const s = back.FRAME_CONVERSION.SYNODIC;
  [s.X, s.Y, s.Z, s.VX, s.VY, s.VZ].forEach((v, i) => assert.ok(Math.abs(v - synodic[i]) < 1e-12));
});

test("requests the module cannot answer come back in band as InvalidRequest", async (tc) => {
  const h = await openHarness(tc);
  const cases = [
    [{ PROBLEM: tbpProblem.LibrationPoints }, "missing-system"],
    [{ PROBLEM: tbpProblem.LibrationPoints, SYSTEM: system({ MASS_RATIO: 0.7 }) }, "invalid-mass-ratio"],
    [{ PROBLEM: tbpProblem.Family, SYSTEM: EARTH_MOON }, "unsupported-problem"],
    [{ PROBLEM: tbpProblem.Unspecified, SYSTEM: EARTH_MOON }, "unsupported-problem"],
    [{ PROBLEM: tbpProblem.PeriodicOrbit, SYSTEM: EARTH_MOON, ORBITS: [orbit({ FAMILY: tbpOrbitFamily.DistantRetrograde, AMPLITUDE: 0.05 })] }, "unsupported-family"],
    [{ PROBLEM: tbpProblem.PeriodicOrbit, SYSTEM: EARTH_MOON, ORBITS: [orbit({ LIBRATION_POINT: rfmLibrationPoint.L3, AMPLITUDE: 0.05 })] }, "unsupported-libration-point"],
    [{ PROBLEM: tbpProblem.Transfer, SYSTEM: EARTH_MOON, TRANSFER: t.transfer({ KIND: sds.tbpTransferKind.PoweredFlyby }) }, "unsupported-transfer-kind"],
    [{ PROBLEM: tbpProblem.JacobiConstant, SYSTEM: EARTH_MOON }, "missing-state"],
  ];
  for (const [request, code] of cases) {
    const answer = await solve(h, request);
    assert.equal(answer.STATUS, tbpStatus.InvalidRequest, code);
    assert.equal(answer.ERROR_CODE, code);
    assert.ok(answer.ERROR_MESSAGE.length > 0);
  }
});

test("a frame that is not a $TBP fails the invoke", async (tc) => {
  const h = await openHarness(tc);
  const result = await h.invoke({ methodId: "invoke", inputs: [{ portId: "request", typeRef: TBP_TYPE, payload: new Uint8Array(64) }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.outputs.length, 0);
  assert.ok(requestFrame({ PROBLEM: tbpProblem.LibrationPoints }).payload.length > 0);
});
