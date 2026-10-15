// compute_covariance end to end on the built artifact: the legacy JSON cases (tests/legacy-cases.json) as $SBC requests,
// every number checked against what the legacy JSON artifact (0.1.0) answered on the same case
// (tests/legacy-reference.json, its %.12g text) and, where the arithmetic is closed-form, bit for bit.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { SBC_CONTRIBUTOR, encode, flatbuffers, loadBindings, readSbcDiagnostics } from "./sds.mjs";

const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const LEGACY = JSON.parse(fs.readFileSync(new URL("./legacy-reference.json", import.meta.url), "utf8"));
const { OCM } = await loadBindings("OCM");
const SBC_TYPE = { schemaName: "SBC.fbs", fileIdentifier: "$SBC", rootTypeName: "SBC", wireFormat: "flatbuffer" };

const ORBIT_FRAMES = new Set(["RSW_ROTATING", "RSW_INERTIAL", "NTW_ROTATING", "NTW_INERTIAL", "LVLH_ROTATING", "LVLH_INERTIAL"]);
const frameOf = (name) => (ORBIT_FRAMES.has(name)
  ? { REFERENCE_FRAME_type: "OrbitFrameWrapper", REFERENCE_FRAME: { frame: name } }
  : { NAME: name });

// The legacy request as the typed one: the per-axis sigma form is the diagonal $OCM covariance (the legacy module's own
// (sigma / 1000)**2 and (sigma * 1e-6)**2), the TLE series $OMM records, the biases SBCBiasTerm (measurement biases
// already taken onto RTN, MeasurementAsRtn).
function typedRequest(legacy) {
  const request = { OBJECT_ID: legacy.objectId, EPOCH: legacy.epoch };
  const direct = legacy.directCovariance;
  if (direct) {
    let data = direct.lowerTriangular;
    if (!data || data.length !== 21) {
      const p = direct.positionSigmaM ?? {};
      const v = direct.velocitySigmaMmps ?? {};
      const d = [(p.radial ?? 0) / 1000, (p.inTrack ?? 0) / 1000, (p.crossTrack ?? 0) / 1000,
        (v.radial ?? 0) * 1e-6, (v.inTrack ?? 0) * 1e-6, (v.crossTrack ?? 0) * 1e-6].map((x) => x ** 2);
      data = [];
      for (let row = 0; row < 6; row += 1) for (let col = 0; col <= row; col += 1) data.push(row === col ? d[row] : 0);
    }
    request.DIRECT_COVARIANCE = { COVARIANCE_DATA: data, COV_ORDERING: "LTM", COV_SIZE: 6, COV_REF_FRAME: frameOf(direct.frame ?? "RTN") };
  }
  if (legacy.tleSeries) {
    request.ELEMENT_SET_SERIES = legacy.tleSeries.map((s) => ({ OBJECT_ID: legacy.objectId, SEMI_MAJOR_AXIS: s.semiMajorAxisKm,
      INCLINATION: s.inclinationDeg, RA_OF_ASC_NODE: s.raanDeg, MEAN_ANOMALY: s.meanAnomalyDeg }));
  }
  if (legacy.sensorBiases) {
    request.SENSOR_BIASES = legacy.sensorBiases.map((b) => {
      const rtn = b.radialBiasM !== undefined || b.inTrackBiasM !== undefined || b.crossTrackBiasM !== undefined;
      return { SENSOR_ID: b.id ?? "", BASIS: rtn ? "OrbitRtn" : "MeasurementAsRtn",
        RADIAL_M: b.radialBiasM ?? b.rangeBiasM ?? 0, IN_TRACK_M: b.inTrackBiasM ?? b.azimuthBiasM ?? 0,
        CROSS_TRACK_M: b.crossTrackBiasM ?? b.elevationBiasM ?? 0 };
    });
  }
  return encode("SBC", { REQUEST: request });
}

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}
const invoke = (harness, payload) => harness.invoke({ methodId: "compute_covariance", inputs: payload ? [{ portId: "covariance", typeRef: SBC_TYPE, payload }] : [] });

function outputsOf(result) {
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.deepEqual(result.outputs.map((o) => o.portId).sort(), ["covariance", "diagnostics"]);
  const ocmFrame = result.outputs.find((o) => o.portId === "covariance");
  const bb = new flatbuffers.ByteBuffer(ocmFrame.payload);
  assert.ok(OCM.bufferHasIdentifier(bb), "covariance is an $OCM");
  const ocm = OCM.getRootAsOCM(bb);
  const diag = readSbcDiagnostics(result.outputs.find((o) => o.portId === "diagnostics").payload);
  assert.ok(diag, "diagnostics is an $SBC with its DIAGNOSTICS arm");
  return { ocm, diag, covariance: Array.from({ length: ocm.covarianceDataLength() }, (_, k) => ocm.COVARIANCE_DATA(k)) };
}

// The legacy JSON printed %.12g: the typed double, printed the same way, is the legacy number.
const legacyText = (x) => Number(x.toPrecision(12));
const sameAsLegacy = (actual, expected, what) => {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((x, k) => assert.equal(legacyText(x), expected[k], `${what}[${k}]: ${x} versus legacy ${expected[k]}`));
};
const CONTRIBUTOR_NAMES = { direct_covariance: SBC_CONTRIBUTOR.DirectCovariance, tle_series_synthetic_mean: SBC_CONTRIBUTOR.ElementSetSeries,
  sensor_biases: SBC_CONTRIBUTOR.SensorBias };

for (const { name, request, legacy } of LEGACY) {
  test(`${name}: the typed $OCM and $SBC carry the legacy artifact's numbers`, async (t) => {
    const { ocm, diag, covariance } = outputsOf(await invoke(await harnessFor(t), typedRequest(request)));
    sameAsLegacy(covariance, legacy.covariance6x6LowerTriangular, "OCM COVARIANCE_DATA");
    assert.deepEqual(diag.COVARIANCE_LOWER_TRIANGLE, covariance, "the $SBC carries the $OCM's values, bit for bit");
    sameAsLegacy(diag.POSITION_COVARIANCE_KM2, legacy.positionCovarianceKm2, "POSITION_COVARIANCE_KM2");
    const s = legacy.positionSigmaM;
    sameAsLegacy(diag.POSITION_SIGMA_RTN_M, [s.radial, s.inTrack, s.crossTrack], "POSITION_SIGMA_RTN_M");
    // Legacy mm/s, typed m/s (the standard's unit).
    sameAsLegacy(diag.VELOCITY_SIGMA_RTN_M_S.map((v) => v * 1000), [s.radialVelocityMmps, s.inTrackVelocityMmps, s.crossTrackVelocityMmps], "VELOCITY_SIGMA_RTN_M_S");
    sameAsLegacy(diag.ELLIPSOID_SEMI_AXES_M, legacy.ellipsoid.semiAxesM, "ELLIPSOID_SEMI_AXES_M");
    assert.equal(diag.ELLIPSOID_SIGMA_LEVEL, legacy.ellipsoid.sigmaLevel);
    assert.deepEqual(diag.CONTRIBUTORS, legacy.inputContributors.map((c) => CONTRIBUTOR_NAMES[c]));
    const series = diag.CONTRIBUTIONS.find((c) => c.KIND === SBC_CONTRIBUTOR.ElementSetSeries);
    assert.equal(series.COUNT, legacy.tleSeries.sampleCount);
    sameAsLegacy([series.RADIAL_VARIANCE_M2, series.IN_TRACK_VARIANCE_M2, series.CROSS_TRACK_VARIANCE_M2],
      [legacy.tleSeries.radialVarianceM2, legacy.tleSeries.inTrackVarianceM2, legacy.tleSeries.crossTrackVarianceM2], "series variances");
    const bias = diag.CONTRIBUTIONS.find((c) => c.KIND === SBC_CONTRIBUTOR.SensorBias && c.SENSOR_ID === "");
    assert.equal(bias.COUNT, legacy.sensorBiases.count);
    sameAsLegacy([bias.RADIAL_VARIANCE_M2, bias.IN_TRACK_VARIANCE_M2, bias.CROSS_TRACK_VARIANCE_M2],
      [legacy.sensorBiases.radialVarianceM2, legacy.sensorBiases.inTrackVarianceM2, legacy.sensorBiases.crossTrackVarianceM2], "bias variances");
    const perSensor = diag.CONTRIBUTIONS.filter((c) => c.KIND === SBC_CONTRIBUTOR.SensorBias && c.SENSOR_ID !== "");
    assert.equal(perSensor.length, (request.sensorBiases ?? []).filter((b) => b.id).length);
    assert.equal(diag.OBJECT_ID, legacy.objectId);
    assert.equal(diag.EPOCH, legacy.epoch);
    assert.equal(diag.REFERENCE_FRAME, legacy.referenceFrame);
    assert.equal(diag.PROVIDER, legacy.provider);
    assert.equal(diag.STATUS, legacy.status);
    assert.deepEqual(diag.ASSUMPTIONS, legacy.assumptions);
    assert.equal(ocm.METADATA().OBJECT_DESIGNATOR(), legacy.objectId);
    assert.equal(ocm.METADATA().EPOCH_TZERO(), legacy.epoch);
    assert.equal(ocm.COV_SIZE(), 6);
    assert.equal(ocm.stateEpochsLength(), 1);
  });
}

test("independent RTN uncertainties: the variance sum, bit for bit", async (t) => {
  // Var(X + Y) = Var(X) + Var(Y): 3²+4², 4²+3², 12²+5² m²; velocity 2², 3², 6² (mm/s)². The module adds the bias
  // variance (m², times 1e-6) to the direct diagonal, in that order.
  const { covariance, diag } = outputsOf(await invoke(await harnessFor(t), typedRequest(LEGACY[0].request)));
  const d = [(3 / 1000) ** 2 + 4 * 4 * 1e-6, (4 / 1000) ** 2 + 3 * 3 * 1e-6, (12 / 1000) ** 2 + 5 * 5 * 1e-6, (2e-6) ** 2, (3e-6) ** 2, (6e-6) ** 2];
  const expected = [];
  for (let row = 0; row < 6; row += 1) for (let col = 0; col <= row; col += 1) expected.push(row === col ? d[row] : 0);
  assert.deepEqual(covariance, expected);
  assert.deepEqual(diag.ELLIPSOID_SEMI_AXES_M, [Math.sqrt(d[2]) * 1000, Math.sqrt(d[0]) * 1000, Math.sqrt(d[1]) * 1000].sort((a, b) => b - a));
});

test("the direct covariance's frame is carried to the $OCM's COV_REF_FRAME", async (t) => {
  const { ocm, diag } = outputsOf(await invoke(await harnessFor(t), typedRequest(LEGACY[2].request)));
  const frame = ocm.COV_REF_FRAME();
  assert.ok(frame && frame.REFERENCE_FRAME_type() !== 0, "the RFM union is copied");
  assert.equal(diag.REFERENCE_FRAME, "RSW_ROTATING");
});

test("refusals: no request, an $SBC without its REQUEST arm, a direct covariance short of 21 values", async (t) => {
  const harness = await harnessFor(t);
  const none = await invoke(harness, null);
  assert.notEqual(none.statusCode, 0);
  assert.equal(none.errorCode, "missing-required-input", "the SDK runtime refuses the required port before the method runs");
  const noArm = await invoke(harness, encode("SBC", { DIAGNOSTICS: { OBJECT_ID: "X" } }));
  assert.equal(noArm.errorCode, "invalid-covariance");
  const short = await invoke(harness, encode("SBC", { REQUEST: { OBJECT_ID: "X", DIRECT_COVARIANCE: { COVARIANCE_DATA: [1, 0, 1] } } }));
  assert.equal(short.errorCode, "invalid-covariance");
  assert.equal(short.outputs.length, 0);
});
