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
}
