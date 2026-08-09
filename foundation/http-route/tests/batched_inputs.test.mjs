// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow
// runtime's `space_data_module_runtime_begin_node_invocation` pops a node's
// WHOLE queue port-blind (budget 64) while `maxStreams`/`maxBatch`/
// `drainPolicy` stay purely declarative, so a guest that reads ordinal 0 of a
// port and returns destroys the rest with nothing logged. Every method in
// foundation/http-route parses ONE $HTQ envelope into ONE decision; two
// request frames in an invocation cannot be answered, so they are refused by
// name rather than half-answered.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const METHODS = ["route", "discover", "route_public_query", "route_node_status", "route_node_activity"];

function requestInput(path) {
  return {
    portId: "request",
    typeRef: HTTP_REQUEST_TYPE_REF,
    payload: encodeHttpRequest({ method: "GET", path, query: "", headers: [], body: new Uint8Array() }),
  };
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

for (const methodId of METHODS) {
  test(`${methodId} refuses two frames on the single-stream "request" port`, async (t) => {
    const response = await invoke(t, methodId, [
      requestInput("/api/v1/data/omm"),
      requestInput("/api/v1/data/query"),
    ]);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(response.errorMessage, /2 frames on single-stream input port "request"/);
    assert.equal(
      response.outputs.length,
      0,
      "routing one request while destroying another is the failure this guards",
    );
  });

  test(`${methodId} still routes a single request frame`, async (t) => {
    const response = await invoke(t, methodId, [requestInput("/api/v1/data/omm")]);
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    assert.equal(response.outputs[0].portId, "decision");
  });
}

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
test("foundation/http-route source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/http_route_module.cpp", import.meta.url)), "utf8");
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
