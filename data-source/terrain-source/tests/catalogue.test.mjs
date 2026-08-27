// THE CATALOGUE: how a client learns which tileset epoch to fetch.
//
// OWNER 2026-08-27: terrain files are requested over IPFS. The pyramid is one
// content-addressed directory per epoch, and a client points a native terrain
// provider at <gateway>/ipfs/<cid>/. The CID is the one thing a client cannot
// derive, must not hardcode (a hardcoded CID is pinned to a dead epoch the day
// the dataset is recut) and must not learn from a hostname (the owner refused
// a static asset hostname on the same day).
//
// So the mount answers ONE question at its root: which directory is current.
// These tests hold that answer to the shape the clients read, and hold the
// FALLBACK honest — a node with no CID configured says so, and says the mount
// path instead, which is what makes a development node with no IPFS daemon
// work unchanged.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const decoder = new TextDecoder();

const CID = "bafybeifkp4sq2qcw7chfcdolv4tdyjpicfzxj6lp76dbpwuvsux43bycje";

const BASE = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 13,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  terrain_attribution: "Copernicus DEM",
  terrain_version: "1.0.0",
};
const OVER_IPFS = {
  ...BASE,
  terrain_tileset_cid: CID,
  terrain_dataset_epoch: "2023-04-01T00:00:00.000Z",
  terrain_gateway_origin: "https://sdn.spaceaware.io",
};

async function get(t, path, config, headers = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({ method: "GET", path, headers }),
      },
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const out = response.outputs.find((o) => o.portId === "response");
  assert.ok(out, `route produced no direct response for ${path}`);
  const http = decodeHttpResponse(new Uint8Array(out.payload));
  const headerOf = (name) =>
    (http.headers ?? []).find((h) => h.name?.toLowerCase() === name)?.value ?? "";
  return { http, headerOf, body: () => JSON.parse(decoder.decode(http.body)) };
}

test("the mount root names the CID a client should fetch tiles from", async (t) => {
  const { http, headerOf, body } = await get(t, "/api/v1/terrain/", OVER_IPFS);
  assert.equal(http.status, 200);
  const doc = body();
  assert.equal(doc.delivery, "ipfs");
  assert.equal(doc.cid, CID);
  // The path is RELATIVE so a client joins it against the node origin it is
  // already talking to. Nothing here names a host a client has to trust.
  assert.equal(doc.terrainBasePath, `/ipfs/${CID}/`);
  assert.equal(doc.layerJsonPath, `/ipfs/${CID}/layer.json`);
  assert.equal(doc.terrainBaseUrl, `https://sdn.spaceaware.io/ipfs/${CID}/`);
  assert.equal(doc.tilesetId, "spaceaware-terrain");
  assert.equal(doc.datasetEpoch, "2023-04-01T00:00:00.000Z");
  assert.equal(doc.maxzoom, 13);
  assert.equal(doc.format, "quantized-mesh-1.0");
  assert.equal(doc.scheme, "tms");
  assert.deepEqual(doc.extensions, ["watermask"]);
  assert.equal(doc.attribution, "Copernicus DEM");
  assert.equal(headerOf("content-type"), "application/json");
  // A minute: everything under a CID is immutable, and this is the lane's one
  // mutable pointer.
  assert.equal(headerOf("cache-control"), "public, max-age=60");
  assert.equal(headerOf("access-control-allow-origin"), "*");
  assert.match(headerOf("etag"), /^"[0-9a-f]+"$/);
});

test("/catalogue.json is the same document under an explicit name", async (t) => {
  const root = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const named = await get(t, "/api/v1/terrain/catalogue.json", OVER_IPFS);
  assert.equal(named.http.status, 200);
  assert.deepEqual(named.body(), root.body());
  assert.equal(named.headerOf("etag"), root.headerOf("etag"));
});

test("a revalidation of the pointer is a 304", async (t) => {
  const first = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const etag = first.headerOf("etag");
  const again = await get(t, "/api/v1/terrain/", OVER_IPFS, { "if-none-match": etag });
  assert.equal(again.http.status, 304);
  assert.equal(again.http.body.length, 0);
});

test("a node with no CID configured says so, and names its own mount", async (t) => {
  const { http, body } = await get(t, "/api/v1/terrain/", BASE);
  assert.equal(http.status, 200);
  const doc = body();
  // NOT a 404 and NOT a fabricated CID: a development node with no IPFS daemon
  // serves its own tiles, and the client reads one document either way.
  assert.equal(doc.delivery, "mount");
  assert.equal(doc.cid, null);
  assert.equal(doc.datasetEpoch, null);
  assert.equal(doc.terrainBasePath, "/api/v1/terrain/");
  assert.equal(doc.layerJsonPath, "/api/v1/terrain/layer.json");
  assert.ok(!("terrainBaseUrl" in doc), "no absolute URL without a gateway origin");
});

test("the pointer moves when the epoch does", async (t) => {
  const other = "bafybeia7a7l77nmng2zqseebbmzl6mdxprsvrgg7udsatoner6yfexwpny";
  const a = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const b = await get(t, "/api/v1/terrain/", { ...OVER_IPFS, terrain_tileset_cid: other });
  assert.notEqual(a.body().cid, b.body().cid);
  // A stale ETag must not revalidate against the new epoch, or a client holding
  // the old pointer never learns the tileset was recut.
  assert.notEqual(a.headerOf("etag"), b.headerOf("etag"));
});

test("the catalogue does not shadow the tile and layer.json routes", async (t) => {
  const layer = await get(t, "/api/v1/terrain/layer.json", OVER_IPFS).catch(() => null);
  // layer.json leaves through the layer_plan port, not `response`, so the
  // helper's assertion failing IS the evidence the route still belongs to it.
  assert.equal(layer, null, "layer.json must still be planned, not answered here");
});

test("layer.json states the tiles template the mount configures", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") {
        // What the IPFS publisher configures: a CID needs no `?v=` cache-key
        // query, because the CID is already the cache key.
        return { ...BASE, terrain_tiles_template: "{z}/{x}/{y}.terrain" };
      }
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: "/api/v1/terrain/layer.json",
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  const plan = routed.outputs.find((o) => o.portId === "layer_plan");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength },
        payload: plan.payload,
      },
    ],
  });
  assert.equal(rendered.statusCode, 0, `${rendered.errorCode}: ${rendered.errorMessage}`);
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  const doc = JSON.parse(decoder.decode(http.body));
  assert.deepEqual(doc.tiles, ["{z}/{x}/{y}.terrain"]);
  assert.deepEqual(doc.extensions, ["watermask"]);
  assert.equal(doc.scheme, "tms");
  assert.equal(doc.format, "quantized-mesh-1.0");
});

test("the default tiles template is unchanged for a mount-served tileset", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return BASE;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: "/api/v1/terrain/layer.json",
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  const plan = routed.outputs.find((o) => o.portId === "layer_plan");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength },
        payload: plan.payload,
      },
    ],
  });
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  const doc = JSON.parse(decoder.decode(http.body));
  assert.deepEqual(doc.tiles, ["{z}/{x}/{y}.terrain?v={version}"]);
});
