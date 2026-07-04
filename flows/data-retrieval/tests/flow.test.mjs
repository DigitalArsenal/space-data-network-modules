/*
 * Flow-level tests for the compiled data-retrieval flow — LINKED mode
 * (loop C.7 direct linkage).
 *
 * The bundle is compiled with engineLinkage: "flatsql": the retrieval node
 * submits queries DIRECTLY to a live FlatSQL engine instance through wasm
 * imports (module "flatsql" = the engine's function exports, module
 * "flatsql_link" = the SDK's memory-crossing shim). These tests are the
 * BROWSER-PARITY end-to-end proof: the SAME artifact the Go host mounts is
 * instantiated here against a REAL JS-hosted engine
 * (repos/main-packages/flatsql wasm/standalone.js — the browser loader), the
 * query executes entirely in-wasm, and:
 *
 *   - the $HTR body is BYTE-IDENTICAL to the engine's own
 *     queryRawFlatBufferStream result for the same SQL/params,
 *   - the etag is W/"fnv1a64-<hex>" over exactly those bytes — the same
 *     algorithm + format the Go host serves (byte-equal etags for
 *     byte-equal bodies),
 *   - ZERO storage.flatsql_* hostcalls exist on any query path (the module
 *     config hostcall fires once per instance; the epoch default comes from
 *     the WASI clock).
 *
 * Flatbuffer-branch bodies never enter the flow's memory: they ride as
 * engine body-ref tokens ("SDNE" magic) resolved straight out of ENGINE
 * memory by the egress — the JS counterpart of the Go host's harvest under
 * the store engine lock.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/main.js";
import { loadFlatSQLStandalone } from "../../../../flatsql/wasm/standalone.js";
import { createFlowRuntimeHost, decodeFlowProgram, isEngineBodyRefToken } from "space-data-module-sdk/flow";
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
  // register_source + unified views via the raw C ABI (the standalone class
  // has no wrappers for them; the exports are the same ones the Go host and
  // the linked artifact call).
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

// ---------------------------------------------------------------------------
// Hostcall bridge stub — in LINKED mode only plugin.getConfig may fire (once
// per instance); ANY storage.* hostcall is a regression and fails loudly.
// ---------------------------------------------------------------------------

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

function createHostcallStub() {
  const calls = [];
  let memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        calls.push(operation);
        if (operation.startsWith("storage.")) {
          throw new Error(
            `LINKED flow issued a ${operation} hostcall — query submission must be in-wasm`,
          );
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

  return { calls, imports, memoryRef };
}

// ---------------------------------------------------------------------------
// Flow runner: the linked artifact instantiated against the LIVE engine.
// ---------------------------------------------------------------------------

async function createFlow() {
  const { engine, db } = await createEngineWithData();
  const stub = createHostcallStub();
  const host = await createFlowRuntimeHost({
    wasmSource: readWasm(),
    extraImports: stub.imports,
    engineLink: { exports: engine._runtime.exports, dbHandle: db._handle },
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
            // Engine body-ref resolution — the JS egress counterpart of the
            // Go host's post-drain harvest.
            assert.ok(
              isEngineBodyRefToken(http.bodyRefToken),
              "linked flows mint SDNE engine tokens",
            );
            const resolved = flow.host.resolveEngineBodyRef(http.bodyRefToken);
            assert.ok(resolved, "engine body-ref token must resolve from the flow's ref table");
            assert.equal(BigInt(resolved.size), BigInt(http.bodyRefSize));
            assert.equal(
              fnv1a64Hex(resolved.bytes),
              resolved.fnv1a64.toString(16).padStart(16, "0"),
              "harvested bytes must verify against the descriptor fnv1a64",
            );
            http.body = resolved.bytes;
          }
          responses.push(http);
        }
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, `expected exactly one $HTR frame (drain=${JSON.stringify(drain)})`);
  return responses[0];
}

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

test("compiled LINKED bundle: linkage marker, capability union, embedded FLOW program", async () => {
  const artifact = JSON.parse(fs.readFileSync(fileURLToPath(ARTIFACT_PATH), "utf8"));
  assert.equal(artifact.engineLinkage, "flatsql-direct");
  assert.deepEqual(artifact.capabilities, ["storage_engine_link", "storage_query"]);
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(MANIFEST_PATH), "utf8"));
  assert.deepEqual(manifest.capabilities, ["storage_engine_link", "storage_query"]);
  assert.equal(manifest.pluginFamily, "flow");

  // The artifact's engine surface is direct imports, not hostcalls.
  const wasmModule = await WebAssembly.compile(readWasm().slice().buffer);
  const imports = WebAssembly.Module.imports(wasmModule).map((i) => `${i.module}.${i.name}`);
  assert.ok(imports.includes("flatsql.flatsql_query_raw_flatbuffer_stream"));
  assert.ok(imports.includes("flatsql.malloc"));
  assert.ok(imports.includes("flatsql_link.poke8"));
  assert.ok(imports.includes("flatsql_link.fnv1a64"));
  const exportNames = WebAssembly.Module.exports(wasmModule).map((e) => e.name);
  assert.ok(exportNames.includes("sdn_flatsql_link_init"));
  assert.ok(exportNames.includes("sdn_flatsql_link_ref_table"));

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
// $HTQ /omm/bulk -> in-wasm engine query -> engine body-ref -> $HTR
// ---------------------------------------------------------------------------

test("GET /omm/bulk executes in-wasm against the JS-hosted engine: body byte-identical, etag canonical, zero storage hostcalls", async () => {
  const flow = await createFlow();
  const expected = referenceStream(flow.db);
  assert.ok(expected.length > 0, "reference stream must not be empty");

  const http = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}&limit=100&profile=nearest`,
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "2");
  assert.deepEqual(
    new Uint8Array(http.body),
    expected,
    "flow-served body must be byte-identical to the engine's own raw stream",
  );
  assert.equal(
    findHttpHeader(http.headers, "etag"),
    `W/"fnv1a64-${fnv1a64Hex(expected)}"`,
    "etag = canonical word-folded fnv1a64 over the body bytes (byte-equal to the server's for equal bodies)",
  );

  // The ONLY hostcall that left the sandbox is the one-time config read.
  assert.deepEqual(flow.stub.calls, ["plugin.getConfig"]);

  // Warm request on the same instance: config is cached, still zero
  // storage hostcalls, same bytes.
  const warm = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}&limit=100&profile=nearest`,
  });
  assert.equal(warm.status, 200);
  assert.deepEqual(new Uint8Array(warm.body), expected);
  assert.deepEqual(flow.stub.calls, ["plugin.getConfig"], "config hostcall fires once per instance");
});

test("GET /omm/bulk without an epoch defaults through the WASI clock (no clock.now hostcall)", async () => {
  const flow = await createFlow();
  const before = Date.now() / 1000;
  const http = await pumpRequest(flow, { method: "GET", path: "/omm/bulk", query: "" });
  assert.equal(http.status, 200);
  assert.deepEqual(flow.stub.calls, ["plugin.getConfig"], "no clock.now, no storage hostcalls");
  // nearest-to-now over the fixture epochs returns both records.
  assert.equal(findHttpHeader(http.headers, "x-sdn-record-count"), "2");
  assert.deepEqual(
    new Uint8Array(http.body),
    flow.db.queryRawFlatBufferStream(NEAREST_SQL, ["", Math.round(before), 50000]),
    "clock-defaulted query returns the same nearest-per-object rows",
  );
});

// ---------------------------------------------------------------------------
// format=json -> engine bytes cross engine->flow in-wasm -> omm-json
// ---------------------------------------------------------------------------

test("GET /omm/bulk?format=json field-extracts the in-wasm materialized stream", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `format=json&epoch=${EPOCH_SECONDS}`,
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/json");
  const body = JSON.parse(decoder.decode(http.body));
  assert.equal(body.count, 2);
  assert.deepEqual(
    body.records.map((record) => [record.norad_cat_id, record.object_name, record.epoch]).sort(),
    RECORDS.map((record) => [record.norad_cat_id, record.object_name, record.epoch]).sort(),
  );
  const iss = body.records.find((record) => record.norad_cat_id === 25544);
  assert.equal(iss.mean_motion, RECORDS[0].mean_motion, "field extraction is exact");
  assert.deepEqual(flow.stub.calls, ["plugin.getConfig"], "json branch is hostcall-free too");
});

// ---------------------------------------------------------------------------
// If-None-Match -> 304 (ref-mode etags revalidate)
// ---------------------------------------------------------------------------

test("If-None-Match revalidation returns 304 with an empty body", async () => {
  const flow = await createFlow();
  const first = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
  });
  assert.equal(first.status, 200);
  const etag = findHttpHeader(first.headers, "etag");
  assert.match(etag, /^W\/"fnv1a64-[0-9a-f]{16}"$/);

  const second = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
    headers: { "if-none-match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0, "304 body must be empty");
  assert.equal(findHttpHeader(second.headers, "etag"), etag);

  const third = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}`,
    headers: { "if-none-match": 'W/"stale"' },
  });
  assert.equal(third.status, 200, "stale validator revalidates to 200");
  assert.deepEqual(new Uint8Array(third.body), referenceStream(flow.db, { limit: 50000 }));
});

// ---------------------------------------------------------------------------
// data_query route: generic SQL + typed params, in-wasm
// ---------------------------------------------------------------------------

test("POST /query executes {sql,params} in-wasm and streams verbatim", async () => {
  const flow = await createFlow();
  const sql = "SELECT _data FROM OMM WHERE NORAD_CAT_ID = ?";
  const expected = flow.db.queryRawFlatBufferStream(sql, [25544]);
  assert.ok(expected.length > 0);

  const http = await pumpRequest(flow, {
    method: "POST",
    path: "/query",
    query: "",
    body: JSON.stringify({ sql, params: [{ t: "i64", v: 25544 }] }),
  });

  assert.equal(http.status, 200);
  assert.equal(findHttpHeader(http.headers, "content-type"), "application/vnd.sdn.flatbuffers.stream");
  assert.deepEqual(new Uint8Array(http.body), expected, "rows pass through verbatim");
  assert.deepEqual(flow.stub.calls, [], "data_query path never leaves the sandbox");
});

test("POST /query with bad SQL: node fails 502 in-wasm, engine stays healthy, no $HTR", async () => {
  const flow = await createFlow();
  flow.host.enqueueTriggerFrame(0, {
    portId: "request",
    bytes: encodeHttpRequest({
      method: "POST",
      path: "/query",
      query: "",
      body: JSON.stringify({ sql: "SELECT nonsense FROM no_such_table" }),
    }),
  });
  const responses = [];
  await flow.host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        responses.push(...frames);
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  // The failing node produces no stream frame — the flow emits no $HTR (the
  // HTTP hosts map that to a 502), and the node's status carries the error.
  assert.equal(responses.length, 0);
  assert.equal(flow.host.getNodeState(3).lastStatus, 502, "data_query node failed with 502");
  // The engine survives the latched error (no-throw contract): a good query
  // on the SAME instance still executes in-wasm.
  const ok = await pumpRequest(flow, {
    method: "GET",
    path: "/omm/bulk",
    query: `epoch=${EPOCH_SECONDS}&limit=100&profile=nearest`,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(new Uint8Array(ok.body), referenceStream(flow.db));
});

// ---------------------------------------------------------------------------
// not_found route
// ---------------------------------------------------------------------------

test("GET /nope routes to 404 without touching the engine or the bridge", async () => {
  const flow = await createFlow();
  const http = await pumpRequest(flow, { method: "GET", path: "/nope", query: "" });
  assert.equal(http.status, 404);
  const body = JSON.parse(decoder.decode(http.body));
  assert.ok(typeof body.error === "string" && body.error.length > 0);
  assert.deepEqual(flow.stub.calls, [], "no hostcalls for unroutable requests");
});
