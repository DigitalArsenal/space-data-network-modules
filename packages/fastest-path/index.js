import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const pluginManifestPath = new URL("./plugin-manifest.json", import.meta.url);
export const browserModulePath = new URL("./dist/browser/module.js", import.meta.url);
export const browserWasmPath = new URL("./dist/browser/module.wasm", import.meta.url);
export const isomorphicWasmPath = new URL("./dist/isomorphic/module.wasm", import.meta.url);

const EXPECTED_MANIFEST_SOURCE = "embedded-flatbuffer";
const EDGE_RECORD_SIZE = 16;

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function loadLocalWasmBytes() {
  return readFileSync(fileURLToPath(isomorphicWasmPath));
}

async function resolveWasmBytes(options = {}) {
  const directBytes = toUint8Array(options.wasmBinary ?? options.wasmBytes);
  if (directBytes) {
    return directBytes;
  }

  if (typeof options.loadWasmBytes === "function") {
    const loadedBytes = toUint8Array(await options.loadWasmBytes());
    if (loadedBytes) {
      return loadedBytes;
    }
  }

  if (options.wasmUrl !== undefined) {
    const resolvedUrl =
      options.wasmUrl instanceof URL
        ? options.wasmUrl
        : new URL(String(options.wasmUrl), import.meta.url);
    if (resolvedUrl.protocol === "file:") {
      return readFileSync(fileURLToPath(resolvedUrl));
    }
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Fastest Path wasm from ${resolvedUrl.href}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return loadLocalWasmBytes();
}

function getModuleExport(module, exportName) {
  return module?.[exportName] ?? module?.[`_${exportName}`] ?? null;
}

function getTypedMemory(module) {
  return module?.memory?.buffer ?? module?.wasmMemory?.buffer ?? null;
}

function cloneBytes(module, pointer, size) {
  const memoryBuffer = getTypedMemory(module);
  if (!memoryBuffer || pointer === 0 || size === 0) {
    return new Uint8Array();
  }
  return new Uint8Array(memoryBuffer, pointer, size).slice();
}

function packEdges(module, edges) {
  const totalBytes = edges.length * EDGE_RECORD_SIZE;
  const alloc = getModuleExport(module, "plugin_alloc");
  const free = getModuleExport(module, "plugin_free");
  if (typeof alloc !== "function" || typeof free !== "function") {
    throw new Error("Fastest Path wasm is missing plugin_alloc/plugin_free exports.");
  }

  const pointer = alloc(totalBytes);
  if (!pointer) {
    throw new Error("Fastest Path wasm failed to allocate edge packing buffer.");
  }

  const memoryBuffer = getTypedMemory(module);
  const view = new DataView(memoryBuffer, pointer, totalBytes);
  for (let index = 0; index < edges.length; index += 1) {
    const offset = index * EDGE_RECORD_SIZE;
    const edge = edges[index] ?? {};
    view.setUint32(offset, Number(edge.src ?? 0), true);
    view.setUint32(offset + 4, Number(edge.dst ?? 0), true);
    view.setFloat64(offset + 8, Number(edge.weight ?? 0), true);
  }

  return {
    pointer,
    free,
  };
}

function normalizeStreamInputs(inputs = []) {
  return inputs.map((input = {}) => {
    const bytes = toUint8Array(
      input.bytes ?? input.data ?? input.payloadBytes ?? input.payload,
    );
    return bytes ? { ...input, bytes } : input;
  });
}

function createSolverApi(harness, manifest, manifestSource) {
  const module = harness.instance.exports;
  const streamInvoke = typeof harness.invoke === "function" ? harness.invoke.bind(harness) : null;
  const moduleMemory = getTypedMemory(module);

  const api = {
    type: "Analysis",
    name: manifest?.name ?? "Fastest Path (SSSP)",
    version: manifest?.version ?? "1.0.0",
    manifestSource,
    metadata: {
      id: manifest?.pluginId ?? "com.orbpro.fastest-path",
      name: manifest?.name ?? "Fastest Path (SSSP)",
      version: manifest?.version ?? "1.0.0",
      type: "Analysis",
      encrypted: false,
      requiresProtection: false,
    },
    manifest,
    supportsStreamInvoke: typeof module.plugin_invoke_stream === "function",

    streamInvoke(invocation = {}) {
      if (!streamInvoke) {
        throw new Error("Fastest Path harness does not expose invoke().");
      }
      return streamInvoke({
        methodId: invocation.methodId ?? null,
        inputs: normalizeStreamInputs(invocation.inputs ?? []),
        outputStreamCap: invocation.outputStreamCap ?? 0,
      });
    },

    createGraph(numVertices) {
      const fn = getModuleExport(module, "graph_create");
      if (typeof fn !== "function") {
        throw new Error("Fastest Path wasm is missing graph_create.");
      }
      return fn(Number(numVertices ?? 0));
    },

    addEdge(src, dst, weight) {
      const fn = getModuleExport(module, "graph_add_edge");
      if (typeof fn !== "function") {
        throw new Error("Fastest Path wasm is missing graph_add_edge.");
      }
      return fn(Number(src ?? 0), Number(dst ?? 0), Number(weight ?? 0));
    },

    addEdges(edges = []) {
      if (!Array.isArray(edges) || edges.length === 0) {
        return 0;
      }
      const { pointer, free } = packEdges(module, edges);
      try {
        const fn = getModuleExport(module, "graph_add_edges_bulk");
        if (typeof fn !== "function") {
          throw new Error("Fastest Path wasm is missing graph_add_edges_bulk.");
        }
        return fn(pointer, edges.length);
      } finally {
        free(pointer);
      }
    },

    loadCSR(offsets, destinations, weights) {
      const fn = getModuleExport(module, "graph_load_csr");
      if (typeof fn !== "function") {
        throw new Error("Fastest Path wasm is missing graph_load_csr.");
      }
      const offsetsArray =
        offsets instanceof Uint32Array ? offsets : Uint32Array.from(offsets ?? []);
      const destinationsArray =
        destinations instanceof Uint32Array
          ? destinations
          : Uint32Array.from(destinations ?? []);
      const weightsArray =
        weights instanceof Float64Array ? weights : Float64Array.from(weights ?? []);
      const offsetsBytes = offsetsArray.byteLength;
      const destinationsBytes = destinationsArray.byteLength;
      const weightsBytes = weightsArray.byteLength;
      const alloc = getModuleExport(module, "plugin_alloc");
      const free = getModuleExport(module, "plugin_free");
      if (typeof alloc !== "function" || typeof free !== "function") {
        throw new Error("Fastest Path wasm is missing plugin_alloc/plugin_free exports.");
      }

      const offsetsPtr = alloc(offsetsBytes);
      const destinationsPtr = alloc(destinationsBytes);
      const weightsPtr = alloc(weightsBytes);
      const memory = moduleMemory;
      if (!offsetsPtr || !destinationsPtr || !weightsPtr || !memory) {
        throw new Error("Fastest Path wasm failed to allocate CSR buffers.");
      }

      try {
        new Uint32Array(memory, offsetsPtr, offsetsArray.length).set(offsetsArray);
        new Uint32Array(memory, destinationsPtr, destinationsArray.length).set(destinationsArray);
        new Float64Array(memory, weightsPtr, weightsArray.length).set(weightsArray);
        return fn(offsetsPtr, destinationsPtr, weightsPtr, offsetsArray.length - 1, destinationsArray.length);
      } finally {
        free(offsetsPtr);
        free(destinationsPtr);
        free(weightsPtr);
      }
    },

    buildGraph() {
      const fn = getModuleExport(module, "graph_build");
      if (typeof fn !== "function") {
        throw new Error("Fastest Path wasm is missing graph_build.");
      }
      return fn();
    },

    computeSSSP(source, options = {}) {
      const fn = getModuleExport(module, "compute_sssp");
      if (typeof fn !== "function") {
        throw new Error("Fastest Path wasm is missing compute_sssp.");
      }
      const hints = { auto: 0, frontier: 1, dijkstra: 2 };
      const hint = hints[options.algorithm ?? "auto"] ?? 0;
      return fn(Number(source ?? 0), hint);
    },

    getDistances() {
      const getDistances = getModuleExport(module, "get_distances");
      const getVertexCount = getModuleExport(module, "get_vertex_count");
      if (typeof getDistances !== "function" || typeof getVertexCount !== "function") {
        return new Float64Array(0);
      }
      const pointer = getDistances();
      const vertexCount = getVertexCount();
      if (!pointer || !vertexCount || !moduleMemory) {
        return new Float64Array(0);
      }
      return new Float64Array(moduleMemory, pointer, vertexCount);
    },

    getPredecessors() {
      const getPredecessors = getModuleExport(module, "get_predecessors");
      const getVertexCount = getModuleExport(module, "get_vertex_count");
      if (typeof getPredecessors !== "function" || typeof getVertexCount !== "function") {
        return new Uint32Array(0);
      }
      const pointer = getPredecessors();
      const vertexCount = getVertexCount();
      if (!pointer || !vertexCount || !moduleMemory) {
        return new Uint32Array(0);
      }
      return new Uint32Array(moduleMemory, pointer, vertexCount);
    },

    getPath(target) {
      const getVertexCount = getModuleExport(module, "get_vertex_count");
      const reconstructPath = getModuleExport(module, "reconstruct_path");
      const alloc = getModuleExport(module, "plugin_alloc");
      const free = getModuleExport(module, "plugin_free");
      if (
        typeof getVertexCount !== "function" ||
        typeof reconstructPath !== "function" ||
        typeof alloc !== "function" ||
        typeof free !== "function" ||
        !moduleMemory
      ) {
        return null;
      }
      const vertexCount = getVertexCount();
      if (!vertexCount) {
        return null;
      }
      const pointer = alloc(vertexCount * 4);
      if (!pointer) {
        return null;
      }
      try {
        const length = reconstructPath(Number(target ?? 0), pointer, vertexCount);
        if (length <= 0) {
          return null;
        }
        const pathView = new Uint32Array(moduleMemory, pointer, length);
        return Array.from(pathView).reverse();
      } finally {
        free(pointer);
      }
    },

    get vertexCount() {
      const fn = getModuleExport(module, "get_vertex_count");
      return typeof fn === "function" ? fn() : 0;
    },

    get edgeCount() {
      const fn = getModuleExport(module, "get_edge_count");
      return typeof fn === "function" ? fn() : 0;
    },

    destroy() {
      const destroy = getModuleExport(module, "plugin_destroy");
      if (typeof destroy === "function") {
        destroy();
      }
      harness.destroy();
    },
  };

  if (typeof getModuleExport(module, "plugin_init") === "function") {
    getModuleExport(module, "plugin_init")();
  }

  return api;
}

export async function createFastestPathSolver(options = {}) {
  const wasmBytes = await resolveWasmBytes(options);
  const harness = await createBrowserModuleHarness({
    wasmSource: wasmBytes,
    surface: "direct",
    host: options.host,
    hostOptions: options.hostOptions,
    args: options.args,
    env: options.env,
    logOutput: options.logOutput === true,
  });
  const manifestBytes = harness.readManifest();
  const manifest = manifestBytes ? decodePluginManifest(manifestBytes) : null;
  if (options.requireEmbeddedManifest === true && !manifest) {
    harness.destroy();
    throw new Error(
      "Fastest Path wasm must export an embedded manifest through plugin_get_manifest_flatbuffer.",
    );
  }
  return createSolverApi(
    harness,
    manifest ?? JSON.parse(readFileSync(fileURLToPath(pluginManifestPath), "utf8")),
    manifest ? EXPECTED_MANIFEST_SOURCE : "static-manifest",
  );
}

export const packageMetadata = Object.freeze({
  pluginId: "com.orbpro.fastest-path",
  name: "Fastest Path (SSSP)",
  version: "1.0.0",
  pluginFamily: "analysis",
});

const packageApi = Object.assign(createFastestPathSolver, {
  createFastestPathSolver,
  pluginManifestPath,
  browserModulePath,
  browserWasmPath,
  isomorphicWasmPath,
  packageMetadata,
});

export default packageApi;
