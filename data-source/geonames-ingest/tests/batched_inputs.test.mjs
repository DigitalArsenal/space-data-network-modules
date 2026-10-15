// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// `space_data_module_runtime_begin_node_invocation` fills an invocation by popping the node's queue PORT-BLIND, budget
// 64, while `maxStreams`, `maxBatch` and `drainPolicy` are purely DECLARATIVE in the compiled runtime. A guest that reads
// ordinal 0 of a port and returns therefore destroys every other frame it was handed, with nothing re-delivering them
// and nothing logging the loss.
//
// Every input port of data-source/geonames-ingest is single-stream BY CONTRACT - except ingest_plan's "mark", which
// carries the flatsql-query result's $FSB chunks, every one of which is read - so a surplus is refused by name. The
// refusal runs before any port parsing or hostcall, which is why these cases need no host stub. Every frame is typed.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { markFrames, metaFrame, recordsFrame, responseFrame, resultFrame, tickFrame } from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

const FRAMES = {
  tick: () => tickFrame(),
  mark: () => markFrames([])[0],
  records: () => recordsFrame(1),
  response: () => responseFrame(),
  result: () => resultFrame({ schema: "GNP.fbs", inserted: 1 }),
  meta: () => metaFrame({ schema: "GNP.fbs", tags: { batchId: "geonames@2026-08-15" } }),
};

// [methodId, the port that is doubled, the other ports one frame each]
const CASES = [
  ["mark_query", "tick", []],
  ["ingest_plan", "tick", ["mark"]],
  ["ingest_meta", "records", ["response"]],
  ["ingest_meta", "response", ["records"]],
  ["publish_request", "result", ["meta"]],
  ["publish_request", "meta", ["result"]],
];

for (const [methodId, port, others] of CASES) {
  test(`${methodId} refuses two frames on the single-stream "${port}" port`, async (t) => {
    const inputs = [...others.map((other) => FRAMES[other]()), FRAMES[port](), FRAMES[port]()];
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(response.errorMessage, new RegExp(`2 frames on single-stream input port "${port}"`), response.errorMessage);
    assert.equal(response.outputs.length, 0, "answering from one frame while destroying the other is the defect this guards");
  });

  test(`${methodId} does not refuse one frame per port`, async (t) => {
    // The guard must be inert on the shape every deployed flow delivers. This asserts only that the refusal did NOT
    // fire — the method may still fail for its own reasons, which is a different error code.
    const response = await invoke(t, methodId, [...others.map((other) => FRAMES[other]()), FRAMES[port]()]);
    assert.notEqual(response.errorCode, "batched-input-frames");
  });
}

test("ingest_plan reads every $FSB chunk on \"mark\" rather than refusing them", async (t) => {
  const response = await invoke(t, "ingest_plan", [tickFrame(), ...markFrames([new Uint8Array(64), new Uint8Array(64)], 40)]);
  assert.notEqual(response.errorCode, "batched-input-frames");
});

// ---------------------------------------------------------------------------------------------------------------------
// SOURCE LOCK: no port-blind frame-0 reads. `plugin_get_input_frame(0)` takes the invocation's FIRST frame regardless of
// which port it arrived on. Port-filtered access (`plugin_find_input_index(port, ordinal)`) is the only admissible form.
// Asserted against the source because the harness cannot express the failure: it validates portIds against the manifest
// before the invoke, so an off-port frame never reaches the guest here. It does in a baked flow.
test("data-source/geonames-ingest source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/geonames_ingest_module.cpp", import.meta.url)), "utf8");
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
