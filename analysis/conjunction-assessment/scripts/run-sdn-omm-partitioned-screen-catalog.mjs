#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FlatcRunner } from "flatc-wasm";
import { loadModule } from "space-data-module-sdk/host/isomorphic";
import { buildWasmEdgeEmscriptenPthreadRunner } from "space-data-module-sdk/testing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WASM_PATH = path.join(
  PACKAGE_ROOT,
  "dist",
  "isomorphic",
  "module.wasm",
);

function readText(relativePath) {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), "utf8");
}

function conjunctionRequestSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogRequest.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogRequest.fbs": readText(
        "schemas/ConjunctionScreenCatalogRequest.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText(
        "schemas/ConjunctionCommon.fbs",
      ),
    },
  };
}

function screenCatalogResultSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogResult.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogResult.fbs": readText(
        "schemas/ConjunctionScreenCatalogResult.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText(
        "schemas/ConjunctionCommon.fbs",
      ),
    },
  };
}

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
    if (options[key] === undefined) {
      options[key] = next;
    } else if (Array.isArray(options[key])) {
      options[key].push(next);
    } else {
      options[key] = [options[key], next];
    }
    index++;
  }
  return options;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalSha256Hex(value) {
  const payload =
    typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array
      ? value
      : canonicalJson(value);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function requiredNumber(value, name, defaultValue) {
  const resolved = value ?? defaultValue;
  const numeric = Number(resolved);
  if (!Number.isFinite(numeric)) {
    throw new Error(`--${name} must be numeric.`);
  }
  return numeric;
}

function readUint32beFrameRanges(buffer) {
  let offset = 0;
  const ranges = [];
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error(`Truncated uint32be frame length at byte ${offset}.`);
    }
    const frameStart = offset;
    const frameLength = buffer.readUInt32BE(offset);
    offset += 4;
    if (frameLength <= 0) {
      throw new Error(`Invalid zero-length frame at index ${ranges.length}.`);
    }
    if (offset + frameLength > buffer.length) {
      throw new Error(
        `Truncated uint32be frame ${ranges.length}: length ${frameLength} exceeds remaining bytes.`,
      );
    }
    offset += frameLength;
    ranges.push({ start: frameStart, end: offset });
  }
  return ranges;
}

function countUint32beFrames(buffer) {
  return readUint32beFrameRanges(buffer).length;
}

export function sliceUint32beFrames(buffer, startFrame, endFrame) {
  if (startFrame < 0) {
    throw new Error("catalog window start must be greater than or equal to zero.");
  }
  if (endFrame < startFrame) {
    throw new Error("catalog window end must be greater than or equal to start.");
  }
  const ranges = readUint32beFrameRanges(buffer);
  const clampedStart = Math.min(startFrame, ranges.length);
  const clampedEnd = Math.min(endFrame, ranges.length);
  const selected = ranges.slice(clampedStart, clampedEnd);
  const byteLength = selected.reduce(
    (sum, range) => sum + range.end - range.start,
    0,
  );
  const payload = Buffer.alloc(byteLength);
  let offset = 0;
  for (const range of selected) {
    buffer.copy(payload, offset, range.start, range.end);
    offset += range.end - range.start;
  }
  return {
    payload,
    objectCount: selected.length,
    sourceObjectCount: ranges.length,
    startFrame: clampedStart,
    endFrame: clampedEnd,
  };
}

export function sliceUint32beBlockPair(buffer, range) {
  const primary = sliceUint32beFrames(
    buffer,
    range.primaryStartOrderIndex,
    range.primaryEndOrderIndex,
  );
  const diagonal =
    range.primaryStartOrderIndex === range.secondaryStartOrderIndex &&
    range.primaryEndOrderIndex === range.secondaryEndOrderIndex;
  if (diagonal) {
    return {
      payload: primary.payload,
      objectCount: primary.objectCount,
      sourceObjectCount: primary.sourceObjectCount,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: primary.objectCount,
      secondaryStartOrderIndex: Math.min(1, primary.objectCount),
      secondaryEndOrderIndex: primary.objectCount,
    };
  }

  const secondary = sliceUint32beFrames(
    buffer,
    range.secondaryStartOrderIndex,
    range.secondaryEndOrderIndex,
  );
  return {
    payload: Buffer.concat([primary.payload, secondary.payload]),
    objectCount: primary.objectCount + secondary.objectCount,
    sourceObjectCount: primary.sourceObjectCount,
    primaryStartOrderIndex: 0,
    primaryEndOrderIndex: primary.objectCount,
    secondaryStartOrderIndex: primary.objectCount,
    secondaryEndOrderIndex: primary.objectCount + secondary.objectCount,
  };
}

function makeRange(start, end, step) {
  const ranges = [];
  let partitionIndex = 0;
  for (let index = start; index < end; index += step) {
    ranges.push({
      partitionIndex,
      startOrderIndex: index,
      endOrderIndex: Math.min(index + step, end),
    });
    partitionIndex++;
  }
  return ranges;
}

function makeCatalogBlockPairRanges(start, end, step) {
  const blocks = makeRange(start, end, step);
  const ranges = [];
  let partitionIndex = 0;
  for (let primaryIndex = 0; primaryIndex < blocks.length; primaryIndex += 1) {
    const primary = blocks[primaryIndex];
    for (let secondaryIndex = primaryIndex; secondaryIndex < blocks.length; secondaryIndex += 1) {
      const secondary = blocks[secondaryIndex];
      ranges.push({
        partitionIndex,
        primaryStartOrderIndex: primary.startOrderIndex,
        primaryEndOrderIndex: primary.endOrderIndex,
        secondaryStartOrderIndex: secondary.startOrderIndex,
        secondaryEndOrderIndex: secondary.endOrderIndex,
        diagonal: primaryIndex === secondaryIndex,
      });
      partitionIndex += 1;
    }
  }
  return ranges;
}

function createScreenCatalogRequest(flatc, options, range, orderedCatalogIndices) {
  const startOrderIndex =
    range.primaryStartOrderIndex ?? (Array.isArray(range) ? range[0] : range.startOrderIndex);
  const endOrderIndex =
    range.primaryEndOrderIndex ?? (Array.isArray(range) ? range[1] : range.endOrderIndex);
  const secondaryStartOrderIndex = range.secondaryStartOrderIndex ?? 0;
  const secondaryEndOrderIndex = range.secondaryEndOrderIndex ?? 0;
  return flatc.generateBinary(
    conjunctionRequestSchema(),
    JSON.stringify({
      selectedSources: [
        {
          sourceKind: "OMM",
          sourceId: String(options.sourceId ?? "celestrak-full-catalog"),
          providerId: String(options.providerId ?? "celestrak.eth"),
          schemaName: "OMM/main.fbs",
          fileIdentifier: "$OMM",
        },
      ],
      startJd: requiredNumber(options.startJd, "start-jd", 2460743.5),
      durationDays: requiredNumber(options.durationDays, "duration-days", 0.01),
      thresholdKm: requiredNumber(options.thresholdKm, "threshold-km", 15.0),
      numThreads: Math.trunc(requiredNumber(options.numThreads, "num-threads", 1)),
      coarseStepSec: requiredNumber(options.coarseStepSec, "coarse-step-sec", 300.0),
      fineTolSec: requiredNumber(options.fineTolSec, "fine-tol-sec", 0.01),
      combinedRadiusM: requiredNumber(
        options.combinedRadiusM,
        "combined-radius-m",
        10.0,
      ),
      useKdTree: options.useKdTree !== false,
      useDynamicWindow: options.useDynamicWindow !== false,
      usePerigeeFilter: options.usePerigeeFilter !== false,
      orderedCatalogIndices,
      startOrderIndex,
      endOrderIndex,
      secondaryStartOrderIndex,
      secondaryEndOrderIndex,
    }),
    { sizePrefix: false },
  );
}

function splitList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry) => entry !== undefined && entry !== null && entry !== true)
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCliOptions(rawOptions) {
  return {
    catalog: rawOptions.catalog,
    output: rawOptions.output,
    checkpointDir: rawOptions["checkpoint-dir"],
    resume: Boolean(rawOptions.resume),
    maxPartitions:
      rawOptions["max-partitions"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(rawOptions["max-partitions"], "max-partitions", 0),
          ),
    partitionShardCount:
      rawOptions["partition-shard-count"] === undefined
        ? 1
        : Math.trunc(
            requiredNumber(
              rawOptions["partition-shard-count"],
              "partition-shard-count",
              1,
            ),
          ),
    partitionShardIndex:
      rawOptions["partition-shard-index"] === undefined
        ? 0
        : Math.trunc(
            requiredNumber(
              rawOptions["partition-shard-index"],
              "partition-shard-index",
              0,
            ),
          ),
    wasm: rawOptions.wasm ?? DEFAULT_WASM_PATH,
    wasmEdgeBinary: rawOptions["wasmedge-binary"],
    wasmEdgeRunnerBinary: rawOptions["wasmedge-runner-binary"],
    partitionSize: Math.trunc(
      requiredNumber(rawOptions["partition-size"], "partition-size", 100),
    ),
    catalogBlockSize:
      rawOptions["catalog-block-size"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["catalog-block-size"],
              "catalog-block-size",
              0,
            ),
          ),
    startOrderIndex: Math.trunc(
      requiredNumber(rawOptions["start-order-index"], "start-order-index", 0),
    ),
    endOrderIndex:
      rawOptions["end-order-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(rawOptions["end-order-index"], "end-order-index", 0),
          ),
    catalogStartFrame: Math.trunc(
      requiredNumber(rawOptions["catalog-start-frame"], "catalog-start-frame", 0),
    ),
    catalogEndFrame:
      rawOptions["catalog-end-frame"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(rawOptions["catalog-end-frame"], "catalog-end-frame", 0),
          ),
    catalogFrameLimit:
      rawOptions["catalog-frame-limit"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["catalog-frame-limit"],
              "catalog-frame-limit",
              0,
            ),
          ),
    sourceId: rawOptions["source-id"],
    providerId: rawOptions["provider-id"],
    sourcePnmCids: splitList(rawOptions["source-pnm-cid"]),
    moduleArtifactHash: rawOptions["module-artifact-hash"],
    moduleVersion: rawOptions["module-version"],
    signingPrivateKey: rawOptions["signing-private-key"],
    startJd: rawOptions["start-jd"],
    durationDays: rawOptions["duration-days"],
    thresholdKm: rawOptions["threshold-km"],
    numThreads: rawOptions["num-threads"],
    coarseStepSec: rawOptions["coarse-step-sec"],
    fineTolSec: rawOptions["fine-tol-sec"],
    combinedRadiusM: rawOptions["combined-radius-m"],
    useKdTree: rawOptions["no-kdtree"] ? false : undefined,
    useDynamicWindow: rawOptions["no-dynamic-window"] ? false : undefined,
    usePerigeeFilter: rawOptions["no-perigee-filter"] ? false : undefined,
  };
}

function configuredSelectedSources(options) {
  return [
    {
      sourceKind: "OMM",
      sourceId: String(options.sourceId ?? "celestrak-full-catalog"),
      providerId: String(options.providerId ?? "celestrak.eth"),
      schemaName: "OMM/main.fbs",
      fileIdentifier: "$OMM",
    },
  ];
}

function resolvedRunConfig(options, summary) {
  return {
    methodId: "screen_catalog",
    catalogFrameFormat: "uint32be",
    partitionMode: summary.partitionMode ?? "ordered-primary",
    partitionSize: options.partitionSize,
    catalogBlockSize: options.catalogBlockSize,
    startOrderIndex: summary.startOrderIndex,
    endOrderIndex: summary.endOrderIndex,
    selectedSources: configuredSelectedSources(options),
    startJd: requiredNumber(options.startJd, "start-jd", 2460743.5),
    durationDays: requiredNumber(options.durationDays, "duration-days", 0.01),
    thresholdKm: requiredNumber(options.thresholdKm, "threshold-km", 15.0),
    numThreads: Math.trunc(requiredNumber(options.numThreads, "num-threads", 1)),
    coarseStepSec: requiredNumber(options.coarseStepSec, "coarse-step-sec", 300.0),
    fineTolSec: requiredNumber(options.fineTolSec, "fine-tol-sec", 0.01),
    combinedRadiusM: requiredNumber(
      options.combinedRadiusM,
      "combined-radius-m",
      10.0,
    ),
    useKdTree: options.useKdTree !== false,
    useDynamicWindow: options.useDynamicWindow !== false,
    usePerigeeFilter: options.usePerigeeFilter !== false,
  };
}

function canonicalQueryFromConfig(config) {
  return {
    sourceFamilies: config.selectedSources.map((source) => source.sourceKind),
    selectedSources: config.selectedSources,
    catalogFrameFormat: config.catalogFrameFormat,
    partitionMode: config.partitionMode,
    startOrderIndex: config.startOrderIndex,
    endOrderIndex: config.endOrderIndex,
    startJd: config.startJd,
    durationDays: config.durationDays,
    thresholdKm: config.thresholdKm,
  };
}

function canonicalResultFromSummary(summary) {
  return {
    catalogBytes: summary.catalogBytes,
    objectCount: summary.objectCount,
    partitionMode: summary.partitionMode ?? "ordered-primary",
    partitionSize: summary.partitionSize,
    catalogBlockSize: summary.catalogBlockSize ?? null,
    startOrderIndex: summary.startOrderIndex,
    endOrderIndex: summary.endOrderIndex,
    complete: summary.complete ?? false,
    partitions: summary.partitions.map((partition) => ({
      partitionIndex: partition.partitionIndex,
      startOrderIndex: partition.startOrderIndex,
      endOrderIndex: partition.endOrderIndex,
      primaryStartOrderIndex: partition.primaryStartOrderIndex,
      primaryEndOrderIndex: partition.primaryEndOrderIndex,
      secondaryStartOrderIndex: partition.secondaryStartOrderIndex,
      secondaryEndOrderIndex: partition.secondaryEndOrderIndex,
      statusCode: partition.statusCode,
      errorMessage: partition.errorMessage ?? "",
      objectsParsed: partition.objectsParsed ?? 0,
      conjunctionsFound: partition.conjunctionsFound ?? 0,
      stats: partition.stats
        ? {
            pairsScreened: partition.stats.pairsScreened ?? 0,
            pairsPrefiltered: partition.stats.pairsPrefiltered ?? 0,
            kdtreeCandidates: partition.stats.kdtreeCandidates ?? 0,
            tcaRefined: partition.stats.tcaRefined ?? 0,
            propagations: partition.stats.propagations ?? 0,
          }
        : null,
    })),
    aggregate: {
      partitions: summary.aggregate.partitions,
      failedPartitions: summary.aggregate.failedPartitions,
      deferredPartitions: summary.aggregate.deferredPartitions ?? 0,
      objectsParsed: summary.aggregate.objectsParsed,
      conjunctionsFound: summary.aggregate.conjunctionsFound,
      pairsScreened: summary.aggregate.pairsScreened,
      pairsPrefiltered: summary.aggregate.pairsPrefiltered,
      kdtreeCandidates: summary.aggregate.kdtreeCandidates,
      tcaRefined: summary.aggregate.tcaRefined,
      propagations: summary.aggregate.propagations,
    },
  };
}

function readPluginVersion() {
  const manifest = JSON.parse(readText("plugin-manifest.json"));
  return manifest.version ?? "unknown";
}

function hashFileSha256(pathname) {
  return crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
}

export function buildPartitionedRunProvenance(summary, options) {
  const canonicalConfig = resolvedRunConfig(options, summary);
  const canonicalQuery = canonicalQueryFromConfig(canonicalConfig);
  const canonicalResult = canonicalResultFromSummary(summary);
  const moduleArtifactHash =
    options.moduleArtifactHash ??
    `sha256:${hashFileSha256(options.wasm ?? DEFAULT_WASM_PATH)}`;

  return {
    schemaVersion: 1,
    sourcePnmCids: [...(options.sourcePnmCids ?? [])].sort(),
    canonicalQuery,
    queryHash: canonicalSha256Hex(canonicalQuery),
    canonicalConfig,
    configHash: canonicalSha256Hex(canonicalConfig),
    moduleArtifactHash,
    moduleVersion: String(options.moduleVersion ?? readPluginVersion()),
    canonicalResult,
    resultHash: canonicalSha256Hex(canonicalResult),
    cdmOutputMetadata: {
      available: false,
      reason:
        "partitioned screen_catalog emits aggregate conjunction counts; signed CDM bytes remain limited to emit_cdm for TLE-backed pair requests",
      sourceTypes: ["OMM"],
    },
  };
}

function readPrivateKey(options) {
  const keyText =
    options.signingPrivateKey !== undefined
      ? fs.readFileSync(options.signingPrivateKey, "utf8")
      : process.env.CA_RESULT_ED25519_PRIVATE_KEY;
  if (!keyText) {
    return null;
  }
  return crypto.createPrivateKey(keyText);
}

export function signPartitionedRunProvenance(provenance, privateKey) {
  const signedPayload = {
    schemaVersion: provenance.schemaVersion,
    sourcePnmCids: provenance.sourcePnmCids,
    queryHash: provenance.queryHash,
    configHash: provenance.configHash,
    moduleArtifactHash: provenance.moduleArtifactHash,
    moduleVersion: provenance.moduleVersion,
    resultHash: provenance.resultHash,
    cdmOutputMetadata: provenance.cdmOutputMetadata,
  };
  const payload = Buffer.from(canonicalJson(signedPayload), "utf8");
  const signature = crypto.sign(null, payload, privateKey);
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" });
  return {
    ...provenance,
    signedPayload,
    resultSignature: {
      algorithm: "Ed25519",
      payloadEncoding: "canonical-json",
      signature: signature.toString("base64"),
      publicKeyPem: publicKey.toString(),
    },
  };
}

function aggregatePartitions(partitions, objectCount, wallElapsedMs) {
  const aggregate = {
    partitions: partitions.length,
    failedPartitions: 0,
    deferredPartitions: 0,
    objectsParsed: objectCount,
    conjunctionsFound: 0,
    pairsScreened: 0,
    pairsPrefiltered: 0,
    kdtreeCandidates: 0,
    tcaRefined: 0,
    propagations: 0,
    elapsedMs: 0,
    wallElapsedMs,
  };

  for (const partition of partitions) {
    if (partition.statusCode !== 0) {
      aggregate.failedPartitions++;
    }
    aggregate.conjunctionsFound += partition.conjunctionsFound ?? 0;
    const stats = partition.stats ?? {};
    aggregate.pairsScreened += stats.pairsScreened ?? 0;
    aggregate.pairsPrefiltered += stats.pairsPrefiltered ?? 0;
    aggregate.kdtreeCandidates += stats.kdtreeCandidates ?? 0;
    aggregate.tcaRefined += stats.tcaRefined ?? 0;
    aggregate.propagations += stats.propagations ?? 0;
    aggregate.elapsedMs += stats.elapsedMs ?? partition.elapsedMs ?? 0;
  }
  return aggregate;
}

function checkpointFileName(partition) {
  const index = String(partition.partitionIndex).padStart(6, "0");
  if (partition.primaryStartOrderIndex !== undefined) {
    const primaryStart = String(partition.primaryStartOrderIndex).padStart(6, "0");
    const primaryEnd = String(partition.primaryEndOrderIndex).padStart(6, "0");
    const secondaryStart = String(partition.secondaryStartOrderIndex).padStart(6, "0");
    const secondaryEnd = String(partition.secondaryEndOrderIndex).padStart(6, "0");
    return `partition-${index}-${primaryStart}-${primaryEnd}-${secondaryStart}-${secondaryEnd}.json`;
  }
  const start = String(partition.startOrderIndex).padStart(6, "0");
  const end = String(partition.endOrderIndex).padStart(6, "0");
  return `partition-${index}-${start}-${end}.json`;
}

function checkpointKey(partition) {
  if (partition.primaryStartOrderIndex !== undefined) {
    return [
      partition.primaryStartOrderIndex,
      partition.primaryEndOrderIndex,
      partition.secondaryStartOrderIndex,
      partition.secondaryEndOrderIndex,
    ].join(":");
  }
  return `${partition.startOrderIndex}:${partition.endOrderIndex}`;
}

export async function loadPartitionCheckpoints(checkpointDir) {
  if (!checkpointDir) {
    return { completedPartitions: [] };
  }
  let entries;
  try {
    entries = await readdir(checkpointDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { completedPartitions: [] };
    }
    throw error;
  }

  const completedPartitions = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^partition-\d+-\d+-\d+(?:-\d+-\d+)?\.json$/.test(entry.name)
    ) {
      continue;
    }
    const pathname = path.join(checkpointDir, entry.name);
    const partition = JSON.parse(await readFile(pathname, "utf8"));
    if (partition.statusCode === 0) {
      completedPartitions.push(partition);
    }
  }
  completedPartitions.sort((left, right) => {
    if (
      left.primaryStartOrderIndex !== undefined ||
      right.primaryStartOrderIndex !== undefined
    ) {
      return left.partitionIndex - right.partitionIndex;
    }
    if (left.startOrderIndex !== right.startOrderIndex) {
      return left.startOrderIndex - right.startOrderIndex;
    }
    return left.endOrderIndex - right.endOrderIndex;
  });
  return { completedPartitions };
}

export function planCatalogBlockPairWork({
  objectCount,
  startOrderIndex,
  endOrderIndex,
  catalogBlockSize,
  resume = false,
  maxPartitions = null,
  partitionShardCount = 1,
  partitionShardIndex = 0,
  completedPartitions = [],
}) {
  if (catalogBlockSize <= 0) {
    throw new Error("--catalog-block-size must be greater than zero.");
  }
  if (partitionShardCount <= 0) {
    throw new Error("--partition-shard-count must be greater than zero.");
  }
  if (partitionShardIndex < 0 || partitionShardIndex >= partitionShardCount) {
    throw new Error(
      "--partition-shard-index must be greater than or equal to zero and less than --partition-shard-count.",
    );
  }
  if (maxPartitions !== null && maxPartitions < 0) {
    throw new Error("--max-partitions must be greater than or equal to zero.");
  }

  const allRanges = makeCatalogBlockPairRanges(
    startOrderIndex,
    endOrderIndex,
    catalogBlockSize,
  ).filter(
    (range) => range.partitionIndex % partitionShardCount === partitionShardIndex,
  );
  const completedByRange = new Map(
    completedPartitions.map((partition) => [checkpointKey(partition), partition]),
  );
  const completed = resume
    ? allRanges
        .map((range) => completedByRange.get(checkpointKey(range)))
        .filter(Boolean)
    : [];
  const pending = allRanges.filter(
    (range) => !resume || !completedByRange.has(checkpointKey(range)),
  );
  const limit = maxPartitions ?? pending.length;
  const pendingRanges = pending.slice(0, limit);
  const deferredRanges = pending.slice(limit);
  return {
    objectCount,
    allRanges,
    completedPartitions: completed,
    pendingRanges,
    deferredRanges,
    complete: deferredRanges.length === 0,
  };
}

export function planPartitionWork({
  objectCount,
  startOrderIndex,
  endOrderIndex,
  partitionSize,
  resume = false,
  maxPartitions = null,
  partitionShardCount = 1,
  partitionShardIndex = 0,
  completedPartitions = [],
}) {
  if (partitionSize <= 0) {
    throw new Error("--partition-size must be greater than zero.");
  }
  if (partitionShardCount <= 0) {
    throw new Error("--partition-shard-count must be greater than zero.");
  }
  if (partitionShardIndex < 0 || partitionShardIndex >= partitionShardCount) {
    throw new Error(
      "--partition-shard-index must be greater than or equal to zero and less than --partition-shard-count.",
    );
  }
  if (maxPartitions !== null && maxPartitions < 0) {
    throw new Error("--max-partitions must be greater than or equal to zero.");
  }

  const allRanges = makeRange(startOrderIndex, endOrderIndex, partitionSize).filter(
    (range) => range.partitionIndex % partitionShardCount === partitionShardIndex,
  );
  const completedByRange = new Map(
    completedPartitions.map((partition) => [checkpointKey(partition), partition]),
  );
  const completed = resume
    ? allRanges
        .map((range) => completedByRange.get(checkpointKey(range)))
        .filter(Boolean)
    : [];
  const pending = allRanges.filter(
    (range) => !resume || !completedByRange.has(checkpointKey(range)),
  );
  const limit = maxPartitions ?? pending.length;
  const pendingRanges = pending.slice(0, limit);
  const deferredRanges = pending.slice(limit);
  return {
    objectCount,
    allRanges,
    completedPartitions: completed,
    pendingRanges,
    deferredRanges,
    complete: deferredRanges.length === 0,
  };
}

async function writePartitionCheckpoint(checkpointDir, partition) {
  if (!checkpointDir) {
    return;
  }
  await mkdir(checkpointDir, { recursive: true });
  const finalPath = path.join(checkpointDir, checkpointFileName(partition));
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(partition, null, 2)}\n`);
  await rename(temporaryPath, finalPath);
}

async function maybeBuildRunner() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-ca-runner-"));
  const outputPath = path.join(tempDir, "wasmedge-pthread-runner");
  const runnerBinary = await buildWasmEdgeEmscriptenPthreadRunner({ outputPath });
  return {
    runnerBinary,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function runPartitionedSdnOmmCatalog(options) {
  if (!options.catalog) {
    throw new Error("--catalog is required.");
  }
  if (options.partitionSize <= 0) {
    throw new Error("--partition-size must be greater than zero.");
  }
  if (options.catalogBlockSize !== null && options.catalogBlockSize <= 0) {
    throw new Error("--catalog-block-size must be greater than zero.");
  }

  const sourceCatalogPayload = fs.readFileSync(options.catalog);
  const requestedCatalogEnd =
    options.catalogFrameLimit !== null
      ? options.catalogStartFrame + options.catalogFrameLimit
      : options.catalogEndFrame;
  const catalogWindow =
    options.catalogStartFrame > 0 || requestedCatalogEnd !== null
      ? sliceUint32beFrames(
          sourceCatalogPayload,
          options.catalogStartFrame,
          requestedCatalogEnd ?? Number.MAX_SAFE_INTEGER,
        )
      : {
          payload: sourceCatalogPayload,
          objectCount: countUint32beFrames(sourceCatalogPayload),
          sourceObjectCount: null,
          startFrame: 0,
          endFrame: null,
        };
  const catalogPayload = catalogWindow.payload;
  const objectCount = catalogWindow.objectCount;
  const startOrderIndex = Math.min(options.startOrderIndex, objectCount);
  const endOrderIndex = Math.min(options.endOrderIndex ?? objectCount, objectCount);
  if (endOrderIndex < startOrderIndex) {
    throw new Error("--end-order-index must be greater than or equal to --start-order-index.");
  }

  const checkpointState =
    options.resume && options.checkpointDir
      ? await loadPartitionCheckpoints(options.checkpointDir)
      : { completedPartitions: [] };
  const partitionMode =
    options.catalogBlockSize === null ? "ordered-primary" : "catalog-block-pair";
  const workPlan =
    partitionMode === "catalog-block-pair"
      ? planCatalogBlockPairWork({
          objectCount,
          startOrderIndex,
          endOrderIndex,
          catalogBlockSize: options.catalogBlockSize,
          resume: options.resume,
          maxPartitions: options.maxPartitions,
          partitionShardCount: options.partitionShardCount,
          partitionShardIndex: options.partitionShardIndex,
          completedPartitions: checkpointState.completedPartitions,
        })
      : planPartitionWork({
          objectCount,
          startOrderIndex,
          endOrderIndex,
          partitionSize: options.partitionSize,
          resume: options.resume,
          maxPartitions: options.maxPartitions,
          partitionShardCount: options.partitionShardCount,
          partitionShardIndex: options.partitionShardIndex,
          completedPartitions: checkpointState.completedPartitions,
        });

  const orderedCatalogIndices =
    partitionMode === "catalog-block-pair"
      ? null
      : Array.from({ length: objectCount }, (_, index) => index);
  const partitions = [...workPlan.completedPartitions];
  const startedAt = performance.now();
  let builtRunner = null;
  let harness = null;
  try {
    if (workPlan.pendingRanges.length > 0) {
      builtRunner = options.wasmEdgeRunnerBinary ? null : await maybeBuildRunner();
      harness = await loadModule({
        wasmSource: options.wasm,
        runtimeKind: "wasmedge",
        enableThreads: true,
        wasmEdgeBinary: options.wasmEdgeBinary,
        wasmEdgeRunnerBinary:
          options.wasmEdgeRunnerBinary ?? builtRunner?.runnerBinary,
        cwd: PACKAGE_ROOT,
      });
    }
    const flatc =
      workPlan.pendingRanges.length > 0 ? await FlatcRunner.init() : null;
    for (const range of workPlan.pendingRanges) {
      const partitionCatalog =
        partitionMode === "catalog-block-pair"
          ? sliceUint32beBlockPair(catalogPayload, range)
          : {
              payload: catalogPayload,
              objectCount,
              primaryStartOrderIndex: range.startOrderIndex,
              primaryEndOrderIndex: range.endOrderIndex,
              secondaryStartOrderIndex: 0,
              secondaryEndOrderIndex: 0,
            };
      const partitionOrderedCatalogIndices = Array.from(
        { length: partitionCatalog.objectCount },
        (_, index) => index,
      );
      const requestRange =
        partitionMode === "catalog-block-pair"
          ? {
              primaryStartOrderIndex: partitionCatalog.primaryStartOrderIndex,
              primaryEndOrderIndex: partitionCatalog.primaryEndOrderIndex,
              secondaryStartOrderIndex: partitionCatalog.secondaryStartOrderIndex,
              secondaryEndOrderIndex: partitionCatalog.secondaryEndOrderIndex,
            }
          : range;
      const requestPayload = createScreenCatalogRequest(
        flatc,
        options,
        requestRange,
        orderedCatalogIndices ?? partitionOrderedCatalogIndices,
      );
      const partitionStartedAt = performance.now();
      const response = await harness.invoke({
        methodId: "screen_catalog",
        inputs: [
          { portId: "request", payload: requestPayload },
          { portId: "catalog", payload: partitionCatalog.payload },
        ],
      });
      const elapsedMs = performance.now() - partitionStartedAt;
      const resultFrame = response.outputs?.find(
        (frame) => frame.portId === "result",
      );
      const decoded =
        resultFrame?.payload instanceof Uint8Array
          ? JSON.parse(
              flatc.generateJSON(
                screenCatalogResultSchema(),
                { path: "/result.bin", data: resultFrame.payload },
                { defaultsJson: true },
              ),
            )
          : null;

      const partition = {
        partitionIndex: range.partitionIndex,
        startOrderIndex: range.startOrderIndex,
        endOrderIndex: range.endOrderIndex,
        primaryStartOrderIndex: range.primaryStartOrderIndex,
        primaryEndOrderIndex: range.primaryEndOrderIndex,
        secondaryStartOrderIndex: range.secondaryStartOrderIndex,
        secondaryEndOrderIndex: range.secondaryEndOrderIndex,
        catalogBytes: partitionCatalog.payload.byteLength,
        statusCode: response.statusCode,
        errorMessage: response.errorMessage ?? "",
        elapsedMs,
        objectsParsed: decoded?.objectsParsed ?? 0,
        conjunctionsFound: decoded?.conjunctionsFound ?? 0,
        stats: decoded?.stats ?? null,
      };
      partitions.push(partition);
      await writePartitionCheckpoint(options.checkpointDir, partition);
    }
  } finally {
    await harness?.destroy?.();
    await builtRunner?.cleanup();
  }

  const wallElapsedMs = performance.now() - startedAt;
  partitions.sort((left, right) => left.partitionIndex - right.partitionIndex);
  const aggregate = aggregatePartitions(partitions, objectCount, wallElapsedMs);
  aggregate.deferredPartitions = workPlan.deferredRanges.length;
  const complete =
    workPlan.deferredRanges.length === 0 && aggregate.failedPartitions === 0;
  const summary = {
    catalogPath: path.resolve(options.catalog),
    catalogBytes: catalogPayload.byteLength,
    sourceCatalogBytes: sourceCatalogPayload.byteLength,
    sourceObjectCount: catalogWindow.sourceObjectCount ?? objectCount,
    catalogStartFrame: catalogWindow.startFrame,
    catalogEndFrame: catalogWindow.endFrame ?? objectCount,
    objectCount,
    partitionMode,
    partitionSize: options.partitionSize,
    catalogBlockSize: options.catalogBlockSize,
    startOrderIndex,
    endOrderIndex,
    checkpointDir: options.checkpointDir ? path.resolve(options.checkpointDir) : null,
    resume: options.resume,
    partitionShardCount: options.partitionShardCount,
    partitionShardIndex: options.partitionShardIndex,
    maxPartitions: options.maxPartitions,
    complete,
    deferredRanges: workPlan.deferredRanges,
    partitions,
    aggregate,
  };
  const provenance = buildPartitionedRunProvenance(summary, options);
  const privateKey = readPrivateKey(options);
  summary.provenance = privateKey
    ? signPartitionedRunProvenance(provenance, privateKey)
    : provenance;
  return summary;
}

async function main() {
  const options = parseCliOptions(parseArgs(process.argv.slice(2)));
  const summary = await runPartitionedSdnOmmCatalog(options);
  const json = JSON.stringify(summary, null, 2);
  if (options.output) {
    await writeFile(options.output, `${json}\n`);
  }
  console.log(json);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
