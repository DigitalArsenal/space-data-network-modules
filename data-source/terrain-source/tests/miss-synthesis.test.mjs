// ATLAS: a store miss must NEVER reach the browser as a 404.
//
// layer.json's `available` is a PROMISE. The client plans every request against
// it: it asks for exactly what the tileset said exists and nothing else. So an
// address inside `available` that the store cannot answer is not a miss, it is
// a broken promise — and a native CesiumTerrainProvider meeting one gets a
// rejected tile promise, a hole in the globe and a console full of failures.
//
// The encoder never STORES an all-ocean tile (they are identical and there are
// millions of them), which is what makes the resolution honest rather than a
// papered-over error: an address the tileset published and the store does not
// hold IS ocean, so the server synthesizes exactly that — height 0 everywhere,
// UNIFORM_WATER — and says so on the wire with x-terrain-synthesized.
//
// Outside `available`, nothing was promised, and a miss stays the cheap
// cacheable 404 it always was.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { decodeQuantizedMesh } from "./helpers.mjs";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A published pyramid: level 0's two roots, and a small z11 region.
const Z11 = { startX: 2162, startY: 1536, endX: 2172, endY: 1546 };
const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 11,
  terrain_available: [
    [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
    ...Array.from({ length: 10 }, () => []),
    [Z11],
  ],
};

const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

async function withHarness(t, config = CONFIG) {
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness;
}

// route the path, then hand route's own context to respond with an EMPTY store
// stream — the exact wiring the compiled flow produces on a store miss.
async function serveMiss(t, path, { ifNoneMatch } = {}) {
  const harness = await withHarness(t);
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path,
          headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
        }),
      },
    ],
  });
  assert.equal(routed.statusCode, 0, `${routed.errorCode}: ${routed.errorMessage}`);
  const context = routed.outputs.find((o) => o.portId === "context");
  if (!context) return { direct: decodeHttpResponse(new Uint8Array(routed.outputs[0].payload)) };
  const responded = await harness.invoke({
    methodId: "respond",
    // The flatsql stream for zero rows: nothing but alignment padding.
    inputs: [frame("stream", new Uint8Array(4)), frame("context", context.payload)],
  });
  assert.equal(responded.statusCode, 0, `${responded.errorCode}: ${responded.errorMessage}`);
  return {
    context: JSON.parse(decoder.decode(context.payload)),
    http: decodeHttpResponse(new Uint8Array(responded.outputs[0].payload)),
  };
}

const headerOf = (http, name) => http.headers.find((h) => h.name === name)?.value;

test("a miss INSIDE availability is served as synthesized ocean, never a 404", async (t) => {
  const { context, http } = await serveMiss(t, "/api/v1/terrain/11/2165/1540.terrain");
  assert.equal(context.insideAvailability, true, "route recognised the published address");
  assert.equal(http.status, 200, "the client asked for what the tileset promised; it gets terrain");
  assert.equal(headerOf(http, "content-type"), "application/vnd.quantized-mesh");
  assert.equal(headerOf(http, "content-encoding"), "gzip");
  assert.equal(headerOf(http, "cache-control"), "public, max-age=86400");
  assert.equal(
    headerOf(http, "x-terrain-synthesized"),
    "uniform-water",
    "a synthesized tile and a measured one are not the same claim; the wire says which",
  );

  // It really is a valid quantized-mesh at sea level with a full-water mask.
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(http.body)));
  assert.equal(mesh.header.minHeight, 0, "exactly zero");
  assert.equal(mesh.header.maxHeight, 0, "exactly zero");
  assert.equal(mesh.vertexCount, 65 * 65);
  assert.ok(mesh.h.every((h) => h === 0), "every height post is zero");
  const watermask = mesh.extensions.find((e) => e.id === 2);
  assert.equal(watermask.bytes.length, 1, "uniform mask is ONE byte, not 65 KB of 0xff");
  assert.equal(watermask.bytes[0], 0xff, "all water");

  // The index stream still decodes: the synthesized tile is encoded by THE SAME
  // encoder as a stored one, so it satisfies the same invariants.
  assert.equal(mesh.triangleCount, 64 * 64 * 2);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
  assert.ok(mesh.indices.every((i) => i >= 0 && i < mesh.vertexCount));
});

test("the synthesized tile carries a strong ETag and answers 304", async (t) => {
  const first = await serveMiss(t, "/api/v1/terrain/11/2165/1540.terrain");
  const etag = headerOf(first.http, "etag");
  assert.ok(etag?.startsWith('"1220'), `strong sha2-256 multihash ETag, got ${etag}`);
  const second = await serveMiss(t, "/api/v1/terrain/11/2165/1540.terrain", { ifNoneMatch: etag });
  assert.equal(second.http.status, 304, "a revalidating client is not re-sent the same bytes");
  assert.equal(second.http.body?.length ?? 0, 0, "304 is bodiless");
});

test("a miss OUTSIDE availability stays a cheap cacheable 404", async (t) => {
  // z11 x=3000 is outside the published rectangle; nothing promised it.
  const { context, http } = await serveMiss(t, "/api/v1/terrain/11/3000/1540.terrain");
  assert.equal(context.insideAvailability, false);
  assert.equal(http.status, 404);
  assert.equal(headerOf(http, "cache-control"), "public, max-age=300");
});

test("level 0 is inside availability, so the roots always answer", async (t) => {
  // Atlas: layer.json MUST cover level 0 or the client's tile promise rejects
  // with a TypeError and the globe stays an ellipsoid forever. Covering it is
  // only honest if both roots actually answer, stored or not.
  for (const x of [0, 1]) {
    const { context, http } = await serveMiss(t, `/api/v1/terrain/0/${x}/0.terrain`);
    assert.equal(context.insideAvailability, true, `root ${x}/0 is published`);
    assert.equal(http.status, 200, `root ${x}/0 answers`);
  }
});
