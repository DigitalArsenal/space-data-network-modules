import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("licensing core generated SCV C++ header exposes current raster product kinds", () => {
  const headerPath = path.join(
    repoRoot,
    "licensing/core/src/cpp/generated/sds/SCV_generated.h",
  );
  const source = fs.readFileSync(headerPath, "utf8");

  for (const snippet of [
    "PASS_COUNT_RGBA = 12",
    "CURRENT_ACCESS_RGBA = 13",
    "LATITUDE_BAND_COVERAGE = 14",
    "MAX = LATITUDE_BAND_COVERAGE",
  ]) {
    assert.ok(
      source.includes(snippet),
      `${path.relative(repoRoot, headerPath)} is stale; missing ${snippet}`,
    );
  }

  assert.equal(
    source.includes("MAX = BUCKET_ACTIVE_CELL_COUNT"),
    false,
    `${path.relative(repoRoot, headerPath)} must not cap scvRasterProductKind at the retired bucket-count maximum`,
  );

  for (const retiredToken of [
    "SCVCellStat",
    "SCVInterval",
    "SCVLatitudeBandStat",
    "SCVTimeSeriesPoint",
    "CELL_STATS",
    "LATITUDE_BANDS",
    "TIME_SERIES",
  ]) {
    assert.equal(
      source.includes(retiredToken),
      false,
      `${path.relative(repoRoot, headerPath)} must not preserve retired inline result-vector schema ${retiredToken}`,
    );
  }
});
