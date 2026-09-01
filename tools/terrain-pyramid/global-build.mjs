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
  MAX_GLOBAL_SHARDS,
  makeShardConfigs,
  markShard,
  saveGlobalState,
} from "./build-support.mjs";
import { readDtt } from "./dtt-reader.mjs";
import {
  MAX_GLOBAL_SOURCE_CACHE_BYTES,
  MAX_GLOBAL_STATIC_DIRECTORY_BYTES,
  MAX_GLOBAL_VERIFIED_STORE_BYTES,
  canonicalJson,
  emitCompletionSourceManifest,
  ensureSourceEpoch,
  fsyncFile,
  mergeBoundedFramedStores,
  mergeOceanSkips,
  publicationPolicyContract,
  sourcePolicyContract,
  sha256,
  validateSourceObservationLog,
} from "./source-provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_MAX_BYTES = MAX_GLOBAL_SOURCE_CACHE_BYTES;
const MAX_SHARD_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_STATE_BYTES = 4 * 1024 * 1024;
const GLOBAL_ARTIFACT_NAMES = Object.freeze([
  "tiles.dttstream",
  "ocean-skipped.lines",
  "ocean-skipped.json",
]);
const GLOBAL_SOURCE_MANIFEST_NAME = "source-manifest.ndjson";

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
    else if (flag === "--fault-after-terminal-state") args.faultAfterTerminalState = true;
    else if (flag === "--fault-after-verify") args.faultAfterVerify = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  assert.ok(args.config, "--config <run.json> is required");
  assert.ok(args.out, "--out <dir> is required");
  for (const [name, value] of [["--shards", args.shards], ["--workers", args.workers], ["--cache-max-bytes", args.cacheMaxBytes], ["--max-cells", args.maxCells], ["--fault-after-shards", args.faultAfterShards], ["--fault-merge-rename-after", args.faultMergeRenameAfter], ["--fault-merge-crash-after", args.faultMergeCrashAfter]]) {
    if (value !== undefined) assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  }
  assert.ok(args.workers <= args.shards, "--workers may not exceed --shards");
  assert.ok(args.shards <= MAX_GLOBAL_SHARDS,
    `--shards may not exceed the ${MAX_GLOBAL_SHARDS}-shard coordinator policy`);
  return args;
}

function verifierPublicationPolicy(contract, globalConfigDigest) {
  if (!contract) return null;
  return {
    format: "terrain-publication-policy-v1",
    globalConfigDigest,
    maxVerifiedStoreBytes: contract.policy.max_verified_store_bytes,
    maxStaticDirectoryBytes: contract.policy.max_static_directory_bytes,
    synthGridSize: contract.policy.synthesized_tile_grid_size,
  };
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

function assertStableFileStat(before, after, label) {
  assert.equal(after.dev, before.dev, `${label} inode changed while reading`);
  assert.equal(after.ino, before.ino, `${label} inode changed while reading`);
  assert.equal(after.size, before.size, `${label} changed while reading`);
  // Inode/size alone do not catch a writer that replaces bytes in place with
  // the same length. ctime is kernel-maintained and cannot be restored with
  // utimes(2), so require it (and mtime) to remain stable through the read.
  assert.equal(after.mtimeNs, before.mtimeNs, `${label} changed while reading`);
  assert.equal(after.ctimeNs, before.ctimeNs, `${label} changed while reading`);
}

function stableDigestFile(file, { maxBytes = Infinity, label = path.basename(file) } = {}) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${label} is not a regular file`);
    assert.ok(maxBytes === Infinity || before.size <= BigInt(maxBytes), `${label} exceeds ${maxBytes} byte bound`);
    const size = Number(before.size);
    assert.ok(Number.isSafeInteger(size), `${label} exceeds JavaScript's safe byte range`);
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      const read = fs.readSync(handle, chunk, 0, Math.min(chunk.length, size - position), position);
      assert.ok(read > 0, `${label} ended while reading`);
      hash.update(chunk.subarray(0, read));
      position += read;
    }
    assertStableFileStat(before, fs.fstatSync(handle, { bigint: true }), label);
    return { digest: hash.digest("hex"), bytes: size };
  } finally { fs.closeSync(handle); }
}

async function fileDigest(file, options = {}) {
  return stableDigestFile(file, options).digest;
}

function stableReadSmallFile(file, maxBytes, label) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${label} is not a regular file`);
    assert.ok(before.size <= BigInt(maxBytes), `${label} exceeds ${maxBytes} byte bound`);
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle, { bigint: true });
    assertStableFileStat(before, after, label);
    return bytes;
  } finally { fs.closeSync(handle); }
}

function readShardReport(file) {
  const bytes = stableReadSmallFile(file, MAX_SHARD_REPORT_BYTES, "shard run report");
  return { report: JSON.parse(bytes.toString("utf8")), digest: sha256(bytes) };
}

// Copy every coordinator input through an already-open, non-symlink source fd.
// Later validation and merge consume this immutable local snapshot rather than
// reopening a shard-owned pathname that could be replaced at equal length.
function snapshotShardInput(outDir, shard, name, source, { maxBytes = Infinity } = {}) {
  const snapshotDir = path.join(outDir, ".coordinator-shard-snapshots", `shard-${String(shard).padStart(3, "0")}`);
  fs.mkdirSync(snapshotDir, { recursive: true });
  // The child directory name is itself part of the state checkpoint. Persist
  // both that entry and the containing snapshot root before publishing paths
  // into global-build-state.json.
  fsyncDirectory(snapshotDir);
  fsyncDirectory(path.dirname(snapshotDir));
  fsyncDirectory(path.dirname(path.dirname(snapshotDir)));
  const destination = path.join(snapshotDir, name);
  const temporary = `${destination}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(input, { bigint: true });
    assert.ok(before.isFile(), `shard ${shard} ${name} is not a regular file`);
    assert.ok(maxBytes === Infinity || before.size <= BigInt(maxBytes), `shard ${shard} ${name} exceeds ${maxBytes} byte bound`);
    const size = Number(before.size);
    assert.ok(Number.isSafeInteger(size), `shard ${shard} ${name} exceeds JavaScript's safe byte range`);
    const output = fs.openSync(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    try {
      let position = 0;
      while (position < size) {
        const read = fs.readSync(input, chunk, 0, Math.min(chunk.length, size - position), position);
        assert.ok(read > 0, `shard ${shard} ${name} ended while snapshotting`);
        fs.writeSync(output, chunk, 0, read);
        hash.update(chunk.subarray(0, read));
        position += read;
      }
      fs.fsyncSync(output);
    } finally { fs.closeSync(output); }
    const after = fs.fstatSync(input, { bigint: true });
    assertStableFileStat(before, after, `shard ${shard} ${name}`);
    fs.renameSync(temporary, destination);
    fsyncDirectory(snapshotDir);
    fsyncDirectory(path.dirname(snapshotDir));
    fsyncDirectory(path.dirname(path.dirname(snapshotDir)));
    return { path: destination, digest: hash.digest("hex"), bytes: size };
  } finally {
    fs.closeSync(input);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function fsyncDirectory(directory) {
  const handle = fs.openSync(directory, "r");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function fsyncArtifact(file) {
  fsyncFile(file);
  fsyncDirectory(path.dirname(file));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
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

function reportIsCompleteFile(report) {
  if (!fs.existsSync(report)) return false;
  const { report: parsed } = readShardReport(report);
  return parsed.drained === true && Array.isArray(parsed.errors) && parsed.errors.length === 0;
}

function reportIsComplete(outDir) {
  const report = path.join(outDir, "run-report.json");
  const stream = path.join(outDir, "tiles.dttstream");
  return fs.existsSync(stream) && reportIsCompleteFile(report);
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
  return shard.snapshots?.sourceLog?.path ?? path.join(shard.outDir, contract.policy.manifest.shard_log);
}

function snapshotLimit(name, publicationContract) {
  if (name === "report") return MAX_SHARD_REPORT_BYTES;
  if (name === "tiles") return publicationContract?.policy.max_verified_store_bytes ?? MAX_GLOBAL_VERIFIED_STORE_BYTES;
  return MAX_GLOBAL_STATIC_DIRECTORY_BYTES;
}

function assertSnapshotBudget(state, snapshots, publicationContract) {
  const ceiling = publicationContract?.policy.max_static_directory_bytes ?? MAX_GLOBAL_STATIC_DIRECTORY_BYTES;
  let committed = 0;
  for (const shard of state.shards) {
    if (shard.status !== "complete") continue;
    for (const snapshot of Object.values(shard.snapshots ?? {})) {
      assert.ok(Number.isSafeInteger(snapshot?.bytes) && snapshot.bytes >= 0,
        `shard ${shard.index} has an invalid persisted snapshot byte count`);
      committed += snapshot.bytes;
    }
  }
  const candidate = Object.values(snapshots).reduce((total, snapshot) => total + snapshot.bytes, 0);
  assert.ok(Number.isSafeInteger(committed + candidate) && committed + candidate <= ceiling,
    `coordinator shard snapshots ${committed + candidate} exceed approved ${ceiling}-byte static ceiling`);
}

function assertSnapshot(outDir, shard, name, publicationContract) {
  const snapshot = shard.snapshots?.[name];
  assert.ok(snapshot && typeof snapshot.path === "string", `shard ${shard.index} is missing ${name} snapshot metadata`);
  const root = `${path.resolve(outDir, ".coordinator-shard-snapshots")}${path.sep}`;
  assert.ok(path.resolve(snapshot.path).startsWith(root), `shard ${shard.index} ${name} snapshot escapes coordinator storage`);
  assert.ok(Number.isSafeInteger(snapshot.bytes) && snapshot.bytes >= 0,
    `shard ${shard.index} ${name} snapshot byte count is invalid`);
  assert.match(snapshot.digest ?? "", /^[0-9a-f]{64}$/, `shard ${shard.index} ${name} snapshot digest is invalid`);
  const actual = stableDigestFile(snapshot.path, {
    maxBytes: snapshotLimit(name, publicationContract), label: `shard ${shard.index} ${name} snapshot`,
  });
  assert.equal(actual.bytes, snapshot.bytes, `shard ${shard.index} ${name} snapshot byte count changed`);
  assert.equal(actual.digest, snapshot.digest, `shard ${shard.index} ${name} snapshot digest changed`);
}

function assertCompletedShardSnapshots(outDir, shard, sourceContract, publicationContract) {
  for (const name of ["report", "tiles"]) assertSnapshot(outDir, shard, name, publicationContract);
  if (sourceContract) assertSnapshot(outDir, shard, "sourceLog", publicationContract);
  if (shard.snapshots?.oceanLines) assertSnapshot(outDir, shard, "oceanLines", publicationContract);
  if (shard.snapshots?.oceanJson) assertSnapshot(outDir, shard, "oceanJson", publicationContract);
  assert.ok(!(shard.snapshots?.oceanLines && shard.snapshots?.oceanJson),
    `shard ${shard.index} must not mix ocean-skip formats`);
}

async function assertCompletedShardSource(shard, contract, globalConfigDigest, cacheDir) {
  const report = readShardReport(shard.snapshots?.report?.path ?? path.join(shard.outDir, "run-report.json")).report;
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
  const report = readShardReport(shard.snapshots?.report?.path ?? path.join(shard.outDir, "run-report.json")).report;
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

function terminalVerificationMatchesState(outDir) {
  const reportPath = path.join(outDir, "verify-report.json");
  const statePath = path.join(outDir, "global-build-state.json");
  const configPath = path.join(outDir, "approved-run-config.json");
  if (!fs.existsSync(reportPath) || !fs.existsSync(statePath) || !fs.existsSync(configPath)) return false;
  const report = JSON.parse(stableReadSmallFile(reportPath, MAX_GLOBAL_STATE_BYTES, "verification report").toString("utf8"));
  const state = stableDigestFile(statePath, { maxBytes: MAX_GLOBAL_STATE_BYTES, label: "global build state" });
  const config = stableDigestFile(configPath, { maxBytes: MAX_GLOBAL_STATE_BYTES, label: "approved run config" });
  const receipt = report?.publicationInputs;
  return report?.format === "terrain-verification-report-v1" && report?.publishable === true &&
    Array.isArray(report.problems) && report.problems.length === 0 &&
    receipt?.format === "terrain-publication-inputs-v2" &&
    receipt.globalState?.path === "global-build-state.json" &&
    receipt.globalState?.bytes === state.bytes && receipt.globalState?.sha256 === state.digest &&
    receipt.approvedConfig?.path === "approved-run-config.json" &&
    receipt.approvedConfig?.bytes === config.bytes && receipt.approvedConfig?.sha256 === config.digest;
}

function terminalMergeReportMatchesState(outDir, state) {
  const reportPath = path.join(outDir, "global-merge-report.json");
  if (!fs.existsSync(reportPath) || !state.merged) return false;
  const report = JSON.parse(stableReadSmallFile(reportPath, MAX_GLOBAL_STATE_BYTES, "global merge report").toString("utf8"));
  return canonicalJson(report) === canonicalJson(state.merged);
}

function lstatIfExists(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlinkTraversal(outDir, file, label, { final = "regular-or-absent" } = {}) {
  const root = path.resolve(outDir);
  const resolved = path.resolve(file);
  assert.ok(resolved.startsWith(`${root}${path.sep}`), `${label} escapes the global output directory`);
  const rootStat = fs.lstatSync(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `${label} output directory is not a real directory`);
  const parts = path.relative(root, resolved).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatIfExists(current);
    if (!stat) return null;
    assert.ok(!stat.isSymbolicLink(), `${label} traverses a symbolic link: ${current}`);
    if (index !== parts.length - 1) {
      assert.ok(stat.isDirectory(), `${label} parent is not a directory: ${current}`);
      continue;
    }
    if (final === "directory") assert.ok(stat.isDirectory(), `${label} is not a directory: ${current}`);
    else assert.ok(stat.isFile(), `${label} is not a regular file: ${current}`);
    return stat;
  }
  return null;
}

function assertArtifactFile(outDir, file, label, { required = false } = {}) {
  const stat = assertNoSymlinkTraversal(outDir, file, label);
  if (required) assert.ok(stat, `${label} is missing: ${file}`);
  return stat;
}

function unlinkArtifact(outDir, file, label) {
  const stat = assertArtifactFile(outDir, file, label);
  if (stat) fs.unlinkSync(file);
}

function renameArtifact(outDir, source, destination, label) {
  assertArtifactFile(outDir, source, `${label} source`, { required: true });
  assert.equal(assertArtifactFile(outDir, destination, `${label} destination`), null,
    `${label} destination already exists: ${destination}`);
  fs.renameSync(source, destination);
  fsyncDirectory(outDir);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertArtifactTransaction(transaction, outDir) {
  assert.equal(transaction?.version, 1, "unsupported global artifact transaction");
  assert.ok(Array.isArray(transaction.entries) && transaction.entries.length >= 3 && transaction.entries.length <= 4,
    "global artifact transaction has an invalid artifact set");
  assert.deepEqual(Object.keys(transaction).sort(), ["entries", "stagingDir", "version"],
    "global artifact transaction has unexpected authority-bearing fields");
  const root = path.resolve(outDir);
  assertNoSymlinkTraversal(path.dirname(root), root, "global artifact transaction output", { final: "directory" });
  assert.equal(typeof transaction.stagingDir, "string", "global artifact transaction has no staging directory");
  const stagingDir = path.resolve(transaction.stagingDir);
  assert.equal(transaction.stagingDir, stagingDir, "global artifact transaction staging directory must be absolute and canonical");
  assert.equal(path.dirname(stagingDir), root, "global artifact transaction staging path is not a direct output child");
  assert.match(path.basename(stagingDir), /^\.global-merge-stage-[A-Za-z0-9_-]+$/,
    "global artifact transaction has an invalid staging directory name");
  assertNoSymlinkTraversal(root, stagingDir, "global artifact transaction staging directory", { final: "directory" });
  const expectedNames = transaction.entries.length === GLOBAL_ARTIFACT_NAMES.length
    ? GLOBAL_ARTIFACT_NAMES
    : [...GLOBAL_ARTIFACT_NAMES, GLOBAL_SOURCE_MANIFEST_NAME];
  assert.deepEqual(transaction.entries.map((entry) => path.basename(entry?.destination ?? "")), expectedNames,
    "global artifact transaction entries are not the exact coordinator-owned artifact set");
  for (const [index, entry] of transaction.entries.entries()) {
    const name = expectedNames[index];
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "global artifact transaction entry is invalid");
    assert.deepEqual(Object.keys(entry).sort(), ["backup", "destination", "hadDestination", "staged"],
      `global artifact transaction ${name} has unexpected authority-bearing fields`);
    assert.equal(typeof entry.destination, "string", `global artifact transaction ${name} destination is missing`);
    assert.equal(typeof entry.staged, "string", `global artifact transaction ${name} stage is missing`);
    assert.equal(entry.destination, path.join(root, name),
      `global artifact transaction ${name} destination is not coordinator-owned`);
    assert.equal(entry.staged, path.join(stagingDir, name),
      `global artifact transaction ${name} stage is not coordinator-owned`);
    assert.equal(typeof entry.backup, "string", `global artifact transaction ${name} backup is missing`);
    assert.equal(path.dirname(entry.backup), root, `global artifact transaction ${name} backup is not a direct output child`);
    assert.match(path.basename(entry.backup), new RegExp(`^${escapeRegExp(name)}\\.premerge-[A-Za-z0-9_-]+$`),
      `global artifact transaction ${name} backup is not coordinator-owned`);
    assert.equal(typeof entry.hadDestination, "boolean", "global artifact transaction destination state is missing");
    assertArtifactFile(root, entry.staged, `global artifact transaction ${name} stage`);
    assertArtifactFile(root, entry.destination, `global artifact transaction ${name} destination`);
    assertArtifactFile(root, entry.backup, `global artifact transaction ${name} backup`);
  }
}

// An individual rename is atomic, but a process can die between the three.
// Keep a durable transaction plus backups until the terminal state receipt is
// written. On an incomplete restart we restore the previous complete set; on
// a completed restart we merely finalize stale transaction metadata.
function recoverArtifactSet(outDir, { completed, preserve = false }) {
  const file = artifactTransactionPath(outDir);
  if (!assertArtifactFile(outDir, file, "global artifact transaction journal")) return false;
  const transaction = JSON.parse(stableReadSmallFile(file, 128 * 1024, "global artifact transaction").toString("utf8"));
  assertArtifactTransaction(transaction, outDir);
  // A durable terminal state can precede verify-report.json. Its transaction
  // backups are still the rollback proof until the verifier binds that exact
  // state, so do not interpret "completed" as permission to discard them.
  if (preserve) return true;
  if (completed) {
    for (const entry of transaction.entries) unlinkArtifact(outDir, entry.backup, "global artifact transaction backup");
  } else {
    for (const entry of [...transaction.entries].reverse()) {
      const backup = assertArtifactFile(outDir, entry.backup, "global artifact transaction backup");
      const staged = assertArtifactFile(outDir, entry.staged, "global artifact transaction stage");
      if (backup) {
        unlinkArtifact(outDir, entry.destination, "global artifact transaction destination");
        renameArtifact(outDir, entry.backup, entry.destination, "global artifact transaction restore");
      } else if (!staged) {
        // No old destination means this is either an installed new artifact,
        // or (for the completion manifest) a reservation made before its
        // staged bytes were produced. Both cases are safe to remove. When an
        // old destination exists, no missing backup means installation had
        // not begun; preserve that old immutable artifact.
        if (!entry.hadDestination) unlinkArtifact(outDir, entry.destination, "global artifact transaction destination");
      }
      // If the staged file still exists, this entry was never installed; the
      // destination (if any) is the untouched old one and must be preserved.
    }
  }
  for (const entry of transaction.entries) unlinkArtifact(outDir, entry.staged, "global artifact transaction stage");
  assertNoSymlinkTraversal(outDir, transaction.stagingDir, "global artifact transaction staging directory", { final: "directory" });
  assert.deepEqual(fs.readdirSync(transaction.stagingDir), [], "global artifact transaction staging directory has unexpected entries");
  fs.rmdirSync(transaction.stagingDir);
  unlinkArtifact(outDir, file, "global artifact transaction journal");
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
      hadDestination: Boolean(assertArtifactFile(outDir, destination, "global artifact destination")),
    })),
  };
  const journalPath = artifactTransactionPath(outDir);
  assertArtifactTransaction(transaction, outDir);
  assert.equal(assertArtifactFile(outDir, journalPath, "global artifact transaction journal"), null,
    "an unfinished global artifact transaction must be recovered before install");
  writeJsonAtomic(journalPath, transaction);
  try {
    let installed = 0;
    for (const entry of transaction.entries) {
      if (entry.hadDestination) renameArtifact(outDir, entry.destination, entry.backup, "global artifact backup");
      renameArtifact(outDir, entry.staged, entry.destination, "global artifact install");
      fsyncArtifact(entry.destination);
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

// The source manifest is a fourth member of the tiles/ocean rollback set. Its
// staged bytes are durable before this intent is appended to the transaction.
function reserveArtifact(transaction, destination, staged) {
  const outDir = path.dirname(destination);
  assertArtifactTransaction(transaction, outDir);
  const entry = {
    staged,
    destination,
    backup: `${destination}.premerge-${process.pid}-${Date.now()}`,
    hadDestination: Boolean(assertArtifactFile(outDir, destination, "reserved global artifact destination")),
  };
  transaction.entries.push(entry);
  assertArtifactTransaction(transaction, outDir);
  writeJsonAtomic(artifactTransactionPath(outDir), transaction);
  return entry;
}

function installReservedArtifact(transaction, entry) {
  const outDir = path.dirname(entry.destination);
  assertArtifactTransaction(transaction, outDir);
  if (entry.hadDestination) {
    renameArtifact(outDir, entry.destination, entry.backup, "reserved global artifact backup");
  }
  renameArtifact(outDir, entry.staged, entry.destination, "reserved global artifact install");
  fsyncArtifact(entry.destination);
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
      inputFiles: ordered.map((shard) => shard.snapshots?.tiles?.path ?? path.join(shard.outDir, "tiles.dttstream")),
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
    fsyncArtifact(stagedTiles);
    const stagedOcean = path.join(staging, "ocean-skipped.lines");
    const ocean = await mergeOceanSkips({
      inputFiles: ordered.map((shard) => {
        return shard.snapshots?.oceanLines?.path ?? shard.snapshots?.oceanJson?.path ??
          path.join(shard.outDir, "ocean-skipped.lines");
      }),
      outputFile: stagedOcean,
    });
    assert.equal(ocean.duplicates, 0, "ocean-skip merge must not hide duplicate shard coverage");
    fsyncArtifact(stagedOcean);
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
    fsyncArtifact(oceanReceipt);
    // The stage directory entry and every staged file are durable before the
    // transaction journal can authorize any destination rename.
    fsyncDirectory(staging);
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
  if (sourceContract) {
    assert.equal(sourceContract.policy.manifest.completion_manifest, GLOBAL_SOURCE_MANIFEST_NAME,
      "global source completion manifest must use the coordinator-owned source-manifest.ndjson basename");
  }
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
  const terminalVerified = args.verify && state.completed && terminalVerificationMatchesState(outDir);
  const terminalMergeReported = state.completed && terminalMergeReportMatchesState(outDir, state);
  recoverArtifactSet(outDir, {
    completed: state.completed && terminalVerified && terminalMergeReported,
    preserve: state.completed && !(terminalVerified && terminalMergeReported),
  });
  const approvedConfigPath = ensureApprovedRunConfig(outDir, runConfig, state.configDigest);
  const sourceState = bindSourceEpochToState(state, sourceContract);
  if (publicationContract) {
    const verifierPolicy = verifierPublicationPolicy(publicationContract, state.configDigest);
    const existing = state.publicationPolicy;
    if (existing) {
      assert.equal(canonicalJson(existing), canonicalJson(verifierPolicy),
        "refusing to resume a state written for a different publication policy");
    } else {
      state.publicationPolicy = verifierPolicy;
    }
  }
  const finalReport = path.join(outDir, "global-merge-report.json");
  assert.ok(state.completed || !fs.existsSync(finalReport),
    "incomplete global state has a terminal merge report; refuse a torn attempt instead of treating it as approved");
  if (!state.completed) saveGlobalState(outDir, state);
  const configs = makeShardConfigs(runConfig, args.shards, { outDir, cacheDir, cacheMaxBytes }).map((config) => ({
    ...config,
    global_config_digest: state.configDigest,
    ...(sourceState ? { source_run_started_at: sourceState.sourceRunStartedAt } : {}),
  }));

  if (state.completed) {
    // A terminal receipt does not waive the shard evidence: every resume
    // rechecks every coordinator-owned snapshot before reporting success.
    for (const shard of state.shards) {
      assertCompletedShardSnapshots(outDir, shard, sourceContract, publicationContract);
      if (sourceContract) await assertCompletedShardSource(shard, sourceContract, state.configDigest, cacheDir);
      assertCompletedShardPublication(shard, publicationContract, state.configDigest);
    }
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
      assert.equal(canonicalJson(receipt.publicationPolicy),
        canonicalJson(verifierPublicationPolicy(publicationContract, state.configDigest)),
      "completed merge receipt publication policy mismatch");
    }
    // A terminal state is deliberately written before verification. If a
    // power loss leaves either report absent, retain transaction backups and
    // re-run the verifier against this immutable state; never re-merge it.
    if (args.verify && !terminalVerificationMatchesState(outDir)) {
      fs.rmSync(finalReport, { force: true });
      fsyncDirectory(outDir);
      await runNode([path.join(HERE, "verify.mjs"), "--out", outDir]);
    }
    if (args.faultAfterVerify) throw new Error("fault injection after global verification");
    assert.ok(!args.verify || terminalVerificationMatchesState(outDir),
      "verifier did not emit a v2 receipt bound to the terminal global state");
    if (!terminalMergeReportMatchesState(outDir, state)) writeJsonAtomic(finalReport, receipt);
    finalizeArtifactSet(outDir);
    process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged: receipt, resumed: true }, null, 2)}\n`);
    return;
  }

  const pending = [];
  for (const shard of state.shards) {
    const out = path.join(outDir, "shards", `shard-${String(shard.index).padStart(3, "0")}`);
    if (shard.status === "complete" && shard.snapshots?.tiles && shard.snapshots?.report) {
      assertCompletedShardSnapshots(outDir, shard, sourceContract, publicationContract);
      if (reportIsCompleteFile(shard.snapshots.report.path) &&
          shard.outputDigest === shard.snapshots.tiles.digest) {
        if (sourceContract) await assertCompletedShardSource(shard, sourceContract, state.configDigest, cacheDir);
        assertCompletedShardPublication(shard, publicationContract, state.configDigest);
        continue;
      }
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
      markShard(state, index, "running", { snapshots: undefined, outputDigest: undefined });
      saveGlobalState(outDir, state);
      try {
        await runNode([
          path.resolve(args.runner ?? path.join(HERE, "run.mjs")), "--config", configFile, "--out", out,
          "--cache-dir", cacheDir, "--cache-max-bytes", String(cacheMaxBytes),
          ...(args.maxCells ? ["--max-cells", String(args.maxCells)] : []),
          ...(args.wasmedgeVerify === false ? ["--no-wasmedge-verify"] : []),
        ]);
        assert.ok(reportIsComplete(out), `shard ${index} did not leave a clean run report`);
        const snapshotDir = path.join(outDir, ".coordinator-shard-snapshots", `shard-${String(index).padStart(3, "0")}`);
        // A previously failed attempt can have snapshotted some inputs before
        // validation. It never reached a durable complete checkpoint, so its
        // exact coordinator-owned directory may be safely replaced.
        const snapshotRoot = path.dirname(snapshotDir);
        fs.mkdirSync(snapshotRoot, { recursive: true });
        fsyncDirectory(snapshotRoot);
        fsyncDirectory(outDir);
        fs.rmSync(snapshotDir, { recursive: true, force: true });
        fsyncDirectory(snapshotRoot);
        const snapshots = {
          report: snapshotShardInput(outDir, index, "run-report.json", path.join(out, "run-report.json"), { maxBytes: MAX_SHARD_REPORT_BYTES }),
          tiles: snapshotShardInput(outDir, index, "tiles.dttstream", path.join(out, "tiles.dttstream"), {
            maxBytes: snapshotLimit("tiles", publicationContract),
          }),
        };
        const oceanLines = path.join(out, "ocean-skipped.lines");
        if (fs.existsSync(oceanLines)) {
          snapshots.oceanLines = snapshotShardInput(outDir, index, "ocean-skipped.lines", oceanLines, {
            maxBytes: snapshotLimit("oceanLines", publicationContract),
          });
        } else if (fs.existsSync(path.join(out, "ocean-skipped.json"))) {
          snapshots.oceanJson = snapshotShardInput(outDir, index, "ocean-skipped.json", path.join(out, "ocean-skipped.json"), {
            maxBytes: snapshotLimit("oceanJson", publicationContract),
          });
        }
        if (sourceContract) {
          snapshots.sourceLog = snapshotShardInput(outDir, index, "source-observations.ndjson", shardSourceLog({ outDir: out }, sourceContract), {
            maxBytes: snapshotLimit("sourceLog", publicationContract),
          });
          await assertCompletedShardSource({ index, outDir: out, snapshots }, sourceContract, state.configDigest, cacheDir);
        }
        assertSnapshotBudget(state, snapshots, publicationContract);
        assertCompletedShardPublication({ index, outDir: out, snapshots }, publicationContract, state.configDigest);
        markShard(state, index, "complete", { outputDigest: snapshots.tiles.digest, snapshots });
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
  const { merged, transaction } = await mergeShardStores(state.shards, outDir, {
    faultMergeRenameAfter: args.faultMergeRenameAfter,
    faultMergeCrashAfter: args.faultMergeCrashAfter,
  });
  state.mergeCandidate = { ...merged, at: new Date().toISOString() };
  saveGlobalState(outDir, state);
  if (publicationContract) {
    const size = fs.statSync(path.join(outDir, "tiles.dttstream")).size;
    assert.ok(size <= publicationContract.policy.max_verified_store_bytes,
      `merged verified store ${size} exceeds approved ${publicationContract.policy.max_verified_store_bytes}-byte ceiling`);
  }
  const sourceManifest = sourceContract
    ? await (async () => {
        const destination = path.resolve(outDir, sourceContract.policy.manifest.completion_manifest);
        const staged = path.join(transaction.stagingDir, path.basename(destination));
        const receipt = await emitCompletionSourceManifest({
          outDir, outputFile: staged, reportedPath: path.relative(outDir, destination),
          logFiles: state.shards.map((shard) => shardSourceLog(shard, sourceContract)),
          contract: sourceContract, configDigest: state.configDigest,
        });
        // A crash before this durable staged file exists leaves the original
        // three-artifact journal untouched. Only then record the fourth
        // intent, so recovery never has to infer whether an old manifest was
        // backed up before an absent stage could be installed.
        const entry = reserveArtifact(transaction, destination, staged);
        installReservedArtifact(transaction, entry);
        return receipt;
      })()
    : null;
  const completed = {
    ...merged,
    completion: "complete",
    completedAt: new Date().toISOString(),
    configDigest: state.configDigest,
    approvedConfigPath,
    ...(publicationContract ? {
      publicationPolicy: verifierPublicationPolicy(publicationContract, state.configDigest),
    } : {}),
    ...(sourceManifest ? { sourceManifest, sourceEpochReceipt: path.relative(outDir, sourceEpoch.file) } : {}),
  };
  state.merged = completed;
  state.completed = true;
  if (sourceState) sourceState.completed = true;
  // This is the terminal, immutable verifier input. Do not write state again
  // below: verify-report v2 binds these exact bytes, and backups remain until
  // that receipt and the user-facing merge report both exist.
  saveGlobalState(outDir, state);
  if (args.faultAfterTerminalState) throw new Error("fault injection after terminal global state");
  if (args.verify) await runNode([path.join(HERE, "verify.mjs"), "--out", outDir]);
  if (args.faultAfterVerify) throw new Error("fault injection after global verification");
  assert.ok(!args.verify || terminalVerificationMatchesState(outDir),
    "verifier did not emit a v2 receipt bound to the terminal global state");
  // Write this only after the durable terminal state and its bound verifier
  // receipt. The temp+rename prevents a torn JSON file from looking approved.
  writeJsonAtomic(path.join(outDir, "global-merge-report.json"), completed);
  finalizeArtifactSet(outDir);
  process.stdout.write(`${JSON.stringify({ outDir, shards: state.shards.length, merged: completed }, null, 2)}\n`);
}

await main();
