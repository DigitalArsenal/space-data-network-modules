// The committed build, as the module catalog will publish it: its embedded $PLG names this package, and its tile
// router answers a slippy-map tile with that tile's own Web Mercator rectangle (typed: the row read is an $FSO with
// four float64 bounds and the int64 row budget, the job an $APR).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";

import { MANIFEST_PATH, WASM_PATH, createHarness, decodeFso, htq, ok, one, params, read } from "./helpers.mjs";

const wasm = fs.readFileSync(WASM_PATH);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

test("the built artifact embeds this manifest's plugin id and version", () => {
  const embedded = embeddedPlgManifest(new WebAssembly.Module(wasm));
  assert.equal(embedded?.pluginId, manifest.pluginId);
  assert.equal(embedded?.version, "0.2.0");
  assert.equal(manifest.version, "0.2.0");
});

// Web Mercator's latitude limit, atan(sinh(pi)) in degrees = 85.0511287798066°.
// Tolerance 1e-12°: a few ulps of a double near 85, far below any tile edge.
const MERCATOR_MAX_LAT = 85.0511287798066;

test("tile_plan scopes tile 1/1/0 to its rectangle: lat [0, 85.0511287798066], lon [0, 180]", async (t) => {
  const harness = await createHarness(t);
  const response = ok(await harness.invoke({ methodId: "tile_plan", inputs: [htq("/api/v1/cellular/tiles/1/1/0")] }));
  const rows = decodeFso(one(response, "rows_query"));
  assert.match(rows.sql, /^SELECT _data FROM TBS WHERE LATITUDE >= \?1 AND LATITUDE <= \?2 AND LONGITUDE >= \?3 AND LONGITUDE <= \?4 ORDER BY _rowid DESC LIMIT \?5$/);
  const [south, north, west, east, budget] = rows.params;
  assert.deepEqual([south.t, north.t, west.t, east.t, budget.t], ["f64", "f64", "f64", "f64", "i64"]);
  assert.ok(Math.abs(south.v - 0) < 1e-12, `south ${south.v}`);
  assert.ok(Math.abs(north.v - MERCATOR_MAX_LAT) < 1e-12, `north ${north.v}`);
  assert.equal(west.v, 0);
  assert.equal(east.v, 180);
  assert.equal(budget.v, 25000);
  const job = read("APR", one(response, "tile_job"));
  assert.deepEqual(params(job.PARAMETERS), { z: "1", x: "1", y: "0", maxRows: "25000", scoped: "true", provider: "opencellid" });
});

test("tile_plan refuses x = 2^z instead of clamping it to a neighbour", async (t) => {
  const harness = await createHarness(t);
  const response = ok(await harness.invoke({ methodId: "tile_plan", inputs: [htq("/api/v1/cellular/tiles/1/2/0")] }));
  assert.deepEqual(response.outputs.map((f) => f.portId), ["refusal"]);
  const refusal = read("APR", one(response, "refusal"));
  assert.equal(refusal.STATUS, 400);
  assert.equal(refusal.ERROR_CODE, "tile-bounds");
});
