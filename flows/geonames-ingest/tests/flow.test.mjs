/*
 * Flow-level tests for the compiled geonames-ingest flow.
 *
 * These assert COMPUTABLE OUTCOMES only (owner law: no UI-wiring or
 * source-pattern tests). Every assertion here is a number, a URL or a byte
 * range that must hold for the ingest to be correct:
 *
 *   - which lane a tick runs, and which URLs that lane asks for,
 *   - the Range header bounded by the Go host's 4 MiB response-body cap,
 *   - the in-guest ZIP inflate on the seed edition,
 *   - the resolved admin/country NAMES $GNP requires, joined from the lookup
 *     fetches,
 *   - the record counts that actually reached storage.ingest_with_source,
 *   - reconcile=append and one batch id per edition,
 *   - the same-data ledger: a repeat day costs ZERO fetches, and an unchanged
 *     file costs ONE conditional request that 304s and stores nothing,
 *   - the inserted=0 refusal,
 *   - fail-closed publication.
 *
 * The SAME artifact the Go host would serve is instantiated in the JS flow
 * runtime host, with the host dialect the Go node speaks (base64 bodies,
 * {"ok":true,"result":{...}} envelopes).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLOW_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const FIXTURES = new URL(
  "../../../data-source/geonames-source/tests/fixtures/",
  import.meta.url,
);
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(name, FIXTURES)));

const BASE = "https://download.geonames.org/export/dump/";
const MODIFICATIONS = fixture("geonames-modifications.slice.txt");
const DELETES = fixture("geonames-deletes.slice.txt");
const ADMIN1 = fixture("admin1CodesASCII.slice.txt");
const ADMIN2 = fixture("admin2Codes.slice.txt");
const COUNTRY = fixture("countryInfo.slice.txt");
const PLACE_ROWS = MODIFICATIONS.toString("utf8").trimEnd().split("\n").length;

// A real ZIP around the fixture rows, so the SEED lane exercises the vendored
// in-guest inflate end to end rather than a stand-in.
function buildZip(name, contents) {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + deflated.length, 16);

  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd]);
}

const SEED_ZIP = buildZip("cities15000.txt", MODIFICATIONS);
const SEED_ETAG = '"3273cd-6590c8be06b08"';

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, s) => sum + 4 + s.length, 0);
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

// Serves the gazetteer as a real origin: it honours Range, answers a truthful
// Content-Range, publishes an ETag, and honours If-None-Match with a 304 —
// the four behaviours this lane's schedule and ledger depend on.
function createHostStub({ config = {}, mark = null, ingestResult, missingDeletes = false } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const bodies = new Map([
    [`${BASE}cities15000.zip`, { body: SEED_ZIP, etag: SEED_ETAG }],
    [`${BASE}admin1CodesASCII.txt`, { body: ADMIN1 }],
    [`${BASE}admin2Codes.txt`, { body: ADMIN2 }],
    [`${BASE}countryInfo.txt`, { body: COUNTRY }],
    [`${BASE}modifications-2026-08-15.txt`, { body: MODIFICATIONS, etag: '"76b6-mods"' }],
    [`${BASE}deletes-2026-08-15.txt`, { body: DELETES, etag: '"76b6-dels"' }],
  ]);

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

        // The resume mark comes back as the first SEGMENT of the query-stream
        // envelope, which is exactly what hostcap/flatsql-query forwards.
        if (operation === "storage.flatsql_query_stream") {
          response = encodeHostcallEnvelope(
            { ok: true, result: { rows: mark ? 1 : 0 } },
            mark ? [encoder.encode(JSON.stringify(mark))] : [],
          );
          return 0;
        }

        if (operation === "http.request") {
          const entry = bodies.get(meta.url);
          if (!entry || (missingDeletes && meta.url.includes("deletes-"))) {
            // GeoNames retains only the most recent day's deletes file and
            // answers 404 with an HTML body for anything older.
            response = encodeHostcallEnvelope({
              ok: true,
              result: {
                status: 404,
                headers: {},
                body: Buffer.from("<!DOCTYPE HTML>\n<title>404 Not Found</title>\n").toString("base64"),
                body_encoding: "base64",
              },
            });
            return 0;
          }
          const ifNoneMatch = meta.headers?.["If-None-Match"] ?? meta.headers?.["if-none-match"];
          if (ifNoneMatch && entry.etag && ifNoneMatch === entry.etag) {
            response = encodeHostcallEnvelope({
              ok: true,
              result: { status: 304, headers: { etag: entry.etag }, body: "", body_encoding: "base64" },
            });
            return 0;
          }
          const range = meta.headers?.Range ?? meta.headers?.range;
          const headers = entry.etag ? { etag: entry.etag } : {};
          if (!range) {
            response = encodeHostcallEnvelope({
              ok: true,
              result: {
                status: 200,
                headers: { ...headers, "content-length": String(entry.body.length) },
                body: Buffer.from(entry.body).toString("base64"),
                body_encoding: "base64",
              },
            });
            return 0;
          }
          const m = /bytes=(\d+)-(\d+)/.exec(range);
          const start = Number(m[1]);
          const end = Math.min(Number(m[2]), entry.body.length - 1);
          response = encodeHostcallEnvelope({
            ok: true,
            result: {
              status: 206,
              headers: {
                ...headers,
                "content-range": `bytes ${start}-${end}/${entry.body.length}`,
              },
              body: Buffer.from(entry.body).subarray(start, end + 1).toString("base64"),
              body_encoding: "base64",
            },
          });
          return 0;
        }

        if (operation === "storage.ingest_with_source") {
          const recordsRef = meta.records?.$bin ?? 0;
          const records = Buffer.from(segments[recordsRef]);
          let count = 0;
          for (let off = 0; off + 4 <= records.length; ) {
            const len = records.readUInt32LE(off);
            off += 4 + len;
            count++;
          }
          response = encodeHostcallEnvelope({
            ok: true,
            result: ingestResult
              ? ingestResult(meta, count)
              : { schema: meta.schema, inserted: count, batch_id: meta.batch_id },
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

async function runFlowOnce(stub, firedAt = "2026-08-15T00:00:00Z") {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(FLOW_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;

  const emitted = [];
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt })),
  });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) emitted.push(decoder.decode(frame.bytes));
      return { statusCode: 0 };
    },
  });
  return emitted;
}

const httpCalls = (stub) => stub.calls.filter((c) => c.operation === "http.request");
const ingestCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const fetchedUrls = (stub) => httpCalls(stub).map((c) => c.meta.url);
const parsed = (emitted) =>
  emitted
    .map((t) => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const markOf = (emitted) => parsed(emitted).find((v) => v && typeof v.seeded === "boolean");

const SEEDED_MARK = {
  dataset_id: "geonames",
  lane: "delta",
  seeded: true,
  dataset_epoch: "2026-08-14T00:00:00.000Z",
  delta_date: "2026-08-14",
  etag: '"76b6-yesterday"',
  last_modified: "Fri, 14 Aug 2026 02:18:01 GMT",
  batch_id: "geonames@2026-08-14",
  records: 12,
};

function storedRecords(call) {
  const recordsRef = call.meta.records?.$bin ?? 0;
  const records = Buffer.from(call.segments[recordsRef]);
  const out = [];
  for (let off = 0; off + 4 <= records.length; ) {
    const len = records.readUInt32LE(off);
    off += 4;
    out.push(records.subarray(off, off + len));
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// the SEED lane
// ---------------------------------------------------------------------------

test("the first tick seeds: the archive is fetched RANGED and inflated in-guest", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);

  const urls = fetchedUrls(stub);
  assert.ok(urls.includes(`${BASE}cities15000.zip`), "the seed archive is fetched");
  const seedCall = httpCalls(stub).find((c) => c.meta.url.endsWith("cities15000.zip"));
  // The Go host caps a response body at 4 MiB; a larger ask is truncated by the
  // host and inflates to a plausible short gazetteer with no error anywhere.
  assert.equal(seedCall.meta.headers.Range, `bytes=0-${4 * 1024 * 1024 - 1}`);

  const stores = ingestCalls(stub);
  assert.equal(stores.length, 1, "one tick, one store");
  assert.equal(
    storedRecords(stores[0]).length,
    PLACE_ROWS,
    "every row inside the ZIP reached storage, which proves the in-guest inflate ran",
  );
});

test("the seed fetches all three lookup files and nothing else", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  const urls = fetchedUrls(stub).sort();
  assert.deepEqual(urls, [
    `${BASE}admin1CodesASCII.txt`,
    `${BASE}admin2Codes.txt`,
    `${BASE}cities15000.zip`,
    `${BASE}countryInfo.txt`,
  ]);
  // A seed edition IS the gazetteer's current state, so there is nothing to
  // tombstone and no deletes fetch is planned.
  assert.ok(!urls.some((u) => u.includes("deletes-")));
});

test("the stored records carry the RESOLVED names the join produced, not just codes", async () => {
  // $GNP: "Carried beside the code so a consumer need not hold the division
  // tables to render a place." The country table is fetched in the same tick and
  // joined in-guest, so this is end-to-end evidence that the join happened.
  const stub = createHostStub();
  await runFlowOnce(stub);
  const record = storedRecords(ingestCalls(stub)[0])[0];
  // The file identifier lives at bytes 4..8 of a FlatBuffer root; getting it
  // wrong is how a stream reaches storage and is routed to the wrong table.
  assert.equal(record.subarray(4, 8).toString("latin1"), "$GNP");
  const text = record.toString("utf8");
  assert.ok(text.includes("Argentina"), "COUNTRY_NAME resolved from countryInfo.txt");
  assert.ok(text.includes("geonames:"), "the publisher-stable ID is minted and prefixed");
  assert.ok(text.includes("CC BY 4.0"), "the licence rides on every record");
});

test("storage attribution: $GNP, append reconcile, one batch id per edition", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  const meta = ingestCalls(stub)[0].meta;
  assert.equal(meta.schema, "GNP");
  assert.equal(meta.provider_id, "geonames");
  assert.equal(meta.source_name, "geonames-gazetteer");
  // NOT a source-batch reconcile: a daily modifications file is an upsert of a
  // few thousand rows and reconciling on it would delete the rest of the world.
  assert.equal(meta.reconcile, "append");
  assert.equal(meta.batch_id, "geonames@2026-08-15");
  assert.equal(meta.dataset_epoch, "2026-08-15T00:00:00.000Z");
});

test("the mark that comes out of a seed marks the dataset SEEDED and ledgers the ETag", async () => {
  const stub = createHostStub();
  const mark = markOf(await runFlowOnce(stub));
  assert.ok(mark, "publish_request emitted the advanced mark");
  assert.equal(mark.seeded, true);
  assert.equal(mark.lane, "seed");
  assert.equal(mark.delta_date, "2026-08-15");
  assert.equal(mark.etag, SEED_ETAG, "the mark IS the same-data ledger");
  assert.equal(mark.records, PLACE_ROWS);
});

// ---------------------------------------------------------------------------
// the DELTA lane
// ---------------------------------------------------------------------------

test("a seeded mark makes the tick a DELTA: modifications + deletes, no lookups", async () => {
  const stub = createHostStub({ mark: SEEDED_MARK });
  const emitted = await runFlowOnce(stub);

  const urls = fetchedUrls(stub).sort();
  assert.deepEqual(urls, [
    `${BASE}deletes-2026-08-15.txt`,
    `${BASE}modifications-2026-08-15.txt`,
  ]);

  // The daily modifications file is a file of FULL geoname rows (verified live
  // 2026-08-15), so it upserts through the SAME decoder as the seed.
  const stores = ingestCalls(stub);
  assert.equal(stores.length, 1);
  assert.equal(storedRecords(stores[0]).length, PLACE_ROWS);
  assert.equal(stores[0].meta.lane, "delta");
  assert.equal(stores[0].meta.batch_id, "geonames@2026-08-15");

  // The tombstones leave the flow on egress: no host capability removes a stored
  // row, and inventing one would be a new host capability this lane may not add.
  const tombstones = parsed(emitted).find((v) => v && v.lane === "deletes");
  assert.ok(tombstones, "the tombstone list reached egress");
  assert.equal(tombstones.tombstones, 1);
  assert.deepEqual(tombstones.entries[0], {
    native_id: "793657",
    id: "geonames:793657",
    name: "Malynivka",
    reason: "duplicate",
  });
});

test("a missing deletes file does not stop the day's places from being stored", async () => {
  // GeoNames retains only the most recent day's deletes file; every older date
  // 404s with an HTML body. The places lane must be unaffected.
  const stub = createHostStub({ mark: SEEDED_MARK, missingDeletes: true });
  const emitted = await runFlowOnce(stub);
  assert.equal(ingestCalls(stub).length, 1, "the modifications still reached storage");
  assert.equal(storedRecords(ingestCalls(stub)[0]).length, PLACE_ROWS);
  const tombstones = parsed(emitted).find((v) => v && v.lane === "deletes");
  assert.equal(tombstones, undefined, "nothing is tombstoned from a 404 body");
});

// ---------------------------------------------------------------------------
// the SAME-DATA LEDGER
// ---------------------------------------------------------------------------

test("a tick for a day already on the mark costs ZERO fetches", async () => {
  const stub = createHostStub({
    mark: { ...SEEDED_MARK, delta_date: "2026-08-15" },
  });
  await runFlowOnce(stub, "2026-08-15T00:00:00Z");
  assert.deepEqual(fetchedUrls(stub), [], "the cheapest possible no-op");
  assert.deepEqual(ingestCalls(stub), []);
});

test("an unchanged file costs ONE conditional request, 304s, and stores nothing", async () => {
  // The mark's ETag rides out as If-None-Match. A 304 is the ledger paying off,
  // not a failure: the run ends without storing identical rows again.
  const stub = createHostStub({
    mark: { ...SEEDED_MARK, delta_date: "2026-08-14", etag: '"76b6-mods"' },
  });
  const emitted = await runFlowOnce(stub);

  const modsCall = httpCalls(stub).find((c) => c.meta.url.includes("modifications-"));
  assert.equal(modsCall.meta.headers["If-None-Match"], '"76b6-mods"');
  assert.deepEqual(ingestCalls(stub), [], "nothing is re-stored");
  assert.equal(markOf(emitted), undefined, "and no mark advances over a store that never happened");
  const report = parsed(emitted).find((v) => v && v.ledgeredNoOp === true);
  assert.ok(report, "the no-op is OBSERVABLE, not indistinguishable from a flow that never fired");
  assert.equal(report.status, 304);
});

// ---------------------------------------------------------------------------
// failure modes
// ---------------------------------------------------------------------------

test("SILENT NOP: ok-with-inserted-0 stops the run and does NOT advance the mark", async () => {
  // The disk-floor refusal that hostcap/storage-ingest's own ok:false check does
  // not catch. Byte-identical to a day the gazetteer did not change, so it is
  // only detectable against the count the tick actually produced.
  const stub = createHostStub({
    ingestResult: (meta) => ({ schema: meta.schema, inserted: 0, batch_id: meta.batch_id }),
  });
  const emitted = await runFlowOnce(stub);
  assert.equal(markOf(emitted), undefined, "no mark, so the next tick re-fetches this edition");
});

test("publication is fail-closed without a configured URL", async () => {
  const stub = createHostStub();
  await runFlowOnce(stub);
  assert.deepEqual(
    httpCalls(stub).filter((c) => c.meta.method === "POST"),
    [],
    "absence of configuration is not permission to publish",
  );
});

test("the epoch announce POSTs the batch identity when a URL IS configured", async () => {
  const publishURL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
  const stub = createHostStub({ config: { geonames_publish_url: publishURL } });
  await runFlowOnce(stub);
  const posts = httpCalls(stub).filter((c) => c.meta.method === "POST");
  assert.equal(posts.length, 1);
  const bodyRef = posts[0].meta.body?.$bin ?? 0;
  const body = JSON.parse(Buffer.from(posts[0].segments[bodyRef]).toString("utf8"));
  assert.equal(body.schema, "GNP");
  assert.equal(body.providerId, "geonames");
  assert.equal(body.batchId, "geonames@2026-08-15");
});
