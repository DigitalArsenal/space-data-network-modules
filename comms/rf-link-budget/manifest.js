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

export const RF_LINK_PLUGIN_ID = "com.orbpro.rf-link-budget";
export const RF_LINK_PLUGIN_NAME = "RF Link-Budget Orchestrator";
export const RF_LINK_PLUGIN_VERSION = "0.1.0";
export const RF_LINK_PLUGIN_DESCRIPTION =
  "Friis link budget + kTB noise + SNR + Shannon capacity. Includes the Eb/N0 = SNR + 10·log10(B/Rb) fix the audit identified at RfCommsCore.js:2872.";
export const RF_LINK_MANIFEST_BYTES_SYMBOL = "rf_link_budget_plugin_manifest_bytes";
export const RF_LINK_MANIFEST_SIZE_SYMBOL = "rf_link_budget_plugin_manifest_size";

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

export function createRfLinkBudgetPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.LinkBudgetRequest", "RLBR");
  const resultType = createTypeRef("orbpro.comms.rf.LinkBudgetResult", "RLBS");
  const requestSet = createAcceptedTypeSet(
    "comms.rf-link-budget-request",
    [requestType],
    "Aligned-binary link-budget request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-link-budget-result",
    [resultType],
    "Aligned-binary link-budget result frames (96-byte struct).",
  );
  const ports = [
    [createPort("request", "Link Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Link Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_LINK_PLUGIN_ID,
    RF_LINK_PLUGIN_NAME,
    RF_LINK_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod("compute_eirp", "Compute EIRP", ports[0], ports[1], "EIRP_dBW = 10·log10(P_W) + G_t − L_t."),
      createMethod("compute_noise_power", "Compute Noise Power", ports[0], ports[1], "kTB noise floor in dBW with receiver noise figure."),
      createMethod("compute_free_space_loss", "Compute Free-Space Loss", ports[0], ports[1], "Friis FSPL in dB."),
      createMethod("compute_ebno", "Compute Eb/N0", ports[0], ports[1], "Eb/N0 = SNR + 10·log10(B/R_b) per Sklar Eq. 4.27 — fixes the audit-identified bug at RfCommsCore.js:2872."),
      createMethod("compute_capacity", "Compute Channel Capacity", ports[0], ports[1], "Shannon capacity in bps."),
      createMethod("compute_link_budget", "Compute Composed Link Budget", ports[0], ports[1], "Full Friis + kTB + Shannon orchestrator returning the legacy 96-byte result struct."),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-link-budget-runtime",
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
  const manifest = options.manifest ?? createRfLinkBudgetPluginManifest();
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
    description: RF_LINK_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-link-budget.wasm",
      loader: options.loaderFile ?? "rf-link-budget.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_LINK_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_LINK_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfLinkBudgetPluginManifest;
