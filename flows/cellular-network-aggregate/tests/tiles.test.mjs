/*
 * Flow-level tests for the CELLULAR DENSITY-TILE SERVING LANE
 * (graph tasks sdn-cellular-density-tiles / upstream-modules-2; owner
 * 2026-08-24: "all worldwide cell towers must reach the cellular sandcastle").
 *
 * COMPUTABLE OUTCOMES ONLY (owner law: no UI-wiring or source-pattern tests).
 * Every assertion below is a status code, a count, a coordinate, a byte
 * comparison, or the presence/absence of a host call.
 *
 * THE NORMATIVE CONSUMER IS VENDORED, NOT PARAPHRASED.
 *
 * The landed OrbPro client (OrbPro packages/sandcastle/gallery/_shared/
 * cellularTileStream.js at f9e39b5437) FAILS HARD on an off-contract envelope:
 * unknown scheme, unknown mode, points mode above budget, density mode at or
 * below budget, a density tile with an empty cells array, a missing threshold,
 * a non-ISO epoch, a non-boolean `sampled`, `deconflicted` other than true.
 * A server-side test that re-states the grammar in its own words would drift
 * from that parser silently, and the drift only surfaces as a broken globe.
 *
 * So `parseTileEnvelope` and `decideRenderMode` below are a VERBATIM COPY of
 * the client's, and every envelope this flow emits is pushed through them. If
 * this lane and that client ever disagree, these tests fail here rather than in
 * a browser. (The modules repo cannot depend on OrbPro, and OrbPro cannot
 * depend on the modules repo, which is why the copy exists at all.)
 *
 * The SAME artifact the Go host would serve is instantiated in the JS flow
 * runtime host at runtimeTarget "wasmedge", with the host dialect the Go node
 * speaks ({"ok":true,"result":{...}} envelopes, aligned segments for streams).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

import { irmRecord, irmStream, isMarkQuery } from "./irm-fixture.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);

const sdkTestingEntry = fileURLToPath(
  new URL(import.meta.resolve("space-data-module-sdk/testing")),
);
const sdkRoot = path.resolve(path.dirname(sdkTestingEntry), "..", "..");
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = sdkRequire("flatbuffers");
const { HttpRequest } = sdkRequire(
  path.join(sdkRoot, "src", "generated", "http", "sdn", "http", "http-request.js"),
);
const { HttpResponse } = sdkRequire(
  path.join(sdkRoot, "src", "generated", "http", "sdn", "http", "http-response.js"),
);

// ═══════════════ VERBATIM from OrbPro cellularTileStream.js @ f9e39b5437 ═════
const TILE_SCHEME = "xyz";
const TILE_MODES = Object.freeze(["points", "density"]);

function decideRenderMode(envelope) {
  if (envelope.mode === "points") {
    if (envelope.count > envelope.budget) {
      throw new Error(
        `off-contract tile ${envelope.z}/${envelope.x}/${envelope.y}: mode "points" with count ${envelope.count} > budget ${envelope.budget}; the contract sends density above budget`,
      );
    }
    return "points";
  }
  if (envelope.mode === "density") {
    if (envelope.count <= envelope.budget) {
      throw new Error(
        `off-contract tile ${envelope.z}/${envelope.x}/${envelope.y}: mode "density" with count ${envelope.count} <= budget ${envelope.budget}; the contract sends points below budget`,
      );
    }
    return "density";
  }
  throw new Error(`unknown tile mode "${envelope.mode}"`);
}

function parseTileEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new Error(`tile envelope is not JSON: ${error.message}`);
  }
  if (envelope.scheme !== TILE_SCHEME) {
    throw new Error(`unknown tile scheme ${JSON.stringify(envelope.scheme)}`);
  }
  const { z, x, y } = envelope;
  if (![z, x, y].every((v) => Number.isInteger(v) && v >= 0)) {
    throw new Error(`tile envelope has non-integer or negative z/x/y`);
  }
  if (!TILE_MODES.includes(envelope.mode)) {
    throw new Error(`unknown tile mode ${JSON.stringify(envelope.mode)}`);
  }
  if (!Number.isFinite(envelope.count) || envelope.count < 0) {
    throw new Error(`tile count must be a non-negative number, got ${envelope.count}`);
  }
  if (!Number.isFinite(envelope.threshold) || envelope.threshold < 0) {
    throw new Error(`tile threshold must be a non-negative number`);
  }
  if (!Number.isFinite(envelope.budget) || envelope.budget < 0) {
    throw new Error(`tile budget must be a non-negative number`);
  }
  if (typeof envelope.sampled !== "boolean") {
    throw new Error(`tile sampled must be a boolean`);
  }
  if (envelope.deconflicted !== true) {
    throw new Error(`tile deconflicted must be true; tiles are always pre-deconflicted`);
  }
  if (!envelope.dataset || typeof envelope.dataset !== "object") {
    throw new Error(`tile dataset must be an object`);
  }
  const dataset = envelope.dataset;
  if (typeof dataset.dataset !== "string" || dataset.dataset.length === 0) {
    throw new Error(`tile dataset.dataset must be a non-empty string`);
  }
  if (typeof dataset.epoch !== "string" || Number.isNaN(Date.parse(dataset.epoch))) {
    throw new Error(`tile dataset.epoch must be an ISO timestamp`);
  }
  if (!Number.isFinite(dataset.records) || dataset.records < 0) {
    throw new Error(`tile dataset.records must be a non-negative number`);
  }
  if (typeof dataset.stale !== "boolean") {
    throw new Error(`tile dataset.stale must be a boolean`);
  }
  if (typeof dataset.cacheState !== "string") {
    throw new Error(`tile dataset.cacheState must be a string`);
  }
  if (envelope.mode === "points") {
    if (envelope.density !== null && envelope.density !== undefined) {
      throw new Error(`points-mode tile must carry density: null`);
    }
    if (!Array.isArray(envelope.points)) {
      throw new Error(`points-mode tile must carry a points array`);
    }
    for (const point of envelope.points) {
      validatePoint(point);
    }
  } else {
    if (envelope.points !== null && envelope.points !== undefined) {
      throw new Error(`density-mode tile must carry points: null`);
    }
    validateDensity(envelope.density);
  }
  return envelope;
}

function validatePoint(point) {
  if (!point || typeof point !== "object") {
    throw new Error(`tile point must be an object`);
  }
  const { LATITUDE, LONGITUDE } = point;
  if (!Number.isFinite(LATITUDE) || Math.abs(LATITUDE) > 90) {
    throw new Error(`tile point LATITUDE must be in [-90, 90]`);
  }
  if (!Number.isFinite(LONGITUDE) || Math.abs(LONGITUDE) > 180) {
    throw new Error(`tile point LONGITUDE must be in [-180, 180]`);
  }
}

function validateDensity(density) {
  if (!density || typeof density !== "object") {
    throw new Error(`density-mode tile must carry a density object`);
  }
  if (!Number.isInteger(density.n) || density.n < 1) {
    throw new Error(`density.n must be a positive integer`);
  }
  if (!Array.isArray(density.cells) || density.cells.length === 0) {
    throw new Error(`density.cells must be a non-empty array of cell entries`);
  }
  for (const cell of density.cells) {
    if (!cell || typeof cell !== "object") {
      throw new Error(`density cell must be an object`);
    }
    if (!Number.isFinite(cell.lon) || Math.abs(cell.lon) > 180) {
      throw new Error(`density cell lon must be in [-180, 180]`);
    }
    if (!Number.isFinite(cell.lat) || Math.abs(cell.lat) > 90) {
      throw new Error(`density cell lat must be in [-90, 90]`);
    }
    if (!Number.isFinite(cell.count) || cell.count < 0) {
      throw new Error(`density cell count must be a non-negative number`);
    }
  }
}

// The client's own meta check (loadTileMeta in cellular-network-performance).
function assertMetaGrammar(meta) {
  assert.equal(meta.scheme, TILE_SCHEME, "meta scheme must be xyz");
  for (const field of ["minZoom", "maxZoom", "threshold", "budget", "densityN"]) {
    assert.ok(Number.isInteger(meta[field]), `meta ${field} must be an integer`);
  }
  assert.ok(meta.dataset && typeof meta.dataset === "object", "meta dataset must be an object");
}

// The client's own tile-index math (lonToTileX / latToTileY / tileBounds /
// densityCellRectangle), for fixtures that must land in a KNOWN tile and for
// the cell-partition check. Duplicated for the same reason as the parser.
const TILE_INDEX_EPSILON = 1e-9;
function lonToTileX(lonDeg, z) {
  const n = 2 ** z;
  return Math.min(Math.max(Math.floor(((lonDeg + 180) / 360) * n + TILE_INDEX_EPSILON), 0), n - 1);
}
function latToTileY(latDeg, z) {
  const n = 2 ** z;
  const phi = (latDeg * Math.PI) / 180;
  const raw = ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n + TILE_INDEX_EPSILON;
  return Math.min(Math.max(Math.floor(raw), 0), n - 1);
}
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { west, south, north, east };
}
function densityCellRectangle(tile, cell) {
  const bounds = tileBounds(tile.z, tile.x, tile.y);
  const spanLon = (bounds.east - bounds.west) / tile.density.n;
  const spanLat = (bounds.north - bounds.south) / tile.density.n;
  return {
    west: cell.lon,
    south: cell.lat,
    east: cell.lon + spanLon,
    north: cell.lat + spanLat,
  };
}
// ═══════════════════════════ end vendored client ════════════════════════════

// ── fixtures ───────────────────────────────────────────────────────────────
//
// A real $TBS buffer, built field-by-field so the guest's hand-decoded slot
// indices (LATITUDE = 8, LONGITUDE = 9, from the IDL's declaration order) are
// exercised against a buffer a real writer would produce. The defaults are NaN
// so the fields are always PRESENT: a record at exactly 0/0 must still carry
// its position, and a writer that omitted it must be skipped, not plotted at
// null island — both behaviours only show up if the fixture can express both.
const TBS_FIELD_COUNT = 21;
const TBS_SLOT_ID = 0;
const TBS_SLOT_LATITUDE = 8;
const TBS_SLOT_LONGITUDE = 9;

function tbsRecord(lat, lon, { omitPosition = false, id = "site" } = {}) {
  const b = new flatbuffers.Builder(256);
  const idOffset = b.createString(id);
  b.startObject(TBS_FIELD_COUNT);
  b.addFieldOffset(TBS_SLOT_ID, idOffset, 0);
  if (!omitPosition) {
    b.addFieldFloat64(TBS_SLOT_LATITUDE, lat, NaN);
    b.addFieldFloat64(TBS_SLOT_LONGITUDE, lon, NaN);
  }
  const off = b.endObject();
  b.finish(off, "$TBS");
  return b.asUint8Array();
}

function sizePrefixedStream(payloads) {
  const total = payloads.reduce((sum, p) => sum + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of payloads) {
    view.setUint32(offset, p.length, true);
    out.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return out;
}

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((s, x) => s + 4 + x.length, 0);
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
  let offset = 0;
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  const meta = JSON.parse(decoder.decode(bytes.subarray(offset, offset + metaLen)));
  return { meta };
}

function htqRequest({ method = "GET", requestPath, query = "", body = "" }) {
  const b = new flatbuffers.Builder(1024);
  const methodOff = b.createString(method);
  const pathOff = b.createString(requestPath);
  const queryOff = b.createString(query);
  const bodyOff = HttpRequest.createBodyVector(b, encoder.encode(body));
  HttpRequest.startHttpRequest(b);
  HttpRequest.addMethod(b, methodOff);
  HttpRequest.addPath(b, pathOff);
  HttpRequest.addQuery(b, queryOff);
  HttpRequest.addBody(b, bodyOff);
  const off = HttpRequest.endHttpRequest(b);
  HttpRequest.finishHttpRequestBuffer(b, off);
  return b.asUint8Array();
}

function createHostStub({ config = {}, rows = new Uint8Array(0), mark = null } = {}) {
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
          response = encodeHostcallEnvelope({ ok: true, result: config });
          return 0;
        }
        if (operation === "storage.flatsql_query_stream") {
          // The DURABLE mark read: $IRM records out of the store's per-type
          // table, not a bespoke bookkeeping table.
          const isMark = isMarkQuery(meta.sql);
          if (isMark) {
            const segment = mark ? irmStream([mark]) : new Uint8Array(0);
            response = encodeHostcallEnvelope({ ok: true, result: {} }, [segment]);
            return 0;
          }
          response = encodeHostcallEnvelope({ ok: true, result: {} }, [rows]);
          return 0;
        }
        if (operation === "http.request") {
          response = encodeHostcallEnvelope({
            ok: true,
            result: { status: 200, headers: {}, body: "", body_encoding: "base64" },
          });
          return 0;
        }
        response = encodeHostcallEnvelope({ ok: false, message: `unexpected op ${operation}` });
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

async function runFlowOnce(stub, requestBytes) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(FLOW_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const emitted = [];
  host.enqueueTriggerFrame(0, { portId: "request", bytes: requestBytes });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) emitted.push(Uint8Array.from(frame.bytes));
      return { statusCode: 0 };
    },
  });
  return { emitted };
}

// The egress frame is the $HTR. Decoding it through the generated binding gives
// the STATUS as a number rather than as a string that happened to appear in the
// bytes — a 400 must be a 400, not a substring.
function decodeResponse(emitted) {
  assert.ok(emitted.length > 0, "the flow must emit a response");
  const bytes = emitted[emitted.length - 1];
  for (const offset of [0, 4]) {
    try {
      const bb = new flatbuffers.ByteBuffer(bytes.subarray(offset));
      const htr = HttpResponse.getRootAsHttpResponse(bb);
      const status = htr.status();
      if (status >= 100 && status <= 599) {
        const body = htr.bodyArray();
        return { status, body: body ? decoder.decode(body) : "" };
      }
    } catch {
      // fall through to the next candidate offset
    }
  }
  throw new Error("emitted frame is not a decodable $HTR");
}

// ── the tile fixtures ──────────────────────────────────────────────────────
//
// One tile is chosen and every fixture point is placed in it THROUGH THE
// CLIENT'S OWN INDEX MATH, so "in this tile" means what the renderer means.
const Z = 5;
const HOME_LAT = 40.7;
const HOME_LON = -74.0;
const X = lonToTileX(HOME_LON, Z);
const Y = latToTileY(HOME_LAT, Z);

function jitteredInTile(count, seed = 1) {
  // A deterministic spread inside the tile: no RNG anywhere in a fixture whose
  // whole purpose is to prove the answer is reproducible.
  const points = [];
  let state = seed;
  for (let i = 0; i < count; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const dLat = ((state % 1000) / 1000) * 4 - 2;
    const dLon = (((state >> 10) % 1000) / 1000) * 8 - 4;
    let lat = HOME_LAT + dLat;
    let lon = HOME_LON + dLon;
    if (lonToTileX(lon, Z) !== X || latToTileY(lat, Z) !== Y) {
      lat = HOME_LAT;
      lon = HOME_LON;
    }
    points.push([lat, lon]);
  }
  return points;
}

function storeOf(points, extra = []) {
  return sizePrefixedStream([
    ...points.map(([lat, lon]) => tbsRecord(lat, lon)),
    ...extra,
  ]);
}

// THE DURABLE MARK, as a real $IRM record built by the published JS binding.
// The guest reads it back through flatc's C++ output, so this is a genuine
// cross-implementation round trip rather than two copies of one mistake.
const WARM_MARK = irmRecord({
  providerId: "opencellid",
  sourceUrl: "https://example.invalid/opencellid-bulk.csv",
  nextOffset: 3145728,
  totalBytes: 3145728,
  nextChunkIndex: 1,
  recordsCommitted: 41234,
  updatedAt: "2026-08-24T12:00:00Z",
});

const tilePath = (z, x, y) => `/api/v1/cellular/tiles/${z}/${x}/${y}`;

// ── 1. META ────────────────────────────────────────────────────────────────

test("the meta envelope satisfies the client's meta grammar and reports the store honestly", async () => {
  const stub = createHostStub({ mark: WARM_MARK });
  const { emitted } = await runFlowOnce(
    stub,
    htqRequest({ requestPath: "/api/v1/cellular/tiles/meta" }),
  );
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);
  const meta = JSON.parse(body);
  assertMetaGrammar(meta);

  assert.equal(meta.minZoom, 0);
  assert.equal(meta.maxZoom, 18);
  assert.equal(meta.threshold, 2048);
  assert.equal(meta.budget, 4096);
  assert.equal(meta.densityN, 16);
  assert.equal(meta.latClamp, 85.05112878);
  assert.equal(meta.dataset.cacheState, "warm");
  assert.equal(meta.dataset.records, 41234);
  assert.equal(meta.dataset.epoch, "2026-08-24T12:00:00Z");
  assert.equal(meta.dataset.stale, false);

  // NO ROW SCAN for meta: exactly one store read, and it is the mark read.
  const queries = stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream");
  assert.equal(queries.length, 1, "meta must not scan the record store");
  assert.ok(isMarkQuery(queries[0].meta.sql), "meta's one read is the durable $IRM mark read");
  assert.equal(stub.calls.filter((c) => c.operation === "http.request").length, 0);
});

test("meta over an un-ingested store says empty rather than claiming to be current", async () => {
  const stub = createHostStub({ mark: null });
  const { emitted } = await runFlowOnce(
    stub,
    htqRequest({ requestPath: "/api/v1/cellular/tiles/meta" }),
  );
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);
  const meta = JSON.parse(body);
  assertMetaGrammar(meta);
  assert.equal(meta.dataset.cacheState, "empty");
  assert.equal(meta.dataset.records, 0);
  assert.equal(meta.dataset.stale, true);
  // Still an ISO timestamp — the client refuses anything Date.parse cannot read.
  assert.ok(!Number.isNaN(Date.parse(meta.dataset.epoch)));
});

// ── 2. A POINTS TILE ───────────────────────────────────────────────────────

test("a points tile carries exactly the sites inside it, and passes the client's parser", async () => {
  const inTile = [
    [HOME_LAT, HOME_LON],
    [HOME_LAT + 0.01, HOME_LON + 0.01],
    [HOME_LAT - 0.01, HOME_LON - 0.01],
  ];
  // Two records the tile must NOT contain: a site on the other side of the
  // planet, and a site whose writer omitted its position entirely. The second
  // is the one that matters — a missing double read as 0.0 would plot it at
  // null island and it would appear in SOME tile.
  const rows = storeOf(inTile, [tbsRecord(-33.9, 151.2), tbsRecord(0, 0, { omitPosition: true })]);
  const stub = createHostStub({ mark: WARM_MARK, rows });
  const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);

  const envelope = parseTileEnvelope(body);
  assert.equal(decideRenderMode(envelope), "points");
  assert.equal(envelope.z, Z);
  assert.equal(envelope.x, X);
  assert.equal(envelope.y, Y);
  assert.equal(envelope.count, 3);
  assert.equal(envelope.sampled, false);
  assert.equal(envelope.density, null);
  assert.equal(envelope.points.length, 3);
  assert.equal(envelope.deconflicted, true);

  // Every returned point really does belong to the requested tile, by the
  // CLIENT's index math — the server and the renderer agree on seam ownership.
  for (const p of envelope.points) {
    assert.equal(lonToTileX(p.LONGITUDE, Z), X);
    assert.equal(latToTileY(p.LATITUDE, Z), Y);
  }
  // The positionless record was skipped, not plotted: 4 positioned records were
  // scanned out of the 5 stored.
  assert.equal(envelope.scanned, 4);
  assert.equal(envelope.malformed, 1);
});

test("an empty store answers an empty tile and says which of the two it is", async () => {
  const stub = createHostStub({ mark: null, rows: new Uint8Array(0) });
  const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);
  const envelope = parseTileEnvelope(body);
  assert.equal(decideRenderMode(envelope), "points");
  assert.equal(envelope.count, 0);
  assert.deepEqual(envelope.points, []);
  assert.equal(envelope.density, null);
  // The honesty half: zero towers over an un-ingested store is stated as such.
  assert.equal(envelope.dataset.cacheState, "empty");
  assert.equal(envelope.dataset.records, 0);
  assert.equal(envelope.dataset.stale, true);
  assert.equal(stub.calls.filter((c) => c.operation === "http.request").length, 0);
});

// ── 3. THE DETERMINISTIC SAMPLE ────────────────────────────────────────────

test("a tile above the threshold and at or below budget ships a deterministic sample", async () => {
  const points = jitteredInTile(3000);
  const rows = storeOf(points);
  const runOnce = async () => {
    const stub = createHostStub({ mark: WARM_MARK, rows });
    const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
    return decodeResponse(emitted);
  };
  const first = await runOnce();
  assert.equal(first.status, 200);
  const envelope = parseTileEnvelope(first.body);

  // Still POINTS mode — the client refuses density at or below budget.
  assert.equal(decideRenderMode(envelope), "points");
  assert.equal(envelope.count, 3000, "count is the tile's TRUE population, not the shipped count");
  assert.equal(envelope.sampled, true);
  assert.ok(
    envelope.points.length <= envelope.threshold,
    `a sampled tile ships at most ${envelope.threshold} points, got ${envelope.points.length}`,
  );
  assert.ok(envelope.points.length > 0);

  // DETERMINISM: the same store and the same tile produce byte-identical bytes.
  const second = await runOnce();
  assert.equal(second.body, first.body, "the sample must be reproducible byte-for-byte");
});

// ── 4. A DENSITY TILE ──────────────────────────────────────────────────────

test("a tile above budget ships a 16x16 density grid whose cells account for every site", async () => {
  const points = jitteredInTile(4500);
  const rows = storeOf(points);
  const stub = createHostStub({ mark: WARM_MARK, rows });
  const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);

  const envelope = parseTileEnvelope(body);
  assert.equal(decideRenderMode(envelope), "density");
  assert.equal(envelope.count, 4500);
  assert.ok(envelope.count > envelope.budget);
  assert.equal(envelope.points, null);
  assert.equal(envelope.density.n, 16);
  assert.ok(envelope.density.cells.length > 0);
  assert.ok(envelope.density.cells.length <= 16 * 16);

  // CONSERVATION: a density grid that loses sites is a density grid that lies
  // about the coverage of the planet.
  const summed = envelope.density.cells.reduce((sum, cell) => sum + cell.count, 0);
  assert.equal(summed, envelope.count, "the cells must account for every site in the tile");

  // Every emitted cell is populated (empty cells are omitted, and the client
  // refuses an empty cells array outright).
  for (const cell of envelope.density.cells) {
    assert.ok(cell.count > 0, "an emitted density cell must be populated");
  }

  // THE CELLS MUST PARTITION THEIR PARENT TILE, EXACTLY.
  //
  // The client rebuilds each cell's rectangle from its south-west corner plus
  // the tile span it derives itself. If the corner the server sent was rounded,
  // the last column's east edge overshoots the tile's east edge and adjacent
  // tiles overlap by a sliver at every seam — a density product that
  // double-counts at its own boundaries. Measured at 2e-8 degrees before the
  // cell corners were emitted at round-trip precision; the tolerance here is
  // ZERO, not "small", because the server hands over the exact double it used.
  const bounds = tileBounds(envelope.z, envelope.x, envelope.y);
  for (const cell of envelope.density.cells) {
    const rect = densityCellRectangle(envelope, cell);
    assert.ok(rect.west >= bounds.west, "cell west edge inside the tile");
    assert.ok(rect.east <= bounds.east, "cell east edge inside the tile");
    assert.ok(rect.south >= bounds.south, "cell south edge inside the tile");
    assert.ok(rect.north <= bounds.north, "cell north edge inside the tile");
  }
});

// ── 5. BOUNDS ARE REFUSED, NEVER CLAMPED ───────────────────────────────────

for (const [label, requestPath] of [
  ["zoom above the maximum", tilePath(19, 0, 0)],
  ["zoom far above the maximum", tilePath(30, 0, 0)],
  ["x at 2^z", tilePath(2, 4, 0)],
  ["y at 2^z", tilePath(2, 0, 4)],
  ["a non-integer index", "/api/v1/cellular/tiles/5/3.5/9"],
  ["a negative index", "/api/v1/cellular/tiles/5/-1/9"],
  ["too few path segments", "/api/v1/cellular/tiles/5/9"],
  ["too many path segments", "/api/v1/cellular/tiles/5/9/9/9"],
]) {
  test(`${label} is refused 400, not clamped into a neighbouring tile`, async () => {
    const stub = createHostStub({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
    const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath }));
    const { status, body } = decodeResponse(emitted);
    assert.equal(status, 400, `${requestPath} must be a 400`);
    const error = JSON.parse(body);
    assert.ok(typeof error.error === "string" && error.error.length > 0, "the reason is named");
    assert.ok(["tile-bounds", "tile-path"].includes(error.code), `unexpected code ${error.code}`);

    // A refusal costs the store NOTHING: no row scan, no mark read, no fetch.
    assert.equal(
      stub.calls.filter((c) => c.operation === "storage.flatsql_query_stream").length,
      0,
      "a refused tile request must not read the store",
    );
    assert.equal(stub.calls.filter((c) => c.operation === "http.request").length, 0);
  });
}

// ── 6. THE TILE LANE AND THE CACHE LANE ARE MUTUALLY EXCLUSIVE ─────────────

test("a tile request never reaches the aggregate cache lane, and vice versa", async () => {
  const rows = storeOf([[HOME_LAT, HOME_LON]]);
  const tileStub = createHostStub({ mark: WARM_MARK, rows });
  const { emitted } = await runFlowOnce(tileStub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);
  // The answer is a tile envelope, not the aggregate's verbatim record stream.
  const envelope = parseTileEnvelope(body);
  assert.equal(envelope.scheme, "xyz");

  // The aggregate route is untouched by the tile branch.
  const aggStub = createHostStub({ mark: WARM_MARK, rows });
  const agg = await runFlowOnce(
    aggStub,
    htqRequest({
      method: "POST",
      requestPath: "/api/v1/cellular/aggregate",
      body: JSON.stringify({ PROVIDERS: ["opencellid"], LIMIT: 2000 }),
    }),
  );
  assert.ok(agg.emitted.length > 0);
  const aggQueries = aggStub.calls.filter((c) => c.operation === "storage.flatsql_query_stream");
  assert.equal(aggQueries.length, 2, "the aggregate lane still runs its two reads");
});

// ── 5. THE READ IS SCOPED AND BOUNDED ──────────────────────────────────────
//
// graph sdn-cellular-tile-lane-stalls-after-tile-plan. The tile lane used to
// ask the engine for up to cell_tile_max_rows = 100,000 WHOLE $TBS records on
// EVERY tile request, with no spatial predicate. Two failures, one fatal:
//
//  * O(store), not O(tile): a z=10 tile holding three sites still dragged the
//    whole recent store through the guest.
//  * unbounded in the instance's linear memory: the budget was a ROW COUNT, so
//    it could not respect memory_pages. MEASURED on host-01 (2048 pages =
//    128 MiB, TBS hot window 400,000, ~818 bytes per stored site): WasmEdge
//    refused the grow and the mount answered 502 "flow produced no HTTP
//    response" for every tile, with the query node reported as NEVER REACHED
//    because the runtime counts an invocation only after its entry returns.
//
// The predicate is a PREFILTER over the tile's own rectangle; membership is
// still decided per point by the client's index math, so seam ownership does
// not move into SQL.

const tileRowQuery = (stub) =>
  stub.calls
    .filter((c) => c.operation === "storage.flatsql_query_stream")
    .find((c) => !isMarkQuery(c.meta.sql));

test("the tile row read is scoped to the tile's own rectangle and bounded by the row budget", async () => {
  const stub = createHostStub({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
  await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));

  const rowQuery = tileRowQuery(stub);
  assert.ok(rowQuery, "the tile lane must issue a row read");
  assert.match(
    rowQuery.meta.sql,
    /SELECT _data FROM TBS WHERE LATITUDE >= \?1 AND LATITUDE <= \?2 AND LONGITUDE >= \?3 AND LONGITUDE <= \?4 ORDER BY _rowid DESC LIMIT \?5/,
  );

  // The bound values ARE this tile's rectangle, from the client's own bounds
  // function — the server cannot read a neighbouring tile's rows by accident.
  const bounds = tileBounds(Z, X, Y);
  const params = rowQuery.meta.params;
  assert.equal(params.length, 5);
  assert.deepEqual(
    params.slice(0, 4).map((p) => p.t),
    ["f64", "f64", "f64", "f64"],
  );
  assert.equal(params[0].v, bounds.south);
  assert.equal(params[1].v, bounds.north);
  assert.equal(params[2].v, bounds.west);
  assert.equal(params[3].v, bounds.east);

  // The budget the guest can hold, not the 100,000 that could not fit.
  assert.equal(params[4].t, "i64");
  assert.equal(params[4].v, 25000);
});

test("a deeper tile reads a strictly smaller rectangle than its ancestor", async () => {
  const deep = { z: 12, x: lonToTileX(HOME_LON, 12), y: latToTileY(HOME_LAT, 12) };
  const shallow = { z: 2, x: lonToTileX(HOME_LON, 2), y: latToTileY(HOME_LAT, 2) };

  const read = async (t) => {
    const stub = createHostStub({ mark: WARM_MARK, rows: storeOf([[HOME_LAT, HOME_LON]]) });
    await runFlowOnce(stub, htqRequest({ requestPath: tilePath(t.z, t.x, t.y) }));
    const p = tileRowQuery(stub).meta.params;
    return { south: p[0].v, north: p[1].v, west: p[2].v, east: p[3].v };
  };

  const a = await read(deep);
  const b = await read(shallow);
  assert.ok(a.north - a.south < b.north - b.south, "z=12 must read a narrower latitude band");
  assert.ok(a.east - a.west < b.east - b.west, "z=12 must read a narrower longitude band");
  assert.ok(a.south >= b.south && a.north <= b.north, "the deep tile is inside its ancestor");
  assert.ok(a.west >= b.west && a.east <= b.east, "the deep tile is inside its ancestor");
});

test("an explicit cell_tile_sql override is still taken verbatim, with the budget as its one param", async () => {
  const override = "SELECT _data FROM my_tbs_view ORDER BY rowid DESC LIMIT ?";
  const stub = createHostStub({
    config: { cell_tile_sql: override, cell_tile_max_rows: 1234 },
    mark: WARM_MARK,
    rows: storeOf([[HOME_LAT, HOME_LON]]),
  });
  await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));

  const rowQuery = tileRowQuery(stub);
  assert.equal(rowQuery.meta.sql, override);
  assert.deepEqual(rowQuery.meta.params, [{ t: "i64", v: 1234 }]);

  // ...and the answer ADMITS the read was not scoped to the tile, so an empty
  // tile cannot be misread as "no sites here".
  const { emitted } = await runFlowOnce(
    createHostStub({
      config: { cell_tile_sql: override, cell_tile_max_rows: 1234 },
      mark: WARM_MARK,
      rows: storeOf([[HOME_LAT, HOME_LON]]),
    }),
    htqRequest({ requestPath: tilePath(Z, X, Y) }),
  );
  assert.equal(parseTileEnvelope(decodeResponse(emitted).body).scoped, false);
});

test("a read that hits the row budget answers 200 and SAYS it was truncated", async () => {
  // Four positioned sites in the tile, budget 4: the read came back full, so
  // the tile's population is a floor, not a count. The client is told.
  const rows = storeOf([
    [HOME_LAT, HOME_LON],
    [HOME_LAT + 0.001, HOME_LON + 0.001],
    [HOME_LAT + 0.002, HOME_LON + 0.002],
    [HOME_LAT + 0.003, HOME_LON + 0.003],
  ]);
  const stub = createHostStub({ config: { cell_tile_max_rows: 4 }, mark: WARM_MARK, rows });
  const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const { status, body } = decodeResponse(emitted);
  assert.equal(status, 200);

  const envelope = parseTileEnvelope(body);
  assert.equal(envelope.scanned, 4);
  assert.equal(envelope.truncated, true, "a full read must be reported as truncated");
  assert.equal(envelope.count, 4);
});

test("a read inside the row budget is NOT reported as truncated", async () => {
  const rows = storeOf([[HOME_LAT, HOME_LON]]);
  const stub = createHostStub({ mark: WARM_MARK, rows });
  const { emitted } = await runFlowOnce(stub, htqRequest({ requestPath: tilePath(Z, X, Y) }));
  const envelope = parseTileEnvelope(decodeResponse(emitted).body);
  assert.equal(envelope.truncated, false);
  assert.equal(envelope.scanned, 1);
  assert.equal(envelope.scoped, true, "the default read is scoped to the tile");
});
