import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "space-data-module-sdk/testing/isomorphic";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const EARTH_MOON_MU = 0.0121505856;
const EARTH_MOON_SYSTEM = {
  mu: EARTH_MOON_MU,
  l_star: 384_400_000,
  t_star: 375_190.25852,
  m1: 5.972e24,
  m2: 7.348e22,
  name: "Earth-Moon",
};
const HALO_AUTHORITIES = JSON.parse(
  fs.readFileSync(new URL("../vectors/jpl-halo-authority.json", import.meta.url), "utf8"),
);

function jacobiConstant(state, mu) {
  const [x, y, z, vx, vy, vz] = state;
  const r1 = Math.sqrt((x + mu) ** 2 + y * y + z * z);
  const r2 = Math.sqrt((x - 1 + mu) ** 2 + y * y + z * z);
  const potential = ((1 - mu) / r1) + (mu / r2) + 0.5 * (x * x + y * y);
  const speedSquared = vx * vx + vy * vy + vz * vz;
  return 2 * potential - speedSquared;
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`Earth-Moon Lagrange points preserve textbook geometry on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const points = await invokeJsonRequest(harness, {
      operation: "computeLagrangePoints",
      params: { mu: EARTH_MOON_MU },
    });

    assert.equal(points.length, 5);
    assert.ok(Math.abs(points[0].position[0] - 0.8369151258197124) < 1e-9);
    assert.ok(points[1].position[0] > 1.0);
    assert.ok(points[2].position[0] < -1.0);
    assert.ok(Math.abs(points[3].position[0] - (0.5 - EARTH_MOON_MU)) < 1e-12);
    assert.ok(Math.abs(points[3].position[1] - Math.sqrt(3) / 2) < 1e-12);
    assert.ok(Math.abs(points[4].position[1] + Math.sqrt(3) / 2) < 1e-12);
    assert.ok(Math.abs(points[3].jacobi - points[4].jacobi) < 1e-12);
  });

  test(`Richardson halo guesses mirror across the synodic plane on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const northern = await invokeJsonRequest(harness, {
      operation: "richardsonHaloGuess",
      params: { mu: EARTH_MOON_MU, point: 1, Az: 0.01, northern: true },
    });
    const southern = await invokeJsonRequest(harness, {
      operation: "richardsonHaloGuess",
      params: { mu: EARTH_MOON_MU, point: 1, Az: 0.01, northern: false },
    });

    assert.ok(northern.z > 0);
    assert.ok(southern.z < 0);
    assert.ok(Math.abs(northern.x - southern.x) < 1e-12);
    assert.ok(Math.abs(northern.vy - southern.vy) < 1e-12);
    assert.ok(Math.abs(northern.z + southern.z) < 1e-12);
  });

  test(`Earth-Moon L1/L2 halo periods and Jacobi constants reproduce the published family on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    assert.equal(HALO_AUTHORITIES.authority, "NASA/JPL Three-Body Periodic Orbits API");
    assert.equal(HALO_AUTHORITIES.apiVersion, "1.0");
    let worstJacobiRelative = 0;
    let worstPeriodRelative = 0;
    for (const authority of HALO_AUTHORITIES.queries) {
      const solved = await invokeJsonRequest(harness, {
        operation: "computePeriodicOrbit",
        params: {
          config: {
            family: 0,
            point: authority.librationPoint - 1,
            amplitude: authority.moduleAmplitude,
            maxIterations: 100,
            tolerance: 1e-10,
          },
          system: {
            ...EARTH_MOON_SYSTEM,
            mu: HALO_AUTHORITIES.massRatio,
          },
        },
      });
      assert.equal(solved.converged, true);
      const jacobiRelative =
        Math.abs(solved.jacobi - authority.record.jacobi) /
        Math.abs(authority.record.jacobi);
      const periodRelative =
        Math.abs(solved.period - authority.record.period) /
        Math.abs(authority.record.period);
      worstJacobiRelative = Math.max(worstJacobiRelative, jacobiRelative);
      worstPeriodRelative = Math.max(worstPeriodRelative, periodRelative);
      assert.ok(
        jacobiRelative <= 1e-4,
        `L${authority.librationPoint} Jacobi relative error ${jacobiRelative}`,
      );
      assert.ok(
        periodRelative <= 1e-4,
        `L${authority.librationPoint} period relative error ${periodRelative}`,
      );
    }
    t.diagnostic(
      `JPL halo worst_jacobi_relative=${worstJacobiRelative.toExponential(6)} ` +
      `worst_period_relative=${worstPeriodRelative.toExponential(6)}`,
    );
  });

  test(`coordinate transforms round-trip through ECI on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const rotatingState = {
      x: 0.8,
      y: 0.1,
      z: 0.02,
      vx: 0.0,
      vy: 0.15,
      vz: 0.01,
    };
    const eci = await invokeJsonRequest(harness, {
      operation: "coordinateTransform",
      params: {
        action: "rotatingToECI",
        system: EARTH_MOON_SYSTEM,
        epoch_s: 12_345,
        state: rotatingState,
      },
    });
    const roundTrip = await invokeJsonRequest(harness, {
      operation: "coordinateTransform",
      params: {
        action: "eciToRotating",
        system: EARTH_MOON_SYSTEM,
        epoch_s: 12_345,
        state: eci,
      },
    });

    assert.ok(Math.abs(roundTrip.x - rotatingState.x) < 1e-12);
    assert.ok(Math.abs(roundTrip.y - rotatingState.y) < 1e-12);
    assert.ok(Math.abs(roundTrip.z - rotatingState.z) < 1e-12);
    assert.ok(Math.abs(roundTrip.vx - rotatingState.vx) < 1e-12);
    assert.ok(Math.abs(roundTrip.vy - rotatingState.vy) < 1e-12);
    assert.ok(Math.abs(roundTrip.vz - rotatingState.vz) < 1e-12);
  });

  test(`short CR3BP propagations preserve Jacobi constant on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const propagated = await invokeJsonRequest(harness, {
      operation: "propagateCR3BP",
      params: {
        state: { x: 0.8, y: 0.0, z: 0.0, vx: 0.0, vy: 0.1, vz: 0.0 },
        mu: EARTH_MOON_MU,
        options: {
          duration: 0.05,
          stepSize: 0.001,
          outputPoints: 51,
          computeSTM: false,
        },
      },
    });

    assert.equal(propagated.states.length, 51);
    const initialJacobi = jacobiConstant(propagated.states[0], EARTH_MOON_MU);
    const finalJacobi = jacobiConstant(propagated.states.at(-1), EARTH_MOON_MU);
    assert.ok(Math.abs(propagated.jacobi - initialJacobi) < 1e-12);
    assert.ok(Math.abs(finalJacobi - initialJacobi) < 1e-5);
  });
}
