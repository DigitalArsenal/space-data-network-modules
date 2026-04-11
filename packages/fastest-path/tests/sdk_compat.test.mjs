import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  CSRGraphT,
  GraphDefinitionT,
  PathRequestT,
  PathResult,
  ShortestPathAlgorithmHint,
  ShortestPathRequestT,
  ShortestPathResult,
  WeightedEdgeListT,
  WeightedEdgeT,
} from "../../../../plugin-sdk/src/generated/orbpro/analysis.js";
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

function finishWithIdentifier(builder, offset, identifier) {
  builder.finish(offset, identifier);
  return builder.asUint8Array();
}

function encodeGraphDefinition(vertexCount) {
  const builder = new flatbuffers.Builder(64);
  return finishWithIdentifier(
    builder,
    new GraphDefinitionT(vertexCount).pack(builder),
    "FGDF",
  );
}

function encodeWeightedEdgeList({
  vertexCount = 0,
  buildGraph = true,
  edges = [],
} = {}) {
  const builder = new flatbuffers.Builder(256);
  return finishWithIdentifier(
    builder,
    new WeightedEdgeListT(
      vertexCount,
      edges.map((edge) => new WeightedEdgeT(edge.src, edge.dst, edge.weight)),
      buildGraph,
    ).pack(builder),
    "FELT",
  );
}

function encodeCSRGraph({
  vertexCount,
  offsets,
  destinations,
  weights,
}) {
  const builder = new flatbuffers.Builder(256);
  return finishWithIdentifier(
    builder,
    new CSRGraphT(vertexCount, offsets, destinations, weights).pack(builder),
    "FCSR",
  );
}

function encodeShortestPathRequest({
  source = 0,
  algorithmHint = ShortestPathAlgorithmHint.AUTO,
} = {}) {
  const builder = new flatbuffers.Builder(64);
  return finishWithIdentifier(
    builder,
    new ShortestPathRequestT(source, algorithmHint).pack(builder),
    "FSPR",
  );
}

function encodePathRequest(target) {
  const builder = new flatbuffers.Builder(64);
  return finishWithIdentifier(
    builder,
    new PathRequestT(target).pack(builder),
    "FPTR",
  );
}

function decodeShortestPathResult(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.equal(bb.__has_identifier("FSPS"), true);
  return ShortestPathResult.getRootAsShortestPathResult(bb).unpack();
}

function decodePathResult(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.equal(bb.__has_identifier("FPTH"), true);
  return PathResult.getRootAsPathResult(bb).unpack();
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

test("browser harness preserves the canonical stream-invoke solver contract", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const createGraphResult = await harness.invoke({
    methodId: "create_graph",
    inputs: [
      {
        portId: "graph",
        payload: encodeGraphDefinition(4),
      },
    ],
  });
  assert.equal(createGraphResult.statusCode, 0);
  assert.equal(createGraphResult.outputs.length, 0);

  const ingestEdgesResult = await harness.invoke({
    methodId: "ingest_edges",
    inputs: [
      {
        portId: "edges",
        payload: encodeWeightedEdgeList({
          vertexCount: 4,
          edges: [
            { src: 0, dst: 1, weight: 1.0 },
            { src: 1, dst: 2, weight: 2.0 },
            { src: 0, dst: 2, weight: 5.0 },
            { src: 2, dst: 3, weight: 1.0 },
          ],
        }),
      },
    ],
  });
  assert.equal(ingestEdgesResult.statusCode, 0);
  assert.equal(ingestEdgesResult.outputs.length, 0);

  const solveResult = await harness.invoke({
    methodId: "compute_shortest_paths",
    inputs: [
      {
        portId: "request",
        payload: encodeShortestPathRequest({
          source: 0,
          algorithmHint: ShortestPathAlgorithmHint.DIJKSTRA,
        }),
      },
    ],
    outputStreamCap: 1,
  });
  assert.equal(solveResult.statusCode, 0);
  assert.equal(solveResult.outputs.length, 1);
  assert.equal(solveResult.outputs[0].portId, "results");
  const solvePayload = decodeShortestPathResult(solveResult.outputs[0].payload);
  assert.equal(solvePayload.source, 0);
  assert.equal(solvePayload.vertexCount, 4);
  assert.equal(solvePayload.reachableCount, 4);
  assert.deepEqual(solvePayload.distances, [0, 1, 3, 4]);
  assert.deepEqual(solvePayload.predecessors, [0xffffffff, 0, 1, 2]);

  const pathResult = await harness.invoke({
    methodId: "reconstruct_path",
    inputs: [
      {
        portId: "request",
        payload: encodePathRequest(3),
      },
    ],
    outputStreamCap: 1,
  });
  assert.equal(pathResult.statusCode, 0);
  assert.equal(pathResult.outputs.length, 1);
  assert.equal(pathResult.outputs[0].portId, "path");
  const pathPayload = decodePathResult(pathResult.outputs[0].payload);
  assert.equal(pathPayload.reachable, true);
  assert.equal(pathPayload.distance, 4);
  assert.deepEqual(pathPayload.path, [0, 1, 2, 3]);
});

test("browser harness accepts canonical CSR ingestion requests", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => {
    harness.destroy();
  });

  const ingestCsrResult = await harness.invoke({
    methodId: "ingest_csr",
    inputs: [
      {
        portId: "csr",
        payload: encodeCSRGraph({
          vertexCount: 4,
          offsets: [0, 2, 3, 4, 4],
          destinations: [1, 2, 2, 3],
          weights: [1, 5, 2, 1],
        }),
      },
    ],
  });
  assert.equal(ingestCsrResult.statusCode, 0);
  assert.equal(ingestCsrResult.outputs.length, 0);

  const solveResult = await harness.invoke({
    methodId: "compute_shortest_paths",
    inputs: [
      {
        portId: "request",
        payload: encodeShortestPathRequest({ source: 0 }),
      },
    ],
    outputStreamCap: 1,
  });
  assert.equal(solveResult.statusCode, 0);
  assert.equal(solveResult.outputs.length, 1);
  const solvePayload = decodeShortestPathResult(solveResult.outputs[0].payload);
  assert.deepEqual(solvePayload.distances, [0, 1, 3, 4]);
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
