import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STANDALONE_RUNTIME_KINDS,
  assertSuccessfulResponse,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const FIXTURE_MEME_PATH = new URL("./fixtures/request.fit.meme", import.meta.url);
const MEME_DATA_DIR = path.join(__dirname, "data", "meme");
const REFERENCE_SUITE_DIR = path.join(__dirname, "data", "supgp-reference");
const REFERENCE_MEME_DATA_DIR = path.join(REFERENCE_SUITE_DIR, "meme");
const REFERENCE_CELESTRAK_CSV = path.join(
  REFERENCE_SUITE_DIR,
  "celestrak_supgp_2026-034.csv",
);
const DEFAULT_CELESTRAK_CSV = path.join(
  __dirname,
  "data",
  "celestrak_starlink_supgp.csv",
);

function createFitRequest(payload, options = null) {
  const request = {
    methodId: "fit",
    inputs: [
      {
        portId: "meme",
        payload,
      },
    ],
  };
  if (options) {
    request.inputs.push({
      portId: "options",
      payload: new TextEncoder().encode(JSON.stringify(options)),
    });
  }
  return request;
}

async function invokeFitJson(harness, payload, options = null) {
  const response = await harness.invoke(createFitRequest(payload, options));
  const bytes = assertSuccessfulResponse(response, { outputPortId: "result" });
  return JSON.parse(new TextDecoder().decode(bytes));
}

function listRegressionFiles() {
  if (!fs.existsSync(MEME_DATA_DIR)) {
    return [];
  }
  return fs.readdirSync(MEME_DATA_DIR)
    .filter((entry) => entry.startsWith("MEME_") && entry.endsWith(".txt"))
    .sort()
    .map((entry) => path.join(MEME_DATA_DIR, entry));
}

function listReferenceSuiteFiles() {
  if (!fs.existsSync(REFERENCE_MEME_DATA_DIR)) {
    return [];
  }
  return fs.readdirSync(REFERENCE_MEME_DATA_DIR)
    .filter((entry) => entry.startsWith("MEME_") && entry.endsWith(".txt"))
    .sort()
    .map((entry) => path.join(REFERENCE_MEME_DATA_DIR, entry));
}

function parseCelestrakCsv(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    return new Map();
  }
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/);
  const records = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split(",");
    if (fields.length < 18) {
      continue;
    }
    const noradId = Number.parseInt(fields[11], 10);
    const rms = Number.parseFloat(fields[17]);
    if (!Number.isFinite(noradId) || !Number.isFinite(rms)) {
      continue;
    }
    records.set(noradId, { rms });
  }
  return records;
}

function noradIdFromMemePath(filePath) {
  const id = Number.parseInt(path.basename(filePath).split("_")[1] ?? "", 10);
  return Number.isFinite(id) ? id : Number.NaN;
}

function summarizeRegression(results, celestrak) {
  const successful = results
    .filter((entry) => entry.ok)
    .map((entry) => entry.rms)
    .sort((left, right) => left - right);
  const comparisons = results
    .filter((entry) => entry.ok && celestrak.has(entry.noradId))
    .map((entry) => ({
      rms: entry.rms,
      referenceRms: celestrak.get(entry.noradId).rms,
    }));

  return {
    count: results.length,
    successCount: successful.length,
    medianRms: successful.length
      ? successful[Math.floor(successful.length / 2)]
      : Number.NaN,
    meanRms: successful.length
      ? successful.reduce((sum, value) => sum + value, 0) / successful.length
      : Number.NaN,
    betterCount: comparisons.filter((entry) => entry.rms < entry.referenceRms).length,
    worseCount: comparisons.filter((entry) => entry.rms >= entry.referenceRms).length,
  };
}

function assertBeatsCelestrak(result) {
  assert.ok(
    result.rms < result.referenceRms,
    [
      `${path.basename(result.filePath)} must beat CelesTrak SupGP RMS.`,
      `OrbPro=${result.rms.toFixed(6)} km`,
      `CelesTrak=${result.referenceRms.toFixed(6)} km`,
      `delta=${(result.rms - result.referenceRms).toFixed(6)} km`,
    ].join(" "),
  );
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`OD fixture fit produces a stable GP estimate on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
    );

    assert.equal(result.DATA_SOURCE, "SpaceX-E");
    assert.equal(result.OBJECT_ID.trim(), "99999A");
    assert.ok(result.EPOCH.startsWith("2026-03-10T20:16:42"));
    assert.ok(Math.abs(result.MEAN_MOTION - 15.08802686) < 1e-8);
    assert.ok(Math.abs(result.ECCENTRICITY - 0.0001602) < 1e-7);
    assert.ok(Math.abs(result.INCLINATION - 53.2223) < 1e-4);
    assert.ok(Number.parseFloat(result.RMS) <= 0.001);
  });

  test(`OD fit honors maxIterations option on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeFitJson(
      harness,
      fs.readFileSync(fileURLToPath(FIXTURE_MEME_PATH)),
      { maxIterations: 2 },
    );

    assert.equal(result.MAX_ITERATIONS, 2);
    assert.ok(
      Number.isInteger(result.ITERATIONS) && result.ITERATIONS <= 2,
      `Expected solver iterations <= 2, got ${result.ITERATIONS}`,
    );
  });

  test(`OD fit rejects malformed MEME payloads on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const response = await harness.invoke(
      createFitRequest(Buffer.from("not a meme", "utf8")),
    );
    assert.equal(response.statusCode, 1);
    assert.equal(response.errorCode, "parse-failed");
    assert.match(response.errorMessage, /did not contain any ephemeris points/i);
  });

  test(`OD SupGP reference suite beats CelesTrak RMS for every case on ${runtimeKind}`, async (t) => {
    const referenceFiles = listReferenceSuiteFiles();
    assert.ok(
      referenceFiles.length > 0,
      "Expected checked-in SpaceX Starlink reference ephemerides under tests/data/supgp-reference/meme.",
    );

    const celestrak = parseCelestrakCsv(REFERENCE_CELESTRAK_CSV);
    assert.ok(
      celestrak.size > 0,
      "Expected checked-in matching CelesTrak SupGP CSV records for the reference suite.",
    );

    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const results = [];
    for (const filePath of referenceFiles) {
      const noradId = noradIdFromMemePath(filePath);
      const reference = celestrak.get(noradId);
      assert.ok(
        reference,
        `Missing CelesTrak SupGP reference RMS for NORAD ${noradId}.`,
      );

      const fit = await invokeFitJson(harness, fs.readFileSync(filePath));
      const rms = Number.parseFloat(fit.RMS);
      assert.ok(
        Number.isFinite(rms),
        `Fit RMS must be finite for ${path.basename(filePath)}.`,
      );
      results.push({
        filePath,
        noradId,
        rms,
        referenceRms: reference.rms,
      });
    }

    for (const result of results) {
      assertBeatsCelestrak(result);
    }
  });

  test(`OD source-adapter corpus regression stays within fit-quality thresholds on ${runtimeKind}`, async (t) => {
    const regressionFiles = listRegressionFiles();
    if (regressionFiles.length === 0) {
      t.skip("Add MEME files under tests/data/meme to run the broader OD regression corpus.");
      return;
    }

    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Keep the default corpus small enough for the repo-wide WasmEdge matrix.
    // Larger public MEME sweeps stay available through OD_MEME_MAX_FILES.
    const maxFiles = Number.parseInt(process.env.OD_MEME_MAX_FILES ?? "5", 10);
    const files = regressionFiles.slice(0, Math.max(1, maxFiles));
    const celestrak = parseCelestrakCsv(
      process.env.OD_CELESTRAK_SUPGP_CSV ?? DEFAULT_CELESTRAK_CSV,
    );
    const results = [];

    for (const filePath of files) {
      const fit = await invokeFitJson(harness, fs.readFileSync(filePath));
      const noradId = noradIdFromMemePath(filePath);
      const rms = Number.parseFloat(fit.RMS);
      results.push({
        filePath,
        noradId,
        ok: Number.isFinite(rms) && rms <= 50 && !fit.error,
        rms,
      });
    }

    const summary = summarizeRegression(results, celestrak);
    assert.ok(
      summary.successCount >= Math.ceil(summary.count * 0.9),
      `Expected at least 90% successful fits, got ${summary.successCount}/${summary.count}.`,
    );
    assert.ok(
      summary.medianRms < 0.35,
      `Expected median RMS < 0.35 km, got ${summary.medianRms}.`,
    );
    if (summary.betterCount + summary.worseCount > 0) {
      assert.equal(
        summary.worseCount,
        0,
        `Expected every comparable OD fit to beat the optional CelesTrak reference (${summary.betterCount} better, ${summary.worseCount} not lower).`,
      );
    }
  });
}
