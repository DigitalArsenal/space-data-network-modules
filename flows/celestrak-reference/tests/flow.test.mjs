/*
 * Flow-level tests for the compiled celestrak-reference flows (fbcs-06b) —
 * BRIDGE mode. The SAME artifacts the Go host serves from cron timers are
 * instantiated in the JS flow runtime host here (browser parity): a timer
 * tick frame enters the request-builder node, the whole
 * fetch -> parse -> ingest chain runs linked-direct inside the artifact's
 * linear memory, and the ONLY host crossings are the declared hostcalls:
 * plugin.getConfig (node config), http.request (fetch), and
 * storage.ingest_with_source (guarded persistence).
 *
 * The baked runtime hands a node at most 64 frames per invocation, which is
 * exactly why gp_groups emits ONE job frame for N groups; these tests run
 * against that runtime, so the pairing contract is exercised for real.
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

const GP_GROUPS_WASM = new URL("../dist/gp-groups/runtime.wasm", import.meta.url);
const SATCAT_REFERENCE_WASM = new URL("../dist/satcat-reference/runtime.wasm", import.meta.url);

const FIXTURES = new URL("../../../data-source/celestrak-reference/tests/fixtures/", import.meta.url);
const STATIONS_CSV = fs.readFileSync(new URL("celestrak-gp-group-stations.csv", FIXTURES));
const GPZ_CSV = fs.readFileSync(new URL("celestrak-gp-group-gpz.csv", FIXTURES));
const LAUNCHSITES_HTML = fs.readFileSync(new URL("celestrak-launchsites.html", FIXTURES));
const SOURCES_HTML = fs.readFileSync(new URL("celestrak-sources.html", FIXTURES));

const STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv";
const GPZ_URL = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=gpz&FORMAT=csv";
const LAUNCHSITES_URL = "https://celestrak.org/satcat/launchsites.php";
const SOURCES_URL = "https://celestrak.org/satcat/sources.php";
const DATE_HEADER = "Thu, 04 Sep 2026 01:57:53 GMT";

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
// base64 strings (an empty utf8 body for 304), ingest responses as
// {"ok":true,"result":{...}}. The fetch table is keyed by URL.
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
          const status = fetchSpec.status ?? 200;
          response = encodeHostcallEnvelope({
            ok: true,
            result: {
              status,
              headers: fetchSpec.headers ?? { date: DATE_HEADER },
              body: fetchSpec.body ? Buffer.from(fetchSpec.body).toString("base64") : "",
              body_encoding: fetchSpec.body ? "base64" : "utf8",
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
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;

  const results = [];
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt: "2026-09-04T00:00:00Z" })),
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

function fetchCalls(stub) {
  return stub.calls.filter((call) => call.operation === "http.request");
}

function provenanceOf(meta) {
  return JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
}

// Two groups via node CONFIG: the fixture table only knows these URLs, and a
// 404 for any other group would (correctly) fail the batch.
const TWO_GROUPS = { celestrak_gp_groups: "stations,gpz" };

test("celestrak-gp-groups-ingest: tick -> one fetch per group -> one $EGP per group -> one attributed ingest", async () => {
  const stub = createIngestHostStub({
    config: TWO_GROUPS,
    fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { body: GPZ_CSV } },
  });
  const results = await runFlowOnce(GP_GROUPS_WASM, stub);

  assert.deepEqual(
    fetchCalls(stub).map((call) => call.meta.url),
    [STATIONS_URL, GPZ_URL],
    "one outbound fetch per group, in list order",
  );

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "one EGP batch");
  const egp = ingests[0];
  assert.equal(egp.meta.schema, "EGP.fbs");
  assert.equal(egp.meta.provider_id, "space-data-network-02");
  assert.equal(egp.meta.source_name, "celestrak-gp-groups");
  assert.equal(egp.meta.source_url, "https://celestrak.org/NORAD/elements/");
  const concat = Buffer.concat([STATIONS_CSV, GPZ_CSV]);
  assert.equal(egp.meta.batch_id, sha256Hex(concat), "batch = sha256 of the concatenated payloads");
  assert.equal(egp.meta.reconcile, "current");
  assert.equal(egp.meta.origin_id, "celestrak.org");
  assert.equal(egp.meta.origin_name, "CelesTrak");
  assert.equal(egp.meta.dataset_id, "gp-groups");
  assert.equal(egp.meta.license_url, "https://celestrak.org/usage-policy.php");
  assert.equal(egp.meta.source_peer, "source:celestrak");
  assert.equal(egp.meta.archive.name, "gp-groups.csv");
  assert.equal(egp.segments.length, 2, "records + archive raw segments");
  assert.deepEqual(Buffer.from(egp.segments[1]), concat, "raw archive bytes = the hashed concatenation");
  const provenance = provenanceOf(egp.meta);
  assert.deepEqual(provenance.groups, ["stations", "gpz"]);
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.schema_counts["EGP.fbs"], 2);

  assert.equal(results.length, 1, "one ingest result reached the egress sink");
  assert.equal(results[0].inserted, 2, "one $EGP per group");
  assert.equal(results[0].schema, "EGP.fbs");
});

// The default list is 47 GROUP + 2 SPECIAL queries. The baked runtime hands a
// node at most 64 frames per invocation, so the parser must see 1 job + 49
// responses = 50 frames in ONE invocation; this is the contract the single
// job frame exists for, exercised against the real runtime.wasm.
test("celestrak-gp-groups-ingest: the default 49-group list lands in one invocation and one batch", async () => {
  // Learn the default URL list from the artifact itself (no override).
  const enumerate = createIngestHostStub({ fetches: {} });
  try {
    await runFlowOnce(GP_GROUPS_WASM, enumerate);
  } catch {
    // every fetch 404s -> the parse node refuses; the request list is what we want
  }
  const urls = fetchCalls(enumerate).map((call) => call.meta.url);
  assert.equal(urls.length, 49, "47 GROUP + 2 SPECIAL requests");
  assert.equal(new Set(urls).size, 49);

  const fetches = Object.fromEntries(urls.map((url) => [url, { body: STATIONS_CSV }]));
  const stub = createIngestHostStub({ fetches });
  const results = await runFlowOnce(GP_GROUPS_WASM, stub);
  assert.equal(fetchCalls(stub).length, 49);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "all 49 responses were paired in one invocation");
  assert.equal(ingests[0].meta.reconcile, "current");
  assert.equal(
    ingests[0].meta.batch_id,
    sha256Hex(Buffer.concat(urls.map(() => STATIONS_CSV))),
    "batch = sha256 of all 49 payloads in list order",
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].inserted, 49, "one $EGP per group");
});

test("celestrak-gp-groups-ingest: unchanged groups reach egress as a notice and never an ingest", async () => {
  const stub = createIngestHostStub({
    config: TWO_GROUPS,
    fetches: { [STATIONS_URL]: { status: 304 }, [GPZ_URL]: { status: 304 } },
  });
  const results = await runFlowOnce(GP_GROUPS_WASM, stub);
  assert.equal(ingestCalls(stub).length, 0, "nothing stored for 304");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 304);
  assert.equal(results[0].unchanged, true);
  assert.deepEqual(results[0].groups, ["stations", "gpz"]);
  assert.equal(results[0].source_name, "celestrak-gp-groups");
});

test("celestrak-gp-groups-ingest: a partial refresh appends only the changed groups", async () => {
  const stub = createIngestHostStub({
    config: TWO_GROUPS,
    fetches: { [STATIONS_URL]: { status: 304 }, [GPZ_URL]: { body: GPZ_CSV } },
  });
  const results = await runFlowOnce(GP_GROUPS_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].meta.reconcile, "duplicates", "unchanged groups are never superseded");
  assert.equal(ingests[0].meta.batch_id, sha256Hex(GPZ_CSV));
  assert.equal(results.length, 2, "the unchanged notice and the ingest result");
  assert.ok(results.some((r) => r.unchanged === true && r.groups?.[0] === "stations"));
  assert.ok(results.some((r) => r.inserted === 1));
});

test("celestrak-gp-groups-ingest: a non-200 group fetch stops the batch before any ingest", async () => {
  const stub = createIngestHostStub({
    config: TWO_GROUPS,
    fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { status: 403 } },
  });
  try {
    await runFlowOnce(GP_GROUPS_WASM, stub);
  } catch {
    // the parse node errors; either way nothing may be stored
  }
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall after a refused fetch");
});

test("celestrak-gp-groups-ingest: OMM re-emission stores a second batch only when configured", async () => {
  const stub = createIngestHostStub({
    config: { ...TWO_GROUPS, celestrak_gp_groups_emit_omm: true },
    fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { body: GPZ_CSV } },
  });
  const results = await runFlowOnce(GP_GROUPS_WASM, stub);
  const schemas = ingestCalls(stub).map((call) => call.meta.schema).sort();
  assert.deepEqual(schemas, ["EGP.fbs", "OMM.fbs"]);
  const omm = ingestCalls(stub).find((call) => call.meta.schema === "OMM.fbs");
  assert.equal(omm.meta.reconcile, "duplicates");
  assert.equal(omm.meta.archive, undefined, "payload archived once (EGP batch only)");
  assert.equal(results.find((r) => r.schema === "OMM.fbs").inserted, 4);
});

test("celestrak-satcat-reference-ingest: one tick fans out to BOTH reference tables", async () => {
  const stub = createIngestHostStub({
    fetches: {
      [LAUNCHSITES_URL]: { body: LAUNCHSITES_HTML },
      [SOURCES_URL]: { body: SOURCES_HTML },
    },
  });
  const results = await runFlowOnce(SATCAT_REFERENCE_WASM, stub);

  assert.deepEqual(fetchCalls(stub).map((call) => call.meta.url).sort(), [LAUNCHSITES_URL, SOURCES_URL]);
  for (const call of fetchCalls(stub)) {
    assert.equal(call.meta.max_bytes ?? call.meta.maxBytes, 2097152, "2 MiB byte budget per page");
  }

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "launch sites + owners");
  const bySchema = new Map(ingests.map((call) => [call.meta.schema, call]));
  const sit = bySchema.get("SIT.fbs");
  assert.ok(sit, "SIT ingest fired");
  assert.equal(sit.meta.source_name, "celestrak-satcat-launch-sites");
  assert.equal(sit.meta.dataset_id, "satcat-launch-sites");
  assert.equal(sit.meta.batch_id, sha256Hex(LAUNCHSITES_HTML));
  assert.equal(sit.meta.reconcile, "current");
  assert.equal(sit.meta.origin_id, "celestrak.org");
  assert.equal(sit.meta.archive.name, "launchsites.html");
  assert.deepEqual(Buffer.from(sit.segments[1]), Buffer.from(LAUNCHSITES_HTML), "raw archive bytes");
  const lcc = bySchema.get("LCC.fbs");
  assert.ok(lcc, "LCC ingest fired");
  assert.equal(lcc.meta.source_name, "celestrak-satcat-owners");
  assert.equal(lcc.meta.dataset_id, "satcat-owners");
  assert.equal(lcc.meta.batch_id, sha256Hex(SOURCES_HTML));
  assert.equal(lcc.meta.source_url, SOURCES_URL);
  assert.deepEqual(provenanceOf(lcc.meta).warnings, []);

  assert.equal(results.length, 2);
  for (const result of results) assert.equal(result.inserted, 3, "3 fixture rows per table");
});

test("celestrak-satcat-reference-ingest: node CONFIG URL overrides drive the fetches", async () => {
  const sitesURL = "https://fixtures.test/launchsites.html";
  const sourcesURL = "https://fixtures.test/sources.html";
  const stub = createIngestHostStub({
    config: { celestrak_satcat_launchsites_url: sitesURL, celestrak_satcat_sources_url: sourcesURL },
    fetches: { [sitesURL]: { body: LAUNCHSITES_HTML }, [sourcesURL]: { body: SOURCES_HTML } },
  });
  await runFlowOnce(SATCAT_REFERENCE_WASM, stub);
  assert.deepEqual(fetchCalls(stub).map((call) => call.meta.url).sort(), [sitesURL, sourcesURL]);
  const lcc = ingestCalls(stub).find((call) => call.meta.schema === "LCC.fbs");
  assert.equal(lcc.meta.source_url, sourcesURL, "node CONFIG override drove the fetch");
});

test("celestrak-satcat-reference-ingest: a 304 page yields an unchanged notice, not an ingest", async () => {
  const stub = createIngestHostStub({
    fetches: { [LAUNCHSITES_URL]: { status: 304 }, [SOURCES_URL]: { body: SOURCES_HTML } },
  });
  const results = await runFlowOnce(SATCAT_REFERENCE_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].meta.schema, "LCC.fbs");
  const unchanged = results.find((r) => r.unchanged === true);
  assert.ok(unchanged, "the unchanged notice reached egress");
  assert.equal(unchanged.source_name, "celestrak-satcat-launch-sites");
  assert.equal(unchanged.dataset_id, "satcat-launch-sites");
});
