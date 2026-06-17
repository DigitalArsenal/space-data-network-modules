import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = resolveStandardsRoot();
const flatbuffers = await import(
  pathToFileURL(`${STANDARDS_ROOT}/node_modules/flatbuffers/mjs/flatbuffers.js`).href
);
const {
  SCV,
  SCVCoverageGridT,
  SCVCoverageRequestT,
  SCVEllipsoidT,
  SCVSensorT,
  SCVStateSampleT,
  SCVTimeGridT,
  SCVT,
  SCVVec3T,
  scvBodyKind,
  scvCoordinateFrame,
  scvEnvelopeKind,
  scvGeometryDomain,
  scvIntervalCategory,
  scvResultState,
  scvSensorShapeKind,
} = await import(pathToFileURL(`${STANDARDS_ROOT}/lib/js/SCV/main.js`).href);
const JSON_COVERAGE_REQUEST_TYPE = Object.freeze({
  schemaName: "SensorCoverageCompatibilityJson",
  fileIdentifier: "JSON",
  rootTypeName: "SensorCoverageCompatibilityRequest",
});

function decodeScvFrames(response) {
  return response.outputs
    .filter((frame) => frame.typeRef?.fileIdentifier === "$SCV")
    .map((frame) => {
      const byteBuffer = new flatbuffers.ByteBuffer(frame.payload);
      assert.equal(SCV.bufferHasIdentifier(byteBuffer), true);
      return {
        frame,
        envelope: SCV.getRootAsSCV(byteBuffer),
      };
    });
}

function findScvEnvelope(response, envelopeKind) {
  return decodeScvFrames(response).find(
    ({ envelope }) => envelope.ENVELOPE_KIND() === envelopeKind,
  );
}

function assertRenderableScvGeometry(result, expectedSegments) {
  const geometry = result.GEOMETRY();
  assert.ok(geometry, "SCV result must include packed geometry for rendering");
  assert.equal(geometry.WINDOW_COUNT(), expectedSegments);
  assert.equal(geometry.segmentIdsLength(), expectedSegments);
  assert.equal(geometry.sensorIdsLength(), expectedSegments);
  assert.equal(geometry.segmentsLength(), expectedSegments);
  assert.equal(geometry.revealCoordsLength(), expectedSegments * 8);
  assert.equal(geometry.indicesLength(), expectedSegments * 6);
  assert.equal(geometry.SEGMENT_IDS(0), 0);
  assert.equal(geometry.INDICES(0), 0);
  assert.equal(geometry.INDICES(5), 3);
  const firstSegment = geometry.SEGMENTS(0);
  assert.ok(firstSegment, "SCV geometry must include segment descriptors");
  assert.equal(firstSegment.VERTEX_COUNT(), 4);
  assert.equal(firstSegment.INDEX_COUNT(), 6);
  assert.equal(firstSegment.START_OFFSET_SEC(), 0);
}

function resolveStandardsRoot() {
  const candidates = [
    process.env.SPACE_DATA_STANDARDS_ROOT,
    new URL("../../../../sds-wasm-module-architecture", import.meta.url).pathname,
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

function createSingleSensorCoverageRequest() {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const makeState = (theta, elapsedSeconds) => ({
    elapsedSeconds,
    position: {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
      z: 0,
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: 0,
    },
  });
  return {
    sensors: [
      {
        sensorId: 7,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: [
          makeState(-0.04, 0),
          makeState(0, 600),
          makeState(0.04, 1200),
        ],
      },
    ],
    grid: {
      minLatitudeDeg: -8,
      maxLatitudeDeg: 8,
      minLongitudeDeg: -12,
      maxLongitudeDeg: 12,
      latitudeStepDeg: 4,
      longitudeStepDeg: 4,
    },
    timeSpan: {
      startSeconds: 0,
      stopSeconds: 1200,
    },
    figureOfMerit: "percent_coverage",
  };
}

function createSeparatedContributorCoverageRequest() {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const makeState = (theta, elapsedSeconds) => ({
    elapsedSeconds,
    position: {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
      z: 0,
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: 0,
    },
  });
  const firstPassStates = [
    makeState(-0.08, 0),
    makeState(-0.04, 600),
    makeState(0, 1200),
    makeState(0.04, 1800),
    makeState(0.08, 2400),
  ];
  const secondPassStates = [
    makeState(-0.08, 3600),
    makeState(-0.04, 4200),
    makeState(0, 4800),
    makeState(0.04, 5400),
    makeState(0.08, 6000),
  ];

  return {
    sensors: [
      {
        sensorId: 0,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: firstPassStates,
      },
      {
        sensorId: 33,
        type: "conic",
        outerHalfAngleRad: 0.22,
        radiusMeters: 1600000,
        states: secondPassStates,
      },
    ],
    grid: {
      minLatitudeDeg: -8,
      maxLatitudeDeg: 8,
      minLongitudeDeg: -12,
      maxLongitudeDeg: 12,
      latitudeStepDeg: 2,
      longitudeStepDeg: 2,
    },
    timeSpan: {
      startSeconds: 0,
      stopSeconds: 6000,
    },
    figureOfMerit: "percent_coverage",
  };
}

function createScvCoverageRequestPayload({ windowCount = 2 } = {}) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const stepSeconds = 600;
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      7,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      0,
      0,
      0,
      1,
      scvCoordinateFrame.BODY_FIXED,
    );
  const stateSamples = [];
  for (let index = 0; index <= windowCount; index++) {
    const fraction = windowCount > 0 ? index / windowCount : 0;
    stateSamples.push(makeState(-0.04 + 0.08 * fraction, index * stepSeconds));
  }
  const request = new SCVCoverageRequestT(
    "scv-request-test",
    BigInt("42"),
    undefined,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, windowCount * stepSeconds, stepSeconds, 0, windowCount),
    new SCVCoverageGridT(
      "regional-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -8,
      8,
      -12,
      12,
      4,
      4,
      0,
      24,
      4,
    ),
    [
      new SCVSensorT(
        7,
        "sensor-7",
        "SCV request sensor",
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        0.22 * (180 / Math.PI),
        0,
        0,
        0,
        1600000,
      ),
    ],
    stateSamples,
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createScvOffNadirCoverageRequestPayload(offNadirAlongTrackRad = 0) {
  const earthRadius = 6378137.0;
  const orbitRadius = earthRadius + 500000.0;
  const speed = 7612.608173223869;
  const halfAngleDeg = 0.08 * (180 / Math.PI);
  const rotationHalfAngle = offNadirAlongTrackRad / 2;
  const qx = 0;
  const qy = Math.sin(rotationHalfAngle);
  const qz = 0;
  const qw = Math.cos(rotationHalfAngle);
  const makeState = (theta, elapsedSeconds) =>
    new SCVStateSampleT(
      0,
      elapsedSeconds,
      new SCVVec3T(
        orbitRadius * Math.cos(theta),
        orbitRadius * Math.sin(theta),
        0,
      ),
      new SCVVec3T(-speed * Math.sin(theta), speed * Math.cos(theta), 0),
      qx,
      qy,
      qz,
      qw,
      scvCoordinateFrame.BODY_FIXED,
    );
  const request = new SCVCoverageRequestT(
    "scv-off-nadir-parity",
    BigInt("77"),
    undefined,
    new SCVEllipsoidT(
      scvBodyKind.EARTH,
      "Earth",
      earthRadius,
      6356752.314245,
      earthRadius,
      scvCoordinateFrame.BODY_FIXED,
    ),
    new SCVTimeGridT(null, 0, 0, 1200, 600, 0, 2),
    new SCVCoverageGridT(
      "off-nadir-grid",
      scvGeometryDomain.SURFACE,
      scvCoordinateFrame.BODY_FIXED,
      -8,
      8,
      -16,
      16,
      2,
      2,
      0,
      128,
      2,
    ),
    [
      new SCVSensorT(
        0,
        "sensor-0",
        "SCV off-nadir parity sensor",
        scvSensorShapeKind.CONIC,
        scvCoordinateFrame.BODY_FIXED,
        null,
        null,
        null,
        null,
        halfAngleDeg,
        0,
        0,
        0,
        1600000,
      ),
    ],
    [makeState(-0.03, 0), makeState(0, 600), makeState(0.03, 1200)],
  );
  const envelope = new SCVT(scvEnvelopeKind.REQUEST, request);
  const builder = new flatbuffers.Builder(1024);
  SCV.finishSCVBuffer(builder, envelope.pack(builder));
  return builder.asUint8Array();
}

function createSensorCoverageHarness(runtimeKind, t) {
  return createStandaloneHarnessOrSkip(
    runtimeKind,
    WASM_PATH,
    t,
    runtimeKind === "browser" ? { surface: "direct" } : {},
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`sensor coverage module accepts an SDS SCV binary request frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.some((frame) => frame.typeRef?.fileIdentifier === "JSON"),
      false,
      "SCV request path should not emit JSON compatibility results",
    );
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assert.equal(result.cellStatsLength(), 24);
    assertRenderableScvGeometry(result, 2);
  });

  test(`sensor coverage module emits SDS SCV progress frames on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload(),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const progressEnvelopes = decodeScvFrames(response)
      .filter(({ envelope }) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.PROGRESS);
    const progressEnvelope = progressEnvelopes.at(-1);
    assert.ok(progressEnvelope, "missing canonical SCV progress output frame");
    assert.equal(progressEnvelope.frame.portId, "coverage");
    const progress = progressEnvelope.envelope.PROGRESS();
    assert.ok(progress, "missing SCV PROGRESS payload");
    assert.equal(progress.TOTAL_SENSORS(), 1);
    assert.equal(progress.TOTAL_WINDOWS(), 2);
    assert.equal(progress.COMPLETED_WINDOWS(), 2);
    assert.equal(progress.BACKLOG_REMAINING(), 0);
    assert.equal(progress.COMPLETION_FRACTION(), 1);
    assert.match(progress.MESSAGE(), /complete/i);
  });

  test(`sensor coverage module emits non-final SDS SCV progress cadence on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: {
            schemaName: "SCV/main.fbs",
            fileIdentifier: "$SCV",
            rootTypeName: "SCV",
          },
          payload: createScvCoverageRequestPayload({ windowCount: 5 }),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const progressFrames = decodeScvFrames(response)
      .filter(({ envelope }) => envelope.ENVELOPE_KIND() === scvEnvelopeKind.PROGRESS)
      .map(({ envelope }) => envelope.PROGRESS());
    assert.ok(
      progressFrames.length >= 2,
      `expected at least one non-final progress frame plus final progress, got ${progressFrames.length}`,
    );
    assert.ok(
      progressFrames.some((progress) =>
        progress &&
        progress.TOTAL_WINDOWS() === 5 &&
        progress.COMPLETED_WINDOWS() > 0 &&
        progress.COMPLETED_WINDOWS() < progress.TOTAL_WINDOWS() &&
        progress.COMPLETION_FRACTION() > 0 &&
        progress.COMPLETION_FRACTION() < 1
      ),
      "expected a non-final progress frame for the multi-window SCV job",
    );
    const finalProgress = progressFrames.at(-1);
    assert.equal(finalProgress.TOTAL_WINDOWS(), 5);
    assert.equal(finalProgress.COMPLETED_WINDOWS(), 5);
    assert.equal(finalProgress.BACKLOG_REMAINING(), 0);
    assert.equal(finalProgress.COMPLETION_FRACTION(), 1);
  });

  test(`sensor coverage module emits an SDS SCV binary result frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: JSON_COVERAGE_REQUEST_TYPE,
          payload: Buffer.from(
            JSON.stringify(createSingleSensorCoverageRequest()),
            "utf8",
          ),
        },
      ],
    });

    assert.equal(response.statusCode, 0);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    assert.equal(resultEnvelope.frame.portId, "coverage");
    assert.equal(resultEnvelope.frame.typeRef?.schemaName, "SCV/main.fbs");

    const envelope = resultEnvelope.envelope;
    assert.equal(envelope.ENVELOPE_KIND(), scvEnvelopeKind.RESULT);
    const result = envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.equal(result.STATUS(), scvResultState.OK);
    assert.equal(result.TOTAL_SENSORS(), 1);
    assert.equal(result.TOTAL_WINDOWS(), 2);
    assert.equal(result.cellStatsLength(), 24);
    assertRenderableScvGeometry(result, 2);
  });

  test(`sensor coverage module aggregates all active sensors into one differential geometry product on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const makeState = (theta, elapsedSeconds) => ({
      elapsedSeconds,
      position: {
        x: orbitRadius * Math.cos(theta),
        y: orbitRadius * Math.sin(theta),
        z: 0,
      },
      velocity: {
        x: -speed * Math.sin(theta),
        y: speed * Math.cos(theta),
        z: 0,
      },
    });
    const sharedStates = [
      makeState(-0.08, 0),
      makeState(-0.04, 600),
      makeState(0, 1200),
      makeState(0.04, 1800),
      makeState(0.08, 2400),
    ];

    const sensors = Array.from({ length: 3 }, (_, sensorIndex) => ({
      sensorId: sensorIndex,
      type: "conic",
      outerHalfAngleRad: 0.22,
      radiusMeters: 1600000,
      states: sharedStates,
    }));

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "all active sensors in one analysis",
          attachedToPropagatedEntity: true,
          positionPropertyType: "PropagatedPositionProperty",
          requestedSensorCount: sensors.length,
        },
        sensors,
        grid: {
          minLatitudeDeg: -8,
          maxLatitudeDeg: 8,
          minLongitudeDeg: -12,
          maxLongitudeDeg: 12,
          latitudeStepDeg: 2,
          longitudeStepDeg: 2,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 2400,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.statistics.activeSensorCount, 3);
    assert.equal(result.swaths.length, 12);
    assert.equal(result.aggregateGeometry.contract, "orbpro.coverage.aggregate.v0");
    assert.equal(result.aggregateGeometry.aggregation, "all_active_sensors");
    assert.equal(result.aggregateGeometry.operationMode, "additive_deltas");
    assert.equal(result.aggregateGeometry.activeSensorCount, 3);
    assert.equal(result.aggregateGeometry.full.kind, "multipolygon");
    assert.equal(result.aggregateGeometry.full.polygonCount, result.swaths.length);
    assert.equal(result.aggregateGeometry.full.ringReference, "swaths[].vertices");
    assert.equal(result.aggregateGeometry.deltas.length, result.swaths.length);
    assert.ok(
      result.aggregateGeometry.deltas.every((delta) => delta.operation === "add"),
    );
    assert.ok(
      result.aggregateGeometry.deltas.every((delta) =>
        Number.isInteger(delta.chunkId),
      ),
    );
    assert.ok(
      result.cells.some((cell) => cell.sensorContributionCount > 1),
      "expected at least one grid cell to record overlapping sensor contribution",
    );
    assert.ok(
      Array.isArray(result.coverageIntervals),
      "coverage result should expose merged access intervals",
    );
    assert.ok(result.coverageIntervals.length > 0);
    assert.equal(
      result.statistics.totalIntervalCount,
      result.coverageIntervals.length,
    );
    assert.ok(Number.isFinite(result.statistics.maxGapDurationSec));
    assert.ok(Number.isFinite(result.statistics.meanRevisitTimeSec));
    assert.ok(Number.isFinite(result.statistics.maxResponseTimeSec));
    assert.ok(Number.isFinite(result.statistics.meanResponseTimeSec));
    assert.ok(Number.isInteger(result.statistics.totalRevisitCount));
    assert.ok(
      result.coverageIntervals.every(
        (interval) =>
          interval.stopSeconds > interval.startSeconds &&
          interval.durationSec === interval.stopSeconds - interval.startSeconds,
      ),
    );
    assert.ok(
      result.cells.some(
        (cell) =>
          cell.intervals.length > 0 &&
          Number.isFinite(cell.firstResponseTimeSec) &&
          Number.isFinite(cell.maxResponseTimeSec),
      ),
      "expected covered cells to include interval and response metrics",
    );
    assert.deepEqual(
      Object.keys(result.figureOfMerit.products).sort(),
      [
        "gap_time",
        "percent_coverage",
        "response_time",
        "revisit_time",
      ],
    );
    assert.equal(result.figureOfMerit.products.percent_coverage.units, "percent");
    assert.equal(result.figureOfMerit.products.gap_time.units, "seconds");
    assert.equal(result.figureOfMerit.products.revisit_time.units, "seconds");
    assert.equal(result.figureOfMerit.products.response_time.units, "seconds");
    assert.equal(
      result.figureOfMerit.products.response_time.values.length,
      result.grid.cellCount,
    );
  });

  test(`sensor coverage module accepts a 1000-sensor analysis without splitting work per sensor on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 550000.0;
    const speed = 7560.0;
    const sensors = Array.from({ length: 1000 }, (_, sensorIndex) => {
      const phase = (2 * Math.PI * sensorIndex) / 1000;
      const inclination = 0.22 * Math.sin(sensorIndex * 0.37);
      const makeState = (theta, elapsedSeconds) => ({
        elapsedSeconds,
        position: {
          x: orbitRadius * Math.cos(theta + phase),
          y: orbitRadius * Math.sin(theta + phase),
          z: orbitRadius * inclination * Math.sin(theta + phase),
        },
        velocity: {
          x: -speed * Math.sin(theta + phase),
          y: speed * Math.cos(theta + phase),
          z: speed * inclination * Math.cos(theta + phase),
        },
      });
      return {
        sensorId: sensorIndex,
        type: "conic",
        outerHalfAngleRad: 0.055,
        radiusMeters: 900000,
        angularSamples: 8,
        states: [makeState(0, 0), makeState(0.025, 180)],
      };
    });

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "1000 satellite aggregate coverage",
          requestedSensorCount: sensors.length,
        },
        sensors,
        grid: {
          minLatitudeDeg: -30,
          maxLatitudeDeg: 30,
          minLongitudeDeg: -180,
          maxLongitudeDeg: 180,
          latitudeStepDeg: 15,
          longitudeStepDeg: 30,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 180,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.statistics.activeSensorCount, 1000);
    assert.equal(result.swaths.length, 1000);
    assert.equal(result.aggregateGeometry.activeSensorCount, 1000);
    assert.equal(result.aggregateGeometry.full.polygonCount, 1000);
    assert.equal(result.aggregateGeometry.deltas.length, 1000);
    assert.ok(result.statistics.accessedCells > 0);

    const highSensorCell = result.cells.find(
      (cell) =>
        Array.isArray(cell.sensorIds) &&
        cell.sensorIds.some((sensorId) => sensorId >= 32),
    );
    assert.ok(
      highSensorCell,
      "expected exact contributing sensor ids beyond the legacy 32-bit mask",
    );
    assert.equal(
      highSensorCell.sensorContributionCount,
      highSensorCell.sensorIds.length,
    );
    assert.ok(Array.isArray(highSensorCell.sensorBitsetWords));
    assert.ok(
      highSensorCell.sensorBitsetWords.length >=
        Math.floor(Math.max(...highSensorCell.sensorIds) / 64) + 1,
    );
    assert.ok(
      highSensorCell.sensorBitsetWords.every((word) => typeof word === "string"),
      "JSON compatibility results should encode 64-bit bitset words as decimal strings",
    );
    assert.ok(
      result.coverageIntervals.every((interval) => Array.isArray(interval.sensorIds)),
      "coverage intervals should expose exact contributing sensor ids",
    );
  });

  test(`sensor coverage intervals preserve exact per-interval contributors beyond 32 sensors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      createSeparatedContributorCoverageRequest(),
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const intervalsByCell = new Map();
    for (const interval of result.coverageIntervals) {
      const intervals = intervalsByCell.get(interval.cellIndex) ?? [];
      intervals.push(interval);
      intervalsByCell.set(interval.cellIndex, intervals);
    }
    const intervals = Array.from(intervalsByCell.values())
      .find(
        (entries) =>
          entries.some((interval) => interval.sensorIds.includes(0)) &&
          entries.some((interval) => interval.sensorIds.includes(33)),
      )
      ?.sort((left, right) => left.startSeconds - right.startSeconds) ?? [];
    assert.equal(intervals.length, 2);
    assert.deepEqual(intervals[0].sensorIds, [0]);
    assert.deepEqual(intervals[1].sensorIds, [33]);
    assert.equal(intervals[1].sensorContributionCount, 1);
    assert.deepEqual(intervals[1].sensorBitsetWords, ["8589934592"]);
  });

  test(`sensor coverage SCV result emits canonical access intervals beyond 32 sensors on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke({
      methodId: "compute_sensor_coverage",
      inputs: [
        {
          portId: "coverage",
          typeRef: JSON_COVERAGE_REQUEST_TYPE,
          payload: Buffer.from(
            JSON.stringify(createSeparatedContributorCoverageRequest()),
            "utf8",
          ),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
    assert.ok(resultEnvelope, "missing canonical SCV result output frame");
    const result = resultEnvelope.envelope.RESULT();
    assert.ok(result, "missing SCV RESULT payload");
    assert.ok(result.intervalsLength() >= 2);

    const intervals = Array.from(
      { length: result.intervalsLength() },
      (_, index) => result.INTERVALS(index),
    );
    const intervalsByCell = new Map();
    for (const interval of intervals) {
      const cellIntervals = intervalsByCell.get(interval.CELL_ID()) ?? [];
      cellIntervals.push(interval);
      intervalsByCell.set(interval.CELL_ID(), cellIntervals);
    }
    const cellIntervals =
      Array.from(intervalsByCell.values())
        .find(
          (entries) =>
            entries.some((interval) => interval.SENSOR_ID() === 0) &&
            entries.some((interval) => interval.SENSOR_ID() === 33),
        )
        ?.sort((left, right) => left.START_OFFSET_SEC() - right.START_OFFSET_SEC()) ?? [];
    assert.equal(cellIntervals.length, 2);
    assert.equal(cellIntervals[0].SENSOR_ID(), 0);
    assert.equal(cellIntervals[1].SENSOR_ID(), 33);
    assert.equal(cellIntervals[0].INTERVAL_KIND(), scvIntervalCategory.ACCESS);
    assert.equal(cellIntervals[1].INTERVAL_KIND(), scvIntervalCategory.ACCESS);
    assert.equal(
      cellIntervals[1].DURATION_SEC(),
      cellIntervals[1].STOP_OFFSET_SEC() - cellIntervals[1].START_OFFSET_SEC(),
    );
    assert.ok(cellIntervals[1].START_OFFSET_SEC() >= 3600);
  });

  test(`sensor coverage module handles the dense 1000-satellite Sandcastle batch shape on ${runtimeKind}`, async (t) => {
    if (runtimeKind !== "browser") {
      t.skip("Dense Sandcastle batch stress is guarded on the browser worker path.");
      return;
    }
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const stateCount = 25;
    const sensorCount = 400;
    const stepSeconds = 5;
    const meanMotion = speed / orbitRadius;
    const sensors = Array.from({ length: sensorCount }, (_, sensorIndex) => {
      const phase = (2 * Math.PI * sensorIndex) / 1000;
      const ringIndex = Math.floor(sensorIndex / 25);
      const inclinationScale = 0.12;
      const makeState = (stateIndex) => {
        const elapsedSeconds = stateIndex * stepSeconds;
        const theta = -0.22 + phase + meanMotion * elapsedSeconds;
        const zTheta = theta * 0.7 + ringIndex * ((2 * Math.PI) / 40);
        return {
          elapsedSeconds,
          position: {
            x: orbitRadius * Math.cos(theta),
            y: orbitRadius * Math.sin(theta),
            z: orbitRadius * inclinationScale * Math.sin(zTheta),
          },
          velocity: {
            x: -speed * Math.sin(theta),
            y: speed * Math.cos(theta),
            z: speed * inclinationScale * 0.7 * Math.cos(zTheta),
          },
        };
      };
      return {
        sensorId: sensorIndex,
        type: "conic",
        outerHalfAngleRad: (12.5 * Math.PI) / 180,
        radiusMeters: 1600000,
        angularSamples: 8,
        states: Array.from({ length: stateCount }, (_, stateIndex) =>
          makeState(stateIndex),
        ),
      };
    });

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "1000 satellite aggregate coverage first worker batch",
          requestedSensorCount: 1000,
          batchStartSensorIndex: 0,
          batchSensorCount: sensorCount,
        },
        sensors,
        grid: {
          minLatitudeDeg: -90,
          maxLatitudeDeg: 90,
          minLongitudeDeg: -180,
          maxLongitudeDeg: 180,
          latitudeStepDeg: 5,
          longitudeStepDeg: 5,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 120,
        },
        figureOfMerit: "percent_coverage",
        outputMode: "aggregate_differential_geometry",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.statistics.activeSensorCount, sensorCount);
    assert.equal(result.swaths.length, sensorCount * (stateCount - 1));
    assert.equal(result.aggregateGeometry.full.polygonCount, result.swaths.length);
    assert.ok(result.statistics.accessedCells > 0);
    assert.ok(result.coverageIntervals.length > 0);
  });

  test(`sensor coverage module derives moving Orekit-style swaths from sensor-attached states on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const makeState = (theta, elapsedSeconds) => ({
      elapsedSeconds,
      position: {
        x: orbitRadius * Math.cos(theta),
        y: orbitRadius * Math.sin(theta),
        z: 0,
      },
      velocity: {
        x: -speed * Math.sin(theta),
        y: speed * Math.cos(theta),
        z: 0,
      },
    });

    const result = await invokeJsonRequest(
      harness,
      {
        coverageSource: {
          brand: "OrbPro",
          mode: "OrbPro Sensor attached to propagated entity",
          sensorObject: "Cesium.Sensor",
          ownerEntityId: "orbpro-coverage-sat",
          sensorEntityId: "orbpro-coverage-sat",
          attachedToPropagatedEntity: true,
          positionPropertyType: "PropagatedPositionProperty",
          sampleCount: 5,
        },
        sensor: {
          sensorId: 0,
          type: "conic",
          outerHalfAngleRad: 0.22,
          radiusMeters: 1600000,
        },
        states: [
          makeState(-0.08, 0),
          makeState(-0.04, 600),
          makeState(0, 1200),
          makeState(0.04, 1800),
          makeState(0.08, 2400),
        ],
        grid: {
          minLatitudeDeg: -8,
          maxLatitudeDeg: 8,
          minLongitudeDeg: -12,
          maxLongitudeDeg: 12,
          latitudeStepDeg: 2,
          longitudeStepDeg: 2,
        },
        timeSpan: {
          startSeconds: 0,
          stopSeconds: 2400,
        },
        figureOfMerit: "percent_coverage",
        colorMap: "orbpro_coverage",
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    assert.equal(result.provider, "sensor-coverage-analysis");
    assert.equal(result.coverageSource.brand, "OrbPro");
    assert.equal(result.coverageSource.attachedToPropagatedEntity, true);
    assert.equal(result.coverageSource.positionPropertyType, "PropagatedPositionProperty");
    assert.equal(result.grid.cellCount, 96);
    assert.equal(result.swathMode, "orekit_along_track_swath");
    assert.equal(result.swaths.length, 4);
    assert.ok(result.statistics.accessedCells > 0);
    assert.ok(result.statistics.totalAccessDurationSec > 0);
    assert.ok(result.statistics.percentCoverage > 0);
    assert.ok(result.swaths.every((swath) => swath.kind === "orekit_along_track_swath"));
    assert.ok(result.swaths.every((swath) => swath.vertices.length === 4));
    assert.ok(result.swaths.every((swath) => swath.leftEdge.length === 2));
    assert.ok(result.swaths.every((swath) => swath.rightEdge.length === 2));
    assert.ok(result.swaths.every((swath) => swath.colorRgba.length === 4));
    assert.notEqual(
      result.swaths[0].vertices[0].longitudeDeg,
      result.swaths.at(-1).vertices[0].longitudeDeg,
    );
    assert.ok(
      result.swaths.at(-1).centerline[1].longitudeDeg >
        result.swaths[0].centerline[0].longitudeDeg,
    );
    assert.equal(result.figureOfMerit.values.length, 96);
    assert.equal(result.figureOfMerit.units, "percent");
  });

  test(`sensor coverage module honors the supplied time-dynamic sensor frame on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const earthRadius = 6378137.0;
    const orbitRadius = earthRadius + 500000.0;
    const speed = 7612.608173223869;
    const offNadirRad = 0.28;
    const makeState = (theta, elapsedSeconds, offNadirAlongTrackRad = 0) => {
      const radial = {
        x: Math.cos(theta),
        y: Math.sin(theta),
        z: 0,
      };
      const along = {
        x: -Math.sin(theta),
        y: Math.cos(theta),
        z: 0,
      };
      const cross = {
        x: 0,
        y: 0,
        z: 1,
      };
      const nadir = {
        x: -radial.x,
        y: -radial.y,
        z: 0,
      };
      const cos = Math.cos(offNadirAlongTrackRad);
      const sin = Math.sin(offNadirAlongTrackRad);
      return {
        elapsedSeconds,
        position: {
          x: orbitRadius * radial.x,
          y: orbitRadius * radial.y,
          z: 0,
        },
        velocity: {
          x: speed * along.x,
          y: speed * along.y,
          z: 0,
        },
        sensorFrame: {
          boresight: {
            x: nadir.x * cos + along.x * sin,
            y: nadir.y * cos + along.y * sin,
            z: 0,
          },
          xAxis: {
            x: along.x * cos - nadir.x * sin,
            y: along.y * cos - nadir.y * sin,
            z: 0,
          },
          yAxis: cross,
        },
      };
    };
    const baseRequest = {
      coverageSource: {
        brand: "OrbPro",
        mode: "OrbPro Sensor attached to propagated entity",
        sensorObject: "Cesium.Sensor",
        attachedToPropagatedEntity: true,
        positionPropertyType: "PropagatedPositionProperty",
        sensorFrameSource: "entity.computeModelMatrix",
      },
      sensor: {
        sensorId: 0,
        type: "conic",
        outerHalfAngleRad: 0.08,
        radiusMeters: 1600000,
      },
      grid: {
        minLatitudeDeg: -8,
        maxLatitudeDeg: 8,
        minLongitudeDeg: -16,
        maxLongitudeDeg: 16,
        latitudeStepDeg: 2,
        longitudeStepDeg: 2,
      },
      timeSpan: {
        startSeconds: 0,
        stopSeconds: 1200,
      },
      figureOfMerit: "percent_coverage",
      colorMap: "orbpro_coverage",
    };

    const nadirResult = await invokeJsonRequest(
      harness,
      {
        ...baseRequest,
        states: [
          makeState(-0.03, 0),
          makeState(0, 600),
          makeState(0.03, 1200),
        ],
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const offNadirResult = await invokeJsonRequest(
      harness,
      {
        ...baseRequest,
        states: [
          makeState(-0.03, 0, offNadirRad),
          makeState(0, 600, offNadirRad),
          makeState(0.03, 1200, offNadirRad),
        ],
      },
      {
        methodId: "compute_sensor_coverage",
        inputPortId: "coverage",
        outputPortId: "coverage",
        inputTypeRef: JSON_COVERAGE_REQUEST_TYPE,
      },
    );

    const nadirLongitude = nadirResult.swaths[0].centerline[0].longitudeDeg;
    const offNadirLongitude =
      offNadirResult.swaths[0].centerline[0].longitudeDeg;
    assert.ok(
      offNadirLongitude > nadirLongitude + 0.5,
      `expected supplied sensor frame to move swath centerline, got ${nadirLongitude} and ${offNadirLongitude}`,
    );
    assert.equal(
      offNadirResult.coverageSource.sensorFrameSource,
      "entity.computeModelMatrix",
    );
  });

  test(`sensor coverage SCV request preserves time-dynamic sensor attitude on ${runtimeKind}`, async (t) => {
    const harness = await createSensorCoverageHarness(runtimeKind, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const invokeScv = async (offNadirRad) => {
      const response = await harness.invoke({
        methodId: "compute_sensor_coverage",
        inputs: [
          {
            portId: "coverage",
            typeRef: {
              schemaName: "SCV/main.fbs",
              fileIdentifier: "$SCV",
              rootTypeName: "SCV",
            },
            payload: createScvOffNadirCoverageRequestPayload(offNadirRad),
          },
        ],
      });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const resultEnvelope = findScvEnvelope(response, scvEnvelopeKind.RESULT);
      assert.ok(resultEnvelope, "missing canonical SCV result output frame");
      const geometry = resultEnvelope.envelope.RESULT()?.GEOMETRY();
      assert.ok(geometry, "SCV result must include packed geometry");
      assert.ok(geometry.segmentsLength() > 0, "SCV geometry must include swath segments");
      const firstSegment = geometry.SEGMENTS(0);
      const vertexOffset = firstSegment.VERTEX_OFFSET() * 2;
      const leftStartLon = geometry.REVEAL_COORDS(vertexOffset);
      const rightStartLon = geometry.REVEAL_COORDS(vertexOffset + 6);
      return (leftStartLon + rightStartLon) / 2;
    };

    const nadirLongitude = await invokeScv(0);
    const offNadirLongitude = await invokeScv(0.28);
    assert.ok(
      offNadirLongitude > nadirLongitude + 0.5,
      `expected SCV attitude quaternion to move swath centerline, got ${nadirLongitude} and ${offNadirLongitude}`,
    );
  });
}
