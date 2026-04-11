import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import * as fastestPathPackage from "../index.js";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);

const EXPECTED_METHOD_IDS = [
  "create_graph",
  "ingest_edges",
  "ingest_csr",
  "compute_shortest_paths",
  "reconstruct_path",
];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("package manifest advertises the canonical Fastest Path stream surface", () => {
  const manifest = readManifest();

  assert.equal(manifest.pluginId, "com.orbpro.fastest-path");
  assert.equal(manifest.name, "Fastest Path (SSSP)");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(manifest.invokeSurfaces, ["direct", "command"]);
  assert.deepEqual(
    manifest.runtimeTargets,
    ["browser", "wasi", "wasmedge"],
  );
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

test("package entrypoint keeps the OrbPro bridge solver export", () => {
  assert.equal(typeof fastestPathPackage.createFastestPathSolver, "function");
  assert.equal(typeof fastestPathPackage.default, "function");
  assert.equal(
    fastestPathPackage.default.createFastestPathSolver,
    fastestPathPackage.createFastestPathSolver,
  );
  assert.equal(
    fastestPathPackage.default.browserModulePath.href,
    BROWSER_MODULE_PATH.href,
  );
  assert.equal(
    fastestPathPackage.default.isomorphicWasmPath.href,
    ISOMORPHIC_WASM_PATH.href,
  );
});

test("package entrypoint can instantiate the shipped solver wrapper", async (t) => {
  const solver = await fastestPathPackage.createFastestPathSolver();
  t.after(() => {
    solver.destroy();
  });

  assert.equal(solver.manifest.pluginId, "com.orbpro.fastest-path");
  assert.equal(solver.manifestSource, "embedded-flatbuffer");
  assert.equal(typeof solver.streamInvoke, "function");
  assert.equal(solver.createGraph(1), 0);
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
  assert.equal(decoded.pluginId, "com.orbpro.fastest-path");
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
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(exportName), exportName);
  }
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

test("built artifact loads through the WasmEdge server path", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }

  t.after(async () => {
    await harness.destroy();
  });

  assert.equal(harness.runtime.kind, "wasmedge");
  assert.equal(harness.runtime.profile, "standalone");
  assert.equal(harness.runtime.surface, "command");
});
