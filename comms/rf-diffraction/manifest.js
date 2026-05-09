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

export const RF_DIFFRACTION_PLUGIN_ID = "com.orbpro.rf-diffraction";
export const RF_DIFFRACTION_PLUGIN_NAME = "RF Diffraction (ITU-R P.526)";
export const RF_DIFFRACTION_PLUGIN_VERSION = "0.1.0";
export const RF_DIFFRACTION_PLUGIN_DESCRIPTION =
  "Knife-edge diffraction primitives per ITU-R P.526-15 §4.1 (Vogler approximation J(v)) plus Earth-curvature correction; multi-knife-edge Deygout recursion is JS-host orchestrated.";
export const RF_DIFFRACTION_MANIFEST_BYTES_SYMBOL =
  "rf_diffraction_plugin_manifest_bytes";
export const RF_DIFFRACTION_MANIFEST_SIZE_SYMBOL =
  "rf_diffraction_plugin_manifest_size";

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

export function createRfDiffractionPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.DiffractionRequest", "RDFR");
  const resultType = createTypeRef("orbpro.comms.rf.DiffractionResult", "RDFS");
  const requestSet = createAcceptedTypeSet(
    "comms.rf-diffraction-request",
    [requestType],
    "Aligned-binary diffraction request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-diffraction-result",
    [resultType],
    "Aligned-binary diffraction result frames.",
  );
  const ports = [
    [createPort("request", "Diffraction Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Diffraction Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_DIFFRACTION_PLUGIN_ID,
    RF_DIFFRACTION_PLUGIN_NAME,
    RF_DIFFRACTION_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_curvature_drop",
        "Compute Earth-Curvature Drop",
        ports[0],
        ports[1],
        "Earth-bulge drop d²/(2·k·R_E) along a great-circle path; pass k = 0 to disable.",
      ),
      createMethod(
        "compute_fresnel_kirchhoff_v",
        "Compute Fresnel-Kirchhoff Parameter from Clearance",
        ports[0],
        ports[1],
        "v = h·√(2·(d1+d2)/(λ·d1·d2)) given clearance directly.",
      ),
      createMethod(
        "compute_knife_edge_parameter_v",
        "Compute Knife-Edge v from Path Profile",
        ports[0],
        ports[1],
        "v computed from start/end/obstacle distances and heights with optional Earth-curvature correction.",
      ),
      createMethod(
        "compute_knife_edge_loss",
        "Compute Knife-Edge Diffraction Loss",
        ports[0],
        ports[1],
        "ITU-R P.526-15 §4.1 Eq. (31) Vogler approximation J(v) in dB.",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-diffraction-runtime",
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
  const manifest = options.manifest ?? createRfDiffractionPluginManifest();
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
    description: RF_DIFFRACTION_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-diffraction.wasm",
      loader: options.loaderFile ?? "rf-diffraction.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_DIFFRACTION_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_DIFFRACTION_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfDiffractionPluginManifest;
