// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames` (class defect, filed
// from the live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// The compiled flow runtime fills an invocation PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy stay declarative, so a guest that
// reads ordinal 0 of a port and returns destroys every other frame it was
// handed there. parse_cyclone_tracks reads ONE HttpResponse (its job rides
// that response's CONTEXT), so a surplus is refused by name. parse_cloud_chunks
// is multi-stream by contract: every response carries its own job, and all
// the responses of one invocation are one batch (covered in sdk_compat).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };
function responseInput(portId, text) {
  return { portId, typeRef: HRSP, payload: encodeHttpResponse({ status: 200, body: new TextEncoder().encode(text) }) };
}

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    // the refusal runs before any hostcall; a single frame reaches plugin.getConfig, answered as "no config"
    hostcallDispatch: (operation) => { throw new Error(`no ${operation} in this test`); },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

test(`parse_cyclone_tracks refuses two frames on the single-stream "response" port`, async (t) => {
  const response = await invoke(t, "parse_cyclone_tracks", [responseInput("response", "first"), responseInput("response", "second")]);
  assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
  assert.equal(response.errorCode, "batched-input-frames");
  assert.match(response.errorMessage, /2 frames on single-stream input port "response"/);
  assert.equal(response.outputs.length, 0);
});

test("parse_cyclone_tracks does not refuse one frame", async (t) => {
  const response = await invoke(t, "parse_cyclone_tracks", [responseInput("response", "storm_id")]);
  assert.notEqual(response.errorCode, "batched-input-frames");
});

test("data-source/weathernext-parser source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/weathernext_parser_module.cpp", import.meta.url)),
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
