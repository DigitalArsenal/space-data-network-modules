export interface CoverageGridConfig {
  minLatitudeDeg: number;
  maxLatitudeDeg: number;
  minLongitudeDeg: number;
  maxLongitudeDeg: number;
  latitudeStepDeg?: number;
  longitudeStepDeg?: number;
  latitudeResolutionDeg?: number;
  longitudeResolutionDeg?: number;
  startEpochJd: number;
  endEpochJd: number;
}

export interface CoverageFootprintVertex {
  latDeg: number;
  lonDeg: number;
}

export interface CoverageFootprintRecord {
  sensorId: number;
  startEpochJd: number;
  endEpochJd: number;
  vertices: CoverageFootprintVertex[];
}

export interface CoverageGridInfo {
  gridId: number;
  rowCount: number;
  columnCount: number;
  cellCount: number;
  config: CoverageGridConfig;
}

export interface CoverageCell {
  firstAccessTime: number | null;
  lastAccessTime: number | null;
  totalAccessDuration: number;
  minRevisitTime: number;
  maxRevisitTime: number;
  sumRevisitTime: number;
  accessCount: number;
  revisitCount: number;
  flags: number;
  sensorMask: bigint;
}

export interface CoverageAccessInterval {
  startTime: number;
  endTime: number;
  duration: number;
  flags: number;
}

export interface CoverageStatistics {
  totalCells: number;
  accessedCells: number;
  multiAccessCells: number;
  percentCoverage: number;
  meanAccessCount: number;
  meanRevisitTime: number;
  minRevisitTime: number;
  maxRevisitTime: number;
  meanGapDuration: number;
  maxGapDuration: number;
  totalAccessTime: number;
}

export interface CoverageHeatmap {
  width: number;
  height: number;
  minValue: number;
  maxValue: number;
  pixels: Uint8Array;
}

export interface CoverageUnionResult {
  unionCoveredCells: number;
  fullyCoveredCells: number;
  partialCoverageCells: number;
  gapCells: number;
  meanSensorsPerCoveredCell: number;
  maxGapDurationSec: number;
}

export interface CoverageMinimumSensorSetResult {
  selectedSensorIds: number[];
  candidateSensorIds: number[];
  requiredCellCount: number;
  coveredCellCount: number;
  uncoveredCellCount: number;
  coverageComplete: boolean;
  coverageFraction: number;
  iterations: number;
}

export interface CoverageAccumulationSummary {
  footprintCount: number;
  affectedCells: number;
  accessedCellCount: number;
  updatedIntervals: number;
}

export interface PluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly encrypted: boolean;
  readonly requiresProtection: boolean;
}

export interface CoverageAnalyzerLoadOptions {
  decryptFn?: (
    encrypted: Uint8Array,
  ) => Promise<{ data?: Uint8Array; error?: string | null }>;
  requireEmbeddedManifest?: boolean;
}

export interface FlowInvocationFrame {
  payload?: any;
  payloadBytes?: Uint8Array;
  bytes?: Uint8Array;
  data?: Uint8Array;
  [key: string]: any;
}

export interface FlowMethodInvocation {
  inputs: FlowInvocationFrame[];
}

export interface FlowMethodResult {
  outputs: FlowInvocationFrame[];
  backlogRemaining: number;
  yielded: boolean;
}

export interface StreamMethodFrame {
  portId?: string;
  typeRef?: {
    schemaName?: string | null;
    fileIdentifier?: string | null;
    schemaHash?: number[];
    acceptsAnyFlatbuffer?: boolean;
  };
  alignment?: number;
  streamId?: number;
  sequence?: bigint | number;
  traceToken?: bigint | number;
  endOfStream?: boolean;
  bytes?: Uint8Array;
  payloadBytes?: Uint8Array;
  data?: Uint8Array;
  payload?: Uint8Array;
}

export interface StreamMethodInvocation {
  methodId: string;
  inputs?: StreamMethodFrame[];
  outputStreamCap?: number;
}

export interface StreamMethodResultFrame extends StreamMethodFrame {
  offset?: number;
  size?: number;
  ownership?: string;
  generation?: number;
  mutability?: string;
}

export interface StreamMethodResult {
  statusCode: number;
  outputs: StreamMethodResultFrame[];
  backlogRemaining: number;
  yielded: boolean;
  errorMessage?: string | null;
}

export type FlowMethodHandler = (
  invocation: FlowMethodInvocation,
) => FlowMethodResult | Promise<FlowMethodResult>;

export interface CoverageAnalyzer {
  readonly type: "Analysis";
  readonly name: string;
  readonly version: string;
  readonly metadata: PluginMetadata;
  readonly manifest: unknown;
  readonly manifestSource: string;
  readonly module: any;
  readonly supportsStreamInvoke: boolean;

  streamInvoke(invocation: StreamMethodInvocation): StreamMethodResult;
  createGrid(config: CoverageGridConfig): CoverageGridInfo;
  destroyGrid(gridId: number): void;
  resetGrid(gridId: number): void;
  getCellIndex(
    gridId: number,
    latitudeDeg: number,
    longitudeDeg: number,
  ): number;
  accumulateFootprints(
    gridId: number,
    footprints: CoverageFootprintRecord[],
  ): CoverageAccumulationSummary;
  accumulateSwath?(
    gridId: number,
    states: Array<Record<string, any>>,
    sensorConfig: Record<string, any>,
    options?: Record<string, any>,
  ): Promise<CoverageAccumulationSummary>;
  getCellData(gridId: number, cellIndex: number): CoverageCell;
  getGridData(gridId: number): CoverageCell[];
  getAccessIntervals(
    gridId: number,
    cellIndex: number,
  ): CoverageAccessInterval[];
  getStatistics(gridId: number): CoverageStatistics;
  computeFom(gridId: number, fomType: string): Float64Array;
  analyzeSensorUnion(
    gridId: number,
    options?: { sensorIds?: number[] },
  ): CoverageUnionResult;
  computeMinimumSensorSet(
    gridId: number,
    options?: {
      sensorIds?: number[];
      cellIndices?: number[];
    },
  ): CoverageMinimumSensorSetResult;
  generateHeatmap(
    gridId: number,
    options?: {
      fomType?: string;
      colorMap?: string;
      width?: number;
      height?: number;
      minValue?: number;
      maxValue?: number;
    },
  ): CoverageHeatmap;
  destroy(): void;
}

export function loadCoveragePlugin(
  options?: CoverageAnalyzerLoadOptions,
): Promise<CoverageAnalyzer>;
export function createCoverageAnalyzer(
  options?: CoverageAnalyzerLoadOptions,
): Promise<CoverageAnalyzer>;
export function getCoverageManifest(module?: any): unknown;
export function createCoverageFlowMethodHandlers(
  analyzer: CoverageAnalyzer,
): Record<string, FlowMethodHandler>;
export const metadata: PluginMetadata;
export default createCoverageAnalyzer;
