import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MU_EARTH = 398600441800000.0;

function circularVelocity(radius) {
  return Math.sqrt(MU_EARTH / radius);
}

function hohmannReference(r1, r2) {
  const aTransfer = (r1 + r2) / 2;
  const v1 = circularVelocity(r1);
  const v2 = circularVelocity(r2);
  const vTransfer1 = Math.sqrt(MU_EARTH * ((2 / r1) - (1 / aTransfer)));
  const vTransfer2 = Math.sqrt(MU_EARTH * ((2 / r2) - (1 / aTransfer)));
  const dv1 = vTransfer1 - v1;
  const dv2 = v2 - vTransfer2;
  return {
    aTransfer,
    dv1,
    dv2,
    totalDeltaV: dv1 + dv2,
    tof: Math.PI * Math.sqrt((aTransfer ** 3) / MU_EARTH),
  };
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`Hohmann transfer matches analytic reference values on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const request = {
      operation: "hohmannTransfer",
      params: { r1: 6_778_000, r2: 42_164_000, mu: MU_EARTH },
    };
    const result = await invokeJsonRequest(harness, request);
    const reference = hohmannReference(6_778_000, 42_164_000);

    assert.ok(Math.abs(result.aTransfer - reference.aTransfer) < 1e-6);
    assert.ok(Math.abs(result.dv1 - reference.dv1) < 1e-9);
    assert.ok(Math.abs(result.dv2 - reference.dv2) < 1e-9);
    assert.ok(Math.abs(result.totalDeltaV - reference.totalDeltaV) < 1e-9);
    assert.ok(Math.abs(result.tof - reference.tof) < 1e-9);
    assert.deepEqual(result.dv1_ric, [0, result.dv1, 0]);
    assert.deepEqual(result.dv2_ric, [0, result.dv2, 0]);
  });

  test(`plane-change delta-v matches 2 v sin(di/2) on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const velocity = 7_500;
    const deltaInclination = 10 * Math.PI / 180;
    const result = await invokeJsonRequest(harness, {
      operation: "planeChange",
      params: {
        orbitalRadius: 7_000_000,
        velocity,
        deltaInclination,
      },
    });
    const reference = 2 * velocity * Math.sin(deltaInclination / 2);

    assert.ok(Math.abs(result.dv - reference) < 1e-9);
    assert.deepEqual(result.dv_ric, [0, 0, result.dv]);
    assert.equal(result.optimalTrueAnomaly, 0);
  });

  test(`combined maneuver improves on separate transfer-plus-plane-change on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const r1 = 7_000_000;
    const r2 = 10_000_000;
    const deltaInclination = 5 * Math.PI / 180;
    const result = await invokeJsonRequest(harness, {
      operation: "combinedManeuver",
      params: { r1, r2, deltaInclination, mu: MU_EARTH },
    });
    const hohmann = hohmannReference(r1, r2);
    const separate = hohmann.totalDeltaV +
      (2 * circularVelocity(r2) * Math.sin(deltaInclination / 2));

    assert.ok(result.totalDeltaV > 0);
    assert.ok(result.totalDeltaV < separate);
    assert.ok(result.dv1 > 0);
    assert.ok(result.dv2 > 0);
  });

  test(`collision-avoidance maneuvers honor miss-distance and timing config on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "computeCAM",
      params: {
        initialState: {
          position: [50, 0, 0],
          velocity: [0, -0.02, 0],
        },
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0,
          inclination: 0,
          mu: MU_EARTH,
        },
        config: {
          minMissDistance: 1_000,
          timeToTCA: 600,
          maxDeltaV: 10,
          preferRadial: false,
        },
      },
    });

    const magnitude = Math.hypot(...result.deltaV);
    assert.equal(result.feasible, true);
    assert.equal(result.achievedMiss, 1_000);
    assert.equal(result.optimalBurnTime, 600);
    assert.ok(Math.abs(result.magnitude - magnitude) < 1e-12);
    assert.ok(result.magnitude <= 10);
  });

  test(`KGD ROE STM propagation returns finite J2 state transition data on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "computeRoeStateTransition",
      params: {
        model: "j2",
        deltaTime: 1200,
        initialRoe: [1e-5, 2e-5, 1e-6, 2e-6, 3e-6, 4e-6],
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0.001,
          inclination: 51.6 * Math.PI / 180,
          raan: 0,
          argumentOfPerigee: 0,
          meanAnomaly: 0,
          mu: MU_EARTH,
        },
      },
    });

    assert.equal(result.model, "j2");
    assert.equal(result.reference, "Koenig-Guffanti-D'Amico ROE STM");
    assert.equal(result.stm.length, 6);
    assert.equal(result.stm[0].length, 6);
    assert.equal(result.propagatedRoe.length, 6);
    assert.ok(Math.abs(result.stm[0][0] - 1) < 1e-12);
    assert.ok(result.propagatedRoe.every(Number.isFinite));
  });

  test(`relative waypoint mission planning returns finite burns and trajectory on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const period =
      2 * Math.PI * Math.sqrt((6_778_000 ** 3) / MU_EARTH);
    const legTof = 0.75 * period;
    const result = await invokeJsonRequest(harness, {
      operation: "planRelativeWaypointMission",
      params: {
        initialState: {
          position: [0, -200, 0],
          velocity: [0, 0, 0],
        },
        chief: {
          semiMajorAxis: 6_778_000,
          eccentricity: 0.001,
          inclination: 51.6 * Math.PI / 180,
          raan: 0,
          argumentOfPerigee: 0,
          meanAnomaly: 0,
          mu: MU_EARTH,
        },
        waypoints: [
          { position: [40, -120, 20], tof: legTof },
          { position: [0, -60, 0], tof: legTof },
          { position: [0, 0, 0], tof: legTof },
        ],
        options: {
          includeJ2: true,
          positionTolerance: 5,
          pointsPerLeg: 24,
        },
      },
    });

    assert.equal(result.reference, "Koenig-Guffanti-D'Amico ROE STM");
    assert.equal(result.converged, true);
    assert.equal(result.legs.length, 3);
    assert.equal(result.trajectory.length, 72);
    assert.ok(result.totalDeltaV > 0);
    assert.ok(result.totalTime > 0);
    assert.ok(result.legs.every((leg) => leg.converged));
    assert.ok(result.legs.every((leg) => Number.isFinite(leg.totalDeltaV)));
    assert.ok(result.trajectory.every((point) =>
      point.position.every(Number.isFinite) &&
      point.velocity.every(Number.isFinite),
    ));
  });
}
