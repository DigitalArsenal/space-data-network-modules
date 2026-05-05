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

const JULIAN_UNIX_EPOCH = 2440587.5;
const MILLIS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;

function isoToJulianDate(isoString, fieldName) {
  const millis = Date.parse(String(isoString ?? "").trim());
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 timestamp.`);
  }
  return millis / MILLIS_PER_DAY + JULIAN_UNIX_EPOCH;
}

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${fieldName} must be finite.`);
  }
  return number;
}

function optionalPositiveInteger(value, fallback, fieldName) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer.`);
  }
  return number;
}

function integerFromDesignator(value) {
  if (value == null) {
    return 0;
  }
  const match = String(value).trim().match(/^\d+$/);
  return match ? Number(match[0]) : 0;
}

function normalizeReferenceFrame(value) {
  const frame = String(value ?? "").trim().toUpperCase();
  if (frame === "TEME") {
    return "TEME";
  }
  if (frame === "ICRF" || frame === "EME2000" || frame === "J2000") {
    return "ICRF";
  }
  if (frame === "ECI" || frame === "GCRF") {
    return "ECI";
  }
  if (frame === "ECEF" || frame === "ITRF") {
    return "ECEF";
  }
  return "UNKNOWN";
}

function buildCompactSamples({
  data,
  vectorSize,
  startIso,
  stepSeconds,
  dataFieldName,
}) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new TypeError(`${dataFieldName} must contain compact Cartesian state data.`);
  }
  const safeVectorSize = optionalPositiveInteger(
    vectorSize,
    6,
    `${dataFieldName} state vector size`,
  );
  if (safeVectorSize < 6) {
    throw new TypeError(`${dataFieldName} state vector size must be at least 6.`);
  }
  if (data.length % safeVectorSize !== 0) {
    throw new TypeError(`${dataFieldName} length must divide evenly by state vector size.`);
  }
  const safeStepSeconds = finiteNumber(stepSeconds, `${dataFieldName} step size`);
  if (safeStepSeconds <= 0) {
    throw new TypeError(`${dataFieldName} step size must be positive.`);
  }
  const startJd = isoToJulianDate(startIso, `${dataFieldName} start time`);

  const samples = [];
  for (let offset = 0; offset < data.length; offset += safeVectorSize) {
    samples.push({
      jd: startJd + (offset / safeVectorSize) * safeStepSeconds / SECONDS_PER_DAY,
      xKm: finiteNumber(data[offset], `${dataFieldName}[${offset}]`),
      yKm: finiteNumber(data[offset + 1], `${dataFieldName}[${offset + 1}]`),
      zKm: finiteNumber(data[offset + 2], `${dataFieldName}[${offset + 2}]`),
      vxKmS: finiteNumber(data[offset + 3], `${dataFieldName}[${offset + 3}]`),
      vyKmS: finiteNumber(data[offset + 4], `${dataFieldName}[${offset + 4}]`),
      vzKmS: finiteNumber(data[offset + 5], `${dataFieldName}[${offset + 5}]`),
    });
  }
  if (samples.length < 2) {
    throw new TypeError(`${dataFieldName} must provide at least two samples.`);
  }
  return samples;
}

function buildVerboseOemSamples(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new TypeError("OEM EPHEMERIS_DATA_LINES must provide at least two samples.");
  }
  return lines.map((line, index) => ({
    jd: isoToJulianDate(line?.EPOCH, `OEM EPHEMERIS_DATA_LINES[${index}].EPOCH`),
    xKm: finiteNumber(line?.X, `OEM EPHEMERIS_DATA_LINES[${index}].X`),
    yKm: finiteNumber(line?.Y, `OEM EPHEMERIS_DATA_LINES[${index}].Y`),
    zKm: finiteNumber(line?.Z, `OEM EPHEMERIS_DATA_LINES[${index}].Z`),
    vxKmS: finiteNumber(line?.X_DOT, `OEM EPHEMERIS_DATA_LINES[${index}].X_DOT`),
    vyKmS: finiteNumber(line?.Y_DOT, `OEM EPHEMERIS_DATA_LINES[${index}].Y_DOT`),
    vzKmS: finiteNumber(line?.Z_DOT, `OEM EPHEMERIS_DATA_LINES[${index}].Z_DOT`),
  }));
}

function objectNameFromCat(cat) {
  return normalizeOptionalString(
    cat?.OBJECT_NAME ?? cat?.objectName ?? cat?.name ?? cat?.NAME,
  );
}

export function adaptOcmToPropagatedTrack(ocm, options = {}) {
  if (ocm == null || typeof ocm !== "object" || Array.isArray(ocm)) {
    throw new TypeError("OCM source must be a decoded SDS OCM object.");
  }
  const metadata = ocm.METADATA ?? ocm.metadata ?? {};
  const samples = buildCompactSamples({
    data: ocm.STATE_DATA ?? ocm.stateData,
    vectorSize: ocm.STATE_VECTOR_SIZE ?? ocm.stateVectorSize,
    startIso: metadata.START_TIME ?? metadata.startTime ?? metadata.EPOCH_TZERO,
    stepSeconds: ocm.STATE_STEP_SIZE ?? ocm.stateStepSize,
    dataFieldName: "OCM STATE_DATA",
  });
  return {
    sourcePluginId: normalizeOptionalString(options.sourcePluginId),
    sourceHandle: Number(options.sourceHandle ?? 0),
    objectName:
      normalizeOptionalString(options.objectName) ??
      normalizeOptionalString(metadata.OBJECT_NAME ?? metadata.objectName),
    objectId:
      normalizeOptionalString(options.objectId) ??
      normalizeOptionalString(
        metadata.INTERNATIONAL_DESIGNATOR ??
          metadata.internationalDesignator ??
          metadata.OBJECT_DESIGNATOR,
      ),
    noradCatId:
      Number(options.noradCatId ?? 0) ||
      integerFromDesignator(metadata.OBJECT_DESIGNATOR ?? metadata.objectDesignator),
    referenceFrame: normalizeReferenceFrame(
      options.referenceFrame ?? ocm.REFERENCE_FRAME ?? ocm.referenceFrame,
    ),
    samples,
  };
}

export function adaptOemToPropagatedTrack(oem, options = {}) {
  if (oem == null || typeof oem !== "object" || Array.isArray(oem)) {
    throw new TypeError("OEM source must be a decoded SDS OEM object.");
  }
  const blocks = oem.EPHEMERIS_DATA_BLOCK ?? oem.ephemerisDataBlock;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new TypeError("OEM source requires at least one EPHEMERIS_DATA_BLOCK.");
  }
  const block = blocks[Number(options.blockIndex ?? 0)] ?? blocks[0];
  const stepSeconds = Number(block.STEP_SIZE ?? block.stepSize ?? 0);
  const samples =
    stepSeconds > 0
      ? buildCompactSamples({
          data: block.EPHEMERIS_DATA ?? block.ephemerisData,
          vectorSize: block.STATE_VECTOR_SIZE ?? block.stateVectorSize,
          startIso: block.START_TIME ?? block.startTime,
          stepSeconds,
          dataFieldName: "OEM EPHEMERIS_DATA",
        })
      : buildVerboseOemSamples(
          block.EPHEMERIS_DATA_LINES ?? block.ephemerisDataLines,
        );
  const object = block.OBJECT ?? block.object ?? {};
  return {
    sourcePluginId: normalizeOptionalString(options.sourcePluginId),
    sourceHandle: Number(options.sourceHandle ?? 0),
    objectName:
      normalizeOptionalString(options.objectName) ?? objectNameFromCat(object),
    objectId:
      normalizeOptionalString(options.objectId) ??
      normalizeOptionalString(object.OBJECT_ID ?? object.objectId),
    noradCatId:
      Number(options.noradCatId ?? 0) ||
      Number(object.NORAD_CAT_ID ?? object.noradCatId ?? 0),
    referenceFrame: normalizeReferenceFrame(
      options.referenceFrame ?? block.REFERENCE_FRAME ?? block.referenceFrame,
    ),
    samples,
  };
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
