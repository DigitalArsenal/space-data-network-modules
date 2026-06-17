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

export const SWATH_PLUGIN_ID = "com.orbpro.swath";
export const SWATH_PLUGIN_NAME = "Swath Analysis";
export const SWATH_PLUGIN_VERSION = "1.0.0";
export const SWATH_PLUGIN_DESCRIPTION =
  "Sensor footprint projection, ground-track generation, access geometry, and swath analytics for mission planning.";

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

export function createSwathPluginManifest() {
  const footprintRequestType = createTypeRef(
    "orbpro.analysis.SwathFootprintRequest",
    "SFPQ",
  );
  const footprintResultType = createTypeRef(
    "orbpro.analysis.SwathFootprintResult",
    "SFPR",
  );
  const groundTrackRequestType = createTypeRef(
    "orbpro.analysis.SwathGroundTrackRequest",
    "SGRQ",
  );
  const groundTrackResultType = createTypeRef(
    "orbpro.analysis.SwathGroundTrackResult",
    "SGRS",
  );
  const swathRequestType = createTypeRef(
    "orbpro.analysis.SwathGenerationRequest",
    "SWAQ",
  );
  const swathResultType = createTypeRef(
    "orbpro.analysis.SwathGenerationResult",
    "SWAS",
  );
  const containmentRequestType = createTypeRef(
    "orbpro.analysis.SwathContainmentRequest",
    "SPIQ",
  );
  const containmentResultType = createTypeRef(
    "orbpro.analysis.SwathContainmentResult",
    "SPIR",
  );
  const accessRequestType = createTypeRef(
    "orbpro.analysis.SwathAccessRequest",
    "SAPQ",
  );
  const accessResultType = createTypeRef(
    "orbpro.analysis.SwathAccessResult",
    "SAPR",
  );

  const footprintRequestSet = createAcceptedTypeSet(
    "analysis.swath-footprint-request",
    [footprintRequestType],
    "Aligned-binary swath footprint request frames.",
  );
  const footprintResultSet = createAcceptedTypeSet(
    "analysis.swath-footprint-result",
    [footprintResultType],
    "Aligned-binary swath footprint result frames.",
  );
  const groundTrackRequestSet = createAcceptedTypeSet(
    "analysis.swath-ground-track-request",
    [groundTrackRequestType],
    "Aligned-binary ground-track request frames.",
  );
  const groundTrackResultSet = createAcceptedTypeSet(
    "analysis.swath-ground-track-result",
    [groundTrackResultType],
    "Aligned-binary ground-track result frames.",
  );
  const swathRequestSet = createAcceptedTypeSet(
    "analysis.swath-generation-request",
    [swathRequestType],
    "Aligned-binary swath generation request frames.",
  );
  const swathResultSet = createAcceptedTypeSet(
    "analysis.swath-generation-result",
    [swathResultType],
    "Aligned-binary swath generation result frames.",
  );
  const containmentRequestSet = createAcceptedTypeSet(
    "analysis.swath-containment-request",
    [containmentRequestType],
    "Aligned-binary swath containment request frames.",
  );
  const containmentResultSet = createAcceptedTypeSet(
    "analysis.swath-containment-result",
    [containmentResultType],
    "Aligned-binary swath containment result frames.",
  );
  const accessRequestSet = createAcceptedTypeSet(
    "analysis.swath-access-request",
    [accessRequestType],
    "Aligned-binary swath access request frames.",
  );
  const accessResultSet = createAcceptedTypeSet(
    "analysis.swath-access-result",
    [accessResultType],
    "Aligned-binary swath access result frames.",
  );

  return new PluginManifestT(
    SWATH_PLUGIN_ID,
    SWATH_PLUGIN_NAME,
    SWATH_PLUGIN_VERSION,
    PluginFamily.ANALYSIS,
    [
      createMethod(
        "project_footprint",
        "Project Footprint",
        [
          createPort(
            "request",
            "Footprint Requests",
            [footprintRequestSet],
            "State-vector plus sensor-geometry requests for single-epoch footprint projection.",
          ),
        ],
        [
          createPort(
            "results",
            "Footprint Results",
            [footprintResultSet],
            "Aligned-binary footprint vertices projected onto the WGS84 ellipsoid.",
          ),
        ],
        "Projects a sensor field of view onto the ellipsoid and emits the footprint boundary.",
      ),
      createMethod(
        "ground_track",
        "Ground Track",
        [
          createPort(
            "request",
            "Ground Track Requests",
            [groundTrackRequestSet],
            "Aligned-binary state batches for ground-track generation.",
          ),
        ],
        [
          createPort(
            "results",
            "Ground Track Results",
            [groundTrackResultSet],
            "Aligned-binary ground-track samples.",
          ),
        ],
        "Converts ordered state vectors into sub-satellite ground-track samples.",
      ),
      createMethod(
        "generate_swath",
        "Generate Swath",
        [
          createPort(
            "request",
            "Swath Requests",
            [swathRequestSet],
            "Aligned-binary state/sensor batches for time-varying swath generation.",
          ),
        ],
        [
          createPort(
            "results",
            "Swath Results",
            [swathResultSet],
            "Aligned-binary swath segment and vertex output.",
          ),
        ],
        "Generates left/right swath edges and segment metadata for an ordered ephemeris.",
      ),
      createMethod(
        "point_in_footprint",
        "Point In Footprint",
        [
          createPort(
            "request",
            "Containment Requests",
            [containmentRequestSet],
            "Aligned-binary containment requests for a target cartographic point.",
          ),
        ],
        [
          createPort(
            "results",
            "Containment Results",
            [containmentResultSet],
            "Aligned-binary footprint containment results.",
          ),
        ],
        "Tests whether a target cartographic point lies inside the projected sensor footprint.",
      ),
      createMethod(
        "access_geometry",
        "Access Geometry",
        [
          createPort(
            "request",
            "Access Requests",
            [accessRequestSet],
            "Aligned-binary access geometry requests for a target cartographic point.",
          ),
        ],
        [
          createPort(
            "results",
            "Access Results",
            [accessResultSet],
            "Aligned-binary range/elevation/azimuth and visibility results.",
          ),
        ],
        "Computes instantaneous target access geometry relative to the sensor field of view.",
      ),
    ],
    [],
    [],
    [],
    [
      footprintRequestType,
      footprintResultType,
      groundTrackRequestType,
      groundTrackResultType,
      swathRequestType,
      swathResultType,
      containmentRequestType,
      containmentResultType,
      accessRequestType,
      accessResultType,
    ],
    [
      new BuildArtifactT(
        "swath-runtime",
        "wasm",
        "dist/isomorphic/module.wasm",
        "browser,wasmedge",
        null,
      ),
    ],
    1,
    [InvokeSurface.DIRECT],
    ["browser", "wasmedge"],
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
  const manifest = options.manifest ?? createSwathPluginManifest();
  const legacyMetadata = createLegacyMetadata(manifest, {
    encrypted: options.encrypted,
    requiresProtection: options.requiresProtection,
  });

  return {
    pluginId: legacyMetadata.id,
    name: legacyMetadata.name,
    version: legacyMetadata.version,
    type: legacyMetadata.type,
    encrypted: legacyMetadata.encrypted,
    requiresProtection: legacyMetadata.requiresProtection,
    description: SWATH_PLUGIN_DESCRIPTION,
    methods: Array.isArray(manifest.methods)
      ? manifest.methods.map((method) => ({
          methodId: method.methodId,
          name: method.name,
          inputs: method.inputPorts?.map((port) => port.portId) ?? [],
          outputs: method.outputPorts?.map((port) => port.portId) ?? [],
        }))
      : [],
  };
}

export default createSwathPluginManifest;
