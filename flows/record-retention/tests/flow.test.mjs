/*
 * Flow-level test for the compiled record-retention flow - BRIDGE mode: the SAME runtime.wasm the Go host serves from
 * its cron timer, instantiated in the JS flow runtime host (WasmEdge leg). The timer's TimerTick enters expire; the
 * only host crossings are the module's typed hostcalls (SDS $PIV invocations), stubbed here: plugin.getConfig (one
 * ModuleConfig on raw "config"), clock.now and storage.expire. Each lane pass's FlowNotice reaches the egress.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeFlowNotice, decodeHostCall, encodeHostCallResult, encodeModuleConfig, encodeTimerTick, identifierOf } from "space-data-module-sdk/runtime-contracts";

const RUNTIME = new URL("../dist/runtime.wasm", import.meta.url);
const NOW_MS = 1_791_259_200_000; // 2026-10-06T00:00:00Z
const HOUR_MS = 3_600_000;

// The Go host's typed hostcall dialect: each call an SDS $PIV request, each answer a $PIV response.
function createHostStub(config, answers) {
  const calls = [];
  const memoryRef = { memory: null };
  const queue = [...answers];
  let response = new Uint8Array(0);
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const call = decodeHostCall(new Uint8Array(memoryRef.memory.buffer, payloadPtr, payloadLen).slice());
      calls.push(call);
      if (call.op === "plugin.getConfig") response = encodeHostCallResult({ ok: true, op: call.op, raw: { config: encodeModuleConfig(config) } });
      else if (call.op === "clock.now") response = encodeHostCallResult({ ok: true, op: call.op, result: { UNIX_MS: BigInt(NOW_MS) } });
      else if (call.op === "storage.expire") response = encodeHostCallResult({ ok: true, op: call.op, result: queue.shift() ?? { DELETED: 0n, MISSING: 0n, CAPPED: false } });
      else response = encodeHostCallResult({ ok: false, error: { code: "unsupported", message: `unexpected op ${call.op}` } });
      return 0;
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { calls, imports, memoryRef };
}

async function run(config, answers) {
  const stub = createHostStub(config, answers);
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(RUNTIME)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  const egress = [];
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encodeTimerTick({ triggerId: "timer-retention", scheduledMs: NOW_MS, firedMs: NOW_MS, sequence: 0 }) });
  await host.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) egress.push(Uint8Array.from(f.bytes)); return { statusCode: 0 }; } });
  return { stub, egress };
}

test("timer tick -> one typed storage.expire over the default lane, 72 h before the host clock -> one Expired FlowNotice at the egress", async () => {
  const { stub, egress } = await run({}, [{ DELETED: 4608n, MISSING: 0n, CAPPED: false }]);
  assert.deepEqual(stub.calls.map((c) => c.op), ["plugin.getConfig", "clock.now", "storage.expire"]);
  const [expire] = stub.calls.filter((c) => c.op === "storage.expire");
  const cutoff = NOW_MS - 72 * HOUR_MS;
  assert.deepEqual([expire.params.SCHEMA, expire.params.PROVIDER_ID, Number(expire.params.BEFORE_MS), expire.params.BATCH, expire.params.MAX_DELETES], ["WXF.fbs", "noaa-ncep", cutoff, 500, 100000]);
  assert.equal(egress.length, 1);
  assert.equal(identifierOf(egress[0]), "FNTC");
  assert.deepEqual(decodeFlowNotice(egress[0]), { kind: "expired", schema: "WXF.fbs", providerId: "noaa-ncep", sourceName: "", batchId: "", count: 4608, reason: "rolling window 72 h", items: [], atMs: cutoff });
});

test("configured lanes: a notice per lane, the budget carried across them", async () => {
  const config = { window_hours: 72, targets: [{ schema: "WXF.fbs", provider_id: "noaa-goes", sources: ["noaa-goes19-world", "noaa-goes18-world"] }] };
  const { stub, egress } = await run(config, [{ DELETED: 90n, MISSING: 1n, CAPPED: false }, { DELETED: 10n, MISSING: 0n, CAPPED: false }]);
  const expires = stub.calls.filter((c) => c.op === "storage.expire").map((c) => [c.params.SOURCE_NAME, c.params.MAX_DELETES]);
  assert.deepEqual(expires, [["noaa-goes19-world", 100000], ["noaa-goes18-world", 99910]]);
  assert.deepEqual(egress.map(decodeFlowNotice).map((n) => [n.kind, n.sourceName, n.count]), [["expired", "noaa-goes19-world", 90], ["missing", "noaa-goes19-world", 1], ["expired", "noaa-goes18-world", 10]]);
});
