/*
 * Flow-level tests for the compiled data-retrieval flow — BRIDGE mode.
 *
 * WHAT THESE TESTS ARE FOR (graph task
 * `modules-data-retrieval-flatbuffer-branch-emits-nothing`, P1):
 *
 * This suite used to be written exclusively against engineLinkage "flatsql"
 * (loop C.7 direct linkage). That linkage is RETIRED — the shipped bundle is
 * engineLinkage "bridge" — so every test in the file failed at setup with
 * "engineLink was provided but the flow artifact exports no
 * sdn_flatsql_link_init". A suite that cannot instantiate the artifact it
 * ships asserts NOTHING, and that is exactly how the flow's DEFAULT branch
 * reached production dead: /omm/bulk and /cat/bulk answered 502 "flow produced
 * no HTTP response" for every request that did not say format=json, while the
 * only lane with (nominal) coverage was the json one.
 *
 * So these tests instantiate THE SHIPPED ARTIFACT (dist/isomorphic/module.wasm,
 * engineLinkage "bridge") against a REAL JS-hosted FlatSQL engine behind a
 * hostcall stub that implements the Go host's storage.flatsql_* contract
 * INCLUDING "deliver":"ref" — the reference-delivery election that the live Go
 * host honours (sdn-server internal/modulert/caps/storage.go streamResult) and
 * that the flow's flatbuffer branch always requests.
 *
 * THE REGRESSION THEY PIN: a body-reference descriptor is a frame on the SAME
 * typed edge as the bytes it stands for ($OMM/OMM.fbs, alignment 8). It used
 * to be pushed with no type claim and required_alignment=1, so the compiled
 * runtime's route_output rejected it (-26) and DROPPED it silently: `branch`
 * was never invoked, no $HTR was ever emitted, drain reported no error, and
 * the host answered 502 with no detail. Any test that asserts a 200 on the
 * DEFAULT (format-less) request would have caught it; none existed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";
import { loadFlatSQLStandalone } from "../../../../flatsql/wasm/standalone.js";
import { createFlowRuntimeHost, decodeFlowProgram } from "space-data-module-sdk/flow";
import {
  decodeHttpResponse,
  encodeHttpRequest,
  findHttpHeader,
  fnv1a64Hex,
} from "space-data-module-sdk/http";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const ARTIFACT_PATH = new URL("../dist/artifact.json", import.meta.url);
const MANIFEST_PATH = new URL("../dist/plugin-manifest.json", import.meta.url);

// Non-integer epoch so the reference query's JS param tagging (f64) matches
// the module's TLV encoding exactly.
const EPOCH_SECONDS = 1_782_950_400.5;
const SOURCE = "celestrak-gp";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readWasm() {
  return new Uint8Array(fs.readFileSync(fileURLToPath(WASM_PATH)));
}

// ---------------------------------------------------------------------------
// Real engine database: the server's engine OMM schema (byte-copied from
// sdn-server internal/storage/engine_records.go), $OMM routing, per-source
// shadow tables + unified view — the same layout FlatSQLStore builds.
// ---------------------------------------------------------------------------

const ENGINE_RECORD_SCHEMA = `
  table OMM {
    CCSDS_OMM_VERS:double;
    CREATION_DATE:string;
    ORIGINATOR:string;
    OBJECT_NAME:string;
    OBJECT_ID:string;
    CENTER_NAME:string;
    REFERENCE_FRAME:RFM;
    REFERENCE_FRAME_EPOCH:string;
    TIME_SYSTEM:timingStandard = UTC;
    MEAN_ELEMENT_THEORY:meanElementSource = SGP4;
    COMMENT:string;
    EPOCH:string;
    SEMI_MAJOR_AXIS:double;
    MEAN_MOTION:double;
    ECCENTRICITY:double;
    INCLINATION:double;
    RA_OF_ASC_NODE:double;
    ARG_OF_PERICENTER:double;
    MEAN_ANOMALY:double;
    GM:double;
    MASS:double;
    SOLAR_RAD_AREA:double;
    SOLAR_RAD_COEFF:double;
    DRAG_AREA:double;
    DRAG_COEFF:double;
    EPHEMERIS_TYPE:ephemerisFormat = SGP4;
    CLASSIFICATION_TYPE:string;
    NORAD_CAT_ID:uint32;
    ELEMENT_SET_NO:uint32;
    REV_AT_EPOCH:double;
    BSTAR:double;
    MEAN_MOTION_DOT:double;
    MEAN_MOTION_DDOT:double;
    COV_REFERENCE_FRAME:RFM;
    COVARIANCE:[double];
    USER_DEFINED_BIP_0044_TYPE:uint;
    USER_DEFINED_OBJECT_DESIGNATOR:string;
    USER_DEFINED_EARTH_MODEL:string;
    USER_DEFINED_EPOCH_TIMESTAMP: double;
    USER_DEFINED_MICROSECONDS: double;
  }
  root_type OMM;
  file_identifier "$OMM";
`;

// The engine-native nearest-epoch SQL — byte-identical in the retrieval
// module, the Go store, and here (?1 source shadow, ?2 epoch, ?3 limit).
const NEAREST_SQL =
  "SELECT _data FROM (SELECT _data, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY " +
  "ABS(USER_DEFINED_EPOCH_TIMESTAMP - ?2)) rn FROM OMM WHERE (?1 = '' OR _source = ?1)) WHERE " +
  "rn = 1 LIMIT ?3";

const RECORDS = [
  {
    norad_cat_id: 25544,
    object_name: "ISS (ZARYA)",
    object_id: "1998-067A",
    epoch: "2026-07-01T12:00:00.000000Z",
    epoch_ts: 1_782_907_200,
    mean_motion: 15.49309239,
    eccentricity: 0.0007976,
    inclination: 51.6416,
  },
  {
    norad_cat_id: 33591,
    object_name: "NOAA 19",
    object_id: "2009-005A",
    epoch: "2026-07-01T00:00:00.000000Z",
    epoch_ts: 1_782_864_000,
    mean_motion: 14.12501077,
    eccentricity: 0.0013872,
    inclination: 99.1943,
  },
];

function encodeOmm(record) {
  const builder = new flatbuffers.Builder(512);
  const objectName = builder.createString(record.object_name);
  const objectId = builder.createString(record.object_id);
  const epoch = builder.createString(record.epoch);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectName);
  OMM.addObjectId(builder, objectId);
  OMM.addEpoch(builder, epoch);
  OMM.addMeanMotion(builder, record.mean_motion);
  OMM.addEccentricity(builder, record.eccentricity);
  OMM.addInclination(builder, record.inclination);
  OMM.addNoradCatId(builder, record.norad_cat_id);
  OMM.addUserDefinedEpochTimestamp(builder, record.epoch_ts);
  OMM.finishOMMBuffer(builder, OMM.endOMM(builder));
  return builder.asUint8Array();
}

async function createEngineWithData() {
  const engine = await loadFlatSQLStandalone();
  const db = engine.createDatabase(ENGINE_RECORD_SCHEMA, "sdn-parity");
  db.registerFileId("$OMM", "OMM");
  const rt = engine._runtime;
  rt.withCString(SOURCE, (ptr) => rt.exports.flatsql_register_source(db._handle, ptr));
  rt.exports.flatsql_create_unified_views(db._handle);
  for (const record of RECORDS) {
    const seq = db.ingestOne(encodeOmm(record), SOURCE);
    assert.ok(seq >= 0, "engine ingest failed");
  }
  return { engine, db };
}

// The reference bytes: what the ENGINE itself serves for the nearest-epoch
// query the flow is about to run (all sources, limit 100).
function referenceStream(db, { limit = 100 } = {}) {
  return db.queryRawFlatBufferStream(NEAREST_SQL, ["", EPOCH_SECONDS, limit]);
}

// Mirrors http_respond_module.cpp count_stream_frames EXACTLY: size-prefixed
// frames, zero-length prefixes skipped as padding, NO alignment padding. The
// header the flow serves must equal this for byte-identical streams.
function countStreamFrames(bytes) {
  let count = 0;
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) return -1;
    const size = view.getUint32(offset, true);
    offset += 4;
    if (size === 0) continue;
    if (size > bytes.length - offset) return -1;
    offset += size;
    count++;
  }
  return count;
}

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total =
    4 + metaBytes.length + 4 + segments.reduce((sum, segment) => sum + 4 + segment.length, 0);
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

// The host publishes the WORD-FOLDED FNV-1a 64 of the stream (Go:
// flatsqlrt.RawStream.FNV1a64). It is the same function the flow computes
// in-wasm on the byte path, which is why a ref-delivered body and a
// byte-delivered body must carry the SAME etag — asserted below.
const hostStreamHash = (bytes) => fnv1a64Hex(bytes);

// ---------------------------------------------------------------------------
// Hostcall bridge stub — the Go host's storage capability, faithfully.
//
// It honours "deliver":"ref" exactly as
// sdn-server internal/modulert/caps/storage.go streamResult does: the stream
// bytes stay OUT of the flow's memory and only {token,size,frames,fnv1a64}
// crosses, to be substituted at the egress sink. This is the contract the
// flatbuffer branch always requests, so a stub that ignored it (or that failed
// to parse the LENGTH-PREFIXED payload and so never saw the key) would silently
// exercise the byte path only — and miss the P1 entirely.
// ---------------------------------------------------------------------------

function createBridgeStub(db) {
  const calls = [];
  const bodyRefs = new Map();
  let nextToken = 1n;
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  function streamResult(bytes, deliver) {
    const rows = countStreamFrames(bytes);
    if (deliver === "ref") {
      const token = nextToken++;
      bodyRefs.set(token, bytes);
      return encodeHostcallEnvelope({
        ok: true,
        result: {
          rows,
          columns: ["_data"],
          ref: {
            token: Number(token),
            size: bytes.length,
            frames: rows,
            fnv1a64: hostStreamHash(bytes),
          },
        },
      });
    }
    return encodeHostcallEnvelope(
      { ok: true, result: { rows, columns: ["_data"], stream: { $bin: 0 } } },
      [bytes],
    );
  }

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const view = new DataView(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        // Payload is LENGTH-PREFIXED: [u32 LE json length][json][pad].
        const jsonLength = view.getUint32(payloadPtr, true);
        const payloadText = decoder.decode(
          heap.subarray(payloadPtr + 4, payloadPtr + 4 + jsonLength),
        );
        let payload = {};
        try {
          payload = JSON.parse(payloadText);
        } catch {
          /* non-JSON payloads are not storage ops */
        }
        calls.push({ operation, deliver: payload.deliver ?? null });

        if (operation === "storage.flatsql_epoch_stream") {
          const bytes = db.queryRawFlatBufferStream(NEAREST_SQL, [
            payload.source ?? "",
            payload.epoch ?? EPOCH_SECONDS,
            payload.limit ?? 50000,
          ]);
          response = streamResult(bytes, payload.deliver);
          return 0;
        }
        if (operation === "storage.flatsql_query_stream") {
          const params = (payload.params ?? []).map((p) =>
            p && typeof p === "object" && "v" in p ? p.v : p,
          );
          const bytes = db.queryRawFlatBufferStream(payload.sql, params);
          response = streamResult(bytes, payload.deliver);
          return 0;
        }
        response = encodeHostcallEnvelope({ ok: false, message: "no module config" });
        return 0;
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

  return { calls, imports, memoryRef, bodyRefs };
}

// ---------------------------------------------------------------------------
// Flow runner. ONE HTTP exchange per flow instance — the Go host checks an
// instance out of a pool per request, and a failed exchange must not be able
// to leave frames queued for the next one.
// ---------------------------------------------------------------------------

async function createFlow() {
  const { engine, db } = await createEngineWithData();
  const stub = createBridgeStub(db);
  const host = await createFlowRuntimeHost({
    wasmSource: readWasm(),
    extraImports: stub.imports,
    // SDK 0.8.12: this host is runtime-agnostic, so the Node leg is a fact only
    // when the caller states it. Without this the artifact's declared
    // runtimeTargets are never checked here at all.
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  return { host, stub, engine, db };
}

async function pumpRequest(flow, request) {
  const responses = [];
  flow.host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest(request),
  });
  const drain = await flow.host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) {
          const http = decodeHttpResponse(frame.bytes);
          if (http.bodyRefSize > 0) {
            // Out-of-band body: the egress substitutes the buffer the storage
            // capability registered during this same exchange (the JS
            // counterpart of the Go host's htrPipe TakeBodyRef).
            const resolved = flow.stub.bodyRefs.get(BigInt(http.bodyRefToken));
            assert.ok(resolved, "body-ref token must resolve on this exchange");
            assert.equal(BigInt(resolved.length), BigInt(http.bodyRefSize));
            http.body = resolved;
          }
          responses.push(http);
        }
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  // A dropped frame is silent: drain succeeds, nothing is emitted, and the Go
  // host turns that into 502 "flow produced no HTTP response" with NO detail.
  // Name it here instead.
  assert.equal(
    responses.length,
    1,
    `expected exactly one $HTR frame, got ${responses.length} — the flow emitted no HTTP ` +
      `response, which is the 502 the node serves (drain=${JSON.stringify(drain)})`,
  );
  return responses[0];
}

function get(path, query) {
  return { method: "GET", path, query, headers: [] };
}

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

test("compiled BRIDGE bundle: linkage marker, capability set, embedded FLOW program", async () => {
  const artifact = JSON.parse(fs.readFileSync(fileURLToPath(ARTIFACT_PATH), "utf8"));
  assert.equal(artifact.engineLinkage, "bridge");
  assert.deepEqual(artifact.capabilities, ["storage_query"]);
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(MANIFEST_PATH), "utf8"));
  assert.deepEqual(manifest.capabilities, ["storage_query"]);
  assert.equal(manifest.pluginFamily, "flow");

  // Bridge linkage reaches the store over hostcalls, NOT direct engine imports.
  const wasmModule = await WebAssembly.compile(readWasm().slice().buffer);
  const imports = WebAssembly.Module.imports(wasmModule).map((i) => `${i.module}.${i.name}`);
  assert.ok(
    !imports.some((name) => name.startsWith("flatsql.")),
    "a bridge artifact must not import the engine directly",
  );

  const flow = await createFlow();
  assert.equal(flow.host.nodeCount, 8);
  assert.equal(flow.host.edgeCount, 13);
  assert.equal(flow.host.dependencyCount, 5);

  const exports = flow.host.instance.exports;
  const ptr = exports.flow_get_manifest_flatbuffer();
  const size = exports.flow_get_manifest_flatbuffer_size();
  const program = decodeFlowProgram(new Uint8Array(flow.host.memory.buffer, ptr, size).slice());
  assert.equal(program.programId, "com.digitalarsenal.flows.data-retrieval");
  assert.equal(program.nodes.length, 8);
});

// ---------------------------------------------------------------------------
// THE DEFAULT BRANCH. Public consumers send no format param at all.
// ---------------------------------------------------------------------------

test("GET /omm/bulk with NO format param serves the flatbuffer stream (the P1 regression)", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, get("/api/v1/data/omm/bulk", `epoch=${EPOCH_SECONDS}`));

  assert.equal(http.status, 200);
  assert.equal(
    findHttpHeader(http.headers, "content-type"),
    "application/vnd.sdn.flatbuffers.stream",
  );

  // The flatbuffer branch elects reference delivery, so the bytes must have
  // crossed as a body-ref — not as a copy through the flow's memory.
  assert.ok(http.bodyRefSize > 0, "the flatbuffer branch must deliver by reference");
  assert.ok(
    flow.stub.calls.some((c) => c.operation.startsWith("storage.") && c.deliver === "ref"),
    'the flatbuffer branch must request "deliver":"ref"',
  );

  // Body is byte-identical to what the engine itself serves.
  const expected = referenceStream(flow.db);
  assert.deepEqual(Buffer.from(http.body), Buffer.from(expected));

  // Record count + etag are the canonical ones.
  assert.equal(
    findHttpHeader(http.headers, "x-sdn-record-count"),
    String(countStreamFrames(expected)),
  );
  assert.equal(findHttpHeader(http.headers, "etag"), `W/"fnv1a64-${fnv1a64Hex(expected)}"`);
});

test("GET /omm/bulk?format=flatbuffer is identical to the format-less default", async () => {
  const bare = await createFlow();
  const explicit = await createFlow();
  const a = await pumpRequest(bare, get("/api/v1/data/omm/bulk", `epoch=${EPOCH_SECONDS}`));
  const b = await pumpRequest(
    explicit,
    get("/api/v1/data/omm/bulk", `format=flatbuffer&epoch=${EPOCH_SECONDS}`),
  );
  assert.equal(a.status, b.status);
  assert.deepEqual(Buffer.from(a.body), Buffer.from(b.body));
  assert.equal(
    findHttpHeader(a.headers, "x-sdn-record-count"),
    findHttpHeader(b.headers, "x-sdn-record-count"),
  );
  assert.equal(findHttpHeader(a.headers, "etag"), findHttpHeader(b.headers, "etag"));
});

// ---------------------------------------------------------------------------
// format=json -> engine bytes cross engine->flow in-wasm -> omm-json
// ---------------------------------------------------------------------------

test("GET /omm/bulk?format=json field-extracts the in-wasm materialized stream", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(
    flow,
    get("/api/v1/data/omm/bulk", `format=json&epoch=${EPOCH_SECONDS}`),
  );
  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.ok(Array.isArray(body), "format=json must return a bare top-level array");
  assert.equal(body.length, RECORDS.length);

  // The json branch needs the bytes IN the flow, so it must NOT ask for a ref.
  assert.ok(
    flow.stub.calls.every((c) => c.deliver !== "ref"),
    "the json branch must take byte delivery",
  );
});

test("the record-count header agrees across formats for the same query", async () => {
  const fb = await createFlow();
  const js = await createFlow();
  const a = await pumpRequest(fb, get("/api/v1/data/omm/bulk", `epoch=${EPOCH_SECONDS}`));
  const b = await pumpRequest(
    js,
    get("/api/v1/data/omm/bulk", `format=json&epoch=${EPOCH_SECONDS}`),
  );
  assert.equal(
    findHttpHeader(a.headers, "x-sdn-record-count"),
    findHttpHeader(b.headers, "x-sdn-record-count"),
  );
});

// ---------------------------------------------------------------------------
// Per-schema bulk lane: /<code>/bulk routes through the SAME retrieval method
// with query.schema set, so it rides the same delivery path.
// ---------------------------------------------------------------------------

test("GET /cat/bulk with NO format param serves the flatbuffer stream", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, get("/api/v1/data/cat/bulk", `epoch=${EPOCH_SECONDS}`));
  assert.equal(http.status, 200);
  assert.equal(
    findHttpHeader(http.headers, "content-type"),
    "application/vnd.sdn.flatbuffers.stream",
  );
  assert.ok(http.bodyRefSize > 0, "the cat/bulk flatbuffer branch must deliver by reference");
  assert.ok(http.body.length > 0, "cat/bulk must return a body");
});

test("GET /cat/bulk?format=json refuses with 404 — CAT has no json encoder", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(
    flow,
    get("/api/v1/data/cat/bulk", `format=json&epoch=${EPOCH_SECONDS}`),
  );
  assert.equal(http.status, 404);
  const body = JSON.parse(decoder.decode(http.body));
  assert.match(body.error, /json encoding is not available for CAT\.fbs/);
});

// ---------------------------------------------------------------------------
// Conditional requests + routing
// ---------------------------------------------------------------------------

test("If-None-Match revalidation returns 304 with an empty body", async () => {
  const first = await createFlow();
  const seen = await pumpRequest(first, get("/api/v1/data/omm/bulk", `epoch=${EPOCH_SECONDS}`));
  const etag = findHttpHeader(seen.headers, "etag");
  assert.ok(etag, "the 200 must carry an etag to revalidate against");

  const second = await createFlow();
  const http = await pumpRequest(second, {
    method: "GET",
    path: "/api/v1/data/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
    headers: [["if-none-match", etag]],
  });
  assert.equal(http.status, 304);
  assert.equal(http.body?.length ?? 0, 0);
});

test("GET /nope routes to 404 without touching the engine", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, get("/api/v1/data/nosuchthing", ""));
  assert.equal(http.status, 404);
  assert.ok(
    flow.stub.calls.every((c) => !c.operation.startsWith("storage.")),
    "a 404 must not query the store",
  );
});
