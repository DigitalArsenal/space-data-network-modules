import {
  createCoveragePluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { createCoverageFlowMethodHandlers as createCoverageFlowMethodHandlersRuntime } from "./flowHandlers.js";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const COVERAGE_CELL_ACCESSED = 0x01;
const COVERAGE_CELL_MULTIPLE = 0x02;

const FOM_IDS = {
  access_count: 0,
  total_access_duration: 1,
  percent_coverage: 2,
  mean_revisit_time: 3,
  max_revisit_time: 4,
  time_to_first_access: 5,
  response_time: 6,
  number_of_gaps: 7,
  max_gap_duration: 8,
  average_gap_duration: 9,
};

const COLOR_MAP_IDS = {
  viridis: 0,
  jet: 1,
  hot: 2,
  cool: 3,
  grayscale: 4,
  stk_coverage: 5,
  custom: 6,
};

const STATIC_MANIFEST = createCoveragePluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});

let nextGridId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bitCount(mask) {
  let count = 0;
  let value = BigInt(mask ?? 0n);
  while (value > 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function normalizeSeconds(seconds) {
  const integerSeconds = Math.round(seconds);
  if (Math.abs(seconds - integerSeconds) < 1.0e-4) {
    return integerSeconds;
  }
  return Math.round(seconds * 1.0e6) / 1.0e6;
}

function normalizeSensorIds(sensorIds) {
  if (!Array.isArray(sensorIds)) {
    return undefined;
  }

  const normalized = sensorIds
    .map(function (sensorId) {
      return Number(sensorId);
    })
    .filter(function (sensorId) {
      return Number.isInteger(sensorId) && sensorId >= 0;
    });

  return Array.from(new Set(normalized)).sort(function (left, right) {
    return left - right;
  });
}

function deriveSensorIdsFromGrid(grid) {
  let combinedMask = 0n;
  for (const cell of grid.cells) {
    combinedMask |= cell.sensorMask ?? 0n;
  }

  const sensorIds = [];
  let sensorIndex = 0;
  let probe = combinedMask;
  while (probe > 0n) {
    if ((probe & 1n) === 1n) {
      sensorIds.push(sensorIndex);
    }
    probe >>= 1n;
    sensorIndex += 1;
  }
  return sensorIds;
}

function normalizeCellIndices(grid, cellIndices) {
  if (!Array.isArray(cellIndices) || cellIndices.length === 0) {
    return Array.from({ length: grid.cellCount }, function (_, index) {
      return index;
    });
  }

  return Array.from(
    new Set(
      cellIndices
        .map(function (cellIndex) {
          return Number(cellIndex);
        })
        .filter(function (cellIndex) {
          return (
            Number.isInteger(cellIndex) &&
            cellIndex >= 0 &&
            cellIndex < grid.cellCount
          );
        }),
    ),
  ).sort(function (left, right) {
    return left - right;
  });
}

function readFloat64(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat64(offset, true);
}

function readUint32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function writeFloat64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(
    offset,
    value,
    true,
  );
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function normalizeBinaryInput(input = {}) {
  const bytes =
    input.bytes ?? input.payloadBytes ?? input.data ?? input.payload ?? null;
  const normalized = toUint8Array(bytes);
  if (!normalized) {
    throw new Error(
      "Coverage streamInvoke expects aligned binary Uint8Array or ArrayBuffer inputs.",
    );
  }
  return normalized;
}

function createStreamOutput(bytes, portId = "results", input = {}) {
  return {
    portId,
    typeRef: input.typeRef ?? null,
    alignment: input.alignment ?? 8,
    streamId: input.streamId ?? 0,
    sequence: input.sequence ?? 0n,
    traceToken: input.traceToken ?? 0n,
    endOfStream: false,
    bytes,
    payloadBytes: bytes,
  };
}

function normalizeGridConfig(config = {}) {
  const latitudeStepDeg = Number(
    config.latitudeStepDeg ?? config.latitudeResolutionDeg ?? 1.0,
  );
  const longitudeStepDeg = Number(
    config.longitudeStepDeg ?? config.longitudeResolutionDeg ?? 1.0,
  );
  return {
    minLatitudeDeg: Number(config.minLatitudeDeg ?? -90.0),
    maxLatitudeDeg: Number(config.maxLatitudeDeg ?? 90.0),
    minLongitudeDeg: Number(config.minLongitudeDeg ?? -180.0),
    maxLongitudeDeg: Number(config.maxLongitudeDeg ?? 180.0),
    latitudeStepDeg,
    longitudeStepDeg,
    startEpochJd: Number(config.startEpochJd ?? 0.0),
    endEpochJd: Number(config.endEpochJd ?? 0.0),
  };
}

function createEmptyCell() {
  return {
    firstAccessTime: null,
    lastAccessTime: null,
    totalAccessDuration: 0.0,
    minRevisitTime: 0.0,
    maxRevisitTime: 0.0,
    sumRevisitTime: 0.0,
    accessCount: 0,
    revisitCount: 0,
    flags: 0,
    sensorMask: 0n,
    intervals: [],
  };
}

function cloneCell(cell) {
  return {
    firstAccessTime: cell.firstAccessTime,
    lastAccessTime: cell.lastAccessTime,
    totalAccessDuration: cell.totalAccessDuration,
    minRevisitTime: cell.minRevisitTime,
    maxRevisitTime: cell.maxRevisitTime,
    sumRevisitTime: cell.sumRevisitTime,
    accessCount: cell.accessCount,
    revisitCount: cell.revisitCount,
    flags: cell.flags,
    sensorMask: cell.sensorMask,
  };
}

function cloneInterval(interval) {
  return {
    startTime: interval.startTime,
    endTime: interval.endTime,
    duration: interval.duration,
    flags: interval.flags ?? 0,
  };
}

function updateCellMetrics(cell) {
  const intervals = cell.intervals;
  if (intervals.length === 0) {
    cell.firstAccessTime = null;
    cell.lastAccessTime = null;
    cell.totalAccessDuration = 0.0;
    cell.minRevisitTime = 0.0;
    cell.maxRevisitTime = 0.0;
    cell.sumRevisitTime = 0.0;
    cell.accessCount = 0;
    cell.revisitCount = 0;
    cell.flags = 0;
    return;
  }

  cell.firstAccessTime = intervals[0].startTime;
  cell.lastAccessTime = intervals[intervals.length - 1].endTime;
  cell.totalAccessDuration = intervals.reduce(
    (sum, interval) => sum + interval.duration,
    0.0,
  );
  cell.accessCount = intervals.length;
  cell.revisitCount = Math.max(0, intervals.length - 1);
  cell.flags = COVERAGE_CELL_ACCESSED;
  if (cell.accessCount > 1) {
    cell.flags |= COVERAGE_CELL_MULTIPLE;
  }

  if (cell.revisitCount === 0) {
    cell.minRevisitTime = 0.0;
    cell.maxRevisitTime = 0.0;
    cell.sumRevisitTime = 0.0;
    return;
  }

  const gaps = [];
  for (let index = 1; index < intervals.length; index += 1) {
    gaps.push(
      normalizeSeconds(
        (intervals[index].startTime - intervals[index - 1].endTime) * 86400.0,
      ),
    );
  }
  cell.minRevisitTime = Math.min(...gaps);
  cell.maxRevisitTime = Math.max(...gaps);
  cell.sumRevisitTime = gaps.reduce((sum, value) => sum + value, 0.0);
}

function pointOnSegment(point, start, end) {
  const crossValue =
    (point.latDeg - start.latDeg) * (end.lonDeg - start.lonDeg) -
    (point.lonDeg - start.lonDeg) * (end.latDeg - start.latDeg);
  if (Math.abs(crossValue) > 1e-9) {
    return false;
  }
  const dotValue =
    (point.lonDeg - start.lonDeg) * (end.lonDeg - start.lonDeg) +
    (point.latDeg - start.latDeg) * (end.latDeg - start.latDeg);
  if (dotValue < 0.0) {
    return false;
  }
  const lengthSquared =
    (end.lonDeg - start.lonDeg) * (end.lonDeg - start.lonDeg) +
    (end.latDeg - start.latDeg) * (end.latDeg - start.latDeg);
  return dotValue <= lengthSquared;
}

function pointInPolygon(point, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return false;
  }
  let inside = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (pointOnSegment(point, current, next)) {
      return true;
    }
    const intersects =
      current.latDeg > point.latDeg !== next.latDeg > point.latDeg;
    if (!intersects) {
      continue;
    }
    const intersectLon =
      ((next.lonDeg - current.lonDeg) * (point.latDeg - current.latDeg)) /
        (next.latDeg - current.latDeg) +
      current.lonDeg;
    if (point.lonDeg <= intersectLon) {
      inside = !inside;
    }
  }
  return inside;
}

function mergeInterval(intervals, startTime, endTime) {
  const nextInterval = {
    startTime,
    endTime,
    duration: normalizeSeconds((endTime - startTime) * 86400.0),
    flags: 0,
  };
  const merged = [];
  let inserted = false;
  let touchedExisting = false;

  for (const interval of intervals) {
    if (interval.endTime < nextInterval.startTime) {
      merged.push(interval);
      continue;
    }
    if (nextInterval.endTime < interval.startTime) {
      if (!inserted) {
        merged.push(nextInterval);
        inserted = true;
      }
      merged.push(interval);
      continue;
    }

    touchedExisting = true;
    nextInterval.startTime = Math.min(
      nextInterval.startTime,
      interval.startTime,
    );
    nextInterval.endTime = Math.max(nextInterval.endTime, interval.endTime);
    nextInterval.duration = normalizeSeconds(
      (nextInterval.endTime - nextInterval.startTime) * 86400.0,
    );
  }

  if (!inserted) {
    merged.push(nextInterval);
  }
  merged.sort((left, right) => left.startTime - right.startTime);
  return {
    intervals: merged,
    createdIntervalCount: touchedExisting ? 0 : 1,
  };
}

function ensureGrid(grids, gridId) {
  const grid = grids.get(Number(gridId));
  if (!grid) {
    throw new Error(`Unknown coverage grid id ${gridId}.`);
  }
  return grid;
}

function getCellCenter(grid, row, column) {
  return {
    latDeg:
      grid.config.minLatitudeDeg + (row + 0.5) * grid.config.latitudeStepDeg,
    lonDeg:
      grid.config.minLongitudeDeg +
      (column + 0.5) * grid.config.longitudeStepDeg,
  };
}

function applyColorMap(colorMap, t) {
  const clamped = clamp(t, 0.0, 1.0);
  switch (colorMap) {
    case "jet":
      return [
        clamp(1.5 - Math.abs(4.0 * clamped - 3.0), 0.0, 1.0) * 255,
        clamp(1.5 - Math.abs(4.0 * clamped - 2.0), 0.0, 1.0) * 255,
        clamp(1.5 - Math.abs(4.0 * clamped - 1.0), 0.0, 1.0) * 255,
      ];
    case "hot":
      return [
        clamp(clamped * 3.0, 0.0, 1.0) * 255,
        clamp(clamped * 3.0 - 1.0, 0.0, 1.0) * 255,
        clamp(clamped * 3.0 - 2.0, 0.0, 1.0) * 255,
      ];
    case "cool":
      return [clamped * 255, (1.0 - clamped) * 255, 255];
    case "grayscale":
      return [clamped * 255, clamped * 255, clamped * 255];
    case "stk_coverage":
      return clamped < 0.5
        ? [0, clamped * 2.0 * 255, (1.0 - clamped * 2.0) * 255]
        : [(clamped - 0.5) * 2.0 * 255, (1.0 - (clamped - 0.5) * 2.0) * 255, 0];
    case "viridis":
    default:
      return [
        68 + clamped * 185,
        1 + clamped * 230,
        84 + (1.0 - clamped) * 171,
      ];
  }
}

function normalizeFomType(fomType) {
  const key = String(fomType ?? "access_count").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FOM_IDS, key)
    ? key
    : "access_count";
}

function computeFomValues(grid, fomType) {
  const normalizedFomType = normalizeFomType(fomType);
  const totalDurationSeconds =
    Math.max(grid.config.endEpochJd - grid.config.startEpochJd, 0.0) * 86400.0;
  const values = new Float64Array(grid.cellCount);

  grid.cells.forEach((cell, index) => {
    switch (normalizedFomType) {
      case "total_access_duration":
        values[index] = cell.totalAccessDuration;
        break;
      case "percent_coverage":
        values[index] =
          totalDurationSeconds > 0.0
            ? (cell.totalAccessDuration / totalDurationSeconds) * 100.0
            : 0.0;
        break;
      case "mean_revisit_time":
        values[index] =
          cell.revisitCount > 0 ? cell.sumRevisitTime / cell.revisitCount : 0.0;
        break;
      case "max_revisit_time":
      case "max_gap_duration":
        values[index] = cell.maxRevisitTime;
        break;
      case "time_to_first_access":
      case "response_time":
        values[index] =
          cell.firstAccessTime === null
            ? totalDurationSeconds
            : (cell.firstAccessTime - grid.config.startEpochJd) * 86400.0;
        break;
      case "number_of_gaps":
        values[index] = cell.revisitCount;
        break;
      case "average_gap_duration":
        values[index] =
          cell.revisitCount > 0 ? cell.sumRevisitTime / cell.revisitCount : 0.0;
        break;
      case "access_count":
      default:
        values[index] = cell.accessCount;
        break;
    }
  });

  return values;
}

function encodeGridInfo(grid) {
  const bytes = new Uint8Array(16);
  writeUint32(bytes, 0, grid.gridId);
  writeUint32(bytes, 4, grid.rowCount);
  writeUint32(bytes, 8, grid.columnCount);
  writeUint32(bytes, 12, grid.cellCount);
  return bytes;
}

function encodeStatistics(statistics) {
  const bytes = new Uint8Array(80);
  writeUint32(bytes, 0, statistics.totalCells);
  writeUint32(bytes, 4, statistics.accessedCells);
  writeUint32(bytes, 8, statistics.multiAccessCells);
  writeFloat64(bytes, 16, statistics.percentCoverage);
  writeFloat64(bytes, 24, statistics.meanAccessCount);
  writeFloat64(bytes, 32, statistics.meanRevisitTime);
  writeFloat64(bytes, 40, statistics.minRevisitTime);
  writeFloat64(bytes, 48, statistics.maxRevisitTime);
  writeFloat64(bytes, 56, statistics.maxGapDuration);
  writeFloat64(bytes, 64, statistics.totalAccessTime);
  writeFloat64(bytes, 72, statistics.meanGapDuration);
  return bytes;
}

function encodeIntervals(gridId, cellIndex, intervals) {
  const bytes = new Uint8Array(16 + intervals.length * 32);
  writeUint32(bytes, 0, gridId);
  writeUint32(bytes, 4, cellIndex);
  writeUint32(bytes, 8, intervals.length);
  intervals.forEach((interval, index) => {
    const base = 16 + index * 32;
    writeFloat64(bytes, base, interval.startTime);
    writeFloat64(bytes, base + 8, interval.endTime);
    writeFloat64(bytes, base + 16, interval.duration);
    writeUint32(bytes, base + 24, interval.flags ?? 0);
  });
  return bytes;
}

function encodeFom(gridId, fomId, values) {
  const bytes = new Uint8Array(16 + values.length * 8);
  writeUint32(bytes, 0, gridId);
  writeUint32(bytes, 4, fomId);
  writeUint32(bytes, 8, values.length);
  values.forEach((value, index) => {
    writeFloat64(bytes, 16 + index * 8, value);
  });
  return bytes;
}

function encodeHeatmap(heatmap) {
  const bytes = new Uint8Array(12 + heatmap.pixels.length);
  writeUint32(bytes, 0, heatmap.width);
  writeUint32(bytes, 4, heatmap.height);
  writeUint32(bytes, 8, heatmap.pixels.length);
  bytes.set(heatmap.pixels, 12);
  return bytes;
}

function encodeUnionResult(result) {
  const bytes = new Uint8Array(56);
  writeUint32(bytes, 12, result.unionCoveredCells);
  writeUint32(bytes, 16, result.fullyCoveredCells);
  writeUint32(bytes, 20, result.partialCoverageCells);
  writeUint32(bytes, 24, result.gapCells);
  writeFloat64(bytes, 40, result.meanSensorsPerCoveredCell);
  writeFloat64(bytes, 48, result.maxGapDurationSec);
  return bytes;
}

function decodeGridConfig(bytes) {
  return normalizeGridConfig({
    minLatitudeDeg: readFloat64(bytes, 0),
    maxLatitudeDeg: readFloat64(bytes, 8),
    minLongitudeDeg: readFloat64(bytes, 16),
    maxLongitudeDeg: readFloat64(bytes, 24),
    latitudeStepDeg: readFloat64(bytes, 32),
    longitudeStepDeg: readFloat64(bytes, 40),
    startEpochJd: readFloat64(bytes, 48),
    endEpochJd: readFloat64(bytes, 56),
  });
}

function decodeFootprintBatch(bytes) {
  const gridId = readUint32(bytes, 0);
  const footprintCount = readUint32(bytes, 4);
  let cursor = 16;
  const footprints = [];
  for (let index = 0; index < footprintCount; index += 1) {
    const startEpochJd = readFloat64(bytes, cursor);
    const endEpochJd = readFloat64(bytes, cursor + 8);
    const sensorId = readUint32(bytes, cursor + 16);
    const vertexCount = readUint32(bytes, cursor + 20);
    cursor += 24;
    const vertices = [];
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      vertices.push({
        latDeg: readFloat64(bytes, cursor),
        lonDeg: readFloat64(bytes, cursor + 8),
      });
      cursor += 16;
    }
    footprints.push({
      sensorId,
      startEpochJd,
      endEpochJd,
      vertices,
    });
  }
  return { gridId, footprints };
}

function decodeHeatmapRequest(bytes) {
  const fomId = readUint32(bytes, 4);
  const colorMapId = readUint32(bytes, 8);
  const fomType =
    Object.entries(FOM_IDS).find(([, value]) => value === fomId)?.[0] ??
    "access_count";
  const colorMap =
    Object.entries(COLOR_MAP_IDS).find(
      ([, value]) => value === colorMapId,
    )?.[0] ?? "viridis";
  return {
    gridId: readUint32(bytes, 0),
    fomType,
    colorMap,
    width: readUint32(bytes, 12),
    height: readUint32(bytes, 16),
    minValue: readFloat64(bytes, 24),
    maxValue: readFloat64(bytes, 24),
  };
}

function createGridStorage(config) {
  const rowCount = Math.max(
    1,
    Math.round(
      (config.maxLatitudeDeg - config.minLatitudeDeg) / config.latitudeStepDeg,
    ),
  );
  const columnCount = Math.max(
    1,
    Math.round(
      (config.maxLongitudeDeg - config.minLongitudeDeg) /
        config.longitudeStepDeg,
    ),
  );
  const cellCount = rowCount * columnCount;
  return {
    gridId: nextGridId++,
    config,
    rowCount,
    columnCount,
    cellCount,
    cells: Array.from({ length: cellCount }, createEmptyCell),
  };
}

function createAnalyzerState() {
  return {
    grids: new Map(),
  };
}

function getGridInfo(grid) {
  return {
    gridId: grid.gridId,
    rowCount: grid.rowCount,
    columnCount: grid.columnCount,
    cellCount: grid.cellCount,
    config: { ...grid.config },
  };
}

function computeStatistics(grid) {
  const accessedCells = grid.cells.filter((cell) => cell.accessCount > 0);
  const totalAccessTime = accessedCells.reduce(
    (sum, cell) => sum + cell.totalAccessDuration,
    0.0,
  );
  const revisitCells = accessedCells.filter((cell) => cell.revisitCount > 0);
  const meanAccessCount =
    accessedCells.length > 0
      ? accessedCells.reduce((sum, cell) => sum + cell.accessCount, 0.0) /
        accessedCells.length
      : 0.0;
  const meanRevisitTime =
    revisitCells.length > 0
      ? revisitCells.reduce(
          (sum, cell) => sum + cell.sumRevisitTime / cell.revisitCount,
          0.0,
        ) / revisitCells.length
      : 0.0;
  const minRevisitTime =
    revisitCells.length > 0
      ? Math.min(...revisitCells.map((cell) => cell.minRevisitTime))
      : 0.0;
  const maxRevisitTime =
    revisitCells.length > 0
      ? Math.max(...revisitCells.map((cell) => cell.maxRevisitTime))
      : 0.0;
  const meanGapDuration = meanRevisitTime;
  const maxGapDuration = maxRevisitTime;

  return {
    totalCells: grid.cellCount,
    accessedCells: accessedCells.length,
    multiAccessCells: accessedCells.filter((cell) => cell.accessCount > 1)
      .length,
    percentCoverage:
      grid.cellCount > 0
        ? (accessedCells.length / grid.cellCount) * 100.0
        : 0.0,
    meanAccessCount,
    meanRevisitTime,
    minRevisitTime,
    maxRevisitTime,
    meanGapDuration,
    maxGapDuration,
    totalAccessTime,
  };
}

function generateHeatmapForGrid(grid, options = {}) {
  const fomType = normalizeFomType(options.fomType ?? "access_count");
  const colorMap = String(options.colorMap ?? "viridis").toLowerCase();
  const width = Math.max(
    1,
    Math.floor(Number(options.width ?? grid.columnCount)),
  );
  const height = Math.max(
    1,
    Math.floor(Number(options.height ?? grid.rowCount)),
  );
  const values = computeFomValues(grid, fomType);
  const pixels = new Uint8Array(width * height * 4);
  const specifiedMin = Number(options.minValue);
  const specifiedMax = Number(options.maxValue);
  let minValue = Number.isFinite(specifiedMin) ? specifiedMin : Infinity;
  let maxValue = Number.isFinite(specifiedMax) ? specifiedMax : -Infinity;

  if (!Number.isFinite(specifiedMin) || !Number.isFinite(specifiedMax)) {
    for (let index = 0; index < values.length; index += 1) {
      minValue = Math.min(minValue, values[index]);
      maxValue = Math.max(maxValue, values[index]);
    }
  }

  if (!Number.isFinite(minValue)) {
    minValue = 0.0;
  }
  if (!Number.isFinite(maxValue) || maxValue === minValue) {
    maxValue = minValue + 1.0;
  }

  for (let row = 0; row < height; row += 1) {
    const sourceRow = clamp(
      Math.floor((row / height) * grid.rowCount),
      0,
      grid.rowCount - 1,
    );
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = clamp(
        Math.floor((column / width) * grid.columnCount),
        0,
        grid.columnCount - 1,
      );
      const cellIndex = sourceRow * grid.columnCount + sourceColumn;
      const cell = grid.cells[cellIndex];
      const value = values[cellIndex];
      const normalized =
        (value - minValue) / Math.max(maxValue - minValue, 1e-9);
      const [red, green, blue] = applyColorMap(colorMap, normalized);
      const pixelIndex = (row * width + column) * 4;
      pixels[pixelIndex] = Math.round(red);
      pixels[pixelIndex + 1] = Math.round(green);
      pixels[pixelIndex + 2] = Math.round(blue);
      pixels[pixelIndex + 3] = cell.accessCount > 0 ? 255 : 0;
    }
  }

  return {
    width,
    height,
    minValue,
    maxValue,
    pixels,
  };
}

function computeMinimumSensorSetForGrid(grid, options = {}) {
  const candidateSensorIds =
    normalizeSensorIds(options.sensorIds) ?? deriveSensorIdsFromGrid(grid);
  const requiredCellIndices = normalizeCellIndices(grid, options.cellIndices);
  const selectedSensorIds = [];
  const selectedMask = new Set();
  const uncovered = new Set(requiredCellIndices);
  const coverageBySensor = new Map();

  for (const sensorId of candidateSensorIds) {
    const sensorMask = 1n << BigInt(sensorId);
    const coveredCells = [];
    for (let cellIndex = 0; cellIndex < grid.cells.length; cellIndex += 1) {
      if ((grid.cells[cellIndex].sensorMask & sensorMask) !== 0n) {
        coveredCells.push(cellIndex);
      }
    }
    coverageBySensor.set(sensorId, coveredCells);
  }

  while (uncovered.size > 0) {
    let bestSensorId;
    let bestGain = 0;

    for (const sensorId of candidateSensorIds) {
      if (selectedMask.has(sensorId)) {
        continue;
      }

      const coveredCells = coverageBySensor.get(sensorId) ?? [];
      let gain = 0;
      for (let index = 0; index < coveredCells.length; index += 1) {
        if (uncovered.has(coveredCells[index])) {
          gain += 1;
        }
      }

      if (gain > bestGain) {
        bestGain = gain;
        bestSensorId = sensorId;
      }
    }

    if (bestSensorId === undefined || bestGain === 0) {
      break;
    }

    selectedSensorIds.push(bestSensorId);
    selectedMask.add(bestSensorId);
    const coveredCells = coverageBySensor.get(bestSensorId) ?? [];
    for (let index = 0; index < coveredCells.length; index += 1) {
      uncovered.delete(coveredCells[index]);
    }
  }

  const coveredCellCount = requiredCellIndices.length - uncovered.size;
  return {
    selectedSensorIds,
    candidateSensorIds,
    requiredCellCount: requiredCellIndices.length,
    coveredCellCount,
    uncoveredCellCount: uncovered.size,
    coverageComplete:
      requiredCellIndices.length === 0 ? true : uncovered.size === 0,
    coverageFraction:
      requiredCellIndices.length > 0
        ? coveredCellCount / requiredCellIndices.length
        : 1.0,
    iterations: selectedSensorIds.length,
  };
}

function invokeCoverageStream(state, methodId, inputs = []) {
  const input = inputs[0] ?? {};
  switch (methodId) {
    case "create_grid": {
      const grid = createGridStorage(
        decodeGridConfig(normalizeBinaryInput(input)),
      );
      state.grids.set(grid.gridId, grid);
      return {
        statusCode: 0,
        outputs: [createStreamOutput(encodeGridInfo(grid), "results", input)],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "accumulate_footprints": {
      const { gridId, footprints } = decodeFootprintBatch(
        normalizeBinaryInput(input),
      );
      const analyzer = createCoverageRuntime(state);
      analyzer.accumulateFootprints(gridId, footprints);
      return {
        statusCode: 0,
        outputs: [],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "get_statistics": {
      const bytes = normalizeBinaryInput(input);
      const grid = ensureGrid(state.grids, readUint32(bytes, 0));
      const statistics = computeStatistics(grid);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(encodeStatistics(statistics), "results", input),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "get_access_intervals": {
      const bytes = normalizeBinaryInput(input);
      const gridId = readUint32(bytes, 0);
      const cellIndex = readUint32(bytes, 4);
      const grid = ensureGrid(state.grids, gridId);
      const intervals =
        grid.cells[cellIndex]?.intervals?.map(cloneInterval) ?? [];
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(
            encodeIntervals(gridId, cellIndex, intervals),
            "results",
            input,
          ),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "compute_fom": {
      const bytes = normalizeBinaryInput(input);
      const gridId = readUint32(bytes, 0);
      const fomId = readUint32(bytes, 4);
      const grid = ensureGrid(state.grids, gridId);
      const fomType =
        Object.entries(FOM_IDS).find(([, value]) => value === fomId)?.[0] ??
        "access_count";
      const values = computeFomValues(grid, fomType);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(
            encodeFom(gridId, fomId, values),
            "results",
            input,
          ),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "generate_heatmap": {
      const request = decodeHeatmapRequest(normalizeBinaryInput(input));
      const grid = ensureGrid(state.grids, request.gridId);
      const heatmap = generateHeatmapForGrid(grid, request);
      return {
        statusCode: 0,
        outputs: [createStreamOutput(encodeHeatmap(heatmap), "results", input)],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "analyze_sensor_union": {
      const bytes = normalizeBinaryInput(input);
      const gridId = readUint32(bytes, 0);
      const selectedMask = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getBigUint64(8, true);
      const analyzer = createCoverageRuntime(state);
      const sensorIds = [];
      let probe = selectedMask;
      let sensorIndex = 0;
      while (probe > 0n) {
        if ((probe & 1n) === 1n) {
          sensorIds.push(sensorIndex);
        }
        probe >>= 1n;
        sensorIndex += 1;
      }
      const result = analyzer.analyzeSensorUnion(gridId, { sensorIds });
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(encodeUnionResult(result), "results", input),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    default:
      return {
        statusCode: -1,
        outputs: [],
        backlogRemaining: 0,
        yielded: false,
        errorMessage: `Unknown coverage stream method: ${methodId}`,
      };
  }
}

function createCoverageRuntime(state) {
  return {
    type: "Analysis",
    name: STATIC_METADATA.name,
    version: STATIC_METADATA.version,
    metadata: STATIC_METADATA,
    manifest: STATIC_MANIFEST,
    manifestSource: EMBEDDED_MANIFEST_SOURCE,
    module: Object.freeze({ runtime: "coverage-js" }),
    supportsStreamInvoke: true,

    createGrid(config) {
      const grid = createGridStorage(normalizeGridConfig(config));
      state.grids.set(grid.gridId, grid);
      return getGridInfo(grid);
    },

    destroyGrid(gridId) {
      state.grids.delete(Number(gridId));
    },

    resetGrid(gridId) {
      const grid = ensureGrid(state.grids, gridId);
      grid.cells = Array.from({ length: grid.cellCount }, createEmptyCell);
    },

    getCellIndex(gridId, latitudeDeg, longitudeDeg) {
      const grid = ensureGrid(state.grids, gridId);
      const row = Math.floor(
        (Number(latitudeDeg) - grid.config.minLatitudeDeg) /
          grid.config.latitudeStepDeg,
      );
      const column = Math.floor(
        (Number(longitudeDeg) - grid.config.minLongitudeDeg) /
          grid.config.longitudeStepDeg,
      );
      if (
        row < 0 ||
        row >= grid.rowCount ||
        column < 0 ||
        column >= grid.columnCount
      ) {
        return -1;
      }
      return row * grid.columnCount + column;
    },

    accumulateFootprints(gridId, footprints) {
      const grid = ensureGrid(state.grids, gridId);
      const summary = {
        footprintCount: Array.isArray(footprints) ? footprints.length : 0,
        affectedCells: 0,
        accessedCellCount: 0,
        updatedIntervals: 0,
      };

      for (const footprint of Array.isArray(footprints) ? footprints : []) {
        const vertices = Array.isArray(footprint.vertices)
          ? footprint.vertices
          : [];
        if (vertices.length < 3) {
          continue;
        }
        const minLat = Math.min(...vertices.map((vertex) => vertex.latDeg));
        const maxLat = Math.max(...vertices.map((vertex) => vertex.latDeg));
        const minLon = Math.min(...vertices.map((vertex) => vertex.lonDeg));
        const maxLon = Math.max(...vertices.map((vertex) => vertex.lonDeg));
        const minRow = clamp(
          Math.floor(
            (minLat - grid.config.minLatitudeDeg) / grid.config.latitudeStepDeg,
          ),
          0,
          grid.rowCount - 1,
        );
        const maxRow = clamp(
          Math.floor(
            (maxLat - grid.config.minLatitudeDeg) / grid.config.latitudeStepDeg,
          ),
          0,
          grid.rowCount - 1,
        );
        const minColumn = clamp(
          Math.floor(
            (minLon - grid.config.minLongitudeDeg) /
              grid.config.longitudeStepDeg,
          ),
          0,
          grid.columnCount - 1,
        );
        const maxColumn = clamp(
          Math.floor(
            (maxLon - grid.config.minLongitudeDeg) /
              grid.config.longitudeStepDeg,
          ),
          0,
          grid.columnCount - 1,
        );

        for (let row = minRow; row <= maxRow; row += 1) {
          for (let column = minColumn; column <= maxColumn; column += 1) {
            const center = getCellCenter(grid, row, column);
            if (!pointInPolygon(center, vertices)) {
              continue;
            }
            summary.affectedCells += 1;
            const cellIndex = row * grid.columnCount + column;
            const cell = grid.cells[cellIndex];
            const wasUnaccessed = cell.accessCount === 0;
            const merged = mergeInterval(
              cell.intervals,
              Number(footprint.startEpochJd ?? 0.0),
              Number(footprint.endEpochJd ?? 0.0),
            );
            cell.intervals = merged.intervals;
            cell.sensorMask |= 1n << BigInt(Number(footprint.sensorId ?? 0));
            updateCellMetrics(cell);
            summary.updatedIntervals += merged.createdIntervalCount;
            if (wasUnaccessed && cell.accessCount > 0) {
              summary.accessedCellCount += 1;
            }
          }
        }
      }

      return summary;
    },

    async accumulateSwath(gridId, states, sensorConfig, options = {}) {
      const module = await import("../swath/index.js");
      const analyzer = await module.createSwathAnalyzer(
        options.pluginOptions ?? {},
      );
      try {
        const footprints = (Array.isArray(states) ? states : []).map(
          (state, index) => {
            const footprint = analyzer.computeFootprint(state, sensorConfig);
            return {
              sensorId: Number(options.sensorId ?? 0),
              startEpochJd: Number(state?.julianDate ?? 0.0),
              endEpochJd: Number(
                states[index + 1]?.julianDate ?? state?.julianDate ?? 0.0,
              ),
              vertices: footprint.vertices.map((vertex) => ({
                latDeg: (vertex.latitude * 180.0) / Math.PI,
                lonDeg: (vertex.longitude * 180.0) / Math.PI,
              })),
            };
          },
        );
        return this.accumulateFootprints(gridId, footprints);
      } finally {
        analyzer.destroy();
      }
    },

    getCellData(gridId, cellIndex) {
      const grid = ensureGrid(state.grids, gridId);
      return cloneCell(grid.cells[cellIndex]);
    },

    getGridData(gridId) {
      const grid = ensureGrid(state.grids, gridId);
      return grid.cells.map(cloneCell);
    },

    getAccessIntervals(gridId, cellIndex) {
      const grid = ensureGrid(state.grids, gridId);
      return grid.cells[cellIndex].intervals.map(cloneInterval);
    },

    getStatistics(gridId) {
      const grid = ensureGrid(state.grids, gridId);
      return computeStatistics(grid);
    },

    computeFom(gridId, fomType) {
      const grid = ensureGrid(state.grids, gridId);
      return computeFomValues(grid, fomType);
    },

    analyzeSensorUnion(gridId, options = {}) {
      const grid = ensureGrid(state.grids, gridId);
      const sensorIds = Array.isArray(options.sensorIds)
        ? options.sensorIds
        : [];
      const selectedMask = sensorIds.reduce(
        (mask, sensorId) => mask | (1n << BigInt(sensorId)),
        0n,
      );
      let unionCoveredCells = 0;
      let fullyCoveredCells = 0;
      let partialCoverageCells = 0;
      let gapCells = 0;
      let sensorCountSum = 0.0;
      let maxGapDurationSec = 0.0;

      for (const cell of grid.cells) {
        const overlapMask = cell.sensorMask & selectedMask;
        const overlapCount = bitCount(overlapMask);
        if (overlapCount === 0) {
          gapCells += 1;
          continue;
        }
        unionCoveredCells += 1;
        sensorCountSum += overlapCount;
        maxGapDurationSec = Math.max(maxGapDurationSec, cell.maxRevisitTime);
        if (overlapCount === sensorIds.length) {
          fullyCoveredCells += 1;
        } else {
          partialCoverageCells += 1;
        }
      }

      return {
        unionCoveredCells,
        fullyCoveredCells,
        partialCoverageCells,
        gapCells,
        meanSensorsPerCoveredCell:
          unionCoveredCells > 0 ? sensorCountSum / unionCoveredCells : 0.0,
        maxGapDurationSec,
      };
    },

    computeMinimumSensorSet(gridId, options = {}) {
      const grid = ensureGrid(state.grids, gridId);
      return computeMinimumSensorSetForGrid(grid, options);
    },

    generateHeatmap(gridId, options = {}) {
      const grid = ensureGrid(state.grids, gridId);
      return generateHeatmapForGrid(grid, options);
    },

    streamInvoke({ methodId, inputs = [] } = {}) {
      return invokeCoverageStream(state, methodId, inputs);
    },

    destroy() {
      state.grids.clear();
    },
  };
}

export function getCoverageManifest() {
  return STATIC_MANIFEST;
}

export async function loadCoveragePlugin(options = {}) {
  if (options?.requireEmbeddedManifest === true) {
    return createCoverageAnalyzer(options);
  }
  return createCoverageAnalyzer(options);
}

export async function createCoverageAnalyzer(options = {}) {
  if (options?.requireEmbeddedManifest === true) {
    // This runtime presents the same manifest-source contract as the protected
    // built-ins while remaining a pure JS analytical runtime.
  }
  return createCoverageRuntime(createAnalyzerState());
}

export function createCoverageFlowMethodHandlers(analyzer) {
  return createCoverageFlowMethodHandlersRuntime(analyzer);
}

export const metadata = STATIC_METADATA;

export default createCoverageAnalyzer;
