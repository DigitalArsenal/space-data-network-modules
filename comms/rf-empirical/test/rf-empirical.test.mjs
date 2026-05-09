// Node native-test-runner harness for rf-empirical.
// Loads the compiled WASM and exercises three model families against
// fixture vectors derived from Rappaport §4.6.2 / §4.10 (two-ray + Hata)
// and COST 231 Final Report §4.4.3 (COST-231 Hata extension).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRfEmpiricalPlugin } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TWO_RAY_FIXTURE = join(__dirname, "fixtures", "two_ray_rappaport.json");
const HATA_FIXTURE = join(__dirname, "fixtures", "hata.json");
const COST231_FIXTURE = join(__dirname, "fixtures", "cost231.json");

let plugin;

test.before(async () => {
  plugin = await createRfEmpiricalPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-empirical");
});

test("rejects invalid inputs by returning 0.0", () => {
  // two-ray
  assert.equal(plugin.twoRayGroundLossDb(0, 30, 2, 1.0e9), 0.0);
  assert.equal(plugin.twoRayGroundLossDb(1000, 0, 2, 1.0e9), 0.0);
  assert.equal(plugin.twoRayGroundLossDb(1000, 30, 2, 0), 0.0);
  // Hata urban
  assert.equal(plugin.hataUrbanLossDb(0, 30, 2, 5), 0.0);
  assert.equal(plugin.hataUrbanLossDb(900, 30, 2, 0), 0.0);
  // COST-231
  assert.equal(plugin.cost231LossDb(0, 50, 2, 5, true), 0.0);
});

test("two-ray matches fixture vectors", async () => {
  const raw = await readFile(TWO_RAY_FIXTURE, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_db;
  for (const vector of fixture.vectors) {
    const actual = plugin.twoRayGroundLossDb(
      vector.inputs.range_m,
      vector.inputs.tx_height_m,
      vector.inputs.rx_height_m,
      vector.inputs.frequency_hz,
    );
    const deviation = Math.abs(actual - vector.expected.loss_db);
    assert.ok(
      deviation <= tolerance,
      `${vector.id}: deviation ${deviation} dB exceeds tolerance ${tolerance} dB (actual=${actual}, expected=${vector.expected.loss_db})`,
    );
  }
});

test("Hata urban / suburban / rural match fixture vectors", async () => {
  const raw = await readFile(HATA_FIXTURE, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_db;
  const dispatch = {
    urban: plugin.hataUrbanLossDb,
    suburban: plugin.hataSuburbanLossDb,
    rural: plugin.hataRuralLossDb,
  };
  for (const vector of fixture.vectors) {
    const fn = dispatch[vector.model_variant];
    assert.ok(fn, `Unknown Hata variant in fixture: ${vector.model_variant}`);
    const actual = fn(
      vector.inputs.frequency_mhz,
      vector.inputs.tx_height_m,
      vector.inputs.rx_height_m,
      vector.inputs.range_km,
    );
    const deviation = Math.abs(actual - vector.expected.loss_db);
    assert.ok(
      deviation <= tolerance,
      `${vector.id}: deviation ${deviation} dB exceeds tolerance ${tolerance} dB (actual=${actual}, expected=${vector.expected.loss_db})`,
    );
  }
});

test("Hata correction relations: suburban = urban − [2·(log10(f/28))² + 5.4]", () => {
  const cases = [
    [900, 30, 2, 5],
    [1500, 100, 3, 10],
    [600, 50, 1.5, 8],
  ];
  for (const [f, ht, hr, dkm] of cases) {
    const u = plugin.hataUrbanLossDb(f, ht, hr, dkm);
    const s = plugin.hataSuburbanLossDb(f, ht, hr, dkm);
    const lf = Math.log10(f / 28.0);
    const expectedDiff = 2.0 * lf * lf + 5.4;
    assert.ok(
      Math.abs((u - s) - expectedDiff) < 1.0e-9,
      `Suburban correction off at ${f}/${dkm}: u-s=${u - s}, expected ${expectedDiff}`,
    );
  }
});

test("COST-231 metropolitan = suburban + 3 dB", async () => {
  const raw = await readFile(COST231_FIXTURE, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_db;
  for (const vector of fixture.vectors) {
    const actual = plugin.cost231LossDb(
      vector.inputs.frequency_mhz,
      vector.inputs.tx_height_m,
      vector.inputs.rx_height_m,
      vector.inputs.range_km,
      vector.metropolitan,
    );
    const deviation = Math.abs(actual - vector.expected.loss_db);
    assert.ok(
      deviation <= tolerance,
      `${vector.id}: deviation ${deviation} dB exceeds tolerance ${tolerance} dB (actual=${actual}, expected=${vector.expected.loss_db})`,
    );
  }

  // Property: metropolitan correction is exactly +3 dB.
  const cases = [
    [1800, 50, 2, 5],
    [2000, 30, 1.5, 2],
  ];
  for (const [f, ht, hr, dkm] of cases) {
    const metro = plugin.cost231LossDb(f, ht, hr, dkm, true);
    const sub = plugin.cost231LossDb(f, ht, hr, dkm, false);
    assert.ok(
      Math.abs(metro - sub - 3.0) < 1.0e-9,
      `COST-231 metro-correction off at ${f}/${dkm}: metro - sub = ${metro - sub}`,
    );
  }
});
