import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// The artifact is wasi-sequential on the sanctioned wasm32-wasip1-threads
// triple, which implies the atomics feature, so wasm-ld declares its own
// memory shared (limits flags 0x03) even though the guest never spawns a
// thread. The WasmEdge CLI only parses a shared memory with the threads
// proposal enabled; --enable-threads adds no wasi thread-spawn host function.
// The browser leg ignores this option.
const HARNESS_OPTIONS = Object.freeze({ enableThreads: true });

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`independent RTN uncertainties obey the closed-form variance sum on ${runtimeKind}`, async (t) => {
    // Source: Var(X + Y) = Var(X) + Var(Y) for independent zero-mean errors.
    // Independently calculated Pythagorean cases: 3²+4²=25, 4²+3²=25,
    // 12²+5²=169 m²; velocity variances are 2², 3², 6² (mm/s)².
    // Frame: RTN. Epoch: 2024-03-03T04:53:00 UTC; no time propagation.
    // Output units: km² and (km/s)². Relative tolerance 1e-11 allows the
    // documented 12-significant-digit JSON serialization; zeros stay exact.
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, HARNESS_OPTIONS);
    if (!harness) return;
    t.after(() => harness.destroy());
    const result = await invokeJsonRequest(harness, {
      objectId: "INDEPENDENT-RTN-ERRORS",
      epoch: "2024-03-03T04:53:00Z",
      directCovariance: {
        frame: "RTN",
        positionSigmaM: { radial: 3, inTrack: 4, crossTrack: 12 },
        velocitySigmaMmps: { radial: 2, inTrack: 3, crossTrack: 6 },
      },
      sensorBiases: [{ radialBiasM: 4, inTrackBiasM: 3, crossTrackBiasM: 5 }],
    }, { methodId: "compute_covariance", inputPortId: "covariance", outputPortId: "covariance" });
    const expected = [25e-6, 0, 25e-6, 0, 0, 169e-6, 0, 0, 0, 4e-12,
      0, 0, 0, 0, 9e-12, 0, 0, 0, 0, 0, 36e-12];
    assert.equal(result.covariance6x6LowerTriangular.length, expected.length);
    expected.forEach((value, index) => {
      const actual = result.covariance6x6LowerTriangular[index];
      if (value === 0) assert.equal(actual, 0);
      else assert.ok(Math.abs(actual - value) <= Math.abs(value) * 1e-11,
        `covariance[${index}]: ${actual} versus ${value}`);
    });
    assert.deepEqual(result.ellipsoid.semiAxesM, [13, 5, 5]);
    assert.equal(result.referenceFrame, "RTN");
    assert.equal(result.epoch, "2024-03-03T04:53:00Z");
  });

  test(`covariance module combines direct, TLE-series, and sensor-bias inputs on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, HARNESS_OPTIONS);
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
