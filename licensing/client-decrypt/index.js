import {
  createBrowserWasiShim,
} from "space-data-module-sdk/host/wasi-shim";
import { createHostcallBridge } from "space-data-module-sdk";
import { toLoadableWasmBytes } from "space-data-module-sdk/testing/browser";
import {
  decodePluginInvokeResponse,
  encodePluginInvokeRequest,
} from "space-data-module-sdk/invoke";

export const isomorphicWasmPath = new URL("./dist/isomorphic/module.wasm", import.meta.url);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const NODE_SCHEME = "node";

function nodeSpecifier(name) {
  return `${NODE_SCHEME}:${name}`;
}

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

async function readNodeFile(url) {
  const [{ readFileSync }, { fileURLToPath }] = await Promise.all([
    import(nodeSpecifier("fs")),
    import(nodeSpecifier("url")),
  ]);
  return readFileSync(fileURLToPath(url));
}

async function loadLocalWasmBytes() {
  if (isomorphicWasmPath.protocol === "file:") {
    return readNodeFile(isomorphicWasmPath);
  }
  throw new Error(
    "Client-decrypt cannot read local wasm bytes in this runtime. Pass wasmBytes, wasmBinary, loadWasmBytes, or wasmUrl.",
  );
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
      return readNodeFile(resolvedUrl);
    }
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch client-decrypt wasm from ${resolvedUrl.href}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return loadLocalWasmBytes();
}

async function compileWasmModule(source) {
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  const bytes =
    typeof source === "string" || source instanceof URL
      ? await resolveWasmBytes({ wasmUrl: source })
      : await resolveWasmBytes({ wasmBytes: source });
  return WebAssembly.compile(toLoadableWasmBytes(bytes));
}

async function instantiateClientDecrypt(options = {}) {
  const wasmModule =
    options.wasmSource instanceof WebAssembly.Module
      ? options.wasmSource
      : await compileWasmModule(options.wasmSource ?? (await resolveWasmBytes(options)));

  const wasi = createBrowserWasiShim({
    args: options.args ?? [],
    env: options.env ?? {},
    stdinBytes: new Uint8Array(),
    logOutput: options.logOutput === true,
  });
  const importObject = { ...wasi.imports };
  let instance = null;
  const bridge = createHostcallBridge({
    dispatch:
      options.dispatch ??
      (() => {
        throw new Error("client-decrypt requires a synchronous host dispatch function.");
      }),
    getMemory: () => instance.exports.memory,
    maxRequestBytes: options.maxRequestBytes,
    maxResponseBytes: options.maxResponseBytes,
  });
  Object.assign(importObject, bridge.imports);

  instance = await WebAssembly.instantiate(wasmModule, importObject);
  if (instance.exports.memory) {
    wasi.setMemory(instance.exports.memory);
  }
  if (typeof instance.exports._initialize === "function") {
    instance.exports._initialize();
  }

  return {
    bridge,
    instance,
    wasi,
  };
}

function invokeDirect(instance, request) {
  const requestBytes = encodePluginInvokeRequest(request);
  const alloc = instance.exports.plugin_alloc;
  const free = instance.exports.plugin_free;
  const invoke = instance.exports.plugin_invoke_stream;
  const memory = instance.exports.memory;

  if (
    typeof alloc !== "function" ||
    typeof free !== "function" ||
    typeof invoke !== "function" ||
    !memory
  ) {
    throw new Error(
      "client-decrypt wasm is missing plugin_alloc/plugin_free/plugin_invoke_stream/memory exports.",
    );
  }

  const requestPointer = alloc(requestBytes.length || 1);
  new Uint8Array(memory.buffer, requestPointer, requestBytes.length).set(requestBytes);

  const responseLengthPointer = alloc(4);
  new DataView(memory.buffer).setUint32(responseLengthPointer, 0, true);
  const responsePointer = invoke(requestPointer, requestBytes.length, responseLengthPointer);
  const responseLength = new DataView(memory.buffer).getUint32(responseLengthPointer, true);

  free(requestPointer, requestBytes.length || 1);
  free(responseLengthPointer, 4);

  if (!responsePointer || responseLength === 0) {
    throw new Error("client-decrypt returned an empty invoke response.");
  }

  const responseBytes = new Uint8Array(memory.buffer, responsePointer, responseLength).slice();
  free(responsePointer, responseLength);
  return decodePluginInvokeResponse(responseBytes);
}

function normalizeDecryptPayload(firstArg, secondArg) {
  if (
    firstArg &&
    typeof firstArg === "object" &&
    !(firstArg instanceof Uint8Array) &&
    !(firstArg instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(firstArg)
  ) {
    return {
      payload:
        toUint8Array(
          firstArg.payload ?? firstArg.grantResponse ?? firstArg.envelope ?? firstArg.bytes,
        ) ?? new Uint8Array(),
      privateKey: toUint8Array(firstArg.privateKey) ?? new Uint8Array(),
      encryptedBundle:
        toUint8Array(
          firstArg.encryptedBundle ??
            firstArg.encryptedBundleBytes ??
            firstArg.bundleBytes ??
            firstArg.artifactBytes,
        ) ?? new Uint8Array(),
    };
  }

  return {
    payload: toUint8Array(firstArg) ?? new Uint8Array(),
    privateKey: toUint8Array(secondArg) ?? new Uint8Array(),
    encryptedBundle: new Uint8Array(),
  };
}

export async function createClientDecrypt(options = {}) {
  const runtime = await instantiateClientDecrypt(options);

  const api = {
    runtime: {
      kind: "browser",
      profile: "space-data-module-abi",
      surface: "direct",
    },
    instance: runtime.instance,
    async invoke(request) {
      return invokeDirect(runtime.instance, request);
    },
    async decryptArtifact(firstArg, secondArg) {
      const { payload, privateKey, encryptedBundle } = normalizeDecryptPayload(
        firstArg,
        secondArg,
      );
      if (payload.length === 0) {
        throw new Error("decryptArtifact requires a payload.");
      }
      if (privateKey.length === 0) {
        throw new Error("decryptArtifact requires a private key.");
      }

      const result = invokeDirect(runtime.instance, {
        methodId: "decrypt_artifact",
        inputs: [
          { payload },
          { payload: privateKey },
          ...(encryptedBundle.length > 0 ? [{ payload: encryptedBundle }] : []),
        ],
      });
      if (result.statusCode !== 0 || result.errorMessage) {
        throw new Error(result.errorMessage || "client-decrypt failed");
      }
      return result.outputs?.[0]?.payload ?? new Uint8Array();
    },
    async destroy() {
      runtime.wasi.flushOutput();
    },
  };

  return api;
}

const packageApi = Object.assign(createClientDecrypt, {
  createClientDecrypt,
  isomorphicWasmPath,
});

export default packageApi;
