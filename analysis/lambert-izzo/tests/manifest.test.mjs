import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifestPath = new URL("../plugin-manifest.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

test("Lambert package declares the planned SDK solve surface", () => {
  const manifest = readJson(manifestPath);
  const method = manifest.methods.find((entry) => entry.methodId === "solve_lambert");

  assert.equal(manifest.pluginId, "com.orbpro.lambert-izzo");
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.ok(method);
  assert.equal(method.inputPorts[0].portId, "request");
  assert.equal(
    method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "LMSR",
  );
  assert.equal(method.outputPorts[0].portId, "solutions");
  assert.equal(
    method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
    "LMSO",
  );
});

test("Lambert package pins upstream source and avoids nested submodules", () => {
  const pkg = readJson(packagePath);
  const readme = fs.readFileSync(readmePath, "utf8");

  assert.equal(pkg.dependencies.lambert_izzo, "2.0.0");
  assert.match(readme, /65b561b745a0f1afe6a2d73f46f70a3a382e67aa/);
  assert.match(readme, /Do not add a nested upstream submodule/);
  assert.match(readme, /must add canonical SDS records first/);
});
