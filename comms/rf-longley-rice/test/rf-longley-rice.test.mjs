// rf-longley-rice Node native-test-runner harness.
//
// This module is a STUB by design — the API surface is frozen so hosts
// can branch on `isStub` and fall back to the existing JS-side
// computeLongleyRicePathLoss bridge until the native NTIA-ITS port
// replaces the kernel. The test verifies the stub contract.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfLongleyRicePlugin } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfLongleyRicePlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-longley-rice");
});

test("reports itself as a stub", () => {
  assert.equal(plugin.isStub, true);
});

test("path-loss kernel returns 0 from the stub", () => {
  const loss = plugin.pathLossDb({
    distanceKm: 50,
    frequencyMhz: 1000,
    txHeightM: 30,
    rxHeightM: 2,
  });
  assert.equal(loss, 0);
});

test("path-loss accepts the full options shape without throwing", () => {
  assert.doesNotThrow(() =>
    plugin.pathLossDb({
      distanceKm: 100,
      frequencyMhz: 2400,
      txHeightM: 100,
      rxHeightM: 5,
      terrainIrregularityM: 200,
      climateCode: 5,
      polarizationCode: 0,
      surfaceRefractivityNUnits: 301,
      groundDielectricConstant: 15,
      groundConductivitySPerM: 0.005,
      timePercent: 50,
      locationPercent: 50,
      situationPercent: 50,
    }),
  );
});
