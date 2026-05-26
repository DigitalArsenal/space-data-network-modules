import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`sensor coverage module aggregates all active sensors into one differential geometry product on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
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
  });

  test(`sensor coverage module accepts a 1000-sensor analysis without splitting work per sensor on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
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
      },
    );

    assert.equal(result.statistics.activeSensorCount, 1000);
    assert.equal(result.swaths.length, 1000);
    assert.equal(result.aggregateGeometry.activeSensorCount, 1000);
    assert.equal(result.aggregateGeometry.full.polygonCount, 1000);
    assert.equal(result.aggregateGeometry.deltas.length, 1000);
    assert.ok(result.statistics.accessedCells > 0);
  });

  test(`sensor coverage module derives moving Orekit-style swaths from sensor-attached states on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
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
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
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
}
