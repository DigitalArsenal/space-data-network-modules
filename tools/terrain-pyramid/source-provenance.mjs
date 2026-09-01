// Immutable source-observation support for global terrain cuts.
//
// The bounded granule cache owns bytes and eviction.  This companion owns the
// evidence that makes those bytes usable as a source: a response receipt per
// cache key, append-only per-request logs, and a completion-only canonical
// manifest assembled by external sort.  Neither the runner nor the merger
// keeps a world-sized URL map in memory.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { iterateStreamFile, MAX_TERRAIN_RECORD_BYTES } from "./dtt-reader.mjs";

export const MAX_GLOBAL_SOURCE_CACHE_BYTES = 96 * 1024 ** 3;
// Publication is deliberately bounded independently from source cache space.
// These are protocol ceilings for the approved z<=10 epoch, not aspirational
// disk capacities: a changed global scope must obtain a new reviewed policy.
export const MAX_GLOBAL_VERIFIED_STORE_BYTES = 16 * 1024 ** 3;
// The global static directory is empirically much larger than the compressed
// DTT stream (the checked Liguria identity directory is 12.807x its store).
// 128 GiB is a reviewed binary ceiling, not a generic 1 TiB escape hatch.
export const MAX_GLOBAL_STATIC_DIRECTORY_BYTES = 128 * 1024 ** 3;
export const SOURCE_MANIFEST_VERSION = 1;
const MAX_OBSERVATION_LINE_BYTES = 16 * 1024;
const SOURCE_SORT_RUN_BYTES = 4 * 1024 * 1024;
const SOURCE_SORT_FAN_IN = 32;
const MAX_MERGE_RECORD_LINE_BYTES = 2 * 1024 * 1024;
const TERRAIN_SORT_RUN_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_EPOCH_BYTES = 4 * 1024;
const MAX_SOURCE_RECEIPT_BYTES = 16 * 1024;
const MAX_SOURCE_URL_BYTES = 4 * 1024;
const MAX_SOURCE_HEADER_BYTES = 8 * 1024;
const MAX_SOURCE_TIMESTAMP_BYTES = 128;
// The runner intentionally holds one whole planned-cell record stream before
// atomically committing it with the $IRM mark. Liguria evidence includes a
// 1,693-tile cell (about 12.3 MiB at the measured 7,616 B/tile average), so a
// tiny generic append cap would reject an approved regional cut. Derive each
// live attempt's allowance from its planner-owned tile count and the framing
// reader's hard record maximum, but retain a 32 MiB ceiling so a forged or
// incompatible planner cannot turn recovery into unbounded allocation.
export const MAX_CELL_ATTEMPT_APPEND_BYTES = 32 * 1024 * 1024;
export const MAX_GLOBAL_SOURCE_RESPONSE_BYTES = 128 * 1024 ** 2;

export function cellAttemptAppendBound(cellTiles) {
  assert.ok(Number.isSafeInteger(cellTiles) && cellTiles > 0,
    "cell attempt needs a positive planner-owned tile count");
  const framedRecordBytes = MAX_TERRAIN_RECORD_BYTES + 4;
  assert.ok(cellTiles <= Math.floor(Number.MAX_SAFE_INTEGER / framedRecordBytes),
    "cell attempt planner tile count overflows its framed record bound");
  return Math.min(MAX_CELL_ATTEMPT_APPEND_BYTES, cellTiles * framedRecordBytes);
}

function assertCellAttemptAppendBound(maxAppendBytes) {
  assert.ok(Number.isSafeInteger(maxAppendBytes) && maxAppendBytes > 0 &&
    maxAppendBytes <= MAX_CELL_ATTEMPT_APPEND_BYTES,
  `cell attempt append bound must be in [1, ${MAX_CELL_ATTEMPT_APPEND_BYTES}]`);
  return maxAppendBytes;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Validate the small, immutable publication envelope carried by every shard. */
export function publicationPolicyContract(runConfig) {
  const policy = runConfig?.publication_policy;
  if (!policy) return null;
  assert.equal(policy.version, 1, "publication_policy.version must be 1");
  assert.ok(Number.isSafeInteger(policy.max_verified_store_bytes) && policy.max_verified_store_bytes > 0,
    "publication_policy.max_verified_store_bytes must be a positive safe integer");
  assert.ok(policy.max_verified_store_bytes <= MAX_GLOBAL_VERIFIED_STORE_BYTES,
    `publication_policy.max_verified_store_bytes may not exceed ${MAX_GLOBAL_VERIFIED_STORE_BYTES} bytes`);
  assert.ok(Number.isSafeInteger(policy.max_static_directory_bytes) && policy.max_static_directory_bytes > 0,
    "publication_policy.max_static_directory_bytes must be a positive safe integer");
  assert.ok(policy.max_static_directory_bytes <= MAX_GLOBAL_STATIC_DIRECTORY_BYTES,
    `publication_policy.max_static_directory_bytes may not exceed ${MAX_GLOBAL_STATIC_DIRECTORY_BYTES} bytes`);
  assert.ok(policy.max_static_directory_bytes >= policy.max_verified_store_bytes,
    "publication_policy.max_static_directory_bytes must cover the verified store ceiling");
  assert.ok(typeof policy.static_directory_basis === "string" && policy.static_directory_basis.length > 0,
    "publication_policy.static_directory_basis is required");
  assert.ok(Number.isSafeInteger(policy.synthesized_tile_grid_size) &&
    policy.synthesized_tile_grid_size >= 2 && policy.synthesized_tile_grid_size <= 255,
  "publication_policy.synthesized_tile_grid_size must be in [2, 255]");
  assert.equal(runConfig.flow_config?.terrain_synth_grid_size, policy.synthesized_tile_grid_size,
    "flow_config.terrain_synth_grid_size must equal publication_policy.synthesized_tile_grid_size");
  return { policy, digest: sha256(canonicalJson(policy)) };
}

// A cell produces four independently useful artifacts (DTT frames, index
// facts, all-ocean declarations, and the $IRM resume mark).  They must advance
// as one logical unit: the mark is last, and a durable journal makes a crash
// between physical appends resumable without replaying a cell.  The helper is
// deliberately byte-oriented so it can be exercised without a Wasm flow and
// does not retain a cell's records after the bounded staging buffers are made.
function fsyncDirectory(directory) {
  const handle = fs.openSync(directory, "r");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

export function fsyncFile(file) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function framedRecord(bytes) {
  const framed = Buffer.alloc(4 + bytes.length);
  framed.writeUInt32LE(bytes.length, 0);
  Buffer.from(bytes).copy(framed, 4);
  return framed;
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
  assert.ok(resolved.startsWith(`${root}${path.sep}`), `${label} escapes its output directory`);
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
    else if (final === "regular") assert.ok(stat.isFile(), `${label} is not a regular file: ${current}`);
    else assert.ok(stat.isFile(), `${label} is not a regular file: ${current}`);
    return stat;
  }
  return null;
}

function assertHeldFileStillNamed(outDir, file, before, label) {
  assertNoSymlinkTraversal(outDir, file, label, { final: "regular" });
  const named = fs.lstatSync(file, { bigint: true });
  assert.equal(named.dev, before.dev, `${label} pathname changed while reading`);
  assert.equal(named.ino, before.ino, `${label} pathname changed while reading`);
}

function assertHeldFileStable(before, after, label) {
  assert.equal(after.dev, before.dev, `${label} inode changed while reading`);
  assert.equal(after.ino, before.ino, `${label} inode changed while reading`);
  assert.equal(after.size, before.size, `${label} changed while reading`);
  assert.equal(after.mtimeNs, before.mtimeNs, `${label} changed while reading`);
  assert.equal(after.ctimeNs, before.ctimeNs, `${label} changed while reading`);
}

function ensureSafeParent(outDir, file, label) {
  const root = path.resolve(outDir);
  const parent = path.dirname(path.resolve(file));
  assert.ok(parent === root || parent.startsWith(`${root}${path.sep}`), `${label} parent escapes its output directory`);
  const parts = path.relative(root, parent) === "" ? [] : path.relative(root, parent).split(path.sep);
  let current = root;
  const rootStat = fs.lstatSync(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `${label} output directory is not a real directory`);
  for (const part of parts) {
    const next = path.join(current, part);
    const stat = lstatIfExists(next);
    if (!stat) {
      fs.mkdirSync(next, 0o700);
      fsyncDirectory(current);
      fsyncDirectory(next);
    } else {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `${label} parent traverses a non-directory or symbolic link: ${next}`);
    }
    current = next;
  }
}

function readRegularFile(outDir, file, label, expectedLength = undefined) {
  assertNoSymlinkTraversal(outDir, file, label, { final: "regular" });
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${label} is not a regular file: ${file}`);
    const size = Number(before.size);
    assert.ok(Number.isSafeInteger(size), `${label} exceeds JavaScript's safe byte range`);
    if (expectedLength !== undefined) assert.equal(size, expectedLength, `${label} length changed`);
    const bytes = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      const read = fs.readSync(handle, bytes, position, size - position, position);
      assert.ok(read > 0, `${label} ended while reading`);
      position += read;
    }
    assertHeldFileStable(before, fs.fstatSync(handle, { bigint: true }), label);
    assertHeldFileStillNamed(outDir, file, before, label);
    return bytes;
  } finally { fs.closeSync(handle); }
}

function tailDigest(outDir, file, offset, length) {
  assertNoSymlinkTraversal(outDir, file, "attempt artifact", { final: "regular" });
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, length)));
  let position = offset;
  let remaining = length;
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    assert.ok(stat.isFile(), `attempt artifact is not a regular file: ${file}`);
    assert.ok(offset >= 0 && length >= 0 && offset + length <= Number(stat.size), `attempt artifact range is outside ${file}`);
    while (remaining > 0) {
      const read = fs.readSync(handle, chunk, 0, Math.min(chunk.length, remaining), position);
      assert.ok(read > 0, `attempt artifact ended before ${offset + length}: ${file}`);
      hash.update(chunk.subarray(0, read));
      position += read;
      remaining -= read;
    }
    assertHeldFileStable(stat, fs.fstatSync(handle, { bigint: true }), "attempt artifact");
    assertHeldFileStillNamed(outDir, file, stat, "attempt artifact");
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function wholeFileDigest(outDir, file) {
  const stat = assertNoSymlinkTraversal(outDir, file, "attempt artifact");
  if (!stat) return sha256("");
  return tailDigest(outDir, file, 0, stat.size);
}

function chainDigest(beforeDigest, appendDigest, afterLength) {
  return sha256(`${beforeDigest}:${appendDigest}:${afterLength}`);
}

function appendDurably(outDir, file, bytes, label = "attempt artifact") {
  ensureSafeParent(outDir, file, label);
  assertNoSymlinkTraversal(outDir, file, label);
  const handle = fs.openSync(file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${label} is not a regular file: ${file}`);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    const after = fs.fstatSync(handle, { bigint: true });
    assert.equal(after.dev, before.dev, `${label} inode changed while appending`);
    assert.equal(after.ino, before.ino, `${label} inode changed while appending`);
    assert.equal(after.size, before.size + BigInt(bytes.length), `${label} append length changed`);
    assertHeldFileStillNamed(outDir, file, after, label);
  } finally {
    fs.closeSync(handle);
  }
  // A source log may be configured below a child directory of the shard. The
  // `$IRM` mark must never become durable merely because that child entry was
  // still only in the page cache, so every append acknowledges its own parent.
  fsyncDirectory(path.dirname(file));
}

const CELL_ARTIFACT_NAMES = Object.freeze({
  tiles: "tiles.dttstream",
  index: "tiles.index.jsonl",
  ocean: "ocean-skipped.lines",
  "source-observations": "source-observations.ndjson",
  mark: "irm.records",
});

function cellArtifactPaths(outDir, supplied = {}) {
  const root = path.resolve(outDir);
  assert.ok(supplied && typeof supplied === "object" && !Array.isArray(supplied), "cell artifact paths must be an object");
  for (const name of Object.keys(supplied)) assert.ok(Object.hasOwn(CELL_ARTIFACT_NAMES, name), `unknown cell artifact ${name}`);
  const targets = {};
  for (const [name, basename] of Object.entries(CELL_ARTIFACT_NAMES)) {
    const target = path.resolve(supplied[name] ?? path.join(root, basename));
    assert.ok(target.startsWith(`${root}${path.sep}`), `cell artifact ${name} escapes its output directory`);
    targets[name] = target;
  }
  return targets;
}

function validateChainEntry(entry, target) {
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `artifact chain entry is invalid for ${target}`);
  assert.ok(Number.isSafeInteger(entry.length) && entry.length >= 0, `artifact chain length is invalid for ${target}`);
  assert.match(entry.digest ?? "", /^[0-9a-f]{64}$/, `artifact chain digest is invalid for ${target}`);
}

function loadArtifactChains(outDir, artifactPaths, targets, { initializeMissing = true, validateLengths = true } = {}) {
  const file = path.join(outDir, "artifact-chains.json");
  let chains = {};
  const existing = assertNoSymlinkTraversal(outDir, file, "artifact chain journal");
  if (existing) chains = readSmallJson(file, 512 * 1024, "artifact chain journal");
  assert.ok(chains && typeof chains === "object" && !Array.isArray(chains), "artifact chain journal must be an object");
  const allowedTargets = new Set(Object.values(artifactPaths));
  for (const [target, entry] of Object.entries(chains)) {
    assert.ok(allowedTargets.has(target), `artifact chain journal has an unknown target: ${target}`);
    validateChainEntry(entry, target);
  }
  for (const target of targets) {
    const stat = assertNoSymlinkTraversal(outDir, target, "attempt artifact");
    const length = stat ? stat.size : 0;
    if (!chains[target] && initializeMissing) chains[target] = { length, digest: wholeFileDigest(outDir, target) };
    if (chains[target]) {
      validateChainEntry(chains[target], target);
      if (validateLengths) assert.equal(chains[target].length, length, `artifact chain length does not match ${target}`);
    }
  }
  return { file, chains };
}

function cellStageDirectory(outDir, cell, attemptId) {
  assert.ok(Number.isSafeInteger(cell) && cell >= 0, "cell attempt has an invalid cell number");
  assert.match(attemptId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "cell attempt has an invalid stage identifier");
  return path.join(path.resolve(outDir), `.cell-stage-${cell}-${attemptId}`);
}

function validateCellJournal(journal, outDir, artifactPaths, markPath, maxAppendBytes) {
  assert.equal(journal?.version, 2, "unsupported cell attempt journal");
  assert.deepEqual(Object.keys(journal).sort(), ["attemptId", "cell", "chains", "markJson", "operations", "version"],
    "cell attempt journal has unexpected authority-bearing fields");
  const stageDir = cellStageDirectory(outDir, journal.cell, journal.attemptId);
  assert.equal(path.resolve(markPath), path.join(path.resolve(outDir), "resume-mark.json"),
    "cell attempt mark path does not match this run");
  assert.ok(Array.isArray(journal.operations) && journal.operations.length > 0, "cell attempt has no operations");
  assert.equal(journal.operations.at(-1).name, "mark", "cell attempt must commit the $IRM mark last");
  assert.ok(journal.markJson && typeof journal.markJson === "object" && !Array.isArray(journal.markJson),
    "cell attempt has no operator-readable mark");
  const names = journal.operations.map((operation) => operation?.name);
  assert.equal(new Set(names).size, names.length, "cell attempt has duplicate artifact operations");
  for (const operation of journal.operations) {
    assert.deepEqual(Object.keys(operation ?? {}).sort(), [
      "afterDigest", "afterLength", "appendDigest", "appendLength", "beforeDigest", "beforeLength", "name",
    ], `cell attempt ${operation?.name} has unexpected authority-bearing fields`);
    assert.ok(Object.hasOwn(artifactPaths, operation?.name), `cell attempt has an unknown artifact operation: ${operation?.name}`);
    for (const key of ["beforeLength", "appendLength", "afterLength"]) {
      assert.ok(Number.isSafeInteger(operation[key]) && operation[key] >= 0, `cell attempt ${operation.name} has an invalid ${key}`);
    }
    assert.ok(operation.appendLength <= maxAppendBytes,
      `cell attempt ${operation.name} exceeds its ${maxAppendBytes}-byte live staged append bound`);
    assert.equal(operation.afterLength, operation.beforeLength + operation.appendLength,
      `cell attempt ${operation.name} has an invalid append length`);
    for (const key of ["beforeDigest", "appendDigest", "afterDigest"]) {
      assert.match(operation[key] ?? "", /^[0-9a-f]{64}$/, `cell attempt ${operation.name} has an invalid ${key}`);
    }
    assert.equal(operation.afterDigest, chainDigest(operation.beforeDigest, operation.appendDigest, operation.afterLength),
      `cell attempt has an invalid ${operation.name} digest chain`);
  }
  assert.ok(journal.chains && typeof journal.chains === "object" && !Array.isArray(journal.chains),
    "cell attempt has invalid artifact chains");
  const targets = journal.operations.map((operation) => artifactPaths[operation.name]);
  assert.deepEqual(Object.keys(journal.chains).sort(), [...targets].sort(),
    "cell attempt chains must name exactly its derived artifact targets");
  for (const operation of journal.operations) {
    const target = artifactPaths[operation.name];
    validateChainEntry(journal.chains[target], target);
    assert.equal(journal.chains[target].length, operation.afterLength,
      `cell attempt ${operation.name} final chain length is invalid`);
    assert.equal(journal.chains[target].digest, operation.afterDigest,
      `cell attempt ${operation.name} final chain digest is invalid`);
  }
  assertNoSymlinkTraversal(outDir, stageDir, "cell attempt stage directory", { final: "directory" });
  const expectedStages = journal.operations.map((operation) => `${operation.name}.append`).sort();
  assert.deepEqual(fs.readdirSync(stageDir).sort(), expectedStages,
    "cell attempt stage directory has unexpected entries");
  for (const operation of journal.operations) {
    const stage = path.join(stageDir, `${operation.name}.append`);
    const bytes = readRegularFile(outDir, stage, `cell attempt staged ${operation.name}`, operation.appendLength);
    assert.equal(sha256(bytes), operation.appendDigest, `cell attempt stage digest changed for ${operation.name}`);
  }
  return { stageDir, targets };
}

function replayCellOperation(outDir, operation, target, stageDir, { faultPhase = undefined } = {}) {
  assert.equal(operation.afterDigest, chainDigest(operation.beforeDigest, operation.appendDigest, operation.afterLength),
    `cell attempt has an invalid ${operation.name} digest chain`);
  const stat = assertNoSymlinkTraversal(outDir, target, `cell attempt ${operation.name} target`);
  const actual = stat ? stat.size : 0;
  if (actual === operation.afterLength) {
    assert.equal(tailDigest(outDir, target, operation.beforeLength, operation.appendLength), operation.appendDigest,
      `cell attempt has corrupt committed ${operation.name} bytes`);
    return;
  }
  assert.ok(actual >= operation.beforeLength && actual <= operation.afterLength,
    `cell attempt ${operation.name} has an unexpected length and cannot be recovered safely`);
  const bytes = readRegularFile(outDir, path.join(stageDir, `${operation.name}.append`),
    `cell attempt staged ${operation.name}`, operation.appendLength);
  assert.equal(sha256(bytes), operation.appendDigest, `cell attempt stage digest changed for ${operation.name}`);
  const committedLength = actual - operation.beforeLength;
  if (committedLength) {
    assert.ok(tailDigest(outDir, target, operation.beforeLength, committedLength) === sha256(bytes.subarray(0, committedLength)),
      `cell attempt ${operation.name} partial bytes are not a prefix of its staged append`);
  }
  if (faultPhase === `mid-${operation.name}`) {
    const partial = Math.max(1, Math.floor(bytes.length / 2));
    appendDurably(outDir, target, bytes.subarray(0, partial), `cell attempt ${operation.name} target`);
    throw new Error(`fault injection ${faultPhase} for cell attempt`);
  }
  appendDurably(outDir, target, bytes.subarray(committedLength), `cell attempt ${operation.name} target`);
  assert.equal(fs.statSync(target).size, operation.afterLength, `cell attempt did not append ${operation.name} exactly`);
}

function removeCellStage(outDir, stageDir, operations) {
  assertNoSymlinkTraversal(outDir, stageDir, "cell attempt stage directory", { final: "directory" });
  const expected = operations.map((operation) => `${operation.name}.append`).sort();
  assert.deepEqual(fs.readdirSync(stageDir).sort(), expected, "cell attempt stage directory has unexpected entries");
  for (const name of expected) {
    const stage = path.join(stageDir, name);
    assertNoSymlinkTraversal(outDir, stage, "cell attempt staged artifact", { final: "regular" });
    fs.unlinkSync(stage);
  }
  fs.rmdirSync(stageDir);
  fsyncDirectory(outDir);
}

export function recoverCellAttempt({
  outDir,
  markPath = path.join(outDir, "resume-mark.json"),
  artifactPaths = undefined,
  maxAppendBytes = MAX_CELL_ATTEMPT_APPEND_BYTES,
  expectedCell = undefined,
}) {
  outDir = path.resolve(outDir);
  const journalPath = path.join(outDir, "cell-attempt.json");
  const journalStat = assertNoSymlinkTraversal(outDir, journalPath, "cell attempt journal");
  if (!journalStat) return false;
  const journal = readSmallJson(journalPath, 512 * 1024, "cell attempt journal");
  const targets = cellArtifactPaths(outDir, artifactPaths);
  const validated = validateCellJournal(journal, outDir, targets, markPath,
    assertCellAttemptAppendBound(maxAppendBytes));
  if (expectedCell !== undefined) {
    assert.ok(Number.isSafeInteger(expectedCell) && expectedCell >= 0,
      "current live planner cell is invalid");
    assert.equal(journal.cell, expectedCell,
      "cell attempt does not match the current live planner cell");
  }
  const chain = loadArtifactChains(outDir, targets, validated.targets, {
    // A crash may have appended a journaled suffix before the separate chain
    // receipt was replaced.  The persistent chain is therefore the durable
    // prefix if present, not a claim about the target's current length.
    initializeMissing: false,
    validateLengths: false,
  });
  for (const operation of journal.operations) {
    const target = targets[operation.name];
    if (chain.chains[target]) {
      const persisted = chain.chains[target];
      const isPrefix = persisted.length === operation.beforeLength && persisted.digest === operation.beforeDigest;
      const isAdvanced = persisted.length === operation.afterLength && persisted.digest === operation.afterDigest;
      assert.ok(isPrefix || isAdvanced,
        `cell attempt ${operation.name} chain does not match its durable prefix or completed append`);
    }
    replayCellOperation(outDir, operation, target, validated.stageDir);
    chain.chains[target] = journal.chains[target];
  }
  writeJsonAtomic(chain.file, chain.chains);
  writeJsonAtomic(markPath, journal.markJson);
  removeCellStage(outDir, validated.stageDir, journal.operations);
  assertNoSymlinkTraversal(outDir, journalPath, "cell attempt journal", { final: "regular" });
  fs.unlinkSync(journalPath);
  fsyncDirectory(outDir);
  return true;
}

/**
 * Atomically advance one cell's durable artifacts, modulo crash recovery.
 * `operations` are append-only byte payloads and MUST put the `$IRM` `mark`
 * last.  Each payload is staged before the journal is made durable.  Recovery
 * either observes an exact already-appended payload or appends exactly the
 * staged digest, so it cannot duplicate a partially committed cell.
 */
export function commitCellAttempt({
  outDir,
  cell,
  operations,
  markJson,
  markPath = path.join(outDir, "resume-mark.json"),
  artifactPaths = undefined,
  maxAppendBytes = MAX_CELL_ATTEMPT_APPEND_BYTES,
  faultPhase = undefined,
}) {
  outDir = path.resolve(outDir);
  assert.ok(fs.existsSync(outDir), "cell attempt output directory must exist");
  assertNoSymlinkTraversal(path.dirname(outDir), outDir, "cell attempt output directory", { final: "directory" });
  assert.ok(Array.isArray(operations) && operations.length > 0, "cell attempt operations are required");
  assert.equal(operations.at(-1).name, "mark", "cell attempt must put $IRM mark last");
  assert.ok(Buffer.isBuffer(operations.at(-1).bytes) && operations.at(-1).bytes.length > 0,
    "cell attempt has no durable $IRM mark");
  assert.ok(markJson && typeof markJson === "object" && !Array.isArray(markJson), "cell attempt has no operator-readable mark");
  const targetsByName = cellArtifactPaths(outDir, artifactPaths);
  maxAppendBytes = assertCellAttemptAppendBound(maxAppendBytes);
  assert.equal(path.resolve(markPath), path.join(outDir, "resume-mark.json"), "cell attempt mark path does not match this run");
  const attemptId = randomUUID();
  const stageDir = cellStageDirectory(outDir, cell, attemptId);
  fs.mkdirSync(stageDir, 0o700);
  fsyncDirectory(stageDir);
  fsyncDirectory(outDir);
  const nonEmpty = operations.filter((operation) => Buffer.isBuffer(operation.bytes) && operation.bytes.length > 0);
  assert.equal(nonEmpty.length, operations.length, "cell attempt cannot journal empty artifact operations");
  for (const operation of nonEmpty) assert.ok(operation.bytes.length <= maxAppendBytes,
    `cell operation ${operation.name} exceeds its ${maxAppendBytes}-byte live staged append bound`);
  const names = nonEmpty.map((operation) => operation.name);
  assert.equal(new Set(names).size, names.length, "cell attempt artifact operations must be unique");
  for (const operation of nonEmpty) {
    assert.ok(Object.hasOwn(targetsByName, operation.name), `unknown cell artifact ${operation.name}`);
    assert.equal(path.resolve(operation.target ?? ""), targetsByName[operation.name],
      `cell operation ${operation.name} target does not match this run`);
  }
  const targets = names.map((name) => targetsByName[name]);
  assert.equal(new Set(targets).size, targets.length, "cell attempt artifact targets must be unique");
  const chain = loadArtifactChains(outDir, targetsByName, targets);
  const journalOperations = nonEmpty.map((input) => {
    assert.ok(typeof input.name === "string" && input.name.length > 0, "cell operation name is required");
    const bytes = Buffer.from(input.bytes);
    const stage = path.join(stageDir, `${input.name}.append`);
    appendDurably(outDir, stage, bytes, `cell attempt staged ${input.name}`);
    const target = targetsByName[input.name];
    const stat = assertNoSymlinkTraversal(outDir, target, `cell attempt ${input.name} target`);
    const beforeLength = stat ? stat.size : 0;
    const beforeDigest = chain.chains[target].digest;
    const appendDigest = sha256(bytes);
    const afterLength = beforeLength + bytes.length;
    const afterDigest = chainDigest(beforeDigest, appendDigest, afterLength);
    chain.chains[target] = { length: afterLength, digest: afterDigest };
    return {
      name: input.name, beforeLength, beforeDigest,
      appendLength: bytes.length, afterLength, appendDigest, afterDigest,
    };
  });
  const journalPath = path.join(outDir, "cell-attempt.json");
  const journalChains = Object.fromEntries(journalOperations.map((operation) => {
    const target = targetsByName[operation.name];
    return [target, chain.chains[target]];
  }));
  writeJsonAtomic(journalPath, {
    version: 2, cell, attemptId, operations: journalOperations, markJson, chains: journalChains,
  });
  for (const operation of journalOperations) {
    replayCellOperation(outDir, operation, targetsByName[operation.name], stageDir, { faultPhase });
    if (faultPhase === `after-${operation.name}`) {
      throw new Error(`fault injection ${faultPhase} for cell ${cell}`);
    }
  }
  writeJsonAtomic(chain.file, chain.chains);
  if (faultPhase === "after-chain") throw new Error(`fault injection after artifact chain for cell ${cell}`);
  writeJsonAtomic(markPath, markJson);
  removeCellStage(outDir, stageDir, journalOperations);
  assertNoSymlinkTraversal(outDir, journalPath, "cell attempt journal", { final: "regular" });
  fs.unlinkSync(journalPath);
  fsyncDirectory(outDir);
  return journalOperations;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceTemplatePattern(template) {
  const parts = template.split(/(\{(?:NS|LAT2|EW|LON3)\})/);
  const token = {
    "{NS}": "[NS]",
    "{LAT2}": "[0-9]{2}",
    "{EW}": "[EW]",
    "{LON3}": "[0-9]{3}",
  };
  const pattern = parts.map((part) => token[part] ?? escapeRegExp(part)).join("");
  // Refuse an unrecognised placeholder rather than turning it into a broad
  // endpoint allowance. The checked policy uses only the four coordinates.
  assert.equal(/\{[^}]+\}/.test(template.replace(/\{(?:NS|LAT2|EW|LON3)\}/g, "")), false,
    "source URL template has an unsupported placeholder");
  return pattern;
}

export function sourcePolicyAllowsUrl(contract, url) {
  if (!contract.urlPattern.test(url)) return false;
  // The shape regex prevents a mutable/foreign path but cannot tell N99/E999
  // from a real tile. Inspect every coordinate occurrence so the directory
  // and filename must name the same canonical Copernicus southwest tile.
  const relative = url.slice(contract.policy.url_policy.base_url.length);
  const latitudes = relative.match(/[NS]\d{2}/g) ?? [];
  const longitudes = relative.match(/[EW]\d{3}/g) ?? [];
  if (!latitudes.length || !longitudes.length) return false;
  const validLatitude = (token) => {
    const value = Number(token.slice(1));
    return (token[0] === "N" && value >= 0 && value <= 89) ||
      (token[0] === "S" && value >= 1 && value <= 90);
  };
  const validLongitude = (token) => {
    const value = Number(token.slice(1));
    return (token[0] === "E" && value >= 0 && value <= 179) ||
      (token[0] === "W" && value >= 1 && value <= 180);
  };
  return latitudes.every(validLatitude) && longitudes.every(validLongitude) &&
    new Set(latitudes).size === 1 && new Set(longitudes).size === 1;
}

function assertBoundedText(value, maxBytes, label) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.ok(Buffer.byteLength(value, "utf8") <= maxBytes,
    `${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function directoryHasEntry(directory) {
  const handle = fs.opendirSync(directory);
  try {
    return handle.readSync() !== null;
  } finally {
    handle.closeSync();
  }
}

function assertStableFileStat(before, after, label, file) {
  assert.equal(after.dev, before.dev, `${label} inode changed while reading: ${file}`);
  assert.equal(after.ino, before.ino, `${label} inode changed while reading: ${file}`);
  assert.equal(after.size, before.size, `${label} changed while reading: ${file}`);
  // Same-inode, equal-length overwrites are still a TOCTOU. ctime is updated
  // by writes and cannot be restored with utimes(2); retain mtime too.
  assert.equal(after.mtimeNs, before.mtimeNs, `${label} changed while reading: ${file}`);
  assert.equal(after.ctimeNs, before.ctimeNs, `${label} changed while reading: ${file}`);
}

function readSmallJson(file, maxBytes, label, { fsync = false } = {}) {
  // Receipt and journal paths are evidence, never hints.  Read one stable,
  // non-symlink inode: stat(path)+read(path) would permit a same-length swap.
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), `${label} is not a regular file: ${file}`);
    assert.ok(before.size <= BigInt(maxBytes), `${label} exceeds ${maxBytes} byte bound: ${file}`);
    const bytes = fs.readFileSync(handle, "utf8");
    assertStableFileStat(before, fs.fstatSync(handle, { bigint: true }), label, file);
    const parsed = JSON.parse(bytes);
    // The EEXIST cache writer validates and fsyncs this same opened regular
    // inode. Reopening by pathname here would reintroduce a swap window.
    if (fsync) fs.fsyncSync(handle);
    return parsed;
  } finally { fs.closeSync(handle); }
}

/** A fixed-capacity top-K heap for streaming summaries. compareBest(a,b) > 0 means a is preferred. */
export class BoundedTopK {
  constructor(cap, compareBest) {
    assert.ok(Number.isSafeInteger(cap) && cap > 0, "bounded top-K cap must be a positive integer");
    assert.equal(typeof compareBest, "function", "bounded top-K comparator is required");
    this.cap = cap;
    this.compareBest = compareBest;
    this.heap = [];
  }
  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compareBest(this.heap[index], this.heap[parent]) >= 0) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }
  bubbleDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.compareBest(this.heap[left], this.heap[smallest]) < 0) smallest = left;
      if (right < this.heap.length && this.compareBest(this.heap[right], this.heap[smallest]) < 0) smallest = right;
      if (smallest === index) return;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
  add(entry) {
    if (this.heap.length < this.cap) {
      this.heap.push(entry);
      this.bubbleUp(this.heap.length - 1);
    } else if (this.compareBest(entry, this.heap[0]) > 0) {
      this.heap[0] = entry;
      this.bubbleDown(0);
    }
  }
  ordered() { return [...this.heap].sort((a, b) => -this.compareBest(a, b)); }
}

/** Exact bounded integer histogram for values under a declared hard ceiling. */
export class FixedHistogram {
  constructor(maxValue) {
    assert.ok(Number.isSafeInteger(maxValue) && maxValue >= 0, "histogram maxValue must be a non-negative integer");
    this.maxValue = maxValue;
    this.bins = new Uint32Array(maxValue + 1);
    this.count = 0;
    this.max = 0;
  }
  add(value) {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= this.maxValue,
      `histogram value must be in [0, ${this.maxValue}]`);
    assert.ok(this.bins[value] < 0xffffffff, "histogram bucket overflow");
    this.bins[value] += 1;
    this.count += 1;
    this.max = Math.max(this.max, value);
  }
  percentile(fraction) {
    if (!this.count) return 0;
    assert.ok(fraction >= 0 && fraction <= 1, "histogram percentile must be in [0, 1]");
    const target = Math.floor((this.count - 1) * fraction);
    let seen = 0;
    for (let value = 0; value <= this.max; value += 1) {
      seen += this.bins[value];
      if (seen > target) return value;
    }
    throw new Error("histogram count is inconsistent with bins");
  }
}

export function sourcePolicyContract(runConfig) {
  const policy = runConfig?.source_policy;
  if (!policy) return null;
  assert.equal(policy.version, 1, "source_policy.version must be 1");
  assert.ok(typeof policy.dataset_epoch === "string" && policy.dataset_epoch.length > 0,
    "source_policy.dataset_epoch is required");
  assert.equal(runConfig.flow_config?.dataset_epoch, policy.dataset_epoch,
    "flow_config.dataset_epoch must equal source_policy.dataset_epoch");
  assert.ok(typeof policy.provider === "string" && policy.provider.length > 0,
    "source_policy.provider is required");
  assert.ok(typeof policy.url_policy?.base_url === "string" && policy.url_policy.base_url.startsWith("https://"),
    "source_policy.url_policy.base_url must be an https URL");
  assert.ok(typeof policy.url_policy?.dem_template === "string" && policy.url_policy.dem_template.length > 0,
    "source_policy.url_policy.dem_template is required");
  assert.ok(typeof policy.url_policy?.water_template === "string" && policy.url_policy.water_template.length > 0,
    "source_policy.url_policy.water_template is required");
  assert.ok(!/[?#]/.test(policy.url_policy.base_url),
    "source_policy.url_policy.base_url must not carry a query or fragment");
  if (runConfig.flow_config?.source_url !== undefined) {
    assert.equal(runConfig.flow_config.source_url, policy.url_policy.base_url,
      "flow_config.source_url must equal source_policy.url_policy.base_url");
  }
  assert.equal(Object.hasOwn(runConfig.flow_config ?? {}, "retrieved_at"), false,
    "a source_policy run must not prefill flow_config.retrieved_at as an observation");
  assert.ok(Number.isSafeInteger(policy.request?.timeout_ms) && policy.request.timeout_ms > 0,
    "source_policy.request.timeout_ms must be a positive integer");
  if (runConfig.flow_config?.timeout_ms !== undefined) {
    assert.equal(runConfig.flow_config.timeout_ms, policy.request.timeout_ms,
      "flow_config.timeout_ms must equal source_policy.request.timeout_ms");
  }
  assert.ok(Number.isSafeInteger(policy.request?.retries) && policy.request.retries >= 0,
    "source_policy.request.retries must be a non-negative integer");
  assert.ok(Number.isSafeInteger(policy.request?.retry_base_ms) && policy.request.retry_base_ms >= 0,
    "source_policy.request.retry_base_ms must be a non-negative integer");
  assert.ok(Number.isSafeInteger(policy.request?.max_outstanding) && policy.request.max_outstanding >= 1 && policy.request.max_outstanding <= 64,
    "source_policy.request.max_outstanding must be an integer in [1, 64]");
  assert.ok(Number.isSafeInteger(policy.request?.max_response_bytes) && policy.request.max_response_bytes > 0 &&
    policy.request.max_response_bytes <= MAX_GLOBAL_SOURCE_RESPONSE_BYTES,
  `source_policy.request.max_response_bytes must be in [1, ${MAX_GLOBAL_SOURCE_RESPONSE_BYTES}]`);
  assert.equal(policy.no_data?.http_404, "record-no-coverage-never-retry",
    "source_policy.no_data.http_404 must explicitly preserve 404 observations");
  assert.ok(typeof policy.no_data?.non_water === "string" && policy.no_data.non_water.length > 0,
    "source_policy.no_data.non_water is required");
  assert.ok(typeof policy.ocean_policy === "string" && policy.ocean_policy.length > 0,
    "source_policy.ocean_policy is required");
  assert.ok(Number.isSafeInteger(policy.cache?.max_bytes) && policy.cache.max_bytes > 0,
    "source_policy.cache.max_bytes must be a positive safe integer");
  assert.ok(policy.cache.max_bytes <= MAX_GLOBAL_SOURCE_CACHE_BYTES,
    `source_policy.cache.max_bytes may not exceed ${MAX_GLOBAL_SOURCE_CACHE_BYTES} bytes (96 GiB)`);
  assert.equal(runConfig.cache_max_bytes, policy.cache.max_bytes,
    "cache_max_bytes must equal source_policy.cache.max_bytes");
  assert.equal(policy.manifest?.format, "canonical-jsonl-v1",
    "source_policy.manifest.format must be canonical-jsonl-v1");
  assert.equal(policy.manifest?.digest, "sha256",
    "source_policy.manifest.digest must be sha256");
  assert.ok(typeof policy.manifest?.shard_log === "string" && policy.manifest.shard_log.length > 0,
    "source_policy.manifest.shard_log is required");
  assert.ok(typeof policy.manifest?.completion_manifest === "string" && policy.manifest.completion_manifest.length > 0,
    "source_policy.manifest.completion_manifest is required");
  const urlPattern = new RegExp(`^${escapeRegExp(policy.url_policy.base_url)}(?:${
    sourceTemplatePattern(policy.url_policy.dem_template)
  }|${sourceTemplatePattern(policy.url_policy.water_template)})$`);
  return {
    policy,
    digest: sha256(canonicalJson(policy)),
    datasetEpoch: policy.dataset_epoch,
    cacheMaxBytes: policy.cache.max_bytes,
    urlPattern,
  };
}

export function ensureSourceEpoch(cacheDir, contract) {
  if (!contract) return null;
  cacheDir = path.resolve(cacheDir);
  const file = path.join(cacheDir, "source-epoch.json");
  const receipt = {
    version: SOURCE_MANIFEST_VERSION,
    sourcePolicyDigest: contract.digest,
    datasetEpoch: contract.datasetEpoch,
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(file)) {
    const entries = path.join(cacheDir, "entries");
    // A cache from before this protocol has object bytes but no immutable
    // response receipts.  Binding that cache to a new policy would manufacture
    // provenance, so a new epoch may start only in an empty cache directory.
    if (fs.existsSync(entries) && directoryHasEntry(entries)) {
      throw new Error(`refusing to bind legacy cache entries without source receipts: ${cacheDir}`);
    }
  }
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${canonicalJson(receipt)}\n`);
      // This exact opened inode is the epoch receipt we will later trust to
      // authorize cache publication. Do not fsync a reopened pathname.
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let existing;
  try { existing = readSmallJson(file, MAX_SOURCE_EPOCH_BYTES, "source epoch receipt", { fsync: true }); } catch {
    throw new Error(`source epoch receipt is torn or unreadable: ${file}`);
  }
  assert.equal(existing.version, receipt.version, `unsupported source epoch receipt in ${file}`);
  assert.equal(existing.sourcePolicyDigest, receipt.sourcePolicyDigest,
    `refusing to mix source policy epochs in cache ${cacheDir}`);
  assert.equal(existing.datasetEpoch, receipt.datasetEpoch,
    `refusing to mix dataset epochs in cache ${cacheDir}`);
  // A racing EEXIST caller must not return and publish cache bytes while the
  // creator has only made the receipt visible in a directory's page cache.
  // Both the receipt directory and the newly-created cache-directory entry
  // are durable before any caller receives this epoch capability.
  fsyncDirectory(cacheDir);
  fsyncDirectory(path.dirname(cacheDir));
  return { file, ...receipt };
}

function sourceKey(url) { return `sha256:${sha256(url)}`; }
function receiptPath(cacheDir, url) {
  return path.join(cacheDir, "source-observations", `${sha256(url)}.json`);
}

// The shard log is an audit trail of logical requests, so it additionally
// carries requested_at and cache_hit.  The completion manifest instead names
// each immutable response once; leaving request scheduling fields in it would
// make otherwise identical completed cuts depend on worker timing.
function manifestObservation(observation) {
  return {
    source_key: observation.source_key,
    url: observation.url,
    status: observation.status,
    content_length: observation.content_length,
    content_digest: observation.content_digest,
    ...(observation.etag ? { etag: observation.etag } : {}),
    ...(observation.last_modified ? { last_modified: observation.last_modified } : {}),
    observed_at: observation.observed_at,
  };
}

export function sourceObservationIdentity(observation) {
  return canonicalJson({
    source_key: observation.source_key,
    url: observation.url,
    status: observation.status,
    content_length: observation.content_length,
    content_digest: observation.content_digest,
    etag: observation.etag ?? null,
    last_modified: observation.last_modified ?? null,
  });
}

function assertObservation(observation) {
  assert.match(observation?.source_key ?? "", /^sha256:[0-9a-f]{64}$/, "invalid source observation key");
  assertBoundedText(observation?.url, MAX_SOURCE_URL_BYTES, "source observation URL");
  assert.ok(observation.url.length > 0, "source observation URL is required");
  assert.ok(Number.isInteger(observation?.status) && observation.status >= 100 && observation.status <= 599,
    "source observation status must be an HTTP status");
  assert.ok(Number.isSafeInteger(observation?.content_length) && observation.content_length >= 0,
    "source observation content_length is required");
  assert.match(observation?.content_digest ?? "", /^[0-9a-f]{64}$/, "source observation SHA-256 digest is required");
  assertBoundedText(observation?.observed_at, MAX_SOURCE_TIMESTAMP_BYTES, "source observation observed_at");
  assert.ok(observation.observed_at.length > 0, "source observation observed_at is required");
  assertCanonicalRfc3339(observation.observed_at, "source observation observed_at");
  if (observation.etag !== undefined) assertBoundedText(observation.etag, MAX_SOURCE_HEADER_BYTES, "source observation ETag");
  if (observation.last_modified !== undefined) assertBoundedText(observation.last_modified, MAX_SOURCE_HEADER_BYTES, "source observation Last-Modified");
}

function assertCanonicalRfc3339(value, label) {
  assertBoundedText(value, MAX_SOURCE_TIMESTAMP_BYTES, label);
  const epoch = Date.parse(value);
  assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString() === value,
    `${label} must be canonical RFC3339 UTC milliseconds`);
}

function assertContractObservation(observation, contract) {
  if (!contract) return;
  assert.equal(observation.source_key, sourceKey(observation.url), "source observation key must equal SHA-256(url)");
  assert.ok(sourcePolicyAllowsUrl(contract, observation.url),
    `source observation URL is outside the approved naming policy: ${observation.url}`);
}

function assertRequestLogObservation(observation, contract) {
  assertContractObservation(observation, contract);
  assertCanonicalRfc3339(observation.requested_at, "source request requested_at");
  assert.equal(typeof observation.cache_hit, "boolean", "source request cache_hit must be boolean");
}

function readReceipt(cacheDir, url, { fsync = false } = {}) {
  try {
    const observation = readSmallJson(receiptPath(cacheDir, url), MAX_SOURCE_RECEIPT_BYTES, "source observation receipt", { fsync });
    assertObservation(observation);
    assert.equal(observation.source_key, sourceKey(url), "source receipt URL key mismatch");
    assert.equal(observation.url, url, "source receipt URL mismatch");
    return observation;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function persistReceipt(cacheDir, observation) {
  const file = receiptPath(cacheDir, observation.url);
  const receiptDir = path.dirname(file);
  fs.mkdirSync(receiptDir, { recursive: true });
  const bytes = `${canonicalJson(observation)}\n`;
  try {
    const handle = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    // The cache's `current.json` may publish immediately after this callback.
    // Sync the receipt parent too, so a power loss cannot leave the pointer
    // durable while the provenance entry that authorized it is absent.
    fsyncDirectory(receiptDir);
    // `source-observations` can itself be newly created.  Its parent entry
    // must survive the same power loss as a subsequently published pointer.
    fsyncDirectory(cacheDir);
    return observation;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readReceipt(cacheDir, observation.url, { fsync: true });
    assert.ok(existing, `source receipt vanished while recording ${observation.url}`);
    assert.equal(sourceObservationIdentity(existing), sourceObservationIdentity(observation),
      `source changed during this policy epoch: ${observation.url}`);
    // An orphan from a prior process can exist after its writer fsynced the
    // file but died before the directory.  Make this exact, non-symlink inode
    // and its namespace durable before authorizing a cache generation.
    fsyncDirectory(receiptDir);
    fsyncDirectory(cacheDir);
    return existing;
  }
}

export class SourceRequestObserver {
  constructor({ timeoutMs, fetchImpl = fetch, maxOutstanding = 8, allowUrl = undefined } = {}) {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "source request timeout must be a positive integer");
    assert.ok(Number.isSafeInteger(maxOutstanding) && maxOutstanding > 0,
      "source request observer maxOutstanding must be a positive integer");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.maxOutstanding = maxOutstanding;
    this.allowUrl = allowUrl;
    this.byUrl = new Map();
    this.pending = new Set();
  }

  async fetch(url, options = {}) {
    assertBoundedText(url, MAX_SOURCE_URL_BYTES, "source request URL");
    assert.ok(!this.allowUrl || this.allowUrl(url), `source URL is outside the approved immutable naming policy: ${url}`);
    assert.ok(!this.pending.has(url), `concurrent duplicate source request is not permitted: ${url}`);
    assert.ok(this.pending.size < this.maxOutstanding,
      `source request observer exceeds ${this.maxOutstanding} outstanding observations`);
    this.pending.add(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
      const header = (name) => {
        try {
          if (typeof response.headers?.get === "function") return response.headers.get(name) ?? undefined;
          if (response.headers && typeof response.headers === "object") return response.headers[name] ?? response.headers[name.toLowerCase()];
        } catch {}
        return undefined;
      };
      const etag = header("etag");
      const lastModified = header("last-modified");
      this.byUrl.set(url, {
        observation: {
          ...(etag ? { etag: assertBoundedText(String(etag), MAX_SOURCE_HEADER_BYTES, "response ETag") } : {}),
          ...(lastModified ? { last_modified: assertBoundedText(String(lastModified), MAX_SOURCE_HEADER_BYTES, "response Last-Modified") } : {}),
          observed_at: new Date().toISOString(),
        },
        timer,
        controller,
      });
      return response;
    } catch (error) {
      clearTimeout(timer);
      this.byUrl.delete(url);
      this.pending.delete(url);
      throw error;
    }
  }

  peek(url) { return this.byUrl.get(url)?.observation; }

  take(url) {
    const entry = this.byUrl.get(url);
    this.byUrl.delete(url);
    this.pending.delete(url);
    if (entry) clearTimeout(entry.timer);
    return entry?.observation;
  }

  discard(url) {
    const entry = this.byUrl.get(url);
    this.byUrl.delete(url);
    this.pending.delete(url);
    if (entry) clearTimeout(entry.timer);
  }

  abort(url, reason = "source response exceeded its approved object cap") {
    const entry = this.byUrl.get(url);
    entry?.controller.abort(new Error(reason));
  }
}

export function validateCachedSource({ cacheDir, url, status, body }) {
  const existing = readReceipt(cacheDir, url);
  assert.ok(existing, `cached source object has no immutable observation receipt: ${url}`);
  assert.equal(existing.status, status, `cached source status differs from receipt: ${url}`);
  assert.equal(existing.content_length, body.length, `cached source length differs from receipt: ${url}`);
  assert.equal(existing.content_digest, sha256(body), `cached source digest differs from receipt: ${url}`);
  return existing;
}

export function observationForRequest({ cacheDir, url, fetched, networkObservation = undefined }) {
  if (fetched.hit) {
    return validateCachedSource({ cacheDir, url, status: fetched.status, body: fetched.body });
  }
  const observation = {
    source_key: sourceKey(url),
    url,
    status: fetched.status,
    content_length: fetched.body.length,
    content_digest: sha256(fetched.body),
    ...(networkObservation?.etag ? { etag: networkObservation.etag } : {}),
    ...(networkObservation?.last_modified ? { last_modified: networkObservation.last_modified } : {}),
    observed_at: networkObservation?.observed_at ?? new Date().toISOString(),
  };
  assertObservation(observation);
  return persistReceipt(cacheDir, observation);
}

export function sourceObservationLine(observation, { requestedAt, cacheHit }) {
  assertObservation(observation);
  assertCanonicalRfc3339(requestedAt, "source request requested_at");
  return Buffer.from(`${canonicalJson({ ...observation, requested_at: requestedAt, cache_hit: Boolean(cacheHit) })}\n`);
}

export function appendRequestObservation(logFile, observation, metadata) {
  const bytes = sourceObservationLine(observation, metadata);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const handle = fs.openSync(logFile, "a", 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fsyncDirectory(path.dirname(logFile));
}

function codeUnitCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareObservation(a, b) {
  return codeUnitCompare(a.source_key, b.source_key) ||
    codeUnitCompare(sourceObservationIdentity(a), sourceObservationIdentity(b)) ||
    codeUnitCompare(a.observed_at, b.observed_at);
}

async function* boundedLines(file, maxBytes) {
  let pending = Buffer.alloc(0);
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const before = fs.fstatSync(handle, { bigint: true });
  try {
    assert.ok(before.isFile(), `JSONL input is not a regular file: ${file}`);
    // Keep the exact opened inode for the full parse. A source-log producer
    // cannot substitute a same-length file between a preliminary stat and a
    // later stream open.
    const size = Number(before.size);
    assert.ok(Number.isSafeInteger(size), `JSONL input exceeds JavaScript's safe byte range: ${file}`);
    const chunkBuffer = Buffer.alloc(4096);
    for (let position = 0; position < size;) {
      const read = fs.readSync(handle, chunkBuffer, 0, Math.min(chunkBuffer.length, size - position), position);
      assert.ok(read > 0, `JSONL input ended while reading: ${file}`);
      position += read;
      const chunk = chunkBuffer.subarray(0, read);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(start, end);
        assert.ok(pending.length + segment.length <= maxBytes,
          `line exceeds ${maxBytes} bytes: ${file}`);
        if (newline < 0) {
          pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment);
          break;
        }
        const bytes = pending.length ? Buffer.concat([pending, segment]) : segment;
        pending = Buffer.alloc(0);
        if (bytes.length) yield bytes;
        start = newline + 1;
      }
    }
    assert.equal(pending.length, 0, `JSONL file ends without a newline: ${file}`);
    assertStableFileStat(before, fs.fstatSync(handle, { bigint: true }), "JSONL input", file);
  } finally {
    try { fs.closeSync(handle); } catch (error) { if (error.code !== "EBADF") throw error; }
  }
}

async function* jsonl(file, { contract = null, requestLog = false } = {}) {
  for await (const bytes of boundedLines(file, MAX_OBSERVATION_LINE_BYTES)) {
    const row = JSON.parse(bytes.toString("utf8"));
    assertObservation(row);
    if (requestLog) assertRequestLogObservation(row, contract);
    else assertContractObservation(row, contract);
    yield row;
  }
}

export async function validateSourceObservationLog(file, contract, { cacheDir = undefined } = {}) {
  let count = 0;
  for await (const row of jsonl(file, { contract, requestLog: true })) {
    if (cacheDir) {
      const receipt = readReceipt(cacheDir, row.url);
      assert.ok(receipt, `source request log has no immutable response receipt: ${row.url}`);
      assertContractObservation(receipt, contract);
      assert.equal(canonicalJson(manifestObservation(row)), canonicalJson(manifestObservation(receipt)),
        `source request log does not match immutable response receipt: ${row.url}`);
    }
    count += 1;
  }
  assert.ok(count > 0, `completed source shard has an empty observation log: ${file}`);
  return count;
}

function flushRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(compareObservation);
  const file = path.join(dir, `run-${String(ordinal).padStart(8, "0")}.ndjson`);
  fs.writeFileSync(file, `${rows.map(canonicalJson).join("\n")}\n`);
  rows.length = 0;
  return file;
}

async function sortObservationLogs(logFiles, dir, maxRunBytes, contract) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let bytes = 0;
  const runs = [];
  for (const file of logFiles) {
    assert.ok(fs.existsSync(file), `missing completed shard source log: ${file}`);
    for await (const row of jsonl(file, { contract, requestLog: true })) {
      const canonical = canonicalJson(row);
      rows.push(row);
      bytes += Buffer.byteLength(canonical) + 1;
      if (bytes >= maxRunBytes) {
        runs.push(flushRun(rows, dir, runs.length));
        bytes = 0;
      }
    }
  }
  const final = flushRun(rows, dir, runs.length);
  if (final) runs.push(final);
  return runs;
}

async function mergeObservationGroup(inputFiles, output) {
  const iterators = inputFiles.map((file) => jsonl(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  let previous = null;
  let count = 0;
  const emit = (row) => {
    fs.writeSync(handle, `${canonicalJson(row)}\n`);
    count += 1;
  };
  try {
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || compareObservation(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const row = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (!previous || row.source_key !== previous.source_key) {
        if (previous) emit(previous);
        previous = row;
        continue;
      }
      assert.equal(sourceObservationIdentity(previous), sourceObservationIdentity(row),
        `source changed during this policy epoch: ${row.url}`);
      // Input is sorted by observed_at after identity, so retaining the first
      // observation is deterministic even when workers finish in another order.
    }
    if (previous) emit(previous);
  } finally {
    fs.closeSync(handle);
  }
  return count;
}

async function collapseRuns(runs, sortDir, fanIn) {
  let round = 0;
  let active = runs;
  while (active.length > 1) {
    const next = [];
    for (let start = 0; start < active.length; start += fanIn) {
      const file = path.join(sortDir, `merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.ndjson`);
      await mergeObservationGroup(active.slice(start, start + fanIn), file);
      next.push(file);
    }
    for (const file of active) fs.unlinkSync(file);
    active = next;
    round += 1;
  }
  return active[0] ?? null;
}

async function digestFile(file, contract = null) {
  const hash = createHash("sha256");
  let count = 0;
  for await (const bytes of boundedLines(file, MAX_OBSERVATION_LINE_BYTES)) {
    hash.update(bytes);
    hash.update("\n");
    const row = JSON.parse(bytes.toString("utf8"));
    assertObservation(row);
    assertContractObservation(row, contract);
    count += 1;
  }
  return { digest: hash.digest("hex"), count };
}

export async function readSourceManifestEvidence(file, contract) {
  const hash = createHash("sha256");
  let observations = 0;
  let latestObservedAt = "";
  for await (const bytes of boundedLines(file, MAX_OBSERVATION_LINE_BYTES)) {
    hash.update(bytes);
    hash.update("\n");
    const observation = JSON.parse(bytes.toString("utf8"));
    assertObservation(observation);
    assertContractObservation(observation, contract);
    observations += 1;
    if (observation.observed_at > latestObservedAt) latestObservedAt = observation.observed_at;
  }
  assert.ok(observations > 0 && latestObservedAt, `source manifest is empty: ${file}`);
  return { digest: hash.digest("hex"), observations, latestObservedAt };
}

async function writeCanonicalManifest(input, output, contract) {
  const handle = fs.openSync(output, "w", 0o600);
  try {
    for await (const row of jsonl(input, { contract, requestLog: true })) {
      fs.writeSync(handle, `${canonicalJson(manifestObservation(row))}\n`);
    }
  } finally {
    fs.fsyncSync(handle);
    fs.closeSync(handle);
  }
}

/**
 * Merge completed shard logs into a source manifest.  This is called only
 * after verify.mjs has passed.  The final file is installed with link(2), so a
 * resume cannot silently overwrite an earlier completion receipt.
 */
export async function emitCompletionSourceManifest({
  outDir, logFiles, contract, configDigest, outputFile = undefined, reportedPath = undefined,
  // Narrow test hooks prove the external merge remains correct across many
  // chunks without making a unit test manufacture gigabytes of log data.
  sortRunBytes = SOURCE_SORT_RUN_BYTES,
  fanIn = SOURCE_SORT_FAN_IN,
}) {
  assert.ok(contract, "a source contract is required for a completion manifest");
  const final = outputFile
    ? path.resolve(outputFile)
    : path.resolve(outDir, contract.policy.manifest.completion_manifest);
  assert.ok(final.startsWith(`${path.resolve(outDir)}${path.sep}`),
    "source_policy.manifest.completion_manifest must stay inside the global output");
  const sortDir = fs.mkdtempSync(path.join(outDir, ".source-manifest-runs-"));
  const temporary = path.join(outDir, `.source-manifest-${process.pid}.tmp`);
  try {
    assert.ok(Number.isSafeInteger(sortRunBytes) && sortRunBytes > 0, "sortRunBytes must be positive");
    assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
    const runs = await sortObservationLogs(logFiles, sortDir, sortRunBytes, contract);
    assert.ok(runs.length > 0, "a source-backed completion has no source observations");
    const collapsed = await collapseRuns(runs, sortDir, fanIn);
    assert.ok(collapsed, "source observation merge produced no manifest run");
    await writeCanonicalManifest(collapsed, temporary, contract);
    const receipt = await digestFile(temporary, contract);
    assert.ok(receipt.count > 0, "a source-backed completion has an empty source manifest");
    fs.mkdirSync(path.dirname(final), { recursive: true });
    try {
      fs.linkSync(temporary, final);
      fs.chmodSync(final, 0o444);
      fsyncFile(final);
      fsyncDirectory(path.dirname(final));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await digestFile(final, contract);
      assert.deepEqual(existing, receipt,
        `refusing to overwrite immutable source manifest with different bytes: ${final}`);
    }
    return {
      path: reportedPath ?? path.relative(outDir, final),
      digest: receipt.digest,
      observations: receipt.count,
      configDigest,
      sourcePolicyDigest: contract.digest,
      datasetEpoch: contract.datasetEpoch,
      format: contract.policy.manifest.format,
    };
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}

function compareRecordRow(a, b) {
  return codeUnitCompare(a.address, b.address) || codeUnitCompare(a.digest, b.digest);
}

async function* recordRows(file) {
  for await (const bytes of boundedLines(file, MAX_MERGE_RECORD_LINE_BYTES)) {
    const row = JSON.parse(bytes.toString("utf8"));
    assert.match(row?.address ?? "", /^\d+\/\d+\/\d+$/, `invalid terrain address in ${file}`);
    assert.match(row?.digest ?? "", /^[0-9a-f]{64}$/, `invalid terrain digest in ${file}`);
    assert.ok(typeof row?.data === "string", `missing terrain record bytes in ${file}`);
    assert.ok(Number.isSafeInteger(row?.duplicates) && row.duplicates >= 0, `invalid terrain duplicate count in ${file}`);
    yield row;
  }
}

function flushRecordRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(compareRecordRow);
  const file = path.join(dir, `terrain-run-${String(ordinal).padStart(8, "0")}.ndjson`);
  fs.writeFileSync(file, `${rows.map(canonicalJson).join("\n")}\n`);
  rows.length = 0;
  return file;
}

async function writeRecordRuns(inputFiles, dir, addressForRecord, maxRunBytes) {
  const runs = [];
  const rows = [];
  let bytes = 0;
  for (const file of inputFiles) {
    for await (const record of iterateStreamFile(file)) {
      const address = addressForRecord(record);
      assert.match(address, /^\d+\/\d+\/\d+$/, `invalid terrain address from ${file}`);
      const row = { address, digest: sha256(record), data: Buffer.from(record).toString("base64"), duplicates: 0 };
      const size = Buffer.byteLength(row.data) + 256;
      assert.ok(size <= maxRunBytes, `terrain record at ${address} exceeds merge run bound ${maxRunBytes}`);
      rows.push(row);
      bytes += size;
      if (bytes >= maxRunBytes) {
        runs.push(flushRecordRun(rows, dir, runs.length));
        bytes = 0;
      }
    }
  }
  const final = flushRecordRun(rows, dir, runs.length);
  if (final) runs.push(final);
  return runs;
}

async function mergeRecordGroup(inputFiles, output) {
  const iterators = inputFiles.map((file) => recordRows(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  try {
    let previous = null;
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || compareRecordRow(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const row = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (!previous || row.address !== previous.address) {
        if (previous) fs.writeSync(handle, `${canonicalJson(previous)}\n`);
        previous = row;
        continue;
      }
      assert.equal(previous.digest, row.digest, `shards disagree on duplicate address ${row.address}`);
      previous.duplicates += row.duplicates + 1;
    }
    if (previous) fs.writeSync(handle, `${canonicalJson(previous)}\n`);
  } finally {
    try { fs.closeSync(handle); } catch (error) { if (error.code !== "EBADF") throw error; }
  }
}

async function collapseRecordRuns(runs, dir, fanIn) {
  let active = runs;
  let round = 0;
  while (active.length > 1) {
    const next = [];
    for (let start = 0; start < active.length; start += fanIn) {
      const file = path.join(dir, `terrain-merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.ndjson`);
      await mergeRecordGroup(active.slice(start, start + fanIn), file);
      next.push(file);
    }
    for (const file of active) fs.unlinkSync(file);
    active = next;
    round += 1;
  }
  if (!active.length) return null;
  // A single initial run is still only sorted, not de-duplicated. Normalize
  // it through the same merge path so one small shard set cannot bypass the
  // overlap check that multi-run input receives.
  const normalized = path.join(dir, `terrain-normalized-${String(round).padStart(4, "0")}.ndjson`);
  await mergeRecordGroup(active, normalized);
  fs.unlinkSync(active[0]);
  return normalized;
}

/** Stream, sort, de-duplicate and merge framed terrain stores without an O(N) address map. */
export async function mergeBoundedFramedStores({
  inputFiles, outputFile, addressForRecord,
  maxRunBytes = TERRAIN_SORT_RUN_BYTES, fanIn = SOURCE_SORT_FAN_IN,
}) {
  assert.ok(Number.isSafeInteger(maxRunBytes) && maxRunBytes > 0, "maxRunBytes must be positive");
  assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
  const outputDir = path.dirname(outputFile);
  const sortDir = fs.mkdtempSync(path.join(outputDir, ".terrain-merge-runs-"));
  try {
    const runs = await writeRecordRuns(inputFiles, sortDir, addressForRecord, maxRunBytes);
    const collapsed = await collapseRecordRuns(runs, sortDir, fanIn);
    const handle = fs.openSync(outputFile, "w", 0o600);
    const hash = createHash("sha256");
    let records = 0;
    let duplicates = 0;
    try {
      if (collapsed) {
        for await (const row of recordRows(collapsed)) {
          const record = Buffer.from(row.data, "base64");
          assert.equal(sha256(record), row.digest, `terrain merge run has corrupt bytes for ${row.address}`);
          const length = Buffer.alloc(4);
          length.writeUInt32LE(record.length);
          fs.writeSync(handle, length);
          fs.writeSync(handle, record);
          if (records > 0) hash.update("\n");
          hash.update(`${row.address}:${row.digest}`);
          records += 1;
          duplicates += row.duplicates;
        }
      }
    } finally {
      fs.fsyncSync(handle);
      fs.closeSync(handle);
    }
    return { records, duplicates, recordSetDigest: hash.digest("hex") };
  } finally {
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}

function oceanAddressKey(address, file) {
  // Geographic WGS84 has 2^(z+1) columns and 2^z rows.  Fixed-width numeric
  // fields make code-unit comparison a host-independent level,y,x ordering;
  // raw lexical address ordering would put z10 before z8 and corrupt the
  // deterministic availability worklist.
  const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(address);
  assert.ok(match, `invalid canonical ocean-skip address in ${file}`);
  const [, levelText, xText, yText] = match;
  const level = Number(levelText);
  const x = Number(xText);
  const y = Number(yText);
  assert.ok(Number.isSafeInteger(level) && level >= 0 && level <= 30,
    `ocean-skip level is outside [0,30] in ${file}`);
  assert.ok(Number.isSafeInteger(x) && x >= 0 && x < 2 ** (level + 1),
    `ocean-skip x is outside geographic bounds for level ${level} in ${file}`);
  assert.ok(Number.isSafeInteger(y) && y >= 0 && y < 2 ** level,
    `ocean-skip y is outside geographic bounds for level ${level} in ${file}`);
  return `${String(level).padStart(2, "0")}|${String(y).padStart(10, "0")}|${String(x).padStart(10, "0")}`;
}

function assertOceanAddress(address, file) {
  oceanAddressKey(address, file);
  return address;
}

function compareOceanAddress(a, b) {
  return codeUnitCompare(oceanAddressKey(a, "ocean merge"), oceanAddressKey(b, "ocean merge"));
}

async function* legacyOceanAddresses(file) {
  // Parse just the address array instead of JSON.parse()ing a global array.
  // These are simple ASCII x/y/z strings written by prior runners; reject
  // escapes and any changed shape rather than guessing at a broader JSON API.
  let state = "key";
  let inString = false;
  let escaped = false;
  let token = "";
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const before = fs.fstatSync(handle, { bigint: true });
  try {
    assert.ok(before.isFile(), `legacy ocean input is not a regular file: ${file}`);
    const size = Number(before.size);
    assert.ok(Number.isSafeInteger(size), `legacy ocean input exceeds JavaScript's safe byte range: ${file}`);
    const chunkBuffer = Buffer.alloc(4096);
    for (let position = 0; position < size;) {
      const read = fs.readSync(handle, chunkBuffer, 0, Math.min(chunkBuffer.length, size - position), position);
      assert.ok(read > 0, `legacy ocean input ended while reading: ${file}`);
      position += read;
      const chunk = chunkBuffer.subarray(0, read);
      for (const char of chunk.toString("utf8")) {
        if (inString) {
          if (escaped) throw new Error(`escaped legacy ocean address/key is unsupported: ${file}`);
          if (char === "\\") { escaped = true; continue; }
          if (char === "\"") {
            inString = false;
            if (state === "key") state = token === "addresses" ? "colon" : "key";
            else if (state === "array") yield assertOceanAddress(token, file);
            token = "";
          } else {
            assert.ok(token.length < 128, `legacy ocean token is too long: ${file}`);
            token += char;
          }
          continue;
        }
        if (char === "\"") { inString = true; token = ""; continue; }
        if (state === "colon" && char === ":") state = "array-start";
        else if (state === "array-start" && char === "[") state = "array";
        else if (state === "array" && char === "]") state = "done";
      }
    }
    assert.equal(inString, false, `unterminated legacy ocean string: ${file}`);
    assert.equal(state, "done", `legacy ocean file has no complete addresses array: ${file}`);
    assertStableFileStat(before, fs.fstatSync(handle, { bigint: true }), "legacy ocean input", file);
  } finally {
    try { fs.closeSync(handle); } catch (error) { if (error.code !== "EBADF") throw error; }
  }
}

async function* oceanAddresses(file) {
  if (file.endsWith(".lines") || file.endsWith(".ndjson")) {
    for await (const bytes of boundedLines(file, 128)) yield assertOceanAddress(bytes.toString("utf8"), file);
  } else {
    yield* legacyOceanAddresses(file);
  }
}

async function mergeOceanGroup(inputFiles, output, { allowDuplicate = false } = {}) {
  const iterators = inputFiles.map((file) => oceanAddresses(file));
  const current = await Promise.all(iterators.map((iterator) => iterator.next()));
  const handle = fs.openSync(output, "w", 0o600);
  let previous = null;
  let count = 0;
  let duplicates = 0;
  try {
    while (true) {
      let selected = -1;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i].done) continue;
        if (selected < 0 || compareOceanAddress(current[i].value, current[selected].value) < 0) selected = i;
      }
      if (selected < 0) break;
      const address = current[selected].value;
      current[selected] = await iterators[selected].next();
      if (address !== previous) {
        fs.writeSync(handle, `${address}\n`);
        previous = address;
        count += 1;
      } else {
        duplicates += 1;
        if (!allowDuplicate) {
          throw new Error(`ocean-skip inputs overlap at ${address}; refusing to hide duplicate shard coverage`);
        }
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  return { count, duplicates };
}

function flushOceanRun(rows, dir, ordinal) {
  if (!rows.length) return null;
  rows.sort(compareOceanAddress);
  const run = path.join(dir, `ocean-run-${String(ordinal).padStart(8, "0")}.lines`);
  fs.writeFileSync(run, `${rows.join("\n")}\n`);
  rows.length = 0;
  return run;
}

async function collapseOceanRuns(runs, dir, fanIn, { allowDuplicate }) {
  let active = runs;
  let round = 0;
  let duplicates = 0;
  while (active.length > 1) {
    const next = [];
    for (let start = 0; start < active.length; start += fanIn) {
      const file = path.join(dir, `ocean-merge-${String(round).padStart(4, "0")}-${String(next.length).padStart(6, "0")}.lines`);
      const result = await mergeOceanGroup(active.slice(start, start + fanIn), file, { allowDuplicate });
      duplicates += result.duplicates;
      next.push(file);
    }
    for (const file of active) fs.unlinkSync(file);
    active = next;
    round += 1;
  }
  if (!active.length) return { file: null, duplicates };
  // One sorted initial run has not passed through duplicate handling yet.
  const normalized = path.join(dir, `ocean-normalized-${String(round).padStart(4, "0")}.lines`);
  const result = await mergeOceanGroup(active, normalized, { allowDuplicate });
  duplicates += result.duplicates;
  fs.unlinkSync(active[0]);
  return { file: normalized, duplicates };
}

async function oceanRunsForInput(file, dir, ordinalStart, maxRunBytes, fanIn) {
  const localDir = fs.mkdtempSync(path.join(dir, "ocean-input-"));
  const rows = [];
  const runs = [];
  let bytes = 0;
  try {
    for await (const address of oceanAddresses(file)) {
      rows.push(address);
      bytes += Buffer.byteLength(address) + 1;
      if (bytes >= maxRunBytes) {
        runs.push(flushOceanRun(rows, localDir, ordinalStart + runs.length));
        bytes = 0;
      }
    }
    if (rows.length) runs.push(flushOceanRun(rows, localDir, ordinalStart + runs.length));
    const collapsed = await collapseOceanRuns(runs, localDir, fanIn, { allowDuplicate: true });
    if (!collapsed.file) return collapsed;
    const output = path.join(dir, `ocean-shard-${String(ordinalStart).padStart(8, "0")}.lines`);
    fs.renameSync(collapsed.file, output);
    return { ...collapsed, file: output };
  } finally {
    fs.rmSync(localDir, { recursive: true, force: true });
  }
}

/** Produce the stream-friendly global ocean-skip artifact, accepting legacy JSON inputs. */
export async function mergeOceanSkips({ inputFiles, outputFile, maxRunBytes = SOURCE_SORT_RUN_BYTES, fanIn = SOURCE_SORT_FAN_IN }) {
  assert.ok(Number.isSafeInteger(maxRunBytes) && maxRunBytes > 0, "maxRunBytes must be positive");
  assert.ok(Number.isSafeInteger(fanIn) && fanIn > 1, "fanIn must exceed one");
  const sortDir = fs.mkdtempSync(path.join(path.dirname(outputFile), ".ocean-skip-runs-"));
  try {
    const shardRuns = [];
    let ordinal = 0;
    let duplicateLinesWithinShards = 0;
    for (const file of inputFiles) {
      if (!fs.existsSync(file)) continue;
      const local = await oceanRunsForInput(file, sortDir, ordinal, maxRunBytes, fanIn);
      ordinal += 1_000_000;
      duplicateLinesWithinShards += local.duplicates;
      if (local.file) shardRuns.push(local.file);
    }
    const merged = await collapseOceanRuns(shardRuns, sortDir, fanIn, { allowDuplicate: false });
    const final = merged.file;
    if (final) fs.renameSync(final, outputFile);
    else fs.writeFileSync(outputFile, "");
    fsyncFile(outputFile);
    fsyncDirectory(path.dirname(outputFile));
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of fs.createReadStream(outputFile)) hash.update(chunk);
    for await (const unused of oceanAddresses(outputFile)) { void unused; count += 1; }
    return { count, duplicates: 0, duplicateLinesWithinShards, digest: hash.digest("hex"), path: path.basename(outputFile) };
  } finally {
    fs.rmSync(sortDir, { recursive: true, force: true });
  }
}
