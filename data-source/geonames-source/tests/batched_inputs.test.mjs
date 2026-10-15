// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// `space_data_module_runtime_begin_node_invocation` fills an invocation by
// popping the node's queue PORT-BLIND, budget 64, while `maxStreams`, `maxBatch`
// and `drainPolicy` are purely DECLARATIVE in the compiled runtime. A guest that
// reads ordinal 0 of a port and returns therefore destroys every other frame it
// was handed, with nothing re-delivering them and nothing logging the loss.
//
// Every input port of data-source/geonames-source is single-stream BY CONTRACT,
// so a surplus is refused by name. The refusal runs before any port parsing or
// hostcall, which is why these cases need no host stub. Every frame is a typed
// HttpResponse (HRSP), as hostcap/http-request and inflate emit them.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();

function bytesInput(portId, text) {
  return {
    portId,
    typeRef: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
    payload: encodeHttpResponse({ status: 200, body: encoder.encode(text) }),
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

// [methodId, the port that is doubled, the other ports one frame each]
const CASES = [
  ["inflate", "response", []],
  ["parse_places", "text", ["admin1"]],
  ["parse_places", "admin1", ["text"]],
  ["parse_places", "country", ["text", "admin2"]],
  ["parse_deletes", "text", []],
];

for (const [methodId, port, others] of CASES) {
  test(`${methodId} refuses two frames on the single-stream "${port}" port`, async (t) => {
    const inputs = others.map((other, i) => bytesInput(other, `{"n":${i}}`));
    inputs.push(bytesInput(port, '{"which":"first"}'));
    inputs.push(bytesInput(port, '{"which":"second"}'));

    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(
      response.errorMessage,
      new RegExp(`2 frames on single-stream input port "${port}"`),
      response.errorMessage,
    );
    assert.equal(
      response.outputs.length,
      0,
      "answering from one frame while destroying the other is the defect this guards",
    );
  });

  test(`${methodId} does not refuse one frame per port`, async (t) => {
    // The guard must be inert on the shape every deployed flow delivers. This
    // asserts only that the refusal did NOT fire — the method may still fail for
    // its own reasons (unparseable payload, incomplete contract), which is a
    // different error code and not this invariant's business.
    const inputs = others.map((other, i) => bytesInput(other, `{"n":${i}}`));
    inputs.push(bytesInput(port, "{}"));
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.errorCode, "batched-input-frames");
  });
}

// ---------------------------------------------------------------------------
// SOURCE LOCK: no port-blind frame-0 reads.
//
// `plugin_get_input_frame(0)` takes the invocation's FIRST frame regardless of
// which port it arrived on, and frame 0 is NOT promised to be on any particular
// port. Port-filtered access (`plugin_find_input_index(port, ordinal)`) is the
// only admissible form. Asserted against the source because the harness cannot
// express the failure: it validates portIds against the manifest before the
// invoke, so an off-port frame never reaches the guest here. It does in a baked
// flow.
test("data-source/geonames-source source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/geonames_source_module.cpp", import.meta.url)),
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
  assert.deepEqual(
    offenders,
    [],
    `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`,
  );
});
