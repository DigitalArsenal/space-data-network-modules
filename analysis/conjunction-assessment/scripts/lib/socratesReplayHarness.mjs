import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Canonical plugin loader for the conjunction-assessment wasm artifact lives
// at the submodule package root. The old OrbPro wrapper path was retired during
// the SDK 0.8 module migration.
import { createConjunctionAssessmentPlugin } from "../../index.js";

import { maybeWriteJson, parseCsvLine } from "./aerospaceDataset.mjs";
import {
  defaultCelestrakCacheDir,
  fetchCachedText,
} from "./celestrakFetchCache.mjs";

const DEFAULT_BASE_URL = "https://celestrak.org/SOCRATES";
const DEFAULT_SORT = "maxProb";
const DEFAULT_LIMIT = 5;
const DEFAULT_RATE_MS = 200;
const DEFAULT_WINDOW_LEAD_DAYS = 3.5;
const DEFAULT_WINDOW_DURATION_DAYS = 7;
const DEFAULT_THRESHOLD_KM = 5;
const DEFAULT_TCA_TOLERANCE_SEC = 60;
const DEFAULT_RANGE_TOLERANCE_KM = 0.5;
const DEFAULT_SPEED_TOLERANCE_KM_S = 0.5;
const DEFAULT_PROBABILITY_RATIO_TOLERANCE = 100;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CSV_TIMEOUT_MS = 60000;
const DEFAULT_MAX_SCAN_ROWS = 25;

function numberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sleep(ms) {
  if (!(ms > 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIsoString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes("T")) {
    return raw.endsWith("Z") ? raw : `${raw}Z`;
  }
  return `${raw.replace(" ", "T")}Z`;
}

function isoToJd(value) {
  const millis = Date.parse(String(value ?? ""));
  if (!Number.isFinite(millis)) {
    return Number.NaN;
  }
  return millis / 86400000 + 2440587.5;
}

function computeProbabilityRatio(actual, expected) {
  const actualNumeric = Number(actual);
  const expectedNumeric = Number(expected);
  if (actualNumeric === 0 && expectedNumeric === 0) {
    return 1;
  }
  if (!(actualNumeric > 0) || !(expectedNumeric > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    actualNumeric / expectedNumeric,
    expectedNumeric / actualNumeric,
  );
}

function buildMismatchRecord(row, result, deltas) {
  return {
    sourceRowIndex: row.sourceRowIndex,
    obj1Norad: row.obj1Norad,
    obj2Norad: row.obj2Norad,
    tcaIso: row.tcaIso,
    expectedMinRangeKm: row.minRangeKm,
    expectedRelSpeedKmS: row.relSpeedKmS,
    expectedMaxProb: row.maxProb,
    actualTcaIso: result?.tca_iso ?? null,
    actualMinRangeKm: Number(result?.min_range_km ?? Number.NaN),
    actualRelSpeedKmS: Number(result?.rel_speed_kms ?? Number.NaN),
    actualMaxProb: Number(result?.max_probability ?? Number.NaN),
    ...deltas,
  };
}

function buildErrorRecord(row, error) {
  return {
    sourceRowIndex: row.sourceRowIndex,
    obj1Norad: row.obj1Norad,
    obj2Norad: row.obj2Norad,
    tcaIso: row.tcaIso,
    message: error instanceof Error ? error.message : String(error),
  };
}

function maybePushLimited(target, value, limit) {
  if (target.length < limit) {
    target.push(value);
  }
}

async function fetchText(url, options = {}) {
  const timeoutMs = Math.max(
    1000,
    numberOrDefault(options.timeoutMs, DEFAULT_TIMEOUT_MS),
  );
  const fetched = await fetchCachedText(url, {
    cacheDir: options.cacheDir ?? defaultCelestrakCacheDir(),
    extension: options.extension ?? "txt",
    forceRefresh: options.forceRefresh === true,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs,
    headers: {
      "user-agent": "OrbPro-SOCRATES-Validation/1.0",
      accept: "text/plain, text/csv, application/json;q=0.9, */*;q=0.1",
      ...options.headers,
    },
  });
  return fetched.text;
}

export function parseSocratesCsv(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((value) => String(value).trim());
  const rows = [];
  for (let index = 1; index < lines.length; index++) {
    const values = parseCsvLine(lines[index]);
    const row = {};
    for (let headerIndex = 0; headerIndex < headers.length; headerIndex++) {
      row[headers[headerIndex]] = values[headerIndex] ?? "";
    }
    rows.push({
      sourceRowIndex: index - 1,
      obj1Norad: Number(row.NORAD_CAT_ID_1),
      obj1Name: String(row.OBJECT_NAME_1 ?? "").trim(),
      obj1Dse: Number(row.DSE_1),
      obj2Norad: Number(row.NORAD_CAT_ID_2),
      obj2Name: String(row.OBJECT_NAME_2 ?? "").trim(),
      obj2Dse: Number(row.DSE_2),
      tcaIso: toIsoString(row.TCA),
      tcaJd: isoToJd(toIsoString(row.TCA)),
      minRangeKm: Number(row.TCA_RANGE),
      relSpeedKmS: Number(row.TCA_RELATIVE_SPEED),
      maxProb: Number(row.MAX_PROB),
      dilutionKm: Number(row.DILUTION),
    });
  }

  return rows;
}

export async function fetchSocratesCsv(options = {}) {
  const sort = String(options.sort ?? DEFAULT_SORT);
  const csvFile = sort === "minRange" ? "sort-minRange.csv" : "sort-maxProb.csv";
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const text = await fetchText(`${baseUrl}/${csvFile}`, {
    ...options,
    extension: "csv",
    timeoutMs: options.csvTimeoutMs ?? DEFAULT_CSV_TIMEOUT_MS,
  });
  return {
    baseUrl,
    sort,
    csvFile,
    text,
    rows: parseSocratesCsv(text),
  };
}

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

export async function fetchSocratesPairGpJson(row, options = {}) {
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const cacheDir = options.cacheDir ?? defaultCelestrakCacheDir();
  const forceRefresh = options.forceRefresh === true;
  const fileName = `gp_${row.obj1Norad},${row.obj2Norad}.json`;
  const cachePath = path.join(cacheDir, fileName);

  if (!forceRefresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      // Fall through to network fetch.
    }
  }

  await ensureDirectory(cacheDir);
  const url = `${baseUrl}/data.php?CATNR=${row.obj1Norad},${row.obj2Norad}&FORMAT=json`;
  const text = await fetchText(url, {
    ...options,
    cacheDir,
    extension: "json",
  });
  await writeFile(cachePath, text, "utf8");
  return JSON.parse(text);
}

function createSummary(context) {
  return {
    baseUrl: context.baseUrl,
    sort: context.sort,
    csvFile: context.csvFile,
    fetchedRows: context.fetchedRows,
    scannedRows: context.scannedRows,
    skippedFetchCount: context.skippedFetchCount,
    testedRows: context.testedRows,
    matchedRows: context.matchedRows,
    mismatchCount: context.mismatchCount,
    errorCount: context.errorCount,
    maxTcaDeltaSec: context.maxTcaDeltaSec,
    maxRangeDeltaKm: context.maxRangeDeltaKm,
    maxSpeedDeltaKmS: context.maxSpeedDeltaKmS,
    maxProbabilityRatio: context.maxProbabilityRatio,
    elapsedMs: Date.now() - context.startedAt,
    mismatches: context.mismatches,
    errors: context.errors,
  };
}

export async function runSocratesLiveComparison(options = {}) {
  const fetched = await fetchSocratesCsv(options);
  const offset = Math.max(0, numberOrDefault(options.offset, 0));
  const limit = Math.max(1, numberOrDefault(options.limit, DEFAULT_LIMIT));
  const maxScanRows = Math.max(
    limit,
    numberOrDefault(options.maxScanRows, DEFAULT_MAX_SCAN_ROWS),
  );
  const rows = fetched.rows.slice(offset, offset + maxScanRows);
  const cacheDir = options.cacheDir ?? defaultCelestrakCacheDir();
  const rateMs = Math.max(0, numberOrDefault(options.rateMs, DEFAULT_RATE_MS));
  const progressEvery = Math.max(0, numberOrDefault(options.progressEvery, 0));
  const maxRecordedMismatches = Math.max(
    0,
    numberOrDefault(options.maxRecordedMismatches, 20),
  );
  const maxRecordedErrors = Math.max(
    0,
    numberOrDefault(options.maxRecordedErrors, maxRecordedMismatches),
  );
  const windowLeadDays = Math.max(
    0.1,
    numberOrDefault(options.windowLeadDays, DEFAULT_WINDOW_LEAD_DAYS),
  );
  const windowDurationDays = Math.max(
    0.1,
    numberOrDefault(options.windowDurationDays, DEFAULT_WINDOW_DURATION_DAYS),
  );
  const thresholdKm = Math.max(
    0.1,
    numberOrDefault(options.thresholdKm, DEFAULT_THRESHOLD_KM),
  );
  const tcaToleranceSec = Math.max(
    0,
    numberOrDefault(options.tcaToleranceSec, DEFAULT_TCA_TOLERANCE_SEC),
  );
  const rangeToleranceKm = Math.max(
    0,
    numberOrDefault(options.rangeToleranceKm, DEFAULT_RANGE_TOLERANCE_KM),
  );
  const speedToleranceKmS = Math.max(
    0,
    numberOrDefault(options.speedToleranceKmS, DEFAULT_SPEED_TOLERANCE_KM_S),
  );
  const probabilityRatioTolerance = Math.max(
    1,
    numberOrDefault(
      options.probabilityRatioTolerance,
      DEFAULT_PROBABILITY_RATIO_TOLERANCE,
    ),
  );
  const context = {
    baseUrl: fetched.baseUrl,
    sort: fetched.sort,
    csvFile: fetched.csvFile,
    fetchedRows: fetched.rows.length,
    scannedRows: 0,
    skippedFetchCount: 0,
    testedRows: 0,
    matchedRows: 0,
    mismatchCount: 0,
    errorCount: 0,
    maxTcaDeltaSec: 0,
    maxRangeDeltaKm: 0,
    maxSpeedDeltaKmS: 0,
    maxProbabilityRatio: 0,
    mismatches: [],
    errors: [],
    startedAt: Date.now(),
  };
  const createPlugin =
    typeof options.createPlugin === "function"
      ? options.createPlugin
      : () =>
          createConjunctionAssessmentPlugin({
            requireEmbeddedManifest: true,
          });
  const plugin = await createPlugin();

  try {
    for (let index = 0; index < rows.length; index++) {
      if (context.testedRows >= limit) {
        break;
      }
      const row = rows[index];
      context.scannedRows++;
      let gpRecords;
      try {
        gpRecords = await fetchSocratesPairGpJson(row, {
          ...options,
          baseUrl: fetched.baseUrl,
          cacheDir,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        context.skippedFetchCount++;
        maybePushLimited(
          context.errors,
          buildErrorRecord(row, error),
          maxRecordedErrors,
        );
        if (
          progressEvery > 0 &&
          context.scannedRows % progressEvery === 0 &&
          typeof options.onProgress === "function"
        ) {
          options.onProgress(createSummary(context));
        }
        if (index + 1 < rows.length) {
          await sleep(rateMs);
        }
        continue;
      }

      try {
        if (!Array.isArray(gpRecords) || gpRecords.length < 2) {
          throw new Error(
            `SOCRATES GP download returned ${Array.isArray(gpRecords) ? gpRecords.length : 0} objects for ${row.obj1Norad},${row.obj2Norad}.`,
          );
        }

        const parseResult = plugin.parseAndScreen({
          gp_json: JSON.stringify(gpRecords),
          screen: true,
          start_jd: row.tcaJd - windowLeadDays,
          duration_days: windowDurationDays,
          threshold_km: Math.max(thresholdKm, row.minRangeKm + 1),
          num_threads: 1,
        });
        const result = Array.isArray(parseResult?.conjunctions)
          ? parseResult.conjunctions[0]
          : null;
        if (!result) {
          throw new Error(
            `Plugin found no conjunction for ${row.obj1Norad},${row.obj2Norad}.`,
          );
        }

        const tcaDeltaSec =
          Math.abs(Number(result.tca_jd ?? Number.NaN) - row.tcaJd) * 86400.0;
        const rangeDeltaKm = Math.abs(
          Number(result.min_range_km ?? Number.NaN) - row.minRangeKm,
        );
        const speedDeltaKmS = Math.abs(
          Number(result.rel_speed_kms ?? Number.NaN) - row.relSpeedKmS,
        );
        const probabilityRatio = computeProbabilityRatio(
          Number(result.max_probability ?? Number.NaN),
          row.maxProb,
        );

        context.testedRows++;
        context.maxTcaDeltaSec = Math.max(context.maxTcaDeltaSec, tcaDeltaSec);
        context.maxRangeDeltaKm = Math.max(
          context.maxRangeDeltaKm,
          rangeDeltaKm,
        );
        context.maxSpeedDeltaKmS = Math.max(
          context.maxSpeedDeltaKmS,
          speedDeltaKmS,
        );
        context.maxProbabilityRatio = Math.max(
          context.maxProbabilityRatio,
          probabilityRatio,
        );

        if (
          tcaDeltaSec <= tcaToleranceSec &&
          rangeDeltaKm <= rangeToleranceKm &&
          speedDeltaKmS <= speedToleranceKmS &&
          probabilityRatio <= probabilityRatioTolerance
        ) {
          context.matchedRows++;
        } else {
          context.mismatchCount++;
          maybePushLimited(
            context.mismatches,
            buildMismatchRecord(row, result, {
              tcaDeltaSec,
              rangeDeltaKm,
              speedDeltaKmS,
              probabilityRatio,
            }),
            maxRecordedMismatches,
          );
        }
      } catch (error) {
        context.testedRows++;
        context.errorCount++;
        maybePushLimited(
          context.errors,
          buildErrorRecord(row, error),
          maxRecordedErrors,
        );
      }

      if (
        progressEvery > 0 &&
        context.scannedRows > 0 &&
        context.scannedRows % progressEvery === 0 &&
        typeof options.onProgress === "function"
      ) {
        options.onProgress(createSummary(context));
      }

      if (index + 1 < rows.length) {
        await sleep(rateMs);
      }
    }
  } finally {
    plugin?.destroy?.();
  }

  if (context.testedRows < limit) {
    context.errorCount++;
    maybePushLimited(
      context.errors,
      {
        message:
          `Only completed ${context.testedRows}/${limit} live SOCRATES comparisons ` +
          `after scanning ${context.scannedRows} rows.`,
      },
      maxRecordedErrors,
    );
  }

  return createSummary(context);
}

export async function runSocratesLiveComparisonCli(options = {}) {
  const summary = await runSocratesLiveComparison(options);
  await maybeWriteJson(options.output, summary);
  return summary;
}
