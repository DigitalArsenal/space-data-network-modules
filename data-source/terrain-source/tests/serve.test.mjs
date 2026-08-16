// Serving-pair correctness: route ($HTQ -> query/layer_plan/404) and respond
// ($DTT stream -> $HTR). The stored record under test is produced by the
// module's own `tile` method, so the serve path is exercised against exactly
// the bytes the ingest path stores.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { buildGeoTiff, decodeQuantizedMesh, splitStream } from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 8,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  terrain_attribution: "test attribution",
};

function frame(portId, payload) {
  const bytes =
    typeof payload === "string"
      ? encoder.encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

async function invoke(t, methodId, inputs, config = CONFIG) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) map.set(out.portId, out.payload);
  return map;
}

const asJson = (bytes) => JSON.parse(decoder.decode(bytes));

const requestFrame = (path, { method = "GET", headers = {} } = {}) => ({
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  payload: encodeHttpRequest({ method, path, headers }),
});

// One stored $DTT record, produced by the module's own encoder: [u32 len]
// [plain $DTT] — exactly the stream framing tile emits and storage ingests.
async function storedRecordStream(t) {
  const tiff = buildGeoTiff({
    width: 64,
    height: 64,
    originLon: 10.5,
    originLat: 45.8,
    scaleLon: 0.8 / 63,
    scaleLat: 0.9 / 63,
    heightFn: (px, py) => 100 + px + 2 * py,
  });
  const outputs = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", {
        tilesetId: "spaceaware-terrain",
        level: 8,
        x: 271,
        y: 192,
        gridSize: 33,
        maxLevel: 8,
        childAvailability: 0,
        provenance: {
          datasetId: "cop-dem-glo-30",
          datasetEpoch: "2023-04-01T00:00:00.000Z",
          retrievedAt: "2026-08-15T12:00:00.000Z",
          license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
        },
      }),
      jsonFrame("dem", { status: 200, headers: {}, bodyB64: Buffer.from(tiff).toString("base64") }),
    ]),
  );
  return Buffer.from(outputs.get("records"));
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

test("route turns a tile path into the DTT select plus serve context", async (t) => {
  const response = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/8/271/192.terrain", {
      headers: { "if-none-match": 'W/"probe"' },
    }),
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = new Map(response.outputs.map((o) => [o.portId, o.payload]));
  assert.deepEqual([...outputs.keys()].sort(), ["context", "query"]);
  const query = asJson(outputs.get("query"));
  assert.equal(
    query.sql,
    "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? ORDER BY rowid DESC LIMIT 1",
  );
  assert.deepEqual(query.params, [
    { t: "str", v: "spaceaware-terrain" },
    { t: "i64", v: 8 },
    { t: "i64", v: 271 },
    { t: "i64", v: 192 },
  ]);
  const context = asJson(outputs.get("context"));
  assert.deepEqual(context, {
    tilesetId: "spaceaware-terrain",
    level: 8,
    x: 271,
    y: 192,
    ifNoneMatch: 'W/"probe"',
  });
});

test("route turns layer.json into the config-derived layer plan", async (t) => {
  const response = await invoke(t, "route", [requestFrame("/api/v1/terrain/layer.json")]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "layer_plan");
  const plan = asJson(response.outputs[0].payload);
  assert.equal(plan.tilesetId, "spaceaware-terrain");
  assert.equal(plan.maxzoom, 8);
  assert.deepEqual(plan.available, CONFIG.terrain_available, "availability rides verbatim");
  assert.equal(plan.attribution, "test attribution");

  // …and layer_json accepts exactly that plan.
  const layer = await invoke(t, "layer_json", [frame("plan", response.outputs[0].payload)]);
  assert.equal(layer.statusCode, 0);
  const http = decodeHttpResponse(new Uint8Array(layer.outputs[0].payload));
  const body = JSON.parse(Buffer.from(http.body).toString("utf8"));
  assert.equal(body.maxzoom, 8);
  assert.deepEqual(body.available, CONFIG.terrain_available);
});

test("route without configured availability defaults to the two level-0 roots only", async (t) => {
  const response = await invoke(t, "route", [requestFrame("/api/v1/terrain/layer.json")], {});
  const plan = asJson(response.outputs[0].payload);
  assert.equal(plan.tilesetId, "spaceaware-terrain");
  assert.equal(plan.maxzoom, 0, "no config = a pyramid of exactly the roots");
  assert.deepEqual(plan.available, [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]]);
});

test("route answers unknown paths with a cacheable 404 and bad verbs with 405", async (t) => {
  for (const path of [
    "/api/v1/terrain/nope",
    "/api/v1/terrain/8/271/192.png",
    "/api/v1/terrain/8/271.terrain",
    "/api/v1/terrain/a/b/c.terrain",
    "/somewhere/else",
  ]) {
    const response = await invoke(t, "route", [requestFrame(path)]);
    assert.equal(response.statusCode, 0, `${path}: a 404 is an answer, not an error`);
    assert.equal(response.outputs.length, 1);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 404, path);
    assert.equal(
      http.headers.find((h) => h.name === "cache-control")?.value,
      "public, max-age=300",
      "a miss is normal traffic and must be cacheable",
    );
  }
  const post = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/layer.json", { method: "POST" }),
  ]);
  const http = decodeHttpResponse(new Uint8Array(post.outputs[0].payload));
  assert.equal(http.status, 405);
  assert.equal(http.headers.find((h) => h.name === "allow")?.value, "GET, HEAD");
});

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

test("respond serves the stored record verbatim with record-stated headers", async (t) => {
  const stream = await storedRecordStream(t);
  const response = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 8, x: 271, y: 192, ifNoneMatch: "" }),
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 200);
  const headerOf = (name) => http.headers.find((h) => h.name === name)?.value;
  assert.equal(headerOf("content-type"), "application/vnd.quantized-mesh");
  assert.equal(headerOf("content-encoding"), "gzip", "the stored bytes are already gzipped");
  assert.equal(headerOf("cache-control"), "public, max-age=86400");
  const etag = headerOf("etag");
  assert.ok(etag && etag.startsWith('W/"dtt-8-271-192-'), "weak address+size tag when the record states none");

  // The served body IS the record's payload: it gunzips to a valid
  // quantized-mesh whose vertex count matches the encode plan.
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(http.body)));
  assert.equal(mesh.vertexCount, 33 * 33);

  // …and a conditional request with the served etag answers 304, bodiless.
  const conditional = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 8, x: 271, y: 192, ifNoneMatch: etag }),
  ]);
  const notModified = decodeHttpResponse(new Uint8Array(conditional.outputs[0].payload));
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  assert.equal(
    notModified.headers.find((h) => h.name === "etag")?.value,
    etag,
    "the 304 restates the entity tag",
  );
});

test("respond answers an empty stream with a cheap cacheable 404, never an error", async (t) => {
  // The flatsql stream for zero rows: nothing but alignment padding.
  const response = await invoke(t, "respond", [
    frame("stream", new Uint8Array(4)),
    jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 12, x: 0, y: 0, ifNoneMatch: "" }),
  ]);
  assert.equal(response.statusCode, 0, "an unpublished tile is normal traffic");
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 404);
  assert.equal(
    http.headers.find((h) => h.name === "cache-control")?.value,
    "public, max-age=300",
  );
});

test("respond refuses a stream frame that is not a $DTT record", async (t) => {
  const garbage = Buffer.alloc(24);
  garbage.writeUInt32LE(20, 0); // says 20 bytes of record follow
  garbage.write("NOT A FLATBUFFER!!!", 4, "latin1");
  const response = await invoke(t, "respond", [frame("stream", new Uint8Array(garbage))]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-dtt-frame");
});

test("the module's own record stream framing is what respond consumes (boundary-exact)", async (t) => {
  const stream = await storedRecordStream(t);
  assert.equal(splitStream(stream).length, 1, "one record, boundary-exact");
});
