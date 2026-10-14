// data-source/spacex-starlink-source end-to-end on the typed contracts (1.0): the compiled wasm in the SDK browser
// harness, TimerTick / HttpResponse frames in, HttpRequest / OEM / FlowNotice frames out, the job a size-prefixed $OEM
// object header in HttpRequest.CONTEXT, the node config the SDS $PIV plugin.getConfig answer. The http connector is
// played by serve(): it answers each HttpRequest from the checked-in MEME files (a Range request on a MEME file gets the
// prefix and 206, as api.starlink.com does) and echoes CONTEXT, as hostcap/http-request does.
//
// Byte identity: tests/fixtures/legacy-oem holds the $OEM records the last JSON-lane artifact (pull, $OEM stream
// returned from plugin_invoke_stream) produced on the same inputs - the two fixture objects, and the ten synthetic
// SupGP-suite objects range-fetched (128 KiB) and whole. The typed nodes must emit the same bytes.

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
  decodeHttpRequest,
  encodeHttpResponse,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { privatePath, privateSkip } from "../../../tests/lib/privateFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, "..", "plugin-manifest.json");
const WASM_PATH = path.join(__dirname, "..", "dist", "isomorphic", "module.wasm");
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const OEM_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/OEM/main.js"));
const flatbuffers = createRequire(OEM_LIB)("flatbuffers");
const oemLib = await import(OEM_LIB.href);

const FIXTURES = path.join(__dirname, "fixtures");
const LEGACY = path.join(FIXTURES, "legacy-oem");
const SYNTHETIC_SUITE = path.resolve(__dirname, "../../../analysis/od/tests/data/supgp-reference/starlink-synthetic");
const MANIFEST_URL = "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
const BASE_URL = "https://api.starlink.com/public-files/ephemerides/";

const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

async function createHarness(t, config = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostOptions: { config },
  });
  t.after(() => harness.destroy());
  return harness;
}

function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}
const on = (response, port) => ok(response).outputs.filter((f) => f.portId === port);
const requestsOn = (response) => on(response, "requests").map((f) => decodeHttpRequest(f.payload));
const noticesOn = (response) => on(response, "status").map((f) => decodeFlowNotice(f.payload));
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "starlink-pull", firedMs: Date.UTC(2026, 9, 14) }) });
const hrsp = (portId, r) => ({ portId, typeRef: TYPE.HRSP, payload: encodeHttpResponse(r) });

// The http connector over a directory holding MANIFEST.sample.txt (or a manifest text) and meme/<file>.
function connector(dir, manifestText) {
  return (request) => {
    if (request.url.endsWith("MANIFEST.txt")) {
      const body = manifestText ?? fs.readFileSync(path.join(dir, "MANIFEST.sample.txt"));
      return { url: request.url, status: 200, body: new Uint8Array(Buffer.from(body)), context: request.context };
    }
    const file = path.join(dir, "meme", request.url.slice(BASE_URL.length));
    if (!fs.existsSync(file)) return { url: request.url, status: 404, body: new Uint8Array(0), context: request.context };
    let body = new Uint8Array(fs.readFileSync(file));
    const range = request.headers.range;
    if (range) body = body.subarray(0, Number(range.split("-")[1]) + 1);
    return { url: request.url, status: range ? 206 : 200, body, context: request.context };
  };
}

// plan -> select_objects (draining its backlog) -> emit, through the connector.
async function pull(t, config, serve) {
  const harness = await createHarness(t, config);
  const [manifestRequest] = requestsOn(await harness.invoke({ methodId: "plan", inputs: [tick()] }));
  let selected = await harness.invoke({ methodId: "select_objects", inputs: [hrsp("manifest", serve(manifestRequest))] });
  const requests = [], notices = [], batches = [];
  for (;;) {
    const batch = requestsOn(selected);
    batches.push(batch.length);
    requests.push(...batch);
    notices.push(...noticesOn(selected));
    if (!selected.yielded) break;
    selected = await harness.invoke({ methodId: "select_objects", inputs: [] });
  }
  const oems = [];
  for (let i = 0; i < requests.length; i += 16) {
    const emitted = await harness.invoke({ methodId: "emit", inputs: requests.slice(i, i + 16).map((r) => hrsp("ephemerides", serve(r))) });
    oems.push(...on(emitted, "oem").map((f) => new Uint8Array(f.payload)));
    notices.push(...noticesOn(emitted));
  }
  return { manifestRequest, requests, notices, batches, oems };
}

function readJob(context) {
  assert.equal(identifierOf(context.subarray(4)), "$OEM", "CONTEXT is one size-prefixed $OEM record");
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4);
  const oem = oemLib.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(Uint8Array.from(context.subarray(4)))).unpack();
  assert.equal(oem.EPHEMERIS_DATA_BLOCK.length, 1);
  assert.equal(oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA.length, 0, "a header: no states");
  return oem.EPHEMERIS_DATA_BLOCK[0].OBJECT;
}
const legacy = (dir) => fs.readdirSync(path.join(LEGACY, dir)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))
  .map((f) => new Uint8Array(fs.readFileSync(path.join(LEGACY, dir, f))));

// ---- contract -----------------------------------------------------------------------------------------------------

test("spacex-starlink-source artifact passes SDK compliance with typed ports only", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const report = await validateArtifactWithStandards({ manifest, wasmPath: WASM_PATH, standardsRoot: STANDARDS_ROOT });
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
  assert.deepEqual(ids, { "plan.tick": "TICK", "plan.requests": "HREQ", "select_objects.manifest": "HRSP", "select_objects.requests": "HREQ",
    "select_objects.status": "FNTC", "emit.ephemerides": "HRSP", "emit.oem": "$OEM", "emit.status": "FNTC" });
  assert.deepEqual(manifest.capabilities, []);
});

test("spacex-starlink-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

// ---- plan / select_objects ----------------------------------------------------------------------------------------

test("plan: a tick is the manifest GET; manifestUrl overrides it; batched ticks are refused", async (t) => {
  const [request, ...rest] = requestsOn(await (await createHarness(t)).invoke({ methodId: "plan", inputs: [tick()] }));
  assert.equal(rest.length, 0);
  assert.deepEqual([request.method, request.url, request.headers, request.context.length], ["GET", MANIFEST_URL, {}, 0]);
  const [mirror] = requestsOn(await (await createHarness(t, { manifestUrl: "https://mirror.example/MANIFEST.txt", timeoutMs: 30000 })).invoke({ methodId: "plan", inputs: [tick()] }));
  assert.deepEqual([mirror.url, mirror.timeoutMs], ["https://mirror.example/MANIFEST.txt", 30000]);
  const twice = await (await createHarness(t)).invoke({ methodId: "plan", inputs: [tick(), tick()] });
  assert.equal(twice.errorCode, "batched-input-frames");
});

test("select_objects: one range GET per MEME entry, the object's identity in CONTEXT", async (t) => {
  const { requests, notices } = await pull(t, {}, connector(FIXTURES));
  const names = fs.readFileSync(path.join(FIXTURES, "MANIFEST.sample.txt"), "utf8").trim().split("\n");
  assert.deepEqual(requests.map((r) => r.url), names.map((n) => BASE_URL + n), "default: the whole manifest (unlimited cap)");
  for (const [i, r] of requests.entries()) {
    assert.deepEqual(r.headers, { range: "bytes=0-131071" });
    const object = readJob(r.context);
    const [, norad, name] = names[i].split("_");
    assert.deepEqual([object.NORAD_CAT_ID, object.OBJECT_NAME], [Number(norad), name]);
  }
  // the third entry has no file (404): listed, not fatal
  assert.deepEqual(notices.map((n) => [n.kind, n.reason, n.count, n.providerId]), [["missing", "objects-unavailable", 1, "spacex-starlink"]]);
  assert.match(notices[0].items[0], /^STARLINK-99999 \(99999\): HTTP 404$/);
});

test("select_objects: objectCap, offset/count windows, rangeBytes 0, probe", async (t) => {
  const serve = connector(FIXTURES);
  assert.equal((await pull(t, { objectCap: 2 }, serve)).requests.length, 2);
  const first = await pull(t, { offset: 0, count: 1 }, serve);
  assert.deepEqual([first.requests.length, first.oems.length], [1, 1]);
  const tail = await pull(t, { offset: 2, count: 5 }, serve);
  assert.deepEqual([tail.requests.length, tail.oems.length], [1, 0], "past the resolvable fixtures: one request, a 404");
  const past = await pull(t, { offset: 7 }, serve);
  assert.deepEqual(past.notices.map((n) => [n.kind, n.reason]), [["skipped", "nothing-to-fetch"]]);
  const whole = await pull(t, { objectCap: 2, rangeBytes: 0 }, serve);
  for (const r of whole.requests) assert.deepEqual(r.headers, {}, "rangeBytes 0: no range header");
  const probe = await pull(t, { probe: true }, serve);
  assert.equal(probe.requests.length, 0, "probe fetches no object");
  assert.deepEqual(probe.notices.map((n) => [n.kind, n.reason, n.count]), [["info", "object-count", 3]]);
  assert.equal((await pull(t, { probe: true, objectCap: 2 }, serve)).notices[0].count, 2);
});

test("select_objects: 16 requests per invocation, the rest yielded and resumed without input", async (t) => {
  const manifest = Array.from({ length: 40 }, (_, i) => `MEME_${70000 + i}_STARLINK-${i}_1_Operational_1_UNCLASSIFIED.txt`).join("\n");
  const { batches, requests } = await pull(t, {}, connector(FIXTURES, manifest));
  assert.deepEqual(batches, [16, 16, 8]);
  assert.deepEqual(requests.map((r) => readJob(r.context).NORAD_CAT_ID), Array.from({ length: 40 }, (_, i) => 70000 + i));
});

test("select_objects: a manifest not answered 200 is a Missing notice; a non-HRSP frame is refused", async (t) => {
  const harness = await createHarness(t);
  const res = await harness.invoke({ methodId: "select_objects", inputs: [hrsp("manifest", { url: MANIFEST_URL, status: 503, error: "" })] });
  assert.deepEqual(noticesOn(res).map((n) => [n.kind, n.reason, n.items]), [["missing", "manifest-unavailable", [`${MANIFEST_URL}: HTTP 503`]]]);
  const bad = await harness.invoke({ methodId: "select_objects", inputs: [{ portId: "manifest", typeRef: TYPE.HRSP, payload: encodeTimerTick({}) }] });
  assert.equal(bad.errorCode, "invalid-response-frame");
});

// ---- emit ---------------------------------------------------------------------------------------------------------

test("emit: byte-identical to the legacy artifact's $OEM on the fixtures", async (t) => {
  const { oems } = await pull(t, {}, connector(FIXTURES));
  assert.deepEqual(oems, legacy("fixtures"));
  for (const oem of oems) assert.equal(identifierOf(oem), "$OEM");
});

test("emit: byte-identical to the legacy artifact's $OEM on the ten synthetic Starlink ephemerides, ranged and whole", async (t) => {
  const files = fs.readdirSync(path.join(SYNTHETIC_SUITE, "meme")).filter((n) => /^MEME_\d+_.*\.txt$/.test(n)).sort();
  const serve = connector(SYNTHETIC_SUITE, `${files.join("\n")}\n`);
  assert.deepEqual((await pull(t, {}, serve)).oems, legacy("synth-range"));
  assert.deepEqual((await pull(t, { rangeBytes: 0 }, serve)).oems, legacy("synth-full"));
});

test("emit: a response without its job header is refused; an object without states is Missing", async (t) => {
  const harness = await createHarness(t);
  const lost = await harness.invoke({ methodId: "emit", inputs: [hrsp("ephemerides", { url: BASE_URL + "x", status: 200, body: new Uint8Array([1]) })] });
  assert.equal(lost.errorCode, "missing-context");
  const { requests } = await pull(t, { objectCap: 1 }, connector(FIXTURES));
  const res = await harness.invoke({ methodId: "emit", inputs: [hrsp("ephemerides", { url: requests[0].url, status: 200, body: Buffer.from("created: x\n"), context: requests[0].context })] });
  assert.equal(on(res, "oem").length, 0);
  assert.deepEqual(noticesOn(res).map((n) => n.items), [["STARLINK-36840 (67850): no state vectors"]]);
});

// ---- Frame: MEME state vectors are EME2000 ------------------------------------------------------------------------
// Pull the ten full-length MEME files of a suite through these nodes and fit each emitted $OEM with analysis/od (typed
// `oem` port), which honours the frame the $OEM declares; score our GP and the suite's reference element set with the
// same SGP4 against analysis/od's own frame-correct reading of the MEME states (EME2000 rotated to TEME). Both are RMS
// position errors against the same states, so their sum bounds our GP's distance from the reference. A TEME label
// would leave the states unrotated and put our GP ~35 km off; frame-correct it is within the 5 km bound. Public: the
// synthetic suite. Private (SDN_MODULES_PRIVATE_FIXTURES): the SpaceX ephemerides and CelesTrak SupGP.
const SUPGP_SUITE_RELATIVE = "analysis/od/tests/data/supgp-reference/starlink";
const OD_WASM_PATH = path.resolve(__dirname, "../../../analysis/od/dist/isomorphic/module.wasm");
const SUPGP_AGREEMENT_MAX_KM = 5.0;

function parseSupGpRows(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split(",");
  const byNorad = new Map();
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const num = (name) => Number.parseFloat(f[header.indexOf(name)]);
    const norad = Number.parseInt(f[header.indexOf("NORAD_CAT_ID")], 10);
    const row = { epoch: f[header.indexOf("EPOCH")], meanMotion: num("MEAN_MOTION"), eccentricity: num("ECCENTRICITY"), inclination: num("INCLINATION"),
      raan: num("RA_OF_ASC_NODE"), argp: num("ARG_OF_PERICENTER"), meanAnomaly: num("MEAN_ANOMALY"), bstar: num("BSTAR"),
      meanMotionDot: num("MEAN_MOTION_DOT"), meanMotionDdot: num("MEAN_MOTION_DDOT") };
    if (!byNorad.has(norad)) byNorad.set(norad, []);
    byNorad.get(norad).push(row);
  }
  return byNorad;
}
const epochMs = (iso) => Date.parse(/[zZ]$/.test(iso) ? iso : `${iso}Z`);
const closestRow = (rows, iso) => rows.reduce((best, row) =>
  !best || Math.abs(epochMs(row.epoch) - epochMs(iso)) < Math.abs(epochMs(best.epoch) - epochMs(iso)) ? row : best, null);
const referenceOptions = (e) => ({ inputFormat: "meme", refEpoch: e.epoch, refMeanMotion: e.meanMotion, refEccentricity: e.eccentricity,
  refInclination: e.inclination, refRaan: e.raan, refArgPericenter: e.argp, refMeanAnomaly: e.meanAnomaly, refBstar: e.bstar,
  refMeanMotionDot: e.meanMotionDot, refMeanMotionDdot: e.meanMotionDdot });

async function checkEme2000Suite(t, suiteDir, referenceCsv) {
  const { OMM } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/OMM/main.js")).href);
  const { OBD } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/OBD/main.js")).href);
  const { FILT } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/FIL/main.js")).href);
  const { createStandaloneHarness } = await import("space-data-module-sdk/testing/isomorphic");
  const files = fs.readdirSync(path.join(suiteDir, "meme")).filter((n) => /^MEME_\d+_.*\.txt$/.test(n)).sort();
  assert.equal(files.length, 10, "the Starlink suite holds ten MEME files");
  const memeByNorad = new Map(files.map((name) => [Number.parseInt(name.split("_")[1], 10), name]));
  const { oems } = await pull(t, { rangeBytes: 0 }, connector(suiteDir, `${files.join("\n")}\n`));
  assert.equal(oems.length, files.length, "one $OEM per suite object");

  const supGp = parseSupGpRows(path.join(suiteDir, referenceCsv));
  // analysis/od on the typed contract: the options are node CONFIG (fixed when a host is created, so one harness per
  // reference set), a text ephemeris goes in as a $FIL on "meme", and a configured reference set comes back scored on
  // the same points as the $OBD whose METHOD_SOURCE is "reference" (its WRMS, km).
  const odHarnesses = [];
  const odWith = async (config) => {
    const harness = await createStandaloneHarness("browser", OD_WASM_PATH, { enableThreads: true, hostOptions: { config } });
    odHarnesses.push(harness);
    return harness;
  };
  t.after(async () => { for (const harness of odHarnesses) await harness.destroy(); });
  const od = await odWith({});
  const fitOem = async (oem) => {
    const response = ok(await od.invoke({ methodId: "fit", inputs: [{ portId: "oem", wireFormat: "flatbuffer",
      typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" }, payload: oem }] }));
    const omm = OMM.getSizePrefixedRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(response.outputs.find((o) => o.portId === "omm").payload)));
    return { epoch: omm.EPOCH(), meanMotion: omm.MEAN_MOTION(), eccentricity: omm.ECCENTRICITY(), inclination: omm.INCLINATION(),
      raan: omm.RA_OF_ASC_NODE(), argp: omm.ARG_OF_PERICENTER(), meanAnomaly: omm.MEAN_ANOMALY(), bstar: omm.BSTAR(),
      meanMotionDot: omm.MEAN_MOTION_DOT(), meanMotionDdot: omm.MEAN_MOTION_DDOT() };
  };
  const filFrame = (bytes) => {
    const builder = new flatbuffers.Builder(1024 + bytes.length);
    builder.finish(Object.assign(new FILT(), { NAME: "ephemeris.txt", MEDIA_TYPE: "text/plain", CONTENT: [...bytes] }).pack(builder), "$FIL");
    return { portId: "meme", typeRef: { schemaName: "FIL.fbs", fileIdentifier: "$FIL", rootTypeName: "FIL", wireFormat: "flatbuffer" },
      payload: builder.asUint8Array() };
  };
  const scoreOnMemeStates = async (meme, elements) => {
    const scorer = await odWith(referenceOptions(elements));
    const response = ok(await scorer.invoke({ methodId: "fit", inputs: [filFrame(meme)] }));
    const reference = response.outputs.filter((o) => o.portId === "obd")
      .map((o) => OBD.getSizePrefixedRootAsOBD(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))))
      .find((obd) => obd.METHOD_SOURCE() === "reference");
    assert.ok(reference, "analysis/od reported no reference $OBD");
    const km = reference.WRMS();
    assert.ok(Number.isFinite(km), "analysis/od reported no reference WRMS");
    return km;
  };

  for (const record of oems) {
    const block = oemLib.OEM.getRootAsOEM(new flatbuffers.ByteBuffer(record)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const norad = block.OBJECT.NORAD_CAT_ID;
    assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME_type, oemLib.RFMUnion.CelestialFrameWrapper, `${norad}: celestial frame arm`);
    assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, oemLib.CelestialFrame.EME2000, `${norad}: EME2000`);
    const ours = await fitOem(record);
    const rows = supGp.get(norad);
    assert.ok(rows?.length, `no reference row for NORAD ${norad}`);
    const meme = new Uint8Array(fs.readFileSync(path.join(suiteDir, "meme", memeByNorad.get(norad))));
    const oursKm = await scoreOnMemeStates(meme, ours);
    const refKm = await scoreOnMemeStates(meme, closestRow(rows, ours.epoch));
    t.diagnostic(`NORAD ${norad}: our GP ${oursKm.toFixed(3)} km, reference ${refKm.toFixed(3)} km from the TEME states`);
    assert.ok(oursKm + refKm <= SUPGP_AGREEMENT_MAX_KM, `${norad}: ${oursKm} + ${refKm} km > ${SUPGP_AGREEMENT_MAX_KM} km; the $OEM states are in the wrong frame.`);
  }
}

test("$OEM carries EME2000, and our fitted GP agrees with the synthetic reference element set within 5 km", (t) =>
  checkEme2000Suite(t, SYNTHETIC_SUITE, "synthetic_reference_elements.csv"));

test("$OEM carries EME2000, and our fitted GP agrees with CelesTrak SupGP within 5 km on the SpaceX ephemerides (private)",
  { skip: privateSkip(`${SUPGP_SUITE_RELATIVE}/celestrak_supgp_2026-034.csv`) },
  (t) => checkEme2000Suite(t, privatePath(SUPGP_SUITE_RELATIVE), "celestrak_supgp_2026-034.csv"));
