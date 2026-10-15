import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserHost } from "space-data-module-sdk/host/browser";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// hostcap/clock on the typed contracts (1.0): an optional TimerTick in, one $TIM out, and the clock reads themselves
// SDS $PIV hostcalls the SDK host bridge decodes into the host's own clock.now / clock.nowIso calls.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
// The standard's own generated JS bindings decode the $TIM frames.
const { TIM, timingStandard, timEpochRepresentation } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", "TIM", "main.js")).href);
const flatbuffers = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")).href);

const FIXED_NOW_MS = 1_782_950_400_123; // 2026-07-03T00:00:00.123Z
const FIXED_NOW_ISO = "2026-07-03T00:00:00.123Z";
const TICK_TYPE = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const tickFrame = (tick) => ({ portId: "trigger", typeRef: TICK_TYPE, payload: encodeTimerTick(tick) });

// The SDK JS host's clock built-ins: clock.now answers Unix ms (a number), clock.nowIso the RFC3339 text.
function hostStub({ failOps = {} } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    if (failOps[operation]) throw Object.assign(new Error(failOps[operation]), { name: "HostCapabilityError" });
    if (operation === "clock.now") return FIXED_NOW_MS;
    if (operation === "clock.nowIso") return FIXED_NOW_ISO;
    throw new Error(`unexpected hostcall ${operation}`);
  };
  return { calls, dispatch };
}
// Zero-input invokes use the command surface (a PIV request without payload-arena bytes flips the direct surface into
// plugin-owned external-arena output descriptors); invokes with a tick use the direct surface.
async function harnessFor(t, options, surface = "command") {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface, ...options });
  t.after(() => harness.destroy());
  return harness;
}
function decodeTime(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1);
  const [frame] = result.outputs;
  assert.equal(frame.portId, "time");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.ok(TIM.bufferHasIdentifier(bb), "the frame is a $TIM");
  const tim = TIM.getRootAsTIM(bb);
  const instant = tim.INSTANT();
  assert.ok(instant, "the $TIM carries an INSTANT");
  return {
    timeSystem: tim.TIME_SYSTEM(),
    instantTimeSystem: instant.TIME_SYSTEM(),
    epochFormat: instant.EPOCH_FORMAT(),
    unixMs: instant.SECONDS() * 1000 + instant.SUBSECOND_NANOS() / 1e6,
    seconds: instant.SECONDS(),
    nanos: instant.SUBSECOND_NANOS(),
    iso: instant.ISO8601(),
  };
}

test("hostcap/clock passes SDK compliance with typed ports", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "TICK");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$TIM");
});

test("hostcap/clock imports only WASI and the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  assert.equal(inspection.profile, "module-host-abi");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("now samples clock.now + clock.nowIso and emits one $TIM carrying both readings", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const time = decodeTime(await harness.invoke({ methodId: "now", inputs: [] }));
  assert.equal(time.timeSystem, timingStandard.UTC);
  assert.equal(time.instantTimeSystem, timingStandard.UTC);
  assert.equal(time.epochFormat, timEpochRepresentation.UNIX_SECONDS);
  assert.equal(time.seconds, Math.floor(FIXED_NOW_MS / 1000));
  assert.equal(time.nanos, (FIXED_NOW_MS % 1000) * 1e6, "the millisecond remainder rides SUBSECOND_NANOS exactly");
  assert.equal(time.unixMs, FIXED_NOW_MS);
  assert.equal(time.iso, FIXED_NOW_ISO, "ISO8601 is clock.nowIso verbatim");
  assert.deepEqual(stub.calls.map((c) => c.operation), ["clock.now", "clock.nowIso"], "exactly the two clock hostcalls");
});

test("a TimerTick trigger causes one sample; its fields are not read", async (t) => {
  const stub = hostStub();
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch }, "direct");
  const time = decodeTime(await harness.invoke({ methodId: "now", inputs: [tickFrame({ triggerId: "every-minute", scheduledMs: 1, firedMs: 2, sequence: 7 })] }));
  assert.equal(time.unixMs, FIXED_NOW_MS, "the time is the host clock's, not the tick's");
  assert.equal(stub.calls.length, 2);
});

test("now works against the real BrowserHost clock built-ins (capability-gated)", async (t) => {
  const harness = await harnessFor(t, { host: createBrowserHost({ capabilities: ["clock"] }) });
  const before = Date.now();
  const time = decodeTime(await harness.invoke({ methodId: "now", inputs: [] }));
  const after = Date.now();
  assert.ok(time.unixMs >= before && time.unixMs <= after, "the instant comes from the host clock");
  const parsedIso = Date.parse(time.iso);
  assert.ok(Number.isFinite(parsedIso), "ISO8601 is a parseable RFC3339 timestamp");
  assert.ok(Math.abs(parsedIso - time.unixMs) < 5_000, "ISO8601 and the Unix instant agree");
});

test("now fails closed when the host clock is unavailable", async (t) => {
  const stub = hostStub({ failOps: { "clock.now": "clock capability not granted" } });
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const result = await harness.invoke({ methodId: "now", inputs: [] });
  assert.notEqual(result.statusCode, 0, "a host error fails the invoke");
  assert.equal(result.errorCode, "clock-unavailable");
  assert.match(String(result.errorMessage), /clock capability not granted/);
  assert.equal(result.outputs.length, 0);
  assert.deepEqual(stub.calls.map((c) => c.operation), ["clock.now"]);
});

test("now propagates a clock.nowIso failure after a successful clock.now", async (t) => {
  const stub = hostStub({ failOps: { "clock.nowIso": "nowIso exploded" } });
  const harness = await harnessFor(t, { hostcallDispatch: stub.dispatch });
  const result = await harness.invoke({ methodId: "now", inputs: [] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "clock-unavailable");
  assert.match(String(result.errorMessage), /nowIso exploded/);
  assert.equal(result.outputs.length, 0);
});

test("the BrowserHost refuses the clock without the capability grant", async (t) => {
  const harness = await harnessFor(t, { host: createBrowserHost({ capabilities: [] }) });
  const result = await harness.invoke({ methodId: "now", inputs: [] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.errorCode, "clock-unavailable");
  assert.equal(result.outputs.length, 0);
});
