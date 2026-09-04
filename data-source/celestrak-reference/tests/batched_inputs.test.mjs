// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames`: the compiled flow
// runtime pops a node's queue port-blind (budget 64) while maxStreams is
// declarative only, so a guest that reads ordinal 0 of a single-stream port
// and returns destroys every other frame it was handed there. The
// single-stream ports of data-source/celestrak-reference refuse a surplus by
// name; parse_gp_groups' "response" port is multi-stream BY CONTRACT and is
// read in full, so it is exempt.

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
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return {};
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

const CASES = [
  ["gp_groups", "tick", []],
  ["satcat_reference", "tick", []],
  ["parse_gp_groups", "job", ["response"]],
  ["parse_satcat_reference", "response", ["job"]],
  ["parse_satcat_reference", "job", ["response"]],
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
    assert.equal(response.outputs.length, 0);
  });

  test(`${methodId} does not refuse one frame per port`, async (t) => {
    const inputs = others.map((other, i) => bytesInput(other, `{"n":${i}}`));
    inputs.push(bytesInput(port, "{}"));
    const response = await invoke(t, methodId, inputs);
    assert.notEqual(response.errorCode, "batched-input-frames");
  });
}

test("parse_gp_groups accepts several frames on its multi-stream response port", async (t) => {
  const response = await invoke(t, "parse_gp_groups", [
    bytesInput("job", '{"source_name":"x","groups":[{"token":"a","url":"u"},{"token":"b","url":"v"}]}'),
    bytesInput("response", '{"status":304,"headers":{},"bodyB64":""}'),
    bytesInput("response", '{"status":304,"headers":{},"bodyB64":""}'),
  ]);
  assert.notEqual(response.errorCode, "batched-input-frames");
  assert.equal(response.statusCode, 0, response.errorMessage);
});

// SOURCE LOCK: no port-blind frame-0 reads (see celestrak-parser for why).
test("data-source/celestrak-reference source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/celestrak_reference_module.cpp", import.meta.url)),
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
  assert.deepEqual(offenders, [], `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`);
});
