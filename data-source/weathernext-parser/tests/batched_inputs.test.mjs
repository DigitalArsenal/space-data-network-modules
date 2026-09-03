// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames` (class defect, filed
// from the live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// The compiled flow runtime fills an invocation PORT-BLIND up to a budget of
// 64 while maxStreams/maxBatch/drainPolicy stay declarative, so a guest that
// reads ordinal 0 of a port and returns destroys every other frame it was
// handed there. parse_cyclone_tracks pairs ONE job with ONE response, so a
// surplus is refused by name. parse_cloud_chunks is multi-stream by contract
// and pairs jobs with responses by position instead (covered in sdk_compat).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();

function bytesInput(portId, text) {
  const payload = encoder.encode(text);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
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

for (const [port, other] of [["job", "response"], ["response", "job"]]) {
  test(`parse_cyclone_tracks refuses two frames on the single-stream "${port}" port`, async (t) => {
    const response = await invoke(t, "parse_cyclone_tracks", [
      bytesInput(other, '{"n":0}'),
      bytesInput(port, '{"which":"first"}'),
      bytesInput(port, '{"which":"second"}'),
    ]);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(response.errorMessage, new RegExp(`2 frames on single-stream input port "${port}"`));
    assert.equal(response.outputs.length, 0);
  });
}

test("parse_cyclone_tracks does not refuse one frame per port", async (t) => {
  const response = await invoke(t, "parse_cyclone_tracks", [bytesInput("job", "{}"), bytesInput("response", "{}")]);
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
