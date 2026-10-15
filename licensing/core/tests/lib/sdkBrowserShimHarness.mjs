import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createBrowserWasiShim,
  createHostcallBridge,
  WasiExitError,
} from "space-data-module-sdk";
import {
  encodePluginInvokeRequest,
  decodePluginInvokeResponse,
} from "space-data-module-sdk/invoke";
import {
  decodeHostCall,
  encodeHostCallResult,
  isTypedHostCall,
} from "space-data-module-sdk/runtime-contracts";
import { toLoadableWasmBytes } from "space-data-module-sdk/testing/browser";

// The module's host for these tests, on the typed contracts (1.0): every hostcall must be an SDS $PIV invocation
// (a JSON-envelope call fails the test). The SDK's own host bridge (createHostcallBridge -> typedDispatch) answers
// the operations it has adapters for, with the test's `dispatch` as the host behind it, and plugin.getConfig /
// secrets.get are served from the harness's `config` object and `secrets` map as a node would.
//
// The SDK JS host's generic path answers only an operation's "result" record, so ipfs.cat, protocol.request and
// keyslot.sign - whose answer is the raw "data" frame - are answered here, in the same shape (the dispatch gets the
// call's record fields and raw frames camelCased, as typedDispatch passes them, and its bytes go back on "data").
const RAW_DATA_OPERATIONS = new Set(["ipfs.cat", "protocol.request", "keyslot.sign"]);

const textDecoder = new TextDecoder();
const camel = (field) => field.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function hostParams(call) {
  const out = {};
  for (const [field, value] of Object.entries(call.params || {})) {
    if (value === null || value === undefined || value === "" || value === 0 || value === 0n || value === false) continue;
    out[camel(field)] = typeof value === "bigint" ? Number(value) : value;
  }
  for (const [port, bytes] of Object.entries(call.raw || {})) out[camel(port)] = bytes;
  return out;
}

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
  return WebAssembly.compile(toLoadableWasmBytes(normalizeWasmBytes(source)));
}

function createTypedHost(options, getMemory) {
  const config = options.config ?? {};
  const secrets = options.secrets ?? new Map();
  const hostcalls = [];
  const userDispatch = options.dispatch ?? (() => {
    throw new Error("no host dispatch");
  });
  const dispatch = (operation, params) => {
    if (operation === "plugin.getConfig") return config;
    if (operation === "secrets.get") {
      const secret = secrets.get(params?.id);
      if (!secret) throw new Error(`secret not configured: ${params?.id}`);
      return { id: params.id, secret: new Uint8Array(secret) };
    }
    return userDispatch(operation, params);
  };
  const bridge = createHostcallBridge({ dispatch, getMemory });
  const sdk = bridge.imports[bridge.moduleName];
  let local = null;
  const call = (opPtr, opLen, payloadPtr, payloadLen) => {
    const payload = new Uint8Array(getMemory().buffer, payloadPtr, payloadLen).slice();
    const op = textDecoder.decode(new Uint8Array(getMemory().buffer, opPtr, opLen));
    if (!isTypedHostCall(payload)) {
      hostcalls.push({ op, typed: false });
      throw new Error(`hostcall ${op} is not an SDS $PIV invocation`);
    }
    const decoded = decodeHostCall(payload);
    hostcalls.push({ op: decoded.op, typed: true, params: decoded.params, raw: Object.keys(decoded.raw) });
    if (!RAW_DATA_OPERATIONS.has(decoded.op)) {
      local = null;
      return sdk.call(opPtr, opLen, payloadPtr, payloadLen);
    }
    try {
      const value = dispatch(decoded.op, hostParams(decoded));
      local = encodeHostCallResult({ ok: true, op: decoded.op, raw: { data: new Uint8Array(value ?? []) } });
    } catch (error) {
      local = encodeHostCallResult({ ok: false, error: { code: "failed", message: String(error?.message ?? error) } });
    }
    return 0;
  };
  const imports = {
    [bridge.moduleName]: {
      ...sdk,
      call,
      response_len: () => (local ? local.length : sdk.response_len()),
      read_response: (dstPtr, dstLen) => {
        if (!local) return sdk.read_response(dstPtr, dstLen);
        const n = Math.min(dstLen, local.length);
        new Uint8Array(getMemory().buffer, dstPtr, n).set(local.subarray(0, n));
        return n;
      },
    },
  };
  return { imports, hostcalls, config, secrets };
}

// Frames named by file identifier only are given their port's full type reference (schema, root type, wire format).
function typedRequest(request) {
  return {
    ...request,
    inputs: (request.inputs ?? []).map((frame) => {
      if (frame.typeRef || !frame.fileIdentifier) return frame;
      const code = frame.fileIdentifier.slice(1);
      const { fileIdentifier, ...rest } = frame;
      return {
        ...rest,
        typeRef: { schemaName: `${code}.fbs`, fileIdentifier, rootTypeName: code, wireFormat: "flatbuffer" },
      };
    }),
  };
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
  const host = createTypedHost(options, () => instance.exports.memory);
  Object.assign(importObject, host.imports);

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
    host,
  };
}

function invokeDirect(instance, request) {
  const requestBytes = encodePluginInvokeRequest(typedRequest(request));
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
  const config = options.config ?? {};
  const secrets = options.secrets ?? new Map();
  const hostcalls = [];
  let directRuntime = null;

  async function getDirectRuntime() {
    if (directRuntime) {
      return directRuntime;
    }
    directRuntime = await instantiateWithHostcallBridge({ ...options, wasmModule, config, secrets });
    return directRuntime;
  }

  async function invoke(request) {
    if (surface === "command") {
      const { instance, wasi, host } = await instantiateWithHostcallBridge({
        ...options,
        wasmModule,
        config,
        secrets,
        stdinBytes: encodePluginInvokeRequest(typedRequest(request)),
        logOutput: false,
        initialize: false,
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
        hostcalls.push(...host.hostcalls);
      }
      return decodePluginInvokeResponse(stdoutBytes);
    }

    const { instance } = await getDirectRuntime();
    return invokeDirect(instance, request);
  }

  return {
    config,
    secrets,
    get hostcalls() {
      return directRuntime ? [...hostcalls, ...directRuntime.host.hostcalls] : hostcalls;
    },
    async invoke(request) {
      return invoke(request);
    },
    async destroy() {
      if (directRuntime) {
        directRuntime.wasi.flushOutput();
        directRuntime = null;
      }
    },
  };
}

export async function createSdkBrowserShimSyncHarness(options = {}) {
  const wasmModule = await compileWasmModule(options.wasmSource);
  const config = options.config ?? {};
  const secrets = options.secrets ?? new Map();
  const { instance, wasi, host } = await instantiateWithHostcallBridge({ ...options, wasmModule, config, secrets });

  return {
    config,
    secrets,
    hostcalls: host.hostcalls,
    invokeSync(request) {
      return invokeDirect(instance, request);
    },
    destroy() {
      wasi.flushOutput();
    },
  };
}
