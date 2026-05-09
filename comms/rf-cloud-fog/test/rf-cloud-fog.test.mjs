// rf-cloud-fog Node native-test-runner harness.
// ITU-R P.840-9 Annex 1 double-Debye permittivity. Property-based
// suite — externally-sourced fixture vectors regenerated against ITU
// validation tables are a Phase 2 follow-up.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfCloudFogPlugin } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfCloudFogPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-cloud-fog");
});

test("specific attenuation coefficient is non-negative and finite", () => {
  for (const fGhz of [1, 5, 10, 30, 80, 150]) {
    for (const tC of [-10, 0, 10, 20]) {
      const kl = plugin.specificAttenuationCoeff(fGhz, tC);
      assert.ok(Number.isFinite(kl));
      assert.ok(kl >= 0, `K_l negative at ${fGhz} GHz, ${tC} °C: ${kl}`);
    }
  }
});

test("K_l increases with frequency through the microwave band", () => {
  const t = 0;
  const seq = [1, 5, 10, 20, 50].map((f) =>
    plugin.specificAttenuationCoeff(f, t),
  );
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(
      seq[i] > seq[i - 1],
      `K_l not monotonic in f at index ${i}: ${seq[i - 1]} → ${seq[i]}`,
    );
  }
});

test("total cloud attenuation is linear in liquid water density and path", () => {
  const f = 30;
  const t = 5;
  const baseline = plugin.attenuationDb(f, t, 0.5, 5);
  const doubleDensity = plugin.attenuationDb(f, t, 1.0, 5);
  const doublePath = plugin.attenuationDb(f, t, 0.5, 10);
  assert.ok(Math.abs(doubleDensity - 2 * baseline) < 1.0e-12);
  assert.ok(Math.abs(doublePath - 2 * baseline) < 1.0e-12);
});

test("zero density or path returns zero attenuation", () => {
  assert.equal(plugin.attenuationDb(30, 5, 0, 5), 0);
  assert.equal(plugin.attenuationDb(30, 5, 0.5, 0), 0);
});

test("rejects non-finite inputs by returning 0.0", () => {
  assert.equal(plugin.specificAttenuationCoeff(Number.NaN, 0), 0);
  assert.equal(plugin.attenuationDb(30, 5, -0.1, 1), 0);
});
