import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import {
  meanElementSource,
  OMM,
  OMMT,
  timingStandard,
} from "../../../../spacedatastandards.org/lib/js/OMM/main.js";
import {
  OPM,
  OPMT,
} from "../../../../spacedatastandards.org/lib/js/OPM/main.js";
import {
  ephemerisDataBlockT,
  ephemerisDataLineT,
  OEM,
  OEMT,
} from "../../../../spacedatastandards.org/lib/js/OEM/main.js";
import {
  CDM,
  CDMT,
} from "../../../../spacedatastandards.org/lib/js/CDM/main.js";
import {
  CRD,
  CRDT,
} from "../../../../spacedatastandards.org/lib/js/CRD/main.js";
import {
  CentralBody,
  GravityModelName,
  GravityModelType,
  GRV,
  GRVT,
} from "../../../../spacedatastandards.org/lib/js/GRV/main.js";
import {
  anomalyConvention as vcmAnomalyConvention,
  equinoctialElementsT,
  keplerianElementsT,
  VCM,
  VCMStateVectorT,
  VCMT,
} from "../../../../spacedatastandards.org/lib/js/VCM/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeOmmMeanElements({
  objectName = "OREKIT-REFERENCE-ELLIPSE",
  objectId = "1998-067A",
  comment = "Orekit KeplerianOrbitTest.testJacobianReferenceEllipse input, converted from SI to SDS OMM units.",
  epoch = "2000-04-01T00:00:00.000Z",
  semiMajorAxis = 7000.0,
  eccentricity = 0.01,
  inclination = 80.0,
  raan = 20.0,
  argPericenter = 80.0,
  meanAnomaly = 40.0,
  gm = 398600.4415,
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new OMMT(
    2.0,
    "2026-05-24T00:00:00Z",
    "DigitalArsenal",
    objectName,
    objectId,
    "EARTH",
    null,
    null,
    timingStandard.UTC,
    meanElementSource.DSST,
    comment,
    epoch,
    semiMajorAxis,
    0.0,
    eccentricity,
    inclination,
    raan,
    argPericenter,
    meanAnomaly,
    gm,
  );
  const root = envelope.pack(builder);
  OMM.finishOMMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeOemCartesianState({
  comment = "Orekit KeplerianOrbitTest.testJacobianReferenceEllipse PV reference, converted from SI to SDS OEM units.",
  epoch = "2000-04-01T00:00:00.000Z",
  x = -3691.5555698748335,
  y = -240.33025399271487,
  z = 5879.700285850423,
  xDot = -5.936229884450408,
  yDot = -2.871067660163344,
  zDot = -3.7862095491927267,
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new OEMT(
    "U",
    2.0,
    "2026-05-24T00:00:00Z",
    "DigitalArsenal",
    [
      new ephemerisDataBlockT(
        comment,
        null,
        "EARTH",
        null,
        null,
        null,
        timingStandard.UTC,
        epoch,
        null,
        null,
        epoch,
        null,
        0,
        0.0,
        6,
        [],
        [
          new ephemerisDataLineT(
            epoch,
            x,
            y,
            z,
            xDot,
            yDot,
            zDot,
          ),
        ],
      ),
    ],
  );
  const root = envelope.pack(builder);
  OEM.finishOEMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeOpmOrbitParameters({
  objectName = "OREKIT-REFERENCE-ELLIPSE",
  objectId = "1998-067A",
  epoch = "2000-04-01T00:00:00.000Z",
  x = -3691.5555698748335,
  y = -240.33025399271487,
  z = 5879.700285850423,
  xDot = -5.936229884450408,
  yDot = -2.871067660163344,
  zDot = -3.7862095491927267,
  semiMajorAxis = 7000.0,
  eccentricity = 0.01,
  inclination = 80.0,
  raan = 20.0,
  argPericenter = 80.0,
  trueAnomaly = 40.82708546671332,
  meanAnomaly = 40.0,
  gm = 398600.4415,
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new OPMT(
    "2.0",
    "2026-05-24T00:00:00Z",
    "DigitalArsenal",
    objectName,
    objectId,
    "EARTH",
    "EME2000",
    "UTC",
    epoch,
    x,
    y,
    z,
    xDot,
    yDot,
    zDot,
    semiMajorAxis,
    eccentricity,
    inclination,
    raan,
    argPericenter,
    trueAnomaly,
    meanAnomaly,
    gm,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
  );
  const root = envelope.pack(builder);
  OPM.finishOPMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeGravityContext({ gm = 398600.4415 } = {}) {
  return encodeOmmMeanElements({
    comment: "GM context for Orekit/Basilisk orbit-conversion references.",
    semiMajorAxis: 0.0,
    eccentricity: 0.0,
    inclination: 0.0,
    raan: 0.0,
    argPericenter: 0.0,
    meanAnomaly: 0.0,
    gm,
  });
}

function encodeGrvJ2Context({
  equatorialRadius = 300.0,
  mu = 398600.436,
  j2 = 1e-3,
  j3 = 0.0,
  j4 = 0.0,
  j5 = 0.0,
  j6 = 0.0,
  maxDegree = 2,
  modelType = GravityModelType.J2_ONLY,
} = {}) {
  const builder = new flatbuffers.Builder(256);
  const envelope = new GRVT(
    modelType,
    GravityModelName.CUSTOM_MODEL,
    CentralBody.EARTH,
    maxDegree,
    0,
    false,
    false,
    false,
    false,
    false,
    false,
    equatorialRadius,
    j2,
    mu,
    j3,
    j4,
    j5,
    j6,
  );
  const root = envelope.pack(builder);
  GRV.finishGRVBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeGrvJ6Context({
  equatorialRadius = 6378.1366,
  mu = 398600.436,
  j2 = 1082.616e-6,
  j3 = -2.53881e-6,
  j4 = -1.65597e-6,
  j5 = -0.15e-6,
  j6 = 0.57e-6,
} = {}) {
  return encodeGrvJ2Context({
    equatorialRadius,
    mu,
    j2,
    j3,
    j4,
    j5,
    j6,
    maxDegree: 6,
    modelType: GravityModelType.J2_J6,
  });
}

function encodeVcmKeplerianState({
  objectName = "BASILISK-EQUINOCTIAL-REFERENCE",
  objectId = "BASILISK-ORBITAL-MOTION",
  stateEpoch = "2000-04-01T00:00:00.000Z",
  x = 0.0,
  y = 0.0,
  z = 0.0,
  xDot = 0.0,
  yDot = 0.0,
  zDot = 0.0,
  semiMajorAxis = 1000.0,
  eccentricity = 0.2,
  inclination = 0.2 * 180.0 / Math.PI,
  raan = 0.15 * 180.0 / Math.PI,
  argPericenter = 0.5 * 180.0 / Math.PI,
  anomalyType = vcmAnomalyConvention.TRUE_ANOMALY,
  anomaly = 0.2 * 180.0 / Math.PI,
  periapsisRadius = 0.0,
  gm = 398600.436,
  mass = 0.0,
  solarRadArea = 0.0,
  solarRadCoeff = 0.0,
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new VCMT(
    2.0,
    "2026-05-24T00:00:00Z",
    "DigitalArsenal",
    objectName,
    objectId,
    "EARTH",
    "EME2000",
    "UTC",
    new VCMStateVectorT(
      stateEpoch,
      x,
      y,
      z,
      xDot,
      yDot,
      zDot,
    ),
    new keplerianElementsT(
      semiMajorAxis,
      eccentricity,
      inclination,
      raan,
      argPericenter,
      anomalyType,
      anomaly,
      periapsisRadius,
    ),
    null,
    gm,
    null,
    null,
    null,
    mass,
    solarRadArea,
    solarRadCoeff,
  );
  const root = envelope.pack(builder);
  VCM.finishVCMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeCrdSunVectorAu({
  x = 1.0,
  y = 0.3,
  z = -0.2,
} = {}) {
  const builder = new flatbuffers.Builder(128);
  const envelope = new CRDT(
    x,
    y,
    z,
    0.0,
    0.0,
    0.0,
    1,
    0,
    [],
  );
  const root = envelope.pack(builder);
  CRD.finishCRDBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeVcmParabolicKeplerianState({
  objectName = "BASILISK-TWO-DIMENSION-PARABOLIC",
  objectId = "BASILISK-ORBITAL-MOTION",
  stateEpoch = "2000-04-01T00:00:00.000Z",
  periapsisRadius = 7500.0,
  inclination = 40.0,
  raan = 133.0,
  argPericenter = 113.0,
  anomalyType = vcmAnomalyConvention.TRUE_ANOMALY,
  anomaly = 123.0,
  gm = 398600.436,
} = {}) {
  return encodeVcmKeplerianState({
    objectName,
    objectId,
    stateEpoch,
    semiMajorAxis: 0.0,
    eccentricity: 1.0,
    inclination,
    raan,
    argPericenter,
    anomalyType,
    anomaly,
    periapsisRadius,
    gm,
  });
}

function encodeVcmEquinoctialState({
  objectName = "BASILISK-EQUINOCTIAL-REFERENCE",
  objectId = "BASILISK-ORBITAL-MOTION",
  stateEpoch = "2000-04-01T00:00:00.000Z",
  af = 0.15921675970981119530023306651856,
  ag = 0.12103728114720790909331071816268,
  trueLongitude = 0.85000000000000008881784197001252 * 180.0 / Math.PI,
  semiMajorAxis = 1000.0,
  chi = 0.01499382601880069713906618034116,
  psi = 0.09920802187229026125603326136115,
  gm = 398600.436,
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new VCMT(
    2.0,
    "2026-05-24T00:00:00Z",
    "DigitalArsenal",
    objectName,
    objectId,
    "EARTH",
    "EME2000",
    "UTC",
    new VCMStateVectorT(
      stateEpoch,
      0.0,
      0.0,
      0.0,
      0.0,
      0.0,
      0.0,
    ),
    null,
    new equinoctialElementsT(
      af,
      ag,
      trueLongitude,
      semiMajorAxis,
      chi,
      psi,
    ),
    gm,
  );
  const root = envelope.pack(builder);
  VCM.finishVCMBuffer(builder, root);
  return builder.asUint8Array();
}

function encodeCdmRelativeHillState({
  creationDate = "2026-05-24T00:00:00Z",
  originator = "DigitalArsenal",
  messageFor = "Basilisk Hill relative state",
  messageId = "BASILISK-HILL-RELATIVE",
  tca = "2000-04-01T00:00:00.000Z",
  relativePositionR = -0.286371,
  relativePositionT = 0.012113,
  relativePositionN = 0.875157,
  relativeVelocityR = 0.000689358,
  relativeVelocityT = 0.000620362,
  relativeVelocityN = 0.000927434,
} = {}) {
  const missDistance = Math.hypot(relativePositionR, relativePositionT, relativePositionN);
  const relativeSpeed = Math.hypot(relativeVelocityR, relativeVelocityT, relativeVelocityN);
  const builder = new flatbuffers.Builder(512);
  const envelope = new CDMT(
    2.0,
    creationDate,
    originator,
    messageFor,
    messageId,
    tca,
    missDistance,
    relativeSpeed,
    relativePositionR,
    relativePositionT,
    relativePositionN,
    relativeVelocityR,
    relativeVelocityT,
    relativeVelocityN,
  );
  const root = envelope.pack(builder);
  CDM.finishCDMBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeKeplerianToCartesian(harness, payload) {
  return harness.invoke({
    methodId: "keplerian_to_cartesian",
    inputs: [
      {
        portId: "mean_elements",
        typeRef: {
          schemaName: "OMM.fbs",
          fileIdentifier: "$OMM",
        },
        payload,
      },
    ],
  });
}

async function invokeCartesianToKeplerian(harness, cartesianPayload, contextPayload) {
  return harness.invoke({
    methodId: "cartesian_to_keplerian",
    inputs: [
      {
        portId: "cartesian_state",
        typeRef: {
          schemaName: "OEM.fbs",
          fileIdentifier: "$OEM",
        },
        payload: cartesianPayload,
      },
      {
        portId: "gravity_context",
        typeRef: {
          schemaName: "OMM.fbs",
          fileIdentifier: "$OMM",
        },
        payload: contextPayload,
      },
    ],
  });
}

async function invokeOpmToOem(harness, payload) {
  return harness.invoke({
    methodId: "opm_to_oem",
    inputs: [
      {
        portId: "orbit_parameters",
        typeRef: {
          schemaName: "OPM.fbs",
          fileIdentifier: "$OPM",
        },
        payload,
      },
    ],
  });
}

async function invokeOpmKeplerianToOem(harness, payload) {
  return harness.invoke({
    methodId: "opm_keplerian_to_oem",
    inputs: [
      {
        portId: "orbit_parameters",
        typeRef: {
          schemaName: "OPM.fbs",
          fileIdentifier: "$OPM",
        },
        payload,
      },
    ],
  });
}

async function invokeOpmToOmm(harness, payload) {
  return harness.invoke({
    methodId: "opm_to_omm",
    inputs: [
      {
        portId: "orbit_parameters",
        typeRef: {
          schemaName: "OPM.fbs",
          fileIdentifier: "$OPM",
        },
        payload,
      },
    ],
  });
}

async function invokeOpmKeplerianToOmm(harness, payload) {
  return harness.invoke({
    methodId: "opm_keplerian_to_omm",
    inputs: [
      {
        portId: "orbit_parameters",
        typeRef: {
          schemaName: "OPM.fbs",
          fileIdentifier: "$OPM",
        },
        payload,
      },
    ],
  });
}

async function invokeKeplerianToEquinoctial(harness, payload) {
  return harness.invoke({
    methodId: "keplerian_to_equinoctial",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeEquinoctialToKeplerian(harness, payload) {
  return harness.invoke({
    methodId: "equinoctial_to_keplerian",
    inputs: [
      {
        portId: "equinoctial_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmEquinoctialToOem(harness, payload) {
  return harness.invoke({
    methodId: "vcm_equinoctial_to_oem",
    inputs: [
      {
        portId: "equinoctial_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmEquinoctialToState(harness, payload) {
  return harness.invoke({
    methodId: "vcm_equinoctial_to_state",
    inputs: [
      {
        portId: "equinoctial_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianToOem(harness, payload) {
  return harness.invoke({
    methodId: "vcm_keplerian_to_oem",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianToState(harness, payload) {
  return harness.invoke({
    methodId: "vcm_keplerian_to_state",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmStateToOem(harness, payload) {
  return harness.invoke({
    methodId: "vcm_state_to_oem",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmStateToJZonalAccelerationOem(harness, statePayload, gravityPayload) {
  return harness.invoke({
    methodId: "vcm_state_to_j_zonal_acceleration_oem",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: statePayload,
      },
      {
        portId: "gravity_context",
        typeRef: {
          schemaName: "GRV.fbs",
          fileIdentifier: "$GRV",
          rootTypeName: "GRV",
        },
        payload: gravityPayload,
      },
    ],
  });
}

async function invokeVcmStateToSrpAccelerationOem(harness, statePayload, sunVectorPayload) {
  return harness.invoke({
    methodId: "vcm_state_to_srp_acceleration_oem",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: statePayload,
      },
      {
        portId: "sun_vector",
        typeRef: {
          schemaName: "CRD.fbs",
          fileIdentifier: "$CRD",
          rootTypeName: "CRD",
        },
        payload: sunVectorPayload,
      },
    ],
  });
}

async function invokeVcmStateToOmm(harness, payload) {
  return harness.invoke({
    methodId: "vcm_state_to_omm",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmStateToKeplerian(harness, payload) {
  return harness.invoke({
    methodId: "vcm_state_to_keplerian",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmStateToEquinoctial(harness, payload) {
  return harness.invoke({
    methodId: "vcm_state_to_equinoctial",
    inputs: [
      {
        portId: "vector_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianToOmm(harness, payload) {
  return harness.invoke({
    methodId: "vcm_keplerian_to_omm",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianToTrueAnomaly(harness, payload) {
  return harness.invoke({
    methodId: "vcm_keplerian_to_true_anomaly",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianToMeanAnomaly(harness, payload) {
  return harness.invoke({
    methodId: "vcm_keplerian_to_mean_anomaly",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmKeplerianMeanToOsculating(harness, keplerianPayload, gravityPayload) {
  return harness.invoke({
    methodId: "vcm_keplerian_mean_to_osculating",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: keplerianPayload,
      },
      {
        portId: "gravity_context",
        typeRef: {
          schemaName: "GRV.fbs",
          fileIdentifier: "$GRV",
          rootTypeName: "GRV",
        },
        payload: gravityPayload,
      },
    ],
  });
}

async function invokeVcmKeplerianOsculatingToMean(harness, keplerianPayload, gravityPayload) {
  return harness.invoke({
    methodId: "vcm_keplerian_osculating_to_mean",
    inputs: [
      {
        portId: "keplerian_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: keplerianPayload,
      },
      {
        portId: "gravity_context",
        typeRef: {
          schemaName: "GRV.fbs",
          fileIdentifier: "$GRV",
          rootTypeName: "GRV",
        },
        payload: gravityPayload,
      },
    ],
  });
}

async function invokeVcmEquinoctialToOmm(harness, payload) {
  return harness.invoke({
    methodId: "vcm_equinoctial_to_omm",
    inputs: [
      {
        portId: "equinoctial_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload,
      },
    ],
  });
}

async function invokeVcmPairToCdmRelativeHill(harness, chiefPayload, deputyPayload) {
  return harness.invoke({
    methodId: "vcm_pair_to_cdm_relative_hill",
    inputs: [
      {
        portId: "chief_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: chiefPayload,
      },
      {
        portId: "deputy_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: deputyPayload,
      },
    ],
  });
}

async function invokeCdmRelativeHillToVcmDeputyState(harness, chiefPayload, relativePayload) {
  return harness.invoke({
    methodId: "cdm_relative_hill_to_vcm_deputy_state",
    inputs: [
      {
        portId: "chief_state",
        typeRef: {
          schemaName: "VCM.fbs",
          rootTypeName: "VCM",
        },
        payload: chiefPayload,
      },
      {
        portId: "relative_state",
        typeRef: {
          schemaName: "CDM.fbs",
          fileIdentifier: "$CDM",
          rootTypeName: "CDM",
        },
        payload: relativePayload,
      },
    ],
  });
}

function decodeOemResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "cartesian_state");
  assert.equal(frame.typeRef?.schemaName, "OEM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$OEM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(OEM.bufferHasIdentifier(bb), true);
  return OEM.getRootAsOEM(bb);
}

function decodeOmmResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "mean_elements");
  assert.equal(frame.typeRef?.schemaName, "OMM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$OMM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(OMM.bufferHasIdentifier(bb), true);
  return OMM.getRootAsOMM(bb);
}

function decodeVcmResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "equinoctial_state");
  assert.equal(frame.typeRef?.schemaName, "VCM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, null);
  assert.equal(frame.typeRef?.rootTypeName, "VCM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  return VCM.getRootAsVCM(bb);
}

function decodeVcmKeplerianResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "keplerian_state");
  assert.equal(frame.typeRef?.schemaName, "VCM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, null);
  assert.equal(frame.typeRef?.rootTypeName, "VCM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  return VCM.getRootAsVCM(bb);
}

function decodeVcmVectorResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "vector_state");
  assert.equal(frame.typeRef?.schemaName, "VCM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, null);
  assert.equal(frame.typeRef?.rootTypeName, "VCM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  return VCM.getRootAsVCM(bb);
}

function outputPayload(response, portId) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, portId);
  return frame.payload;
}

function decodeVcmDeputyResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "deputy_state");
  assert.equal(frame.typeRef?.schemaName, "VCM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, null);
  assert.equal(frame.typeRef?.rootTypeName, "VCM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  return VCM.getRootAsVCM(bb);
}

function decodeCdmRelativeResponse(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "relative_state");
  assert.equal(frame.typeRef?.schemaName, "CDM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$CDM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(CDM.bufferHasIdentifier(bb), true);
  return CDM.getRootAsCDM(bb);
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}`);
}

function assertNearRelative(actual, expected, relativeTolerance, absoluteTolerance, label) {
  const delta = Math.abs(actual - expected);
  const tolerance = Math.max(absoluteTolerance, relativeTolerance * Math.max(1.0, Math.abs(expected)));
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}`);
}

function assertAngleNearDegrees(actual, expected, tolerance, label) {
  const delta = Math.abs(((actual - expected + 540.0) % 360.0) - 180.0);
  assert.ok(delta <= tolerance, `${label} angle delta ${delta} exceeds ${tolerance}`);
}

function meanMotionRevPerDayFromBasiliskKeplerianOrbitFormula(gmKm3PerS2, semiMajorAxisKm) {
  const meanMotionRadPerSecond = Math.sqrt(gmKm3PerS2 / semiMajorAxisKm ** 3);
  return meanMotionRadPerSecond * 86400.0 / (2.0 * Math.PI);
}

function hyperbolicMeanAnomalyDegreesFromTrueAnomaly(eccentricity, trueAnomalyDegrees) {
  const trueAnomaly = trueAnomalyDegrees * Math.PI / 180.0;
  const hyperbolicAnomaly = 2.0 * Math.atanh(
    Math.sqrt((eccentricity - 1.0) / (eccentricity + 1.0)) * Math.tan(trueAnomaly / 2.0),
  );
  return (eccentricity * Math.sinh(hyperbolicAnomaly) - hyperbolicAnomaly) * 180.0 / Math.PI;
}

function ellipticMeanAnomalyDegreesFromTrueAnomaly(eccentricity, trueAnomalyDegrees) {
  const trueAnomaly = trueAnomalyDegrees * Math.PI / 180.0;
  const eccentricAnomaly = 2.0 * Math.atan2(
    Math.sqrt(1.0 - eccentricity) * Math.sin(trueAnomaly / 2.0),
    Math.sqrt(1.0 + eccentricity) * Math.cos(trueAnomaly / 2.0),
  );
  const meanAnomaly = eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
  return ((meanAnomaly * 180.0 / Math.PI) + 360.0) % 360.0;
}

function basiliskOrbElemConvertSweepCases() {
  const inclined = { inclination: 33.3, raan: 48.2, argPericenter: 347.8, trueAnomaly: 85.3 };
  const equatorial = { inclination: 0.0, raan: 0.0, argPericenter: 347.8, trueAnomaly: 85.3 };
  const mu = 0.3986004415e15;
  const cases = [];
  const push = (name, base, aMeters, eccentricity) => {
    cases.push({ name, ...base, aMeters, eccentricity, mu });
  };

  for (const [index, eccentricity] of [0.01, 0.10, 0.25, 0.50, 0.75].entries()) {
    push(`IncEllip_e_${index + 1}`, inclined, 10000000.0, eccentricity);
    push(`EquEllip_e_${index + 1}`, equatorial, 10000000.0, eccentricity);
  }
  for (const [index, aMeters] of [10000000.0, 100000.0, 10000.0, 1000.0, 100.0, 10.0].entries()) {
    push(`IncEllip_a_${index + 1}`, inclined, aMeters, 0.50);
    push(`EquEllip_a_${index + 1}`, equatorial, aMeters, 0.50);
  }
  for (const [index, aMeters] of [10000000.0, 1000000.0, 100000.0, 10000.0, 1000.0, 100.0, 10.0].entries()) {
    push(`IncCirc_${index + 1}`, { ...inclined, argPericenter: 0.0 }, aMeters, 0.0);
    push(`EquCirc_${index + 1}`, { ...equatorial, argPericenter: 0.0 }, aMeters, 0.0);
  }
  for (const [index, aMeters] of [-10.0, -100.0, -1000.0, -10000.0, -100000.0].entries()) {
    push(`IncPara_${index + 1}`, inclined, aMeters, 1.0);
    push(`EquPara_${index + 1}`, equatorial, aMeters, 1.0);
  }
  for (const [index, aMeters] of [-10.0, -100.0, -1000.0, -10000.0, -100000.0].entries()) {
    push(`IncHyp_a_${index + 1}`, inclined, aMeters, 1.3);
    push(`EquHyp_a_${index + 1}`, equatorial, aMeters, 1.3);
  }
  for (const [index, eccentricity] of [1.1, 1.2, 1.3, 1.4, 1.5].entries()) {
    push(`IncHyp_e_${index + 1}`, inclined, -100000.0, eccentricity);
    push(`EquHyp_e_${index + 1}`, equatorial, -100000.0, eccentricity);
  }
  return cases;
}

function encodeBasiliskOrbElemConvertCase(caseEntry) {
  const semiMajorAxisKm = caseEntry.eccentricity === 1.0 ? 0.0 : caseEntry.aMeters / 1000.0;
  const periapsisRadiusKm = caseEntry.eccentricity === 1.0 ? -caseEntry.aMeters / 1000.0 : 0.0;
  return encodeVcmKeplerianState({
    objectName: `BASILISK-ORBELEM-${caseEntry.name}`,
    objectId: "BASILISK-ORB-ELEM-CONVERT",
    semiMajorAxis: semiMajorAxisKm,
    eccentricity: caseEntry.eccentricity,
    inclination: caseEntry.inclination,
    raan: caseEntry.raan,
    argPericenter: caseEntry.argPericenter,
    anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
    anomaly: caseEntry.trueAnomaly,
    periapsisRadius: periapsisRadiusKm,
    gm: caseEntry.mu / 1e9,
  });
}

function basiliskElem2RvReferenceKm(caseEntry) {
  const eccentricity = caseEntry.eccentricity;
  const semiMajorAxisKm = caseEntry.aMeters / 1000.0;
  const inclination = caseEntry.inclination * Math.PI / 180.0;
  const raan = caseEntry.raan * Math.PI / 180.0;
  const argPericenter = caseEntry.argPericenter * Math.PI / 180.0;
  const trueAnomaly = caseEntry.trueAnomaly * Math.PI / 180.0;
  const gm = caseEntry.mu / 1e9;
  const parameter = eccentricity === 1.0
    ? 2.0 * (-semiMajorAxisKm)
    : semiMajorAxisKm * (1.0 - eccentricity * eccentricity);
  const radius = parameter / (1.0 + eccentricity * Math.cos(trueAnomaly));
  const theta = argPericenter + trueAnomaly;
  const angularMomentum = Math.sqrt(gm * parameter);

  const x = radius * (Math.cos(raan) * Math.cos(theta) -
    Math.sin(raan) * Math.sin(theta) * Math.cos(inclination));
  const y = radius * (Math.sin(raan) * Math.cos(theta) +
    Math.cos(raan) * Math.sin(theta) * Math.cos(inclination));
  const z = radius * (Math.sin(theta) * Math.sin(inclination));

  const xDot = -gm / angularMomentum * (
    Math.cos(raan) * (Math.sin(theta) + eccentricity * Math.sin(argPericenter)) +
    Math.sin(raan) * (Math.cos(theta) + eccentricity * Math.cos(argPericenter)) * Math.cos(inclination)
  );
  const yDot = -gm / angularMomentum * (
    Math.sin(raan) * (Math.sin(theta) + eccentricity * Math.sin(argPericenter)) -
    Math.cos(raan) * (Math.cos(theta) + eccentricity * Math.cos(argPericenter)) * Math.cos(inclination)
  );
  const zDot = -gm / angularMomentum * (
    -(Math.cos(theta) + eccentricity * Math.cos(argPericenter)) * Math.sin(inclination)
  );

  return {
    x,
    y,
    z,
    xDot,
    yDot,
    zDot,
  };
}

// Authoritative numerical source:
// Orekit org.orekit.orbits.KeplerianOrbitTest.testJacobianReferenceEllipse uses
// a=7000000 m, e=0.01, i=80 deg, argPerigee=80 deg, RAAN=20 deg, mean anomaly=40 deg,
// mu=3.986004415e14 m^3/s^2, and asserts the PV reference vector. SDS OMM/OEM
// store these values in km and km/s, so the expected vector below is divided by
// 1000 from the Orekit SI values. Tolerances keep sub-millimeter position and
// sub-micrometer-per-second velocity agreement.

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

test("manifest declares OPM Keplerian true-anomaly to OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "opm_keplerian_to_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "orbit_parameters");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OPM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OPM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares OPM Keplerian true-anomaly to OMM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "opm_keplerian_to_omm");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "orbit_parameters");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OPM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OPM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "mean_elements");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OMM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OMM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM Keplerian to OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_keplerian_to_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "keplerian_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM Keplerian to state-vector contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_keplerian_to_state");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "keplerian_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "vector_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM Keplerian to OMM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_keplerian_to_omm");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "keplerian_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "mean_elements");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OMM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OMM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM Keplerian mean-to-osculating J2 contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_keplerian_mean_to_osculating");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "keplerian_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.inputPorts[1].portId, "gravity_context");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].schemaName, "GRV.fbs");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$GRV");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "keplerian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM Keplerian osculating-to-mean J2 contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_keplerian_osculating_to_mean");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "keplerian_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.inputPorts[1].portId, "gravity_context");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].schemaName, "GRV.fbs");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$GRV");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "keplerian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to J-zonal acceleration OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_j_zonal_acceleration_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.inputPorts[1].portId, "gravity_context");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].schemaName, "GRV.fbs");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$GRV");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to SRP acceleration OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_srp_acceleration_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.inputPorts[1].portId, "sun_vector");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].schemaName, "CRD.fbs");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$CRD");
  assert.equal(method.inputPorts[1].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to OMM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_omm");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "mean_elements");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OMM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OMM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to Keplerian contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_keplerian");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "keplerian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM state-vector to equinoctial contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_state_to_equinoctial");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "vector_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "equinoctial_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM equinoctial to OMM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_equinoctial_to_omm");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "equinoctial_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "mean_elements");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OMM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OMM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM equinoctial to OEM contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_equinoctial_to_oem");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "equinoctial_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "cartesian_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "OEM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$OEM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("manifest declares VCM equinoctial to state-vector contract", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "vcm_equinoctial_to_state");
  assert.notEqual(method, undefined);
  assert.equal(method.inputPorts[0].portId, "equinoctial_state");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.inputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
  assert.equal(method.outputPorts[0].portId, "vector_state");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].schemaName, "VCM.fbs");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[0].rootTypeName, "VCM");
  assert.equal(method.outputPorts[0].acceptedTypeSets[0].allowedTypes[1].wireFormat, "aligned-binary");
});

test("converts Orekit reference mean elements from SDS OMM to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeKeplerianToCartesian(harness, encodeOmmMeanElements());
  const oem = decodeOemResponse(response);
  assert.equal(oem.CCSDS_OEM_VERS(), 2.0);
  assert.equal(oem.ephemerisDataBlockLength(), 1);

  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  assert.equal(block.STOP_TIME(), "2000-04-01T00:00:00.000Z");
  assert.equal(block.ephemerisDataLinesLength(), 1);

  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), -3691.5555698748335, 1e-9, "position x km");
  assertNear(line.Y(), -240.33025399271487, 1e-9, "position y km");
  assertNear(line.Z(), 5879.700285850423, 1e-9, "position z km");
  assertNear(line.X_DOT(), -5.936229884450408, 1e-12, "velocity x km/s");
  assertNear(line.Y_DOT(), -2.871067660163344, 1e-12, "velocity y km/s");
  assertNear(line.Z_DOT(), -3.7862095491927267, 1e-12, "velocity z km/s");
});

test("converts Orekit reference Cartesian state from SDS OEM to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState(),
    encodeGravityContext(),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 7000.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.01, 1e-12, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 80.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 20.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 80.0, 1e-10, "argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 40.0, 1e-10, "mean anomaly deg");
  assertNear(omm.GM(), 398600.4415, 1e-12, "GM km^3/s^2");
});

test("recovers Basilisk parabolic OEM Cartesian state as OMM Barker mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const parabolicTrueAnomalyRad = 123.0 * Math.PI / 180.0;
  const barkerParameter = Math.tan(parabolicTrueAnomalyRad / 2.0);
  const parabolicMeanAnomalyDegrees =
    (barkerParameter + (barkerParameter ** 3) / 3.0) * 180.0 / Math.PI;

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.TwoDimensionParabolic rv2elem reference.",
      x: 27862.6148209797,
      y: 795.70270010667,
      z: -17554.0435142669,
      xDot: 3.06499561197954,
      yDot: 2.21344887266898,
      zDot: -3.14760065404514,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 0.0, 1e-10, "parabolic semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.0, 1e-12, "parabolic eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "parabolic inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "parabolic RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-10, "parabolic argument of pericenter deg");
  assertNear(omm.MEAN_ANOMALY(), parabolicMeanAnomalyDegrees, 1e-10, "parabolic Barker mean anomaly deg");
  assertNear(omm.MEAN_MOTION(), 0.0, 1e-15, "parabolic mean motion rev/day");
  assertNear(omm.GM(), 398600.436, 1e-12, "GM km^3/s^2");
});

test("converts Orekit reference SDS OPM Cartesian state to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeOpmToOem(harness, encodeOpmOrbitParameters());
  const oem = decodeOemResponse(response);
  assert.equal(oem.ephemerisDataBlockLength(), 1);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  const line = block.EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), -3691.5555698748335, 1e-9, "OPM position x km");
  assertNear(line.Y(), -240.33025399271487, 1e-9, "OPM position y km");
  assertNear(line.Z(), 5879.700285850423, 1e-9, "OPM position z km");
  assertNear(line.X_DOT(), -5.936229884450408, 1e-12, "OPM velocity x km/s");
  assertNear(line.Y_DOT(), -2.871067660163344, 1e-12, "OPM velocity y km/s");
  assertNear(line.Z_DOT(), -3.7862095491927267, 1e-12, "OPM velocity z km/s");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// TwoDimensionElliptical uses a=7500 km, e=0.5, i=40 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH=398600.436 km^3/s^2.
// This OPM path intentionally ignores Cartesian OPM fields and derives the OEM
// state from Keplerian TRUE_ANOMALY to cover CCSDS OPM element semantics.

test("converts Basilisk OPM Keplerian true-anomaly elements to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeOpmKeplerianToOem(
    harness,
    encodeOpmOrbitParameters({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 0.0,
      y: 0.0,
      z: 0.0,
      xDot: 0.0,
      yDot: 0.0,
      zDot: 0.0,
      semiMajorAxis: 7500.0,
      eccentricity: 0.5,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      trueAnomaly: 123.0,
      meanAnomaly: 0.0,
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  const line = block.EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), 6538.3506963942027, 1e-9, "OPM Keplerian position x km");
  assertNear(line.Y(), 186.7227227879431, 1e-9, "OPM Keplerian position y km");
  assertNear(line.Z(), -4119.3008399778619, 1e-9, "OPM Keplerian position z km");
  assertNear(line.X_DOT(), 1.4414106130924005, 1e-12, "OPM Keplerian velocity x km/s");
  assertNear(line.Y_DOT(), 5.588901415902356, 1e-12, "OPM Keplerian velocity y km/s");
  assertNear(line.Z_DOT(), -4.0828931566657038, 1e-12, "OPM Keplerian velocity z km/s");
});

test("normalizes Basilisk OPM Keplerian true-anomaly elements to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeOpmKeplerianToOmm(
    harness,
    encodeOpmOrbitParameters({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 0.0,
      y: 0.0,
      z: 0.0,
      xDot: 0.0,
      yDot: 0.0,
      zDot: 0.0,
      semiMajorAxis: 7500.0,
      eccentricity: 0.5,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      trueAnomaly: 123.0,
      meanAnomaly: 0.0,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-ELLIPTICAL");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-12, "OPM Keplerian semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.5, 1e-15, "OPM Keplerian eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-12, "OPM Keplerian inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-12, "OPM Keplerian RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-12, "OPM Keplerian argument of pericenter deg");
  assertAngleNearDegrees(
    omm.MEAN_ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.5, 123.0),
    1e-12,
    "OPM Keplerian mean anomaly deg",
  );
  assertNear(omm.GM(), 398600.436, 1e-12, "OPM Keplerian GM km^3/s^2");
});

test("recovers Orekit reference SDS OPM Cartesian state as SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeOpmToOmm(harness, encodeOpmOrbitParameters());
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "OREKIT-REFERENCE-ELLIPSE");
  assert.equal(omm.OBJECT_ID(), "1998-067A");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 7000.0, 1e-8, "OPM semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.01, 1e-12, "OPM eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 80.0, 1e-10, "OPM inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 20.0, 1e-10, "OPM RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 80.0, 1e-10, "OPM argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 40.0, 1e-10, "OPM mean anomaly deg");
  assertNear(omm.GM(), 398600.4415, 1e-12, "OPM GM km^3/s^2");
});

test("recovers Basilisk parabolic OPM Cartesian state as OMM Barker mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const parabolicTrueAnomalyRad = 123.0 * Math.PI / 180.0;
  const barkerParameter = Math.tan(parabolicTrueAnomalyRad / 2.0);
  const parabolicMeanAnomalyDegrees =
    (barkerParameter + (barkerParameter ** 3) / 3.0) * 180.0 / Math.PI;

  const response = await invokeOpmToOmm(
    harness,
    encodeOpmOrbitParameters({
      objectName: "BASILISK-TWO-DIMENSION-PARABOLIC",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 27862.6148209797,
      y: 795.70270010667,
      z: -17554.0435142669,
      xDot: 3.06499561197954,
      yDot: 2.21344887266898,
      zDot: -3.14760065404514,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-PARABOLIC");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 0.0, 1e-10, "OPM parabolic semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.0, 1e-12, "OPM parabolic eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "OPM parabolic inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "OPM parabolic RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-10, "OPM parabolic argument of pericenter deg");
  assertNear(omm.MEAN_ANOMALY(), parabolicMeanAnomalyDegrees, 1e-10, "OPM parabolic Barker mean anomaly deg");
  assertNear(omm.MEAN_MOTION(), 0.0, 1e-15, "OPM parabolic mean motion rev/day");
  assertNear(omm.GM(), 398600.436, 1e-12, "OPM parabolic GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// CircularInclined uses a=7500 km, e=0, i=40 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH. For a circular
// orbit, OMM mean anomaly carries the argument of latitude when argument of
// pericenter is undefined. Tolerances match Basilisk's 1e-11 relative element
// checks while allowing FlatBuffer/browser double roundoff.

test("recovers Basilisk circular inclined Cartesian state as OMM argument of latitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.CircularInclined elem2rv reference.",
      x: 6343.7735859429586,
      y: 181.16597468085499,
      z: -3996.7130970223939,
      xDot: -1.8379619466304487,
      yDot: 6.5499717954886121,
      zDot: -2.6203988553352131,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.0, 1e-11, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.0, 1e-10, "argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 236.0, 1e-10, "argument of latitude deg");
});

test("promotes Basilisk VCM Cartesian state vector to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToOem(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-CIRCULAR-INCLINED",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 6343.7735859429586,
      y: 181.16597468085499,
      z: -3996.7130970223939,
      xDot: -1.8379619466304487,
      yDot: 6.5499717954886121,
      zDot: -2.6203988553352131,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), 6343.7735859429586, 1e-12, "VCM state position x km");
  assertNear(line.Y(), 181.16597468085499, 1e-12, "VCM state position y km");
  assertNear(line.Z(), -3996.7130970223939, 1e-12, "VCM state position z km");
  assertNear(line.X_DOT(), -1.8379619466304487, 1e-12, "VCM state velocity x km/s");
  assertNear(line.Y_DOT(), 6.5499717954886121, 1e-12, "VCM state velocity y km/s");
  assertNear(line.Z_DOT(), -2.6203988553352131, 1e-12, "VCM state velocity z km/s");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// OrbitalMotion.jPerturb_order_6 uses r = [6200, 100, 2000] km and order 6
// with Basilisk Earth constants MU_EARTH, REQ_EARTH, and J2-J6.
// The fixture's stored check vector is stale; compiling current orbitalMotion.c
// directly with those constants yields the values asserted below.

test("computes Basilisk J2-J6 zonal perturbation acceleration from VCM state and GRV context", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToJZonalAccelerationOem(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-JPERTURB-ORDER-6",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 6200.0,
      y: 100.0,
      z: 2000.0,
      xDot: 0.0,
      yDot: 0.0,
      zDot: 0.0,
      gm: 398600.436,
    }),
    encodeGrvJ6Context(),
  );

  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.STATE_VECTOR_SIZE(), 9);
  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), 6200.0, 1e-12, "J-zonal source position x km");
  assertNear(line.Y(), 100.0, 1e-12, "J-zonal source position y km");
  assertNear(line.Z(), 2000.0, 1e-12, "J-zonal source position z km");
  assertNear(line.X_DDOT(), -7.3076237157986613e-6, 5e-16, "J-zonal acceleration x km/s^2");
  assertNear(line.Y_DDOT(), -1.1786489864191389e-7, 5e-18, "J-zonal acceleration y km/s^2");
  assertNear(line.Z_DDOT(), -1.1381693580051556e-5, 5e-16, "J-zonal acceleration z km/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// OrbitalMotion.solarRadiationPressure uses A = 2 m^2, m = 50 kg,
// sunvec = [1.0, 0.3, -0.2] AU, Cr = 1.3 from orbitalMotion.c solarRad,
// flux = 1372.5398 W/m^2, and c = 299792458 m/s.
// The fixture's stored check vector appears to come from an older flux value;
// compiling current orbitalMotion.c directly yields the values asserted below.

test("computes Basilisk solar radiation pressure acceleration from VCM spacecraft parameters and CRD sun vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToSrpAccelerationOem(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-SOLAR-RADIATION-PRESSURE",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 7000.0,
      y: 0.0,
      z: 0.0,
      xDot: 0.0,
      yDot: 7.5,
      zDot: 0.0,
      mass: 50.0,
      solarRadArea: 2.0,
      solarRadCoeff: 1.3,
    }),
    encodeCrdSunVectorAu(),
  );

  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.STATE_VECTOR_SIZE(), 9);
  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), 7000.0, 1e-12, "SRP source position x km");
  assertNear(line.Y_DOT(), 7.5, 1e-12, "SRP source velocity y km/s");
  assertNear(line.X_DDOT(), -1.98193735028737631e-10, 5e-21, "SRP acceleration x km/s^2");
  assertNear(line.Y_DDOT(), -5.94581205086212816e-11, 5e-22, "SRP acceleration y km/s^2");
  assertNear(line.Z_DDOT(), 3.96387470057475276e-11, 5e-22, "SRP acceleration z km/s^2");
});

test("recovers Basilisk VCM Cartesian state vector as OMM argument of latitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToOmm(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-CIRCULAR-INCLINED",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 6343.7735859429586,
      y: 181.16597468085499,
      z: -3996.7130970223939,
      xDot: -1.8379619466304487,
      yDot: 6.5499717954886121,
      zDot: -2.6203988553352131,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-CIRCULAR-INCLINED");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "VCM state semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.0, 1e-11, "VCM state eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "VCM state inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "VCM state RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.0, 1e-10, "VCM state argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 236.0, 1e-10, "VCM state argument of latitude deg");
  assertNear(omm.GM(), 398600.436, 1e-12, "VCM state GM km^3/s^2");
});

test("recovers Basilisk VCM Cartesian state vector as VCM Keplerian mean anomaly", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToKeplerian(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 6538.3506963942027,
      y: 186.7227227879431,
      z: -4119.3008399778619,
      xDot: 1.4414106130924005,
      yDot: 5.588901415902356,
      zDot: -4.0828931566657038,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-ELLIPTICAL");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(vcm.CENTER_NAME(), "EARTH");
  assert.equal(vcm.REF_FRAME(), "EME2000");
  assert.equal(vcm.TIME_SYSTEM(), "UTC");
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "VCM state semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 0.5, 1e-12, "VCM state eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 40.0, 1e-10, "VCM state inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 133.0, 1e-10, "VCM state RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 113.0, 1e-10, "VCM state argument of pericenter deg");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.MEAN_ANOMALY);
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.5, 123.0),
    1e-10,
    "VCM state mean anomaly deg",
  );
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM state GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// TwoDimensionParabolic.rv2elem uses rPeriap=7500 km, e=1, i=40 deg,
// RAAN=133 deg, argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH.
// VCM can preserve the recovered parabolic state as KEPLERIAN_ELEMENTS with
// TRUE_ANOMALY, while OMM uses the Barker mean-anomaly convention.

test("recovers Basilisk parabolic VCM Cartesian state vector as VCM Keplerian true anomaly", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToKeplerian(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-PARABOLIC",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 27862.6148209797,
      y: 795.70270010667,
      z: -17554.0435142669,
      xDot: 3.06499561197954,
      yDot: 2.21344887266898,
      zDot: -3.14760065404514,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-PARABOLIC");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 0.0, 1e-10, "VCM parabolic semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 1.0, 1e-12, "VCM parabolic eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 40.0, 1e-10, "VCM parabolic inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 133.0, 1e-10, "VCM parabolic RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 113.0, 1e-10, "VCM parabolic argument of pericenter deg");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(keplerian.ANOMALY(), 123.0, 1e-10, "VCM parabolic true anomaly deg");
  assertNear(keplerian.PERIAPSIS_RADIUS(), 7500.0, 1e-8, "VCM parabolic periapsis radius km");
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM parabolic GM km^3/s^2");
});

test("recovers Basilisk parabolic VCM Cartesian state vector as OMM Barker mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const parabolicTrueAnomalyRad = 123.0 * Math.PI / 180.0;
  const barkerParameter = Math.tan(parabolicTrueAnomalyRad / 2.0);
  const parabolicMeanAnomalyDegrees =
    (barkerParameter + (barkerParameter ** 3) / 3.0) * 180.0 / Math.PI;

  const response = await invokeVcmStateToOmm(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-PARABOLIC",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 27862.6148209797,
      y: 795.70270010667,
      z: -17554.0435142669,
      xDot: 3.06499561197954,
      yDot: 2.21344887266898,
      zDot: -3.14760065404514,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-PARABOLIC");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assertNear(omm.SEMI_MAJOR_AXIS(), 0.0, 1e-10, "OMM parabolic semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.0, 1e-12, "OMM parabolic eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "OMM parabolic inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "OMM parabolic RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-10, "OMM parabolic argument of pericenter deg");
  assertNear(omm.MEAN_ANOMALY(), parabolicMeanAnomalyDegrees, 1e-10, "OMM parabolic Barker mean anomaly deg");
  assertNear(omm.MEAN_MOTION(), 0.0, 1e-15, "OMM parabolic mean motion rev/day");
  assertNear(omm.GM(), 398600.436, 1e-12, "OMM parabolic GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk `src/simulation/dynamics/DynOutput/orbElemConvert/_UnitTest/
// test_orb_elem_convert.py` checks the `rv2elem` calculation against the
// signed conic range by subtracting signed 2*pi when `eO >= 1` and
// `abs(fO) > pi`.
// This state uses the same TwoDimensionParabolic geometry as the upstream
// unit test, but on the negative true-anomaly branch: f = -123 deg.
test("recovers Basilisk parabolic VCM Cartesian state with signed true anomaly", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToKeplerian(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-PARABOLIC-NEGATIVE-F",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: -18919.638129773895,
      y: 26713.87519561345,
      z: -3676.8269229873467,
      xDot: 0.909969526808347,
      yDot: -4.415647903980721,
      zDot: 1.968490014978394,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-PARABOLIC-NEGATIVE-F");
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 0.0, 1e-10, "VCM parabolic semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 1.0, 1e-12, "VCM parabolic eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 40.0, 1e-10, "VCM parabolic inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 133.0, 1e-10, "VCM parabolic RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 113.0, 1e-10, "VCM parabolic argument of pericenter deg");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertNear(keplerian.ANOMALY(), -123.0, 1e-10, "VCM parabolic signed true anomaly deg");
  assertNear(keplerian.PERIAPSIS_RADIUS(), 7500.0, 1e-8, "VCM parabolic periapsis radius km");
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM parabolic GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk `src/simulation/dynamics/DynOutput/orbElemConvert/_UnitTest/
// test_orb_elem_convert.py` parameterizes inclined/equatorial elliptical,
// circular, parabolic, and hyperbolic cases in SI units. SDS VCM stores the
// same elements in km, km/s, and km^3/s^2, so this ports the complete upstream
// sweep through the module's Keplerian-to-state and state-to-Keplerian VCM
// FlatBuffer surfaces.
test("covers Basilisk orbElemConvert parameter sweep through VCM Keplerian/state conversion", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  for (const caseEntry of basiliskOrbElemConvertSweepCases()) {
    const payload = encodeBasiliskOrbElemConvertCase(caseEntry);
    const expected = basiliskElem2RvReferenceKm(caseEntry);

    const stateResponse = await invokeVcmKeplerianToState(harness, payload);
    const stateVcm = decodeVcmVectorResponse(stateResponse);
    const state = stateVcm.STATE_VECTOR();
    assert.notEqual(state, null, `${caseEntry.name} missing state vector`);
    assert.equal(stateVcm.OBJECT_NAME(), `BASILISK-ORBELEM-${caseEntry.name}`);
    assert.equal(stateVcm.OBJECT_ID(), "BASILISK-ORB-ELEM-CONVERT");
    assertNearRelative(state.X(), expected.x, 5e-10, 5e-11, `${caseEntry.name} position x km`);
    assertNearRelative(state.Y(), expected.y, 5e-10, 5e-11, `${caseEntry.name} position y km`);
    assertNearRelative(state.Z(), expected.z, 5e-10, 5e-11, `${caseEntry.name} position z km`);
    assertNearRelative(state.X_DOT(), expected.xDot, 5e-10, 5e-11, `${caseEntry.name} velocity x km/s`);
    assertNearRelative(state.Y_DOT(), expected.yDot, 5e-10, 5e-11, `${caseEntry.name} velocity y km/s`);
    assertNearRelative(state.Z_DOT(), expected.zDot, 5e-10, 5e-11, `${caseEntry.name} velocity z km/s`);

    const recoveredResponse = await invokeVcmStateToKeplerian(
      harness,
      outputPayload(stateResponse, "vector_state"),
    );
    const recoveredTruePayload = outputPayload(
      await invokeVcmKeplerianToTrueAnomaly(
        harness,
        outputPayload(recoveredResponse, "keplerian_state"),
      ),
      "keplerian_state",
    );
    const recoveredVcm = decodeVcmKeplerianResponse({
      statusCode: 0,
      outputs: [
        {
          portId: "keplerian_state",
          typeRef: {
            schemaName: "VCM.fbs",
            fileIdentifier: null,
            rootTypeName: "VCM",
          },
          payload: recoveredTruePayload,
        },
      ],
    });
    const recovered = recoveredVcm.KEPLERIAN_ELEMENTS();
    assert.notEqual(recovered, null, `${caseEntry.name} missing recovered Keplerian elements`);

    const expectedSemiMajorAxis = caseEntry.eccentricity === 1.0 ? 0.0 : caseEntry.aMeters / 1000.0;
    const expectedPeriapsisRadius = caseEntry.eccentricity === 1.0 ? -caseEntry.aMeters / 1000.0 : 0.0;
    assertNearRelative(
      recovered.SEMI_MAJOR_AXIS(),
      expectedSemiMajorAxis,
      5e-9,
      5e-10,
      `${caseEntry.name} recovered semi-major axis km`,
    );
    assertNear(recovered.ECCENTRICITY(), caseEntry.eccentricity, 5e-9, `${caseEntry.name} recovered eccentricity`);
    assertAngleNearDegrees(recovered.INCLINATION(), caseEntry.inclination, 1e-7, `${caseEntry.name} recovered inclination deg`);
    assertAngleNearDegrees(recovered.RA_OF_ASC_NODE(), caseEntry.raan, 1e-7, `${caseEntry.name} recovered RAAN deg`);
    assertAngleNearDegrees(recovered.ARG_OF_PERICENTER(), caseEntry.argPericenter, 1e-7, `${caseEntry.name} recovered argument of pericenter deg`);
    assertAngleNearDegrees(recovered.ANOMALY(), caseEntry.trueAnomaly, 1e-7, `${caseEntry.name} recovered true anomaly deg`);
    assert.equal(recovered.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
    assertNearRelative(
      recovered.PERIAPSIS_RADIUS(),
      expectedPeriapsisRadius,
      5e-9,
      5e-10,
      `${caseEntry.name} recovered periapsis radius km`,
    );
    assertNear(recoveredVcm.GM(), caseEntry.mu / 1e9, 1e-12, `${caseEntry.name} recovered GM km^3/s^2`);
  }
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// TwoDimensionParabolic.elem2rv uses rPeriap=7500 km, e=1, i=40 deg,
// RAAN=133 deg, argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH.
// The SDS VCM Keplerian payload uses PERIAPSIS_RADIUS to carry the parabolic
// geometry that cannot be represented by semi-major axis when a=0.

test("converts Basilisk parabolic VCM Keplerian periapsis elements to Cartesian state", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const payload = encodeVcmParabolicKeplerianState();
  const stateResponse = await invokeVcmKeplerianToState(harness, payload);
  const vcm = decodeVcmVectorResponse(stateResponse);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-PARABOLIC");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assertNear(state.X(), 27862.6148209797, 1e-9, "parabolic state position x km");
  assertNear(state.Y(), 795.70270010667, 1e-9, "parabolic state position y km");
  assertNear(state.Z(), -17554.0435142669, 1e-9, "parabolic state position z km");
  assertNear(state.X_DOT(), 3.06499561197954, 1e-12, "parabolic state velocity x km/s");
  assertNear(state.Y_DOT(), 2.21344887266898, 1e-12, "parabolic state velocity y km/s");
  assertNear(state.Z_DOT(), -3.14760065404514, 1e-12, "parabolic state velocity z km/s");

  const oemResponse = await invokeVcmKeplerianToOem(harness, payload);
  const oem = decodeOemResponse(oemResponse);
  const line = oem.EPHEMERIS_DATA_BLOCK(0).EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), 27862.6148209797, 1e-9, "parabolic OEM position x km");
  assertNear(line.Y(), 795.70270010667, 1e-9, "parabolic OEM position y km");
  assertNear(line.Z(), -17554.0435142669, 1e-9, "parabolic OEM position z km");
  assertNear(line.X_DOT(), 3.06499561197954, 1e-12, "parabolic OEM velocity x km/s");
  assertNear(line.Y_DOT(), 2.21344887266898, 1e-12, "parabolic OEM velocity y km/s");
  assertNear(line.Z_DOT(), -3.14760065404514, 1e-12, "parabolic OEM velocity z km/s");
});

// Source: Basilisk `src/architecture/utilitiesSelfCheck/avsLibrarySelfCheck/avsLibrarySelfCheck.c`
// `testOrbitalHill`, mirroring `orbitalMotion.c` `rv2hill`. Inputs are inertial
// chief/deputy Cartesian states in km and km/s; output is CDM RTN/Hill relative
// position and velocity in km and km/s. Basilisk validates the vector with
// 1e-4 relative tolerance; these assertions use tighter absolute tolerances
// while respecting the source file's rounded six-decimal position vector.
test("maps Basilisk chief and deputy VCM states to CDM Hill relative state", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const chief = encodeVcmKeplerianState({
    objectName: "BASILISK-HILL-CHIEF",
    objectId: "BASILISK-HILL-CHIEF",
    stateEpoch: "2000-04-01T00:00:00.000Z",
    x: 353.38362479494975,
    y: 6494.841478640714,
    z: 2507.239669788398,
    xDot: -7.073840333019544,
    yDot: -0.5666429544308719,
    zDot: 2.6565522055197555,
  });
  const deputy = encodeVcmKeplerianState({
    objectName: "BASILISK-HILL-DEPUTY",
    objectId: "BASILISK-HILL-DEPUTY",
    stateEpoch: "2000-04-01T00:00:00.000Z",
    x: 353.6672082996106,
    y: 6494.264242564805,
    z: 2507.898786238764,
    xDot: -7.073766857682589,
    yDot: -0.5663665778237081,
    zDot: 2.65770594819381,
  });

  const cdm = decodeCdmRelativeResponse(
    await invokeVcmPairToCdmRelativeHill(harness, chief, deputy),
  );

  assertNear(cdm.RELATIVE_POSITION_R(), -0.286371, 1e-6, "Hill radial relative position km");
  assertNear(cdm.RELATIVE_POSITION_T(), 0.012113, 1e-6, "Hill transverse relative position km");
  assertNear(cdm.RELATIVE_POSITION_N(), 0.875157, 1e-6, "Hill normal relative position km");
  assertNear(cdm.RELATIVE_VELOCITY_R(), 0.000689358, 1e-9, "Hill radial relative velocity km/s");
  assertNear(cdm.RELATIVE_VELOCITY_T(), 0.000620362, 1e-9, "Hill transverse relative velocity km/s");
  assertNear(cdm.RELATIVE_VELOCITY_N(), 0.000927434, 1e-9, "Hill normal relative velocity km/s");
});

test("maps Basilisk CDM Hill relative state and chief VCM to deputy VCM state", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const chief = encodeVcmKeplerianState({
    objectName: "BASILISK-HILL-CHIEF",
    objectId: "BASILISK-HILL-CHIEF",
    stateEpoch: "2000-04-01T00:00:00.000Z",
    x: 353.38362479494975,
    y: 6494.841478640714,
    z: 2507.239669788398,
    xDot: -7.073840333019544,
    yDot: -0.5666429544308719,
    zDot: 2.6565522055197555,
  });
  const relative = encodeCdmRelativeHillState();

  const deputy = decodeVcmDeputyResponse(
    await invokeCdmRelativeHillToVcmDeputyState(harness, chief, relative),
  );
  const state = deputy.STATE_VECTOR();

  assert.equal(state.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(state.X(), 353.6672082996106, 1e-6, "deputy position x km");
  assertNear(state.Y(), 6494.264242564805, 1e-6, "deputy position y km");
  assertNear(state.Z(), 2507.898786238764, 1e-6, "deputy position z km");
  assertNear(state.X_DOT(), -7.073766857682589, 1e-9, "deputy velocity x km/s");
  assertNear(state.Y_DOT(), -0.5663665778237081, 1e-9, "deputy velocity y km/s");
  assertNear(state.Z_DOT(), 2.65770594819381, 1e-9, "deputy velocity z km/s");
});

test("recovers Basilisk VCM Cartesian state vector as VCM equinoctial elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmStateToEquinoctial(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 6538.3506963942027,
      y: 186.7227227879431,
      z: -4119.3008399778619,
      xDot: 1.4414106130924005,
      yDot: 5.588901415902356,
      zDot: -4.0828931566657038,
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmResponse(response);
  const equinoctial = vcm.EQUINOCTIAL_ELEMENTS();
  assert.notEqual(equinoctial, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-ELLIPTICAL");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(vcm.CENTER_NAME(), "EARTH");
  assert.equal(vcm.REF_FRAME(), "EME2000");
  assert.equal(vcm.TIME_SYSTEM(), "UTC");
  assertNear(equinoctial.N(), 7500.0, 1e-8, "VCM state equinoctial semi-major axis km");
  assertNear(equinoctial.AF(), -0.20336832153790005, 1e-14, "VCM state equinoctial AF");
  assertNear(equinoctial.AG(), -0.4567727288213005, 1e-14, "VCM state equinoctial AG");
  assertNear(equinoctial.CHI(), 0.26619097810978376, 1e-14, "VCM state equinoctial CHI");
  assertNear(equinoctial.PSI(), -0.24822710288111335, 1e-14, "VCM state equinoctial PSI");
  assertAngleNearDegrees(equinoctial.L(), 9.0, 1e-10, "VCM state equinoctial true longitude deg");
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM state GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// CircularEquitorial uses a=7500 km, e=0, i=0 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH. For a circular
// equatorial orbit, both RAAN and argument of pericenter are undefined, so OMM
// stores the true longitude in MEAN_ANOMALY and zeroes both undefined angles.

test("recovers Basilisk circular equatorial Cartesian state as OMM true longitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.CircularEquitorial elem2rv reference.",
      x: 7407.6625544635335,
      y: 1173.2584878017262,
      z: 0.0,
      xDot: -1.1404354122910105,
      yDot: 7.2004258117414572,
      zDot: 0.0,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.0, 1e-11, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 0.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.0, 1e-10, "argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 9.0, 1e-10, "true longitude deg");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// NonCircularEquitorial uses a=7500 km, e=0.5, i=0 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH. For a non-circular
// equatorial orbit, RAAN is undefined, so OMM stores longitude of pericenter
// in ARG_OF_PERICENTER with RA_OF_ASC_NODE zeroed; MEAN_ANOMALY remains the
// elliptic mean anomaly corresponding to the Basilisk true anomaly.

test("converts Basilisk non-circular equatorial OMM mean elements to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeKeplerianToCartesian(
    harness,
    encodeOmmMeanElements({
      objectName: "BASILISK-NON-CIRCULAR-EQUITORIAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      comment: "Basilisk OrbitalMotion.NonCircularEquitorial elem2rv reference.",
      semiMajorAxis: 7500.0,
      eccentricity: 0.5,
      inclination: 0.0,
      raan: 0.0,
      argPericenter: 246.0,
      meanAnomaly: ellipticMeanAnomalyDegreesFromTrueAnomaly(0.5, 123.0),
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const line = oem.EPHEMERIS_DATA_BLOCK(0).EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), 7634.8714161163643, 1e-9, "equatorial position x km");
  assertNear(line.Y(), 1209.2448361913848, 1e-9, "equatorial position y km");
  assertNear(line.Z(), 0.0, 1e-12, "equatorial position z km");
  assertNear(line.X_DOT(), 2.5282399359829868, 1e-12, "equatorial velocity x km/s");
  assertNear(line.Y_DOT(), 6.6023861555546057, 1e-12, "equatorial velocity y km/s");
  assertNear(line.Z_DOT(), 0.0, 1e-12, "equatorial velocity z km/s");
});

test("recovers Basilisk non-circular equatorial Cartesian state as OMM longitude of pericenter", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.NonCircularEquitorial rv2elem reference.",
      x: 7634.8714161163643,
      y: 1209.2448361913848,
      z: 0.0,
      xDot: 2.5282399359829868,
      yDot: 6.6023861555546057,
      zDot: 0.0,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.5, 1e-12, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 0.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 246.0, 1e-10, "longitude of pericenter deg");
  assertAngleNearDegrees(
    omm.MEAN_ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.5, 123.0),
    1e-10,
    "elliptic mean anomaly deg",
  );
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// NonCircularNearEquitorial uses the same a/e/RAAN/argPerigee/true-anomaly
// setup as NonCircularEquitorial with inclination eps2=5e-13 rad. Basilisk
// asserts the wrapped Omega+omega longitude of pericenter for this case rather
// than requiring a specific split between RAAN and argument of pericenter.

test("recovers Basilisk near-equatorial Cartesian state with longitude-of-pericenter sum", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.NonCircularNearEquitorial rv2elem reference.",
      x: 7634.87141611636,
      y: 1209.24483619139,
      z: -3.20424723337984e-9,
      xDot: 2.52823993598298,
      yDot: 6.60238615555461,
      zDot: -3.17592708317508e-12,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "near-equatorial semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.5, 1e-12, "near-equatorial eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 5e-13 * 180.0 / Math.PI, 1e-9, "near-equatorial inclination deg");
  assertAngleNearDegrees(
    omm.RA_OF_ASC_NODE() + omm.ARG_OF_PERICENTER(),
    246.0,
    1e-10,
    "near-equatorial longitude of pericenter deg",
  );
  assertAngleNearDegrees(
    omm.MEAN_ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.5, 123.0),
    1e-10,
    "near-equatorial elliptic mean anomaly deg",
  );
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// CircularEquitorialRetrograde uses a=7500 km, e=0, i=180 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH. For a circular
// retrograde equatorial orbit, RAAN and argument of pericenter are undefined;
// OMM stores the retrograde true longitude in MEAN_ANOMALY with both zeroed.

test("converts Basilisk circular retrograde equatorial OMM state to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeKeplerianToCartesian(
    harness,
    encodeOmmMeanElements({
      objectName: "BASILISK-CIRCULAR-EQUITORIAL-RETROGRADE",
      objectId: "BASILISK-ORBITAL-MOTION",
      comment: "Basilisk OrbitalMotion.CircularEquitorialRetrograde elem2rv reference.",
      semiMajorAxis: 7500.0,
      eccentricity: 0.0,
      inclination: 180.0,
      raan: 0.0,
      argPericenter: 0.0,
      meanAnomaly: 103.0,
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const line = oem.EPHEMERIS_DATA_BLOCK(0).EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), -1687.13290757899, 1e-9, "retrograde position x km");
  assertNear(line.Y(), -7307.77548588926, 1e-9, "retrograde position y km");
  assertNear(line.Z(), 0.0, 1e-12, "retrograde position z km");
  assertNear(line.X_DOT(), -7.10333318346184, 1e-12, "retrograde velocity x km/s");
  assertNear(line.Y_DOT(), 1.63993368302803, 1e-12, "retrograde velocity y km/s");
  assertNear(line.Z_DOT(), 0.0, 1e-12, "retrograde velocity z km/s");
});

test("recovers Basilisk circular retrograde equatorial Cartesian state as OMM true longitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.CircularEquitorialRetrograde rv2elem reference.",
      x: -1687.13290757899,
      y: -7307.77548588926,
      z: 0.0,
      xDot: -7.10333318346184,
      yDot: 1.63993368302803,
      zDot: 0.0,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.0, 1e-11, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 180.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.0, 1e-10, "argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 103.0, 1e-10, "retrograde true longitude deg");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// TwoDimensionHyperbolic uses a=-7500 km, e=1.4, i=40 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=23 deg, and MU_EARTH=398600.436 km^3/s^2.
// OMM stores mean anomaly, so these tests convert Basilisk's true anomaly to
// hyperbolic mean anomaly using M=e*sinh(H)-H and
// tanh(H/2)=sqrt((e-1)/(e+1))*tan(f/2). Tolerances match Basilisk's 1e-11
// relative element checks while allowing FlatBuffer/browser double roundoff.

test("converts Basilisk hyperbolic OMM mean elements to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeKeplerianToCartesian(
    harness,
    encodeOmmMeanElements({
      objectName: "BASILISK-TWO-DIMENSION-HYPERBOLIC",
      objectId: "BASILISK-ORBITAL-MOTION",
      comment: "Basilisk OrbitalMotion.TwoDimensionHyperbolic elem2rv reference.",
      semiMajorAxis: -7500.0,
      eccentricity: 1.4,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      meanAnomaly: hyperbolicMeanAnomalyDegreesFromTrueAnomaly(1.4, 23.0),
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const line = oem.EPHEMERIS_DATA_BLOCK(0).EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), 319.013136281857, 1e-9, "hyperbolic position x km");
  assertNear(line.Y(), -2796.71958333493, 1e-9, "hyperbolic position y km");
  assertNear(line.Z(), 1404.6919948109, 1e-9, "hyperbolic position z km");
  assertNear(line.X_DOT(), 15.3433051336115, 1e-12, "hyperbolic velocity x km/s");
  assertNear(line.Y_DOT(), -5.87012423567412, 1e-12, "hyperbolic velocity y km/s");
  assertNear(line.Z_DOT(), -6.05659420479213, 1e-12, "hyperbolic velocity z km/s");
});

test("recovers Basilisk hyperbolic Cartesian state as OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeCartesianToKeplerian(
    harness,
    encodeOemCartesianState({
      comment: "Basilisk OrbitalMotion.TwoDimensionHyperbolic rv2elem reference.",
      x: 319.013136281857,
      y: -2796.71958333493,
      z: 1404.6919948109,
      xDot: 15.3433051336115,
      yDot: -5.87012423567412,
      zDot: -6.05659420479213,
    }),
    encodeGravityContext({ gm: 398600.436 }),
  );
  const omm = decodeOmmResponse(response);
  assertNear(omm.SEMI_MAJOR_AXIS(), -7500.0, 1e-8, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.4, 1e-12, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-10, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-10, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-10, "argument of pericenter deg");
  assertNear(
    omm.MEAN_ANOMALY(),
    hyperbolicMeanAnomalyDegreesFromTrueAnomaly(1.4, 23.0),
    1e-10,
    "hyperbolic mean anomaly deg",
  );
});

test("normalizes Basilisk VCM hyperbolic Keplerian true-anomaly elements to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianToOmm(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-HYPERBOLIC",
      objectId: "BASILISK-ORBITAL-MOTION",
      semiMajorAxis: -7500.0,
      eccentricity: 1.4,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 23.0,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-HYPERBOLIC");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assertNear(omm.SEMI_MAJOR_AXIS(), -7500.0, 1e-12, "VCM hyperbolic semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.4, 1e-15, "VCM hyperbolic eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-12, "VCM hyperbolic inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-12, "VCM hyperbolic RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-12, "VCM hyperbolic argument of pericenter deg");
  assertNear(
    omm.MEAN_ANOMALY(),
    hyperbolicMeanAnomalyDegreesFromTrueAnomaly(1.4, 23.0),
    1e-12,
    "VCM hyperbolic mean anomaly deg",
  );
  assertNear(omm.GM(), 398600.436, 1e-12, "VCM hyperbolic GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// OrbitalMotion.elem2rv1DHyperbolic uses a=-7500 km, e=1, i=40 deg,
// RAAN=133 deg, argPerigee=113 deg, anomaly=23 deg, and MU_EARTH. Basilisk's
// rectilinear branch treats ClassicElements.f as the hyperbolic anomaly, so SDS
// VCM carries that source anomaly through ANOMALY with TRUE_ANOMALY convention
// rather than normalizing it into an SDS OMM mean anomaly.

test("converts Basilisk rectilinear hyperbolic VCM anomaly elements to Cartesian state", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const payload = encodeVcmKeplerianState({
    objectName: "BASILISK-RECTILINEAR-HYPERBOLIC",
    objectId: "BASILISK-ORBITAL-MOTION",
    semiMajorAxis: -7500.0,
    eccentricity: 1.0,
    inclination: 40.0,
    raan: 133.0,
    argPericenter: 113.0,
    anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
    anomaly: 23.0,
    gm: 398600.436,
  });

  const stateResponse = await invokeVcmKeplerianToState(harness, payload);
  const vcm = decodeVcmVectorResponse(stateResponse);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-RECTILINEAR-HYPERBOLIC");
  assertNear(state.X(), -152.641873349816, 1e-9, "rectilinear state position x km");
  assertNear(state.Y(), -469.543156608544, 1e-9, "rectilinear state position y km");
  assertNear(state.Z(), 362.375968124408, 1e-9, "rectilinear state position z km");
  assertNear(state.X_DOT(), -9.17378720883851, 1e-12, "rectilinear state velocity x km/s");
  assertNear(state.Y_DOT(), -28.2195763820421, 1e-12, "rectilinear state velocity y km/s");
  assertNear(state.Z_DOT(), 21.7788208976681, 1e-12, "rectilinear state velocity z km/s");

  const oemResponse = await invokeVcmKeplerianToOem(harness, payload);
  const oem = decodeOemResponse(oemResponse);
  const line = oem.EPHEMERIS_DATA_BLOCK(0).EPHEMERIS_DATA_LINES(0);
  assertNear(line.X(), -152.641873349816, 1e-9, "rectilinear OEM position x km");
  assertNear(line.Y(), -469.543156608544, 1e-9, "rectilinear OEM position y km");
  assertNear(line.Z(), 362.375968124408, 1e-9, "rectilinear OEM position z km");
  assertNear(line.X_DOT(), -9.17378720883851, 1e-12, "rectilinear OEM velocity x km/s");
  assertNear(line.Y_DOT(), -28.2195763820421, 1e-12, "rectilinear OEM velocity y km/s");
  assertNear(line.Z_DOT(), 21.7788208976681, 1e-12, "rectilinear OEM velocity z km/s");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// OrbitalMotion.elem2rv1DEccentric uses a=7500 km, e=1, i=40 deg,
// RAAN=133 deg, argPerigee=113 deg, anomaly=23 deg, and MU_EARTH. As with the
// rectilinear hyperbolic case, Basilisk treats ClassicElements.f as the source
// rectilinear anomaly.

test("converts Basilisk rectilinear elliptical VCM anomaly elements to Cartesian state", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianToState(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-RECTILINEAR-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      semiMajorAxis: 7500.0,
      eccentricity: 1.0,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 23.0,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmVectorResponse(response);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-RECTILINEAR-ELLIPTICAL");
  assertNear(state.X(), -148.596902253492, 1e-9, "rectilinear elliptical position x km");
  assertNear(state.Y(), -457.100381534593, 1e-9, "rectilinear elliptical position y km");
  assertNear(state.Z(), 352.773096481799, 1e-9, "rectilinear elliptical position z km");
  assertNear(state.X_DOT(), -8.93065944520745, 1e-12, "rectilinear elliptical velocity x km/s");
  assertNear(state.Y_DOT(), -27.4716886950712, 1e-12, "rectilinear elliptical velocity y km/s");
  assertNear(state.Z_DOT(), 21.2016289595043, 1e-12, "rectilinear elliptical velocity z km/s");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// TwoDimensionElliptical uses a=7500 km, e=0.5, i=40 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH=398600.436 km^3/s^2.
// The VCM test carries a deliberately wrong STATE_VECTOR and derives OEM from
// KEPLERIAN_ELEMENTS while using STATE_VECTOR.EPOCH as required OEM metadata.

test("converts Basilisk VCM Keplerian true-anomaly elements to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianToOem(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 0.0,
      y: 0.0,
      z: 0.0,
      xDot: 0.0,
      yDot: 0.0,
      zDot: 0.0,
      semiMajorAxis: 7500.0,
      eccentricity: 0.5,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 123.0,
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), 6538.3506963942027, 1e-9, "VCM Keplerian position x km");
  assertNear(line.Y(), 186.7227227879431, 1e-9, "VCM Keplerian position y km");
  assertNear(line.Z(), -4119.3008399778619, 1e-9, "VCM Keplerian position z km");
  assertNear(line.X_DOT(), 1.4414106130924005, 1e-12, "VCM Keplerian velocity x km/s");
  assertNear(line.Y_DOT(), 5.588901415902356, 1e-12, "VCM Keplerian velocity y km/s");
  assertNear(line.Z_DOT(), -4.0828931566657038, 1e-12, "VCM Keplerian velocity z km/s");
});

test("converts Basilisk VCM Keplerian true-anomaly elements to VCM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianToState(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      x: 0.0,
      y: 0.0,
      z: 0.0,
      xDot: 0.0,
      yDot: 0.0,
      zDot: 0.0,
      semiMajorAxis: 7500.0,
      eccentricity: 0.5,
      inclination: 40.0,
      raan: 133.0,
      argPericenter: 113.0,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 123.0,
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmVectorResponse(response);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-ELLIPTICAL");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(state.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(state.X(), 6538.3506963942027, 1e-9, "VCM Keplerian state position x km");
  assertNear(state.Y(), 186.7227227879431, 1e-9, "VCM Keplerian state position y km");
  assertNear(state.Z(), -4119.3008399778619, 1e-9, "VCM Keplerian state position z km");
  assertNear(state.X_DOT(), 1.4414106130924005, 1e-12, "VCM Keplerian state velocity x km/s");
  assertNear(state.Y_DOT(), 5.588901415902356, 1e-12, "VCM Keplerian state velocity y km/s");
  assertNear(state.Z_DOT(), -4.0828931566657038, 1e-12, "VCM Keplerian state velocity z km/s");
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM state GM km^3/s^2");
});

test("normalizes Basilisk VCM Keplerian true-anomaly elements to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianToOmm(harness, encodeVcmKeplerianState());
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-EQUINOCTIAL-REFERENCE");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 1000.0, 1e-12, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.2, 1e-15, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 0.2 * 180.0 / Math.PI, 1e-12, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.15 * 180.0 / Math.PI, 1e-12, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.5 * 180.0 / Math.PI, 1e-12, "argument of pericenter deg");
  assertAngleNearDegrees(
    omm.MEAN_ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.2, 0.2 * 180.0 / Math.PI),
    1e-12,
    "mean anomaly deg",
  );
  assertNear(
    omm.MEAN_MOTION(),
    meanMotionRevPerDayFromBasiliskKeplerianOrbitFormula(398600.436, 1000.0),
    1e-12,
    "Basilisk KeplerianOrbit mean motion rev/day",
  );
  assertNear(omm.GM(), 398600.436, 1e-12, "GM km^3/s^2");
});

// Source: Basilisk `src/architecture/utilitiesSelfCheck/avsLibrarySelfCheck/avsLibrarySelfCheck.c`
// `testOrbitalAnomalies` checks E2f, E2M, f2E, H2f, H2N, M2E, and N2H.
// These VCM methods expose the same anomaly conversions with SDS degree fields.
test("normalizes Basilisk VCM Keplerian anomaly conventions", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const ellipticalMean = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToTrueAnomaly(
      harness,
      encodeVcmKeplerianState({
        objectName: "BASILISK-ORBITAL-ANOMALY-ELLIPTIC-MEAN",
        semiMajorAxis: 1000.0,
        eccentricity: 0.1,
        anomalyType: vcmAnomalyConvention.MEAN_ANOMALY,
        anomaly: 3.471144674255927 * 180.0 / Math.PI,
      }),
    ),
  );
  let keplerian = ellipticalMean.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    3.413322139966247 * 180.0 / Math.PI,
    1e-10,
    "elliptic E2M plus E2f anomaly deg",
  );

  const ellipticalTrue = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToMeanAnomaly(
      harness,
      encodeVcmKeplerianState({
        objectName: "BASILISK-ORBITAL-ANOMALY-ELLIPTIC-TRUE",
        semiMajorAxis: 1000.0,
        eccentricity: 0.1,
        anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
        anomaly: 0.3 * 180.0 / Math.PI,
      }),
    ),
  );
  keplerian = ellipticalTrue.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.MEAN_ANOMALY);
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    (0.2717294863764543 - 0.1 * Math.sin(0.2717294863764543)) * 180.0 / Math.PI,
    1e-10,
    "elliptic f2E plus E2M anomaly deg",
  );

  const hyperbolicMean = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToTrueAnomaly(
      harness,
      encodeVcmKeplerianState({
        objectName: "BASILISK-ORBITAL-ANOMALY-HYPERBOLIC-MEAN",
        semiMajorAxis: -7500.0,
        eccentricity: 2.1,
        anomalyType: vcmAnomalyConvention.MEAN_ANOMALY,
        anomaly: 0.33949261623899946 * 180.0 / Math.PI,
      }),
    ),
  );
  keplerian = hyperbolicMean.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    0.4898441475256363 * 180.0 / Math.PI,
    1e-10,
    "hyperbolic H2N plus H2f anomaly deg",
  );

  const hyperbolicTrue = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToMeanAnomaly(
      harness,
      encodeVcmKeplerianState({
        objectName: "BASILISK-ORBITAL-ANOMALY-HYPERBOLIC-TRUE",
        semiMajorAxis: -7500.0,
        eccentricity: 2.1,
        anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
        anomaly: 0.3 * 180.0 / Math.PI,
      }),
    ),
  );
  keplerian = hyperbolicTrue.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.MEAN_ANOMALY);
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    (2.1 * Math.sinh(0.18054632550895094) - 0.18054632550895094) * 180.0 / Math.PI,
    1e-10,
    "hyperbolic f2H plus H2N anomaly deg",
  );
});

// Source orbit: Basilisk `src/architecture/utilities/tests/test_orbitalMotion.cpp`
// `TwoDimensionParabolic`, with closed-form Barker parabolic anomaly
// M = tan(f/2) + tan(f/2)^3 / 3. SDS VCM stores this M in the same degree-valued
// ANOMALY field used by elliptic and hyperbolic mean-anomaly conventions.
test("normalizes parabolic VCM Keplerian anomaly with Barker equation", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const parabolicTrueAnomalyRad = 123.0 * Math.PI / 180.0;
  const barkerParameter = Math.tan(parabolicTrueAnomalyRad / 2.0);
  const parabolicMeanAnomalyDegrees =
    (barkerParameter + (barkerParameter ** 3) / 3.0) * 180.0 / Math.PI;

  const meanNormalized = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToMeanAnomaly(
      harness,
      encodeVcmParabolicKeplerianState({
        objectName: "BASILISK-PARABOLIC-BARKER-TRUE",
        anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
        anomaly: 123.0,
      }),
    ),
  );
  let keplerian = meanNormalized.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.MEAN_ANOMALY);
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 0.0, 1e-12, "parabolic semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 1.0, 1e-15, "parabolic eccentricity");
  assertNear(keplerian.PERIAPSIS_RADIUS(), 7500.0, 1e-12, "parabolic periapsis radius km");
  assertAngleNearDegrees(
    keplerian.ANOMALY(),
    parabolicMeanAnomalyDegrees,
    1e-10,
    "parabolic Barker mean anomaly deg",
  );

  const trueNormalized = decodeVcmKeplerianResponse(
    await invokeVcmKeplerianToTrueAnomaly(
      harness,
      encodeVcmParabolicKeplerianState({
        objectName: "BASILISK-PARABOLIC-BARKER-MEAN",
        anomalyType: vcmAnomalyConvention.MEAN_ANOMALY,
        anomaly: parabolicMeanAnomalyDegrees,
      }),
    ),
  );
  keplerian = trueNormalized.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(keplerian.ANOMALY(), 123.0, 1e-10, "parabolic true anomaly deg");

  const stateFromMean = decodeVcmVectorResponse(
    await invokeVcmKeplerianToState(
      harness,
      encodeVcmParabolicKeplerianState({
        objectName: "BASILISK-PARABOLIC-BARKER-STATE",
        anomalyType: vcmAnomalyConvention.MEAN_ANOMALY,
        anomaly: parabolicMeanAnomalyDegrees,
      }),
    ),
  ).STATE_VECTOR();
  assert.notEqual(stateFromMean, null);
  assertNear(stateFromMean.X(), 27862.6148209797, 1e-9, "parabolic mean state position x km");
  assertNear(stateFromMean.Y(), 795.70270010667, 1e-9, "parabolic mean state position y km");
  assertNear(stateFromMean.Z(), -17554.0435142669, 1e-9, "parabolic mean state position z km");
  assertNear(stateFromMean.X_DOT(), 3.06499561197954, 1e-12, "parabolic mean velocity x km/s");
  assertNear(stateFromMean.Y_DOT(), 2.21344887266898, 1e-12, "parabolic mean velocity y km/s");
  assertNear(stateFromMean.Z_DOT(), -3.14760065404514, 1e-12, "parabolic mean velocity z km/s");
});

test("normalizes Basilisk parabolic VCM Keplerian elements to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const parabolicTrueAnomalyRad = 123.0 * Math.PI / 180.0;
  const barkerParameter = Math.tan(parabolicTrueAnomalyRad / 2.0);
  const parabolicMeanAnomalyDegrees =
    (barkerParameter + (barkerParameter ** 3) / 3.0) * 180.0 / Math.PI;

  const response = await invokeVcmKeplerianToOmm(
    harness,
    encodeVcmParabolicKeplerianState({
      objectName: "BASILISK-PARABOLIC-BARKER-OMM",
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 123.0,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-PARABOLIC-BARKER-OMM");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 0.0, 1e-12, "parabolic semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 1.0, 1e-15, "parabolic eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 40.0, 1e-12, "parabolic inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 133.0, 1e-12, "parabolic RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 113.0, 1e-12, "parabolic argument of pericenter deg");
  assertNear(omm.MEAN_ANOMALY(), parabolicMeanAnomalyDegrees, 1e-10, "parabolic Barker mean anomaly deg");
  assertNear(omm.MEAN_MOTION(), 0.0, 1e-15, "parabolic mean motion rev/day");
  assertNear(omm.GM(), 398600.436, 1e-12, "GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// classicElementsToMeanElements calls clMeanOscMap with sgn=1 (mean to
// osculating) and asserts the expected first-order J2-mapped orbital elements.

test("maps Basilisk VCM Keplerian mean elements to osculating elements with GRV J2 context", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianMeanToOsculating(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-J2-MEAN-REFERENCE",
      semiMajorAxis: 1000.0,
      eccentricity: 0.2,
      inclination: 0.2 * 180.0 / Math.PI,
      raan: 0.15 * 180.0 / Math.PI,
      argPericenter: 0.5 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.2 * 180.0 / Math.PI,
    }),
    encodeGrvJ2Context({
      equatorialRadius: 300.0,
      j2: 1e-3,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-J2-MEAN-REFERENCE");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 1000.07546442015950560744386166334152, 1e-10, "osculating semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 0.20017786852908628358882481279579, 1e-14, "osculating eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 0.20000333960738947425284095515963 * 180.0 / Math.PI, 1e-10, "osculating inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 0.15007256499303692209856819772540 * 180.0 / Math.PI, 1e-10, "osculating RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 0.50011857315729335571319325026707 * 180.0 / Math.PI, 1e-10, "osculating argument of pericenter deg");
  assertAngleNearDegrees(keplerian.ANOMALY(), 0.19982315726261962174348241205735 * 180.0 / Math.PI, 1e-10, "osculating true anomaly deg");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/orbitalMotion.c clMeanOscMap documents
// sgn=-1 as the osculating-to-mean branch. This uses the osculating vector
// asserted by classicElementsToMeanElements and checks recovery of the source
// mean vector to first-order inverse tolerance.

test("maps Basilisk VCM Keplerian osculating elements to mean elements with GRV J2 context", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmKeplerianOsculatingToMean(
    harness,
    encodeVcmKeplerianState({
      objectName: "BASILISK-J2-OSC-REFERENCE",
      semiMajorAxis: 1000.07546442015950560744386166334152,
      eccentricity: 0.20017786852908628358882481279579,
      inclination: 0.20000333960738947425284095515963 * 180.0 / Math.PI,
      raan: 0.15007256499303692209856819772540 * 180.0 / Math.PI,
      argPericenter: 0.50011857315729335571319325026707 * 180.0 / Math.PI,
      anomalyType: vcmAnomalyConvention.TRUE_ANOMALY,
      anomaly: 0.19982315726261962174348241205735 * 180.0 / Math.PI,
    }),
    encodeGrvJ2Context({
      equatorialRadius: 300.0,
      j2: 1e-3,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-J2-OSC-REFERENCE");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 1000.0, 2e-4, "mean semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 0.2, 1e-7, "mean eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 0.2 * 180.0 / Math.PI, 5e-6, "mean inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 0.15 * 180.0 / Math.PI, 5e-6, "mean RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 0.5 * 180.0 / Math.PI, 5e-6, "mean argument of pericenter deg");
  assertAngleNearDegrees(keplerian.ANOMALY(), 0.2 * 180.0 / Math.PI, 5e-6, "mean true anomaly deg");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// classicElementsToEquinoctialElements uses a=1000 km, e=0.2, i=0.2 rad,
// RAAN=0.15 rad, argPerigee=0.5 rad, true anomaly=0.2 rad. SDS VCM stores
// Keplerian angles in degrees; VCM equinoctial AF/AG/CHI/PSI are unitless and
// L is emitted as true longitude in degrees.

test("converts Basilisk VCM Keplerian elements to VCM equinoctial elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeKeplerianToEquinoctial(harness, encodeVcmKeplerianState());
  const vcm = decodeVcmResponse(response);
  const equinoctial = vcm.EQUINOCTIAL_ELEMENTS();
  assert.notEqual(equinoctial, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-EQUINOCTIAL-REFERENCE");
  assert.equal(vcm.CENTER_NAME(), "EARTH");
  assert.equal(vcm.REF_FRAME(), "EME2000");
  assert.equal(vcm.TIME_SYSTEM(), "UTC");
  assertNear(equinoctial.N(), 1000.0, 1e-12, "semi-major axis km");
  assertNear(equinoctial.AF(), 0.15921675970981119530023306651856, 1e-15, "AF");
  assertNear(equinoctial.AG(), 0.12103728114720790909331071816268, 1e-15, "AG");
  assertNear(equinoctial.CHI(), 0.01499382601880069713906618034116, 1e-15, "CHI");
  assertNear(equinoctial.PSI(), 0.09920802187229026125603326136115, 1e-15, "PSI");
  assertAngleNearDegrees(equinoctial.L(), 0.85000000000000008881784197001252 * 180.0 / Math.PI, 1e-12, "true longitude deg");
});

test("recovers Basilisk VCM equinoctial elements as VCM Keplerian true anomaly", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeEquinoctialToKeplerian(harness, encodeVcmEquinoctialState());
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-EQUINOCTIAL-REFERENCE");
  assert.equal(vcm.CENTER_NAME(), "EARTH");
  assert.equal(vcm.REF_FRAME(), "EME2000");
  assert.equal(vcm.TIME_SYSTEM(), "UTC");
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 1000.0, 1e-12, "semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 0.2, 1e-15, "eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 0.2 * 180.0 / Math.PI, 1e-12, "inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 0.15 * 180.0 / Math.PI, 1e-12, "RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 0.5 * 180.0 / Math.PI, 1e-12, "argument of pericenter deg");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(keplerian.ANOMALY(), 0.2 * 180.0 / Math.PI, 1e-12, "true anomaly deg");
});

test("normalizes Basilisk VCM equinoctial elements to SDS OMM mean elements", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmEquinoctialToOmm(harness, encodeVcmEquinoctialState());
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-EQUINOCTIAL-REFERENCE");
  assert.equal(omm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(omm.CENTER_NAME(), "EARTH");
  assert.equal(omm.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 1000.0, 1e-12, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.2, 1e-15, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 0.2 * 180.0 / Math.PI, 1e-12, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.15 * 180.0 / Math.PI, 1e-12, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.5 * 180.0 / Math.PI, 1e-12, "argument of pericenter deg");
  assertAngleNearDegrees(
    omm.MEAN_ANOMALY(),
    ellipticMeanAnomalyDegreesFromTrueAnomaly(0.2, 0.2 * 180.0 / Math.PI),
    1e-12,
    "mean anomaly deg",
  );
  assertNear(omm.GM(), 398600.436, 1e-12, "GM km^3/s^2");
});

test("converts Basilisk VCM equinoctial elements to SDS OEM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const inclination = 40.0 * Math.PI / 180.0;
  const raan = 133.0 * Math.PI / 180.0;
  const argPericenter = 113.0 * Math.PI / 180.0;
  const trueAnomaly = 123.0 * Math.PI / 180.0;
  const nodePericenterSum = raan + argPericenter;
  const response = await invokeVcmEquinoctialToOem(
    harness,
    encodeVcmEquinoctialState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      semiMajorAxis: 7500.0,
      af: 0.5 * Math.cos(nodePericenterSum),
      ag: 0.5 * Math.sin(nodePericenterSum),
      trueLongitude: (nodePericenterSum + trueAnomaly) * 180.0 / Math.PI,
      chi: Math.tan(inclination / 2.0) * Math.sin(raan),
      psi: Math.tan(inclination / 2.0) * Math.cos(raan),
      gm: 398600.436,
    }),
  );
  const oem = decodeOemResponse(response);
  const block = oem.EPHEMERIS_DATA_BLOCK(0);
  assert.equal(block.CENTER_NAME(), "EARTH");
  assert.equal(block.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(block.START_TIME(), "2000-04-01T00:00:00.000Z");
  const line = block.EPHEMERIS_DATA_LINES(0);
  assert.equal(line.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(line.X(), 6538.3506963942027, 1e-9, "VCM equinoctial position x km");
  assertNear(line.Y(), 186.7227227879431, 1e-9, "VCM equinoctial position y km");
  assertNear(line.Z(), -4119.3008399778619, 1e-9, "VCM equinoctial position z km");
  assertNear(line.X_DOT(), 1.4414106130924005, 1e-12, "VCM equinoctial velocity x km/s");
  assertNear(line.Y_DOT(), 5.588901415902356, 1e-12, "VCM equinoctial velocity y km/s");
  assertNear(line.Z_DOT(), -4.0828931566657038, 1e-12, "VCM equinoctial velocity z km/s");
});

test("converts Basilisk VCM equinoctial elements to VCM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const inclination = 40.0 * Math.PI / 180.0;
  const raan = 133.0 * Math.PI / 180.0;
  const argPericenter = 113.0 * Math.PI / 180.0;
  const trueAnomaly = 123.0 * Math.PI / 180.0;
  const nodePericenterSum = raan + argPericenter;
  const response = await invokeVcmEquinoctialToState(
    harness,
    encodeVcmEquinoctialState({
      objectName: "BASILISK-TWO-DIMENSION-ELLIPTICAL",
      af: 0.5 * Math.cos(nodePericenterSum),
      ag: 0.5 * Math.sin(nodePericenterSum),
      trueLongitude: (nodePericenterSum + trueAnomaly) * 180.0 / Math.PI,
      semiMajorAxis: 7500.0,
      chi: Math.tan(inclination / 2.0) * Math.sin(raan),
      psi: Math.tan(inclination / 2.0) * Math.cos(raan),
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmVectorResponse(response);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-TWO-DIMENSION-ELLIPTICAL");
  assert.equal(vcm.OBJECT_ID(), "BASILISK-ORBITAL-MOTION");
  assert.equal(state.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(state.X(), 6538.3506963942027, 1e-9, "VCM equinoctial state position x km");
  assertNear(state.Y(), 186.7227227879431, 1e-9, "VCM equinoctial state position y km");
  assertNear(state.Z(), -4119.3008399778619, 1e-9, "VCM equinoctial state position z km");
  assertNear(state.X_DOT(), 1.4414106130924005, 1e-12, "VCM equinoctial state velocity x km/s");
  assertNear(state.Y_DOT(), 5.588901415902356, 1e-12, "VCM equinoctial state velocity y km/s");
  assertNear(state.Z_DOT(), -4.0828931566657038, 1e-12, "VCM equinoctial state velocity z km/s");
  assertNear(vcm.GM(), 398600.436, 1e-12, "VCM state GM km^3/s^2");
});

// Authoritative numerical source:
// Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
// CircularInclined uses a=7500 km, e=0, i=40 deg, RAAN=133 deg,
// argPerigee=113 deg, true anomaly=123 deg, and MU_EARTH. In circular
// equinoctial input, AF/AG are zero and L carries true longitude; the inverse
// normalizes undefined argument of pericenter to zero and recovers argument of
// latitude as the Keplerian anomaly.

test("recovers circular inclined VCM equinoctial elements as Keplerian argument of latitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const inclination = 40.0 * Math.PI / 180.0;
  const raan = 133.0 * Math.PI / 180.0;
  const response = await invokeEquinoctialToKeplerian(
    harness,
    encodeVcmEquinoctialState({
      objectName: "BASILISK-CIRCULAR-INCLINED",
      objectId: "BASILISK-ORBITAL-MOTION",
      af: 0.0,
      ag: 0.0,
      trueLongitude: 9.0,
      semiMajorAxis: 7500.0,
      chi: Math.tan(inclination / 2.0) * Math.sin(raan),
      psi: Math.tan(inclination / 2.0) * Math.cos(raan),
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmKeplerianResponse(response);
  const keplerian = vcm.KEPLERIAN_ELEMENTS();
  assert.notEqual(keplerian, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-CIRCULAR-INCLINED");
  assertNear(keplerian.SEMI_MAJOR_AXIS(), 7500.0, 1e-12, "semi-major axis km");
  assertNear(keplerian.ECCENTRICITY(), 0.0, 1e-15, "eccentricity");
  assertAngleNearDegrees(keplerian.INCLINATION(), 40.0, 1e-12, "inclination deg");
  assertAngleNearDegrees(keplerian.RA_OF_ASC_NODE(), 133.0, 1e-12, "RAAN deg");
  assertAngleNearDegrees(keplerian.ARG_OF_PERICENTER(), 0.0, 1e-12, "argument of pericenter deg");
  assert.equal(keplerian.ANOMALY_TYPE(), vcmAnomalyConvention.TRUE_ANOMALY);
  assertAngleNearDegrees(keplerian.ANOMALY(), 236.0, 1e-12, "argument of latitude deg");
});

test("converts circular inclined VCM equinoctial elements to VCM state vector", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const inclination = 40.0 * Math.PI / 180.0;
  const raan = 133.0 * Math.PI / 180.0;
  const response = await invokeVcmEquinoctialToState(
    harness,
    encodeVcmEquinoctialState({
      objectName: "BASILISK-CIRCULAR-INCLINED",
      objectId: "BASILISK-ORBITAL-MOTION",
      af: 0.0,
      ag: 0.0,
      trueLongitude: 9.0,
      semiMajorAxis: 7500.0,
      chi: Math.tan(inclination / 2.0) * Math.sin(raan),
      psi: Math.tan(inclination / 2.0) * Math.cos(raan),
      gm: 398600.436,
    }),
  );
  const vcm = decodeVcmVectorResponse(response);
  const state = vcm.STATE_VECTOR();
  assert.notEqual(state, null);
  assert.equal(vcm.OBJECT_NAME(), "BASILISK-CIRCULAR-INCLINED");
  assert.equal(state.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(state.X(), 6343.7735859429586, 1e-9, "circular equinoctial state position x km");
  assertNear(state.Y(), 181.16597468085499, 1e-9, "circular equinoctial state position y km");
  assertNear(state.Z(), -3996.7130970223939, 1e-9, "circular equinoctial state position z km");
  assertNear(state.X_DOT(), -1.8379619466304487, 1e-12, "circular equinoctial state velocity x km/s");
  assertNear(state.Y_DOT(), 6.5499717954886121, 1e-12, "circular equinoctial state velocity y km/s");
  assertNear(state.Z_DOT(), -2.6203988553352131, 1e-12, "circular equinoctial state velocity z km/s");
});

test("normalizes circular equatorial VCM equinoctial elements to SDS OMM true longitude", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeVcmEquinoctialToOmm(
    harness,
    encodeVcmEquinoctialState({
      objectName: "BASILISK-CIRCULAR-EQUATORIAL",
      objectId: "BASILISK-ORBITAL-MOTION",
      af: 0.0,
      ag: 0.0,
      trueLongitude: 9.0,
      semiMajorAxis: 7500.0,
      chi: 0.0,
      psi: 0.0,
      gm: 398600.436,
    }),
  );
  const omm = decodeOmmResponse(response);
  assert.equal(omm.OBJECT_NAME(), "BASILISK-CIRCULAR-EQUATORIAL");
  assert.equal(omm.EPOCH(), "2000-04-01T00:00:00.000Z");
  assertNear(omm.SEMI_MAJOR_AXIS(), 7500.0, 1e-12, "semi-major axis km");
  assertNear(omm.ECCENTRICITY(), 0.0, 1e-15, "eccentricity");
  assertAngleNearDegrees(omm.INCLINATION(), 0.0, 1e-12, "inclination deg");
  assertAngleNearDegrees(omm.RA_OF_ASC_NODE(), 0.0, 1e-12, "RAAN deg");
  assertAngleNearDegrees(omm.ARG_OF_PERICENTER(), 0.0, 1e-12, "argument of pericenter deg");
  assertAngleNearDegrees(omm.MEAN_ANOMALY(), 9.0, 1e-12, "true longitude deg");
  assertNear(omm.GM(), 398600.436, 1e-12, "GM km^3/s^2");
});
