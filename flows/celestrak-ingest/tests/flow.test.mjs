/*
 * Flow-level tests for the compiled celestrak-ingest flows on the typed contracts (1.0) - BRIDGE mode. The SAME
 * runtime.wasm artifacts the Go host serves from cron timers are instantiated in the JS flow runtime host here: a
 * TimerTick enters the request-builder node and the whole fetch -> parse -> ingest -> publish chain runs linked-direct
 * inside the artifact's linear memory, every frame a FlatBuffer (HttpRequest / HttpResponse with the job's $ICN in
 * CONTEXT, IngestRequest + SDS record stream + raw HttpResponse, IngestResult, FlowNotice). The only host crossings are
 * the declared hostcalls, each an SDS $PIV invocation answered here as the Go node answers it: plugin.getConfig
 * (one ModuleConfig on raw "config"), http.request (HttpParams + raw url / headers / body, answered HttpResult + raw headers /
 * body) and storage.ingest_with_source (StorageIngestParams + raw records / archive + list provenance).
 *
 * Data: the CelesTrak payloads the sdn-server internal/ingest tests use (data-source/celestrak-parser/tests/fixtures).
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
  encodeHostCallResult,
  encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

const decoder = new TextDecoder();
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const OMM_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/OMM/main.js"));
const flatbuffers = createRequire(OMM_LIB)("flatbuffers");
const { CelestialFrame, CelestialFrameWrapper, OMM, RFMUnion } = await import(OMM_LIB.href);

const GP_WASM = new URL("../dist/gp/runtime.wasm", import.meta.url);
const SATCAT_WASM = new URL("../dist/satcat/runtime.wasm", import.meta.url);
const SPW_WASM = new URL("../dist/spw/runtime.wasm", import.meta.url);
const EOP_WASM = new URL("../dist/eop/runtime.wasm", import.meta.url);
const SOCRATES_WASM = new URL("../dist/socrates/runtime.wasm", import.meta.url);

const FIXTURES = new URL("../../../data-source/celestrak-parser/tests/fixtures/", import.meta.url);
const GP_CSV = fs.readFileSync(new URL("celestrak-gp-omm.csv", FIXTURES));
const SATCAT_TXT = fs.readFileSync(new URL("celestrak-satcat.txt", FIXTURES));
const SATCAT_CSV = fs.readFileSync(new URL("celestrak-satcat.csv", FIXTURES));
const SW_CSV = fs.readFileSync(new URL("celestrak-sw-all.csv", FIXTURES));
const EOP_CSV = fs.readFileSync(new URL("celestrak-eop-all.csv", FIXTURES));
const SOCRATES_CSV = fs.readFileSync(new URL("celestrak-socrates-minrange.csv", FIXTURES));

const GP_URL = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv";
const EOP_URL = "https://celestrak.org/SpaceData/EOP-All.csv";
const LICENSE_REF = "LicenseRef-CelesTrak-Usage-Policy";
const LICENSE_URL = "https://celestrak.org/usage-policy.php";
const RECONCILE = { duplicates: 0, none: 1, current: 2 };
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const headerLines = (bytes) =>
  Object.fromEntries(decoder.decode(bytes ?? new Uint8Array(0)).split(/\r?\n/).filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
const headerBlock = (headers) => Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\r\n");

// The host side of the typed hostcall: the module's SDS $PIV request decoded, answered with a $PIV response. `fetches`
// is keyed by URL: {status, headers, body}; an unknown URL answers 404.
function createHostStub({ fetches = {}, config = {} }) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (r) => { response = encodeHostCallResult(r); return 0; };
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const heap = new Uint8Array(memoryRef.memory.buffer);
      const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
      const call = decodeHostCall(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
      assert.equal(call.op, operation);
      const c = { operation, params: call.params, lists: call.lists, raw: call.raw };
      calls.push(c);
      if (operation === "plugin.getConfig") return answer({ ok: true, op: operation, raw: { config: encodeModuleConfig(config) } });
      if (operation === "http.request") {
        c.url = decoder.decode(call.raw.url);
        c.headers = headerLines(call.raw.headers);
        const spec = fetches[c.url] ?? { status: 404, body: "" };
        return answer({ ok: true, op: operation, result: { STATUS: spec.status ?? 200, RETRIEVED_MS: BigInt(Date.UTC(2026, 6, 4)) },
          raw: { url: "", headers: headerBlock(spec.headers), body: Buffer.from(spec.body ?? "") } });
      }
      if (operation === "storage.ingest_with_source") {
        const records = Buffer.from(call.raw.records);
        let count = 0;
        for (let off = 0; off < records.length;) { off += 4 + records.readUInt32LE(off); count++; }
        c.records = records;
        c.archive = call.raw.archive ? Buffer.from(call.raw.archive) : null;
        return answer({ ok: true, op: operation, result: { SCHEMA: call.params.SCHEMA, BATCH_ID: call.params.BATCH_ID, INSERTED: BigInt(count) } });
      }
      return answer({ ok: false, error: { code: "unsupported", message: `unexpected op ${operation}` } });
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { calls, imports, memoryRef };
}

// Runs one timer tick through the flow; the egress frames sorted by type (each port carries exactly one).
async function runFlowOnce(wasmURL, stub) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmURL))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const egress = { results: [], notices: [], publications: [] };
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encodeTimerTick({ triggerId: "timer", firedMs: Date.UTC(2026, 6, 4) }) });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const f of frames) {
        const id = identifierOf(f.bytes);
        if (id === "INGR") { assert.equal(f.portId, "result"); egress.results.push(decodeIngestResult(f.bytes)); }
        else if (id === "FNTC") { assert.equal(f.portId, "notice"); egress.notices.push(decodeFlowNotice(f.bytes)); }
        else if (id === "HRSP") { assert.equal(f.portId, "publication"); egress.publications.push(decodeHttpResponse(f.bytes)); }
        else assert.fail(`an egress frame that is no runtime type: "${id}"`);
      }
      return { statusCode: 0 };
    },
  });
  return egress;
}

const ingestCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const fetchCalls = (stub, url) => stub.calls.filter((c) => c.operation === "http.request" && c.url === url);

// §19 dataset-publication trigger: the loopback URL arrives as node CONFIG, and with no URL the flow publishes NOTHING.
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
const PUBLISH_FETCH = { status: 202, body: "" };
// The publication POSTs the flow drove through hostcap/http-request: each body one IngestResult naming the batch.
function publications(stub) {
  return stub.calls.filter((c) => c.operation === "http.request" && c.url === PUBLISH_URL).map((c) => {
    assert.equal(c.params.METHOD, "POST");
    assert.equal(c.headers["content-type"], "application/octet-stream");
    return decodeIngestResult(c.raw.body);
  });
}

function splitStream(payload) {
  const records = [];
  for (let off = 0; off < payload.length;) {
    const len = payload.readUInt32LE(off);
    assert.ok(len > 0 && off + 4 + len <= payload.length, "invalid record length");
    records.push(payload.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return records;
}

test("celestrak-gp-ingest: timer tick -> fetch -> parse -> two attributed ingests (the payload archived once)", async () => {
  const stub = createHostStub({ fetches: { [GP_URL]: { body: GP_CSV } } });
  const egress = await runFlowOnce(GP_WASM, stub);

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "OMM + MPE batches");
  const bySchema = new Map(ingests.map((c) => [c.params.SCHEMA, c]));
  const omm = bySchema.get("OMM.fbs");
  assert.ok(omm, "OMM ingest fired");
  assert.deepEqual(
    [omm.params.PROVIDER_ID, omm.params.SOURCE_NAME, omm.params.BATCH_ID, omm.params.SOURCE_URL, omm.params.CONTENT_KEY_ID, omm.params.SOURCE_PEER],
    ["space-data-network-02", "celestrak-gp", sha256Hex(GP_CSV), GP_URL, "public", "source:celestrak"],
  );
  assert.equal(omm.params.RECONCILE, RECONCILE.duplicates);
  assert.deepEqual([omm.params.ARCHIVE_SOURCE, omm.params.ARCHIVE_NAME], ["celestrak", "catalog.csv"]);
  assert.deepEqual(omm.archive, Buffer.from(GP_CSV), "raw archive bytes = the fetched payload");
  assert.equal(omm.lists.provenance.length, 1);
  const p = omm.lists.provenance[0];
  assert.deepEqual([p.SOURCE_URL, p.HTTP_STATUS, p.SOURCE_SHA256, Number(p.NORMALIZED_COUNT)], [GP_URL, 200, sha256Hex(GP_CSV), 4]);
  const mpe = bySchema.get("MPE.fbs");
  assert.ok(mpe, "MPE ingest fired");
  assert.equal(mpe.params.ARCHIVE_NAME ?? "", "", "payload archived once");
  assert.equal(mpe.archive, null);

  assert.equal(egress.results.length, 2, "two IngestResults reached the egress sink");
  for (const r of egress.results) assert.equal(r.inserted, 2, "fixture has 2 objects");
  assert.deepEqual(egress.notices, []);
});

test("celestrak-gp-ingest: NO publish POST is made without celestrak_publish_url", async () => {
  const stub = createHostStub({ fetches: { [GP_URL]: { body: GP_CSV } } });
  await runFlowOnce(GP_WASM, stub);
  assert.equal(ingestCalls(stub).length, 2, "the stores still happen");
  assert.deepEqual(publications(stub), [], "absence of config is not permission to publish");
});

test("celestrak-gp-ingest: each stored batch triggers its own dataset publication", async () => {
  const stub = createHostStub({ config: { celestrak_publish_url: PUBLISH_URL }, fetches: { [GP_URL]: { body: GP_CSV }, [PUBLISH_URL]: PUBLISH_FETCH } });
  const egress = await runFlowOnce(GP_WASM, stub);
  const bodies = publications(stub).sort((a, b) => a.schema.localeCompare(b.schema));
  assert.deepEqual(bodies.map((b) => b.schema), ["MPE.fbs", "OMM.fbs"], "OMM + MPE batches each publish");
  for (const body of bodies) {
    assert.equal(body.providerId, "space-data-network-02");
    assert.equal(body.sourceName, "celestrak-gp");
    assert.equal(body.batchId, sha256Hex(GP_CSV));
    assert.equal(body.inserted, 2);
  }
  // 2 ingest results + 2 publication responses reach the egress sink.
  assert.equal(egress.results.length, 2);
  assert.deepEqual(egress.publications.map((r) => r.status), [202, 202]);
});

test("celestrak-gp-ingest: never asks the host to query while ingesting and publishing", async () => {
  const stub = createHostStub({
    config: {
      celestrak_publish_url: PUBLISH_URL,
      // Retained operator configuration must not restore the removed host query branch.
      celestrak_cache_sql: "SELECT data FROM sds_omm ORDER BY rowid DESC LIMIT ?",
      celestrak_cache_max_rows: 2,
    },
    fetches: { [GP_URL]: { body: GP_CSV }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  const egress = await runFlowOnce(GP_WASM, stub);
  assert.equal(ingestCalls(stub).length, 2, "OMM and MPE still ingest");
  assert.equal(publications(stub).length, 2, "both stored batches still publish");
  assert.equal(egress.results.length + egress.publications.length, 4, "both ingests and publications reach egress");
  assert.deepEqual([...new Set(stub.calls.map((c) => c.operation))].sort(), ["http.request", "plugin.getConfig", "storage.ingest_with_source"]);
});

// CelesTrak GP data are SGP4 mean elements in TEME of date (CelesTrak's own OMM KVN/XML states REF_FRAME = TEME). Read
// here through the SDS JavaScript bindings (SDS RFM CelestialFrame.TEMEOFDATE, SANA OID 1.3.112.4.57.2.25).
test("celestrak-gp-ingest: every stored OMM declares CENTER_NAME EARTH and REFERENCE_FRAME TEME of date", async () => {
  const stub = createHostStub({ fetches: { [GP_URL]: { body: GP_CSV } } });
  await runFlowOnce(GP_WASM, stub);
  const omm = ingestCalls(stub).find((c) => c.params.SCHEMA === "OMM.fbs");
  const records = splitStream(omm.records);
  const expected = [{ norad: 25544, name: "ISS (ZARYA)" }, { norad: 40909, name: "STARLINK-1001" }];
  assert.equal(records.length, expected.length);
  records.forEach((record, index) => {
    const decoded = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(Uint8Array.from(record)));
    assert.equal(decoded.NORAD_CAT_ID(), expected[index].norad);
    assert.equal(decoded.OBJECT_NAME(), expected[index].name);
    assert.equal(decoded.CENTER_NAME(), "EARTH");
    const frame = decoded.REFERENCE_FRAME();
    assert.ok(frame, `NORAD ${expected[index].norad}: REFERENCE_FRAME must be present`);
    assert.equal(frame.REFERENCE_FRAME_type(), RFMUnion.CelestialFrameWrapper);
    assert.equal(CelestialFrame[frame.REFERENCE_FRAME(new CelestialFrameWrapper()).frame()], "TEMEOFDATE");
  });
});

test("celestrak-gp-ingest: the fetch carries the lane byte budget and no headers; the meta carries the usage terms", async () => {
  const stub = createHostStub({ fetches: { [GP_URL]: { body: GP_CSV } } });
  await runFlowOnce(GP_WASM, stub);
  const [fetch] = fetchCalls(stub, GP_URL);
  assert.ok(fetch, "one GP fetch");
  assert.equal(Number(fetch.params.MAX_BYTES), 67108864, "64 MiB budget forwarded as MAX_BYTES");
  assert.equal(fetch.params.TIMEOUT_MS, 90000);
  assert.deepEqual(fetch.headers, {}, "no request headers: the host adds its recorded validators");
  const omm = ingestCalls(stub).find((c) => c.params.SCHEMA === "OMM.fbs");
  // the usage-policy sentence is no licence identifier: SourceTags carry the LicenseRef and the policy URL
  assert.equal(omm.params.LICENSE, LICENSE_REF);
  assert.equal(omm.params.LICENSE_URL, LICENSE_URL);
  assert.ok(omm.params.CITATION.length > 0);
});

test("celestrak-satcat-ingest: one tick fans out to BOTH satcat sources", async () => {
  const stub = createHostStub({
    fetches: { "https://celestrak.org/pub/satcat.txt": { body: SATCAT_TXT }, "https://celestrak.org/pub/satcat.csv": { body: SATCAT_CSV } },
  });
  const egress = await runFlowOnce(SATCAT_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "txt + csv batches");
  assert.deepEqual(ingests.map((c) => c.params.SOURCE_NAME).sort(), ["celestrak-satcat", "celestrak-satcat-csv"]);
  for (const c of ingests) {
    assert.equal(c.params.SCHEMA, "CAT.fbs");
    assert.equal(c.params.RECONCILE, RECONCILE.current, "snapshot source keeps only the newest batch");
  }
  assert.deepEqual(ingests.map((c) => c.params.ARCHIVE_NAME).sort(), ["satcat.csv", "satcat.txt"]);
  assert.equal(egress.results.length, 2);
});

test("celestrak-satcat-ingest: both snapshot lanes publish their own batch", async () => {
  const stub = createHostStub({
    config: { celestrak_publish_url: PUBLISH_URL },
    fetches: { "https://celestrak.org/pub/satcat.txt": { body: SATCAT_TXT }, "https://celestrak.org/pub/satcat.csv": { body: SATCAT_CSV }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  await runFlowOnce(SATCAT_WASM, stub);
  const bodies = publications(stub);
  assert.deepEqual(bodies.map((b) => b.sourceName).sort(), ["celestrak-satcat", "celestrak-satcat-csv"]);
  for (const body of bodies) assert.equal(body.schema, "CAT.fbs");
  assert.equal(bodies.find((b) => b.sourceName === "celestrak-satcat").batchId, sha256Hex(SATCAT_TXT));
  assert.equal(bodies.find((b) => b.sourceName === "celestrak-satcat-csv").batchId, sha256Hex(SATCAT_CSV));
});

test("celestrak-spw-ingest: fresh source ingests; config URL override reaches the fetch", async () => {
  const overrideURL = "https://fixtures.test/SW-All.csv";
  const stub = createHostStub({
    config: { celestrak_space_weather_url: overrideURL },
    // the Go host answers net/http canonical names; the connector lower-cases them
    fetches: { [overrideURL]: { body: SW_CSV, headers: { "Last-Modified": "Fri, 02 Jan 2026 12:00:00 GMT" } } },
  });
  const egress = await runFlowOnce(SPW_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].params.SCHEMA, "SPW.fbs");
  assert.equal(ingests[0].params.SOURCE_NAME, "celestrak-space-weather");
  assert.equal(ingests[0].params.SOURCE_URL, overrideURL, "node CONFIG override drove the fetch");
  // SW-All.csv is a whole-history snapshot: every batch supersedes the older ones.
  assert.equal(ingests[0].params.RECONCILE, RECONCILE.current);
  assert.equal(ingests[0].params.ARCHIVE_NAME, "SW-All.csv");
  assert.equal(ingests[0].lists.provenance[0].LAST_MODIFIED, "Fri, 02 Jan 2026 12:00:00 GMT");
  assert.equal(egress.results.length, 1);
  assert.equal(egress.results[0].inserted, 2);
});

test("celestrak-spw-ingest: the stored space-weather batch publishes", async () => {
  const overrideURL = "https://fixtures.test/SW-All.csv";
  const stub = createHostStub({
    config: { celestrak_space_weather_url: overrideURL, celestrak_publish_url: PUBLISH_URL },
    fetches: { [overrideURL]: { body: SW_CSV, headers: { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" } }, [PUBLISH_URL]: PUBLISH_FETCH },
  });
  await runFlowOnce(SPW_WASM, stub);
  const bodies = publications(stub);
  assert.equal(bodies.length, 1);
  assert.deepEqual(
    [bodies[0].schema, bodies[0].providerId, bodies[0].sourceName, bodies[0].batchId],
    ["SPW.fbs", "space-data-network-02", "celestrak-space-weather", sha256Hex(SW_CSV)],
  );
});

test("celestrak-spw-ingest: the stale-source gate stops the batch and the publication", async () => {
  const spwURL = "https://celestrak.org/SpaceData/SW-All.csv";
  // No Last-Modified: the in-wasm reference falls back to NOW, far past the fixture's 2026-01-02 latest DATE -> the
  // parse node errors, nothing is persisted.
  const stub = createHostStub({ config: { celestrak_publish_url: PUBLISH_URL }, fetches: { [spwURL]: { body: SW_CSV }, [PUBLISH_URL]: PUBLISH_FETCH } });
  let egress = null;
  try {
    egress = await runFlowOnce(SPW_WASM, stub);
  } catch {
    // the parse node errors on the stale gate; either way nothing may be stored or published
  }
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall after the stale gate");
  assert.deepEqual(publications(stub), [], "nothing stored, nothing published");
  if (egress) assert.deepEqual(egress.results, [], "no results reach the egress sink");
});

test("celestrak-eop-ingest: tick -> EOP-All fetch (budget, no headers) -> one attributed $EOP ingest", async () => {
  const stub = createHostStub({
    fetches: { [EOP_URL]: { body: EOP_CSV, headers: { "Last-Modified": "Tue, 01 Sep 2026 12:00:00 GMT", Etag: '"154cec7daf3bdd1:0"' } } },
  });
  const egress = await runFlowOnce(EOP_WASM, stub);

  const [fetch] = fetchCalls(stub, EOP_URL);
  assert.ok(fetch, "one EOP fetch");
  assert.equal(Number(fetch.params.MAX_BYTES), 4194304, "4 MiB budget forwarded as MAX_BYTES");
  assert.deepEqual(fetch.headers, {}, "headers-free: validators are the host's");

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  const [ingest] = ingests;
  assert.deepEqual(
    [ingest.params.SCHEMA, ingest.params.PROVIDER_ID, ingest.params.SOURCE_NAME, ingest.params.BATCH_ID, ingest.params.RECONCILE],
    ["EOP.fbs", "space-data-network-02", "celestrak-eop", sha256Hex(EOP_CSV), RECONCILE.current],
  );
  assert.equal(ingest.params.LICENSE_URL, LICENSE_URL);
  assert.deepEqual([ingest.params.ARCHIVE_SOURCE, ingest.params.ARCHIVE_NAME], ["celestrak", "EOP-All.csv"]);
  const p = ingest.lists.provenance[0];
  assert.deepEqual([p.ETAG, p.LAST_MODIFIED], ['"154cec7daf3bdd1:0"', "Tue, 01 Sep 2026 12:00:00 GMT"], "validators reach the provenance");
  const records = splitStream(ingest.records);
  assert.equal(records.length, 3, "fixture has 3 rows");
  for (const r of records) assert.equal(Buffer.from(r.subarray(4, 8)).toString("latin1"), "$EOP");
  assert.deepEqual(ingest.archive, Buffer.from(EOP_CSV), "raw archive bytes");
  assert.equal(egress.results.length, 1);
  assert.equal(egress.results[0].inserted, 3);
});

test("celestrak-eop-ingest: HTTP 304 stores nothing and reports one unchanged notice", async () => {
  const stub = createHostStub({ fetches: { [EOP_URL]: { status: 304, body: "", headers: { Etag: '"154cec7daf3bdd1:0"' } } } });
  const egress = await runFlowOnce(EOP_WASM, stub);
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall on 304");
  assert.deepEqual(publications(stub), [], "nothing stored, nothing published");
  assert.deepEqual(egress.results, []);
  assert.deepEqual(egress.notices, [{
    kind: "unchanged", schema: "EOP.fbs", providerId: "space-data-network-02", sourceName: "celestrak-eop", batchId: "",
    count: 1, reason: "not-modified", items: [EOP_URL], atMs: 0,
  }]);
});

test("celestrak-socrates-ingest: one tick fans out to BOTH sort files as their own $CSM lanes", async () => {
  const minRangeURL = "https://celestrak.org/SOCRATES/sort-minRange.csv";
  const maxProbURL = "https://celestrak.org/SOCRATES/sort-maxProb.csv";
  const stub = createHostStub({ fetches: { [minRangeURL]: { body: SOCRATES_CSV }, [maxProbURL]: { body: SOCRATES_CSV } } });
  const egress = await runFlowOnce(SOCRATES_WASM, stub);
  for (const url of [minRangeURL, maxProbURL]) {
    const [fetch] = fetchCalls(stub, url);
    assert.ok(fetch, `fetch for ${url}`);
    assert.equal(Number(fetch.params.MAX_BYTES), 8388608, "8 MiB budget forwarded as MAX_BYTES");
    assert.deepEqual(fetch.headers, {});
  }
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "minRange + maxProb batches");
  assert.deepEqual(ingests.map((c) => c.params.SOURCE_NAME).sort(), ["celestrak-socrates-maxprob", "celestrak-socrates-minrange"]);
  assert.deepEqual(ingests.map((c) => c.params.ARCHIVE_NAME).sort(), ["sort-maxProb.csv", "sort-minRange.csv"]);
  for (const c of ingests) {
    assert.equal(c.params.SCHEMA, "CSM.fbs");
    assert.equal(c.params.RECONCILE, RECONCILE.current, "each sort file is a snapshot");
    assert.equal(c.params.BATCH_ID, sha256Hex(SOCRATES_CSV));
    assert.equal(c.params.LICENSE_URL, LICENSE_URL);
    assert.equal(Buffer.from(c.records.subarray(8, 12)).toString("latin1"), "$CSM");
  }
  assert.equal(egress.results.length, 2);
  for (const r of egress.results) assert.equal(r.inserted, 2);
});
