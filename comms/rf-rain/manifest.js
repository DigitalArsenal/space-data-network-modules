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

export const RF_RAIN_PLUGIN_ID = "com.orbpro.rf-rain";
export const RF_RAIN_PLUGIN_NAME = "RF Rain Attenuation";
export const RF_RAIN_PLUGIN_VERSION = "0.1.0";
export const RF_RAIN_PLUGIN_DESCRIPTION =
  "ITU-R P.838-3 specific attenuation, ITU-R P.530-18 terrestrial path reduction, and Crane 1980 piecewise-exponential rain attenuation.";
export const RF_RAIN_MANIFEST_BYTES_SYMBOL = "rf_rain_plugin_manifest_bytes";
export const RF_RAIN_MANIFEST_SIZE_SYMBOL = "rf_rain_plugin_manifest_size";

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

export function createRfRainPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.RainRequest", "RNRR");
  const resultType = createTypeRef("orbpro.comms.rf.RainResult", "RNRS");
  const requestSet = createAcceptedTypeSet(
    "comms.rf-rain-request",
    [requestType],
    "Aligned-binary rain-attenuation request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-rain-result",
    [resultType],
    "Aligned-binary rain-attenuation result frames.",
  );
  const ports = [
    [createPort("request", "Rain Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Rain Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_RAIN_PLUGIN_ID,
    RF_RAIN_PLUGIN_NAME,
    RF_RAIN_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_specific_attenuation",
        "Compute Specific Rain Attenuation",
        ports[0],
        ports[1],
        "ITU-R P.838-3 §1: γ_R = k(f, θ, τ) · R^α(f, θ, τ) in dB/km.",
      ),
      createMethod(
        "compute_attenuation_p530",
        "Compute Path Rain Attenuation (P.530-18)",
        ports[0],
        ports[1],
        "ITU-R P.530-18 §2.4 terrestrial LOS reduction: A = γ_R·d/(1+0.045·d) in dB.",
      ),
      createMethod(
        "compute_attenuation_crane",
        "Compute Path Rain Attenuation (Crane)",
        ports[0],
        ports[1],
        "Crane 1980 piecewise-exponential rain attenuation in dB; path clamped at 22.5 km.",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-rain-runtime",
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
  const manifest = options.manifest ?? createRfRainPluginManifest();
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
    description: RF_RAIN_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-rain.wasm",
      loader: options.loaderFile ?? "rf-rain.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_RAIN_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_RAIN_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfRainPluginManifest;
