// data-source/weathernext-source SDK-compat tests: the request-builder nodes
// run in the gate-free hostcall-bridge harness with hostcall stubs answering
// plugin.getConfig and secrets.get, and every emitted frame is asserted:
// nothing leaves the node while weathernext_live_access is false (and
// secrets.get is never called), the fan-out is exactly arrays x leads x
// chunks with the grid/chunk fields and the one-hour licence rule, the bearer
// token rides ONLY the request frames, refresh-token is refused by name, an
// empty store path fails closed, and publish_request emits nothing without
// weathernext_publish_url.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
// The SDK browser harness gates on runtimeTargets and this artifact is
// WasmEdge-only (secrets.* has no browser host), so the direct invocations run
// through the repo's gate-free sync hostcall-bridge harness: the same
// plugin_invoke_stream ABI and hostcall wire the WasmEdge host speaks, with
// Node standing in for that leg.
import { createSdkBrowserShimHarness } from "../../../tests/lib/sdkBrowserShimHarness.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BASE_URL = "https://storage.googleapis.com/weathernext3_spatial";
const HISTORICAL_URL = "https://creativecommons.org/licenses/by/4.0/";
const REALTIME_URL = "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
const TOKEN = "ya29.test-access-token";

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength.
function jsonInput(portId, value) {
  const payload = encoder.encode(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function tickInput() {
  return jsonInput("tick", { firedAt: "2026-09-03T12:00:00Z" });
}

// Hostcall stub: plugin.getConfig answers the node config, secrets.get the
// stored credential; every call is recorded with its parameters.
function createHostStub({ config = {}, secret = TOKEN, secretsOk = true } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (operation === "plugin.getConfig") return config;
    if (operation === "secrets.get") {
      if (!secretsOk) throw new Error("secrets lane not approved");
      return { id: params.id, username: "operator@example.test", secret };
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createSdkBrowserShimHarness({
    wasmSource: readWasm(),
    surface: "direct",
    dispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function framesByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) {
    if (!map.has(frame.portId)) map.set(frame.portId, []);
    map.get(frame.portId).push(JSON.parse(decoder.decode(frame.payload)));
  }
  return map;
}

function secretsCalls(stub) {
  return stub.calls.filter((call) => call.operation === "secrets.get");
}

const LIVE_CONFIG = {
  weathernext_live_access: true,
  weathernext_auth_mode: "none",
  weathernext_store_path: "wn3",
  weathernext_init_time: "2026-09-02T00:00:00Z",
};

test("weathernext-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("weathernext-source imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  const manifest = readManifest();
  assert.deepEqual(manifest.runtimeTargets, ["wasmedge"], "secrets.* has no browser host");
  assert.deepEqual(manifest.capabilities, ["secrets:gcp-weathernext"]);
});

test("plan: live access OFF (the default) emits no request, no job and never touches secrets", async (t) => {
  const stub = createHostStub({ config: {} });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  assert.equal(outputs.has("requests"), false);
  assert.equal(outputs.has("jobs"), false);
  assert.deepEqual(outputs.get("status"), [{ skipped: "live-access-disabled" }]);
  assert.equal(secretsCalls(stub).length, 0, "no credential is read while the switch is off");
  assert.deepEqual(stub.calls.map((call) => call.operation), ["plugin.getConfig"]);
});

test("plan: an explicit false switch behaves like the default", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false, weathernext_auth_mode: "bearer" } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0);
  assert.deepEqual(framesByPort(response).get("status"), [{ skipped: "live-access-disabled" }]);
  assert.equal(secretsCalls(stub).length, 0);
});

test("plan: live + auth none fans out arrays x leads x chunks with grid fields and the 1 h licence rule", async (t) => {
  const stub = createHostStub({
    config: {
      ...LIVE_CONFIG,
      weathernext_lead_hours: "6,12",
      weathernext_chunks: "14,7;28,7",
    },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  const requests = outputs.get("requests");
  const jobs = outputs.get("jobs");
  assert.equal(requests.length, 3 * 2 * 2, "3 arrays x 2 leads x 2 chunks");
  assert.equal(jobs.length, requests.length, "one job per request, positionally");
  assert.equal(outputs.has("status"), false);
  assert.equal(secretsCalls(stub).length, 0, "auth none never reads a credential");

  const expectedUrls = [];
  for (const array of ["low_cloud_cover", "medium_cloud_cover", "high_cloud_cover"]) {
    for (const lead of [6, 12]) {
      for (const [lat, lon] of [[14, 7], [28, 7]]) {
        expectedUrls.push(`${BASE_URL}/wn3/${array}/c/0/0/${lead}/${lat}/${lon}`);
      }
    }
  }
  assert.deepEqual(requests.map((request) => request.url), expectedUrls, "array outer, lead middle, chunk inner");
  for (let k = 0; k < requests.length; k++) {
    const request = requests[k];
    const job = jobs[k];
    assert.equal(request.method, "GET");
    assert.equal(request.timeoutMs, 90000);
    assert.equal(request.responseWire, "raw-body-v1");
    assert.equal(request.headers, undefined, "auth none: no authorization header");
    assert.equal(job.source_url, request.url);
    assert.equal(job.source_name, "weathernext3-clouds-0p1deg");
    assert.equal(job.provider_id, "weathernext");
    assert.equal(job.variable_name, job.array);
    assert.equal(job.model_id, "weathernext-3");
    assert.equal(job.model_class, "MachineLearnedGlobalEnsemble");
    assert.equal(job.init_time_ms, Date.UTC(2026, 8, 2, 0, 0, 0));
    assert.equal(job.horizon_hours, 360);
    assert.equal(job.member_kind, "Member");
    assert.equal(job.member_index, 0);
    assert.equal(job.ensemble_size, 64);
    assert.equal(job.dtype, "float32");
    assert.deepEqual(job.codecs, ["bytes"]);
    assert.deepEqual(job.chunk_shape, [1, 1, 1, 64, 64]);
    assert.deepEqual(job.dims, ["init_time", "member", "lead_time", "latitude", "longitude"]);
    assert.deepEqual(job.grid, { lat0: 90, lon0: 0, dlat: -0.1, dlon: 0.1, nlat: 1801, nlon: 3600, periodic_lon: true });
    assert.deepEqual(job.chunk_index, [0, 0, job.lead_hours, ...request.url.split("/").slice(-2).map(Number)]);
    assert.equal(job.origin_id, "storage.googleapis.com");
    assert.equal(job.dataset_id, "weathernext3_spatial");
    // init 2026-09-02T00Z + 6/12 h is far more than one hour old -> Historical.
    assert.equal(job.license_class, "Historical");
    assert.equal(job.license_url, HISTORICAL_URL);
    assert.equal(job.citation, "");
  }
});

test("plan: a run whose valid time is less than one hour old is RealTimeExperimental", async (t) => {
  const stub = createHostStub({
    config: { ...LIVE_CONFIG, weathernext_init_time: "2035-01-01T00:00:00Z", weathernext_arrays: "low_cloud_cover" },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const jobs = framesByPort(response).get("jobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].license_class, "RealTimeExperimental");
  assert.equal(jobs[0].license_url, REALTIME_URL);
  assert.equal(jobs[0].init_time_ms, Date.UTC(2035, 0, 1, 0, 0, 0));
});

test("plan: bearer mode reads the lane once and puts the token ONLY on request frames", async (t) => {
  const stub = createHostStub({
    config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_chunks: "14,7;15,7" },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const calls = secretsCalls(stub);
  assert.equal(calls.length, 1, "one secrets.get per plan, not per request");
  assert.deepEqual(calls[0].params, { id: "gcp-weathernext" });
  const outputs = framesByPort(response);
  const requests = outputs.get("requests");
  assert.equal(requests.length, 6);
  for (const request of requests) {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  }
  for (const job of outputs.get("jobs")) {
    assert.equal(JSON.stringify(job).includes(TOKEN), false, "a job frame never carries the credential");
  }
});

test("plan: bearer mode honours a custom secrets lane", async (t) => {
  const stub = createHostStub({
    config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_secrets_lane: "gcp-weathernext-staging" },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0);
  assert.deepEqual(secretsCalls(stub)[0].params, { id: "gcp-weathernext-staging" });
});

test("plan: bearer mode with no stored credential fails closed", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer" }, secretsOk: false });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "credential-unavailable");
  assert.equal(response.outputs.length, 0, "no request leaves without its credential");
});

test("plan: refresh-token auth is reserved and refused by name", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "refresh-token" } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "auth-mode-unsupported");
  assert.equal(secretsCalls(stub).length, 0);
  assert.equal(response.outputs.length, 0);
});

test("plan: live access with an empty store path is store-path-missing", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_store_path: "" } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "store-path-missing");
  assert.equal(response.outputs.length, 0);
});

test("plan: base URL, chunk extents, codecs and grid overrides reach the frames", async (t) => {
  const stub = createHostStub({
    config: {
      ...LIVE_CONFIG,
      weathernext_gcs_base_url: "http://fixture.local",
      weathernext_arrays: "total_cloud_cover",
      weathernext_lead_hours: "3",
      weathernext_lead_step_hours: 3,
      weathernext_chunks: "0,0",
      weathernext_chunk_lat: 32,
      weathernext_chunk_lon: 128,
      weathernext_codecs: "bytes,zstd",
      weathernext_dtype: "float16",
      weathernext_grid_dlat: -0.25,
      weathernext_grid_dlon: 0.25,
      weathernext_grid_nlat: 721,
      weathernext_grid_nlon: 1440,
      weathernext_member_index: 5,
      weathernext_init_index: 2,
      weathernext_http_timeout_ms: 5000,
      weathernext_provider_id: "prov-test",
      weathernext_citation: "Forecast data (CC BY 4.0)",
    },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  const [request] = outputs.get("requests");
  const [job] = outputs.get("jobs");
  assert.equal(request.url, "http://fixture.local/wn3/total_cloud_cover/c/2/5/1/0/0", "lead_index = 3 h / 3 h");
  assert.equal(request.timeoutMs, 5000);
  assert.deepEqual(job.chunk_shape, [1, 1, 1, 32, 128]);
  assert.deepEqual(job.chunk_index, [2, 5, 1, 0, 0]);
  assert.deepEqual(job.codecs, ["bytes", "zstd"]);
  assert.equal(job.dtype, "float16");
  assert.equal(job.member_index, 5);
  assert.equal(job.lead_hours, 3);
  assert.deepEqual(job.grid, { lat0: 90, lon0: 0, dlat: -0.25, dlon: 0.25, nlat: 721, nlon: 1440, periodic_lon: true });
  assert.equal(job.provider_id, "prov-test");
  assert.equal(job.citation, "Forecast data (CC BY 4.0)");
});

test("cyclone_request: live OFF and missing URL each yield a status frame", async (t) => {
  const off = createHostStub({ config: {} });
  const offResponse = await (await createHarness(t, off)).invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(offResponse.statusCode, 0);
  assert.deepEqual(framesByPort(offResponse).get("status"), [{ skipped: "live-access-disabled" }]);
  assert.equal(secretsCalls(off).length, 0);

  const noUrl = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer" } });
  const noUrlResponse = await (await createHarness(t, noUrl)).invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(noUrlResponse.statusCode, 0);
  const outputs = framesByPort(noUrlResponse);
  assert.deepEqual(outputs.get("status"), [{ skipped: "cyclone-url-missing" }]);
  assert.equal(outputs.has("request"), false);
  assert.equal(secretsCalls(noUrl).length, 0, "no URL, no credential read");
});

test("cyclone_request: emits the CSV fetch (default JSON lane) + job, bearer on the request only", async (t) => {
  const url = "https://storage.googleapis.com/weathernext3_spatial/cyclones/cyclone-tracks.csv";
  const stub = createHostStub({
    config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_cyclone_url: url },
  });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  const [request] = outputs.get("request");
  const [job] = outputs.get("job");
  assert.equal(request.method, "GET");
  assert.equal(request.url, url);
  assert.equal(request.responseWire, undefined, "cyclone lane uses the JSON/bodyB64 response");
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(secretsCalls(stub).length, 1);
  assert.equal(JSON.stringify(job).includes(TOKEN), false);
  assert.equal(job.source_url, url);
  assert.equal(job.source_name, "weathernext3-cyclone-tracks");
  assert.equal(job.archive_source, "weathernext");
  assert.equal(job.archive_name, "cyclone-tracks.csv");
  assert.equal(job.model_id, "weathernext-3");
  assert.equal(job.model_class, "MachineLearnedGlobalEnsemble");
  assert.equal(job.ensemble_size, 64);
  assert.equal(job.wind_averaging_period_s, 60);
  assert.equal(job.license_class, "Historical");
  assert.equal(job.origin_id, "storage.googleapis.com");
  assert.equal(job.dataset_id, "weathernext3_spatial");
});

// --------------------------------------------------------------------------
// publish_request (dataset-publication trigger).
// --------------------------------------------------------------------------

const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

function ingestResultInput({ schema = "WXF.fbs", batch_id = "b".repeat(64) } = {}) {
  return jsonInput("result", { schema, inserted: 3, batch_id, reconciled_duplicates: 0, archived: false });
}

function ingestMetaInput({ schema = "WXF.fbs", batch_id = "b".repeat(64), provider_id = "weathernext", source_name = "weathernext3-clouds-0p1deg" } = {}) {
  return jsonInput("meta", { schema, batch_id, provider_id, source_name });
}

test("publish_request emits NOTHING when no weathernext_publish_url is configured", async (t) => {
  const stub = createHostStub({ config: {} });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput(), ingestMetaInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 0, "absence of config is not permission to publish");
});

test("publish_request builds the camelCase DatasetPublicationRequest POST", async (t) => {
  const stub = createHostStub({ config: { weathernext_publish_url: PUBLISH_URL } });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput(), ingestMetaInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [request] = framesByPort(response).get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(body).sort(), ["batchId", "providerId", "schema", "sourceName"]);
  assert.deepEqual(body, { schema: "WXF.fbs", providerId: "weathernext", sourceName: "weathernext3-clouds-0p1deg", batchId: "b".repeat(64) });
});

test("publish_request requires BOTH frames and a complete identity", async (t) => {
  const stub = createHostStub({ config: { weathernext_publish_url: PUBLISH_URL } });
  const harness = await createHarness(t, stub);
  assert.equal((await harness.invoke({ methodId: "publish_request", inputs: [ingestResultInput()] })).statusCode, 400);
  assert.equal((await harness.invoke({ methodId: "publish_request", inputs: [ingestMetaInput()] })).statusCode, 400);
  const incomplete = await harness.invoke({
    methodId: "publish_request",
    inputs: [ingestResultInput(), jsonInput("meta", { schema: "WXF.fbs", batch_id: "b".repeat(64), provider_id: "" })],
  });
  assert.equal(incomplete.statusCode, 400);
});
