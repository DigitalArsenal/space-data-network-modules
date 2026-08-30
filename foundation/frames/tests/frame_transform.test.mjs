import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import {
  FRM,
  FRMFrameTransformRequestT,
  FRMT,
  FRMMatrix3T,
  FRMVector3T,
  frmOperationCode,
  frmResultStatus,
} from "spacedatastandards.org/lib/js/FRM/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// SDS comes from the PUBLISHED package this package pins, never a sibling
// checkout (published-deps law, owner 2026-08-21).
const STANDARDS_ROOT = fileURLToPath(
  new URL("../node_modules/spacedatastandards.org/", import.meta.url),
);

const BASILISK_DCM_J2000_TO_PFIX = [
  1, 0, 0,
  0, 0, 1,
  0, -1, 0,
];
const BASILISK_EQUATORIAL_RADIUS_M = 6378.1363E3;
const BASILISK_POLAR_RADIUS_M = 6356.7523E3;
const BASILISK_LLA_RAD_M = [0.6935805104270613, 1.832425562445269, 1596.668];
const BASILISK_PCPF_M = [-1270640.01, 4745322.63, 4056784.62];
const BASILISK_SPHERICAL_RADIUS_M = 10.0;
const BASILISK_SPHERICAL_PCPF_M = [3.0, 4.0, 12.0];
const BASILISK_SPHERICAL_LLA_RAD_M = [Math.atan2(12.0, 5.0), Math.atan2(4.0, 3.0), 3.0];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeRequest({
  operation,
  position,
  transformDcm = BASILISK_DCM_J2000_TO_PFIX,
  equatorialRadiusM = BASILISK_EQUATORIAL_RADIUS_M,
  polarRadiusM = BASILISK_POLAR_RADIUS_M,
  traceId,
}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new FRMFrameTransformRequestT(
    operation,
    new FRMVector3T(...position),
    transformDcm === null ? null : new FRMMatrix3T(...transformDcm),
    equatorialRadiusM,
    polarRadiusM,
    traceId,
  );
  const root = new FRMT(request, null).pack(builder);
  FRM.finishFRMBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeFrames(harness, payload) {
  return harness.invoke({
    methodId: "transform_frame_position",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "FRM.fbs",
          fileIdentifier: "$FRM",
          rootTypeName: "FRM",
        },
        payload,
      },
    ],
  });
}

function decodeResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "FRM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$FRM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(FRM.bufferHasIdentifier(bb), true);
  const envelope = FRM.getRootAsFRM(bb);
  const result = envelope.FRAME_TRANSFORM_RESULT();
  assert.ok(result, "missing FRM.FRAME_TRANSFORM_RESULT");
  assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE());
  const position = result.POSITION();
  assert.ok(position, "missing result POSITION");
  return {
    x: position.X(),
    y: position.Y(),
    z: position.Z(),
    traceId: result.TRACE_ID(),
  };
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}; actual=${actual}, expected=${expected}`);
}

function assertVector(actual, expected, tolerance, label) {
  assertNear(actual.x, expected[0], tolerance, `${label} X`);
  assertNear(actual.y, expected[1], tolerance, `${label} Y`);
  assertNear(actual.z, expected[2], tolerance, `${label} Z`);
}

function normDelta(actual, expected) {
  const dx = actual.x - expected[0];
  const dy = actual.y - expected[1];
  const dz = actual.z - expected[2];
  return Math.hypot(dx, dy, dz);
}

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
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

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_geodeticConversion.cpp`
// `testPCI2PCPF` applies the J2000-to-planet-fixed DCM to PCI position [1,2,3]
// and expects PCPF [1,3,-2]. Components are unitless frame-transform inputs;
// equality is exact for this source vector.
test("matches Basilisk GeodeticConversion.testPCI2PCPF", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.PCI_TO_PCPF,
          position: [1, 2, 3],
          traceId: "basilisk-geodetic-testPCI2PCPF",
        }),
      ),
    );
    assertVector(result, [1, 3, -2], 0.0, "PCPF position");
    assert.equal(result.traceId, "basilisk-geodetic-testPCI2PCPF");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_geodeticConversion.cpp`
// `testPCPF2PCI` applies the transpose of the same J2000-to-planet-fixed DCM
// to PCPF position [1,2,3] and expects PCI [1,-3,2].
test("matches Basilisk GeodeticConversion.testPCPF2PCI", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.PCPF_TO_PCI,
          position: [1, 2, 3],
          traceId: "basilisk-geodetic-testPCPF2PCI",
        }),
      ),
    );
    assertVector(result, [1, -3, 2], 0.0, "PCI position");
    assert.equal(result.traceId, "basilisk-geodetic-testPCPF2PCI");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_geodeticConversion.cpp`
// `testLLA2PCPF` converts [lat, lon, altitude] =
// [0.6935805104270613 rad, 1.832425562445269 rad, 1596.668 m] on an ellipsoid
// with equatorial radius 6378136.3 m and polar radius 6356752.3 m. Basilisk
// expects ECEF/PCPF position [-1270640.01, 4745322.63, 4056784.62] m with
// Euclidean error less than 100 m.
test("matches Basilisk GeodeticConversion.testLLA2PCPF", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.LLA_TO_PCPF,
          position: BASILISK_LLA_RAD_M,
          transformDcm: null,
          traceId: "basilisk-geodetic-testLLA2PCPF",
        }),
      ),
    );
    assert.ok(normDelta(result, BASILISK_PCPF_M) < 100.0, `PCPF norm delta ${normDelta(result, BASILISK_PCPF_M)} exceeds 100 m`);
    assert.equal(result.traceId, "basilisk-geodetic-testLLA2PCPF");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_geodeticConversion.cpp`
// `testPCPF2LLA` inverts the same ellipsoid conversion and expects latitude
// and longitude within 0.0001 rad and altitude within 100 m.
test("matches Basilisk GeodeticConversion.testPCPF2LLA", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.PCPF_TO_LLA,
          position: BASILISK_PCPF_M,
          transformDcm: null,
          traceId: "basilisk-geodetic-testPCPF2LLA",
        }),
      ),
    );
    assertNear(result.x, BASILISK_LLA_RAD_M[0], 0.0001, "latitude rad");
    assertNear(result.y, BASILISK_LLA_RAD_M[1], 0.0001, "longitude rad");
    assertNear(result.z, BASILISK_LLA_RAD_M[2], 100.0, "altitude m");
    assert.equal(result.traceId, "basilisk-geodetic-testPCPF2LLA");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/geodeticConversion.cpp` `LLA2PCPF`
// leaves eccentricity at zero when `planetPoRad < 0`, which gives the
// spherical closed-form transform. For radius 10 m and LLA
// [atan2(12, 5), atan2(4, 3), 3 m], the expected PCPF vector is [3, 4, 12] m.
test("matches Basilisk geodeticConversion LLA2PCPF spherical branch", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.LLA_TO_PCPF,
          position: BASILISK_SPHERICAL_LLA_RAD_M,
          transformDcm: null,
          equatorialRadiusM: BASILISK_SPHERICAL_RADIUS_M,
          polarRadiusM: -1.0,
          traceId: "basilisk-geodetic-lla2pcpf-spherical",
        }),
      ),
    );
    assertVector(result, BASILISK_SPHERICAL_PCPF_M, 1e-12, "spherical PCPF position");
    assert.equal(result.traceId, "basilisk-geodetic-lla2pcpf-spherical");
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/geodeticConversion.cpp` `PCPF2LLA`
// uses spherical latitude, longitude, and altitude equations when
// `planetPoRad < 0`. For PCPF [3, 4, 12] m and radius 10 m, the expected LLA
// is [atan2(12, 5), atan2(4, 3), 3 m].
test("matches Basilisk geodeticConversion PCPF2LLA spherical branch", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeFrames(
        harness,
        encodeRequest({
          operation: frmOperationCode.PCPF_TO_LLA,
          position: BASILISK_SPHERICAL_PCPF_M,
          transformDcm: null,
          equatorialRadiusM: BASILISK_SPHERICAL_RADIUS_M,
          polarRadiusM: -1.0,
          traceId: "basilisk-geodetic-pcpf2lla-spherical",
        }),
      ),
    );
    assertNear(result.x, BASILISK_SPHERICAL_LLA_RAD_M[0], 1e-12, "spherical latitude rad");
    assertNear(result.y, BASILISK_SPHERICAL_LLA_RAD_M[1], 1e-12, "spherical longitude rad");
    assertNear(result.z, BASILISK_SPHERICAL_LLA_RAD_M[2], 1e-12, "spherical altitude m");
    assert.equal(result.traceId, "basilisk-geodetic-pcpf2lla-spherical");
  });
});
