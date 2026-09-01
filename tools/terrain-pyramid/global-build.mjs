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
  saveGlobalState,
} from "./build-support.mjs";
import { readDtt } from "./dtt-reader.mjs";
import {
  MAX_GLOBAL_SOURCE_CACHE_BYTES,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  sourcePolicyContract,
} from "./source-provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_MAX_BYTES = MAX_GLOBAL_SOURCE_CACHE_BYTES;

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

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function reportIsComplete(outDir) {
  const report = path.join(outDir, "run-report.json");
  const stream = path.join(outDir, "tiles.dttstream");
  if (!fs.existsSync(report) || !fs.existsSync(stream)) return false;
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  return parsed.drained === true && Array.isArray(parsed.errors) && parsed.errors.length === 0;
}

function bindSourceEpochToState(state, contract) {
  if (!contract) return null;
  const existing = state.sourceProvenance;
  if (existing) {
    assert.equal(existing.sourcePolicyDigest, contract.digest,
      "refusing to resume a state written for a different source policy epoch");
    assert.equal(existing.datasetEpoch, contract.datasetEpoch,
      "refusing to resume a state written for a different dataset epoch");
    assert.ok(typeof existing.sourceRunStartedAt === "string" && existing.sourceRunStartedAt.length > 0,
      "global state is missing its source run observation start");
    return existing;
  }
  const sourceProvenance = {
    sourcePolicyDigest: contract.digest,
    datasetEpoch: contract.datasetEpoch,
    // DTT requires one retrieved_at string.  This coordinator receipt is made
    // at the real run start and is shared by all shards for record parity; it
    // is not substituted for the per-response observed_at manifest evidence.
    sourceRunStartedAt: new Date().toISOString(),
    completed: false,
  };
  state.sourceProvenance = sourceProvenance;
  return sourceProvenance;
}

function shardSourceLog(shard, contract) {
  return path.join(shard.outDir, contract.policy.manifest.shard_log);
}

function assertCompletedShardSource(shard, contract) {
  const report = JSON.parse(fs.readFileSync(path.join(shard.outDir, "run-report.json"), "utf8"));
  assert.equal(report.sourceProvenance?.sourcePolicyDigest, contract.digest,
    `shard ${shard.index} has no matching source policy receipt`);
  assert.equal(report.sourceProvenance?.datasetEpoch, contract.datasetEpoch,
    `shard ${shard.index} has no matching dataset epoch receipt`);
  assert.ok(fs.existsSync(shardSourceLog(shard, contract)),
    `shard ${shard.index} has no source observation log`);
}

async function mergeShardStores(shards, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Assemble the entire merge in an isolated staging directory.  The root
  // receipt is written only after verify and state completion, but staging all
  // three generated artifacts first also prevents a failed merge from leaving
  // a new tiles file beside an old ocean receipt.
  const staging = fs.mkdtempSync(path.join(outDir, ".global-merge-stage-"));
  const destination = path.join(outDir, "tiles.dttstream");
  const ordered = [...shards].sort((a, b) => a.index - b.index);
  try {
    const stagedTiles = path.join(staging, "tiles.dttstream");
    const merged = await mergeBoundedFramedStores({
      inputFiles: ordered.map((shard) => path.join(shard.outDir, "tiles.dttstream")),
      outputFile: stagedTiles,
      addressForRecord: (record) => {
        const dtt = readDtt(record);
        return `${dtt.level}/${dtt.x}/${dtt.y}`;
      },
    });
    // A byte-identical duplicate is still an overlapping shard boundary. The
    // global verifier reads the de-duplicated store, so accepting it here
    // would hide an invariant failure from the evidence layer.
    assert.equal(merged.duplicates, 0,
      `shard merge found ${merged.duplicates} duplicate terrain address(es); refusing to hide overlap`);
    const stagedOcean = path.join(staging, "ocean-skipped.lines");
    const ocean = await mergeOceanSkips({
      inputFiles: ordered.map((shard) => {
        const streaming = path.join(shard.outDir, "ocean-skipped.lines");
        return fs.existsSync(streaming) ? streaming : path.join(shard.outDir, "ocean-skipped.json");
      }),
      outputFile: stagedOcean,
    });
    assert.equal(ocean.duplicates, 0, "ocean-skip merge must not hide duplicate shard coverage");
    const oceanReceipt = path.join(staging, "ocean-skipped.json");
    fs.writeFileSync(
      oceanReceipt,
      `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        format: "terrain-ocean-skips-lines-v1",
        addressesPath: ocean.path,
        count: ocean.count,
        digest: ocean.digest,
      }, null, 2)}\n`,
    );
    // Each rename is atomic.  They are deliberately delayed until every
    // bounded merge and receipt write succeeded; global-merge-report.json
    // remains the terminal consumption gate for this artifact set.
    fs.renameSync(stagedTiles, destination);
    fs.renameSync(stagedOcean, path.join(outDir, "ocean-skipped.lines"));
    fs.renameSync(oceanReceipt, path.join(outDir, "ocean-skipped.json"));
    return { ...merged, oceanSkips: ocean };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const runConfig = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
  const sourceContract = sourcePolicyContract(runConfig);
  if (sourceContract) assert.ok(args.verify, "a source-policy build may not use --skip-verify");
  const cacheMaxBytes = args.cacheMaxBytes ?? runConfig.cache_max_bytes ?? DEFAULT_CACHE_MAX_BYTES;
  if (sourceContract) assert.equal(cacheMaxBytes, sourceContract.cacheMaxBytes,
    "a source-policy build may not override its approved cache bound");
  assert.ok(cacheMaxBytes <= MAX_GLOBAL_SOURCE_CACHE_BYTES || !sourceContract,
    "a source-policy build may not exceed the 96 GiB cache bound");
  const cacheDir = path.join(outDir, "granule-cache");
  const sourceEpoch = ensureSourceEpoch(cacheDir, sourceContract);
  const state = initializeGlobalState(outDir, runConfig, args.shards);
  const sourceState = bindSourceEpochToState(state, sourceContract);
  const finalReport = path.join(outDir, "global-merge-report.json");
  assert.ok(state.completed || !fs.existsSync(finalReport),
    "incomplete global state has a terminal merge report; refuse a torn attempt instead of treating it as approved");
  saveGlobalState(outDir, state);
  const configs = makeShardConfigs(runConfig, args.shards, { outDir, cacheDir, cacheMaxBytes }).map((config) => ({
    ...config,
    ...(sourceState ? { source_run_started_at: sourceState.sourceRunStartedAt } : {}),
  }));

  if (state.completed) {
    const receipt = state.merged;
    assert.ok(receipt && receipt.completion === "complete", "completed global state has no terminal merge receipt");
    assert.equal(receipt.configDigest, state.configDigest, "completed merge receipt config digest mismatch");
    if (sourceContract) {
      assert.equal(receipt.sourceManifest?.sourcePolicyDigest, sourceContract.digest,
        "completed merge receipt source policy digest mismatch");
      const manifest = path.join(outDir, receipt.sourceManifest.path);
      assert.ok(fs.existsSync(manifest), "completed source-policy build is missing its immutable source manifest");
      assert.equal(await fileDigest(manifest), receipt.sourceManifest.digest,
        "completed source manifest digest does not match its merge receipt");
    }
    // State is the atomic completion gate.  If the process died after its
    // state checkpoint but before this user-facing receipt rename, recreate
    // the same bytes; an incomplete attempt never exposes a "complete" report.
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(finalReport, "utf8")); } catch {}
    if (JSON.stringify(onDisk) !== JSON.stringify(receipt)) writeJsonAtomic(finalReport, receipt);
    process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged: receipt, resumed: true }, null, 2)}\n`);
    return;
  }

  const pending = [];
  for (const shard of state.shards) {
    const out = path.join(outDir, "shards", `shard-${String(shard.index).padStart(3, "0")}`);
    if (shard.status === "complete" && reportIsComplete(out) && shard.outputDigest === await fileDigest(path.join(out, "tiles.dttstream"))) {
      if (sourceContract) assertCompletedShardSource({ index: shard.index, outDir: out }, sourceContract);
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
        if (sourceContract) assertCompletedShardSource({ index, outDir: out }, sourceContract);
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
  state.mergeCandidate = { ...merged, at: new Date().toISOString() };
  saveGlobalState(outDir, state);
  if (args.verify) await runNode([path.join(HERE, "verify.mjs"), "--out", outDir]);
  const sourceManifest = sourceContract
    ? await emitCompletionSourceManifest({
        outDir,
        logFiles: state.shards.map((shard) => shardSourceLog(shard, sourceContract)),
        contract: sourceContract,
        configDigest: state.configDigest,
      })
    : null;
  const completed = {
    ...merged,
    completion: "complete",
    completedAt: new Date().toISOString(),
    configDigest: state.configDigest,
    ...(sourceManifest ? { sourceManifest, sourceEpochReceipt: path.relative(outDir, sourceEpoch.file) } : {}),
  };
  state.merged = completed;
  state.completed = true;
  if (sourceState) sourceState.completed = true;
  saveGlobalState(outDir, state);
  // Write this only after the durable state checkpoint.  The temp+rename
  // prevents a torn JSON file from looking like approval; resume recreates it
  // from the terminal state receipt above.
  writeJsonAtomic(path.join(outDir, "global-merge-report.json"), completed);
  process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged: completed }, null, 2)}\n`);
}

await main();
