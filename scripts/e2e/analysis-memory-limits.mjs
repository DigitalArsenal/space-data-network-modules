#!/usr/bin/env node
// E2E (modules-analysis-shared-memory-20261017): the parameter catalog
// and the event locator declare a shared memory sized to their measured need,
// not 2 GiB each.
//
// A browser reserves a shared memory's whole maximum up front; the console
// loads both at startup, and 2 x 2 GiB puts a phone past what it will reserve.
// For each rebuilt artifact this:
//   1. reads its declared memory from its bytes: one DEFINED memory whose
//      maximum is the size its build declares;
//   2. runs the LARGEST request each module accepts (its own per-invocation
//      limits), on the rebuilt artifact and on the artifact it replaces
//      (modules main ffa561dc), through the SDK's own browser harness:
//        parameters: publish_catalog; 16 parameters on 4,096 states and 256
//                    on 256 (kMaxValues = 65,536 values); 12 on one state;
//        events:     apsides and node crossings over a 200,000-state ephemeris
//                    (kMaxSamples) at the engine's 10 s spacing, 23 days;
//      every answer is byte-identical between the two, and a parameter request
//      over kMaxValues is refused as too large;
//   3. holds the rebuilt artifact's measured high-water to at most its maximum
//      / 1.5 (the sizing rule), and prints the reservation saved.
// --measure (the sizing run) prints each artifact's high-water without the
// limit checks.
// usage: node scripts/e2e/analysis-memory-limits.mjs [--measure]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "ffa561dc70393b4f56899a2128688093affc7c30";
const MiB = 1024 * 1024;
const PAGE = 65536;
const MEASURE = process.argv.includes("--measure");

/** Each module's package, artifact, and the maximum its build declares (MiB). */
const MODULES = [
  { name: "analysis/parameters", maximumMiB: 32 },
  { name: "propagator/events", maximumMiB: 80 },
];

function definedMemories(bytes) {
  const out = [];
  let offset = 8;
  const leb = () => { let result = 0, shift = 0, byte; do { byte = bytes[offset++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return result; };
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = leb();
    const end = offset + size;
    if (id === 5) for (let n = leb(), i = 0; i < n; i += 1) { const flags = bytes[offset++]; const min = leb(); out.push({ shared: Boolean(flags & 2), min, max: flags & 1 ? leb() : null }); }
    offset = end;
  }
  return out;
}

/** A package's own dependency, resolved from that package (each pins its own SDK and SDS). */
async function from(pkg, specifier) {
  const require = createRequire(path.join(root, pkg, "package.json"));
  return import(pathToFileURL(require.resolve(specifier)).href);
}

async function harnessFor(pkg, bytes) {
  const { createBrowserModuleHarness } = await from(pkg, "space-data-module-sdk/testing");
  return createBrowserModuleHarness({ wasmSource: bytes, surface: "direct" });
}

/** Run every request on one harness: the answers (bytes) and the memory high-water. */
async function run(harness, requests) {
  const answers = [];
  let highWater = harness.memory?.buffer?.byteLength ?? 0;
  for (const request of requests) {
    const response = await harness.invoke(request);
    assert.equal(response.statusCode, 0, `${request.methodId}: ${response.errorMessage ?? "refused"}`);
    answers.push(Buffer.concat((response.outputs ?? []).map((frame) => Buffer.from(frame.payload))).toString("base64"));
    highWater = Math.max(highWater, harness.memory?.buffer?.byteLength ?? 0);
  }
  return { answers, highWater };
}

const ARCSEC = Math.PI / (180 * 3600);
const eopTypeRef = { schemaName: "EOP.fbs", fileIdentifier: "$EOP", rootTypeName: "EOP" };

async function earthOrientation(pkg) {
  const flatbuffers = await from(pkg, "flatbuffers");
  const { EOP, EOPT } = await from(pkg, "spacedatastandards.org/lib/js/EOP/main.js");
  const builder = new flatbuffers.Builder(1024);
  const row = new EOPT();
  row.DATE = "2026-08-29T00:00:00Z";
  row.TAI_MINUS_UTC_SECONDS = 37;
  row.UT1_MINUS_UTC_SECONDS_HP = 0.0177655;
  row.X_POLE_WANDER_RADIANS_HP = 0.182065 * ARCSEC;
  row.Y_POLE_WANDER_RADIANS_HP = 0.407705 * ARCSEC;
  row.DATA_SET_EPOCH = "2026-08-29T00:00:00Z";
  row.DATA_SET_CID = "bafkreie2jfwy5jvc564e2wqqx3t76xoqg26tu3k7eplobeqxbzbqg6elyi";
  EOP.finishEOPBuffer(builder, row.pack(builder));
  return builder.asUint8Array();
}

/** A fixed state on a synthetic ellipse (a request fixture, not a propagator). */
function ellipse(seconds, periodSeconds = 5400) {
  const w = (2 * Math.PI) / periodSeconds;
  const angle = w * seconds + Math.PI / 8;
  return {
    position: [7100000 * Math.cos(angle), 6900000 * Math.sin(angle), 900000 * Math.sin(angle)],
    velocity: [-7100000 * w * Math.sin(angle), 6900000 * w * Math.cos(angle), 900000 * w * Math.cos(angle)],
  };
}
const START = Date.UTC(2026, 7, 29, 0, 0, 0);
const isoAt = (seconds) => new Date(START + seconds * 1000).toISOString().replace("Z", "");

async function parametersRequests(pkg) {
  const flatbuffers = await from(pkg, "flatbuffers");
  const { PCE, PCET, PCEEvaluationContextT, PCEEvaluationRequestT, PCEParameterRefT } = await from(pkg, "spacedatastandards.org/lib/js/PCE/main.js");
  const { FRMStateVectorT, FRMVector3T } = await from(pkg, "spacedatastandards.org/lib/js/FRM/main.js");
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, pkg, "src", "generated", "pce-crosswalk.json"), "utf8"));
  const roster = JSON.parse(fs.readFileSync(path.join(root, pkg, "src", "generated", "roster.json"), "utf8"));
  const codeOf = (name) => crosswalk.rows.find((row) => row.target === name)?.value ?? null;
  const names = (roster.parameters ?? roster).map((row) => row.name);
  const encode = (parameterNames, count) => {
    const builder = new flatbuffers.Builder(1 << 20);
    const context = new PCEEvaluationContextT();
    context.CENTRAL_BODY_ID = 399;
    context.GRAVITATIONAL_PARAMETER = 3.986004418e14;
    context.EQUATORIAL_RADIUS_M = 6378137.0;
    context.FLATTENING = 1.0 / 298.257223563;
    context.REFERENCE_EPOCH = "2026-08-28T12:00:00";
    const request = new PCEEvaluationRequestT();
    request.CONTEXT = context;
    request.PARAMETERS = parameterNames.map((name) => {
      const ref = new PCEParameterRefT();
      const code = codeOf(name);
      if (code === null) { ref.PARAMETER = 65535; ref.PROVIDER_DEFINED_NAME = name; } else ref.PARAMETER = code;
      return ref;
    });
    request.STATES = Array.from({ length: count }, (_, i) => {
      const { position, velocity } = ellipse(i * 10);
      const state = new FRMStateVectorT();
      state.POSITION = new FRMVector3T(...position);
      state.VELOCITY = new FRMVector3T(...velocity);
      state.EPOCH = isoAt(i * 10);
      state.EPOCH_TIME_SYSTEM = "UTC";
      return state;
    });
    request.TRACE_ID = "analysis-memory-limits";
    const envelope = new PCET();
    envelope.EVALUATION_REQUEST = request;
    PCE.finishPCEBuffer(builder, envelope.pack(builder));
    return builder.asUint8Array();
  };
  const eop = await earthOrientation(pkg);
  const pceTypeRef = { schemaName: "PCE.fbs", fileIdentifier: "$PCE", rootTypeName: "PCE" };
  const evaluate = (payload) => ({ methodId: "evaluate_parameters", inputs: [{ portId: "request", typeRef: pceTypeRef, payload }, { portId: "earth_orientation", typeRef: eopTypeRef, payload: eop }] });
  return {
    label: `publish_catalog; 16 of ${names.length} parameters on 4,096 states, 256 on 256; 12 on one state`,
    requests: [{ methodId: "publish_catalog", inputs: [] }, evaluate(encode(names.slice(0, 16), 4096)), evaluate(encode(names.slice(0, 256), 256)), evaluate(encode(names.slice(0, 12), 1))],
    tooLarge: evaluate(encode(names.slice(0, 17), 4096)),
  };
}

async function eventsRequests(pkg) {
  const flatbuffers = await from(pkg, "flatbuffers");
  const { EVL, EVLT, EVLEventLocationRequestT } = await from(pkg, "spacedatastandards.org/lib/js/EVL/main.js");
  const { PCEEvaluationContextT } = await from(pkg, "spacedatastandards.org/lib/js/PCE/main.js");
  const { OEM, OEMT, ephemerisDataBlockT, ephemerisDataLineT } = await from(pkg, "spacedatastandards.org/lib/js/OEM/main.js");
  const SPACING = 10;
  const SPAN = (200000 - 1) * SPACING;
  const builder = new flatbuffers.Builder(1 << 24);
  const lines = [];
  for (let seconds = 0; seconds <= SPAN; seconds += SPACING) {
    const { position, velocity } = ellipse(seconds);
    const line = new ephemerisDataLineT();
    line.EPOCH = isoAt(seconds);
    [line.X, line.Y, line.Z] = position.map((v) => v / 1000);
    [line.X_DOT, line.Y_DOT, line.Z_DOT] = velocity.map((v) => v / 1000);
    lines.push(line);
  }
  const block = new ephemerisDataBlockT();
  block.EPHEMERIS_DATA_LINES = lines;
  const message = new OEMT();
  message.EPHEMERIS_DATA_BLOCK = [block];
  OEM.finishOEMBuffer(builder, message.pack(builder));
  const ephemeris = builder.asUint8Array();
  const locate = (locatorClass) => {
    const b = new flatbuffers.Builder(1 << 16);
    const context = new PCEEvaluationContextT();
    context.CENTRAL_BODY_ID = 399;
    context.GRAVITATIONAL_PARAMETER = 3.986004418e14;
    context.EQUATORIAL_RADIUS_M = 6378137.0;
    context.FLATTENING = 1.0 / 298.257223563;
    const request = new EVLEventLocationRequestT();
    request.LOCATOR_CLASS = locatorClass;
    request.CONTEXT = context;
    request.SCAN_START_EPOCH = isoAt(0);
    request.SCAN_STOP_EPOCH = isoAt(SPAN);
    request.EPOCH_TIME_SYSTEM = "UTC";
    request.SCAN_STEP_SECONDS = 30;
    request.REFINEMENT_TOLERANCE_SECONDS = 1e-9;
    request.TRACE_ID = "analysis-memory-limits";
    const envelope = new EVLT();
    envelope.LOCATION_REQUEST = request;
    EVL.finishEVLBuffer(b, envelope.pack(b));
    return b.asUint8Array();
  };
  const eop = await earthOrientation(pkg);
  const evlTypeRef = { schemaName: "EVL.fbs", fileIdentifier: "$EVL", rootTypeName: "EVL" };
  const oemTypeRef = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
  const request = (locatorClass) => ({ methodId: "locate_events", inputs: [
    { portId: "request", typeRef: evlTypeRef, payload: locate(locatorClass) },
    { portId: "ephemeris", typeRef: oemTypeRef, payload: ephemeris },
    { portId: "earth_orientation", typeRef: eopTypeRef, payload: eop },
  ] });
  return {
    label: `apsides and node crossings over ${(SPAN / 86400).toFixed(1)} days at ${SPACING} s (${lines.length.toLocaleString()} states, ${(ephemeris.length / MiB).toFixed(1)} MiB of $OEM)`,
    requests: [request(4), request(5)],
  };
}

const REQUESTS = { "analysis/parameters": parametersRequests, "propagator/events": eventsRequests };

async function main() {
  const t0 = Date.now();
  let reservedBefore = 0;
  let reservedAfter = 0;
  for (const { name, maximumMiB } of MODULES) {
    const artifact = path.join(name, "dist", "isomorphic", "module.wasm");
    const bytes = new Uint8Array(fs.readFileSync(path.join(root, artifact)));
    const before = new Uint8Array(execFileSync("git", ["-C", root, "show", `${BASE}:${artifact}`], { maxBuffer: 64 * MiB }));
    const [memory, ...extra] = definedMemories(bytes);
    const [old] = definedMemories(before);
    assert.ok(memory && !extra.length, `${name}: one defined memory (${JSON.stringify(definedMemories(bytes))})`);
    if (!MEASURE) assert.equal(memory.max * PAGE, maximumMiB * MiB, `${name}: declares ${memory.max * PAGE / MiB} MiB, its build says ${maximumMiB} MiB`);

    const { label, requests, tooLarge } = await REQUESTS[name](name);
    const harness = await harnessFor(name, bytes);
    const rebuilt = await run(harness, requests);
    if (tooLarge && !MEASURE) {
      const refused = await harness.invoke(tooLarge);
      assert.notEqual(refused.statusCode, 0, `${name}: a request over its per-invocation limit was answered`);
      assert.match(String(refused.errorMessage ?? refused.errorCode), /per-invocation limits|request-too-large/, `${name}: refused for another reason: ${refused.errorMessage}`);
    }
    const replaced = await run(await harnessFor(name, before), requests);
    rebuilt.answers.forEach((answer, i) => assert.equal(answer, replaced.answers[i], `${name}: answer ${i} (${requests[i].methodId}) differs from the artifact it replaces`));
    if (!MEASURE) assert.ok(rebuilt.highWater * 1.5 <= memory.max * PAGE, `${name}: high-water ${(rebuilt.highWater / MiB).toFixed(1)} MiB x1.5 exceeds its ${maximumMiB} MiB maximum`);
    reservedBefore += (old.shared ? old.max : 0) * PAGE;
    reservedAfter += (memory.shared ? memory.max : 0) * PAGE;
    console.log(`${name}: ${memory.shared ? "shared" : "unshared"} ${memory.min * PAGE / MiB}..${memory.max * PAGE / MiB} MiB (was ${old.min * PAGE / MiB}..${old.max * PAGE / MiB}); ${label}: high-water ${(rebuilt.highWater / MiB).toFixed(1)} MiB, ${requests.length} answers identical`);
  }
  console.log(`reserved by the two: ${reservedAfter / MiB} MiB (was ${reservedBefore / MiB} MiB)`);
  console.log(`ANALYSIS-MEMORY-LIMITS ${MEASURE ? "MEASURED" : "PASS"} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((error) => {
  console.log(`ANALYSIS-MEMORY-LIMITS FAIL: ${error?.stack ?? error}`);
  process.exit(1);
});
