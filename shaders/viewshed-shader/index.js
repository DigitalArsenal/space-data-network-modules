import { createBrowserWasiShim } from "space-data-module-sdk/host/wasi-shim";
import { decodePluginInvokeResponse, encodePluginInvokeRequest } from "space-data-module-sdk/invoke";

export const pluginManifestPath = new URL("./dist/manifest.json", import.meta.url);
export const browserWasmPath = new URL("./dist/viewshed-shader.wasm", import.meta.url);
export const isomorphicWasmPath = browserWasmPath;

export const metadata = Object.freeze({
  id: "com.orbpro.viewshed-shader",
  name: "OrbPro Viewshed Shader",
  version: "1.0.0",
  type: "Shader",
  encrypted: true,
  requiresProtection: true,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultShaderSources = Object.freeze({
  vertexSource: null,
  fragmentSource: null,
  frustumVertexSource: null,
  frustumFragmentSource: null,
  uniformsJson: JSON.stringify([
    { name: "u_modelView", type: "mat4" },
    { name: "u_observerPosition", type: "vec3" },
    { name: "u_range", type: "float" },
    { name: "u_viewshedMatrix", type: "mat4" },
    { name: "u_visibleColor", type: "vec4" },
    { name: "u_occludedColor", type: "vec4" },
    { name: "u_opacity", type: "float" },
    { name: "u_viewshedTexture", type: "sampler2D" },
  ]),
  definesJson: JSON.stringify(["VIEWSHED_SHADER"]),
});

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
      `Failed to fetch viewshed-shader artifact from ${url.href}: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readJson(url) {
  return JSON.parse(textDecoder.decode(await readUrlBytes(url)));
}

async function readText(url) {
  return textDecoder.decode(await readUrlBytes(url));
}

async function resolveViewshedWasmBytes(options = {}) {
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

export async function getViewshedShaderManifest() {
  return readJson(pluginManifestPath);
}

export async function loadViewshedShaderSources(options = {}) {
  const vertexSource =
    typeof options.vertexSource === "string"
      ? options.vertexSource
      : await readText(new URL("./shaders/viewshed.vs.glsl", import.meta.url));
  const fragmentSource =
    typeof options.fragmentSource === "string"
      ? options.fragmentSource
      : await readText(new URL("./shaders/viewshed.fs.glsl", import.meta.url));

  return {
    vertexSource,
    fragmentSource,
    frustumVertexSource:
      typeof options.frustumVertexSource === "string"
        ? options.frustumVertexSource
        : vertexSource,
    frustumFragmentSource:
      typeof options.frustumFragmentSource === "string"
        ? options.frustumFragmentSource
        : fragmentSource,
    uniformsJson:
      typeof options.uniformsJson === "string"
        ? options.uniformsJson
        : defaultShaderSources.uniformsJson,
    definesJson:
      typeof options.definesJson === "string"
        ? options.definesJson
        : defaultShaderSources.definesJson,
  };
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
  return module?.memory?.buffer ?? module?.wasmMemory?.buffer ?? null;
}

function readNullTerminatedString(module, exportName) {
  const getter = getModuleExport(module, [exportName]);
  const memoryBuffer = getMemoryBuffer(module);
  if (!getter || !memoryBuffer) {
    return null;
  }
  const pointer = Number(getter());
  if (!Number.isFinite(pointer) || pointer <= 0) {
    return null;
  }
  const bytes = new Uint8Array(memoryBuffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return textDecoder.decode(bytes.subarray(pointer, end));
}

async function instantiateViewshedModule(options = {}) {
  const wasmBytes = await resolveViewshedWasmBytes(options);
  const shaderSources = await loadViewshedShaderSources(options);
  const wasi = createBrowserWasiShim({
    args: options.args ?? [],
    env: options.env ?? {},
    stdinBytes: options.stdinBytes ?? new Uint8Array(),
    logOutput: options.logOutput === true,
    performance: options.performance,
  });
  const importObject = {
    ...wasi.imports,
    env: {
      emscripten_asm_const_int() {
        return 0;
      },
      emscripten_notify_memory_growth() {
        return 0;
      },
    },
  };

  const wasmModule = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(wasmModule, importObject);
  if (instance.exports.memory) {
    wasi.setMemory(instance.exports.memory);
  }
  if (typeof instance.exports._initialize === "function") {
    instance.exports._initialize();
  }

  const alloc = getModuleExport(instance.exports, [
    "orbpro_malloc",
    "orbpro_free",
    "malloc",
    "_malloc",
  ]);
  const free = getModuleExport(instance.exports, [
    "orbpro_free",
    "plugin_free",
    "free",
    "_free",
  ]);

  if (typeof instance.exports.orbpro_set_shaders === "function" && alloc && free) {
    const writeString = (value) => {
      const bytes = textEncoder.encode(`${value ?? ""}\0`);
      const pointer = alloc(bytes.length || 1);
      if (!pointer) {
        throw new Error("Viewshed shader module failed to allocate shader seed bytes.");
      }
      new Uint8Array(instance.exports.memory.buffer, pointer, bytes.length).set(bytes);
      return { pointer, length: bytes.length };
    };

    const vertex = writeString(shaderSources.vertexSource);
    const fragment = writeString(shaderSources.fragmentSource);
    const uniforms = writeString(shaderSources.uniformsJson);
    const frustumVertex = writeString(shaderSources.frustumVertexSource);
    const frustumFragment = writeString(shaderSources.frustumFragmentSource);

    try {
      instance.exports.orbpro_set_shaders(vertex.pointer, fragment.pointer, uniforms.pointer);
      instance.exports.orbpro_set_frustum_shaders(
        frustumVertex.pointer,
        frustumFragment.pointer,
      );
    } finally {
      free(vertex.pointer);
      free(fragment.pointer);
      free(uniforms.pointer);
      free(frustumVertex.pointer);
      free(frustumFragment.pointer);
    }
  }

  return { instance, wasi, shaderSources };
}

function bindViewshedShaderApi(context, manifest, manifestSource) {
  const module = context.instance.exports;
  const alloc = getModuleExport(module, ["orbpro_malloc", "plugin_alloc", "malloc", "_malloc"]);
  const free = getModuleExport(module, ["orbpro_free", "plugin_free", "free", "_free"]);
  const invoke = getModuleExport(module, [
    "plugin_stream_invoke",
    "_plugin_stream_invoke",
  ]);

  const api = {
    instance: context.instance,
    module,
    exports: module,
    wasi: context.wasi,
    shaderSources: context.shaderSources,
    manifest,
    manifestSource,
    metadata,
    getManifest: () => manifest,
    getMetadata: () => metadata,
    destroy: async () => {
      const cleanup = getModuleExport(module, ["orbpro_cleanup", "plugin_destroy", "_plugin_destroy"]);
      cleanup?.();
    },
    streamInvoke(request = {}) {
      if (!invoke || !alloc || !free) {
        throw new Error("Viewshed shader module is missing invoke exports.");
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
        throw new Error("Viewshed shader module failed to allocate invoke buffers.");
      }

      let responsePointer = 0;
      try {
        const memoryBuffer = getMemoryBuffer(module);
        if (!memoryBuffer) {
          throw new Error("Viewshed shader module does not expose linear memory.");
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
        const responseBytes = new Uint8Array(memoryBuffer, responsePointer, responseSize).slice();
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
    getName: () => readNullTerminatedString(module, "get_name"),
    getVersion: () => readNullTerminatedString(module, "get_version"),
    getType: () => readNullTerminatedString(module, "get_type"),
    getDefines: () => readNullTerminatedString(module, "get_defines"),
    getUniforms: () => readNullTerminatedString(module, "get_uniforms"),
    getVertexSource: () => readNullTerminatedString(module, "get_vertex_source"),
    getFragmentSource: () => readNullTerminatedString(module, "get_fragment_source"),
    getFrustumVertexSource: () =>
      readNullTerminatedString(module, "get_frustum_vertex_source"),
    getFrustumFragmentSource: () =>
      readNullTerminatedString(module, "get_frustum_fragment_source"),
    isInitialized: () => Boolean(module.orbpro_is_initialized?.()),
    compileProgram: (...args) => module.orbpro_compile_program?.(...args),
    initKey: (...args) => module.orbpro_init_key?.(...args),
    setShaders: (...args) => module.orbpro_set_shaders?.(...args),
    setFrustumShaders: (...args) => module.orbpro_set_frustum_shaders?.(...args),
    cleanup: (...args) => module.orbpro_cleanup?.(...args),
  };

  return Object.freeze(api);
}

export async function loadViewshedShaderPlugin(options = {}) {
  const manifest = await getViewshedShaderManifest();
  const context = await instantiateViewshedModule(options);
  return bindViewshedShaderApi(context, manifest, "embedded-flatbuffer");
}

export async function createViewshedShaderPlugin(options = {}) {
  return loadViewshedShaderPlugin(options);
}
