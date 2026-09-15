import path from "node:path";
import { fileURLToPath } from "node:url";

// Canonical plugin loader for the conjunction-assessment wasm artifact lives
// at the submodule package root. The old OrbPro wrapper path was retired during
// the SDK 0.8 module migration.
import { createConjunctionAssessmentPlugin } from "../../index.js";

import {
  listOcmDirectoryEntries,
  readCsvRows,
  readOcmDirectoryEntryText,
} from "./aerospaceDataset.mjs";
import { parseAerospaceOcmText } from "./aerospaceOcm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const LOCAL_AEROSPACE_EXTRACTED_ROOT = path.join(
  PACKAGE_ROOT,
  "tests",
  "data",
  "aerospace-ivv",
);
const DEFAULT_AEROSPACE_EXTRACTED_ROOT =
  process.env.AEROSPACE_IVV_EXTRACTED_ROOT ||
  process.env.CONJUNCTION_AEROSPACE_IVV_EXTRACTED_ROOT ||
  LOCAL_AEROSPACE_EXTRACTED_ROOT;
const DEFAULT_PLUGIN_BATCH_SIZE = 10;
const DEFAULT_TRACK_CACHE_SIZE = 32;
const DEFAULT_WINDOW_LEAD_SEC = 2 * 60;
const DEFAULT_WINDOW_LAG_SEC = 2 * 60;
const DEFAULT_RESAMPLE_STEP_SEC = 1;
const DEFAULT_COARSE_STEP_SEC = 1;
const DEFAULT_FINE_TOL_SEC = 0.001;
const DEFAULT_TCA_TOLERANCE_SEC = 0.01;
const DEFAULT_RANGE_TOLERANCE_KM = 0.01;

function numberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createLruCache(maxEntries) {
  const cache = new Map();
  let hitCount = 0;
  let missCount = 0;
  let evictionCount = 0;

  function touch(key, value) {
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  return {
    get(key) {
      if (!cache.has(key)) {
        missCount++;
        return undefined;
      }
      hitCount++;
      return touch(key, cache.get(key));
    },

    set(key, value) {
      if (!(maxEntries > 0)) {
        return value;
      }
      touch(key, value);
      while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
        evictionCount++;
      }
      return value;
    },

    stats() {
      return {
        size: cache.size,
        hitCount,
        missCount,
        evictionCount,
      };
    },
  };
}

function normalizeAnswerKeyRow(row, sourceRowIndex) {
  const expectedTcaJd = Number(row.jdate);
  const expectedMinRangeKm = Number(row.min_range);
  const obj1Filename = String(row.obj1_filename ?? "").trim();
  const obj2Filename = String(row.obj2_filename ?? "").trim();

  if (!Number.isFinite(expectedTcaJd)) {
    throw new Error(`Row ${sourceRowIndex} has invalid jdate.`);
  }
  if (!Number.isFinite(expectedMinRangeKm)) {
    throw new Error(`Row ${sourceRowIndex} has invalid min_range.`);
  }
  if (!obj1Filename || !obj2Filename) {
    throw new Error(`Row ${sourceRowIndex} is missing OCM filenames.`);
  }

  return {
    sourceRowIndex,
    conjId: String(row.conj_id ?? "").trim() || null,
    obj1: numberOrDefault(row.obj1, 0),
    obj2: numberOrDefault(row.obj2, 0),
    obj1Filename,
    obj2Filename,
    expectedTcaJd,
    expectedMinRangeKm,
  };
}

function shouldSelectRow(sourceRowIndex, options, selectedSoFar) {
  const shardCount = numberOrDefault(options.shardCount, 1);
  const shardIndex = numberOrDefault(options.shardIndex, 0);
  const offset = Math.max(0, numberOrDefault(options.offset, 0));
  const limit = numberOrDefault(options.limit, Number.POSITIVE_INFINITY);

  if (shardCount > 1 && sourceRowIndex % shardCount !== shardIndex) {
    return false;
  }
  if (selectedSoFar < offset) {
    return false;
  }
  if (selectedSoFar - offset >= limit) {
    return false;
  }
  return true;
}

// Preserve authoritative source samples. C++ OEM interpolation owns all
// trajectory evaluation; the host only selects a window with bracketing rows.
function buildReplayTrackFromOcm(ocm, options = {}) {
  const samples = ocm?.primaryTrajectory?.samples ?? [];
  if (samples.length < 2) throw new Error(`OCM ${ocm.sourcePath} requires at least two samples.`);
  const start = Number(options.centerJd) - Number(options.windowLeadSec) / 86400;
  const stop = Number(options.centerJd) + Number(options.windowLagSec) / 86400;
  let first = samples.findIndex(s => s.epochJD >= start);
  if (first < 0) first = samples.length - 1;
  first = Math.max(0, first - 1);
  let last = samples.findIndex(s => s.epochJD >= stop);
  if (last < 0) last = samples.length - 1;
  return { object_name: ocm.objectName, object_id: ocm.objectId || String(ocm.objectDesignator), norad_cat_id: Number(ocm.objectDesignator ?? 0), reference_frame: ocm.referenceFrame,
    samples: samples.slice(first, last + 1).map(s => ({ EPOCH: s.epoch, jd: s.epochJD, x_km: s.positionKm.x, y_km: s.positionKm.y, z_km: s.positionKm.z, vx_km_s: s.velocityKmS.x, vy_km_s: s.velocityKmS.y, vz_km_s: s.velocityKmS.z })) };
}

async function loadOcmByFilename(filename, context) {
  const cached = context.trackCache.get(filename);
  if (cached) {
    return cached;
  }

  const entryPath = context.ocmBasenameIndex.get(filename);
  if (!entryPath) {
    throw new Error(`No extracted OCM entry found for ${filename}.`);
  }

  const text = await readOcmDirectoryEntryText(context.ocmRoot, entryPath);
  const ocm = parseAerospaceOcmText(text, { sourcePath: entryPath });
  context.trackLoads++;
  context.trackCache.set(filename, ocm);
  return ocm;
}

function buildMismatchRecord(row, result, tcaDeltaSec, rangeDeltaKm) {
  return {
    sourceRowIndex: row.sourceRowIndex,
    conjId: row.conjId,
    obj1: row.obj1,
    obj2: row.obj2,
    obj1Filename: row.obj1Filename,
    obj2Filename: row.obj2Filename,
    expectedTcaJd: row.expectedTcaJd,
    actualTcaJd: Number(result?.tca_jd ?? Number.NaN),
    tcaDeltaSec,
    expectedMinRangeKm: row.expectedMinRangeKm,
    actualMinRangeKm: Number(result?.min_range_km ?? Number.NaN),
    rangeDeltaKm,
  };
}

function buildErrorRecord(row, error) {
  return {
    sourceRowIndex: row.sourceRowIndex,
    conjId: row.conjId,
    obj1: row.obj1,
    obj2: row.obj2,
    obj1Filename: row.obj1Filename,
    obj2Filename: row.obj2Filename,
    message: error instanceof Error ? error.message : String(error),
  };
}

function maybePushLimited(list, value, limit) {
  if (list.length < limit) {
    list.push(value);
  }
}

async function processReplayBatch(batch, context) {
  if (batch.length === 0) {
    return;
  }

  const plugin = await context.createPlugin();
  context.pluginInstancesCreated++;

  try {
    for (const row of batch) {
      try {
        const [primaryOcm, secondaryOcm] = await Promise.all([
          loadOcmByFilename(row.obj1Filename, context),
          loadOcmByFilename(row.obj2Filename, context),
        ]);
        const primaryTrack = buildReplayTrackFromOcm(primaryOcm, {
          centerJd: row.expectedTcaJd,
          windowLeadSec: context.windowLeadSec,
          windowLagSec: context.windowLagSec,
          resampleStepSec: context.resampleStepSec,
        });
        const secondaryTrack = buildReplayTrackFromOcm(secondaryOcm, {
          centerJd: row.expectedTcaJd,
          windowLeadSec: context.windowLeadSec,
          windowLagSec: context.windowLagSec,
          resampleStepSec: context.resampleStepSec,
        });
        const result = plugin.assessConjunction({
          primary_track: primaryTrack,
          secondary_track: secondaryTrack,
          start_jd: row.expectedTcaJd - context.windowLeadDays,
          duration_days: context.windowDurationDays,
          coarse_step_sec: context.coarseStepSec,
          fine_tol_sec: context.fineTolSec,
        });
        const tcaDeltaSec =
          Math.abs(Number(result?.tca_jd ?? Number.NaN) - row.expectedTcaJd) *
          86400.0;
        const rangeDeltaKm = Math.abs(
          Number(result?.min_range_km ?? Number.NaN) - row.expectedMinRangeKm,
        );

        context.testedRows++;
        context.maxTcaDeltaSec = Math.max(context.maxTcaDeltaSec, tcaDeltaSec);
        context.maxRangeDeltaKm = Math.max(
          context.maxRangeDeltaKm,
          rangeDeltaKm,
        );

        if (
          tcaDeltaSec <= context.tcaToleranceSec &&
          rangeDeltaKm <= context.rangeToleranceKm
        ) {
          context.matchedRows++;
        } else {
          context.mismatchCount++;
          maybePushLimited(
            context.mismatches,
            buildMismatchRecord(row, result, tcaDeltaSec, rangeDeltaKm),
            context.maxRecordedMismatches,
          );
        }
      } catch (error) {
        context.testedRows++;
        context.errorCount++;
        maybePushLimited(
          context.errors,
          buildErrorRecord(row, error),
          context.maxRecordedErrors,
        );
      }

      if (
        context.progressEvery > 0 &&
        context.testedRows > 0 &&
        context.testedRows % context.progressEvery === 0 &&
        typeof context.onProgress === "function"
      ) {
        context.onProgress(createReplaySummary(context));
      }
    }
  } finally {
    plugin?.destroy?.();
  }
}

function createReplaySummary(context) {
  const cacheStats = context.trackCache.stats();
  return {
    mode: context.mode,
    answerKeyPath: context.answerKeyPath,
    ocmRoot: context.ocmRoot,
    indexedOcmCount: context.ocmBasenameIndex.size,
    testedRows: context.testedRows,
    matchedRows: context.matchedRows,
    mismatchCount: context.mismatchCount,
    errorCount: context.errorCount,
    maxTcaDeltaSec: context.maxTcaDeltaSec,
    maxRangeDeltaKm: context.maxRangeDeltaKm,
    pluginBatchSize: context.pluginBatchSize,
    pluginInstancesCreated: context.pluginInstancesCreated,
    trackCacheSize: context.trackCacheSize,
    trackLoads: context.trackLoads,
    trackCacheHits: cacheStats.hitCount,
    trackCacheMisses: cacheStats.missCount,
    trackCacheEvictions: cacheStats.evictionCount,
    cachedTracks: cacheStats.size,
    elapsedMs: Date.now() - context.startedAt,
    mismatches: context.mismatches,
    errors: context.errors,
  };
}

export function getDefaultAerospaceReplayPaths(
  extractedRoot = DEFAULT_AEROSPACE_EXTRACTED_ROOT,
) {
  return {
    extractedRoot,
    ocmRoot: path.join(
      extractedRoot,
      "ocm",
      "AerospaceIVVDataset_20251009",
    ),
    sphericalAnswerKeyPath: path.join(
      extractedRoot,
      "csv",
      "IVV_Releasable_Dataset_Spherical_DefaultHBR.csv",
    ),
    sfshAnswerKeyPath: path.join(
      extractedRoot,
      "csv",
      "IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv",
    ),
  };
}

export async function buildAerospaceOcmBasenameIndex(ocmRoot) {
  const index = new Map();
  const entries = await listOcmDirectoryEntries(ocmRoot);

  for (const entry of entries) {
    const basename = path.basename(entry);
    const existing = index.get(basename);
    if (existing && existing !== entry) {
      throw new Error(
        `Duplicate Aerospace OCM basename ${basename}: ${existing} and ${entry}.`,
      );
    }
    index.set(basename, entry);
  }

  return index;
}

export async function runAerospaceAnswerKeyReplay(options = {}) {
  const defaults = getDefaultAerospaceReplayPaths(options.extractedRoot);
  const answerKeyPath =
    options.answerKeyPath ?? defaults.sphericalAnswerKeyPath;
  const ocmRoot = options.ocmRoot ?? defaults.ocmRoot;
  const mode = String(options.mode ?? "track");

  if (mode !== "track") {
    throw new Error(`Unsupported Aerospace replay mode: ${mode}`);
  }

  const pluginBatchSize = Math.max(
    1,
    numberOrDefault(options.pluginBatchSize, DEFAULT_PLUGIN_BATCH_SIZE),
  );
  const trackCacheSize = Math.max(
    0,
    numberOrDefault(options.trackCacheSize, DEFAULT_TRACK_CACHE_SIZE),
  );
  const maxRecordedMismatches = Math.max(
    0,
    numberOrDefault(options.maxRecordedMismatches, 50),
  );
  const maxRecordedErrors = Math.max(
    0,
    numberOrDefault(options.maxRecordedErrors, maxRecordedMismatches),
  );
  const windowLeadSec = Math.max(
    0,
    numberOrDefault(options.windowLeadSec, DEFAULT_WINDOW_LEAD_SEC),
  );
  const windowLagSec = Math.max(
    0,
    numberOrDefault(options.windowLagSec, DEFAULT_WINDOW_LAG_SEC),
  );
  const context = {
    mode,
    answerKeyPath,
    ocmRoot,
    pluginBatchSize,
    trackCacheSize,
    tcaToleranceSec: Math.max(
      0,
      numberOrDefault(options.tcaToleranceSec, DEFAULT_TCA_TOLERANCE_SEC),
    ),
    rangeToleranceKm: Math.max(
      0,
      numberOrDefault(options.rangeToleranceKm, DEFAULT_RANGE_TOLERANCE_KM),
    ),
    windowLeadSec,
    windowLagSec,
    resampleStepSec: Math.max(
      0.1,
      numberOrDefault(options.resampleStepSec, DEFAULT_RESAMPLE_STEP_SEC),
    ),
    coarseStepSec: Math.max(
      0.1,
      numberOrDefault(options.coarseStepSec, DEFAULT_COARSE_STEP_SEC),
    ),
    fineTolSec: Math.max(
      1e-6,
      numberOrDefault(options.fineTolSec, DEFAULT_FINE_TOL_SEC),
    ),
    windowLeadDays: windowLeadSec / 86400.0,
    windowDurationDays: (windowLeadSec + windowLagSec) / 86400.0,
    progressEvery: Math.max(0, numberOrDefault(options.progressEvery, 0)),
    onProgress:
      typeof options.onProgress === "function" ? options.onProgress : null,
    maxRecordedMismatches,
    maxRecordedErrors,
    createPlugin:
      typeof options.createPlugin === "function"
        ? options.createPlugin
        : () =>
            createConjunctionAssessmentPlugin({
              requireEmbeddedManifest: true,
            }),
    ocmBasenameIndex:
      options.ocmBasenameIndex instanceof Map
        ? options.ocmBasenameIndex
        : await buildAerospaceOcmBasenameIndex(ocmRoot),
    trackCache: createLruCache(trackCacheSize),
    startedAt: Date.now(),
    testedRows: 0,
    matchedRows: 0,
    mismatchCount: 0,
    errorCount: 0,
    maxTcaDeltaSec: 0,
    maxRangeDeltaKm: 0,
    pluginInstancesCreated: 0,
    trackLoads: 0,
    mismatches: [],
    errors: [],
  };

  let sourceRowIndex = 0;
  let selectedRowsSeen = 0;
  const batch = [];

  for await (const rawRow of readCsvRows(answerKeyPath)) {
    const limit = numberOrDefault(options.limit, Number.POSITIVE_INFINITY);
    const offset = Math.max(0, numberOrDefault(options.offset, 0));
    if (
      Number.isFinite(limit) &&
      selectedRowsSeen >= offset + limit &&
      numberOrDefault(options.shardCount, 1) <= 1
    ) {
      break;
    }

    const selected = shouldSelectRow(sourceRowIndex, options, selectedRowsSeen);
    if (selected) {
      batch.push(normalizeAnswerKeyRow(rawRow, sourceRowIndex));
    }

    if (
      numberOrDefault(options.shardCount, 1) <= 1 ||
      sourceRowIndex % numberOrDefault(options.shardCount, 1) ===
        numberOrDefault(options.shardIndex, 0)
    ) {
      selectedRowsSeen++;
    }
    sourceRowIndex++;

    if (batch.length >= pluginBatchSize) {
      await processReplayBatch(batch, context);
      batch.length = 0;
      const limitRequested = numberOrDefault(
        options.limit,
        Number.POSITIVE_INFINITY,
      );
      if (context.testedRows >= limitRequested) {
        break;
      }
    }
  }

  await processReplayBatch(batch, context);
  return createReplaySummary(context);
}
