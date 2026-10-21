import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeHostCall, decodeIngestResult, encodeFlowNotice, encodeHttpResponse, encodeIngestRequest } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/storage-ingest on the typed contracts (1.0): an IngestRequest + the batch's size-prefixed record stream (+ the
// HttpResponse it was made from) in, one IngestResult out, and the host call an SDS $PIV storage.ingest_with_source.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
const RUNTIME = {
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

// The smallest valid FlatBuffer root carrying file identifier `$CODE` (an empty table), and a size-prefixed stream.
function emptyRecord(code) {
  const b = new Uint8Array(16), v = new DataView(b.buffer);
  v.setUint32(0, 12, true);
  b.set(new TextEncoder().encode(`$${code}`), 4);
  v.setUint16(8, 4, true); v.setUint16(10, 4, true);
  v.setInt32(12, 4, true);
  return b;
}
function recordStream(code, count) {
  const out = new Uint8Array(count * 20), v = new DataView(out.buffer);
  for (let i = 0; i < count; i++) { v.setUint32(i * 20, 16, true); out.set(emptyRecord(code), i * 20 + 4); }
  return out;
}
const RECORDS = recordStream("WXF", 3);
const RAW_BODY = new TextEncoder().encode("GRIB....7777");

const REQUEST = {
  schema: "WXF.fbs",
  tags: { providerId: "noaa-ncep", sourceName: "gfs-0p25-sea", batchId: "b".repeat(64), sourceUrl: "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261013/06/atmos/gfs.t06z.pgrb2.0p25.f003",
    contentKeyId: "public", sourcePeer: "source:noaa", license: "CC0-1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", citation: "NOAA NCEP GFS", shareAlike: true },
  reconcile: "current",
  archive: { source: "noaa", name: "gfs.t06z.f003.grib2" },
  provenance: { sourceUrl: "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261013/06/atmos/gfs.t06z.pgrb2.0p25.f003", httpStatus: 206, etag: "\"abc\"", lastModified: "Tue, 13 Oct 2026 09:00:00 GMT",
    contentType: "application/octet-stream", retrievedMs: 1791900000000, parser: "nwp-grib2-parser", parserVersion: "0.4.1", sourceSha256: "a".repeat(64), normalizedSha256: "c".repeat(64), normalizedCount: 3, fromCache: false },
};

const meta = (request) => ({ portId: "meta", typeRef: RUNTIME.INGQ, payload: encodeIngestRequest(request) });
const records = (code = "WXF", payload = RECORDS) => ({ portId: `${code.toLowerCase()}_records`, typeRef: typeRef(code), payload });
const raw = (body = RAW_BODY) => ({ portId: "raw", typeRef: RUNTIME.HRSP, payload: encodeHttpResponse({ url: REQUEST.tags.sourceUrl, status: 200, body }) });

// The SDK JS host's view of the call (its storage.ingest_with_source adapter: the Go node's handler-shaped request -
// lower-case source tags, reconcile by name, records, archive {source, name, raw}, provenance {source, json}) plus the
// $PIV request itself, decoded from guest memory, for the module's own request bytes.
function hostStub({ fail } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v instanceof Uint8Array ? Uint8Array.from(v) : v])) });
    if (operation !== "storage.ingest_with_source") throw new Error(`unexpected hostcall ${operation}`);
    if (fail) throw fail;
    return { schema: params.schema, batch_id: params.batch_id, inserted: 3, reconciled_duplicates: 0, reconciled_old_batches: 7, archived: params.archive ? `/raw/${params.archive.source}/2026-10-13/${params.archive.name}` : "" };
  };
  return { calls, dispatch, wire: [] };
}
async function harnessFor(t, stub) {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host, call: (op, opLen, ptr, len) => {
      stub.wire.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
      return host.call(op, opLen, ptr, len);
    } } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostcallDispatch: stub.dispatch });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  return harness;
}
function result(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");
  return decodeIngestResult(response.outputs[0].payload);
}

test("hostcap/storage-ingest passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes[0].acceptsAnyFlatbuffer, undefined, port.portId);
  }
  const ids = Object.fromEntries([...method.inputPorts, ...method.outputPorts].map((p) => [p.portId, p.acceptedTypeSets[0].allowedTypes[0].fileIdentifier]));
  assert.deepEqual([ids.meta, ids.raw, ids.result, ids.wxf_records, ids.omm_records, ids.ldm_records, ids.ocm_records, ids.obd_records, ids.oem_records], ["INGQ", "HRSP", "INGR", "$WXF", "$OMM", "$LDM", "$OCM", "$OBD", "$OEM"]);
});

test("hostcap/storage-ingest imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("an IngestRequest + record stream + raw document become one typed storage.ingest_with_source", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const out = result(await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records(), raw()] }));
  assert.deepEqual(out, { schema: "WXF.fbs", providerId: "noaa-ncep", sourceName: "gfs-0p25-sea", batchId: "b".repeat(64), inserted: 3, reconciledDuplicates: 0,
    reconciledOldBatches: 7, archived: "/raw/noaa/2026-10-13/gfs.t06z.f003.grib2", refused: "" });

  // What the SDK JS host's storage.ingest_with_source adapter hands the handler.
  assert.equal(stub.calls.length, 1);
  const { params } = stub.calls[0];
  assert.deepEqual(
    [params.schema, params.provider_id, params.source_name, params.batch_id, params.source_url, params.content_key_id, params.source_peer, params.license, params.license_url, params.citation, params.share_alike, params.reconcile, params.archive.source, params.archive.name],
    ["WXF.fbs", "noaa-ncep", "gfs-0p25-sea", "b".repeat(64), REQUEST.tags.sourceUrl, "public", "source:noaa", "CC0-1.0", REQUEST.tags.licenseUrl, "NOAA NCEP GFS", true, "current", "noaa", "gfs.t06z.f003.grib2"],
  );
  assert.deepEqual(Uint8Array.from(params.records), RECORDS, "the record stream reaches the host verbatim");
  assert.deepEqual(Uint8Array.from(params.archive.raw), RAW_BODY, "the raw document (the HttpResponse BODY) reaches the host verbatim");
  const provenanceDoc = JSON.parse(new TextDecoder().decode(params.provenance.json));
  assert.deepEqual([params.provenance.source, provenanceDoc.parser, provenanceDoc.parser_version], ["gfs-0p25-sea", "nwp-grib2-parser", "0.4.1"]);

  // What the module put on the wire: the $PIV request, including the provenance list the generic path drops.
  const [call] = stub.wire;
  assert.equal(call.op, "storage.ingest_with_source");
  assert.equal(call.params.RECONCILE, 2, "reconcile Current");
  assert.deepEqual(Object.keys(call.raw).sort(), ["archive", "records"]);
  assert.equal(call.lists.provenance.length, 1);
  const p = call.lists.provenance[0];
  assert.deepEqual([p.SOURCE_URL, p.HTTP_STATUS, p.ETAG, p.LAST_MODIFIED, p.CONTENT_TYPE, Number(p.RETRIEVED_MS), p.PARSER, p.PARSER_VERSION, p.SOURCE_SHA256, p.NORMALIZED_SHA256, Number(p.NORMALIZED_COUNT), p.FROM_CACHE],
    [REQUEST.provenance.sourceUrl, 206, "\"abc\"", "Tue, 13 Oct 2026 09:00:00 GMT", "application/octet-stream", 1791900000000, "nwp-grib2-parser", "0.4.1", "a".repeat(64), "c".repeat(64), 3, false]);
});

test("archive naming without a raw document archives nothing; a raw document without naming is ignored", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const named = result(await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records()] }));
  assert.equal(named.archived, "");
  const { provenance, archive, ...plain } = REQUEST;
  const unnamed = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...plain, reconcile: undefined }), records(), raw()] }));
  assert.equal(unnamed.archived, "");
  for (const [i, call] of stub.wire.entries()) {
    assert.deepEqual(Object.keys(call.raw), ["records"], `call ${i} sends no archive`);
    assert.equal(call.params.ARCHIVE_SOURCE ?? "", "", "ARCHIVE_SOURCE unset");
    assert.equal(call.params.ARCHIVE_NAME ?? "", "", "ARCHIVE_NAME unset");
  }
  assert.equal(stub.wire[1].params.RECONCILE, 0, "reconcile defaults to Duplicates");
  assert.equal(stub.wire[1].lists.provenance, undefined, "no provenance list without PROVENANCE");
});

test("a value over its aligned bound is REFUSED by name, never truncated, and nothing reaches the host", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const longUrl = `https://example.test/${"x".repeat(300)}`;
  const out = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, tags: { ...REQUEST.tags, sourceUrl: longUrl } }), records()] }));
  assert.match(out.refused, /^TAGS\.SOURCE_URL is 321 bytes; the storage\.ingest_with_source record holds at most 255/);
  assert.deepEqual([out.schema, out.providerId, out.sourceName, out.batchId, out.inserted], ["WXF.fbs", "noaa-ncep", "gfs-0p25-sea", "b".repeat(64), 0]);
  const batch = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, tags: { ...REQUEST.tags, batchId: "d".repeat(129) } }), records()] }));
  assert.match(batch.refused, /^TAGS\.BATCH_ID is 129 bytes; .* at most 128/);
  const prov = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, provenance: { ...REQUEST.provenance, parserVersion: "v".repeat(65) } }), records()] }));
  assert.match(prov.refused, /^PROVENANCE\.PARSER_VERSION is 65 bytes; .* at most 64/);
  assert.equal(stub.calls.length + stub.wire.length, 0);
});

test("a host refusal answers REFUSED; any other host failure fails the node", async (t) => {
  const refusing = hostStub({ fail: Object.assign(new Error("ingest requires at least 2147483648 free bytes"), { hostcallCode: "refused" }) });
  const out = result(await (await harnessFor(t, refusing)).invoke({ methodId: "ingest", inputs: [meta(REQUEST), records()] }));
  assert.equal(out.refused, "refused: ingest requires at least 2147483648 free bytes");
  assert.equal(out.inserted, 0);

  const denied = hostStub({ fail: Object.assign(new Error("requires the storage_ingest capability grant"), { name: "HostCapabilityError" }) });
  assert.match(result(await (await harnessFor(t, denied)).invoke({ methodId: "ingest", inputs: [meta(REQUEST), records()] })).refused, /^not-authorized: requires the storage_ingest/);

  const failing = hostStub({ fail: new Error("ingest failed: disk I/O error") });
  const response = await (await harnessFor(t, failing)).invoke({ methodId: "ingest", inputs: [meta(REQUEST), records()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "ingest-failed");
  assert.match(response.errorMessage, /disk I\/O error/);
  assert.equal(response.outputs.length, 0);
});

test("the record stream's standard must be the request's SCHEMA", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const response = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records("OMM", recordStream("OMM", 2))] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "record-type-disagreement");
  const ok = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, schema: "OMM.fbs", archive: undefined }), records("OMM", recordStream("OMM", 2))] }));
  assert.equal(ok.schema, "OMM.fbs");
  const ldm = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, schema: "LDM.fbs", archive: undefined }), records("LDM", recordStream("LDM", 2))] }));
  assert.equal(ldm.schema, "LDM.fbs", "ldm_records carries data-source/launch-schedule's $LDM batches");
  // flows/supplemental-omm stores its fits' $OCM states and $OBD diagnostics beside the $OMM sets
  for (const code of ["OCM", "OBD", "OEM"]) {
    const stored = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, schema: `${code}.fbs`, archive: undefined }), records(code, recordStream(code, 2))] }));
    assert.equal(stored.schema, `${code}.fbs`);
  }
  assert.equal(stub.calls.length, 5, "the disagreeing batch never reached the host");
});

test("missing frames and frames of the wrong type are refused before any hostcall", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const noRecords = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST)] });
  assert.equal(noRecords.errorCode, "missing-records-frame");
  const notRequest = await harness.invoke({ methodId: "ingest", inputs: [{ portId: "meta", typeRef: RUNTIME.INGQ, payload: encodeFlowNotice({ kind: "info" }) }, records()] });
  assert.equal(notRequest.errorCode, "invalid-meta");
  const notResponse = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records(), { portId: "raw", typeRef: RUNTIME.HRSP, payload: encodeFlowNotice({ kind: "info" }) }] });
  assert.equal(notResponse.errorCode, "invalid-raw");
  assert.equal(stub.calls.length, 0);
});

// The compiled flow runtime drains a node's queue port-blind (maxStreams is declarative only), so a surplus frame on a
// single-stream port is refused by name rather than silently destroyed (graph: modules-guest-nodes-drop-batched-frames).
test("surplus frames are refused, never dropped: two streams on one port, or streams on two ports", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const twice = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records(), records()] });
  assert.equal(twice.errorCode, "batched-input-frames");
  assert.match(twice.errorMessage, /2 frames on single-stream input port "wxf_records"/);
  const twoMetas = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), meta(REQUEST), records()] });
  assert.match(twoMetas.errorMessage, /2 frames on single-stream input port "meta"/);
  const twoPorts = await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records(), records("OMM", recordStream("OMM", 1))] });
  assert.equal(twoPorts.errorCode, "batched-input-frames");
  assert.match(twoPorts.errorMessage, /"wxf_records" and "omm_records"/);
  for (const r of [twice, twoMetas, twoPorts]) assert.equal(r.outputs.length, 0);
  assert.equal(stub.calls.length, 0);
});

// plugin_get_input_frame(0) takes the invocation's first frame whatever its port; only port-filtered access is admissible.
test("the source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/storage_ingest_module.cpp", import.meta.url)), "utf8");
  const offenders = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes("plugin_get_input_frame(0)"));
  assert.deepEqual(offenders, []);
});

test("PROVENANCE.ATTRIBUTES travel in order on list provenance_attributes; the host's provenance document carries them", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const attributes = [{ name: "method", value: "GRIB2 decode" }, { name: "units", value: "m s-1" }, { name: "date_range", value: "2026-10-13T06Z/2026-10-13T09Z" }, { name: "method", value: "second entry, same name" }];
  result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, provenance: { ...REQUEST.provenance, attributes } }), records()] }));
  const [call] = stub.wire;
  assert.deepEqual(call.lists.provenance_attributes.map((a) => [a.NAME, a.VALUE]), attributes.map((a) => [a.name, a.value]), "the module's own records, in order");
  const doc = JSON.parse(new TextDecoder().decode(stub.calls[0].params.provenance.json));
  assert.deepEqual(doc.attributes, attributes, "the SDK adapter's provenance document, in order");

  result(await harness.invoke({ methodId: "ingest", inputs: [meta(REQUEST), records()] }));
  assert.equal(stub.wire[1].lists.provenance_attributes, undefined, "no attributes, no list");
});

test("an over-long provenance attribute is REFUSED by name, never truncated, and nothing reaches the host", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, stub);
  const value = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, provenance: { ...REQUEST.provenance, attributes: [{ name: "ok", value: "fine" }, { name: "method", value: "v".repeat(256) }] } }), records()] }));
  assert.match(value.refused, /^PROVENANCE\.ATTRIBUTES\[1\]\.VALUE is 256 bytes; .* at most 255/);
  assert.equal(value.inserted, 0);
  const name = result(await harness.invoke({ methodId: "ingest", inputs: [meta({ ...REQUEST, provenance: { ...REQUEST.provenance, attributes: [{ name: "n".repeat(129), value: "x" }] } }), records()] }));
  assert.match(name.refused, /^PROVENANCE\.ATTRIBUTES\[0\]\.NAME is 129 bytes; .* at most 128/);
  assert.equal(stub.calls.length + stub.wire.length, 0);
});
