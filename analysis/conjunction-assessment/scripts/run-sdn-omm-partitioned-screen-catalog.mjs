#!/usr/bin/env node

import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    options[key] = next;
    index++;
  }
  return options;
}

function requiredNumber(value, name, defaultValue) {
  const resolved = value ?? defaultValue;
  const numeric = Number(resolved);
  if (!Number.isFinite(numeric)) {
    throw new Error(`--${name} must be numeric.`);
  }
  return numeric;
}

function countUint32beFrames(buffer) {
  let offset = 0;
  let frames = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error(`Truncated uint32be frame length at byte ${offset}.`);
    }
    const frameLength = buffer.readUInt32BE(offset);
    offset += 4;
    if (frameLength <= 0) {
      throw new Error(`Invalid zero-length frame at index ${frames}.`);
    }
    if (offset + frameLength > buffer.length) {
      throw new Error(
        `Truncated uint32be frame ${frames}: length ${frameLength} exceeds remaining bytes.`,
      );
    }
    offset += frameLength;
    frames++;
  }
  return frames;
}

function makeRange(start, end, step) {
  const ranges = [];
  for (let index = start; index < end; index += step) {
    ranges.push([index, Math.min(index + step, end)]);
  }
  return ranges;
}

function createScreenCatalogRequest(flatc, options, range, orderedCatalogIndices) {
  const [startOrderIndex, endOrderIndex] = range;
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
    }),
    { sizePrefix: false },
  );
}

function parseCliOptions(rawOptions) {
  return {
    catalog: rawOptions.catalog,
    output: rawOptions.output,
    wasm: rawOptions.wasm ?? DEFAULT_WASM_PATH,
    wasmEdgeBinary: rawOptions["wasmedge-binary"],
    wasmEdgeRunnerBinary: rawOptions["wasmedge-runner-binary"],
    partitionSize: Math.trunc(
      requiredNumber(rawOptions["partition-size"], "partition-size", 100),
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
    sourceId: rawOptions["source-id"],
    providerId: rawOptions["provider-id"],
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

function aggregatePartitions(partitions, objectCount, wallElapsedMs) {
  const aggregate = {
    partitions: partitions.length,
    failedPartitions: 0,
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

  const catalogPayload = fs.readFileSync(options.catalog);
  const objectCount = countUint32beFrames(catalogPayload);
  const startOrderIndex = Math.min(options.startOrderIndex, objectCount);
  const endOrderIndex = Math.min(options.endOrderIndex ?? objectCount, objectCount);
  if (endOrderIndex < startOrderIndex) {
    throw new Error("--end-order-index must be greater than or equal to --start-order-index.");
  }

  const orderedCatalogIndices = Array.from(
    { length: objectCount },
    (_, index) => index,
  );
  const ranges = makeRange(startOrderIndex, endOrderIndex, options.partitionSize);
  const flatc = await FlatcRunner.init();
  const builtRunner = options.wasmEdgeRunnerBinary ? null : await maybeBuildRunner();
  const harness = await loadModule({
    wasmSource: options.wasm,
    runtimeKind: "wasmedge",
    enableThreads: true,
    wasmEdgeBinary: options.wasmEdgeBinary,
    wasmEdgeRunnerBinary:
      options.wasmEdgeRunnerBinary ?? builtRunner?.runnerBinary,
    cwd: PACKAGE_ROOT,
  });

  const partitions = [];
  const startedAt = performance.now();
  try {
    for (let partitionIndex = 0; partitionIndex < ranges.length; partitionIndex++) {
      const range = ranges[partitionIndex];
      const requestPayload = createScreenCatalogRequest(
        flatc,
        options,
        range,
        orderedCatalogIndices,
      );
      const partitionStartedAt = performance.now();
      const response = await harness.invoke({
        methodId: "screen_catalog",
        inputs: [
          { portId: "request", payload: requestPayload },
          { portId: "catalog", payload: catalogPayload },
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

      partitions.push({
        partitionIndex,
        startOrderIndex: range[0],
        endOrderIndex: range[1],
        statusCode: response.statusCode,
        errorMessage: response.errorMessage ?? "",
        elapsedMs,
        objectsParsed: decoded?.objectsParsed ?? 0,
        conjunctionsFound: decoded?.conjunctionsFound ?? 0,
        stats: decoded?.stats ?? null,
      });
    }
  } finally {
    await harness.destroy?.();
    await builtRunner?.cleanup();
  }

  const wallElapsedMs = performance.now() - startedAt;
  return {
    catalogPath: path.resolve(options.catalog),
    catalogBytes: catalogPayload.byteLength,
    objectCount,
    partitionSize: options.partitionSize,
    startOrderIndex,
    endOrderIndex,
    partitions,
    aggregate: aggregatePartitions(partitions, objectCount, wallElapsedMs),
  };
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
