import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const INVOKE = {
  methodId: "evaluate_hypersonic_state_batch",
  inputPortId: "trajectory",
  outputPortId: "conditions",
  inputTypeRef: {
    schemaName: "OEM.fbs",
    fileIdentifier: "$OEM",
    rootTypeName: "OEM",
  },
};

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`hypersonic state batch evaluates Mach, q, and heating on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
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
      INVOKE,
    );

    assert.equal(result.provider, "hypersonics-propagator");
    assert.equal(result.atmosphereProvider, "atmosphere-model");
    assert.equal(result.atmosphereModel, "US76");
    assert.equal(result.count, 1);

    const condition = result.conditions[0];
    assert.equal(condition.id, "ten-km-mach-five");
    // Published US Standard Atmosphere 1976 (NOAA-S/T 76-1562) Table I,
    // Z = 10 km GEOMETRIC: T = 223.252 K, rho = 0.41351 kg/m^3.
    // (223.252 K, not 223.15 K: US76 layers are defined in geopotential
    // altitude H = r0*Z/(r0+Z); H(10 km) = 9.9843 km.)
    assertClose(condition.atmosphere.densityKgM3, 0.41351, 0.002, "density");
    assertClose(
      condition.atmosphere.temperatureK,
      223.252,
      0.02,
      "temperature",
    );
    // a = sqrt(1.4 * 287.053 * 223.252) = 299.53 m/s -> M = 1500/299.53 = 5.008
    assertClose(condition.mach, 5.008, 0.02, "Mach number");
    assertClose(
      condition.dynamicPressurePa,
      465_200,
      2_500,
      "dynamic pressure",
    );
    assertClose(
      condition.stagnationHeatFluxWm2,
      561_000,
      8_000,
      "Sutton-Graves heat flux",
    );
    assert.ok(condition.reynoldsNumber > 1_000_000);
  });

  test(`NRLMSISE00 atmosphere model is rejected with a clear error on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "evaluate_hypersonic_state_batch",
      inputs: [
        {
          portId: "trajectory",
          typeRef: INVOKE.inputTypeRef,
          payload: Buffer.from(
            JSON.stringify({
              atmosphereModel: "NRLMSISE00",
              states: [{ id: "x", altitudeM: 100_000, speedMps: 5_000 }],
            }),
            "utf8",
          ),
        },
      ],
    });

    // This module must NOT silently substitute an exponential fit for
    // NRLMSISE-00 — the request fails hard with a clear error.
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "unsupported-atmosphere-model");
    assert.match(response.errorMessage ?? "", /NRLMSISE00/);
    assert.match(response.errorMessage ?? "", /US76_EXPONENTIAL_EXTENSION/);
  });

  test(`US76_EXPONENTIAL_EXTENSION extends honestly above 86 km on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(
      runtimeKind,
      WASM_PATH,
      t,
    );
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        atmosphereModel: "US76_EXPONENTIAL_EXTENSION",
        states: [
          { id: "low", altitudeM: 10_000, speedMps: 1_500 },
          { id: "high", altitudeM: 120_000, speedMps: 7_000 },
        ],
      },
      INVOKE,
    );

    assert.equal(result.count, 2);
    const low = result.conditions[0];
    const high = result.conditions[1];
    // Below 86 km the extension is exactly US76 (published 10 km values).
    assertClose(
      low.atmosphere.temperatureK,
      223.252,
      0.02,
      "US76 temperature at 10 km",
    );
    // Above 86 km: crude isothermal extension — positive, decreasing density.
    assert.ok(high.atmosphere.densityKgM3 > 0);
    assert.ok(high.atmosphere.densityKgM3 < low.atmosphere.densityKgM3);
  });
}
