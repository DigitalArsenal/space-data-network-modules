import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
  invokeConjunctionJson,
} from "./lib/conjunctionCommandHarness.mjs";
import {
  createLocalSgp4Plugin,
  sampleTrackWindowFromReference,
  sgp4ArtifactExists,
} from "./lib/sgp4TrackHarness.mjs";

const CLOSE_PAIR_FIXTURE_PATH = new URL(
  "./fixtures/socrates/gp_61721,67298.json",
  import.meta.url,
);
const SOCRATES_REFERENCE_PATH = new URL(
  "./fixtures/socrates/reference.top3.json",
  import.meta.url,
);

function wasmedgeAvailable() {
  const probe = spawnSync("wasmedge", ["--version"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

test("conjunction WasmEdge harness accepts SGP4-sampled tracks for the known close pair", async (t) => {
  if (!wasmedgeAvailable()) {
    t.skip("Install wasmedge to verify the server-path conjunction harness.");
    return;
  }
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  if (!sgp4ArtifactExists()) {
    t.skip("Build the local SGP4 plugin before running the WasmEdge harness test.");
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness();
  const sgp4 = await createLocalSgp4Plugin();

  t.after(async () => {
    sgp4.destroy();
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = await sampleTrackWindowFromReference(
    sgp4,
    gpRecords,
    reference,
  );

  const { response, json } = await invokeConjunctionJson(harness, {
    operation: "assessTracks",
    params: {
      primary_track: primaryTrack,
      secondary_track: secondaryTrack,
      tca_hint_jd: Date.parse(reference.tca) / 86400000 + 2440587.5,
      window_hours: 0.2,
    },
  });

  assert.equal(response.statusCode, 0);
  assert.ok(Number.isFinite(Number(json?.tca_jd)));
  assert.ok(Number(json?.min_range_km) < 0.2);
  assert.ok(Number(json?.rel_speed_kms) > 5);
  assert.equal(json?.obj1_norad, 61721);
  assert.equal(json?.obj2_norad, 67298);
});
