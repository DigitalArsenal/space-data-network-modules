import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FlatcRunner } from "flatc-wasm";

import { conjunctionArtifactExists } from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import {
  buildPartitionedRunProvenance,
  invokeWithTimeout,
  loadPartitionCheckpoints,
  planExplicitBlockPairWork,
  planCatalogBlockPairWork,
  planTimedOutBlockPairSubdivisions,
  planPartitionWork,
  sliceUint32beBlockPair,
  sliceUint32beFrames,
  canonicalJson,
  canonicalSha256Hex,
  signPartitionedRunProvenance,
} from "../scripts/run-sdn-omm-partitioned-screen-catalog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

test("partition invocation timeout fails bounded work instead of waiting forever", async () => {
  await assert.rejects(
    () => invokeWithTimeout(() => new Promise(() => {}), 5, "partition 4"),
    /partition 4 timed out after 5 ms/,
  );

  const result = await invokeWithTimeout(
    () => Promise.resolve({ statusCode: 0 }),
    50,
    "partition 5",
  );
  assert.deepEqual(result, { statusCode: 0 });
});

test("timed-out block-pair checkpoints split into smaller retry ranges", () => {
  const retries = planTimedOutBlockPairSubdivisions({
    partitions: [
      {
        partitionIndex: 4,
        statusCode: 124,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 500,
        secondaryStartOrderIndex: 2000,
        secondaryEndOrderIndex: 2500,
      },
      {
        partitionIndex: 5,
        statusCode: 0,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 500,
        secondaryStartOrderIndex: 2500,
        secondaryEndOrderIndex: 3000,
      },
    ],
    minCatalogBlockSize: 250,
  });

  assert.deepEqual(
    retries.map((range) => [
      range.parentPartitionIndex,
      range.primaryStartOrderIndex,
      range.primaryEndOrderIndex,
      range.secondaryStartOrderIndex,
      range.secondaryEndOrderIndex,
      range.catalogBlockSize,
    ]),
    [
      [4, 0, 250, 2000, 2250, 250],
      [4, 0, 250, 2250, 2500, 250],
      [4, 250, 500, 2000, 2250, 250],
      [4, 250, 500, 2250, 2500, 250],
    ],
  );
});

test("explicit block-pair planner schedules a single retry child range", () => {
  const plan = planExplicitBlockPairWork({
    primaryStartOrderIndex: 0,
    primaryEndOrderIndex: 250,
    secondaryStartOrderIndex: 2000,
    secondaryEndOrderIndex: 2250,
    partitionIndex: 4,
    parentPartitionIndex: 4,
    resume: false,
  });

  assert.deepEqual(plan.pendingRanges, [
    {
      partitionIndex: 4,
      parentPartitionIndex: 4,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 250,
      secondaryStartOrderIndex: 2000,
      secondaryEndOrderIndex: 2250,
      diagonal: false,
    },
  ]);
  assert.equal(plan.complete, true);
});

test("partitioned runner can resume from successful checkpoints and schedule only pending work", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-resume-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(
    path.join(tempDir, "partition-000001-000002-000004.json"),
    JSON.stringify({
      partitionIndex: 1,
      startOrderIndex: 2,
      endOrderIndex: 4,
      statusCode: 0,
      objectsParsed: 6,
      conjunctionsFound: 1,
      stats: { pairsScreened: 8 },
    }),
  );
  await writeFile(
    path.join(tempDir, "partition-000002-000004-000006.json"),
    JSON.stringify({
      partitionIndex: 2,
      startOrderIndex: 4,
      endOrderIndex: 6,
      statusCode: 2,
      objectsParsed: 0,
      conjunctionsFound: 0,
      stats: { pairsScreened: 0 },
    }),
  );

  const checkpoints = await loadPartitionCheckpoints(tempDir);
  const plan = planPartitionWork({
    objectCount: 6,
    startOrderIndex: 0,
    endOrderIndex: 6,
    partitionSize: 2,
    resume: true,
    maxPartitions: 1,
    completedPartitions: checkpoints.completedPartitions,
  });

  assert.deepEqual(
    plan.completedPartitions.map((partition) => [
      partition.partitionIndex,
      partition.startOrderIndex,
      partition.endOrderIndex,
    ]),
    [[1, 2, 4]],
  );
  assert.deepEqual(
    plan.pendingRanges.map((partition) => [
      partition.partitionIndex,
      partition.startOrderIndex,
      partition.endOrderIndex,
    ]),
    [[0, 0, 2]],
  );
  assert.equal(plan.deferredRanges.length, 1);
  assert.equal(plan.deferredRanges[0].partitionIndex, 2);
});

test("catalog block-pair planner schedules exact upper-triangular block pairs", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-block-pairs-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(
    path.join(tempDir, "partition-000001-000000-000002-000002-000004.json"),
    JSON.stringify({
      partitionIndex: 1,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 2,
      secondaryStartOrderIndex: 2,
      secondaryEndOrderIndex: 4,
      statusCode: 0,
      objectsParsed: 4,
      conjunctionsFound: 0,
      stats: { pairsScreened: 4 },
    }),
  );

  const checkpoints = await loadPartitionCheckpoints(tempDir);
  const plan = planCatalogBlockPairWork({
    objectCount: 6,
    startOrderIndex: 0,
    endOrderIndex: 6,
    catalogBlockSize: 2,
    resume: true,
    maxPartitions: 2,
    completedPartitions: checkpoints.completedPartitions,
  });

  assert.deepEqual(
    plan.allRanges.map((range) => [
      range.partitionIndex,
      range.primaryStartOrderIndex,
      range.primaryEndOrderIndex,
      range.secondaryStartOrderIndex,
      range.secondaryEndOrderIndex,
      range.diagonal,
    ]),
    [
      [0, 0, 2, 0, 2, true],
      [1, 0, 2, 2, 4, false],
      [2, 0, 2, 4, 6, false],
      [3, 2, 4, 2, 4, true],
      [4, 2, 4, 4, 6, false],
      [5, 4, 6, 4, 6, true],
    ],
  );
  assert.deepEqual(
    plan.completedPartitions.map((partition) => partition.partitionIndex),
    [1],
  );
  assert.deepEqual(
    plan.pendingRanges.map((range) => range.partitionIndex),
    [0, 2],
  );
  assert.deepEqual(
    plan.deferredRanges.map((range) => range.partitionIndex),
    [3, 4, 5],
  );
});

test("partitioned runner provenance hashes and Ed25519 signatures are deterministic and verifiable", () => {
  const summary = {
    catalogPath: "/tmp/catalog.uint32be.bin",
    catalogBytes: 24,
    objectCount: 2,
    partitionSize: 1,
    startOrderIndex: 0,
    endOrderIndex: 2,
    partitions: [
      {
        partitionIndex: 0,
        startOrderIndex: 0,
        endOrderIndex: 1,
        statusCode: 0,
        errorMessage: "",
        elapsedMs: 12.5,
        objectsParsed: 2,
        conjunctionsFound: 1,
        stats: {
          elapsedMs: 12.5,
          pairsScreened: 1,
          pairsPrefiltered: 0,
          kdtreeCandidates: 1,
          tcaRefined: 1,
          propagations: 2,
        },
      },
    ],
    aggregate: {
      partitions: 1,
      failedPartitions: 0,
      objectsParsed: 2,
      conjunctionsFound: 1,
      pairsScreened: 1,
      pairsPrefiltered: 0,
      kdtreeCandidates: 1,
      tcaRefined: 1,
      propagations: 2,
      elapsedMs: 12.5,
      wallElapsedMs: 18.75,
    },
  };
  const options = {
    catalog: "/tmp/catalog.uint32be.bin",
    providerId: "celestrak.eth",
    sourceId: "celestrak-full-catalog",
    sourcePnmCids: ["bafybeipnm1", "bafybeipnm2"],
    moduleArtifactHash: "sha256:" + "a".repeat(64),
    moduleVersion: "0.2.0",
    startJd: "2460743.5",
    durationDays: "0.01",
    thresholdKm: "15",
    numThreads: "1",
    coarseStepSec: "300",
    fineTolSec: "0.01",
    combinedRadiusM: "10",
    partitionSize: 1,
    startOrderIndex: 0,
    endOrderIndex: 2,
    useKdTree: true,
    useDynamicWindow: true,
    usePerigeeFilter: true,
  };

  const provenance = buildPartitionedRunProvenance(summary, options);
  const repeated = buildPartitionedRunProvenance(
    {
      ...summary,
      partitions: [{ ...summary.partitions[0], elapsedMs: 999 }],
      aggregate: { ...summary.aggregate, elapsedMs: 999, wallElapsedMs: 999 },
    },
    options,
  );
  assert.deepEqual(provenance, repeated);
  assert.equal(provenance.sourcePnmCids.length, 2);
  assert.equal(
    provenance.configHash,
    canonicalSha256Hex(provenance.canonicalConfig),
  );
  assert.equal(
    provenance.queryHash,
    canonicalSha256Hex(provenance.canonicalQuery),
  );
  assert.equal(
    provenance.resultHash,
    canonicalSha256Hex(provenance.canonicalResult),
  );
  assert.equal(provenance.cdmOutputMetadata.available, false);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const signed = signPartitionedRunProvenance(provenance, privateKey);
  assert.ok(
    crypto.verify(
      null,
      Buffer.from(canonicalJson(signed.signedPayload), "utf8"),
      publicKey,
      Buffer.from(signed.resultSignature.signature, "base64"),
    ),
  );
  assert.equal(signed.resultSignature.algorithm, "Ed25519");
});

function readText(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function ommSchema() {
  return {
    entry: "/sds/OMM/main.fbs",
    files: {
      "/sds/OMM/main.fbs": await readText(
        "../node_modules/spacedatastandards.org/schema/OMM/main.fbs",
      ),
      "/sds/RFM/main.fbs": await readText(
        "../node_modules/spacedatastandards.org/schema/RFM/main.fbs",
      ),
      "/sds/TIM/main.fbs": await readText(
        "../node_modules/spacedatastandards.org/schema/TIM/main.fbs",
      ),
      "/sds/MET/main.fbs": await readText(
        "../node_modules/spacedatastandards.org/schema/MET/main.fbs",
      ),
    },
  };
}

async function createOmmRecord(flatc, schema, noradCatId) {
  return flatc.generateBinary(
    schema,
    JSON.stringify({
      OBJECT_NAME: `PARTITION-${noradCatId}`,
      OBJECT_ID: `2026-002${noradCatId}`,
      EPOCH: "2026-03-09T00:00:00.000000",
      MEAN_MOTION: 14.2 + (noradCatId % 5) * 0.1,
      ECCENTRICITY: 0.001,
      INCLINATION: 40.0 + (noradCatId % 4),
      RA_OF_ASC_NODE: 1.0,
      ARG_OF_PERICENTER: 2.0,
      MEAN_ANOMALY: noradCatId % 360,
      EPHEMERIS_TYPE: "SGP4",
      CLASSIFICATION_TYPE: "U",
      NORAD_CAT_ID: noradCatId,
      ELEMENT_SET_NO: 1,
      REV_AT_EPOCH: 1,
      BSTAR: 0.0,
      MEAN_MOTION_DOT: 0.0,
      MEAN_MOTION_DDOT: 0.0,
    }),
    { sizePrefix: true },
  );
}

function encodeUint32beFramedStream(records) {
  const totalLength = records.reduce((sum, record) => sum + 4 + record.length, 0);
  const stream = new Uint8Array(totalLength);
  const view = new DataView(stream.buffer);
  let offset = 0;
  for (const record of records) {
    view.setUint32(offset, record.length, false);
    offset += 4;
    stream.set(record, offset);
    offset += record.length;
  }
  return stream;
}

test("partitioned runner can slice deterministic windows from uint32be OMM streams", () => {
  const first = Uint8Array.from([1, 2, 3]);
  const second = Uint8Array.from([4, 5]);
  const third = Uint8Array.from([6, 7, 8, 9]);
  const stream = Buffer.from(encodeUint32beFramedStream([first, second, third]));

  const sliced = sliceUint32beFrames(stream, 1, 3);
  assert.equal(sliced.objectCount, 2);
  assert.equal(sliced.sourceObjectCount, 3);
  assert.equal(sliced.startFrame, 1);
  assert.equal(sliced.endFrame, 3);
  assert.deepEqual(
    [...sliced.payload],
    [...encodeUint32beFramedStream([second, third])],
  );

  assert.throws(
    () => sliceUint32beFrames(stream, -1, 2),
    /catalog window start must be greater than or equal to zero/,
  );
  assert.throws(
    () => sliceUint32beFrames(stream.subarray(0, stream.length - 1), 0, 3),
    /Truncated uint32be frame/,
  );
});

test("catalog block-pair slicer builds minimal diagonal and off-diagonal streams", () => {
  const first = Uint8Array.from([1]);
  const second = Uint8Array.from([2]);
  const third = Uint8Array.from([3]);
  const fourth = Uint8Array.from([4]);
  const stream = Buffer.from(encodeUint32beFramedStream([first, second, third, fourth]));

  const diagonal = sliceUint32beBlockPair(stream, {
    primaryStartOrderIndex: 0,
    primaryEndOrderIndex: 2,
    secondaryStartOrderIndex: 0,
    secondaryEndOrderIndex: 2,
  });
  assert.equal(diagonal.objectCount, 2);
  assert.equal(diagonal.primaryStartOrderIndex, 0);
  assert.equal(diagonal.primaryEndOrderIndex, 2);
  assert.equal(diagonal.secondaryStartOrderIndex, 1);
  assert.equal(diagonal.secondaryEndOrderIndex, 2);
  assert.deepEqual([...diagonal.payload], [...encodeUint32beFramedStream([first, second])]);

  const offDiagonal = sliceUint32beBlockPair(stream, {
    primaryStartOrderIndex: 0,
    primaryEndOrderIndex: 2,
    secondaryStartOrderIndex: 2,
    secondaryEndOrderIndex: 4,
  });
  assert.equal(offDiagonal.objectCount, 4);
  assert.equal(offDiagonal.primaryStartOrderIndex, 0);
  assert.equal(offDiagonal.primaryEndOrderIndex, 2);
  assert.equal(offDiagonal.secondaryStartOrderIndex, 2);
  assert.equal(offDiagonal.secondaryEndOrderIndex, 4);
  assert.deepEqual(
    [...offDiagonal.payload],
    [...encodeUint32beFramedStream([first, second, third, fourth])],
  );
});

test("partitioned runner can write resumable block-pair shard commands without invoking WASM", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-shard-commands-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const catalogPath = path.join(tempDir, "catalog.uint32be.bin");
  const scriptPath = path.join(tempDir, "run-shards.sh");
  const outputDir = path.join(tempDir, "summaries");
  await writeFile(
    catalogPath,
    encodeUint32beFramedStream([
      Uint8Array.from([1]),
      Uint8Array.from([2]),
      Uint8Array.from([3]),
      Uint8Array.from([4]),
      Uint8Array.from([5]),
      Uint8Array.from([6]),
    ]),
  );

  const result = await runNodeScript([
    "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
    "--catalog",
    catalogPath,
    "--catalog-block-size",
    "2",
    "--partition-timeout-ms",
    "1234",
    "--partition-shard-count",
    "3",
    "--checkpoint-dir",
    path.join(tempDir, "checkpoints"),
    "--resume",
    "--max-partitions",
    "4",
    "--shard-output-dir",
    outputDir,
    "--write-shard-script",
    scriptPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.partitionMode, "catalog-block-pair");
  assert.equal(summary.objectCount, 6);
  assert.equal(summary.totalPartitions, 6);
  assert.equal(summary.partitionShardCount, 3);
  assert.deepEqual(
    summary.shards.map((shard) => [
      shard.partitionShardIndex,
      shard.totalPartitions,
      shard.pendingPartitions,
    ]),
    [
      [0, 2, 2],
      [1, 2, 2],
      [2, 2, 2],
    ],
  );
  assert.equal(summary.shardScriptPath, scriptPath);

  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /--partition-shard-index 0/);
  assert.match(script, /--partition-shard-index 1/);
  assert.match(script, /--partition-shard-index 2/);
  assert.match(script, /--catalog-block-size 2/);
  assert.match(script, /--partition-timeout-ms 1234/);
  assert.match(script, /--resume/);
  assert.match(script, /summary-shard-000.json/);
});

test("partitioned runner can write timeout retry plans without invoking WASM", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-timeout-retry-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const checkpointDir = path.join(tempDir, "checkpoints");
  const retryPlanPath = path.join(tempDir, "timeout-retries.json");
  await mkdir(checkpointDir);
  await writeFile(
    path.join(checkpointDir, "partition-000004-000000-000500-002000-002500.json"),
    JSON.stringify({
      partitionIndex: 4,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 500,
      secondaryStartOrderIndex: 2000,
      secondaryEndOrderIndex: 2500,
      statusCode: 124,
      errorMessage: "partition 4 timed out after 5000 ms",
    }),
  );

  const result = await runNodeScript([
    "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
    "--checkpoint-dir",
    checkpointDir,
    "--min-catalog-block-size",
    "250",
    "--write-timeout-retry-plan",
    retryPlanPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.timeoutPartitions, 1);
  assert.equal(summary.retryRanges, 4);
  assert.equal(summary.retryPlanPath, retryPlanPath);

  const retryPlan = JSON.parse(await readFile(retryPlanPath, "utf8"));
  assert.deepEqual(
    retryPlan.ranges.map((range) => [
      range.parentPartitionIndex,
      range.primaryStartOrderIndex,
      range.primaryEndOrderIndex,
      range.secondaryStartOrderIndex,
      range.secondaryEndOrderIndex,
    ]),
    [
      [4, 0, 250, 2000, 2250],
      [4, 0, 250, 2250, 2500],
      [4, 250, 500, 2000, 2250],
      [4, 250, 500, 2250, 2500],
    ],
  );
});

function runNodeScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

test(
  "partitioned SDN OMM runner invokes ordered catalog ranges and aggregates stats",
  { timeout: 30000 },
  async (t) => {
    if (!conjunctionArtifactExists()) {
      t.skip("Build conjunction-assessment before running the partitioned runner test.");
      return;
    }
    const runnerBinary = await buildThreadedWasmEdgeRunner(
      t,
      "conjunction-sdn-partitioned-runner-",
    );
    if (!runnerBinary) {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-partitions-"));
    t.after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const flatc = await FlatcRunner.init();
    const schema = await ommSchema();
    const records = [];
    for (let index = 0; index < 6; index++) {
      records.push(await createOmmRecord(flatc, schema, 93000 + index));
    }

    const catalogPath = path.join(tempDir, "catalog.uint32be.bin");
    const outputPath = path.join(tempDir, "summary.json");
    const privateKeyPath = path.join(tempDir, "test-ed25519-private.pem");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    await writeFile(catalogPath, encodeUint32beFramedStream(records));
    await writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );

    const result = await runNodeScript([
      "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
      "--catalog",
      catalogPath,
      "--partition-size",
      "2",
      "--duration-days",
      "0",
      "--coarse-step-sec",
      "600",
      "--wasmedge-runner-binary",
      runnerBinary,
      "--source-pnm-cid",
      "bafybeipnmfixture",
      "--signing-private-key",
      privateKeyPath,
      "--output",
      outputPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(summary.objectCount, 6);
    assert.equal(summary.aggregate.partitions, 3);
    assert.deepEqual(
      summary.partitions.map((partition) => [
        partition.startOrderIndex,
        partition.endOrderIndex,
      ]),
      [
        [0, 2],
        [2, 4],
        [4, 6],
      ],
    );
    assert.equal(summary.aggregate.failedPartitions, 0);
    assert.ok(summary.aggregate.elapsedMs >= 0);
    assert.equal(summary.aggregate.objectsParsed, 6);
    assert.ok(
      summary.partitions.every((partition) => partition.statusCode === 0),
      "every partition completed successfully",
    );
    assert.equal(summary.provenance.sourcePnmCids[0], "bafybeipnmfixture");
    assert.match(summary.provenance.moduleArtifactHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(summary.provenance.moduleVersion, "0.2.0");
    assert.ok(summary.provenance.resultHash);
    assert.ok(
      crypto.verify(
        null,
        Buffer.from(canonicalJson(summary.provenance.signedPayload), "utf8"),
        publicKey,
        Buffer.from(summary.provenance.resultSignature.signature, "base64"),
      ),
      "runner output signature verifies against the test public key",
    );
  },
);

test(
  "partitioned SDN OMM runner can execute catalog block-pair shards",
  { timeout: 30000 },
  async (t) => {
    if (!conjunctionArtifactExists()) {
      t.skip("Build conjunction-assessment before running the catalog block-pair runner test.");
      return;
    }
    const runnerBinary = await buildThreadedWasmEdgeRunner(
      t,
      "conjunction-sdn-block-pair-runner-",
    );
    if (!runnerBinary) {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-block-pair-run-"));
    t.after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const flatc = await FlatcRunner.init();
    const schema = await ommSchema();
    const records = [];
    for (let index = 0; index < 6; index++) {
      records.push(await createOmmRecord(flatc, schema, 94000 + index));
    }

    const catalogPath = path.join(tempDir, "catalog.uint32be.bin");
    const outputPath = path.join(tempDir, "summary.json");
    await writeFile(catalogPath, encodeUint32beFramedStream(records));

    const result = await runNodeScript([
      "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
      "--catalog",
      catalogPath,
      "--catalog-block-size",
      "2",
      "--duration-days",
      "0",
      "--coarse-step-sec",
      "600",
      "--wasmedge-runner-binary",
      runnerBinary,
      "--output",
      outputPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(summary.partitionMode, "catalog-block-pair");
    assert.equal(summary.aggregate.partitions, 6);
    assert.deepEqual(
      summary.partitions.map((partition) => [
        partition.primaryStartOrderIndex,
        partition.primaryEndOrderIndex,
        partition.secondaryStartOrderIndex,
        partition.secondaryEndOrderIndex,
      ]),
      [
        [0, 2, 0, 2],
        [0, 2, 2, 4],
        [0, 2, 4, 6],
        [2, 4, 2, 4],
        [2, 4, 4, 6],
        [4, 6, 4, 6],
      ],
    );
    assert.equal(summary.aggregate.failedPartitions, 0);
    assert.equal(summary.aggregate.deferredPartitions, 0);
    assert.ok(
      summary.partitions.every((partition) => partition.catalogBytes < summary.sourceCatalogBytes),
      "each block-pair invocation should use a sliced catalog payload",
    );
  },
);
