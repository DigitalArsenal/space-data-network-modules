import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180.0;
}

function toCartesian(sample) {
  const latitude = toRadians(sample.latitudeDeg);
  const longitude = toRadians(sample.longitudeDeg);
  const radius = EARTH_RADIUS_M + sample.altitudeM;
  const cosLatitude = Math.cos(latitude);
  return {
    x: radius * cosLatitude * Math.cos(longitude),
    y: radius * cosLatitude * Math.sin(longitude),
    z: radius * Math.sin(latitude),
  };
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function pathSpeedBetween(left, right) {
  return (
    magnitude(subtract(toCartesian(right), toCartesian(left))) /
    (right.elapsedSeconds - left.elapsedSeconds)
  );
}

function turnAngleBetween(leftA, leftB, rightA, rightB) {
  const leftVector = subtract(toCartesian(leftB), toCartesian(leftA));
  const rightVector = subtract(toCartesian(rightB), toCartesian(rightA));
  const denominator = magnitude(leftVector) * magnitude(rightVector);
  return Math.acos(Math.max(-1, Math.min(1, dot(leftVector, rightVector) / denominator))) * 180 / Math.PI;
}

const falcon9CrewDragonRequest = Object.freeze({
  atmosphereProvider: "atmosphere-model",
  hypersonicsProvider: "hypersonics-propagator",
  atmosphereModel: "US76",
  vehicle: {
    name: "Falcon 9 Block 5 / Crew Dragon",
    referenceAreaM2: 10.75,
    referenceLengthM: 3.7,
    noseRadiusM: 1.85,
    massKg: 549_000,
  },
  launchSite: {
    name: "KSC LC-39A",
    latitudeDeg: 28.608389,
    longitudeDeg: -80.604333,
    altitudeM: 3,
  },
  targetOrbit: {
    altitudeM: 200_000,
    inclinationDeg: 51.64,
    azimuthDeg: 73,
    insertionSpeedMps: 7790,
  },
  guidance: {
    durationSeconds: 540,
    sampleStepSeconds: 15,
    maxTurnRateDegPerSample: 1.5,
  },
});

function cloneRequest(overrides = {}) {
  return {
    ...falcon9CrewDragonRequest,
    ...overrides,
    vehicle: {
      ...falcon9CrewDragonRequest.vehicle,
      ...overrides.vehicle,
    },
    launchSite: {
      ...falcon9CrewDragonRequest.launchSite,
      ...overrides.launchSite,
    },
    targetOrbit: {
      ...falcon9CrewDragonRequest.targetOrbit,
      ...overrides.targetOrbit,
    },
    guidance: {
      ...falcon9CrewDragonRequest.guidance,
      ...overrides.guidance,
    },
  };
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`launch ascent simulation composes atmosphere and hypersonics samples on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereProvider: "atmosphere-model",
        hypersonicsProvider: "hypersonics-propagator",
        atmosphereModel: "US76",
        vehicle: {
          referenceAreaM2: 1.2,
          referenceLengthM: 2,
          noseRadiusM: 0.5,
          massKg: 12_000,
        },
        samples: [
          { id: "liftoff", elapsedSeconds: 0, altitudeM: 0, speedMps: 0, massKg: 12_000 },
          { id: "max-q", elapsedSeconds: 55, altitudeM: 10_000, speedMps: 1_500, massKg: 9_500 },
          { id: "upper-stage", elapsedSeconds: 180, altitudeM: 30_000, speedMps: 2_200, massKg: 5_000 },
        ],
      },
      {
        methodId: "simulate_launch_ascent",
        inputPortId: "ascent",
        outputPortId: "launch",
      },
    );

    assert.equal(result.provider, "launch-ascent-analysis");
    assert.equal(result.status, "nominal");
    assert.equal(result.maxDynamicPressure.sampleId, "max-q");
    assertClose(result.maxDynamicPressure.valuePa, 465_200, 2_500, "max dynamic pressure");
    assert.ok(result.maxMach.value > 7);
    assert.deepEqual(
      result.events.map((entry) => entry.event),
      ["liftoff", "max_dynamic_pressure", "ascent_complete"],
    );
    assert.equal(result.hypersonicConditions.length, 3);
  });

  test(`launch ascent module generates a smooth target-orbit trajectory and delta-v budget on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest(),
      {
        methodId: "simulate_launch_ascent",
        inputPortId: "ascent",
        outputPortId: "launch",
      },
    );

    assert.equal(result.provider, "launch-ascent-analysis");
    assert.equal(result.trajectorySource, "module-generated-target-orbit");
    assert.ok(result.trajectorySamples.length >= 35);
    assert.equal(
      result.trajectorySamples[0].phase,
      "liftoff",
      "first generated sample should be liftoff",
    );
    assert.equal(
      result.trajectorySamples.at(-1).phase,
      "orbital-insertion",
      "last generated sample should be orbital insertion",
    );
    assertClose(
      result.trajectorySamples.at(-1).altitudeM,
      200_000,
      1_000,
      "target insertion altitude",
    );
    assertClose(
      result.trajectorySamples.at(-1).speedMps,
      7_790,
      30,
      "target insertion speed",
    );
    assert.ok(
      result.launchTrajectory.maxHeadingStepDeg <= 1.5,
      `max heading step ${result.launchTrajectory.maxHeadingStepDeg}`,
    );
    assert.ok(result.deltaV.fromStationaryLaunchMps > 9_000);
    assert.ok(result.deltaV.fromStationaryLaunchMps < 10_500);
    assert.ok(result.deltaV.earthRotationBoostMps > 350);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps > 40);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps < 200);
    assert.equal(result.hypersonicConditions.length, result.trajectorySamples.length);
  });

  test(`launch ascent generated path preserves terminal speed and tangent continuity on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      cloneRequest(),
      {
        methodId: "simulate_launch_ascent",
        inputPortId: "ascent",
        outputPortId: "launch",
      },
    );
    const samples = result.trajectorySamples;
    const insertion = samples.at(-1);
    const terminalPathSpeed = pathSpeedBetween(samples.at(-2), insertion);
    const previousPathSpeed = pathSpeedBetween(samples.at(-3), samples.at(-2));
    const terminalTurnAngle = turnAngleBetween(
      samples.at(-3),
      samples.at(-2),
      samples.at(-2),
      insertion,
    );

    assert.ok(
      terminalPathSpeed > insertion.speedMps * 0.72,
      `terminal path speed ${terminalPathSpeed} should stay close to insertion speed ${insertion.speedMps}`,
    );
    assert.ok(
      terminalPathSpeed > previousPathSpeed * 0.75,
      `terminal path speed ${terminalPathSpeed} should not collapse from previous path speed ${previousPathSpeed}`,
    );
    assert.ok(
      terminalTurnAngle < 8.0,
      `terminal turn angle ${terminalTurnAngle} should not create an insertion kink`,
    );
  });

  test(`launch ascent throttle schedule changes the achieved orbit on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const fullThrottle = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 180, throttle: 1.0 },
          ],
        },
      }),
      {
        methodId: "simulate_launch_ascent",
        inputPortId: "ascent",
        outputPortId: "launch",
      },
    );
    const reducedThrottle = await invokeJsonRequest(
      harness,
      cloneRequest({
        guidance: {
          throttleSchedule: [
            { elapsedSeconds: 0, throttle: 1.0 },
            { elapsedSeconds: 180, throttle: 0.62 },
          ],
        },
      }),
      {
        methodId: "simulate_launch_ascent",
        inputPortId: "ascent",
        outputPortId: "launch",
      },
    );

    assert.ok(
      Number.isFinite(fullThrottle.achievedOrbit?.apoapsisM),
      "full-throttle run should report achieved orbit",
    );
    assert.ok(
      Number.isFinite(reducedThrottle.achievedOrbit?.apoapsisM),
      "reduced-throttle run should report achieved orbit",
    );
    assert.ok(
      reducedThrottle.insertionState.speedMps <
        fullThrottle.insertionState.speedMps - 250,
      "reducing throttle should lower insertion speed",
    );
    assert.ok(
      reducedThrottle.achievedOrbit.apoapsisM <
        fullThrottle.achievedOrbit.apoapsisM - 50_000,
      "reducing throttle should lower the achieved apoapsis",
    );
  });
}
