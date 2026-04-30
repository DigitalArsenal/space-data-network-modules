import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const README_PATH = new URL("../README.md", import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8"));
}

test("runtime manifest uses canonical SDN module contract", () => {
  const manifest = readJson(MANIFEST_PATH);
  assert.equal(manifest.pluginId, "com.digitalarsenal.basilisk.runtime");
  assert.equal(manifest.pluginFamily, "basilisk");
  assert.deepEqual(manifest.invokeSurfaces, ["command"]);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasi", "wasmedge"]);

  const method = manifest.methods.find((entry) => entry.methodId === "echo_xtc_dictionary");
  assert.ok(method, "missing echo_xtc_dictionary method");
  assert.equal(method.inputPorts[0].portId, "dictionary");
  assert.equal(method.outputPorts[0].portId, "dictionary");

  const inputType = method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0];
  const outputType = method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0];
  assert.equal(inputType.schemaName, "XTC.fbs");
  assert.equal(inputType.fileIdentifier, "$XTC");
  assert.equal(outputType.schemaName, "XTC.fbs");
  assert.equal(outputType.fileIdentifier, "$XTC");
});

test("runtime package documents authoritative test source and limits", () => {
  const readme = fs.readFileSync(fileURLToPath(README_PATH), "utf8");
  assert.match(readme, /Authoritative test source/i);
  assert.match(readme, /Basilisk WASM test runner/i);
  assert.match(readme, /1810\/1810/i);
  assert.match(readme, /not complete/i);
});
