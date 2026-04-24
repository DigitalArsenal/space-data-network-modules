export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface StateVectorLike {
  julianDate: number;
  position: Vector3Like;
  velocity: Vector3Like;
}

export interface CartographicTarget {
  longitude: number;
  latitude: number;
  altitude?: number;
}

export interface SwathSensorConfig {
  sensorType?: "conical" | "rectangular" | "custom";
  halfAngleRad?: number;
  alongTrackFovRad?: number;
  crossTrackFovRad?: number;
  angularResolutionRad?: number;
  rollRad?: number;
  pitchRad?: number;
  yawRad?: number;
  minRangeM?: number;
  maxRangeM?: number;
  minElevationRad?: number;
  maxElevationRad?: number;
  customDirections?: Array<Vector3Like>;
  maxVerticesPerSide?: number;
}

export interface SwathRuntimeOptions {
  maxVerticesPerSide?: number;
}

export interface SwathFootprintVertex {
  longitude: number;
  latitude: number;
  altitude: number;
  julianDate: number;
  groundRange: number;
  lookAngle: number;
  flags: number;
  vertexIndex: number;
}

export interface SwathGroundTrackPoint {
  julianDate: number;
  longitude: number;
  latitude: number;
  altitude: number;
  heading: number;
  speed: number;
  flags: number;
}

export interface SwathAccessGeometry {
  range: number;
  elevation: number;
  azimuth: number;
  slantRange: number;
  lookAngle: number;
  isVisible: boolean;
  isOccluded: boolean;
}

export interface SwathSegment {
  startTime: number;
  endTime: number;
  centerLon: number;
  centerLat: number;
  leftVertexStart: number;
  leftVertexCount: number;
  rightVertexStart: number;
  rightVertexCount: number;
  leftVertices: SwathFootprintVertex[];
  rightVertices: SwathFootprintVertex[];
}

export interface SwathResult {
  segments: SwathSegment[];
  vertices: SwathFootprintVertex[];
  groundTrack: SwathGroundTrackPoint[];
}

export interface PluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly encrypted: boolean;
  readonly requiresProtection: boolean;
}

export interface SwathLoadOptions {
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

export interface SwathAnalyzer {
  readonly type: "Analysis";
  readonly name: string;
  readonly version: string;
  readonly metadata: PluginMetadata;
  readonly manifest: unknown;
  readonly manifestSource: string;
  readonly module: any;
  readonly supportsStreamInvoke: boolean;

  streamInvoke(invocation: StreamMethodInvocation): StreamMethodResult;
  computeLVLHFrame(state: StateVectorLike): {
    radial: Vector3Like;
    alongTrack: Vector3Like;
    crossTrack: Vector3Like;
    nadir: Vector3Like;
  };
  projectRayToEllipsoid(ray: { origin: Vector3Like; direction: Vector3Like }): {
    hit: boolean;
    position?: Vector3Like;
    cartographic?: CartographicTarget;
    distance?: number;
  };
  computeFootprint(
    state: StateVectorLike,
    sensor: SwathSensorConfig,
  ): { vertices: SwathFootprintVertex[] };
  computeGroundTrack(states: StateVectorLike[]): SwathGroundTrackPoint[];
  pointInFootprint(
    state: StateVectorLike,
    sensor: SwathSensorConfig,
    target: CartographicTarget,
  ): boolean;
  computeAccessGeometry(
    state: StateVectorLike,
    sensor: SwathSensorConfig,
    target: CartographicTarget,
  ): SwathAccessGeometry;
  computeSwath(
    states: StateVectorLike[],
    sensor: SwathSensorConfig,
    options?: SwathRuntimeOptions,
  ): SwathResult;
  destroy(): void;
}

export function loadSwathPlugin(
  options?: SwathLoadOptions,
): Promise<SwathAnalyzer>;
export function createSwathAnalyzer(
  options?: SwathLoadOptions,
): Promise<SwathAnalyzer>;
export function getSwathManifest(module?: any): unknown;
export function createSwathFlowMethodHandlers(
  analyzer: SwathAnalyzer,
): Record<string, FlowMethodHandler>;
export const metadata: PluginMetadata;
export default createSwathAnalyzer;
