// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames` (class defect, filed
// from the live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK
// src/flow/runtime-src/flow_runtime.cpp) fills an invocation by popping the
// node's queue `while (count < budget && !queue.empty())` — PORT-BLIND, budget
// 64 — while `maxStreams` / `maxBatch` / `drainPolicy` are purely DECLARATIVE
// in the compiled runtime (enforced at compose time and in the JS-only
// reference runtime, never in the baked runtime.wasm). A guest that reads
// ordinal 0 of a port and returns therefore destroys every other frame it was
// handed on that port, with nothing logged anywhere.
//
// This test asserts the artifact REFUSES that instead of answering from a
// frame it picked out of queue order. Before the fix, the exact inputs below
// produced a clean `statusCode 0` HTTP 200 carrying the FIRST decision and the
// FIRST body, with the second decision (503) and second body silently gone —
// measured against the artifact live on host-01, not hypothesised.
//
// The invariant is per-PORT: two frames on `body` is as inadmissible as two on
// `decision`, and a surplus on a port this method never reads is still a lost
// frame, so the scan covers every port the runtime handed over rather than
// only the ones `respond` looks at.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeHttpResponse } from "space-data-module-sdk/http";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesInput(portId, bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

async function invokeRespond(t, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "respond", inputs });
}

const OK_DECISION = JSON.stringify({ route: "omm_bulk", format: "json", status: 200 });
const ERR_DECISION = JSON.stringify({ route: "error", format: "json", status: 503, error: "down" });

test("respond refuses two frames on the single-stream \"decision\" port", async (t) => {
  const response = await invokeRespond(t, [
    bytesInput("decision", OK_DECISION),
    bytesInput("decision", ERR_DECISION),
  ]);
  assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "decision"/);
  assert.equal(response.outputs.length, 0, "no $HTR envelope may be emitted from a refused batch");
});

test("respond refuses two frames on the single-stream \"body\" port", async (t) => {
  const response = await invokeRespond(t, [
    bytesInput("decision", OK_DECISION),
    bytesInput("body", "[1,2]"),
    bytesInput("body", "[3]"),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "body"/);
  assert.equal(response.outputs.length, 0);
});

test("respond refuses a surplus frame even when both frames are identical", async (t) => {
  // The guard is STRUCTURAL, not value-based. Two identical `etag` frames
  // would have produced the same response either way — and that is exactly why
  // the refusal must not depend on it: "the answer happened to come out the
  // same" is not a property a node can check, and the whole class defect is
  // that a wrong answer and a right one are indistinguishable at the output.
  // The scan therefore covers every port the runtime handed over, in whatever
  // order, rather than only the ones whose value changed the answer.
  const response = await invokeRespond(t, [
    bytesInput("decision", OK_DECISION),
    bytesInput("body", "[1]"),
    bytesInput("etag", 'W/"same"'),
    bytesInput("etag", 'W/"same"'),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /"etag"/);
});

test("respond is unchanged at one frame per port (the shape every deployed flow delivers)", async (t) => {
  const response = await invokeRespond(t, [
    bytesInput("decision", OK_DECISION),
    bytesInput("body", "[1,2]"),
    bytesInput("etag", 'W/"x"'),
  ]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 200);
  assert.equal(decoder.decode(new Uint8Array(http.body)), "[1,2]");
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
test("foundation/http-respond source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/http_respond_module.cpp", import.meta.url)), "utf8");
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
