import test from "node:test";
import assert from "node:assert/strict";

import { createSwathAnalyzer } from "../index.js";

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function makeState(theta, julianDate) {
  const radius = 6878137.0;
  const speed = 7612.608173223869;
  return {
    julianDate,
    position: {
      x: radius * Math.cos(theta),
      y: radius * Math.sin(theta),
      z: 0.0,
    },
    velocity: {
      x: -speed * Math.sin(theta),
      y: speed * Math.cos(theta),
      z: 0.0,
    },
  };
}

test("Swath analyzer computes LVLH frame, footprints, access, and swath outputs", async () => {
  const analyzer = await createSwathAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const state = makeState(0.0, 2460400.5);
    const nextStates = [
      state,
      makeState(0.03, 2460400.5002),
      makeState(0.06, 2460400.5004),
      makeState(0.09, 2460400.5006),
    ];

    const frame = analyzer.computeLVLHFrame(state);
    assert.ok(Math.abs(magnitude(frame.radial) - 1.0) < 1e-12);
    assert.ok(Math.abs(magnitude(frame.alongTrack) - 1.0) < 1e-12);
    assert.ok(Math.abs(magnitude(frame.crossTrack) - 1.0) < 1e-12);
    assert.ok(Math.abs(dot(frame.radial, frame.alongTrack)) < 1e-12);
    assert.ok(Math.abs(dot(frame.radial, frame.crossTrack)) < 1e-12);
    assert.ok(Math.abs(dot(frame.alongTrack, frame.crossTrack)) < 1e-12);
    assert.ok(Math.abs(frame.nadir.x + frame.radial.x) < 1e-12);
    assert.ok(Math.abs(frame.nadir.y + frame.radial.y) < 1e-12);
    assert.ok(Math.abs(frame.nadir.z + frame.radial.z) < 1e-12);

    const conicalSensor = {
      sensorType: "conical",
      halfAngleRad: 0.2,
      angularResolutionRad: Math.PI / 18.0,
      maxRangeM: 2.0e7,
    };
    const conicalFootprint = analyzer.computeFootprint(state, conicalSensor);
    assert.ok(conicalFootprint.vertices.length >= 16);
    assert.ok(
      conicalFootprint.vertices.every(
        (vertex) =>
          Number.isFinite(vertex.longitude) &&
          Number.isFinite(vertex.latitude) &&
          Math.abs(vertex.altitude) < 1e-3,
      ),
    );

    const rectangularSensor = {
      sensorType: "rectangular",
      alongTrackFovRad: 0.14,
      crossTrackFovRad: 0.24,
      angularResolutionRad: Math.PI / 18.0,
      maxRangeM: 2.0e7,
    };
    const rectangularFootprint = analyzer.computeFootprint(
      state,
      rectangularSensor,
    );
    assert.ok(rectangularFootprint.vertices.length >= 8);

    const customFootprint = analyzer.computeFootprint(state, {
      sensorType: "custom",
      customDirections: [
        { x: -0.10, y: -0.08, z: 1.0 },
        { x: 0.12, y: -0.04, z: 1.0 },
        { x: 0.06, y: 0.10, z: 1.0 },
      ],
      maxRangeM: 2.0e7,
    });
    assert.equal(customFootprint.vertices.length, 3);

    const groundTrack = analyzer.computeGroundTrack(nextStates);
    assert.equal(groundTrack.length, nextStates.length);
    assert.ok(groundTrack.every((point) => point.speed > 0.0));

    const nadirTarget = {
      longitude: groundTrack[0].longitude,
      latitude: groundTrack[0].latitude,
      altitude: 0.0,
    };
    assert.equal(
      analyzer.pointInFootprint(state, conicalSensor, nadirTarget),
      true,
    );
    assert.equal(
      analyzer.pointInFootprint(state, conicalSensor, {
        longitude: 0.7,
        latitude: 0.35,
        altitude: 0.0,
      }),
      false,
    );

    const access = analyzer.computeAccessGeometry(
      state,
      conicalSensor,
      nadirTarget,
    );
    assert.equal(access.isVisible, true);
    assert.ok(access.range > 4.9e5);
    assert.ok(access.elevation > 1.4);
    assert.ok(access.lookAngle < 1e-3);

    const swath = analyzer.computeSwath(nextStates, rectangularSensor);
    assert.equal(swath.segments.length, nextStates.length);
    assert.ok(swath.vertices.length >= nextStates.length * 4);
    assert.ok(swath.segments.every((segment) => segment.leftVertices.length > 0));
    assert.ok(swath.segments.every((segment) => segment.rightVertices.length > 0));

    const optimizedSwath = analyzer.computeSwath(nextStates, rectangularSensor, {
      maxVerticesPerSide: 2,
    });
    assert.ok(
      optimizedSwath.segments.every((segment) => segment.leftVertices.length <= 2),
    );
    assert.ok(
      optimizedSwath.segments.every(
        (segment) => segment.rightVertices.length <= 2,
      ),
    );
  } finally {
    analyzer.destroy();
  }
});
