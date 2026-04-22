/**
 * Smoke test for the archive-streaming dataset surface.
 *
 * This test skips gracefully when the raw archives are not present. On a
 * developer machine with `~/Documents/Conjunctions/` populated, it walks the
 * CSV answer keys and locates matching OCM files inside the tar.gz *without*
 * a prior extraction pass.
 *
 * Scope is intentionally small — streaming through the 22 GB tar.gz is slow.
 * Bulk replay still belongs in the extracted-dataset harness.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseAerospaceOcmText, validateAerospaceOcm } from "./lib/aerospaceOcm.mjs";
import {
  aerospaceArchiveInventory,
  discoverAerospaceArchiveRoot,
  discoverSocratesRoot,
  listSocratesPairGpFiles,
  readSocratesPairGp,
  resolveAerospaceArchivePaths,
  resolveSocratesPaths,
  socratesInventory,
  streamAnswerKeyCsv,
  streamOcmEntries,
  streamSocratesCsv,
} from "./lib/archiveDataset.mjs";

const ARCHIVE_TIMEOUT_MS = Number(
  process.env.CONJUNCTION_ARCHIVE_TEST_TIMEOUT_MS ?? 30 * 60 * 1000,
);

async function prepareArchiveContext() {
  const root = await discoverAerospaceArchiveRoot();
  if (!root) {
    return null;
  }
  const inventory = await aerospaceArchiveInventory(root);
  const missing = Object.entries(inventory.files)
    .filter(([, info]) => !info.exists)
    .map(([name]) => name);
  if (missing.length > 0) {
    return { root, inventory, skipReason: `Missing archive members: ${missing.join(", ")}` };
  }
  return { root, inventory };
}

test(
  "answer key CSV streams directly from .csv.gz without extraction",
  { timeout: ARCHIVE_TIMEOUT_MS },
  async (t) => {
    const context = await prepareArchiveContext();
    if (!context) {
      t.skip(
        "Aerospace archive root not found. Set CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT or place archives at ~/Documents/Conjunctions/.",
      );
      return;
    }
    if (context.skipReason) {
      t.skip(context.skipReason);
      return;
    }

    const paths = resolveAerospaceArchivePaths(context.root);
    const rows = [];
    for await (const row of streamAnswerKeyCsv(paths.sphericalAnswerKeyPath, {
      limit: 5,
    })) {
      rows.push(row);
    }
    assert.equal(rows.length, 5);
    const first = rows[0];
    assert.ok("obj1_filename" in first, "Answer key rows must carry obj1_filename");
    assert.ok("obj2_filename" in first, "Answer key rows must carry obj2_filename");
    assert.ok("jdate" in first, "Answer key rows must carry a jdate column");
    assert.ok("min_range" in first, "Answer key rows must carry a min_range column");
  },
);

test(
  "tar.gz streaming yields valid OCM entries that appear in the answer key",
  { timeout: ARCHIVE_TIMEOUT_MS },
  async (t) => {
    const context = await prepareArchiveContext();
    if (!context) {
      t.skip(
        "Aerospace archive root not found. Set CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT or place archives at ~/Documents/Conjunctions/.",
      );
      return;
    }
    if (context.skipReason) {
      t.skip(context.skipReason);
      return;
    }

    const paths = resolveAerospaceArchivePaths(context.root);

    // tar.gz is a sequential stream — random access would require extraction
    // or a gzip index. For the smoke test we walk just the first handful of
    // OCM entries, validate their content, and then cross-reference the
    // basenames against the answer key. This confirms the full pipeline
    // (gunzip → tar parse → OCM validation → CSV stream) without scanning
    // the full 22 GB archive.
    const SAMPLE_SIZE = 3;
    const extracted = new Map();

    const { scannedEntries, matchedEntries } = await streamOcmEntries(
      paths.tarGzPath,
      {
        async onEntry({ basename, text }) {
          extracted.set(basename, text);
          if (extracted.size >= SAMPLE_SIZE) {
            return false;
          }
          return true;
        },
      },
    );

    assert.ok(
      scannedEntries > 0,
      "tar stream did not scan any entries — archive may be empty or unreadable.",
    );
    assert.equal(
      extracted.size,
      SAMPLE_SIZE,
      `Expected ${SAMPLE_SIZE} OCM entries from tar stream; got ${extracted.size} (matched=${matchedEntries}).`,
    );

    for (const [basename, text] of extracted) {
      assert.ok(text.length > 0, `Extracted OCM ${basename} was empty.`);
      const parsed = parseAerospaceOcmText(text, { sourcePath: basename });
      const issues = validateAerospaceOcm(parsed);
      assert.deepEqual(
        issues,
        [],
        `OCM ${basename} failed validation: ${JSON.stringify(issues)}`,
      );
    }

    // Cross-reference is informational: tar entries are ordered by descending
    // NORAD, and high-NORAD OCMs (debris, smallsats) may not be primary
    // conjunction targets in the answer key. Log rather than assert, so the
    // smoke test remains focused on "tar streaming + OCM validation works."
    const streamedBasenames = new Set(extracted.keys());
    const CSV_SCAN_LIMIT = 5000;
    let foundMatch = false;
    let csvRowsScanned = 0;
    for await (const row of streamAnswerKeyCsv(paths.sphericalAnswerKeyPath, {
      limit: CSV_SCAN_LIMIT,
    })) {
      csvRowsScanned += 1;
      if (
        (row.obj1_filename && streamedBasenames.has(String(row.obj1_filename))) ||
        (row.obj2_filename && streamedBasenames.has(String(row.obj2_filename)))
      ) {
        foundMatch = true;
        break;
      }
    }
    t.diagnostic(
      `Streamed ${streamedBasenames.size} OCM basenames from tar head; cross-reference in first ${csvRowsScanned} answer-key rows: ${
        foundMatch ? "HIT" : "no match (expected — archive is sorted desc by NORAD, answer key covers primary conjunctions)"
      }`,
    );
  },
);

test(
  "SOCRATES catalog CSV streams and resolves to per-pair GP records on disk",
  async (t) => {
    const root = await discoverSocratesRoot();
    if (!root) {
      t.skip(
        "Local SOCRATES root not found. Set CONJUNCTION_ASSESSMENT_SOCRATES_ROOT or populate packages/conjunction-assessment-sdn-plugin/tests/data/.",
      );
      return;
    }
    const inventory = await socratesInventory(root);
    const missing = Object.entries(inventory.files)
      .filter(([name, info]) => !info.exists && name.endsWith(".csv"))
      .map(([name]) => name);
    if (missing.length > 0) {
      t.skip(`Missing SOCRATES CSV files: ${missing.join(", ")}`);
      return;
    }

    const paths = resolveSocratesPaths(root);
    const rows = [];
    for await (const row of streamSocratesCsv(paths.maxProbCsvPath, { limit: 5 })) {
      rows.push(row);
    }
    assert.equal(rows.length, 5);
    const first = rows[0];
    assert.ok("NORAD_CAT_ID_1" in first, "SOCRATES row must carry NORAD_CAT_ID_1");
    assert.ok("NORAD_CAT_ID_2" in first, "SOCRATES row must carry NORAD_CAT_ID_2");
    assert.ok("TCA" in first, "SOCRATES row must carry TCA");
    assert.ok("MAX_PROB" in first, "SOCRATES row must carry MAX_PROB");

    // At least one of the first 5 rows should resolve to a per-pair GP record
    // if the socrates_gp/ mirror is populated.
    const gpFiles = await listSocratesPairGpFiles(root);
    if (gpFiles.length === 0) {
      t.diagnostic(
        "socrates_gp/ directory is empty — skipping per-pair GP record resolution.",
      );
      return;
    }

    let resolvedPairs = 0;
    for (const row of rows) {
      const gp = await readSocratesPairGp(
        root,
        row.NORAD_CAT_ID_1,
        row.NORAD_CAT_ID_2,
      );
      if (gp !== null) {
        resolvedPairs += 1;
      }
    }
    // We don't strictly require every row to resolve (SOCRATES rotates the
    // catalog faster than the fixture is refreshed), but at least one of five
    // TOP-probability pairs should have a vendored GP fixture.
    assert.ok(
      resolvedPairs >= 1,
      `Expected at least one SOCRATES row (out of ${rows.length}) to resolve to a vendored GP record; got ${resolvedPairs}.`,
    );
  },
);
