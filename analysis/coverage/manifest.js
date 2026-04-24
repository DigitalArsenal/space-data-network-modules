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

export const COVERAGE_PLUGIN_ID = "com.orbpro.coverage";
export const COVERAGE_PLUGIN_NAME = "Coverage Analysis";
export const COVERAGE_PLUGIN_VERSION = "1.0.0";
export const COVERAGE_PLUGIN_DESCRIPTION =
  "Analytical ground-grid coverage accumulation, figure-of-merit computation, interval tracking, and heatmap generation.";

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

export function createCoveragePluginManifest() {
  const gridConfigType = createTypeRef(
    "orbpro.analysis.CoverageGridConfig",
    "CVGC",
  );
  const gridInfoType = createTypeRef(
    "orbpro.analysis.CoverageGridInfo",
    "CVGI",
  );
  const footprintBatchType = createTypeRef(
    "orbpro.analysis.CoverageFootprintBatch",
    "CVFB",
  );
  const statisticsType = createTypeRef(
    "orbpro.analysis.CoverageStatisticsResult",
    "CVST",
  );
  const intervalsType = createTypeRef(
    "orbpro.analysis.CoverageIntervalsResult",
    "CVIR",
  );
  const fomType = createTypeRef("orbpro.analysis.CoverageFomResult", "CVFR");
  const heatmapType = createTypeRef(
    "orbpro.analysis.CoverageHeatmapResult",
    "CVHR",
  );
  const unionType = createTypeRef(
    "orbpro.analysis.CoverageUnionResult",
    "CVUR",
  );

  const gridConfigSet = createAcceptedTypeSet(
    "analysis.coverage-grid-config",
    [gridConfigType],
    "Aligned-binary analytical coverage grid configuration frames.",
  );
  const gridInfoSet = createAcceptedTypeSet(
    "analysis.coverage-grid-info",
    [gridInfoType],
    "Aligned-binary analytical coverage grid metadata frames.",
  );
  const footprintBatchSet = createAcceptedTypeSet(
    "analysis.coverage-footprint-batch",
    [footprintBatchType],
    "Aligned-binary analytical coverage footprint accumulation frames.",
  );
  const statisticsSet = createAcceptedTypeSet(
    "analysis.coverage-statistics",
    [statisticsType],
    "Aligned-binary analytical coverage statistics frames.",
  );
  const intervalsSet = createAcceptedTypeSet(
    "analysis.coverage-intervals",
    [intervalsType],
    "Aligned-binary analytical coverage interval frames.",
  );
  const fomSet = createAcceptedTypeSet(
    "analysis.coverage-fom",
    [fomType],
    "Aligned-binary analytical coverage figure-of-merit frames.",
  );
  const heatmapSet = createAcceptedTypeSet(
    "analysis.coverage-heatmap",
    [heatmapType],
    "Aligned-binary analytical coverage heatmap frames.",
  );
  const unionSet = createAcceptedTypeSet(
    "analysis.coverage-union",
    [unionType],
    "Aligned-binary analytical coverage union-analysis frames.",
  );

  return new PluginManifestT(
    COVERAGE_PLUGIN_ID,
    COVERAGE_PLUGIN_NAME,
    COVERAGE_PLUGIN_VERSION,
    PluginFamily.ANALYSIS,
    [
      createMethod(
        "create_grid",
        "Create Grid",
        [
          createPort(
            "grid",
            "Grid Config",
            [gridConfigSet],
            "Aligned-binary analytical coverage grid configuration.",
          ),
        ],
        [
          createPort(
            "results",
            "Grid Info",
            [gridInfoSet],
            "Aligned-binary analytical coverage grid metadata.",
          ),
        ],
        "Creates a coverage grid for subsequent analytical accumulation.",
      ),
      createMethod(
        "accumulate_footprints",
        "Accumulate Footprints",
        [
          createPort(
            "footprints",
            "Footprint Batches",
            [footprintBatchSet],
            "Aligned-binary footprint polygons and time windows for grid accumulation.",
          ),
        ],
        [],
        "Accumulates explicit footprint polygons into the analytical coverage grid.",
        {
          maxBatch: 1024,
          drainPolicy: DrainPolicy.DRAIN_TO_EMPTY,
        },
      ),
      createMethod(
        "get_statistics",
        "Get Statistics",
        [
          createPort(
            "grid",
            "Grid Query",
            [gridInfoSet],
            "Aligned-binary grid-id query frames.",
          ),
        ],
        [
          createPort(
            "results",
            "Statistics",
            [statisticsSet],
            "Aligned-binary analytical coverage statistics.",
          ),
        ],
        "Returns aggregate analytical coverage statistics for a grid.",
      ),
      createMethod(
        "get_access_intervals",
        "Get Access Intervals",
        [
          createPort(
            "cell",
            "Cell Query",
            [gridInfoSet],
            "Aligned-binary cell query frames containing grid id and cell index.",
          ),
        ],
        [
          createPort(
            "results",
            "Intervals",
            [intervalsSet],
            "Aligned-binary analytical coverage interval output.",
          ),
        ],
        "Returns the merged access intervals for a specific analytical coverage cell.",
      ),
      createMethod(
        "compute_fom",
        "Compute FOM",
        [
          createPort(
            "grid",
            "FOM Query",
            [gridInfoSet],
            "Aligned-binary FOM query frames containing grid id and FOM id.",
          ),
        ],
        [
          createPort(
            "results",
            "FOM Values",
            [fomSet],
            "Aligned-binary analytical coverage figure-of-merit values.",
          ),
        ],
        "Computes a figure of merit across all analytical coverage cells.",
      ),
      createMethod(
        "generate_heatmap",
        "Generate Heatmap",
        [
          createPort(
            "heatmap",
            "Heatmap Request",
            [heatmapSet],
            "Aligned-binary analytical coverage heatmap request frames.",
          ),
        ],
        [
          createPort(
            "results",
            "Heatmap Output",
            [heatmapSet],
            "Aligned-binary RGBA heatmap output.",
          ),
        ],
        "Generates an RGBA heatmap from analytical coverage cell values.",
      ),
      createMethod(
        "analyze_sensor_union",
        "Analyze Sensor Union",
        [
          createPort(
            "union",
            "Union Request",
            [unionSet],
            "Aligned-binary sensor union request frames.",
          ),
        ],
        [
          createPort(
            "results",
            "Union Output",
            [unionSet],
            "Aligned-binary analytical coverage union-analysis output.",
          ),
        ],
        "Computes coverage overlap and gap metrics for a selected sensor set.",
      ),
    ],
    [],
    [],
    [],
    [
      gridConfigType,
      gridInfoType,
      footprintBatchType,
      statisticsType,
      intervalsType,
      fomType,
      heatmapType,
      unionType,
    ],
    [
      new BuildArtifactT(
        "coverage-runtime",
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
  const manifest = options.manifest ?? createCoveragePluginManifest();
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
    description: COVERAGE_PLUGIN_DESCRIPTION,
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

export default createCoveragePluginManifest;
