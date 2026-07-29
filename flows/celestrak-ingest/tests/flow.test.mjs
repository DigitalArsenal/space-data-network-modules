/*
 * Flow-level tests for the compiled celestrak-ingest flows (loop C.8a) —
 * BRIDGE mode. The SAME artifacts the Go host serves from cron timers are
 * instantiated in the JS flow runtime host here (browser parity): a timer
 * tick frame enters the request-builder node, the whole
 * fetch -> parse -> ingest chain runs linked-direct inside the artifact's
 * linear memory, and the ONLY host crossings are the declared hostcalls:
 * plugin.getConfig (node config), http.request (fetch), and
 * storage.ingest_with_source (guarded persistence).
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

const GP_WASM = new URL("../dist/gp/runtime.wasm", import.meta.url);
const SATCAT_WASM = new URL("../dist/satcat/runtime.wasm", import.meta.url);
const SPW_WASM = new URL("../dist/spw/runtime.wasm", import.meta.url);

const GP_CSV = fs.readFileSync(
  new URL("../../../data-source/celestrak-parser/tests/fixtures/celestrak-gp-omm.csv", import.meta.url),
);
const SATCAT_TXT = fs.readFileSync(
  new URL("../../../data-source/celestrak-parser/tests/fixtures/celestrak-satcat.txt", import.meta.url),
);
const SATCAT_CSV = fs.readFileSync(
  new URL("../../../data-source/celestrak-parser/tests/fixtures/celestrak-satcat.csv", import.meta.url),
);
const SW_CSV = fs.readFileSync(
  new URL("../../../data-source/celestrak-parser/tests/fixtures/celestrak-sw-all.csv", import.meta.url),
);

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

// Hostcall stub speaking the Go-host dialect: http bodies come back as
// base64 strings, ingest responses as {"ok":true,"result":{...}}.
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
          // The guest references binary segments as {"$bin":N} in the meta
          // (the Go bridge substitutes base64; this raw stub resolves the
          // segment directly).
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
  });
  stub.memoryRef.memory = host.memory;

  const results = [];
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt: "2026-07-04T00:00:00Z" })),
  });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) {
        results.push(JSON.parse(decoder.decode(frame.bytes)));
      }
      return { statusCode: 0 };
    },
  });
  return results;
}

function ingestCalls(stub) {
  return stub.calls.filter((call) => call.operation === "storage.ingest_with_source");
}

// §19 dataset-publication trigger. The node cannot be discovered by the flow —
// there is no hostcall for the admin port — so the loopback URL arrives as node
// CONFIG, and with no URL configured the flow publishes NOTHING (fail-closed).
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
const PUBLISH_FETCH = {
  status: 202,
  body: JSON.stringify({
    standardCode: "OMM",
    recordCount: 2,
    shardCid: "bafkreitestshard",
    indexCid: "bafkreitestindex",
    manifestCid: "bafkreitestmanifest",
    pnmCid: "bafkreitestpnm",
  }),
};

// The POST bodies the flow drove through hostcap/http-request at the publish
// URL. The http cap detaches the request body into a binary envelope segment
// and references it as {"$bin":N} in the meta, exactly as it does for a fetch.
function publishBodies(stub) {
  return stub.calls
    .filter((call) => call.operation === "http.request" && call.meta.url === PUBLISH_URL)
    .map((call) => {
      const bodyRef = call.meta.body?.$bin ?? 0;
      return JSON.parse(Buffer.from(call.segments[bodyRef]).toString("utf8"));
    });
}

test("celestrak-gp-ingest: NO publish POST is made without celestrak_publish_url", async () => {
  const gpURL = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
  const stub = createIngestHostStub({ fetches: { [gpURL]: { body: GP_CSV } } });
  await runFlowOnce(GP_WASM, stub);

  assert.equal(ingestCalls(stub).length, 2, "the stores still happen");
  assert.deepEqual(publishBodies(stub), [], "absence of config is not permission to publish");
});

test("celestrak-gp-ingest: each stored batch triggers its own dataset publication", async () => {
  const gpURL = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
  const stub = createIngestHostStub({
    config: { celestrak_publish_url: PUBLISH_URL },
    fetches: { [gpURL]: { body: GP_CSV }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  const results = await runFlowOnce(GP_WASM, stub);

  const bodies = publishBodies(stub).sort((a, b) => a.schema.localeCompare(b.schema));
  assert.equal(bodies.length, 2, "OMM + MPE batches each publish");
  assert.deepEqual(
    bodies.map((body) => body.schema),
    ["MPE.fbs", "OMM.fbs"],
  );
  for (const body of bodies) {
    assert.deepEqual(Object.keys(body).sort(), ["batchId", "providerId", "schema", "sourceName"]);
    assert.equal(body.providerId, "space-data-network-02");
    assert.equal(body.sourceName, "celestrak-gp");
    assert.equal(body.batchId, sha256Hex(GP_CSV));
  }
  // 2 ingest results + 2 publication responses reach the egress sink.
  assert.equal(results.length, 4);
  assert.equal(results.filter((entry) => entry.status === 202).length, 2);
});

test("celestrak-satcat-ingest: both snapshot lanes publish their own batch", async () => {
  const stub = createIngestHostStub({
    config: { celestrak_publish_url: PUBLISH_URL },
    fetches: {
      "https://celestrak.org/pub/satcat.txt": { body: SATCAT_TXT },
      "https://celestrak.org/pub/satcat.csv": { body: SATCAT_CSV },
      [PUBLISH_URL]: PUBLISH_FETCH,
    },
  });
  await runFlowOnce(SATCAT_WASM, stub);

  const bodies = publishBodies(stub);
  assert.equal(bodies.length, 2);
  assert.deepEqual(
    bodies.map((body) => body.sourceName).sort(),
    ["celestrak-satcat", "celestrak-satcat-csv"],
  );
  for (const body of bodies) assert.equal(body.schema, "CAT.fbs");
  assert.equal(
    bodies.find((body) => body.sourceName === "celestrak-satcat").batchId,
    sha256Hex(SATCAT_TXT),
  );
  assert.equal(
    bodies.find((body) => body.sourceName === "celestrak-satcat-csv").batchId,
    sha256Hex(SATCAT_CSV),
  );
});

test("celestrak-spw-ingest: the stored space-weather batch publishes", async () => {
  const overrideURL = "https://fixtures.test/SW-All.csv";
  const stub = createIngestHostStub({
    config: { celestrak_space_weather_url: overrideURL, celestrak_publish_url: PUBLISH_URL },
    fetches: {
      [overrideURL]: {
        body: SW_CSV,
        headers: { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" },
      },
      [PUBLISH_URL]: PUBLISH_FETCH,
    },
  });
  await runFlowOnce(SPW_WASM, stub);

  const bodies = publishBodies(stub);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    schema: "SPW.fbs",
    providerId: "space-data-network-02",
    sourceName: "celestrak-space-weather",
    batchId: sha256Hex(SW_CSV),
  });
});

test("celestrak-spw-ingest: the stale-source gate also stops the publication", async () => {
  const spwURL = "https://celestrak.org/SpaceData/SW-All.csv";
  const stub = createIngestHostStub({
    config: { celestrak_publish_url: PUBLISH_URL },
    fetches: { [spwURL]: { body: SW_CSV }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  try {
    await runFlowOnce(SPW_WASM, stub);
  } catch {
    // the parse node errors on the stale gate; either way nothing may publish
  }
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall after the stale gate");
  assert.deepEqual(publishBodies(stub), [], "nothing stored, nothing published");
});

test("celestrak-gp-ingest: timer tick -> fetch -> parse -> two attributed ingests", async () => {
  const gpURL = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
  const stub = createIngestHostStub({ fetches: { [gpURL]: { body: GP_CSV } } });
  const results = await runFlowOnce(GP_WASM, stub);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "OMM + MPE batches");
  const bySchema = new Map(ingests.map((call) => [call.meta.schema, call]));
  const omm = bySchema.get("OMM.fbs");
  assert.ok(omm, "OMM ingest fired");
  assert.equal(omm.meta.provider_id, "space-data-network-02");
  assert.equal(omm.meta.source_name, "celestrak-gp");
  assert.equal(omm.meta.batch_id, sha256Hex(GP_CSV));
  assert.equal(omm.meta.reconcile, "duplicates");
  assert.equal(omm.meta.archive.name, "catalog.csv");
  assert.equal(omm.segments.length, 2, "records + archive raw segments");
  assert.deepEqual(Buffer.from(omm.segments[1]), Buffer.from(GP_CSV), "raw archive bytes");
  const mpe = bySchema.get("MPE.fbs");
  assert.ok(mpe, "MPE ingest fired");
  assert.equal(mpe.meta.archive, undefined, "payload archived once");

  assert.equal(results.length, 2, "two ingest results reached the egress sink");
  for (const result of results) {
    assert.equal(result.inserted, 2, "fixture has 2 objects");
  }
});

test("celestrak-satcat-ingest: one tick fans out to BOTH satcat sources", async () => {
  const stub = createIngestHostStub({
    fetches: {
      "https://celestrak.org/pub/satcat.txt": { body: SATCAT_TXT },
      "https://celestrak.org/pub/satcat.csv": { body: SATCAT_CSV },
    },
  });
  const results = await runFlowOnce(SATCAT_WASM, stub);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "txt + csv batches");
  const sources = ingests.map((call) => call.meta.source_name).sort();
  assert.deepEqual(sources, ["celestrak-satcat", "celestrak-satcat-csv"]);
  for (const call of ingests) {
    assert.equal(call.meta.schema, "CAT.fbs");
    assert.equal(call.meta.reconcile, "current", "snapshot source keeps only the newest batch");
  }
  assert.equal(results.length, 2);
});

test("celestrak-spw-ingest: fresh source ingests; config URL override reaches the fetch", async () => {
  const overrideURL = "https://fixtures.test/SW-All.csv";
  const stub = createIngestHostStub({
    config: { celestrak_space_weather_url: overrideURL },
    fetches: {
      [overrideURL]: {
        body: SW_CSV,
        headers: { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" },
      },
    },
  });
  const results = await runFlowOnce(SPW_WASM, stub);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].meta.schema, "SPW.fbs");
  assert.equal(ingests[0].meta.source_name, "celestrak-space-weather");
  assert.equal(ingests[0].meta.source_url, overrideURL, "node CONFIG override drove the fetch");
  assert.equal(results.length, 1);
  assert.equal(results[0].inserted, 2);
});

test("celestrak-spw-ingest: the stale-source gate stops the batch before any ingest", async () => {
  const spwURL = "https://celestrak.org/SpaceData/SW-All.csv";
  // No Last-Modified: the in-wasm reference falls back to NOW, far past the
  // fixture's 2026-01-02 latest DATE -> the parse node errors, nothing is
  // persisted.
  const stub = createIngestHostStub({ fetches: { [spwURL]: { body: SW_CSV } } });
  let results = null;
  let drainError = null;
  try {
    results = await runFlowOnce(SPW_WASM, stub);
  } catch (error) {
    drainError = error;
  }
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall after the stale gate");
  if (!drainError) {
    assert.deepEqual(results, [], "no results reach the egress sink");
  }
});
