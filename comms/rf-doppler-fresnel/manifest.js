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

export const RF_DOPPLER_FRESNEL_PLUGIN_ID = "com.orbpro.rf-doppler-fresnel";
export const RF_DOPPLER_FRESNEL_PLUGIN_NAME = "RF Doppler / Fresnel Primitives";
export const RF_DOPPLER_FRESNEL_PLUGIN_VERSION = "0.1.0";
export const RF_DOPPLER_FRESNEL_PLUGIN_DESCRIPTION =
  "Classical Doppler shift (Sklar §1.3.2) and Fresnel-zone radius (ITU-R P.526-15 §3) scalar primitives.";
export const RF_DOPPLER_FRESNEL_MANIFEST_BYTES_SYMBOL =
  "rf_doppler_fresnel_plugin_manifest_bytes";
export const RF_DOPPLER_FRESNEL_MANIFEST_SIZE_SYMBOL =
  "rf_doppler_fresnel_plugin_manifest_size";

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

export function createRfDopplerFresnelPluginManifest() {
  const dopplerRequestType = createTypeRef(
    "orbpro.comms.rf.DopplerRequest",
    "RDPR",
  );
  const dopplerResultType = createTypeRef(
    "orbpro.comms.rf.DopplerResult",
    "RDPS",
  );
  const fresnelRequestType = createTypeRef(
    "orbpro.comms.rf.FresnelRequest",
    "RFRR",
  );
  const fresnelResultType = createTypeRef(
    "orbpro.comms.rf.FresnelResult",
    "RFRS",
  );

  const dopplerRequestSet = createAcceptedTypeSet(
    "comms.rf-doppler-request",
    [dopplerRequestType],
    "Aligned-binary Doppler request frames (relative_velocity_mps: f64, frequency_hz: f64).",
  );
  const dopplerResultSet = createAcceptedTypeSet(
    "comms.rf-doppler-result",
    [dopplerResultType],
    "Aligned-binary Doppler result frames (shift_hz: f64).",
  );
  const fresnelRequestSet = createAcceptedTypeSet(
    "comms.rf-fresnel-request",
    [fresnelRequestType],
    "Aligned-binary Fresnel-zone request frames (d1_m: f64, d2_m: f64, frequency_hz: f64, zone: i32).",
  );
  const fresnelResultSet = createAcceptedTypeSet(
    "comms.rf-fresnel-result",
    [fresnelResultType],
    "Aligned-binary Fresnel-zone result frames (radius_m: f64).",
  );

  return new PluginManifestT(
    RF_DOPPLER_FRESNEL_PLUGIN_ID,
    RF_DOPPLER_FRESNEL_PLUGIN_NAME,
    RF_DOPPLER_FRESNEL_PLUGIN_VERSION,
    PluginFamily.COMMS,
    [
      createMethod(
        "compute_doppler",
        "Compute Doppler Shift",
        [
          createPort(
            "request",
            "Doppler Requests",
            [dopplerRequestSet],
            "Aligned-binary Doppler inputs.",
          ),
        ],
        [
          createPort(
            "result",
            "Doppler Results",
            [dopplerResultSet],
            "Aligned-binary Doppler outputs.",
          ),
        ],
        "Computes classical first-order Doppler shift Δf = (v_r/c) · f.",
      ),
      createMethod(
        "compute_fresnel",
        "Compute Fresnel-Zone Radius",
        [
          createPort(
            "request",
            "Fresnel Requests",
            [fresnelRequestSet],
            "Aligned-binary Fresnel-zone inputs.",
          ),
        ],
        [
          createPort(
            "result",
            "Fresnel Results",
            [fresnelResultSet],
            "Aligned-binary Fresnel-zone outputs.",
          ),
        ],
        "Computes the n-th Fresnel-zone radius at an obstruction plane (ITU-R P.526-15 §3).",
      ),
    ],
    [],
    [],
    [],
    [
      dopplerRequestType,
      dopplerResultType,
      fresnelRequestType,
      fresnelResultType,
    ],
    [
      new BuildArtifactT(
        "rf-doppler-fresnel-runtime",
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
  const manifest = options.manifest ?? createRfDopplerFresnelPluginManifest();
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
    description: RF_DOPPLER_FRESNEL_PLUGIN_DESCRIPTION,
    wasmModule: {
      file: options.wasmFile ?? "rf-doppler-fresnel.wasm",
      loader: options.loaderFile ?? "rf-doppler-fresnel.mjs",
      hash: options.wasmHash ?? null,
      exports: exportedFunctions.map((symbol) => symbol.replace(/^_/, "")),
    },
    embeddedManifest: {
      file: options.manifestFile ?? "plugin-manifest.fb",
      fileIdentifier: "PMAN",
      bytesSymbol:
        options.bytesSymbol ?? RF_DOPPLER_FRESNEL_MANIFEST_BYTES_SYMBOL,
      sizeSymbol:
        options.sizeSymbol ?? RF_DOPPLER_FRESNEL_MANIFEST_SIZE_SYMBOL,
    },
  };
}

export default createRfDopplerFresnelPluginManifest;
