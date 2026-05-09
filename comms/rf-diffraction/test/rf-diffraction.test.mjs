// rf-diffraction Node native-test-runner harness.
// ITU-R P.526-15 §4 knife-edge + Vogler J(v) approximation +
// host-orchestrated Deygout multi-knife recursion.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfDiffractionPlugin } from "../index.js";

let plugin;
const C_MS = 299792458;

test.before(async () => {
  plugin = await createRfDiffractionPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-diffraction");
});

test("knife-edge loss at v=0 is approximately 6.02 dB (P.526 Eq. 30)", () => {
  // Standard ITU-R P.526 reference: J(0) = 6.02 dB.
  const loss = plugin.knifeEdgeLossDb(0);
  assert.ok(
    Math.abs(loss - 6.02) < 0.05,
    `J(0) expected ~6.02 dB, got ${loss}`,
  );
});

test("knife-edge loss is 0 dB for v ≤ -0.78 (LOS regime)", () => {
  assert.equal(plugin.knifeEdgeLossDb(-0.78), 0);
  assert.equal(plugin.knifeEdgeLossDb(-1), 0);
  assert.equal(plugin.knifeEdgeLossDb(-5), 0);
});

test("knife-edge loss is monotonically non-decreasing for v ≥ 0", () => {
  const samples = [0, 0.5, 1, 1.5, 2, 3, 5, 10].map((v) =>
    plugin.knifeEdgeLossDb(v),
  );
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(
      samples[i] >= samples[i - 1] - 1.0e-9,
      `J(v) not monotonic at ${i}: ${samples[i - 1]} → ${samples[i]}`,
    );
  }
});

test("Earth curvature drop is zero when factor non-finite/zero", () => {
  assert.equal(plugin.curvatureDropM(10000, 0), 0);
});

test("Earth curvature drop scales as d^2 / (2 k a)", () => {
  // For k=4/3 and Earth radius a=6371 km, drop at 10 km ≈ 5.88 m.
  const drop = plugin.curvatureDropM(10000, 4 / 3);
  assert.ok(drop > 5);
  assert.ok(drop < 7);
  // Doubling distance quadruples drop.
  const drop20 = plugin.curvatureDropM(20000, 4 / 3);
  assert.ok(Math.abs(drop20 / drop - 4) < 1.0e-6);
});

test("Fresnel-Kirchhoff v scales sqrt with geometry", () => {
  const wavelength = C_MS / 1.0e9; // 1 GHz
  const v1 = plugin.fresnelKirchhoffV(10, 1000, 1000, wavelength);
  // Doubling clearance doubles v.
  const v2 = plugin.fresnelKirchhoffV(20, 1000, 1000, wavelength);
  assert.ok(Math.abs(v2 - 2 * v1) < 1.0e-9);
});

test("knifeEdgeParameterV produces v with same sign as obstacle clearance", () => {
  // Obstacle above LOS line → positive v (loss).
  const wavelength = C_MS / 1.0e9;
  const above = plugin.knifeEdgeParameterV({
    startDistanceM: 0,
    startHeightM: 30,
    endDistanceM: 10000,
    endHeightM: 30,
    obstacleDistanceM: 5000,
    obstacleHeightM: 50, // 20 m above straight LOS
    wavelengthM: wavelength,
  });
  assert.ok(above > 0);
  // Obstacle below LOS line → negative v (no loss).
  const below = plugin.knifeEdgeParameterV({
    startDistanceM: 0,
    startHeightM: 30,
    endDistanceM: 10000,
    endHeightM: 30,
    obstacleDistanceM: 5000,
    obstacleHeightM: 10, // 20 m below straight LOS
    wavelengthM: wavelength,
  });
  assert.ok(below < 0);
});

test("Deygout multi-knife reduces to single-knife with one obstacle", () => {
  const wavelength = C_MS / 1.0e9;
  const opts = {
    startDistanceM: 0,
    startHeightM: 30,
    endDistanceM: 10000,
    endHeightM: 30,
    wavelengthM: wavelength,
  };
  const v = plugin.knifeEdgeParameterV({
    ...opts,
    obstacleDistanceM: 5000,
    obstacleHeightM: 60,
  });
  const single = plugin.knifeEdgeLossDb(v);
  const deygout = plugin.multiKnifeEdgeDeygoutLossDb({
    ...opts,
    obstacles: [{ distance: 5000, height: 60 }],
  });
  assert.ok(Math.abs(deygout - single) < 1.0e-9);
});

test("Deygout multi-knife with no obstacles returns 0", () => {
  assert.equal(
    plugin.multiKnifeEdgeDeygoutLossDb({
      startDistanceM: 0,
      startHeightM: 30,
      endDistanceM: 10000,
      endHeightM: 30,
      obstacles: [],
      wavelengthM: C_MS / 1.0e9,
    }),
    0,
  );
});
