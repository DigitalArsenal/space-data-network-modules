// rf-atmospheric-gaseous Node native-test-runner harness.
//
// Self-consistency + analytical-property suite. Externally-sourced
// fixtures regenerated against ITU-R P.676-13 are a Phase 2 follow-up;
// the simplified single-Lorentzian fits in this module deliberately
// trade accuracy for callable scope and are NOT P.676 conformant.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfAtmosphericGaseousPlugin } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfAtmosphericGaseousPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-atmospheric-gaseous");
});

test("oxygen + water-vapor specific attenuations are non-negative", () => {
  for (const fGhz of [1, 5, 10, 22, 35, 50]) {
    const o2 = plugin.oxygenSpecificAttenuationDbPerKm(fGhz, 15);
    const h2o = plugin.waterVaporSpecificAttenuationDbPerKm(fGhz, 15, 50);
    assert.ok(Number.isFinite(o2));
    assert.ok(Number.isFinite(h2o));
    assert.ok(o2 >= 0, `O2 absorption negative at ${fGhz} GHz: ${o2}`);
    assert.ok(h2o >= 0, `H2O absorption negative at ${fGhz} GHz: ${h2o}`);
  }
});

test("water-vapor 22 GHz line peaks above neighboring frequencies", () => {
  const at22 = plugin.waterVaporSpecificAttenuationDbPerKm(22, 15, 50);
  const at5 = plugin.waterVaporSpecificAttenuationDbPerKm(5, 15, 50);
  const at40 = plugin.waterVaporSpecificAttenuationDbPerKm(40, 15, 50);
  assert.ok(at22 > at5, "22 GHz line should exceed 5 GHz baseline");
  assert.ok(at22 > at40, "22 GHz line should exceed 40 GHz baseline");
});

test("total absorption scales linearly with path length", () => {
  const f = 10;
  const t = 20;
  const rh = 60;
  const a1 = plugin.atmosphericAbsorptionDb(f, 1, t, rh);
  const a10 = plugin.atmosphericAbsorptionDb(f, 10, t, rh);
  const a100 = plugin.atmosphericAbsorptionDb(f, 100, t, rh);
  assert.ok(Math.abs(a10 - 10 * a1) < 1.0e-12);
  assert.ok(Math.abs(a100 - 100 * a1) < 1.0e-12);
});

test("WMO Magnus saturation vapor pressure matches reference points", () => {
  // At 0 °C, saturation vapor pressure ≈ 6.112 hPa (WMO No. 8 Annex 4.A.1
  // canonical value). Magnus form returns 6.112 exactly when T=0.
  const at0 = plugin.saturationVaporPressureHpa(0);
  assert.ok(Math.abs(at0 - 6.112) < 1.0e-3, `e_sat(0°C) = ${at0}`);

  // Saturation pressure increases monotonically with temperature.
  const seq = [-10, 0, 10, 20, 30, 40].map((t) =>
    plugin.saturationVaporPressureHpa(t),
  );
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] > seq[i - 1], `e_sat not monotonic at index ${i}`);
  }
});

test("rejects non-finite inputs by returning 0.0", () => {
  assert.equal(plugin.oxygenSpecificAttenuationDbPerKm(Number.NaN, 15), 0);
  assert.equal(
    plugin.waterVaporSpecificAttenuationDbPerKm(10, Number.NaN, 50),
    0,
  );
  assert.equal(plugin.atmosphericAbsorptionDb(10, -1, 15, 50), 0);
});
