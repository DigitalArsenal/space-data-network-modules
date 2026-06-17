import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import {
  BSP,
  BSPInterpolationRequestT,
  BSPT,
  BSPVector3SeriesT,
  bspInterpolationStatus,
} from "../../../../spacedatastandards.org/lib/js/BSP/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const BASILISK_T = [0, 2, 3, 5, 7, 8, 10];
const BASILISK_X1 = [0, 1, 2, 3, 4, 5, 6];
const BASILISK_X2 = [5, 4, 3, 2, 1, 0, 1];
const BASILISK_X3 = [3, 2, 1, 2, 3, 4, 5];
const BASILISK_CASES = [
  {
    order: 5,
    xDot: false,
    xDDot: false,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=5, xDot=false, xDDot=false",
  },
  {
    order: 5,
    xDot: false,
    xDDot: true,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=5, xDot=false, xDDot=true",
  },
  {
    order: 5,
    xDot: true,
    xDDot: false,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=5, xDot=true, xDDot=false",
  },
  {
    order: 5,
    xDot: true,
    xDDot: true,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=5, xDot=true, xDDot=true",
  },
  {
    order: 6,
    xDot: false,
    xDDot: false,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=6, xDot=false, xDDot=false",
  },
  {
    order: 6,
    xDot: false,
    xDDot: true,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=6, xDot=false, xDDot=true",
  },
  {
    order: 6,
    xDot: true,
    xDDot: false,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=6, xDot=true, xDDot=false",
  },
  {
    order: 6,
    xDot: true,
    xDDot: true,
    name: "matches Basilisk BSpline waypoint and derivative checks for P=6, xDot=true, xDDot=true",
  },
];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeRequest({ order, xDot = false, xDDot = false }) {
  const builder = new flatbuffers.Builder(2048);
  const root = new BSPT(
    new BSPInterpolationRequestT(
      new BSPVector3SeriesT(BASILISK_T, BASILISK_X1, BASILISK_X2, BASILISK_X3),
      101,
      order,
      xDot,
      xDot ? [0, 0, 0] : [],
      xDot,
      xDot ? [0, 0, 0] : [],
      xDDot,
      xDDot ? [0, 0, 0] : [],
      xDDot,
      xDDot ? [0.2, 0, 0] : [],
      `basilisk-test-BSpline-P${order}-xdot-${xDot}-xddot-${xDDot}`,
    ),
    null,
  ).pack(builder);
  BSP.finishBSPBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeInterpolation(harness, payload) {
  return harness.invoke({
    methodId: "interpolate_bspline",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "BSP.fbs",
          fileIdentifier: "$BSP",
          rootTypeName: "BSP",
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
  assert.equal(frame.typeRef?.schemaName, "BSP.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$BSP");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(BSP.bufferHasIdentifier(bb), true);
  const envelope = BSP.getRootAsBSP(bb);
  const result = envelope.INTERPOLATION_RESULT();
  assert.ok(result, "missing BSP.INTERPOLATION_RESULT");
  return result;
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}`);
}

function assertBasiliskWaypointChecks(result, order, tolerance = 1e-6) {
  assert.equal(result.STATUS(), bspInterpolationStatus.OK, result.ERROR_MESSAGE());
  const samples = result.SAMPLES();
  assert.ok(samples, "missing result samples");
  assert.equal(samples.tLength(), 101);
  assert.equal(samples.x1Length(), 101);
  assert.equal(result.xd1Length(), 101);
  assert.equal(result.xdd1Length(), 101);

  for (let i = 0; i < samples.tLength(); i += 1) {
    for (let j = 0; j < BASILISK_T.length; j += 1) {
      if (Math.abs(samples.T(i) - BASILISK_T[j]) < tolerance) {
        assertNear(samples.X1(i), BASILISK_X1[j], tolerance, `P${order} X1 at t=${BASILISK_T[j]}`);
        assertNear(samples.X2(i), BASILISK_X2[j], tolerance, `P${order} X2 at t=${BASILISK_T[j]}`);
        assertNear(samples.X3(i), BASILISK_X3[j], tolerance, `P${order} X3 at t=${BASILISK_T[j]}`);
      }
    }
  }
}

// Authoritative numerical source:
// Basilisk `src/architecture/utilitiesSelfCheck/_UnitTest/test_BSpline.py`
// validates order 5 and 6 interpolation for seven 3D waypoints at
// t=[0,2,3,5,7,8,10], with optional zero first derivatives and zero start
// second derivative. Tolerance is the upstream `accuracy = 1e-6`.

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

for (const { order, xDot, xDDot, name } of BASILISK_CASES) {
  test(name, async (t) => {
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
      surface: "direct",
    });
    t.after(() => harness.destroy());

    const response = await invokeInterpolation(harness, encodeRequest({ order, xDot, xDDot }));
    const result = decodeResult(response);
    assertBasiliskWaypointChecks(result, order);

    if (xDot) {
      assertNear(result.XD1(0), 0, 1e-6, `P${order} start XD1`);
      assertNear(result.XD2(0), 0, 1e-6, `P${order} start XD2`);
      assertNear(result.XD3(0), 0, 1e-6, `P${order} start XD3`);
    }
    if (xDDot) {
      assertNear(result.XDD1(0), 0, 1e-6, `P${order} start XDD1`);
      assertNear(result.XDD2(0), 0, 1e-6, `P${order} start XDD2`);
      assertNear(result.XDD3(0), 0, 1e-6, `P${order} start XDD3`);
    }
  });
}
