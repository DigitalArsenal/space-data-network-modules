import test from "node:test";
import assert from "node:assert/strict";

import { createSwathAnalyzer } from "../index.js";

const STATE_RECORD_SIZE = 64;
const SENSOR_RECORD_SIZE = 576;
const TARGET_RECORD_SIZE = 64;
const FOOTPRINT_VERTEX_SIZE = 64;
const GROUND_TRACK_POINT_SIZE = 64;
const SWATH_SEGMENT_SIZE = 64;

function writeFloat64(bytes, offset, value) {
  new DataView(bytes.buffer).setFloat64(offset, value, true);
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function encodeState(state) {
  const bytes = new Uint8Array(STATE_RECORD_SIZE);
  writeFloat64(bytes, 0, state.position.x);
  writeFloat64(bytes, 8, state.position.y);
  writeFloat64(bytes, 16, state.position.z);
  writeFloat64(bytes, 24, state.velocity.x);
  writeFloat64(bytes, 32, state.velocity.y);
  writeFloat64(bytes, 40, state.velocity.z);
  writeFloat64(bytes, 48, state.julianDate);
  return bytes;
}

function encodeSensor(sensor) {
  const bytes = new Uint8Array(SENSOR_RECORD_SIZE);
  const sensorTypeMap = {
    conical: 0,
    rectangular: 1,
    custom: 2,
  };
  writeUint32(bytes, 0, sensorTypeMap[sensor.sensorType] ?? 0);
  writeUint32(bytes, 4, 0);
  const customDirections = Array.isArray(sensor.customDirections)
    ? sensor.customDirections
    : [];
  writeUint32(bytes, 8, customDirections.length);
  writeFloat64(bytes, 16, sensor.halfAngleRad ?? 0.0);
  writeFloat64(bytes, 24, sensor.alongTrackFovRad ?? 0.0);
  writeFloat64(bytes, 32, sensor.crossTrackFovRad ?? 0.0);
  writeFloat64(bytes, 40, sensor.angularResolutionRad ?? (Math.PI / 18.0));
  writeFloat64(bytes, 48, sensor.rollRad ?? 0.0);
  writeFloat64(bytes, 56, sensor.pitchRad ?? 0.0);
  writeFloat64(bytes, 64, sensor.yawRad ?? 0.0);
  writeFloat64(bytes, 72, sensor.minRangeM ?? 0.0);
  writeFloat64(bytes, 80, sensor.maxRangeM ?? 2.0e7);
  writeFloat64(bytes, 88, sensor.minElevationRad ?? 0.0);
  writeFloat64(bytes, 96, sensor.maxElevationRad ?? Math.PI * 0.5);

  customDirections.slice(0, 16).forEach((direction, index) => {
    const base = 160 + index * 24;
    writeFloat64(bytes, base, direction.x);
    writeFloat64(bytes, base + 8, direction.y);
    writeFloat64(bytes, base + 16, direction.z);
  });

  return bytes;
}

function encodeTarget(target) {
  const bytes = new Uint8Array(TARGET_RECORD_SIZE);
  writeFloat64(bytes, 0, target.longitude);
  writeFloat64(bytes, 8, target.latitude);
  writeFloat64(bytes, 16, target.altitude ?? 0.0);
  return bytes;
}

function concatBytes(parts) {
  const totalSize = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeStateBatch(states) {
  const header = new Uint8Array(16);
  writeUint32(header, 0, states.length);
  return concatBytes([header, ...states.map(encodeState)]);
}

function encodeSwathRequest(states, sensor) {
  const header = new Uint8Array(16);
  writeUint32(header, 0, states.length);
  return concatBytes([header, encodeSensor(sensor), ...states.map(encodeState)]);
}

function decodeFootprint(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  assert.equal(view.getUint32(4, true), FOOTPRINT_VERTEX_SIZE);
  const vertices = [];
  for (let index = 0; index < count; index += 1) {
    const base = 16 + index * FOOTPRINT_VERTEX_SIZE;
    vertices.push({
      longitude: view.getFloat64(base, true),
      latitude: view.getFloat64(base + 8, true),
      altitude: view.getFloat64(base + 16, true),
      julianDate: view.getFloat64(base + 24, true),
      groundRange: view.getFloat64(base + 32, true),
      lookAngle: view.getFloat64(base + 40, true),
    });
  }
  return vertices;
}

function decodeGroundTrack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  assert.equal(view.getUint32(4, true), GROUND_TRACK_POINT_SIZE);
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const base = 16 + index * GROUND_TRACK_POINT_SIZE;
    points.push({
      julianDate: view.getFloat64(base, true),
      longitude: view.getFloat64(base + 8, true),
      latitude: view.getFloat64(base + 16, true),
      altitude: view.getFloat64(base + 24, true),
      heading: view.getFloat64(base + 32, true),
      speed: view.getFloat64(base + 40, true),
    });
  }
  return points;
}

function decodeSwath(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentCount = view.getUint32(0, true);
  const vertexCount = view.getUint32(4, true);
  assert.equal(view.getUint32(8, true), SWATH_SEGMENT_SIZE);
  assert.equal(view.getUint32(12, true), FOOTPRINT_VERTEX_SIZE);

  const segments = [];
  let offset = 32;
  for (let index = 0; index < segmentCount; index += 1) {
    const base = offset + index * SWATH_SEGMENT_SIZE;
    segments.push({
      startTime: view.getFloat64(base, true),
      endTime: view.getFloat64(base + 8, true),
      centerLon: view.getFloat64(base + 16, true),
      centerLat: view.getFloat64(base + 24, true),
      leftVertexStart: view.getUint32(base + 32, true),
      leftVertexCount: view.getUint32(base + 36, true),
      rightVertexStart: view.getUint32(base + 40, true),
      rightVertexCount: view.getUint32(base + 44, true),
    });
  }
  offset += segmentCount * SWATH_SEGMENT_SIZE;

  const vertices = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const base = offset + index * FOOTPRINT_VERTEX_SIZE;
    vertices.push({
      longitude: view.getFloat64(base, true),
      latitude: view.getFloat64(base + 8, true),
      altitude: view.getFloat64(base + 16, true),
    });
  }

  return { segments, vertices };
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

test("Swath wrapper exposes native streamInvoke for footprint, ground track, and swath outputs", async () => {
  const analyzer = await createSwathAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    assert.equal(analyzer.supportsStreamInvoke, true);

    const baseState = makeState(0.0, 2460400.5);
    const sensor = {
      sensorType: "rectangular",
      alongTrackFovRad: 0.14,
      crossTrackFovRad: 0.22,
      angularResolutionRad: Math.PI / 18.0,
      maxRangeM: 2.0e7,
    };

    const footprintResult = analyzer.streamInvoke({
      methodId: "project_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathFootprintRequest",
            fileIdentifier: "SFPQ",
            schemaHash: [],
            acceptsAnyFlatbuffer: false,
          },
          bytes: concatBytes([encodeState(baseState), encodeSensor(sensor)]),
          alignment: 8,
          streamId: 1,
          sequence: 1n,
          traceToken: 100n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(footprintResult.statusCode, 0);
    const footprint = decodeFootprint(footprintResult.outputs[0].bytes);
    assert.ok(footprint.length >= 4);
    assert.ok(footprint.every((vertex) => Math.abs(vertex.altitude) < 1e-3));

    const states = [
      makeState(0.0, 2460400.5),
      makeState(0.03, 2460400.5002),
      makeState(0.06, 2460400.5004),
    ];

    const groundTrackResult = analyzer.streamInvoke({
      methodId: "ground_track",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathGroundTrackRequest",
            fileIdentifier: "SGRQ",
            schemaHash: [],
            acceptsAnyFlatbuffer: false,
          },
          bytes: encodeStateBatch(states),
          alignment: 8,
          streamId: 2,
          sequence: 1n,
          traceToken: 101n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(groundTrackResult.statusCode, 0);
    const groundTrack = decodeGroundTrack(groundTrackResult.outputs[0].bytes);
    assert.equal(groundTrack.length, states.length);
    assert.ok(groundTrack[1].longitude > groundTrack[0].longitude);

    const swathResult = analyzer.streamInvoke({
      methodId: "generate_swath",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathGenerationRequest",
            fileIdentifier: "SWAQ",
            schemaHash: [],
            acceptsAnyFlatbuffer: false,
          },
          bytes: encodeSwathRequest(states, sensor),
          alignment: 8,
          streamId: 3,
          sequence: 1n,
          traceToken: 102n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(swathResult.statusCode, 0);
    const swath = decodeSwath(swathResult.outputs[0].bytes);
    assert.equal(swath.segments.length, states.length);
    assert.ok(swath.vertices.length >= states.length * 4);
    assert.ok(swath.segments.every((segment) => segment.leftVertexCount > 0));
    assert.ok(swath.segments.every((segment) => segment.rightVertexCount > 0));
  } finally {
    analyzer.destroy();
  }
});

test("Swath native streamInvoke evaluates access and containment requests", async () => {
  const analyzer = await createSwathAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const state = makeState(0.0, 2460400.5);
    const sensor = {
      sensorType: "conical",
      halfAngleRad: 0.25,
      angularResolutionRad: Math.PI / 18.0,
      maxRangeM: 2.0e7,
    };
    const target = {
      longitude: 0.0,
      latitude: 0.0,
      altitude: 0.0,
    };

    const pointResult = analyzer.streamInvoke({
      methodId: "point_in_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathContainmentRequest",
            fileIdentifier: "SPIQ",
            schemaHash: [],
            acceptsAnyFlatbuffer: false,
          },
          bytes: concatBytes([
            encodeState(state),
            encodeSensor(sensor),
            encodeTarget(target),
          ]),
          alignment: 8,
          streamId: 4,
          sequence: 1n,
          traceToken: 103n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(pointResult.statusCode, 0);
    const pointView = new DataView(
      pointResult.outputs[0].bytes.buffer,
      pointResult.outputs[0].bytes.byteOffset,
      pointResult.outputs[0].bytes.byteLength,
    );
    assert.equal(pointView.getUint32(0, true), 1);

    const accessResult = analyzer.streamInvoke({
      methodId: "access_geometry",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathAccessRequest",
            fileIdentifier: "SAPQ",
            schemaHash: [],
            acceptsAnyFlatbuffer: false,
          },
          bytes: concatBytes([
            encodeState(state),
            encodeSensor(sensor),
            encodeTarget(target),
          ]),
          alignment: 8,
          streamId: 5,
          sequence: 1n,
          traceToken: 104n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(accessResult.statusCode, 0);
    const accessView = new DataView(
      accessResult.outputs[0].bytes.buffer,
      accessResult.outputs[0].bytes.byteOffset,
      accessResult.outputs[0].bytes.byteLength,
    );
    assert.ok(accessView.getFloat64(0, true) > 4.9e5);
    assert.ok(accessView.getFloat64(8, true) > 1.4);
    assert.equal(accessView.getUint32(48, true), 1);
  } finally {
    analyzer.destroy();
  }
});
