import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createStandaloneHarnessOrSkip,
  invokeBinaryRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

export const WGS84_A_M = 6378137.0;
export const WGS84_B_M = 6356752.314245;
export const WGS84_E2 = 1.0 - (WGS84_B_M * WGS84_B_M) / (WGS84_A_M * WGS84_A_M);
export const DEFAULT_ALTITUDE_M = 550000.0;
export const DEFAULT_MAX_RANGE_M = 1600000.0;
export const SENSOR_ID = 7;

const WASM_PATH = process.env.SENSOR_COVERAGE_TEST_WASM
  ? pathToFileURL(path.resolve(process.env.SENSOR_COVERAGE_TEST_WASM))
  : new URL("../dist/isomorphic/module.wasm", import.meta.url);

function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    new URL("../../../../spacedatastandards.org", import.meta.url).pathname,
    new URL("../node_modules/spacedatastandards.org", import.meta.url).pathname,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(`${candidate}/lib/js/SCV/main.js`)) {
      return candidate;
    }
  }
  throw new Error("Unable to resolve SDS SCV JavaScript bindings.");
}

const STANDARDS_ROOT = resolveStandardsRoot();
const flatbuffers = await import(
  pathToFileURL(`${STANDARDS_ROOT}/node_modules/flatbuffers/mjs/flatbuffers.js`).href,
);
const bindings = await import(
  pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href,
);

const {
  SCV,
  SCVCoverageGridT,
  SCVCoverageRequestT,
  SCVEllipsoidT,
  SCVSensorT,
  SCVSensorShapeContractT,
  SCVStateSampleT,
  SCVTimeGridT,
  SCVT,
  SCVVec3T,
  scvAnalysisMode,
  scvBodyKind,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvGeometryDomain,
  scvMetricSeriesKind,
  scvRasterProductKind,
  scvSensorRangeBoundaryKind,
  scvSensorShapeKind,
} = bindings;

export {
  SCVTimeGridT,
  scvMetricSeriesKind,
  scvRasterProductKind,
};

export const SENSOR_COVERAGE_TYPE_REF = Object.freeze({
  schemaName: "SCV/main.fbs",
  fileIdentifier: "$SCV",
  rootTypeName: "SCV",
});

export function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
}

export function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

export function add(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

export function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

export function scale(value, scalar) {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

export function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

export function magnitude(value) {
  return Math.sqrt(dot(value, value));
}

export function normalize(value, fallback = { x: 1, y: 0, z: 0 }) {
  const length = magnitude(value);
  if (!(length > 0) || !Number.isFinite(length)) {
    return fallback;
  }
  return scale(value, 1 / length);
}

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function geodeticToEcef(latitudeDeg, longitudeDeg, altitudeM = 0) {
  const latitude = degreesToRadians(latitudeDeg);
  const longitude = degreesToRadians(longitudeDeg);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const primeVertical = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLatitude * sinLatitude);
  return {
    x: (primeVertical + altitudeM) * cosLatitude * Math.cos(longitude),
    y: (primeVertical + altitudeM) * cosLatitude * Math.sin(longitude),
    z: (primeVertical * (1 - WGS84_E2) + altitudeM) * sinLatitude,
  };
}

export function geodeticSurfaceNormal(position) {
  return normalize({
    x: position.x / (WGS84_A_M * WGS84_A_M),
    y: position.y / (WGS84_A_M * WGS84_A_M),
    z: position.z / (WGS84_B_M * WGS84_B_M),
  }, normalize(position));
}

function tangentVelocity(position) {
  let tangent = cross({ x: 0, y: 0, z: 1 }, position);
  if (magnitude(tangent) < 1) {
    tangent = cross({ x: 0, y: 1, z: 0 }, position);
  }
  return scale(normalize(tangent), 7500);
}

export function quaternionFromAxisAngle(axis, angleDeg) {
  const unit = normalize(axis);
  const half = 0.5 * degreesToRadians(angleDeg);
  const sine = Math.sin(half);
  return {
    x: unit.x * sine,
    y: unit.y * sine,
    z: unit.z * sine,
    w: Math.cos(half),
  };
}

export function stateSample({
  elapsedSeconds,
  latitudeDeg,
  longitudeDeg,
  altitudeM = DEFAULT_ALTITUDE_M,
  position = null,
  velocity = null,
  quaternion = { x: 0, y: 0, z: 0, w: 1 },
  sensorId = SENSOR_ID,
}) {
  const resolvedPosition = position ?? geodeticToEcef(latitudeDeg, longitudeDeg, altitudeM);
  const resolvedVelocity = velocity ?? tangentVelocity(resolvedPosition);
  return {
    sensorId,
    elapsedSeconds,
    position: resolvedPosition,
    velocity: resolvedVelocity,
    quaternion,
  };
}

export function conicShape({
  outerHalfAngleDeg,
  innerHalfAngleDeg = 0,
  maxRangeM = DEFAULT_MAX_RANGE_M,
  minRangeM = 0,
  minClockAngleDeg = 0,
  maxClockAngleDeg = 360,
}) {
  return {
    outerHalfAngleDeg,
    innerHalfAngleDeg,
    maxRangeM,
    minRangeM,
    minClockAngleDeg,
    maxClockAngleDeg,
  };
}

export function rectangularShape({
  crossTrackHalfAngleDeg,
  alongTrackHalfAngleDeg,
  maxRangeM = DEFAULT_MAX_RANGE_M,
  minRangeM = 0,
}) {
  return {
    kind: "rectangular",
    crossTrackHalfAngleDeg,
    alongTrackHalfAngleDeg,
    maxRangeM,
    minRangeM,
  };
}

export function sarAnnularSectorShape({
  innerLookAngleDeg,
  outerLookAngleDeg,
  minClockAngleDeg,
  maxClockAngleDeg,
  maxRangeM = DEFAULT_MAX_RANGE_M,
  minRangeM = 0,
  samplingDensity = 2,
}) {
  return {
    kind: "sar-annular-sector",
    innerLookAngleDeg,
    outerLookAngleDeg,
    minClockAngleDeg,
    maxClockAngleDeg,
    maxRangeM,
    minRangeM,
    samplingDensity,
  };
}

function scvShapeContract(shape) {
  if (shape.kind === "rectangular") {
    return new SCVSensorShapeContractT(
      scvSensorShapeKind.RECTANGULAR,
      0,
      scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
      0,
      0,
      0,
      360,
      shape.crossTrackHalfAngleDeg,
      shape.alongTrackHalfAngleDeg,
      0,
      0,
      0,
      shape.minRangeM ?? 0,
      shape.maxRangeM ?? DEFAULT_MAX_RANGE_M,
      [],
      scvCoordinateFrame.BODY_FIXED,
    );
  }
  if (shape.kind === "sar-annular-sector") {
    return new SCVSensorShapeContractT(
      scvSensorShapeKind.SAR_ANNULAR_SECTOR,
      0,
      scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
      0,
      0,
      shape.minClockAngleDeg,
      shape.maxClockAngleDeg,
      0,
      0,
      shape.innerLookAngleDeg,
      shape.outerLookAngleDeg,
      shape.samplingDensity,
      shape.minRangeM ?? 0,
      shape.maxRangeM ?? DEFAULT_MAX_RANGE_M,
      [],
      scvCoordinateFrame.BODY_FIXED,
    );
  }
  return new SCVSensorShapeContractT(
    scvSensorShapeKind.CONIC,
    0,
    scvSensorRangeBoundaryKind.RADIAL_SPHERICAL,
    shape.outerHalfAngleDeg,
    shape.innerHalfAngleDeg ?? 0,
    shape.minClockAngleDeg ?? 0,
    shape.maxClockAngleDeg ?? 360,
    0,
    0,
    0,
    0,
    0,
    shape.minRangeM ?? 0,
    shape.maxRangeM ?? DEFAULT_MAX_RANGE_M,
    [],
    scvCoordinateFrame.BODY_FIXED,
  );
}

export function gridDimensions(grid) {
  return {
    rows: Math.ceil((grid.maxLatitudeDeg - grid.minLatitudeDeg) / grid.latitudeStepDeg),
    columns: Math.ceil((grid.maxLongitudeDeg - grid.minLongitudeDeg) / grid.longitudeStepDeg),
  };
}

export function buildGridCells(grid) {
  const { rows, columns } = gridDimensions(grid);
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const latitude = grid.minLatitudeDeg + (row + 0.5) * grid.latitudeStepDeg;
      const longitude = grid.minLongitudeDeg + (column + 0.5) * grid.longitudeStepDeg;
      cells.push({
        index: row * columns + column,
        row,
        column,
        minLatitudeDeg: clamp(latitude - 0.5 * grid.latitudeStepDeg, -90, 90),
        maxLatitudeDeg: clamp(latitude + 0.5 * grid.latitudeStepDeg, -90, 90),
        minLongitudeDeg: clamp(longitude - 0.5 * grid.longitudeStepDeg, -180, 180),
        maxLongitudeDeg: clamp(longitude + 0.5 * grid.longitudeStepDeg, -180, 180),
      });
    }
  }
  return cells;
}

export function createCoveragePayload({
  id,
  grid,
  timeGrid,
  states,
  shape,
  requestedProducts = [scvMetricSeriesKind.ACCESS_COUNT],
  includeTimeGrid = true,
  includePackedGeometry = false,
}) {
  const { rows, columns } = gridDimensions(grid);
  const stateSamples = states.map((state) => new SCVStateSampleT(
    state.sensorId ?? SENSOR_ID,
    state.elapsedSeconds,
    new SCVVec3T(state.position.x, state.position.y, state.position.z),
    new SCVVec3T(state.velocity.x, state.velocity.y, state.velocity.z),
    state.quaternion.x,
    state.quaternion.y,
    state.quaternion.z,
    state.quaternion.w,
    scvCoordinateFrame.BODY_FIXED,
  ));
  const scvTimeGrid = includeTimeGrid
    ? new SCVTimeGridT(
      null,
      0,
      timeGrid.start,
      timeGrid.stop,
      timeGrid.step,
      timeGrid.gridIndexStart ?? 0,
      timeGrid.count,
    )
    : null;
  const request = new SCVCoverageRequestT(
    id,
    BigInt(timeGrid.count ?? 0),
    scvAnalysisMode.COVERAGE,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      WGS84_A_M,
      WGS84_B_M,
      WGS84_A_M,
      scvCoordinateFrame.BODY_FIXED,
    ),
    scvTimeGrid,
    new SCVCoverageGridT(
      `${id}-grid`,
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      grid.minLatitudeDeg,
      grid.maxLatitudeDeg,
      grid.minLongitudeDeg,
      grid.maxLongitudeDeg,
      grid.latitudeStepDeg,
      grid.longitudeStepDeg,
      0,
      rows * columns,
      rows,
    ),
    [
      new SCVSensorT(
        SENSOR_ID,
        "sensor-7",
        id,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        scvShapeContract(shape),
      ),
    ],
    stateSamples,
    [],
    [],
    requestedProducts,
    0,
    0,
    0,
    0,
    undefined,
    includePackedGeometry,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

export async function createContractHarness(t) {
  if (
    typeof SharedArrayBuffer !== "function" ||
    typeof globalThis.WebAssembly?.Memory !== "function"
  ) {
    t.skip("Shared-memory browser direct harness is unavailable in this runtime.");
    return null;
  }
  return createStandaloneHarnessOrSkip("browser", WASM_PATH, t, {
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
}

export function invokeCoveragePayload(harness, payload) {
  return invokeBinaryRequest(harness, payload, {
    methodId: "compute_sensor_coverage",
    inputPortId: "coverage",
    inputTypeRef: SENSOR_COVERAGE_TYPE_REF,
    alignment: 8,
  });
}

function decodeResult(response) {
  const envelopes = response.outputs
    .filter((frame) => frame.typeRef?.fileIdentifier === "$SCV")
    .map((frame) => {
      const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
      assert.equal(SCV.bufferHasIdentifier(byteBuffer), true);
      return SCV.getRootAsSCV(byteBuffer);
    });
  const resultEnvelope = envelopes.find(
    (envelope) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.RESULT,
  );
  assert.ok(resultEnvelope, "missing canonical SCV RESULT output frame");
  const result = resultEnvelope.RESULT();
  assert.ok(result, "missing SCV RESULT payload");
  return result;
}

function findBand(raster, productKind) {
  for (let index = 0; index < raster.bandsLength(); index += 1) {
    const band = raster.BANDS(index);
    if (band?.PRODUCT_KIND() === productKind) {
      return band;
    }
  }
  return null;
}

function regionMap(raster) {
  const regions = new Map();
  for (let index = 0; index < raster.memoryRegionsLength(); index += 1) {
    const region = raster.MEMORY_REGIONS(index);
    regions.set(`${region.REGION_ID()}:${region.RECORD_INDEX()}`, region);
  }
  return regions;
}

function copyBand(raster, productKind, memoryBuffer, ArrayType) {
  const band = findBand(raster, productKind);
  assert.ok(band, `missing raster band ${productKind}`);
  const region = regionMap(raster).get(
    `${band.MEMORY_REGION_ID()}:${band.MEMORY_RECORD_INDEX()}`,
  );
  assert.ok(region, `missing raster memory region for band ${productKind}`);
  const offset = Number(region.BYTE_OFFSET());
  const byteLength = Number(region.BYTE_LENGTH());
  assert.equal(byteLength % ArrayType.BYTES_PER_ELEMENT, 0);
  return Array.from(
    new ArrayType(memoryBuffer, offset, byteLength / ArrayType.BYTES_PER_ELEMENT),
  );
}

export async function invokeAndReadCoverage(harness, payload) {
  const response = await invokeCoveragePayload(harness, payload);
  assert.equal(response.statusCode, 0, `module invoke failed: ${response.errorMessage}`);
  const result = decodeResult(response);
  const raster = result.RASTER_PRODUCTS();
  assert.ok(raster, "SCV result must include RASTER_PRODUCTS");
  const memory = harness.memory.buffer;
  const bitset = copyBand(
    raster,
    scvRasterProductKind.CURRENT_ACCESS_BITSET,
    memory,
    Uint32Array,
  );
  const passCount = copyBand(
    raster,
    scvRasterProductKind.PASS_COUNT,
    memory,
    Uint32Array,
  );
  const bucketStart = copyBand(
    raster,
    scvRasterProductKind.BUCKET_START_SECONDS,
    memory,
    Float64Array,
  );
  const bucketStop = copyBand(
    raster,
    scvRasterProductKind.BUCKET_STOP_SECONDS,
    memory,
    Float64Array,
  );
  const activeCellCount = copyBand(
    raster,
    scvRasterProductKind.BUCKET_ACTIVE_CELL_COUNT,
    memory,
    Uint32Array,
  );
  return {
    response,
    result,
    raster,
    bucketCount: raster.BUCKET_COUNT(),
    wordsPerBucket: raster.WORDS_PER_BUCKET(),
    bitset,
    passCount,
    bucketStart,
    bucketStop,
    activeCellCount,
  };
}

export function bitIsSet(output, bucketIndex, cellIndex) {
  const wordIndex = bucketIndex * output.wordsPerBucket + Math.floor(cellIndex / 32);
  return (output.bitset[wordIndex] & (1 << (cellIndex % 32))) !== 0;
}

function rotateByQuaternion(quaternion, vector) {
  const qVector = { x: quaternion.x, y: quaternion.y, z: quaternion.z };
  const twiceCross = scale(cross(qVector, vector), 2);
  return add(add(vector, scale(twiceCross, quaternion.w)), cross(qVector, twiceCross));
}

function derivedFrame(state) {
  const radial = normalize(state.position);
  let xAxis = subtract(state.velocity, scale(radial, dot(state.velocity, radial)));
  xAxis = normalize(xAxis, normalize({ x: -radial.y, y: radial.x, z: 0 }));
  const boresight = scale(radial, -1);
  const yAxis = normalize(cross(boresight, xAxis), { x: 0, y: 0, z: 1 });
  return { boresight, xAxis, yAxis };
}

function frameVectorFromLocal(base, local) {
  return add(
    add(scale(base.xAxis, local.x), scale(base.yAxis, local.y)),
    scale(base.boresight, local.z),
  );
}

export function resolvedFrame(state) {
  const base = derivedFrame(state);
  const quaternion = normalizeQuaternion(state.quaternion);
  return {
    boresight: normalize(
      frameVectorFromLocal(base, rotateByQuaternion(quaternion, { x: 0, y: 0, z: 1 })),
      base.boresight,
    ),
    xAxis: normalize(
      frameVectorFromLocal(base, rotateByQuaternion(quaternion, { x: 1, y: 0, z: 0 })),
      base.xAxis,
    ),
    yAxis: normalize(
      frameVectorFromLocal(base, rotateByQuaternion(quaternion, { x: 0, y: 1, z: 0 })),
      base.yAxis,
    ),
  };
}

function normalizeQuaternion(value) {
  const length = Math.sqrt(
    value.x * value.x + value.y * value.y + value.z * value.z + value.w * value.w,
  );
  if (!(length > 0) || !Number.isFinite(length)) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length,
    w: value.w / length,
  };
}

export function interpolateState(start, stop, elapsedSeconds) {
  const span = stop.elapsedSeconds - start.elapsedSeconds;
  const fraction = span > 0
    ? clamp((elapsedSeconds - start.elapsedSeconds) / span, 0, 1)
    : 0;
  const startFrame = resolvedFrame(start);
  const stopFrame = resolvedFrame(stop);
  const interpolated = {
    sensorId: start.sensorId,
    elapsedSeconds,
    position: add(start.position, scale(subtract(stop.position, start.position), fraction)),
    velocity: add(start.velocity, scale(subtract(stop.velocity, start.velocity), fraction)),
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
  const frame = {
    boresight: normalize(add(startFrame.boresight, scale(subtract(stopFrame.boresight, startFrame.boresight), fraction))),
    xAxis: normalize(add(startFrame.xAxis, scale(subtract(stopFrame.xAxis, startFrame.xAxis), fraction))),
    yAxis: normalize(add(startFrame.yAxis, scale(subtract(stopFrame.yAxis, startFrame.yAxis), fraction))),
  };
  return { ...interpolated, resolvedFrame: frame };
}

export function surfacePointVisible(latitudeDeg, longitudeDeg, state, shape, toleranceRad = 2e-12) {
  const surface = geodeticToEcef(latitudeDeg, longitudeDeg, 0);
  const normal = geodeticSurfaceNormal(surface);
  const sensorToPoint = subtract(surface, state.position);
  const range = magnitude(sensorToPoint);
  if (!(range > 0) || !Number.isFinite(range)) {
    return false;
  }
  if (range + 1e-7 < (shape.minRangeM ?? 0) || range - 1e-7 > shape.maxRangeM) {
    return false;
  }
  const targetToSensor = normalize(subtract(state.position, surface));
  if (!(dot(targetToSensor, normal) > 0)) {
    return false;
  }
  const frame = state.resolvedFrame ?? resolvedFrame(state);
  const look = scale(sensorToPoint, 1 / range);
  const forward = dot(look, frame.boresight);
  if (!(forward > 0)) {
    return false;
  }
  const angle = Math.acos(clamp(forward, -1, 1));
  return angle <= degreesToRadians(shape.outerHalfAngleDeg) + toleranceRad &&
    angle + toleranceRad >= degreesToRadians(shape.innerHalfAngleDeg ?? 0);
}

export function cellVisibleOnLattice(
  cell,
  state,
  shape,
  divisions = 64,
  extraPoints = [],
) {
  for (let latitudeIndex = 0; latitudeIndex <= divisions; latitudeIndex += 1) {
    const latitude = cell.minLatitudeDeg +
      ((cell.maxLatitudeDeg - cell.minLatitudeDeg) * latitudeIndex) / divisions;
    for (let longitudeIndex = 0; longitudeIndex <= divisions; longitudeIndex += 1) {
      const longitude = cell.minLongitudeDeg +
        ((cell.maxLongitudeDeg - cell.minLongitudeDeg) * longitudeIndex) / divisions;
      if (surfacePointVisible(latitude, longitude, state, shape)) {
        return true;
      }
    }
  }
  return extraPoints.some(({ latitudeDeg, longitudeDeg }) =>
    latitudeDeg >= cell.minLatitudeDeg &&
    latitudeDeg <= cell.maxLatitudeDeg &&
    longitudeDeg >= cell.minLongitudeDeg &&
    longitudeDeg <= cell.maxLongitudeDeg &&
    surfacePointVisible(latitudeDeg, longitudeDeg, state, shape));
}

export function productionLatticeCellVisible(cell, state, shape) {
  const latitudes = [
    cell.minLatitudeDeg,
    0.5 * (cell.minLatitudeDeg + cell.maxLatitudeDeg),
    cell.maxLatitudeDeg,
  ];
  const longitudes = [
    cell.minLongitudeDeg,
    0.5 * (cell.minLongitudeDeg + cell.maxLongitudeDeg),
    cell.maxLongitudeDeg,
  ];
  return latitudes.some((latitude) =>
    longitudes.some((longitude) => surfacePointVisible(latitude, longitude, state, shape)));
}

export function lookAngleDegrees(state, latitudeDeg, longitudeDeg) {
  const point = geodeticToEcef(latitudeDeg, longitudeDeg, 0);
  const sensorToPoint = subtract(point, state.position);
  const frame = state.resolvedFrame ?? resolvedFrame(state);
  return radiansToDegrees(Math.acos(clamp(
    dot(normalize(sensorToPoint), frame.boresight),
    -1,
    1,
  )));
}
