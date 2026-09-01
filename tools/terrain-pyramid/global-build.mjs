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
  canonicalJson,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  publicationPolicyContract,
  sourcePolicyContract,
  sha256,
  validateSourceObservationLog,
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
    else if (flag === "--fault-merge-rename-after") args.faultMergeRenameAfter = Number(argv[++i]);
    else if (flag === "--fault-merge-crash-after") args.faultMergeCrashAfter = Number(argv[++i]);
    else throw new Error(`unknown argument ${flag}`);
  }
  assert.ok(args.config, "--config <run.json> is required");
  assert.ok(args.out, "--out <dir> is required");
  for (const [name, value] of [["--shards", args.shards], ["--workers", args.workers], ["--cache-max-bytes", args.cacheMaxBytes], ["--max-cells", args.maxCells], ["--fault-after-shards", args.faultAfterShards], ["--fault-merge-rename-after", args.faultMergeRenameAfter], ["--fault-merge-crash-after", args.faultMergeCrashAfter]]) {
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

function fsyncDirectory(directory) {
  const handle = fs.openSync(directory, "r");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function ensureApprovedRunConfig(outDir, runConfig, configDigest) {
  const file = path.join(outDir, "approved-run-config.json");
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(sha256(canonicalJson(existing)), configDigest,
      "approved run config bytes do not match the resumable global config digest");
    return path.basename(file);
  }
  writeJsonAtomic(file, runConfig);
  return path.basename(file);
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
    assert.equal(existing.globalConfigDigest, state.configDigest,
      "refusing to resume source provenance under a different global config digest");
    assert.ok(typeof existing.sourceRunStartedAt === "string" && existing.sourceRunStartedAt.length > 0,
      "global state is missing its source run observation start");
    return existing;
  }
  const sourceProvenance = {
    sourcePolicyDigest: contract.digest,
    datasetEpoch: contract.datasetEpoch,
    globalConfigDigest: state.configDigest,
    // This is build-start metadata only. The runner derives each cell's DTT
    // retrieved_at from the actual immutable source observations it prefetched.
    sourceRunStartedAt: new Date().toISOString(),
    completed: false,
  };
  state.sourceProvenance = sourceProvenance;
  return sourceProvenance;
}

function shardSourceLog(shard, contract) {
  return path.join(shard.outDir, contract.policy.manifest.shard_log);
}

async function assertCompletedShardSource(shard, contract, globalConfigDigest, cacheDir) {
  const report = JSON.parse(fs.readFileSync(path.join(shard.outDir, "run-report.json"), "utf8"));
  assert.equal(report.sourceProvenance?.sourcePolicyDigest, contract.digest,
    `shard ${shard.index} has no matching source policy receipt`);
  assert.equal(report.sourceProvenance?.datasetEpoch, contract.datasetEpoch,
    `shard ${shard.index} has no matching dataset epoch receipt`);
  assert.equal(report.sourceProvenance?.globalConfigDigest, globalConfigDigest,
    `shard ${shard.index} has no matching immutable global config digest`);
  assert.ok(fs.existsSync(shardSourceLog(shard, contract)),
    `shard ${shard.index} has no source observation log`);
  await validateSourceObservationLog(shardSourceLog(shard, contract), contract, { cacheDir });
}

function assertCompletedShardPublication(shard, contract, globalConfigDigest) {
  if (!contract) return;
  const report = JSON.parse(fs.readFileSync(path.join(shard.outDir, "run-report.json"), "utf8"));
  assert.equal(report.publicationPolicy?.digest, contract.digest,
    `shard ${shard.index} has no matching publication policy digest`);
  assert.equal(report.publicationPolicy?.globalConfigDigest, globalConfigDigest,
    `shard ${shard.index} has no matching immutable global config digest for publication`);
  assert.equal(canonicalJson(report.publicationPolicy?.policy), canonicalJson(contract.policy),
    `shard ${shard.index} did not carry the exact approved publication policy`);
}

function artifactTransactionPath(outDir) {
  return path.join(outDir, "global-artifact-transaction.json");
}

function assertArtifactTransaction(transaction, outDir) {
  assert.equal(transaction?.version, 1, "unsupported global artifact transaction");
  assert.ok(Array.isArray(transaction.entries) && transaction.entries.length === 3,
    "global artifact transaction has an invalid artifact set");
  const root = `${path.resolve(outDir)}${path.sep}`;
  assert.ok(typeof transaction.stagingDir === "string" && transaction.stagingDir.startsWith(root) &&
    path.basename(transaction.stagingDir).startsWith(".global-merge-stage-"),
  "global artifact transaction staging path is outside the build output");
  for (const entry of transaction.entries) {
    for (const field of ["staged", "destination", "backup"]) {
      assert.ok(typeof entry[field] === "string" && entry[field].startsWith(root),
        `global artifact transaction ${field} is outside the build output`);
    }
    assert.equal(typeof entry.hadDestination, "boolean", "global artifact transaction destination state is missing");
  }
}

// An individual rename is atomic, but a process can die between the three.
// Keep a durable transaction plus backups until the terminal state receipt is
// written. On an incomplete restart we restore the previous complete set; on
// a completed restart we merely finalize stale transaction metadata.
function recoverArtifactSet(outDir, { completed }) {
  const file = artifactTransactionPath(outDir);
  if (!fs.existsSync(file)) return false;
  const transaction = JSON.parse(fs.readFileSync(file, "utf8"));
  assertArtifactTransaction(transaction, outDir);
  if (completed) {
    for (const entry of transaction.entries) fs.rmSync(entry.backup, { force: true });
  } else {
    for (const entry of [...transaction.entries].reverse()) {
      if (fs.existsSync(entry.backup)) {
        fs.rmSync(entry.destination, { force: true });
        fs.renameSync(entry.backup, entry.destination);
      } else if (!fs.existsSync(entry.staged)) {
        // No old destination was backed up, so this destination is the new
        // artifact that a dead process had already installed.
        assert.equal(entry.hadDestination, false,
          `global artifact transaction lost the backup for ${entry.destination}`);
        fs.rmSync(entry.destination, { force: true });
      }
      // If the staged file still exists, this entry was never installed; the
      // destination (if any) is the untouched old one and must be preserved.
    }
  }
  fs.rmSync(transaction.stagingDir, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
  fsyncDirectory(outDir);
  return true;
}

function installArtifactSet(entries, { stagingDir, faultAfter = undefined, crashAfter = undefined } = {}) {
  assert.ok(stagingDir, "global artifact install requires its staging directory");
  const outDir = path.dirname(entries[0]?.destination ?? "");
  assert.ok(outDir, "global artifact install requires destinations");
  assert.ok(entries.every((entry) => path.dirname(entry.destination) === outDir),
    "global artifact set must share one destination directory");
  const token = `${process.pid}-${Date.now()}`;
  const transaction = {
    version: 1,
    stagingDir,
    entries: entries.map(({ staged, destination }) => ({
      staged,
      destination,
      backup: `${destination}.premerge-${token}`,
      hadDestination: fs.existsSync(destination),
    })),
  };
  const journalPath = artifactTransactionPath(outDir);
  assert.ok(!fs.existsSync(journalPath), "an unfinished global artifact transaction must be recovered before install");
  writeJsonAtomic(journalPath, transaction);
  try {
    let installed = 0;
    for (const entry of transaction.entries) {
      if (entry.hadDestination) fs.renameSync(entry.destination, entry.backup);
      fs.renameSync(entry.staged, entry.destination);
      installed += 1;
      if (crashAfter !== undefined && installed >= crashAfter) process.exit(86);
      if (faultAfter !== undefined && installed >= faultAfter) {
        throw new Error(`fault injection after ${installed} global artifact rename(s)`);
      }
    }
    fsyncDirectory(outDir);
    return transaction;
  } catch (error) {
    recoverArtifactSet(outDir, { completed: false });
    throw error;
  }
}

function finalizeArtifactSet(outDir) {
  recoverArtifactSet(outDir, { completed: true });
}

async function mergeShardStores(shards, outDir, { faultMergeRenameAfter = undefined, faultMergeCrashAfter = undefined } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // Assemble the entire merge in an isolated staging directory.  The root
  // receipt is written only after verify and state completion, but staging all
  // three generated artifacts first also prevents a failed merge from leaving
  // a new tiles file beside an old ocean receipt.
  const staging = fs.mkdtempSync(path.join(outDir, ".global-merge-stage-"));
  const destination = path.join(outDir, "tiles.dttstream");
  const ordered = [...shards].sort((a, b) => a.index - b.index);
  let transaction = null;
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
    // Install the three related artifacts as a rollback-capable set. Each
    // individual rename is atomic, and a later failure restores every prior
    // destination before the terminal merge receipt can be created.
    transaction = installArtifactSet([
      { staged: stagedTiles, destination },
      { staged: stagedOcean, destination: path.join(outDir, "ocean-skipped.lines") },
      { staged: oceanReceipt, destination: path.join(outDir, "ocean-skipped.json") },
    ], { stagingDir: staging, faultAfter: faultMergeRenameAfter, crashAfter: faultMergeCrashAfter });
    return { merged: { ...merged, oceanSkips: ocean }, transaction };
  } finally {
    if (!transaction) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const runConfig = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
  const sourceContract = sourcePolicyContract(runConfig);
  const publicationContract = publicationPolicyContract(runConfig);
  if (sourceContract) assert.ok(args.verify, "a source-policy build may not use --skip-verify");
  const cacheMaxBytes = args.cacheMaxBytes ?? runConfig.cache_max_bytes ?? DEFAULT_CACHE_MAX_BYTES;
  if (sourceContract) assert.equal(cacheMaxBytes, sourceContract.cacheMaxBytes,
    "a source-policy build may not override its approved cache bound");
  assert.ok(cacheMaxBytes <= MAX_GLOBAL_SOURCE_CACHE_BYTES || !sourceContract,
    "a source-policy build may not exceed the 96 GiB cache bound");
  const cacheDir = path.join(outDir, "granule-cache");
  const sourceEpoch = ensureSourceEpoch(cacheDir, sourceContract);
  const state = initializeGlobalState(outDir, runConfig, args.shards);
  recoverArtifactSet(outDir, { completed: state.completed });
  const approvedConfigPath = ensureApprovedRunConfig(outDir, runConfig, state.configDigest);
  const sourceState = bindSourceEpochToState(state, sourceContract);
  if (publicationContract) {
    const existing = state.publicationPolicy;
    if (existing) {
      assert.equal(existing.digest, publicationContract.digest,
        "refusing to resume a state written for a different publication policy");
      assert.equal(existing.globalConfigDigest, state.configDigest,
        "refusing to resume publication policy under a different global config digest");
    } else {
      state.publicationPolicy = {
        policy: publicationContract.policy,
        digest: publicationContract.digest,
        globalConfigDigest: state.configDigest,
      };
    }
  }
  const finalReport = path.join(outDir, "global-merge-report.json");
  assert.ok(state.completed || !fs.existsSync(finalReport),
    "incomplete global state has a terminal merge report; refuse a torn attempt instead of treating it as approved");
  saveGlobalState(outDir, state);
  const configs = makeShardConfigs(runConfig, args.shards, { outDir, cacheDir, cacheMaxBytes }).map((config) => ({
    ...config,
    global_config_digest: state.configDigest,
    ...(sourceState ? { source_run_started_at: sourceState.sourceRunStartedAt } : {}),
  }));

  if (state.completed) {
    const receipt = state.merged;
    assert.ok(receipt && receipt.completion === "complete", "completed global state has no terminal merge receipt");
    assert.equal(receipt.configDigest, state.configDigest, "completed merge receipt config digest mismatch");
    if (sourceContract) {
      assert.equal(receipt.sourceManifest?.sourcePolicyDigest, sourceContract.digest,
        "completed merge receipt source policy digest mismatch");
      assert.equal(receipt.sourceManifest?.configDigest, state.configDigest,
        "completed merge receipt source manifest config digest mismatch");
      const manifest = path.join(outDir, receipt.sourceManifest.path);
      assert.ok(fs.existsSync(manifest), "completed source-policy build is missing its immutable source manifest");
      assert.equal(await fileDigest(manifest), receipt.sourceManifest.digest,
        "completed source manifest digest does not match its merge receipt");
    }
    if (publicationContract) {
      assert.equal(receipt.publicationPolicy?.digest, publicationContract.digest,
        "completed merge receipt publication policy digest mismatch");
      assert.equal(receipt.publicationPolicy?.globalConfigDigest, state.configDigest,
        "completed merge receipt publication policy config digest mismatch");
      assert.equal(canonicalJson(receipt.publicationPolicy?.policy), canonicalJson(publicationContract.policy),
        "completed merge receipt publication policy mismatch");
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
      if (sourceContract) await assertCompletedShardSource({ index: shard.index, outDir: out }, sourceContract, state.configDigest, cacheDir);
      assertCompletedShardPublication({ index: shard.index, outDir: out }, publicationContract, state.configDigest);
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
        if (sourceContract) await assertCompletedShardSource({ index, outDir: out }, sourceContract, state.configDigest, cacheDir);
        assertCompletedShardPublication({ index, outDir: out }, publicationContract, state.configDigest);
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
  const { merged } = await mergeShardStores(state.shards, outDir, {
    faultMergeRenameAfter: args.faultMergeRenameAfter,
    faultMergeCrashAfter: args.faultMergeCrashAfter,
  });
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
    approvedConfigPath,
    ...(publicationContract ? {
      publicationPolicy: {
        policy: publicationContract.policy,
        digest: publicationContract.digest,
        globalConfigDigest: state.configDigest,
      },
    } : {}),
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
  finalizeArtifactSet(outDir);
  process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged: completed }, null, 2)}\n`);
}

await main();
