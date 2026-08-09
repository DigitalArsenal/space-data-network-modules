// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow
// runtime's `space_data_module_runtime_begin_node_invocation` pops a node's
// WHOLE queue port-blind (budget 64) while `maxStreams`/`maxBatch`/
// `drainPolicy` stay purely declarative, so a guest that reads ordinal 0 of a
// port and returns destroys the rest with nothing logged.
//
// `encode` turns ONE record stream into ONE JSON document, and its `json`
// output feeds a single-stream consumer (foundation/http-respond's `body`), so
// there is no N-in/N-out reading available to it: a second stream frame has
// nowhere to go, and answering from the first while dropping the second would
// serve a truncated catalog that looks exactly like an honest one.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

// The `stream` port is typed to $OMM. The SDK invoke codec requires BOTH
// requiredAlignment and byteLength on an aligned typeRef.
function streamInput(bytes) {
  return {
    portId: "stream",
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

async function invoke(t, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "encode", inputs });
}

// One zero-length size prefix: the "no records" wire shape.
const EMPTY_STREAM = new Uint8Array(4);

test('encode refuses two frames on the single-stream "stream" port', async (t) => {
  const response = await invoke(t, [streamInput(EMPTY_STREAM), streamInput(EMPTY_STREAM)]);
  assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "stream"/);
  assert.equal(response.outputs.length, 0, "a truncated catalog must never be emitted as a whole one");
});

test("encode is unchanged at one stream frame", async (t) => {
  const response = await invoke(t, [streamInput(EMPTY_STREAM)]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "json");
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
test("foundation/omm-json source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/omm_json_module.cpp", import.meta.url)), "utf8");
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
