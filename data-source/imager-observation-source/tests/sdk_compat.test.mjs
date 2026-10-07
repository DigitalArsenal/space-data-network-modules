// data-source/imager-observation-source SDK-compat tests: the compiled wasm in the SDK browser harness, its node config
// stubbed through plugin.getConfig, select_files fed REAL S3 ListObjectsV2 listings of NOAA's public GOES-19 bucket
// (tests/fixtures, fetched 2026-10-07 for the 2026-280 06 UTC folders).

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

test("plan: one listing per (satellite, product folder) of the frame hour, with its list job", async (t) => {
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
  assert.deepEqual(cmipf, { satellite: "goes-east", sensor: "GOES-19 ABI", bucket: "noaa-goes19", prefix: "ABI-L2-CMIPF/2026/280/06/",
    frame_time_ms: FRAME_MS, widths: "4096,2048,1024", fields: "reflectance_064um,brightness_temperature_10um" });
});

test("plan: without a set frame time, the latest hour imager_lag_minutes old (the node's clock)", async (t) => {
  const { harness } = await createHarness(t, { imager_satellites: "goes-west", imager_fields: "cloud_top_height", imager_lag_minutes: 20 });
  const before = Date.now();
  const jobs = framesOn(await harness.invoke({ methodId: "plan", inputs: [tick()] }), "jobs");
  const want = Math.floor((before - 20 * 60000) / 3600000) * 3600000;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].frame_time_ms === want || jobs[0].frame_time_ms === want + 3600000, `${jobs[0].frame_time_ms} vs ${want}`);
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
  const { harness } = await createHarness(t);
  const batched = await harness.invoke({ methodId: "plan", inputs: [tick(), tick()] });
  assert.equal(batched.errorCode, "batched-input-frames");
});

test("select_files: the hour's first scan of each field from real listings; the 143 MB band as three byte ranges; one file per invocation", async (t) => {
  const { harness } = await createHarness(t, {});
  const listJob = (product, fields) => ({ satellite: "goes-east", sensor: "GOES-19 ABI", bucket: "noaa-goes19", prefix: `${product}/2026/280/06/`,
    frame_time_ms: FRAME_MS, widths: "4096,2048,1024", fields });
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    jsonInput("list_jobs", listJob("ABI-L2-CMIPF", "reflectance_064um,brightness_temperature_10um")),
    jsonInput("list_jobs", listJob("ABI-L2-ACHA2KMF", "cloud_top_height")),
    bytesInput("listings", rawResponseFrame(CMIPF_LISTING)),
    bytesInput("listings", rawResponseFrame(ACHA_LISTING)),
  ] });
  const requests = framesOn(response, "requests");
  const jobs = framesOn(response, "jobs");
  assert.equal(framesOn(response, "status").length, 0, "nothing missing");
  // first: reflectance, band 2, 142 635 609 bytes > 64 MiB -> three ranges covering the file exactly
  const key = "ABI-L2-CMIPF/2026/280/06/OR_ABI-L2-CMIPF-M6C02_G19_s20262800600212_e20262800609520_c20262800609576.nc";
  assert.equal(requests.length, 3);
  assert.deepEqual(jobs.map((j) => [j.key, j.field, j.variable, j.part, j.parts]), [0, 1, 2].map((p) => [key, "reflectance_064um", "CMI", p, 3]));
  const ranges = requests.map((r) => r.headers.Range.match(/^bytes=(\d+)-(\d+)$/).slice(1).map(Number));
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges[2][1], 142635609 - 1);
  for (let p = 1; p < 3; p++) assert.equal(ranges[p][0], ranges[p - 1][1] + 1, "contiguous");
  for (const [a, b] of ranges) assert.ok(b - a + 1 <= 64 * 1024 * 1024);
  for (const r of requests) {
    assert.equal(r.url, `https://noaa-goes19.s3.amazonaws.com/${key}`);
    assert.equal(r.headers["If-Modified-Since"], NO_VALIDATORS, "a second range must never come back 304");
    assert.equal(r.timeoutMs, 300000);
  }
  assert.equal(jobs[0].frame_time_ms, FRAME_MS);
  assert.equal(jobs[0].sensor, "GOES-19 ABI");
  assert.equal(jobs[0].license_class, "OpenAttribution");
  assert.equal(jobs[0].source_name, "noaa-goes19-world");
  assert.match(jobs[0].citation, /courtesy of NOAA/);
});

test("select_files: a field missing from its listing, or a failed listing, is reported, not invented", async (t) => {
  const { harness } = await createHarness(t, {});
  const listJob = (product, fields, hour = "06") => ({ satellite: "goes-east", sensor: "GOES-19 ABI", bucket: "noaa-goes19",
    prefix: `${product}/2026/280/${hour}/`, frame_time_ms: FRAME_MS, widths: "4096", fields });
  const response = await harness.invoke({ methodId: "select_files", inputs: [
    jsonInput("list_jobs", listJob("ABI-L2-ACHA2KMF", "cloud_top_height")),
    jsonInput("list_jobs", listJob("ABI-L2-ACMF", "cloud_mask")),
    bytesInput("listings", rawResponseFrame(encoder.encode('<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>'))),
    bytesInput("listings", rawResponseFrame(encoder.encode("<Error><Code>SlowDown</Code></Error>"), 503)),
  ] });
  const status = framesOn(response, "status");
  assert.deepEqual(status, [{ missing: [   // (in list-job order)
    { field: "cloud_top_height", satellite: "goes-east", prefix: "ABI-L2-ACHA2KMF/2026/280/06/" },
    { listing: "noaa-goes19/ABI-L2-ACMF/2026/280/06/", http_status: 503 },
  ] }]);
  assert.equal(framesOn(response, "requests").length, 0);
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
