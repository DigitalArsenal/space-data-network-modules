import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
  invokeConjunctionJson,
} from "./lib/conjunctionCommandHarness.mjs";
import {
  buildAerospaceOcmBasenameIndex,
  formatAerospaceDatasetSetupMessage,
  getDefaultAerospaceReplayPaths,
  runAerospaceAnswerKeyReplay,
} from "./lib/aerospaceReplayHarness.mjs";

const DEFAULT_PATHS = getDefaultAerospaceReplayPaths();

function wasmedgeAvailable() {
  const probe = spawnSync("wasmedge", ["--version"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

async function aerospaceDatasetAvailable() {
  if (!DEFAULT_PATHS.extractedRoot) {
    return false;
  }
  try {
    await access(DEFAULT_PATHS.sphericalAnswerKeyPath);
    await access(DEFAULT_PATHS.ocmRoot);
    return true;
  } catch {
    return false;
  }
}

test("Aerospace OCM basename index resolves answer-key files across extracted subtrees", async (t) => {
  if (!(await aerospaceDatasetAvailable())) {
    t.skip(formatAerospaceDatasetSetupMessage());
    return;
  }

  const index = await buildAerospaceOcmBasenameIndex(DEFAULT_PATHS.ocmRoot);
  assert.ok(index.size > 26000);
  assert.equal(index.get("95025.ocm"), path.join("CDM", "95025.ocm"));
  assert.equal(index.get("14780.ocm"), path.join("tle", "14780.ocm"));
});

test("track-mode replay reproduces the first 100 Aerospace spherical answer-key rows through the local conjunction package", async (t) => {
  if (!wasmedgeAvailable()) {
    t.skip("Install wasmedge to verify the Aerospace replay harness.");
    return;
  }
  if (!(await aerospaceDatasetAvailable())) {
    t.skip(formatAerospaceDatasetSetupMessage());
    return;
  }
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the Aerospace replay test.");
    return;
  }

  const summary = await runAerospaceAnswerKeyReplay({
    answerKeyPath: DEFAULT_PATHS.sphericalAnswerKeyPath,
    ocmRoot: DEFAULT_PATHS.ocmRoot,
    limit: 100,
    pluginBatchSize: 10,
    trackCacheSize: 32,
    tcaToleranceSec: 0.01,
    rangeToleranceKm: 0.01,
    maxRecordedMismatches: 5,
    createHarness: () => createConjunctionCommandHarness(),
    invokeHarness: invokeConjunctionJson,
  });

  assert.equal(summary.mode, "track");
  assert.equal(summary.testedRows, 100);
  assert.equal(summary.mismatchCount, 0);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.pluginInstancesCreated >= 10);
  assert.ok(summary.maxTcaDeltaSec < 0.01);
  assert.ok(summary.maxRangeDeltaKm < 0.01);
});

test("track-mode replay keeps a known close-pair Aerospace row within the measured replay envelope", async (t) => {
  if (!wasmedgeAvailable()) {
    t.skip("Install wasmedge to verify the Aerospace replay harness.");
    return;
  }
  if (!(await aerospaceDatasetAvailable())) {
    t.skip(formatAerospaceDatasetSetupMessage());
    return;
  }
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the Aerospace replay test.");
    return;
  }

  const summary = await runAerospaceAnswerKeyReplay({
    answerKeyPath: DEFAULT_PATHS.sphericalAnswerKeyPath,
    ocmRoot: DEFAULT_PATHS.ocmRoot,
    offset: 867,
    limit: 1,
    pluginBatchSize: 1,
    trackCacheSize: 4,
    tcaToleranceSec: 10,
    rangeToleranceKm: 0.01,
    maxRecordedMismatches: 1,
    createHarness: () => createConjunctionCommandHarness(),
    invokeHarness: invokeConjunctionJson,
  });

  assert.equal(summary.testedRows, 1);
  assert.equal(summary.mismatchCount, 0);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.maxTcaDeltaSec < 10);
  assert.ok(summary.maxRangeDeltaKm < 0.01);
});
