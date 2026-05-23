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
      {
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
      },
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
}
