// coordinate_systems.test.mjs — the $FRM operations 5, 6 and 7 measured on the
// SHIPPED WASM ARTIFACT.
//
// WHAT MAKES THIS DIFFERENT FROM axis_engine_parity.test.mjs. That harness
// measures the C++ header compiled natively. This one measures the bytes in
// dist/isomorphic/module.wasm, driven over the real SDS $FRM / $RFM / $EOP
// wire through the SDK host — and it cross-checks them against the SAME native
// build, at the same epoch with the same Earth-orientation row, in the same
// run. That is what turns "one IAU-2006/2000A chain" from a statement about
// the source into a measurement of the artifact.
//
// Every number below is a computable outcome with a named authority:
//   * the native ERFA chain (this repo's vendored ERFA) for the GCRF<->ITRF and
//     GSE matrices and the Earth-rotation angular velocity;
//   * exact rotation/round-trip identities, which admit machine-precision
//     bounds;
//   * the IERS Conventions (2010) nominal Earth rotation rate.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import {
  FRM,
  FRMFrameTransformRequestT,
  FRMStateVectorT,
  FRMT,
  FRMVector3T,
  frmOperationCode,
  frmResultStatus,
  frmStateRepresentation,
  RFMCoordinateSystemT,
  RFMObjectReferencedAxesT,
  RFMOriginT,
  rfmAxisType,
  rfmLibrationPoint,
  rfmOriginKind,
  rfmVectorSpecification,
} from "spacedatastandards.org/lib/js/FRM/main.js";
import { EOP, EOPT } from "spacedatastandards.org/lib/js/EOP/main.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { buildNativeAxisReference } from "./native_axis_reference.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const EARTH = 399;
const MOON = 301;
const EARTH_MOON_BARYCENTRE = 3;
const EARTH_GM = 3.986004418e14;

// The SOFA "Time Scales and Earth Rotation" cookbook epoch and its EOP, which
// is also the epoch the native harness reports at.
const EPOCH_UTC = "2007-04-05T12:00:00";
const ARCSEC = Math.PI / (180 * 3600);
const COOKBOOK_EOP = {
  dut1: -0.072073685,
  xPoleRad: 0.0349282 * ARCSEC,
  yPoleRad: 0.4833163 * ARCSEC,
};

// A LEO state in GCRF, metres and metres/second. Arbitrary but fixed, so a
// regression moves a printed number rather than a random one.
const STATE_POSITION = [7000000.0, 1200000.0, 300000.0];
const STATE_VELOCITY = [-1500.0, 7100.0, 400.0];

function coordinateSystem({
  name,
  axisType,
  origin = new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, EARTH),
  axisBodyId = EARTH,
  objectReferencedAxes = null,
}) {
  return new RFMCoordinateSystemT(
    name,
    axisType,
    origin,
    axisBodyId,
    EPOCH_UTC,
    "UTC",
    objectReferencedAxes,
  );
}

function encodeRequest({
  operation,
  sourceSystem = null,
  targetSystem = null,
  sourceState = null,
  targetRepresentation = frmStateRepresentation.UNSPECIFIED,
  epoch = EPOCH_UTC,
}) {
  const builder = new flatbuffers.Builder(4096);
  const request = new FRMFrameTransformRequestT(
    operation,
    null,
    null,
    0.0,
    0.0,
    null,
    sourceSystem,
    targetSystem,
    sourceState,
    targetRepresentation,
    epoch,
    "UTC",
    null,
  );
  const root = new FRMT(request, null).pack(builder);
  FRM.finishFRMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeCookbookEopRow() {
  const builder = new flatbuffers.Builder(1024);
  const row = new EOPT(
    "2007-04-05T00:00:00Z",
    54195,
    0, 0, 0, 0, 0, 33, 0,
    0, 0, 0,
    0, 0, 0, 0, 0, 0,
    COOKBOOK_EOP.xPoleRad,
    COOKBOOK_EOP.yPoleRad,
    0.0,
    0.0,
    COOKBOOK_EOP.dut1,
    0.0,
    "2007-04-05T00:00:00Z",
    "test-fixture-sofa-cookbook",
  );
  const root = row.pack(builder);
  EOP.finishEOPBuffer(builder, root);
  return builder.asUint8Array();
}

function cartesianState(position, velocity, systemName) {
  return new FRMStateVectorT(
    frmStateRepresentation.CARTESIAN,
    [...position, ...velocity],
    new FRMVector3T(...position),
    new FRMVector3T(...velocity),
    systemName,
    EPOCH_UTC,
    "UTC",
    EARTH_GM,
  );
}

async function invoke(harness, requestPayload, { eop = true, objectState = null } = {}) {
  const inputs = [
    {
      portId: "request",
      typeRef: { schemaName: "FRM.fbs", fileIdentifier: "$FRM", rootTypeName: "FRM" },
      payload: requestPayload,
    },
  ];
  if (eop) {
    inputs.push({
      portId: "earth_orientation",
      typeRef: { schemaName: "EOP.fbs", fileIdentifier: "$EOP", rootTypeName: "EOP" },
      payload: encodeCookbookEopRow(),
    });
  }
  if (objectState) {
    inputs.push({
      portId: "object_state",
      typeRef: { schemaName: "FRM.fbs", fileIdentifier: "$FRM", rootTypeName: "FRM" },
      payload: objectState,
    });
  }
  const response = await harness.invoke({ methodId: "transform_frame_position", inputs });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const frame = response.outputs?.[0];
  assert.ok(frame, "the module emitted no result frame");
  const buffer = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(FRM.bufferHasIdentifier(buffer), true);
  const result = FRM.getRootAsFRM(buffer).FRAME_TRANSFORM_RESULT();
  assert.ok(result, "missing FRM.FRAME_TRANSFORM_RESULT");
  return result;
}

function matrixOf(dcm) {
  return [
    dcm.M11(), dcm.M12(), dcm.M13(),
    dcm.M21(), dcm.M22(), dcm.M23(),
    dcm.M31(), dcm.M32(), dcm.M33(),
  ];
}

function maxAbsDifference(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  return worst;
}

function relativeError(actual, expected) {
  const magnitude = Math.hypot(...expected);
  const error = Math.hypot(...actual.map((value, index) => value - expected[index]));
  return magnitude > 0 ? error / magnitude : error;
}

const ICRF = () => coordinateSystem({ name: "ICRF", axisType: rfmAxisType.ICRF });
const ITRF = () =>
  coordinateSystem({ name: "ITRF", axisType: rfmAxisType.BODY_FIXED, axisBodyId: EARTH });

test("FRM operations 5/6/7 on the shipped artifact", { concurrency: false }, async (t) => {
  if (!fs.existsSync(WASM_PATH)) {
    t.skip("dist/isomorphic/module.wasm is not built; run npm run build");
    return;
  }
  const reference = buildNativeAxisReference();
  if (!reference) {
    t.skip("no host compiler or vendored ERFA; the native cross-check cannot run");
    return;
  }

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    surface: "direct",
  });

  try {
    await t.test("operation 6 GCRF->ITRF matches the native ERFA chain", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.FRAME_ROTATION,
          sourceSystem: ICRF(),
          targetSystem: ITRF(),
        }),
      );
      assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE() ?? "");
      const measured = matrixOf(result.ROTATION_DCM());
      const worst = maxAbsDifference(measured, reference.gcrfToItrf);
      console.log(`  GCRF->ITRF wasm vs native ERFA: max |delta| = ${worst.toExponential(4)}`);
      // The WASM module and the native harness compile the SAME header over the
      // SAME vendored ERFA. Anything above rounding here means they are not one
      // chain, which is the whole acceptance.
      assert.ok(worst <= 1e-14, `GCRF->ITRF differs by ${worst}`);
    });

    await t.test("operation 6 GCRF->GSE matches the native ERFA chain", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.FRAME_ROTATION,
          sourceSystem: ICRF(),
          targetSystem: coordinateSystem({
            name: "GSE",
            axisType: rfmAxisType.SOLAR_ECLIPTIC_MAGNETOSPHERIC,
          }),
        }),
      );
      assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE() ?? "");
      const worst = maxAbsDifference(matrixOf(result.ROTATION_DCM()), reference.gcrfToGse);
      console.log(`  GCRF->GSE  wasm vs native ERFA: max |delta| = ${worst.toExponential(4)}`);
      assert.ok(worst <= 1e-14, `GCRF->GSE differs by ${worst}`);
    });

    await t.test("operation 6 reports the Earth-rotation angular velocity", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.FRAME_ROTATION,
          sourceSystem: ICRF(),
          targetSystem: ITRF(),
        }),
      );
      const omega = result.ANGULAR_VELOCITY_RAD_S();
      const measured = [omega.X(), omega.Y(), omega.Z()];
      const worst = maxAbsDifference(measured, reference.gcrfToItrfAngularVelocity);
      const magnitude = Math.hypot(...measured);
      console.log(
        `  |omega| = ${magnitude.toExponential(10)} rad/s; wasm vs native max |delta| = ${worst.toExponential(4)}`,
      );
      // The two builds central-difference the same chain with different
      // instruction selection (WASM has no FMA contraction here, the native
      // build does), so the floor is the differencing round-off, eps/h ~ 2e-16
      // rad/s, not bit equality. MEASURED 1.3e-17 rad/s, i.e. 2e-13 relative.
      assert.ok(worst <= 1e-15, `angular velocity differs by ${worst}`);
      // IERS Conventions (2010) Table 1.1 nominal mean Earth rotation rate.
      assert.ok(
        Math.abs(magnitude - 7.292115e-5) <= 1e-11,
        `angular rate ${magnitude} is not the Earth rotation rate`,
      );
    });

    await t.test("operation 6 refuses an EOP-dependent chain with no EOP row", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.FRAME_ROTATION,
          sourceSystem: ICRF(),
          targetSystem: ITRF(),
        }),
        { eop: false },
      );
      // The provider must fail rather than silently substitute zeros. That
      // refusal IS the contract: a zeroed EOP is a different answer, not a
      // default.
      assert.equal(result.STATUS(), frmResultStatus.MISSING_EOP_DATA);
    });

    await t.test("operation 5 GCRF->ITRF->GCRF round-trips the full state", async () => {
      const toItrf = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: ICRF(),
          targetSystem: ITRF(),
          sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "ICRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(toItrf.STATUS(), frmResultStatus.OK, toItrf.ERROR_MESSAGE() ?? "");
      const itrfState = toItrf.TARGET_STATE();
      const itrfPosition = [
        itrfState.POSITION().X(), itrfState.POSITION().Y(), itrfState.POSITION().Z(),
      ];
      const itrfVelocity = [
        itrfState.VELOCITY().X(), itrfState.VELOCITY().Y(), itrfState.VELOCITY().Z(),
      ];

      const back = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: ITRF(),
          targetSystem: ICRF(),
          sourceState: cartesianState(itrfPosition, itrfVelocity, "ITRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(back.STATUS(), frmResultStatus.OK, back.ERROR_MESSAGE() ?? "");
      const restored = back.TARGET_STATE();
      const positionError = relativeError(
        [restored.POSITION().X(), restored.POSITION().Y(), restored.POSITION().Z()],
        STATE_POSITION,
      );
      const velocityError = relativeError(
        [restored.VELOCITY().X(), restored.VELOCITY().Y(), restored.VELOCITY().Z()],
        STATE_VELOCITY,
      );
      console.log(
        `  ICRF->ITRF->ICRF relative error: position ${positionError.toExponential(4)}, velocity ${velocityError.toExponential(4)}`,
      );
      assert.ok(positionError <= 1e-12, `position round-trip ${positionError}`);
      assert.ok(velocityError <= 1e-12, `velocity round-trip ${velocityError}`);
    });

    await t.test("operation 5 round-trips through a barycentre origin", async () => {
      const barycentre = coordinateSystem({
        name: "EarthMoonBarycentreICRF",
        axisType: rfmAxisType.ICRF,
        origin: new RFMOriginT(rfmOriginKind.BARYCENTRE, 0, EARTH_MOON_BARYCENTRE),
      });
      const out = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: ICRF(),
          targetSystem: barycentre,
          sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "ICRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(out.STATUS(), frmResultStatus.OK, out.ERROR_MESSAGE() ?? "");
      const shifted = out.TARGET_STATE();
      const shiftedPosition = [
        shifted.POSITION().X(), shifted.POSITION().Y(), shifted.POSITION().Z(),
      ];
      const shiftedVelocity = [
        shifted.VELOCITY().X(), shifted.VELOCITY().Y(), shifted.VELOCITY().Z(),
      ];
      // A barycentre origin MOVES the state: if it did not, the origin was
      // being ignored and the round-trip below would prove nothing.
      const displacement = Math.hypot(
        ...shiftedPosition.map((value, index) => value - STATE_POSITION[index]),
      );
      console.log(`  barycentre displacement: ${(displacement / 1000).toFixed(1)} km`);
      assert.ok(displacement > 4.0e6, "the Earth-Moon barycentre offset was not applied");

      const back = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: barycentre,
          targetSystem: ICRF(),
          sourceState: cartesianState(shiftedPosition, shiftedVelocity, "EarthMoonBarycentreICRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(back.STATUS(), frmResultStatus.OK, back.ERROR_MESSAGE() ?? "");
      const restored = back.TARGET_STATE();
      const error = relativeError(
        [restored.POSITION().X(), restored.POSITION().Y(), restored.POSITION().Z()],
        STATE_POSITION,
      );
      console.log(`  barycentre-origin round-trip relative error: ${error.toExponential(4)}`);
      assert.ok(error <= 1e-12, `barycentre round-trip ${error}`);
    });

    await t.test("operation 5 round-trips through an Earth-Moon L1 origin", async () => {
      const l1 = coordinateSystem({
        name: "EarthMoonL1",
        axisType: rfmAxisType.ICRF,
        origin: new RFMOriginT(
          rfmOriginKind.LIBRATION_POINT, 0, 0, rfmLibrationPoint.L1, EARTH, MOON,
        ),
      });
      const out = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: ICRF(),
          targetSystem: l1,
          sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "ICRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(out.STATUS(), frmResultStatus.OK, out.ERROR_MESSAGE() ?? "");
      const shifted = out.TARGET_STATE();
      const shiftedPosition = [
        shifted.POSITION().X(), shifted.POSITION().Y(), shifted.POSITION().Z(),
      ];
      const shiftedVelocity = [
        shifted.VELOCITY().X(), shifted.VELOCITY().Y(), shifted.VELOCITY().Z(),
      ];
      const distance = Math.hypot(
        ...shiftedPosition.map((value, index) => value - STATE_POSITION[index]),
      );
      // L1 sits at about 85% of the Earth-Moon distance, so the offset is of
      // order 3.2e8 m. The window is wide because the lunar distance varies.
      console.log(`  L1 offset: ${(distance / 1000).toFixed(0)} km`);
      assert.ok(distance > 2.8e8 && distance < 3.6e8, `L1 offset ${distance} m is not plausible`);

      const back = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: l1,
          targetSystem: ICRF(),
          sourceState: cartesianState(shiftedPosition, shiftedVelocity, "EarthMoonL1"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
      );
      assert.equal(back.STATUS(), frmResultStatus.OK, back.ERROR_MESSAGE() ?? "");
      const restored = back.TARGET_STATE();
      const error = relativeError(
        [restored.POSITION().X(), restored.POSITION().Y(), restored.POSITION().Z()],
        STATE_POSITION,
      );
      console.log(`  L1-origin round-trip relative error: ${error.toExponential(4)}`);
      assert.ok(error <= 1e-12, `L1 round-trip ${error}`);
    });

    await t.test("operation 5 resolves a spacecraft origin with RTN axes", async () => {
      const chaser = [7000500.0, 1201000.0, 300400.0];
      const chaserVelocity = [-1500.4, 7100.9, 400.2];
      const objectStatePayload = encodeRequest({
        operation: frmOperationCode.STATE_TRANSFORM,
        sourceSystem: coordinateSystem({
          name: "TargetICRF",
          axisType: rfmAxisType.ICRF,
          origin: new RFMOriginT(
            rfmOriginKind.SPACE_OBJECT, 0, 0, rfmLibrationPoint.UNSPECIFIED, 0, 0, "TARGET-1",
          ),
        }),
        sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "TargetICRF"),
      });

      const rtn = coordinateSystem({
        name: "TargetRTN",
        axisType: rfmAxisType.OBJECT_REFERENCED,
        origin: new RFMOriginT(
          rfmOriginKind.SPACE_OBJECT, 0, 0, rfmLibrationPoint.UNSPECIFIED, 0, 0, "TARGET-1",
        ),
        objectReferencedAxes: new RFMObjectReferencedAxesT(
          "TARGET-1",
          "",
          rfmVectorSpecification.RADIAL,
          rfmVectorSpecification.UNSPECIFIED,
          rfmVectorSpecification.ORBIT_NORMAL,
        ),
      });

      const out = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: ICRF(),
          targetSystem: rtn,
          sourceState: cartesianState(chaser, chaserVelocity, "ICRF"),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
        { objectState: objectStatePayload },
      );
      assert.equal(out.STATUS(), frmResultStatus.OK, out.ERROR_MESSAGE() ?? "");
      const relative = out.TARGET_STATE();
      const relativePosition = [
        relative.POSITION().X(), relative.POSITION().Y(), relative.POSITION().Z(),
      ];
      const separation = Math.hypot(
        ...chaser.map((value, index) => value - STATE_POSITION[index]),
      );
      // A rotation preserves length: the RTN separation must equal the
      // straight-line separation in ICRF.
      const lengthError = Math.abs(Math.hypot(...relativePosition) - separation) / separation;
      console.log(
        `  RTN separation ${Math.hypot(...relativePosition).toFixed(3)} m vs ICRF ${separation.toFixed(3)} m (relative ${lengthError.toExponential(4)})`,
      );
      assert.ok(lengthError <= 1e-12, `RTN separation length changed by ${lengthError}`);

      const back = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_TRANSFORM,
          sourceSystem: rtn,
          targetSystem: ICRF(),
          sourceState: cartesianState(
            relativePosition,
            [relative.VELOCITY().X(), relative.VELOCITY().Y(), relative.VELOCITY().Z()],
            "TargetRTN",
          ),
          targetRepresentation: frmStateRepresentation.CARTESIAN,
        }),
        { objectState: objectStatePayload },
      );
      assert.equal(back.STATUS(), frmResultStatus.OK, back.ERROR_MESSAGE() ?? "");
      const restored = back.TARGET_STATE();
      const error = relativeError(
        [restored.POSITION().X(), restored.POSITION().Y(), restored.POSITION().Z()],
        chaser,
      );
      console.log(`  spacecraft-origin round-trip relative error: ${error.toExponential(4)}`);
      assert.ok(error <= 1e-12, `spacecraft-origin round-trip ${error}`);
    });

    await t.test("operation 7 round-trips every implemented element set", async () => {
      const sets = [
        ["KEPLERIAN", frmStateRepresentation.KEPLERIAN],
        ["MODIFIED_KEPLERIAN", frmStateRepresentation.MODIFIED_KEPLERIAN],
        ["SPHERICAL_AZFPA", frmStateRepresentation.SPHERICAL_AZFPA],
        ["SPHERICAL_RADEC", frmStateRepresentation.SPHERICAL_RADEC],
        ["EQUINOCTIAL", frmStateRepresentation.EQUINOCTIAL],
        ["MODIFIED_EQUINOCTIAL", frmStateRepresentation.MODIFIED_EQUINOCTIAL],
        ["ALTERNATE_EQUINOCTIAL", frmStateRepresentation.ALTERNATE_EQUINOCTIAL],
        ["DELAUNAY", frmStateRepresentation.DELAUNAY],
      ];
      const system = ICRF();
      let worst = 0;
      for (const [name, representation] of sets) {
        const forward = await invoke(
          harness,
          encodeRequest({
            operation: frmOperationCode.STATE_REPRESENTATION_CONVERT,
            sourceSystem: system,
            sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "ICRF"),
            targetRepresentation: representation,
          }),
          { eop: false },
        );
        assert.equal(forward.STATUS(), frmResultStatus.OK, `${name}: ${forward.ERROR_MESSAGE()}`);
        const elements = [];
        const state = forward.TARGET_STATE();
        for (let i = 0; i < 6; i += 1) {
          elements.push(state.ELEMENTS(i));
        }

        const back = await invoke(
          harness,
          encodeRequest({
            operation: frmOperationCode.STATE_REPRESENTATION_CONVERT,
            sourceSystem: system,
            sourceState: new FRMStateVectorT(
              representation, elements, null, null, "ICRF", EPOCH_UTC, "UTC", EARTH_GM,
            ),
            targetRepresentation: frmStateRepresentation.CARTESIAN,
          }),
          { eop: false },
        );
        assert.equal(back.STATUS(), frmResultStatus.OK, `${name}: ${back.ERROR_MESSAGE()}`);
        const restored = back.TARGET_STATE();
        const positionError = relativeError(
          [restored.POSITION().X(), restored.POSITION().Y(), restored.POSITION().Z()],
          STATE_POSITION,
        );
        const velocityError = relativeError(
          [restored.VELOCITY().X(), restored.VELOCITY().Y(), restored.VELOCITY().Z()],
          STATE_VELOCITY,
        );
        const error = Math.max(positionError, velocityError);
        worst = Math.max(worst, error);
        console.log(`  ${name.padEnd(24)} round-trip relative error ${error.toExponential(4)}`);
        assert.ok(error <= 1e-12, `${name} round-trip ${error}`);
      }
      console.log(`  worst element-set round-trip: ${worst.toExponential(4)}`);
    });

    await t.test("operation 7 refuses Brouwer mean elements rather than approximating", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.STATE_REPRESENTATION_CONVERT,
          sourceSystem: ICRF(),
          sourceState: cartesianState(STATE_POSITION, STATE_VELOCITY, "ICRF"),
          targetRepresentation: frmStateRepresentation.BROUWER_MEAN_SHORT,
        }),
        { eop: false },
      );
      assert.equal(result.STATUS(), frmResultStatus.UNSUPPORTED_STATE_REPRESENTATION);
    });

    await t.test("the result carries the EOP data set it actually used", async () => {
      const result = await invoke(
        harness,
        encodeRequest({
          operation: frmOperationCode.FRAME_ROTATION,
          sourceSystem: ICRF(),
          targetSystem: ITRF(),
        }),
      );
      assert.equal(result.EOP_DATA_SET_CID(), "test-fixture-sofa-cookbook");
      assert.equal(result.EOP_DATA_SET_EPOCH(), "2007-04-05T00:00:00Z");
    });
  } finally {
    await harness.destroy();
  }
});
