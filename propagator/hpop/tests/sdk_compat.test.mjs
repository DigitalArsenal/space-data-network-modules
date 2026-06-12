import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePluginArtifact } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";
import {
  createBrowserModuleHarness,
  generateManifestHarnessPlan,
  materializeHarnessScenario,
} from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const REQUEST_FIXTURE_PATH = new URL(
  "../tests/fixtures/request.propagate.json",
  import.meta.url,
);
const FLOW_EXAMPLE_PATH = new URL(
  "../tests/fixtures/hosted-runtime/hpop.single-plugin.flow.json",
  import.meta.url,
);

function readFixtureBytes() {
  return fs.readFileSync(REQUEST_FIXTURE_PATH);
}

function createHarnessScenario(surface) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const plan = generateManifestHarnessPlan({
    manifest,
    payloadForPort({ portId }) {
      if (portId !== "request") {
        return null;
      }
      return readFixtureBytes();
    },
  });
  const scenario = plan.generatedCases.find((entry) => entry.surface === surface);
  assert.ok(scenario, `missing ${surface} harness scenario`);
  return materializeHarnessScenario(scenario);
}

function createInvokeRequest() {
  const scenario = createHarnessScenario("command");
  return {
    methodId: scenario.methodId,
    inputs: scenario.inputs,
  };
}

function instantiateStandaloneModule(wasmBytes) {
  const wasi = {
    proc_exit() {},
    fd_read() {
      return 52;
    },
    fd_seek() {
      return 70;
    },
    fd_write() {
      return 0;
    },
    fd_close() {
      return 52;
    },
    args_get() {
      return 0;
    },
    args_sizes_get() {
      return 0;
    },
  };
  return new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {
    env: wasi,
    wasi_snapshot_preview1: wasi,
  });
}

async function instantiateBrowserModuleAsBrowser({
  // Browser consumers (e.g. OrbPro PluginLoader via resolveProtectedWasmBytes)
  // strip the appended publication record collection (signature/PNM/REC
  // trailers) before handing wasmBinary to the Emscripten factory; mirror
  // that contract here since dist artifacts ship signed.
  wasmBytes = stripPublicationRecordCollection(
    fs.readFileSync(fileURLToPath(BROWSER_WASM_PATH)),
  ),
  noInitialRun = true,
} = {}) {
  const savedProcess = globalThis.process;
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;

  try {
    globalThis.window = {};
    globalThis.document = {
      currentScript: {
        src: "https://localhost/plugin-hpop/module.js",
      },
    };
    globalThis.process = undefined;

    const namespace = await import(
      `${BROWSER_MODULE_PATH.href}?browser-shim=${Date.now()}-${Math.random()}`
    );
    return await namespace.default({
      wasmBinary: wasmBytes,
      noInitialRun,
    });
  } finally {
    globalThis.process = savedProcess;
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
}

function assertSuccessfulResponse(response) {
  assert.equal(response.statusCode, 0);
  assert.ok(response.errorCode === "" || response.errorCode === null);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const payload = JSON.parse(new TextDecoder().decode(response.outputs[0].payload));
  assert.ok(
    payload.version || payload.epochJD,
    "response must contain version or propagation result",
  );
}

test("build publishes canonical browser and isomorphic artifact paths", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_MODULE_PATH)), true);
  assert.equal(fs.existsSync(fileURLToPath(BROWSER_WASM_PATH)), true);
});

test("browser module exposes a default factory for worker imports", async () => {
  const namespace = await import(BROWSER_MODULE_PATH.href);

  assert.equal(typeof namespace.default, "function");
});

test("browser module exports an explicit initializer so noInitialRun library loads can safely allocate after plugin_init", async (t) => {
  const module = await instantiateBrowserModuleAsBrowser({
    noInitialRun: true,
  });
  t.after(() => {
    module._plugin_destroy?.();
  });

  assert.equal(typeof module.__initialize, "function");
  module.__initialize();
  assert.equal(module._plugin_init(), 0);

  const firstAllocation = module._malloc(56);
  const secondAllocation = module._malloc(56);
  assert.ok(firstAllocation > 0);
  assert.ok(secondAllocation > 0);
});

test("built artifact passes SDK compliance checks", async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
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
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();

  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  assert.ok(inspection.exports.includes("_start"));
  assert.ok(inspection.exports.includes("plugin_alloc"));
  assert.ok(inspection.exports.includes("plugin_free"));
  assert.ok(inspection.exports.includes("plugin_invoke_stream"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer"));
  assert.ok(inspection.exports.includes("plugin_get_manifest_flatbuffer_size"));
});

test("built artifact embeds a non-empty manifest flatbuffer", () => {
  // dist artifacts ship signed: strip the publication record trailer the
  // way runtime loaders do before compiling raw bytes.
  const wasmBytes = stripPublicationRecordCollection(
    fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
  );
  const instance = instantiateStandaloneModule(wasmBytes);
  const manifestPtr = instance.exports.plugin_get_manifest_flatbuffer();
  const manifestSize = instance.exports.plugin_get_manifest_flatbuffer_size();

  assert.ok(manifestPtr > 0);
  assert.ok(manifestSize > 0);
});

test("built artifact loads through the SDK browser harness", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "command",
  });
  t.after(() => {
    harness.destroy();
  });

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
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

  const response = await harness.invoke(createInvokeRequest());
  assertSuccessfulResponse(response);
});

test("hosted-runtime example is wired to the canonical invoke contract", () => {
  const flow = JSON.parse(fs.readFileSync(FLOW_EXAMPLE_PATH, "utf8"));
  assert.equal(flow.nodes.length, 1);
  assert.equal(flow.nodes[0].pluginId, "hpop-propagator");
  assert.equal(flow.nodes[0].methodId, "invoke");
  assert.equal(flow.triggerBindings[0].targetPortId, "request");
});
