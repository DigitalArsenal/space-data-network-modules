import {
  createBrowserWasiShim,
} from "space-data-module-sdk/host/wasi-shim";
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

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
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

function encodeHostcallValue(value) {
  if (value === undefined) {
    return undefined;
  }
  const bytes = toUint8Array(value);
  if (bytes) {
    return {
      __type: "bytes",
      base64: bytesToBase64(bytes),
    };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => encodeHostcallValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, encodeHostcallValue(entry)]),
    );
  }
  return value;
}

function createJsonHostcallBridge(options = {}) {
  if (typeof options.dispatch !== "function") {
    throw new TypeError("createJsonHostcallBridge requires a dispatch function.");
  }
  if (typeof options.getMemory !== "function") {
    throw new TypeError("createJsonHostcallBridge requires a getMemory function.");
  }

  const maxRequestBytes = Number.isInteger(options.maxRequestBytes)
    ? options.maxRequestBytes
    : DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = Number.isInteger(options.maxResponseBytes)
    ? options.maxResponseBytes
    : DEFAULT_MAX_RESPONSE_BYTES;

  let lastEnvelopeBytes = textEncoder.encode(JSON.stringify({ ok: true, result: null }));

  function setEnvelope(envelope) {
    const bytes = textEncoder.encode(JSON.stringify(envelope));
    if (bytes.length > maxResponseBytes) {
      throw new Error(`Hostcall response exceeds ${maxResponseBytes} bytes.`);
    }
    lastEnvelopeBytes = bytes;
  }

  function readMemory(ptr, len, label) {
    const memory = options.getMemory();
    const buffer = memory?.buffer;
    if (!(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Hostcall bridge requires a WebAssembly memory export.");
    }
    if (!Number.isInteger(ptr) || ptr < 0 || !Number.isInteger(len) || len < 0) {
      throw new RangeError(`${label} range is invalid.`);
    }
    if (ptr + len > buffer.byteLength) {
      throw new RangeError(`${label} exceeds guest memory bounds.`);
    }
    return new Uint8Array(buffer, ptr, len);
  }

  function writeMemory(ptr, bytes, maxLen) {
    const memory = options.getMemory();
    const buffer = memory?.buffer;
    if (!(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Hostcall bridge requires a WebAssembly memory export.");
    }
    const payload = toUint8Array(bytes) ?? new Uint8Array(bytes);
    const byteLength = Math.min(payload.length, maxLen);
    new Uint8Array(buffer, ptr, byteLength).set(payload.subarray(0, byteLength));
    return byteLength;
  }

  function callJson(operationPtr, operationLen, payloadPtr, payloadLen) {
    try {
      if (payloadLen > maxRequestBytes) {
        throw new Error(`Hostcall request exceeds ${maxRequestBytes} bytes.`);
      }
      const operation = textDecoder.decode(
        readMemory(operationPtr, operationLen, "Host operation"),
      );
      const payloadBytes = readMemory(payloadPtr, payloadLen, "Host payload");
      const params =
        payloadBytes.length > 0
          ? JSON.parse(textDecoder.decode(payloadBytes))
          : null;
      const result = options.dispatch(operation, params);
      if (result && typeof result === "object" && typeof result.then === "function") {
        throw new Error(
          `Operation "${operation}" returned a Promise. The sync hostcall ABI requires synchronous dispatch.`,
        );
      }
      setEnvelope({
        ok: true,
        result: encodeHostcallValue(result),
      });
      return 0;
    } catch (error) {
      setEnvelope({
        ok: false,
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
        },
      });
      return 1;
    }
  }

  return {
    imports: {
      space_data_module_host: {
        call_json: callJson,
        response_len() {
          return lastEnvelopeBytes.length;
        },
        read_response(dstPtr, dstLen) {
          return writeMemory(dstPtr, lastEnvelopeBytes, dstLen);
        },
        clear_response() {
          setEnvelope({ ok: true, result: null });
          return 0;
        },
      },
    },
  };
}

async function compileWasmModule(source) {
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  const bytes =
    typeof source === "string" || source instanceof URL
      ? await resolveWasmBytes({ wasmUrl: source })
      : await resolveWasmBytes({ wasmBytes: source });
  return WebAssembly.compile(bytes);
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
  const bridge = createJsonHostcallBridge({
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
