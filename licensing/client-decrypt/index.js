import * as flatbuffers from "flatbuffers";
import { FIL } from "spacedatastandards.org/lib/js/FIL/FIL.js";
import { filEntryKind } from "spacedatastandards.org/lib/js/FIL/filEntryKind.js";
import { KMF } from "spacedatastandards.org/lib/js/KMF/KMF.js";
import { keyMaterialAlgorithm } from "spacedatastandards.org/lib/js/KMF/keyMaterialAlgorithm.js";
import { keyMaterialEncoding } from "spacedatastandards.org/lib/js/KMF/keyMaterialEncoding.js";
import { keyMaterialRole } from "spacedatastandards.org/lib/js/KMF/keyMaterialRole.js";
import {
  createBrowserWasiShim,
} from "space-data-module-sdk/host/wasi-shim";
import { createHostcallBridge } from "space-data-module-sdk";
import { toLoadableWasmBytes } from "space-data-module-sdk/testing/browser";
import {
  decodePluginInvokeResponse,
  encodePluginInvokeRequest,
} from "space-data-module-sdk/invoke";

const ISOMORPHIC_WASM_RELATIVE_PATH = "./dist/isomorphic/module.wasm";

class LazyModuleUrl {
  get href() {
    return getIsomorphicWasmPath().href;
  }

  get protocol() {
    return getIsomorphicWasmPath().protocol;
  }

  toString() {
    return this.href;
  }

  [Symbol.toPrimitive]() {
    return this.href;
  }
}

export const isomorphicWasmPath = new LazyModuleUrl();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const NODE_SCHEME = "node";

// The module's port types (plugin-manifest.json, typed contracts 1.0).
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
export const PORT_TYPES = Object.freeze({ LGR: typeRef("LGR"), KMF: typeRef("KMF"), FIL: typeRef("FIL") });

/** The recipient's private key as the recipient_key frame: a $KMF, ROLE DecryptKey, KEY_BYTES the raw key. */
export function encodeRecipientKey(privateKey) {
  const builder = new flatbuffers.Builder(privateKey.length + 64);
  const keyBytes = KMF.createKeyBytesVector(builder, privateKey);
  KMF.startKMF(builder);
  KMF.addRole(builder, keyMaterialRole.DecryptKey);
  KMF.addAlgorithm(builder, keyMaterialAlgorithm.Opaque);
  KMF.addEncoding(builder, keyMaterialEncoding.RawBytes);
  KMF.addKeyBytes(builder, keyBytes);
  KMF.finishKMFBuffer(builder, KMF.endKMF(builder));
  return builder.asUint8Array();
}

/** Bytes as a $FIL (KIND File, SIZE, CONTENT): the protected_content frame. */
export function encodeFileContent(content) {
  const builder = new flatbuffers.Builder(content.length + 64);
  const contentOffset = FIL.createContentVector(builder, content);
  FIL.startFIL(builder);
  FIL.addKind(builder, filEntryKind.File);
  FIL.addSize(builder, BigInt(content.length));
  FIL.addContent(builder, contentOffset);
  FIL.finishFILBuffer(builder, FIL.endFIL(builder));
  return builder.asUint8Array();
}

/** The CONTENT of a $FIL frame (the plaintext port). */
export function decodeFileContent(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  if (!FIL.bufferHasIdentifier(bb)) throw new Error("client-decrypt answered a frame that is not a $FIL.");
  return FIL.getRootAsFIL(bb).contentArray() ?? new Uint8Array();
}

/** The decrypt_artifact input frames for a grant, the recipient key and (optionally) the encrypted bundle. */
export function decryptArtifactInputs({ grantResponseBytes, privateKey, encryptedBundle }) {
  return [
    { portId: "grant_response", typeRef: PORT_TYPES.LGR, payload: grantResponseBytes },
    { portId: "recipient_key", typeRef: PORT_TYPES.KMF, payload: encodeRecipientKey(privateKey) },
    ...(encryptedBundle && encryptedBundle.length > 0
      ? [{ portId: "protected_content", typeRef: PORT_TYPES.FIL, payload: encodeFileContent(encryptedBundle) }]
      : []),
  ];
}

function nodeSpecifier(name) {
  return `${NODE_SCHEME}:${name}`;
}

export function getIsomorphicWasmPath() {
  const importMetaUrl = import.meta.url;
  if (typeof importMetaUrl !== "string" || importMetaUrl.length === 0) {
    throw new Error(
      "Unable to resolve client-decrypt isomorphic WASM URL because import.meta.url is unavailable. Pass wasmBytes, wasmBinary, loadWasmBytes, or wasmUrl.",
    );
  }
  return new URL(ISOMORPHIC_WASM_RELATIVE_PATH, importMetaUrl);
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
  const wasmPath = getIsomorphicWasmPath();
  if (wasmPath.protocol === "file:") {
    return readNodeFile(wasmPath);
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
          firstArg.payload ?? firstArg.grantResponseBytes ?? firstArg.grantResponse ?? firstArg.envelope ?? firstArg.bytes,
        ) ?? new Uint8Array(),
      privateKey: toUint8Array(firstArg.privateKey ?? secondArg) ?? new Uint8Array(),
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
        inputs: decryptArtifactInputs({ grantResponseBytes: payload, privateKey, encryptedBundle }),
      });
      if (result.statusCode !== 0 || result.errorMessage) {
        throw new Error(result.errorMessage || "client-decrypt failed");
      }
      const plaintext = result.outputs?.find((frame) => frame.portId === "plaintext");
      return plaintext ? decodeFileContent(plaintext.payload) : new Uint8Array();
    },
    async destroy() {
      runtime.wasi.flushOutput();
    },
  };

  return api;
}

const packageApi = Object.assign(createClientDecrypt, {
  createClientDecrypt,
  decryptArtifactInputs,
  decodeFileContent,
  getIsomorphicWasmPath,
  isomorphicWasmPath,
});

export default packageApi;
