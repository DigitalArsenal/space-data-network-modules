// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow
// runtime's `space_data_module_runtime_begin_node_invocation` pops a node's
// WHOLE queue port-blind (budget 64) while `maxStreams`/`maxBatch`/
// `drainPolicy` stay purely declarative, so a guest reading ordinal 0 of a
// port destroys the rest with nothing logged.
//
// This node is the reason the invariant matters beyond simple fan-out:
// data-retrieval (live on host-01 at /api/v1/data/) wires TWO edges into
// `branch`'s `stream` port — `omm.stream` from data-source/retrieval::omm_bulk
// and `query.rows` from ::data_query — and relies on `dispatch` having routed
// to exactly one of them. It does. But "the producer upstream is exclusive" is
// a property of OTHER modules' code, not something this node can verify, and
// pairing a decision with the wrong branch's stream is a wrong answer no
// consumer downstream can detect.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();

function bytesInput(portId, bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function ommInput(portId, bytes) {
  return {
    portId,
    typeRef: {
      schemaName: "OMM.fbs",
      fileIdentifier: "$OMM",
      rootTypeName: "OMM",
      wireFormat: "aligned-binary",
      requiredAlignment: 8,
      byteLength: bytes.byteLength,
    },
    payload: bytes,
  };
}

function buildCannedStream(seed) {
  const frames = [Uint8Array.from({ length: 24 }, (_, i) => (i * seed + 1) & 0xff)];
  const total = frames.reduce((sum, frame) => sum + 4 + frame.length, 0);
  const stream = new Uint8Array(total);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    stream.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return stream;
}

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

const OMM_DECISION = JSON.stringify({ route: "omm_bulk", format: "flatbuffer", query: {} });
const QUERY_DECISION = JSON.stringify({ route: "data_query", format: "json", query: { sql: "SELECT 1" } });

test("dispatch refuses two frames on the single-stream \"decision\" port", async (t) => {
  const response = await invoke(t, "dispatch", [
    bytesInput("decision", OMM_DECISION),
    bytesInput("decision", QUERY_DECISION),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "decision"/);
  assert.equal(response.outputs.length, 0, "dispatching one decision and dropping another is the defect");
});

test("branch refuses two frames on the single-stream \"stream\" port (the two-edge port in data-retrieval)", async (t) => {
  const response = await invoke(t, "branch", [
    bytesInput("decision", OMM_DECISION),
    ommInput("stream", buildCannedStream(7)),
    ommInput("stream", buildCannedStream(13)),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "stream"/);
  assert.equal(response.outputs.length, 0, "a decision must never be paired with an arbitrarily chosen stream");
});

test("branch is unchanged at one frame per port", async (t) => {
  const stream = buildCannedStream(7);
  const response = await invoke(t, "branch", [
    bytesInput("decision", OMM_DECISION),
    ommInput("stream", stream),
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const ports = response.outputs.map((frame) => frame.portId).sort();
  assert.deepEqual(ports, ["decision", "etag", "flatbuffer"]);
  const passthrough = response.outputs.find((frame) => frame.portId === "flatbuffer");
  assert.deepEqual(new Uint8Array(passthrough.payload), stream, "stream must pass through verbatim");
});

// ---------------------------------------------------------------------------
// SOURCE LOCK: no port-blind frame-0 reads.
//
// `plugin_get_input_frame(0)` takes the invocation's FIRST frame regardless of
// which port it arrived on, and frame 0 is NOT promised to be on any particular
// port — the compiled runtime hands a node whatever is queued on it, in queue
// order. hostcap/flatsql-query::query executed SQL from such a read and
// ::sandbox_query fell back to one when it could not find its `decision` port:
// not a dropped frame, a CONFUSED one, which is worse. Port-filtered access
// (`plugin_find_input_index(port, ordinal)`) is the only admissible form.
//
// This is asserted against the source because the harness cannot express the
// failure: it validates portIds against the manifest before the invoke, so an
// off-port frame never reaches the guest here. It does in a baked flow.
test("foundation/decision-gate source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/decision_gate_module.cpp", import.meta.url)), "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    // Comment lines are excluded: several of these modules DOCUMENT the defect
    // by quoting the offending call, and a lock that cannot tell an
    // explanation from a call would push the explanation out of the source.
    .filter(([, line]) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return code.includes("plugin_get_input_frame(0)");
    });
  assert.deepEqual(
    offenders,
    [],
    `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`,
  );
});
