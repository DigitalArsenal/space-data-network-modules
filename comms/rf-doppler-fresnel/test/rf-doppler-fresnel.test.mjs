// Node native-test-runner harness for rf-doppler-fresnel.
// Loads the compiled WASM module and exercises both kernels against
// fixture vectors derived from Sklar §1.3.2 (Doppler) and ITU-R P.526-15
// §3 (Fresnel-zone radius).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRfDopplerFresnelPlugin } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOPPLER_FIXTURE = join(__dirname, "fixtures", "doppler.json");
const FRESNEL_FIXTURE = join(__dirname, "fixtures", "fresnel_p526.json");

let plugin;

test.before(async () => {
  plugin = await createRfDopplerFresnelPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-doppler-fresnel");
});

test("Doppler returns 0.0 for invalid inputs", () => {
  assert.equal(plugin.dopplerShiftHz(7500, 0), 0.0);
  assert.equal(plugin.dopplerShiftHz(7500, -1), 0.0);
  assert.equal(plugin.dopplerShiftHz(Number.NaN, 1.0e9), 0.0);
  assert.equal(plugin.dopplerShiftHz(7500, Number.NaN), 0.0);
});

test("Fresnel returns 0.0 for invalid inputs", () => {
  assert.equal(plugin.fresnelZoneRadiusM(0, 1000, 1.0e9, 1), 0.0);
  assert.equal(plugin.fresnelZoneRadiusM(1000, 0, 1.0e9, 1), 0.0);
  assert.equal(plugin.fresnelZoneRadiusM(1000, 1000, 0, 1), 0.0);
  assert.equal(plugin.fresnelZoneRadiusM(1000, 1000, 1.0e9, 0), 0.0);
  assert.equal(plugin.fresnelZoneRadiusM(-1, 1000, 1.0e9, 1), 0.0);
  assert.equal(plugin.fresnelZoneRadiusM(1000, 1000, Number.NaN, 1), 0.0);
});

test("Doppler matches Sklar §1.3.2 fixture vectors", async () => {
  const raw = await readFile(DOPPLER_FIXTURE, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_hz;
  for (const vector of fixture.vectors) {
    const actual = plugin.dopplerShiftHz(
      vector.inputs.relative_velocity_mps,
      vector.inputs.frequency_hz,
    );
    const deviation = Math.abs(actual - vector.expected.shift_hz);
    assert.ok(
      deviation <= tolerance,
      `${vector.id} deviation ${deviation} Hz exceeds tolerance ${tolerance} Hz (actual=${actual}, expected=${vector.expected.shift_hz})`,
    );
  }
});

test("Doppler is linear and antisymmetric in velocity", () => {
  const f = 2.0e9;
  for (const v of [1.0, 27.0, 7500.0, 1.0e6]) {
    const positive = plugin.dopplerShiftHz(v, f);
    const negative = plugin.dopplerShiftHz(-v, f);
    assert.ok(
      Math.abs(positive + negative) < 1.0e-6,
      `Antisymmetry failed at v=${v}: ${positive} + ${negative} != 0`,
    );
    const doubled = plugin.dopplerShiftHz(2.0 * v, f);
    assert.ok(
      Math.abs(doubled - 2.0 * positive) < 1.0e-6,
      `Linearity failed at v=${v}: f(2v) - 2*f(v) = ${doubled - 2.0 * positive}`,
    );
  }
});

test("Fresnel matches ITU-R P.526-15 §3 fixture vectors", async () => {
  const raw = await readFile(FRESNEL_FIXTURE, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_m;
  for (const vector of fixture.vectors) {
    const actual = plugin.fresnelZoneRadiusM(
      vector.inputs.d1_m,
      vector.inputs.d2_m,
      vector.inputs.frequency_hz,
      vector.inputs.zone,
    );
    const deviation = Math.abs(actual - vector.expected.radius_m);
    assert.ok(
      deviation <= tolerance,
      `${vector.id} deviation ${deviation} m exceeds tolerance ${tolerance} m (actual=${actual}, expected=${vector.expected.radius_m})`,
    );
  }
});

test("Fresnel zone radii scale as √n", () => {
  const d1 = 1000.0;
  const d2 = 1000.0;
  const f = 1.0e9;
  const r1 = plugin.fresnelZoneRadiusM(d1, d2, f, 1);
  for (const n of [2, 3, 5, 9, 16]) {
    const rn = plugin.fresnelZoneRadiusM(d1, d2, f, n);
    const expected = r1 * Math.sqrt(n);
    assert.ok(
      Math.abs(rn - expected) < 1.0e-9,
      `Zone scaling failed at n=${n}: got ${rn}, expected ${expected}`,
    );
  }
});

test("Fresnel is symmetric in d1, d2", () => {
  const f = 2.4e9;
  for (const [d1, d2] of [
    [500, 2000],
    [100, 9000],
    [333, 6667],
  ]) {
    const ab = plugin.fresnelZoneRadiusM(d1, d2, f, 1);
    const ba = plugin.fresnelZoneRadiusM(d2, d1, f, 1);
    assert.ok(
      Math.abs(ab - ba) < 1.0e-12,
      `Symmetry failed at d1=${d1} d2=${d2}: ${ab} vs ${ba}`,
    );
  }
});
