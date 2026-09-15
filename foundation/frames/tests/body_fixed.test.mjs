// Authoritative BODY_FIXED tests over the production FRM wire.
// Numerical authority, frames, UTC->TDB conversion, units and tolerances are
// recorded in body_fixed_utc_reference.json. NAIF CSPICE generated the
// expected matrices independently of the module. JavaScript encodes records
// and measures errors; all production orientation calculations run in WASM.
//
// Default: node --test tests/body_fixed.test.mjs
// Native/container: SDN_FRAME_WASMEDGE_BINARY=/path/to/wasmedge-or-wrapper \
//                    node --test tests/body_fixed.test.mjs
// Every lane reads the same dist/isomorphic/module.wasm; an explicitly
// selected unavailable runtime fails instead of silently skipping a lane.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import {
  FRM,
  FRMFrameTransformRequestT,
  FRMT,
  RFMCoordinateSystemT,
  RFMOriginT,
  frmOperationCode,
  frmResultStatus,
  frmStateRepresentation,
  rfmAxisType,
  rfmOriginKind,
} from "spacedatastandards.org/lib/js/FRM/main.js";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const REFERENCE = JSON.parse(fs.readFileSync(
  new URL("./body_fixed_utc_reference.json", import.meta.url), "utf8",
));
const WASMEDGE_BINARY = process.env.SDN_FRAME_WASMEDGE_BINARY;
const RUNTIME = WASMEDGE_BINARY ? "wasmedge" : "browser";
const EARTH = 399;

function coordinateSystem(name, axisType, axisBodyId,
  origin = new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, EARTH)) {
  // Orientation and origin are independent. Earth-centred origins keep this
  // test solely about axes, without needing planetary translation ephemerides.
  return new RFMCoordinateSystemT(
    name,
    axisType,
    origin,
    axisBodyId,
    REFERENCE.epoch_utc,
    "UTC",
  );
}

function encodeRequest(reference) {
  const builder = new flatbuffers.Builder(1024);
  const request = new FRMFrameTransformRequestT(
    frmOperationCode.FRAME_ROTATION,
    null,
    null,
    0.0,
    0.0,
    null,
    coordinateSystem("ICRF", rfmAxisType.ICRF, EARTH),
    coordinateSystem(reference.frame, rfmAxisType.BODY_FIXED, reference.body_id, reference.origin),
    null,
    frmStateRepresentation.UNSPECIFIED,
    REFERENCE.epoch_utc,
    "UTC",
    `naif-pck00011-${reference.frame}`,
  );
  FRM.finishFRMBuffer(builder, new FRMT(request, null).pack(builder));
  return builder.asUint8Array();
}

async function rotationResult(harness, reference) {
  const response = await harness.invoke({
    methodId: "transform_frame_position",
    inputs: [{
      portId: "request",
      typeRef: { schemaName: "FRM.fbs", fileIdentifier: "$FRM", rootTypeName: "FRM" },
      payload: encodeRequest(reference),
    }],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const output = response.outputs?.[0];
  assert.ok(output, "module emitted no result frame");
  const buffer = new flatbuffers.ByteBuffer(output.payload);
  assert.equal(FRM.bufferHasIdentifier(buffer), true);
  const result = FRM.getRootAsFRM(buffer).FRAME_TRANSFORM_RESULT();
  assert.ok(result, "missing FRM.FRAME_TRANSFORM_RESULT");
  return result;
}

async function rotationMatrix(harness, reference) {
  const result = await rotationResult(harness, reference);
  assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE() ?? "");
  const matrix = result.ROTATION_DCM();
  assert.ok(matrix, "missing result rotation matrix");
  return [
    matrix.M11(), matrix.M12(), matrix.M13(),
    matrix.M21(), matrix.M22(), matrix.M23(),
    matrix.M31(), matrix.M32(), matrix.M33(),
  ];
}

test(`FRM BODY_FIXED agrees with NAIF CSPICE (${RUNTIME})`, { concurrency: false }, async (t) => {
  assert.ok(fs.existsSync(WASM_PATH), "build dist/isomorphic/module.wasm before running this test");
  assert.equal(REFERENCE.cases.length, 7, "reference must cover all seven requested bodies");
  const harness = await createStandaloneHarness(RUNTIME, WASM_PATH, {
    surface: "direct",
    enableThreads: false,
    wasmEdgeBinary: WASMEDGE_BINARY,
  });
  t.after(async () => harness.destroy());

  for (const reference of REFERENCE.cases) {
    await t.test(`${reference.frame}: UTC input and full IAU body model`, async () => {
      const actual = await rotationMatrix(harness, reference);
      let worst = 0.0;
      for (let index = 0; index < 9; ++index) {
        assert.ok(Number.isFinite(actual[index]), `matrix element ${index} is nonfinite`);
        worst = Math.max(worst, Math.abs(actual[index] - reference.matrix_icrf_to_fixed[index]));
      }
      t.diagnostic(`${reference.frame}: max |WASM - CSPICE| = ${worst.toExponential(8)}; tolerance ${reference.tolerance}`);
      assert.ok(worst <= reference.tolerance,
        `${reference.frame} matrix error ${worst} exceeds ${reference.tolerance}`);
    });
  }

  await t.test("Earth BODY_FIXED still refuses a missing EOP row", async () => {
    const result = await rotationResult(harness, { frame: "ITRF", body_id: EARTH });
    assert.equal(result.STATUS(), frmResultStatus.MISSING_EOP_DATA);
  });

  await t.test("Earth ground-site origin requires EOP with Moon BODY_FIXED axes", async () => {
    const origin = new RFMOriginT(rfmOriginKind.GROUND_SITE);
    origin.SITE_BODY_ID = EARTH;
    origin.SITE_ID = "earth-equator-test-site";
    const result = await rotationResult(harness, { frame: "IAU_MOON", body_id: 301, origin });
    assert.equal(result.STATUS(), frmResultStatus.MISSING_EOP_DATA);
  });
});
