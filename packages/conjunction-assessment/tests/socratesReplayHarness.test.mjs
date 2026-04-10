import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  createConjunctionCommandHarness,
  invokeConjunctionJson,
  conjunctionArtifactExists,
} from "./lib/conjunctionCommandHarness.mjs";
import {
  createLocalSgp4Plugin,
  sampleTrackWindowFromReference,
  sgp4ArtifactExists,
} from "./lib/sgp4TrackHarness.mjs";

const SOCRATES_REFERENCE_PATH = new URL(
  "./fixtures/socrates/reference.top3.json",
  import.meta.url,
);
const GP_FIXTURE_DIR = new URL("./fixtures/socrates/", import.meta.url);

function wasmedgeAvailable() {
  const probe = spawnSync("wasmedge", ["--version"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function loadGpFixture(gpFile) {
  const jsonFile = gpFile.replace(/\.txt$/i, ".json");
  return JSON.parse(
    fs.readFileSync(new URL(jsonFile, GP_FIXTURE_DIR), "utf8"),
  );
}

function probabilityRatio(actual, expected) {
  const a = Number(actual);
  const e = Number(expected);
  if (a === 0 && e === 0) {
    return 1;
  }
  if (!(a > 0) || !(e > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(a / e, e / a);
}

test("WasmEdge conjunction replay stays within the public SOCRATES tolerance envelope for the vendored close pairs", async (t) => {
  if (!wasmedgeAvailable()) {
    t.skip("Install wasmedge to verify the server-path conjunction harness.");
    return;
  }
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the SOCRATES replay test.");
    return;
  }
  if (!sgp4ArtifactExists()) {
    t.skip("Build the local SGP4 plugin before running the SOCRATES replay test.");
    return;
  }

  const referenceRows = JSON.parse(
    fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"),
  ).conjunctions;
  const harness = await createConjunctionCommandHarness();
  t.after(async () => {
    await harness.destroy();
  });

  for (const reference of referenceRows) {
    const sgp4 = await createLocalSgp4Plugin();
    try {
      const gpRecords = loadGpFixture(reference.gp_file);
      const [primaryTrack, secondaryTrack] = await sampleTrackWindowFromReference(
        sgp4,
        gpRecords,
        reference,
      );
      const expectedTcaJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
      const { response, json } = await invokeConjunctionJson(harness, {
        operation: "assessTracks",
        params: {
          primary_track: primaryTrack,
          secondary_track: secondaryTrack,
          tca_hint_jd: expectedTcaJd,
          window_hours: 0.2,
        },
      });

      assert.equal(response.statusCode, 0, reference.gp_file);

      const tcaDeltaSec = Math.abs(Number(json.tca_jd) - expectedTcaJd) * 86400.0;
      const rangeDeltaKm = Math.abs(
        Number(json.min_range_km) - Number(reference.min_range_km),
      );
      const speedDeltaKmS = Math.abs(
        Number(json.rel_speed_kms) - Number(reference.rel_speed_kms),
      );
      const maxProbRatio = probabilityRatio(
        Number(json.max_probability),
        Number(reference.max_prob),
      );

      assert.ok(
        tcaDeltaSec <= 60,
        `${reference.gp_file}: TCA delta ${tcaDeltaSec}s exceeded 60s`,
      );
      assert.ok(
        rangeDeltaKm <= 0.5,
        `${reference.gp_file}: range delta ${rangeDeltaKm} km exceeded 0.5 km`,
      );
      assert.ok(
        speedDeltaKmS <= 0.5,
        `${reference.gp_file}: speed delta ${speedDeltaKmS} km/s exceeded 0.5 km/s`,
      );
      assert.ok(
        maxProbRatio <= 100,
        `${reference.gp_file}: probability ratio ${maxProbRatio} exceeded 100`,
      );
    } finally {
      sgp4.destroy();
    }
  }
});
