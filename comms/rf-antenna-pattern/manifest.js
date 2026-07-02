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

export const RF_ANTENNA_PLUGIN_ID = "com.orbpro.rf-antenna-pattern";
export const RF_ANTENNA_PLUGIN_NAME = "RF Antenna Pattern Evaluator";
export const RF_ANTENNA_PLUGIN_VERSION = "0.1.0";
export const RF_ANTENNA_PLUGIN_DESCRIPTION =
  "Antenna-pattern gain evaluation kernel: analytic family gains (isotropic through teardrop), sampled cone×clock dB grids with bilinear interpolation and clock wrap, and the boresight/up → (cone, clock) geometry bridge. C++ port of the AntennaPattern.js evaluator (the JS is the semantic spec).";
export const RF_ANTENNA_MANIFEST_BYTES_SYMBOL =
  "rf_antenna_pattern_plugin_manifest_bytes";
export const RF_ANTENNA_MANIFEST_SIZE_SYMBOL =
  "rf_antenna_pattern_plugin_manifest_size";

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

export function createRfAntennaPatternPluginManifest() {
  const requestType = createTypeRef(
    "orbpro.comms.rf.AntennaPatternRequest",
    "RAPR",
  );
  const resultType = createTypeRef(
    "orbpro.comms.rf.AntennaPatternResult",
    "RAPS",
  );
  const requestSet = createAcceptedTypeSet(
    "comms.rf-antenna-pattern-request",
    [requestType],
    "Aligned-binary antenna-pattern gain request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-antenna-pattern-result",
    [resultType],
    "Aligned-binary antenna-pattern gain result frames.",
  );
  const ports = [
    [createPort("request", "Gain Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Gain Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_ANTENNA_PLUGIN_ID,
    RF_ANTENNA_PLUGIN_NAME,
    RF_ANTENNA_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod("evaluate_gain", "Evaluate Analytic Gain", ports[0], ports[1], "Unit gain [0,1] for the analytic pattern families (isotropic, hemispheric, parabolic, gaussian, pencil, dipole, helix, dish, ringed, toroidal, cardioid, teardrop)."),
      createMethod("evaluate_gain_db", "Evaluate Analytic Gain (dB)", ports[0], ports[1], "referenceGainDb + 10·log10(max(gain, 1e-12)) for the analytic families."),
      createMethod("load_sampled_pattern", "Load Sampled Pattern", ports[0], ports[1], "Copy a dense cone×clock float64 dB grid into an evaluation handle (cone axis clamps, clock axis optionally wraps at 360°)."),
      createMethod("evaluate_sampled_gain_db", "Evaluate Sampled Gain (dB)", ports[0], ports[1], "Bilinear grid interpolation in dB at (cone, clock) radians against a loaded handle."),
      createMethod("evaluate_sampled_gain", "Evaluate Sampled Unit Gain", ports[0], ports[1], "clamp01(10^((gainDb − maximumGainDb)/10)) against a loaded handle."),
      createMethod("free_pattern", "Free Sampled Pattern", ports[0], ports[1], "Release a sampled-pattern handle."),
      createMethod("compute_cone_clock", "Compute Cone/Clock Angles", ports[0], ports[1], "Geometry bridge: antenna-local (cone, clock) angles from antenna position, boresight, up, and target vectors."),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-antenna-pattern-runtime",
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
  const manifest = options.manifest ?? createRfAntennaPatternPluginManifest();
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
    description: RF_ANTENNA_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-antenna-pattern.wasm",
      loader: options.loaderFile ?? "rf-antenna-pattern.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_ANTENNA_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_ANTENNA_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfAntennaPatternPluginManifest;
