import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { createStandaloneHarnessOrSkip } from "space-data-module-sdk/testing/isomorphic";
import { encodeTimerTick, encodeHttpResponse, decodeHttpRequest, decodeHttpResponse, decodeIngestRequest, decodeFlowNotice } from "space-data-module-sdk/runtime-contracts";
import { deepSpaceFlow } from "../flow.mjs";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

// Independent source: NASA/JPL Horizons TLIST queries, not module outputs.
// Epochs: the fixture's JD TDB; center: Sun; frame: ICRF; units: km and km/s.
// Position tolerance: 1 km, a conservative bound above the independent Python
// contract implementation's <= 0.0015 km Hermite error at these 60 epochs.
// All CSV parsing and interpolation run in C++/WASM, including record mode.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(root, "tests/fixtures/horizons");
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { ByteBuffer } = require("flatbuffers");
const sdkRoot = path.dirname(path.dirname(require.resolve("space-data-module-sdk")));
const { IngestRequest } = await import(pathToFileURL(path.join(sdkRoot, "src/generated/runtime/sdn/runtime/IngestRequest.js")));
const { EGP, egpMembershipMode } = await import(pathToFileURL(path.join(sds, "lib/js/EGP/main.js")));
const { OEM, timingStandard, CelestialFrame, RFMUnion } = await import(pathToFileURL(path.join(sds, "lib/js/OEM/main.js")));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json")));
const wasmPath = path.join(root, "dist/isomorphic/module.wasm");
const cassette = JSON.parse(gunzipSync(fs.readFileSync(path.join(fixtureRoot, "cassette.json.gz"))));
const reference = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "reference.json")));
const events = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "events-table.json")));
const record = process.env.HORIZONS_RECORD === "1";
const ids = [-143205, -31, -32, -23, -24, -98, -96, -170, -61, -159, -49, -255, -64];
const licence = "NASA/JPL Horizons On-Line Ephemeris System (Solar System Dynamics Group): U.S. Government work, public domain";
const credit = "Ephemeris: NASA/JPL-Caltech Horizons";
const J = (bytes) => JSON.parse(Buffer.from(bytes).toString());
const outs = (result, port) => result.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));
const firedMs = Date.UTC(2026, 9, 21, 12, 34, 56);
const producer = "source:deep-space-test";
const catalogIds = ["lunar-orbit", "cislunar", "earth-moon-lagrange", "sun-earth-l1", "sun-earth-l2",
  "mercury-orbit", "venus-orbit", "mars-orbit", "jupiter-orbit", "saturn-orbit", "heliocentric"];
const runtimeType = (name, id) => ({ schemaName: `${name}.fbs`, fileIdentifier: id, rootTypeName: name, wireFormat: "flatbuffer" });
const tick = (at = firedMs) => ({ portId: "tick", typeRef: runtimeType("TimerTick", "TICK"), payload: encodeTimerTick({ triggerId: "daily", firedMs: at }) });
function planOptions(config = {}, at = firedMs) {
  // The fixture's historical dictionary is translated only at the test boundary;
  // the host delivers ModuleConfig TableList/NumberList, never a JSON input port.
  const { now_tdb, limits, ...options } = config;
  if (now_tdb) at = Date.parse(now_tdb + "Z");
  const hostConfig = { deep_space_enabled: true, producer_peer_id: producer, ...options,
    ...(limits ? { limits: Object.entries(limits).map(([id, bounds]) => ({ id: Number(id), ...bounds })) } : {}) };
  return { config: hostConfig, request: { methodId: "plan_horizons", inputs: [tick(at)] } };
}
async function plan(config = {}, at = firedMs) {
  const planned = planOptions(config, at);
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct", hostOptions: { config: planned.config } });
  try { return await h.invoke(planned.request); }
  finally { await h.destroy(); }
}
function splitStream(bytes, identifier) {
  const out = [];
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset) + 4;
    assert.ok(size > 12 && offset + size <= bytes.length);
    const record = bytes.subarray(offset, offset + size);
    assert.equal(record.subarray(8, 12).toString(), identifier);
    out.push(record); offset += size;
  }
  return out;
}
function recordEntries(result) {
  return catalogIds.flatMap((catalog) => outs(result, catalog.replaceAll("-", "_") + "_records").flatMap((stream) =>
    splitStream(stream, "$OEM").map((bytes) => {
      const block = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0];
      return { bytes, catalog, naif_id: block.OBJECT_NAIF_ID, lifecycle: /LIFECYCLE: (active|ended)/.exec(block.COMMENT)[1] };
    })));
}
const recordBytes = (result) => recordEntries(result).map((r) => r.bytes);
const lanes = (result) => recordEntries(result).map(({ bytes, ...lane }) => lane);
const missing = (result) => outs(result, "notice").map(decodeFlowNotice).filter((n) => n.kind === "missing")
  .map((n) => ({ naif_id: Number(n.items[0]), skipped: n.reason }));
const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  const typeRef = portId === "response" ? runtimeType("HttpResponse", "HRSP") : portId === "oem"
    ? { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" }
    : { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length };
  return { portId, payload, typeRef };
};
const ok = (result, stage) => {
  assert.equal(result.statusCode, 0, `${stage}: ${result.errorCode}: ${result.errorMessage}`);
  for (const frame of result.outputs) {
    if (["state", "states", "result"].includes(frame.portId)) continue;
    assert.equal(frame.typeRef.wireFormat, "flatbuffer", frame.portId);
    const bytes = Buffer.from(frame.payload), stream = frame.portId.endsWith("_records");
    if (bytes.length) assert.equal(bytes.subarray(stream ? 8 : 4, stream ? 12 : 8).toString(), frame.typeRef.fileIdentifier);
    assert.throws(() => JSON.parse(bytes.toString()), `${frame.portId} must never emit JSON`);
  }
};
function namedFailure(result, name) {
  assert.notEqual(result.statusCode, 0);
  assert.match(result.errorCode ?? "", name);
  assert.equal(recordBytes(result).length, 0);
}
function skippedCraft(result, id, code) {
  ok(result, `skip ${id}`);
  const state = outs(result, "state")[0];
  let skipped;
  if (state) {
    const stored = J(state).craft.find((c) => c.id === id);
    skipped = stored.skipped;
    assert.equal(Object.hasOwn(stored, "groups"), false, "skipping releases every group's stored rows");
    assert.ok(decodeFlowNotice(outs(result, "status")[0]).items.includes(`${id}:${skipped}`));
  } else skipped = missing(result).find((c) => c.naif_id === id).skipped;
  assert.match(skipped, code);
  return skipped;
}
function params(url) {
  return Object.fromEntries([...new URL(url).searchParams].map(([k, v]) => [k, v.replace(/^'(.*)'$/s, "$1")]));
}
function key(url) {
  const p = params(url);
  return Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("|");
}
function requestShape(request) {
  assert.equal(request.method, "GET");
  assert.equal(new URL(request.url).origin + new URL(request.url).pathname, "https://ssd.jpl.nasa.gov/api/horizons.api");
  assert.deepEqual(request.headers, {});
  assert.ok(!request.url.includes("sdn-range") && !request.url.includes("+"));
  for (const [name, value] of new URL(request.url).searchParams) {
    if (name !== "format") assert.match(value, /^'.*'$/s, name);
  }
  const p = params(request.url);
  assert.ok(["1 d", "5 m", "10 m", "15 m"].includes(p.STEP_SIZE));
  // Calendar subtraction only counts the requested grid; it does not convert
  // TDB to UTC or calculate trajectories. Both strings are the same time scale.
  const first = Date.parse(p.START_TIME.replace(" ", "T") + "Z");
  const last = Date.parse(p.STOP_TIME.replace(" ", "T") + "Z");
  const rows = (last - first) / (p.STEP_SIZE === "1 d" ? 86400000 : Number.parseInt(p.STEP_SIZE) * 60000) + 1;
  assert.ok(Number.isInteger(rows) && rows >= 1 && rows <= 80000, `requested ${rows} rows`);
}
function respond(body, status = 200, error = "") {
  return encodeHttpResponse({ status, body: Buffer.from(body), error });
}
function compactResponse(body) {
  const end = body.indexOf("$$EOE");
  return end < 0 ? body : body.slice(0, end + "$$EOE".length) + "\n";
}
let hasFetched = false;
async function fetchText(request) {
  assert.equal(record, true, "network access is restricted to explicit HORIZONS_RECORD=1");
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (hasFetched) await delay(700);
    hasFetched = true;
    try {
      const response = await fetch(request.url, { method: "GET", headers: request.headers, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Horizons HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

async function runAll(h, answer) {
  let result = await h.invoke(planOptions(cassette.config).request);
  ok(result, "plan_horizons");
  const keys = [], requestsSeen = [], snapshots = [];
  for (const methodId of [...Array(6).fill("advance"), "build_oem"]) {
    const requests = outs(result, "request").map(decodeHttpRequest);
    assert.ok(requests.length <= 60, `${methodId} received ${requests.length} requests`);
    const responses = [];
    for (const request of requests) {
      requestShape(request);
      keys.push(key(request.url));
      requestsSeen.push(request);
      responses.push(respond(await answer(request)));
    }
    const state = outs(result, "state");
    assert.equal(state.length, 1);
    const inputs = [input("state", state[0]), ...responses.map((r) => input("response", r))];
    snapshots.push({ methodId, inputs, requests });
    result = await h.invoke({ methodId, inputs });
    ok(result, `${methodId} ${snapshots.length}`);
  }
  assert.equal(outs(result, "request").length, 0);
  assert.equal(keys.length, 29);
  assert.equal(new Set(keys).size, keys.length, "a request must not be duplicated");
  assert.deepEqual([...keys].sort(), Object.keys(cassette.responses).sort(), "the independent cassette defines the exact request set");
  return { result, keys, requestsSeen, snapshots, records: recordBytes(result) };
}

function checkGroups(result) {
  const catalogLanes = lanes(result);
  const frames = outs(result, "catalogs_records");
  assert.equal(frames.length, 1);
  const groups = [], bytes = frames[0];
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset) + 4;
    assert.ok(size > 12 && offset + size <= bytes.length);
    const frame = bytes.subarray(offset, offset + size);
    assert.equal(frame.subarray(8, 12).toString(), "$EGP");
    groups.push(EGP.getSizePrefixedRootAsEGP(new ByteBuffer(frame)).unpack());
    offset += size;
  }
  assert.deepEqual(groups.map((g) => g.GROUP_ID), [...new Set(catalogLanes.map((c) => `deep-space-spacecraft/${c.catalog}`))]);
  for (const group of groups) {
    const lane = group.GROUP_ID.split("/")[1];
    const cadence = ["heliocentric", "sun-earth-l1", "sun-earth-l2"].includes(lane) ? "168h" : "24h";
    assert.deepEqual(group.TAGS, [`cadence:${cadence}`, "class:query", "environment:space",
      "provisioner:deep-space-spacecraft", `regime:${lane}`, "schema:oem", `source:${lane}`]);
    assert.equal(group.MEMBERSHIP_MODE, egpMembershipMode.QUERY_LIVE);
    assert.equal(group.QUERY.DIALECT, "sdn-data-query");
    assert.deepEqual(JSON.parse(group.QUERY.TEXT), { schema: "OEM.fbs", provider_id: "deep-space-spacecraft", source_name: lane });
    assert.equal(group.QUERY.RESULT_COUNT, catalogLanes.filter((c) => c.catalog === lane).length);
    assert.ok(group.NAME && group.DESCRIPTION.includes(`${group.QUERY.RESULT_COUNT} objects`));
    assert.equal(group.PROVENANCE[0].SOURCE, "NASA/JPL Horizons");
    assert.equal(group.PROVENANCE[0].SOURCE_URL, "https://ssd.jpl.nasa.gov/api/horizons.api");
    assert.equal(group.PROVENANCE[0].LICENSE, licence);
    assert.equal(group.PROVENANCE[0].ATTRIBUTION, credit);
  }
  checkMetas(result, Date.parse(groups[0]?.UPDATED_AT ?? new Date(firedMs).toISOString()));
  return groups;
}

function checkMetas(result, expectedMs = firedMs) {
  const entries = recordEntries(result), expectedPorts = [], sourceUrl = "https://ssd.jpl.nasa.gov/api/horizons.api";
  for (const id of [...catalogIds, "catalogs"]) {
    const prefix = id.replaceAll("-", "_"), records = outs(result, `${prefix}_records`), metas = outs(result, `${prefix}_meta`);
    const members = entries.filter((r) => r.catalog === id);
    assert.equal(records.length, id === "catalogs" || members.length ? 1 : 0, id);
    assert.equal(metas.length, records.length, `one paired meta for ${id}`);
    if (!records.length) continue;
    expectedPorts.push(`${prefix}_records`, `${prefix}_meta`);
    const [stream] = records, schema = id === "catalogs" ? "EGP.fbs" : "OEM.fbs";
    const count = splitStream(stream, id === "catalogs" ? "$EGP" : "$OEM").length;
    const sha = createHash("sha256").update(stream).digest("hex"), meta = decodeIngestRequest(metas[0]);
    assert.equal(meta.schema, schema);
    assert.equal(meta.reconcile, "current");
    for (const [key, value] of Object.entries({ providerId: "deep-space-spacecraft", sourceName: id,
      batchId: sha + (id === "catalogs" ? `@${expectedMs}` : ""), sourceUrl, sourcePeer: producer,
      license: "LicenseRef-NASA-JPL-Horizons-PD", citation: credit })) assert.equal(meta.tags[key], value, `${id}.${key}`);
    const p = meta.provenance;
    for (const [key, value] of Object.entries({ sourceUrl, httpStatus: 200, retrievedMs: expectedMs,
      parser: "deep-space-spacecraft", parserVersion: "0.2.0", normalizedSha256: sha, normalizedCount: count }))
      assert.equal(p[key], value, `${id}.provenance.${key}`);
    // The convenience decoder combines these parallel vectors into a map; verify the wire vectors too.
    const wire = IngestRequest.getRootAsIngestRequest(new ByteBuffer(metas[0])).PROVENANCE();
    assert.equal(wire.schemasLength(), 1); assert.equal(wire.SCHEMAS(0), schema);
    assert.equal(wire.schemaCountsLength(), 1); assert.equal(Number(wire.SCHEMA_COUNTS(0)), count);
    const unique = id === "catalogs" ? [...new Map(entries.map((r) => [r.naif_id, r])).values()] : members;
    assert.deepEqual(p.attributes.map((a) => a.name), unique.map((r) => `naif:${r.naif_id}`));
    for (const [i, r] of unique.entries()) {
      const block = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(r.bytes)).unpack().EPHEMERIS_DATA_BLOCK[0];
      assert.equal(p.attributes[i].value, `${block.OBJECT.OBJECT_NAME}; lifecycle ${r.lifecycle}`);
    }
  }
  assert.deepEqual(result.outputs.filter((f) => f.portId !== "notice").map((f) => f.portId), expectedPorts, "catalog enum order, records then metadata");
  const notices = outs(result, "notice").map(decodeFlowNotice);
  assert.equal(notices.filter((n) => n.kind === "info").length, 1);
  const summary = notices.at(-1);
  assert.equal(summary.kind, "info"); assert.equal(summary.count, entries.length);
  assert.deepEqual(summary.items, catalogIds.map((id) => `${id}:${entries.filter((r) => r.catalog === id).length}`));
  for (const n of notices.slice(0, -1)) {
    assert.equal(n.kind, "missing"); assert.equal(n.items.length, 1); assert.ok(n.reason); assert.equal(n.count, 1);
  }
}

// Inspect transport/grid metadata only: no CSV parsing or physics in JS.
function compactState(snapshot) {
  const state = J(snapshot.inputs[0].payload);
  const absorbed = state.queue.slice(0, state.next - state.pending.length);
  for (const [craftIndex, craft] of state.craft.entries()) {
    for (const [groupIndex, group] of (craft.groups ?? []).entries()) {
      assert.equal(typeof group.data, "string", "state rows are base64, never JSON doubles");
      assert.match(group.data, /^[A-Za-z0-9+/]*$/);
      const bytes = Buffer.from(group.data, "base64");
      assert.equal(bytes.toString("base64"), group.data, "canonical base64 with exact round trip");
      assert.equal(bytes.length % 48, 0, "six little-endian float64 values per retained row");
      const received = absorbed.filter((p) => p.craft === craftIndex && p.group === groupIndex)
        .reduce((n, p) => n + p.rows, 0);
      assert.equal(group.received, received, "complete-grid progress survives daily filtering");
      assert.ok(group.received <= (group.stop - group.start) / group.step + 1);
      let kept = 0;
      for (let index = 0; index < received; index++) {
        const epoch = group.start + index * group.step;
        if (groupIndex || craft.groups.slice(1).every((w) => epoch <= w.start || epoch >= w.stop)) kept++;
      }
      assert.equal(bytes.length, kept * 48, "only strict window interiors are discarded; both edges remain");
      if (!groupIndex && received) assert.ok(kept < received, "the cassette exercises sparse daily rows");
    }
  }
  return state;
}
function float64Bytes(values) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return bytes;
}

// This helper is compiled only when recording. It uses the same pure C++
// Horizons reader for irregular TLIST rows; JavaScript only transports JSON.
async function referenceParser(t) {
  const { compileModuleFromSource } = await import("space-data-module-sdk/compiler");
  const temporary = fs.mkdtempSync(path.join(root, ".horizons-record-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const headers = ["../../common/civil_time.hpp", "../../common/horizons_vectors.hpp",
    "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"]
    .map((name) => fs.readFileSync(path.join(root, name), "utf8").replace(/^#pragma once\s*$/gm, "")
      .replace(/^#include "(?:.*\/)?civil_time\.hpp"\s*$/gm, ""));
  const source = `
#include "space_data_module_invoke.h"
extern "C" int parse_reference() {
  const auto* f = plugin_get_input_frame(0);
  if (!f || !f->payload) { plugin_set_error("missing-reference", "A Horizons response is required."); return 1; }
  std::vector<double> jd;
  std::vector<std::array<double, 6>> rows;
  std::string error;
  const std::string text(reinterpret_cast<const char*>(f->payload), f->payload_length);
  if (!horizons::parseVectorRows(text, jd, rows, error)) { plugin_set_error(error.c_str(), "Invalid TLIST response."); return 1; }
  const std::string output = nlohmann::json({{"jd", jd}, {"rows", rows}}).dump();
  return plugin_push_output_ex("parsed", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
      nullptr, 0, 1, reinterpret_cast<const uint8_t*>(output.data()), output.size()) < 0 ? 1 : 0;
}`;
  const method = structuredClone(manifest.methods.find((m) => m.methodId === "reconcile_id"));
  method.methodId = "parse_reference";
  method.displayName = "Parse reference TLIST response";
  method.inputPorts[0].portId = "response";
  method.inputPorts[0].acceptedTypeSets[0].wildcardJustification = {
    kind: "foreign-wire-format", mediaType: "text/plain", detail: "Independent Horizons TLIST reference response."
  };
  method.outputPorts[0].portId = "parsed";
  const helperManifest = { ...manifest, pluginId: "com.digitalarsenal.tests.horizons-reference", schemasUsed: [], methods: [method] };
  const outputPath = path.join(temporary, "module.wasm");
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  let built;
  try {
    built = await compileModuleFromSource({ manifest: helperManifest,
      sourceCode: ["#define JSON_NOEXCEPTION 1", ...headers, source].join("\n"),
      language: "c++", outputPath, threadModel: "single-thread" });
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
  assert.equal(built.report?.ok, true, JSON.stringify(built.report?.issues));
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(outputPath), manifest: helperManifest, surface: "direct" });
  t.after(() => h.destroy());
  return async (text) => {
    const result = await h.invoke({ methodId: "parse_reference", inputs: [input("response", Buffer.from(text))] });
    ok(result, "parse_reference");
    return J(outs(result, "parsed")[0]);
  };
}
async function refreshReferences(t, requests) {
  const parse = await referenceParser(t);
  const refreshed = structuredClone(reference);
  for (const sample of Object.values(refreshed)) {
    const request = requests.find((r) => params(r.url).COMMAND === String(sample.naif_id));
    const query = params(request.url);
    delete query.START_TIME; delete query.STOP_TIME; delete query.STEP_SIZE;
    query.TLIST = sample.epochs_jd_tdb.join("\n");
    query.TLIST_TYPE = "JD";
    const encode = (s) => encodeURIComponent(s).replaceAll("'", "%27");
    const url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + Object.entries(query)
      .map(([k, v]) => `${k}=${encode(k === "format" ? v : `'${v}'`)}`).join("&");
    const parsed = await parse(await fetchText({ ...request, url }));
    assert.equal(parsed.rows.length, sample.epochs_jd_tdb.length);
    sample.states_km_kms = parsed.rows;
    sample.horizons_jd_tdb = parsed.jd;
  }
  return refreshed;
}

test("Horizons stages build deterministic Sun-centered OEMs and evaluate independent TLIST states", async (t) => {
  const validation = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: sds });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.match(fs.readFileSync(path.join(root, "../../common/horizons_vectors.hpp"), "utf8"), /kHorizonsLineCap\s*=\s*90024\b/);
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct",
    hostOptions: { config: planOptions(cassette.config).config } });
  t.after(() => h.destroy());
  const defaults = await plan({ objects: ids, now_tdb: "2026-10-21T00:00:00" });
  ok(defaults, "default plan_horizons");
  const objects = J(outs(defaults, "state")[0]).craft.map((c) => ({ naif_id: c.id }));
  assert.deepEqual(objects.map((o) => o.naif_id), ids);
  assert.equal(outs(defaults, "request").length, 26);
  assert.ok(objects.every((o) => Object.hasOwn(events, String(o.naif_id))));
  const identities = [
    { naif_id: -143205, name: "Tesla Roadster", aliases: ["Starman", "SpaceX Roadster", "Falcon Heavy test payload"], cospar: "2018-017A", norad: 43205 },
    { naif_id: -31, name: "Voyager 1", aliases: ["Voyager-1"], cospar: "1977-084A", norad: 10321 },
    { naif_id: -32, name: "Voyager 2", aliases: ["Voyager-2"], cospar: "1977-076A", norad: 10271 },
  ];
  const recorded = {};
  const first = await runAll(h, async (request) => {
    const requestKey = key(request.url);
    if (!record) {
      assert.ok(Object.hasOwn(cassette.responses, requestKey), `unexpected request: ${requestKey}`);
      return cassette.responses[requestKey];
    }
    const body = compactResponse(await fetchText(request));
    recorded[requestKey] = body;
    return body;
  });
  const activeResponses = record ? recorded : cassette.responses;
  const activeReference = record ? await refreshReferences(t, first.requestsSeen) : reference;
  assert.equal(first.records.length, 3);
  const compactStates = first.snapshots.map(compactState);
  const byId = new Map();
  assert.equal(missing(first.result).length, 0);
  for (const [index, bytes] of first.records.entries()) {
    assert.equal(bytes.readUInt32LE(0) + 4, bytes.length, "one complete size-prefixed OEM per frame");
    assert.equal(bytes.subarray(8, 12).toString(), "$OEM");
    // evaluate_oem invokes the generated C++ VerifySizePrefixedOEMBuffer even
    // for no epochs; every output must pass that verifier before JS reads it.
    const verified = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", bytes), input("epochs", { jd_tdb: [] })] });
    ok(verified, "generated OEM verifier");
    assert.deepEqual(J(outs(verified, "states")[0]), []);
    const oem = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(bytes)).unpack();
    assert.equal(oem.CCSDS_OEM_VERS, 3);
    assert.equal(oem.ORIGINATOR, "NASA/JPL Horizons via SDN data-source/deep-space-spacecraft");
    assert.equal(oem.CREATION_DATE, new Date(firedMs).toISOString().replace(".000Z", "Z"));
    const lane = lanes(first.result)[index];
    const identity = identities.find((o) => o.naif_id === lane.naif_id);
    const craftIndex = cassette.config.objects.indexOf(identity.naif_id);
    const blocks = oem.EPHEMERIS_DATA_BLOCK;
    assert.ok(blocks.some((b) => b.STEP_SIZE === 86400));
    assert.ok(blocks.some((b) => b.STEP_SIZE === 600));
    assert.match(blocks[0].COMMENT, /departure/);
    for (const [blockIndex, block] of blocks.entries()) {
      assert.equal(block.OBJECT.OBJECT_NAME, identity.name);
      assert.equal(block.OBJECT.OBJECT_ID, identity.cospar);
      assert.equal(block.OBJECT.NORAD_CAT_ID, identity.norad);
      assert.equal(block.OBJECT_NAIF_ID, identity.naif_id);
      assert.equal(block.CENTER_NAME, "SUN");
      assert.equal(block.CENTER_NAIF_ID, 10);
      assert.equal(block.TIME_SYSTEM, timingStandard.TDB);
      assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME_type, RFMUnion.CelestialFrameWrapper);
      assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, CelestialFrame.ICRF);
      assert.equal(block.INTERPOLATION, "Hermite");
      assert.equal(block.INTERPOLATION_DEGREE, 7);
      assert.equal(block.STATE_VECTOR_SIZE, 6);
      assert.ok(block.EPHEMERIS_DATA.length >= 12 && block.EPHEMERIS_DATA.length % 6 === 0);
      assert.ok(block.COMMENT.includes(`CATALOG: ${lane.catalog}\nLIFECYCLE: ${lane.lifecycle} `));
      assert.ok(block.COMMENT.includes(`ALIASES: ${identity.aliases.join("; ")}`));
      assert.ok(block.COMMENT.includes(licence) && block.COMMENT.includes(credit));
      assert.match(block.START_TIME, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?$/);
      assert.match(block.STOP_TIME, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?$/);
      if (blockIndex) assert.equal(blocks[blockIndex - 1].STOP_TIME, block.START_TIME, "segment edges are shared");
    }
    const dailyBytes = Buffer.from(compactStates.at(-1).craft[craftIndex].groups[0].data, "base64");
    let dailyOffset = 0;
    for (const block of blocks.filter((b) => b.STEP_SIZE === 86400)) {
      const expected = float64Bytes(block.EPHEMERIS_DATA);
      const offset = dailyBytes.indexOf(expected, dailyOffset);
      assert.ok(offset >= dailyOffset && offset % 48 === 0, "daily OEM rows survive sparsification in exact byte order");
      dailyOffset = offset + expected.length;
    }
    byId.set(identity.naif_id, { bytes, blocks });
  }
  assert.equal(outs(first.result, "meta").length, 0);
  assert.deepEqual([...new Set(lanes(first.result).map((c) => c.catalog))], ["heliocentric"]);
  checkGroups(first.result);
  // The cassette/reference contain only Roadster and Voyagers, with no JWST,
  // Earth vectors or geocentric distances. A recorded JWST geometry check is
  // unavailable; below we check partition/row consistency and synthetic rules.
  for (const [label, sample] of Object.entries(activeReference)) {
    assert.equal(sample.epochs_jd_tdb.length, 20);
    const craft = byId.get(sample.naif_id);
    const evaluated = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", craft.bytes), input("epochs", { jd_tdb: sample.epochs_jd_tdb })] });
    ok(evaluated, `evaluate ${label}`);
    const states = J(outs(evaluated, "states")[0]);
    assert.equal(states.length, 20);
    let worst = 0;
    for (const [i, state] of states.entries()) {
      assert.equal(state.jd_tdb, sample.epochs_jd_tdb[i]);
      for (const component of ["x", "y", "z", "vx", "vy", "vz"]) assert.ok(Number.isFinite(state[component]));
      const expected = sample.states_km_kms[i];
      const error = Math.hypot(state.x - expected[0], state.y - expected[1], state.z - expected[2]);
      assert.ok(error <= 1, `${label} JD TDB ${state.jd_tdb}: |dr|=${error} km exceeds 1 km`);
      worst = Math.max(worst, error);
      if (label === "voyager2_neptune") {
        assert.equal(craft.blocks[state.block].STEP_SIZE, 600);
        assert.match(craft.blocks[state.block].COMMENT, /Neptune flyby/);
      }
    }
    t.diagnostic(`${label}: 20 independent Horizons TLIST epochs, worst |dr|=${worst.toFixed(9)} km (limit 1 km; Sun/ICRF/TDB)`);
  }
  const rebuilt = await runAll(h, async (request) => activeResponses[key(request.url)]);
  assert.deepEqual(rebuilt.records, first.records, "a full rebuild must be byte-identical");
  // Horizons cassette JDTDB values for Roadster's first row and the shared
  // departure/daily edge (2018-Feb-07/09 03:00:02 TDB). No interpolation
  // tolerance is involved: both must select the dense departure block.
  const edges = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", byId.get(-143205).bytes),
    input("epochs", { jd_tdb: [2458156.625023148, 2458158.625023148] })] });
  ok(edges, "outer endpoint and shared edge");
  assert.deepEqual(J(outs(edges, "states")[0]).map((s) => s.block), [0, 0]);
  for (const [mission, expected] of [["artemis-ii", -1024], ["", -24]]) {
    const result = await h.invoke({ methodId: "reconcile_id", inputs: [input("request", { mission, kernel_id: -24 })] });
    ok(result, "reconcile_id");
    const reconciled = J(outs(result, "result")[0]);
    assert.equal(reconciled.horizons_id, expected);
    assert.match(reconciled.name, mission ? /Artemis II/i : /Pioneer 11/);
  }
  for (const [snapshot, corrupt, expected] of [
    [first.snapshots.find((s) => s.requests.some((r) => activeResponses[key(r.url)].includes("$$SOE"))),
      (body) => body.slice(0, body.indexOf("$$EOE")), /truncated|missing.*row|vector.*page/],
    [first.snapshots.find((s) => s.requests.some((r) => activeResponses[key(r.url)].includes("$$SOE"))),
      (body) => body.replace("(-143205)", "(-31)"), /vector-target-mismatch/],
  ]) {
    assert.ok(snapshot);
    const inputs = snapshot.inputs.map((f) => ({ ...f }));
    const original = Buffer.from(decodeHttpResponse(inputs[1].payload).body).toString();
    inputs[1] = input("response", respond(corrupt(original)));
    skippedCraft(await h.invoke({ methodId: snapshot.methodId, inputs }), -143205, expected);
  }
  const complete = first.snapshots.at(-1);
  for (const corrupt of [
    (g) => { g.data = []; },
    (g) => { g.data = "!" + g.data.slice(1); },
    (g) => { g.data = Buffer.from(g.data, "base64").subarray(1).toString("base64"); },
    (g) => { g.data += g.data; },
    (g) => { g.data = g.data.slice(64); },
    (g) => { g.data = Buffer.alloc(48, 255).toString("base64") + g.data.slice(64); },
    (g) => { g.received--; },
    (g) => { g.received += 4294967296; },
  ]) {
    const state = J(complete.inputs[0].payload);
    corrupt(state.craft[0].groups[0]);
    const inputs = [input("state", state), ...complete.inputs.slice(1)];
    namedFailure(await h.invoke({ methodId: complete.methodId, inputs }), /invalid-state/);
  }
  const pageSnapshot = first.snapshots.find((s) => {
    const pending = J(s.inputs[0].payload).pending;
    return pending.some((p, i) => i && Number.isInteger(p.group) && p.craft === pending[i - 1].craft && p.group === pending[i - 1].group);
  });
  assert.ok(pageSnapshot);
  const badGroup = J(pageSnapshot.inputs[0].payload);
  badGroup.pending[0].group += 4294967296;
  namedFailure(await h.invoke({ methodId: pageSnapshot.methodId,
    inputs: [input("state", badGroup), ...pageSnapshot.inputs.slice(1)] }), /invalid-state/);
  const pending = J(pageSnapshot.inputs[0].payload).pending;
  const later = pending.findIndex((p, i) => i && Number.isInteger(p.group) && p.craft === pending[i - 1].craft && p.group === pending[i - 1].group);
  const reordered = [...pageSnapshot.inputs];
  [reordered[later], reordered[later + 1]] = [reordered[later + 1], reordered[later]];
  const reorderedId = J(pageSnapshot.inputs[0].payload).craft[pending[later].craft].id;
  skippedCraft(await h.invoke({ methodId: pageSnapshot.methodId, inputs: reordered }), reorderedId, /grid|row|page|order/);
  const outOfOrder = J(pageSnapshot.inputs[0].payload);
  [outOfOrder.pending[later - 1], outOfOrder.pending[later]] = [outOfOrder.pending[later], outOfOrder.pending[later - 1]];
  skippedCraft(await h.invoke({ methodId: pageSnapshot.methodId,
    inputs: [input("state", outOfOrder), ...pageSnapshot.inputs.slice(1)] }), reorderedId, /^out-of-order-vector-page$/);
  const badOem = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", first.records[0].subarray(0, 24)), input("epochs", { jd_tdb: [] })] });
  namedFailure(badOem, /oem|flatbuffer|verif/i);
  const outside = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", first.records[0]), input("epochs", { jd_tdb: [2400000] })] });
  namedFailure(outside, /epoch|range|coverage/i);
  assert.equal(outs(outside, "states").length, 0);
  if (record) {
    fs.writeFileSync(path.join(fixtureRoot, "cassette.json.gz"), gzipSync(JSON.stringify({ config: cassette.config, responses: recorded })));
    fs.writeFileSync(path.join(fixtureRoot, "reference.json"), JSON.stringify(activeReference, null, 2) + "\n");
  }
  t.diagnostic("SDK contract, explicit 13-object selection/26 probes, 3-craft/29-request cassette, OEM verifier/metadata, exact sparse/base64 state, byte-identical rebuild, reconciliation and named failure paths passed.");
});

async function fixtureHarness(t) {
  const { compileModuleFromSource } = await import("space-data-module-sdk/compiler");
  const temporary = fs.mkdtempSync(path.join(root, ".classifier-fixture-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const files = ["../../common/civil_time.hpp", "../../common/horizons_vectors.hpp", "src/packed_rows.hpp",
    "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp", "tests/fixtures/classifier_cases.cpp"];
  const source = files.map((name) => fs.readFileSync(path.join(root, name), "utf8")
    .replace(/^#pragma once\s*$/gm, "").replace(/^#include "(?:.*\/)?civil_time\.hpp"\s*$/gm, "")).join("\n");
  const method = structuredClone(manifest.methods.find((m) => m.methodId === "reconcile_id"));
  method.methodId = "make_fixture";
  const helperManifest = { ...manifest, pluginId: "com.digitalarsenal.tests.classifier-fixture", schemasUsed: [], methods: [method] };
  const outputPath = path.join(temporary, "module.wasm");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  let built;
  try {
    built = await compileModuleFromSource({ manifest: helperManifest, language: "c++", outputPath, threadModel: "single-thread",
      sourceCode: '#define JSON_NOEXCEPTION 1\n#include "space_data_module_invoke.h"\n' + source });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  assert.equal(built.report?.ok, true, JSON.stringify(built.report?.issues));
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(outputPath), manifest: helperManifest, surface: "direct" });
  t.after(() => h.destroy());
  return async (query = {}) => {
    const result = await h.invoke({ methodId: "make_fixture", inputs: [input("request", query)] });
    ok(result, "make_fixture");
    const decoded = J(outs(result, "result")[0]);
    if (Array.isArray(decoded)) for (const c of decoded) Object.assign(c.state.config, { retrieved_ms: firedMs, producer_peer_id: producer });
    return decoded;
  };
}
// Exact error wording copied from the cassette's coverage probes; synthetic bounds.
const coverage = (lower, stamp) => `API VERSION: 1.2\nAPI SOURCE: NASA/JPL Horizons API\n\n\nNo ephemeris for target "Synthetic (spacecraft)" ${lower ? "prior to" : "after"} A.D. ${stamp}.0000 TDB\n`;
async function advanceWith(h, result, answer, methodId = "advance", extra = []) {
  const requests = outs(result, "request").map(decodeHttpRequest);
  assert.ok(requests.length <= 60);
  const responses = [];
  for (const request of requests) {
    requestShape(request);
    responses.push(input("response", respond(await answer(request))));
  }
  return h.invoke({ methodId, inputs: [input("state", outs(result, "state")[0]), ...responses, ...extra] });
}
function vectorAnswer(fixture) {
  return async (request) => {
    const p = params(request.url);
    return fixture({ id: Number(p.COMMAND), center: Number(p.CENTER.split("@")[1]),
      start: p.START_TIME, stop: p.STOP_TIME, step: p.STEP_SIZE === "1 d" ? 86400 : Number.parseInt(p.STEP_SIZE) * 60 });
  };
}
const decodedRecords = (result) => recordBytes(result).map((bytes) => ({ bytes,
  blocks: OEM.getSizePrefixedRootAsOEM(new ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK }));

test("browser and WasmEdge produce byte-identical frames", async (t) => {
  const started = performance.now(), recordedPlan = planOptions(cassette.config);
  const harness = async (runtimeKind, config) => {
    // This SDK forwards config to native WasmEdge and hostOptions to the browser.
    const h = await createStandaloneHarnessOrSkip(runtimeKind, wasmPath, t,
      { surface: "direct", config, hostOptions: { config } });
    if (h) {
      t.after(() => h.destroy());
      assert.equal(h.runtime.kind, runtimeKind);
      assert.equal(h.runtime.surface, "direct");
    }
    return h;
  };
  // Check the native lane first: the ONE parity test must be explicitly skipped
  // by name when WasmEdge is absent, before compiling any synthetic fixtures.
  const native = await harness("wasmedge", recordedPlan.config);
  if (!native) return;
  const timings = { browser: { calls: 0, ms: 0 }, wasmedge: { calls: 0, ms: 0 } };
  t.after(() => t.diagnostic(`parity ran (not skipped): ${Object.entries(timings)
    .map(([kind, { calls, ms }]) => `${kind} ${calls} completed invocations in ${ms.toFixed(1)} ms`).join("; ")}; total ${(performance.now() - started).toFixed(1)} ms`));
  const frame = (f) => ({ portId: f.portId, typeRef: f.typeRef,
    payload: Buffer.from(f.payload) });
  const digest = (f) => ({ portId: f.portId, typeRef: f.typeRef,
    size: f.payload.length, sha256: createHash("sha256").update(f.payload).digest("hex") });
  const trace = (h, runtimeKind, scenario, expected) => {
    const calls = [];
    return { calls, async invoke(request) {
      const label = `${scenario}/${runtimeKind}/${request.methodId} invocation ${calls.length + 1}`;
      const inputs = request.inputs.map(frame), previous = expected?.[calls.length];
      if (expected) {
        assert.ok(previous, `${label}: unexpected invocation`);
        assert.equal(request.methodId, previous.methodId, label);
        assert.deepEqual(inputs, previous.inputs, `${label}: identical input frames`);
      }
      const before = performance.now();
      const result = await h.invoke(request);
      timings[runtimeKind].ms += performance.now() - before;
      timings[runtimeKind].calls++;
      const outputs = result.outputs.map(digest);
      const urls = outs(result, "request").map(decodeHttpRequest).map((r) => r.url);
      const trap = { errorCode: result.errorCode, statusCode: result.statusCode };
      if (previous) {
        assert.deepEqual(trap, previous.trap, `${label}: trap class`);
        assert.deepEqual(outputs, previous.outputs, `${label}: every output port, typeRef and payload SHA-256`);
        assert.deepEqual(urls, previous.urls, `${label}: exact request URLs`);
      }
      calls.push({ methodId: request.methodId, inputs, outputs, urls, trap });
      return result;
    } };
  };
  let recorded;
  for (const runtimeKind of ["browser", "wasmedge"]) {
    const h = runtimeKind === "wasmedge" ? native : await harness(runtimeKind, recordedPlan.config);
    const replay = trace(h, runtimeKind, "cassette", recorded?.calls);
    const run = await runAll(replay, async (request) => {
      const requestKey = key(request.url);
      assert.ok(Object.hasOwn(cassette.responses, requestKey), `uncached request: ${requestKey}`);
      return cassette.responses[requestKey];
    });
    assert.equal(run.records.length, 3);
    checkGroups(run.result);
    // Includes every OEM record stream, ingest meta, EGP group stream and notice.
    const finalFrames = run.result.outputs.map(frame);
    if (recorded) assert.deepEqual(finalFrames, recorded.finalFrames, "cassette: exact final records/metas/groups/notices");
    const invalid = J(run.snapshots[0].inputs[0].payload);
    invalid.next = -1;
    namedFailure(await replay.invoke({ methodId: "advance", inputs: [input("state", invalid)] }), /^invalid-state$/);
    assert.equal(replay.calls.length, 9, "plan, six advances, build and invalid-state failure");
    recorded ??= { calls: replay.calls, finalFrames };
  }

  const fixture = await fixtureHarness(t), vectors = vectorAnswer(fixture);
  const table = J(outs(await plan({ now_tdb: "2026-10-21T00:00:00" }), "state")[0]).craft;
  const syntheticPlan = planOptions({ objects: table.slice(0, 20).map((c) => c.id),
    now_tdb: "2026-10-21T00:00:00", page_rows: 100 });
  let synthetic;
  for (const runtimeKind of ["browser", "wasmedge"]) {
    const h = await harness(runtimeKind, syntheticPlan.config);
    if (!h) return;
    const replay = trace(h, runtimeKind, "20-object synthetic", synthetic);
    let result = await replay.invoke(syntheticPlan.request);
    ok(result, "synthetic plan");
    assert.equal(J(outs(result, "state")[0]).craft.length, 20);
    assert.equal(outs(result, "request").length, 40);
    let vectorRequests = 0;
    for (let stage = 1; stage <= 2; stage++) {
      result = await advanceWith(replay, result, async (request) => {
        const p = params(request.url);
        if (p.START_TIME.startsWith("1900")) return coverage(true, "2000-JAN-01 00:00:00");
        if (p.START_TIME.startsWith("2300")) return coverage(false, "2000-FEB-10 00:00:00");
        vectorRequests++;
        return vectors(request);
      });
      ok(result, `synthetic advance ${stage}`);
      assert.equal(J(outs(result, "state")[0]).stage, stage);
      assert.equal(outs(result, "request").length, 60);
    }
    assert.equal(vectorRequests, 60, "second stage consumes a full batch of synthetic vector responses");
    assert.equal(replay.calls.length, 3);
    synthetic ??= replay.calls;
  }
  assert.equal(timings.wasmedge.calls, 12, "native WasmEdge must execute both runs and the named failure");
});

// Numerical provenance and tolerances are in classifier_cases.cpp. It creates
// independent analytic/closed-form inputs in C++; JS only transports/asserts.
// The classifier itself is reached only through the production build_oem.
test("Offline window plans, six-stage queues and independent regime geometry", async (t) => {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
  t.after(() => h.destroy());
  const fixture = await fixtureHarness(t);
  const vectors = vectorAnswer(fixture);
  await t.test("39-object table, window bounds, skipping and named failures", async () => {
    const defaults = await plan({ now_tdb: "2026-10-21T12:34:56" });
    ok(defaults, "full table");
    const objects = J(outs(defaults, "state")[0]).craft.map((c) => ({ naif_id: c.id }));
    assert.equal(objects.length, 39);
    assert.equal(new Set(objects.map((o) => o.naif_id)).size, 39);
    assert.equal(outs(defaults, "request").length, 60);
    assert.equal(J(outs(defaults, "state")[0]).queue.length, 78);
    assert.equal(J(outs(defaults, "state")[0]).config.now_tdb, "2026-10-21T00:00:00", "tick floors to UTC day");
    assert.equal(J(outs(defaults, "state")[0]).config.retrieved_ms, Date.parse("2026-10-21T12:34:56Z"));
    ok(await plan({ objects: [-21, -92] }), "archive-only uses the same tick clock");
    const config = { objects: [-85, -95, -12, -74, -1176], now_tdb: "2026-10-21T12:34:56",
      limits: { "-85": { start: "2026-10-20T12:00:00", stop: "2026-11-16T17:00:00" } } };
    const planned = await plan(config);
    ok(planned, "five-window probes"); assert.equal(outs(planned, "request").length, 10);
    const answerProbe = async (request) => {
      const p = params(request.url), lower = p.START_TIME.startsWith("1900");
      if (p.COMMAND === "-1176") return "Horizons: unrecognized target / unknown id\n";
      return coverage(lower, lower ? "2009-JUN-18 12:00:00" : p.COMMAND === "-12" ? "2014-APR-18 00:00:00" : "2040-JAN-01 12:00:00");
    };
    const pages = await advanceWith(h, planned, answerProbe);
    ok(pages, "window plans");
    const requests = outs(pages, "request").map(decodeHttpRequest).map((r) => params(r.url));
    assert.equal(requests.length, 4);
    const expected = new Map([
      ["-85", ["500@301", "5 m", "2026-10-21 00:00:00", "2026-11-16 00:00:00"]],
      ["-95", ["500@399", "15 m", "2026-10-19 00:00:00", "2026-11-18 00:00:00"]],
      ["-12", ["500@301", "5 m", "2014-03-18 00:00:00", "2014-04-17 00:00:00"]],
      ["-74", ["500@499", "5 m", "2026-10-19 00:00:00", "2026-11-18 00:00:00"]],
    ]);
    for (const p of requests) assert.deepEqual([p.CENTER, p.STEP_SIZE, p.START_TIME, p.STOP_TIME], expected.get(p.COMMAND));
    skippedCraft(pages, -1176, /^unknown-horizons-error$/);
    const state = J(outs(pages, "state")[0]);
    assert.ok(state.craft.filter((c) => !c.skipped).every((c) => c.archive_groups === 0 && c.groups.length === 1));
    const built = await advanceWith(h, pages, vectors, "build_oem");
    ok(built, "early build consumes final responses");
    assert.ok(missing(built).some((r) => r.naif_id === -1176 && r.skipped === "unknown-horizons-error"));
    for (const bytes of recordBytes(built)) {
      const oem = OEM.getSizePrefixedRootAsOEM(new ByteBuffer(bytes)).unpack();
      assert.equal(oem.CREATION_DATE, "2026-10-21T12:34:56Z");
      assert.notEqual(oem.EPHEMERIS_DATA_BLOCK[0].CENTER_NAIF_ID, 10);
      ok(await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", bytes), input("epochs", { jd_tdb: [] })] }), "body OEM verifier");
    }
    for (const group of checkGroups(built)) {
      assert.equal(group.UPDATED_AT, "2026-10-21T12:34:56.000Z");
      assert.equal(group.PROVENANCE[0].RETRIEVED_AT, group.UPDATED_AT);
    }
    for (const [now_tdb, start, stop] of [
      ["2000-01-01T00:00:00", "2009-06-20 00:00:00", "2009-07-20 00:00:00"],
      ["2050-01-01T00:00:00", "2039-12-01 00:00:00", "2039-12-31 00:00:00"],
    ]) {
      const p = await plan({ objects: [-85], now_tdb });
      const next = await advanceWith(h, p, answerProbe); ok(next, "coverage clamp");
      const query = params(decodeHttpRequest(outs(next, "request")[0]).url);
      assert.equal(query.START_TIME, start); assert.equal(query.STOP_TIME, stop);
    }
    const httpInputs = [input("state", outs(planned, "state")[0]),
      ...outs(planned, "request").map(() => input("response", respond("unavailable", 503)))];
    namedFailure(await h.invoke({ methodId: "advance", inputs: httpInputs }), /horizons-http-error/);
    const wrongCenter = await advanceWith(h, pages, async (r) => {
      const body = await vectors(r);
      return params(r.url).COMMAND === "-85" ? body.replace("Center body name: Synthetic (301)", "Center body name: Sun (10)") : body;
    }, "build_oem");
    skippedCraft(wrongCenter, -85, /^invalid-vector-header$/);
    assert.ok(missing(wrongCenter).some((r) => r.naif_id === -85 && r.skipped === "invalid-vector-header"));
    assert.ok(lanes(wrongCenter).every((c) => c.naif_id !== -85));
  });
  await t.test("catalog geometry, smoothing, shared edges and exact row preservation", async () => {
    const cases = await fixture();
    for (const c of cases) {
      const result = await h.invoke({ methodId: "build_oem", inputs: [input("state", c.state)] });
      ok(result, c.name);
      const catalogLanes = lanes(result), records = decodedRecords(result);
      assert.deepEqual(catalogLanes.map((l) => l.catalog), c.expected.filter((l) => l !== "dropped"), c.name);
      assert.equal(records.length, catalogLanes.length);
      checkGroups(result);
      for (const [index, record] of records.entries()) {
        ok(await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", record.bytes), input("epochs", { jd_tdb: [] })] }), c.name);
        for (const block of record.blocks) {
          assert.equal(block.OBJECT_NAIF_ID, c.state.craft[0].id);
          assert.ok(block.COMMENT.includes(`CATALOG: ${catalogLanes[index].catalog}`));
          assert.equal(block.INTERPOLATION_DEGREE, 7);
          assert.equal(block.INTERPOLATION, "Hermite");
          const original = c.state.craft[0].groups.find((g) => g.center === block.CENTER_NAIF_ID && g.step === block.STEP_SIZE);
          assert.ok(original, c.name);
          const source = Buffer.from(original.data, "base64"), piece = float64Bytes(block.EPHEMERIS_DATA);
          const offset = source.indexOf(piece);
          assert.ok(offset >= 0 && offset % 48 === 0, `${c.name}: all output row bits are preserved`);
        }
      }
      if (c.name === "Three shared-edge segments") {
        const blocks = records.flatMap((r) => r.blocks).sort((a,b) => a.START_TIME.localeCompare(b.START_TIME));
        assert.equal(blocks[0].START_TIME, "2000-01-01T12:00:00");
        assert.equal(blocks.at(-1).STOP_TIME, "2000-01-16T12:00:00");
        assert.equal(blocks.length, 3);
        for (let i = 1; i < blocks.length; i++) {
          assert.equal(blocks[i-1].STOP_TIME, blocks[i].START_TIME);
          assert.deepEqual(blocks[i-1].EPHEMERIS_DATA.slice(-6), blocks[i].EPHEMERIS_DATA.slice(0,6));
        }
      }
      const again = await h.invoke({ methodId: "build_oem", inputs: [input("state", c.state)] });
      assert.deepEqual(recordBytes(again), recordBytes(result));
      assert.deepEqual(outs(again, "catalogs_records"), outs(result, "catalogs_records"));
    }
  });
  await t.test("page validation skips only the craft while transport and state failures stay fatal", async () => {
    const planned = await plan({ objects: [-21, -92] });
    ok(planned, "validation probes");
    const pages = await advanceWith(h, planned, async (r) => {
      const lower = params(r.url).START_TIME.startsWith("1900");
      return coverage(lower, lower ? "2000-JAN-01 00:00:00" : "2000-FEB-10 00:00:00");
    });
    ok(pages, "validation pages");
    const state = outs(pages, "state")[0], requests = outs(pages, "request").map(decodeHttpRequest);
    const bodies = await Promise.all(requests.map(vectors));
    const invoke = (responses, stateBytes = state) => h.invoke({ methodId: "build_oem",
      inputs: [input("state", stateBytes), ...responses.map((r) => input("response", r))] });
    for (const [code, corrupt] of [
      ["unknown-horizons-error", () => "Horizons: unknown target id\n"],
      ["vector-target-mismatch", (s) => s.replace("Synthetic (-21)", "Synthetic (-92)")],
      ["invalid-vector-header", (s) => s.replace("Center body name: Synthetic (10)", "Center body name: Synthetic (399)")],
      ["vector-grid-mismatch", (s) => s.replace(/(\$\$SOE\n)[^,]+,/, (_, marker) => marker + "2400000,")],
      ["missing-vector-row", (s) => s.replace(/(\$\$SOE\n)[^\n]+\n/, "$1")],
      ["extra-vector-row", (s) => s.replace(/(\$\$SOE\n)([^\n]+\n)/, "$1$2$2")],
      ["horizons-line-cap", (s) => "\n".repeat(90024) + s],
    ]) {
      const result = await invoke(bodies.map((body, i) => respond(i ? body : corrupt(body))));
      skippedCraft(result, -21, new RegExp(`^${code}$`));
      assert.deepEqual(missing(result).filter((r) => r.skipped), [{ naif_id: -21, skipped: code }]);
      assert.deepEqual(lanes(result).map((c) => c.naif_id), [-92]);
    }
    // The second response belongs to the same craft: envelopes/status still
    // matter after its first response has already caused it to skip.
    assert.equal(params(requests[1].url).COMMAND, "-21");
    for (const [response, code] of [[respond("unavailable", 503), /^horizons-http-error$/],
      [Buffer.from("not an HRSP envelope"), /^invalid-http-response$/]]) {
      const responses = bodies.map((body) => respond(body));
      responses[0] = respond("unknown target id\n");
      responses[1] = response;
      namedFailure(await invoke(responses), code);
    }
    namedFailure(await invoke(bodies.slice(1).map((body) => respond(body))), /^response-count-mismatch$/);
    const invalid = J(state); invalid.next = -1;
    namedFailure(await invoke(bodies.map((body) => respond(body)), invalid), /^invalid-state$/);
    for (const [config, code] of [[{ objects: [-21], page_rows: 0 }, /^invalid-page-rows$/],
      [{ objects: [-21], limits: { "-21": { start: "invalid" } } }, /^invalid-limit-time$/]]) {
      namedFailure(await plan(config), code);
    }
    namedFailure(await invoke(bodies.map(() => respond("unknown target id\n"))), /^no-trajectories$/);
  });
  await t.test("archive and window plan failures skip a craft without leaving partial pages", async () => {
    for (const badId of [-21, -85, -61]) {
      for (const code of ["invalid-coverage-range", "empty-trajectory-range"]) {
        const config = { objects: [badId, -92], now_tdb: "2000-01-15T00:00:00" };
        if (code === "empty-trajectory-range") {
          // Juno's archive succeeds on this narrow range; its window then fails.
          config.limits = { [badId]: badId === -61
            ? { start: "2000-01-05T12:00:00", stop: "2000-01-05T18:00:00" }
            : { start: "2050-01-01T00:00:00" } };
        }
        const planned = await plan(config);
        ok(planned, "plan failure probes");
        const pages = await advanceWith(h, planned, async (r) => {
          const p = params(r.url), lower = p.START_TIME.startsWith("1900");
          return coverage(lower, lower || (Number(p.COMMAND) === badId && code === "invalid-coverage-range")
            ? "2000-JAN-01 00:00:00" : "2000-FEB-10 00:00:00");
        });
        skippedCraft(pages, badId, new RegExp(`^${code}$`));
        const state = J(outs(pages, "state")[0]);
        assert.ok(state.queue.every((p) => Object.hasOwn(p, "lower") || state.craft[p.craft].id !== badId));
        assert.ok(outs(pages, "request").map(decodeHttpRequest).every((r) => params(r.url).COMMAND === "-92"));
        const built = await advanceWith(h, pages, vectors, "build_oem");
        skippedCraft(built, badId, new RegExp(`^${code}$`));
        assert.deepEqual(missing(built).filter((r) => r.skipped), [{ naif_id: badId, skipped: code }]);
        assert.deepEqual(lanes(built).map((c) => c.naif_id), [-92]);
      }
    }
  });
  await t.test("20-object run contains probe/vector failures and preserves every surviving record", async () => {
    const table = J(outs(await plan({ now_tdb: "2026-10-21T00:00:00" }), "state")[0]).craft.map((c) => ({ naif_id: c.id }));
    const objects = table.slice(0, 20).map((c) => c.naif_id), badVector = -61, badProbe = -121;
    const run = async (selection, injectFailures) => {
      let result = await plan({
        objects: selection, now_tdb: "2026-10-21T00:00:00", page_rows: 50,
      });
      ok(result, "containment plan");
      const seen = new Set();
      let ignored = 0, failed = false;
      for (let stage = 1; stage <= 6; stage++) {
        const before = J(outs(result, "state")[0]);
        assert.equal(before.pending.length, outs(result, "request").length);
        if (injectFailures && stage === 3) {
          const index = before.craft.findIndex((c) => c.id === badVector);
          assert.ok(before.craft[index].groups.some((g) => g.data.length > 0), "bad craft already retained rows in an earlier batch");
          assert.ok(before.queue.slice(before.next).some((p) => p.craft === index), "bad craft also has future queued pages");
        }
        result = await advanceWith(h, result, async (request) => {
          const p = params(request.url), id = Number(p.COMMAND), requestKey = key(request.url);
          assert.equal(seen.has(requestKey), false, "requests are never repeated");
          seen.add(requestKey);
          const lower = p.START_TIME.startsWith("1900"), upper = p.START_TIME.startsWith("2300");
          if (lower || upper) {
            if (injectFailures && id === badProbe) return "Horizons: unrecognized target / unknown id\n";
            return coverage(lower, lower ? "2000-JAN-01 00:00:00" : "2000-FEB-10 00:00:00");
          }
          assert.notEqual(id, injectFailures ? badProbe : 0, "skipped probe never plans vectors");
          if (injectFailures && id === badVector && stage === 3) {
            if (failed) { ignored++; return "ignored response after the first failed page\n"; }
            failed = true;
            return coverage(true, "2001-JAN-01 00:00:00");
          }
          assert.ok(!failed || id !== badVector, "no future requests for a skipped craft");
          return vectors(request);
        });
        ok(result, `containment advance ${stage}`);
        const after = J(outs(result, "state")[0]);
        assert.equal(after.pending.length, outs(result, "request").length);
        assert.ok(after.next >= after.pending.length && after.next <= after.queue.length);
        if (injectFailures) skippedCraft(result, badProbe, /^unknown-horizons-error$/);
        if (failed) {
          skippedCraft(result, badVector, /^unknown-horizons-error$/);
          assert.ok(after.pending.every((p) => after.craft[p.craft].id !== badVector));
        }
        if (injectFailures && stage === 3) assert.equal(after.pending.length, 60, "skipped queue entries do not use request slots");
      }
      if (injectFailures) assert.ok(failed && ignored > 0, "already-emitted pages of the failed craft were consumed in the same batch");
      assert.equal(outs(result, "request").length, 0);
      const built = await advanceWith(h, result, vectors, "build_oem");
      ok(built, "containment build");
      checkGroups(built);
      return built;
    };
    const contained = await run(objects, true);
    const survivors = objects.filter((id) => id !== badVector && id !== badProbe);
    const baseline = await run(survivors, false);
    const skips = missing(contained).filter((r) => r.skipped);
    assert.deepEqual(skips, [badVector, badProbe].map((naif_id) => ({ naif_id, skipped: "unknown-horizons-error" })));
    for (const id of [badVector, badProbe]) skippedCraft(contained, id, /^unknown-horizons-error$/);
    assert.deepEqual(new Set(lanes(contained).map((c) => c.naif_id)), new Set(survivors));
    // Exact equality is required: unrelated craft cannot change row bits or OEM metadata.
    assert.deepEqual(recordBytes(contained), recordBytes(baseline));
    assert.deepEqual(lanes(contained), lanes(baseline));
    assert.deepEqual(outs(contained, "catalogs_records"), outs(baseline, "catalogs_records"));
  });
  await t.test("20-object vectors, split probe queues, six advances and compact full-table state", async () => {
    const table = J(outs(await plan({ now_tdb: "2026-10-21T00:00:00" }), "state")[0]).craft.map((c) => ({ naif_id: c.id }));
    for (const full of [false, true]) {
      const config = full ? { now_tdb: "2026-10-21T00:00:00" } :
        { objects: table.slice(0, 20).map((c) => c.naif_id), now_tdb: "2026-10-21T00:00:00", page_rows: 100 };
      let result = await plan(config);
      ok(result, "staged plan");
      let maximum = 0, probeBatches = 0, vectorRequests = 0;
      const answer = async (request) => {
        const p = params(request.url);
        if (p.START_TIME.startsWith("1900")) return coverage(true, full ? "1970-JAN-01 00:00:00" : "2000-JAN-01 00:00:00");
        if (p.START_TIME.startsWith("2300")) return coverage(false, full ? "2050-JAN-01 00:00:00" : "2000-FEB-10 00:00:00");
        vectorRequests++;
        return vectors(request);
      };
      for (let stage = 1; stage <= 6; stage++) {
        const previous = J(outs(result, "state")[0]);
        if (previous.pending.some((p) => Object.hasOwn(p,"lower"))) probeBatches++;
        result = await advanceWith(h, result, answer);
        ok(result, `advance ${stage}`);
        const stateBytes = outs(result, "state")[0], state = J(stateBytes);
        assert.equal(state.stage, stage);
        assert.ok(stateBytes.length < 64 * 1024 * 1024);
        maximum = Math.max(maximum, stateBytes.length);
        if (!previous.pending.length && previous.planned) {
          const { stage: oldStage, ...oldBody } = previous;
          const { stage: newStage, ...newBody } = state;
          assert.deepEqual(newBody, oldBody, "exhausted advance passes through with only stage changed");
        }
      }
      assert.equal(probeBatches, full ? 2 : 1);
      assert.ok(vectorRequests > 60, "multiple vector batches exercised");
      const completedState = outs(result, "state")[0];
      const built = await advanceWith(h, result, answer, "build_oem");
      ok(built, "six-stage build");
      assert.equal(new Set(lanes(built).map((c) => c.naif_id)).size, full ? 39 : 20);
      checkGroups(built);
      namedFailure(await h.invoke({ methodId: "advance", inputs: [input("state", completedState)] }), /invalid-stage/);
      t.diagnostic(`${full ? 39 : 20} synthetic craft: ${vectorRequests} vector requests, largest state ${maximum} bytes`);
    }
    // All probes can fail without aborting advances, but an empty build is fatal.
    let skipped = await plan({ objects: [-85], now_tdb: "2026-10-21T00:00:00" });
    skipped = await advanceWith(h, skipped, async () => "Unknown target id\n"); ok(skipped,"skip all probes");
    skippedCraft(skipped, -85, /^unknown-horizons-error$/);
    namedFailure(await advanceWith(h, skipped, vectors, "build_oem"), /^no-trajectories$/);
  });
});


test("typed contracts, disabled runs, producer identity and HTTP failures", async (t) => {
  for (const method of manifest.methods.slice(0, 3)) for (const p of [...method.inputPorts, ...method.outputPorts]) {
    if (p.portId === "state") continue;
    assert.equal(p.acceptedTypeSets.length, 1);
    const [set] = p.acceptedTypeSets;
    assert.equal(set.allowedTypes.length, 1); assert.equal(set.wildcardJustification, undefined);
    assert.equal(set.allowedTypes[0].acceptsAnyFlatbuffer, undefined);
    assert.ok(set.allowedTypes[0].schemaName && set.allowedTypes[0].rootTypeName && set.allowedTypes[0].fileIdentifier);
  }
  for (const config of [{}, { deep_space_enabled: false }]) {
    const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct", hostOptions: { config } });
    try {
      const result = await h.invoke({ methodId: "plan_horizons", inputs: [tick()] }); ok(result, "disabled");
      assert.equal(result.outputs.length, 1); assert.equal(outs(result, "request").length, 0);
      const n = decodeFlowNotice(outs(result, "status")[0]);
      assert.equal(n.kind, "skipped"); assert.equal(n.reason, "disabled"); assert.equal(n.atMs, firedMs);
    } finally { await h.destroy(); }
  }
  for (const producer_peer_id of [undefined, "", 42]) namedFailure(await plan({ producer_peer_id }), /^missing-producer-peer-id$/);
  const planned = await plan({ objects: [-21] }, firedMs + 789); ok(planned, "millisecond tick");
  const state = J(outs(planned, "state")[0]);
  assert.equal(state.config.now_tdb, "2026-10-21T00:00:00"); assert.equal(state.config.retrieved_ms, firedMs + 789);
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
  t.after(() => h.destroy());
  for (const [response, code] of [[respond("", 200), /^horizons-http-error$/], [respond("body", 200, "offline"), /^fetch-failed$/]]) {
    namedFailure(await h.invoke({ methodId: "advance", inputs: [input("state", state), input("response", response), input("response", respond("body"))] }), code);
  }
  namedFailure(await h.invoke({ methodId: "plan_horizons", inputs: [] }), /^missing-required-input$/);
});

test("typed flow has twelve ingests, seven HTTP stages and only state edges opaque", () => {
  const source = manifest.pluginId, http = "http", storage = "storage";
  const { flow, deps } = deepSpaceFlow({
    node: (id, plugin, method, kind) => ({ id, plugin, method, kind }),
    edge: (from, fromPort, to, toPort) => ({ from, fromPort, to, toPort, opaque: true }),
    http, storage, packageDir: root,
  });
  assert.equal(flow.version, "0.2.0"); assert.equal(flow.programId, "com.digitalarsenal.flows.deep-space-catalogs-ingest");
  assert.deepEqual(flow.requiredPlugins, [source, http, storage]); assert.deepEqual(deps, { [source]: root });
  assert.equal(flow.nodes.filter((n) => n.plugin === storage).length, 12);
  assert.equal(flow.nodes.filter((n) => n.plugin === http).length, 7);
  assert.equal(flow.triggerBindings[0].targetNodeId, "plan"); assert.equal(flow.triggerBindings[0].targetPortId, "tick");
  for (const e of flow.edges) assert.equal(e.opaque, e.fromPort === "state" ? true : undefined);
  for (const id of [...catalogIds, "catalogs"]) {
    const prefix = id.replaceAll("-", "_");
    for (const [fromPort, toPort] of [[`${prefix}_records`, id === "catalogs" ? "egp_records" : "oem_records"], [`${prefix}_meta`, "meta"]])
      assert.ok(flow.edges.some((e) => e.from === "build" && e.fromPort === fromPort && e.to === `ingest_${prefix}` && e.toPort === toPort));
    assert.ok(flow.edges.some((e) => e.from === `ingest_${prefix}` && e.fromPort === "result" && e.to === "egress"));
  }
});
