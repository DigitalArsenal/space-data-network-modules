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
  chmod,
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
    partitionTimeoutMs:
      rawOptions["partition-timeout-ms"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["partition-timeout-ms"],
              "partition-timeout-ms",
              0,
            ),
          ),
    writeShardScript: rawOptions["write-shard-script"],
    shardOutputDir: rawOptions["shard-output-dir"],
    writeTimeoutRetryPlan: rawOptions["write-timeout-retry-plan"],
    retryPlan: rawOptions["retry-plan"],
    writeRetryScript: rawOptions["write-retry-script"],
    minCatalogBlockSize:
      rawOptions["min-catalog-block-size"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["min-catalog-block-size"],
              "min-catalog-block-size",
              0,
            ),
          ),
    blockPairPrimaryStartOrderIndex:
      rawOptions["block-pair-primary-start-order-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-primary-start-order-index"],
              "block-pair-primary-start-order-index",
              0,
            ),
          ),
    blockPairPrimaryEndOrderIndex:
      rawOptions["block-pair-primary-end-order-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-primary-end-order-index"],
              "block-pair-primary-end-order-index",
              0,
            ),
          ),
    blockPairSecondaryStartOrderIndex:
      rawOptions["block-pair-secondary-start-order-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-secondary-start-order-index"],
              "block-pair-secondary-start-order-index",
              0,
            ),
          ),
    blockPairSecondaryEndOrderIndex:
      rawOptions["block-pair-secondary-end-order-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-secondary-end-order-index"],
              "block-pair-secondary-end-order-index",
              0,
            ),
          ),
    blockPairPartitionIndex:
      rawOptions["block-pair-partition-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-partition-index"],
              "block-pair-partition-index",
              0,
            ),
          ),
    blockPairParentPartitionIndex:
      rawOptions["block-pair-parent-partition-index"] === undefined
        ? null
        : Math.trunc(
            requiredNumber(
              rawOptions["block-pair-parent-partition-index"],
              "block-pair-parent-partition-index",
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

function hasExplicitBlockPairRange(options) {
  return (
    options.blockPairPrimaryStartOrderIndex !== null ||
    options.blockPairPrimaryEndOrderIndex !== null ||
    options.blockPairSecondaryStartOrderIndex !== null ||
    options.blockPairSecondaryEndOrderIndex !== null
  );
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

async function loadPartitionCheckpointRecords(checkpointDir) {
  if (!checkpointDir) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(checkpointDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const partitions = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^partition-\d+-\d+-\d+(?:-\d+-\d+)?\.json$/.test(entry.name)
    ) {
      continue;
    }
    const pathname = path.join(checkpointDir, entry.name);
    partitions.push(JSON.parse(await readFile(pathname, "utf8")));
  }
  partitions.sort((left, right) => left.partitionIndex - right.partitionIndex);
  return partitions;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function addCommandArg(parts, name, value) {
  if (value === undefined || value === null || value === false) {
    return;
  }
  if (value === true) {
    parts.push(`--${name}`);
    return;
  }
  parts.push(`--${name}`, shellQuote(value));
}

async function writeShardScript(options, summary) {
  if (!options.writeShardScript) {
    return null;
  }
  const scriptPath = path.resolve(options.writeShardScript);
  const outputDir = path.resolve(
    options.shardOutputDir ?? path.dirname(scriptPath),
  );
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const scriptRelative = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  const scriptEntrypoint = scriptRelative.startsWith("..")
    ? fileURLToPath(import.meta.url)
    : scriptRelative;
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
  ];
  for (const shard of summary.shards) {
    const parts = [
      "node",
      shellQuote(scriptEntrypoint),
    ];
    addCommandArg(parts, "catalog", options.catalog);
    addCommandArg(parts, "catalog-block-size", options.catalogBlockSize);
    addCommandArg(parts, "partition-size", options.partitionSize);
    addCommandArg(parts, "partition-timeout-ms", options.partitionTimeoutMs);
    addCommandArg(parts, "checkpoint-dir", options.checkpointDir);
    addCommandArg(parts, "resume", true);
    addCommandArg(parts, "partition-shard-count", summary.partitionShardCount);
    addCommandArg(parts, "partition-shard-index", shard.partitionShardIndex);
    addCommandArg(parts, "max-partitions", options.maxPartitions);
    addCommandArg(parts, "provider-id", options.providerId);
    addCommandArg(parts, "source-id", options.sourceId);
    addCommandArg(parts, "source-pnm-cid", options.sourcePnmCids?.join(","));
    addCommandArg(parts, "module-artifact-hash", options.moduleArtifactHash);
    addCommandArg(parts, "module-version", options.moduleVersion);
    addCommandArg(parts, "signing-private-key", options.signingPrivateKey);
    addCommandArg(parts, "start-jd", options.startJd);
    addCommandArg(parts, "duration-days", options.durationDays);
    addCommandArg(parts, "threshold-km", options.thresholdKm);
    addCommandArg(parts, "num-threads", options.numThreads);
    addCommandArg(parts, "coarse-step-sec", options.coarseStepSec);
    addCommandArg(parts, "fine-tol-sec", options.fineTolSec);
    addCommandArg(parts, "combined-radius-m", options.combinedRadiusM);
    addCommandArg(parts, "start-order-index", options.startOrderIndex);
    addCommandArg(parts, "end-order-index", options.endOrderIndex);
    addCommandArg(parts, "catalog-start-frame", options.catalogStartFrame);
    addCommandArg(parts, "catalog-end-frame", options.catalogEndFrame);
    addCommandArg(parts, "catalog-frame-limit", options.catalogFrameLimit);
    addCommandArg(parts, "wasm", options.wasm);
    addCommandArg(parts, "wasmedge-binary", options.wasmEdgeBinary);
    addCommandArg(parts, "wasmedge-runner-binary", options.wasmEdgeRunnerBinary);
    if (options.useKdTree === false) {
      addCommandArg(parts, "no-kdtree", true);
    }
    if (options.useDynamicWindow === false) {
      addCommandArg(parts, "no-dynamic-window", true);
    }
    if (options.usePerigeeFilter === false) {
      addCommandArg(parts, "no-perigee-filter", true);
    }
    addCommandArg(
      parts,
      "output",
      path.join(
        outputDir,
        `summary-shard-${String(shard.partitionShardIndex).padStart(3, "0")}.json`,
      ),
    );
    lines.push(parts.join(" "));
    lines.push("");
  }
  await writeFile(scriptPath, `${lines.join("\n")}\n`, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function planShardExecution(options) {
  if (!options.catalog) {
    throw new Error("--catalog is required.");
  }
  if (options.partitionShardCount <= 0) {
    throw new Error("--partition-shard-count must be greater than zero.");
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
    hasExplicitBlockPairRange(options) || options.catalogBlockSize !== null
      ? "catalog-block-pair"
      : "ordered-primary";
  const shardCount = options.partitionShardCount;
  const shards = [];
  let totalPartitions = 0;
  let completedPartitions = 0;
  let pendingPartitions = 0;
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const plan =
      partitionMode === "catalog-block-pair"
        ? planCatalogBlockPairWork({
            objectCount,
            startOrderIndex,
            endOrderIndex,
            catalogBlockSize: options.catalogBlockSize,
            resume: options.resume,
            maxPartitions: null,
            partitionShardCount: shardCount,
            partitionShardIndex: shardIndex,
            completedPartitions: checkpointState.completedPartitions,
          })
        : planPartitionWork({
            objectCount,
            startOrderIndex,
            endOrderIndex,
            partitionSize: options.partitionSize,
            resume: options.resume,
            maxPartitions: null,
            partitionShardCount: shardCount,
            partitionShardIndex: shardIndex,
            completedPartitions: checkpointState.completedPartitions,
          });
    const shard = {
      partitionShardIndex: shardIndex,
      totalPartitions: plan.allRanges.length,
      completedPartitions: plan.completedPartitions.length,
      pendingPartitions: plan.pendingRanges.length,
      firstPartitionIndex: plan.allRanges[0]?.partitionIndex ?? null,
      lastPartitionIndex: plan.allRanges.at(-1)?.partitionIndex ?? null,
    };
    totalPartitions += shard.totalPartitions;
    completedPartitions += shard.completedPartitions;
    pendingPartitions += shard.pendingPartitions;
    shards.push(shard);
  }
  const summary = {
    catalogPath: path.resolve(options.catalog),
    catalogBytes: catalogWindow.payload.byteLength,
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
    partitionShardCount: shardCount,
    maxPartitionsPerShardRun: options.maxPartitions,
    totalPartitions,
    completedPartitions,
    pendingPartitions,
    shards,
  };
  const shardScriptPath = await writeShardScript(options, summary);
  return {
    ...summary,
    shardScriptPath,
  };
}

async function writeTimeoutRetryPlan(options) {
  if (!options.checkpointDir) {
    throw new Error("--checkpoint-dir is required for --write-timeout-retry-plan.");
  }
  const retryPlanPath = path.resolve(options.writeTimeoutRetryPlan);
  const partitions = await loadPartitionCheckpointRecords(options.checkpointDir);
  const timeoutPartitions = partitions.filter(
    (partition) =>
      partition.statusCode === 124 &&
      partition.primaryStartOrderIndex !== undefined,
  );
  const minCatalogBlockSize = options.minCatalogBlockSize ?? 100;
  const ranges = planTimedOutBlockPairSubdivisions({
    partitions,
    minCatalogBlockSize,
  });
  const retryPlan = {
    schemaVersion: 1,
    checkpointDir: path.resolve(options.checkpointDir),
    minCatalogBlockSize,
    timeoutPartitions: timeoutPartitions.length,
    retryRanges: ranges.length,
    ranges,
  };
  await mkdir(path.dirname(retryPlanPath), { recursive: true });
  await writeFile(retryPlanPath, `${JSON.stringify(retryPlan, null, 2)}\n`);
  return {
    ...retryPlan,
    retryPlanPath,
  };
}

async function writeRetryScript(options) {
  if (!options.retryPlan) {
    throw new Error("--retry-plan is required for --write-retry-script.");
  }
  if (!options.catalog) {
    throw new Error("--catalog is required for --write-retry-script.");
  }
  if (!options.checkpointDir) {
    throw new Error("--checkpoint-dir is required for --write-retry-script.");
  }
  const retryPlanPath = path.resolve(options.retryPlan);
  const retryScriptPath = path.resolve(options.writeRetryScript);
  const retryPlan = JSON.parse(await readFile(retryPlanPath, "utf8"));
  const ranges = Array.isArray(retryPlan.ranges) ? retryPlan.ranges : [];
  const outputDir = path.resolve(
    options.shardOutputDir ?? path.dirname(retryScriptPath),
  );
  await mkdir(path.dirname(retryScriptPath), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const scriptRelative = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  const scriptEntrypoint = scriptRelative.startsWith("..")
    ? fileURLToPath(import.meta.url)
    : scriptRelative;
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
  ];
  ranges.forEach((range, index) => {
    const parts = [
      "node",
      shellQuote(scriptEntrypoint),
    ];
    addCommandArg(parts, "catalog", options.catalog);
    addCommandArg(parts, "block-pair-partition-index", range.parentPartitionIndex ?? index);
    addCommandArg(parts, "block-pair-parent-partition-index", range.parentPartitionIndex);
    addCommandArg(parts, "block-pair-primary-start-order-index", range.primaryStartOrderIndex);
    addCommandArg(parts, "block-pair-primary-end-order-index", range.primaryEndOrderIndex);
    addCommandArg(parts, "block-pair-secondary-start-order-index", range.secondaryStartOrderIndex);
    addCommandArg(parts, "block-pair-secondary-end-order-index", range.secondaryEndOrderIndex);
    addCommandArg(parts, "partition-size", options.partitionSize);
    addCommandArg(parts, "partition-timeout-ms", options.partitionTimeoutMs);
    addCommandArg(parts, "checkpoint-dir", options.checkpointDir);
    addCommandArg(parts, "resume", true);
    addCommandArg(parts, "provider-id", options.providerId);
    addCommandArg(parts, "source-id", options.sourceId);
    addCommandArg(parts, "source-pnm-cid", options.sourcePnmCids?.join(","));
    addCommandArg(parts, "module-artifact-hash", options.moduleArtifactHash);
    addCommandArg(parts, "module-version", options.moduleVersion);
    addCommandArg(parts, "signing-private-key", options.signingPrivateKey);
    addCommandArg(parts, "start-jd", options.startJd);
    addCommandArg(parts, "duration-days", options.durationDays);
    addCommandArg(parts, "threshold-km", options.thresholdKm);
    addCommandArg(parts, "num-threads", options.numThreads);
    addCommandArg(parts, "coarse-step-sec", options.coarseStepSec);
    addCommandArg(parts, "fine-tol-sec", options.fineTolSec);
    addCommandArg(parts, "combined-radius-m", options.combinedRadiusM);
    addCommandArg(parts, "start-order-index", options.startOrderIndex);
    addCommandArg(parts, "end-order-index", options.endOrderIndex);
    addCommandArg(parts, "catalog-start-frame", options.catalogStartFrame);
    addCommandArg(parts, "catalog-end-frame", options.catalogEndFrame);
    addCommandArg(parts, "catalog-frame-limit", options.catalogFrameLimit);
    addCommandArg(parts, "wasm", options.wasm);
    addCommandArg(parts, "wasmedge-binary", options.wasmEdgeBinary);
    addCommandArg(parts, "wasmedge-runner-binary", options.wasmEdgeRunnerBinary);
    if (options.useKdTree === false) {
      addCommandArg(parts, "no-kdtree", true);
    }
    if (options.useDynamicWindow === false) {
      addCommandArg(parts, "no-dynamic-window", true);
    }
    if (options.usePerigeeFilter === false) {
      addCommandArg(parts, "no-perigee-filter", true);
    }
    addCommandArg(
      parts,
      "output",
      path.join(outputDir, `retry-${String(index).padStart(6, "0")}.json`),
    );
    lines.push(parts.join(" "));
    lines.push("");
  });
  await writeFile(retryScriptPath, `${lines.join("\n")}\n`, { mode: 0o755 });
  await chmod(retryScriptPath, 0o755);
  return {
    retryPlanPath,
    retryScriptPath,
    retryRanges: ranges.length,
    checkpointDir: path.resolve(options.checkpointDir),
    outputDir,
  };
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

export function planExplicitBlockPairWork({
  primaryStartOrderIndex,
  primaryEndOrderIndex,
  secondaryStartOrderIndex,
  secondaryEndOrderIndex,
  partitionIndex = 0,
  parentPartitionIndex = null,
  resume = false,
  completedPartitions = [],
}) {
  const range = {
    partitionIndex,
    parentPartitionIndex,
    primaryStartOrderIndex,
    primaryEndOrderIndex,
    secondaryStartOrderIndex,
    secondaryEndOrderIndex,
    diagonal:
      primaryStartOrderIndex === secondaryStartOrderIndex &&
      primaryEndOrderIndex === secondaryEndOrderIndex,
  };
  for (const [name, value] of Object.entries(range)) {
    if (name === "parentPartitionIndex" || name === "diagonal") {
      continue;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer.`);
    }
  }
  if (primaryEndOrderIndex <= primaryStartOrderIndex) {
    throw new Error("primary explicit block-pair range must be non-empty.");
  }
  if (secondaryEndOrderIndex <= secondaryStartOrderIndex) {
    throw new Error("secondary explicit block-pair range must be non-empty.");
  }

  const completedByRange = new Map(
    completedPartitions.map((partition) => [checkpointKey(partition), partition]),
  );
  const completed = resume
    ? [completedByRange.get(checkpointKey(range))].filter(Boolean)
    : [];
  const pendingRanges =
    resume && completed.length > 0
      ? []
      : [range];
  return {
    objectCount: null,
    allRanges: [range],
    completedPartitions: completed,
    pendingRanges,
    deferredRanges: [],
    complete: true,
  };
}

export function planTimedOutBlockPairSubdivisions({
  partitions,
  minCatalogBlockSize,
}) {
  if (!Array.isArray(partitions)) {
    throw new TypeError("partitions must be an array");
  }
  const minimum = Math.trunc(requiredNumber(minCatalogBlockSize, "min-catalog-block-size", 1));
  if (minimum <= 0) {
    throw new Error("--min-catalog-block-size must be greater than zero.");
  }

  const retryRanges = [];
  for (const partition of partitions) {
    if (partition.statusCode !== 124) {
      continue;
    }
    if (partition.primaryStartOrderIndex === undefined) {
      continue;
    }
    const primaryRanges = splitRetryRange(
      partition.primaryStartOrderIndex,
      partition.primaryEndOrderIndex,
      minimum,
    );
    const secondaryRanges = splitRetryRange(
      partition.secondaryStartOrderIndex,
      partition.secondaryEndOrderIndex,
      minimum,
    );
    for (const primary of primaryRanges) {
      for (const secondary of secondaryRanges) {
        if (
          partition.diagonal &&
          secondary.start < primary.start
        ) {
          continue;
        }
        retryRanges.push({
          parentPartitionIndex: partition.partitionIndex,
          primaryStartOrderIndex: primary.start,
          primaryEndOrderIndex: primary.end,
          secondaryStartOrderIndex: secondary.start,
          secondaryEndOrderIndex: secondary.end,
          diagonal:
            primary.start === secondary.start && primary.end === secondary.end,
          catalogBlockSize: Math.max(
            primary.end - primary.start,
            secondary.end - secondary.start,
          ),
        });
      }
    }
  }
  return retryRanges;
}

function splitRetryRange(start, end, minimum) {
  const span = end - start;
  if (span <= minimum) {
    return [{ start, end }];
  }
  const ranges = [];
  for (let index = start; index < end; index += minimum) {
    ranges.push({
      start: index,
      end: Math.min(index + minimum, end),
    });
  }
  return ranges;
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

export async function invokeWithTimeout(invoke, timeoutMs, label = "partition") {
  if (timeoutMs === null || timeoutMs === undefined || timeoutMs <= 0) {
    return invoke();
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms`);
      error.code = "ERR_PARTITION_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(invoke)
        .catch((error) => {
          throw error;
        }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
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
    hasExplicitBlockPairRange(options) || options.catalogBlockSize !== null
      ? "catalog-block-pair"
      : "ordered-primary";
  const workPlan =
    hasExplicitBlockPairRange(options)
      ? planExplicitBlockPairWork({
          primaryStartOrderIndex: options.blockPairPrimaryStartOrderIndex,
          primaryEndOrderIndex: options.blockPairPrimaryEndOrderIndex,
          secondaryStartOrderIndex: options.blockPairSecondaryStartOrderIndex,
          secondaryEndOrderIndex: options.blockPairSecondaryEndOrderIndex,
          partitionIndex: options.blockPairPartitionIndex ?? 0,
          parentPartitionIndex: options.blockPairParentPartitionIndex,
          resume: options.resume,
          completedPartitions: checkpointState.completedPartitions,
        })
      : partitionMode === "catalog-block-pair"
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
  const runtimeDeferredRanges = [];
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
    for (let rangeIndex = 0; rangeIndex < workPlan.pendingRanges.length; rangeIndex += 1) {
      const range = workPlan.pendingRanges[rangeIndex];
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
      let response;
      let timedOut = false;
      try {
        response = await invokeWithTimeout(
          () =>
            harness.invoke({
              methodId: "screen_catalog",
              inputs: [
                { portId: "request", payload: requestPayload },
                { portId: "catalog", payload: partitionCatalog.payload },
              ],
            }),
          options.partitionTimeoutMs,
          `partition ${range.partitionIndex}`,
        );
      } catch (error) {
        if (error?.code !== "ERR_PARTITION_TIMEOUT") {
          throw error;
        }
        timedOut = true;
        response = {
          statusCode: 124,
          errorMessage: error.message,
          outputs: [],
        };
      }
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
      if (timedOut) {
        runtimeDeferredRanges.push(
          ...workPlan.pendingRanges.slice(rangeIndex + 1),
        );
        break;
      }
    }
  } finally {
    await harness?.destroy?.();
    await builtRunner?.cleanup();
  }

  const wallElapsedMs = performance.now() - startedAt;
  partitions.sort((left, right) => left.partitionIndex - right.partitionIndex);
  const aggregate = aggregatePartitions(partitions, objectCount, wallElapsedMs);
  const deferredRanges = [...runtimeDeferredRanges, ...workPlan.deferredRanges];
  aggregate.deferredPartitions = deferredRanges.length;
  const complete =
    deferredRanges.length === 0 && aggregate.failedPartitions === 0;
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
    deferredRanges,
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
  const summary = options.writeTimeoutRetryPlan
    ? await writeTimeoutRetryPlan(options)
    : options.writeRetryScript
      ? await writeRetryScript(options)
      : options.writeShardScript
        ? await planShardExecution(options)
        : await runPartitionedSdnOmmCatalog(options);
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
