// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames` (class defect, filed
// from the live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// The compiled flow runtime fills an invocation PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy stay declarative, so a guest that
// reads ordinal 0 of a port and returns destroys every other frame it was
// handed there. Every input port of data-source/weathernext-source is
// single-stream BY CONTRACT, so a surplus is refused by name. The refusal
// runs before any hostcall, which is why these cases need no host stub.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeIngestRequest, encodeIngestResult, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";

// The SDK browser harness gates on runtimeTargets and this artifact is
// WasmEdge-only (secrets.* has no browser host), so the direct invocations run
// through the repo's gate-free sync hostcall-bridge harness: the same
// plugin_invoke_stream ABI and hostcall wire the WasmEdge host speaks, with
// Node standing in for that leg.
import { createSdkBrowserShimHarness } from "../../../tests/lib/sdkBrowserShimHarness.mjs";

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

// Typed frames (contracts 1.0): the port's own runtime type.
const TYPED = {
  tick: () => ({ typeRef: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" }, payload: encodeTimerTick({ triggerId: "t" }) }),
  result: () => ({ typeRef: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" }, payload: encodeIngestResult({ schema: "WXF.fbs" }) }),
  meta: () => ({ typeRef: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" }, payload: encodeIngestRequest({ schema: "WXF.fbs", tags: {} }) }),
};
function bytesInput(portId) {
  return { portId, ...TYPED[portId]() };
}

async function invoke(t, methodId, inputs) {
  const harness = await createSdkBrowserShimHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
    // Any hostcall before the refusal would be the defect; answering nothing
    // makes such a call fail loudly instead of passing by accident.
    dispatch: (operation) => {
      throw new Error(`hostcall ${operation} reached the host before the batched-frame guard`);
    },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

const CASES = [
  ["plan", "tick", []],
  ["cyclone_request", "tick", []],
  ["publish_request", "result", ["meta"]],
];

for (const [methodId, port, others] of CASES) {
  test(`${methodId} refuses two frames on the single-stream "${port}" port`, async (t) => {
    const inputs = others.map((other) => bytesInput(other));
    inputs.push(bytesInput(port));
    inputs.push(bytesInput(port));
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(response.errorMessage, new RegExp(`2 frames on single-stream input port "${port}"`));
    assert.equal(response.outputs.length, 0);
  });
}

test("data-source/weathernext-source source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/weathernext_source_module.cpp", import.meta.url)),
    "utf8",
  );
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return code.includes("plugin_get_input_frame(0)");
    });
  assert.deepEqual(offenders, []);
});
