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

export const RF_ATMOS_PLUGIN_ID = "com.orbpro.rf-atmospheric-gaseous";
export const RF_ATMOS_PLUGIN_NAME = "RF Atmospheric (Gaseous) Absorption";
export const RF_ATMOS_PLUGIN_VERSION = "0.1.0";
export const RF_ATMOS_PLUGIN_DESCRIPTION =
  "Gaseous absorption: legacy simplified single-Lorentzian oxygen + water-vapor fits (RfCommsCore.js port, preserved verbatim) plus ITU-R P.676-13 Annex 1 §1 line-by-line specific attenuation (44 oxygen + 35 water-vapour lines, dry continuum) via the rf_gaseous_*_p676_db_per_km exports.";
export const RF_ATMOS_MANIFEST_BYTES_SYMBOL =
  "rf_atmospheric_gaseous_plugin_manifest_bytes";
export const RF_ATMOS_MANIFEST_SIZE_SYMBOL =
  "rf_atmospheric_gaseous_plugin_manifest_size";

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

export function createRfAtmosphericGaseousPluginManifest() {
  const requestType = createTypeRef("orbpro.comms.rf.AtmosphericRequest", "RATR");
  const resultType = createTypeRef("orbpro.comms.rf.AtmosphericResult", "RATS");

  const requestSet = createAcceptedTypeSet(
    "comms.rf-atmospheric-request",
    [requestType],
    "Aligned-binary atmospheric-attenuation request frames.",
  );
  const resultSet = createAcceptedTypeSet(
    "comms.rf-atmospheric-result",
    [resultType],
    "Aligned-binary atmospheric-attenuation result frames.",
  );

  const ports = [
    [createPort("request", "Atmospheric Requests", [requestSet], "Aligned-binary inputs.")],
    [createPort("result", "Atmospheric Results", [resultSet], "Aligned-binary outputs.")],
  ];

  return new PluginManifestT(
    RF_ATMOS_PLUGIN_ID,
    RF_ATMOS_PLUGIN_NAME,
    RF_ATMOS_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_oxygen_db_per_km",
        "Compute Oxygen Specific Attenuation",
        ports[0],
        ports[1],
        "Single-Lorentzian oxygen-line absorption in dB/km. Valid < 57 GHz.",
      ),
      createMethod(
        "compute_water_vapor_db_per_km",
        "Compute Water Vapor Specific Attenuation",
        ports[0],
        ports[1],
        "Single-Lorentzian H₂O-line absorption (centered at 22.235 GHz) in dB/km.",
      ),
      createMethod(
        "compute_total_atmospheric_db",
        "Compute Total Atmospheric Absorption",
        ports[0],
        ports[1],
        "Total slant-path atmospheric absorption (oxygen + water vapor) in dB.",
      ),
      createMethod(
        "compute_saturation_vapor_pressure",
        "Compute WMO Magnus Saturation Vapor Pressure",
        ports[0],
        ports[1],
        "WMO No. 8 Annex 4.A.1 saturation vapor pressure over water in hPa.",
      ),
      createMethod(
        "compute_p676_gamma0_db_per_km",
        "Compute P.676-13 Dry-Air Specific Attenuation",
        ports[0],
        ports[1],
        "ITU-R P.676-13 Annex 1 §1 line-by-line dry-air (oxygen + dry continuum) specific attenuation in dB/km.",
      ),
      createMethod(
        "compute_p676_gammaw_db_per_km",
        "Compute P.676-13 Water-Vapour Specific Attenuation",
        ports[0],
        ports[1],
        "ITU-R P.676-13 Annex 1 §1 line-by-line water-vapour specific attenuation in dB/km.",
      ),
      createMethod(
        "compute_p676_specific_attenuation_db_per_km",
        "Compute P.676-13 Total Specific Gaseous Attenuation",
        ports[0],
        ports[1],
        "ITU-R P.676-13 Annex 1 §1 total specific gaseous attenuation (gamma_o + gamma_w) in dB/km.",
      ),
    ],
    [],
    [],
    [],
    [requestType, resultType],
    [
      new BuildArtifactT(
        "rf-atmospheric-gaseous-runtime",
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
  const manifest = options.manifest ?? createRfAtmosphericGaseousPluginManifest();
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
    description: RF_ATMOS_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-atmospheric-gaseous.wasm",
      loader: options.loaderFile ?? "rf-atmospheric-gaseous.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol: options.bytesSymbol ?? RF_ATMOS_MANIFEST_BYTES_SYMBOL,
      sizeSymbol: options.sizeSymbol ?? RF_ATMOS_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfAtmosphericGaseousPluginManifest;
