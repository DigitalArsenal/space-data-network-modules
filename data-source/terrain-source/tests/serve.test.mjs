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
  terrain_version: "1.0.0",
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

const requestFrame = (path, { method = "GET", headers = {}, query = "" } = {}) => ({
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  // PATH and QUERY are separate on the wire, exactly as the host stages them
  // (flowrt/httpmount: EscapedPath and RawQuery), so a test can put a query on
  // a request without smuggling it through the path.
  payload: encodeHttpRequest({ method, path, query, headers }),
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
  // The report names the density the adaptive search settled on. Tests read
  // it rather than assuming gridSize: the plan's gridSize is the CEILING of
  // the search, and a tile whose relief a coarser mesh describes exactly ships
  // at that coarser mesh (coordinator 2026-08-27 (a)). Here the source is a
  // plane, so the coarsest candidate is exact and the tile is 5x5 — which is
  // the feature working, not a defect, and a test that hard-coded 33 would be
  // asserting the absence of the feature.
  const report = JSON.parse(decoder.decode(outputs.get("report")));
  const stream = Buffer.from(outputs.get("records"));
  stream.shippedGrid = report.tiles[0].gridSize;
  return stream;
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
  const headerOf = (n) => http.headers.find((h) => h.name === n)?.value;
  assert.equal(headerOf("content-encoding"), "gzip", "layer.json compresses, like every tile");
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(http.body)).toString("utf8"));
  assert.equal(body.maxzoom, 8);
  assert.deepEqual(body.available, CONFIG.terrain_available);
});

// ── layer.json STATES A POLICY, LIKE EVERY OTHER RESPONSE ──────────────────
//
// It used to ship with exactly one header — content-type — while the tiles it
// indexes carried cache-control, a strong ETag and a vary, and even the 404
// argued its own max-age in a comment. So the ONE response every client
// fetches first, and refetches in full on every session, could not be
// revalidated, could not be reasoned about by an intermediary, and was not
// compressed: 4.4 MB at the ruled ship configuration against 801 KB gzipped.
test("layer.json carries the same explicit policy headers as a tile", async (t) => {
  const routed = await invoke(t, "route", [requestFrame("/api/v1/terrain/layer.json")]);
  const layer = await invoke(t, "layer_json", [frame("plan", routed.outputs[0].payload)]);
  const http = decodeHttpResponse(new Uint8Array(layer.outputs[0].payload));
  const headerOf = (n) => http.headers.find((h) => h.name === n)?.value;

  assert.equal(http.status, 200);
  assert.equal(headerOf("content-type"), "application/json");
  assert.equal(headerOf("x-content-type-options"), "nosniff");
  assert.equal(headerOf("vary"), "accept-encoding", "the body's coding is negotiated");
  // 300 s, not the tiles' 86400: a tile at an address is immutable for an
  // edition, but layer.json is the INDEX, and a stale one makes a client ask
  // for tiles that do not exist yet or never learn about the ones that do.
  assert.equal(headerOf("cache-control"), "public, max-age=300");

  const etag = headerOf("etag");
  assert.ok(etag, "a strong ETag, so a revalidation is a 304 and not 4.4 MB again");
  assert.ok(!etag.startsWith("W/"), "strong, never weak");

  // The tag revalidates: the same client, the same index, no body.
  const conditional = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/layer.json", { headers: { "if-none-match": etag } }),
  ]);
  const revalidated = await invoke(t, "layer_json", [frame("plan", conditional.outputs[0].payload)]);
  const notModified = decodeHttpResponse(new Uint8Array(revalidated.outputs[0].payload));
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  assert.equal(notModified.headers.find((h) => h.name === "etag")?.value, etag);

  // Two representations, two tags — a shared cache holding one must not answer
  // the other's revalidation with a 304.
  const identityRouted = await invoke(t, "route", [
    requestFrame("/api/v1/terrain/layer.json", { headers: { "accept-encoding": "identity" } }),
  ]);
  const identity = await invoke(t, "layer_json", [
    frame("plan", identityRouted.outputs[0].payload),
  ]);
  const plainHttp = decodeHttpResponse(new Uint8Array(identity.outputs[0].payload));
  const plainTag = plainHttp.headers.find((h) => h.name === "etag")?.value;
  assert.equal(
    plainHttp.headers.find((h) => h.name === "content-encoding")?.value,
    undefined,
    "identity was asked for",
  );
  assert.notEqual(plainTag, etag);
  JSON.parse(Buffer.from(plainHttp.body).toString("utf8"));  // and it really is the JSON
});

// ── ONE TILE, ONE URL — THE QUERY HALF ─────────────────────────────────────
//
// route() read $HTQ PATH and nothing else, so a tile was answered 200
// `public, max-age=86400` under unboundedly many distinct cache keys: append
// any query at all and you had a fresh entry for identical bytes. The query
// cannot simply be refused either — layer.json states its tiles template as
// "{z}/{x}/{y}.terrain?v={version}", so every conforming native client sends
// exactly one token.
test("ONE TILE, ONE URL: only the version token layer.json declares is admitted", async (t) => {
  // layer.json's own template, resolved: this is what a native client sends.
  const declared = await (async () => {
    const routed = await invoke(t, "route", [requestFrame("/api/v1/terrain/layer.json")]);
    const layer = await invoke(t, "layer_json", [frame("plan", routed.outputs[0].payload)]);
    const http = decodeHttpResponse(new Uint8Array(layer.outputs[0].payload));
    return JSON.parse(zlib.gunzipSync(Buffer.from(http.body)).toString("utf8")).version;
  })();
  assert.equal(declared, CONFIG.terrain_version);

  const routeWithQuery = (query) =>
    invoke(t, "route", [requestFrame("/api/v1/terrain/8/271/192.terrain", { query })]);

  for (const query of ["", `v=${declared}`]) {
    const response = await routeWithQuery(query);
    const ports = new Set(response.outputs.map((o) => o.portId));
    assert.ok(ports.has("query"), `${JSON.stringify(query)} is the one addressed resource`);
  }

  // Everything else is a REFUSAL, not a miss — and the difference is now in
  // the cache-control. It used to answer `public, max-age=300` with the
  // request path echoed in the body, which closed the amplifier on the 200s
  // and left it wide open one status code over: every distinct junk query was
  // a distinct, publicly cacheable key holding a distinct body for five
  // minutes. A refusal caches nothing and echoes nothing.
  for (const query of [
    "v=0.0.0",
    "v=1.0.0&v=1.0.0",
    "cachebust=1",
    "V=1.0.0",
    "v=1.0.0 ",
    "".padEnd(4096, "x"),
  ]) {
    const response = await routeWithQuery(query);
    assert.equal(response.outputs.length, 1, query);
    assert.equal(response.outputs[0].portId, "response", query);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 404, `?${query} must not be a second key for one tile`);
    assert.equal(
      http.headers.find((h) => h.name === "cache-control")?.value,
      "no-store",
      `?${query} must not be parkable in a public cache`,
    );
    assert.equal(
      JSON.parse(Buffer.from(http.body).toString("utf8")).detail,
      "not a tile address in this tileset",
      "and the refusal echoes nothing back",
    );
  }
});

// ── ONE TILE, ONE URL — THE 404 HALF ───────────────────────────────────────
//
// The same amplifier class, on the status code the discipline had never been
// applied to. `/{z}/{x}/{tile}` is the host's route template, so the tile
// segment is whatever a caller sends: an unbounded family of distinct paths,
// each answered `public, max-age=300` with its own path echoed into its own
// body. Bodies are small and the parser refuses before any store query, so the
// cost per key was small — but "small times unbounded" is the shape of every
// cache-poisoning amplifier this module has already closed twice.
//
// A 404 is publicly cacheable ONLY when the request named a real address.
test("a 404 is publicly cacheable only when the request named a real address", async (t) => {
  const refusals = [
    "/api/v1/terrain/1/1/whatever.terrain",
    "/api/v1/terrain/1/1/../../../etc/passwd",
    "/api/v1/terrain/8/271/192.png",
    "/api/v1/terrain/8/0271/192.terrain",   // non-canonical spelling
    "/api/v1/terrain/8/271/192/193.terrain",
    "/api/v1/terrain/not/a/tile.terrain",
    `/api/v1/terrain/1/1/${"z".repeat(2048)}.terrain`,
  ];
  const bodies = new Set();
  for (const path of refusals) {
    const response = await invoke(t, "route", [requestFrame(path)]);
    assert.equal(response.outputs.length, 1, path);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 404, path);
    assert.equal(
      http.headers.find((h) => h.name === "cache-control")?.value,
      "no-store",
      `${path} must not occupy a public cache key`,
    );
    bodies.add(Buffer.from(http.body).toString("utf8"));
  }
  // ONE body for every refusal: nothing a caller sends comes back, so there is
  // nothing to vary and nothing to store.
  assert.equal(bodies.size, 1, "a refusal reflects no part of the request");

  // The honest cacheable miss is unchanged: a canonical address that exists at
  // its level, outside availability, that the store does not hold.
  const routed = await invoke(t, "route", [requestFrame("/api/v1/terrain/11/3000/1540.terrain")]);
  const context = routed.outputs.find((o) => o.portId === "context");
  assert.ok(context, "a real address is planned, not refused at the parser");
  const responded = await invoke(t, "respond", [
    frame("stream", new Uint8Array(4)),
    frame("context", context.payload),
  ]);
  const miss = decodeHttpResponse(new Uint8Array(responded.outputs[0].payload));
  assert.equal(miss.status, 404);
  assert.equal(
    miss.headers.find((h) => h.name === "cache-control")?.value,
    "public, max-age=300",
    "nobody was promised it, and a client asking twice should not cost two store queries",
  );
});

test("route without configured availability defaults to the two level-0 roots only", async (t) => {
  const response = await invoke(t, "route", [requestFrame("/api/v1/terrain/layer.json")], {});
  const plan = asJson(response.outputs[0].payload);
  assert.equal(plan.tilesetId, "spaceaware-terrain");
  assert.equal(plan.maxzoom, 0, "no config = a pyramid of exactly the roots");
  assert.deepEqual(plan.available, [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]]);
});

test("route answers unknown paths with a no-store 404 and bad verbs with 405", async (t) => {
  // None of these NAMES A TILE, so none of them is a miss: they are refusals,
  // and a refusal is not parkable in a public cache (see "a 404 is publicly
  // cacheable only when the request named a real address").
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
      "no-store",
      "an unparseable path is a refusal, not normal traffic",
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
  assert.equal(mesh.vertexCount, stream.shippedGrid ** 2, "the mesh the record's report named");

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
  assert.equal(
    mesh.vertexCount,
    stream.shippedGrid ** 2,
    "the identity body is the DECODED mesh, not relabelled",
  );

  // Two representations, two strong tags: one tag over both would let a cache
  // holding the gzip variant answer the identity variant's revalidation 304.
  assert.notEqual(gz.headerOf("etag"), none.headerOf("etag"));
  // The identity tag is DERIVED from the stored representation's tag rather
  // than hashed over the inflated bytes, so a conditional request that will be
  // answered 304 never pays for an inflate whose result it discards. gunzip is
  // deterministic, so the derivation is exact: two identity bodies share a tag
  // exactly when their gzip forms are byte-identical.
  assert.equal(
    none.headerOf("etag"),
    `"identity-${gz.headerOf("etag").slice(1, -1)}"`,
    "one representation, one tag, derived without inflating anything",
  );
  assert.ok(!none.headerOf("etag").startsWith("W/"), "strong stays strong");

  // The 304 on the identity variant is BODILESS AND CHEAP — the property the
  // derivation exists for.
  const conditionalIdentity = await serve({
    "accept-encoding": "identity",
    "if-none-match": none.headerOf("etag"),
  });
  assert.equal(conditionalIdentity.http.status, 304);
  assert.equal(conditionalIdentity.http.body.length, 0);

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

// ── THE ADDRESS THAT WAS ASKED FOR IS THE ADDRESS THAT IS SERVED ───────────
//
// respond took the FIRST decodable $DTT frame off the stream and never
// compared the record's own LEVEL/X/Y with the serve context, which already
// carries them. Measured on the shipped module against the real regional store,
// GET /api/v1/terrain/11/2155/1530.terrain answered with 13/8632/6112's record
// returned 200 with that tile's 6,459 bytes and its strong ETag — publicly
// cacheable for a day, under the wrong address, so the wrong terrain would
// stick until the epoch changed.
//
// Under correct host operation the sibling query node cannot return a foreign
// address, which is exactly why this was invisible; it also means the whole
// address-to-bytes binding rested on that one node. Coordinator resolution
// 2026-08-27 (3) puts the check where the claim is published.
test("respond REFUSES to serve a record labelled with another address", async (t) => {
  const stream = await storedRecordStream(t); // 8/271/192
  const record = decodeDtt(splitStream(stream)[0]);
  assert.equal(record.level, 8);
  assert.equal(record.x, 271);
  assert.equal(record.y, 192);

  // Same stream, a context asking for a DIFFERENT tile — the shape a
  // cross-batch ingest or a stale-plan re-cut produces.
  const response = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", {
      tilesetId: "spaceaware-terrain",
      level: 11,
      x: 2155,
      y: 1530,
      ifNoneMatch: "",
      insideAvailability: false,
    }),
  ]);
  assert.equal(response.statusCode, 0, "a mislabelled record is not a crash; it is a miss");
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 404, "the other tile's bytes are NOT served under this address");
  assert.equal(http.body.length > 0, true);
  const body = JSON.parse(Buffer.from(http.body).toString("utf8"));
  assert.match(
    body.detail,
    /labelled with another address/,
    `the skip is stated, never silent: ${body.detail}`,
  );

  // And the control: the SAME stream under its OWN address still serves 200,
  // so the check refuses foreign records rather than everything.
  const own = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 8, x: 271, y: 192, ifNoneMatch: "" }),
  ]);
  assert.equal(
    decodeHttpResponse(new Uint8Array(own.outputs[0].payload)).status,
    200,
    "the record's own address is served exactly as before",
  );
});

test("a foreign TILESET is refused the same way as a foreign address", async (t) => {
  const stream = await storedRecordStream(t);
  const response = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", {
      tilesetId: "some-other-tileset",
      level: 8,
      x: 271,
      y: 192,
      ifNoneMatch: "",
      insideAvailability: false,
    }),
  ]);
  assert.equal(
    decodeHttpResponse(new Uint8Array(response.outputs[0].payload)).status,
    404,
    "one tileset's tile is not another tileset's tile",
  );
});

test("a mislabelled record inside availability SYNTHESIZES rather than serving the wrong tile", async (t) => {
  // The fail-safe half. Inside declared availability a miss must not reach the
  // browser as a 404 (Atlas), and a record that disagrees about its own address
  // is a miss — so the address the client asked for gets the synthesized tile
  // the tileset promised, never another tile's terrain.
  const stream = await storedRecordStream(t);
  const response = await invoke(t, "respond", [
    frame("stream", new Uint8Array(stream)),
    jsonFrame("context", {
      tilesetId: "spaceaware-terrain",
      level: 11,
      x: 2155,
      y: 1530,
      ifNoneMatch: "",
      insideAvailability: true,
      synthWater: false,
      synthGridSize: 65,
      acceptsGzip: true,
    }),
  ]);
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 200);
  assert.equal(
    http.headers.find((h) => h.name === "x-terrain-synthesized")?.value,
    "uniform-land",
    "synthesized, and it says so — not the stored tile of another address",
  );
});

// ── EVERY JSON RESPONSE CARRIES THE SAME MIME AND CACHE POLICY ─────────────
//
// The 404 is the one response whose body reflects client-controlled text (the
// requested path, bounded and escaped), and it was the one response with no
// x-content-type-options. Coordinator resolution 2026-08-27 (5).
test("every JSON error carries nosniff and an explicit cache policy", async (t) => {
  const cases = [
    // A 404 from respond with an empty stream…
    async () =>
      await invoke(t, "respond", [
        frame("stream", new Uint8Array(4)),
        jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 12, x: 0, y: 0, ifNoneMatch: "" }),
      ]),
    // …and the reflecting 404s route emits for junk paths, in the spellings
    // that actually put attacker bytes in the body.
    async () => await invoke(t, "route", [requestFrame("/api/v1/terrain/<script>alert(1)</script>")]),
    async () => await invoke(t, "route", [requestFrame("/api/v1/terrain/9/1/1.terrain?v=9.9.9")]),
    async () => await invoke(t, "route", [requestFrame("/somewhere/else")]),
  ];
  for (const run of cases) {
    const response = await run();
    assert.equal(response.statusCode, 0);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    const headerOf = (n) => http.headers.find((h) => h.name === n)?.value;
    assert.equal(http.status, 404, "these are all misses");
    assert.equal(headerOf("content-type"), "application/json");
    assert.equal(headerOf("x-content-type-options"), "nosniff", "sniffing is forbidden on every one");
    assert.ok(headerOf("cache-control"), "and the cache policy is stated, never inherited");
  }
});
