import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`covariance module combines direct, TLE-series, and sensor-bias inputs on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(
      harness,
      {
        objectId: "CREW-DRAGON-COVARIANCE",
        epoch: "2024-03-03T04:53:00Z",
        directCovariance: {
          frame: "RTN",
          positionSigmaM: {
            radial: 30,
            inTrack: 90,
            crossTrack: 15
          },
          velocitySigmaMmps: {
            radial: 2,
            inTrack: 4,
            crossTrack: 1
          }
        },
        tleSeries: [
          {
            epochSeconds: 0,
            semiMajorAxisKm: 6780.00,
            inclinationDeg: 51.640,
            raanDeg: 42.100,
            meanAnomalyDeg: 4.0
          },
          {
            epochSeconds: 5400,
            semiMajorAxisKm: 6780.03,
            inclinationDeg: 51.642,
            raanDeg: 42.102,
            meanAnomalyDeg: 4.4
          },
          {
            epochSeconds: 10800,
            semiMajorAxisKm: 6779.97,
            inclinationDeg: 51.638,
            raanDeg: 42.098,
            meanAnomalyDeg: 3.7
          }
        ],
        sensorBiases: [
          {
            id: "radar-range",
            radialBiasM: 18,
            inTrackBiasM: 8,
            crossTrackBiasM: 6
          },
          {
            id: "angles-only",
            radialBiasM: 5,
            inTrackBiasM: 22,
            crossTrackBiasM: 12
          }
        ]
      },
      {
        methodId: "compute_covariance",
        inputPortId: "covariance",
        outputPortId: "covariance",
      },
    );

    assert.equal(result.provider, "covariance-analysis");
    assert.equal(result.objectId, "CREW-DRAGON-COVARIANCE");
    assert.equal(result.referenceFrame, "RTN");
    assert.deepEqual(result.inputContributors, [
      "direct_covariance",
      "tle_series_synthetic_mean",
      "sensor_biases",
    ]);
    assert.equal(result.covariance6x6LowerTriangular.length, 21);
    assert.equal(result.positionCovarianceKm2.length, 9);
    assert.ok(result.positionSigmaM.radial > 30);
    assert.ok(result.positionSigmaM.inTrack > 90);
    assert.ok(result.positionSigmaM.crossTrack > 15);
    assert.equal(result.ellipsoid.semiAxesM.length, 3);
    assert.ok(result.ellipsoid.semiAxesM[0] >= result.ellipsoid.semiAxesM[1]);
    assert.ok(result.tleSeries.sampleCount === 3);
    assert.ok(result.sensorBiases.count === 2);
  });
}
