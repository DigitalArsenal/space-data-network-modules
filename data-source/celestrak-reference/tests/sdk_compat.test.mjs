// data-source/celestrak-reference SDK-compat tests on the typed contracts (1.0): the GP group and SATCAT reference
// nodes run in the SDK browser harness - TimerTick / HttpResponse frames in, HttpRequest / IngestRequest / FlowNotice /
// SDS record-stream frames out, the job a size-prefixed $ICN record in HttpRequest.CONTEXT, and the node config the SDS
// $PIV plugin.getConfig answer (one ModuleConfig on raw "config") - against fixture payloads shaped after one
// polite live read of the CelesTrak pages. Outputs are asserted structurally: request URLs and byte budgets, job
// attribution (origin, dataset, licence), $EGP / $SIT / $LCC record streams with the right file identifiers and field
// values, batch ids, provenance warnings, the pairing refusals and the 304 path.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  decodeHttpResponse,
  decodeIngestRequest,
  encodeHttpResponse,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const OMM_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/OMM/main.js"));
const flatbuffers = createRequire(OMM_LIB)("flatbuffers");
const { CelestialFrame, CelestialFrameWrapper, OMM, RFMUnion } = await import(OMM_LIB.href);
const icnLib = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/ICN/main.js")).href);

const decoder = new TextDecoder();

const STATIONS_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-group-stations.csv", import.meta.url));
const GPZ_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-group-gpz.csv", import.meta.url));
const LAUNCHSITES_HTML = fs.readFileSync(new URL("./fixtures/celestrak-launchsites.html", import.meta.url));
const SOURCES_HTML = fs.readFileSync(new URL("./fixtures/celestrak-sources.html", import.meta.url));

const GP_BASE = "https://celestrak.org/NORAD/elements/gp.php";
const GP_INDEX = "https://celestrak.org/NORAD/elements/";
const DATE_HEADER = "Thu, 04 Sep 2026 01:57:53 GMT";
const DATE_RFC3339 = "2026-09-04T01:57:53Z";
const DATE_RFC3339_MS = "2026-09-04T01:57:53.000Z";
const DATE_MS = Date.parse(DATE_RFC3339);
const LICENSE_REF = "LicenseRef-CelesTrak-Usage-Policy";

const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

// The 47 GROUP tokens and 2 SPECIAL tokens on the CelesTrak elements index,
// in page order (enumerated once, 2026-09-04).
const DEFAULT_GROUPS = [
  ["GROUP", "last-30-days"], ["GROUP", "stations"], ["GROUP", "visual"], ["GROUP", "active"],
  ["GROUP", "analyst"], ["GROUP", "fengyun-1c-debris"], ["GROUP", "iridium-33-debris"],
  ["GROUP", "cosmos-2251-debris"], ["GROUP", "weather"], ["GROUP", "resource"], ["GROUP", "sar"],
  ["GROUP", "sarsat"], ["GROUP", "dmc"], ["GROUP", "tdrss"], ["GROUP", "argos"], ["GROUP", "planet"],
  ["GROUP", "spire"], ["GROUP", "geo"], ["SPECIAL", "gpz"], ["SPECIAL", "gpz-plus"],
  ["GROUP", "intelsat"], ["GROUP", "ses"], ["GROUP", "eutelsat"], ["GROUP", "telesat"],
  ["GROUP", "starlink"], ["GROUP", "oneweb"], ["GROUP", "qianfan"], ["GROUP", "hulianwang"],
  ["GROUP", "kuiper"], ["GROUP", "iridium-NEXT"], ["GROUP", "orbcomm"], ["GROUP", "globalstar"],
  ["GROUP", "amateur"], ["GROUP", "satnogs"], ["GROUP", "x-comm"], ["GROUP", "other-comm"],
  ["GROUP", "gnss"], ["GROUP", "gps-ops"], ["GROUP", "glo-ops"], ["GROUP", "galileo"],
  ["GROUP", "beidou"], ["GROUP", "sbas"], ["GROUP", "science"], ["GROUP", "geodetic"],
  ["GROUP", "engineering"], ["GROUP", "education"], ["GROUP", "military"], ["GROUP", "radar"],
  ["GROUP", "cubesat"],
];

function groupURL(kind, token) {
  return `${GP_BASE}?${kind}=${token}&FORMAT=csv`;
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- the job: one size-prefixed $ICN record ---------------------------------------------------------------------

function readJob(context) {
  assert.equal(identifierOf(context.subarray(4)), "$ICN", "CONTEXT is one size-prefixed $ICN record");
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4);
  return icnLib.ICN.getRootAsICN(new flatbuffers.ByteBuffer(Uint8Array.from(context.subarray(4)))).unpack();
}

// A job as satcat_reference builds it - for parser inputs whose job is not the builder's own.
function icnJob(j) {
  const b = new flatbuffers.Builder(1024);
  const s = (v) => b.createString(v);
  const offsets = {
    connectorId: s(j.connectorId ?? j.sourceName), targetSchema: s(j.targetSchema ?? "SIT.fbs"), endpoint: s(j.sourceUrl),
    method: s("GET"), originId: s("celestrak.org"), originName: s("CelesTrak"), datasetId: s(j.datasetId),
    providerId: s(j.providerId ?? "space-data-network-02"), sourceName: s(j.sourceName), license: s(j.license),
    licenseUrl: s(j.licenseUrl), citation: s(j.citation),
  };
  const { ICN } = icnLib;
  ICN.startICN(b);
  ICN.addConnectorId(b, offsets.connectorId);
  ICN.addKind(b, icnLib.icnConnectorKind.HttpsPull);
  ICN.addTargetSchema(b, offsets.targetSchema);
  ICN.addEndpointUrl(b, offsets.endpoint);
  ICN.addHttpMethod(b, offsets.method);
  ICN.addOriginId(b, offsets.originId);
  ICN.addOriginName(b, offsets.originName);
  ICN.addDatasetId(b, offsets.datasetId);
  ICN.addProviderId(b, offsets.providerId);
  ICN.addSourceName(b, offsets.sourceName);
  ICN.addLicense(b, offsets.license);
  ICN.addLicenseUrl(b, offsets.licenseUrl);
  ICN.addCitation(b, offsets.citation);
  b.finishSizePrefixed(ICN.endICN(b), "$ICN");
  return b.asUint8Array().slice();
}

// ---- harness: the node config is the $PIV plugin.getConfig answer ------------------------------------------------

// The SDK harness's BrowserHost answers plugin.getConfig from `config` (one ModuleConfig on raw "config", as the Go node
// answers it). The hostcall import is wrapped only to record which operations the module calls.
async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    // only the module under test imports the hostcall bridge (the SDK's own helper wasm passes through)
    if (!imports?.space_data_module_host) return instantiate(module, imports);
    let memory;
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()).op);
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
      wasmSource: readWasm(),
      manifest: readManifest(),
      surface: "direct",
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}

const tickInput = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-gp-groups", firedMs: Date.UTC(2026, 8, 4) }) });

// An HttpResponse as hostcap/http-request answers it: the request's CONTEXT echoed verbatim.
function responseInput(body, context, { status = 200, headers = { date: DATE_HEADER }, url = "" } = {}) {
  return {
    portId: "response",
    typeRef: TYPE.HRSP,
    payload: encodeHttpResponse({ url, status, headers, body: body ?? new Uint8Array(0), context, retrievedMs: DATE_MS + 250 }),
  };
}

function framesOnPort(response, portId) {
  return response.outputs.filter((frame) => frame.portId === portId);
}
function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}
const requestsOn = (response, port) => framesOnPort(ok(response), port).map((f) => decodeHttpRequest(f.payload));
function only(response, portId, decode) {
  const frames = framesOnPort(response, portId);
  assert.equal(frames.length, 1, `expected exactly one frame on ${portId}`);
  return decode(frames[0].payload);
}
const onlyMeta = (response, portId) => only(response, portId, decodeIngestRequest);
const onlyNotice = (response) => only(response, "unchanged", decodeFlowNotice);

// Splits a size-prefixed record stream into unprefixed record buffers.
function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

function fileIdentifier(record) {
  return decoder.decode(record.subarray(4, 8));
}

// ---------------------------------------------------------------------------
// Minimal FlatBuffer reader (enough to decode EGP / SIT / LCC by field index).
// ---------------------------------------------------------------------------

function fbTable(bytes, tablePos) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vtable = tablePos - view.getInt32(tablePos, true);
  const vtableLen = view.getUint16(vtable, true);
  const fieldOffset = (index) => {
    const slot = vtable + 4 + index * 2;
    if (slot + 2 > vtable + vtableLen) return 0;
    return view.getUint16(slot, true);
  };
  const indirect = (pos) => pos + view.getUint32(pos, true);
  const readString = (pos) => {
    const len = view.getUint32(pos, true);
    return decoder.decode(bytes.subarray(pos + 4, pos + 4 + len));
  };
  return {
    string(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? null : readString(indirect(tablePos + fo));
    },
    uint32(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? 0 : view.getUint32(tablePos + fo, true);
    },
    int8(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? 0 : view.getInt8(tablePos + fo);
    },
    bool(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? false : view.getUint8(tablePos + fo) !== 0;
    },
    float32(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? 0 : view.getFloat32(tablePos + fo, true);
    },
    table(index) {
      const fo = fieldOffset(index);
      return fo === 0 ? null : fbTable(bytes, indirect(tablePos + fo));
    },
    stringVector(index) {
      const fo = fieldOffset(index);
      if (fo === 0) return [];
      const vec = indirect(tablePos + fo);
      const len = view.getUint32(vec, true);
      const out = [];
      for (let i = 0; i < len; i++) out.push(readString(indirect(vec + 4 + i * 4)));
      return out;
    },
    tableVector(index) {
      const fo = fieldOffset(index);
      if (fo === 0) return [];
      const vec = indirect(tablePos + fo);
      const len = view.getUint32(vec, true);
      const out = [];
      for (let i = 0; i < len; i++) out.push(fbTable(bytes, indirect(vec + 4 + i * 4)));
      return out;
    },
  };
}

function fbRoot(record) {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return fbTable(record, view.getUint32(0, true));
}

// EGP field indices (schema order).
const EGP = { GROUP_ID: 0, NAME: 1, DESCRIPTION: 2, TAGS: 3, MEMBERSHIP_MODE: 4, MEMBERS: 5, QUERY: 6, CREATED_AT: 7, UPDATED_AT: 8, PROVENANCE: 9, DATASET_CID: 10 };
const EGP_MEMBER = { STANDARD: 0, RECORD_ID: 1, NORAD_CAT_ID: 2 };
const EGP_QUERY = { DIALECT: 0, TEXT: 1, EVALUATED_AT: 2, RESULT_COUNT: 3 };
const EGP_PROVENANCE = { SOURCE: 0, SOURCE_DATASET: 1, SOURCE_URL: 3, RETRIEVED_AT: 5, SOURCE_SHA256: 6, LICENSE: 7, ATTRIBUTION: 8 };
const SIT = { ID: 0, NAME: 1, ABBREVIATION: 2, SITE_TYPE: 3, LATITUDE: 6, LONGITUDE: 7, DESCRIPTION: 14, SOURCE: 16 };
const LCC = { OWNER: 0, NAME: 1, DESCRIPTION: 2, ACTIVE: 3, SOURCE_URL: 4, RETRIEVED_AT: 5 };

function decodeEgp(record) {
  const t = fbRoot(record);
  const query = t.table(EGP.QUERY);
  return {
    groupId: t.string(EGP.GROUP_ID),
    name: t.string(EGP.NAME),
    description: t.string(EGP.DESCRIPTION),
    tags: t.stringVector(EGP.TAGS),
    membershipMode: t.int8(EGP.MEMBERSHIP_MODE),
    members: t.tableVector(EGP.MEMBERS).map((m) => ({
      standard: m.string(EGP_MEMBER.STANDARD),
      recordId: m.string(EGP_MEMBER.RECORD_ID),
      norad: m.uint32(EGP_MEMBER.NORAD_CAT_ID),
    })),
    query: query && {
      dialect: query.string(EGP_QUERY.DIALECT),
      text: query.string(EGP_QUERY.TEXT),
      evaluatedAt: query.string(EGP_QUERY.EVALUATED_AT),
      resultCount: query.uint32(EGP_QUERY.RESULT_COUNT),
    },
    createdAt: t.string(EGP.CREATED_AT),
    updatedAt: t.string(EGP.UPDATED_AT),
    provenance: t.tableVector(EGP.PROVENANCE).map((p) => ({
      source: p.string(EGP_PROVENANCE.SOURCE),
      sourceDataset: p.string(EGP_PROVENANCE.SOURCE_DATASET),
      sourceUrl: p.string(EGP_PROVENANCE.SOURCE_URL),
      retrievedAt: p.string(EGP_PROVENANCE.RETRIEVED_AT),
      sourceSha256: p.string(EGP_PROVENANCE.SOURCE_SHA256),
      license: p.string(EGP_PROVENANCE.LICENSE),
      attribution: p.string(EGP_PROVENANCE.ATTRIBUTION),
    })),
    datasetCid: t.string(EGP.DATASET_CID),
  };
}

function decodeSit(record) {
  const t = fbRoot(record);
  return {
    id: t.string(SIT.ID),
    name: t.string(SIT.NAME),
    abbreviation: t.string(SIT.ABBREVIATION),
    siteType: t.int8(SIT.SITE_TYPE),
    latitude: t.float32(SIT.LATITUDE),
    longitude: t.float32(SIT.LONGITUDE),
    description: t.string(SIT.DESCRIPTION),
    source: t.string(SIT.SOURCE),
  };
}

function decodeLcc(record) {
  const t = fbRoot(record);
  return {
    owner: t.int8(LCC.OWNER),
    name: t.string(LCC.NAME),
    description: t.string(LCC.DESCRIPTION),
    active: t.bool(LCC.ACTIVE),
    sourceUrl: t.string(LCC.SOURCE_URL),
    retrievedAt: t.string(LCC.RETRIEVED_AT),
  };
}

// The flow service's config: every node of the flow reads the same one (gp_groups and parse_gp_groups resolve the same
// group plan from it).
const TWO_GROUPS = { celestrak_gp_groups: "stations,gpz" };

// The gp_groups requests for a two-group list, exactly as the builder emits them (each with its job in CONTEXT).
async function twoGroupRequests(t, config = TWO_GROUPS) {
  const harness = await createHarness(t, config);
  return requestsOn(await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] }), "request");
}

// ---------------------------------------------------------------------------
// Artifact.
// ---------------------------------------------------------------------------

test("celestrak-reference artifact passes SDK compliance with one concrete FlatBuffer type per port", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "gp_groups.tick": "TICK", "gp_groups.request": "HREQ",
    "parse_gp_groups.response": "HRSP", "parse_gp_groups.egp_meta": "INGQ", "parse_gp_groups.egp_records": "$EGP",
    "parse_gp_groups.raw": "HRSP", "parse_gp_groups.unchanged": "FNTC", "parse_gp_groups.omm_meta": "INGQ",
    "parse_gp_groups.omm_records": "$OMM",
    "satcat_reference.tick": "TICK", "satcat_reference.request_sites": "HREQ", "satcat_reference.request_owners": "HREQ",
    "parse_satcat_reference.response": "HRSP", "parse_satcat_reference.sit_meta": "INGQ",
    "parse_satcat_reference.sit_records": "$SIT", "parse_satcat_reference.lcc_meta": "INGQ",
    "parse_satcat_reference.lcc_records": "$LCC", "parse_satcat_reference.raw": "HRSP",
    "parse_satcat_reference.unchanged": "FNTC",
  });
});

test("celestrak-reference artifact imports only WASI and the builtin hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.deepEqual(importedModuleNames, ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

// ---------------------------------------------------------------------------
// gp_groups.
// ---------------------------------------------------------------------------

test("gp_groups emits the 47 GROUP + 2 SPECIAL requests in page order, each carrying its group's job", async (t) => {
  const harness = await createHarness(t);
  const requests = requestsOn(await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] }), "request");
  assert.equal(requests.length, 49, "47 GROUP + 2 SPECIAL");
  assert.deepEqual(
    requests.map((r) => r.url),
    DEFAULT_GROUPS.map(([kind, token]) => groupURL(kind, token)),
    "request URLs are exact and in page order",
  );
  for (const [i, request] of requests.entries()) {
    assert.equal(request.method, "GET");
    assert.equal(request.timeoutMs, 90000, "runner HTTPTimeout default");
    assert.equal(request.maxBytes, 8388608, "8 MiB per group");
    assert.deepEqual(request.headers, {}, "the host presents its recorded validators");
    const job = readJob(request.context);
    assert.equal(job.CONNECTOR_ID, `celestrak-gp-groups/${DEFAULT_GROUPS[i][1]}`, "the job names its group");
    assert.equal(job.ENDPOINT_URL, request.url);
    assert.equal(job.KIND, icnLib.icnConnectorKind.HttpsPull);
    assert.equal(job.HTTP_METHOD, "GET");
    assert.equal(job.TARGET_SCHEMA, "EGP.fbs");
    assert.deepEqual(job.EMITS_SCHEMAS, ["EGP"]);
    assert.equal(job.POST_INGEST_ACTION, icnLib.icnPostIngestAction.Archive);
    assert.equal(job.SOURCE_NAME, "celestrak-gp-groups");
    assert.equal(job.PROVIDER_ID, "space-data-network-02");
    assert.equal(job.ORIGIN_ID, "celestrak.org");
    assert.equal(job.ORIGIN_NAME, "CelesTrak");
    assert.equal(job.DATASET_ID, "gp-groups");
    assert.equal(job.LICENSE_URL, "https://celestrak.org/usage-policy.php");
    assert.match(job.LICENSE, /Only download the data you need/);
    assert.match(job.CITATION, /CelesTrak/);
  }
  assert.deepEqual(harness.calls, ["plugin.getConfig"]);
});

test("gp_groups: node CONFIG celestrak_gp_groups shrinks the list; provider/licence overrides reach the jobs", async (t) => {
  const harness = await createHarness(t, {
    celestrak_gp_groups: "stations, gpz ,stations",
    celestrak_provider_id: "prov-test",
    celestrak_license: "test terms",
    celestrak_license_url: "https://fixtures.test/terms",
    celestrak_citation: "Fixture citation",
    celestrak_http_timeout_ms: 5000,
    celestrak_gp_groups_emit_omm: true,
  });
  const requests = requestsOn(await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] }), "request");
  assert.deepEqual(
    requests.map((r) => r.url),
    [groupURL("GROUP", "stations"), groupURL("SPECIAL", "gpz")],
    "deduplicated, trimmed, SPECIAL kind resolved from the registry",
  );
  assert.equal(requests[0].timeoutMs, 5000);
  const jobs = requests.map((r) => readJob(r.context));
  assert.deepEqual(jobs.map((j) => j.CONNECTOR_ID), ["celestrak-gp-groups/stations", "celestrak-gp-groups/gpz"]);
  for (const job of jobs) {
    assert.equal(job.PROVIDER_ID, "prov-test");
    assert.equal(job.LICENSE, "test terms");
    assert.equal(job.LICENSE_URL, "https://fixtures.test/terms");
    assert.equal(job.CITATION, "Fixture citation");
    assert.deepEqual(job.EMITS_SCHEMAS, ["EGP", "OMM"], "the OMM re-emission lane is declared");
  }
});

test("gp_groups refuses a list longer than one flow invocation can carry", async (t) => {
  const tokens = Array.from({ length: 64 }, (_, i) => `group-${i}`);
  const harness = await createHarness(t, { celestrak_gp_groups: tokens });
  const response = await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-group-list");
  assert.equal(response.outputs.length, 0);
});

// ---------------------------------------------------------------------------
// parse_gp_groups.
// ---------------------------------------------------------------------------

test("parse_gp_groups emits one $EGP per group with membership, tags, query and provenance", async (t) => {
  const [stationsReq, gpzReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  // answered in the opposite order: the pairing is by CONTEXT, the output order the plan's
  const response = ok(await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(GPZ_CSV, gpzReq.context), responseInput(STATIONS_CSV, stationsReq.context)],
  }));
  assert.equal(framesOnPort(response, "unchanged").length, 0);
  assert.deepEqual(harness.calls, ["plugin.getConfig"], "the plan from the node config");

  const concat = Buffer.concat([STATIONS_CSV, GPZ_CSV]);
  const meta = onlyMeta(response, "egp_meta");
  assert.equal(meta.schema, "EGP.fbs");
  assert.equal(meta.tags.providerId, "space-data-network-02");
  assert.equal(meta.tags.sourceName, "celestrak-gp-groups");
  assert.equal(meta.tags.sourceUrl, GP_INDEX);
  assert.equal(meta.tags.batchId, sha256Hex(concat), "batch id = sha256 of the concatenated payloads in plan order");
  assert.equal(meta.tags.contentKeyId, "public");
  assert.equal(meta.tags.sourcePeer, "source:celestrak");
  assert.equal(meta.reconcile, "current", "a complete snapshot supersedes the lane");
  assert.equal(meta.tags.licenseUrl, "https://celestrak.org/usage-policy.php");
  assert.equal(meta.tags.license, LICENSE_REF, "the prose usage terms are named by an SPDX LicenseRef");
  assert.match(meta.tags.citation, /CelesTrak/);
  assert.deepEqual(meta.archive, { source: "celestrak", name: "gp-groups.csv" });
  const provenance = meta.provenance;
  assert.equal(provenance.parser, "celestrak-gp-groups-wasm");
  assert.equal(provenance.parserVersion, "v1");
  assert.equal(provenance.sourceUrl, GP_INDEX);
  assert.equal(provenance.httpStatus, 200);
  assert.equal(provenance.sourceSha256, sha256Hex(concat));
  assert.equal(provenance.retrievedMs, DATE_MS, "retrieved_at: the response Date header");
  assert.deepEqual(provenance.schemaCounts, { "EGP.fbs": 2 });
  assert.equal(provenance.normalizedCount, 2);
  assert.match(provenance.normalizedSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.fromCache, false);

  const raw = framesOnPort(response, "raw").map((f) => decodeHttpResponse(f.payload));
  assert.equal(raw.length, 1);
  assert.deepEqual(Buffer.from(raw[0].body), concat, "raw archive = the hashed concatenation");
  assert.equal(raw[0].url, GP_INDEX);
  assert.equal(raw[0].status, 200);

  const records = splitStream(framesOnPort(response, "egp_records")[0].payload);
  assert.equal(records.length, 2, "one $EGP per group");
  for (const record of records) assert.equal(fileIdentifier(record), "$EGP");
  const [stations, gpz] = records.map(decodeEgp);

  assert.equal(stations.groupId, "celestrak.org/gp/stations");
  assert.equal(stations.name, "stations");
  assert.equal(stations.description, "Space Stations", "the page's human label");
  assert.deepEqual(stations.tags, ["class:query", "provisioner:celestrak.org", "status:active"]);
  assert.equal(stations.membershipMode, 2, "QUERY_SNAPSHOT");
  assert.equal(stations.members.length, 2, "MEMBERS count == fixture rows");
  assert.deepEqual(stations.members.map((m) => m.norad), [25544, 48274]);
  assert.deepEqual(stations.members.map((m) => m.recordId), ["1998-067A", "2021-035A"]);
  assert.ok(stations.members.every((m) => m.standard === "$OMM"));
  assert.equal(stations.query.dialect, "https");
  assert.equal(stations.query.text, groupURL("GROUP", "stations"));
  assert.equal(stations.query.evaluatedAt, DATE_RFC3339_MS);
  assert.equal(stations.query.resultCount, 2);
  assert.equal(stations.updatedAt, DATE_RFC3339_MS, "UPDATED_AT is the retrieval time");
  assert.equal(stations.createdAt, stations.updatedAt);
  assert.equal(stations.provenance.length, 1);
  assert.equal(stations.provenance[0].source, "CelesTrak");
  assert.equal(stations.provenance[0].sourceDataset, "GP group stations");
  assert.equal(stations.provenance[0].sourceUrl, groupURL("GROUP", "stations"));
  assert.equal(stations.provenance[0].retrievedAt, stations.updatedAt, "UPDATED_AT == RETRIEVED_AT");
  assert.equal(stations.provenance[0].sourceSha256, sha256Hex(STATIONS_CSV), "per-group payload hash");
  assert.match(stations.provenance[0].license, /Only download the data you need/, "the verbatim terms on the record");
  assert.match(stations.provenance[0].attribution, /CelesTrak/);
  assert.equal(stations.datasetCid, null, "DATASET_CID empty");

  assert.equal(gpz.groupId, "celestrak.org/gp/gpz");
  assert.equal(gpz.description, "GEO Protected Zone");
  assert.deepEqual(
    gpz.tags,
    ["class:query", "provisioner:celestrak.org", "regime:geo", "status:active"],
    "TAGS sorted and deduplicated; regime only where the token states it",
  );
  const sorted = [...gpz.tags].sort();
  assert.deepEqual(gpz.tags, sorted);
  assert.equal(new Set(gpz.tags).size, gpz.tags.length);
  assert.deepEqual(gpz.members.map((m) => m.norad), [41866, 36516]);
  assert.equal(gpz.query.text, groupURL("SPECIAL", "gpz"));
  assert.equal(gpz.provenance[0].sourceSha256, sha256Hex(GPZ_CSV));
});

test("parse_gp_groups refuses a response set that differs from the group plan (group-count-mismatch)", async (t) => {
  const [stationsReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  const missing = await harness.invoke({ methodId: "parse_gp_groups", inputs: [responseInput(STATIONS_CSV, stationsReq.context)] });
  assert.notEqual(missing.statusCode, 0);
  assert.equal(missing.errorCode, "group-count-mismatch");
  assert.equal(missing.outputs.length, 0, "nothing is published partially");
  const twice = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(STATIONS_CSV, stationsReq.context)],
  });
  assert.equal(twice.errorCode, "group-count-mismatch", "one group twice is not two groups");
  assert.equal(twice.outputs.length, 0);
});

test("parse_gp_groups refuses a response for a group or URL the plan does not name (group-url-mismatch)", async (t) => {
  const [stationsReq, gpzReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  // a group outside the plan
  const [activeReq] = await twoGroupRequests(t, { celestrak_gp_groups: "active" });
  const foreign = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(GPZ_CSV, activeReq.context)],
  });
  assert.notEqual(foreign.statusCode, 0);
  assert.equal(foreign.errorCode, "group-url-mismatch");
  // the planned group, but another URL
  const other = await twoGroupRequests(t, { ...TWO_GROUPS, celestrak_gp_groups: "gpz" });
  const job = readJob(other[0].context);
  const moved = icnJob({ connectorId: job.CONNECTOR_ID, sourceName: job.SOURCE_NAME, sourceUrl: groupURL("GROUP", "gpz"), datasetId: "gp-groups", targetSchema: "EGP.fbs", license: "t", licenseUrl: "u", citation: "c" });
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(GPZ_CSV, moved)],
  });
  assert.equal(response.errorCode, "group-url-mismatch");
  assert.match(response.errorMessage ?? "", /SPECIAL=gpz/);
  assert.equal(response.outputs.length, 0);
  // and a response that carries no job at all cannot be attributed
  const lost = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(GPZ_CSV, new Uint8Array(0))],
  });
  assert.equal(lost.errorCode, "missing-context");
  void gpzReq;
});

test("parse_gp_groups: every group 304 -> one unchanged notice, no records", async (t) => {
  const [stationsReq, gpzReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  const response = ok(await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(null, stationsReq.context, { status: 304 }), responseInput(null, gpzReq.context, { status: 304 })],
  }));
  assert.deepEqual(response.outputs.map((f) => f.portId), ["unchanged"], "304 -> unchanged notice only");
  assert.deepEqual(onlyNotice(response), {
    kind: "unchanged", schema: "EGP.fbs", providerId: "space-data-network-02", sourceName: "celestrak-gp-groups",
    batchId: "", count: 2, reason: "not-modified", items: ["stations", "gpz"], atMs: 0,
  });
});

test("parse_gp_groups: a partial refresh appends the changed groups and reports the unchanged ones", async (t) => {
  const [stationsReq, gpzReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  const response = ok(await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(null, stationsReq.context, { status: 304 }), responseInput(GPZ_CSV, gpzReq.context)],
  }));
  const unchanged = onlyNotice(response);
  assert.deepEqual(unchanged.items, ["stations"]);
  assert.equal(unchanged.count, 1);
  const meta = onlyMeta(response, "egp_meta");
  assert.equal(meta.reconcile, "duplicates", "a partial refresh never supersedes the unchanged groups");
  assert.equal(meta.tags.batchId, sha256Hex(GPZ_CSV), "batch id hashes the payloads received");
  const records = splitStream(framesOnPort(response, "egp_records")[0].payload);
  assert.equal(records.length, 1);
  assert.equal(decodeEgp(records[0]).groupId, "celestrak.org/gp/gpz");
});

test("parse_gp_groups fails the batch on any other non-200 status (usage policy)", async (t) => {
  const [stationsReq, gpzReq] = await twoGroupRequests(t);
  const harness = await createHarness(t, TWO_GROUPS);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(null, gpzReq.context, { status: 403 })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /gpz.*403/);
  assert.equal(response.outputs.length, 0);
});

test("parse_gp_groups re-emits OMM rows only when celestrak_gp_groups_emit_omm is set", async (t) => {
  const config = { ...TWO_GROUPS, celestrak_gp_groups_emit_omm: true };
  const [stationsReq, gpzReq] = await twoGroupRequests(t, config);
  const plain = ok(await (await createHarness(t, TWO_GROUPS)).invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(GPZ_CSV, gpzReq.context)],
  }));
  assert.equal(framesOnPort(plain, "omm_meta").length + framesOnPort(plain, "omm_records").length, 0);
  const harness = await createHarness(t, config);
  const response = ok(await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [responseInput(STATIONS_CSV, stationsReq.context), responseInput(GPZ_CSV, gpzReq.context)],
  }));
  const ommMeta = onlyMeta(response, "omm_meta");
  assert.equal(ommMeta.schema, "OMM.fbs");
  assert.equal(ommMeta.reconcile, "duplicates");
  assert.equal(ommMeta.tags.sourceName, "celestrak-gp-groups");
  assert.equal(ommMeta.archive, null, "payload archived once (EGP meta only)");
  assert.equal(ommMeta.provenance, null, "provenance once (EGP meta only)");
  const omm = splitStream(framesOnPort(response, "omm_records")[0].payload);
  assert.equal(omm.length, 4, "two rows per fixture group");
  for (const record of omm) assert.equal(fileIdentifier(record), "$OMM");
  assert.deepEqual(onlyMeta(response, "egp_meta").provenance.schemaCounts, { "EGP.fbs": 2, "OMM.fbs": 4 });
  // CelesTrak GP data are SGP4 mean elements in TEME of date: the GP product
  // defines them that way and CelesTrak's own OMM KVN/XML for the same records
  // states REF_FRAME = TEME. Every re-emitted GP-group OMM therefore declares
  // Earth + TEME of date, read through the published SDS JavaScript bindings
  // (SDS RFM CelestialFrame.TEMEOFDATE, SANA OID 1.3.112.4.57.2.25), the same
  // contract as celestrak-parser's parse_gp. An OMM without a frame is refused
  // by SGP4 consumers such as conjunction-assessment.
  const expected = [
    { norad: 25544, name: "ISS (ZARYA)" },
    { norad: 48274, name: "CSS (TIANHE)" },
    { norad: 41866, name: "GOES 16" },
    { norad: 36516, name: "SES-1" },
  ];
  omm.forEach((record, index) => {
    const decoded = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(Uint8Array.from(record)));
    assert.equal(decoded.NORAD_CAT_ID(), expected[index].norad);
    assert.equal(decoded.OBJECT_NAME(), expected[index].name);
    assert.equal(decoded.CENTER_NAME(), "EARTH");
    const frame = decoded.REFERENCE_FRAME();
    assert.ok(frame, `NORAD ${expected[index].norad}: REFERENCE_FRAME must be present`);
    assert.equal(frame.REFERENCE_FRAME_type(), RFMUnion.CelestialFrameWrapper);
    const celestial = frame.REFERENCE_FRAME(new CelestialFrameWrapper());
    assert.equal(celestial.frame(), CelestialFrame.TEMEOFDATE);
    assert.equal(CelestialFrame[celestial.frame()], "TEMEOFDATE");
  });
});

// ---------------------------------------------------------------------------
// satcat_reference.
// ---------------------------------------------------------------------------

test("satcat_reference emits the launch-site and owner table fetches, each carrying its job", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "satcat_reference", inputs: [tickInput()] });
  const [sites] = requestsOn(response, "request_sites");
  assert.equal(sites.url, "https://celestrak.org/satcat/launchsites.php");
  assert.equal(sites.method, "GET");
  assert.equal(sites.maxBytes, 2097152);
  assert.equal(sites.timeoutMs, 90000);
  const [owners] = requestsOn(response, "request_owners");
  assert.equal(owners.url, "https://celestrak.org/satcat/sources.php");
  assert.equal(owners.maxBytes, 2097152);
  assert.deepEqual(response.outputs.map((f) => f.portId).sort(), ["request_owners", "request_sites"]);

  const jobSites = readJob(sites.context);
  assert.equal(jobSites.CONNECTOR_ID, "celestrak-satcat-launch-sites");
  assert.equal(jobSites.SOURCE_NAME, "celestrak-satcat-launch-sites");
  assert.equal(jobSites.DATASET_ID, "satcat-launch-sites");
  assert.equal(jobSites.ENDPOINT_URL, sites.url);
  assert.equal(jobSites.TARGET_SCHEMA, "SIT.fbs");
  assert.deepEqual(jobSites.EMITS_SCHEMAS, ["SIT"]);
  assert.equal(jobSites.ORIGIN_ID, "celestrak.org");
  const jobOwners = readJob(owners.context);
  assert.equal(jobOwners.SOURCE_NAME, "celestrak-satcat-owners");
  assert.equal(jobOwners.DATASET_ID, "satcat-owners");
  assert.equal(jobOwners.ENDPOINT_URL, owners.url);
  assert.equal(jobOwners.TARGET_SCHEMA, "LCC.fbs");
  assert.equal(jobOwners.LICENSE_URL, "https://celestrak.org/usage-policy.php");
  assert.deepEqual(harness.calls, ["plugin.getConfig"]);
});

test("satcat_reference honours node-CONFIG page URL overrides", async (t) => {
  const harness = await createHarness(t, {
    celestrak_satcat_launchsites_url: "https://fixtures.test/launchsites.html",
    celestrak_satcat_sources_url: "https://fixtures.test/sources.html",
  });
  const response = await harness.invoke({ methodId: "satcat_reference", inputs: [tickInput()] });
  assert.equal(requestsOn(response, "request_sites")[0].url, "https://fixtures.test/launchsites.html");
  const [owners] = requestsOn(response, "request_owners");
  assert.equal(owners.url, "https://fixtures.test/sources.html");
  assert.equal(readJob(owners.context).ENDPOINT_URL, "https://fixtures.test/sources.html");
});

// ---------------------------------------------------------------------------
// parse_satcat_reference.
// ---------------------------------------------------------------------------

const SITES_JOB = {
  sourceUrl: "https://celestrak.org/satcat/launchsites.php",
  sourceName: "celestrak-satcat-launch-sites",
  datasetId: "satcat-launch-sites",
  targetSchema: "SIT.fbs",
  license: "test terms",
  licenseUrl: "https://fixtures.test/terms",
  citation: "Fixture citation",
};
const OWNERS_JOB = {
  ...SITES_JOB,
  sourceUrl: "https://celestrak.org/satcat/sources.php",
  sourceName: "celestrak-satcat-owners",
  datasetId: "satcat-owners",
  targetSchema: "LCC.fbs",
};

test("parse_satcat_reference turns the launch-site table into $SIT rows with entities decoded", async (t) => {
  const harness = await createHarness(t);
  const input = responseInput(LAUNCHSITES_HTML, icnJob(SITES_JOB));
  const response = ok(await harness.invoke({ methodId: "parse_satcat_reference", inputs: [input] }));
  assert.deepEqual(response.outputs.map((f) => f.portId).sort(), ["raw", "sit_meta", "sit_records"]);
  assert.deepEqual(harness.calls, [], "the parser reads no config");

  const meta = onlyMeta(response, "sit_meta");
  assert.equal(meta.schema, "SIT.fbs");
  assert.equal(meta.reconcile, "current");
  assert.equal(meta.tags.batchId, sha256Hex(LAUNCHSITES_HTML));
  assert.equal(meta.tags.sourceName, "celestrak-satcat-launch-sites");
  assert.equal(meta.tags.sourceUrl, SITES_JOB.sourceUrl);
  assert.equal(meta.tags.license, LICENSE_REF, "\"test terms\" is prose, not an identifier");
  assert.equal(meta.tags.licenseUrl, "https://fixtures.test/terms");
  assert.equal(meta.tags.citation, "Fixture citation");
  assert.deepEqual(meta.archive, { source: "celestrak", name: "launchsites.html" });
  const provenance = meta.provenance;
  assert.equal(provenance.parser, "celestrak-satcat-reference-wasm");
  assert.equal(provenance.parserVersion, "v1");
  assert.deepEqual(provenance.schemaCounts, { "SIT.fbs": 3 });
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.retrievedMs, DATE_MS);
  assert.equal(provenance.sourceSha256, sha256Hex(LAUNCHSITES_HTML));

  const records = splitStream(framesOnPort(response, "sit_records")[0].payload);
  assert.equal(records.length, 3, "3 launch-site rows; header and footer note rows are not rows");
  for (const record of records) assert.equal(fileIdentifier(record), "$SIT");
  const sites = records.map(decodeSit);
  assert.deepEqual(sites.map((s) => s.id), ["AFETR", "ANDSP", "SEAL"], "codes trimmed, link text unwrapped");
  assert.deepEqual(sites.map((s) => s.abbreviation), ["AFETR", "ANDSP", "SEAL"]);
  assert.equal(sites[0].name, "Air Force Eastern Test Range, Florida, USA");
  assert.equal(sites[1].name, "Andøya Spaceport, Nordland, Norway", "&oslash; decoded");
  assert.equal(
    sites[2].name,
    "Sea Launch Platform (Odyssey & Sea Launch Commander), Pacific Ocean",
    "&amp; decoded, <br> collapsed to a space",
  );
  for (const site of sites) {
    assert.equal(site.siteType, 0, "LAUNCH_SITE");
    assert.equal(site.latitude, 0);
    assert.equal(site.longitude, 0);
    assert.equal(site.source, "CelesTrak");
    assert.equal(site.description, site.name);
  }
  const [raw] = framesOnPort(response, "raw");
  assert.deepEqual(Buffer.from(raw.payload), Buffer.from(input.payload), "raw: the HttpResponse, verbatim");
  assert.deepEqual(Buffer.from(decodeHttpResponse(raw.payload).body), LAUNCHSITES_HTML);
});

test("parse_satcat_reference turns the owner table into $LCC rows with exact enum codes", async (t) => {
  const harness = await createHarness(t);
  const response = ok(await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [responseInput(SOURCES_HTML, icnJob({ ...OWNERS_JOB, license: "CC-BY-4.0" }))],
  }));
  assert.deepEqual(response.outputs.map((f) => f.portId).sort(), ["lcc_meta", "lcc_records", "raw"]);
  const meta = onlyMeta(response, "lcc_meta");
  assert.equal(meta.schema, "LCC.fbs");
  assert.equal(meta.reconcile, "current");
  assert.equal(meta.tags.sourceName, "celestrak-satcat-owners");
  assert.equal(meta.tags.batchId, sha256Hex(SOURCES_HTML));
  assert.equal(meta.tags.license, "CC-BY-4.0", "an identifier-shaped licence is used as configured");
  assert.deepEqual(meta.archive, { source: "celestrak", name: "sources.html" });
  assert.deepEqual(meta.provenance.warnings, []);

  const records = splitStream(framesOnPort(response, "lcc_records")[0].payload);
  assert.equal(records.length, 3);
  for (const record of records) assert.equal(fileIdentifier(record), "$LCC");
  const owners = records.map(decodeLcc);
  assert.deepEqual(owners.map((o) => o.owner), [0, 20, 120], "legacyCountryCode AB, CHTU, US exactly");
  assert.equal(owners[0].name, "Arab Satellite Communications Organization", "link text unwrapped");
  assert.equal(owners[1].name, "China/Türkiye", "&uuml; decoded");
  assert.equal(owners[2].name, "United States");
  for (const owner of owners) {
    assert.equal(owner.active, true);
    assert.equal(owner.sourceUrl, OWNERS_JOB.sourceUrl);
    assert.equal(owner.retrievedAt, DATE_RFC3339, "RETRIEVED_AT from the response Date header");
    assert.equal(owner.description, owner.name);
  }
});

test("parse_satcat_reference records an unknown owner code as a provenance warning and skips it", async (t) => {
  const html = Buffer.from(
    [
      "<table>",
      "<tr><th>Source Code</th><th>Source Description</th></tr>",
      "<tr><td>XXXX</td><td>Not A Catalogued Owner</td></tr>",
      "<tr><td>US  </td><td>United States</td></tr>",
      "</table>",
    ].join("\n"),
  );
  const harness = await createHarness(t);
  const response = ok(await harness.invoke({ methodId: "parse_satcat_reference", inputs: [responseInput(html, icnJob(OWNERS_JOB))] }));
  const records = splitStream(framesOnPort(response, "lcc_records")[0].payload);
  assert.equal(records.length, 1, "the unknown code is skipped, never remapped");
  assert.equal(decodeLcc(records[0]).owner, 120);
  assert.deepEqual(onlyMeta(response, "lcc_meta").provenance.warnings, ["unknown owner code XXXX"]);
});

test("parse_satcat_reference falls back to now for RETRIEVED_AT when the response carries no Date", async (t) => {
  const harness = await createHarness(t);
  const before = Math.floor(Date.now() / 1000);
  const response = ok(await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [responseInput(SOURCES_HTML, icnJob(OWNERS_JOB), { headers: {} })],
  }));
  const retrieved = decodeLcc(splitStream(framesOnPort(response, "lcc_records")[0].payload)[0]).retrievedAt;
  const seconds = Math.floor(Date.parse(retrieved) / 1000);
  assert.ok(seconds >= before - 5 && seconds <= before + 120, `${retrieved} is not now`);
});

test("parse_satcat_reference: 304 -> one unchanged notice only", async (t) => {
  const harness = await createHarness(t);
  const response = ok(await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [responseInput(null, icnJob(SITES_JOB), { status: 304 })],
  }));
  assert.deepEqual(response.outputs.map((f) => f.portId), ["unchanged"]);
  assert.deepEqual(onlyNotice(response), {
    kind: "unchanged", schema: "SIT.fbs", providerId: "space-data-network-02", sourceName: "celestrak-satcat-launch-sites",
    batchId: "", count: 1, reason: "not-modified", items: [SITES_JOB.sourceUrl], atMs: 0,
  });
});

test("parse_satcat_reference rejects non-200 fetches, unknown reference datasets and responses without a job", async (t) => {
  const harness = await createHarness(t);
  const failed = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [responseInput(null, icnJob(SITES_JOB), { status: 503 })],
  });
  assert.notEqual(failed.statusCode, 0);
  assert.equal(failed.errorCode, "fetch-failed");
  assert.match(failed.errorMessage ?? "", /503/);

  const unknown = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [responseInput(LAUNCHSITES_HTML, icnJob({ ...SITES_JOB, datasetId: "satcat" }))],
  });
  assert.notEqual(unknown.statusCode, 0);
  assert.equal(unknown.errorCode, "unknown-reference-dataset");

  const lost = await harness.invoke({ methodId: "parse_satcat_reference", inputs: [responseInput(LAUNCHSITES_HTML, encodeTimerTick({}))] });
  assert.equal(lost.errorCode, "missing-context");
  assert.equal(lost.outputs.length, 0);
});

// End to end through both nodes: the builder's own requests, answered with the fixture pages, parse into the lanes.
test("satcat_reference -> parse_satcat_reference: each job routes its page to its standard", async (t) => {
  const builder = await createHarness(t);
  const built = await builder.invoke({ methodId: "satcat_reference", inputs: [tickInput()] });
  const [sites] = requestsOn(built, "request_sites");
  const [owners] = requestsOn(built, "request_owners");
  const parser = await createHarness(t);
  const sitOut = ok(await parser.invoke({ methodId: "parse_satcat_reference", inputs: [responseInput(LAUNCHSITES_HTML, sites.context)] }));
  const lccOut = ok(await parser.invoke({ methodId: "parse_satcat_reference", inputs: [responseInput(SOURCES_HTML, owners.context)] }));
  const sitMeta = onlyMeta(sitOut, "sit_meta");
  const lccMeta = onlyMeta(lccOut, "lcc_meta");
  assert.equal(sitMeta.tags.license, LICENSE_REF, "the default usage terms are prose");
  assert.match(readJob(sites.context).LICENSE, /Only download the data you need/, "the verbatim terms stay in the job");
  assert.deepEqual([sitMeta.tags.sourceUrl, lccMeta.tags.sourceUrl], [sites.url, owners.url]);
  assert.deepEqual([sitMeta.archive.name, lccMeta.archive.name], ["launchsites.html", "sources.html"]);
});
