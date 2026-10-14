// data-source/oem-source-iss end to end on the typed contracts (1.0): the compiled wasm runs in the SDK browser
// harness, a TimerTick (TICK) in, one $OEM FlatBuffer out per method. The $OEM bytes must equal the ones the legacy
// artifact (untyped tick, aligned-binary label) emitted for the same fixture, kept in tests/fixtures/legacy-oem-*.bin.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = new Uint8Array(fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const legacy = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/legacy-oem-${name}.bin`, import.meta.url)));

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}
const tick = () => ({
  portId: "tick",
  typeRef: TICK,
  payload: encodeTimerTick({ triggerId: "iss-oem", scheduledMs: 1760400000000n, firedMs: 1760400000123n, sequence: 0n }),
});

for (const [methodId, name] of [["emit", "verbose"], ["emit_compact", "compact"]]) {
  test(`${methodId}: a TimerTick emits one $OEM FlatBuffer, byte-identical to the legacy artifact's`, async (t) => {
    const harness = await harnessFor(t);
    const response = await harness.invoke({ methodId, inputs: [tick()] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [out] = response.outputs;
    assert.equal(out.portId, "oem");
    assert.equal(out.typeRef.fileIdentifier, "$OEM");
    assert.equal(out.typeRef.wireFormat, "flatbuffer");
    assert.equal(new TextDecoder().decode(out.payload.subarray(4, 8)), "$OEM");
    assert.deepEqual(new Uint8Array(out.payload), legacy(name));
  });
}

test("the manifest names one concrete FlatBuffer type on every port", () => {
  for (const method of MANIFEST.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      const types = port.acceptedTypeSets.flatMap((s) => s.allowedTypes);
      assert.equal(types.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(types[0].wireFormat, "flatbuffer");
      assert.ok(!types[0].acceptsAnyFlatbuffer);
    }
  }
});
