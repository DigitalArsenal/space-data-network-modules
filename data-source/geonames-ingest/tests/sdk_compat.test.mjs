// data-source/geonames-ingest SDK-compat tests on the typed contracts (1.0): the four orchestration nodes turn a daily
// TimerTick into an $FSO mark read, a set of HttpRequests carrying the job ($GNP header) in CONTEXT, an IngestRequest
// and an advanced $IRM resume mark - with runner defaults and node-CONFIG overrides through the builtin plugin.getConfig
// hostcall (SDS $PIV, one ModuleConfig on raw "config").
//
// Every assertion is a computable outcome of the SCHEDULE: which lane a tick runs, which URLs it asks for, what the
// range and if-none-match headers say, and under exactly which conditions the mark advances.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeIngestResult } from "space-data-module-sdk/runtime-contracts";

import {
  BASE, ISOMORPHIC_WASM_PATH, MANIFEST_PATH, STANDARDS_ROOT, createHarness, fsoLib, irm, irmLib, jobHeader, markFrames,
  metaFrame, outputsByPort, readHeader, recordsFrame, responseFrame, resultFrame, tickFrame,
} from "./helpers.mjs";

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
const AUG15 = Date.UTC(2026, 7, 15);

// ---------------------------------------------------------------------------
// artifact
// ---------------------------------------------------------------------------

test("geonames-ingest artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("every port names ONE concrete FlatBuffer type", () => {
  const ids = {};
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(type.wireFormat, "flatbuffer", port.portId);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "mark_query.tick": "TICK", "mark_query.query": "$FSO",
    "ingest_plan.tick": "TICK", "ingest_plan.mark": "$FSB", "ingest_plan.request": "HREQ", "ingest_plan.request_deletes": "HREQ",
    "ingest_plan.request_admin1": "HREQ", "ingest_plan.request_admin2": "HREQ", "ingest_plan.request_country": "HREQ",
    "ingest_meta.records": "$GNP", "ingest_meta.response": "HRSP", "ingest_meta.meta": "INGQ", "ingest_meta.records": "$GNP",
    "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.mark": "$IRM", "publish_request.request": "HREQ",
  });
});

test("geonames-ingest imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("the manifest declares capabilities [] and both runtime targets; the guest-link metadata wasi-sequential", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.geonames-ingest");
  const metadata = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dist/guest-link/metadata.json", import.meta.url)), "utf8"));
  assert.equal(metadata.threadModel, "wasi-sequential");
});

// ---------------------------------------------------------------------------
// mark_query
// ---------------------------------------------------------------------------

test("mark_query emits the $FSO that reads the newest $IRM marks through the code-named view", async (t) => {
  const harness = await createHarness(t);
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickFrame()] })).get("query");
  assert.equal(query.OPERATION, fsoLib.flatSqlNodeOperation.QUERY_RECORDS);
  assert.equal(Buffer.from(query.QUERY).toString("utf8"), "SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?");
  // one FlatSQL tagged parameter: tag 2 (int64), size 8, the scan row count
  assert.equal(query.PARAMETER_COUNT, 1);
  const p = Buffer.from(query.PARAMETERS);
  assert.deepEqual([p[0], p.readUInt32LE(1), p.readBigInt64LE(5)], [2, 8, 32n]);
  assert.deepEqual(harness.calls, ["plugin.getConfig"]);
});

test("mark_query honours geonames_mark_sql and geonames_mark_scan_rows", async (t) => {
  const harness = await createHarness(t, { geonames_mark_sql: "SELECT _data FROM IRM WHERE _source = 'x' LIMIT ?", geonames_mark_scan_rows: 8 });
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickFrame()] })).get("query");
  assert.equal(Buffer.from(query.QUERY).toString("utf8"), "SELECT _data FROM IRM WHERE _source = 'x' LIMIT ?");
  assert.equal(Buffer.from(query.PARAMETERS).readBigInt64LE(5), 8n);
});

// ---------------------------------------------------------------------------
// ingest_plan — the schedule
// ---------------------------------------------------------------------------

test("the FIRST tick (no mark) runs the SEED: the archive plus all three lookup files, each carrying its job", async (t) => {
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] }));
  const request = outputs.get("request");
  assert.equal(request.url, `${BASE}cities15000.zip`);
  assert.equal(request.method, "GET");
  assert.equal(request.timeoutMs, 90000);
  assert.equal(outputs.get("request_admin1").url, `${BASE}admin1CodesASCII.txt`);
  assert.equal(outputs.get("request_admin2").url, `${BASE}admin2Codes.txt`);
  assert.equal(outputs.get("request_country").url, `${BASE}countryInfo.txt`);
  // A seed edition IS the gazetteer's current state; there is nothing to tombstone, so no deletes fetch is planned.
  assert.equal(outputs.get("request_deletes"), undefined);

  const job = readHeader(request.context);
  assert.equal(job.ID, "geonames", "the id prefix records are minted under");
  assert.equal(job.NAME, "cities15000.txt", "the archive member the job decodes");
  assert.deepEqual(
    [job.SOURCE.DATASET_ID, job.SOURCE.DATASET_NAME, job.SOURCE.DATASET_URL, job.SOURCE.SOURCE_URL, job.SOURCE.SOURCE_QUERY],
    ["geonames", "GeoNames gazetteer", BASE, `${BASE}cities15000.zip`, "cities15000.zip"],
  );
  assert.equal(job.SOURCE.DATASET_EPOCH, "2026-08-15T00:00:00.000Z", "the epoch is the TICK's date");
  assert.equal(job.SOURCE.LICENSE, "CC BY 4.0");
  assert.equal(job.SOURCE.ATTRIBUTION, "GeoNames (CC BY 4.0)");
  assert.equal(job.SOURCE.LICENSE_URL, "https://creativecommons.org/licenses/by/4.0/");
  const country = readHeader(outputs.get("request_country").context);
  assert.deepEqual([country.NAME, country.SOURCE.SOURCE_QUERY, country.SOURCE.DATASET_EPOCH], ["countryInfo.txt", "countryInfo.txt", "2026-08-15T00:00:00.000Z"]);
});

test("the seed fetch is RANGED under the host's 4 MiB response-body cap", async (t) => {
  // A larger ask is truncated by the Go host and inflates to a plausible short gazetteer with no error anywhere, so the
  // guest never makes it.
  const harness = await createHarness(t);
  const request = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] })).get("request");
  assert.deepEqual(request.headers, { range: `bytes=0-${4 * 1024 * 1024 - 1}` });
});

test("a configured seed budget above the host cap is CLAMPED, not honoured", async (t) => {
  const harness = await createHarness(t, { geonames_seed_max_bytes: 64 * 1024 * 1024 });
  const request = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame()] })).get("request");
  assert.equal(request.headers.range, `bytes=0-${4 * 1024 * 1024 - 1}`);
});

test("a SEEDED mark makes the tick a DELTA for the tick's own UTC day", async (t) => {
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({
    methodId: "ingest_plan", inputs: [tickFrame(Date.UTC(2026, 7, 15, 3, 17)), ...markFrames([irm({ date: "2026-08-14" })])],
  }));
  assert.equal(outputs.get("request").url, `${BASE}modifications-2026-08-15.txt`);
  assert.equal(outputs.get("request_deletes").url, `${BASE}deletes-2026-08-15.txt`);
  // The lookup tables change on the gazetteer's own slow cadence, not daily.
  assert.equal(outputs.get("request_admin1"), undefined);
  const job = readHeader(outputs.get("request").context);
  assert.deepEqual([job.NAME, job.SOURCE.SOURCE_QUERY, job.SOURCE.DATASET_EPOCH], ["modifications-2026-08-15.txt", "modifications-2026-08-15.txt", "2026-08-15T00:00:00.000Z"]);
  assert.deepEqual(outputs.get("request").headers, {}, "the daily files are fetched whole");
  assert.equal(readHeader(outputs.get("request_deletes").context).SOURCE.SOURCE_URL, `${BASE}deletes-2026-08-15.txt`);
});

test("a tick for a day already on the mark is a LEDGERED NO-OP: no fetch at all", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames([irm({ date: "2026-08-15" })])] });
  assert.equal(response.statusCode, 0, "a day already ingested is not an error");
  assert.equal(response.outputs.length, 0, "nothing is requested, so the run ends here");
});

test("the mark's ETag rides out as if-none-match, so an unchanged file costs one request", async (t) => {
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({
    methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames([irm({ date: "2026-08-14", etag: '"76b6-6590c8be06ef0"' })])],
  }));
  assert.equal(outputs.get("request").headers["if-none-match"], '"76b6-6590c8be06ef0"');
});

test("the mark is picked by JOB_ID and the highest SEQUENCE, across $FSB chunks", async (t) => {
  // One relation holds every lane's marks; the newest rows come first. Another dataset's (and another lane's) marks are
  // never resumed from, and an older mark of this dataset never wins over a newer one.
  const records = [
    irm({ dataset: "geonames-full", date: "2026-08-15" }),
    irm({ jobId: "copernicus@terrain@x", date: "2026-08-15" }),
    irm({ date: "2026-08-13", etag: '"old"' }),
    irm({ date: "2026-08-14", etag: '"new"' }),
  ];
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames(records, 100)] }));
  assert.equal(outputs.get("request").url, `${BASE}modifications-2026-08-15.txt`);
  assert.equal(outputs.get("request").headers["if-none-match"], '"new"');
});

test("a mark for a DIFFERENT dataset (or one that never completed) is ignored, never resumed from", async (t) => {
  // Resuming dataset A from dataset B's date would skip A's seed entirely and never report it.
  for (const mark of [irm({ dataset: "somewhere-else", date: "2026-08-15" }), irm({ date: "2026-08-14", state: "FAILED" })]) {
    const harness = await createHarness(t);
    const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames([mark])] }));
    assert.equal(outputs.get("request").url, `${BASE}cities15000.zip`, "an unrelated mark cannot suppress the seed");
  }
  // and an empty result (no marks at all) is the first run
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames([])] }));
  assert.equal(outputs.get("request").url, `${BASE}cities15000.zip`);
});

test("ingest_plan honours node-CONFIG base URL, edition, dataset and timeout", async (t) => {
  const harness = await createHarness(t, {
    geonames_base_url: "https://fixtures.test/dump/", geonames_seed_dataset: "cities500", geonames_http_timeout_ms: 5000,
    geonames_dataset_id: "geonames-full", geonames_id_prefix: "gn",
  });
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), ...markFrames([irm({ date: "2026-08-14" })])] }));
  assert.equal(outputs.get("request").url, "https://fixtures.test/dump/cities500.zip", "the geonames mark is not this dataset's");
  assert.equal(outputs.get("request").timeoutMs, 5000);
  const job = readHeader(outputs.get("request").context);
  assert.deepEqual([job.ID, job.NAME, job.SOURCE.DATASET_ID], ["gn", "cities500.txt", "geonames-full"]);
});

test("ingest_plan refuses a tick it cannot date, and a mark frame that is not an $FSB", async (t) => {
  // $GNP.SOURCE.DATASET_EPOCH is required on every record and is the EDITION boundary; an epoch guessed in-guest would
  // make two editions falsely comparable.
  const harness = await createHarness(t);
  const undated = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(0)] });
  assert.equal(undated.errorCode, "missing-tick-date");
  const notFsb = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(), { ...markFrames([])[0], payload: tickFrame().payload }] });
  assert.equal(notFsb.errorCode, "invalid-mark-frame");
});

// ---------------------------------------------------------------------------
// ingest_meta
// ---------------------------------------------------------------------------

test("ingest_meta authors the IngestRequest: $GNP, no reconcile, one batch per edition, the response's provenance", async (t) => {
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({
    methodId: "ingest_meta",
    inputs: [recordsFrame(2), responseFrame({ headers: { "content-range": "bytes 0-4194303/3306445", etag: '"3273cd-6590c8be06b08"', "last-modified": "Sat, 15 Aug 2026 02:18:01 GMT", "content-type": "application/zip" } })],
  }));
  const meta = outputs.get("meta");
  assert.equal(meta.schema, "GNP.fbs");
  assert.deepEqual(
    [meta.tags.providerId, meta.tags.sourceName, meta.tags.batchId, meta.tags.sourceUrl],
    ["geonames", "geonames-gazetteer", "geonames@2026-08-15", `${BASE}cities15000.zip`],
  );
  // NOT a source-batch reconcile: a daily modifications file is an upsert of a few thousand rows, and retiring older
  // batches on it would delete the rest of the world.
  assert.equal(meta.reconcile, "none");
  assert.deepEqual(meta.provenance, {
    sourceUrl: `${BASE}cities15000.zip`, httpStatus: 206, etag: '"3273cd-6590c8be06b08"', lastModified: "Sat, 15 Aug 2026 02:18:01 GMT",
    contentType: "application/zip", retrievedMs: Date.UTC(2026, 7, 15, 2, 18), parser: "geonames-ingest-wasm", parserVersion: "v1",
    sourceSha256: "", normalizedSha256: "", normalizedCount: 2, schemaCounts: { "GNP.fbs": 2 }, warnings: [], fromCache: false, attributes: [],
  }, "the three facts only the RESPONSE carries, and the edition's record count");
});

test("ingest_meta forwards the record stream untouched", async (t) => {
  const harness = await createHarness(t);
  const records = recordsFrame(3);
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_meta", inputs: [records, responseFrame()] }));
  assert.deepEqual(outputs.get("records"), Buffer.from(records.payload));
  assert.equal(outputs.get("meta").provenance.normalizedCount, 3);
});

test("ingest_meta REFUSES a seed the host could only have truncated", async (t) => {
  // The bytes in hand are a PREFIX of the archive. Decoding a prefix would report a gazetteer that is merely missing
  // places.
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "ingest_meta", inputs: [recordsFrame(), responseFrame({ headers: { "content-range": "bytes 0-4194303/12000000" } })] });
  assert.equal(response.errorCode, "seed-exceeds-host-body-cap");
  assert.equal(response.outputs.length, 0, "nothing reaches storage");
  // a delta file is fetched whole: the seed check does not apply to it
  const delta = await harness.invoke({ methodId: "ingest_meta", inputs: [recordsFrame(), responseFrame({ status: 200, headers: { "content-range": "bytes 0-4194303/12000000" }, context: jobHeader({ file: "modifications-2026-08-15.txt", name: "modifications-2026-08-15.txt" }) })] });
  assert.equal(delta.statusCode, 0);
});

test("ingest_meta needs the dataset identity storage cannot invent", async (t) => {
  const harness = await createHarness(t);
  for (const context of [new Uint8Array(0), jobHeader({ dataset: "" }), jobHeader({ epoch: "" })]) {
    const response = await harness.invoke({ methodId: "ingest_meta", inputs: [recordsFrame(), responseFrame({ context })] });
    assert.equal(response.errorCode, "incomplete-job-attribution");
  }
});

// ---------------------------------------------------------------------------
// publish_request — the mark advance and the epoch announce
// ---------------------------------------------------------------------------

const META = {
  schema: "GNP.fbs",
  tags: { providerId: "geonames", sourceName: "geonames-gazetteer", batchId: "geonames@2026-08-15", sourceUrl: `${BASE}modifications-2026-08-15.txt` },
  reconcile: "none",
  provenance: { sourceUrl: `${BASE}modifications-2026-08-15.txt`, httpStatus: 200, etag: '"76b6-6590c8be06ef0"', lastModified: "Sat, 15 Aug 2026 02:18:01 GMT", normalizedCount: 12, schemaCounts: { "GNP.fbs": 12 } },
};
const RESULT = { schema: "GNP.fbs", providerId: "geonames", sourceName: "geonames-gazetteer", batchId: "geonames@2026-08-15", inserted: 12 };
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

test("publish_request advances the mark ($IRM) AND ledgers the ETag from the storage result", async (t) => {
  const harness = await createHarness(t);
  const mark = outputsByPort(await harness.invoke({ methodId: "publish_request", inputs: [resultFrame(RESULT), metaFrame(META)] })).get("mark");
  assert.equal(mark.JOB_ID, "geonames-ingest/geonames");
  assert.equal(mark.SEQUENCE, BigInt(AUG15 / 86400000), "the edition's day number: monotonic per job");
  assert.equal(mark.STATE, irmLib.irmJobState.COMPLETE, "the dataset is seeded");
  assert.equal(mark.PROVIDER_ID, "geonames");
  assert.equal(mark.INGESTOR_ID, "com.digitalarsenal.data-source.geonames-ingest");
  assert.equal(mark.SOURCE.SOURCE_URL, `${BASE}modifications-2026-08-15.txt`);
  assert.equal(mark.SOURCE.SOURCE_VERSION, "2026-08-15T00:00:00.000Z", "the stored edition");
  assert.equal(mark.SOURCE.ENTITY_TAG, '"76b6-6590c8be06ef0"', "the mark IS the same-data ledger");
  assert.equal(mark.SOURCE.LAST_MODIFIED, "Sat, 15 Aug 2026 02:18:01 GMT");
  assert.deepEqual([mark.LAST_CHUNK.BATCH_ID, mark.LAST_CHUNK.RECORDS_DECODED, mark.LAST_CHUNK.RECORDS_STORED], ["geonames@2026-08-15", 12, 12]);
  assert.equal(mark.RECORDS_COMMITTED, 12n);
  assert.deepEqual([mark.TARGET_STANDARD, mark.RECONCILE_MODE], ["$GNP", "none"]);
  assert.deepEqual(mark.TAGS, ["date:2026-08-15", "lane:delta"]);
  assert.match(mark.UPDATED_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("a SEED result marks the dataset seeded, so the next tick is a delta", async (t) => {
  const harness = await createHarness(t);
  const seedMeta = { ...META, tags: { ...META.tags, sourceUrl: `${BASE}cities15000.zip` }, provenance: { ...META.provenance, normalizedCount: 26000 } };
  const published = await harness.invoke({ methodId: "publish_request", inputs: [resultFrame({ ...RESULT, inserted: 26000 }), metaFrame(seedMeta)] });
  const mark = outputsByPort(published).get("mark");
  assert.equal(mark.STATE, irmLib.irmJobState.COMPLETE);
  assert.deepEqual(mark.TAGS, ["date:2026-08-15", "lane:seed"]);
  // and the plan reads that very record back as seeded: the next day is a delta, the same day a no-op
  const record = published.outputs.find((o) => o.portId === "mark").payload;
  const next = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(AUG15 + 86400000), ...markFrames([record])] }));
  assert.equal(next.get("request").url, `${BASE}modifications-2026-08-16.txt`);
  const same = await harness.invoke({ methodId: "ingest_plan", inputs: [tickFrame(AUG15), ...markFrames([record])] });
  assert.deepEqual([same.statusCode, same.outputs.length], [0, 0]);
});

test("SILENT NOP: inserted=0 for an edition that carried records advances NOTHING — not the mark, not the ETag", async (t) => {
  // What survives the refusal check is inserted=0, byte-identical to a day on which the gazetteer changed nothing.
  // Ledgering the ETag there would be the worse half: every later tick would no-op against places never stored.
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "publish_request", inputs: [resultFrame({ ...RESULT, inserted: 0 }), metaFrame(META)] });
  assert.equal(response.errorCode, "ingest-stored-nothing");
  assert.equal(response.outputs.length, 0, "no mark, so the next tick re-fetches this day");
});

test("a REFUSED batch advances nothing either", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "publish_request", inputs: [resultFrame({ ...RESULT, inserted: 0, refused: "refused: disk guardrail" }), metaFrame(META)] });
  assert.equal(response.errorCode, "ingest-refused");
  assert.match(response.errorMessage, /disk guardrail/);
  assert.equal(response.outputs.length, 0);
});

test("a genuinely empty edition still advances the mark", async (t) => {
  // inserted=0 with no records in is a real day on which nothing changed, and it must make progress or the lane stalls
  // on the first quiet day.
  const harness = await createHarness(t);
  const empty = { ...META, provenance: { ...META.provenance, normalizedCount: 0, schemaCounts: { "GNP.fbs": 0 } } };
  const mark = outputsByPort(await harness.invoke({ methodId: "publish_request", inputs: [resultFrame({ ...RESULT, inserted: 0 }), metaFrame(empty)] })).get("mark");
  assert.equal(mark.SOURCE.SOURCE_VERSION, "2026-08-15T00:00:00.000Z");
});

test("the epoch announce is fail-closed without a configured URL", async (t) => {
  const harness = await createHarness(t);
  const outputs = outputsByPort(await harness.invoke({ methodId: "publish_request", inputs: [resultFrame(RESULT), metaFrame(META)] }));
  assert.equal(outputs.get("request"), undefined, "absence of config is not permission to publish");
  assert.ok(outputs.get("mark"), "but the mark is NOT gated on publication");
});

test("the epoch announce POSTs the IngestResult naming the batch through the normal publication path", async (t) => {
  // No new record type is minted: DATASET_EPOCH and DATASET_CID already ride in $GNP.SOURCE on every stored record.
  const harness = await createHarness(t, { geonames_publish_url: PUBLISH_URL });
  const request = outputsByPort(await harness.invoke({ methodId: "publish_request", inputs: [resultFrame(RESULT), metaFrame(META)] })).get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.deepEqual(request.headers, { "content-type": "application/octet-stream" });
  assert.deepEqual(decodeIngestResult(request.body), { ...RESULT, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "", refused: "" });
});

test("publish_request requires BOTH the result and the meta frame, each of its type", async (t) => {
  // Both ports are declared required, so the SDK harness refuses the invocation before the guest is entered; the
  // guest's own refusals stand behind it for the composed flow runtime, which does not pre-validate.
  const harness = await createHarness(t);
  for (const inputs of [[resultFrame(RESULT)], [metaFrame(META)]]) {
    const response = await harness.invoke({ methodId: "publish_request", inputs });
    assert.equal(response.errorCode, "missing-required-input");
    assert.equal(response.outputs.length, 0, "nothing is announced from half an identity");
  }
  const wrong = await harness.invoke({ methodId: "publish_request", inputs: [{ ...resultFrame(RESULT), payload: metaFrame(META).payload }, metaFrame(META)] });
  assert.equal(wrong.errorCode, "invalid-result-frame");
});
