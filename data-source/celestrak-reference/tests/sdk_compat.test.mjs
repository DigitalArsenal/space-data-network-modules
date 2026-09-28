// data-source/celestrak-reference SDK-compat tests (fbcs-06b): the GP group
// and SATCAT reference nodes run in the SDK browser harness against fixture
// payloads shaped after one polite live read of the CelesTrak pages, and their
// outputs are asserted structurally: request URLs and byte budgets, job
// attribution (origin, dataset, licence), $EGP / $SIT / $LCC record streams
// with the right file identifiers and field values, batch ids, provenance
// warnings, the count-mismatch refusal and the 304 path.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import {
  CelestialFrame,
  CelestialFrameWrapper,
  OMM,
  RFMUnion,
} from "spacedatastandards.org/lib/js/OMM/main.js";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const STATIONS_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-group-stations.csv", import.meta.url));
const GPZ_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-group-gpz.csv", import.meta.url));
const LAUNCHSITES_HTML = fs.readFileSync(new URL("./fixtures/celestrak-launchsites.html", import.meta.url));
const SOURCES_HTML = fs.readFileSync(new URL("./fixtures/celestrak-sources.html", import.meta.url));

const GP_BASE = "https://celestrak.org/NORAD/elements/gp.php";
const DATE_HEADER = "Thu, 04 Sep 2026 01:57:53 GMT";
const DATE_RFC3339 = "2026-09-04T01:57:53Z";
const DATE_RFC3339_MS = "2026-09-04T01:57:53.000Z";

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

// Aligned typeRefs REQUIRE requiredAlignment and byteLength (SDK invoke codec).
function bytesInput(portId, payload) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function jsonInput(portId, value) {
  return bytesInput(portId, encoder.encode(JSON.stringify(value)));
}

function tickInput() {
  return jsonInput("tick", { firedAt: "2026-09-04T00:00:00Z" });
}

function httpResponse(bodyBytes, { status = 200, headers = { date: DATE_HEADER }, extra = {} } = {}) {
  return {
    status,
    headers,
    bodyB64: bodyBytes ? Buffer.from(bodyBytes).toString("base64") : "",
    ...extra,
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createConfigStub(config = {}) {
  const calls = [];
  const dispatch = (operation) => {
    calls.push(operation);
    if (operation === "plugin.getConfig") return config;
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub = createConfigStub()) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function framesOnPort(response, portId) {
  return response.outputs.filter((frame) => frame.portId === portId);
}

function jsonFrames(response, portId) {
  return framesOnPort(response, portId).map((frame) => JSON.parse(decoder.decode(frame.payload)));
}

function onlyJson(response, portId) {
  const frames = jsonFrames(response, portId);
  assert.equal(frames.length, 1, `expected exactly one frame on ${portId}`);
  return frames[0];
}

function provenanceOf(meta) {
  return JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
}

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

// The gp_groups job for a two-group list, exactly as the builder emits it.
async function twoGroupJob(t) {
  const harness = await createHarness(t, createConfigStub({ celestrak_gp_groups: "stations,gpz" }));
  const response = await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return onlyJson(response, "job");
}

// ---------------------------------------------------------------------------
// Artifact.
// ---------------------------------------------------------------------------

test("celestrak-reference artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
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

test("gp_groups emits the 47 GROUP + 2 SPECIAL requests in page order and one job listing them", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);

  const requests = jsonFrames(response, "request");
  assert.equal(requests.length, 49, "47 GROUP + 2 SPECIAL");
  assert.deepEqual(
    requests.map((r) => r.url),
    DEFAULT_GROUPS.map(([kind, token]) => groupURL(kind, token)),
    "request URLs are exact and in page order",
  );
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.timeoutMs, 90000, "runner HTTPTimeout default");
    assert.equal(request.maxBytes, 8388608, "8 MiB per group");
  }

  const job = onlyJson(response, "job");
  assert.equal(job.source_name, "celestrak-gp-groups");
  assert.equal(job.source_url, "https://celestrak.org/NORAD/elements/");
  assert.equal(job.provider_id, "space-data-network-02");
  assert.equal(job.archive_source, "celestrak");
  assert.equal(job.archive_name, "gp-groups.csv");
  assert.equal(job.origin_id, "celestrak.org");
  assert.equal(job.origin_name, "CelesTrak");
  assert.equal(job.dataset_id, "gp-groups");
  assert.equal(job.license_url, "https://celestrak.org/usage-policy.php");
  assert.match(job.license, /Only download the data you need/);
  assert.match(job.citation, /CelesTrak/);
  assert.equal(job.group_count, 49);
  assert.deepEqual(
    job.groups.map((g) => [g.kind, g.token]),
    DEFAULT_GROUPS,
    "the job lists the same groups in the same order",
  );
  assert.deepEqual(job.groups.map((g) => g.url), requests.map((r) => r.url));
  assert.equal(job.groups.find((g) => g.token === "stations").label, "Space Stations");
  assert.equal(job.groups.find((g) => g.token === "gpz").label, "GEO Protected Zone");
  assert.deepEqual(stub.calls, ["plugin.getConfig"]);
});

test("gp_groups: node CONFIG celestrak_gp_groups shrinks the list; provider/licence overrides reach the job", async (t) => {
  const harness = await createHarness(
    t,
    createConfigStub({
      celestrak_gp_groups: "stations, gpz ,stations",
      celestrak_provider_id: "prov-test",
      celestrak_license: "test terms",
      celestrak_license_url: "https://fixtures.test/terms",
      celestrak_citation: "Fixture citation",
      celestrak_http_timeout_ms: 5000,
    }),
  );
  const response = await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const requests = jsonFrames(response, "request");
  assert.deepEqual(
    requests.map((r) => r.url),
    [groupURL("GROUP", "stations"), groupURL("SPECIAL", "gpz")],
    "deduplicated, trimmed, SPECIAL kind resolved from the registry",
  );
  assert.equal(requests[0].timeoutMs, 5000);
  const job = onlyJson(response, "job");
  assert.equal(job.group_count, 2);
  assert.equal(job.provider_id, "prov-test");
  assert.equal(job.license, "test terms");
  assert.equal(job.license_url, "https://fixtures.test/terms");
  assert.equal(job.citation, "Fixture citation");
});

test("gp_groups refuses a list longer than one flow invocation can carry", async (t) => {
  const tokens = Array.from({ length: 64 }, (_, i) => `group-${i}`).join(",");
  const harness = await createHarness(t, createConfigStub({ celestrak_gp_groups: tokens }));
  const response = await harness.invoke({ methodId: "gp_groups", inputs: [tickInput()] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-group-list");
  assert.equal(response.outputs.length, 0);
});

// ---------------------------------------------------------------------------
// parse_gp_groups.
// ---------------------------------------------------------------------------

test("parse_gp_groups emits one $EGP per group with membership, tags, query and provenance", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(STATIONS_CSV)),
      jsonInput("response", httpResponse(GPZ_CSV)),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(framesOnPort(response, "unchanged").length, 0);

  const concat = Buffer.concat([STATIONS_CSV, GPZ_CSV]);
  const meta = onlyJson(response, "egp_meta");
  assert.equal(meta.schema, "EGP.fbs");
  assert.equal(meta.provider_id, "space-data-network-02");
  assert.equal(meta.source_name, "celestrak-gp-groups");
  assert.equal(meta.source_url, "https://celestrak.org/NORAD/elements/");
  assert.equal(meta.batch_id, sha256Hex(concat), "batch id = sha256 of the concatenated payloads in list order");
  assert.equal(meta.content_key_id, "public");
  assert.equal(meta.source_peer, "source:celestrak");
  assert.equal(meta.reconcile, "current", "a complete snapshot supersedes the lane");
  assert.equal(meta.origin_id, "celestrak.org");
  assert.equal(meta.origin_name, "CelesTrak");
  assert.equal(meta.dataset_id, "gp-groups");
  assert.equal(meta.license_url, "https://celestrak.org/usage-policy.php");
  assert.match(meta.license, /Only download the data you need/);
  assert.deepEqual(meta.archive, { source: "celestrak", name: "gp-groups.csv" });
  assert.equal(meta.provenance.source, "celestrak-gp-groups");
  const provenance = provenanceOf(meta);
  assert.equal(provenance.parser_version, "celestrak-gp-groups-wasm/v1");
  assert.equal(provenance.source_sha256, sha256Hex(concat));
  assert.equal(provenance.retrieved_at, DATE_RFC3339);
  assert.equal(provenance.schema_counts["EGP.fbs"], 2);
  assert.equal(provenance.normalized_count, 2);
  assert.deepEqual(provenance.groups, ["stations", "gpz"]);
  assert.deepEqual(provenance.group_urls, [groupURL("GROUP", "stations"), groupURL("SPECIAL", "gpz")]);
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.origin_id, "celestrak.org");
  assert.equal(provenance.dataset_id, "gp-groups");

  const raw = framesOnPort(response, "raw");
  assert.equal(raw.length, 1);
  assert.deepEqual(Buffer.from(raw[0].payload), concat, "raw archive = the hashed concatenation");

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
  assert.match(stations.provenance[0].license, /Only download the data you need/);
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

test("parse_gp_groups refuses a response count that differs from the job list (group-count-mismatch)", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [jsonInput("job", job), jsonInput("response", httpResponse(STATIONS_CSV))],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "group-count-mismatch");
  assert.equal(response.outputs.length, 0, "nothing is published partially");
});

test("parse_gp_groups refuses a response that names a different request URL (group-url-mismatch)", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(STATIONS_CSV, { extra: { url: groupURL("GROUP", "stations") } })),
      jsonInput("response", httpResponse(GPZ_CSV, { extra: { url: groupURL("GROUP", "active") } })),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "group-url-mismatch");
});

test("parse_gp_groups: every group 304 -> one unchanged frame, no records", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(null, { status: 304 })),
      jsonInput("response", httpResponse(null, { status: 304 })),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(
    response.outputs.map((f) => f.portId),
    ["unchanged"],
    "304 -> unchanged frame only",
  );
  const unchanged = onlyJson(response, "unchanged");
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.source_name, "celestrak-gp-groups");
  assert.equal(unchanged.dataset_id, "gp-groups");
  assert.equal(unchanged.origin_id, "celestrak.org");
  assert.deepEqual(unchanged.groups, ["stations", "gpz"]);
  assert.equal(unchanged.changed_count, 0);
});

test("parse_gp_groups: a partial refresh appends the changed groups and reports the unchanged ones", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(null, { status: 304 })),
      jsonInput("response", httpResponse(GPZ_CSV)),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const unchanged = onlyJson(response, "unchanged");
  assert.deepEqual(unchanged.groups, ["stations"]);
  assert.equal(unchanged.changed_count, 1);
  const meta = onlyJson(response, "egp_meta");
  assert.equal(meta.reconcile, "duplicates", "a partial refresh never supersedes the unchanged groups");
  assert.equal(meta.batch_id, sha256Hex(GPZ_CSV), "batch id hashes the payloads received");
  const records = splitStream(framesOnPort(response, "egp_records")[0].payload);
  assert.equal(records.length, 1);
  assert.equal(decodeEgp(records[0]).groupId, "celestrak.org/gp/gpz");
  assert.deepEqual(provenanceOf(meta).unchanged_groups, ["stations"]);
});

test("parse_gp_groups fails the batch on any other non-200 status (usage policy)", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(STATIONS_CSV)),
      jsonInput("response", httpResponse(null, { status: 403 })),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /gpz.*403/);
  assert.equal(response.outputs.length, 0);
});

test("parse_gp_groups re-emits OMM rows only when celestrak_gp_groups_emit_omm is set", async (t) => {
  const job = await twoGroupJob(t);
  const harness = await createHarness(t, createConfigStub({ celestrak_gp_groups_emit_omm: true }));
  const response = await harness.invoke({
    methodId: "parse_gp_groups",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", httpResponse(STATIONS_CSV)),
      jsonInput("response", httpResponse(GPZ_CSV)),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const ommMeta = onlyJson(response, "omm_meta");
  assert.equal(ommMeta.schema, "OMM.fbs");
  assert.equal(ommMeta.reconcile, "duplicates");
  assert.equal(ommMeta.source_name, "celestrak-gp-groups");
  assert.equal(ommMeta.archive, undefined, "payload archived once (EGP meta only)");
  const omm = splitStream(framesOnPort(response, "omm_records")[0].payload);
  assert.equal(omm.length, 4, "two rows per fixture group");
  for (const record of omm) assert.equal(fileIdentifier(record), "$OMM");
  assert.equal(provenanceOf(onlyJson(response, "egp_meta")).schema_counts["OMM.fbs"], 4);
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

test("satcat_reference emits the launch-site and owner table fetches with their jobs", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({ methodId: "satcat_reference", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);

  const sites = onlyJson(response, "request_sites");
  assert.equal(sites.url, "https://celestrak.org/satcat/launchsites.php");
  assert.equal(sites.method, "GET");
  assert.equal(sites.maxBytes, 2097152);
  const owners = onlyJson(response, "request_owners");
  assert.equal(owners.url, "https://celestrak.org/satcat/sources.php");
  assert.equal(owners.maxBytes, 2097152);

  const jobSites = onlyJson(response, "job_sites");
  assert.equal(jobSites.source_name, "celestrak-satcat-launch-sites");
  assert.equal(jobSites.dataset_id, "satcat-launch-sites");
  assert.equal(jobSites.source_url, sites.url);
  assert.equal(jobSites.archive_name, "launchsites.html");
  assert.equal(jobSites.origin_id, "celestrak.org");
  const jobOwners = onlyJson(response, "job_owners");
  assert.equal(jobOwners.source_name, "celestrak-satcat-owners");
  assert.equal(jobOwners.dataset_id, "satcat-owners");
  assert.equal(jobOwners.source_url, owners.url);
  assert.equal(jobOwners.archive_name, "sources.html");
  assert.equal(jobOwners.license_url, "https://celestrak.org/usage-policy.php");
  assert.deepEqual(stub.calls, ["plugin.getConfig"]);
});

test("satcat_reference honours node-CONFIG page URL overrides", async (t) => {
  const harness = await createHarness(
    t,
    createConfigStub({
      celestrak_satcat_launchsites_url: "https://fixtures.test/launchsites.html",
      celestrak_satcat_sources_url: "https://fixtures.test/sources.html",
    }),
  );
  const response = await harness.invoke({ methodId: "satcat_reference", inputs: [tickInput()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(onlyJson(response, "request_sites").url, "https://fixtures.test/launchsites.html");
  assert.equal(onlyJson(response, "request_owners").url, "https://fixtures.test/sources.html");
  assert.equal(onlyJson(response, "job_owners").source_url, "https://fixtures.test/sources.html");
});

// ---------------------------------------------------------------------------
// parse_satcat_reference.
// ---------------------------------------------------------------------------

const SITES_JOB = {
  source_url: "https://celestrak.org/satcat/launchsites.php",
  source_name: "celestrak-satcat-launch-sites",
  provider_id: "space-data-network-02",
  archive_source: "celestrak",
  archive_name: "launchsites.html",
  origin_id: "celestrak.org",
  origin_name: "CelesTrak",
  dataset_id: "satcat-launch-sites",
  license: "test terms",
  license_url: "https://fixtures.test/terms",
  citation: "Fixture citation",
};

const OWNERS_JOB = {
  ...SITES_JOB,
  source_url: "https://celestrak.org/satcat/sources.php",
  source_name: "celestrak-satcat-owners",
  archive_name: "sources.html",
  dataset_id: "satcat-owners",
};

test("parse_satcat_reference turns the launch-site table into $SIT rows with entities decoded", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", SITES_JOB), jsonInput("response", httpResponse(LAUNCHSITES_HTML))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(
    response.outputs.map((f) => f.portId).sort(),
    ["raw", "sit_meta", "sit_records"],
  );

  const meta = onlyJson(response, "sit_meta");
  assert.equal(meta.schema, "SIT.fbs");
  assert.equal(meta.reconcile, "current");
  assert.equal(meta.batch_id, sha256Hex(LAUNCHSITES_HTML));
  assert.equal(meta.source_name, "celestrak-satcat-launch-sites");
  assert.equal(meta.dataset_id, "satcat-launch-sites");
  assert.equal(meta.origin_id, "celestrak.org");
  assert.equal(meta.license, "test terms");
  assert.equal(meta.citation, "Fixture citation");
  assert.deepEqual(meta.archive, { source: "celestrak", name: "launchsites.html" });
  const provenance = provenanceOf(meta);
  assert.equal(provenance.parser_version, "celestrak-satcat-reference-wasm/v1");
  assert.equal(provenance.schema_counts["SIT.fbs"], 3);
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.retrieved_at, DATE_RFC3339);

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
  assert.deepEqual(Buffer.from(framesOnPort(response, "raw")[0].payload), LAUNCHSITES_HTML);
});

test("parse_satcat_reference turns the owner table into $LCC rows with exact enum codes", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", OWNERS_JOB), jsonInput("response", httpResponse(SOURCES_HTML))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(
    response.outputs.map((f) => f.portId).sort(),
    ["lcc_meta", "lcc_records", "raw"],
  );
  const meta = onlyJson(response, "lcc_meta");
  assert.equal(meta.schema, "LCC.fbs");
  assert.equal(meta.reconcile, "current");
  assert.equal(meta.source_name, "celestrak-satcat-owners");
  assert.equal(meta.dataset_id, "satcat-owners");
  assert.equal(meta.batch_id, sha256Hex(SOURCES_HTML));
  assert.deepEqual(provenanceOf(meta).warnings, []);

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
    assert.equal(owner.sourceUrl, OWNERS_JOB.source_url);
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
  const response = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", OWNERS_JOB), jsonInput("response", httpResponse(html))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage ?? "an unknown code is a warning, not an error");
  const records = splitStream(framesOnPort(response, "lcc_records")[0].payload);
  assert.equal(records.length, 1, "the unknown code is skipped, never remapped");
  assert.equal(decodeLcc(records[0]).owner, 120);
  assert.deepEqual(provenanceOf(onlyJson(response, "lcc_meta")).warnings, ["unknown owner code XXXX"]);
});

test("parse_satcat_reference falls back to now for RETRIEVED_AT when the response carries no Date", async (t) => {
  const harness = await createHarness(t);
  const before = Math.floor(Date.now() / 1000);
  const response = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", OWNERS_JOB), jsonInput("response", httpResponse(SOURCES_HTML, { headers: {} }))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const retrieved = decodeLcc(splitStream(framesOnPort(response, "lcc_records")[0].payload)[0]).retrievedAt;
  const seconds = Math.floor(Date.parse(retrieved) / 1000);
  assert.ok(seconds >= before - 5 && seconds <= before + 120, `${retrieved} is not now`);
});

test("parse_satcat_reference: 304 -> one unchanged frame only", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", SITES_JOB), jsonInput("response", httpResponse(null, { status: 304 }))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs.map((f) => f.portId), ["unchanged"]);
  const unchanged = onlyJson(response, "unchanged");
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.source_name, "celestrak-satcat-launch-sites");
  assert.equal(unchanged.dataset_id, "satcat-launch-sites");
});

test("parse_satcat_reference rejects non-200 fetches and unknown reference datasets", async (t) => {
  const harness = await createHarness(t);
  const failed = await harness.invoke({
    methodId: "parse_satcat_reference",
    inputs: [jsonInput("job", SITES_JOB), jsonInput("response", httpResponse(null, { status: 503 }))],
  });
  assert.notEqual(failed.statusCode, 0);
  assert.equal(failed.errorCode, "fetch-failed");
  assert.match(failed.errorMessage ?? "", /503/);

  const harness2 = await createHarness(t);
  const unknown = await harness2.invoke({
    methodId: "parse_satcat_reference",
    inputs: [
      jsonInput("job", { ...SITES_JOB, dataset_id: "satcat" }),
      jsonInput("response", httpResponse(LAUNCHSITES_HTML)),
    ],
  });
  assert.notEqual(unknown.statusCode, 0);
  assert.equal(unknown.errorCode, "unknown-reference-dataset");
});
