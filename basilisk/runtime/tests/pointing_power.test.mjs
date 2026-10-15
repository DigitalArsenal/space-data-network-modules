import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { PPS_TYPE, battery, decodePPS, scenario, scenarioFrame, scenarioFromLegacy, sds, solarArray } from "./lib-pps.mjs";

// run_pointing_power_scenario on the SDS Pointing and Power Scenario standard: a $PPS scenario in, a $PPS with the
// resolved scenario, STATUS and column-major telemetry out (SDK browser harness, command and direct surfaces).
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
// Requests and responses of the JSON-era artifact (0.2.0, captured before the conversion). Its telemetry was
// printed with %.12g, so typed values are compared at 12 significant digits.
const LEGACY = JSON.parse(fs.readFileSync(new URL("./fixtures/legacy-json-telemetry.json", import.meta.url), "utf8"));
const { ppsStatus, ppsAttitudeMode, ppsProduct } = sds;
const g12 = (value) => Number(value.toPrecision(12));

async function run(t, fields, surface = "command") {
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface });
  t.after(() => harness.destroy());
  const response = await harness.invoke({ methodId: "run_pointing_power_scenario", inputs: [scenarioFrame(fields)] });
  assert.equal(response.statusCode, 0, `${response.errorCode} ${response.errorMessage}`);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "telemetry");
  return decodePPS(response.outputs[0].payload);
}

test("the scenario and telemetry ports name one concrete $PPS type", () => {
  const method = MANIFEST.methods.find((entry) => entry.methodId === "run_pointing_power_scenario");
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.deepEqual(port.acceptedTypeSets.flatMap((set) => set.allowedTypes), [PPS_TYPE]);
  }
});

for (const [key, { request, response }] of Object.entries(LEGACY)) {
  test(`telemetry equals the JSON-era module's on the "${key}" scenario`, async (t) => {
    const answer = await run(t, { RUN_ID: `run-${key}`, SCENARIO: scenarioFromLegacy(request) }, key === "defaults" ? "direct" : "command");
    assert.equal(answer.RUN_ID, `run-${key}`);
    assert.equal(answer.PROVIDER, response.provider);
    assert.equal(answer.SCENARIO.SCENARIO_ID, response.scenarioId);
    assert.equal(answer.STATUS, ppsStatus.Nominal, "legacy status nominal");
    assert.deepEqual(answer.PRODUCTS, [ppsProduct.Attitude, ppsProduct.Power, ppsProduct.Sensor, ppsProduct.RelativeMotion]);
    const tm = answer.TELEMETRY;
    const n = response.telemetry.length;
    assert.equal(tm.SAMPLE_COUNT, n);
    for (const series of ["ELAPSED_S", "MODE", "POINTING_ERROR_DEG", "BODY_RATE_DEG_S", "WHEEL_MOMENTUM_NMS", "SENSOR_NOISE_ARCSEC", "ILLUMINATION", "GENERATED_POWER_W", "LOAD_POWER_W", "NET_POWER_W", "BATTERY_STATE_OF_CHARGE", "BATTERY_ENERGY_WH"]) {
      assert.equal(tm[series].length, n, series);
    }
    assert.equal(tm.RELATIVE_POSITION_M.length, 3 * n);
    assert.equal(tm.ATTITUDE_QUATERNION.length, 0, "not produced");
    assert.equal(tm.IN_ECLIPSE.length, 0, "not produced");
    response.telemetry.forEach((legacy, i) => {
      const at = `${key}[${i}]`;
      assert.equal(g12(tm.ELAPSED_S[i]), legacy.elapsedSeconds, `${at} elapsed`);
      assert.equal(g12(tm.POINTING_ERROR_DEG[i]), legacy.attitudeErrorDeg, `${at} pointing error`);
      assert.equal(g12(tm.BODY_RATE_DEG_S[i]), legacy.bodyRateDegSec, `${at} body rate`);
      assert.equal(g12(tm.WHEEL_MOMENTUM_NMS[i]), legacy.wheelMomentumNms, `${at} wheel`);
      assert.deepEqual(tm.RELATIVE_POSITION_M.slice(3 * i, 3 * i + 3).map(g12), legacy.relativePositionM, `${at} relative`);
      assert.equal(g12(tm.GENERATED_POWER_W[i]), legacy.generatedPowerW, `${at} generated`);
      assert.equal(g12(tm.LOAD_POWER_W[i]), legacy.busLoadW, `${at} load`);
      assert.equal(g12(tm.BATTERY_STATE_OF_CHARGE[i]), legacy.batteryStateOfCharge, `${at} soc`);
      assert.equal(g12(tm.SENSOR_NOISE_ARCSEC[i]), legacy.sensorNoiseArcsec, `${at} noise`);
      assert.equal(tm.MODE[i], legacy.pointingMode === "fine-track" ? ppsAttitudeMode.FineTrack : ppsAttitudeMode.Slew, `${at} mode`);
      assert.equal(tm.NET_POWER_W[i], tm.GENERATED_POWER_W[i] - tm.LOAD_POWER_W[i]);
      assert.equal(tm.BATTERY_ENERGY_WH[i], tm.BATTERY_STATE_OF_CHARGE[i] * answer.SCENARIO.BATTERY.CAPACITY_WH);
    });
  });
}

test("the former hidden constants are scenario fields; left 0 they take the old values and the answer states them", async (t) => {
  const answer = await run(t, { SCENARIO: scenario({ SCENARIO_ID: "defaults-stated", SOLAR_ARRAY: solarArray({ AREA_M2: 10 }) }) });
  const s = answer.SCENARIO;
  assert.equal(s.SOLAR_ARRAY.EFFICIENCY, 0.29);
  assert.equal(s.SOLAR_ARRAY.SOLAR_CONSTANT_W_M2, 1361);
  assert.equal(s.BATTERY.CAPACITY_WH, 14000);
  assert.equal(s.BUS_LOAD_W, 650);
  assert.equal(s.BATTERY.INITIAL_STATE_OF_CHARGE, 0.72);
  assert.equal(s.FINE_POINTING_THRESHOLD_DEG, 0.5);
  assert.equal(s.DURATION_S, 600);
  assert.equal(s.STEP_S, 60);
  assert.equal(answer.TELEMETRY.GENERATED_POWER_W[0], 10 * 1361 * 0.29 * answer.TELEMETRY.ILLUMINATION[0]);
});

test("stated efficiency, capacity and base load drive the power balance", async (t) => {
  const base = { SCENARIO_ID: "stated", DURATION_S: 600, STEP_S: 60, INITIAL_WHEEL_MOMENTUM_NMS: 2, SENSOR_NOISE_ARCSEC: 10 };
  const stated = await run(t, {
    SCENARIO: scenario({ ...base, SOLAR_ARRAY: solarArray({ AREA_M2: 20, EFFICIENCY: 0.32 }), BATTERY: battery({ CAPACITY_WH: 2000, INITIAL_STATE_OF_CHARGE: 0.5 }), BUS_LOAD_W: 300 }),
  });
  const tm = stated.TELEMETRY;
  assert.equal(tm.GENERATED_POWER_W[0], 20 * 1361 * 0.32 * tm.ILLUMINATION[0]);
  assert.equal(tm.LOAD_POWER_W[0], 300 + 18 * 2 + 0.7 * 10);
  assert.equal(tm.BATTERY_STATE_OF_CHARGE[1], 0.5 + tm.NET_POWER_W[1] * 60 / (2000 * 3600));
  assert.equal(tm.BATTERY_ENERGY_WH[0], 1000);
});

test("a battery below its stated floor or a saturated wheel makes the run Degraded", async (t) => {
  const answer = await run(t, {
    SCENARIO: scenario({ DURATION_S: 3600, STEP_S: 300, SOLAR_ARRAY: solarArray({ AREA_M2: 0.1 }), BATTERY: battery({ CAPACITY_WH: 100, INITIAL_STATE_OF_CHARGE: 0.3, MIN_STATE_OF_CHARGE: 0.2 }) }),
  });
  assert.equal(answer.STATUS, ppsStatus.Degraded);
  const wheel = await run(t, { SCENARIO: scenario({ INITIAL_WHEEL_MOMENTUM_NMS: 9, INITIAL_BODY_RATE_DEG_S: 0.1, WHEEL_MOMENTUM_CAPACITY_NMS: 10 }) });
  assert.equal(wheel.STATUS, ppsStatus.Degraded);
});

test("a $PPS without SCENARIO is answered InvalidRequest; a frame that is not a $PPS fails", async (t) => {
  const answer = await run(t, { RUN_ID: "empty" });
  assert.equal(answer.STATUS, ppsStatus.InvalidRequest);
  assert.equal(answer.ERROR_CODE, "missing-scenario");
  assert.equal(answer.RUN_ID, "empty");

  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "command" });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "run_pointing_power_scenario",
    inputs: [{ portId: "scenario", typeRef: PPS_TYPE, payload: new TextEncoder().encode('{"scenarioId":"json"}') }],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-scenario");
  assert.equal(response.outputs.length, 0);
});
