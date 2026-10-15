// data-source/celestrak-request SDK-compat tests on the typed contracts (1.0): the compiled wasm in the SDK browser
// harness, TimerTick / IngestResult / IngestRequest frames in, HttpRequest / $FSO frames out, each request's parser job
// a size-prefixed $ICN record in HttpRequest.CONTEXT, and the node config the SDS $PIV plugin.getConfig answer
// (one ModuleConfig on raw "config"): runner-default URLs and node-CONFIG overrides.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import {
  decodeHttpRequest,
  decodeIngestResult,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

import { ISOMORPHIC_WASM_PATH, MANIFEST_PATH, STANDARDS_ROOT, createHarness, flatbuffers, sdsLib } from "./harness.mjs";

const icnLib = await sdsLib("ICN");
const fsoLib = await sdsLib("FSO");

const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
};
const tickInput = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-gp", firedMs: Date.UTC(2026, 6, 4) }) });

function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}
// Every output frame decoded as an HttpRequest, keyed by port.
function requestsByPort(response) {
  const map = new Map();
  for (const frame of ok(response).outputs) map.set(frame.portId, decodeHttpRequest(frame.payload));
  return map;
}
// The job a request carries: one size-prefixed $ICN record in CONTEXT.
function jobOf(request) {
  const context = request.context;
  assert.equal(identifierOf(context.subarray(4)), "$ICN", "CONTEXT is one size-prefixed $ICN record");
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4);
  const bb = new flatbuffers.ByteBuffer(Uint8Array.from(context.subarray(4)));
  return icnLib.ICN.getRootAsICN(bb).unpack();
}

test("celestrak-request artifact passes SDK compliance with typed ports only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "gp.tick": "TICK", "gp.request": "HREQ",
    "satcat.tick": "TICK", "satcat.request_txt": "HREQ", "satcat.request_csv": "HREQ",
    "spw.tick": "TICK", "spw.request": "HREQ",
    "eop.tick": "TICK", "eop.request": "HREQ",
    "socrates.tick": "TICK", "socrates.request_minrange": "HREQ", "socrates.request_maxprob": "HREQ",
    "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.request": "HREQ",
    "cache_warm.result": "INGR", "cache_warm.query": "$FSO",
  });
});

test("gp emits the runner-default request with its attributed job in CONTEXT", async (t) => {
  const harness = await createHarness(t);
  const outputs = requestsByPort(await harness.invoke({ methodId: "gp", inputs: [tickInput()] }));
  assert.deepEqual([...outputs.keys()], ["request"], "one request, no job port");
  const request = outputs.get("request");
  assert.equal(request.method, "GET");
  assert.equal(request.url, "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv");
  assert.equal(request.timeoutMs, 90000, "runner HTTPTimeout default");
  assert.equal(request.maxBytes, 67108864, "GP full-catalog byte budget (64 MiB)");
  assert.deepEqual(request.headers, {}, "the host presents its recorded validators");
  const job = jobOf(request);
  assert.equal(job.CONNECTOR_ID, "celestrak-gp");
  assert.equal(job.SOURCE_NAME, "celestrak-gp");
  assert.equal(job.PROVIDER_ID, "space-data-network-02");
  assert.equal(job.ENDPOINT_URL, request.url);
  assert.equal(job.HTTP_METHOD, "GET");
  assert.equal(job.KIND, icnLib.icnConnectorKind.HttpsPull);
  assert.equal(job.TARGET_SCHEMA, "OMM.fbs");
  assert.deepEqual(job.EMITS_SCHEMAS, ["OMM", "MPE"]);
  assert.equal(job.POST_INGEST_ACTION, icnLib.icnPostIngestAction.Archive, "the raw payload is archived");
  assert.deepEqual(harness.calls, ["plugin.getConfig"]);
});

// The upstream origin and its usage terms ride on EVERY job so the parser's ingest request names the organisation the
// bytes came from - an organisation, never a tag string.
const LANES = [
  ["gp", "request", "celestrak-gp", "gp-full-catalog", 67108864, "OMM.fbs"],
  ["satcat", "request_txt", "celestrak-satcat", "satcat", 33554432, "CAT.fbs"],
  ["satcat", "request_csv", "celestrak-satcat-csv", "satcat-csv", 33554432, "CAT.fbs"],
  ["spw", "request", "celestrak-space-weather", "sw-all", 4194304, "SPW.fbs"],
  ["eop", "request", "celestrak-eop", "eop-all", 4194304, "EOP.fbs"],
  ["socrates", "request_minrange", "celestrak-socrates-minrange", "socrates-minrange", 8388608, "CSM.fbs"],
  ["socrates", "request_maxprob", "celestrak-socrates-maxprob", "socrates-maxprob", 8388608, "CSM.fbs"],
];

for (const [methodId, requestPort, sourceName, datasetId, maxBytes, schema] of LANES) {
  test(`${methodId}/${requestPort} carries the origin registry, licence and byte budget`, async (t) => {
    const harness = await createHarness(t);
    const outputs = requestsByPort(await harness.invoke({ methodId, inputs: [tickInput()] }));
    const request = outputs.get(requestPort);
    assert.equal(request.maxBytes, maxBytes, "per-lane response byte budget");
    const job = jobOf(request);
    assert.equal(job.SOURCE_NAME, sourceName);
    assert.equal(job.ORIGIN_ID, "celestrak.org");
    assert.equal(job.ORIGIN_NAME, "CelesTrak");
    assert.equal(job.DATASET_ID, datasetId);
    assert.equal(job.TARGET_SCHEMA, schema);
    assert.equal(job.LICENSE_URL, "https://celestrak.org/usage-policy.php");
    // The licence text is the origin's usage-policy sentence quoted verbatim; a non-empty declaration, never a grant.
    assert.match(job.LICENSE, /^Only download the data you need/);
    assert.ok(job.CITATION.includes("https://celestrak.org/usage-policy.php"));
    assert.equal(job.ENDPOINT_URL, request.url);
  });
}

test("byte budgets and licence text honour node-CONFIG overrides", async (t) => {
  const harness = await createHarness(t, {
    celestrak_gp_max_bytes: 1048576,
    celestrak_license: "CC0-1.0",
    celestrak_license_url: "https://example.test/terms",
    celestrak_citation: "Example citation",
  });
  const request = requestsByPort(await harness.invoke({ methodId: "gp", inputs: [tickInput()] })).get("request");
  assert.equal(request.maxBytes, 1048576);
  const job = jobOf(request);
  assert.equal(job.LICENSE, "CC0-1.0");
  assert.equal(job.LICENSE_URL, "https://example.test/terms");
  assert.equal(job.CITATION, "Example citation");
  assert.equal(job.ORIGIN_ID, "celestrak.org", "the origin is the registry's, not configurable");
});

test("gp honors node-CONFIG URL/timeout/provider overrides", async (t) => {
  const harness = await createHarness(t, {
    celestrak_gp_url: "https://fixtures.test/gp.csv",
    celestrak_http_timeout_ms: 5000,
    celestrak_provider_id: "prov-test",
  });
  const request = requestsByPort(await harness.invoke({ methodId: "gp", inputs: [tickInput()] })).get("request");
  assert.equal(request.url, "https://fixtures.test/gp.csv");
  assert.equal(request.timeoutMs, 5000);
  assert.equal(jobOf(request).PROVIDER_ID, "prov-test");
  assert.equal(jobOf(request).ENDPOINT_URL, "https://fixtures.test/gp.csv");
});

test("satcat emits BOTH legacy txt and csv fetches (runner dual-source parity)", async (t) => {
  const harness = await createHarness(t);
  const outputs = requestsByPort(await harness.invoke({ methodId: "satcat", inputs: [tickInput()] }));
  assert.deepEqual([...outputs.keys()], ["request_txt", "request_csv"]);
  assert.equal(outputs.get("request_txt").url, "https://celestrak.org/pub/satcat.txt");
  assert.equal(outputs.get("request_csv").url, "https://celestrak.org/pub/satcat.csv");
  assert.equal(jobOf(outputs.get("request_txt")).SOURCE_NAME, "celestrak-satcat");
  assert.equal(jobOf(outputs.get("request_csv")).SOURCE_NAME, "celestrak-satcat-csv");
  assert.equal(jobOf(outputs.get("request_txt")).DATASET_ID, "satcat");
  assert.equal(jobOf(outputs.get("request_csv")).DATASET_ID, "satcat-csv");
});

test("spw emits the space-weather fetch with its job", async (t) => {
  const harness = await createHarness(t);
  const request = requestsByPort(await harness.invoke({ methodId: "spw", inputs: [tickInput()] })).get("request");
  assert.equal(request.url, "https://celestrak.org/SpaceData/SW-All.csv");
  assert.equal(jobOf(request).SOURCE_NAME, "celestrak-space-weather");
  assert.equal(jobOf(request).DATASET_ID, "sw-all");
});

test("eop emits the Earth-orientation fetch with its job (URL override via node CONFIG)", async (t) => {
  const request = requestsByPort(await (await createHarness(t)).invoke({ methodId: "eop", inputs: [tickInput()] })).get("request");
  assert.equal(request.url, "https://celestrak.org/SpaceData/EOP-All.csv");
  assert.equal(request.method, "GET");
  assert.equal(jobOf(request).SOURCE_NAME, "celestrak-eop");
  assert.equal(jobOf(request).DATASET_ID, "eop-all");
  const overridden = requestsByPort(
    await (await createHarness(t, { celestrak_eop_url: "https://fixtures.test/EOP-All.csv", celestrak_eop_max_bytes: 2048 })).invoke({ methodId: "eop", inputs: [tickInput()] }),
  ).get("request");
  assert.equal(overridden.url, "https://fixtures.test/EOP-All.csv");
  assert.equal(overridden.maxBytes, 2048);
});

test("socrates emits BOTH sort-file fetches as their own lanes", async (t) => {
  const outputs = requestsByPort(await (await createHarness(t)).invoke({ methodId: "socrates", inputs: [tickInput()] }));
  assert.equal(outputs.get("request_minrange").url, "https://celestrak.org/SOCRATES/sort-minRange.csv");
  assert.equal(outputs.get("request_maxprob").url, "https://celestrak.org/SOCRATES/sort-maxProb.csv");
  assert.equal(jobOf(outputs.get("request_minrange")).SOURCE_NAME, "celestrak-socrates-minrange");
  assert.equal(jobOf(outputs.get("request_maxprob")).SOURCE_NAME, "celestrak-socrates-maxprob");
  assert.equal(jobOf(outputs.get("request_minrange")).ENDPOINT_URL, outputs.get("request_minrange").url);
  assert.equal(jobOf(outputs.get("request_maxprob")).ENDPOINT_URL, outputs.get("request_maxprob").url);
});

// --------------------------------------------------------------------------
// publish_request (§19 dataset-publication trigger).
// --------------------------------------------------------------------------

const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

// What storage-ingest answers: schema/inserted/batch and the reconcile counters - NO provider_id, NO source_name.
const ingestResultInput = (r = {}) => ({
  portId: "result", typeRef: TYPE.INGR,
  payload: encodeIngestResult({ schema: "CAT.fbs", inserted: 2, batchId: "b".repeat(64), archived: "celestrak/satcat.csv", ...r }),
});
// What the parser's *_meta port carries: the ONLY place provider_id and source_name exist.
const ingestMetaInput = ({ schema = "CAT.fbs", batchId = "b".repeat(64), providerId = "space-data-network-02", sourceName = "celestrak-satcat" } = {}) => ({
  portId: "meta", typeRef: TYPE.INGQ, payload: encodeIngestRequest({ schema, tags: { providerId, sourceName, batchId } }),
});

test("publish_request emits NOTHING when no celestrak_publish_url is configured", async (t) => {
  const response = ok(await (await createHarness(t)).invoke({ methodId: "publish_request", inputs: [ingestResultInput(), ingestMetaInput()] }));
  assert.equal(response.outputs.length, 0, "absence of config is not permission to publish");
});

test("publish_request POSTs the IngestResult naming the stored batch", async (t) => {
  const harness = await createHarness(t, { celestrak_publish_url: PUBLISH_URL });
  const request = requestsByPort(await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput(), ingestMetaInput()] })).get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.deepEqual(request.headers, { "content-type": "application/octet-stream" });
  assert.equal(request.timeoutMs, 90000);
  assert.deepEqual(decodeIngestResult(request.body), {
    schema: "CAT.fbs", providerId: "space-data-network-02", sourceName: "celestrak-satcat", batchId: "b".repeat(64),
    inserted: 2, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "celestrak/satcat.csv", refused: "",
  });
});

test("publish_request takes provider/source from the meta, schema+batch from the result", async (t) => {
  const harness = await createHarness(t, { celestrak_publish_url: PUBLISH_URL });
  const request = requestsByPort(await harness.invoke({
    methodId: "publish_request",
    inputs: [ingestResultInput({ schema: "OMM.fbs", batchId: "c".repeat(64) }), ingestMetaInput({ schema: "MPE.fbs", batchId: "d".repeat(64), providerId: "prov-test", sourceName: "celestrak-gp" })],
  })).get("request");
  const body = decodeIngestResult(request.body);
  assert.deepEqual([body.schema, body.providerId, body.sourceName, body.batchId], ["OMM.fbs", "prov-test", "celestrak-gp", "c".repeat(64)]);
  // the request's schema and batch when the result carries none
  const fallback = requestsByPort(await harness.invoke({
    methodId: "publish_request", inputs: [ingestResultInput({ schema: "", batchId: "" }), ingestMetaInput({ schema: "OMM.fbs", batchId: "e".repeat(64) })],
  })).get("request");
  assert.deepEqual([decodeIngestResult(fallback.body).schema, decodeIngestResult(fallback.body).batchId], ["OMM.fbs", "e".repeat(64)]);
});

test("publish_request requires BOTH typed frames and publishes nothing for a refused batch", async (t) => {
  const harness = await createHarness(t, { celestrak_publish_url: PUBLISH_URL });
  assert.equal((await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput()] })).statusCode, 400);
  assert.equal((await harness.invoke({ methodId: "publish_request", inputs: [ingestMetaInput()] })).statusCode, 400);
  const notResult = await harness.invoke({ methodId: "publish_request", inputs: [{ ...ingestResultInput(), payload: encodeTimerTick({}) }, ingestMetaInput()] });
  assert.equal(notResult.errorCode, "invalid-result-frame");
  const refused = ok(await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput({ inserted: 0, refused: "refused: disk guardrail" }), ingestMetaInput()] }));
  assert.equal(refused.outputs.length, 0, "nothing stored, nothing announced");
});

test("publish_request refuses to publish an incomplete identity", async (t) => {
  const harness = await createHarness(t, { celestrak_publish_url: PUBLISH_URL });
  const response = await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput(), ingestMetaInput({ sourceName: "" })] });
  assert.equal(response.statusCode, 400, "no source_name -> nothing is announced");
  assert.equal(response.errorCode, "incomplete-publication-identity");
});

// --------------------------------------------------------------------------
// cache_warm: the default query as one $FSO control frame.
// --------------------------------------------------------------------------

function decodeFso(bytes) {
  assert.equal(identifierOf(bytes), "$FSO");
  return fsoLib.FSO.getRootAsFSO(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
}
const taggedI64 = (n) => { const b = Buffer.alloc(13); b[0] = 2; b.writeUInt32LE(8, 1); b.writeBigInt64LE(BigInt(n), 5); return [...b]; };

test("cache_warm emits the default-query $FSO with the LIMIT bound, never interpolated", async (t) => {
  const response = ok(await (await createHarness(t)).invoke({ methodId: "cache_warm", inputs: [ingestResultInput({ schema: "OMM.fbs" })] }));
  assert.deepEqual(response.outputs.map((f) => f.portId), ["query"]);
  const fso = decodeFso(response.outputs[0].payload);
  assert.equal(fso.OPERATION, fsoLib.flatSqlNodeOperation.QUERY_RECORDS);
  assert.equal(Buffer.from(fso.QUERY).toString("utf8"), "SELECT data FROM sds_omm ORDER BY rowid DESC LIMIT ?");
  assert.equal(fso.PARAMETER_COUNT, 1);
  assert.deepEqual(fso.PARAMETERS, taggedI64(5000));
  const custom = ok(await (await createHarness(t, { celestrak_cache_sql: "SELECT data FROM sds_omm LIMIT ?", celestrak_cache_max_rows: 25 }))
    .invoke({ methodId: "cache_warm", inputs: [ingestResultInput()] }));
  const fso2 = decodeFso(custom.outputs[0].payload);
  assert.equal(Buffer.from(fso2.QUERY).toString("utf8"), "SELECT data FROM sds_omm LIMIT ?");
  assert.deepEqual(fso2.PARAMETERS, taggedI64(25));
});

test("celestrak-request imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});
