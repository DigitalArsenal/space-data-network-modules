export interface AccessStateVector {
  julianDate?: number;
  jd?: number;
  position?: {
    x?: number;
    y?: number;
    z?: number;
    [key: string]: unknown;
  };
  ecef?: {
    x?: number;
    y?: number;
    z?: number;
    [key: string]: unknown;
  };
  velocity?: {
    x?: number;
    y?: number;
    z?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AccessBlackoutWindow {
  startJulianDate: number;
  endJulianDate: number;
}

export type AccessRefractionModelName =
  | "earth-standard-atmosphere"
  | "orekit-earth-standard-atmosphere"
  | "EarthStandardAtmosphereRefraction"
  | "itu-r-p834"
  | "itu-r-p.834"
  | "orekit-itu-r-p834"
  | "iturp834"
  | "ITURP834AtmosphericRefraction";

export interface AccessRefractionModelOptions {
  type?: AccessRefractionModelName | string;
  model?: AccessRefractionModelName | string;
  name?: AccessRefractionModelName | string;
  pressurePa?: number;
  pressure?: number;
  localPressurePa?: number;
  temperatureK?: number;
  temperature?: number;
  localTemperatureK?: number;
  stationAltitudeM?: number;
  altitudeM?: number;
  altitude?: number;
  [key: string]: unknown;
}

export type AccessElevationMaskPoint =
  | [number, number]
  | {
      azimuthDeg?: number;
      elevationDeg?: number;
      azimuthRad?: number;
      elevationRad?: number;
      azimuth?: number;
      elevation?: number;
      [key: string]: unknown;
    };

export interface AccessComputeOptions {
  minElevationDeg?: number;
  minElevationRad?: number;
  assetId?: string | number;
  afterJulianDate?: number;
  afterJd?: number;
  elevationMaskDeg?: AccessElevationMaskPoint[];
  elevationMaskRad?: AccessElevationMaskPoint[];
  elevationMask?: AccessElevationMaskPoint[];
  refractionModel?: boolean | "none" | AccessRefractionModelName | AccessRefractionModelOptions;
  refraction?: boolean | "none" | AccessRefractionModelName | AccessRefractionModelOptions;
  atmosphericRefraction?: boolean | "none" | AccessRefractionModelName | AccessRefractionModelOptions;
  [key: string]: unknown;
}

export interface AccessWindowRequest {
  states?: AccessStateVector[];
  stationId?: string | number;
  options?: AccessComputeOptions;
  [key: string]: unknown;
}

export interface AccessWindowResult {
  stationId: string;
  assetId?: string;
  startJulianDate: number;
  endJulianDate: number;
  durationSeconds: number;
  maxElevationRad: number;
  sampleCount: number;
}

export interface AccessContactCandidate {
  stationId: string | number;
  assetId?: string | number;
  startJulianDate: number;
  endJulianDate: number;
  priority?: number;
  score?: number;
  [key: string]: unknown;
}

export interface ScheduledContact {
  stationId: string;
  assetId: string;
  startJulianDate: number;
  endJulianDate: number;
  durationSeconds: number;
  channelIndex?: number;
}

export interface AccessGeometryResult {
  stationId: string;
  rangeM: number;
  elevationRad: number;
  azimuthRad: number;
  lineOfSightVector: {
    x: number;
    y: number;
    z: number;
  };
  minElevationRad: number;
  refractionRad: number;
  apparentElevationRad: number;
  visible: boolean;
}

export interface AccessGroundStation {
  id?: string | number;
  stationId?: string | number;
  name?: string;
  latitudeDeg?: number;
  longitudeDeg?: number;
  latitudeRad?: number;
  longitudeRad?: number;
  altitudeM?: number;
  minElevationDeg?: number;
  minElevationRad?: number;
  channelCapacity?: number;
  blackoutWindows?: AccessBlackoutWindow[];
  [key: string]: unknown;
}

export interface AccessStoredGroundStation {
  id: string;
  name: string;
  latitudeRad: number;
  longitudeRad: number;
  altitudeM: number;
  minElevationRad: number;
  channelCapacity: number;
  blackoutWindows: AccessBlackoutWindow[];
}

export interface PluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly encrypted: boolean;
  readonly requiresProtection: boolean;
}

export interface AccessRuntimeModule {
  runtime: "access-wasm";
  HEAPU8: Uint8Array;
  _plugin_init?: () => number;
  _plugin_destroy?: () => void;
  _access_reset_ground_stations: () => number;
  _access_add_ground_station: (recordPtr: number, recordSize: number) => number;
  _access_set_ground_station_blackouts?: (
    stationIndex: number,
    blackoutPtr: number,
    blackoutCount: number,
  ) => number;
  _access_get_ground_station_count: () => number;
  _access_get_ground_station_record: (
    stationIndex: number,
    recordPtr: number,
    recordSize: number,
  ) => number;
  _access_get_ground_station_blackout_count?: (stationIndex: number) => number;
  _access_get_ground_station_blackout_record?: (
    stationIndex: number,
    blackoutIndex: number,
    recordPtr: number,
    recordSize: number,
  ) => number;
  _access_compute_access_windows: (
    statePtr: number,
    stateCount: number,
    stationIndex: number,
    minElevationRad: number,
    outWindowCountPtr: number,
  ) => number;
  _access_compute_access_windows_with_elevation_mask?: (
    statePtr: number,
    stateCount: number,
    stationIndex: number,
    maskPtr: number,
    maskPointCount: number,
    outWindowCountPtr: number,
  ) => number;
  _access_compute_access_windows_with_effects?: (
    statePtr: number,
    stateCount: number,
    stationIndex: number,
    minElevationRad: number,
    maskPtr: number,
    maskPointCount: number,
    refractionModelPtr: number,
    outWindowCountPtr: number,
  ) => number;
  _access_schedule_contacts: (
    candidatePtr: number,
    candidateCount: number,
    outScheduledCountPtr: number,
  ) => number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  [key: string]: unknown;
}

export interface AccessAnalyzer {
  readonly type: "Analysis";
  readonly name: string;
  readonly version: string;
  readonly metadata: PluginMetadata;
  readonly manifest: unknown;
  readonly manifestSource: string;
  readonly module: AccessRuntimeModule;
  readonly supportsStreamInvoke: boolean;
  addGroundStation(station: AccessGroundStation): string;
  listGroundStations(): AccessStoredGroundStation[];
  computeAccessGeometry(
    state: AccessStateVector,
    stationId?: string | number,
    options?: AccessComputeOptions,
  ): AccessGeometryResult;
  computeAccessWindows(
    states?: AccessStateVector[],
    stationId?: string | number,
    options?: AccessComputeOptions,
  ): AccessWindowResult[];
  computeAllAccessWindows(
    states?: AccessStateVector[],
    options?: AccessComputeOptions,
  ): AccessWindowResult[];
  predictAos(
    states?: AccessStateVector[],
    stationId?: string | number,
    options?: AccessComputeOptions,
  ): number | null;
  predictLos(
    states?: AccessStateVector[],
    stationId?: string | number,
    options?: AccessComputeOptions,
  ): number | null;
  scheduleContacts(windows?: AccessContactCandidate[]): ScheduledContact[];
  destroy(): void;
}

export interface AccessLoadOptions {
  wasmBinary?: Uint8Array | ArrayBuffer;
  wasmUrl?: string;
  requireEmbeddedManifest?: boolean;
  [key: string]: unknown;
}

export interface FlowInvocationFrame {
  payload?: unknown;
  payloadBytes?: Uint8Array;
  bytes?: Uint8Array;
  data?: Uint8Array;
  [key: string]: unknown;
}

export interface FlowMethodInvocation {
  inputs: FlowInvocationFrame[];
}

export interface FlowMethodResult {
  outputs: FlowInvocationFrame[];
  backlogRemaining: number;
  yielded: boolean;
}

export type FlowMethodHandler = (
  invocation: FlowMethodInvocation,
) => FlowMethodResult | Promise<FlowMethodResult>;

export function createAccessFlowMethodHandlers(analyzer: AccessAnalyzer): {
  compute_access_windows: FlowMethodHandler;
};

export function getAccessManifest(): unknown;

export function createAccessAnalyzer(
  options?: AccessLoadOptions,
): Promise<AccessAnalyzer>;

export const loadAccessPlugin: typeof createAccessAnalyzer;

export const metadata: PluginMetadata;

export default createAccessAnalyzer;
