// rf-fspl Node native-test-runner harness.
// Loads the compiled WASM module and exercises both formula forms against
// fixture vectors derived from ITU-R P.525-4 worked examples.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRfFsplPlugin } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fspl_p525.json");

let plugin;

test.before(async () => {
  plugin = await createRfFsplPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-fspl");
});

test("rejects invalid inputs by returning 0.0", () => {
  assert.equal(plugin.fsplFriis(0, 1.0e9), 0.0);
  assert.equal(plugin.fsplFriis(1000, 0), 0.0);
  assert.equal(plugin.fsplFriis(-1, 1.0e9), 0.0);
  assert.equal(plugin.fsplFriis(Number.NaN, 1.0e9), 0.0);
  assert.equal(plugin.fsplItuP525(0, 1000), 0.0);
});

test("Friis and ITU-R P.525 forms agree to 1e-12 dB at every fixture point", async () => {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw);
  for (const vector of fixture.vectors) {
    const friis = plugin.fsplFriis(
      vector.inputs.range_m,
      vector.inputs.frequency_hz,
    );
    const itu = plugin.fsplItuP525(
      vector.inputs.range_m / 1000.0,
      vector.inputs.frequency_hz / 1.0e6,
    );
    // Different code paths must agree to within IEEE-754 precision.
    assert.ok(
      Math.abs(friis - itu) < 1.0e-12,
      `Friis vs ITU disagree at ${vector.id}: ${friis} vs ${itu}`,
    );
  }
});

test("matches ITU-R P.525-4 fixture values within stated tolerance", async () => {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw);
  const tolerance = fixture.tolerance_db;
  for (const vector of fixture.vectors) {
    const actual = plugin.fsplFriis(
      vector.inputs.range_m,
      vector.inputs.frequency_hz,
    );
    const deviation = Math.abs(actual - vector.expected.loss_db);
    assert.ok(
      deviation <= tolerance,
      `${vector.id} deviation ${deviation} dB exceeds tolerance ${tolerance} dB (actual=${actual}, expected=${vector.expected.loss_db})`,
    );
  }
});
