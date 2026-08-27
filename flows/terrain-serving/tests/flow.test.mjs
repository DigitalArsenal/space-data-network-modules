/*
 * Flow-level tests for the compiled terrain-serving flow — BRIDGE mode. The
 * SAME artifact the Go host mounts at /api/v1/terrain/ is instantiated in the
 * JS flow runtime host (browser parity): a $HTQ HttpRequest enters route, the
 * route -> flatsql-query -> respond (or route -> layer_json) chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossings are storage.flatsql_query_stream and plugin.getConfig — stubbed
 * with the Go-host response dialect.
 *
 * The stored $DTT fixture is produced by the terrain-source MODULE's own
 * `tile` encoder, so the serve path is tested against exactly the bytes the
 * ingest path stores.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RUNTIME_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const MODULE_WASM = new URL(
  "../../../data-source/terrain-source/dist/isomorphic/module.wasm",
  import.meta.url,
);
const MODULE_MANIFEST = new URL(
  "../../../data-source/terrain-source/plugin-manifest.json",
  import.meta.url,
);

const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 8,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  terrain_attribution: "test attribution",
};

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect; keys alphabetical like json.Marshal).
// ---------------------------------------------------------------------------

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, seg) => sum + 4 + seg.length, 0);
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  envelope.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    envelope.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return envelope;
}

function decodeHostcallEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  return { meta };
}

// ---------------------------------------------------------------------------
// The stored record fixture: one $DTT produced by the module's own encoder,
// in the store's stream framing ([u32 len][record]).
// ---------------------------------------------------------------------------

function buildDemGeoTiff() {
  // Minimal strip-layout deflate Float32 GeoTIFF matching the module tests'
  // synthetic granule (see data-source/terrain-source/tests/helpers.mjs for
  // the annotated writer; duplicated minimally here to keep the flow package
  // self-contained).
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      raw.writeFloatLE(Math.fround(100 + px + 2 * py), (py * width + px) * 4);
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const tags = [];
  const tag = (id, type, count, value) => tags.push({ id, type, count, value });
  const entryCount = 12;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let cursor = 8 + ifdBytes;
  const scaleOffset = cursor; cursor += 24;
  const tiepointOffset = cursor; cursor += 48;
  const dataOffset = cursor;
  tag(256, 3, 1, width); tag(257, 3, 1, height); tag(258, 3, 1, 32); tag(259, 3, 1, 8);
  tag(273, 4, 1, dataOffset); tag(277, 3, 1, 1); tag(278, 3, 1, height);
  tag(279, 4, 1, compressed.length); tag(317, 3, 1, 1); tag(339, 3, 1, 3);
  tag(33550, 12, 3, scaleOffset); tag(33922, 12, 6, tiepointOffset);
  tags.sort((a, b) => a.id - b.id);
  const file = Buffer.alloc(dataOffset + compressed.length);
  file.write("II", 0, "latin1");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(8, 4);
  file.writeUInt16LE(entryCount, 8);
  tags.forEach((t, n) => {
    const at = 10 + n * 12;
    file.writeUInt16LE(t.id, at);
    file.writeUInt16LE(t.type, at + 2);
    file.writeUInt32LE(t.count, at + 4);
    if (t.type === 3) file.writeUInt16LE(t.value, at + 8);
    else file.writeUInt32LE(t.value, at + 8);
  });
  file.writeDoubleLE(0.8 / 63, scaleOffset);
  file.writeDoubleLE(0.9 / 63, scaleOffset + 8);
  file.writeDoubleLE(0, tiepointOffset + 0);
  file.writeDoubleLE(0, tiepointOffset + 8);
  file.writeDoubleLE(0, tiepointOffset + 16);
  file.writeDoubleLE(10.5, tiepointOffset + 24);
  file.writeDoubleLE(45.8, tiepointOffset + 32);
  file.writeDoubleLE(0, tiepointOffset + 40);
  compressed.copy(file, dataOffset);
  return file;
}

async function storedRecordStream() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(MODULE_WASM)),
    manifest: JSON.parse(fs.readFileSync(fileURLToPath(MODULE_MANIFEST), "utf8")),
    surface: "direct",
  });
  try {
    const frame = (portId, value) => {
      const bytes = encoder.encode(JSON.stringify(value));
      return {
        portId,
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
        payload: bytes,
      };
    };
    const response = await harness.invoke({
      methodId: "tile",
      inputs: [
        frame("plan", {
          tilesetId: "spaceaware-terrain",
          level: 8,
          x: 271,
          y: 192,
          gridSize: 33,
          // PINNED, because this test asserts the served bytes against a
          // stated lattice. Density otherwise adapts to relief inside the
          // 32 KiB cap (coordinator 2026-08-27 (a)) and this fixture is a
          // plane, so the coarsest candidate is exact — correct, and not what
          // the assertion below is about.
          minGridSize: 33,
          maxLevel: 8,
          childAvailability: 0,
          provenance: {
            datasetId: "cop-dem-glo-30",
            datasetEpoch: "2023-04-01T00:00:00.000Z",
            retrievedAt: "2026-08-15T12:00:00.000Z",
            license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
          },
        }),
        frame("dem", {
          status: 200,
          headers: {},
          bodyB64: buildDemGeoTiff().toString("base64"),
        }),
      ],
    });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const records = response.outputs.find((o) => o.portId === "records");
    return Uint8Array.from(records.payload);
  } finally {
    harness.destroy();
  }
}

// ---------------------------------------------------------------------------
// Hostcall stub + request pump.
// ---------------------------------------------------------------------------

function createStub({ stream, config = CONFIG } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta } = decodeHostcallEnvelope(payload);
        calls.push({ operation, meta });
        if (operation === "plugin.getConfig") {
          response = encodeHostcallEnvelope(config);
          return 0;
        }
        if (operation === "storage.flatsql_query_stream") {
          response = encodeHostcallEnvelope({ ok: true }, stream ? [stream] : []);
          return 0;
        }
        response = encodeHostcallEnvelope({
          error: { message: `unexpected op ${operation}` },
          ok: false,
        });
        return 1;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };
  return { calls, imports, memoryRef };
}

async function pumpRequest(stub, request) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(RUNTIME_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const responses = [];
  host.enqueueTriggerFrame(0, { portId: "request", bytes: encodeHttpRequest(request) });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) responses.push(decodeHttpResponse(frame.bytes));
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, "expected exactly one $HTR frame");
  return responses[0];
}

const header = (http, name) => http.headers?.find((h) => h.name === name)?.value;

// ---------------------------------------------------------------------------

test("GET layer.json serves the config-derived descriptor through the compiled flow", async () => {
  const stub = createStub();
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/layer.json" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  // layer.json states a full cache policy now and compresses like every tile,
  // so it is read through the coding it declares.
  assert.equal(header(http, "content-encoding"), "gzip");
  assert.equal(header(http, "cache-control"), "public, max-age=300");
  assert.equal(header(http, "vary"), "accept-encoding");
  assert.equal(header(http, "x-content-type-options"), "nosniff");
  const layerEtag = header(http, "etag");
  assert.ok(layerEtag && !layerEtag.startsWith("W/"), `a strong ETag, got ${layerEtag}`);
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(http.body)).toString("utf8"));
  assert.equal(body.tilejson, "2.1.0");
  assert.equal(body.format, "quantized-mesh-1.0");
  assert.equal(body.scheme, "tms");
  assert.equal(body.maxzoom, 8);
  assert.deepEqual(body.available, CONFIG.terrain_available);
  // ATLAS, both halves of the same rule:
  //  * `available` MUST exist and MUST cover level 0. A native
  //    CesiumTerrainProvider with no availability rejects its tile promise
  //    with a TypeError and the globe stays an ellipsoid forever.
  //  * extensions is EXACTLY ["watermask"]. Declaring octvertexnormals while
  //    serving no normals makes the client request an extension the tiles do
  //    not carry, and the spelling "vertexnormals" is never valid at all.
  assert.ok(Array.isArray(body.available) && body.available.length >= 1);
  assert.ok(body.available[0].length >= 1, "level 0 is covered");
  assert.deepEqual(body.available[0], [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
    "both roots of the two-root geographic scheme");
  assert.deepEqual(body.extensions, ["watermask"]);
  assert.equal(body.projection, "EPSG:4326");
  assert.deepEqual(body.bounds, [-180, -90, 180, 90]);
  assert.equal(body.minzoom, 0);
  assert.equal(body.attribution, CONFIG.terrain_attribution);
  assert.ok(!JSON.stringify(body).includes("vertexnormals"), "never that spelling, in any form");
  assert.deepEqual(
    stub.calls.map((c) => c.operation),
    ["plugin.getConfig"],
    "layer.json touches the host for config only",
  );
});

test("GET {z}/{x}/{y}.terrain serves the stored record bytes verbatim", async () => {
  const stream = await storedRecordStream();
  const stub = createStub({ stream });
  const http = await pumpRequest(stub, {
    method: "GET",
    path: "/api/v1/terrain/8/271/192.terrain",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.quantized-mesh");
  assert.equal(header(http, "content-encoding"), "gzip");
  assert.equal(header(http, "cache-control"), "public, max-age=86400");
  // The record states its own strong ETag: the sha2-256 multihash of the
  // GZIPPED payload bytes, so a cache revalidates against the exact bytes it
  // holds rather than against an address-and-size guess.
  const etag = header(http, "etag");
  assert.ok(etag?.startsWith('"1220'), `strong sha2-256 multihash ETag, got ${etag}`);
  assert.ok(!etag.startsWith("W/"), "strong, never weak, when the record states a digest");
  // The served body gunzips to a quantized-mesh whose vertex count matches
  // the encode plan (33x33 grid).
  const mesh = zlib.gunzipSync(Buffer.from(http.body));
  assert.equal(mesh.readUInt32LE(88), 33 * 33, "vertexCount after the 88-byte header");

  const queryCall = stub.calls.find((c) => c.operation === "storage.flatsql_query_stream");
  assert.ok(queryCall, "the tile path queries the record store");
  assert.equal(
    queryCall.meta.sql,
    "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? ORDER BY _rowid DESC LIMIT 1",
  );
  assert.deepEqual(queryCall.meta.params, [
    { t: "str", v: "spaceaware-terrain" },
    { t: "i64", v: 8 },
    { t: "i64", v: 271 },
    { t: "i64", v: 192 },
  ]);

  // Conditional replay: the etag comes back 304 with no body.
  const conditional = await pumpRequest(createStub({ stream }), {
    method: "GET",
    path: "/api/v1/terrain/8/271/192.terrain",
    headers: { "if-none-match": etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body.length, 0);
});

test("a tile miss and an unknown path both answer cheap cacheable 404s", async () => {
  const miss = await pumpRequest(createStub({ stream: null }), {
    method: "GET",
    path: "/api/v1/terrain/12/100/200.terrain",
  });
  assert.equal(miss.status, 404);
  assert.equal(header(miss, "cache-control"), "public, max-age=300");

  const unknown = await pumpRequest(createStub(), {
    method: "GET",
    path: "/api/v1/terrain/definitely/not/a/tile",
  });
  assert.equal(unknown.status, 404);
  assert.equal(header(unknown, "cache-control"), "public, max-age=300");
});

test("a miss inside availability is synthesized by the COMPILED flow, never a 404", async () => {
  // Level 0 is inside the configured availability, and the stub store holds
  // nothing. Through the whole compiled graph — trigger, route, flatsql-query,
  // respond, egress — the client must still get terrain.
  const stub = createStub({ stream: new Uint8Array(4) });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/0/0/0.terrain" });
  assert.equal(http.status, 200, "the tileset promised level 0; the endpoint answers it");
  assert.equal(header(http, "content-type"), "application/vnd.quantized-mesh");
  assert.equal(header(http, "content-encoding"), "gzip");
  assert.equal(header(http, "cache-control"), "public, max-age=86400");
  // LAND, not water: this config states no authoritative level
  // (terrain_ocean_synth_min_level), nothing built level 0, and a
  // hemisphere-wide root claiming an all-water mask is every continent
  // rendered as specular ocean once the client upsamples from it.
  assert.equal(header(http, "x-terrain-synthesized"), "uniform-land");
  assert.ok(header(http, "etag")?.startsWith('"1220'), "strong digest ETag");

  const mesh = zlib.gunzipSync(Buffer.from(http.body));
  assert.equal(mesh.readFloatLE(24), 0, "minHeight exactly zero");
  assert.equal(mesh.readFloatLE(28), 0, "maxHeight exactly zero");
  assert.equal(mesh.readUInt32LE(88), 65 * 65, "vertexCount after the 88-byte header");
  assert.equal(mesh[mesh.length - 1], 0x00, "the one-byte water-mask extension says LAND");

  // It still went through the store first: synthesis is the ANSWER TO A MISS,
  // not a shortcut that stops the endpoint from serving real tiles.
  assert.ok(
    stub.calls.some((c) => c.operation === "storage.flatsql_query_stream"),
    "the store was asked before anything was synthesized",
  );
});

test("with an authoritative floor configured, a miss at a BUILT level is water", async () => {
  // The other half of the same rule: where the builder really did build,
  // "published but not stored" means "measured all-ocean and skipped", and the
  // console's reflective ocean depends on that mask being set.
  const stub = createStub({
    stream: new Uint8Array(4),
    config: {
      ...CONFIG,
      terrain_maxzoom: 11,
      terrain_ocean_synth_min_level: 11,
      terrain_available: [
        [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
        ...Array.from({ length: 10 }, () => []),
        [{ startX: 2162, startY: 1536, endX: 2172, endY: 1546 }],
      ],
    },
  });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/11/2165/1540.terrain" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "x-terrain-synthesized"), "uniform-water");
  const mesh = zlib.gunzipSync(Buffer.from(http.body));
  assert.equal(mesh[mesh.length - 1], 0xff, "the one-byte water-mask extension says WATER");
});

test("a miss OUTSIDE availability is still a cheap cacheable 404 through the flow", async () => {
  const stub = createStub({ stream: new Uint8Array(4) });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/8/271/192.terrain" });
  assert.equal(http.status, 404, "nothing promised this address");
  assert.equal(header(http, "cache-control"), "public, max-age=300");
});

// ---------------------------------------------------------------------------
// THE CATALOGUE: the one endpoint the IPFS delivery path turns on.
//
// Owner 2026-08-27: terrain files are requested over IPFS. A client learns the
// current tileset CID from THIS document and nowhere else — it hardcodes no CID
// (it would pin a dead epoch the day the dataset is recut) and no hostname (the
// owner refused a static asset host in the same breath). So if the catalogue
// does not answer, the whole delivery path is dark, and it answers through the
// COMPILED artifact here rather than only the module in isolation.
// ---------------------------------------------------------------------------

const IPFS_CONFIG = {
  ...CONFIG,
  terrain_tileset_cid: "bafybeidr3l5zoi6gxui3vuuvfc5sadl3zlkotonukuxysw7fws54s2npmy",
  terrain_gateway_path: "/ipfs/",
  terrain_dataset_epoch: "2023-04-01T00:00:00.000Z",
};

test("the mount root names the CID through the COMPILED flow", async () => {
  const stub = createStub({ config: IPFS_CONFIG });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  // The lane's ONE mutable pointer: short max-age, strong ETag, CORS open so a
  // client on another origin can resolve it before it fetches a single tile.
  assert.equal(header(http, "cache-control"), "public, max-age=60");
  assert.equal(header(http, "access-control-allow-origin"), "*");
  const etag = header(http, "etag");
  assert.ok(etag && !etag.startsWith("W/"), `a strong ETag, got ${etag}`);

  const body = JSON.parse(decoder.decode(Uint8Array.from(http.body)));
  assert.equal(body.delivery, "ipfs");
  assert.equal(body.cid, IPFS_CONFIG.terrain_tileset_cid);
  assert.equal(body.datasetEpoch, IPFS_CONFIG.terrain_dataset_epoch);
  // RELATIVE, so the client joins it against the node origin it already knows
  // and learns no hostname from us.
  assert.equal(body.terrainBasePath, `/ipfs/${IPFS_CONFIG.terrain_tileset_cid}/`);
  assert.equal(body.layerJsonPath, `/ipfs/${IPFS_CONFIG.terrain_tileset_cid}/layer.json`);
  assert.ok(!/^https?:/i.test(body.terrainBasePath), "never an absolute URL");
  assert.equal(body.format, "quantized-mesh-1.0");
  assert.equal(body.scheme, "tms");
  assert.equal(body.projection, "EPSG:4326");
  assert.deepEqual(body.extensions, ["watermask"]);
});

test("/catalogue.json is the same document, byte for byte, through the flow", async () => {
  const root = await pumpRequest(createStub({ config: IPFS_CONFIG }), {
    method: "GET",
    path: "/api/v1/terrain/",
  });
  const named = await pumpRequest(createStub({ config: IPFS_CONFIG }), {
    method: "GET",
    path: "/api/v1/terrain/catalogue.json",
  });
  assert.equal(named.status, 200);
  assert.deepEqual(Array.from(named.body), Array.from(root.body));
  assert.equal(header(named, "etag"), header(root, "etag"));
});

test("a node with NO CID configured still answers, naming its own mount", async () => {
  // A development node with no IPFS daemon must read the SAME document rather
  // than fail — that is what makes the client have one code path either way.
  const stub = createStub();
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/catalogue.json" });
  assert.equal(http.status, 200);
  const body = JSON.parse(decoder.decode(Uint8Array.from(http.body)));
  assert.equal(body.delivery, "mount");
  assert.equal(body.cid, null);
  assert.ok(body.terrainBasePath.endsWith("/"), "a joinable base path");
  assert.ok(!body.terrainBasePath.includes("/ipfs/"), "no gateway path without a CID");
});

test("EVERY path the module answers is a DECLARED route, so the host admits it anonymously", async () => {
  // sdn-server/internal/gateway/anonymous.go: a mounted route is admitted
  // without a session iff the flow DECLARES it anonymous — the host builds the
  // allowlist from api.routes and nothing else. An endpoint the module answers
  // but the manifest omits is reachable only through an operator's
  // gateway.anonymous.allow entry, so narrowing that entry to the declared set
  // would 401 the catalogue and take the delivery path down with it. This test
  // is the coupling: it fails the moment the module grows a surface the
  // manifest does not declare.
  const flow = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../../terrain-serving.flow.json", import.meta.url)), "utf8"),
  );
  const routes = flow.api.routes;
  for (const route of routes) {
    assert.equal(route.anonymous, true, `${route.path} must be declared anonymous`);
    assert.equal(route.method, "GET", `${route.path} is a read`);
  }

  // The host's own join + template match (JoinMountPath / templateMatch),
  // applied to the paths a client actually requests.
  const join = (mountPath, routePath) => {
    const mount = mountPath.replace(/\/$/, "");
    const rest = routePath.trim().replace(/^\//, "");
    return rest === "" ? mount || "/" : `${mount}/${rest}`;
  };
  const matches = (template, path) => {
    if (template === path) return true;
    const p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (template === p) return true;
    const t = template.replace(/^\/|\/$/g, "").split("/");
    const s = p.replace(/^\/|\/$/g, "").split("/");
    if (t.length !== s.length) return false;
    return t.every((seg, i) =>
      seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}") ? s[i] !== "" : seg === s[i],
    );
  };
  const declared = routes.map((r) => join("/api/v1/terrain/", r.path));
  const anonymous = (path) => declared.some((template) => matches(template, path));

  for (const path of [
    "/api/v1/terrain",
    "/api/v1/terrain/",
    "/api/v1/terrain/catalogue.json",
    "/api/v1/terrain/layer.json",
    "/api/v1/terrain/8/268/190.terrain",
  ]) {
    assert.ok(anonymous(path), `${path} must be anonymous by DECLARATION, not by allowlist`);
  }
});

test("THE CLIENT'S PATH: /tileset.json names the CID through the COMPILED flow", async () => {
  // The console fetches exactly this path off the live node and reads
  // PAYLOAD.CID. It is asserted here against the SAME artifact the Go host
  // mounts, because both lanes were green against their own fixtures and the
  // only place they disagreed was where they meet.
  const stub = createStub({ config: IPFS_CONFIG });
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/tileset.json" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.equal(header(http, "access-control-allow-origin"), "*");

  const record = JSON.parse(decoder.decode(Uint8Array.from(http.body)));
  const cidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
  assert.ok(cidPattern.test(record.PAYLOAD.CID), "a CID the client's grammar accepts");
  assert.equal(record.PAYLOAD.CID, IPFS_CONFIG.terrain_tileset_cid);
  assert.equal(record.PAYLOAD.MEDIA_TYPE, "application/vnd.ipld.dag-pb");
  assert.equal(record.TILESET_ID, "spaceaware-terrain");
  assert.equal(record.MAX_LEVEL, IPFS_CONFIG.terrain_maxzoom);
});
