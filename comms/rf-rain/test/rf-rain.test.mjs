// rf-rain Node native-test-runner harness.
// ITU-R P.838-3 specific attenuation + P.530-18 path reduction +
// Crane piecewise. Property-based suite; full ITU validation-table
// fixture upgrade is a Phase 2 follow-up.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfRainPlugin } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfRainPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-rain");
});

test("specific attenuation is zero below 1 GHz (P.838-3 fit undefined)", () => {
  assert.equal(plugin.specificAttenuationDbPerKm(0.5, 25), 0);
  assert.equal(plugin.specificAttenuationDbPerKm(0.99, 25), 0);
  // Exactly at 1 GHz the fit kicks in.
  assert.ok(plugin.specificAttenuationDbPerKm(1.0, 25) > 0);
});

test("specific attenuation increases monotonically with rain rate", () => {
  const fGhz = 12;
  const seq = [1, 5, 10, 25, 50, 100].map((R) =>
    plugin.specificAttenuationDbPerKm(fGhz, R),
  );
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] > seq[i - 1]);
  }
});

test("specific attenuation increases monotonically with frequency in 1–40 GHz", () => {
  const R = 25;
  const seq = [1, 5, 10, 20, 40].map((f) =>
    plugin.specificAttenuationDbPerKm(f, R),
  );
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] > seq[i - 1]);
  }
});

test("P.530 path-reduced attenuation is below γ_R · d", () => {
  const fGhz = 12;
  const R = 25;
  const dKm = 20;
  const gammaR = plugin.specificAttenuationDbPerKm(fGhz, R);
  const A = plugin.attenuationDb(fGhz, R, dKm);
  const linear = gammaR * dKm;
  assert.ok(A > 0);
  assert.ok(
    A < linear,
    `path-reduced ${A} should be < linear γ_R·d ${linear}`,
  );
});

test("Crane piecewise attenuation is finite and positive in rain", () => {
  const A = plugin.attenuationCraneDb(12, 25, 10);
  assert.ok(Number.isFinite(A));
  assert.ok(A > 0);
});

test("Crane attenuation clamps at 22.5 km path length", () => {
  const A22 = plugin.attenuationCraneDb(12, 25, 22.5);
  const A40 = plugin.attenuationCraneDb(12, 25, 40);
  assert.ok(Math.abs(A22 - A40) < 1.0e-12, `clamp broken: ${A22} vs ${A40}`);
});

test("rejects non-finite inputs by returning 0.0", () => {
  assert.equal(plugin.specificAttenuationDbPerKm(Number.NaN, 25), 0);
  assert.equal(plugin.attenuationDb(12, -1, 10), 0);
  assert.equal(plugin.attenuationCraneDb(12, 25, -1), 0);
});
