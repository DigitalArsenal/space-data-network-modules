import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function allowedTypesFor(method, direction, portId) {
  const ports = method[direction] ?? [];
  const port = ports.find((entry) => entry.portId === portId);
  assert.ok(port, `missing ${direction} port ${portId}`);
  return port.acceptedTypeSets.flatMap((set) => set.allowedTypes ?? []);
}

function assertTimDualWireTypes(types, description) {
  const flatbuffer = types.find(
    (entry) =>
      entry.schemaName === "TIM.fbs" &&
      entry.fileIdentifier === "$TIM" &&
      !entry.wireFormat,
  );
  const aligned = types.find(
    (entry) =>
      entry.schemaName === "TIM.fbs" &&
      entry.fileIdentifier === "$TIM" &&
      entry.wireFormat === "aligned-binary" &&
      entry.requiredAlignment === 8,
  );
  assert.ok(flatbuffer, `${description} should accept canonical TIM FlatBuffers`);
  assert.ok(aligned, `${description} should accept aligned-binary TIM frames`);
}

test("manifest declares SDK-compliant TIM conversion surface", () => {
  const manifest = readManifest();
  assert.equal(manifest.pluginId, "com.digitalarsenal.foundation.time");
  assert.equal(manifest.pluginFamily, "foundation");
  assert.deepEqual(manifest.invokeSurfaces.sort(), ["command", "direct"]);
  assert.ok(manifest.runtimeTargets.includes("browser"));
  assert.ok(manifest.runtimeTargets.includes("wasmedge"));

  const method = manifest.methods.find((entry) => entry.methodId === "convert_time");
  assert.ok(method, "missing convert_time method");
  assertTimDualWireTypes(allowedTypesFor(method, "inputPorts", "request"), "request port");
  assertTimDualWireTypes(allowedTypesFor(method, "outputPorts", "result"), "result port");

  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "TIM.fbs" && entry.fileIdentifier === "$TIM",
    ),
    "manifest should declare SDS TIM usage",
  );
});
