import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FlatcRunner } from "flatc-wasm";

import { conjunctionArtifactExists } from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import {
  buildPartitionedRunProvenance,
  loadPartitionCheckpoints,
  planPartitionWork,
  sliceUint32beFrames,
  canonicalJson,
  canonicalSha256Hex,
  signPartitionedRunProvenance,
} from "../scripts/run-sdn-omm-partitioned-screen-catalog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

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
