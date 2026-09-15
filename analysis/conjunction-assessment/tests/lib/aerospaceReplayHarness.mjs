import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listOcmDirectoryEntries,
  readCsvRows,
  readOcmDirectoryEntryText,
} from "./aerospaceDataset.mjs";
import { parseAerospaceOcmText } from "./aerospaceOcm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
export const LOCAL_AEROSPACE_DATASET_ROOT = path.join(
  PACKAGE_ROOT,
  "tests",
  "data",
  "aerospace-ivv",
);
const LOCAL_AEROSPACE_DATASET_DISPLAY_ROOT = "tests/data/aerospace-ivv";
const DEFAULT_AEROSPACE_EXTRACTED_ROOT =
  process.env.AEROSPACE_IVV_EXTRACTED_ROOT ||
  process.env.CONJUNCTION_AEROSPACE_IVV_EXTRACTED_ROOT ||
  LOCAL_AEROSPACE_DATASET_ROOT;
const DEFAULT_PLUGIN_BATCH_SIZE = 10;
const DEFAULT_TRACK_CACHE_SIZE = 32;
const DEFAULT_WINDOW_LEAD_SEC = 2 * 60;
const DEFAULT_WINDOW_LAG_SEC = 2 * 60;
const DEFAULT_RESAMPLE_STEP_SEC = 1;
const DEFAULT_TCA_TOLERANCE_SEC = 0.01;
const DEFAULT_RANGE_TOLERANCE_KM = 0.01;
const REQUIRED_AEROSPACE_LAYOUT = [
  "docs/Conjunction_Screening_Testset_Users_Guide.txt",
  "csv/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv",
  "csv/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv",
  "csv/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv",
  "ocm/AerospaceIVVDataset_20251009/...",
];

export function formatAerospaceDatasetSetupMessage(root = DEFAULT_AEROSPACE_EXTRACTED_ROOT) {
  const displayRoot =
    root === LOCAL_AEROSPACE_DATASET_ROOT
      ? LOCAL_AEROSPACE_DATASET_DISPLAY_ROOT
      : root;
  return [
    `Place the extracted Aerospace dataset under ${displayRoot} or override with AEROSPACE_IVV_EXTRACTED_ROOT.`,
    "Expected layout:",
    ...REQUIRED_AEROSPACE_LAYOUT.map((entry) => `- ${entry}`),
  ].join("\n");
}

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
        missCount += 1;
        return undefined;
      }
      hitCount += 1;
      return touch(key, cache.get(key));
    },

    set(key, value) {
      if (!(maxEntries > 0)) {
        return value;
      }
      touch(key, value);
      while (cache.size > maxEntries) {
        cache.delete(cache.keys().next().value);
        evictionCount += 1;
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
    samples: samples.slice(first, last + 1).map(s => ({ EPOCH: s.epoch, epochJD: s.epochJD, x_km: s.positionKm.x, y_km: s.positionKm.y, z_km: s.positionKm.z, vx_km_s: s.velocityKmS.x, vy_km_s: s.velocityKmS.y, vz_km_s: s.velocityKmS.z })) };
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
  context.trackLoads += 1;
  context.trackCache.set(filename, ocm);
  return ocm;
}

function buildMismatchRecord(row, result, tcaDeltaSec, rangeDeltaKm) {
  return {
    sourceRowIndex: row.sourceRowIndex,
    conjId: row.conjId,
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

  const harness = await context.createHarness();
  context.pluginInstancesCreated += 1;

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

        const { json: result } = await context.invokeHarness(harness, {
          operation: "assessTracks",
          params: {
            primary_track: primaryTrack,
            secondary_track: secondaryTrack,
            tca_hint_jd: row.expectedTcaJd,
            window_hours:
              (context.windowLeadSec + context.windowLagSec) / 7200.0,
          },
        });

        const tcaDeltaSec =
          Math.abs(Number(result?.tca_jd ?? Number.NaN) - row.expectedTcaJd) *
          86400.0;
        const rangeDeltaKm = Math.abs(
          Number(result?.min_range_km ?? Number.NaN) - row.expectedMinRangeKm,
        );

        context.testedRows += 1;
        context.maxTcaDeltaSec = Math.max(context.maxTcaDeltaSec, tcaDeltaSec);
        context.maxRangeDeltaKm = Math.max(context.maxRangeDeltaKm, rangeDeltaKm);

        if (
          tcaDeltaSec <= context.tcaToleranceSec &&
          rangeDeltaKm <= context.rangeToleranceKm
        ) {
          context.matchedRows += 1;
        } else {
          context.mismatchCount += 1;
          maybePushLimited(
            context.mismatches,
            buildMismatchRecord(row, result, tcaDeltaSec, rangeDeltaKm),
            context.maxRecordedMismatches,
          );
        }
      } catch (error) {
        context.testedRows += 1;
        context.errorCount += 1;
        maybePushLimited(
          context.errors,
          buildErrorRecord(row, error),
          context.maxRecordedErrors,
        );
      }
    }
  } finally {
    await harness.destroy?.();
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
    mismatches: context.mismatches,
    errors: context.errors,
  };
}

function normalizeAnswerKeyRow(row, sourceRowIndex) {
  return {
    sourceRowIndex,
    conjId: String(row.conj_id ?? "").trim() || null,
    obj1Filename: String(row.obj1_filename ?? "").trim(),
    obj2Filename: String(row.obj2_filename ?? "").trim(),
    expectedTcaJd: Number(row.jdate),
    expectedMinRangeKm: Number(row.min_range),
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

export function getDefaultAerospaceReplayPaths(extractedRoot = DEFAULT_AEROSPACE_EXTRACTED_ROOT) {
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
  const answerKeyPath = options.answerKeyPath ?? defaults.sphericalAnswerKeyPath;
  const ocmRoot = options.ocmRoot ?? defaults.ocmRoot;
  const mode = String(options.mode ?? "track");
  if (mode !== "track") {
    throw new Error(`Unsupported Aerospace replay mode: ${mode}`);
  }

  const context = {
    mode,
    answerKeyPath,
    ocmRoot,
    pluginBatchSize: Math.max(
      1,
      numberOrDefault(options.pluginBatchSize, DEFAULT_PLUGIN_BATCH_SIZE),
    ),
    trackCacheSize: Math.max(
      0,
      numberOrDefault(options.trackCacheSize, DEFAULT_TRACK_CACHE_SIZE),
    ),
    tcaToleranceSec: Math.max(
      0,
      numberOrDefault(options.tcaToleranceSec, DEFAULT_TCA_TOLERANCE_SEC),
    ),
    rangeToleranceKm: Math.max(
      0,
      numberOrDefault(options.rangeToleranceKm, DEFAULT_RANGE_TOLERANCE_KM),
    ),
    windowLeadSec: Math.max(
      0,
      numberOrDefault(options.windowLeadSec, DEFAULT_WINDOW_LEAD_SEC),
    ),
    windowLagSec: Math.max(
      0,
      numberOrDefault(options.windowLagSec, DEFAULT_WINDOW_LAG_SEC),
    ),
    resampleStepSec: Math.max(
      0.1,
      numberOrDefault(options.resampleStepSec, DEFAULT_RESAMPLE_STEP_SEC),
    ),
    maxRecordedMismatches: Math.max(
      0,
      numberOrDefault(options.maxRecordedMismatches, 50),
    ),
    maxRecordedErrors: Math.max(
      0,
      numberOrDefault(
        options.maxRecordedErrors,
        numberOrDefault(options.maxRecordedMismatches, 50),
      ),
    ),
    createHarness: options.createHarness,
    invokeHarness: options.invokeHarness,
    ocmBasenameIndex:
      options.ocmBasenameIndex instanceof Map
        ? options.ocmBasenameIndex
        : await buildAerospaceOcmBasenameIndex(ocmRoot),
    trackCache: createLruCache(
      Math.max(0, numberOrDefault(options.trackCacheSize, DEFAULT_TRACK_CACHE_SIZE)),
    ),
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
      selectedRowsSeen += 1;
    }
    sourceRowIndex += 1;

    if (batch.length >= context.pluginBatchSize) {
      await processReplayBatch(batch, context);
      batch.length = 0;
      if (context.testedRows >= limit) {
        break;
      }
    }
  }

  await processReplayBatch(batch, context);
  return createReplaySummary(context);
}
