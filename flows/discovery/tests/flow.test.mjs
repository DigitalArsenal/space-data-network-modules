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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PEERS_WASM = new URL("../dist/peers/runtime.wasm", import.meta.url);
const STANDARDS_WASM = new URL("../dist/standards/runtime.wasm", import.meta.url);

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
  EPM.addEntityType(builder, EntityType.Node);
  EPM.finishEPMBuffer(builder, EPM.endEPM(builder));
  return builder.asUint8Array().slice();
}

function sizePrefixedStream(frames) {
  const total = frames.reduce((sum, frame) => sum + 4 + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    stream.set(frame, offset + 4);
    offset += 4 + frame.length;
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

// Hostcall stub speaking the Go-host dialect: response envelope with the
// record stream as binary segment 0 ({"$bin":0} in the result).
function createDiscoveryStub({ peers = peersResult(), standards = standardsResult(), stream } = {}) {
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
            [stream ?? sizePrefixedStream([CELESTRAK_EPM])],
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
  assert.deepEqual(Array.from(frames[0]), Array.from(CELESTRAK_EPM));
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
});
