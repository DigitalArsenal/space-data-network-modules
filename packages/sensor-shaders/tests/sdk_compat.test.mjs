import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import * as sensorShadersPackage from "../index.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);

const EXPECTED_METHOD_IDS = ["load_shader_bundle", "get_shader_bundle"];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("package manifest advertises the canonical sensor shader stream surface", () => {
  const manifest = readManifest();

  assert.equal(manifest.pluginId, "com.orbpro.sensor-shaders");
  assert.equal(manifest.name, "OrbPro Sensor Shaders");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.deepEqual(
    manifest.methods.map((method) => method.methodId),
    EXPECTED_METHOD_IDS,
  );
});

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("package entrypoint exports the OrbPro-compatible loader and canonical paths", () => {
  assert.equal(typeof sensorShadersPackage.loadSensorShaders, "function");
  assert.equal(typeof sensorShadersPackage.getSensorShadersManifest, "function");
  assert.equal(sensorShadersPackage.default.loadSensorShaders, sensorShadersPackage.loadSensorShaders);
  assert.equal(sensorShadersPackage.default.pluginManifestPath.href, MANIFEST_PATH.href);
  assert.equal(sensorShadersPackage.default.browserModulePath.href, BROWSER_MODULE_PATH.href);
  assert.equal(sensorShadersPackage.default.isomorphicWasmPath.href, ISOMORPHIC_WASM_PATH.href);
});

test("package entrypoint can instantiate the shipped shader bundle wrapper", async (t) => {
  const shaderSources = {
    SensorVolumeVS: "void main(){gl_Position=vec4(0.0);}",
    SensorVolumeFS: "void main(){gl_FragColor=vec4(1.0);}",
  };

  const bundle = await sensorShadersPackage.loadSensorShaders({
    shaderSources,
    requireEmbeddedManifest: true,
  });
  t.after(() => {
    bundle.destroy();
  });

  assert.equal(bundle.type, "Shader");
  assert.equal(bundle.manifest.pluginId, "com.orbpro.sensor-shaders");
  assert.equal(bundle.manifestSource, "embedded-flatbuffer");
  assert.equal(bundle.supportsStreamInvoke, true);
  assert.deepEqual(bundle.shaderNames.sort(), Object.keys(shaderSources).sort());
  assert.deepEqual(bundle.shaders, shaderSources);

  const response = bundle.streamInvoke({
    methodId: "get_shader_bundle",
    inputs: [
      {
        portId: "request",
        payload: new Uint8Array(),
      },
    ],
    outputStreamCap: 1,
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "bundle");
  assert.ok(response.outputs[0].bytes instanceof Uint8Array);
  assert.ok(response.outputs[0].bytes.length > 0);
});

test("embedded manifest round-trips through the SDK codec", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const embeddedManifest = harness.readManifest();
  assert.ok(embeddedManifest?.length > 0);

  const decoded = decodePluginManifest(embeddedManifest);
  assert.equal(decoded.pluginId, "com.orbpro.sensor-shaders");
  assert.deepEqual(
    decoded.methods.map((method) => method.methodId),
    EXPECTED_METHOD_IDS,
  );
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = readManifest();
  const report = await validatePluginArtifact({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(
    Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(),
    ["wasi_snapshot_preview1"],
  );
  for (const exportName of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "sensor_shaders_set_bundle_json",
  ]) {
    assert.ok(inspection.exports.includes(exportName), exportName);
  }
  assert.equal(inspection.exports.includes("_start"), false);
});

test("built artifact loads through the SDK browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  assert.equal(harness.runtime.kind, "browser");
  assert.equal(harness.runtime.profile, "standalone");
  assert.equal(harness.runtime.surface, "direct");
  assert.equal(typeof harness.instance.exports.plugin_invoke_stream, "function");
});
