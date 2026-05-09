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

export const RF_CLOUD_PLUGIN_ID = "com.orbpro.rf-cloud-fog";
export const RF_CLOUD_PLUGIN_NAME = "RF Cloud / Fog Attenuation";
export const RF_CLOUD_PLUGIN_VERSION = "0.1.0";
export const RF_CLOUD_PLUGIN_DESCRIPTION =
  "ITU-R P.840-9 Annex 1 cloud / fog liquid-water absorption (double-Debye permittivity).";
export const RF_CLOUD_MANIFEST_BYTES_SYMBOL = "rf_cloud_fog_plugin_manifest_bytes";
export const RF_CLOUD_MANIFEST_SIZE_SYMBOL = "rf_cloud_fog_plugin_manifest_size";

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
    case PluginFamily.PROPAGATOR: return "Propagator";
    case PluginFamily.SENSOR: return "Sensor";
    case PluginFamily.ANALYSIS: return "Analysis";
    case PluginFamily.SHADER: return "Shader";
    case PluginFamily.RENDERER: return "Renderer";
    case PluginFamily.DATA_SOURCE: return "DataSource";
    case PluginFamily.COMMS: return "Comms";
    case PluginFamily.FLOW: return "Flow";
    default: return "Plugin";
  }
}

export function createRfCloudFogPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.CloudRequest", "RCDR");
  const resultType = createTypeRef("orbpro.comms.rf.CloudResult", "RCDS");
  const requestSet = createAcceptedTypeSet(
    "comms.rf-cloud-request",
    [requestType],
    "Aligned-binary cloud-attenuation request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-cloud-result",
    [resultType],
    "Aligned-binary cloud-attenuation result frames.",
  );
  const ports = [
    [createPort("request", "Cloud Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Cloud Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_CLOUD_PLUGIN_ID,
    RF_CLOUD_PLUGIN_NAME,
    RF_CLOUD_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_specific_coefficient",
        "Compute K_l Coefficient",
        ports[0],
        ports[1],
        "Mass-specific cloud-liquid-water attenuation coefficient K_l in dB/(km · g/m³).",
      ),
      createMethod(
        "compute_attenuation",
        "Compute Cloud / Fog Attenuation",
        ports[0],
        ports[1],
        "Total slant-path cloud / fog attenuation A = K_l · ρ · path_km in dB.",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-cloud-fog-runtime",
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
  const manifest = options.manifest ?? createRfCloudFogPluginManifest();
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
    description: RF_CLOUD_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-cloud-fog.wasm",
      loader: options.loaderFile ?? "rf-cloud-fog.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_CLOUD_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_CLOUD_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfCloudFogPluginManifest;
