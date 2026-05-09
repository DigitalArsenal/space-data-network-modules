import {
  AcceptedTypeSetT,
  BuildArtifactT,
  DrainPolicy,
  FlatBufferTypeRefT,
  InvokeSurface,
  MethodManifestT,
  PayloadWireFormat,
  PluginFamily,
  PluginManifestT,
  PortManifestT,
} from "space-data-module-sdk/manifest";

export const RF_FSPL_PLUGIN_ID = "com.orbpro.rf-fspl";
export const RF_FSPL_PLUGIN_NAME = "RF Free-Space Path Loss";
export const RF_FSPL_PLUGIN_VERSION = "0.1.0";
export const RF_FSPL_PLUGIN_DESCRIPTION =
  "Friis (1946) / ITU-R P.525-4 free-space path loss in dB. Scalar primitive used by the RF link-budget orchestrator.";
export const RF_FSPL_MANIFEST_BYTES_SYMBOL = "rf_fspl_plugin_manifest_bytes";
export const RF_FSPL_MANIFEST_SIZE_SYMBOL = "rf_fspl_plugin_manifest_size";

function createTypeRef(schemaName, fileIdentifier) {
  return new FlatBufferTypeRefT(
    schemaName,
    fileIdentifier,
    [],
    false,
    PayloadWireFormat.AlignedBinary,
    null,
    0,
    0,
    8,
  );
}

function createAcceptedTypeSet(setId, allowedTypes, description) {
  return new AcceptedTypeSetT(setId, allowedTypes, description);
}

function createPort(portId, displayName, acceptedTypeSets, description, options = {}) {
  return new PortManifestT(
    portId,
    displayName,
    acceptedTypeSets,
    options.minStreams ?? 1,
    options.maxStreams ?? 65535,
    options.required ?? true,
    description,
  );
}

function createMethod(methodId, displayName, inputPorts, outputPorts, description, options = {}) {
  return new MethodManifestT(
    methodId,
    displayName,
    inputPorts,
    outputPorts,
    options.maxBatch ?? 1,
    options.drainPolicy ?? DrainPolicy.DRAIN_UNTIL_YIELD,
    description,
  );
}

function mapPluginFamilyToLegacyType(pluginFamily) {
  switch (pluginFamily) {
    case PluginFamily.PROPAGATOR:
      return "Propagator";
    case PluginFamily.SENSOR:
      return "Sensor";
    case PluginFamily.ANALYSIS:
      return "Analysis";
    case PluginFamily.SHADER:
      return "Shader";
    case PluginFamily.RENDERER:
      return "Renderer";
    case PluginFamily.DATA_SOURCE:
      return "DataSource";
    case PluginFamily.COMMS:
      return "Comms";
    case PluginFamily.FLOW:
      return "Flow";
    default:
      return "Plugin";
  }
}

export function createRfFsplPluginManifest() {
  // Aligned-binary request/response: a 16-byte pair of doubles in, a single
  // double out. Schemas are intentionally minimal for a scalar primitive —
  // they exist only to satisfy the SDK port contract.
  const fsplRequestType = createTypeRef("orbpro.comms.rf.FsplRequest", "RFFR");
  const fsplResultType = createTypeRef("orbpro.comms.rf.FsplResult", "RFFS");

  const fsplRequestSet = createAcceptedTypeSet(
    "comms.rf-fspl-request",
    [fsplRequestType],
    "Aligned-binary FSPL request frames (range_m: f64, frequency_hz: f64).",
  );
  const fsplResultSet = createAcceptedTypeSet(
    "comms.rf-fspl-result",
    [fsplResultType],
    "Aligned-binary FSPL result frames (loss_db: f64).",
  );

  return new PluginManifestT(
    RF_FSPL_PLUGIN_ID,
    RF_FSPL_PLUGIN_NAME,
    RF_FSPL_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_fspl",
        "Compute Free-Space Path Loss",
        [
          createPort(
            "request",
            "FSPL Requests",
            [fsplRequestSet],
            "Aligned-binary FSPL inputs.",
          ),
        ],
        [
          createPort(
            "result",
            "FSPL Results",
            [fsplResultSet],
            "Aligned-binary FSPL outputs.",
          ),
        ],
        "Computes Friis / ITU-R P.525-4 free-space path loss for a (range, frequency) pair.",
      ),
    ],
    [],
    [],
    [],
    [fsplRequestType, fsplResultType],
    [
      new BuildArtifactT(
        "rf-fspl-runtime",
        "javascript-runtime",
        "index.js",
        "web,worker,node",
        null,
      ),
    ],
    1,
    [InvokeSurface.DIRECT],
    ["browser", "node"],
  );
}

export function createLegacyMetadata(manifest, options = {}) {
  const normalized =
    manifest instanceof PluginManifestT
      ? manifest
      : Object.assign(new PluginManifestT(), manifest);

  return Object.freeze({
    id: normalized.pluginId,
    name: normalized.name,
    version: normalized.version,
    type: mapPluginFamilyToLegacyType(normalized.pluginFamily),
    encrypted: options.encrypted ?? false,
    requiresProtection:
      options.requiresProtection ?? options.encrypted ?? false,
  });
}

export function createLegacyBuildManifest(options = {}) {
  const manifest = options.manifest ?? createRfFsplPluginManifest();
  const legacyMetadata = createLegacyMetadata(manifest, {
    encrypted: options.encrypted,
    requiresProtection: options.requiresProtection,
  });
  const exportedFunctions = Array.isArray(options.exportedFunctions)
    ? options.exportedFunctions
    : [];

  return {
    pluginId: legacyMetadata.id,
    name: legacyMetadata.name,
    version: legacyMetadata.version,
    type: legacyMetadata.type,
    encrypted: legacyMetadata.encrypted,
    requiresProtection: legacyMetadata.requiresProtection,
    description: RF_FSPL_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-fspl.wasm",
      loader: options.loaderFile ?? "rf-fspl.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_FSPL_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_FSPL_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfFsplPluginManifest;
