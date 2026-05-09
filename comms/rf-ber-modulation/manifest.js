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

export const RF_BER_PLUGIN_ID = "com.orbpro.rf-ber-modulation";
export const RF_BER_PLUGIN_NAME = "RF BER per Modulation";
export const RF_BER_PLUGIN_VERSION = "0.1.0";
export const RF_BER_PLUGIN_DESCRIPTION =
  "Bit-error-rate from Eb/N0 for BPSK / QPSK / 8-PSK / 16-QAM / 64-QAM / FSK (Sklar §4 closed forms) plus an erfc primitive.";
export const RF_BER_MANIFEST_BYTES_SYMBOL = "rf_ber_modulation_plugin_manifest_bytes";
export const RF_BER_MANIFEST_SIZE_SYMBOL = "rf_ber_modulation_plugin_manifest_size";

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

export function createRfBerModulationPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.BerRequest", "RBRR");
  const resultType = createTypeRef("orbpro.comms.rf.BerResult", "RBRS");
  const requestSet = createAcceptedTypeSet(
    "comms.rf-ber-request",
    [requestType],
    "Aligned-binary BER request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-ber-result",
    [resultType],
    "Aligned-binary BER result frames.",
  );
  const ports = [
    [createPort("request", "BER Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "BER Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_BER_PLUGIN_ID,
    RF_BER_PLUGIN_NAME,
    RF_BER_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_erfc",
        "Compute erfc",
        ports[0],
        ports[1],
        "Numerical Recipes §6.2 Chebyshev erfc(x) primitive (~7-digit accuracy).",
      ),
      createMethod(
        "compute_ber_from_ebno",
        "Compute BER from Eb/N0",
        ports[0],
        ports[1],
        "Closed-form bit-error rate for BPSK/QPSK/8-PSK/16-QAM/64-QAM/FSK (Sklar §4).",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-ber-modulation-runtime",
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
  const manifest = options.manifest ?? createRfBerModulationPluginManifest();
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
    description: RF_BER_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-ber-modulation.wasm",
      loader: options.loaderFile ?? "rf-ber-modulation.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_BER_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_BER_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfBerModulationPluginManifest;
