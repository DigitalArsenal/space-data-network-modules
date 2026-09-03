/*
 * Flow-level tests for the compiled weathernext-ingest flows — BRIDGE mode.
 * The SAME artifacts the Go host serves from cron timers are instantiated in
 * the JS flow runtime host (WasmEdge leg): a timer tick enters the request-
 * builder node, the whole plan -> fetch -> parse -> ingest chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossings are the declared hostcalls: plugin.getConfig (node config),
 * http.request (fetch) and storage.ingest_with_source (guarded persistence).
 * secrets.get is never expected here (auth mode none); a call to it fails
 * the stub loudly.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, segment) => sum + 4 + segment.length, 0);
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
  const segmentCount = view.getUint32(offset, true);
  offset += 4;
  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    const segmentLen = view.getUint32(offset, true);
    offset += 4;
    segments.push(Uint8Array.from(bytes.subarray(offset, offset + segmentLen)));
    offset += segmentLen;
  }
  return { meta, segments };
}

// Hostcall stub speaking the Go-host dialect: config inside {ok, result},
// http bodies back as base64 strings with body_encoding, ingest answers as
// {"ok":true,"result":{...}}. secrets.get is NOT answered: auth mode none
// must never reach it.
function createIngestHostStub({ fetches, config = {} }) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta, segments } = decodeHostcallEnvelope(payload);
        calls.push({ operation, meta, segments });

        if (operation === "plugin.getConfig") {
          response = encodeHostcallEnvelope({ ok: true, result: config });
          return 0;
        }
        if (operation === "http.request") {
          const fetchSpec = fetches[meta.url];
          if (!fetchSpec) {
            response = encodeHostcallEnvelope({
              ok: true,
              result: { status: 404, headers: {}, body: "", body_encoding: "base64" },
            });
            return 0;
          }
          response = encodeHostcallEnvelope({
            ok: true,
            result: {
              status: fetchSpec.status ?? 200,
              headers: fetchSpec.headers ?? {},
              body: Buffer.from(fetchSpec.body).toString("base64"),
              body_encoding: "base64",
            },
          });
          return 0;
        }
        if (operation === "storage.ingest_with_source") {
          const recordsRef = meta.records?.$bin ?? 0;
          const records = Buffer.from(segments[recordsRef]);
          let count = 0;
          for (let off = 0; off < records.length; ) {
            const len = records.readUInt32LE(off);
            off += 4 + len;
            count++;
          }
          response = encodeHostcallEnvelope({
            ok: true,
            result: { schema: meta.schema, inserted: count, batch_id: meta.batch_id },
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
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt: "2026-09-03T12:00:00Z" })),
  });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) results.push(JSON.parse(decoder.decode(frame.bytes)));
      return { statusCode: 0 };
    },
  });
  return results;
}

const opCalls = (stub, operation) => stub.calls.filter((call) => call.operation === operation);
const ingestCalls = (stub) => opCalls(stub, "storage.ingest_with_source");
const httpCalls = (stub) => opCalls(stub, "http.request");
const secretsCalls = (stub) => opCalls(stub, "secrets.get");

function publishBodies(stub) {
  return httpCalls(stub)
    .filter((call) => call.meta.url === PUBLISH_URL)
    .map((call) => {
      const bodyRef = call.meta.body?.$bin ?? 0;
      return JSON.parse(Buffer.from(call.segments[bodyRef]).toString("utf8"));
    });
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
    fetches.map((call) => call.meta.url),
    Object.keys(CHUNK_FETCHES),
    "one GET per array, in plan order",
  );
  for (const call of fetches) {
    assert.equal(call.meta.method, "GET");
    assert.equal(call.meta.headers?.authorization, undefined, "auth none: no bearer header");
  }
  assert.equal(secretsCalls(stub).length, 0, "auth none never reads the credential lane");

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "one ingest for the whole chunk batch");
  const ingest = ingests[0];
  assert.equal(ingest.meta.schema, "WXF.fbs");
  assert.equal(ingest.meta.provider_id, "weathernext");
  assert.equal(ingest.meta.source_name, "weathernext3-clouds-0p1deg");
  assert.equal(ingest.meta.batch_id, sha256Hex(CHUNK_BODIES), "batch = sha256 of the chunk bodies in port order");
  assert.equal(ingest.meta.reconcile, "duplicates");
  assert.equal(ingest.meta.license, "CC-BY-4.0", "init 2026-09-02T00Z + 6 h is more than an hour old");
  assert.equal(ingest.meta.archive, undefined, "field lane archives nothing");
  assert.ok(ingest.meta.source_url.startsWith(`${BASE_URL}/${STORE_PATH}/`));
  assert.equal(ingest.segments.length, 1, "records segment only");
  const records = Buffer.from(ingest.segments[0]);
  let count = 0;
  for (let off = 0; off < records.length; ) {
    const len = records.readUInt32LE(off);
    assert.equal(records.subarray(off + 8, off + 12).toString("latin1"), "$WXF");
    off += 4 + len;
    count++;
  }
  assert.equal(count, 3, "three $WXF tiles");
  const provenance = JSON.parse(Buffer.from(ingest.meta.provenance.json, "base64").toString("utf8"));
  assert.deepEqual(provenance.schema_counts, { "WXF.fbs": 3 });

  assert.equal(results.length, 1, "one ingest result reached the egress sink");
  assert.equal(results[0].inserted, 3);
  assert.equal(results[0].schema, "WXF.fbs");
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
  assert.equal(results.filter((entry) => entry.status === 202).length, 1);
});

test("clouds: live access OFF fetches nothing, stores nothing, reads no secret", async () => {
  const stub = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false }, fetches: CHUNK_FETCHES });
  const results = await runFlowOnce(CLOUDS_WASM, stub);
  assert.equal(httpCalls(stub).length, 0, "zero http.request hostcalls");
  assert.equal(ingestCalls(stub).length, 0, "zero ingest hostcalls");
  assert.equal(secretsCalls(stub).length, 0);
  assert.deepEqual(results, [{ skipped: "live-access-disabled" }], "the skip reaches the egress sink");
});

test("clouds: the default config (no switch at all) is OFF", async () => {
  const stub = createIngestHostStub({ config: {}, fetches: CHUNK_FETCHES });
  const results = await runFlowOnce(CLOUDS_WASM, stub);
  assert.equal(httpCalls(stub).length, 0);
  assert.equal(ingestCalls(stub).length, 0);
  assert.deepEqual(results, [{ skipped: "live-access-disabled" }]);
});

test("cyclones: timer tick -> fetch -> parse -> ONE attributed $TCT ingest of 6 tracks with the raw CSV archived", async () => {
  const stub = createIngestHostStub({
    config: LIVE_CONFIG,
    fetches: { [CYCLONE_URL]: { body: CSV_BYTES, headers: { "content-type": "text/csv" } } },
  });
  const results = await runFlowOnce(CYCLONES_WASM, stub);

  const fetches = httpCalls(stub);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].meta.url, CYCLONE_URL);
  assert.equal(fetches[0].meta.headers?.authorization, undefined);
  assert.equal(secretsCalls(stub).length, 0);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  const ingest = ingests[0];
  assert.equal(ingest.meta.schema, "TCT.fbs");
  assert.equal(ingest.meta.source_name, "weathernext3-cyclone-tracks");
  assert.equal(ingest.meta.source_url, CYCLONE_URL);
  assert.equal(ingest.meta.batch_id, EXPECTED_CYCLONES.csv_sha256);
  // The ingest node references the archived payload segment positionally
  // inside the archive object ({"$bin":1}); source and name are the parser's.
  assert.equal(ingest.meta.archive.source, EXPECTED_CYCLONES.archive.source);
  assert.equal(ingest.meta.archive.name, EXPECTED_CYCLONES.archive.name);
  assert.deepEqual(ingest.meta.archive.raw, { $bin: 1 });
  assert.equal(ingest.meta.license, "CC-BY-4.0");
  assert.equal(ingest.segments.length, 2, "records + archive raw segments");
  assert.deepEqual(Buffer.from(ingest.segments[1]), Buffer.from(CSV_BYTES), "raw archive bytes");
  const records = Buffer.from(ingest.segments[0]);
  let count = 0;
  for (let off = 0; off < records.length; ) {
    const len = records.readUInt32LE(off);
    assert.equal(records.subarray(off + 8, off + 12).toString("latin1"), "$TCT");
    off += 4 + len;
    count++;
  }
  assert.equal(count, EXPECTED_CYCLONES.record_count, "six (storm, member) tracks");

  assert.equal(results.length, 1);
  assert.equal(results[0].inserted, EXPECTED_CYCLONES.record_count);
  assert.deepEqual(publishBodies(stub), [], "no publish URL, no publication");
});

test("cyclones: live access OFF and a missing URL each skip without fetching", async () => {
  const off = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false }, fetches: {} });
  const offResults = await runFlowOnce(CYCLONES_WASM, off);
  assert.equal(httpCalls(off).length, 0);
  assert.equal(ingestCalls(off).length, 0);
  assert.deepEqual(offResults, [{ skipped: "live-access-disabled" }]);

  const noUrl = createIngestHostStub({ config: { ...LIVE_CONFIG, weathernext_cyclone_url: "" }, fetches: {} });
  const noUrlResults = await runFlowOnce(CYCLONES_WASM, noUrl);
  assert.equal(httpCalls(noUrl).length, 0);
  assert.equal(ingestCalls(noUrl).length, 0);
  assert.deepEqual(noUrlResults, [{ skipped: "cyclone-url-missing" }]);
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
