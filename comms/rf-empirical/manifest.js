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

export const RF_EMPIRICAL_PLUGIN_ID = "com.orbpro.rf-empirical";
export const RF_EMPIRICAL_PLUGIN_NAME = "RF Empirical Path-Loss Models";
export const RF_EMPIRICAL_PLUGIN_VERSION = "0.1.0";
export const RF_EMPIRICAL_PLUGIN_DESCRIPTION =
  "Two-ray ground (Rappaport §4.6.2), Hata urban/suburban/rural (IEEE T-VT-29 1980), and COST-231 Hata extension (COST 231 Final Report §4.4.3) path-loss models.";
export const RF_EMPIRICAL_MANIFEST_BYTES_SYMBOL =
  "rf_empirical_plugin_manifest_bytes";
export const RF_EMPIRICAL_MANIFEST_SIZE_SYMBOL =
  "rf_empirical_plugin_manifest_size";

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

export function createRfEmpiricalPluginManifest() {
  // Aligned-binary request/response. We expose one method per model
  // family rather than a polymorphic "compute_path_loss" so the FlatBuffer
  // schema for each method is fixed-size and straightforward.
  const requestType = createTypeRef("orbpro.comms.rf.EmpiricalRequest", "REMR");
  const resultType = createTypeRef("orbpro.comms.rf.EmpiricalResult", "REMS");

  const requestSet = createAcceptedTypeSet(
    "comms.rf-empirical-request",
    [requestType],
    "Aligned-binary empirical-model request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-empirical-result",
    [resultType],
    "Aligned-binary empirical-model result frames (loss_db: f64).",
  );

  const ports = [
    [
      createPort("request", "Empirical Requests", [requestSet], "Aligned-binary inputs."),
    ],
    [
      createPort("result", "Empirical Results", [resultSet], "Aligned-binary outputs."),
    ],
  ];

  return new PluginManifestT(
    RF_EMPIRICAL_PLUGIN_ID,
    RF_EMPIRICAL_PLUGIN_NAME,
    RF_EMPIRICAL_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_two_ray_ground",
        "Compute Two-Ray Ground Loss",
        ports[0],
        ports[1],
        "Rappaport §4.6.2 two-ray ground model with breakpoint at 4·h_t·h_r/λ.",
      ),
      createMethod(
        "compute_hata_urban",
        "Compute Hata Urban Loss",
        ports[0],
        ports[1],
        "Hata 1980 medium-/small-city urban-area path loss.",
      ),
      createMethod(
        "compute_hata_suburban",
        "Compute Hata Suburban Loss",
        ports[0],
        ports[1],
        "Hata 1980 suburban-area correction over the urban form.",
      ),
      createMethod(
        "compute_hata_rural",
        "Compute Hata Rural Loss",
        ports[0],
        ports[1],
        "Hata 1980 rural / open-area correction over the urban form.",
      ),
      createMethod(
        "compute_cost231",
        "Compute COST-231 Hata Loss",
        ports[0],
        ports[1],
        "COST 231 Final Report §4.4.3 Hata extension to 1500–2000 MHz.",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-empirical-runtime",
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
  const manifest = options.manifest ?? createRfEmpiricalPluginManifest();
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
    description: RF_EMPIRICAL_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-empirical.wasm",
      loader: options.loaderFile ?? "rf-empirical.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_EMPIRICAL_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_EMPIRICAL_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfEmpiricalPluginManifest;
