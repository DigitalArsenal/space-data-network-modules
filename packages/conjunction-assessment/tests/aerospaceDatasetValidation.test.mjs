import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  listOcmDirectoryEntries,
  readCsvRows,
  readOcmDirectoryEntryText,
} from "./lib/aerospaceDataset.mjs";
import {
  parseAerospaceOcmText,
  validateAerospaceOcm,
} from "./lib/aerospaceOcm.mjs";
import {
  formatAerospaceDatasetSetupMessage,
  getDefaultAerospaceReplayPaths,
} from "./lib/aerospaceReplayHarness.mjs";

const DEFAULT_PATHS = getDefaultAerospaceReplayPaths();
const GUIDE_PATH = path.join(
  DEFAULT_PATHS.extractedRoot,
  "docs",
  "Conjunction_Screening_Testset_Users_Guide.txt",
);
const SCREENING_PATH = path.join(
  DEFAULT_PATHS.extractedRoot,
  "csv",
  "AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv",
);

async function datasetAvailable() {
  if (!DEFAULT_PATHS.extractedRoot) {
    return false;
  }
  try {
    await access(GUIDE_PATH);
    await access(DEFAULT_PATHS.ocmRoot);
    await access(DEFAULT_PATHS.sphericalAnswerKeyPath);
    await access(DEFAULT_PATHS.sfshAnswerKeyPath);
    await access(SCREENING_PATH);
    return true;
  } catch {
    return false;
  }
}

async function collectRows(filePath, limit) {
  const rows = [];
  for await (const row of readCsvRows(filePath, { limit })) {
    rows.push(row);
  }
  return rows;
}

test("Aerospace extracted dataset inventory matches the published guide constraints", async (t) => {
  if (!(await datasetAvailable())) {
    t.skip(formatAerospaceDatasetSetupMessage());
    return;
  }

  const guideText = await readFile(GUIDE_PATH, "utf8");
  assert.match(guideText, /2025-01-01T12:00:00/i);
  assert.match(guideText, /2025-01-08T12:00:00/i);
  assert.match(guideText, /ALL vs\. ALL/i);
  assert.match(guideText, /OD_EPOCH[\s\S]*14 days/i);
  assert.match(guideText, /10 km/i);
  assert.match(guideText, /0\.5m/i);

  const ocmEntries = await listOcmDirectoryEntries(DEFAULT_PATHS.ocmRoot);
  assert.ok(ocmEntries.length > 26000);

  const [sphericalRows, sfshRows, screeningRows] = await Promise.all([
    collectRows(DEFAULT_PATHS.sphericalAnswerKeyPath, 3),
    collectRows(DEFAULT_PATHS.sfshAnswerKeyPath, 3),
    collectRows(SCREENING_PATH, 3),
  ]);

  assert.equal(sphericalRows.length, 3);
  assert.equal(sfshRows.length, 3);
  assert.equal(screeningRows.length, 3);

  assert.deepEqual(
    Object.keys(sphericalRows[0]).slice(0, 6),
    ["run_id", "conj_id", "obj1", "met_criteria1", "obj2", "met_criteria2"],
  );
  assert.ok("obj1_filename" in sphericalRows[0]);
  assert.ok("obj2_filename" in sphericalRows[0]);
  assert.ok("obj1_filename" in sfshRows[0]);
  assert.ok("obj2_filename" in sfshRows[0]);
  assert.ok("HBR" in screeningRows[0]);
  assert.ok("ScreeningVolume" in screeningRows[0]);
});

test("Aerospace answer-key filenames resolve to valid extracted OCM files", async (t) => {
  if (!(await datasetAvailable())) {
    t.skip(formatAerospaceDatasetSetupMessage());
    return;
  }

  const ocmEntries = await listOcmDirectoryEntries(DEFAULT_PATHS.ocmRoot);
  const entryMap = new Map(ocmEntries.map((entry) => [path.basename(entry), entry]));

  const referencedFiles = new Set();
  for (const csvPath of [
    DEFAULT_PATHS.sphericalAnswerKeyPath,
    DEFAULT_PATHS.sfshAnswerKeyPath,
  ]) {
    for await (const row of readCsvRows(csvPath, { limit: 8 })) {
      referencedFiles.add(String(row.obj1_filename));
      referencedFiles.add(String(row.obj2_filename));
    }
  }

  const sampleEntries = Array.from(referencedFiles)
    .map((fileName) => entryMap.get(fileName))
    .filter(Boolean)
    .slice(0, 8);

  assert.equal(sampleEntries.length, 8);

  for (const entry of sampleEntries) {
    const text = await readOcmDirectoryEntryText(DEFAULT_PATHS.ocmRoot, entry);
    const parsed = parseAerospaceOcmText(text, { sourcePath: entry });
    assert.deepEqual(validateAerospaceOcm(parsed), [], entry);
  }
});
