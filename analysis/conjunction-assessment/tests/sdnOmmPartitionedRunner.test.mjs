import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { conjunctionArtifactExists } from "./lib/conjunctionCommandHarness.mjs";
import { createFlatcRunner, gpRecord, publishedSchema } from "./lib/cqr.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import {
  buildPartitionedRunProvenance,
  invokeWithTimeout,
  loadPartitionCheckpoints,
  findIrreducibleTimedOutBlockPairs,
  planExplicitBlockPairWork,
  planCatalogBlockPairWork,
  planTimedOutBlockPairSubdivisions,
  planPartitionWork,
  partitionInvocation,
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

test("timed-out block-pair checkpoints recursively split to the minimum block size", () => {
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
    ],
    minCatalogBlockSize: 125,
  });

  assert.equal(retries.length, 16);
  assert.ok(
    retries.every(
      (range) =>
        range.primaryEndOrderIndex - range.primaryStartOrderIndex <= 125 &&
        range.secondaryEndOrderIndex - range.secondaryStartOrderIndex <= 125,
    ),
  );
  assert.deepEqual(
    retries[0],
    {
      parentPartitionIndex: 4,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 125,
      secondaryStartOrderIndex: 2000,
      secondaryEndOrderIndex: 2125,
      diagonal: false,
      catalogBlockSize: 125,
    },
  );
});

test("timeout retry planning splits only terminal timed-out child ranges", () => {
  const retries = planTimedOutBlockPairSubdivisions({
    partitions: [
      {
        partitionIndex: 4,
        statusCode: 124,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2000,
        secondaryEndOrderIndex: 2125,
      },
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        statusCode: 0,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2000,
        secondaryEndOrderIndex: 2025,
      },
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        statusCode: 0,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2025,
        secondaryEndOrderIndex: 2050,
      },
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        statusCode: 0,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2050,
        secondaryEndOrderIndex: 2075,
      },
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        statusCode: 0,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2075,
        secondaryEndOrderIndex: 2100,
      },
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        statusCode: 124,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 25,
        secondaryStartOrderIndex: 2100,
        secondaryEndOrderIndex: 2125,
      },
    ],
    minCatalogBlockSize: 5,
  });

  assert.equal(retries.length, 25);
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
      [4, 0, 5, 2100, 2105, 5],
      [4, 0, 5, 2105, 2110, 5],
      [4, 0, 5, 2110, 2115, 5],
      [4, 0, 5, 2115, 2120, 5],
      [4, 0, 5, 2120, 2125, 5],
      [4, 5, 10, 2100, 2105, 5],
      [4, 5, 10, 2105, 2110, 5],
      [4, 5, 10, 2110, 2115, 5],
      [4, 5, 10, 2115, 2120, 5],
      [4, 5, 10, 2120, 2125, 5],
      [4, 10, 15, 2100, 2105, 5],
      [4, 10, 15, 2105, 2110, 5],
      [4, 10, 15, 2110, 2115, 5],
      [4, 10, 15, 2115, 2120, 5],
      [4, 10, 15, 2120, 2125, 5],
      [4, 15, 20, 2100, 2105, 5],
      [4, 15, 20, 2105, 2110, 5],
      [4, 15, 20, 2110, 2115, 5],
      [4, 15, 20, 2115, 2120, 5],
      [4, 15, 20, 2120, 2125, 5],
      [4, 20, 25, 2100, 2105, 5],
      [4, 20, 25, 2105, 2110, 5],
      [4, 20, 25, 2110, 2115, 5],
      [4, 20, 25, 2115, 2120, 5],
      [4, 20, 25, 2120, 2125, 5],
    ],
  );
});

test("timeout retry planning reports irreducible terminal child ranges", () => {
  const partitions = [
    {
      partitionIndex: 4,
      statusCode: 124,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 1,
      secondaryStartOrderIndex: 2116,
      secondaryEndOrderIndex: 2117,
      errorMessage: "partition 4 timed out after 10000 ms",
    },
  ];

  const retries = planTimedOutBlockPairSubdivisions({
    partitions,
    minCatalogBlockSize: 1,
  });
  const irreducible = findIrreducibleTimedOutBlockPairs({
    partitions,
    minCatalogBlockSize: 1,
  });

  assert.deepEqual(retries, []);
  assert.deepEqual(irreducible, [
    {
      parentPartitionIndex: 4,
      partitionIndex: 4,
      primaryStartOrderIndex: 0,
      primaryEndOrderIndex: 1,
      secondaryStartOrderIndex: 2116,
      secondaryEndOrderIndex: 2117,
      catalogBlockSize: 1,
      errorMessage: "partition 4 timed out after 10000 ms",
    },
  ]);
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

test("explicit block-pair planner skips quarantined irreducible ranges", () => {
  const plan = planExplicitBlockPairWork({
    primaryStartOrderIndex: 0,
    primaryEndOrderIndex: 1,
    secondaryStartOrderIndex: 2116,
    secondaryEndOrderIndex: 2117,
    partitionIndex: 4,
    parentPartitionIndex: 4,
    resume: true,
    quarantinedRanges: [
      {
        partitionIndex: 4,
        parentPartitionIndex: 4,
        primaryStartOrderIndex: 0,
        primaryEndOrderIndex: 1,
        secondaryStartOrderIndex: 2116,
        secondaryEndOrderIndex: 2117,
      },
    ],
  });

  assert.deepEqual(plan.pendingRanges, []);
  assert.deepEqual(plan.completedPartitions, []);
  assert.equal(plan.quarantinedRanges.length, 1);
  assert.equal(plan.quarantinedRanges[0].secondaryStartOrderIndex, 2116);
});

test("partitioned runner can resume from successful checkpoints and schedule only pending work", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-resume-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(
    path.join(tempDir, "partition-000001-000002-000004-000002-000006.json"),
    JSON.stringify({
      partitionIndex: 1,
      startOrderIndex: 2,
      endOrderIndex: 4,
      secondaryStartOrderIndex: 2,
      secondaryEndOrderIndex: 6,
      statusCode: 0,
      objectsParsed: 6,
      conjunctionsFound: 1,
      stats: { pairsScreened: 7 },
    }),
  );
  await writeFile(
    path.join(tempDir, "partition-000002-000004-000006-000004-000006.json"),
    JSON.stringify({
      partitionIndex: 2,
      startOrderIndex: 4,
      endOrderIndex: 6,
      secondaryStartOrderIndex: 4,
      secondaryEndOrderIndex: 6,
      statusCode: 2,
      objectsParsed: 0,
      conjunctionsFound: 0,
      stats: { pairsScreened: 0 },
    }),
  );
  // Written before ordered-primary partitions named a secondary range: that
  // partition screened only the pairs inside [0, 2), so it is not complete.
  await writeFile(
    path.join(tempDir, "partition-000000-000000-000002.json"),
    JSON.stringify({
      partitionIndex: 0,
      startOrderIndex: 0,
      endOrderIndex: 2,
      statusCode: 0,
      objectsParsed: 6,
      conjunctionsFound: 0,
      stats: { pairsScreened: 1 },
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
      partition.secondaryStartOrderIndex,
      partition.secondaryEndOrderIndex,
    ]),
    [[0, 0, 2, 0, 6]],
  );
  assert.equal(plan.deferredRanges.length, 1);
  assert.equal(plan.deferredRanges[0].partitionIndex, 2);
});

// The pairs one screen_catalog request screens, as its guest defines them for
// OMM catalog frames (plugin_invoke_bridge.cpp screenSources and
// ConjunctionScreener::screen): every unordered pair of distinct objects with
// one object in the primary range and the other in the secondary range, once
// however the ranges overlap; with an empty secondary range, every pair
// inside the primary range. ids maps an order index to the object it names.
function requestPairs(ids, invocation) {
  const primaries = ids.slice(invocation.primaryStartOrderIndex, invocation.primaryEndOrderIndex);
  const secondaries =
    invocation.secondaryEndOrderIndex > invocation.secondaryStartOrderIndex
      ? ids.slice(invocation.secondaryStartOrderIndex, invocation.secondaryEndOrderIndex)
      : primaries;
  const pairs = new Set();
  for (const a of primaries) {
    for (const b of secondaries) {
      if (a !== b) pairs.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
  }
  return pairs;
}

test("every partition schedule screens each pair of the ordered range exactly once", () => {
  for (let objectCount = 0; objectCount <= 12; objectCount += 1) {
    // Frame i holds the byte i, so a sliced payload names the objects it sends.
    const catalog = Buffer.from(
      encodeUint32beFramedStream(Array.from({ length: objectCount }, (_, index) => Uint8Array.of(index))),
    );
    const windows = [[0, objectCount], [1, objectCount], [0, objectCount - 1], [2, objectCount - 2]]
      .filter(([start, end]) => start >= 0 && end >= start);
    for (const [startOrderIndex, endOrderIndex] of windows) {
      const expected = new Set();
      for (let i = startOrderIndex; i < endOrderIndex; i += 1) {
        for (let j = i + 1; j < endOrderIndex; j += 1) expected.add(`${i}-${j}`);
      }
      for (let size = 1; size <= objectCount + 1; size += 1) {
        for (const [partitionMode, plan] of [
          ["ordered-primary", planPartitionWork({ objectCount, startOrderIndex, endOrderIndex, partitionSize: size })],
          ["catalog-block-pair", planCatalogBlockPairWork({ objectCount, startOrderIndex, endOrderIndex, catalogBlockSize: size })],
        ]) {
          const label = `${partitionMode} N=${objectCount} [${startOrderIndex}, ${endOrderIndex}) size ${size}`;
          const seen = new Map();
          for (const range of plan.pendingRanges) {
            const invocation = partitionInvocation(catalog, objectCount, range, partitionMode);
            const ids = [];
            for (let offset = 0; offset < invocation.payload.length; offset += 5) ids.push(invocation.payload[offset + 4]);
            assert.equal(ids.length, invocation.objectCount, label);
            for (const pair of requestPairs(ids, invocation)) seen.set(pair, (seen.get(pair) ?? 0) + 1);
          }
          assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), `${label}: the pairs of the range`);
          const n = endOrderIndex - startOrderIndex;
          assert.equal(seen.size, n < 2 ? 0 : (n * (n - 1)) / 2, `${label}: N(N-1)/2 pairs`);
          for (const [pair, count] of seen) assert.equal(count, 1, `${label}: ${pair} screened ${count} times`);
        }
      }
    }
  }
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

const ommSchemaSync = () => publishedSchema("OMM");
const ommSchema = async () => ommSchemaSync();

async function createOmmRecord(flatc, schema, noradCatId) {
  return flatc.generateBinary(
    schema,
    JSON.stringify({
      CENTER_NAME: "EARTH",
      REFERENCE_FRAME: { REFERENCE_FRAME_type: "CelestialFrameWrapper", REFERENCE_FRAME: { frame: "TEMEOFDATE" } },
      TIME_SYSTEM: "UTC",
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
  assert.equal(summary.terminalTimeoutPartitions, 1);
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

test("partitioned runner can write retry range commands from a timeout retry plan", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-retry-script-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const retryPlanPath = path.join(tempDir, "timeout-retries.json");
  const retryScriptPath = path.join(tempDir, "run-retries.sh");
  const catalogPath = path.join(tempDir, "catalog.uint32be.bin");
  await writeFile(
    retryPlanPath,
    JSON.stringify({
      ranges: [
        {
          parentPartitionIndex: 4,
          primaryStartOrderIndex: 0,
          primaryEndOrderIndex: 25,
          secondaryStartOrderIndex: 2000,
          secondaryEndOrderIndex: 2025,
        },
        {
          parentPartitionIndex: 4,
          primaryStartOrderIndex: 0,
          primaryEndOrderIndex: 25,
          secondaryStartOrderIndex: 2025,
          secondaryEndOrderIndex: 2050,
        },
      ],
    }),
  );

  const result = await runNodeScript([
    "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
    "--catalog",
    catalogPath,
    "--checkpoint-dir",
    path.join(tempDir, "retry-checkpoints"),
    "--retry-plan",
    retryPlanPath,
    "--partition-timeout-ms",
    "120000",
    "--write-retry-script",
    retryScriptPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.retryRanges, 2);
  assert.equal(summary.retryScriptPath, retryScriptPath);

  const script = await readFile(retryScriptPath, "utf8");
  assert.match(script, /--block-pair-primary-start-order-index 0/);
  assert.match(script, /--block-pair-primary-end-order-index 25/);
  assert.match(script, /--block-pair-secondary-start-order-index 2000/);
  assert.match(script, /--block-pair-secondary-end-order-index 2025/);
  assert.match(script, /--partition-timeout-ms 120000/);
  assert.match(script, /retry-000000.json/);
  assert.match(script, /retry-000001.json/);
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

    const flatc = await createFlatcRunner();
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
      "0.000011574074074074073",
      "--start-jd",
      "2461108.5",
      "--coarse-step-sec",
      "600",
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
        partition.secondaryStartOrderIndex,
        partition.secondaryEndOrderIndex,
      ]),
      [
        [0, 2, 0, 6],
        [2, 4, 2, 6],
        [4, 6, 4, 6],
      ],
    );
    assert.equal(
      summary.aggregate.pairsScreened + summary.aggregate.pairsPrefiltered,
      15,
      "the partitions plan the 6 * 5 / 2 pairs of the catalog",
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

// Real objects with real conjunctions, most of them across partition
// boundaries. Source: CelesTrak GP element sets, SGP4 mean elements in TEME of
// date, UTC (fixtures/decaying/gp_2026-07-06.json without its three
// reentering objects): EXPLORER 7 (NORAD 22), last in catalog order, and the
// eight objects that pass near it on 2026-07-06. Window 2026-07-06T00:00Z +
// 1 day, 15 km threshold, 300 s coarse step, 1 ms refinement tolerance.
// Exact assertions only: the planned pairs (PAIRS_SCREENED +
// PAIRS_PREFILTERED of every partition) add up to 9 * 8 / 2 = 36 in both
// partition modes, and both find the conjunctions of one screen_catalog over
// the whole catalog. Before ordered-primary partitions named a secondary
// range, the same run planned 4 pairs and found none: EXPLORER 7 was alone
// in its partition.
test(
  "partitioned runner screens every pair of a real catalog once in both partition modes",
  { timeout: 600000 },
  async (t) => {
    if (!conjunctionArtifactExists()) {
      t.skip("Build conjunction-assessment before running the partitioned runner test.");
      return;
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "sdn-omm-pair-coverage-"));
    t.after(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const gp = JSON.parse(
      await readFile(path.join(__dirname, "fixtures/decaying/gp_2026-07-06.json"), "utf8"),
    ).filter((record) => ![8301, 60875, 69729].includes(record.NORAD_CAT_ID));
    const ordered = [
      ...gp.filter((record) => record.NORAD_CAT_ID !== 22),
      ...gp.filter((record) => record.NORAD_CAT_ID === 22),
    ];
    const flatc = await createFlatcRunner();
    const catalogPath = path.join(tempDir, "catalog.uint32be.bin");
    await writeFile(
      catalogPath,
      encodeUint32beFramedStream(
        ordered.map((record) =>
          flatc.generateBinary(ommSchemaSync(), JSON.stringify(gpRecord(record)), { sizePrefix: false }),
        ),
      ),
    );
    const run = async (label, scheduleArgs) => {
      const outputPath = path.join(tempDir, `${label}.json`);
      const result = await runNodeScript([
        "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
        "--catalog",
        catalogPath,
        ...scheduleArgs,
        "--start-jd",
        String(Date.parse("2026-07-06T00:00:00Z") / 86400000 + 2440587.5),
        "--duration-days",
        "1",
        "--threshold-km",
        "15",
        "--coarse-step-sec",
        "300",
        "--fine-tol-sec",
        "0.001",
        "--output",
        outputPath,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(summary.objectCount, 9);
      assert.equal(summary.aggregate.failedPartitions, 0, label);
      assert.equal(summary.aggregate.deferredPartitions, 0, label);
      assert.equal(
        summary.aggregate.pairsScreened + summary.aggregate.pairsPrefiltered,
        36,
        `${label}: N(N-1)/2 pairs`,
      );
      return summary;
    };
    const whole = await run("whole", ["--partition-size", "9"]);
    assert.equal(whole.aggregate.partitions, 1);
    assert.ok(whole.aggregate.conjunctionsFound > 0, "the window has conjunctions");
    const orderedPrimary = await run("ordered-primary", ["--partition-size", "2"]);
    assert.equal(orderedPrimary.partitionMode, "ordered-primary");
    assert.equal(orderedPrimary.aggregate.partitions, 5);
    assert.equal(orderedPrimary.aggregate.conjunctionsFound, whole.aggregate.conjunctionsFound);
    const blockPairs = await run("block-pairs", ["--catalog-block-size", "2"]);
    assert.equal(blockPairs.partitionMode, "catalog-block-pair");
    assert.equal(blockPairs.aggregate.partitions, 15);
    assert.equal(blockPairs.aggregate.conjunctionsFound, whole.aggregate.conjunctionsFound);
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

    const flatc = await createFlatcRunner();
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
      "0.000011574074074074073",
      "--start-jd",
      "2461108.5",
      "--coarse-step-sec",
      "600",
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

    const explicitOutputPath = path.join(tempDir, "explicit-summary.json");
    const explicitResult = await runNodeScript([
      "scripts/run-sdn-omm-partitioned-screen-catalog.mjs",
      "--catalog",
      catalogPath,
      "--block-pair-partition-index",
      "99",
      "--block-pair-primary-start-order-index",
      "0",
      "--block-pair-primary-end-order-index",
      "2",
      "--block-pair-secondary-start-order-index",
      "2",
      "--block-pair-secondary-end-order-index",
      "4",
      "--duration-days",
      "0.000011574074074074073",
      "--start-jd",
      "2461108.5",
      "--coarse-step-sec",
      "600",
      "--output",
      explicitOutputPath,
    ]);

    assert.equal(explicitResult.status, 0, explicitResult.stderr);
    const explicitSummary = JSON.parse(await readFile(explicitOutputPath, "utf8"));
    assert.equal(explicitSummary.partitionMode, "catalog-block-pair");
    assert.equal(explicitSummary.partitions[0].partitionIndex, 99);
    assert.equal(explicitSummary.partitions[0].catalogBytes < explicitSummary.sourceCatalogBytes, true);
  },
);
