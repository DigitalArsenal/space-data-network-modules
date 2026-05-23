import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`Basilisk runtime produces deterministic pointing and power telemetry on ${runtimeKind}`, async (t) => {
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
        scenarioId: "crew-dragon-approach-pointing",
        durationSeconds: 600,
        stepSeconds: 120,
        initialAttitudeErrorDeg: 6,
        bodyRateDegSec: 0.08,
        wheelMomentumNms: 12,
        batteryStateOfCharge: 0.76,
        solarArrayAreaM2: 16,
        sensorNoiseArcsec: 18
      },
      {
        methodId: "run_pointing_power_scenario",
        inputPortId: "scenario",
        outputPortId: "telemetry",
      },
    );

    assert.equal(result.provider, "com.digitalarsenal.basilisk.runtime");
    assert.equal(result.scenarioId, "crew-dragon-approach-pointing");
    assert.equal(result.telemetry.length, 6);
    assert.ok(result.telemetry[0].attitudeErrorDeg > result.telemetry.at(-1).attitudeErrorDeg);
    assert.ok(result.telemetry.at(-1).batteryStateOfCharge > 0);
    assert.ok(result.telemetry.at(-1).wheelMomentumNms > result.telemetry[0].wheelMomentumNms);
    assert.ok(result.telemetry[0].relativePositionM[0] > result.telemetry.at(-1).relativePositionM[0]);
    assert.equal(result.products.includes("attitude"), true);
    assert.equal(result.products.includes("power"), true);
    assert.equal(result.products.includes("sensor"), true);
  });
}
