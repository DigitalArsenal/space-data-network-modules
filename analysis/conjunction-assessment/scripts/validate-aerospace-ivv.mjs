import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AEROSPACE_MAX_OD_AGE_DAYS,
  AEROSPACE_SCREENING_WINDOW_START_ISO,
  AEROSPACE_SCREENING_WINDOW_STOP_ISO,
  odAgeDaysFromScreeningStart,
  parseAerospaceOcmText,
  validateAerospaceOcm,
} from "./lib/aerospaceOcm.mjs";
import {
  listOcmEntries,
  maybeWriteJson,
  readGzipCsvRows,
  readTarEntryText,
} from "./lib/aerospaceDataset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const LOCAL_AEROSPACE_ARCHIVE_ROOT = path.join(
  PACKAGE_ROOT,
  "tests",
  "data",
  "aerospace-archives",
);
const DEFAULT_AEROSPACE_ARCHIVE_ROOT =
  process.env.CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT ||
  process.env.AEROSPACE_IVV_ARCHIVE_ROOT ||
  LOCAL_AEROSPACE_ARCHIVE_ROOT;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index++;
  }
  return options;
}

function basenameToEntryMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(path.basename(entry), entry);
  }
  return map;
}

async function summarizeAnswerKey(filePath, options = {}) {
  const referencedFiles = new Set();
  const uniqueObjects = new Set();
  const epochs = [];
  let rowCount = 0;

  for await (const row of readGzipCsvRows(filePath)) {
    rowCount++;
    uniqueObjects.add(String(row.obj1));
    uniqueObjects.add(String(row.obj2));
    if (row.obj1_filename) {
      referencedFiles.add(String(row.obj1_filename));
    }
    if (row.obj2_filename) {
      referencedFiles.add(String(row.obj2_filename));
    }
    if (row.epoch) {
      const epochValue = String(row.epoch).replace(" ", "T");
      epochs.push(epochValue.endsWith("Z") ? epochValue : `${epochValue}Z`);
    }
  }

  const sortedEpochs = epochs.sort();
  return {
    filePath,
    rowCount,
    uniqueObjects: uniqueObjects.size,
    firstEpoch: sortedEpochs[0] ?? null,
    lastEpoch: sortedEpochs[sortedEpochs.length - 1] ?? null,
    referencedFiles: Array.from(referencedFiles).sort().slice(
      0,
      Number(options.referenceSampleLimit ?? 64),
    ),
  };
}

async function loadScreeningVolumeSummary(filePath) {
  let rowCount = 0;
  const volumes = new Map();
  for await (const row of readGzipCsvRows(filePath)) {
    rowCount++;
    const volumeName = String(row.ScreeningVolume ?? "");
    volumes.set(volumeName, (volumes.get(volumeName) ?? 0) + 1);
  }
  return {
    filePath,
    rowCount,
    screeningVolumes: Object.fromEntries(
      Array.from(volumes.entries()).sort((left, right) =>
        left[0].localeCompare(right[0]),
      ),
    ),
  };
}

async function inspectSampleOcms(datasetTarPath, entryMap, referencedFiles, sampleCount) {
  const sampleEntries = [];
  for (const fileName of referencedFiles) {
    const entryPath = entryMap.get(fileName);
    if (entryPath) {
      sampleEntries.push(entryPath);
    }
    if (sampleEntries.length >= sampleCount) {
      break;
    }
  }

  const samples = [];
  for (const entryPath of sampleEntries) {
    const text = await readTarEntryText(datasetTarPath, entryPath);
    const parsed = parseAerospaceOcmText(text, { sourcePath: entryPath });
    const issues = validateAerospaceOcm(parsed);
    samples.push({
      entryPath,
      objectDesignator: parsed.objectDesignator,
      objectName: parsed.objectName,
      objectId: parsed.objectId,
      trajType: parsed.trajType,
      referenceFrame: parsed.referenceFrame,
      stateCount: parsed.primaryStateCount,
      usableStartTime: parsed.usableStartTime,
      usableStopTime: parsed.usableStopTime,
      odEpoch: parsed.odEpoch,
      odAgeDays: Number.isFinite(parsed.odEpochJD)
        ? odAgeDaysFromScreeningStart(parsed)
        : null,
      issues,
      warnings: parsed.warnings,
    });
  }
  return samples;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetTarPath =
    args["dataset-tar"] ??
    path.join(
      DEFAULT_AEROSPACE_ARCHIVE_ROOT,
      "AerospaceIVVDataset_20251009a.tar.gz",
    );
  const sphericalPath =
    args["spherical-gz"] ??
    path.join(
      DEFAULT_AEROSPACE_ARCHIVE_ROOT,
      "IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz",
    );
  const sfshPath =
    args["sfsh-gz"] ??
    path.join(
      DEFAULT_AEROSPACE_ARCHIVE_ROOT,
      "IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz",
    );
  const screeningMapPath =
    args["screening-map-gz"] ??
    path.join(
      DEFAULT_AEROSPACE_ARCHIVE_ROOT,
      "AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz",
    );
  const sampleCount = Number(args["sample-count"] ?? 12);

  const ocmEntries = await listOcmEntries(datasetTarPath);
  const entryMap = basenameToEntryMap(ocmEntries);
  const sphericalSummary = await summarizeAnswerKey(sphericalPath, args);
  const sfshSummary = await summarizeAnswerKey(sfshPath, args);
  const screeningSummary = await loadScreeningVolumeSummary(screeningMapPath);
  const referencedFiles = [
    ...new Set([
      ...sphericalSummary.referencedFiles,
      ...sfshSummary.referencedFiles,
    ]),
  ];
  const sampleOcms = await inspectSampleOcms(
    datasetTarPath,
    entryMap,
    referencedFiles,
    sampleCount,
  );

  const summary = {
    datasetTarPath,
    guideConstraints: {
      screeningWindowStartIso: AEROSPACE_SCREENING_WINDOW_START_ISO,
      screeningWindowStopIso: AEROSPACE_SCREENING_WINDOW_STOP_ISO,
      maxOdAgeDays: AEROSPACE_MAX_OD_AGE_DAYS,
      allVsAll: true,
      excludeSameObjectDesignatorPairs: true,
      sphericalThresholdKm: 10,
      defaultHbrMeters: 0.5,
    },
    archive: {
      ocmCount: ocmEntries.length,
      sampledReferencedOcmCount: sampleOcms.length,
    },
    sphericalAnswerKey: sphericalSummary,
    sfshAnswerKey: sfshSummary,
    screeningVolumes: screeningSummary,
    sampledOcms: sampleOcms,
  };

  await maybeWriteJson(args.output, summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
