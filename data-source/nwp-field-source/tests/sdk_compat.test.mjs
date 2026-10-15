// data-source/nwp-field-source SDK-compat tests on the typed contracts (1.0): the compiled wasm in the SDK browser
// harness, TimerTick / HttpResponse / IngestResult / IngestRequest frames in, HttpRequest / FlowNotice frames out, the job
// state a $WXF header record in HttpRequest.CONTEXT, and the node config the SDS $PIV plugin.getConfig answer
// (one ModuleConfig FlatBuffer on raw "config"). select_messages is fed REAL .idx inventories of NOAA's public GFS/GEFS buckets
// (tests/fixtures, the 2026-10-06 00 UTC run); the messages it must choose are re-derived here from the world-clouds
// reference fetchers' rules (Cesium_Weather tools/fetch-motion-wxf.mjs, fetch-model-clouds-wxf.mjs, fetch-gfs-wxf.mjs,
// fetch-gfs-profile-wxf.mjs).

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
  encodeHttpResponse,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);
const FIXTURES = new URL("./fixtures/", import.meta.url);
const NO_VALIDATORS = "Thu, 01 Jan 1970 00:00:00 GMT";
const encoder = new TextEncoder();
const RUN_MS = Date.UTC(2026, 9, 6, 0);

const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
};

const GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261006/00/atmos";
const GEFS = "https://noaa-gefs-pds.s3.amazonaws.com/gefs.20261006/00/atmos/pgrb2ap5";
const FILES = {
  "gfs-1p00-motion": { url: `${GFS}/gfs.t00z.pgrb2.1p00.f024`, idx: "gfs.t00z.pgrb2.1p00.f024.idx", lead: 24 },
  "gefs-0p50-spread": { url: `${GEFS}/gespr.t00z.pgrb2a.0p50.f024`, idx: "gespr.t00z.pgrb2a.0p50.f024.idx", lead: 24 },
  "gfs-0p50-clouds": { url: `${GFS}/gfs.t00z.pgrb2.0p50.f024`, idx: "gfs.t00z.pgrb2.0p50.f024.idx", lead: 24 },
  "gfs-0p25-physics": { url: `${GFS}/gfs.t00z.pgrb2.0p25.f000`, idx: "gfs.t00z.pgrb2.0p25.f000.idx", lead: 0 },
};
// What each product's job header must say (the parser cuts the records by it).
const JOB = {
  "gfs-1p00-motion": { modelKey: "gfs", modelId: "NCEP GFS 1°", modelClass: "NumericalGlobalDeterministic", deg: 1, bandRows: 0, tiles: 1, spread: false, ensemble: 0 },
  "gefs-0p50-spread": { modelKey: "gefs", modelId: "NCEP GEFS 0.5° (every other point)", modelClass: "NumericalGlobalEnsemble", deg: 1, bandRows: 0, tiles: 1, spread: true, ensemble: 31 },
  "gfs-0p50-clouds": { modelKey: "gfs", modelId: "NCEP GFS 0.5°", modelClass: "NumericalGlobalDeterministic", deg: 0.5, bandRows: 0, tiles: 1, spread: false, ensemble: 0 },
  "gfs-0p25-physics": { modelKey: "gfs", modelId: "NCEP GFS 0.25°", modelClass: "NumericalGlobalDeterministic", deg: 0.25, bandRows: 64, tiles: 1, spread: false, ensemble: 0 },
  "gfs-0p25-sea": { modelKey: "gfs", modelId: "NCEP GFS 0.25°", modelClass: "NumericalGlobalDeterministic", deg: 0.25, bandRows: 0, tiles: 512, spread: false, ensemble: 0 },
};

// The reference fetchers' choices
const MOTION = [1000, 925, 850, 700, 500, 400, 300, 250, 200].map((p) => `${p} mb`);
const PROFILE = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100].map((p) => `${p} mb`);
const instantaneous = (t) => t === "anl" || /^\d+ hour fcst$/.test(t);
const REFERENCE = {
  "gfs-1p00-motion": (v, l, t, lead) => MOTION.includes(l) && (v === "UGRD" || v === "VGRD" || (v === "HGT" && lead <= 12)) && instantaneous(t),
  "gefs-0p50-spread": (v, l, t) => MOTION.includes(l) && (v === "UGRD" || v === "VGRD") && instantaneous(t),
  "gfs-0p50-clouds": (v, l, t) => instantaneous(t) && ["TCDC:entire atmosphere", "LCDC:low cloud layer", "MCDC:middle cloud layer", "HCDC:high cloud layer"].includes(`${v}:${l}`),
  "gfs-0p25-physics": (v, l, t) => instantaneous(t) && (
    ["TMP:2 m above ground", "DPT:2 m above ground", "UGRD:10 m above ground", "VGRD:10 m above ground", "HPBL:surface", "CAPE:surface", "HGT:surface",
      "LCDC:low cloud layer", "MCDC:middle cloud layer", "HCDC:high cloud layer"].includes(`${v}:${l}`) ||
    (["TMP", "HGT", "UGRD", "VGRD", "RH", "VVEL"].includes(v) && PROFILE.includes(l)) || (["TMP", "HGT", "UGRD", "VGRD"].includes(v) && l === "tropopause")),
};
// the wanted messages of an inventory as byte ranges, adjacent ones merged (each under 64 MiB)
function referenceRanges(product, idxText, lead) {
  const rows = idxText.trim().split("\n").map((l) => l.split(":"));
  const ranges = [];
  rows.forEach((f, i) => {
    if (!REFERENCE[product](f[3], f[4], f[5], lead)) return;
    const a = Number(f[1]), b = i + 1 < rows.length ? Number(rows[i + 1][1]) - 1 : null;
    const last = ranges.at(-1);
    if (last && last[1] !== null && last[1] + 1 === a && (b === null || b - last[0] + 1 <= 64 * 1024 * 1024)) last[1] = b; else ranges.push([a, b]);
  });
  return { ranges, messages: rows.filter((f) => REFERENCE[product](f[3], f[4], f[5], lead)).length };
}

// ---- the job header ($WXF, size-prefixed) ------------------------------------------------------------------------

function readHeader(context) {
  assert.equal(identifierOf(context.subarray(4)), "$WXF", "CONTEXT is one size-prefixed $WXF record");
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4);
  return wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(context.subarray(4)))).unpack();
}
// A job header as plan builds it - for select_messages inputs that do not come from a plan invocation.
function header(product, url, lead) {
  const j = JOB[product];
  const b = new flatbuffers.Builder(512);
  const s = (v) => b.createString(v);
  const fieldId = s(`${j.modelKey}:20261006T00:f${String(lead).padStart(3, "0")}:${product}`), modelId = s(j.modelId), name = s(product), sourceUrl = s(url);
  const { WXF, WXFGrid } = wxfLib;
  WXFGrid.startWXFGrid(b);
  WXFGrid.addDlat(b, j.deg); WXFGrid.addDlon(b, j.deg); WXFGrid.addNlat(b, j.bandRows);
  const grid = WXFGrid.endWXFGrid(b);
  WXF.startWXF(b);
  WXF.addFieldId(b, fieldId); WXF.addModelId(b, modelId); WXF.addModelClass(b, wxfLib.wxfModelClass[j.modelClass]);
  WXF.addInitTimeMs(b, BigInt(RUN_MS)); WXF.addLeadHours(b, lead);
  WXF.addVariableName(b, name); WXF.addGrid(b, grid); WXF.addTileCount(b, j.tiles); WXF.addSourceUrl(b, sourceUrl);
  b.finishSizePrefixed(wxfLib.WXF.endWXF(b), "$WXF");
  return b.asUint8Array().slice();
}
function assertJobHeader(h, product, url, lead) {
  const j = JOB[product];
  assert.equal(h.FIELD_ID, `${j.modelKey}:20261006T00:f${String(lead).padStart(3, "0")}:${product}`);
  assert.equal(h.VARIABLE_NAME, product);
  assert.equal(h.MODEL_ID, j.modelId);
  assert.equal(h.MODEL_CLASS, wxfLib.wxfModelClass[j.modelClass]);
  assert.equal(h.TIME_BASIS, wxfLib.wxfTimeBasis.Initialization);
  assert.equal(Number(h.INIT_TIME_MS), RUN_MS);
  assert.equal(h.LEAD_HOURS, lead);
  assert.equal(Number(h.VALID_TIME_MS), RUN_MS + lead * 3600000);
  assert.equal(h.MEMBER_KIND, j.spread ? wxfLib.wxfMemberKind.StandardDeviation : wxfLib.wxfMemberKind.Unspecified);
  assert.equal(h.ENSEMBLE_SIZE, j.ensemble);
  assert.deepEqual([h.GRID.KIND, h.GRID.DLAT, h.GRID.DLON, h.GRID.NLAT], [wxfLib.wxfGridKind.RegularLatLon, j.deg, j.deg, j.bandRows]);
  assert.equal(h.TILE_COUNT, j.tiles);
  assert.equal(h.SOURCE_URL, url);
  assert.equal(h.ORIGIN_ID, "NOAA Open Data Dissemination (AWS)");
  assert.equal(h.DATASET_ID, new URL(url).hostname.split(".")[0]);
  assert.equal(h.LICENSE_CLASS, wxfLib.wxfLicenseClass.OpenAttribution);
  assert.equal(h.LICENSE_URL, "https://www.weather.gov/disclaimer");
  assert.match(h.CITATION, j.spread ? /ensemble standard deviation via NOAA Open Data Dissemination/ : /^NOAA\/NCEP Global Forecast System via/);
  assert.equal(h.VALUES_ENCODING, wxfLib.wxfValuesEncoding.InlineFloat32);
  assert.equal(h.VALUES.length + h.QUANTIZED_U8.length, 0, "a header: no values");
}

// ---- harness: the node config is the $PIV plugin.getConfig answer -----------------------------------------------

// The SDK harness's BrowserHost answers plugin.getConfig from its `config` option (one ModuleConfig on raw "config", as
// the Go node answers). The hostcall import is only watched here, to record each $PIV call the module makes.
async function createHarness(t, config = {}, surface = "direct") {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
      manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
      surface,
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-nwp", firedMs: Date.UTC(2026, 9, 6, 5) }) });
const inventory = (body, status, context) => ({ portId: "inventories", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: "x", status, body, context }) });
function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}
const requestsOn = (response, port = "requests") => ok(response).outputs.filter((f) => f.portId === port).map((f) => decodeHttpRequest(f.payload));
const noticesOn = (response) => ok(response).outputs.filter((f) => f.portId === "status").map((f) => decodeFlowNotice(f.payload));

test("nwp-field-source artifact passes SDK compliance with typed ports only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1);
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, { "plan.tick": "TICK", "plan.requests": "HREQ", "plan.status": "FNTC", "select_messages.inventories": "HRSP", "select_messages.requests": "HREQ",
    "select_messages.status": "FNTC", "publish_request.result": "INGR", "publish_request.meta": "INGQ", "publish_request.request": "HREQ" });
});

test("nwp-field-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

// A node drains a bounded number of invocations a trigger, so a run of tiled leads takes several ticks: a tick for the
// run already planned plans nothing again - it hands out the queued work, then reports "already-planned" - and the sea
// product's jobs carry its tile count.
test("plan: a tick for the run already planned hands out its queue, never plans it twice", async (t) => {
  const harness = await createHarness(t, { nwp_run: "20261006T00", nwp_products: "gfs-0p25-sea", nwp_max_lead: 72, nwp_lead_step: 3 });
  const first = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  assert.equal(requestsOn(first).length, 16);
  assert.equal(first.backlogRemaining, 25 - 16);
  const again = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  const requests = requestsOn(again);
  assert.equal(requests.length, 9, "the queued leads 48..72, not a new plan");
  const jobs = requests.map((r) => readHeader(r.context));
  assert.deepEqual(jobs.map((j) => j.LEAD_HOURS), [48, 51, 54, 57, 60, 63, 66, 69, 72]);
  jobs.forEach((j, k) => assertJobHeader(j, "gfs-0p25-sea", `${GFS}/gfs.t00z.pgrb2.0p25.f${String(48 + 3 * k).padStart(3, "0")}`, 48 + 3 * k));
  assert.equal(again.backlogRemaining, 0);
  const third = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  assert.equal(requestsOn(third).length, 0);
  // the node's unchanged notice: a quiet tick between cycles is not a failed retrieval
  assert.deepEqual(noticesOn(third), [{ kind: "unchanged", schema: "", providerId: "", sourceName: "", batchId: "", count: 0, reason: "already-planned", items: [], atMs: 0 }]);
});

test("plan: the run's inventories, sixteen per invocation, each with its job in CONTEXT, the rest as backlog", async (t) => {
  const harness = await createHarness(t, { nwp_run: "20261006T00" });
  const response = await harness.invoke({ methodId: "plan", inputs: [tick()] });
  const requests = requestsOn(response);
  assert.equal(requests.length, 16);
  // 129 leads (0..384 by 3) of motion, spread and clouds, and two physics leads: 389 inventories, 373 left as backlog
  assert.equal(response.yielded, true);
  assert.equal(response.backlogRemaining, 3 * 129 + 2 - 16);
  // (the backlog's resume without input is the compiled flow runtime's: flows/nwp-field-ingest/tests)
  // products in order, leads 0, 3, 6, ...: the first sixteen are GFS 1 deg motion leads 0..45
  requests.forEach((r, k) => {
    const url = `${GFS}/gfs.t00z.pgrb2.1p00.f${String(3 * k).padStart(3, "0")}`;
    assert.equal(r.method, "GET");
    assert.equal(r.url, `${url}.idx`);
    assert.deepEqual(r.headers, { "if-modified-since": NO_VALIDATORS });
    assert.equal(r.timeoutMs, 60000);
    assert.deepEqual(r.body, new Uint8Array(0));
    assertJobHeader(readHeader(r.context), "gfs-1p00-motion", url, 3 * k);
  });
  assert.deepEqual(harness.calls.map((c) => c.op), ["plugin.getConfig"], "one config read, nothing else");
});

test("plan: config lists (dotted keys), a set run must be a 6-hourly cycle, live access off is a notice, an unknown product is refused", async (t) => {
  const listed = await (await createHarness(t, { nwp_run: "20261006T00", nwp_products: ["gfs-0p25-physics"], nwp_physics_leads: [0, 6, 12] })).invoke({ methodId: "plan", inputs: [tick()] });
  assert.deepEqual(requestsOn(listed).map((r) => readHeader(r.context).LEAD_HOURS), [0, 6, 12]);
  requestsOn(listed).forEach((r, k) => assertJobHeader(readHeader(r.context), "gfs-0p25-physics", `${GFS}/gfs.t00z.pgrb2.0p25.f${String(6 * k).padStart(3, "0")}`, 6 * k));
  const bad = await (await createHarness(t, { nwp_run: "20261006T03" })).invoke({ methodId: "plan", inputs: [tick()] });
  assert.equal(bad.errorCode, "invalid-run");
  const off = await (await createHarness(t, { nwp_live_access: false })).invoke({ methodId: "plan", inputs: [tick()] });
  assert.deepEqual(noticesOn(off).map((n) => [n.kind, n.reason]), [["skipped", "live-access-disabled"]]);
  const unknown = await (await createHarness(t, { nwp_run: "20261006T00", nwp_products: "ecmwf-hres" })).invoke({ methodId: "plan", inputs: [tick()] });
  assert.equal(unknown.errorCode, "unknown-product");
  const twice = await (await createHarness(t, { nwp_run: "20261006T00" })).invoke({ methodId: "plan", inputs: [tick(), tick()] });
  assert.equal(twice.errorCode, "batched-input-frames");
});

for (const [product, file] of Object.entries(FILES)) {
  test(`select_messages: ${product} - the reference's messages from a real inventory, as merged byte ranges carrying the job`, async (t) => {
    const harness = await createHarness(t, {});
    const idx = fs.readFileSync(new URL(file.idx, FIXTURES), "utf8");
    const job = header(product, file.url, file.lead);
    const response = await harness.invoke({ methodId: "select_messages", inputs: [inventory(encoder.encode(idx), 200, job)] });
    const requests = requestsOn(response);
    const want = referenceRanges(product, idx, file.lead);
    assert.ok(want.messages > 0);
    // the first batch: the lead-file's ranges, at most 16 (the parser takes 32 frames a port at a time)
    assert.deepEqual(requests.map((r) => r.headers.range), want.ranges.slice(0, 16).map(([a, b]) => `bytes=${a}-${b ?? ""}`));
    const batches = Math.ceil(want.ranges.length / 16);
    assert.equal(response.backlogRemaining, batches - 1, "the lead-file's other batches wait as backlog");
    assert.equal(response.yielded, batches > 1);
    for (const r of requests) {
      assert.equal(r.url, file.url);
      assert.deepEqual(Object.keys(r.headers), ["if-modified-since", "range"], "sorted by NAME");
      assert.equal(r.headers["if-modified-since"], NO_VALIDATORS);
      assert.equal(r.timeoutMs, 300000);
      assert.deepEqual(r.context, job, "the job header travels on verbatim");
    }
    assert.equal(noticesOn(response).length, 0);
    console.log(`${product}: ${want.messages} messages in ${want.ranges.length} range(s)`);
  });
}

test("select_messages: a lead the run lacks is a Missing notice, not invented; a response with no job header is refused", async (t) => {
  const harness = await createHarness(t, {});
  const url = `${GFS}/gfs.t00z.pgrb2.1p00.f999`;
  const response = await harness.invoke({ methodId: "select_messages", inputs: [inventory(encoder.encode("<Error/>"), 404, header("gfs-1p00-motion", url, 999))] });
  assert.deepEqual(noticesOn(response), [{ kind: "missing", schema: "", providerId: "noaa-ncep", sourceName: "", batchId: "", count: 1, reason: "missing-leads", items: [`${url}.idx: HTTP 404`], atMs: 0 }]);
  assert.equal(requestsOn(response).length, 0);
  const lost = await harness.invoke({ methodId: "select_messages", inputs: [inventory(encoder.encode(""), 200, new Uint8Array(0))] });
  assert.equal(lost.errorCode, "missing-context");
  const notJob = await harness.invoke({ methodId: "select_messages", inputs: [inventory(encoder.encode(""), 200, encodeTimerTick({}))] });
  assert.equal(notJob.errorCode, "missing-context");
});

// A run planned again (a node restart forgets the plan): the host presents the inventories' validators from its retrieval
// ledger and NOAA answers 304 - nothing fetched, nothing reported missing, and the node's unchanged notice once.
test("select_messages: unchanged inventories (304) fetch nothing and say Unchanged, not Missing", async (t) => {
  const harness = await createHarness(t, {});
  const job = header("gfs-0p25-sea", `${GFS}/gfs.t00z.pgrb2.0p25.f003`, 3);
  const response = await harness.invoke({ methodId: "select_messages", inputs: [inventory(new Uint8Array(0), 304, job), inventory(new Uint8Array(0), 304, job)] });
  assert.deepEqual(noticesOn(response).map((n) => [n.kind, n.reason, n.count]), [["unchanged", "inventory-304", 2]]);
  assert.equal(requestsOn(response).length, 0);
});

test("publish_request: one POST of the IngestResult when nwp_publish_url is set; nothing otherwise, nothing for a refused batch", async (t) => {
  const PUBLISH = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
  const stored = { schema: "WXF.fbs", providerId: "noaa-ncep", sourceName: "gfs-1p00-motion", batchId: "c".repeat(64), inserted: 18 };
  const result = (r) => ({ portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult(r) });
  const meta = { portId: "meta", typeRef: TYPE.INGQ, payload: encodeIngestRequest({ schema: "WXF.fbs", tags: { providerId: "noaa-ncep", sourceName: "gfs-1p00-motion", batchId: "c".repeat(64) } }) };
  assert.equal(requestsOn(await (await createHarness(t, {})).invoke({ methodId: "publish_request", inputs: [result(stored), meta] }), "request").length, 0);
  const harness = await createHarness(t, { nwp_publish_url: PUBLISH });
  const [request] = requestsOn(await harness.invoke({ methodId: "publish_request", inputs: [result(stored), meta] }), "request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH);
  assert.deepEqual(request.headers, { "content-type": "application/octet-stream" });
  assert.deepEqual(decodeIngestResult(request.body), { ...stored, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "", refused: "" });
  // the batch id from the request when the result does not carry one
  const [fallback] = requestsOn(await harness.invoke({ methodId: "publish_request", inputs: [result({ schema: "WXF.fbs", inserted: 1 }), meta] }), "request");
  assert.equal(decodeIngestResult(fallback.body).batchId, "c".repeat(64));
  const refused = await harness.invoke({ methodId: "publish_request", inputs: [result({ ...stored, inserted: 0, refused: "refused: disk guardrail" }), meta] });
  assert.equal(requestsOn(refused, "request").length, 0);
  const notResult = await harness.invoke({ methodId: "publish_request", inputs: [{ ...result(stored), payload: encodeTimerTick({}) }, meta] });
  assert.equal(notResult.errorCode, "invalid-result-frame");
});
