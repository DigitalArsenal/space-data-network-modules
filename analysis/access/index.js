import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createAccessPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { createAccessFlowMethodHandlers as createAccessFlowMethodHandlersRuntime } from "./flowHandlers.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createAccessPluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});
const GROUND_STATION_RECORD_SIZE = 168;
const BLACKOUT_RECORD_SIZE = 16;
const STATE_RECORD_SIZE = 32;
const ACCESS_WINDOW_RECORD_SIZE = 32;
const SCHEDULE_WINDOW_RECORD_SIZE = 40;
const SCHEDULE_RESULT_RECORD_SIZE = 24;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.6943799901413165e-3;
const TEXT_ENCODER =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const TEXT_DECODER =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundDurationSeconds(value) {
  return Math.round(value * 1.0e3) / 1.0e3;
}

function base64ToBytes(base64) {
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(globalThis.Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeFixedString(value, length) {
  const bytes = new Uint8Array(length);
  const text = String(value ?? "");
  if (TEXT_ENCODER) {
    bytes.set(TEXT_ENCODER.encode(text).subarray(0, length - 1));
    return bytes;
  }
  const maxLength = Math.min(text.length, length - 1);
  for (let index = 0; index < maxLength; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function decodeFixedString(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  const slice = bytes.subarray(0, end);
  if (TEXT_DECODER) {
    return TEXT_DECODER.decode(slice);
  }
  let result = "";
  for (let index = 0; index < slice.length; index += 1) {
    result += String.fromCharCode(slice[index]);
  }
  return result;
}

function cloneBytesFromModule(module, pointer, size) {
  const start = Number(pointer) >>> 0;
  const length = Number(size) >>> 0;
  if (start === 0 || length === 0) {
    return new Uint8Array();
  }
  return new Uint8Array(module.HEAPU8.slice(start, start + length));
}

function writeBytesToModule(module, bytes) {
  const pointer = module._malloc(bytes.length || 1);
  if (bytes.length > 0) {
    module.HEAPU8.set(bytes, pointer);
  }
  return pointer;
}

function normalizeBlackoutWindow(window = {}) {
  const startJulianDate = Number(
    window.startJulianDate ?? window.startJd ?? Number.NaN,
  );
  const endJulianDate = Number(
    window.endJulianDate ?? window.endJd ?? Number.NaN,
  );

  if (
    !Number.isFinite(startJulianDate) ||
    !Number.isFinite(endJulianDate) ||
    endJulianDate <= startJulianDate
  ) {
    throw new Error(
      "Access blackout windows require finite start/end Julian dates with end > start.",
    );
  }

  return {
    startJulianDate,
    endJulianDate,
  };
}

function normalizeBlackoutWindows(blackoutWindows = []) {
  return (Array.isArray(blackoutWindows) ? blackoutWindows : [])
    .map(normalizeBlackoutWindow)
    .sort((left, right) => {
      if (left.startJulianDate !== right.startJulianDate) {
        return left.startJulianDate - right.startJulianDate;
      }
      return left.endJulianDate - right.endJulianDate;
    });
}

function encodeBlackoutRecords(blackoutWindows = []) {
  const normalized = normalizeBlackoutWindows(blackoutWindows);
  const bytes = new Uint8Array(normalized.length * BLACKOUT_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  normalized.forEach((window, index) => {
    const offset = index * BLACKOUT_RECORD_SIZE;
    view.setFloat64(offset + 0, window.startJulianDate, true);
    view.setFloat64(offset + 8, window.endJulianDate, true);
  });
  return {
    bytes,
    normalized,
  };
}

function decodeBlackoutRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    startJulianDate: view.getFloat64(0, true),
    endJulianDate: view.getFloat64(8, true),
  };
}

function normalizeGroundStation(station = {}, defaultIndex = 0) {
  const id = String(
    station.id ??
      station.stationId ??
      station.name ??
      `ground-station-${defaultIndex}`,
  );
  const name = String(station.name ?? id);
  const latitudeRad = Number.isFinite(station.latitudeRad)
    ? Number(station.latitudeRad)
    : degreesToRadians(Number(station.latitudeDeg ?? 0.0));
  const longitudeRad = Number.isFinite(station.longitudeRad)
    ? Number(station.longitudeRad)
    : degreesToRadians(Number(station.longitudeDeg ?? 0.0));
  const altitudeM = Number(station.altitudeM ?? 0.0);
  const minElevationRad = Number.isFinite(station.minElevationRad)
    ? Number(station.minElevationRad)
    : degreesToRadians(Number(station.minElevationDeg ?? 0.0));
  const channelCapacity = Math.max(1, Number(station.channelCapacity ?? 1));
  const blackoutWindows = normalizeBlackoutWindows(station.blackoutWindows);

  if (
    !Number.isFinite(latitudeRad) ||
    !Number.isFinite(longitudeRad) ||
    !Number.isFinite(altitudeM) ||
    !Number.isFinite(minElevationRad) ||
    !Number.isFinite(channelCapacity)
  ) {
    throw new Error("Access ground station fields must be finite numbers.");
  }

  return {
    id,
    name,
    latitudeRad,
    longitudeRad,
    altitudeM,
    minElevationRad,
    channelCapacity,
    blackoutWindows,
  };
}

function encodeGroundStationRecord(station) {
  const bytes = new Uint8Array(GROUND_STATION_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, station.latitudeRad, true);
  view.setFloat64(8, station.longitudeRad, true);
  view.setFloat64(16, station.altitudeM, true);
  view.setFloat64(24, station.minElevationRad, true);
  view.setUint32(32, station.channelCapacity, true);
  view.setUint32(36, 0, true);
  bytes.set(encodeFixedString(station.id, 64), 40);
  bytes.set(encodeFixedString(station.name, 64), 104);
  return bytes;
}

function decodeGroundStationRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: decodeFixedString(bytes.subarray(40, 104)),
    name: decodeFixedString(bytes.subarray(104, 168)),
    latitudeRad: view.getFloat64(0, true),
    longitudeRad: view.getFloat64(8, true),
    altitudeM: view.getFloat64(16, true),
    minElevationRad: view.getFloat64(24, true),
    channelCapacity: view.getUint32(32, true),
  };
}

function normalizeState(state = {}) {
  const julianDate = Number(
    state.julianDate ?? state.jd ?? state.timeJulianDate ?? Number.NaN,
  );
  const position = state.position ?? state.ecef ?? state.positionEcef ?? {};
  const x = Number(position.x ?? position[0] ?? Number.NaN);
  const y = Number(position.y ?? position[1] ?? Number.NaN);
  const z = Number(position.z ?? position[2] ?? Number.NaN);
  const velocity = state.velocity ?? state.velocityEcef ?? {};
  const vx = Number(velocity.x ?? velocity[0] ?? 0.0);
  const vy = Number(velocity.y ?? velocity[1] ?? 0.0);
  const vz = Number(velocity.z ?? velocity[2] ?? 0.0);

  if (
    !Number.isFinite(julianDate) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(vx) ||
    !Number.isFinite(vy) ||
    !Number.isFinite(vz)
  ) {
    throw new Error(
      "Access states require finite julianDate, ECEF position, and velocity components.",
    );
  }

  return { julianDate, x, y, z, vx, vy, vz };
}

function encodeStateRecords(states = []) {
  const normalizedStates = states.map(normalizeState);
  const bytes = new Uint8Array(normalizedStates.length * STATE_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  normalizedStates.forEach((state, index) => {
    const offset = index * STATE_RECORD_SIZE;
    view.setFloat64(offset + 0, state.julianDate, true);
    view.setFloat64(offset + 8, state.x, true);
    view.setFloat64(offset + 16, state.y, true);
    view.setFloat64(offset + 24, state.z, true);
  });
  return {
    bytes,
    normalizedStates,
  };
}

function normalizeMinElevationOption(options = {}) {
  if (Number.isFinite(options.minElevationRad)) {
    return Number(options.minElevationRad);
  }
  if (Number.isFinite(options.minElevationDeg)) {
    return degreesToRadians(Number(options.minElevationDeg));
  }
  return Number.NaN;
}

function decodeAccessWindowRecords(bytes, stationId, options = {}) {
  const windows = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let offset = 0;
    offset + ACCESS_WINDOW_RECORD_SIZE <= bytes.byteLength;
    offset += ACCESS_WINDOW_RECORD_SIZE
  ) {
    const startJulianDate = view.getFloat64(offset + 0, true);
    const endJulianDate = view.getFloat64(offset + 8, true);
    const window = {
      stationId,
      startJulianDate,
      endJulianDate,
      durationSeconds: roundDurationSeconds(
        (endJulianDate - startJulianDate) * 86400.0,
      ),
      maxElevationRad: view.getFloat64(offset + 16, true),
      sampleCount: view.getUint32(offset + 24, true),
    };
    if (options.assetId !== undefined) {
      window.assetId = String(options.assetId);
    }
    windows.push(window);
  }
  return windows;
}

function normalizeScheduleCandidate(window = {}, sourceIndex = 0) {
  const stationId = String(window.stationId ?? "");
  const assetId = String(window.assetId ?? `candidate-${sourceIndex}`);
  const startJulianDate = Number(window.startJulianDate ?? Number.NaN);
  const endJulianDate = Number(window.endJulianDate ?? Number.NaN);
  const priority = Number(window.priority ?? 0.0);
  const score = Number(window.score ?? 0.0);

  if (
    stationId.length === 0 ||
    !Number.isFinite(startJulianDate) ||
    !Number.isFinite(endJulianDate) ||
    endJulianDate <= startJulianDate ||
    !Number.isFinite(priority) ||
    !Number.isFinite(score)
  ) {
    throw new Error(
      "Scheduled contact windows require stationId, finite start/end times, and finite priority/score values.",
    );
  }

  return {
    stationId,
    assetId,
    startJulianDate,
    endJulianDate,
    priority,
    score,
    sourceIndex,
  };
}

function encodeScheduleWindowRecords(candidates, resolveGroundStationIndex) {
  const normalized = candidates.map(normalizeScheduleCandidate);
  const stableSorted = [...normalized].sort((left, right) => {
    if (left.stationId !== right.stationId) {
      return left.stationId.localeCompare(right.stationId);
    }
    if (left.assetId !== right.assetId) {
      return left.assetId.localeCompare(right.assetId);
    }
    if (left.startJulianDate !== right.startJulianDate) {
      return left.startJulianDate - right.startJulianDate;
    }
    if (left.endJulianDate !== right.endJulianDate) {
      return left.endJulianDate - right.endJulianDate;
    }
    return left.sourceIndex - right.sourceIndex;
  });
  const bySortIndex = [];
  const bytes = new Uint8Array(
    stableSorted.length * SCHEDULE_WINDOW_RECORD_SIZE,
  );
  const view = new DataView(bytes.buffer);

  stableSorted.forEach((candidate, sortIndex) => {
    const stationIndex = resolveGroundStationIndex(candidate.stationId);
    bySortIndex[sortIndex] = candidate;
    const offset = sortIndex * SCHEDULE_WINDOW_RECORD_SIZE;
    view.setFloat64(offset + 0, candidate.startJulianDate, true);
    view.setFloat64(offset + 8, candidate.endJulianDate, true);
    view.setFloat64(offset + 16, candidate.priority, true);
    view.setFloat64(offset + 24, candidate.score, true);
    view.setUint32(offset + 32, stationIndex, true);
    view.setUint32(offset + 36, sortIndex, true);
  });

  return {
    bytes,
    bySortIndex,
  };
}

function decodeScheduledContactRecords(bytes, bySortIndex) {
  const scheduled = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let offset = 0;
    offset + SCHEDULE_RESULT_RECORD_SIZE <= bytes.byteLength;
    offset += SCHEDULE_RESULT_RECORD_SIZE
  ) {
    const startJulianDate = view.getFloat64(offset + 0, true);
    const endJulianDate = view.getFloat64(offset + 8, true);
    const sortIndex = view.getUint32(offset + 16, true);
    const source = bySortIndex[sortIndex];
    if (!source) {
      continue;
    }
    scheduled.push({
      stationId: source.stationId,
      assetId: source.assetId,
      startJulianDate,
      endJulianDate,
      durationSeconds: roundDurationSeconds(
        (endJulianDate - startJulianDate) * 86400.0,
      ),
    });
  }
  return scheduled;
}

function geodeticToEcef(latitudeRad, longitudeRad, altitudeM) {
  const sinLat = Math.sin(latitudeRad);
  const cosLat = Math.cos(latitudeRad);
  const sinLon = Math.sin(longitudeRad);
  const cosLon = Math.cos(longitudeRad);
  const primeVertical = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (primeVertical + altitudeM) * cosLat * cosLon,
    y: (primeVertical + altitudeM) * cosLat * sinLon,
    z: (primeVertical * (1.0 - WGS84_E2) + altitudeM) * sinLat,
  };
}

function computeEnuAxes(latitudeRad, longitudeRad) {
  const sinLat = Math.sin(latitudeRad);
  const cosLat = Math.cos(latitudeRad);
  const sinLon = Math.sin(longitudeRad);
  const cosLon = Math.cos(longitudeRad);
  return {
    east: { x: -sinLon, y: cosLon, z: 0.0 },
    north: {
      x: -sinLat * cosLon,
      y: -sinLat * sinLon,
      z: cosLat,
    },
    up: {
      x: cosLat * cosLon,
      y: cosLat * sinLon,
      z: sinLat,
    },
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function computeAccessGeometryFromState(state, station) {
  const stationEcef = geodeticToEcef(
    station.latitudeRad,
    station.longitudeRad,
    station.altitudeM,
  );
  const axes = computeEnuAxes(station.latitudeRad, station.longitudeRad);
  const rangeVector = subtract(state, stationEcef);
  const rangeM = magnitude(rangeVector);
  if (!(rangeM > 0.0)) {
    return {
      stationId: station.id,
      rangeM: 0.0,
      elevationRad: -Math.PI * 0.5,
      azimuthRad: 0.0,
      lineOfSightVector: rangeVector,
      visible: false,
    };
  }

  const east = dot(rangeVector, axes.east);
  const north = dot(rangeVector, axes.north);
  const up = dot(rangeVector, axes.up);
  const elevationRad = Math.asin(clamp(up / rangeM, -1.0, 1.0));
  const azimuthRad = Math.atan2(east, north);

  return {
    stationId: station.id,
    rangeM,
    elevationRad,
    azimuthRad,
    lineOfSightVector: rangeVector,
    visible: elevationRad >= station.minElevationRad,
  };
}

function attachEmbeddedManifestMetadata(module) {
  if (!module) {
    return STATIC_MANIFEST;
  }

  if (!module.__orbproEmbeddedManifest) {
    const embeddedManifest = readEmbeddedPluginManifest(module, {
      bytesSymbol: "access_plugin_manifest_bytes",
      sizeSymbol: "access_plugin_manifest_size",
    });
    module.__orbproEmbeddedManifest = STATIC_MANIFEST;
    module.__orbproEmbeddedManifestRaw = embeddedManifest ?? null;
    module.__orbproManifestSource = embeddedManifest
      ? EMBEDDED_MANIFEST_SOURCE
      : "static-fallback";
  }

  if (!module.__orbproMetadata) {
    module.__orbproMetadata = createLegacyMetadata(
      module.__orbproEmbeddedManifest,
      {
        encrypted: false,
        requiresProtection: false,
      },
    );
  }

  return module.__orbproEmbeddedManifest;
}

function getResolvedManifestSource(module) {
  attachEmbeddedManifestMetadata(module);
  return module?.__orbproManifestSource ?? "static-fallback";
}

function assertEmbeddedManifestContract(module, options) {
  if (options?.requireEmbeddedManifest !== true) {
    return;
  }
  if (getResolvedManifestSource(module) !== EMBEDDED_MANIFEST_SOURCE) {
    throw new Error(
      "Access plugin must export an embedded FlatBuffer manifest via access_plugin_manifest_bytes/access_plugin_manifest_size.",
    );
  }
}

async function loadAccessModuleFactory() {
  const { default: createAccessModule } = await import("./dist/access.mjs");
  return createAccessModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/access-binary.js");
  return base64ToBytes(wasmBase64);
}

async function resolveWasmBinary(options = {}) {
  let wasmBytes;
  if (options.wasmBinary) {
    wasmBytes =
      options.wasmBinary instanceof Uint8Array
        ? options.wasmBinary
        : new Uint8Array(options.wasmBinary);
  } else if (options.wasmUrl) {
    const response = await fetch(options.wasmUrl);
    wasmBytes = new Uint8Array(await response.arrayBuffer());
  } else {
    wasmBytes = await loadBundledWasmBytes();
  }
  return stripPublicationRecordCollection(wasmBytes);
}

export function getAccessManifest() {
  return STATIC_MANIFEST;
}

export function createAccessFlowMethodHandlers(analyzer) {
  return createAccessFlowMethodHandlersRuntime(analyzer);
}

export async function createAccessAnalyzer(options = {}) {
  const createAccessModule = await loadAccessModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createAccessModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "access-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init();
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  assertEmbeddedManifestContract(module, options);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  function readGroundStationRecord(index) {
    const recordPointer = module._malloc(GROUND_STATION_RECORD_SIZE);
    try {
      const status = module._access_get_ground_station_record(
        index,
        recordPointer,
        GROUND_STATION_RECORD_SIZE,
      );
      if (status !== 0) {
        throw new Error(`Failed to read ground station ${index}.`);
      }
      return decodeGroundStationRecord(
        cloneBytesFromModule(module, recordPointer, GROUND_STATION_RECORD_SIZE),
      );
    } finally {
      module._free(recordPointer);
    }
  }

  function readGroundStationBlackouts(index) {
    if (
      typeof module._access_get_ground_station_blackout_count !== "function"
    ) {
      return [];
    }
    const count = module._access_get_ground_station_blackout_count(index);
    const blackoutPointer = module._malloc(BLACKOUT_RECORD_SIZE);
    try {
      const blackoutWindows = [];
      for (let blackoutIndex = 0; blackoutIndex < count; blackoutIndex += 1) {
        const status = module._access_get_ground_station_blackout_record(
          index,
          blackoutIndex,
          blackoutPointer,
          BLACKOUT_RECORD_SIZE,
        );
        if (status !== 0) {
          throw new Error(
            `Failed to read blackout window ${blackoutIndex} for station ${index}.`,
          );
        }
        blackoutWindows.push(
          decodeBlackoutRecord(
            cloneBytesFromModule(module, blackoutPointer, BLACKOUT_RECORD_SIZE),
          ),
        );
      }
      return blackoutWindows;
    } finally {
      module._free(blackoutPointer);
    }
  }

  function listGroundStations() {
    const count = module._access_get_ground_station_count();
    const stations = [];
    for (let index = 0; index < count; index += 1) {
      const station = readGroundStationRecord(index);
      station.blackoutWindows = readGroundStationBlackouts(index);
      stations.push(station);
    }
    return stations;
  }

  function resolveGroundStationIndex(
    stationId,
    stations = listGroundStations(),
  ) {
    if (stations.length === 0) {
      throw new Error("No ground stations have been registered.");
    }

    if (stationId === undefined || stationId === null) {
      if (stations.length === 1) {
        return 0;
      }
      throw new Error(
        "computeAccessWindows requires a stationId when multiple stations exist.",
      );
    }

    const targetId = String(stationId);
    const stationIndex = stations.findIndex(
      (station) => station.id === targetId,
    );
    if (stationIndex < 0) {
      throw new Error(`Unknown ground station: ${targetId}`);
    }
    return stationIndex;
  }

  function addGroundStation(station) {
    const normalized = normalizeGroundStation(
      station,
      module._access_get_ground_station_count(),
    );
    const recordBytes = encodeGroundStationRecord(normalized);
    const recordPointer = writeBytesToModule(module, recordBytes);

    try {
      const stationIndex = module._access_add_ground_station(
        recordPointer,
        recordBytes.length,
      );
      if (stationIndex < 0) {
        throw new Error("Native access runtime rejected the ground station.");
      }

      if (typeof module._access_set_ground_station_blackouts === "function") {
        const { bytes } = encodeBlackoutRecords(normalized.blackoutWindows);
        const blackoutPointer = writeBytesToModule(module, bytes);
        try {
          const status = module._access_set_ground_station_blackouts(
            stationIndex,
            blackoutPointer,
            normalized.blackoutWindows.length,
          );
          if (status !== 0) {
            throw new Error(
              "Native access runtime rejected the station blackout windows.",
            );
          }
        } finally {
          module._free(blackoutPointer);
        }
      }

      return normalized.id;
    } finally {
      module._free(recordPointer);
    }
  }

  function computeAccessWindows(states = [], stationId, analysisOptions = {}) {
    const stations = listGroundStations();
    const stationIndex = resolveGroundStationIndex(stationId, stations);
    const resolvedStationId = stations[stationIndex].id;
    const minElevationRad = normalizeMinElevationOption(analysisOptions);
    const { bytes } = encodeStateRecords(states);
    const statePointer = writeBytesToModule(module, bytes);
    const countPointer = module._malloc(4);

    try {
      new DataView(module.HEAPU8.buffer).setUint32(countPointer, 0, true);
      const resultPointer = module._access_compute_access_windows(
        statePointer,
        states.length,
        stationIndex,
        minElevationRad,
        countPointer,
      );
      const windowCount = new DataView(module.HEAPU8.buffer).getUint32(
        countPointer,
        true,
      );
      if (!resultPointer || windowCount === 0) {
        return [];
      }
      const resultBytes = cloneBytesFromModule(
        module,
        resultPointer,
        windowCount * ACCESS_WINDOW_RECORD_SIZE,
      );
      module._free(resultPointer);
      return decodeAccessWindowRecords(
        resultBytes,
        resolvedStationId,
        analysisOptions,
      );
    } finally {
      module._free(statePointer);
      module._free(countPointer);
    }
  }

  function computeAllAccessWindows(states = [], analysisOptions = {}) {
    return listGroundStations().flatMap((station) =>
      computeAccessWindows(states, station.id, analysisOptions),
    );
  }

  function computeAccessGeometry(state, stationId, analysisOptions = {}) {
    const normalizedState = normalizeState(state);
    const stations = listGroundStations();
    const stationIndex = resolveGroundStationIndex(stationId, stations);
    const station = stations[stationIndex];
    const geometry = computeAccessGeometryFromState(normalizedState, station);
    const minElevationRad = normalizeMinElevationOption(analysisOptions);
    const thresholdElevation = Number.isFinite(minElevationRad)
      ? minElevationRad
      : station.minElevationRad;
    return {
      ...geometry,
      minElevationRad: thresholdElevation,
      visible: geometry.elevationRad >= thresholdElevation,
    };
  }

  function predictAos(states = [], stationId, analysisOptions = {}) {
    const afterJulianDate = Number(
      analysisOptions.afterJulianDate ??
        analysisOptions.afterJd ??
        Number.NEGATIVE_INFINITY,
    );
    const windows = computeAccessWindows(states, stationId, analysisOptions);
    const nextWindow = windows.find(
      (window) => window.endJulianDate > afterJulianDate,
    );
    return nextWindow?.startJulianDate ?? null;
  }

  function predictLos(states = [], stationId, analysisOptions = {}) {
    const afterJulianDate = Number(
      analysisOptions.afterJulianDate ??
        analysisOptions.afterJd ??
        Number.NEGATIVE_INFINITY,
    );
    const windows = computeAccessWindows(states, stationId, analysisOptions);
    const nextWindow = windows.find(
      (window) => window.endJulianDate > afterJulianDate,
    );
    return nextWindow?.endJulianDate ?? null;
  }

  function scheduleContacts(windows = []) {
    const stations = listGroundStations();
    const resolveForSchedule = (stationId) =>
      resolveGroundStationIndex(stationId, stations);
    const { bytes, bySortIndex } = encodeScheduleWindowRecords(
      Array.isArray(windows) ? windows : [],
      resolveForSchedule,
    );
    if (bytes.length === 0) {
      return [];
    }

    const inputPointer = writeBytesToModule(module, bytes);
    const countPointer = module._malloc(4);
    try {
      new DataView(module.HEAPU8.buffer).setUint32(countPointer, 0, true);
      const resultPointer = module._access_schedule_contacts(
        inputPointer,
        bySortIndex.length,
        countPointer,
      );
      const resultCount = new DataView(module.HEAPU8.buffer).getUint32(
        countPointer,
        true,
      );
      if (!resultPointer || resultCount === 0) {
        return [];
      }
      const resultBytes = cloneBytesFromModule(
        module,
        resultPointer,
        resultCount * SCHEDULE_RESULT_RECORD_SIZE,
      );
      module._free(resultPointer);
      return decodeScheduledContactRecords(resultBytes, bySortIndex);
    } finally {
      module._free(inputPointer);
      module._free(countPointer);
    }
  }

  return {
    type: "Analysis",
    name: metadata.name,
    version: metadata.version,
    metadata,
    manifest,
    manifestSource: getResolvedManifestSource(module),
    module,
    supportsStreamInvoke: false,
    addGroundStation,
    listGroundStations,
    computeAccessGeometry,
    computeAccessWindows,
    computeAllAccessWindows,
    predictAos,
    predictLos,
    scheduleContacts,
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadAccessPlugin = createAccessAnalyzer;
export const metadata = STATIC_METADATA;

export default createAccessAnalyzer;
