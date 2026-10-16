import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";

// Independent source: NASA/JPL Horizons TLIST queries, not module outputs.
// Epochs: the fixture's JD TDB; centre: Sun; frame: ICRF; units: km and km/s.
// Position tolerance: 1 km, a conservative bound above the independent Python
// contract implementation's <= 0.0015 km Hermite error at these 60 epochs.
// All CSV parsing and interpolation run in C++/WASM, including record mode.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(root, "tests/fixtures/horizons");
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { ByteBuffer } = require("flatbuffers");
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
const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  const typeRef = portId === "oem"
    ? { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" }
    : { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length };
  return { portId, payload, typeRef };
};
const ok = (result, stage) => assert.equal(result.statusCode, 0, `${stage}: ${result.errorCode}: ${result.errorMessage}`);
function namedFailure(result, name) {
  assert.notEqual(result.statusCode, 0);
  assert.match(result.errorCode ?? "", name);
  assert.equal(outs(result, "records").length, 0);
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
  assert.deepEqual(request.headers, { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" });
  assert.ok(!request.url.includes("sdn-range") && !request.url.includes("+"));
  for (const [name, value] of new URL(request.url).searchParams) {
    if (name !== "format") assert.match(value, /^'.*'$/s, name);
  }
  const p = params(request.url);
  assert.ok(["1 d", "10 m"].includes(p.STEP_SIZE));
  // Calendar subtraction only counts the requested grid; it does not convert
  // TDB to UTC or calculate trajectories. Both strings are the same time scale.
  const first = Date.parse(p.START_TIME.replace(" ", "T") + "Z");
  const last = Date.parse(p.STOP_TIME.replace(" ", "T") + "Z");
  const rows = (last - first) / (p.STEP_SIZE === "1 d" ? 86400000 : 600000) + 1;
  assert.ok(Number.isInteger(rows) && rows >= 1 && rows <= 80000, `requested ${rows} rows`);
}
function respond(body, status = 200) {
  const header = Buffer.alloc(8);
  header.write("$HRB");
  header.writeInt32LE(status, 4);
  return Buffer.concat([header, Buffer.from(body)]);
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
  let result = await h.invoke({ methodId: "plan_horizons", inputs: [input("config", cassette.config)] });
  ok(result, "plan_horizons");
  const keys = [], requestsSeen = [], snapshots = [];
  for (const methodId of ["advance", "advance", "advance", "build_oem"]) {
    const requests = outs(result, "request").map(J);
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
  return { result, keys, requestsSeen, snapshots, records: outs(result, "records") };
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
      language: "c++", outputPath, threadModel: "wasi-sequential" });
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

test("Horizons stages build deterministic Sun-centred OEMs and evaluate independent TLIST states", async (t) => {
  const validation = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: sds });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.match(fs.readFileSync(path.join(root, "../../common/horizons_vectors.hpp"), "utf8"), /kHorizonsLineCap\s*=\s*90024\b/);
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
  t.after(() => h.destroy());
  const defaults = await h.invoke({ methodId: "plan_horizons", inputs: [input("config", {})] });
  ok(defaults, "default plan_horizons");
  const objects = J(outs(defaults, "status")[0]).objects;
  assert.deepEqual(objects.map((o) => o.naif_id), ids);
  assert.equal(outs(defaults, "request").length, 26);
  for (const object of objects) {
    assert.ok(object.name && object.aliases.length && object.cospar);
    assert.equal(object.licence, licence);
    assert.equal(object.credit, credit);
    assert.ok(Number.isInteger(object.windows) && object.windows >= 1);
    assert.ok(Object.hasOwn(events, String(object.naif_id)));
  }
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
  const reports = outs(first.result, "report").map(J);
  assert.equal(reports.length, 3);
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
    assert.equal(oem.CREATION_DATE, null);
    const identity = objects.find((o) => o.naif_id === cassette.config.objects[index]);
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
      assert.ok(block.COMMENT.includes(`ALIASES: ${identity.aliases.join("; ")}`));
      assert.ok(block.COMMENT.includes(licence) && block.COMMENT.includes(credit));
      assert.match(block.START_TIME, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?$/);
      assert.match(block.STOP_TIME, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?$/);
      if (blockIndex) assert.equal(blocks[blockIndex - 1].STOP_TIME, block.START_TIME, "segment edges are shared");
    }
    const dailyBytes = Buffer.from(compactStates.at(-1).craft[index].groups[0].data, "base64");
    let dailyOffset = 0;
    for (const block of blocks.filter((b) => b.STEP_SIZE === 86400)) {
      const expected = float64Bytes(block.EPHEMERIS_DATA);
      const offset = dailyBytes.indexOf(expected, dailyOffset);
      assert.ok(offset >= dailyOffset && offset % 48 === 0, "daily OEM rows survive sparsification in exact byte order");
      dailyOffset = offset + expected.length;
    }
    assert.equal(reports[index].blocks, blocks.length);
    assert.equal(reports[index].windows, blocks.filter((b) => b.STEP_SIZE === 600).length);
    assert.equal(reports[index].rows, blocks.reduce((n, b) => n + b.EPHEMERIS_DATA.length / 6, 0));
    assert.equal(reports[index].bytes, bytes.length);
    byId.set(identity.naif_id, { bytes, blocks });
  }
  const meta = J(outs(first.result, "meta")[0]);
  assert.deepEqual(meta, { schema: "OEM.fbs", provider_id: "deep-space-spacecraft", source_name: "horizons", credit, licence });
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
  const edges = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", first.records[0]),
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
    [first.snapshots[0], () => "Horizons: unrecognized target and unexpected server error\n", /horizons.*error|error.*horizons/],
    [first.snapshots.find((s) => s.requests.some((r) => activeResponses[key(r.url)].includes("$$SOE"))),
      (body) => body.slice(0, body.indexOf("$$EOE")), /truncated|missing.*row|vector.*page/],
    [first.snapshots.find((s) => s.requests.some((r) => activeResponses[key(r.url)].includes("$$SOE"))),
      (body) => body.replace("(-143205)", "(-31)"), /vector-target-mismatch/],
  ]) {
    assert.ok(snapshot);
    const inputs = snapshot.inputs.map((f) => ({ ...f }));
    const original = Buffer.from(inputs[1].payload).subarray(8).toString();
    inputs[1] = input("response", respond(corrupt(original)));
    namedFailure(await h.invoke({ methodId: snapshot.methodId, inputs }), expected);
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
  namedFailure(await h.invoke({ methodId: pageSnapshot.methodId, inputs: reordered }), /grid|row|page|order/);
  const badOem = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", first.records[0].subarray(0, 24)), input("epochs", { jd_tdb: [] })] });
  namedFailure(badOem, /oem|flatbuffer|verif/i);
  const outside = await h.invoke({ methodId: "evaluate_oem", inputs: [input("oem", first.records[0]), input("epochs", { jd_tdb: [2400000] })] });
  namedFailure(outside, /epoch|range|coverage/i);
  assert.equal(outs(outside, "states").length, 0);
  if (record) {
    fs.writeFileSync(path.join(fixtureRoot, "cassette.json.gz"), gzipSync(JSON.stringify({ config: cassette.config, responses: recorded })));
    fs.writeFileSync(path.join(fixtureRoot, "reference.json"), JSON.stringify(activeReference, null, 2) + "\n");
  }
  t.diagnostic("SDK contract, 13-object default/26 probes, 29 exact cassette requests, OEM verifier/metadata, exact sparse/base64 state, byte-identical rebuild, reconciliation and named failure paths passed.");
});
