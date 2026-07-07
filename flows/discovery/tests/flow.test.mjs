/*
 * Flow-level tests for the compiled discovery flows (gateway loop G.2) —
 * BRIDGE mode. The SAME artifacts the Go host mounts at /api/v1/peers and
 * /api/v1/standards are instantiated in the JS flow runtime host here
 * (browser parity): a $HTQ HttpRequest enters the discover route node, the
 * route -> p2p-discovery -> discovery-shape -> http-respond chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossings are the declared p2p_read hostcalls (p2p.peers_snapshot /
 * p2p.standards_snapshot), stubbed with the Go-host response dialect.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest, fnv1a64Hex } from "space-data-module-sdk/http";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { EPM, EntityType } from "../../../../spacedatastandards.org/lib/js/EPM/main.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PEERS_WASM = new URL("../dist/peers/runtime.wasm", import.meta.url);
const STANDARDS_WASM = new URL("../dist/standards/runtime.wasm", import.meta.url);
const PNM_WASM = new URL("../dist/pnm/runtime.wasm", import.meta.url);
const LATEST_WASM = new URL("../dist/latest/runtime.wasm", import.meta.url);

const CELESTRAK_PEER = "16Uiu2HAm9oK2jAeVC2RMESFcYfq7BKGp2K2CCDxzoKhB5s9vpbj3";
const SELF_PEER = "16Uiu2HAm1LbvwjEHW2GDP2ZQZvwHLZrz2jbYoRLQmJEQ3wZ5Fm45";

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect; see hostcap/p2p-discovery tests).
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
  let offset = 0;
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  const meta = JSON.parse(decoder.decode(bytes.subarray(offset, offset + metaLen)));
  offset += metaLen;
  return { meta };
}

function buildEPM({ dn, alternateNames = [], addrs = [] }) {
  const builder = new flatbuffers.Builder(512);
  const dnOffset = builder.createString(dn);
  const altOffset = alternateNames.length
    ? EPM.createAlternateNamesVector(builder, alternateNames.map((name) => builder.createString(name)))
    : 0;
  const addrsOffset = addrs.length
    ? EPM.createMultiformatAddressVector(builder, addrs.map((addr) => builder.createString(addr)))
    : 0;
  EPM.startEPM(builder);
  EPM.addDn(builder, dnOffset);
  if (altOffset) EPM.addAlternateNames(builder, altOffset);
  if (addrsOffset) EPM.addMultiformatAddress(builder, addrsOffset);
  EPM.addSignatureTimestamp(builder, BigInt(1751793600));
  EPM.addEntityType(builder, EntityType.Node);
  EPM.finishSizePrefixedEPMBuffer(builder, EPM.endEPM(builder));
  return builder.asUint8Array().slice();
}

// Concatenate frames into a stream. EPM fixtures are already
// size-prefix-finished; raw fixtures (fake PNM bytes) get a prefix added.
function sizePrefixedStream(frames, { prefixed = false } = {}) {
  const extra = prefixed ? 0 : 4;
  const total = frames.reduce((sum, frame) => sum + extra + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    if (!prefixed) {
      view.setUint32(offset, frame.length, true);
      stream.set(frame, offset + 4);
    } else {
      stream.set(frame, offset);
    }
    offset += extra + frame.length;
  }
  return stream;
}

function splitStream(stream) {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const frames = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === 0) continue;
    frames.push(stream.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

const CELESTRAK_EPM = buildEPM({
  dn: "celestrak",
  alternateNames: ["celestrak.eth"],
  addrs: [`/p2p/${CELESTRAK_PEER}`],
});

const PNM_FRAME = encoder.encode("fake-pnm-frame-bytes____");

function peersResult() {
  return {
    self: SELF_PEER,
    peers: [
      {
        peer_id: CELESTRAK_PEER,
        addrs: ["/ip4/167.172.219.213/tcp/4001"],
        connected: true,
        self: false,
        agent_version: "spacedatanetwork/1.0.4",
        standards: ["CAT", "OMM", "SPW"],
        epm_index: 0,
      },
      {
        peer_id: SELF_PEER,
        addrs: ["/ip4/104.131.11.220/tcp/4001"],
        connected: true,
        self: true,
        standards: ["OMM"],
        epm_index: -1,
      },
    ],
    records: { $bin: 0 },
  };
}

function standardsResult() {
  return {
    entries: [
      {
        peer_id: CELESTRAK_PEER,
        standard: "OMM",
        schema: "OMM.fbs",
        file_id: "celestrak:gp:OMM.fbs:2026-07-06T03:00:00Z",
        cid: "bafy-omm",
        publish_timestamp: "2026-07-06T03:00:00Z",
        pnm_index: 0,
      },
    ],
    records: { $bin: 0 },
  };
}

const PNM_FRAME_NEW = encoder.encode("signed-pnm-frame-newest_");
const PNM_FRAME_OLD = encoder.encode("signed-pnm-frame-older__");

function pnmHistoryResult(limit = 1) {
  const entries = [
    {
      publisher_peer_id: CELESTRAK_PEER,
      gossip_peer_id: SELF_PEER,
      standard: "OMM",
      schema: "OMM.fbs",
      file_id: "celestrak:gp:OMM.fbs:2026-07-06T03:00:00Z",
      file_name: "dataset.fsql",
      cid: "bafy-omm-new",
      publish_timestamp: "2026-07-06T03:00:00Z",
      signature_type: "Ed25519",
      signature: "aa".repeat(64),
      signature_verified: true,
      attribution: "signature",
      publisher_key: "bb".repeat(32),
      publisher_key_source: "epm-directory",
      pnm_index: 0,
    },
    {
      publisher_peer_id: CELESTRAK_PEER,
      gossip_peer_id: CELESTRAK_PEER,
      standard: "CAT",
      schema: "CAT.fbs",
      file_id: "celestrak:satcat:CAT.fbs:2026-07-06T02:00:00Z",
      file_name: "dataset.fsql",
      cid: "bafy-cat",
      publish_timestamp: "2026-07-06T02:00:00Z",
      signature_type: "Ed25519",
      signature: "cc".repeat(64),
      signature_verified: true,
      attribution: "signature",
      publisher_key: "bb".repeat(32),
      publisher_key_source: "epm-directory",
      pnm_index: 1,
    },
  ].slice(0, limit);
  // Go json.Marshal emits map keys ALPHABETICALLY — mirror that byte layout
  // (an insertion-ordered stub masked a real key-vs-value collision bug:
  // "attribution":"signature" precedes the "signature" key on the wire).
  const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sortKeys({
    peer_id: CELESTRAK_PEER,
    publisher_key_available: true,
    gossip_only_excluded: 0,
    entries: entries.map(sortKeys),
    records: { $bin: 0 },
  });
}

// Go json.Marshal emits map keys ALPHABETICALLY at every level — fixtures
// must mirror that byte layout (the G.3 key-vs-value collision lesson).
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, deepSortKeys(v)]),
    );
  }
  return value;
}

// Hostcall stub speaking the Go-host dialect: response envelope with the
// record stream as binary segment 0 ({"$bin":0} in the result).
function createDiscoveryStub({ peers = peersResult(), standards = standardsResult(), pnmHistory, stream, latest } = {}) {
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

        if (operation === "p2p.peers_snapshot") {
          response = encodeHostcallEnvelope(
            { ok: true, result: peers },
            [stream ?? sizePrefixedStream([CELESTRAK_EPM], { prefixed: true })],
          );
          return 0;
        }
        if (operation === "p2p.standards_snapshot") {
          response = encodeHostcallEnvelope(
            { ok: true, result: standards },
            [stream ?? sizePrefixedStream([PNM_FRAME])],
          );
          return 0;
        }
        if (operation === "p2p.pnm_history") {
          const result = pnmHistory ?? pnmHistoryResult(meta.limit ?? 1);
          response = encodeHostcallEnvelope(
            { ok: true, result },
            [stream ?? sizePrefixedStream([PNM_FRAME_NEW, PNM_FRAME_OLD].slice(0, result.entries.length))],
          );
          return 0;
        }
        if (operation === "p2p.latest_dataset" && latest) {
          const { result, segments = [] } = typeof latest === "function" ? latest(meta) : latest;
          response = encodeHostcallEnvelope({ ok: true, result: deepSortKeys(result) }, segments);
          return 0;
        }
        response = encodeHostcallEnvelope({ ok: false, error: { message: `unexpected op ${operation}` } });
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

async function pumpRequest(wasmURL, stub, request) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmURL))),
    extraImports: stub.imports,
  });
  stub.memoryRef.memory = host.memory;

  const responses = [];
  host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest(request),
  });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) {
          responses.push(decodeHttpResponse(frame.bytes));
        }
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, "expected exactly one $HTR frame");
  return responses[0];
}

function header(http, name) {
  for (const entry of http.headers ?? []) {
    if (entry.name === name) return entry.value;
  }
  return undefined;
}

test("peers flow: GET /api/v1/peers streams one $EPM frame per peer", async () => {
  const stub = createDiscoveryStub({});
  const http = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: "/api/v1/peers",
    query: "",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.match(header(http, "etag"), /^W\/"fnv1a64-[0-9a-f]{16}"$/);
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(http.body)}"`);

  const frames = splitStream(http.body);
  assert.equal(frames.length, 2);
  // Frame 0 = celestrak's stored EPM verbatim.
  assert.deepEqual(Array.from(frames[0]), Array.from(CELESTRAK_EPM.subarray(4)), "stored EPM spliced verbatim");
  // Frame 1 = synthesized minimal EPM (self peer without a stored profile).
  const synthesized = EPM.getRootAsEPM(new flatbuffers.ByteBuffer(frames[1].slice()));
  assert.equal(synthesized.DN(), SELF_PEER);
  assert.equal(synthesized.MULTIFORMAT_ADDRESS(0), `/p2p/${SELF_PEER}`);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "p2p.peers_snapshot");
});

test("peers flow: format=json is a bare array carrying peerID + standards (cold-client discovery contract)", async () => {
  const stub = createDiscoveryStub({});
  const http = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: "/api/v1/peers",
    query: "format=json",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.equal(header(http, "x-sdn-record-count"), "2");

  const records = JSON.parse(decoder.decode(http.body));
  assert.ok(Array.isArray(records), "bare top-level array");
  const celestrak = records.find((record) => record.peer_id === CELESTRAK_PEER);
  assert.ok(celestrak, "celestrak peer discoverable");
  assert.deepEqual(celestrak.standards, ["CAT", "OMM", "SPW"]);
  assert.deepEqual(celestrak.epm.alternate_names, ["celestrak.eth"]);
});

test("peers flow: /peers/{peerId} narrows to one record; 404 on unknown; If-None-Match answers 304", async () => {
  // Single peer.
  let stub = createDiscoveryStub({});
  const single = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}`,
    query: "format=json",
  });
  assert.equal(single.status, 200);
  assert.equal(header(single, "x-sdn-record-count"), "1");
  assert.equal(stub.calls[0].meta.peer_id, CELESTRAK_PEER, "peerId filter reached the hostcall");
  const etag = header(single, "etag");

  // Unknown peer -> 404 (the snapshot has no such peer).
  stub = createDiscoveryStub({});
  const missing = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: "/api/v1/peers/16Uiu2Nobody",
    query: "",
  });
  assert.equal(missing.status, 404);

  // Conditional GET: If-None-Match with the fb-derived etag -> 304 for BOTH
  // encodings (shared tag).
  stub = createDiscoveryStub({});
  const conditional = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}`,
    query: "format=json",
    headers: { "if-none-match": etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal(header(conditional, "etag"), etag);
  assert.equal(conditional.body?.length ?? 0, 0, "304 carries no body");
});

test("peers flow: non-GET and deeper paths answer 404, POST never reaches the hostcall", async () => {
  const stub = createDiscoveryStub({});
  const post = await pumpRequest(PEERS_WASM, stub, {
    method: "POST",
    path: "/api/v1/peers",
    query: "",
  });
  assert.equal(post.status, 404);
  assert.equal(stub.calls.length, 0, "not_found short-circuits the hostcall");

  const deep = await pumpRequest(PEERS_WASM, createDiscoveryStub({}), {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
  });
  assert.equal(deep.status, 404, "G.3 surface not served by this flow");
});

test("standards flow: GET /api/v1/standards streams $PNM frames + json presentation", async () => {
  let stub = createDiscoveryStub({});
  const fb = await pumpRequest(STANDARDS_WASM, stub, {
    method: "GET",
    path: "/api/v1/standards",
    query: "",
  });
  assert.equal(fb.status, 200);
  assert.equal(header(fb, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(header(fb, "x-sdn-record-count"), "1");
  const frames = splitStream(fb.body);
  assert.deepEqual(Array.from(frames[0]), Array.from(PNM_FRAME), "$PNM frame spliced verbatim");
  assert.equal(stub.calls[0].operation, "p2p.standards_snapshot");

  stub = createDiscoveryStub({});
  const json = await pumpRequest(STANDARDS_WASM, stub, {
    method: "GET",
    path: "/api/v1/standards",
    query: "format=json",
  });
  assert.equal(json.status, 200);
  const records = JSON.parse(decoder.decode(json.body));
  assert.equal(records.length, 1);
  assert.equal(records[0].peer_id, CELESTRAK_PEER);
  assert.equal(records[0].standard, "OMM");
  assert.equal(records[0].file_id, "celestrak:gp:OMM.fbs:2026-07-06T03:00:00Z");
  assert.equal(header(json, "etag"), header(fb, "etag"), "shared tag across encodings");
});

test("pnm flow: GET /api/v1/peers/{peerId}/pnm serves the newest signed $PNM verbatim (loop G.3)", async () => {
  const stub = createDiscoveryStub({});
  const http = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(header(http, "x-sdn-record-count"), "1");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(http.body)}"`);

  const frames = splitStream(http.body);
  assert.equal(frames.length, 1, "default limit=1 -> newest publication only");
  assert.deepEqual(Array.from(frames[0]), Array.from(PNM_FRAME_NEW), "signed frame spliced VERBATIM");

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "p2p.pnm_history");
  assert.equal(stub.calls[0].meta.peer_id, CELESTRAK_PEER);
  assert.equal(stub.calls[0].meta.limit, 1, "clamped default limit forwarded to the host");
});

test("pnm flow: ?limit=N forwards the clamp and format=json exposes provenance fields", async () => {
  let stub = createDiscoveryStub({});
  const fb = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "limit=2",
  });
  assert.equal(fb.status, 200);
  assert.equal(header(fb, "x-sdn-record-count"), "2");
  assert.equal(stub.calls[0].meta.limit, 2);
  const fbEtag = header(fb, "etag");

  stub = createDiscoveryStub({});
  const overclamp = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "limit=99999",
  });
  assert.equal(overclamp.status, 200);
  assert.equal(stub.calls[0].meta.limit, 100, "limit clamped in-wasm to the api-block max");

  stub = createDiscoveryStub({});
  const json = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "limit=2&format=json",
  });
  assert.equal(json.status, 200);
  assert.equal(header(json, "content-type"), "application/json");
  assert.equal(header(json, "etag"), fbEtag, "shared tag across encodings");
  const records = JSON.parse(decoder.decode(json.body));
  assert.ok(Array.isArray(records), "bare top-level array");
  assert.equal(records.length, 2);
  assert.equal(records[0].publisher_peer_id, CELESTRAK_PEER);
  assert.equal(records[0].gossip_peer_id, SELF_PEER, "gossip attribution exposed honestly");
  assert.equal(records[0].signature_verified, true);
  assert.equal(records[0].attribution, "signature");
  assert.equal(records[0].signature, "aa".repeat(64));
  assert.equal(records[0].publisher_key, "bb".repeat(32));
  assert.equal(records[0].publisher_key_source, "epm-directory");
  assert.equal(records[0].cid, "bafy-omm-new");
  assert.equal(records[1].standard, "CAT");
});

test("pnm flow: empty history answers 404; If-None-Match answers 304; POST short-circuits", async () => {
  // No attributable publications -> 404, not an empty 200.
  let stub = createDiscoveryStub({
    pnmHistory: {
      peer_id: "16Uiu2Nobody",
      publisher_key_available: false,
      gossip_only_excluded: 0,
      entries: [],
      records: { $bin: 0 },
    },
    stream: new Uint8Array(0),
  });
  const missing = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: "/api/v1/peers/16Uiu2Nobody/pnm",
    query: "",
  });
  assert.equal(missing.status, 404);

  // Conditional GET with the stream tag -> 304.
  stub = createDiscoveryStub({});
  const first = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
  });
  const etag = header(first, "etag");
  const conditional = await pumpRequest(PNM_WASM, createDiscoveryStub({}), {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
    headers: { "if-none-match": etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body?.length ?? 0, 0);

  // POST is not a discovery read; the hostcall is never issued.
  stub = createDiscoveryStub({});
  const post = await pumpRequest(PNM_WASM, stub, {
    method: "POST",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
  });
  assert.equal(post.status, 404);
  assert.equal(stub.calls.length, 0);
});

test("pnm flow: sibling discovery routes are NOT served by this mount", async () => {
  const stub = createDiscoveryStub({});
  const peersList = await pumpRequest(PNM_WASM, stub, {
    method: "GET",
    path: "/api/v1/peers",
    query: "",
  });
  assert.equal(peersList.status, 404, "route-ownership guard");
  assert.equal(stub.calls.length, 0, "no hostcall for unowned routes");
});

test("peers flow: {peerId}/pnm requests are NOT served by the peers mount (G.3 sibling)", async () => {
  const stub = createDiscoveryStub({});
  const pnmOnPeers = await pumpRequest(PEERS_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/pnm`,
    query: "",
  });
  assert.equal(pnmOnPeers.status, 404);
  assert.equal(stub.calls.length, 0, "peers_snapshot hostcall never issued for pnm_history");
});

test("both bundles carry the api block for the OpenAPI generator", () => {
  const peersFlow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/peers/flow.json", import.meta.url)), "utf8"));
  assert.equal(peersFlow.api.basePath, "/api/v1/peers");
  assert.deepEqual(
    peersFlow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [["GET", "", true], ["GET", "{peerId}", true]],
  );
  const standardsFlow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/standards/flow.json", import.meta.url)), "utf8"));
  assert.equal(standardsFlow.api.basePath, "/api/v1/standards");
  assert.deepEqual(
    standardsFlow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [["GET", "", true]],
  );
  const pnmFlow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/pnm/flow.json", import.meta.url)), "utf8"));
  assert.equal(pnmFlow.api.basePath, "/api/v1/peers/{peerId}/pnm");
  assert.deepEqual(
    pnmFlow.api.routes.map((route) => [route.method, route.path, route.anonymous]),
    [["GET", "", true]],
  );
  const limitParam = pnmFlow.api.routes[0].params.find((param) => param.name === "limit");
  assert.equal(limitParam.schema.default, 1);
  assert.equal(limitParam.schema.maximum, 100);
});

// ---------------------------------------------------------------------------
// latest-dataset flow (gateway loop G.4).
// ---------------------------------------------------------------------------

// STORED record form: SIZE-PREFIXED $OMM FlatBuffers (the ingest wire form).
function encodeLatestOmm(record) {
  const builder = new flatbuffers.Builder(512);
  const objectName = builder.createString(record.object_name);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectName);
  OMM.addMeanMotion(builder, record.mean_motion);
  OMM.addNoradCatId(builder, record.norad_cat_id);
  OMM.addUserDefinedEpochTimestamp(builder, record.epoch_ts);
  OMM.finishSizePrefixedOMMBuffer(builder, OMM.endOMM(builder));
  return builder.asUint8Array().slice();
}

const LATEST_STORED_RECORDS = [
  encodeLatestOmm({ object_name: "ISS (ZARYA)", norad_cat_id: 25544, mean_motion: 15.49, epoch_ts: 1783300000 }),
  encodeLatestOmm({ object_name: "NOAA 19", norad_cat_id: 33591, mean_motion: 14.12, epoch_ts: 1783300100 }),
];
// PUBLISHED shard form (live-host shape): stored records wrapped in OUTER
// stream frames — double-prefixed. The fb path serves these bytes verbatim;
// the json path unwraps the redundant outer layer before omm-json.
const LATEST_OMM_STREAM = sizePrefixedStream(LATEST_STORED_RECORDS, { prefixed: false });

function latestPNMPointer(batch) {
  return {
    attribution: "signature",
    batch_id: batch,
    cid: `bafy-manifest-${batch}`,
    file_id: `sdn-OMM-full:OMM.fbs:${batch}:part-000001`,
    publish_timestamp: "2026-07-06T06:00:00Z",
    schema: "OMM.fbs",
    signature_verified: true,
    standard: "OMM",
  };
}

function latestServingResult({ ref = null, schema = "OMM.fbs", etag = fnv1a64Hex(LATEST_OMM_STREAM) } = {}) {
  const serving = {
    batch_id: "batch-new",
    byte_count: LATEST_OMM_STREAM.length,
    etag_fnv1a64: etag,
    parts: 1,
    pnm: latestPNMPointer("batch-new"),
    provider_id: "space-data-network-02",
    published_at: "2026-07-06T06:00:00Z",
    record_count: 2,
    source_name: "celestrak-gp",
  };
  if (ref) serving.ref = ref;
  else serving.stream = { $bin: 0 };
  return {
    fresh: true,
    known: true,
    pinned: true,
    pnm: latestPNMPointer("batch-new"),
    schema,
    self: false,
    serving,
    standard: schema.replace(/\.fbs$/, ""),
  };
}

test("latest flow: pinned dataset serves the published batch stream verbatim (loop G.4)", async () => {
  const stub = createDiscoveryStub({
    latest: { result: latestServingResult(), segments: [LATEST_OMM_STREAM] },
  });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/omm/latest`,
    query: "",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(LATEST_OMM_STREAM)}"`);
  assert.deepEqual(Array.from(http.body), Array.from(LATEST_OMM_STREAM), "batch stream spliced verbatim");

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].operation, "p2p.latest_dataset");
  assert.equal(stub.calls[0].meta.peer_id, CELESTRAK_PEER);
  assert.equal(stub.calls[0].meta.standard, "omm");
  assert.equal(stub.calls[0].meta.deliver, "ref");
});

test("latest flow: host body reference rides the $HTR BODY_REF fields (loop G.4)", async () => {
  const etag = fnv1a64Hex(LATEST_OMM_STREAM);
  const stub = createDiscoveryStub({
    latest: {
      result: latestServingResult({ ref: { fnv1a64: etag, frames: 2, size: LATEST_OMM_STREAM.length, token: 9 } }),
      segments: [],
    },
  });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/omm/latest`,
    query: "",
  });
  assert.equal(http.status, 200);
  assert.equal(Number(http.bodyRefToken), 9);
  assert.equal(Number(http.bodyRefSize), LATEST_OMM_STREAM.length);
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${etag}"`);
  assert.equal(http.body?.length ?? 0, 0, "no inline body with a BODY_REF");
});

test("latest flow: format=json is the bare-array OMM presentation with the shared etag (loop G.4)", async () => {
  const stub = createDiscoveryStub({
    latest: (meta) => {
      assert.equal(meta.deliver, undefined, "json path must request inline bytes");
      return { result: latestServingResult(), segments: [LATEST_OMM_STREAM] };
    },
  });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/omm/latest`,
    query: "format=json",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  assert.equal(header(http, "x-sdn-record-count"), "2");
  assert.equal(header(http, "etag"), `W/"fnv1a64-${fnv1a64Hex(LATEST_OMM_STREAM)}"`);
  const records = JSON.parse(decoder.decode(http.body));
  assert.ok(Array.isArray(records), "bare top-level array");
  assert.equal(records.length, 2);
  assert.equal(records[0].object_name, "ISS (ZARYA)");
  assert.equal(records[0].norad_cat_id, 25544);
});

test("latest flow: format=json for a non-OMM standard answers 406 with the pnm pointer (loop G.4)", async () => {
  const result = latestServingResult({ schema: "CAT.fbs" });
  result.pnm = { ...latestPNMPointer("batch-new"), schema: "CAT.fbs", standard: "CAT" };
  const stub = createDiscoveryStub({ latest: { result, segments: [LATEST_OMM_STREAM] } });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/cat/latest`,
    query: "format=json",
  });
  assert.equal(http.status, 406);
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /format=json is not available/);
  assert.equal(body.pnm.cid, "bafy-manifest-batch-new");
});

test("latest flow: unpinned answers an honest 503 carrying the newest PNM pointer (loop G.4)", async () => {
  const stub = createDiscoveryStub({
    latest: {
      result: {
        known: true,
        pinned: false,
        pnm: latestPNMPointer("batch-new"),
        reason: "not-pinned",
        schema: "OMM.fbs",
        self: false,
        standard: "OMM",
      },
      segments: [],
    },
  });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/omm/latest`,
    query: "",
  });
  assert.equal(http.status, 503);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /not pinned/);
  assert.equal(body.pnm.cid, "bafy-manifest-batch-new");
  assert.equal(body.pnm.publish_timestamp, "2026-07-06T06:00:00Z");
  assert.equal(body.pnm.signature_verified, true);
});

test("latest flow: unknown provider/standard answers 404; If-None-Match answers 304 (loop G.4)", async () => {
  const stub = createDiscoveryStub({
    latest: { result: { known: false, reason: "no-publications" }, segments: [] },
  });
  const http = await pumpRequest(LATEST_WASM, stub, {
    method: "GET",
    path: `/api/v1/peers/16Uiu2HAmNobody/omm/latest`,
    query: "",
  });
  assert.equal(http.status, 404);

  const etag = fnv1a64Hex(LATEST_OMM_STREAM);
  const cachedStub = createDiscoveryStub({
    latest: { result: latestServingResult(), segments: [LATEST_OMM_STREAM] },
  });
  const cached = await pumpRequest(LATEST_WASM, cachedStub, {
    method: "GET",
    path: `/api/v1/peers/${CELESTRAK_PEER}/omm/latest`,
    query: "",
    headers: [{ name: "if-none-match", value: `W/"fnv1a64-${etag}"` }],
  });
  assert.equal(cached.status, 304);
  assert.equal(header(cached, "etag"), `W/"fnv1a64-${etag}"`);
  assert.equal(cached.body?.length ?? 0, 0);
});

test("latest bundle carries the api block for the OpenAPI generator (loop G.4)", () => {
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/latest/flow.json", import.meta.url)), "utf8"));
  assert.equal(flow.api.basePath, "/api/v1/peers/{peerId}/{standard}/latest");
  assert.equal(flow.api.routes.length, 1);
  assert.equal(flow.api.routes[0].anonymous, true);
  assert.ok(flow.api.routes[0].responses["503"]);
});
