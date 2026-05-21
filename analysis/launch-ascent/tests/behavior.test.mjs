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
}
