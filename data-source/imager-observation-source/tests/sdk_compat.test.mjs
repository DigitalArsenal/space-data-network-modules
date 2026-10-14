// data-source/imager-observation-source SDK-compat tests: the compiled wasm in the SDK browser harness, its node config
// stubbed through plugin.getConfig, select_files fed REAL S3 ListObjectsV2 listings of NOAA's public buckets
// (tests/fixtures: GOES-19 fetched 2026-10-07 for the 2026-280 06 UTC folders; Himawari-9 fetched 2026-10-14 for 18:00).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const CMIPF_LISTING = fs.readFileSync(new URL("noaa-goes19-ABI-L2-CMIPF-2026-280-06.xml", FIXTURES));
const ACHA_LISTING = fs.readFileSync(new URL("noaa-goes19-ABI-L2-ACHA2KMF-2026-280-06.xml", FIXTURES));
const FRAME = "2026-10-07T06:00:00Z";
const FRAME_MS = Date.UTC(2026, 9, 7, 6);
const NO_VALIDATORS = "Thu, 01 Jan 1970 00:00:00 GMT";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesInput(portId, payload) {
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength }, payload };
}
const jsonInput = (portId, value) => bytesInput(portId, encoder.encode(JSON.stringify(value)));
function rawResponseFrame(body, status = 200) {
  const frame = new Uint8Array(8 + body.byteLength);
  frame.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(frame.buffer).setInt32(4, status, true);
  frame.set(body, 8);
  return frame;
}

async function createHarness(t, config = {}) {
  const calls = [];
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      calls.push(operation);
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return { harness, calls };
}

function framesOn(response, port) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.filter((f) => f.portId === port).map((f) => JSON.parse(decoder.decode(f.payload)));
}

const tick = () => jsonInput("tick", {});

test("imager-observation-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("imager-observation-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("plan: one listing per (satellite, product folder) of a set frame hour, with its list job", async (t) => {
  const { harness, calls } = await createHarness(t, { imager_frame_time: FRAME });
  const response = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  const requests = framesOn(response, "requests");
  const jobs = framesOn(response, "jobs");
  assert.deepEqual(calls, ["plugin.getConfig"]);
  // the default fields: cloud mask (ACMF), optical depth (COD2KMF), reflectance + brightness temperature (one CMIPF
  // listing), cloud-top height (ACHA2KMF) -> four folders a satellite, two satellites
  assert.equal(requests.length, 8);
  assert.equal(jobs.length, 8);
  const urls = requests.map((r) => r.url).sort();
  for (const bucket of ["noaa-goes18", "noaa-goes19"]) {
    for (const product of ["ABI-L2-ACHA2KMF", "ABI-L2-ACMF", "ABI-L2-CMIPF", "ABI-L2-COD2KMF"]) {
      assert.ok(urls.includes(`https://${bucket}.s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=${product}/2026/280/06/`), `${bucket} ${product}`);
    }
  }
  for (const r of requests) {
    assert.equal(r.method, "GET");
    assert.equal(r.responseWire, "raw-body-v1");
    assert.equal(r.headers["If-Modified-Since"], NO_VALIDATORS);
    assert.equal(r.timeoutMs, 60000);
  }
  const cmipf = jobs.find((j) => j.bucket === "noaa-goes19" && j.prefix.startsWith("ABI-L2-CMIPF/"));
  assert.equal(cmipf.what, "abi");
  assert.equal(cmipf.satellite, "goes-east");
  assert.equal(cmipf.sensor, "GOES-19 ABI");
  assert.equal(cmipf.provider_id, "noaa-goes");
  assert.equal(cmipf.source_name, "noaa-goes19-world");
  assert.equal(cmipf.frame_time_ms, FRAME_MS);
  assert.equal(cmipf.fields, "reflectance_064um,brightness_temperature_10um");
});

test("plan: the backfill window - every hour of imager_backfill_hours, 32 frames an invocation, then the landed ones skipped", async (t) => {
  const { harness } = await createHarness(t, { imager_satellites: "goes-west", imager_fields: "cloud_top_height", imager_lag_minutes: 20, imager_backfill_hours: 40 });
  const before = Date.now();
  const first = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  const jobs = framesOn(first, "jobs");
  assert.equal(jobs.length, 32, "32 a call (the other 8 yielded as backlog; the compiled runtime resumes the node for them)");
  const frames = jobs.map((j) => j.frame_time_ms);
  const want = Math.floor((before - 20 * 60000) / 3600000) * 3600000;
  assert.ok(frames[0] === want || frames[0] === want + 3600000, `${frames[0]} vs ${want}`);
  for (let k = 1; k < frames.length; k++) assert.equal(frames[k], frames[k - 1] - 3600000, "hour by hour, newest first");
  // a field noticed landed (the parser's probe found its mark) is not listed again; a stored ingest result likewise
  await harness.invoke({ methodId: "note", inputs: [jsonInput("notices", { satellite: "goes-west", frame_time_ms: frames[0], field: "cloud_top_height", state: "landed" })] });
  const meta = jsonInput("meta", { schema: "WXF.fbs", provider_id: "noaa-goes", source_name: "noaa-goes18-world", batch_id: "c".repeat(64),
    satellite: "goes-west", field: "cloud_top_height", frame_time_ms: frames[1], landed_mark: "https://noaa-goes18.s3.amazonaws.com/k.nc?sdn-ingest=landed&field=cloud_top_height" });
  const marked = await harness.invoke({ methodId: "publish_request", inputs: [jsonInput("result", { schema: "WXF.fbs", inserted: 21, batch_id: "c".repeat(64) }), meta] });
  const [mark] = framesOn(marked, "mark");
  assert.equal(mark.url, "https://noaa-goes18.s3.amazonaws.com/k.nc?sdn-ingest=landed&field=cloud_top_height");
  assert.equal(mark.headers.Range, "bytes=0-0");
  assert.equal(mark.headers["If-Modified-Since"], NO_VALIDATORS, "forced 206: the host books the ETag under the mark URL");
  const second = framesOn(await harness.invoke({ methodId: "plan", inputs: [tick()] }), "jobs").map((j) => j.frame_time_ms);
  assert.equal(second.length, 32);
  assert.deepEqual(second.slice(0, 30), frames.slice(2), "the two landed hours skipped, the window otherwise as before");
});

test("plan: view satellites - a work job straight to the parser, the newest hour once, again only when reported missing", async (t) => {
  const { harness } = await createHarness(t, { imager_satellites: "meteosat,metop", imager_lag_minutes_meteosat: 40, imager_lag_minutes_metop: 360 });
  const before = Date.now();
  const work = framesOn(await harness.invoke({ methodId: "plan", inputs: [tick()] }), "work");
  assert.equal(work.length, 2);
  const mtg = work.find((w) => w.satellite === "meteosat"), metop = work.find((w) => w.satellite === "metop");
  assert.equal(mtg.kind, "view");
  assert.deepEqual(mtg.fields, ["cloud_mask", "reflectance_064um", "brightness_temperature_10um", "cloud_top_height"]);
  assert.deepEqual(metop.fields, ["cloud_mask", "brightness_temperature_10um", "cloud_top_height"], "no GeoColour for the polar caps");
  assert.equal(mtg.provider_id, "eumetsat");
  assert.equal(mtg.source_name, "eumetsat-msg-0deg-world");
  assert.equal(metop.source_name, "eumetsat-metop-world");
  assert.equal(mtg.frame_time_ms, Math.floor((before - 40 * 60000) / 3600000) * 3600000);
  assert.equal(metop.frame_time_ms, Math.floor((before - 360 * 60000) / 3600000) * 3600000);
  const quiet = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  assert.deepEqual(framesOn(quiet, "status"), [{ skipped: "all-landed", status: 304, unchanged: true }], "tried once: the node's unchanged notice");
  await harness.invoke({ methodId: "note", inputs: [jsonInput("notices", { satellite: "metop", frame_time_ms: metop.frame_time_ms, field: "cloud_mask", state: "missing" })] });
  const retry = framesOn(await harness.invoke({ methodId: "plan", inputs: [tick()] }), "work");
  assert.deepEqual(retry.map((w) => [w.satellite, w.frame_time_ms]), [["metop", metop.frame_time_ms]]);
});

test("plan: live access off, or an unknown satellite/field, emits no request", async (t) => {
  const off = await createHarness(t, { imager_live_access: false });
  const response = await off.harness.invoke({ methodId: "plan", inputs: [tick()] });
  assert.deepEqual(framesOn(response, "status"), [{ skipped: "live-access-disabled" }]);
  assert.equal(framesOn(response, "requests").length, 0);
  for (const [config, code] of [[{ imager_satellites: "goes-north" }, "unknown-satellite"], [{ imager_fields: "sea_ice" }, "unknown-field"]]) {
    const { harness } = await createHarness(t, { imager_frame_time: FRAME, ...config });
    const bad = await harness.invoke({ methodId: "plan", inputs: [tick()] });
    assert.equal(bad.errorCode, code);
    assert.equal(bad.outputs.length, 0);
  }
  const { harness } = await createHarness(t, { imager_frame_time: FRAME });
  const batched = await harness.invoke({ methodId: "plan", inputs: [tick(), tick()] });
  assert.equal(batched.errorCode, "batched-input-frames");
});

test("select_files: the hour's first scan of each field from real listings, one work job a file", async (t) => {
  const { harness } = await createHarness(t, {});
  const listJob = (product, fields) => ({ what: "abi", satellite: "goes-east", sensor: "GOES-19 ABI", bucket: "noaa-goes19", prefix: `${product}/2026/280/06/`,
    frame_time_ms: FRAME_MS, widths: "4096,2048,1024", fields });
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    jsonInput("list_jobs", listJob("ABI-L2-CMIPF", "reflectance_064um,brightness_temperature_10um")),
    jsonInput("list_jobs", listJob("ABI-L2-ACHA2KMF", "cloud_top_height")),
    bytesInput("listings", rawResponseFrame(CMIPF_LISTING)),
    bytesInput("listings", rawResponseFrame(ACHA_LISTING)),
  ] });
  const work = framesOn(response, "work");
  assert.equal(framesOn(response, "status").length, 0, "nothing missing");
  assert.deepEqual(work.map((w) => [w.kind, w.field, w.variable, w.key.split("/").pop(), w.size]), [
    ["abi", "reflectance_064um", "CMI", "OR_ABI-L2-CMIPF-M6C02_G19_s20262800600212_e20262800609520_c20262800609576.nc", 142635609],
    ["abi", "brightness_temperature_10um", "CMI", "OR_ABI-L2-CMIPF-M6C13_G19_s20262800600212_e20262800609532_c20262800610008.nc", work[1].size],
    ["abi", "cloud_top_height", "HT", work[2].key.split("/").pop(), work[2].size],
  ]);
  assert.match(work[2].key, /ABI-L2-ACHA2KMF-M6_G19_s2026280060/);
  for (const w of work) {
    assert.equal(w.frame_time_ms, FRAME_MS);
    assert.equal(w.timeout_ms, 300000);
    assert.equal(w.max_part_bytes, 64 * 1024 * 1024);
    assert.equal(w.license_class, "OpenAttribution");
    assert.equal(w.source_name, "noaa-goes19-world");
    assert.match(w.citation, /courtesy of NOAA/);
  }
});

test("select_files: Himawari - a band's 88 tiles as one job, a cloud file once with the fields read from it", async (t) => {
  const { harness } = await createHarness(t, {});
  const frame = Date.UTC(2026, 9, 14, 18);
  const common = { satellite: "himawari", sensor: "Himawari-9 AHI", bucket: "noaa-himawari9", frame_time_ms: frame, widths: "2048,1024" };
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    jsonInput("list_jobs", { what: "ahi-clouds", ...common, prefix: "AHI-L2-FLDK-Clouds/2026/10/14/1800/", fields: "cloud_mask,cloud_optical_depth,cloud_top_height" }),
    jsonInput("list_jobs", { what: "ahi-tiles", ...common, prefix: "AHI-L2-FLDK-ISatSS/2026/10/14/1800/OR_HFD-020-B12-M1C13-", fields: "brightness_temperature_10um" }),
    bytesInput("listings", rawResponseFrame(fs.readFileSync(new URL("noaa-himawari9-Clouds-2026-10-14-1800.xml", FIXTURES)))),
    bytesInput("listings", rawResponseFrame(fs.readFileSync(new URL("noaa-himawari9-ISatSS-C13-2026-10-14-1800.xml", FIXTURES)))),
  ] });
  const work = framesOn(response, "work");
  assert.deepEqual(work.map((w) => w.kind), ["ahi-h5", "ahi-h5", "ahi-tiles"]);
  const [cmsk, chgt, tiles] = work;
  assert.match(cmsk.key, /AHI-CMSK_/);
  assert.deepEqual([cmsk.fields, cmsk.variables], [["cloud_mask"], ["CloudMask"]]);
  assert.match(chgt.key, /AHI-CHGT_/);
  assert.deepEqual([chgt.fields, chgt.variables], [["cloud_optical_depth", "cloud_top_height"], ["CldOptDpth", "CldTopHght"]]);
  assert.equal(chgt.provider_id, "noaa-himawari");
  assert.equal(chgt.source_name, "noaa-himawari9-world");
  assert.equal(tiles.keys.length, 88);
  assert.equal(tiles.sizes.length, 88);
  assert.equal(tiles.band, 13);
  assert.match(tiles.keys[0], /-M1C13-T001_/);
});

test("select_files: a field missing from its listing, or a failed listing, is reported as nothing new upstream", async (t) => {
  const { harness } = await createHarness(t, {});
  const listJob = (product, fields, hour = "06") => ({ what: "abi", satellite: "goes-east", sensor: "GOES-19 ABI", bucket: "noaa-goes19",
    prefix: `${product}/2026/280/${hour}/`, frame_time_ms: FRAME_MS, widths: "4096", fields });
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    jsonInput("list_jobs", listJob("ABI-L2-ACHA2KMF", "cloud_top_height")),
    jsonInput("list_jobs", listJob("ABI-L2-ACMF", "cloud_mask")),
    bytesInput("listings", rawResponseFrame(encoder.encode('<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>'))),
    bytesInput("listings", rawResponseFrame(encoder.encode("<Error><Code>SlowDown</Code></Error>"), 503)),
  ] });
  const status = framesOn(response, "status");
  assert.deepEqual(status, [{ missing: [   // (in list-job order)
    { field: "cloud_top_height", satellite: "goes-east", frame_time_ms: FRAME_MS },
    { listing: "noaa-goes19/ABI-L2-ACMF/2026/280/06/", http_status: 503 },
  ], status: 304, unchanged: true }]);
  assert.equal(framesOn(response, "work").length, 0);
  const mismatch = await harness.invoke({ methodId: "select_files", inputs: [jsonInput("list_jobs", listJob("ABI-L2-ACMF", "cloud_mask")), jsonInput("list_jobs", listJob("ABI-L2-ACMF", "cloud_mask")), bytesInput("listings", rawResponseFrame(ACHA_LISTING))] });
  assert.equal(mismatch.errorCode, "job-response-count-mismatch");
});

test("publish_request: one POST when imager_publish_url is set, nothing otherwise", async (t) => {
  const result = jsonInput("result", { schema: "WXF.fbs", inserted: 49, batch_id: "b".repeat(64) });
  const meta = jsonInput("meta", { schema: "WXF.fbs", provider_id: "noaa-goes", source_name: "noaa-goes19-world", batch_id: "b".repeat(64) });
  const off = await createHarness(t, {});
  assert.equal(framesOn(await off.harness.invoke({ methodId: "publish_request", inputs: [result, meta] }), "request").length, 0);
  const on = await createHarness(t, { imager_publish_url: "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish" });
  const [request] = framesOn(await on.harness.invoke({ methodId: "publish_request", inputs: [result, meta] }), "request");
  assert.equal(request.method, "POST");
  assert.deepEqual(JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8")),
    { schema: "WXF.fbs", providerId: "noaa-goes", sourceName: "noaa-goes19-world", batchId: "b".repeat(64) });
});
