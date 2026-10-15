/*
 * Flow-level test for the compiled satnogs-ingest flow (satnogs-rf-ingest.flow.json) on the typed contracts (1.0) -
 * BRIDGE mode: the SAME runtime.wasm the Go host serves from its cron timer, in the JS flow runtime host (WasmEdge leg).
 * A TimerTick enters request and the request -> http -> parse -> storage-ingest chain runs linked-direct inside the
 * artifact's linear memory, every frame a FlatBuffer (HttpRequest / HttpResponse with the job - a size-prefixed
 * IngestRequest - in CONTEXT, IngestRequest + $RFB stream + the HttpResponse as the raw document, IngestResult,
 * FlowNotice); the only host crossings are the declared hostcalls, each an SDS $PIV invocation answered here as the Go
 * node answers it: plugin.getConfig (one ModuleConfig on raw "config"), http.request (HttpParams + raw url / headers; answered with the
 * real SatNOGS fixture, then 304) and storage.ingest_with_source (StorageIngestParams + raw records / archive + list
 * provenance).
 *
 * Data: the module's fixture cut from the LIVE SatNOGS DB transmitters table
 * (data-source/satnogs-source/tests/fixtures, PROVENANCE.md).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeIngestResult,
  encodeHostCallResult,
  encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

const decoder = new TextDecoder();
const RUNTIME = new URL("../dist/rf/runtime.wasm", import.meta.url);
const FIXTURE = fs.readFileSync(new URL("../../../data-source/satnogs-source/tests/fixtures/satnogs-transmitters.sample.json", import.meta.url));
const ROWS = JSON.parse(FIXTURE.toString("utf8"));
// one $RFB per link direction: a downlink and/or an uplink per transmitter row
const RECORDS = ROWS.filter((r) => r.uuid && r.downlink_low).length + ROWS.filter((r) => r.uuid && r.uplink_low).length;
const SOURCE_URL = "https://db.satnogs.org/api/transmitters/?format=json";
const CITATION = "SatNOGS DB, Libre Space Foundation, https://db.satnogs.org/ (CC BY-SA 4.0)";
const RETRIEVED_MS = Date.UTC(2026, 9, 13, 6, 0);
const LAST_MODIFIED = "Sun, 03 Aug 2026 00:00:00 GMT";

const headerLines = (bytes) => Object.fromEntries(decoder.decode(bytes ?? new Uint8Array(0)).split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));

// The host side of the typed hostcall: the module's SDS $PIV request decoded, answered with a $PIV response. `served`
// answers each http.request: { status, body, headers }.
function createHostStub(config, served) {
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
        const { status, body = "", headers = {} } = served(c);
        return answer({ ok: true, op: operation, result: { STATUS: status, RETRIEVED_MS: BigInt(RETRIEVED_MS) },
          raw: { url: c.url, headers: Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n"), body: Buffer.from(body) } });
      }
      if (operation === "storage.ingest_with_source") {
        const records = Buffer.from(call.raw.records);
        let count = 0;
        for (let off = 0; off < records.length;) { off += 4 + records.readUInt32LE(off); count++; }
        c.records = records;
        c.archive = call.raw.archive ? Buffer.from(call.raw.archive) : null;
        return answer({ ok: true, op: operation, result: { SCHEMA: call.params.SCHEMA, BATCH_ID: call.params.BATCH_ID, INSERTED: BigInt(count),
          ARCHIVED: c.archive ? `${call.params.ARCHIVE_SOURCE}/${call.params.ARCHIVE_NAME}` : "" } });
      }
      return answer({ ok: false, error: { code: "unsupported", message: `unexpected op ${operation}` } });
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { calls, imports, memoryRef };
}
// Egress frames by type: IngestResult (result), FlowNotice (notice).
function egressSink() {
  const egress = { results: [], notices: [], ports: [] };
  const handler = ({ frames }) => {
    for (const f of frames) {
      egress.ports.push(f.portId);
      const id = identifierOf(f.bytes);
      if (id === "INGR") egress.results.push(decodeIngestResult(f.bytes));
      else if (id === "FNTC") egress.notices.push(decodeFlowNotice(f.bytes));
      else assert.fail(`an egress frame that is no runtime type: "${id}"`);
    }
    return { statusCode: 0 };
  };
  return { egress, handlers: { "sdn.flow.egress:emit": handler } };
}
const tick = () => ({ portId: "tick", bytes: encodeTimerTick({ triggerId: "timer-satnogs-rf", scheduledMs: RETRIEVED_MS, firedMs: RETRIEVED_MS }) });
async function flowHost(stub) {
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(RUNTIME)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  return host;
}

test("timer tick -> one bulk GET -> one $RFB batch stored with its CC-BY-SA tags, provenance and archived document", async () => {
  const stub = createHostStub({}, () => ({ status: 200, body: FIXTURE, headers: { "Last-Modified": LAST_MODIFIED, ETag: '"s-1"', "Content-Type": "application/json" } }));
  const host = await flowHost(stub);
  const { egress, handlers } = egressSink();
  host.enqueueTriggerFrame(0, tick());
  await host.drain(handlers);

  assert.deepEqual(stub.calls.map((c) => c.operation), ["plugin.getConfig", "http.request", "plugin.getConfig", "storage.ingest_with_source"]);
  const [http] = stub.calls.filter((c) => c.operation === "http.request");
  assert.equal(http.url, SOURCE_URL);
  assert.equal(http.params.METHOD, "GET");
  assert.equal(http.params.TIMEOUT_MS, 120000);
  assert.deepEqual(Object.keys(http.headers).sort(), ["accept", "user-agent"], "anonymous: no credentials, no validators unless configured");
  assert.match(http.headers["user-agent"], /^SDN-CatalogEnrichmentBot\/0\.1 \(\+https:\/\//);

  const [ingest] = stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
  const p = ingest.params;
  const batch = createHash("sha256").update(FIXTURE).digest("hex");
  assert.deepEqual(
    [p.SCHEMA, p.PROVIDER_ID, p.SOURCE_NAME, p.BATCH_ID, p.SOURCE_URL, p.CONTENT_KEY_ID, p.SOURCE_PEER, p.LICENSE, p.LICENSE_URL, p.CITATION, p.SHARE_ALIKE, p.RECONCILE, p.ARCHIVE_SOURCE, p.ARCHIVE_NAME],
    ["RFB.fbs", "space-data-network-02", "satnogs-db", batch, SOURCE_URL, "public", "source:satnogs", "CC-BY-SA-4.0", "https://creativecommons.org/licenses/by-sa/4.0/", CITATION, true, 1, "satnogs", "transmitters.json"],
  );
  assert.deepEqual(ingest.archive, FIXTURE, "the fetched document archived byte for byte");
  let count = 0;
  for (let off = 0; off < ingest.records.length; count++) {
    const len = ingest.records.readUInt32LE(off);
    assert.equal(ingest.records.subarray(off + 8, off + 12).toString("latin1"), "$RFB");
    off += 4 + len;
  }
  assert.equal(count, RECORDS);
  assert.equal(ingest.lists.provenance.length, 1);
  const prov = ingest.lists.provenance[0];
  assert.deepEqual([prov.SOURCE_URL, prov.HTTP_STATUS, prov.ETAG, prov.LAST_MODIFIED, prov.CONTENT_TYPE, prov.PARSER, prov.PARSER_VERSION, prov.SOURCE_SHA256, Number(prov.NORMALIZED_COUNT)],
    [SOURCE_URL, 200, '"s-1"', LAST_MODIFIED, "application/json", "satnogs-source", "satnogs-rfb-wasm/v1", batch, RECORDS]);
  assert.equal(Number(prov.RETRIEVED_MS), RETRIEVED_MS);

  assert.deepEqual(egress.ports, ["result"]);
  assert.deepEqual(egress.results, [{ schema: "RFB.fbs", providerId: "space-data-network-02", sourceName: "satnogs-db", batchId: batch,
    inserted: RECORDS, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "satnogs/transmitters.json", refused: "" }]);
  assert.equal(egress.notices.length, 0);
});

test("HTTP 304 from SatNOGS: one Unchanged FlowNotice on egress, nothing stored", async () => {
  const stub = createHostStub({ satnogs_if_none_match: '"s-1"' }, (c) => {
    assert.equal(c.headers["if-none-match"], '"s-1"', "the configured validator is presented");
    return { status: 304 };
  });
  const host = await flowHost(stub);
  const { egress, handlers } = egressSink();
  host.enqueueTriggerFrame(0, tick());
  await host.drain(handlers);
  assert.deepEqual(stub.calls.map((c) => c.operation), ["plugin.getConfig", "http.request"]);
  assert.deepEqual(egress.ports, ["notice"]);
  assert.deepEqual(egress.notices, [{ kind: "unchanged", schema: "RFB.fbs", providerId: "space-data-network-02", sourceName: "satnogs-db",
    batchId: "", count: 0, reason: "not-modified", items: [SOURCE_URL], atMs: RETRIEVED_MS }]);
  assert.equal(egress.results.length, 0);
});

test("a failed fetch (HTTP 503) stores nothing and leaves no frame queued for the next cycle", async () => {
  let status = 503;
  const stub = createHostStub({}, () => (status === 503 ? { status } : { status, body: FIXTURE }));
  const host = await flowHost(stub);
  const { egress, handlers } = egressSink();
  host.enqueueTriggerFrame(0, tick());
  await host.drain(handlers).catch(() => {});
  assert.equal(stub.calls.filter((c) => c.operation === "storage.ingest_with_source").length, 0);
  assert.equal(egress.results.length, 0);
  // the next cycle stores exactly one batch
  status = 200;
  host.enqueueTriggerFrame(0, tick());
  await host.drain(handlers);
  assert.equal(stub.calls.filter((c) => c.operation === "storage.ingest_with_source").length, 1);
  assert.equal(egress.results.length, 1);
  assert.equal(egress.results[0].inserted, RECORDS);
});
