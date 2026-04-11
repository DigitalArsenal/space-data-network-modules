import { decodePluginInvokeResponse, encodePluginInvokeRequest } from "space-data-module-sdk/invoke";
import { decodePluginManifest } from "space-data-module-sdk/manifest";

export const pluginManifestPath = new URL("./dist/manifest.json", import.meta.url);
export const browserModulePath = new URL("./dist/sgp4.mjs", import.meta.url);
export const browserWasmPath = new URL("./dist/sgp4.wasm", import.meta.url);
export const isomorphicWasmPath = browserWasmPath;

export const metadata = Object.freeze({
  id: "com.orbpro.sgp4",
  name: "SGP4/SDP4 Propagator",
  version: "1.0.0",
  type: "Propagator",
  encrypted: true,
  requiresProtection: false,
});

const textDecoder = new TextDecoder();

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

async function readUrlBytes(url) {
  if (url.protocol === "file:") {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:url"),
    ]);
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch sgp4 artifact from ${url.href}: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readJson(url) {
  return JSON.parse(textDecoder.decode(await readUrlBytes(url)));
}

function getModuleExport(module, names) {
  for (const name of names) {
    const value = module?.[name];
    if (typeof value === "function") {
      return value.bind(module);
    }
  }
  return null;
}

function getMemoryBuffer(module) {
  return module?.HEAPU8?.buffer ?? module?.memory?.buffer ?? null;
}

function cloneBytes(module, pointer, size) {
  const memoryBuffer = getMemoryBuffer(module);
  const safePointer = Number(pointer) >>> 0;
  const safeSize = Number(size) >>> 0;
  if (!memoryBuffer || safePointer === 0 || safeSize === 0) {
    return new Uint8Array();
  }
  return new Uint8Array(memoryBuffer, safePointer, safeSize).slice();
}

async function resolveSgp4WasmBytes(options = {}) {
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
    return readUrlBytes(resolvedUrl);
  }

  return readUrlBytes(browserWasmPath);
}

async function loadSgp4Factory() {
  const namespace = await import(browserModulePath.href);
  return namespace.default ?? namespace;
}

export async function getSGP4Manifest(module = null) {
  if (module) {
    const getBytes = getModuleExport(module, [
      "plugin_get_manifest_flatbuffer",
      "_plugin_get_manifest_flatbuffer",
    ]);
    const getSize = getModuleExport(module, [
      "plugin_get_manifest_flatbuffer_size",
      "_plugin_get_manifest_flatbuffer_size",
    ]);
    const memoryBuffer = getMemoryBuffer(module);
    if (getBytes && getSize && memoryBuffer) {
      const pointer = Number(getBytes());
      const size = Number(getSize());
      if (Number.isFinite(pointer) && pointer > 0 && Number.isFinite(size) && size > 0) {
        return decodePluginManifest(new Uint8Array(memoryBuffer, pointer, size).slice());
      }
    }
  }

  return readJson(pluginManifestPath);
}

function bindSgp4Api(module, manifest, manifestSource) {
  const alloc = getModuleExport(module, ["plugin_alloc", "_plugin_alloc", "malloc", "_malloc"]);
  const free = getModuleExport(module, ["plugin_free", "_plugin_free", "free", "_free"]);
  const invoke = getModuleExport(module, [
    "plugin_stream_invoke",
    "_plugin_stream_invoke",
  ]);

  const api = {
    ...module,
    module,
    exports: module,
    manifest,
    manifestSource,
    metadata,
    getManifest: () => manifest,
    getMetadata: () => metadata,
    destroy: async () => {
      const destroyFn = getModuleExport(module, [
        "plugin_destroy",
        "_plugin_destroy",
      ]);
      destroyFn?.();
    },
    streamInvoke(request = {}) {
      if (!invoke || !alloc || !free) {
        throw new Error("SGP4 module is missing stream invoke exports.");
      }
      const requestBytes = encodePluginInvokeRequest(request);
      const requestPointer = alloc(requestBytes.length || 1);
      const responseLengthPointer = alloc(4);
      if (!requestPointer || !responseLengthPointer) {
        if (requestPointer) {
          free(requestPointer);
        }
        if (responseLengthPointer) {
          free(responseLengthPointer);
        }
        throw new Error("SGP4 module failed to allocate invoke buffers.");
      }

      let responsePointer = 0;
      try {
        const memoryBuffer = getMemoryBuffer(module);
        if (!memoryBuffer) {
          throw new Error("SGP4 module does not expose linear memory.");
        }
        if (requestBytes.length > 0) {
          new Uint8Array(memoryBuffer, requestPointer, requestBytes.length).set(requestBytes);
        }
        new DataView(memoryBuffer).setUint32(responseLengthPointer, 0, true);
        responsePointer = invoke(
          requestPointer,
          requestBytes.length,
          responseLengthPointer,
        );
        const responseSize = new DataView(memoryBuffer).getUint32(
          responseLengthPointer,
          true,
        );
        const responseBytes = cloneBytes(module, responsePointer, responseSize);
        return decodePluginInvokeResponse(responseBytes);
      } finally {
        if (responsePointer) {
          free(responsePointer);
        }
        free(requestPointer);
        free(responseLengthPointer);
      }
    },
    invoke(request = {}) {
      return this.streamInvoke(request);
    },
    plugin_init: (...args) => module.plugin_init?.(...args),
    plugin_init_omm: (...args) => module.plugin_init_omm?.(...args),
    plugin_init_omm_flatbuffer_stream: (...args) =>
      module.plugin_init_omm_flatbuffer_stream?.(...args),
    plugin_propagate: (...args) => module.plugin_propagate?.(...args),
    plugin_propagate_batch: (...args) => module.plugin_propagate_batch?.(...args),
    plugin_propagate_path: (...args) => module.plugin_propagate_path?.(...args),
    plugin_destroy: (...args) => module.plugin_destroy?.(...args),
  };

  return Object.freeze(api);
}

export async function loadSGP4Plugin(options = {}) {
  const factory = await loadSgp4Factory();
  const wasmBinary = await resolveSgp4WasmBytes(options);
  const module = await factory({
    wasmBinary,
    noInitialRun: options.noInitialRun !== false,
    locateFile: (file) => new URL(`./dist/${file}`, import.meta.url).href,
  });
  const manifest = await getSGP4Manifest(module);
  const api = bindSgp4Api(module, manifest, "embedded-flatbuffer");
  if (options.autoInit !== false) {
    api.plugin_init?.();
  }
  return api;
}

export async function createSGP4Propagator(options = {}) {
  return loadSGP4Plugin(options);
}
