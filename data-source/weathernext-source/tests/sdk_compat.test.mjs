// data-source/weathernext-source on the typed contracts (1.0): a TimerTick in; HttpRequests whose CONTEXT is the
// parse job as a size-prefixed SDS header record ($WXF per cloud chunk, $TCT for the cyclone tracks), Skipped
// FlowNotices, and the dataset-publication POST from an IngestResult + IngestRequest out. Host calls are SDS $PIV
// invocations: plugin.getConfig (one ModuleConfig on raw "config") and, in bearer mode, secrets.get (raw "secret").
//
// Asserted: nothing leaves the node while weathernext_live_access is false (and secrets.get is never called), the
// fan-out is exactly arrays x leads x chunks with the tile geometry and the one-hour licence rule in each CONTEXT,
// the bearer token rides ONLY the request HEADERS (never a CONTEXT), refresh-token is refused by name, an empty
// store path fails closed, a chunk outside the grid is refused, and publish_request emits nothing without
// weathernext_publish_url or for a REFUSED batch.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpRequest,
  decodeIngestResult,
  encodeFlowNotice,
  encodeHostCallResult,
  encodeIngestRequest,
  encodeIngestResult,
  encodeModuleConfig,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
// The SDK browser harness gates on runtimeTargets and this artifact is WasmEdge-only (secrets.* has no browser host),
// so the direct invocations run through the repo's gate-free sync hostcall-bridge harness: the same
// plugin_invoke_stream ABI and typed hostcall bridge the WasmEdge host speaks, with Node standing in for that leg.
import { createSdkBrowserShimHarness } from "../../../tests/lib/sdkBrowserShimHarness.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const TCT_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/TCT/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);
const tctLib = await import(TCT_LIB.href);

const BASE_URL = "https://storage.googleapis.com/weathernext3_spatial";
const HISTORICAL_URL = "https://creativecommons.org/licenses/by/4.0/";
const REALTIME_URL = "https://storage.googleapis.com/weathernext-public/terms-of-use.pdf";
const TOKEN = "ya29.test-access-token";
const RUNTIME = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
};

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
const tickInput = () => ({ portId: "tick", typeRef: RUNTIME.TICK, payload: encodeTimerTick({ triggerId: "timer-weathernext", firedMs: Date.UTC(2026, 8, 3, 12) }) });

// Host stub. The node's artifact targets wasmedge only, so it runs in the repo's shared shim harness
// (tests/lib/sdkBrowserShimHarness.mjs), whose typed bridge is the repo root's SDK, not this module's 0.9.2. The hostcall
// import is therefore wrapped: plugin.getConfig is answered here as the Go node answers it - one ModuleConfig on raw
// "config" (encodeModuleConfig) - and secrets.get with its SecretResult and raw "secret"; every $PIV request is decoded
// into `wire`, anything else falls through to the bridge (and fails: this node makes no other call).
function createHostStub({ config = {}, secret = TOKEN, secretsOk = true } = {}) {
  const wire = [];
  const answer = (call) => {
    if (call.op === "plugin.getConfig") return encodeHostCallResult({ ok: true, op: call.op, raw: { config: encodeModuleConfig(config) } });
    if (call.op === "secrets.get") {
      if (!secretsOk) return encodeHostCallResult({ ok: false, error: { code: "not-authorized", message: "secrets lane not approved" } });
      return encodeHostCallResult({ ok: true, op: call.op, result: { ID: call.params.ID, USERNAME: "operator@example.test", CONFIGURED: true }, raw: { secret } });
    }
    return null;
  };
  const dispatch = (operation) => { throw new Error(`unexpected hostcall operation: ${operation}`); };
  return { wire, answer, dispatch, ops: () => wire.map((c) => c.op), secrets: () => wire.filter((c) => c.op === "secrets.get") };
}

const instantiate = WebAssembly.instantiate;
async function createHarness(t, stub) {
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    let pending = null;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        stub.wire.push(call);
        pending = stub.answer(call);
        return pending ? 0 : host.call(op, opLen, ptr, len);
      },
      response_len: () => (pending ? pending.length : host.response_len()),
      read_response: (dst, len) => {
        if (!pending) return host.read_response(dst, len);
        const n = Math.min(len, pending.length);
        new Uint8Array(memory.buffer).set(pending.subarray(0, n), dst);
        return n;
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  t.after(() => { WebAssembly.instantiate = instantiate; });
  const harness = await createSdkBrowserShimHarness({ wasmSource: readWasm(), surface: "direct", dispatch: stub.dispatch });
  t.after(() => harness.destroy());
  return harness;
}

function framesByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) {
    if (!map.has(frame.portId)) map.set(frame.portId, []);
    const id = new TextDecoder().decode(frame.payload.subarray(4, 8));
    map.get(frame.portId).push(id === "HREQ" ? decodeHttpRequest(frame.payload) : id === "FNTC" ? decodeFlowNotice(frame.payload) : frame.payload);
  }
  return map;
}
const sizePrefixed = (bytes) => {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  assert.equal(len + 4, bytes.length, "one size-prefixed record");
  return new flatbuffers.ByteBuffer(Uint8Array.from(bytes.subarray(4)));
};
const wxfJob = (context) => wxfLib.WXF.getRootAsWXF(sizePrefixed(context)).unpack();
const tctJob = (context) => tctLib.TCT.getRootAsTCT(sizePrefixed(context)).unpack();

const LIVE_CONFIG = {
  weathernext_live_access: true,
  weathernext_auth_mode: "none",
  weathernext_store_path: "wn3",
  weathernext_init_time: "2026-09-02T00:00:00Z",
};
const INIT_MS = Date.UTC(2026, 8, 2, 0, 0, 0);

test("weathernext-source artifact passes SDK compliance with typed ports only", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of readManifest().methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(type.wireFormat, "flatbuffer", port.portId);
      assert.equal(port.acceptedTypeSets[0].wildcardJustification, undefined, port.portId);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "plan.tick": "TICK", "plan.requests": "HREQ", "plan.status": "FNTC",
    "cyclone_request.tick": "TICK", "cyclone_request.request": "HREQ", "cyclone_request.status": "FNTC",
    "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.request": "HREQ",
  });
});

test("weathernext-source imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
  assert.deepEqual(readManifest().runtimeTargets, ["wasmedge"], "secrets.* has no browser host");
  assert.deepEqual(readManifest().capabilities, ["secrets:gcp-weathernext"]);
});

test("plan: live access OFF (the default) emits no request and never touches secrets: one Skipped notice", async (t) => {
  const stub = createHostStub({ config: {} });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  assert.equal(outputs.has("requests"), false);
  assert.deepEqual(outputs.get("status"), [{ kind: "skipped", schema: "WXF.fbs", providerId: "weathernext", sourceName: "weathernext3-clouds-0p1deg", batchId: "", count: 0, reason: "live-access-disabled", items: [], atMs: 0 }]);
  assert.deepEqual(stub.ops(), ["plugin.getConfig"], "no credential is read while the switch is off");
});

test("plan: an explicit false switch behaves like the default", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_live_access: false, weathernext_auth_mode: "bearer" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0);
  assert.equal(framesByPort(response).get("status")[0].reason, "live-access-disabled");
  assert.equal(stub.secrets().length, 0);
});

test("plan: live + auth none fans out arrays x leads x chunks, each GET carrying its $WXF job header in CONTEXT", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_lead_hours: "6,12", weathernext_chunks: "14,7;28,7" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const outputs = framesByPort(response);
  const requests = outputs.get("requests");
  assert.equal(requests.length, 3 * 2 * 2, "3 arrays x 2 leads x 2 chunks");
  assert.equal(outputs.has("status"), false);
  assert.equal(stub.secrets().length, 0, "auth none never reads a credential");

  const expectedUrls = [];
  for (const array of ["low_cloud_cover", "medium_cloud_cover", "high_cloud_cover"]) {
    for (const lead of [6, 12]) for (const [lat, lon] of [[14, 7], [28, 7]]) expectedUrls.push(`${BASE_URL}/wn3/${array}/c/0/0/${lead}/${lat}/${lon}`);
  }
  assert.deepEqual(requests.map((r) => r.url), expectedUrls, "array outer, lead middle, chunk inner");
  const variables = { low_cloud_cover: 14, medium_cloud_cover: 13, high_cloud_cover: 12 };
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.timeoutMs, 90000);
    assert.deepEqual(request.headers, {}, "auth none: no authorization header");
    const job = wxfJob(request.context);
    const [array, , , , lead, lat] = request.url.slice(BASE_URL.length + 5).split("/");
    assert.equal(job.SOURCE_URL, request.url);
    assert.equal(job.VARIABLE_NAME, array);
    assert.equal(job.VARIABLE, variables[array]);
    assert.equal(job.FIELD_ID, `weathernext-3|2026-09-02T00:00:00Z|Member0|${array}|${lead}h`);
    assert.equal(job.MODEL_ID, "weathernext-3");
    assert.equal(job.MODEL_VERSION, "");
    assert.equal(job.MODEL_CLASS, 1, "MachineLearnedGlobalEnsemble");
    assert.equal(Number(job.INIT_TIME_MS), INIT_MS);
    assert.equal(job.LEAD_HOURS, Number(lead));
    assert.equal(Number(job.VALID_TIME_MS), INIT_MS + Number(lead) * 3600000);
    assert.equal(job.HORIZON_HOURS, 360);
    assert.equal(job.MEMBER_KIND, 0, "Member");
    assert.equal(job.MEMBER_INDEX, 0);
    assert.equal(job.ENSEMBLE_SIZE, 64);
    assert.equal(job.CHUNK_DTYPE, "float32");
    assert.deepEqual(job.CHUNK_CODECS, ["bytes"]);
    // the tile on the 1801 x 3600 grid at 64 x 64: 57 columns of tiles, 29 rows
    assert.equal(job.TILE_COUNT, 29 * 57);
    assert.equal(job.TILE_INDEX, Number(lat) * 57 + 7);
    assert.equal(job.GRID.NLAT, lat === "28" ? 1801 - 28 * 64 : 64);
    assert.equal(job.GRID.NLON, 64);
    assert.equal(job.GRID.LAT0, 90 + Number(lat) * 64 * -0.1);
    assert.equal(job.GRID.LON0, 0 + 7 * 64 * 0.1);
    assert.equal(job.GRID.DLAT, -0.1);
    assert.equal(job.GRID.DLON, 0.1);
    assert.equal(job.GRID.PERIODIC_LON, false);
    assert.equal(job.VALUES.length, 0, "a header: no samples");
    assert.equal(job.ORIGIN_ID, "storage.googleapis.com");
    assert.equal(job.DATASET_ID, "weathernext3_spatial");
    // init 2026-09-02T00Z + 6/12 h is far more than one hour old -> Historical.
    assert.equal(job.LICENSE_CLASS, 1, "Historical");
    assert.equal(job.LICENSE_URL, HISTORICAL_URL);
    assert.equal(job.CITATION, "");
  }
});

test("plan: a run whose valid time is less than one hour old is RealTimeExperimental", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_init_time: "2035-01-01T00:00:00Z", weathernext_arrays: "low_cloud_cover" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const requests = framesByPort(response).get("requests");
  assert.equal(requests.length, 1);
  const job = wxfJob(requests[0].context);
  assert.equal(job.LICENSE_CLASS, 0, "RealTimeExperimental");
  assert.equal(job.LICENSE_URL, REALTIME_URL);
  assert.equal(Number(job.INIT_TIME_MS), Date.UTC(2035, 0, 1, 0, 0, 0));
});

test("plan: bearer mode reads the lane once and puts the token ONLY in the request HEADERS", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_chunks: "14,7;15,7" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const calls = stub.secrets();
  assert.equal(calls.length, 1, "one secrets.get per plan, not per request");
  assert.equal(calls[0].params.ID, "gcp-weathernext");
  const requests = framesByPort(response).get("requests");
  assert.equal(requests.length, 6);
  for (const request of requests) {
    assert.deepEqual(request.headers, { authorization: `Bearer ${TOKEN}` });
    assert.equal(Buffer.from(request.context).includes(TOKEN), false, "a CONTEXT record never carries the credential");
  }
});

test("plan: bearer mode honours a custom secrets lane, and an unapproved lane fails closed", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_secrets_lane: "gcp-weathernext-staging" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0);
  assert.equal(stub.secrets()[0].params.ID, "gcp-weathernext-staging");

  const denied = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer" }, secretsOk: false });
  const refused = await (await createHarness(t, denied)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.notEqual(refused.statusCode, 0);
  assert.equal(refused.errorCode, "credential-unavailable");
  assert.equal(refused.outputs.length, 0, "no request leaves without its credential");
});

test("plan: refresh-token auth is reserved and refused by name; an empty store path is store-path-missing", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "refresh-token" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.errorCode, "auth-mode-unsupported");
  assert.equal(stub.secrets().length, 0);
  assert.equal(response.outputs.length, 0);

  const empty = await (await createHarness(t, createHostStub({ config: { ...LIVE_CONFIG, weathernext_store_path: "" } }))).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(empty.errorCode, "store-path-missing");
  assert.equal(empty.outputs.length, 0);
});

test("plan: a chunk outside the declared grid is refused before any request leaves", async (t) => {
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_chunks: "14,7;29,7" } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 400);
  assert.equal(response.errorCode, "chunk-index-invalid");
  assert.equal(response.outputs.length, 0);
});

test("plan: base URL, chunk extents, codecs and grid overrides reach the frames (numbers, lists as dotted entries)", async (t) => {
  const stub = createHostStub({
    config: {
      ...LIVE_CONFIG,
      weathernext_gcs_base_url: "http://fixture.local",
      weathernext_arrays: ["total_cloud_cover"],
      weathernext_lead_hours: 3,
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
      weathernext_citation: "Forecast data (CC BY 4.0)",
    },
  });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "plan", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const [request] = framesByPort(response).get("requests");
  assert.equal(request.url, "http://fixture.local/wn3/total_cloud_cover/c/2/5/1/0/0", "lead_index = 3 h / 3 h");
  assert.equal(request.timeoutMs, 5000);
  const job = wxfJob(request.context);
  assert.deepEqual(job.CHUNK_CODECS, ["bytes", "zstd"]);
  assert.equal(job.CHUNK_DTYPE, "float16");
  assert.equal(job.MEMBER_INDEX, 5);
  assert.equal(job.LEAD_HOURS, 3);
  assert.equal(job.VARIABLE, 11, "TotalCloudCover");
  assert.equal(job.FIELD_ID, "weathernext-3|2026-09-02T00:00:00Z|Member5|total_cloud_cover|3h");
  assert.deepEqual([job.GRID.NLAT, job.GRID.NLON, job.GRID.LAT0, job.GRID.LON0, job.GRID.DLAT, job.GRID.DLON], [32, 128, 90, 0, -0.25, 0.25]);
  assert.deepEqual([job.TILE_INDEX, job.TILE_COUNT], [0, Math.ceil(721 / 32) * Math.ceil(1440 / 128)]);
  assert.equal(job.CITATION, "Forecast data (CC BY 4.0)");
});

test("cyclone_request: live OFF and missing URL each yield a Skipped notice", async (t) => {
  const off = createHostStub({ config: {} });
  const offResponse = await (await createHarness(t, off)).invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(offResponse.statusCode, 0);
  const [offNotice] = framesByPort(offResponse).get("status");
  assert.deepEqual([offNotice.kind, offNotice.schema, offNotice.sourceName, offNotice.reason], ["skipped", "TCT.fbs", "weathernext3-cyclone-tracks", "live-access-disabled"]);
  assert.equal(off.secrets().length, 0);

  const noUrl = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer" } });
  const noUrlResponse = await (await createHarness(t, noUrl)).invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(noUrlResponse.statusCode, 0);
  const outputs = framesByPort(noUrlResponse);
  assert.equal(outputs.get("status")[0].reason, "cyclone-url-missing");
  assert.equal(outputs.has("request"), false);
  assert.equal(noUrl.secrets().length, 0, "no URL, no credential read");
});

test("cyclone_request: the CSV GET with its $TCT job header in CONTEXT, bearer in HEADERS only", async (t) => {
  const url = "https://storage.googleapis.com/weathernext3_spatial/cyclones/cyclone-tracks.csv";
  const stub = createHostStub({ config: { ...LIVE_CONFIG, weathernext_auth_mode: "bearer", weathernext_cyclone_url: url } });
  const response = await (await createHarness(t, stub)).invoke({ methodId: "cyclone_request", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const [request] = framesByPort(response).get("request");
  assert.equal(request.method, "GET");
  assert.equal(request.url, url);
  assert.deepEqual(request.headers, { authorization: `Bearer ${TOKEN}` });
  assert.equal(stub.secrets().length, 1);
  assert.equal(Buffer.from(request.context).includes(TOKEN), false);
  const job = tctJob(request.context);
  assert.equal(job.STORM_ID, "");
  assert.equal(job.POINTS.length, 0, "a header: no points");
  assert.equal(job.SOURCE_URL, url);
  assert.equal(job.MODEL_ID, "weathernext-3");
  assert.equal(job.MODEL_CLASS, 1);
  assert.equal(job.ENSEMBLE_SIZE, 64);
  assert.equal(job.WIND_AVERAGING_PERIOD_S, 60);
  assert.equal(job.LICENSE_CLASS, 1, "Historical");
  assert.equal(job.LICENSE_URL, HISTORICAL_URL);
  assert.equal(job.ORIGIN_ID, "storage.googleapis.com");
  assert.equal(job.DATASET_ID, "weathernext3_spatial");
});

// --------------------------------------------------------------------------
// publish_request (dataset-publication trigger).
// --------------------------------------------------------------------------

const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
const resultInput = (r = {}) => ({ portId: "result", typeRef: RUNTIME.INGR, payload: encodeIngestResult({ schema: "WXF.fbs", providerId: "weathernext", sourceName: "weathernext3-clouds-0p1deg", batchId: "b".repeat(64), inserted: 3, ...r }) });
const metaInput = (tags = {}) => ({ portId: "meta", typeRef: RUNTIME.INGQ, payload: encodeIngestRequest({ schema: "WXF.fbs", tags: { providerId: "weathernext", sourceName: "weathernext3-clouds-0p1deg", batchId: "b".repeat(64), ...tags } }) });

test("publish_request emits NOTHING when no weathernext_publish_url is configured", async (t) => {
  const response = await (await createHarness(t, createHostStub({ config: {} }))).invoke({ methodId: "publish_request", inputs: [resultInput(), metaInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 0, "absence of config is not permission to publish");
});

test("publish_request builds the dataset-publication POST as an HttpRequest whose BODY is the stored batch's IngestResult", async (t) => {
  const response = await (await createHarness(t, createHostStub({ config: { weathernext_publish_url: PUBLISH_URL } }))).invoke({ methodId: "publish_request", inputs: [resultInput(), metaInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [request] = framesByPort(response).get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.equal(request.timeoutMs, 90000);
  assert.deepEqual(request.headers, { "content-type": "application/octet-stream" });
  assert.equal(identifierOf(Uint8Array.from(request.body)), "INGR");
  assert.deepEqual(decodeIngestResult(Uint8Array.from(request.body)), { schema: "WXF.fbs", providerId: "weathernext", sourceName: "weathernext3-clouds-0p1deg", batchId: "b".repeat(64),
    inserted: 3, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "", refused: "" });
});

test("publish_request: a REFUSED batch publishes nothing; the result's schema / batch id win, the meta's fill in", async (t) => {
  const harness = await createHarness(t, createHostStub({ config: { weathernext_publish_url: PUBLISH_URL } }));
  const refused = await harness.invoke({ methodId: "publish_request", inputs: [resultInput({ refused: "refused: disk guardrail" }), metaInput()] });
  assert.equal(refused.statusCode, 0);
  assert.equal(refused.outputs.length, 0);
  const filled = await harness.invoke({ methodId: "publish_request", inputs: [resultInput({ schema: "", batchId: "" }), metaInput({ batchId: "c".repeat(64) })] });
  const body = decodeIngestResult(Uint8Array.from(framesByPort(filled).get("request")[0].body));
  assert.deepEqual([body.schema, body.batchId], ["WXF.fbs", "c".repeat(64)]);
});

test("publish_request requires BOTH frames, typed, and a complete identity", async (t) => {
  const harness = await createHarness(t, createHostStub({ config: { weathernext_publish_url: PUBLISH_URL } }));
  // (the SDK invoke glue refuses a missing required port before the module runs: missing-required-input)
  assert.match((await harness.invoke({ methodId: "publish_request", inputs: [resultInput()] })).errorCode, /^missing-(required-input|meta-frame)$/);
  assert.match((await harness.invoke({ methodId: "publish_request", inputs: [metaInput()] })).errorCode, /^missing-(required-input|result-frame)$/);
  const notResult = await harness.invoke({ methodId: "publish_request", inputs: [{ ...resultInput(), payload: encodeFlowNotice({ kind: "info" }) }, metaInput()] });
  assert.equal(notResult.errorCode, "invalid-result");
  const incomplete = await harness.invoke({ methodId: "publish_request", inputs: [resultInput(), metaInput({ providerId: "" })] });
  assert.equal(incomplete.statusCode, 400);
  assert.equal(incomplete.errorCode, "incomplete-publication-identity");
});
