import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodePluginInvokeResponse,
  encodePluginInvokeRequest,
} from "space-data-module-sdk/invoke";
import { decodePluginManifest } from "space-data-module-sdk/manifest";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const pluginManifestPath = new URL("./plugin-manifest.json", import.meta.url);
export const browserModulePath = new URL("./dist/browser/module.js", import.meta.url);
export const browserWasmPath = new URL("./dist/browser/module.wasm", import.meta.url);
export const isomorphicWasmPath = new URL("./dist/isomorphic/module.wasm", import.meta.url);

const EXPECTED_MANIFEST_SOURCE = "embedded-flatbuffer";
const textEncoder = new TextEncoder();

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

function readStaticManifest() {
  return JSON.parse(readFileSync(fileURLToPath(pluginManifestPath), "utf8"));
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
        `Failed to fetch Sensor Shaders wasm from ${resolvedUrl.href}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return loadLocalWasmBytes();
}

function normalizeShaderSources(shaderSources = {}) {
  return Object.fromEntries(
    Object.entries(shaderSources).map(([name, source]) => [name, String(source)]),
  );
}

function loadPackageShaderSources() {
  const shaderDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "shaders");
  const shaderFiles = readdirSync(shaderDir)
    .filter((entry) => entry.endsWith(".glsl"))
    .sort();
  const shaderSources = {};
  for (const fileName of shaderFiles) {
    shaderSources[path.basename(fileName, ".glsl")] = readFileSync(
      path.join(shaderDir, fileName),
      "utf8",
    );
  }
  return shaderSources;
}

async function resolveShaderSources(options = {}) {
  if (options.shaderSources) {
    return normalizeShaderSources(options.shaderSources);
  }
  return normalizeShaderSources(loadPackageShaderSources());
}

function getModuleExport(module, exportName) {
  return module?.[exportName] ?? module?.[`_${exportName}`] ?? null;
}

function getModuleMemoryBuffer(module) {
  return module?.memory?.buffer ?? module?.wasmMemory?.buffer ?? null;
}

function withAllocatedBytes(module, bytes, callback) {
  const alloc = getModuleExport(module, "plugin_alloc");
  const free = getModuleExport(module, "plugin_free");
  if (typeof alloc !== "function" || typeof free !== "function") {
    throw new Error(
      "Sensor Shaders wasm is missing plugin_alloc/plugin_free exports.",
    );
  }

  const byteLength = bytes.length > 0 ? bytes.length : 1;
  const pointer = alloc(byteLength);
  if (!pointer) {
    throw new Error("Sensor Shaders wasm failed to allocate bytes.");
  }

  try {
    const memoryBuffer = getModuleMemoryBuffer(module);
    if (!memoryBuffer) {
      throw new Error("Sensor Shaders wasm is missing a memory export.");
    }
    if (bytes.length > 0) {
      new Uint8Array(memoryBuffer, pointer, bytes.length).set(bytes);
    }
    return callback(pointer, bytes.length);
  } finally {
    free(pointer, byteLength);
  }
}

function synchronizeBundleToModule(module, bundlePayload) {
  const setter = getModuleExport(module, "sensor_shaders_set_bundle_json");
  if (typeof setter !== "function") {
    throw new Error("Sensor Shaders wasm is missing sensor_shaders_set_bundle_json.");
  }

  const jsonBytes = textEncoder.encode(JSON.stringify(bundlePayload));
  return withAllocatedBytes(module, jsonBytes, (pointer, size) => {
    const ok = setter(pointer, size);
    if (!ok) {
      throw new Error("Sensor Shaders wasm rejected bundle JSON.");
    }
    return ok;
  });
}

function normalizeInvokeInputs(inputs = []) {
  return inputs.map((input = {}) => {
    const payload =
      toUint8Array(input.bytes ?? input.payloadBytes ?? input.data ?? input.payload) ??
      new Uint8Array();
    return {
      ...input,
      payload,
    };
  });
}

function invokeStreamSync(module, invocation = {}) {
  const invoke = getModuleExport(module, "plugin_invoke_stream");
  const alloc = getModuleExport(module, "plugin_alloc");
  const free = getModuleExport(module, "plugin_free");
  if (
    typeof invoke !== "function" ||
    typeof alloc !== "function" ||
    typeof free !== "function"
  ) {
    throw new Error(
      "Sensor Shaders wasm is missing plugin_invoke_stream/plugin_alloc/plugin_free exports.",
    );
  }

  const requestBytes = encodePluginInvokeRequest({
    methodId: invocation.methodId ?? null,
    inputs: normalizeInvokeInputs(invocation.inputs ?? []),
    outputStreamCap: invocation.outputStreamCap ?? 0,
  });
  const requestLength = requestBytes.length || 1;
  const requestPointer = alloc(requestLength);
  const responseLengthPointer = alloc(4);
  if (!requestPointer || !responseLengthPointer) {
    if (requestPointer) {
      free(requestPointer, requestLength);
    }
    if (responseLengthPointer) {
      free(responseLengthPointer, 4);
    }
    throw new Error("Sensor Shaders wasm failed to allocate invoke buffers.");
  }

  let responsePointer = 0;
  let responseLength = 0;
  try {
    let memoryBuffer = getModuleMemoryBuffer(module);
    if (!memoryBuffer) {
      throw new Error("Sensor Shaders wasm is missing a memory export.");
    }
    if (requestBytes.length > 0) {
      new Uint8Array(memoryBuffer, requestPointer, requestBytes.length).set(requestBytes);
    }
    new DataView(memoryBuffer).setUint32(responseLengthPointer, 0, true);
    responsePointer = invoke(requestPointer, requestBytes.length, responseLengthPointer);

    memoryBuffer = getModuleMemoryBuffer(module);
    if (!memoryBuffer) {
      throw new Error("Sensor Shaders wasm lost its memory export during invoke.");
    }
    responseLength = new DataView(memoryBuffer).getUint32(responseLengthPointer, true);
    if (!responsePointer || responseLength === 0) {
      throw new Error("Sensor Shaders wasm returned an empty invoke response.");
    }

    const responseBytes = new Uint8Array(memoryBuffer, responsePointer, responseLength).slice();
    const decoded = decodePluginInvokeResponse(responseBytes);
    return {
      ...decoded,
      outputs: decoded.outputs.map((output) => ({
        ...output,
        bytes: output.payload,
        payloadBytes: output.payload,
        data: output.payload,
      })),
    };
  } finally {
    if (responsePointer) {
      free(responsePointer, responseLength);
    }
    free(requestPointer, requestLength);
    free(responseLengthPointer, 4);
  }
}

function createBundleApi(harness, manifest, manifestSource, shaders) {
  const module = harness.instance.exports;
  const shaderNames = Object.keys(shaders);
  const bundlePayload = {
    shaderNames,
    shaders,
    manifestSource,
  };

  synchronizeBundleToModule(module, bundlePayload);

  return {
    type: "Shader",
    name: manifest?.name ?? "OrbPro Sensor Shaders",
    version: manifest?.version ?? "1.0.0",
    metadata: {
      id: manifest?.pluginId ?? "com.orbpro.sensor-shaders",
      name: manifest?.name ?? "OrbPro Sensor Shaders",
      version: manifest?.version ?? "1.0.0",
      type: "Shader",
      encrypted: false,
      requiresProtection: false,
    },
    manifest,
    manifestSource,
    shaderNames,
    shaders: Object.freeze({ ...shaders }),
    supportsStreamInvoke: typeof getModuleExport(module, "plugin_invoke_stream") === "function",
    streamInvoke(invocation = {}) {
      return invokeStreamSync(module, invocation);
    },
    destroy() {
      const cleanup = getModuleExport(module, "sensor_shaders_stream_cleanup");
      if (typeof cleanup === "function") {
        cleanup();
      }
      harness.destroy();
    },
  };
}

export function getSensorShadersManifest(bundle = null) {
  if (bundle?.manifest) {
    return bundle.manifest;
  }
  return readStaticManifest();
}

export async function loadSensorShaders(options = {}) {
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

  const embeddedManifestBytes = harness.readManifest();
  const embeddedManifest = embeddedManifestBytes
    ? decodePluginManifest(embeddedManifestBytes)
    : null;
  if (options.requireEmbeddedManifest === true && !embeddedManifest) {
    harness.destroy();
    throw new Error(
      "Sensor Shaders wasm must export an embedded manifest through plugin_get_manifest_flatbuffer.",
    );
  }

  const shaders = await resolveShaderSources(options);
  return createBundleApi(
    harness,
    embeddedManifest ?? readStaticManifest(),
    embeddedManifest ? EXPECTED_MANIFEST_SOURCE : "static-manifest",
    shaders,
  );
}

export const metadata = Object.freeze({
  id: "com.orbpro.sensor-shaders",
  name: "OrbPro Sensor Shaders",
  version: "1.0.0",
  type: "Shader",
  encrypted: false,
  requiresProtection: false,
});

const packageApi = Object.assign(loadSensorShaders, {
  loadSensorShaders,
  getSensorShadersManifest,
  pluginManifestPath,
  browserModulePath,
  browserWasmPath,
  isomorphicWasmPath,
  metadata,
});

export default packageApi;
