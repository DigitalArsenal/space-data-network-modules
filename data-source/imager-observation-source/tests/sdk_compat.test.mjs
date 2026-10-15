// data-source/imager-observation-source SDK-compat tests (typed contracts 1.0): the compiled wasm in the SDK browser
// harness, its node config answered through a typed plugin.getConfig (one ModuleConfig), select_files fed REAL S3
// ListObjectsV2 listings of NOAA's public GOES-19 bucket (tests/fixtures, fetched 2026-10-07 for the 2026-280 06 UTC
// folders) as HttpResponses echoing their list jobs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeIngestResult, identifierOf, decodeFlowNotice, decodeHostCall, decodeHttpRequest, encodeHttpResponse, encodeIngestRequest,
  encodeIngestResult, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);
const FIXTURES = new URL("./fixtures/", import.meta.url);
const CMIPF_LISTING = fs.readFileSync(new URL("noaa-goes19-ABI-L2-CMIPF-2026-280-06.xml", FIXTURES));
const ACHA_LISTING = fs.readFileSync(new URL("noaa-goes19-ABI-L2-ACHA2KMF-2026-280-06.xml", FIXTURES));
const FRAME = "2026-10-07T06:00:00Z";
const FRAME_MS = Date.UTC(2026, 9, 7, 6);
const NO_VALIDATORS = "Thu, 01 Jan 1970 00:00:00 GMT";
const encoder = new TextEncoder();
const T = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: "flatbuffer" });
const TICK = T("TimerTick.fbs", "TICK", "TimerTick"), HRSP = T("HttpResponse.fbs", "HRSP", "HttpResponse");
const INGR = T("IngestResult.fbs", "INGR", "IngestResult"), INGQ = T("IngestRequest.fbs", "INGQ", "IngestRequest");

// The SDK harness's BrowserHost answers plugin.getConfig from its `config` option (one ModuleConfig on raw "config", as
// the Go node answers). The hostcall import is only watched, to decode every $PIV request into `wire`.
const instantiate = WebAssembly.instantiate;
async function createHarness(t, config = {}) {
  const wire = [];
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        wire.push(call);
        return host.call(op, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  t.after(() => { WebAssembly.instantiate = instantiate; });
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostOptions: { config },
  });
  t.after(() => harness.destroy());
  return { harness, calls: wire };
}

const job = (context) => wxfLib.WXF.getSizePrefixedRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(context))).unpack();
function out(response, port) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.filter((f) => f.portId === port);
}
const requestsOf = (response, port = "requests") => out(response, port).map((f) => {
  assert.equal(f.typeRef?.fileIdentifier, "HREQ");
  const r = decodeHttpRequest(f.payload);
  return { ...r, h: r.headers, job: r.context?.length ? job(r.context) : null };
});
const noticesOf = (response) => out(response, "status").map((f) => decodeFlowNotice(f.payload));
const tick = () => ({ portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "timer-imager", firedMs: FRAME_MS }) });

// a listing HttpResponse echoing the list job plan made (the real job bytes)
function listJobBytes(product, fields, hour = "06") {
  const b = new flatbuffers.Builder(256);
  const grid = wxfLib.WXFGrid.createWXFGrid(b, 0, 0, 0, 0, 0, 0, 0, false);
  const W = wxfLib.WXF;
  const fid = b.createString(fields), sensor = b.createString("GOES-19 ABI"), dataset = b.createString("noaa-goes19"), url = b.createString(`${product}/2026/280/${hour}/`);
  W.startWXF(b); W.addFieldId(b, fid); W.addValidTimeMs(b, BigInt(FRAME_MS)); W.addGrid(b, grid); W.addSensorId(b, sensor); W.addDatasetId(b, dataset); W.addSourceUrl(b, url);
  W.finishSizePrefixedWXFBuffer(b, W.endWXF(b));
  return b.asUint8Array();
}
const listing = (context, body, status = 200) => ({ portId: "listings", typeRef: HRSP, payload: encodeHttpResponse({ url: "https://noaa-goes19.s3.amazonaws.com/", status, body, context }) });

test("imager-observation-source artifact passes SDK compliance, every port one concrete type", async () => {
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
      assert.equal(port.acceptedTypeSets[0].wildcardJustification, undefined);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, { "plan.tick": "TICK", "plan.requests": "HREQ", "plan.status": "FNTC", "select_files.listings": "HRSP", "select_files.requests": "HREQ",
    "select_files.status": "FNTC", "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.request": "HREQ" });
});

test("imager-observation-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("plan: one listing per (satellite, product folder) of the frame hour, its list job in CONTEXT", async (t) => {
  const { harness, calls } = await createHarness(t, { imager_frame_time: FRAME });
  const requests = requestsOf(await harness.invoke({ methodId: "plan", inputs: [tick()] }));
  assert.deepEqual(calls.map((c) => c.op), ["plugin.getConfig"]);
  // the default fields: cloud mask (ACMF), optical depth (COD2KMF), reflectance + brightness temperature (one CMIPF
  // listing), cloud-top height (ACHA2KMF) -> four folders a satellite, two satellites
  assert.equal(requests.length, 8);
  const urls = requests.map((r) => r.url).sort();
  for (const bucket of ["noaa-goes18", "noaa-goes19"]) {
    for (const product of ["ABI-L2-ACHA2KMF", "ABI-L2-ACMF", "ABI-L2-CMIPF", "ABI-L2-COD2KMF"]) {
      assert.ok(urls.includes(`https://${bucket}.s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=${product}/2026/280/06/`), `${bucket} ${product}`);
    }
  }
  for (const r of requests) {
    assert.equal(r.method, "GET");
    assert.deepEqual(r.h, { "if-modified-since": NO_VALIDATORS });
    assert.equal(r.timeoutMs, 60000);
  }
  const cmipf = requests.find((r) => r.job.DATASET_ID === "noaa-goes19" && r.job.SOURCE_URL.startsWith("ABI-L2-CMIPF/")).job;
  assert.deepEqual([cmipf.FIELD_ID, cmipf.SENSOR_ID, cmipf.DATASET_ID, cmipf.SOURCE_URL, Number(cmipf.VALID_TIME_MS)],
    ["reflectance_064um,brightness_temperature_10um", "GOES-19 ABI", "noaa-goes19", "ABI-L2-CMIPF/2026/280/06/", FRAME_MS]);
});

test("plan: without a set frame time, the latest hour imager_lag_minutes old (the node's clock); dotted lists and numeric frame times", async (t) => {
  const { harness } = await createHarness(t, { imager_satellites: "goes-west", imager_fields: "cloud_top_height", imager_lag_minutes: 20 });
  const before = Date.now();
  const [r] = requestsOf(await harness.invoke({ methodId: "plan", inputs: [tick()] }));
  const want = Math.floor((before - 20 * 60000) / 3600000) * 3600000;
  const got = Number(r.job.VALID_TIME_MS);
  assert.ok(got === want || got === want + 3600000, `${got} vs ${want}`);
  const dotted = await createHarness(t, { imager_satellites: ["goes-east"], imager_fields: ["cloud_mask", "cloud_phase"], imager_frame_time: FRAME_MS + 1234 });
  const rs = requestsOf(await dotted.harness.invoke({ methodId: "plan", inputs: [tick()] }));
  assert.deepEqual(rs.map((x) => [x.job.DATASET_ID, x.job.FIELD_ID, Number(x.job.VALID_TIME_MS)]), [["noaa-goes19", "cloud_mask", FRAME_MS], ["noaa-goes19", "cloud_phase", FRAME_MS]]);
});

test("plan: live access off, or an unknown satellite/field, emits no request", async (t) => {
  for (const off of [false, "false", "0"]) {
    const { harness } = await createHarness(t, { imager_live_access: off });
    const response = await harness.invoke({ methodId: "plan", inputs: [tick()] });
    assert.deepEqual(noticesOf(response).map((n) => [n.kind, n.reason, n.providerId]), [["skipped", "live-access-disabled", "noaa-goes"]]);
    assert.equal(out(response, "requests").length, 0);
  }
  for (const [config, code] of [[{ imager_satellites: "goes-north" }, "unknown-satellite"], [{ imager_fields: "sea_ice" }, "unknown-field"]]) {
    const { harness } = await createHarness(t, { imager_frame_time: FRAME, ...config });
    const bad = await harness.invoke({ methodId: "plan", inputs: [tick()] });
    assert.equal(bad.errorCode, code);
    assert.equal(bad.outputs.length, 0);
  }
  const { harness } = await createHarness(t);
  const batched = await harness.invoke({ methodId: "plan", inputs: [tick(), tick()] });
  assert.equal(batched.errorCode, "batched-input-frames");
});

test("select_files: the hour's first scan of each field from real listings; the 143 MB band as three byte ranges; one part per invocation", async (t) => {
  const { harness } = await createHarness(t, {});
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    listing(listJobBytes("ABI-L2-CMIPF", "reflectance_064um,brightness_temperature_10um"), CMIPF_LISTING),
    listing(listJobBytes("ABI-L2-ACHA2KMF", "cloud_top_height"), ACHA_LISTING),
  ] });
  assert.equal(noticesOf(response).length, 0, "nothing missing");
  // first: reflectance, band 2, 142 635 609 bytes > 64 MiB -> three ranges covering the file exactly, ONE A CALL (the parser
  // appends them as they come: a daytime full disc is ~430 MB, held once)
  const key = "ABI-L2-CMIPF/2026/280/06/OR_ABI-L2-CMIPF-M6C02_G19_s20262800600212_e20262800609520_c20262800609576.nc";
  const url = `https://noaa-goes19.s3.amazonaws.com/${key}`;
  assert.equal(requestsOf(response).length, 1);
  const requests = [...requestsOf(response), ...requestsOf(await harness.invoke({ methodId: "select_files", inputs: [] })),
    ...requestsOf(await harness.invoke({ methodId: "select_files", inputs: [] }))];
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((r) => [r.job.SOURCE_URL, r.job.FIELD_ID, r.job.VARIABLE_NAME, r.job.TILE_INDEX, r.job.TILE_COUNT]), [0, 1, 2].map((p) => [url, "reflectance_064um", "CMI", p, 3]));
  const ranges = requests.map((r) => r.h.range.match(/^bytes=(\d+)-(\d+)$/).slice(1).map(Number));
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges[2][1], 142635609 - 1);
  for (let p = 1; p < 3; p++) assert.equal(ranges[p][0], ranges[p - 1][1] + 1, "contiguous");
  for (const [a, b] of ranges) assert.ok(b - a + 1 <= 64 * 1024 * 1024);
  for (const r of requests) {
    assert.equal(r.url, url);
    assert.equal(r.h["if-modified-since"], NO_VALIDATORS, "a second range must never come back 304");
    assert.equal(r.timeoutMs, 300000);
  }
  const j = requests[0].job;
  assert.equal(Number(j.VALID_TIME_MS), FRAME_MS);
  assert.equal(j.SENSOR_ID, "GOES-19 ABI");
  assert.equal(j.DATASET_ID, "noaa-goes19");
  assert.equal(j.LICENSE_CLASS, wxfLib.wxfLicenseClass.OpenAttribution);
  assert.equal(j.ORIGIN_ID, "NOAA Open Data Dissemination (AWS)");
  assert.match(j.CITATION, /^GOES-19 ABI data courtesy of NOAA/);
  // the backlog: resumed without input, the next file (brightness temperature, then cloud-top height), then done
  const next = requestsOf(await harness.invoke({ methodId: "select_files", inputs: [] }));
  assert.deepEqual(next.map((r) => [r.job.FIELD_ID, r.job.TILE_COUNT, r.h.range]), [["brightness_temperature_10um", 1, undefined]]);
  const last = requestsOf(await harness.invoke({ methodId: "select_files", inputs: [] }));
  assert.deepEqual(last.map((r) => [r.job.FIELD_ID, r.job.VARIABLE_NAME]), [["cloud_top_height", "HT"]]);
  assert.equal((await harness.invoke({ methodId: "select_files", inputs: [] })).outputs.length, 0);
});

test("select_files: a field missing from its listing, or a failed listing, is reported, not invented", async (t) => {
  const { harness } = await createHarness(t, {});
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    listing(listJobBytes("ABI-L2-ACHA2KMF", "cloud_top_height"), encoder.encode('<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>')),
    listing(listJobBytes("ABI-L2-ACMF", "cloud_mask"), encoder.encode("<Error><Code>SlowDown</Code></Error>"), 503),
  ] });
  assert.deepEqual(noticesOf(response).map((n) => [n.kind, n.count, n.items, n.reason]), [["missing", 2, [   // (in listing order)
    "cloud_top_height goes-east ABI-L2-ACHA2KMF/2026/280/06/",
    "listing noaa-goes19/ABI-L2-ACMF/2026/280/06/ http 503",
  ], "not in the hour's listings"]]);
  assert.equal(out(response, "requests").length, 0);
  const noJob = await harness.invoke({ methodId: "select_files", inputs: [listing(undefined, ACHA_LISTING)] });
  assert.equal(noJob.errorCode, "invalid-list-job");
});

test("publish_request: one POST when imager_publish_url is set, nothing otherwise or for a refused batch", async (t) => {
  const result = (refused) => ({ portId: "result", typeRef: INGR, payload: encodeIngestResult({ schema: "WXF.fbs", inserted: 49, batchId: "b".repeat(64), refused }) });
  const meta = { portId: "meta", typeRef: INGQ, payload: encodeIngestRequest({ schema: "WXF.fbs", tags: { providerId: "noaa-goes", sourceName: "noaa-goes19-world", batchId: "b".repeat(64) } }) };
  const off = await createHarness(t, {});
  assert.equal(out(await off.harness.invoke({ methodId: "publish_request", inputs: [result(), meta] }), "request").length, 0);
  const on = await createHarness(t, { imager_publish_url: "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish" });
  const [request] = requestsOf(await on.harness.invoke({ methodId: "publish_request", inputs: [result(), meta] }), "request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish");
  assert.deepEqual(request.h, { "content-type": "application/octet-stream" });
  // the BODY is the stored batch's IngestResult (INGR), named from the result and the parser's tags
  assert.equal(identifierOf(Uint8Array.from(request.body)), "INGR");
  assert.deepEqual(decodeIngestResult(Uint8Array.from(request.body)),
    { schema: "WXF.fbs", providerId: "noaa-goes", sourceName: "noaa-goes19-world", batchId: "b".repeat(64), inserted: 49,
      reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "", refused: "" });
  assert.equal(out(await on.harness.invoke({ methodId: "publish_request", inputs: [result("refused: disk"), meta] }), "request").length, 0);
});
