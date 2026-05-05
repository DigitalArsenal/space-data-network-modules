import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FlatcRunner } from "flatc-wasm";

import { conjunctionArtifactExists } from "./lib/conjunctionCommandHarness.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

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
    await writeFile(catalogPath, encodeUint32beFramedStream(records));

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
  },
);
