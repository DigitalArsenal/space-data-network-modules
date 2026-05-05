import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createBrowserWasiShim,
  WasiExitError,
} from "space-data-module-sdk/host/wasi-shim";
import {
  createJsonHostcallBridge,
} from "../../node_modules/space-data-module-sdk/src/host/abi.js";
import {
  encodePluginInvokeRequest,
  decodePluginInvokeResponse,
} from "space-data-module-sdk/invoke";

function normalizeWasmBytes(source) {
  if (source instanceof URL) {
    return fs.readFileSync(fileURLToPath(source));
  }
  if (typeof source === "string") {
    return fs.readFileSync(source);
  }
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  throw new TypeError("Expected wasm bytes, ArrayBuffer, URL, or file path.");
}

async function compileWasmModule(source) {
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  return WebAssembly.compile(normalizeWasmBytes(source));
}

async function instantiateWithHostcallBridge(options) {
  const wasi = createBrowserWasiShim({
    args: options.args ?? [],
    env: options.env ?? {},
    stdinBytes: options.stdinBytes ?? new Uint8Array(),
    logOutput: options.logOutput === true,
  });
  const importObject = { ...wasi.imports };
  let instance = null;
  const bridge = createJsonHostcallBridge({
    dispatch: options.dispatch,
    getMemory: () => instance.exports.memory,
    maxRequestBytes: options.maxRequestBytes ?? 1024 * 1024,
    maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
  });
  Object.assign(importObject, bridge.imports);

  instance = await WebAssembly.instantiate(options.wasmModule, importObject);
  if (instance.exports.memory) {
    wasi.setMemory(instance.exports.memory);
  }
  if (options.initialize !== false && instance.exports._initialize) {
    instance.exports._initialize();
  }

  return {
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

  const inPtr = alloc(requestBytes.length);
  new Uint8Array(memory.buffer, inPtr, requestBytes.length).set(requestBytes);

  const outLenPtr = alloc(4);
  const outPtr = invoke(inPtr, requestBytes.length, outLenPtr);
  free(inPtr, requestBytes.length);

  const outLen = new DataView(memory.buffer).getUint32(outLenPtr, true);
  free(outLenPtr, 4);
  const outBytes = new Uint8Array(memory.buffer, outPtr, outLen).slice();
  free(outPtr, outLen);
  return decodePluginInvokeResponse(outBytes);
}

export async function createSdkBrowserShimHarness(options = {}) {
  const wasmModule = await compileWasmModule(options.wasmSource);
  const surface = options.surface ?? "direct";

  async function invoke(request) {
    if (surface === "command") {
      const { instance, wasi } = await instantiateWithHostcallBridge({
        wasmModule,
        dispatch: options.dispatch,
        args: options.args,
        env: options.env,
        stdinBytes: encodePluginInvokeRequest(request),
        logOutput: false,
        initialize: false,
        maxRequestBytes: options.maxRequestBytes,
        maxResponseBytes: options.maxResponseBytes,
      });
      let stdoutBytes = new Uint8Array();
      try {
        instance.exports._start();
      } catch (error) {
        if (!(error instanceof WasiExitError) || error.code !== 0) {
          throw error;
        }
      } finally {
        stdoutBytes = wasi.stdout.slice();
        wasi.flushOutput();
      }
      return decodePluginInvokeResponse(stdoutBytes);
    }

    const { instance, wasi } = await instantiateWithHostcallBridge({
      wasmModule,
      dispatch: options.dispatch,
      args: options.args,
      env: options.env,
      logOutput: options.logOutput,
      maxRequestBytes: options.maxRequestBytes,
      maxResponseBytes: options.maxResponseBytes,
    });
    try {
      return invokeDirect(instance, request);
    } finally {
      wasi.flushOutput();
    }
  }

  return {
    async invoke(request) {
      return invoke(request);
    },
    async destroy() {},
  };
}
