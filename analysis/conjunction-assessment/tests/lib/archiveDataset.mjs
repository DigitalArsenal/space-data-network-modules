/**
 * Archive-streaming dataset adapter for the Aerospace IVV conjunction test set.
 *
 * The raw Aerospace distribution lands on disk as an archive bundle:
 *
 *   ~/Documents/Conjunctions/
 *     AerospaceIVVDataset_20251009a.tar.gz                   (~22 GB, all OCMs)
 *     AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz
 *     IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz
 *     IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz
 *     Conjunction_Screening_Testset_Users_Guide.pdf
 *
 * Extracting the tar.gz materializes ~26k OCM files onto disk. That's
 * expensive to re-do on every test run, so this module lets callers stream
 * the archives straight from `~/Documents/Conjunctions/` (or wherever
 * `CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT` points).
 *
 * Two streaming surfaces are exposed:
 *   - `streamAnswerKeyCsv(archivePath)` – pipes `.csv.gz` through gunzip and
 *     yields CSV rows via the existing `readCsvRows` helper. No extraction
 *     required; works even for the 200 MB Spherical answer key.
 *   - `streamOcmEntries(archivePath, { filter })` – walks the tar.gz with
 *     `tar.Parse`, yielding OCM entries whose base filename passes `filter`.
 *     Early-exit is supported by returning `false` from the consumer.
 *
 * For random-access replay across 26k rows, prefer a one-time extraction step
 * — streaming through the 22 GB archive per test is only viable for small
 * samples. `streamOcmEntries` is intended for sanity tests and narrow replays.
 */

import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as tar from "tar";

import { readCsvRows } from "./aerospaceDataset.mjs";

const DEFAULT_ARCHIVE_ROOT_CANDIDATES = Object.freeze([
  process.env.CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT ?? "",
  process.env.AEROSPACE_IVV_ARCHIVE_ROOT ?? "",
  path.join(os.homedir(), "Documents", "Conjunctions"),
]);

export const AEROSPACE_ARCHIVE_FILENAMES = Object.freeze({
  tarGz: "AerospaceIVVDataset_20251009a.tar.gz",
  screeningVolumesCsvGz:
    "AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz",
  sphericalAnswerKeyCsvGz: "IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz",
  sfshAnswerKeyCsvGz: "IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz",
  usersGuidePdf: "Conjunction_Screening_Testset_Users_Guide.pdf",
});

async function pathExists(targetPath) {
  if (!targetPath) {
    return false;
  }
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe each candidate archive-root directory in order and return the first
 * that exists. Returns null if none are present.
 */
export async function discoverAerospaceArchiveRoot(candidates = DEFAULT_ARCHIVE_ROOT_CANDIDATES) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveAerospaceArchivePaths(root) {
  return Object.freeze({
    root,
    tarGzPath: path.join(root, AEROSPACE_ARCHIVE_FILENAMES.tarGz),
    sphericalAnswerKeyPath: path.join(
      root,
      AEROSPACE_ARCHIVE_FILENAMES.sphericalAnswerKeyCsvGz,
    ),
    sfshAnswerKeyPath: path.join(
      root,
      AEROSPACE_ARCHIVE_FILENAMES.sfshAnswerKeyCsvGz,
    ),
    screeningVolumesPath: path.join(
      root,
      AEROSPACE_ARCHIVE_FILENAMES.screeningVolumesCsvGz,
    ),
    usersGuidePath: path.join(
      root,
      AEROSPACE_ARCHIVE_FILENAMES.usersGuidePdf,
    ),
  });
}

export async function aerospaceArchiveInventory(root) {
  const paths = resolveAerospaceArchivePaths(root);
  const entries = [
    paths.tarGzPath,
    paths.sphericalAnswerKeyPath,
    paths.sfshAnswerKeyPath,
    paths.screeningVolumesPath,
    paths.usersGuidePath,
  ];
  const available = {};
  for (const entryPath of entries) {
    const exists = await pathExists(entryPath);
    let size = null;
    if (exists) {
      try {
        const stats = await stat(entryPath);
        size = Number(stats.size);
      } catch {
        size = null;
      }
    }
    available[path.basename(entryPath)] = {
      path: entryPath,
      exists,
      sizeBytes: size,
    };
  }
  return {
    root,
    files: available,
  };
}

/**
 * Stream a single `.csv.gz` archive, yielding parsed row objects.
 *
 * Thin wrapper over the shared `readCsvRows` helper (which already handles
 * gzip) so callers can reach for one import per archive surface.
 */
export async function* streamAnswerKeyCsv(archivePath, options = {}) {
  for await (const row of readCsvRows(archivePath, options)) {
    yield row;
  }
}

/**
 * Stream through an Aerospace tar.gz archive, invoking `onEntry` for each
 * `.ocm` file whose base filename passes the provided predicate.
 *
 * `onEntry` receives `{ basename, relativePath, text }` and can return a
 * Promise. Returning `false` from `onEntry` (or resolving to `false`) causes
 * the stream to abort early — useful for extracting only the first N matches.
 *
 * Returns `{ scannedEntries, matchedEntries, stoppedEarly }`.
 */
export async function streamOcmEntries(archivePath, options = {}) {
  const { filter, onEntry, suffix = ".ocm" } = options;
  if (typeof onEntry !== "function") {
    throw new TypeError("streamOcmEntries requires an onEntry callback.");
  }

  let scannedEntries = 0;
  let matchedEntries = 0;
  let stoppedEarly = false;

  const stream = createReadStream(archivePath).pipe(zlib.createGunzip());
  const parser = new tar.Parser();

  await new Promise((resolve, reject) => {
    let pendingEntryPromises = Promise.resolve();

    const stopStream = () => {
      stoppedEarly = true;
      try {
        parser.removeAllListeners("entry");
      } catch {}
      try {
        stream.unpipe(parser);
        stream.destroy();
      } catch {}
      try {
        parser.end();
      } catch {}
    };

    parser.on("entry", (entry) => {
      scannedEntries += 1;

      if (
        entry.type !== "File" ||
        !entry.path.endsWith(suffix) ||
        stoppedEarly
      ) {
        entry.resume();
        return;
      }

      const relativePath = entry.path;
      const basename = path.basename(relativePath);

      const predicateResult =
        typeof filter === "function" ? filter(basename, relativePath) : true;

      if (!predicateResult) {
        entry.resume();
        return;
      }

      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("error", reject);
      const entryEnd = new Promise((resolveEntry, rejectEntry) => {
        entry.on("end", resolveEntry);
        entry.on("error", rejectEntry);
      });

      pendingEntryPromises = pendingEntryPromises.then(async () => {
        await entryEnd;
        matchedEntries += 1;
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          const result = await onEntry({
            basename,
            relativePath,
            text,
          });
          if (result === false) {
            stopStream();
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    stream.on("error", reject);
    parser.on("error", reject);
    parser.on("end", () => {
      pendingEntryPromises.then(resolve, reject);
    });
    parser.on("close", () => {
      pendingEntryPromises.then(resolve, reject);
    });

    stream.pipe(parser);
  });

  return { scannedEntries, matchedEntries, stoppedEarly };
}

/**
 * Convenience: collect OCM entries matching a set of basenames in a single
 * tar.gz pass. Useful for validating that a handful of answer-key rows map
 * cleanly to the archive.
 */
export async function extractOcmEntriesByBasename(archivePath, basenames) {
  const wanted = new Set(basenames);
  const out = new Map();
  const { scannedEntries } = await streamOcmEntries(archivePath, {
    filter: (basename) => wanted.has(basename),
    async onEntry({ basename, text }) {
      out.set(basename, text);
      if (out.size >= wanted.size) {
        return false;
      }
      return true;
    },
  });
  return { entries: out, scannedEntries };
}

export async function formatArchiveInventoryMessage(root) {
  const inventory = await aerospaceArchiveInventory(root);
  const lines = [`Aerospace archive root: ${inventory.root}`];
  for (const [name, info] of Object.entries(inventory.files)) {
    const status = info.exists
      ? `${(info.sizeBytes / 1024 ** 3).toFixed(2)} GB`
      : "MISSING";
    lines.push(`  - ${name}: ${status}`);
  }
  return lines.join("\n");
}

/**
 * Legacy: if a caller still expects to call `readFile` against a guide PDF
 * this exposes the raw buffer rather than attempting to parse it.
 */
export async function readUsersGuidePdf(root) {
  const paths = resolveAerospaceArchivePaths(root);
  return readFile(paths.usersGuidePath);
}

export async function listAerospaceArchiveDirectory(root) {
  return readdir(root);
}

// ---------------------------------------------------------------------------
// SOCRATES / CelesTrak dataset discovery.
//
// The full SOCRATES catalog (~120k conjunction rows) and per-pair GP records
// currently live alongside the legacy OrbPro plugin wrapper at
// `packages/conjunction-assessment-sdn-plugin/tests/data/`. That tree is
// outside the submodule and will move as part of the broader migration, but
// for now it's the source of truth for local SOCRATES validation runs.
// ---------------------------------------------------------------------------

const DEFAULT_SOCRATES_ROOT_CANDIDATES = Object.freeze([
  process.env.CONJUNCTION_ASSESSMENT_SOCRATES_ROOT ?? "",
  process.env.SOCRATES_LOCAL_ROOT ?? "",
  // Monorepo-relative fallbacks — relative to this file's location within
  // `<submodule>/packages/conjunction-assessment/tests/lib/`, walk up to the
  // OrbPro workspace and land on the legacy plugin wrapper.
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "conjunction-assessment-sdn-plugin",
    "tests",
    "data",
  ),
  path.join(
    os.homedir(),
    "software",
    "OrbPro",
    "packages",
    "conjunction-assessment-sdn-plugin",
    "tests",
    "data",
  ),
]);

export const SOCRATES_FILENAMES = Object.freeze({
  currentCsv: "socrates_current.csv",
  fullCsv: "socrates_full.csv",
  maxProbCsv: "socrates_maxprob.csv",
  minRangeCsv: "socrates_minrange_current.csv",
  noradIdsTxt: "socrates_norad_ids.txt",
  perPairGpDir: "socrates_gp",
});

export async function discoverSocratesRoot(candidates = DEFAULT_SOCRATES_ROOT_CANDIDATES) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Require the catalog CSV to be present before accepting a candidate — a
    // bare dir with no SOCRATES files is not a valid root.
    const sentinel = path.join(candidate, SOCRATES_FILENAMES.maxProbCsv);
    if (await pathExists(sentinel)) {
      return candidate;
    }
  }
  return null;
}

export function resolveSocratesPaths(root) {
  return Object.freeze({
    root,
    currentCsvPath: path.join(root, SOCRATES_FILENAMES.currentCsv),
    fullCsvPath: path.join(root, SOCRATES_FILENAMES.fullCsv),
    maxProbCsvPath: path.join(root, SOCRATES_FILENAMES.maxProbCsv),
    minRangeCsvPath: path.join(root, SOCRATES_FILENAMES.minRangeCsv),
    noradIdsTxtPath: path.join(root, SOCRATES_FILENAMES.noradIdsTxt),
    perPairGpDir: path.join(root, SOCRATES_FILENAMES.perPairGpDir),
  });
}

export async function socratesInventory(root) {
  const paths = resolveSocratesPaths(root);
  const files = {};
  for (const [key, value] of Object.entries(paths)) {
    if (key === "root") continue;
    const exists = await pathExists(value);
    let sizeBytes = null;
    if (exists) {
      try {
        const stats = await stat(value);
        sizeBytes = Number(stats.size);
      } catch {
        sizeBytes = null;
      }
    }
    files[path.basename(value)] = { path: value, exists, sizeBytes };
  }
  return { root, files };
}

/**
 * Stream a SOCRATES CSV (plain, not gzipped) and yield parsed rows.
 * Handles the standard header:
 *   NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,
 *   TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION
 */
export async function* streamSocratesCsv(csvPath, options = {}) {
  for await (const row of readCsvRows(csvPath, options)) {
    yield row;
  }
}

/**
 * Resolve the per-pair GP records for a conjunction. Returns parsed JSON if
 * the file exists, otherwise null.
 */
export async function readSocratesPairGp(root, norad1, norad2) {
  const paths = resolveSocratesPaths(root);
  const fileName = `gp_${norad1},${norad2}.json`;
  const filePath = path.join(paths.perPairGpDir, fileName);
  if (!(await pathExists(filePath))) {
    return null;
  }
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

export async function listSocratesPairGpFiles(root) {
  const paths = resolveSocratesPaths(root);
  if (!(await pathExists(paths.perPairGpDir))) {
    return [];
  }
  const entries = await readdir(paths.perPairGpDir);
  return entries.filter((name) => name.startsWith("gp_") && name.endsWith(".json")).sort();
}

export async function formatSocratesInventoryMessage(root) {
  const inventory = await socratesInventory(root);
  const lines = [`SOCRATES root: ${inventory.root}`];
  for (const [name, info] of Object.entries(inventory.files)) {
    const status = info.exists
      ? info.sizeBytes !== null
        ? `${(info.sizeBytes / 1024 ** 2).toFixed(2)} MB`
        : "present (size unknown)"
      : "MISSING";
    lines.push(`  - ${name}: ${status}`);
  }
  return lines.join("\n");
}
