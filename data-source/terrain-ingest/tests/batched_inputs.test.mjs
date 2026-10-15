// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames` (class defect, filed
// from the live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())` — PORT-BLIND, budget
// 64 — while `maxStreams`, `maxBatch` and `drainPolicy` are purely DECLARATIVE
// in the compiled runtime. A guest that reads ordinal 0 of a port and returns
// therefore destroys every other frame it was handed on that port, with
// nothing re-delivering them and nothing logging the loss.
//
// Every input port of data-source/terrain-ingest is single-stream BY CONTRACT,
// so a surplus is refused by name rather than silently discarded. The refusal
// runs before any port parsing or hostcall, which is why these cases need no
// host stub.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeIngestRequest, encodeIngestResult } from "space-data-module-sdk/runtime-contracts";

import { TYPE, createHarness, tickFrame, irmRecord, markFrames, jobIdOf, jobRecord, outputs } from "./typed.mjs";

const JOB_ID = jobIdOf("copernicus-glo30-quantized-mesh", "glo30-test", "2023-04-01T00:00:00.000Z");
// One well-typed frame per port (typed contracts 1.0): the guard reads port ids, the type check reads the type.
const FRAMES = {
  tick: () => tickFrame(),
  job: () => ({ portId: "job", typeRef: TYPE.IRM, payload: jobRecord({ jobId: JOB_ID, first: 0, next: 1 }) }),
  records: () => ({ portId: "records", typeRef: TYPE.DTT, payload: new Uint8Array(4) }),
  result: () => ({ portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult({ schema: "DTT", inserted: 1 }) }),
  meta: () => ({ portId: "meta", typeRef: TYPE.INGQ, payload: encodeIngestRequest({ schema: "DTT", tags: { batchId: "b" } }) }),
};

async function invoke(t, methodId, inputs) {
  const harness = await createHarness(t, {});
  return harness.invoke({ methodId, inputs });
}

const CASES = [
  ["mark_query", "tick", []],
  ["ingest_plan", "tick", []],
  ["granule_plan", "tick", []],
  ["ingest_meta", "job", ["records"]],
  ["ingest_meta", "records", ["job"]],
  ["publish_request", "result", ["meta", "job"]],
  ["publish_request", "meta", ["result", "job"]],
  ["publish_request", "job", ["result", "meta"]],
];

for (const [methodId, port, others] of CASES) {
  test(`${methodId} refuses two frames on the single-stream "${port}" port`, async (t) => {
    const inputs = others.map((other) => FRAMES[other]());
    inputs.push(FRAMES[port](), FRAMES[port]());
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(response.errorMessage, new RegExp(`2 frames on single-stream input port "${port}"`), response.errorMessage);
    assert.equal(response.outputs.length, 0, "answering from one frame while destroying the other is the defect this guards");
  });

  test(`${methodId} does not refuse one frame per port`, async (t) => {
    // The guard must be inert on the shape every deployed flow delivers; the method may still fail for its own
    // reasons (an empty config), which is a different error code and not this invariant's business.
    const inputs = [...others.map((other) => FRAMES[other]()), FRAMES[port]()];
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.errorCode, "batched-input-frames");
  });
}

test("the planners take hostcap/flatsql-query's answer as SEVERAL $FSB chunks on \"mark\" - one answer, not a surplus", async (t) => {
  const config = {
    tileset_id: "glo30-test",
    dataset_epoch: "2023-04-01T00:00:00.000Z",
    retrieved_at: "2026-08-26T00:00:00.000Z",
    min_level: 8,
    max_level: 8,
    regions: [{ name: "probe", west: 10, south: 45, east: 12, north: 47, max_level: 8 }],
  };
  const harness = await createHarness(t, config);
  const chunks = markFrames([irmRecord({ jobId: JOB_ID, next: 3 })], 48);
  assert.ok(chunks.length > 1, "the fixture really is chunked");
  const response = await harness.invoke({ methodId: "granule_plan", inputs: [tickFrame(), ...chunks] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.ok(outputs(response).get("plan"));
  // A chunk sequence with a hole is not an answer.
  const holed = await harness.invoke({ methodId: "granule_plan", inputs: [tickFrame(), ...chunks.slice(1)] });
  assert.equal(holed.errorCode, "invalid-mark-frame");
});

test("data-source/terrain-ingest source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/terrain_ingest_module.cpp", import.meta.url)), "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return code.includes("plugin_get_input_frame(0)");
    });
  assert.deepEqual(offenders, [], `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`);
});
