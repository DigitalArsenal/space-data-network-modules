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
const DEFAULT_CELESTRAK_CSV = path.join(
  __dirname,
  "data",
  "celestrak_starlink_supgp.csv",
);

function createFitRequest(payload) {
  return {
    methodId: "fit",
    inputs: [
      {
        portId: "meme",
        payload,
      },
    ],
  };
}

async function invokeFitJson(harness, payload) {
  const response = await harness.invoke(createFitRequest(payload));
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
    betterCount: comparisons.filter((entry) => entry.rms <= entry.referenceRms).length,
    worseCount: comparisons.filter((entry) => entry.rms > entry.referenceRms).length,
  };
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

  test(`OD MEME corpus regression stays within fit-quality thresholds on ${runtimeKind}`, async (t) => {
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
      const noradId = Number.parseInt(path.basename(filePath).split("_")[1] ?? "", 10);
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
      assert.ok(
        summary.betterCount >= summary.worseCount,
        `Expected OD fits to beat or match the optional CelesTrak reference on at least half of comparable files (${summary.betterCount} vs ${summary.worseCount}).`,
      );
    }
  });
}
