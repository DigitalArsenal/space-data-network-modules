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
  test(`hypersonic state batch evaluates Mach, q, and heating on ${runtimeKind}`, async (t) => {
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
        atmosphereModel: "US76",
        vehicle: {
          referenceAreaM2: 1.2,
          referenceLengthM: 2.0,
          noseRadiusM: 0.5,
          massKg: 900,
        },
        states: [
          {
            id: "ten-km-mach-five",
            altitudeM: 10_000,
            speedMps: 1_500,
            flightPathAngleDeg: -5,
          },
        ],
      },
      {
        methodId: "evaluate_hypersonic_state_batch",
        inputPortId: "trajectory",
        outputPortId: "conditions",
      },
    );

    assert.equal(result.provider, "hypersonics-propagator");
    assert.equal(result.atmosphereProvider, "atmosphere-model");
    assert.equal(result.atmosphereModel, "US76");
    assert.equal(result.count, 1);

    const condition = result.conditions[0];
    assert.equal(condition.id, "ten-km-mach-five");
    assertClose(condition.atmosphere.densityKgM3, 0.4135, 0.002, "density");
    assertClose(condition.atmosphere.temperatureK, 223.15, 0.02, "temperature");
    assertClose(condition.mach, 5.009, 0.02, "Mach number");
    assertClose(condition.dynamicPressurePa, 465_200, 2_500, "dynamic pressure");
    assertClose(condition.stagnationHeatFluxWm2, 561_000, 8_000, "Sutton-Graves heat flux");
    assert.ok(condition.reynoldsNumber > 1_000_000);
  });
}
