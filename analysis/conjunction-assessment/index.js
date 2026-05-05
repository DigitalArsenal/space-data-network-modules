import {
  decodePlgManifest,
  isPlgManifestBuffer,
} from "space-data-module-sdk/manifest";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";

export const pluginManifestPath = new URL(
  "./plugin-manifest.json",
  import.meta.url,
);
export const browserModulePath = new URL(
  "./dist/browser/module.js",
  import.meta.url,
);
export const browserWasmPath = new URL(
  "./dist/browser/module.wasm",
  import.meta.url,
);
export const isomorphicWasmPath = new URL(
  "./dist/isomorphic/module.wasm",
  import.meta.url,
);

export const metadata = Object.freeze({
  id: "conjunction-assessment",
  name: "Conjunction Assessment Plugin",
  version: "0.2.0",
  type: "Analysis",
  encrypted: false,
  requiresProtection: false,
});

export const CA_SOURCE_KINDS = Object.freeze([
  "OMM",
  "OCM",
  "OEM",
  "CDM",
  "FLATSQL_QUERY",
  "PNM",
  "PUBSUB",
]);

const CA_SOURCE_KIND_ALIASES = new Map([
  ["OMM", "OMM"],
  ["OCM", "OCM"],
  ["OEM", "OEM"],
  ["CDM", "CDM"],
  ["FLATSQL_QUERY", "FLATSQL_QUERY"],
  ["FLATSQL-QUERY", "FLATSQL_QUERY"],
  ["FLATSQLQUERY", "FLATSQL_QUERY"],
  ["FLATSQL", "FLATSQL_QUERY"],
  ["PNM", "PNM"],
  ["PUBSUB", "PUBSUB"],
  ["PUB-SUB", "PUBSUB"],
  ["PUB/SUB", "PUBSUB"],
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSourceKind(value) {
  if (!nonEmptyString(value)) {
    throw new TypeError("Conjunction source requires a sourceKind or kind.");
  }
  const key = value.trim().replace(/\s+/g, "_").toUpperCase();
  return CA_SOURCE_KIND_ALIASES.get(key) ?? key;
}

function normalizeOptionalString(value) {
  return nonEmptyString(value) ? value.trim() : undefined;
}

function requireSchemaDescriptor(source) {
  if (!nonEmptyString(source.schemaName) || !nonEmptyString(source.fileIdentifier)) {
    throw new TypeError(
      `${source.sourceKind} source requires schemaName and fileIdentifier.`,
    );
  }
}

function requireAnyString(source, fields, message) {
  if (!fields.some((field) => nonEmptyString(source[field]))) {
    throw new TypeError(message);
  }
}

export function normalizeConjunctionSourceSelection(sources) {
  if (sources == null) {
    return [];
  }
  if (!Array.isArray(sources)) {
    throw new TypeError("Conjunction source selection must be an array.");
  }

  const allowedKinds = new Set(CA_SOURCE_KINDS);
  return sources.map((source, index) => {
    if (source == null || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError(`Conjunction source at index ${index} must be an object.`);
    }

    const sourceKind = normalizeSourceKind(source.sourceKind ?? source.kind);
    if (!allowedKinds.has(sourceKind)) {
      throw new TypeError(`Unsupported conjunction source kind "${sourceKind}".`);
    }

    const normalized = {
      sourceKind,
      sourceId: normalizeOptionalString(source.sourceId ?? source.id),
      providerId: normalizeOptionalString(source.providerId),
      schemaName: normalizeOptionalString(source.schemaName),
      fileIdentifier: normalizeOptionalString(source.fileIdentifier),
      query: normalizeOptionalString(source.query),
      queryHash: normalizeOptionalString(source.queryHash),
      pnmCid: normalizeOptionalString(source.pnmCid),
      manifestCid: normalizeOptionalString(source.manifestCid),
      topic: normalizeOptionalString(source.topic),
    };

    if (["OMM", "OCM", "OEM", "CDM"].includes(sourceKind)) {
      requireSchemaDescriptor(normalized);
    } else if (sourceKind === "FLATSQL_QUERY") {
      requireAnyString(
        normalized,
        ["query", "queryHash"],
        "FLATSQL_QUERY source requires query or queryHash.",
      );
    } else if (sourceKind === "PNM") {
      requireAnyString(
        normalized,
        ["pnmCid", "manifestCid"],
        "PNM source requires pnmCid or manifestCid.",
      );
    } else if (sourceKind === "PUBSUB") {
      requireAnyString(normalized, ["topic"], "PUBSUB source requires topic.");
    }

    return Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined),
    );
  });
}

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
      `Failed to fetch conjunction-assessment artifact from ${url.href}: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readJson(url) {
  return JSON.parse(textDecoder.decode(await readUrlBytes(url)));
}

async function resolveConjunctionWasmBytes(options = {}) {
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

  return readUrlBytes(isomorphicWasmPath);
}

async function resolveConjunctionWasmPath(options = {}) {
  if (
    typeof options.wasmPath === "string" &&
    options.wasmPath.trim().length > 0
  ) {
    return options.wasmPath;
  }

  if (options.wasmUrl !== undefined) {
    const resolvedUrl =
      options.wasmUrl instanceof URL
        ? options.wasmUrl
        : new URL(String(options.wasmUrl), import.meta.url);
    if (resolvedUrl.protocol === "file:") {
      const { fileURLToPath } = await import("node:url");
      return fileURLToPath(resolvedUrl);
    }
  }

  const { fileURLToPath } = await import("node:url");
  return fileURLToPath(isomorphicWasmPath);
}

export async function getConjunctionAssessmentManifest(plugin = null) {
  if (typeof plugin?.readManifest === "function") {
    const bytes = await plugin.readManifest();
    if (bytes instanceof Uint8Array && bytes.length > 0) {
      if (!isPlgManifestBuffer(bytes)) {
        throw new Error(
          "Conjunction-assessment wasm did not expose a canonical $PLG manifest buffer.",
        );
      }
      return decodePlgManifest(bytes);
    }
  }

  return readJson(pluginManifestPath);
}

export async function getConjunctionAssessmentWorkerBootstrap() {
  const namespace = await import(browserModulePath.href);
  return namespace.default ?? namespace;
}

function bindConjunctionAssessmentApi(harness, manifest, manifestSource) {
  const module = harness.instance?.exports ?? harness.exports ?? null;
  return Object.freeze({
    ...harness,
    manifest,
    manifestSource,
    metadata,
    module,
    exports: module,
    getManifest: () => manifest,
    getMetadata: () => metadata,
    destroy: harness.destroy,
    streamInvoke: harness.invoke,
    invoke: harness.invoke,
  });
}

async function loadIsomorphicModuleLoader() {
  const namespace = await import("space-data-module-sdk/host/isomorphic");
  if (typeof namespace.loadModule !== "function") {
    throw new Error(
      "space-data-module-sdk/host/isomorphic did not export loadModule.",
    );
  }
  return namespace.loadModule;
}

export async function loadConjunctionAssessmentPlugin(options = {}) {
  if (options.runtimeKind === "wasmedge" || options.wasmEdgeRunnerBinary) {
    const loadModule = await loadIsomorphicModuleLoader();
    const harness = await loadModule({
      wasmSource: await resolveConjunctionWasmPath(options),
      runtimeKind: "wasmedge",
      wasmEdgeBinary: options.wasmEdgeBinary,
      wasmEdgeRunnerBinary: options.wasmEdgeRunnerBinary,
      enableThreads: options.enableThreads ?? true,
      env: options.env,
      cwd: options.cwd,
      hostProfile: options.hostProfile,
      modules: options.modules,
      defaultModuleId: options.defaultModuleId,
      metadata: options.metadata ?? metadata,
    });
    const manifest = await getConjunctionAssessmentManifest(harness);
    return bindConjunctionAssessmentApi(
      harness,
      manifest,
      "embedded-flatbuffer",
    );
  }

  const wasmBytes = await resolveConjunctionWasmBytes(options);
  const harness = await createBrowserModuleHarness({
    wasmSource: wasmBytes,
    surface: options.surface ?? "direct",
    args: options.args,
    env: options.env,
    host: options.host,
    hostOptions: options.hostOptions,
    performance: options.performance,
    logOutput: options.logOutput === true,
  });
  const manifest = await getConjunctionAssessmentManifest(harness);
  return bindConjunctionAssessmentApi(harness, manifest, "embedded-flatbuffer");
}

export async function createConjunctionAssessmentPlugin(options = {}) {
  return loadConjunctionAssessmentPlugin(options);
}
