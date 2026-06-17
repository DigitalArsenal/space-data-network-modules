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
const ELEVATION_MASK_POINT_RECORD_SIZE = 16;
const REFRACTION_MODEL_RECORD_SIZE = 48;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.6943799901413165e-3;
const TEXT_ENCODER =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const TEXT_DECODER =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const TWO_PI = 2.0 * Math.PI;
const OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA = 101000.0;
const OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K = 283.0;
const OREKIT_STANDARD_REFRACTION_MIN_ELEVATION_DEG = -2.0;
const OREKIT_STANDARD_REFRACTION_MAX_ELEVATION_DEG = 89.89;
const REFRACTION_MODEL_KIND_EARTH_STANDARD_ATMOSPHERE = 1;
const REFRACTION_MODEL_KIND_ITU_R_P834 = 2;
const OREKIT_ITURP834_KM_TO_M = 1000.0;
const OREKIT_ITURP834_INV_DEG_TO_INV_RAD = 180.0 / Math.PI;
const OREKIT_ITURP834_EARTH_RAY_M = 6370.0 * OREKIT_ITURP834_KM_TO_M;
const OREKIT_ITURP834_TAU_ZERO_COEFFICIENTS = [
  OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 1.728,
  OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.5411,
  OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.03723,
  (OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.1815) /
    OREKIT_ITURP834_KM_TO_M,
  (OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.06272) /
    OREKIT_ITURP834_KM_TO_M,
  (OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.01138) /
    OREKIT_ITURP834_KM_TO_M,
  (OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.01727) /
    (OREKIT_ITURP834_KM_TO_M * OREKIT_ITURP834_KM_TO_M),
  (OREKIT_ITURP834_INV_DEG_TO_INV_RAD * 0.008288) /
    (OREKIT_ITURP834_KM_TO_M * OREKIT_ITURP834_KM_TO_M),
];

function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAzimuthRad(value) {
  const normalized = value % TWO_PI;
  return normalized < 0.0 ? normalized + TWO_PI : normalized;
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

function readMaskPair(point = {}, sourceUnit) {
  const azimuth = Array.isArray(point)
    ? point[0]
    : (point.azimuthRad ?? point.azimuthDeg ?? point.azimuth);
  const elevation = Array.isArray(point)
    ? point[1]
    : (point.elevationRad ?? point.elevationDeg ?? point.elevation);
  const pointUsesDegrees =
    sourceUnit === "deg" ||
    (!Array.isArray(point) &&
      (point.azimuthDeg !== undefined || point.elevationDeg !== undefined));
  return {
    azimuthRad: pointUsesDegrees
      ? degreesToRadians(Number(azimuth))
      : Number(azimuth),
    elevationRad: pointUsesDegrees
      ? degreesToRadians(Number(elevation))
      : Number(elevation),
  };
}

function normalizeElevationMaskOption(options = {}) {
  const source = options.elevationMaskRad ?? options.elevationMaskDeg ?? null;
  if (source == null) {
    return null;
  }
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("Access elevation masks require at least one azimuth/elevation point.");
  }
  const sourceUnit =
    options.elevationMaskDeg !== undefined &&
    options.elevationMaskRad === undefined
      ? "deg"
      : "rad";
  const points = source.map((point) => readMaskPair(point, sourceUnit));
  for (const point of points) {
    if (!Number.isFinite(point.azimuthRad) || !Number.isFinite(point.elevationRad)) {
      throw new Error("Access elevation mask azimuth/elevation points must be finite.");
    }
    point.azimuthRad = normalizeAzimuthRad(point.azimuthRad);
  }
  points.sort((left, right) => left.azimuthRad - right.azimuthRad);

  const unique = [];
  for (const point of points) {
    const last = unique.at(-1);
    if (last && Math.abs(last.azimuthRad - point.azimuthRad) < 1.0e-15) {
      if (Math.abs(last.elevationRad - point.elevationRad) > 1.0e-15) {
        throw new Error(
          "Access elevation masks cannot assign two elevations to the same azimuth.",
        );
      }
      continue;
    }
    unique.push(point);
  }
  return unique;
}

function encodeElevationMaskPointRecords(points = []) {
  const bytes = new Uint8Array(points.length * ELEVATION_MASK_POINT_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  points.forEach((point, index) => {
    const offset = index * ELEVATION_MASK_POINT_RECORD_SIZE;
    view.setFloat64(offset + 0, point.azimuthRad, true);
    view.setFloat64(offset + 8, point.elevationRad, true);
  });
  return bytes;
}

function evaluateElevationMask(points, azimuthRad) {
  if (!Array.isArray(points) || points.length === 0) {
    return Number.NaN;
  }

  const normalizedAzimuth = normalizeAzimuthRad(azimuthRad);
  const extended = [
    {
      azimuthRad: points.at(-1).azimuthRad - TWO_PI,
      elevationRad: points.at(-1).elevationRad,
    },
    ...points,
    {
      azimuthRad: points[0].azimuthRad + TWO_PI,
      elevationRad: points[0].elevationRad,
    },
  ];

  for (let index = 1; index < extended.length; index += 1) {
    const end = extended[index];
    if (normalizedAzimuth <= end.azimuthRad) {
      const start = extended[index - 1];
      const span = end.azimuthRad - start.azimuthRad;
      if (Math.abs(span) < 1.0e-15) {
        return end.elevationRad;
      }
      return (
        start.elevationRad +
        ((normalizedAzimuth - start.azimuthRad) *
          (end.elevationRad - start.elevationRad)) /
          span
      );
    }
  }

  return extended.at(-1).elevationRad;
}

function normalizeRefractionModelOption(options = {}, station = null) {
  const source =
    options.refractionModel ??
    options.refraction ??
    options.atmosphericRefraction ??
    null;
  if (source === null || source === undefined || source === false || source === "none") {
    return null;
  }

  const type =
    source === true
      ? "earth-standard-atmosphere"
      : typeof source === "string"
        ? source
        : String(
            source.type ??
              source.model ??
              source.name ??
              "earth-standard-atmosphere",
          );
  const normalizedType = type.trim().toLowerCase();

  if (
    normalizedType === "earth-standard-atmosphere" ||
    normalizedType === "orekit-earth-standard-atmosphere" ||
    normalizedType === "earthstandardatmosphererefraction"
  ) {
    const pressurePa =
      typeof source === "object" && source !== null
        ? Number(
            source.pressurePa ??
              source.pressure ??
              source.localPressurePa ??
              OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA,
          )
        : Number(OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA);
    const temperatureK =
      typeof source === "object" && source !== null
        ? Number(
            source.temperatureK ??
              source.temperature ??
              source.localTemperatureK ??
              OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K,
          )
        : Number(OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K);
    if (!Number.isFinite(pressurePa) || !Number.isFinite(temperatureK) || temperatureK <= 0.0) {
      throw new Error(
        "Access EarthStandardAtmosphereRefraction requires finite pressurePa and positive temperatureK.",
      );
    }

    return {
      type: "earth-standard-atmosphere",
      modelKind: REFRACTION_MODEL_KIND_EARTH_STANDARD_ATMOSPHERE,
      pressurePa,
      temperatureK,
      stationAltitudeM: 0.0,
      elevationStarRad: 0.0,
      refractionStarRad: 0.0,
    };
  }

  if (
    normalizedType === "itu-r-p834" ||
    normalizedType === "itu-r-p.834" ||
    normalizedType === "orekit-itu-r-p834" ||
    normalizedType === "iturp834" ||
    normalizedType === "iturp834atmosphericrefraction"
  ) {
    const stationAltitudeSource =
      typeof source === "object" && source !== null
        ? source.stationAltitudeM ??
          source.altitudeM ??
          source.altitude ??
          station?.altitudeM ??
          0.0
        : station?.altitudeM ?? 0.0;
    const stationAltitudeM = Number(stationAltitudeSource);
    if (
      !Number.isFinite(stationAltitudeM) ||
      stationAltitudeM <= -OREKIT_ITURP834_EARTH_RAY_M + 1.0
    ) {
      throw new Error(
        "Access ITURP834AtmosphericRefraction requires a finite station altitude above the ITU-R P.834 Earth ray.",
      );
    }

    const elevationStarRad =
      computeIturp834AtmosphericRefractionElevationStarRad(stationAltitudeM);
    const refractionStarRad = computeIturp834TauZeroRad(
      elevationStarRad,
      stationAltitudeM,
    );
    return {
      type: "itu-r-p834",
      modelKind: REFRACTION_MODEL_KIND_ITU_R_P834,
      pressurePa: OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA,
      temperatureK: OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K,
      stationAltitudeM,
      elevationStarRad,
      refractionStarRad,
    };
  }

  throw new Error(`Unsupported access refraction model: ${type}`);
}

function encodeRefractionModelRecord(model) {
  const bytes = new Uint8Array(REFRACTION_MODEL_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, model.pressurePa, true);
  view.setFloat64(8, model.temperatureK, true);
  view.setFloat64(16, model.stationAltitudeM, true);
  view.setFloat64(24, model.elevationStarRad, true);
  view.setFloat64(32, model.refractionStarRad, true);
  view.setUint32(40, model.modelKind, true);
  view.setUint32(44, 0, true);
  return bytes;
}

function computeEarthStandardAtmosphereRefractionRad(elevationRad, model) {
  if (!model) {
    return 0.0;
  }

  const elevationDeg = radiansToDegrees(elevationRad);
  if (
    elevationDeg <= OREKIT_STANDARD_REFRACTION_MIN_ELEVATION_DEG ||
    elevationDeg >= OREKIT_STANDARD_REFRACTION_MAX_ELEVATION_DEG
  ) {
    return 0.0;
  }

  const refractionArgumentDeg = elevationDeg + 10.3 / (elevationDeg + 5.11);
  const refractionDeg =
    1.02 / Math.tan(degreesToRadians(refractionArgumentDeg)) / 60.0;
  const correctionFactor =
    (model.pressurePa / OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA) *
    (OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K / model.temperatureK);
  return degreesToRadians(correctionFactor * refractionDeg);
}

function computeIturp834TauZeroRad(elevationRad, altitudeM) {
  const coefficients = OREKIT_ITURP834_TAU_ZERO_COEFFICIENTS;
  const elevationDeg = radiansToDegrees(elevationRad);
  const tmp0 =
    coefficients[0] +
    (coefficients[1] + coefficients[2] * elevationDeg) * elevationDeg;
  const tmp1 =
    altitudeM *
    (coefficients[3] +
      (coefficients[4] + coefficients[5] * elevationDeg) * elevationDeg);
  const tmp2 =
    altitudeM *
    altitudeM *
    (coefficients[6] + coefficients[7] * elevationDeg);
  return 1.0 / (tmp0 + tmp1 + tmp2);
}

function computeIturp834AtmosphericRefractionElevationStarRad(altitudeM) {
  let lower = -Math.PI / 30.0;
  let upper = Math.PI / 4.0;
  const inverseGoldenRatio = (Math.sqrt(5.0) - 1.0) / 2.0;
  const objective = (elevationRad) =>
    elevationRad + computeIturp834TauZeroRad(elevationRad, altitudeM);
  let left = upper - inverseGoldenRatio * (upper - lower);
  let right = lower + inverseGoldenRatio * (upper - lower);
  let leftValue = objective(left);
  let rightValue = objective(right);

  for (
    let iteration = 0;
    iteration < 200 && Math.abs(upper - lower) > 1.0e-12;
    iteration += 1
  ) {
    if (leftValue < rightValue) {
      upper = right;
      right = left;
      rightValue = leftValue;
      left = upper - inverseGoldenRatio * (upper - lower);
      leftValue = objective(left);
    } else {
      lower = left;
      left = right;
      leftValue = rightValue;
      right = lower + inverseGoldenRatio * (upper - lower);
      rightValue = objective(right);
    }
  }

  return (lower + upper) / 2.0;
}

function computeIturp834AtmosphericRefractionRad(elevationRad, model) {
  if (
    !model ||
    !Number.isFinite(elevationRad) ||
    !Number.isFinite(model.stationAltitudeM)
  ) {
    return 0.0;
  }

  if (elevationRad < model.elevationStarRad) {
    return model.refractionStarRad;
  }
  return computeIturp834TauZeroRad(elevationRad, model.stationAltitudeM);
}

function computeRefractionRad(elevationRad, model) {
  if (!model) {
    return 0.0;
  }
  if (model.type === "earth-standard-atmosphere") {
    return computeEarthStandardAtmosphereRefractionRad(elevationRad, model);
  }
  if (model.type === "itu-r-p834") {
    return computeIturp834AtmosphericRefractionRad(elevationRad, model);
  }
  return 0.0;
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
  const azimuthRad = normalizeAzimuthRad(Math.atan2(east, north));

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
    const station = stations[stationIndex];
    const resolvedStationId = station.id;
    const elevationMask = normalizeElevationMaskOption(analysisOptions);
    const refractionModel = normalizeRefractionModelOption(
      analysisOptions,
      station,
    );
    const minElevationRad = normalizeMinElevationOption(analysisOptions);
    const { bytes } = encodeStateRecords(states);
    const statePointer = writeBytesToModule(module, bytes);
    const maskBytes = elevationMask
      ? encodeElevationMaskPointRecords(elevationMask)
      : null;
    const maskPointer = maskBytes ? writeBytesToModule(module, maskBytes) : 0;
    const refractionBytes = refractionModel
      ? encodeRefractionModelRecord(refractionModel)
      : null;
    const refractionPointer = refractionBytes
      ? writeBytesToModule(module, refractionBytes)
      : 0;
    const countPointer = module._malloc(4);

    try {
      new DataView(module.HEAPU8.buffer).setUint32(countPointer, 0, true);
      let resultPointer;
      if (elevationMask || refractionModel) {
        if (
          typeof module._access_compute_access_windows_with_effects ===
          "function"
        ) {
          resultPointer = module._access_compute_access_windows_with_effects(
            statePointer,
            states.length,
            stationIndex,
            minElevationRad,
            maskPointer,
            elevationMask ? elevationMask.length : 0,
            refractionPointer,
            countPointer,
          );
        } else if (elevationMask && !refractionModel) {
          if (
            typeof module._access_compute_access_windows_with_elevation_mask !==
            "function"
          ) {
            throw new Error(
              "Native access runtime does not expose elevation mask support.",
            );
          }
          resultPointer =
            module._access_compute_access_windows_with_elevation_mask(
              statePointer,
              states.length,
              stationIndex,
              maskPointer,
              elevationMask.length,
              countPointer,
            );
        } else {
          throw new Error(
            "Native access runtime does not expose refraction support.",
          );
        }
      } else {
        if (
          typeof module._access_compute_access_windows !==
          "function"
        ) {
          throw new Error(
            "Native access runtime does not expose access-window support.",
          );
        }
        resultPointer = module._access_compute_access_windows(
          statePointer,
          states.length,
          stationIndex,
          minElevationRad,
          countPointer,
        );
      }
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
      if (maskPointer) {
        module._free(maskPointer);
      }
      if (refractionPointer) {
        module._free(refractionPointer);
      }
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
    const elevationMask = normalizeElevationMaskOption(analysisOptions);
    const refractionModel = normalizeRefractionModelOption(
      analysisOptions,
      station,
    );
    const minElevationRad = normalizeMinElevationOption(analysisOptions);
    const thresholdElevation = elevationMask
      ? evaluateElevationMask(elevationMask, geometry.azimuthRad)
      : Number.isFinite(minElevationRad)
        ? minElevationRad
        : station.minElevationRad;
    const refractionRad = computeRefractionRad(
      geometry.elevationRad,
      refractionModel,
    );
    const apparentElevationRad = geometry.elevationRad + refractionRad;
    return {
      ...geometry,
      minElevationRad: thresholdElevation,
      refractionRad,
      apparentElevationRad,
      visible: apparentElevationRad >= thresholdElevation,
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
