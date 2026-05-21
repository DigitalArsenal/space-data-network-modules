import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`version request returns the package version on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "version",
      params: {},
    });
    assert.equal(result.version, "0.1.0");
  });

  test(`US76 sea-level and 10 km values stay near standard atmosphere on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const seaLevel = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 0, model: "US76" },
    });
    const tenKm = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: { altitudeM: 10_000, model: "US76" },
    });

    assert.ok(Math.abs(seaLevel.state.density - 1.225) < 0.001);
    assert.ok(Math.abs(seaLevel.state.pressure - 101_325) < 0.1);
    assert.ok(Math.abs(seaLevel.state.temperature - 288.15) < 1e-9);

    assert.ok(Math.abs(tenKm.state.density - 0.4135) < 0.002);
    assert.ok(tenKm.state.temperature > 223 && tenKm.state.temperature < 224);
    assert.ok(tenKm.state.soundSpeed < seaLevel.state.soundSpeed);
  });

  test(`batch altitude queries preserve ordering and monotonic density on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "queryAltitudes",
      params: {
        altitudesM: [0, 10_000, 20_000],
        model: "US76",
      },
    });

    assert.equal(result.count, 3);
    assert.deepEqual(
      result.results.map((entry) => entry.altitudeM),
      [0, 10_000, 20_000],
    );
    assert.ok(result.results[0].state.density > result.results[1].state.density);
    assert.ok(result.results[1].state.density > result.results[2].state.density);
    assert.ok(result.results[0].state.pressure > result.results[1].state.pressure);
    assert.ok(result.results[1].state.pressure > result.results[2].state.pressure);
  });

  test(`atmosphere state batch exposes the provider contract on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "queryAtmosphereStateBatch",
      params: {
        model: "US76",
        samples: [
          { id: "sea-level", altitudeM: 0 },
          { id: "ten-km", altitudeM: 10_000 },
        ],
      },
    });

    assert.equal(result.provider, "atmosphere-model");
    assert.equal(result.model, "US76");
    assert.equal(result.count, 2);
    assert.deepEqual(
      result.states.map((entry) => entry.id),
      ["sea-level", "ten-km"],
    );
    assert.ok(Math.abs(result.states[0].densityKgM3 - 1.225) < 0.001);
    assert.ok(Math.abs(result.states[0].pressurePa - 101_325) < 0.1);
    assert.ok(Math.abs(result.states[1].densityKgM3 - 0.4135) < 0.002);
    assert.ok(result.states[1].soundSpeedMps < result.states[0].soundSpeedMps);
  });

  test(`direct atmosphere batch method uses fixed provider method id on ${runtimeKind}`, async (t) => {
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
        model: "US76",
        samples: [{ id: "ten-km", altitudeM: 10_000 }],
      },
      {
        methodId: "query_atmosphere_state_batch",
        inputPortId: "atmosphere",
        outputPortId: "states",
      },
    );

    assert.equal(result.provider, "atmosphere-model");
    assert.equal(result.model, "US76");
    assert.equal(result.count, 1);
    assert.equal(result.states[0].id, "ten-km");
    assert.ok(Math.abs(result.states[0].densityKgM3 - 0.4135) < 0.002);
  });

  test(`NRLMSISE00 responds to solar activity at 400 km on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const lowSolar = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        solar: { F107: 70, F107A: 70, Ap: [0, 0, 0, 0, 0, 0, 0] },
      },
    });
    const highSolar = await invokeJsonRequest(harness, {
      operation: "queryAltitude",
      params: {
        altitudeM: 400_000,
        model: "NRLMSISE00",
        solar: { F107: 200, F107A: 180, Ap: [50, 0, 0, 0, 0, 0, 0] },
      },
    });

    assert.ok(highSolar.state.exosphericTemp > lowSolar.state.exosphericTemp);
    assert.ok(highSolar.state.temperature > lowSolar.state.temperature);
    assert.ok(highSolar.state.density > lowSolar.state.density);
  });
}
