import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const STATE_RECORD_SIZE = 64;
const SENSOR_RECORD_SIZE = 576;
const TARGET_RECORD_SIZE = 64;
const FOOTPRINT_VERTEX_SIZE = 64;
const GROUND_TRACK_POINT_SIZE = 64;
const SWATH_SEGMENT_SIZE = 64;

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function writeFloat64(bytes, offset, value) {
  new DataView(bytes.buffer).setFloat64(offset, value, true);
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
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

function encodeSwathRequest(states, sensor = {}) {
  const header = new Uint8Array(16);
  writeUint32(header, 0, states.length);
  return concatBytes([header, encodeSensor(sensor), ...states.map(encodeState)]);
}

function encodeState({
  theta = 0.0,
  julianDate = 2460400.5,
} = {}) {
  const radius = 6878137.0;
  const speed = 7612.608173223869;
  const bytes = new Uint8Array(STATE_RECORD_SIZE);
  writeFloat64(bytes, 0, radius * Math.cos(theta));
  writeFloat64(bytes, 8, radius * Math.sin(theta));
  writeFloat64(bytes, 16, 0.0);
  writeFloat64(bytes, 24, -speed * Math.sin(theta));
  writeFloat64(bytes, 32, speed * Math.cos(theta));
  writeFloat64(bytes, 40, 0.0);
  writeFloat64(bytes, 48, julianDate);
  return bytes;
}

function encodeSensor({
  sensorType = "conical",
  halfAngleRad = 0.2,
  alongTrackFovRad = 0.0,
  crossTrackFovRad = 0.0,
  angularResolutionRad = Math.PI / 18.0,
  maxRangeM = 2.0e7,
  customDirections = [],
} = {}) {
  const bytes = new Uint8Array(SENSOR_RECORD_SIZE);
  const sensorTypeMap = {
    conical: 0,
    rectangular: 1,
    custom: 2,
  };
  writeUint32(bytes, 0, sensorTypeMap[sensorType] ?? 0);
  writeUint32(bytes, 8, customDirections.length);
  writeFloat64(bytes, 16, halfAngleRad);
  writeFloat64(bytes, 24, alongTrackFovRad);
  writeFloat64(bytes, 32, crossTrackFovRad);
  writeFloat64(bytes, 40, angularResolutionRad);
  writeFloat64(bytes, 80, maxRangeM);
  writeFloat64(bytes, 96, Math.PI * 0.5);
  customDirections.slice(0, 16).forEach((direction, index) => {
    const base = 160 + index * 24;
    writeFloat64(bytes, base, direction.x);
    writeFloat64(bytes, base + 8, direction.y);
    writeFloat64(bytes, base + 16, direction.z);
  });
  return bytes;
}

function encodeTarget({
  longitude = 0.0,
  latitude = 0.0,
  altitude = 0.0,
} = {}) {
  const bytes = new Uint8Array(TARGET_RECORD_SIZE);
  writeFloat64(bytes, 0, longitude);
  writeFloat64(bytes, 8, latitude);
  writeFloat64(bytes, 16, altitude);
  return bytes;
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
      groundRange: view.getFloat64(base + 32, true),
      lookAngle: view.getFloat64(base + 40, true),
      flags: view.getUint32(base + 48, true),
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

function decodeContainment(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === 1;
}

function decodeAccessGeometry(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    range: view.getFloat64(0, true),
    elevation: view.getFloat64(8, true),
    azimuth: view.getFloat64(16, true),
    slantRange: view.getFloat64(24, true),
    lookAngle: view.getFloat64(32, true),
    isVisible: view.getUint32(48, true) === 1,
    isOccluded: view.getUint32(52, true) === 1,
  };
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

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

test("swath manifest declares the shared browser/WasmEdge artifact", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.buildArtifacts?.[0]?.path, "dist/isomorphic/module.wasm");
});

test("swath C++ artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("swath C++ artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

// Authoritative behavioral source:
// Orekit `CircularFieldOfViewTest.testNadirNoMargin` and
// `AbstractSmoothFieldOfViewTest.doTestFootprint` require footprint boundary
// samples projected onto the reference ellipsoid with near-zero altitude.
test("swath C++ artifact projects conical footprint vertices onto the WGS84 ellipsoid", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "project_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathFootprintRequest",
            fileIdentifier: "SFPQ",
            rootTypeName: "SwathFootprintRequest",
          },
          payload: concatBytes([encodeState(), encodeSensor()]),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.SwathFootprintResult");
    assert.equal(frame.typeRef?.fileIdentifier, "SFPR");

    const vertices = decodeFootprint(frame.payload);
    assert.ok(vertices.length >= 16);
    for (const vertex of vertices) {
      assert.equal(vertex.flags & 0x03, 0x03);
      assert.ok(Number.isFinite(vertex.longitude));
      assert.ok(Number.isFinite(vertex.latitude));
      assert.ok(Number.isFinite(vertex.groundRange));
      assert.ok(Number.isFinite(vertex.lookAngle));
      assert.ok(Math.abs(vertex.altitude) < 1.0e-3);
    }
  });
});

test("swath C++ artifact projects rectangular sensor perimeter samples", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "project_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathFootprintRequest",
            fileIdentifier: "SFPQ",
            rootTypeName: "SwathFootprintRequest",
          },
          payload: concatBytes([
            encodeState(),
            encodeSensor({
              sensorType: "rectangular",
              alongTrackFovRad: 0.14,
              crossTrackFovRad: 0.24,
              angularResolutionRad: Math.PI / 18.0,
            }),
          ]),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const vertices = decodeFootprint(response.outputs[0].payload);
    assert.equal(vertices.length, 8);
    assert.ok(vertices.every((vertex) => Math.abs(vertex.altitude) < 1.0e-3));
    assert.ok(vertices.every((vertex) => Number.isFinite(vertex.groundRange)));
  });
});

test("swath C++ artifact projects caller-provided custom sensor directions", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "project_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathFootprintRequest",
            fileIdentifier: "SFPQ",
            rootTypeName: "SwathFootprintRequest",
          },
          payload: concatBytes([
            encodeState(),
            encodeSensor({
              sensorType: "custom",
              customDirections: [
                { x: -0.10, y: -0.08, z: 1.0 },
                { x: 0.12, y: -0.04, z: 1.0 },
                { x: 0.06, y: 0.10, z: 1.0 },
              ],
            }),
          ]),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    const vertices = decodeFootprint(response.outputs[0].payload);
    assert.equal(vertices.length, 3);
    assert.ok(vertices.every((vertex) => Math.abs(vertex.altitude) < 1.0e-3));
    assert.ok(vertices.every((vertex) => vertex.flags & 0x03));
  });
});

test("swath C++ artifact emits geodetic ground-track points from state batches", async (t) => {
  await withHarness(t, async (harness) => {
    const states = [
      { theta: 0.0, julianDate: 2460400.5 },
      { theta: 0.03, julianDate: 2460400.5002 },
      { theta: 0.06, julianDate: 2460400.5004 },
    ];
    const response = await harness.invoke({
      methodId: "ground_track",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathGroundTrackRequest",
            fileIdentifier: "SGRQ",
            rootTypeName: "SwathGroundTrackRequest",
          },
          payload: encodeStateBatch(states),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.SwathGroundTrackResult");
    assert.equal(frame.typeRef?.fileIdentifier, "SGRS");

    const groundTrack = decodeGroundTrack(frame.payload);
    assert.equal(groundTrack.length, states.length);
    assert.ok(groundTrack[1].longitude > groundTrack[0].longitude);
    assert.ok(groundTrack.every((point) => point.speed > 0.0));
    assert.ok(groundTrack.every((point) => Math.abs(point.latitude) < 1.0e-12));
  });
});

test("swath C++ artifact classifies a nadir target inside a conical footprint", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "point_in_footprint",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathContainmentRequest",
            fileIdentifier: "SPIQ",
            rootTypeName: "SwathContainmentRequest",
          },
          payload: concatBytes([
            encodeState(),
            encodeSensor({ halfAngleRad: 0.25 }),
            encodeTarget({ longitude: 0.0, latitude: 0.0 }),
          ]),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.SwathContainmentResult");
    assert.equal(frame.typeRef?.fileIdentifier, "SPIR");
    assert.equal(decodeContainment(frame.payload), true);
  });
});

test("swath C++ artifact computes access geometry for a nadir target", async (t) => {
  await withHarness(t, async (harness) => {
    const response = await harness.invoke({
      methodId: "access_geometry",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathAccessRequest",
            fileIdentifier: "SAPQ",
            rootTypeName: "SwathAccessRequest",
          },
          payload: concatBytes([
            encodeState(),
            encodeSensor({ halfAngleRad: 0.25 }),
            encodeTarget({ longitude: 0.0, latitude: 0.0 }),
          ]),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.SwathAccessResult");
    assert.equal(frame.typeRef?.fileIdentifier, "SAPR");

    const access = decodeAccessGeometry(frame.payload);
    assert.ok(access.range > 4.9e5);
    assert.equal(access.range, access.slantRange);
    assert.ok(access.elevation > 1.4);
    assert.ok(access.lookAngle < 1.0e-3);
    assert.equal(access.isVisible, true);
    assert.equal(access.isOccluded, false);
  });
});

test("swath C++ artifact generates swath segments from state batches", async (t) => {
  await withHarness(t, async (harness) => {
    const states = [
      { theta: 0.0, julianDate: 2460400.5 },
      { theta: 0.03, julianDate: 2460400.5002 },
      { theta: 0.06, julianDate: 2460400.5004 },
    ];
    const response = await harness.invoke({
      methodId: "generate_swath",
      inputs: [
        {
          portId: "request",
          typeRef: {
            schemaName: "orbpro.analysis.SwathGenerationRequest",
            fileIdentifier: "SWAQ",
            rootTypeName: "SwathGenerationRequest",
          },
          payload: encodeSwathRequest(states, { halfAngleRad: 0.2 }),
        },
      ],
    });

    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const [frame] = response.outputs;
    assert.equal(frame.portId, "results");
    assert.equal(frame.typeRef?.schemaName, "orbpro.analysis.SwathGenerationResult");
    assert.equal(frame.typeRef?.fileIdentifier, "SWAS");

    const swath = decodeSwath(frame.payload);
    assert.equal(swath.segments.length, states.length);
    assert.ok(swath.vertices.length >= states.length * 4);
    assert.ok(swath.segments.every((segment) => segment.leftVertexCount > 0));
    assert.ok(swath.segments.every((segment) => segment.rightVertexCount > 0));
    assert.ok(swath.vertices.every((vertex) => Math.abs(vertex.altitude) < 1.0e-3));
  });
});
