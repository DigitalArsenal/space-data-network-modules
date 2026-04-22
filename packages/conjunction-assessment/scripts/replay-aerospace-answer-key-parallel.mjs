/* global Buffer, URL, console, process */
import { cpus } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { maybeWriteJson } from "./lib/aerospaceDataset.mjs";

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

function buildChildArgs(scriptPath, args, shardCount, shardIndex) {
  const childArgs = [scriptPath];
  for (const [key, value] of Object.entries(args)) {
    if (key === "output" || key === "per-shard-dir" || key === "concurrency") {
      continue;
    }
    childArgs.push(`--${key}`);
    if (value !== true) {
      childArgs.push(String(value));
    }
  }
  childArgs.push("--shard-count", String(shardCount));
  childArgs.push("--shard-index", String(shardIndex));
  return childArgs;
}

function aggregateShardSummaries(shardSummaries, elapsedMs) {
  return {
    shardCount: shardSummaries.length,
    testedRows: shardSummaries.reduce((sum, item) => sum + item.testedRows, 0),
    matchedRows: shardSummaries.reduce((sum, item) => sum + item.matchedRows, 0),
    mismatchCount: shardSummaries.reduce(
      (sum, item) => sum + item.mismatchCount,
      0,
    ),
    errorCount: shardSummaries.reduce((sum, item) => sum + item.errorCount, 0),
    maxTcaDeltaSec: Math.max(...shardSummaries.map((item) => item.maxTcaDeltaSec)),
    maxRangeDeltaKm: Math.max(
      ...shardSummaries.map((item) => item.maxRangeDeltaKm),
    ),
    pluginInstancesCreated: shardSummaries.reduce(
      (sum, item) => sum + item.pluginInstancesCreated,
      0,
    ),
    elapsedMs,
    shards: shardSummaries,
  };
}

async function runShard(scriptPath, args, shardCount, shardIndex) {
  const childArgs = buildChildArgs(scriptPath, args, shardCount, shardIndex);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: path.dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      try {
        const summary = stdoutText ? JSON.parse(stdoutText) : null;
        resolve({
          shardIndex,
          exitCode: code ?? 1,
          summary,
          stderrText,
        });
      } catch (error) {
        reject(
          new Error(
            `Failed to parse shard ${shardIndex} output: ${error instanceof Error ? error.message : String(error)}\n${stdoutText}\n${stderrText}`,
          ),
        );
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptPath = new URL("./replay-aerospace-answer-key.mjs", import.meta.url)
    .pathname;
  const shardCount = Math.max(
    1,
    Number(args["shard-count"] ?? process.env.AEROSPACE_REPLAY_SHARDS ?? cpus().length),
  );
  const concurrency = Math.max(
    1,
    Number(args.concurrency ?? Math.min(shardCount, cpus().length)),
  );
  const perShardDir =
    typeof args["per-shard-dir"] === "string" ? args["per-shard-dir"] : null;
  const startedAt = Date.now();
  const shardResults = new Array(shardCount);
  let nextShardIndex = 0;

  async function worker() {
    while (nextShardIndex < shardCount) {
      const shardIndex = nextShardIndex;
      nextShardIndex++;
      const result = await runShard(scriptPath, args, shardCount, shardIndex);
      if (!result.summary) {
        throw new Error(`Shard ${shardIndex} returned no summary.`);
      }
      shardResults[shardIndex] = result.summary;
      if (perShardDir) {
        await maybeWriteJson(
          path.join(perShardDir, `shard-${String(shardIndex).padStart(3, "0")}.json`),
          result.summary,
        );
      }
      console.error(
        `[shard ${shardIndex + 1}/${shardCount}] rows=${result.summary.testedRows} mismatches=${result.summary.mismatchCount} errors=${result.summary.errorCount} elapsedMs=${result.summary.elapsedMs}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Shard ${shardIndex} failed with exit code ${result.exitCode}.\n${result.stderrText}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  const aggregate = aggregateShardSummaries(
    shardResults,
    Date.now() - startedAt,
  );
  await maybeWriteJson(args.output, aggregate);
  console.log(JSON.stringify(aggregate, null, 2));

  if (aggregate.mismatchCount > 0 || aggregate.errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
