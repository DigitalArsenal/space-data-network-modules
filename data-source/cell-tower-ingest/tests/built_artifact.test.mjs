// The committed build, as the module catalog will publish it: its embedded $PLG
// names this package, and its tile router answers a slippy-map tile with that
// tile's own Web Mercator rectangle.
//
// The artifact imports the space_data_module_host bridge (plugin.getConfig), so
// it runs in the SDK browser harness with the hostcall answered the way the node
// answers it. The SDK's WasmEdge lanes cannot link that bridge, and its real-
// browser lane cannot construct a host for it, so neither runs this artifact.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { embeddedPlgManifest } from "space-data-module-sdk/host/runtime-target-gate";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const wasm = fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));

test("the built artifact embeds this manifest's plugin id and version", () => {
  const embedded = embeddedPlgManifest(new WebAssembly.Module(wasm));
  assert.equal(embedded?.pluginId, manifest.pluginId);
  assert.equal(embedded?.version, manifest.version);
});

async function tilePlan(t, path) {
  const harness = await createBrowserModuleHarness({
    wasmSource: wasm,
    manifest,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return {};
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "tile_plan",
    inputs: [{ portId: "request", typeRef: HTTP_REQUEST_TYPE_REF, payload: encodeHttpRequest({ method: "GET", path, query: "", headers: {} }) }],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return new Map(response.outputs.map((o) => [o.portId, JSON.parse(Buffer.from(o.payload).toString("utf8"))]));
}

// Web Mercator's latitude limit, atan(sinh(pi)) in degrees = 85.0511287798066°.
// Tolerance 1e-12°: a few ulps of a double near 85, far below any tile edge.
const MERCATOR_MAX_LAT = 85.0511287798066;

test("tile_plan scopes tile 1/1/0 to its rectangle: lat [0, 85.0511287798066], lon [0, 180]", async (t) => {
  const out = await tilePlan(t, "/api/v1/cellular/tiles/1/1/0");
  const [south, north, west, east] = out.get("rows_query").params.map((p) => p.v);
  assert.ok(Math.abs(south - 0) < 1e-12, `south ${south}`);
  assert.ok(Math.abs(north - MERCATOR_MAX_LAT) < 1e-12, `north ${north}`);
  assert.equal(west, 0);
  assert.equal(east, 180);
  const job = out.get("tile_job");
  assert.deepEqual([job.z, job.x, job.y, job.scoped], [1, 1, 0, true]);
});

test("tile_plan refuses x = 2^z instead of clamping it to a neighbour", async (t) => {
  const job = (await tilePlan(t, "/api/v1/cellular/tiles/1/2/0")).get("tile_job");
  assert.equal(job.code, "tile-bounds");
});
