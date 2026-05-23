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
  test(`reentry simulation composes atmosphere and hypersonics samples on ${runtimeKind}`, async (t) => {
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
          massKg: 900,
        },
        samples: [
          { id: "entry-interface", elapsedSeconds: 0, altitudeM: 80_000, speedMps: 11_000 },
          { id: "max-q", elapsedSeconds: 110, altitudeM: 10_000, speedMps: 1_500 },
          { id: "impact", elapsedSeconds: 240, altitudeM: 0, speedMps: 200 },
        ],
      },
      {
        methodId: "simulate_reentry",
        inputPortId: "scenario",
        outputPortId: "reentry",
      },
    );

    assert.equal(result.provider, "reentry-analysis");
    assert.equal(result.atmosphereProvider, "atmosphere-model");
    assert.equal(result.hypersonicsProvider, "hypersonics-propagator");
    assert.equal(result.outcome, "impact");
    assert.equal(result.trajectorySamples.length, 3);
    assert.equal(result.peakDynamicPressure.sampleId, "max-q");
    assertClose(result.peakDynamicPressure.valuePa, 465_200, 2_500, "peak dynamic pressure");
    assert.equal(result.peakHeating.sampleId, "entry-interface");
    assert.ok(result.peakHeating.valueWm2 > result.peakDynamicPressure.valuePa);
    assert.equal(result.impactPoint.altitudeM, 0);
  });

  test(`reentry module generates a deorbit-to-impact trajectory and delta-v budget on ${runtimeKind}`, async (t) => {
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
          name: "Crew Dragon",
          referenceAreaM2: 10.75,
          referenceLengthM: 3.7,
          noseRadiusM: 1.85,
          massKg: 9_500,
        },
        entryInterface: {
          latitudeDeg: 26.5,
          longitudeDeg: -110.0,
          altitudeM: 80_000,
          speedMps: 7_650,
          flightPathAngleDeg: -1.5,
        },
        targetImpact: {
          latitudeDeg: 29.7,
          longitudeDeg: -83.5,
          altitudeM: 0,
        },
        corridor: {
          durationSeconds: 1_500,
          sampleStepSeconds: 30,
        },
        stableOrbit: {
          altitudeM: 420_000,
        },
      },
      {
        methodId: "simulate_reentry",
        inputPortId: "scenario",
        outputPortId: "reentry",
      },
    );

    assert.equal(result.provider, "reentry-analysis");
    assert.equal(result.trajectorySource, "module-generated-entry-corridor");
    assert.ok(result.trajectorySamples.length >= 45);
    assertClose(
      result.trajectorySamples[0].altitudeM,
      80_000,
      1_000,
      "entry interface altitude",
    );
    assertClose(
      result.trajectorySamples.at(-1).altitudeM,
      0,
      1,
      "impact altitude",
    );
    assertClose(
      result.impactPoint.latitudeDeg,
      29.7,
      0.1,
      "impact latitude",
    );
    assertClose(
      result.impactPoint.longitudeDeg,
      -83.5,
      0.1,
      "impact longitude",
    );
    assert.ok(result.trajectoryGeometry.maxHeadingStepDeg < 2.0);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps > 70);
    assert.ok(result.deltaV.fromStableOrbitDeorbitMps < 250);
    assert.equal(result.hypersonicConditions.length, result.trajectorySamples.length);
  });
}
