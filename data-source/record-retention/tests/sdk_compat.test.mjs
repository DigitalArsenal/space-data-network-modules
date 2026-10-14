import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeFlowNotice, decodeHostCall, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// data-source/record-retention on the typed contracts (1.0): an optional TimerTick in, FlowNotice reports out, and the
// host calls SDS $PIV invocations (plugin.getConfig, clock.now, storage.expire).
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// (the behaviour tests run the browser-declared test build of the same source: the SDK's in-process harness is the
// browser leg only, and the shipped artifact targets wasmedge - build.mjs)
const TEST_WASM_PATH = new URL("../dist/test-browser/module.wasm", import.meta.url);
const TEST_MANIFEST_PATH = new URL("../dist/test-browser/plugin-manifest.json", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const HOUR_MS = 3_600_000;
const FIXED_NOW_MS = 1_791_259_200_000; // 2026-10-06T00:00:00Z
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

// Host stub: the SDK harness's typed bridge answers plugin.getConfig, clock.now and storage.expire through
// hostcallDispatch (the SDK adapters: the config object -> one ModuleConfig on raw "config"; record fields -> camelCase
// options, the answer's camelCase fields -> the result record). The hostcall import is only watched: every $PIV
// request the module sends is decoded from guest memory into `wire`.
function createHostStub({ config = {}, answers = [], fail = null } = {}) {
  const calls = [];
  const wire = [];
  const queue = [...answers];
  const dispatch = (operation, params) => {
    calls.push({ operation, params });
    switch (operation) {
      case "plugin.getConfig": return config;
      case "clock.now": return FIXED_NOW_MS;
      case "storage.expire":
        if (fail) throw new Error(fail);
        return queue.shift() ?? { deleted: 0, missing: 0, capped: false };
      default: throw new Error(`unexpected hostcall operation: ${operation}`);
    }
  };
  return { calls, wire, config, dispatch, expires: () => wire.filter((c) => c.op === "storage.expire").map((c) => c.params) };
}

const instantiate = WebAssembly.instantiate;
async function harnessFor(t, stub) {
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports?.space_data_module_host;
    if (!host) return instantiate(module, imports);
    let memory;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (op, opLen, ptr, len) => {
        const call = decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice());
        stub.wire.push(call);
        return host.call(op, opLen, ptr, len);
      },
    } };
    const instance = await instantiate(module, wrapped);
    memory = instance.exports.memory;
    return instance;
  };
  // (the command surface instantiates per invoke, so the wrapper stays in place until the test ends)
  t.after(() => { WebAssembly.instantiate = instantiate; });
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(TEST_WASM_PATH)), manifest: JSON.parse(fs.readFileSync(TEST_MANIFEST_PATH, "utf8")),
    surface: "command", hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}
const tick = () => ({ portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "timer-retention", scheduledMs: FIXED_NOW_MS, firedMs: FIXED_NOW_MS, sequence: 3 }) });
async function invoke(t, stub, inputs = [tick()]) {
  return (await harnessFor(t, stub)).invoke({ methodId: "expire", inputs });
}
function notices(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  for (const o of response.outputs) {
    assert.equal(o.portId, "report");
    assert.equal(o.typeRef?.fileIdentifier, "FNTC");
  }
  return response.outputs.map((o) => decodeFlowNotice(o.payload));
}
// the expire params as the module put them on the wire (aligned record fields; BigInt -> Number)
const expireParams = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== "" && v !== 0 && v !== 0n).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));

test("data-source/record-retention artifact passes SDK compliance with typed ports only", async () => {
  const result = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  const [method] = readManifest().methods;
  const ids = [...method.inputPorts, ...method.outputPorts].map((port) => {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
    const [type] = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
    assert.equal(type.wireFormat, "flatbuffer", port.portId);
    return [port.portId, type.fileIdentifier];
  });
  assert.deepEqual(ids, [["tick", "TICK"], ["report", "FNTC"]]);
});

test("artifact imports only WASI and the sync hostcall bridge, and targets the node (wasmedge)", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
  assert.deepEqual(readManifest().runtimeTargets, ["wasmedge"]);
  assert.deepEqual(readManifest().capabilities, ["storage_write"]);
});

test("default: WXF from noaa-ncep, the window 72 h before the host clock, one typed storage.expire, one Expired notice", async (t) => {
  const stub = createHostStub({ answers: [{ deleted: 4608, missing: 0, capped: false }] });
  const out = notices(await invoke(t, stub));
  assert.deepEqual(stub.wire.map((c) => c.op), ["plugin.getConfig", "clock.now", "storage.expire"]);
  const cutoff = FIXED_NOW_MS - 72 * HOUR_MS;
  assert.deepEqual(stub.expires().map(expireParams), [{ SCHEMA: "WXF.fbs", PROVIDER_ID: "noaa-ncep", BEFORE_MS: cutoff, BATCH: 500, MAX_DELETES: 100000 }]);
  // the SDK JS host's view of it (generic typed path)
  assert.deepEqual(stub.calls.find((c) => c.operation === "storage.expire").params, { schema: "WXF.fbs", provider_id: "noaa-ncep", before_ms: cutoff, batch: 500, max_deletes: 100000 });
  assert.deepEqual(out, [{ kind: "expired", schema: "WXF.fbs", providerId: "noaa-ncep", sourceName: "", batchId: "", count: 4608, reason: "rolling window 72 h", items: [], atMs: cutoff }]);
});

test("a direct invoke without a tick runs the same pass", async (t) => {
  const stub = createHostStub({ answers: [{ deleted: 1, missing: 0, capped: false }] });
  const out = notices(await invoke(t, stub, []));
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 1);
});

test("config: window, batch, budget; one call a source, the budget carried across them; notices per lane", async (t) => {
  const stub = createHostStub({
    config: { window_hours: 24, batch: 100, max_deletes: 1000, targets: [{ schema: "WXF.fbs", provider_id: "noaa-ncep", sources: ["gfs-0p25-sea", "goes19-world"] }, { schema: "OMM.fbs", sources: ["celestrak-gp"] }] },
    answers: [{ deleted: 300, missing: 2, capped: false }, { deleted: 200, missing: 0, capped: false }, { deleted: 7, missing: 1, capped: true }],
  });
  const out = notices(await invoke(t, stub));
  const cutoff = FIXED_NOW_MS - 24 * HOUR_MS;
  assert.deepEqual(stub.expires().map(expireParams), [
    { SCHEMA: "WXF.fbs", PROVIDER_ID: "noaa-ncep", SOURCE_NAME: "gfs-0p25-sea", BEFORE_MS: cutoff, BATCH: 100, MAX_DELETES: 1000 },
    { SCHEMA: "WXF.fbs", PROVIDER_ID: "noaa-ncep", SOURCE_NAME: "goes19-world", BEFORE_MS: cutoff, BATCH: 100, MAX_DELETES: 700 },
    { SCHEMA: "OMM.fbs", SOURCE_NAME: "celestrak-gp", BEFORE_MS: cutoff, BATCH: 100, MAX_DELETES: 500 },
  ]);
  assert.deepEqual(out.map((n) => [n.kind, n.schema, n.providerId, n.sourceName, n.count, n.reason, n.atMs]), [
    ["expired", "WXF.fbs", "noaa-ncep", "gfs-0p25-sea", 300, "rolling window 24 h", cutoff],
    ["missing", "WXF.fbs", "noaa-ncep", "gfs-0p25-sea", 2, "listed by the record index, no longer stored", cutoff],
    ["expired", "WXF.fbs", "noaa-ncep", "goes19-world", 200, "rolling window 24 h", cutoff],
    ["expired", "OMM.fbs", "", "celestrak-gp", 7, "rolling window 24 h; max_deletes reached", cutoff],
    ["missing", "OMM.fbs", "", "celestrak-gp", 1, "listed by the record index, no longer stored", cutoff],
  ]);
  assert.equal(out.reduce((n, x) => n + (x.kind === "expired" ? x.count : 0), 0), 507, "deleted, summed");
});

test("the budget spent before a lane: the lane is not visited and is reported Skipped", async (t) => {
  const stub = createHostStub({
    config: { max_deletes: 300, targets: [{ provider_id: "noaa-ncep", sources: ["a", "b"] }] },
    answers: [{ deleted: 300, missing: 0, capped: true }],
  });
  const out = notices(await invoke(t, stub));
  assert.equal(stub.expires().length, 1);
  assert.deepEqual(out.map((n) => [n.kind, n.sourceName, n.count]), [["expired", "a", 300], ["skipped", "b", 0]]);
  assert.equal(out[1].reason, "max_deletes reached; the lane waits for the next pass");
});

test("a target naming no lane is refused before any deletion; a host failure fails the pass", async (t) => {
  const bare = createHostStub({ config: { targets: [{ schema: "WXF.fbs", provider_id: "" }] } });
  let response = await invoke(t, bare);
  assert.equal(response.statusCode, 400);
  assert.equal(response.errorCode, "retention-bad-target");
  assert.equal(bare.expires().length, 0);

  const failing = createHostStub({ fail: "expire failed: store is read-only" });
  response = await invoke(t, failing);
  assert.equal(response.statusCode, 502);
  assert.match(response.errorMessage ?? "", /read-only/);
  assert.equal(response.outputs.length, 0);
});

test("a lane name over the hostcall's aligned bound is refused, never truncated", async (t) => {
  const stub = createHostStub({ config: { targets: [{ provider_id: "p".repeat(129) }] } });
  const response = await invoke(t, stub);
  assert.equal(response.statusCode, 400);
  assert.match(response.errorMessage, /provider_id .* is 129 bytes; storage\.expire takes at most 128/);
  assert.equal(stub.expires().length, 0);
});
