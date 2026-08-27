// Serving-pair correctness: route ($HTQ -> query/layer_plan/404) and respond
// ($DTT stream -> $HTR). The stored record under test is produced by the
// module's own `tile` method, so the serve path is exercised against exactly
// the bytes the ingest path stores.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { buildGeoTiff, decodeDtt, decodeQuantizedMesh, splitStream } from "./helpers.mjs";

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
    "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? ORDER BY _rowid DESC LIMIT 1",
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
    // Content negotiation is decided where the request headers are, and
    // travels with the address: respond never sees the raw request.
    acceptsGzip: true,
    // The miss verdict travels WITH the address: route holds the configured
    // availability index, respond holds the store answer, and only the pair
    // decides whether a miss is normal traffic or a broken promise.
    insideAvailability: false,
    // ...and whether a synthesized tile may claim WATER travels with it too.
    // Absent terrain_ocean_synth_min_level no level is authoritative, so the
    // answer is always false and no fabricated ocean can reach a client.
    synthWater: false,
    synthGridSize: 65,
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

test("ONE TILE, ONE URL: a junk prefix cannot alias a real address", async (t) => {
  // The mount used to be found with rfind("/terrain/"), so every one of these
  // resolved to the SAME tile and was answered 200 with `public, max-age=86400`
  // — an unbounded number of distinct, publicly cacheable URLs for one
  // resource, none of which a URL-keyed purge could ever reach. The mount is a
  // PREFIX now, and anything left over that is not layer.json or a strict
  // z/x/y.terrain is a 404.
  const aliases = [
    "/api/v1/terrain/a/terrain/8/271/192.terrain",
    "/api/v1/terrain/ZZZ/terrain/8/271/192.terrain",
    "/api/v1/terrain/1/2/3.terrain/terrain/8/271/192.terrain",
    `/api/v1/terrain/${"x".repeat(8192)}/terrain/8/271/192.terrain`,
  ];
  for (const path of aliases) {
    const response = await invoke(t, "route", [requestFrame(path)]);
    assert.equal(response.statusCode, 0, `${path.slice(0, 40)}: a 404 is an answer`);
    assert.deepEqual(
      response.outputs.map((o) => o.portId),
      ["response"],
      "an aliased path must never reach the store query",
    );
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 404);
  }
  // …and the real address still routes.
  const good = await invoke(t, "route", [requestFrame("/api/v1/terrain/8/271/192.terrain")]);
  assert.deepEqual(new Set(good.outputs.map((o) => o.portId)), new Set(["query", "context"]));
});

test("ONE TILE, ONE URL: a leading zero is not a second spelling of an index", async (t) => {
  // parse_tile_path accepted up to nine decimal digits per field with no
  // canonical form, so "8", "08", "008" ... "000000008" all parsed to 8 and
  // one address was reachable at 9x7x7 = 441 distinct publicly cacheable URLs
  // — each a separate cache key costing a full store query and ~9 KB of cache
  // for the identical bytes. There is one canonical decimal spelling and this
  // accepts only that one.
  const aliases = [
    "/api/v1/terrain/08/271/192.terrain",
    "/api/v1/terrain/008/271/192.terrain",
    "/api/v1/terrain/000000008/000000271/000000192.terrain",
    "/api/v1/terrain/8/0271/192.terrain",
    "/api/v1/terrain/8/271/0192.terrain",
  ];
  for (const path of aliases) {
    const response = await invoke(t, "route", [requestFrame(path)]);
    assert.deepEqual(
      response.outputs.map((o) => o.portId),
      ["response"],
      `${path} must never reach the store query`,
    );
    assert.equal(decodeHttpResponse(new Uint8Array(response.outputs[0].payload)).status, 404);
  }
  // "0" itself IS canonical and still routes.
  const zero = await invoke(t, "route", [requestFrame("/api/v1/terrain/0/0/0.terrain")]);
  assert.deepEqual(new Set(zero.outputs.map((o) => o.portId)), new Set(["query", "context"]));
});

test("the mount has no search fallback, configured or not", async (t) => {
  // The first alias fix left a fallback that took the FIRST "/terrain/" when
  // the path did not start with the mount — and it ran whether or not a mount
  // was configured, so /junk/terrain/8/271/192.terrain and a 50 KB junk prefix
  // in front of it both still served the tile, which is the exact amplifier
  // the fix claimed to have removed.
  const outside = [
    "/junk/terrain/8/271/192.terrain",
    `/${"j".repeat(50000)}/terrain/8/271/192.terrain`,
    "/terrain/8/271/192.terrain",
    "/API/V1/TERRAIN/8/271/192.terrain",
  ];
  for (const config of [CONFIG, { ...CONFIG, terrain_mount_path: "/api/v1/terrain/" }]) {
    for (const path of outside) {
      const response = await invoke(t, "route", [requestFrame(path)], config);
      assert.deepEqual(
        response.outputs.map((o) => o.portId),
        ["response"],
        `${path.slice(0, 32)} must not be answered creatively`,
      );
      assert.equal(decodeHttpResponse(new Uint8Array(response.outputs[0].payload)).status, 404);
    }
  }
});

test("availability is the CLIENT's question: max level at the tile centre", async (t) => {
  // CesiumTerrainProvider does not ask "is (level,x,y) listed at level". Its
  // TileAvailability.isTileAvailable is computeMaximumLevelAtPosition(centre of
  // the tile) >= level, so a SHALLOW address whose centre falls inside a DEEP
  // rectangle is one the client will request. A per-level membership test
  // answered a different question, and on the regional pyramid — empty at
  // levels 1-7, populated at 8-13 — that put 14 shallow addresses (2 at z6, 12
  // at z7) through to the browser as 404s.
  //
  // The rectangle below is the level-8 block over the Ligurian region; 6/67/47
  // and 7/134/95 are ancestors of it whose centres land inside.
  const config = {
    ...CONFIG,
    terrain_maxzoom: 8,
    terrain_available: [
      [], [], [], [], [], [], [], [],
      [{ startX: 266, startY: 188, endX: 273, endY: 195 }],
    ],
  };
  const inside = async (path) => {
    const response = await invoke(t, "route", [requestFrame(path)], config);
    const outputs = outputsByPort(response);
    return asJson(outputs.get("context")).insideAvailability;
  };
  assert.equal(await inside("/api/v1/terrain/8/271/192.terrain"), true, "the declared level");
  assert.equal(await inside("/api/v1/terrain/7/135/96.terrain"), true, "an ancestor at z7");
  assert.equal(await inside("/api/v1/terrain/6/67/48.terrain"), true, "an ancestor at z6");
  assert.equal(await inside("/api/v1/terrain/8/100/100.terrain"), false, "outside the region");
  assert.equal(await inside("/api/v1/terrain/6/10/10.terrain"), false, "outside the region");
});

test("the 404 body does not track the request: reflection is bounded", async (t) => {
  // The detail carries the request path, which is client-controlled and — with
  // the host's 1 MiB request-line default — can be ~1 MB. A 404 body that
  // tracks it makes every junk URL a megabyte-scale PUBLICLY CACHEABLE entry.
  const bodies = [];
  for (const length of [100, 10_000, 200_000]) {
    const response = await invoke(t, "route", [requestFrame(`/nope/${"a".repeat(length)}`)]);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 404);
    bodies.push(http.body.length);
  }
  for (const size of bodies) {
    assert.ok(size < 512, `404 body must stay bounded, got ${size} B`);
  }
  assert.equal(bodies[1], bodies[2], "the body stops tracking the path length entirely");
});

test("an over-long If-None-Match is dropped at the door, never carried", async (t) => {
  // Every ETag this module issues is a quoted sha2-256 multihash (71 bytes), so
  // a longer value cannot match one; carrying it across two guest invokes and a
  // control frame buys nothing and costs an allocation per request.
  const response = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/8/271/192.terrain", {
      headers: { "if-none-match": `"${"9".repeat(100_000)}"` },
    }),
  ]);
  const context = asJson(outputsByPort(response).get("context"));
  assert.equal(context.ifNoneMatch, "", "dropped, which degrades to a 200");
  // A real one still rides.
  const ok = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/8/271/192.terrain", { headers: { "if-none-match": '"1220ab"' } }),
  ]);
  assert.equal(asJson(outputsByPort(ok).get("context")).ifNoneMatch, '"1220ab"');
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
  // The record states its own strong ETag now: the sha2-256 multihash of the
  // GZIPPED payload bytes (Themis). A cache therefore revalidates against the
  // exact bytes it holds, not against an address-and-size guess.
  const etag = headerOf("etag");
  const record = decodeDtt(splitStream(stream)[0]);
  assert.ok(record.payload.digest?.startsWith("1220"), "sha2-256 multihash, lowercase hex");
  assert.equal(etag, `"${record.payload.digest}"`, "strong ETag is the payload digest");
  assert.ok(!etag.startsWith("W/"), "strong, never weak, when the record states a digest");
  assert.equal(
    record.payload.digest,
    `1220${createHash("sha256").update(Buffer.from(record.payload.bytes)).digest("hex")}`,
    "the digest is over the bytes the client actually receives",
  );

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

test("the encoding is NEGOTIATED, and each representation carries its own tag", async (t) => {
  // respond stated `content-encoding: gzip` from the record unconditionally,
  // without reading Accept-Encoding and without `vary` — so a shared cache or
  // a client that asked for identity got a coding it had not accepted, under a
  // key that did not record the difference.
  const stream = await storedRecordStream(t);
  const serve = async (headers) => {
    const routed = await invoke(t, "route", [
      requestFrame("/api/v1/terrain/8/271/192.terrain", { headers }),
    ]);
    const context = decoder.decode(outputsByPort(routed).get("context"));
    const response = await invoke(t, "respond", [
      frame("stream", new Uint8Array(stream)),
      frame("context", encoder.encode(context)),
    ]);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    return { http, headerOf: (n) => http.headers.find((h) => h.name === n)?.value };
  };

  const gz = await serve({ "accept-encoding": "gzip, deflate, br" });
  assert.equal(gz.headerOf("content-encoding"), "gzip");
  assert.equal(gz.headerOf("vary"), "accept-encoding", "the cache key records the negotiation");
  assert.equal(gz.headerOf("x-content-type-options"), "nosniff");

  const none = await serve({ "accept-encoding": "identity" });
  assert.equal(none.headerOf("content-encoding"), undefined, "identity was asked for");
  assert.equal(none.headerOf("vary"), "accept-encoding");
  const mesh = decodeQuantizedMesh(Buffer.from(none.http.body));
  assert.equal(mesh.vertexCount, 33 * 33, "the identity body is the DECODED mesh, not relabelled");

  // Two representations, two strong tags: one tag over both would let a cache
  // holding the gzip variant answer the identity variant's revalidation 304.
  assert.notEqual(gz.headerOf("etag"), none.headerOf("etag"));
  assert.equal(
    none.headerOf("etag"),
    `"1220${createHash("sha256").update(Buffer.from(none.http.body)).digest("hex")}"`,
    "the identity tag is over the identity bytes",
  );

  // q=0 is a refusal; a bare * accepts.
  assert.equal((await serve({ "accept-encoding": "gzip;q=0, *" })).headerOf("content-encoding"), undefined);
  assert.equal((await serve({ "accept-encoding": "*" })).headerOf("content-encoding"), "gzip");
  // Absent Accept-Encoding means anything is acceptable (RFC 9110 12.5.3).
  assert.equal((await serve({})).headerOf("content-encoding"), "gzip");
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
