/*
 * Flow-level tests for the compiled celestrak-reference flows on the typed contracts (1.0) - BRIDGE mode. The SAME
 * runtime.wasm artifacts the Go host serves from cron timers are instantiated in the JS flow runtime host here: a
 * TimerTick enters the request-builder node and the whole fetch -> parse -> ingest chain runs linked-direct inside the
 * artifact's linear memory, every frame a FlatBuffer (HttpRequest / HttpResponse with the job's $ICN in CONTEXT,
 * IngestRequest + SDS record stream + raw HttpResponse, IngestResult, FlowNotice). The only host crossings are the
 * declared hostcalls, each an SDS $PIV invocation answered here as the Go node answers it: plugin.getConfig
 * (one ModuleConfig on raw "config"), http.request and storage.ingest_with_source.
 *
 * Each group request carries its own job ($ICN CONNECTOR_ID celestrak-gp-groups/<TOKEN>) and the parser pairs the
 * responses by it, so the 49-group default list (49 responses, no job frame) lands in one invocation of the baked
 * runtime, which hands a node at most 64 frames.
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
const RECONCILE = { duplicates: 0, none: 1, current: 2 };
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const headerLines = (bytes) =>
  Object.fromEntries(decoder.decode(bytes ?? new Uint8Array(0)).split(/\r?\n/).filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
const headerBlock = (headers) => Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\r\n");

// The host side of the typed hostcall ($PIV in, $PIV out). `fetches` is keyed by URL; an unknown URL answers 404.
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
      const c = { operation, params: call.params, lists: call.lists, raw: call.raw };
      calls.push(c);
      if (operation === "plugin.getConfig") return answer({ ok: true, op: operation, raw: { config: encodeModuleConfig(config) } });
      if (operation === "http.request") {
        c.url = decoder.decode(call.raw.url);
        const spec = fetches[c.url] ?? { status: 404 };
        return answer({ ok: true, op: operation, result: { STATUS: spec.status ?? 200, RETRIEVED_MS: BigInt(Date.UTC(2026, 8, 4, 1, 57, 53)) },
          raw: { url: "", headers: headerBlock(spec.headers ?? { Date: DATE_HEADER }), body: Buffer.from(spec.body ?? "") } });
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

async function runFlowOnce(wasmURL, stub) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(wasmURL))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const egress = { results: [], notices: [] };
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encodeTimerTick({ triggerId: "timer", firedMs: Date.UTC(2026, 8, 4) }) });
  await host.drain({
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const f of frames) {
        const id = identifierOf(f.bytes);
        if (id === "INGR") { assert.equal(f.portId, "result"); egress.results.push(decodeIngestResult(f.bytes)); }
        else if (id === "FNTC") { assert.equal(f.portId, "notice"); egress.notices.push(decodeFlowNotice(f.bytes)); }
        else assert.fail(`an egress frame that is no runtime type: "${id}"`);
      }
      return { statusCode: 0 };
    },
  });
  return egress;
}

const ingestCalls = (stub) => stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
const fetchCalls = (stub) => stub.calls.filter((c) => c.operation === "http.request");

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

// Two groups via node CONFIG: the fixture table only knows these URLs, and a 404 for any other group would (correctly)
// fail the batch.
const TWO_GROUPS = { celestrak_gp_groups: "stations,gpz" };

test("celestrak-gp-groups-ingest: tick -> one fetch per group -> one $EGP per group -> one attributed ingest", async () => {
  const stub = createHostStub({ config: TWO_GROUPS, fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { body: GPZ_CSV } } });
  const egress = await runFlowOnce(GP_GROUPS_WASM, stub);

  assert.deepEqual(fetchCalls(stub).map((c) => c.url), [STATIONS_URL, GPZ_URL], "one outbound fetch per group, in list order");
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "one EGP batch");
  const egp = ingests[0];
  const concat = Buffer.concat([STATIONS_CSV, GPZ_CSV]);
  assert.deepEqual(
    [egp.params.SCHEMA, egp.params.PROVIDER_ID, egp.params.SOURCE_NAME, egp.params.SOURCE_URL, egp.params.SOURCE_PEER],
    ["EGP.fbs", "space-data-network-02", "celestrak-gp-groups", "https://celestrak.org/NORAD/elements/", "source:celestrak"],
  );
  assert.equal(egp.params.BATCH_ID, sha256Hex(concat), "batch = sha256 of the concatenated payloads");
  assert.equal(egp.params.RECONCILE, RECONCILE.current);
  assert.equal(egp.params.LICENSE_URL, "https://celestrak.org/usage-policy.php");
  assert.deepEqual([egp.params.ARCHIVE_SOURCE, egp.params.ARCHIVE_NAME], ["celestrak", "gp-groups.csv"]);
  assert.deepEqual(egp.archive, concat, "raw archive bytes = the hashed concatenation");
  const p = egp.lists.provenance[0];
  assert.deepEqual([p.SOURCE_SHA256, Number(p.NORMALIZED_COUNT)], [sha256Hex(concat), 2]);

  assert.equal(egress.results.length, 1, "one IngestResult reached the egress sink");
  assert.equal(egress.results[0].inserted, 2, "one $EGP per group");
  assert.equal(egress.results[0].schema, "EGP.fbs");
  assert.deepEqual(egress.notices, []);
});

// The default list is 47 GROUP + 2 SPECIAL queries: 49 responses, paired by their CONTEXT, in ONE invocation.
test("celestrak-gp-groups-ingest: the default 49-group list lands in one invocation and one batch", async () => {
  // Learn the default URL list from the artifact itself (no override).
  const enumerate = createHostStub({});
  try {
    await runFlowOnce(GP_GROUPS_WASM, enumerate);
  } catch {
    // every fetch 404s -> the parse node refuses; the request list is what we want
  }
  const urls = fetchCalls(enumerate).map((c) => c.url);
  assert.equal(urls.length, 49, "47 GROUP + 2 SPECIAL requests");
  assert.equal(new Set(urls).size, 49);
  assert.equal(ingestCalls(enumerate).length, 0, "a refused group stops the batch");

  const stub = createHostStub({ fetches: Object.fromEntries(urls.map((url) => [url, { body: STATIONS_CSV }])) });
  const egress = await runFlowOnce(GP_GROUPS_WASM, stub);
  assert.equal(fetchCalls(stub).length, 49);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1, "all 49 responses were paired in one invocation");
  assert.equal(ingests[0].params.RECONCILE, RECONCILE.current);
  assert.equal(ingests[0].params.BATCH_ID, sha256Hex(Buffer.concat(urls.map(() => STATIONS_CSV))), "batch = sha256 of all 49 payloads in list order");
  assert.equal(egress.results.length, 1);
  assert.equal(egress.results[0].inserted, 49, "one $EGP per group");
});

test("celestrak-gp-groups-ingest: unchanged groups reach egress as a notice and never an ingest", async () => {
  const stub = createHostStub({ config: TWO_GROUPS, fetches: { [STATIONS_URL]: { status: 304 }, [GPZ_URL]: { status: 304 } } });
  const egress = await runFlowOnce(GP_GROUPS_WASM, stub);
  assert.equal(ingestCalls(stub).length, 0, "nothing stored for 304");
  assert.deepEqual(egress.results, []);
  assert.equal(egress.notices.length, 1);
  const [n] = egress.notices;
  assert.deepEqual([n.kind, n.reason, n.sourceName, n.count, n.items], ["unchanged", "not-modified", "celestrak-gp-groups", 2, ["stations", "gpz"]]);
});

test("celestrak-gp-groups-ingest: a partial refresh appends only the changed groups", async () => {
  const stub = createHostStub({ config: TWO_GROUPS, fetches: { [STATIONS_URL]: { status: 304 }, [GPZ_URL]: { body: GPZ_CSV } } });
  const egress = await runFlowOnce(GP_GROUPS_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].params.RECONCILE, RECONCILE.duplicates, "unchanged groups are never superseded");
  assert.equal(ingests[0].params.BATCH_ID, sha256Hex(GPZ_CSV));
  assert.deepEqual(egress.notices.map((n) => [n.kind, n.items]), [["unchanged", ["stations"]]]);
  assert.deepEqual(egress.results.map((r) => r.inserted), [1]);
});

test("celestrak-gp-groups-ingest: a non-200 group fetch stops the batch before any ingest", async () => {
  const stub = createHostStub({ config: TWO_GROUPS, fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { status: 403 } } });
  try {
    await runFlowOnce(GP_GROUPS_WASM, stub);
  } catch {
    // the parse node errors; either way nothing may be stored
  }
  assert.equal(ingestCalls(stub).length, 0, "no ingest hostcall after a refused fetch");
});

test("celestrak-gp-groups-ingest: OMM re-emission stores a second batch only when configured", async () => {
  const stub = createHostStub({
    config: { ...TWO_GROUPS, celestrak_gp_groups_emit_omm: true },
    fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { body: GPZ_CSV } },
  });
  const egress = await runFlowOnce(GP_GROUPS_WASM, stub);
  assert.deepEqual(ingestCalls(stub).map((c) => c.params.SCHEMA).sort(), ["EGP.fbs", "OMM.fbs"]);
  const omm = ingestCalls(stub).find((c) => c.params.SCHEMA === "OMM.fbs");
  assert.equal(omm.params.RECONCILE, RECONCILE.duplicates);
  assert.equal(omm.params.ARCHIVE_NAME ?? "", "", "payload archived once (EGP batch only)");
  assert.equal(omm.archive, null);
  assert.equal(egress.results.find((r) => r.schema === "OMM.fbs").inserted, 4);
});

// CelesTrak GP data are SGP4 mean elements in TEME of date; the same contract as celestrak-gp-ingest.
test("celestrak-gp-groups-ingest: every re-emitted OMM declares CENTER_NAME EARTH and REFERENCE_FRAME TEME of date", async () => {
  const stub = createHostStub({
    config: { ...TWO_GROUPS, celestrak_gp_groups_emit_omm: true },
    fetches: { [STATIONS_URL]: { body: STATIONS_CSV }, [GPZ_URL]: { body: GPZ_CSV } },
  });
  await runFlowOnce(GP_GROUPS_WASM, stub);
  const omm = ingestCalls(stub).find((c) => c.params.SCHEMA === "OMM.fbs");
  assert.ok(omm, "OMM ingest fired");
  const records = splitStream(omm.records);
  const expected = [
    { norad: 25544, name: "ISS (ZARYA)" },
    { norad: 48274, name: "CSS (TIANHE)" },
    { norad: 41866, name: "GOES 16" },
    { norad: 36516, name: "SES-1" },
  ];
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

test("celestrak-satcat-reference-ingest: one tick fans out to BOTH reference tables", async () => {
  const stub = createHostStub({ fetches: { [LAUNCHSITES_URL]: { body: LAUNCHSITES_HTML }, [SOURCES_URL]: { body: SOURCES_HTML } } });
  const egress = await runFlowOnce(SATCAT_REFERENCE_WASM, stub);

  assert.deepEqual(fetchCalls(stub).map((c) => c.url).sort(), [LAUNCHSITES_URL, SOURCES_URL]);
  for (const c of fetchCalls(stub)) assert.equal(Number(c.params.MAX_BYTES), 2097152, "2 MiB byte budget per page");

  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 2, "launch sites + owners");
  const bySchema = new Map(ingests.map((c) => [c.params.SCHEMA, c]));
  const sit = bySchema.get("SIT.fbs");
  assert.ok(sit, "SIT ingest fired");
  assert.deepEqual(
    [sit.params.SOURCE_NAME, sit.params.BATCH_ID, sit.params.RECONCILE, sit.params.ARCHIVE_NAME],
    ["celestrak-satcat-launch-sites", sha256Hex(LAUNCHSITES_HTML), RECONCILE.current, "launchsites.html"],
  );
  assert.deepEqual(sit.archive, Buffer.from(LAUNCHSITES_HTML), "raw archive bytes");
  const lcc = bySchema.get("LCC.fbs");
  assert.ok(lcc, "LCC ingest fired");
  assert.deepEqual(
    [lcc.params.SOURCE_NAME, lcc.params.BATCH_ID, lcc.params.SOURCE_URL, lcc.params.ARCHIVE_NAME],
    ["celestrak-satcat-owners", sha256Hex(SOURCES_HTML), SOURCES_URL, "sources.html"],
  );
  assert.equal(egress.results.length, 2);
  for (const r of egress.results) assert.equal(r.inserted, 3, "3 fixture rows per table");
});

test("celestrak-satcat-reference-ingest: node CONFIG URL overrides drive the fetches", async () => {
  const sitesURL = "https://fixtures.test/launchsites.html";
  const sourcesURL = "https://fixtures.test/sources.html";
  const stub = createHostStub({
    config: { celestrak_satcat_launchsites_url: sitesURL, celestrak_satcat_sources_url: sourcesURL },
    fetches: { [sitesURL]: { body: LAUNCHSITES_HTML }, [sourcesURL]: { body: SOURCES_HTML } },
  });
  await runFlowOnce(SATCAT_REFERENCE_WASM, stub);
  assert.deepEqual(fetchCalls(stub).map((c) => c.url).sort(), [sitesURL, sourcesURL]);
  const lcc = ingestCalls(stub).find((c) => c.params.SCHEMA === "LCC.fbs");
  assert.equal(lcc.params.SOURCE_URL, sourcesURL, "node CONFIG override drove the fetch");
});

test("celestrak-satcat-reference-ingest: a 304 page yields an unchanged notice, not an ingest", async () => {
  const stub = createHostStub({ fetches: { [LAUNCHSITES_URL]: { status: 304 }, [SOURCES_URL]: { body: SOURCES_HTML } } });
  const egress = await runFlowOnce(SATCAT_REFERENCE_WASM, stub);
  const ingests = ingestCalls(stub);
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0].params.SCHEMA, "LCC.fbs");
  assert.equal(egress.notices.length, 1, "the unchanged notice reached egress");
  const [n] = egress.notices;
  assert.deepEqual([n.kind, n.schema, n.sourceName, n.reason, n.items], ["unchanged", "SIT.fbs", "celestrak-satcat-launch-sites", "not-modified", [LAUNCHSITES_URL]]);
});
