// Resumable coordinator for a *future* global terrain build.
//
// This script is intentionally off-fleet: it creates bounded, independent
// shard runs and merges their record stores only after every shard succeeded.
// It does not publish to IPFS, contact an SDN node, or change a serving mount.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  initializeGlobalState,
  makeShardConfigs,
  markShard,
  recordSetDigest,
  saveGlobalState,
  sha256,
} from "./build-support.mjs";
import { iterateStreamFile, readDtt } from "./dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_MAX_BYTES = 128 * 1024 ** 3;

function parseArgs(argv) {
  const args = { workers: 1, shards: 1, verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--config") args.config = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--shards") args.shards = Number(argv[++i]);
    else if (flag === "--workers") args.workers = Number(argv[++i]);
    else if (flag === "--cache-max-bytes") args.cacheMaxBytes = Number(argv[++i]);
    else if (flag === "--max-cells") args.maxCells = Number(argv[++i]);
    // Test/rehearsal hook: production uses run.mjs. It lets the coordinator's
    // durable state machine be fault-injected without cutting or fetching data.
    else if (flag === "--runner") args.runner = argv[++i];
    else if (flag === "--no-wasmedge-verify") args.wasmedgeVerify = false;
    else if (flag === "--skip-verify") args.verify = false;
    // Deliberately test-only.  It proves a persisted state does not rerun the
    // already completed shards after an interruption.
    else if (flag === "--fault-after-shards") args.faultAfterShards = Number(argv[++i]);
    else throw new Error(`unknown argument ${flag}`);
  }
  assert.ok(args.config, "--config <run.json> is required");
  assert.ok(args.out, "--out <dir> is required");
  for (const [name, value] of [["--shards", args.shards], ["--workers", args.workers], ["--cache-max-bytes", args.cacheMaxBytes], ["--max-cells", args.maxCells], ["--fault-after-shards", args.faultAfterShards]]) {
    if (value !== undefined) assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  }
  assert.ok(args.workers <= args.shards, "--workers may not exceed --shards");
  return args;
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.resolve(HERE, "..", ".."), stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child ${path.basename(args[0])} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function reportIsComplete(outDir) {
  const report = path.join(outDir, "run-report.json");
  const stream = path.join(outDir, "tiles.dttstream");
  if (!fs.existsSync(report) || !fs.existsSync(stream)) return false;
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  return parsed.drained === true && Array.isArray(parsed.errors) && parsed.errors.length === 0;
}

async function mergeShardStores(shards, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const temporary = path.join(outDir, "tiles.dttstream.merge.tmp");
  const destination = path.join(outDir, "tiles.dttstream");
  const handle = fs.openSync(temporary, "w");
  const addresses = new Map();
  const skipped = new Set();
  let records = 0;
  let duplicates = 0;
  try {
    for (const shard of [...shards].sort((a, b) => a.index - b.index)) {
      const stream = path.join(shard.outDir, "tiles.dttstream");
      for await (const record of iterateStreamFile(stream)) {
        const dtt = readDtt(record);
        const address = `${dtt.level}/${dtt.x}/${dtt.y}`;
        const digest = sha256(record);
        const previous = addresses.get(address);
        if (previous) {
          assert.equal(previous, digest, `shards disagree on duplicate address ${address}`);
          duplicates += 1;
          continue;
        }
        addresses.set(address, digest);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(record.length);
        fs.writeSync(handle, length);
        fs.writeSync(handle, record);
        records += 1;
      }
      const oceanFile = path.join(shard.outDir, "ocean-skipped.json");
      if (fs.existsSync(oceanFile)) {
        for (const address of JSON.parse(fs.readFileSync(oceanFile, "utf8")).addresses ?? []) skipped.add(address);
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, destination);
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), count: skipped.size, addresses: [...skipped].sort() }, null, 2)}\n`,
  );
  const report = { records, duplicates, recordSetDigest: recordSetDigest(addresses) };
  fs.writeFileSync(path.join(outDir, "global-merge-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const runConfig = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
  const cacheMaxBytes = args.cacheMaxBytes ?? runConfig.cache_max_bytes ?? DEFAULT_CACHE_MAX_BYTES;
  const cacheDir = path.join(outDir, "granule-cache");
  const state = initializeGlobalState(outDir, runConfig, args.shards);
  const configs = makeShardConfigs(runConfig, args.shards, { outDir, cacheDir, cacheMaxBytes });

  const pending = [];
  for (const shard of state.shards) {
    const out = path.join(outDir, "shards", `shard-${String(shard.index).padStart(3, "0")}`);
    if (shard.status === "complete" && reportIsComplete(out) && shard.outputDigest === await fileDigest(path.join(out, "tiles.dttstream"))) {
      continue;
    }
    markShard(state, shard.index, "pending", { outDir: out });
    pending.push(shard.index);
  }
  saveGlobalState(outDir, state);

  let completedThisInvocation = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const index = pending[cursor++];
      const shard = state.shards[index];
      const out = shard.outDir;
      const configFile = path.join(out, "run.json");
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(configFile, `${JSON.stringify(configs[index], null, 2)}\n`);
      markShard(state, index, "running");
      saveGlobalState(outDir, state);
      try {
        await runNode([
          path.resolve(args.runner ?? path.join(HERE, "run.mjs")), "--config", configFile, "--out", out,
          "--cache-dir", cacheDir, "--cache-max-bytes", String(cacheMaxBytes),
          ...(args.maxCells ? ["--max-cells", String(args.maxCells)] : []),
          ...(args.wasmedgeVerify === false ? ["--no-wasmedge-verify"] : []),
        ]);
        assert.ok(reportIsComplete(out), `shard ${index} did not leave a clean run report`);
        markShard(state, index, "complete", { outputDigest: await fileDigest(path.join(out, "tiles.dttstream")) });
        saveGlobalState(outDir, state);
        completedThisInvocation += 1;
      } catch (error) {
        markShard(state, index, "failed", { error: String(error.message ?? error) });
        saveGlobalState(outDir, state);
        throw error;
      }
      // This must be outside the try/catch: fault injection models a process
      // dying *after* its completion checkpoint. Turning that completed shard
      // into failed would make resume recut it, defeating the test.
      if (args.faultAfterShards && completedThisInvocation >= args.faultAfterShards) {
        throw new Error(`fault injection after ${completedThisInvocation} completed shard(s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.workers }, worker));
  assert.ok(state.shards.every((shard) => shard.status === "complete"), "not every shard completed");
  const merged = await mergeShardStores(state.shards, outDir);
  state.merged = { ...merged, at: new Date().toISOString() };
  saveGlobalState(outDir, state);
  if (args.verify) await runNode([path.join(HERE, "verify.mjs"), "--out", outDir]);
  process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged }, null, 2)}\n`);
}

await main();
