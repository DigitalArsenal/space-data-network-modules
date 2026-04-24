import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createAccessAnalyzer } from "../index.js";

const EARTH_RADIUS_METERS = 6378137.0;
const ORBIT_RADIUS_METERS = EARTH_RADIUS_METERS + 500000.0;
const SAMPLE_STEP_SECONDS = 60.0;
const SAMPLE_STEP_DAYS = SAMPLE_STEP_SECONDS / 86400.0;

function degreesToRadians(value) {
  return (value * Math.PI) / 180.0;
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
