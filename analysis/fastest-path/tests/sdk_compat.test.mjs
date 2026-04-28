import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import {
  decodePlgManifest,
  isPlgManifestBuffer,
} from "space-data-module-sdk/manifest";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import * as fastestPathPackage from "../index.js";

const BUILD_SCRIPT_PATH = new URL("../build.sh", import.meta.url);
const CMAKE_LISTS_PATH = new URL("../src/cpp/CMakeLists.txt", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
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

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

test("package.json exposes SDK-style canonical exports", () => {
  const pkg = readPackageJson();

  assert.equal(pkg.name, "@orbpro/plugin-fastest-path");
  assert.equal(pkg.main, "index.js");
  assert.deepEqual(pkg.exports, {
    ".": "./index.js",
    "./dist/*": "./dist/*",
  });
  assert.ok(pkg.files.includes("dist/"));
  assert.ok(pkg.files.includes("index.js"));
});

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

test("build is source-driven within the package instead of republishing orbpro-runtime artifacts", () => {
  const buildScript = fs.readFileSync(BUILD_SCRIPT_PATH, "utf8");

  assert.equal(fs.existsSync(fileURLToPath(CMAKE_LISTS_PATH)), true);
  assert.match(buildScript, /emcmake cmake -S "\$SRC_DIR" -B "\$BUILD_DIR"/);
  assert.doesNotMatch(buildScript, /orbpro-runtime/);
  assert.doesNotMatch(buildScript, /taggedPluginArtifacts\.generated\.js/);
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

test("package entrypoint solves shortest paths through the bundled browser harness", async (t) => {
  const solver = await fastestPathPackage.createFastestPathSolver();
  t.after(() => {
    solver.destroy();
  });

  assert.equal(solver.manifest.pluginId, "com.orbpro.fastest-path");
  assert.equal(solver.manifestSource, "embedded-flatbuffer");
  assert.equal(typeof solver.streamInvoke, "function");

  assert.equal(solver.createGraph(4), 0);
  assert.equal(
    solver.addEdges([
      { src: 0, dst: 1, weight: 1.0 },
      { src: 1, dst: 2, weight: 2.0 },
      { src: 0, dst: 2, weight: 5.0 },
      { src: 2, dst: 3, weight: 1.0 },
    ]),
    4,
  );
  assert.equal(solver.buildGraph(), 0);
  assert.equal(solver.computeSSSP(0), 0);

  assert.deepEqual(Array.from(solver.getDistances()), [0, 1, 3, 4]);
  assert.deepEqual(Array.from(solver.getPredecessors()), [0xffffffff, 0, 1, 2]);
  assert.deepEqual(solver.getPath(3), [0, 1, 2, 3]);
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
  assert.equal(isPlgManifestBuffer(embeddedManifest), true);

  const decoded = decodePlgManifest(embeddedManifest);
  assert.equal(decoded.pluginId, "com.orbpro.fastest-path");
  assert.deepEqual(
    decoded.entryFunctions.map((entry) => entry.name),
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
