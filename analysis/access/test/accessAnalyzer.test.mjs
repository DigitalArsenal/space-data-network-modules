import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createAccessAnalyzer } from "../index.js";

const EARTH_RADIUS_METERS = 6378137.0;
const ORBIT_RADIUS_METERS = EARTH_RADIUS_METERS + 500000.0;
const SAMPLE_STEP_SECONDS = 60.0;
const SAMPLE_STEP_DAYS = SAMPLE_STEP_SECONDS / 86400.0;
const ACCESS_GEOMETRY_ANGLE_TOLERANCE = 1.0e-10;
const ACCESS_GEOMETRY_RANGE_RELATIVE_TOLERANCE = 1.0e-10;
const OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA = 101000.0;
const OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K = 283.0;
const OREKIT_STANDARD_REFRACTION_MIN_ELEVATION_DEG = -2.0;
const OREKIT_STANDARD_REFRACTION_MAX_ELEVATION_DEG = 89.89;

function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
}

function radiansToDegrees(value) {
  return (value * 180.0) / Math.PI;
}

function orekitStandardAtmosphereRefractionRad(
  trueElevationRad,
  pressurePa = OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA,
  temperatureK = OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K,
) {
  const trueElevationDeg = radiansToDegrees(trueElevationRad);
  if (
    trueElevationDeg <= OREKIT_STANDARD_REFRACTION_MIN_ELEVATION_DEG ||
    trueElevationDeg >= OREKIT_STANDARD_REFRACTION_MAX_ELEVATION_DEG
  ) {
    return 0.0;
  }

  const refractionArgumentDeg =
    trueElevationDeg + 10.3 / (trueElevationDeg + 5.11);
  const refractionDeg =
    1.02 / Math.tan(degreesToRadians(refractionArgumentDeg)) / 60.0;
  const correctionFactor =
    (pressurePa / OREKIT_STANDARD_REFRACTION_DEFAULT_PRESSURE_PA) *
    (OREKIT_STANDARD_REFRACTION_DEFAULT_TEMPERATURE_K / temperatureK);
  return degreesToRadians(correctionFactor * refractionDeg);
}

function interpolateCrossingSeconds(previousSeconds, previousValue, currentSeconds, currentValue) {
  const delta = currentValue - previousValue;
  if (Math.abs(delta) < 1.0e-12) {
    return previousSeconds;
  }
  const fraction = Math.max(0.0, Math.min(1.0, -previousValue / delta));
  return previousSeconds + (currentSeconds - previousSeconds) * fraction;
}

function topocentricToEquatorialEcef(azimuthRad, elevationRad, rangeM) {
  const east = Math.sin(azimuthRad) * Math.cos(elevationRad) * rangeM;
  const north = Math.cos(azimuthRad) * Math.cos(elevationRad) * rangeM;
  const up = Math.sin(elevationRad) * rangeM;
  return {
    x: EARTH_RADIUS_METERS + up,
    y: east,
    z: north,
  };
}

function createEquatorialState(theta, julianDate) {
  return {
    julianDate,
    position: {
      x: ORBIT_RADIUS_METERS * Math.cos(theta),
      y: ORBIT_RADIUS_METERS * Math.sin(theta),
      z: 0.0,
    },
    velocity: {
      x: 0.0,
      y: 0.0,
      z: 0.0,
    },
  };
}

function createTopocentricState(azimuthRad, elevationRad, rangeM, julianDate) {
  return {
    julianDate,
    position: topocentricToEquatorialEcef(azimuthRad, elevationRad, rangeM),
    velocity: {
      x: 0.0,
      y: 0.0,
      z: 0.0,
    },
  };
}

function createTopocentricStateAtAltitude(
  azimuthRad,
  elevationRad,
  rangeM,
  julianDate,
  stationAltitudeM,
) {
  const state = createTopocentricState(
    azimuthRad,
    elevationRad,
    rangeM,
    julianDate,
  );
  return {
    ...state,
    position: {
      ...state.position,
      x: state.position.x + stationAltitudeM,
    },
  };
}

test("Access analyzer loads a compiled WASM runtime and stores ground stations natively", async () => {
  const wasmBytes = await readFile(new URL("../dist/access.wasm", import.meta.url));
  assert.deepEqual(Array.from(wasmBytes.subarray(0, 4)), [0, 97, 115, 109]);

  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    assert.equal(analyzer.module.runtime, "access-wasm");
    assert.equal(typeof analyzer.module._access_add_ground_station, "function");
    assert.equal(
      typeof analyzer.module._access_compute_access_windows,
      "function",
    );
    assert.equal(
      typeof analyzer.module._access_compute_access_windows_with_elevation_mask,
      "function",
    );
    assert.equal(
      typeof analyzer.module._access_compute_access_windows_with_effects,
      "function",
    );

    const stationId = analyzer.addGroundStation({
      id: "equator-west",
      name: "Equator West",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      channelCapacity: 2,
      blackoutWindows: [
        {
          startJulianDate: 2460400.6,
          endJulianDate: 2460400.7,
        },
      ],
      minElevationDeg: 10.0,
    });

    assert.equal(stationId, "equator-west");
    assert.deepEqual(analyzer.listGroundStations(), [
      {
        id: "equator-west",
        name: "Equator West",
        latitudeRad: 0.0,
        longitudeRad: 0.0,
        altitudeM: 0.0,
        channelCapacity: 2,
        blackoutWindows: [
          {
            startJulianDate: 2460400.6,
            endJulianDate: 2460400.7,
          },
        ],
        minElevationRad: degreesToRadians(10.0),
      },
    ]);
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer matches Orekit TopocentricFrame inverse azimuth/elevation/range vectors", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "orekit-topocentric-origin",
      name: "Orekit Topocentric Origin",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
    });

    const vectors = [
      { azimuthRad: 0.0, elevationRad: 0.0, rangeM: 1.0 },
      { azimuthRad: 0.0, elevationRad: Math.PI / 2.0, rangeM: 1.0 },
      { azimuthRad: Math.PI, elevationRad: Math.PI / 3.0, rangeM: 10.0 },
      {
        azimuthRad: (3.0 * Math.PI) / 2.0,
        elevationRad: Math.PI / 4.0,
        rangeM: 1000.0,
      },
      {
        azimuthRad: Math.PI / 2.0,
        elevationRad: -Math.PI / 6.0,
        rangeM: 500.0,
      },
      {
        azimuthRad: Math.PI / 7.0,
        elevationRad: -Math.PI / 5.0,
        rangeM: 100.0,
      },
    ];

    for (const vector of vectors) {
      const geometry = analyzer.computeAccessGeometry(
        {
          julianDate: 2460400.5,
          position: topocentricToEquatorialEcef(
            vector.azimuthRad,
            vector.elevationRad,
            vector.rangeM,
          ),
        },
        "orekit-topocentric-origin",
      );

      assert.ok(
        Math.abs(geometry.azimuthRad - vector.azimuthRad) <
          ACCESS_GEOMETRY_ANGLE_TOLERANCE,
        `azimuth ${geometry.azimuthRad} should match ${vector.azimuthRad}`,
      );
      assert.ok(
        Math.abs(geometry.elevationRad - vector.elevationRad) <
          ACCESS_GEOMETRY_ANGLE_TOLERANCE,
        `elevation ${geometry.elevationRad} should match ${vector.elevationRad}`,
      );
      assert.ok(
        Math.abs(geometry.rangeM - vector.rangeM) <
          ACCESS_GEOMETRY_RANGE_RELATIVE_TOLERANCE *
            Math.max(1.0, vector.rangeM),
        `range ${geometry.rangeM} should match ${vector.rangeM}`,
      );
    }
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer applies Orekit ElevationMask interpolation for azimuth-dependent visibility", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "orekit-mask-origin",
      name: "Orekit Mask Origin",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 0.0,
    });

    const startJulianDate = 2460400.5;
    const stepDays = 60.0 / 86400.0;
    const azimuthRad = degreesToRadians(45.0);
    const states = [
      createTopocentricState(
        azimuthRad,
        degreesToRadians(3.0),
        1000000.0,
        startJulianDate,
      ),
      createTopocentricState(
        azimuthRad,
        degreesToRadians(3.6),
        1000000.0,
        startJulianDate + stepDays,
      ),
      createTopocentricState(
        azimuthRad,
        degreesToRadians(4.0),
        1000000.0,
        startJulianDate + stepDays * 2.0,
      ),
      createTopocentricState(
        azimuthRad,
        degreesToRadians(3.0),
        1000000.0,
        startJulianDate + stepDays * 3.0,
      ),
    ];

    const orekitEventMaskDeg = [
      [0.0, 5.0],
      [30.0, 4.0],
      [60.0, 3.0],
      [90.0, 2.0],
      [120.0, 3.0],
      [150.0, 4.0],
      [180.0, 5.0],
      [210.0, 6.0],
      [240.0, 5.0],
      [270.0, 4.0],
      [300.0, 3.0],
      [330.0, 4.0],
    ];
    const windows = analyzer.computeAccessWindows(
      states,
      "orekit-mask-origin",
      {
        elevationMaskDeg: orekitEventMaskDeg,
      },
    );

    assert.equal(windows.length, 1);
    assert.equal(windows[0].stationId, "orekit-mask-origin");
    assert.ok(
      Math.abs(
        (windows[0].startJulianDate - startJulianDate) * 86400.0 - 50.0,
      ) < 1.0e-3,
      `masked AOS should occur 50 seconds after start, got ${windows[0].startJulianDate}`,
    );
    assert.ok(
      Math.abs(
        (windows[0].endJulianDate - startJulianDate) * 86400.0 - 150.0,
      ) < 1.0e-3,
      `masked LOS should occur 150 seconds after start, got ${windows[0].endJulianDate}`,
    );
    assert.ok(
      Math.abs(windows[0].maxElevationRad - degreesToRadians(4.0)) <
        ACCESS_GEOMETRY_ANGLE_TOLERANCE,
      `max elevation ${windows[0].maxElevationRad} should match 4 degrees`,
    );
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer applies Orekit EarthStandardAtmosphereRefraction to elevation switching", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "orekit-refraction-origin",
      name: "Orekit Refraction Origin",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 0.0,
    });

    const startJulianDate = 2460400.5;
    const stepSeconds = 60.0;
    const stepDays = stepSeconds / 86400.0;
    const azimuthRad = degreesToRadians(45.0);
    const rangeM = 1000000.0;
    const sampledElevationDeg = [-0.7, -0.4, 0.2, -0.8];
    const states = sampledElevationDeg.map((elevationDeg, index) =>
      createTopocentricState(
        azimuthRad,
        degreesToRadians(elevationDeg),
        rangeM,
        startJulianDate + stepDays * index,
      ),
    );
    const switchingValues = sampledElevationDeg.map((elevationDeg) => {
      const elevationRad = degreesToRadians(elevationDeg);
      return elevationRad + orekitStandardAtmosphereRefractionRad(elevationRad);
    });
    const expectedAosSeconds = interpolateCrossingSeconds(
      0.0,
      switchingValues[0],
      stepSeconds,
      switchingValues[1],
    );
    const expectedLosSeconds = interpolateCrossingSeconds(
      stepSeconds * 2.0,
      switchingValues[2],
      stepSeconds * 3.0,
      switchingValues[3],
    );

    const geometry = analyzer.computeAccessGeometry(
      createTopocentricState(
        azimuthRad,
        degreesToRadians(-0.5),
        rangeM,
        startJulianDate,
      ),
      "orekit-refraction-origin",
      {
        minElevationDeg: 0.0,
        refractionModel: "earth-standard-atmosphere",
      },
    );

    const expectedRefractionRad = orekitStandardAtmosphereRefractionRad(
      degreesToRadians(-0.5),
    );
    assert.ok(
      Math.abs(geometry.refractionRad - expectedRefractionRad) < 1.0e-12,
      `refraction ${geometry.refractionRad} should match Orekit EarthStandardAtmosphereRefraction`,
    );
    assert.ok(
      Math.abs(
        geometry.apparentElevationRad -
          (geometry.elevationRad + expectedRefractionRad),
      ) < 1.0e-12,
      "apparent elevation should be geometric elevation plus refraction",
    );
    assert.equal(geometry.visible, true);

    const sourceEventElevationRad = degreesToRadians(-0.5746255623877098);
    assert.ok(
      Math.abs(
        sourceEventElevationRad +
          orekitStandardAtmosphereRefractionRad(sourceEventElevationRad),
      ) < degreesToRadians(1.0e-3),
      "Orekit ElevationDetectorTest.testHorizon source event is near the refracted horizon",
    );

    const windows = analyzer.computeAccessWindows(
      states,
      "orekit-refraction-origin",
      {
        minElevationDeg: 0.0,
        refractionModel: "earth-standard-atmosphere",
      },
    );

    assert.equal(windows.length, 1);
    assert.equal(windows[0].stationId, "orekit-refraction-origin");
    assert.ok(
      Math.abs(
        (windows[0].startJulianDate - startJulianDate) * 86400.0 -
          expectedAosSeconds,
      ) < 1.0e-3,
      `refracted AOS should occur ${expectedAosSeconds} seconds after start, got ${windows[0].startJulianDate}`,
    );
    assert.ok(
      Math.abs(
        (windows[0].endJulianDate - startJulianDate) * 86400.0 -
          expectedLosSeconds,
      ) < 1.0e-3,
      `refracted LOS should occur ${expectedLosSeconds} seconds after start, got ${windows[0].endJulianDate}`,
    );
    assert.ok(
      Math.abs(windows[0].maxElevationRad - degreesToRadians(0.2)) <
        ACCESS_GEOMETRY_ANGLE_TOLERANCE,
      `max elevation ${windows[0].maxElevationRad} should remain geometric elevation`,
    );
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer applies Orekit EarthStandardAtmosphereRefraction pressure and temperature setters", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "orekit-refraction-pres-temp-origin",
      name: "Orekit Refraction Pressure Temperature Origin",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 0.0,
    });

    const startJulianDate = 2460400.5;
    const stepSeconds = 60.0;
    const stepDays = stepSeconds / 86400.0;
    const azimuthRad = degreesToRadians(45.0);
    const rangeM = 1000000.0;
    const pressure = 101325.0;
    const temperature = 290.0;
    const refractionModel = {
      type: "EarthStandardAtmosphereRefraction",
      pressure,
      temperature,
    };
    const sampledElevationDeg = [-0.7, -0.4, 0.2, -0.8];
    const states = sampledElevationDeg.map((elevationDeg, index) =>
      createTopocentricState(
        azimuthRad,
        degreesToRadians(elevationDeg),
        rangeM,
        startJulianDate + stepDays * index,
      ),
    );
    const switchingValues = sampledElevationDeg.map((elevationDeg) => {
      const elevationRad = degreesToRadians(elevationDeg);
      return (
        elevationRad +
        orekitStandardAtmosphereRefractionRad(
          elevationRad,
          pressure,
          temperature,
        )
      );
    });
    const expectedAosSeconds = interpolateCrossingSeconds(
      0.0,
      switchingValues[0],
      stepSeconds,
      switchingValues[1],
    );
    const expectedLosSeconds = interpolateCrossingSeconds(
      stepSeconds * 2.0,
      switchingValues[2],
      stepSeconds * 3.0,
      switchingValues[3],
    );

    const geometry = analyzer.computeAccessGeometry(
      createTopocentricState(
        azimuthRad,
        degreesToRadians(-0.5),
        rangeM,
        startJulianDate,
      ),
      "orekit-refraction-pres-temp-origin",
      {
        minElevationDeg: 0.0,
        refractionModel,
      },
    );
    const expectedRefractionRad = orekitStandardAtmosphereRefractionRad(
      degreesToRadians(-0.5),
      pressure,
      temperature,
    );
    assert.ok(
      Math.abs(geometry.refractionRad - expectedRefractionRad) < 1.0e-12,
      `refraction ${geometry.refractionRad} should include Orekit pressure/temperature correction`,
    );

    const windows = analyzer.computeAccessWindows(
      states,
      "orekit-refraction-pres-temp-origin",
      {
        minElevationDeg: 0.0,
        refractionModel,
      },
    );

    assert.equal(windows.length, 1);
    assert.ok(
      Math.abs(
        (windows[0].startJulianDate - startJulianDate) * 86400.0 -
          expectedAosSeconds,
      ) < 1.0e-3,
      `pressure/temperature AOS should occur ${expectedAosSeconds} seconds after start`,
    );
    assert.ok(
      Math.abs(
        (windows[0].endJulianDate - startJulianDate) * 86400.0 -
          expectedLosSeconds,
      ) < 1.0e-3,
      `pressure/temperature LOS should occur ${expectedLosSeconds} seconds after start`,
    );
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer matches Orekit ITURP834AtmosphericRefraction source vectors", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    const sourceVectors = [
      {
        id: "everest",
        altitudeM: 8848.0,
        elevationDeg: 2.0,
        expectedRefractionDeg: 0.11458177523385392,
        toleranceDeg: 1.0e-14,
      },
      {
        id: "dead-sea",
        altitudeM: -422.0,
        elevationDeg: 2.0,
        expectedRefractionDeg: 0.3550620274090111,
        toleranceDeg: 1.0e-14,
      },
      {
        id: "kiruna-2deg",
        altitudeM: 385.8,
        elevationDeg: 2.0,
        expectedRefractionDeg: 0.32,
        toleranceDeg: 1.0e-2,
      },
      {
        id: "kiruna-4deg",
        altitudeM: 385.8,
        elevationDeg: 4.0,
        expectedRefractionDeg: 0.21,
        toleranceDeg: 1.0e-2,
      },
      {
        id: "kiruna-10deg",
        altitudeM: 385.8,
        elevationDeg: 10.0,
        expectedRefractionDeg: 0.10,
        toleranceDeg: 2.0e-2,
      },
      {
        id: "kiruna-30deg",
        altitudeM: 385.8,
        elevationDeg: 30.0,
        expectedRefractionDeg: 0.02,
        toleranceDeg: 1.0e-2,
      },
      {
        id: "kiruna-90deg",
        altitudeM: 385.8,
        elevationDeg: 90.0,
        expectedRefractionDeg: 0.002,
        toleranceDeg: 1.0e-3,
      },
      {
        id: "hartebeesthoek-negative",
        altitudeM: 1415.821,
        elevationDeg: -10.0,
        expectedRefractionDeg: 1.7367073234643113,
        toleranceDeg: 1.0e-3,
      },
    ];

    for (const vector of sourceVectors) {
      const stationId = `orekit-iturp834-${vector.id}`;
      analyzer.addGroundStation({
        id: stationId,
        name: stationId,
        latitudeDeg: 0.0,
        longitudeDeg: 0.0,
        altitudeM: vector.altitudeM,
        minElevationDeg: -90.0,
      });

      const geometry = analyzer.computeAccessGeometry(
        createTopocentricStateAtAltitude(
          degreesToRadians(45.0),
          degreesToRadians(vector.elevationDeg),
          1000000.0,
          2460400.5,
          vector.altitudeM,
        ),
        stationId,
        {
          minElevationDeg: -90.0,
          refractionModel: "ITURP834AtmosphericRefraction",
        },
      );

      assert.ok(
        Math.abs(
          radiansToDegrees(geometry.refractionRad) -
            vector.expectedRefractionDeg,
        ) <= vector.toleranceDeg,
        `${vector.id} refraction ${radiansToDegrees(
          geometry.refractionRad,
        )} deg should match Orekit ITURP834AtmosphericRefraction`,
      );
      assert.ok(
        Math.abs(
          geometry.apparentElevationRad -
            (geometry.elevationRad + geometry.refractionRad),
        ) < 1.0e-12,
        `${vector.id} apparent elevation should include ITU-R P.834 refraction`,
      );
    }
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer applies Orekit ITURP834AtmosphericRefraction to native elevation switching", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "orekit-iturp834-window-origin",
      name: "Orekit ITU-R P.834 Window Origin",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 0.0,
    });

    const startJulianDate = 2460400.5;
    const stepSeconds = 60.0;
    const stepDays = stepSeconds / 86400.0;
    const azimuthRad = degreesToRadians(45.0);
    const rangeM = 1000000.0;
    const refractionModel = "ITURP834AtmosphericRefraction";
    const sampledElevationDeg = [-0.7, -0.4, 0.2, -0.8];
    const states = sampledElevationDeg.map((elevationDeg, index) =>
      createTopocentricState(
        azimuthRad,
        degreesToRadians(elevationDeg),
        rangeM,
        startJulianDate + stepDays * index,
      ),
    );
    const switchingValues = states.map(
      (state) =>
        analyzer.computeAccessGeometry(
          state,
          "orekit-iturp834-window-origin",
          {
            minElevationDeg: 0.0,
            refractionModel,
          },
        ).apparentElevationRad,
    );
    const expectedAosSeconds = interpolateCrossingSeconds(
      0.0,
      switchingValues[0],
      stepSeconds,
      switchingValues[1],
    );
    const expectedLosSeconds = interpolateCrossingSeconds(
      stepSeconds * 2.0,
      switchingValues[2],
      stepSeconds * 3.0,
      switchingValues[3],
    );

    const windows = analyzer.computeAccessWindows(
      states,
      "orekit-iturp834-window-origin",
      {
        minElevationDeg: 0.0,
        refractionModel,
      },
    );

    assert.equal(windows.length, 1);
    assert.ok(
      Math.abs(
        (windows[0].startJulianDate - startJulianDate) * 86400.0 -
          expectedAosSeconds,
      ) < 1.0e-3,
      `ITU-R P.834 AOS should occur ${expectedAosSeconds} seconds after start`,
    );
    assert.ok(
      Math.abs(
        (windows[0].endJulianDate - startJulianDate) * 86400.0 -
          expectedLosSeconds,
      ) < 1.0e-3,
      `ITU-R P.834 LOS should occur ${expectedLosSeconds} seconds after start`,
    );
    assert.ok(
      Math.abs(windows[0].maxElevationRad - degreesToRadians(0.2)) <
        ACCESS_GEOMETRY_ANGLE_TOLERANCE,
      `max elevation ${windows[0].maxElevationRad} should remain geometric elevation`,
    );
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer computes a simple access window from pre-sampled ECEF states", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "equator-west",
      name: "Equator West",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 10.0,
    });

    const startJulianDate = 2460400.5;
    const states = [
      createEquatorialState(-0.45, startJulianDate + SAMPLE_STEP_DAYS * 0),
      createEquatorialState(-0.30, startJulianDate + SAMPLE_STEP_DAYS * 1),
      createEquatorialState(-0.20, startJulianDate + SAMPLE_STEP_DAYS * 2),
      createEquatorialState(-0.10, startJulianDate + SAMPLE_STEP_DAYS * 3),
      createEquatorialState(0.0, startJulianDate + SAMPLE_STEP_DAYS * 4),
      createEquatorialState(0.10, startJulianDate + SAMPLE_STEP_DAYS * 5),
      createEquatorialState(0.20, startJulianDate + SAMPLE_STEP_DAYS * 6),
      createEquatorialState(0.30, startJulianDate + SAMPLE_STEP_DAYS * 7),
      createEquatorialState(0.45, startJulianDate + SAMPLE_STEP_DAYS * 8),
    ];

    const windows = analyzer.computeAccessWindows(states, "equator-west", {
      minElevationDeg: 10.0,
    });

    assert.equal(windows.length, 1);
    assert.equal(windows[0].stationId, "equator-west");
    assert.ok(windows[0].startJulianDate > states[0].julianDate);
    assert.ok(windows[0].startJulianDate < states[4].julianDate);
    assert.ok(windows[0].endJulianDate > states[4].julianDate);
    assert.ok(windows[0].endJulianDate < states[8].julianDate);
    assert.ok(windows[0].durationSeconds > SAMPLE_STEP_SECONDS * 2.0);
    assert.ok(windows[0].maxElevationRad > 1.2);
    assert.ok(windows[0].sampleCount >= 3);
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer schedules contacts greedily with per-station capacity and blackout clipping", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "alpha",
      name: "Alpha",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      channelCapacity: 1,
      blackoutWindows: [
        {
          startJulianDate: 2460400.50021,
          endJulianDate: 2460400.50025,
        },
      ],
      minElevationDeg: 10.0,
    });
    analyzer.addGroundStation({
      id: "bravo",
      name: "Bravo",
      latitudeDeg: 5.0,
      longitudeDeg: 5.0,
      altitudeM: 0.0,
      channelCapacity: 2,
      minElevationDeg: 10.0,
    });

    const schedule = analyzer.scheduleContacts([
      {
        stationId: "alpha",
        assetId: "sat-b",
        startJulianDate: 2460400.50012,
        endJulianDate: 2460400.50017,
      },
      {
        stationId: "alpha",
        assetId: "sat-d",
        startJulianDate: 2460400.50010,
        endJulianDate: 2460400.50020,
      },
      {
        stationId: "alpha",
        assetId: "sat-a",
        startJulianDate: 2460400.50010,
        endJulianDate: 2460400.50020,
      },
      {
        stationId: "alpha",
        assetId: "sat-c",
        startJulianDate: 2460400.50018,
        endJulianDate: 2460400.50030,
      },
      {
        stationId: "bravo",
        assetId: "relay-2",
        startJulianDate: 2460400.50012,
        endJulianDate: 2460400.50018,
      },
      {
        stationId: "bravo",
        assetId: "relay-3",
        startJulianDate: 2460400.50013,
        endJulianDate: 2460400.50017,
      },
      {
        stationId: "bravo",
        assetId: "relay-1",
        startJulianDate: 2460400.50011,
        endJulianDate: 2460400.50019,
      },
    ]);

    assert.deepEqual(schedule, [
      {
        stationId: "alpha",
        assetId: "sat-a",
        startJulianDate: 2460400.5001,
        endJulianDate: 2460400.5002,
        durationSeconds: 8.64,
      },
      {
        stationId: "bravo",
        assetId: "relay-1",
        startJulianDate: 2460400.50011,
        endJulianDate: 2460400.50019,
        durationSeconds: 6.912,
      },
      {
        stationId: "bravo",
        assetId: "relay-2",
        startJulianDate: 2460400.50012,
        endJulianDate: 2460400.50018,
        durationSeconds: 5.184,
      },
      {
        stationId: "alpha",
        assetId: "sat-c",
        startJulianDate: 2460400.50025,
        endJulianDate: 2460400.5003,
        durationSeconds: 4.32,
      },
    ]);
  } finally {
    analyzer.destroy();
  }
});

test("Access analyzer predicts AOS and LOS from the next computed access window", async () => {
  const analyzer = await createAccessAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    analyzer.addGroundStation({
      id: "equator-west",
      name: "Equator West",
      latitudeDeg: 0.0,
      longitudeDeg: 0.0,
      altitudeM: 0.0,
      minElevationDeg: 10.0,
    });

    const startJulianDate = 2460400.5;
    const states = [
      createEquatorialState(-0.45, startJulianDate + SAMPLE_STEP_DAYS * 0),
      createEquatorialState(-0.3, startJulianDate + SAMPLE_STEP_DAYS * 1),
      createEquatorialState(-0.2, startJulianDate + SAMPLE_STEP_DAYS * 2),
      createEquatorialState(-0.1, startJulianDate + SAMPLE_STEP_DAYS * 3),
      createEquatorialState(0.0, startJulianDate + SAMPLE_STEP_DAYS * 4),
      createEquatorialState(0.1, startJulianDate + SAMPLE_STEP_DAYS * 5),
      createEquatorialState(0.2, startJulianDate + SAMPLE_STEP_DAYS * 6),
      createEquatorialState(0.3, startJulianDate + SAMPLE_STEP_DAYS * 7),
      createEquatorialState(0.45, startJulianDate + SAMPLE_STEP_DAYS * 8),
    ];

    const [window] = analyzer.computeAccessWindows(states, "equator-west", {
      minElevationDeg: 10.0,
    });

    assert.equal(
      analyzer.predictAos(states, "equator-west", {
        minElevationDeg: 10.0,
      }),
      window.startJulianDate,
    );
    assert.equal(
      analyzer.predictLos(states, "equator-west", {
        minElevationDeg: 10.0,
      }),
      window.endJulianDate,
    );
  } finally {
    analyzer.destroy();
  }
});
