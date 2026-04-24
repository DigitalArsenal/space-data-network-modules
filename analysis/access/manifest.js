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

export const ACCESS_PLUGIN_ID = "com.orbpro.access";
export const ACCESS_PLUGIN_NAME = "Access Analysis";
export const ACCESS_PLUGIN_VERSION = "1.0.0";
export const ACCESS_PLUGIN_DESCRIPTION =
  "Access-window analysis for mission-planning and contact-interval evaluation.";
export const ACCESS_MANIFEST_BYTES_SYMBOL = "access_plugin_manifest_bytes";
export const ACCESS_MANIFEST_SIZE_SYMBOL = "access_plugin_manifest_size";

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

function createPort(
  portId,
  displayName,
  acceptedTypeSets,
  description,
  options = {},
) {
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

function createMethod(
  methodId,
  displayName,
  inputPorts,
  outputPorts,
  description,
  options = {},
) {
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

export function createAccessPluginManifest() {
  const accessWindowRequestType = createTypeRef(
    "orbpro.analysis.AccessWindowRequest",
    "AWRQ",
  );
  const accessWindowResultType = createTypeRef(
    "orbpro.analysis.AccessWindowResult",
    "AWRS",
  );

  const accessWindowRequestSet = createAcceptedTypeSet(
    "analysis.access-window-request",
    [accessWindowRequestType],
    "Aligned-binary access-window request frames.",
  );
  const accessWindowResultSet = createAcceptedTypeSet(
    "analysis.access-window-result",
    [accessWindowResultType],
    "Aligned-binary access-window result frames.",
  );

  return new PluginManifestT(
    ACCESS_PLUGIN_ID,
    ACCESS_PLUGIN_NAME,
    ACCESS_PLUGIN_VERSION,
    PluginFamily.ANALYSIS,
    [
      createMethod(
        "compute_access_windows",
        "Compute Access Windows",
        [
          createPort(
            "request",
            "Access Requests",
            [accessWindowRequestSet],
            "Aligned-binary access-window analysis requests.",
          ),
        ],
        [
          createPort(
            "results",
            "Access Windows",
            [accessWindowResultSet],
            "Aligned-binary access-window analysis results.",
          ),
        ],
        "Computes access windows for an asset, target, and time span.",
      ),
    ],
    [],
    [],
    [],
    [accessWindowRequestType, accessWindowResultType],
    [
      new BuildArtifactT(
        "access-runtime",
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
  const manifest = options.manifest ?? createAccessPluginManifest();
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
    description: ACCESS_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "access.wasm",
      loader: options.loaderFile ?? "access.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? ACCESS_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? ACCESS_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createAccessPluginManifest;
