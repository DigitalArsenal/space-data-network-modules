/*
 * Flow-level tests for the compiled weathernext-ingest flows — BRIDGE mode, typed contracts 1.0.
 * The SAME artifacts the Go host serves from cron timers are instantiated in
 * the JS flow runtime host (WasmEdge leg): a TimerTick enters the request-
 * builder node, the whole plan -> fetch -> parse -> ingest chain runs
 * linked-direct inside the artifact's linear memory (HttpRequest / HttpResponse
 * frames with the parse job in CONTEXT, IngestRequest + record stream into
 * storage-ingest), and the ONLY host crossings are the declared hostcalls, each
 * an SDS $PIV invocation: plugin.getConfig (one ModuleConfig on raw "config"), http.request
 * (fetch) and storage.ingest_with_source (guarded persistence). secrets.get is
 * never expected here (auth mode none); a call to it fails the stub loudly.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpResponse,
  decodeIngestResult,
  encodeHostCallResult, encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

const decoder = new TextDecoder();
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);

const CLOUDS_WASM = new URL("../dist/clouds/runtime.wasm", import.meta.url);
const CYCLONES_WASM = new URL("../dist/cyclones/runtime.wasm", import.meta.url);

const FIXTURES = new URL("../../../data-source/weathernext-parser/tests/fixtures/", import.meta.url);
const EXPECTED_CLOUDS = JSON.parse(fs.readFileSync(new URL("wn3-0p1deg-clouds/expected.json", FIXTURES), "utf8"));
const EXPECTED_CYCLONES = JSON.parse(fs.readFileSync(new URL("wn3-cyclones/expected.json", FIXTURES), "utf8"));
const CSV_BYTES = fs.readFileSync(new URL("wn3-cyclones/cyclone-tracks.csv", FIXTURES));

const BASE_URL = "http://fixture.local";
const STORE_PATH = "wn3";
const CYCLONE_URL = `${BASE_URL}/cyclones/cyclone-tracks.csv`;
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

// The three full 64 x 64 chunks (lat chunk 14, lon chunk 7) keyed by the URL
// the plan node builds for them: <base>/<store>/<array>/c/0/0/6/14/7.
const CHUNK_FETCHES = {};
const CHUNK_BODIES = [];
for (const array of ["low_cloud_cover", "medium_cloud_cover", "high_cloud_cover"]) {
  const body = fs.readFileSync(new URL(`wn3-0p1deg-clouds/${array}.c.0.0.6.14.7.bin`, FIXTURES));
  CHUNK_FETCHES[`${BASE_URL}/${STORE_PATH}/${array}/c/0/0/6/14/7`] = { body };
  CHUNK_BODIES.push(body);
}

const LIVE_CONFIG = {
  weathernext_live_access: true,
  weathernext_auth_mode: "none",
  weathernext_gcs_base_url: BASE_URL,
  weathernext_store_path: STORE_PATH,
  weathernext_init_time: EXPECTED_CLOUDS.job.init_time,
  weathernext_cyclone_url: CYCLONE_URL,
};

function sha256Hex(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

const headerBlock = (headers = {}) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
const headersOf = (block) => Object.fromEntries((block ? decoder.decode(block) : "").split(/\r?\n/).filter(Boolean).map((line) => {
  const at = line.indexOf(":");
  return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
}));

// Hostcall stub speaking the Go host's typed dialect: each call an SDS $PIV request, each answer a $PIV response.
// secrets.get is NOT answered: auth mode none must never reach it.
function createIngestHostStub({ fetches, config = {} }) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (call) => {
    if (call.op === "plugin.getConfig") return encodeHostCallResult({ ok: true, op: call.op, raw: { config: encodeModuleConfig(config) } });
    if (call.op === "http.request") {
      const url = decoder.decode(call.raw.url);
      const spec = fetches[url];
      return encodeHostCallResult({ ok: true, op: call.op, result: { STATUS: spec ? spec.status ?? 200 : 404, RETRIEVED_MS: BigInt(Date.UTC(2026, 8, 3, 12, 0, 1)) },
        raw: { url, headers: headerBlock(spec?.headers), body: spec ? new Uint8Array(Buffer.from(spec.body)) : new Uint8Array(0) } });
    }
    if (call.op === "storage.ingest_with_source") {
      const records = Buffer.from(call.raw.records);
      let count = 0;
      for (let off = 0; off < records.length;) { off += 4 + records.readUInt32LE(off); count++; }
      return encodeHostCallResult({ ok: true, op: call.op, result: { SCHEMA: call.params.SCHEMA, BATCH_ID: call.params.BATCH_ID, INSERTED: BigInt(count),
        ARCHIVED: call.raw.archive ? `/raw/${call.params.ARCHIVE_SOURCE}/${call.params.ARCHIVE_NAME}` : "" } });
    }
    return encodeHostCallResult({ ok: false, error: { code: "unsupported", message: `unexpected op ${call.op}` } });
  };
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const call = decodeHostCall(new Uint8Array(memoryRef.memory.buffer, payloadPtr, payloadLen).slice());
        calls.push(call);
        response = answer(call);
        return 0;
      },
      response_len() { return response.length; },
      read_response(dstPtr, dstLen) {
        const length = Math.min(dstLen, response.length);
        new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };
  return { calls, imports, memoryRef };
}

// Egress frames are FlatBuffers: IngestResult, FlowNotice, HttpResponse (the publication's answer).
function decodeEgress(bytes) {
  const id = identifierOf(bytes);
  if (id === "INGR") return { type: "INGR", ...decodeIngestResult(bytes) };
  if (id === "FNTC") return { type: "FNTC", ...decodeFlowNotice(bytes) };
  if (id === "HRSP") return { type: "HRSP", ...decodeHttpResponse(bytes) };
  throw new Error(`egress frame of unexpected type ${id}`);
}

async function runFlowOnce(wasmURL, stub) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmURL))),
    extraImports: stub.imports,
    // The source node is WasmEdge-only (secrets.* has no browser host), so the
    // composed artifact is too; state the leg the Go host runs it on.
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;

  const results = [];
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encodeTimerTick({ triggerId: "timer", firedMs: Date.UTC(2026, 8, 3, 12) }) });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) results.push(decodeEgress(Uint8Array.from(frame.bytes)));
      return { statusCode: 0 };
    },
  });
  return results;
}

const opCalls = (stub, op) => stub.calls.filter((call) => call.op === op);
const ingestCalls = (stub) => opCalls(stub, "storage.ingest_with_source");
const httpCalls = (stub) => opCalls(stub, "http.request");
const secretsCalls = (stub) => opCalls(stub, "secrets.get");
const urlOf = (call) => decoder.decode(call.raw.url);

function publishBodies(stub) {
  return httpCalls(stub).filter((call) => urlOf(call) === PUBLISH_URL).map((call) => {
    assert.equal(call.params.METHOD, "POST");
    assert.deepEqual(headersOf(call.raw.headers), { "content-type": "application/octet-stream" });
    // the BODY is the stored batch's IngestResult (INGR)
    const bytes = Uint8Array.from(call.raw.body);
    assert.equal(identifierOf(bytes), "INGR");
    const { schema, providerId, sourceName, batchId, inserted, refused } = decodeIngestResult(bytes);
    assert.equal(refused, "");
    assert.ok(inserted > 0, "the publication carries the stored count");
    return { schema, providerId, sourceName, batchId };
  });
}

function splitRecords(bytes, identifier) {
  const records = Buffer.from(bytes);
  const out = [];
  for (let off = 0; off < records.length;) {
    const len = records.readUInt32LE(off);
    assert.equal(records.subarray(off + 8, off + 12).toString("latin1"), identifier);
    out.push(Uint8Array.from(records.subarray(off + 4, off + 4 + len)));
    off += 4 + len;
  }
  return out;
}

const PUBLISH_FETCH = {
  status: 202,
  body: JSON.stringify({ standardCode: "WXF", recordCount: 3, shardCid: "bafkreitestshard" }),
};

test("clouds: timer tick -> plan -> 3 chunk fetches -> parse -> ONE attributed $WXF ingest of 3 tiles", async () => {
  const stub = createIngestHostStub({ config: LIVE_CONFIG, fetches: CHUNK_FETCHES });
  const results = await runFlowOnce(CLOUDS_WASM, stub);

  const fetches = httpCalls(stub);
  assert.deepEqual(
    fetches.map(urlOf),
    Object.keys(CHUNK_FETCHES),
    "one GET per array, in plan order",
  );
  for (const call of fetches) {
    assert.equal(call.params.METHOD, "GET");
    assert.equal(call.params.TIMEOUT_MS, 90000);
    assert.equal(call.raw.headers, undefined, "auth none: no header block, no bearer");
  }
  assert.equal(secretsCalls(stub).length, 0, "auth none never reads the credential lane");

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "one ingest for the whole chunk batch");
  const ingest = ingests[0];
  assert.equal(ingest.params.SCHEMA, "WXF.fbs");
  assert.equal(ingest.params.PROVIDER_ID, "weathernext");
  assert.equal(ingest.params.SOURCE_NAME, "weathernext3-clouds-0p1deg");
  assert.equal(ingest.params.BATCH_ID, sha256Hex(CHUNK_BODIES), "batch = sha256 of the chunk bodies in fetch order");
  assert.equal(ingest.params.RECONCILE, 0, "reconcile Duplicates");
  assert.equal(ingest.params.LICENSE, "CC-BY-4.0", "init 2026-09-02T00Z + 6 h is more than an hour old");
  assert.equal(ingest.params.ARCHIVE_NAME ?? "", "", "field lane archives nothing");
  assert.ok(ingest.params.SOURCE_URL.startsWith(`${BASE_URL}/${STORE_PATH}/`));
  assert.deepEqual(Object.keys(ingest.raw), ["records"], "records only");
  assert.equal(splitRecords(ingest.raw.records, "$WXF").length, 3, "three $WXF tiles");
  assert.equal(ingest.lists.provenance.length, 1);
  assert.equal(Number(ingest.lists.provenance[0].NORMALIZED_COUNT), 3);
  assert.equal(ingest.lists.provenance[0].PARSER_VERSION, "weathernext-zarr-wasm/v1");

  assert.equal(results.length, 1, "one ingest result reached the egress sink");
  assert.equal(results[0].type, "INGR");
  assert.equal(results[0].inserted, 3);
  assert.equal(results[0].schema, "WXF.fbs");
});

test("clouds: the tile geometry the source computes reaches the records exactly as expected.json holds it", async () => {
  const edge = fs.readFileSync(new URL("wn3-0p1deg-clouds/low_cloud_cover.c.0.0.6.28.7.bin", FIXTURES));
  const fetches = {
    [`${BASE_URL}/${STORE_PATH}/low_cloud_cover/c/0/0/6/14/7`]: CHUNK_FETCHES[`${BASE_URL}/${STORE_PATH}/low_cloud_cover/c/0/0/6/14/7`],
    [`${BASE_URL}/${STORE_PATH}/low_cloud_cover/c/0/0/6/28/7`]: { body: edge },
  };
  const stub = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_arrays: "low_cloud_cover", weathernext_chunks: "14,7;28,7" }, fetches });
  await runFlowOnce(CLOUDS_WASM, stub);
  const [ingest] = ingestCalls(stub);
  const records = splitRecords(ingest.raw.records, "$WXF").map((r) => wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(r)).unpack());
  for (const [record, name] of [[records[0], "low_cloud_cover.c.0.0.6.14.7.bin"], [records[1], "low_cloud_cover.c.0.0.6.28.7.bin"]]) {
    const chunk = EXPECTED_CLOUDS.chunks[name];
    assert.equal(record.FIELD_ID, EXPECTED_CLOUDS.field_ids.low_cloud_cover);
    assert.deepEqual([record.GRID.NLAT, record.GRID.NLON, record.GRID.LAT0, record.GRID.LON0, record.GRID.DLAT, record.GRID.DLON, record.GRID.PERIODIC_LON],
      [chunk.NLAT, chunk.NLON, chunk.LAT0, chunk.LON0, chunk.DLAT, chunk.DLON, chunk.PERIODIC_LON], name);
    assert.deepEqual([record.TILE_INDEX, record.TILE_COUNT, record.MISSING_COUNT, record.VALUES.length], [chunk.TILE_INDEX, chunk.TILE_COUNT, chunk.MISSING_COUNT, chunk.cell_count], name);
    assert.equal(record.VALUE_MIN, Math.fround(chunk.VALUE_MIN));
    assert.equal(record.VALUE_MAX, Math.fround(chunk.VALUE_MAX));
    for (const spot of chunk.spots) assert.equal(record.VALUES[spot.i * chunk.NLON + spot.j], Math.fround(spot.value), `${name} spot (${spot.i}, ${spot.j})`);
    assert.equal(Number(record.VALID_TIME_MS), EXPECTED_CLOUDS.job.valid_time_ms);
    assert.equal(Number(record.RETRIEVED_AT), Date.UTC(2026, 8, 3, 12, 0, 1), "no Date header: the host's RETRIEVED_MS");
  }
});

test("clouds: NO publish POST is made without weathernext_publish_url", async () => {
  const stub = createIngestHostStub({ config: LIVE_CONFIG, fetches: CHUNK_FETCHES });
  await runFlowOnce(CLOUDS_WASM, stub);
  assert.equal(ingestCalls(stub).length, 1, "the store still happens");
  assert.deepEqual(publishBodies(stub), [], "absence of config is not permission to publish");
});

test("clouds: the stored batch triggers its dataset publication when configured", async () => {
  const stub = createIngestHostStub({
    config: { ...LIVE_CONFIG, weathernext_publish_url: PUBLISH_URL },
    fetches: { ...CHUNK_FETCHES, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  const results = await runFlowOnce(CLOUDS_WASM, stub);
  const bodies = publishBodies(stub);
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["batchId", "providerId", "schema", "sourceName"]);
  assert.deepEqual(bodies[0], {
    schema: "WXF.fbs",
    providerId: "weathernext",
    sourceName: "weathernext3-clouds-0p1deg",
    batchId: sha256Hex(CHUNK_BODIES),
  });
  assert.equal(results.length, 2, "ingest result + publication response reach egress");
  assert.equal(results.filter((entry) => entry.type === "HRSP" && entry.status === 202).length, 1);
});

test("clouds: live access OFF fetches nothing, stores nothing, reads no secret", async () => {
  const stub = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false }, fetches: CHUNK_FETCHES });
  const results = await runFlowOnce(CLOUDS_WASM, stub);
  assert.equal(httpCalls(stub).length, 0, "zero http.request hostcalls");
  assert.equal(ingestCalls(stub).length, 0, "zero ingest hostcalls");
  assert.equal(secretsCalls(stub).length, 0);
  assert.deepEqual(results.map((r) => [r.type, r.kind, r.reason]), [["FNTC", "skipped", "live-access-disabled"]], "the skip reaches the egress sink");
});

test("clouds: the default config (no switch at all) is OFF", async () => {
  const stub = createIngestHostStub({ config: {}, fetches: CHUNK_FETCHES });
  const results = await runFlowOnce(CLOUDS_WASM, stub);
  assert.equal(httpCalls(stub).length, 0);
  assert.equal(ingestCalls(stub).length, 0);
  assert.deepEqual(results.map((r) => [r.type, r.kind, r.reason]), [["FNTC", "skipped", "live-access-disabled"]]);
});

test("cyclones: timer tick -> fetch -> parse -> ONE attributed $TCT ingest of 6 tracks with the raw CSV archived", async () => {
  const stub = createIngestHostStub({
    config: LIVE_CONFIG,
    fetches: { [CYCLONE_URL]: { body: CSV_BYTES, headers: { "content-type": "text/csv" } } },
  });
  const results = await runFlowOnce(CYCLONES_WASM, stub);

  const fetches = httpCalls(stub);
  assert.equal(fetches.length, 1);
  assert.equal(urlOf(fetches[0]), CYCLONE_URL);
  assert.equal(fetches[0].raw.headers, undefined);
  assert.equal(secretsCalls(stub).length, 0);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  const ingest = ingests[0];
  assert.equal(ingest.params.SCHEMA, "TCT.fbs");
  assert.equal(ingest.params.SOURCE_NAME, "weathernext3-cyclone-tracks");
  assert.equal(ingest.params.SOURCE_URL, CYCLONE_URL);
  assert.equal(ingest.params.BATCH_ID, EXPECTED_CYCLONES.csv_sha256);
  assert.equal(ingest.params.ARCHIVE_SOURCE, EXPECTED_CYCLONES.archive.source);
  assert.equal(ingest.params.ARCHIVE_NAME, EXPECTED_CYCLONES.archive.name);
  assert.equal(ingest.params.LICENSE, "CC-BY-4.0");
  assert.deepEqual(Object.keys(ingest.raw).sort(), ["archive", "records"], "records + archive raw frames");
  assert.deepEqual(Buffer.from(ingest.raw.archive), Buffer.from(CSV_BYTES), "the archived document is the CSV, byte-equal");
  assert.equal(ingest.lists.provenance[0].CONTENT_TYPE, "text/csv");
  assert.equal(splitRecords(ingest.raw.records, "$TCT").length, EXPECTED_CYCLONES.record_count, "six (storm, member) tracks");

  assert.equal(results.length, 1);
  assert.equal(results[0].type, "INGR");
  assert.equal(results[0].inserted, EXPECTED_CYCLONES.record_count);
  assert.equal(results[0].archived, `/raw/weathernext/cyclone-tracks.csv`);
  assert.deepEqual(publishBodies(stub), [], "no publish URL, no publication");
});

test("cyclones: live access OFF and a missing URL each skip without fetching", async () => {
  const off = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false }, fetches: {} });
  const offResults = await runFlowOnce(CYCLONES_WASM, off);
  assert.equal(httpCalls(off).length, 0);
  assert.equal(ingestCalls(off).length, 0);
  assert.deepEqual(offResults.map((r) => [r.type, r.kind, r.reason]), [["FNTC", "skipped", "live-access-disabled"]]);

  const noUrl = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_cyclone_url: "" }, fetches: {} });
  const noUrlResults = await runFlowOnce(CYCLONES_WASM, noUrl);
  assert.equal(httpCalls(noUrl).length, 0);
  assert.equal(ingestCalls(noUrl).length, 0);
  assert.deepEqual(noUrlResults.map((r) => [r.type, r.kind, r.reason]), [["FNTC", "skipped", "cyclone-url-missing"]]);
});

test("cyclones: the stored batch publishes when configured", async () => {
  const stub = createIngestHostStub({
    config: { ...LIVE_CONFIG, weathernext_publish_url: PUBLISH_URL },
    fetches: { [CYCLONE_URL]: { body: CSV_BYTES }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  await runFlowOnce(CYCLONES_WASM, stub);
  const bodies = publishBodies(stub);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    schema: "TCT.fbs",
    providerId: "weathernext",
    sourceName: "weathernext3-cyclone-tracks",
    batchId: EXPECTED_CYCLONES.csv_sha256,
  });
});

test("cyclones: a failed fetch stops the batch before any ingest", async () => {
  const stub = createIngestHostStub({ config: LIVE_CONFIG, fetches: {} });
  let drainError = null;
  try {
    await runFlowOnce(CYCLONES_WASM, stub);
  } catch (error) {
    drainError = error;
  }
  assert.equal(httpCalls(stub).length, 1, "the fetch was attempted");
  assert.equal(ingestCalls(stub).length, 0, "a 404 never reaches storage");
  void drainError;
});
