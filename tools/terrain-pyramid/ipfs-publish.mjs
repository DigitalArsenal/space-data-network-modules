// tools/terrain-pyramid/ipfs-publish.mjs — the pyramid becomes an IPFS directory.
//
// OWNER 2026-08-27: "terrain files are requested over IPFS." The $DTT pyramid
// is PUBLISHED as one content-addressed directory per tileset epoch —
// layer.json plus every {z}/{x}/{y}.terrain, the water mask inside each tile —
// added and pinned through the node's IPFS API by this off-fleet builder, and
// served at <gateway>/ipfs/<cid>/. Clients point a native CesiumTerrainProvider
// at the gateway path of the CURRENT CID, which they resolve from the node's
// catalogue rather than from a hostname the owner refused to create.
//
// WHAT CHANGES, AND WHAT DOES NOT. The builder still cuts $DTT records and
// verify.mjs still judges them; nothing about the encoder moves. This step
// reads that finished store and MATERIALIZES the bytes a static gateway can
// serve. Three things follow from "static", and each one is a rule here:
//
//   1. NO NEGOTIATION. The stored payload is gzipped and the mount decompresses
//      per Accept-Encoding; a file on IPFS has one representation. So every
//      .terrain file is written DECODED, and gzip on the wire is whatever the
//      gateway does (measured, and stated in IPFS-DELIVERY.md — kubo does not
//      compress, so the tiles go out identity).
//   2. NO SYNTHESIS. The mount answers an available-but-unstored address by
//      synthesizing a flat tile; a gateway answers 404. layer.json's `available`
//      is a promise, and Atlas set the browser 4xx bound at zero — so every
//      such address is materialized here, by asking the MODULE for the same
//      bytes it would have synthesized, never by a second implementation.
//   3. ONE AUTHORITY FOR layer.json. It is rendered by the module's own
//      layer_json method, from the availability index verify.mjs derived from
//      the records — not written out by this script. The only difference from
//      the mount's rendering is the tiles template, which drops the `?v=`
//      query the mount uses for cache-keying (a CID needs no version query),
//      and that template is now a plan field rather than a constant.
//
// It REFUSES to publish a pyramid verify.mjs has not passed. A CID is forever;
// an unverified one is a permanent invitation to serve bad bytes.
//
//   node tools/terrain-pyramid/ipfs-publish.mjs --out out/liguria
//   node tools/terrain-pyramid/ipfs-publish.mjs --out out/liguria --no-add
//   node tools/terrain-pyramid/ipfs-publish.mjs --out out/liguria \
//        --api http://127.0.0.1:5002 --gateway https://sdn.spaceaware.io
//
// The API is the NODE's, reached however the operator reaches it: host-01's
// kubo RPC listens on loopback only, so an off-fleet build publishes through
// an ssh tunnel (`ssh -N -L 5002:127.0.0.1:5002 sdn.spaceaware.io`). A local
// kubo works identically and is what a development run should use.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { buildDttRecord, writeDttRecord } from "./dtt-projection.mjs";
import { MAX_TERRAIN_RECORD_BYTES, readDtt, readDttProvenance } from "./dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE_DIR = path.join(REPO, "data-source", "terrain-source");
const WASM = path.join(SOURCE_DIR, "dist", "isomorphic", "module.wasm");
const MANIFEST = path.join(SOURCE_DIR, "plugin-manifest.json");
const SDK = path.join(SOURCE_DIR, "node_modules", "space-data-module-sdk");

// The tiles template a CID needs: no `?v=` cache-key query, because the CID is
// the cache key and it is already in the path.
const IPFS_TILES_TEMPLATE = "{z}/{x}/{y}.terrain";
// Kubo serves terrain files identity.  These are deliberately delivery, not
// gzip-store, limits: they were set above the measured regional p50 75,140 B
// and p99 327,267 B with a bounded review margin, while still rejecting a
// runaway mask/payload before a permanent CID is created.
const STATIC_TRANSPORT_BOUNDS = Object.freeze({ p50: 96 * 1024, p99: 384 * 1024, hard: 512 * 1024 });
const MAX_MATERIALIZED_FILES = 5_000_000;
const MAX_VERIFIED_STORE_BYTES = 12 * 1024 ** 3;
const MAX_STATIC_DIRECTORY_BYTES = 128 * 1024 ** 3;
const MAX_STATIC_DIRECTORY_LEVEL = 30;
const STAGING_HEADROOM_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_LINE_BYTES = 64 * 1024;
const MAX_RECEIPT_NAME_BYTES = 4 * 1024;
const MAX_RECEIPT_HASH_BYTES = 256;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const MAX_WORKLIST_LINE_BYTES = 1024;
const MAX_UPLOAD_MANIFEST_LINE_BYTES = 512;
const MAX_TILESET_ID_BYTES = 256;
const MAX_OCEAN_DIAGNOSTICS = 8;
const OCEAN_SKIP_MAX_RECEIPT_BYTES = 64 * 1024;
const OCEAN_SKIP_MAX_LINES_BYTES = 512 * 1024 * 1024;
const OCEAN_SKIP_MAX_LINE_BYTES = 256;
const TERRAIN_ADDRESS_FIELD_WIDTH = 12;
const MAX_VERIFY_REPORT_BYTES = 512 * 1024;
const MAX_LAYER_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_GLOBAL_STATE_BYTES = 8 * 1024 * 1024;
const MAX_APPROVED_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_LAYER_JSON_BYTES = STATIC_TRANSPORT_BOUNDS.hard;
const PUBLICATION_INPUTS_FORMAT = "terrain-publication-inputs-v2";
const PUBLICATION_POLICY_FORMAT = "terrain-publication-policy-v1";
const ATTEMPT_JOURNAL_FORMAT = "terrain-ipfs-publication-attempt-v2";
const ATTEMPT_TOKEN_RE = /^\d+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const INITIAL_JOURNAL_CANDIDATE_LIMIT = 8;
const LIVE_PUBLICATION_NAMES = Object.freeze([
  "ipfs",
  "tileset-catalogue.json",
  "tileset-catalogue.dttstream",
  "ipfs-publication.json",
  "serving-config-ipfs.json",
  "pending-ipfs-pin.json",
]);
// A global directory is tens of GiB, not a control-plane request.  Keep the
// deadline finite but derive it from a deliberately conservative reviewed
// floor rather than applying the 30-second RPC timeout to the data stream.
const MIN_BULK_UPLOAD_BYTES_PER_SECOND = 1024 * 1024;
const BULK_UPLOAD_OVERHEAD_MS = 10n * 60n * 1000n;
const MIN_PIN_TRAVERSAL_FILES_PER_SECOND = 100;
const PIN_TRAVERSAL_OVERHEAD_MS = 5n * 60n * 1000n;

function parsePositiveInteger(value, flag) {
  assert.match(value ?? "", /^\d+$/, `${flag} must be a positive integer`);
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `${flag} is outside the safe integer range`);
  return parsed;
}

function parseByteCount(value, flag) {
  assert.match(value ?? "", /^\d+$/, `${flag} must be a non-negative integer`);
  return BigInt(value);
}

function parseArgs(argv) {
  const args = {
    api: process.env.SDN_IPFS_API || "http://127.0.0.1:5002",
    gateway: "https://sdn.spaceaware.io",
    add: true,
    verify: true,
    timeoutMs: 30_000,
    bulkUploadTimeoutMs: null,
    pinTimeoutMs: null,
    reserveFreeBytes: 0n,
    testCrashAt: null,
    testReplaceOutputRootWith: null,
    testHoldAfterJournalMs: null,
    testHoldAfterInitialJournalTempMs: null,
    testHoldAfterRecoveryReadMs: null,
    testForgeSelfOwnedJournal: false,
    testMutateLayerConfigAfterPreflight: false,
    testGzipBomb: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--out") args.out = argv[++i];
    else if (flag === "--api") args.api = argv[++i];
    else if (flag === "--gateway") args.gateway = argv[++i];
    else if (flag === "--no-add") args.add = false;
    // A bare CID says nothing about its recursive pin.  Do not emit a serving
    // config from an unverified assertion: a trusted import path can be added
    // only when it carries an independently verified pin receipt.
    else if (flag === "--cid") throw new Error("--cid is refused: use --add so this invocation verifies the recursive pin");
    else if (flag === "--no-verify") args.verify = false;
    else if (flag === "--timeout-ms") args.timeoutMs = parsePositiveInteger(argv[++i], "--timeout-ms");
    else if (flag === "--bulk-upload-timeout-ms") args.bulkUploadTimeoutMs = parsePositiveInteger(argv[++i], "--bulk-upload-timeout-ms");
    else if (flag === "--pin-timeout-ms") args.pinTimeoutMs = parsePositiveInteger(argv[++i], "--pin-timeout-ms");
    else if (flag === "--reserve-free-bytes") args.reserveFreeBytes = parseByteCount(argv[++i], "--reserve-free-bytes");
    // Test-only abrupt termination hook for the durable artifact transaction.
    else if (flag === "--test-crash-at") args.testCrashAt = argv[++i];
    else if (flag === "--test-replace-output-root-with") args.testReplaceOutputRootWith = path.resolve(argv[++i]);
    else if (flag === "--test-hold-after-journal-ms") args.testHoldAfterJournalMs = parsePositiveInteger(argv[++i], "--test-hold-after-journal-ms");
    else if (flag === "--test-hold-after-initial-journal-temp-ms") args.testHoldAfterInitialJournalTempMs = parsePositiveInteger(argv[++i], "--test-hold-after-initial-journal-temp-ms");
    else if (flag === "--test-hold-after-recovery-read-ms") args.testHoldAfterRecoveryReadMs = parsePositiveInteger(argv[++i], "--test-hold-after-recovery-read-ms");
    else if (flag === "--test-forge-self-owned-journal") args.testForgeSelfOwnedJournal = true;
    // These hooks exercise the same production safety boundaries without
    // requiring a racing external writer or a giant fixture in CI.
    else if (flag === "--test-mutate-layer-config-after-preflight") args.testMutateLayerConfigAfterPreflight = true;
    else if (flag === "--test-gzip-bomb") args.testGzipBomb = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.out) throw new Error("--out <builder output dir> is required");
  assert.ok(!args.add || args.verify, "--no-verify is refused with --add: a serving CID requires gateway proof");
  while (args.gateway.endsWith("/")) args.gateway = args.gateway.slice(0, -1);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
const ipfsDir = path.join(outDir, "ipfs");
const pendingPinPath = path.join(outDir, "pending-ipfs-pin.json");
const transactionPath = path.join(outDir, ".ipfs-publication-transaction.json");
let journalLeaseIdentity = null;

const outStat = fs.lstatSync(outDir, { bigint: true });
assert.ok(outStat.isDirectory() && !outStat.isSymbolicLink(), `builder output is not a real directory: ${outDir}`);
const outputRootIdentity = Object.freeze({ dev: outStat.dev.toString(), ino: outStat.ino.toString() });

// Node has no portable `openat(2)`.  Treat the output root as an immutable
// capability instead: every mutating phase verifies that the pathname still
// resolves to this original non-symlink directory.  This deliberately fails
// closed if a caller swaps the output directory while an attempt is live.
function assertOutputRootStable(label) {
  const current = fs.lstatSync(outDir, { bigint: true });
  assert.ok(current.isDirectory() && !current.isSymbolicLink(), `${label}: builder output is no longer a real directory`);
  assert.equal(current.dev.toString(), outputRootIdentity.dev, `${label}: builder output device changed`);
  assert.equal(current.ino.toString(), outputRootIdentity.ino, `${label}: builder output inode changed`);
  return current;
}

function immutableIdentityFromStat(stat, file, label) {
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular file: ${file}`);
  return {
    dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  };
}

function immutableIdentity(file, label) {
  return immutableIdentityFromStat(fs.lstatSync(file, { bigint: true }), file, label);
}

function sameImmutableIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertWithinRealOutput(file, label) {
  assertOutputRootStable(label);
  assert.ok(file === outDir || file.startsWith(`${outDir}${path.sep}`), `${label} escapes the builder output`);
  const relative = path.relative(outDir, file);
  let current = outDir;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    const stat = lstatIfExists(current, label);
    if (stat === null) break;
    assert.ok(!stat.isSymbolicLink(), `${label} has a symlinked parent: ${current}`);
  }
  return file;
}

function outputFile(relative, label) {
  assert.equal(typeof relative, "string", `${label} path must be a string`);
  assert.ok(relative.length > 0 && !path.isAbsolute(relative), `${label} path must be relative`);
  const resolved = path.resolve(outDir, relative);
  assert.ok(resolved.startsWith(`${outDir}${path.sep}`), `${label} path escapes the builder output`);
  return assertWithinRealOutput(resolved, label);
}

function openRegularRead(file, label) {
  const before = immutableIdentity(file, label);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || !sameImmutableIdentity(before, immutableIdentityFromStat(opened, file, label))) {
    fs.closeSync(descriptor);
    throw new Error(`${label} changed while opening: ${file}`);
  }
  return { descriptor, identity: before };
}

function readBoundedRegularFileWithIdentity(file, maxBytes, label, expectedIdentity = null) {
  const { descriptor, identity } = openRegularRead(file, label);
  if (expectedIdentity) assert.ok(sameImmutableIdentity(identity, expectedIdentity), `${label} changed since publication preflight: ${file}`);
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    assert.ok(sameImmutableIdentity(identity, immutableIdentityFromStat(stat, file, label)), `${label} changed while opening: ${file}`);
    assert.ok(stat.size <= BigInt(maxBytes), `${label} exceeds ${maxBytes} bytes: ${file}`);
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert.ok(read > 0, `${label} ended while being read: ${file}`);
      offset += read;
    }
    const fdAfter = immutableIdentityFromStat(fs.fstatSync(descriptor, { bigint: true }), file, label);
    assert.ok(sameImmutableIdentity(identity, fdAfter), `${label} changed while being read: ${file}`);
    const after = immutableIdentity(file, label);
    assert.ok(sameImmutableIdentity(identity, after), `${label} changed while being read: ${file}`);
    if (expectedIdentity) assert.ok(sameImmutableIdentity(after, expectedIdentity), `${label} changed since publication preflight: ${file}`);
    return { bytes, identity: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedRegularFile(file, maxBytes, label, expectedIdentity = null) {
  return readBoundedRegularFileWithIdentity(file, maxBytes, label, expectedIdentity).bytes;
}

function readBoundedJson(file, maxBytes, label, expectedIdentity = null) {
  try {
    return JSON.parse(readBoundedRegularFile(file, maxBytes, label, expectedIdentity).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is invalid JSON: ${file}`, { cause: error });
    throw error;
  }
}

function readBoundedJsonWithIdentity(file, maxBytes, label, expectedIdentity = null) {
  try {
    const result = readBoundedRegularFileWithIdentity(file, maxBytes, label, expectedIdentity);
    return { value: JSON.parse(result.bytes.toString("utf8")), identity: result.identity };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is invalid JSON: ${file}`, { cause: error });
    throw error;
  }
}

if (args.testForgeSelfOwnedJournal) {
  const attempt = `${process.pid}-00000000-0000-4000-8000-000000000000`;
  const forged = {
    format: ATTEMPT_JOURNAL_FORMAT,
    attempt,
    root: outputRootIdentity,
    phase: "allocated",
    owned: attemptOwnedRelativePaths(attempt),
    stagingIdentity: null,
    controlIdentity: null,
    transients: emptyAttemptTransients(),
    transaction: null,
  };
  fs.writeFileSync(transactionPath, `${JSON.stringify(forged)}\n`, { flag: "wx", mode: 0o600 });
}

// Recover a previously interrupted artifact transaction before trusting any
// report or input in this output directory. Its journal names only siblings
// inside outDir and never touches a pin recovery receipt except transactionally.
recoverPublicationTransaction();

async function* regularFileChunks(file, label, expectedIdentity = null) {
  const { descriptor, identity } = openRegularRead(file, label);
  if (expectedIdentity) assert.ok(sameImmutableIdentity(identity, expectedIdentity), `${label} changed since publication preflight: ${file}`);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      // Copy this bounded window before the next synchronous read overwrites
      // it. The caller therefore sees one held-fd chunk at a time.
      yield Buffer.from(buffer.subarray(0, read));
    }
  } finally {
    const fdAfter = immutableIdentityFromStat(fs.fstatSync(descriptor, { bigint: true }), file, label);
    fs.closeSync(descriptor);
    assert.ok(sameImmutableIdentity(identity, fdAfter), `${label} changed while being streamed: ${file}`);
  }
  const after = immutableIdentity(file, label);
  assert.ok(sameImmutableIdentity(identity, after), `${label} changed while being streamed: ${file}`);
  if (expectedIdentity) assert.ok(sameImmutableIdentity(after, expectedIdentity), `${label} changed since publication preflight: ${file}`);
}

// ── THE RUN HAS TO HAVE PASSED ─────────────────────────────────────────────
const verifyPath = outputFile("verify-report.json", "verify report");
assert.ok(
  fs.existsSync(verifyPath),
  `run verify.mjs first: ${verifyPath} does not exist. A CID is permanent; an ` +
    "unverified pyramid published under one cannot be withdrawn from anyone " +
    "who has it.",
);
assert.ok(
  BigInt(immutableIdentity(verifyPath, "verify report").size) <= BigInt(MAX_VERIFY_REPORT_BYTES),
  `verify report exceeds safety cap ${MAX_VERIFY_REPORT_BYTES} bytes`,
);
const verifyReport = readBoundedJson(verifyPath, MAX_VERIFY_REPORT_BYTES, "verify report");
assert.equal(
  verifyReport.format,
  "terrain-verification-report-v1",
  "verify report is not a terminal terrain verification receipt; re-run verify.mjs",
);
assert.equal(
  verifyReport.publishable,
  true,
  "verify report is not marked publishable; re-run verify.mjs after every terminal verification succeeds",
);
assert.deepEqual(
  verifyReport.problems,
  [],
  `verify.mjs reported ${verifyReport.problems?.length ?? "?"} unmet bounds; fix them before publishing`,
);
assert.ok(verifyReport.publicationInputs, "the verify report lacks its bound publicationInputs receipt; re-run verify.mjs");
assert.ok(verifyReport.publicationPolicy, "the verify report lacks its approved publicationPolicy; re-run verify.mjs");

async function* boundedLines(file, maxLineBytes, label, expectedIdentity = null) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of regularFileChunks(file, label, expectedIdentity)) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const raw = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) continue;
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error(`${label} line exceeds ${maxLineBytes} bytes`);
      yield line;
    }
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error(`${label} line exceeds ${maxLineBytes} bytes`);
  }
  pending += decoder.end();
  if (pending) {
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error(`${label} line exceeds ${maxLineBytes} bytes`);
    yield pending;
  }
}

function assertExactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const expected = [...keys].sort();
  assert.deepEqual(Object.keys(value).sort(), expected, `${label} has unexpected or missing fields`);
}

function assertPublicationInputEntry(entry, pathName, countField = null) {
  const fields = ["path", "bytes", "sha256"];
  if (countField) fields.push(countField);
  assertExactKeys(entry, fields, `publicationInputs.${pathName}`);
  assert.equal(entry.path, pathName === "tiles" ? "tiles.dttstream" :
      pathName === "availableButUnstored" ? "available-but-unstored.ndjson" :
      pathName === "layerConfig" ? "layer-json-config.json" :
        pathName === "oceanReceipt" ? "ocean-skipped.json" :
          pathName === "oceanAddresses" ? "ocean-skipped.lines" :
            pathName === "globalState" ? "global-build-state.json" : "approved-run-config.json",
  `publicationInputs.${pathName}.path is not the approved output name`);
  assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `publicationInputs.${pathName}.bytes must be a non-negative safe integer`);
  assert.match(entry.sha256 ?? "", /^[a-f0-9]{64}$/, `publicationInputs.${pathName}.sha256 must be SHA-256 hex`);
  if (countField) assert.ok(Number.isSafeInteger(entry[countField]) && entry[countField] >= 0, `publicationInputs.${pathName}.${countField} must be a non-negative safe integer`);
  return entry;
}

function assertPublicationInputs(receipt) {
  assertExactKeys(receipt, ["format", "tiles", "availableButUnstored", "layerConfig", "oceanReceipt", "oceanAddresses", "globalState", "approvedConfig", "oceanLegacyUnbound"], "publicationInputs");
  assert.equal(receipt.format, PUBLICATION_INPUTS_FORMAT, "unsupported publicationInputs format");
  assert.equal(receipt.oceanLegacyUnbound, false, "unbound legacy ocean input is refused; re-run the global verifier");
  assert.ok(receipt.oceanReceipt !== null && receipt.oceanAddresses !== null,
    "global publication requires bound compact ocean receipt and address inputs");
  return {
    tiles: assertPublicationInputEntry(receipt.tiles, "tiles", "records"),
    availableButUnstored: assertPublicationInputEntry(receipt.availableButUnstored, "availableButUnstored", "addresses"),
    layerConfig: assertPublicationInputEntry(receipt.layerConfig, "layerConfig"),
    oceanReceipt: assertPublicationInputEntry(receipt.oceanReceipt, "oceanReceipt"),
    oceanAddresses: assertPublicationInputEntry(receipt.oceanAddresses, "oceanAddresses", "addresses"),
    globalState: assertPublicationInputEntry(receipt.globalState, "globalState"),
    approvedConfig: assertPublicationInputEntry(receipt.approvedConfig, "approvedConfig"),
  };
}

function assertPublicationPolicy(policy) {
  assertExactKeys(policy, ["format", "globalConfigDigest", "maxVerifiedStoreBytes", "maxStaticDirectoryBytes", "synthGridSize"], "publicationPolicy");
  assert.equal(policy.format, PUBLICATION_POLICY_FORMAT, "unsupported publicationPolicy format");
  assert.match(policy.globalConfigDigest ?? "", /^[a-f0-9]{64}$/, "publicationPolicy globalConfigDigest must be SHA-256 hex");
  for (const field of ["maxVerifiedStoreBytes", "maxStaticDirectoryBytes"]) {
    assert.ok(Number.isSafeInteger(policy[field]) && policy[field] > 0, `publicationPolicy.${field} must be a positive safe integer`);
  }
  assert.ok(policy.maxVerifiedStoreBytes <= MAX_VERIFIED_STORE_BYTES,
    `publicationPolicy.maxVerifiedStoreBytes may not exceed ${MAX_VERIFIED_STORE_BYTES}`);
  assert.ok(policy.maxStaticDirectoryBytes <= MAX_STATIC_DIRECTORY_BYTES,
    `publicationPolicy.maxStaticDirectoryBytes may not exceed ${MAX_STATIC_DIRECTORY_BYTES}`);
  assert.ok(policy.maxStaticDirectoryBytes >= policy.maxVerifiedStoreBytes,
    "publicationPolicy.maxStaticDirectoryBytes must cover publicationPolicy.maxVerifiedStoreBytes");
  assert.ok(Number.isSafeInteger(policy.synthGridSize) && policy.synthGridSize >= 2 && policy.synthGridSize <= 255,
    "publicationPolicy.synthGridSize must be an integer in [2, 255]");
  return policy;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashPublicationInput(entry, label, countField = null, expectedIdentity = null) {
  const file = outputFile(entry.path, label);
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  let lastByte = null;
  for await (const chunk of regularFileChunks(file, label, expectedIdentity)) {
    bytes += chunk.length;
    assert.ok(bytes <= entry.bytes, `${label} exceeds its verified byte count`);
    hash.update(chunk);
    if (countField) {
      for (const byte of chunk) if (byte === 0x0a) count += 1;
      if (chunk.length) lastByte = chunk[chunk.length - 1];
    }
  }
  assert.equal(bytes, entry.bytes, `${label} byte count disagrees with publicationInputs`);
  assert.equal(hash.digest("hex"), entry.sha256, `${label} digest disagrees with publicationInputs`);
  if (countField) {
    assert.ok(bytes === 0 || lastByte === 0x0a, `${label} must be LF-terminated`);
    assert.equal(count, entry[countField], `${label} count disagrees with publicationInputs`);
  }
  return { file, identity: immutableIdentity(file, label), entry };
}

async function verifyPublicationInputs(receipt) {
  const inputs = assertPublicationInputs(receipt);
  const verified = {
    tiles: await hashPublicationInput(inputs.tiles, "tile store"),
    availableButUnstored: await hashPublicationInput(inputs.availableButUnstored, "available-but-unstored worklist", "addresses"),
    layerConfig: await hashPublicationInput(inputs.layerConfig, "layer JSON config"),
    oceanReceipt: await hashPublicationInput(inputs.oceanReceipt, "ocean skip receipt"),
    oceanAddresses: await hashPublicationInput(inputs.oceanAddresses, "ocean skip addresses", "addresses"),
    globalState: await hashPublicationInput(inputs.globalState, "global build state"),
    approvedConfig: await hashPublicationInput(inputs.approvedConfig, "approved run config"),
  };
  assert.ok(inputs.tiles.bytes <= publicationPolicy.maxVerifiedStoreBytes,
    `verified tile store ${inputs.tiles.bytes} exceeds approved ${publicationPolicy.maxVerifiedStoreBytes} bytes`);
  return verified;
}

const publicationPolicy = assertPublicationPolicy(verifyReport.publicationPolicy);
const publicationInputs = await verifyPublicationInputs(verifyReport.publicationInputs);

function normalizeApprovedPublicationPolicy(policy, globalConfigDigest, label) {
  assertExactKeys(policy, [
    "version",
    "max_verified_store_bytes",
    "max_static_directory_bytes",
    "static_directory_basis",
    "synthesized_tile_grid_size",
  ], label);
  assert.equal(policy.version, 1, `${label}.version must be 1`);
  assert.ok(Number.isSafeInteger(policy.max_verified_store_bytes) && policy.max_verified_store_bytes > 0,
    `${label}.max_verified_store_bytes must be positive`);
  assert.ok(Number.isSafeInteger(policy.max_static_directory_bytes) && policy.max_static_directory_bytes > 0,
    `${label}.max_static_directory_bytes must be positive`);
  assert.ok(typeof policy.static_directory_basis === "string" && policy.static_directory_basis.length > 0,
    `${label}.static_directory_basis must be a non-empty string`);
  assert.ok(Number.isSafeInteger(policy.synthesized_tile_grid_size) && policy.synthesized_tile_grid_size >= 2 && policy.synthesized_tile_grid_size <= 255,
    `${label}.synthesized_tile_grid_size must be in [2, 255]`);
  return {
    format: PUBLICATION_POLICY_FORMAT,
    globalConfigDigest,
    maxVerifiedStoreBytes: policy.max_verified_store_bytes,
    maxStaticDirectoryBytes: policy.max_static_directory_bytes,
    synthGridSize: policy.synthesized_tile_grid_size,
  };
}

function assertAuthoritativeGlobalInputs() {
  const approvedConfig = readBoundedJson(
    publicationInputs.approvedConfig.file,
    MAX_APPROVED_CONFIG_BYTES,
    "approved run config",
    publicationInputs.approvedConfig.identity,
  );
  assert.equal(
    createHash("sha256").update(canonicalJson(approvedConfig)).digest("hex"),
    publicationPolicy.globalConfigDigest,
    "canonical approved run config does not match publicationPolicy.globalConfigDigest",
  );
  const approvedPolicy = approvedConfig?.publication_policy;
  assert.ok(approvedPolicy && typeof approvedPolicy === "object" && !Array.isArray(approvedPolicy),
    "approved run config lacks publication_policy");
  assert.deepEqual(
    normalizeApprovedPublicationPolicy(approvedPolicy, publicationPolicy.globalConfigDigest, "approved run config publication_policy"),
    publicationPolicy,
    "approved run config publication_policy normalized form disagrees with verify publicationPolicy",
  );
  const state = readBoundedJson(
    publicationInputs.globalState.file,
    MAX_GLOBAL_STATE_BYTES,
    "global build state",
    publicationInputs.globalState.identity,
  );
  assert.ok(state && typeof state === "object" && !Array.isArray(state), "global build state must be an object");
  assert.equal(state.version, 1, "global build state version must be 1");
  assert.equal(state.completed, true, "global build state is not terminally completed");
  assert.equal(state.configDigest, publicationPolicy.globalConfigDigest,
    "global build state configDigest disagrees with verify publicationPolicy");
  assert.deepEqual(
    assertPublicationPolicy(state.publicationPolicy),
    publicationPolicy,
    "global build state publicationPolicy must exactly equal verify publicationPolicy",
  );
  const merged = state.merged;
  assert.ok(merged && typeof merged === "object" && !Array.isArray(merged), "global build state lacks merged completion receipt");
  assert.equal(merged.completion, "complete", "global merged receipt is not complete");
  assert.equal(merged.configDigest, publicationPolicy.globalConfigDigest,
    "global merged receipt configDigest disagrees with verify publicationPolicy");
  assert.equal(merged.approvedConfigPath, "approved-run-config.json", "global merged receipt names an unexpected approved config");
  assert.equal(merged.records, publicationInputs.tiles.entry.records,
    "global merged receipt record count disagrees with publicationInputs tiles");
  assert.deepEqual(
    assertPublicationPolicy(merged.publicationPolicy),
    publicationPolicy,
    "global merged receipt publicationPolicy must exactly equal verify publicationPolicy",
  );
  return { state, approvedConfig };
}

const authoritativeGlobalInputs = assertAuthoritativeGlobalInputs();

if (args.testMutateLayerConfigAfterPreflight) {
  const descriptor = fs.openSync(publicationInputs.layerConfig.file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    // A same-size mutation proves the materialization identity/hash checks do
    // not merely trust the preflight pathname or count.
    fs.writeSync(descriptor, Buffer.from(" "), 0, 1, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function* availableButUnstored() {
  yield* boundedLines(
    publicationInputs.availableButUnstored.file,
    MAX_WORKLIST_LINE_BYTES,
    "available-but-unstored worklist",
    publicationInputs.availableButUnstored.identity,
  );
}

function compareTerrainAddress(a, b) {
  const left = terrainAddressOrderKey(a);
  const right = terrainAddressOrderKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function oceanReceiptPath() {
  return publicationInputs.oceanReceipt.file;
}

function assertOceanReceipt(receipt) {
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt), "ocean skip receipt must be an object");
  const allowed = new Set(["generatedAt", "format", "addressesPath", "count", "digest"]);
  for (const key of Object.keys(receipt)) assert.ok(allowed.has(key), `ocean skip receipt has unexpected field ${key}`);
  assert.equal(receipt.format, "terrain-ocean-skips-lines-v1", `unsupported ocean skip receipt format ${receipt.format}`);
  assert.equal(receipt.addressesPath, "ocean-skipped.lines", "ocean skip receipt must name ocean-skipped.lines");
  assert.ok(Number.isSafeInteger(receipt.count) && receipt.count >= 0, "ocean skip receipt count must be a non-negative safe integer");
  assert.ok(receipt.count <= MAX_MATERIALIZED_FILES, `ocean skip receipt count exceeds ${MAX_MATERIALIZED_FILES} files`);
  assert.match(receipt.digest ?? "", /^[a-f0-9]{64}$/, "ocean skip receipt digest must be a SHA-256 hex digest");
  if (receipt.generatedAt !== undefined) {
    assert.equal(typeof receipt.generatedAt, "string", "ocean skip receipt generatedAt must be a string");
    assert.ok(Number.isFinite(Date.parse(receipt.generatedAt)), "ocean skip receipt generatedAt must be an ISO time");
  }
  return receipt;
}

function readOceanReceipt() {
  const receiptPath = oceanReceiptPath();
  assert.ok(sameImmutableIdentity(immutableIdentity(receiptPath, "ocean skip receipt"), publicationInputs.oceanReceipt.identity),
    "ocean skip receipt changed since publication preflight");
  assert.ok(publicationInputs.oceanReceipt.entry.bytes <= OCEAN_SKIP_MAX_RECEIPT_BYTES,
    `ocean skip receipt exceeds ${OCEAN_SKIP_MAX_RECEIPT_BYTES} bytes`);
  let document;
  try {
    document = JSON.parse(readBoundedRegularFile(
      receiptPath,
      OCEAN_SKIP_MAX_RECEIPT_BYTES,
      "ocean skip receipt",
      publicationInputs.oceanReceipt.identity,
    ).toString("utf8"));
  } catch (error) {
    throw new Error(`ocean skip receipt is invalid JSON: ${receiptPath}`, { cause: error });
  }
  return assertOceanReceipt(document);
}

async function* exactOceanReceiptLines(receipt) {
  const linesPath = outputFile(receipt.addressesPath, "ocean skip receipt");
  assert.equal(linesPath, path.join(outDir, "ocean-skipped.lines"), "ocean skip receipt path is not contained in this output");
  assert.equal(linesPath, publicationInputs.oceanAddresses.file, "ocean skip receipt target disagrees with publicationInputs");
  const stat = immutableIdentity(linesPath, "ocean skip receipt target");
  assert.ok(sameImmutableIdentity(stat, publicationInputs.oceanAddresses.identity), "ocean skip receipt target changed since publication preflight");
  const countBound = BigInt(receipt.count) * BigInt(OCEAN_SKIP_MAX_LINE_BYTES + 1);
  const statBound = countBound < BigInt(OCEAN_SKIP_MAX_LINES_BYTES) ? countBound : BigInt(OCEAN_SKIP_MAX_LINES_BYTES);
  assert.ok(BigInt(stat.size) <= statBound, `ocean skip address list exceeds its declared byte bound: ${linesPath}`);

  const hash = createHash("sha256");
  let carried = Buffer.alloc(0);
  let count = 0;
  let previous = null;
  const consume = (line) => {
    assert.ok(line.length > 0, "ocean skip list contains an empty line");
    assert.ok(line.length <= OCEAN_SKIP_MAX_LINE_BYTES, `ocean skip line exceeds ${OCEAN_SKIP_MAX_LINE_BYTES} bytes`);
    for (const byte of line) assert.ok(byte >= 0x20 && byte <= 0x7e, `ocean skip line ${count + 1} is not raw ASCII`);
    const address = line.toString("ascii");
    const key = terrainAddressOrderKey(address);
    assert.ok(previous === null || previous < key, `ocean skip lines are not strictly padded level/y/x sorted at ${address}`);
    previous = key;
    count += 1;
    assert.ok(count <= receipt.count, "ocean skip receipt contains more lines than its count");
    return address;
  };
  for await (const bytes of regularFileChunks(linesPath, "ocean skip receipt target", publicationInputs.oceanAddresses.identity)) {
    hash.update(bytes);
    const input = carried.length ? Buffer.concat([carried, bytes], carried.length + bytes.length) : bytes;
    let start = 0;
    for (let newline = input.indexOf(0x0a, start); newline >= 0; newline = input.indexOf(0x0a, start)) {
      const line = input.subarray(start, newline);
      // The producer writes raw LF-delimited ASCII; accepting CRLF would
      // make this publisher validate a different byte contract.
      assert.ok(!line.includes(0x0d), "ocean skip lines must use LF, not CRLF");
      yield consume(line);
      start = newline + 1;
    }
    carried = Buffer.from(input.subarray(start));
    assert.ok(carried.length <= OCEAN_SKIP_MAX_LINE_BYTES, `ocean skip line exceeds ${OCEAN_SKIP_MAX_LINE_BYTES} bytes`);
  }
  assert.equal(carried.length, 0, "ocean skip list must end with LF");
  assert.equal(count, receipt.count, "ocean skip receipt count disagrees with streamed worklist");
  assert.equal(hash.digest("hex"), receipt.digest, "ocean skip receipt digest disagrees with streamed worklist");
}

async function oceanSkipJoiner() {
  const receipt = readOceanReceipt();
  const declaredByReceipt = receipt.count;
  const source = exactOceanReceiptLines(receipt);

  const iterator = source[Symbol.asyncIterator]();
  let next = await iterator.next();
  let sourceCount = 0;
  let matchedCount = 0;
  let lastOcean = null;
  let lastAvailable = null;

  const advance = async () => {
    if (next.done) return;
    const address = next.value;
    parseTerrainAddress(address);
    if (lastOcean !== null) assert.ok(compareTerrainAddress(lastOcean, address) < 0, "ocean-skipped worklist is not strictly sorted");
    lastOcean = address;
    sourceCount += 1;
  };
  await advance();

  return {
    async matches(address) {
      parseTerrainAddress(address);
      if (lastAvailable !== null) assert.ok(compareTerrainAddress(lastAvailable, address) < 0, "available-but-unstored worklist is not strictly sorted");
      lastAvailable = address;
      if (next.done) return false;
      const order = compareTerrainAddress(next.value, address);
      assert.ok(order >= 0, `ocean-skipped address ${next.value} is absent from available-but-unstored worklist`);
      if (order !== 0) return false;
      matchedCount += 1;
      next = await iterator.next();
      await advance();
      return true;
    },
    finish() {
      assert.ok(next.done, `ocean-skipped address ${next.value} is absent from available-but-unstored worklist`);
      assert.equal(sourceCount, matchedCount, "not every ocean-skipped address joined the publication worklist");
      assert.equal(sourceCount, declaredByReceipt, "ocean skip receipt count disagrees with streamed worklist");
      return sourceCount;
    },
  };
}

const layerConfig = readBoundedJson(
  publicationInputs.layerConfig.file,
  MAX_LAYER_CONFIG_BYTES,
  "layer JSON config",
  publicationInputs.layerConfig.identity,
);
assert.equal(layerConfig.terrain_synth_grid_size, publicationPolicy.synthGridSize,
  "layer JSON config terrain_synth_grid_size disagrees with approved publicationPolicy");
const recordsPath = publicationInputs.tiles.file;
async function* iterateBoundRecords() {
  // The iterator below holds one O_NOFOLLOW descriptor from preflight through
  // framing, hashing, and the post-read fstat. A pathname replacement cannot
  // change which bytes are materialized.
  const hash = createHash("sha256");
  let bytes = 0;
  let records = 0;
  let pending = Buffer.alloc(0);
  try {
    for await (const input of regularFileChunks(recordsPath, "tile store", publicationInputs.tiles.identity)) {
      bytes += input.length;
      assert.ok(bytes <= publicationInputs.tiles.entry.bytes, "tile store exceeds its verified byte count");
      hash.update(input);
      pending = pending.length ? Buffer.concat([pending, input]) : input;
      let offset = 0;
      while (offset + 4 <= pending.length) {
        const length = pending.readUInt32LE(offset);
        if (length === 0) {
          offset += 4;
          continue;
        }
        assert.ok(length <= MAX_TERRAIN_RECORD_BYTES,
          `record length ${length} exceeds ${MAX_TERRAIN_RECORD_BYTES}-byte terrain safety limit`);
        if (offset + 4 + length > pending.length) break;
        records += 1;
        yield pending.subarray(offset + 4, offset + 4 + length);
        offset += 4 + length;
      }
      pending = pending.subarray(offset);
    }
    assert.equal(pending.length, 0, "the tile store ends exactly on a record boundary");
    assert.equal(bytes, publicationInputs.tiles.entry.bytes, "tile store byte count disagrees with publicationInputs");
    assert.equal(hash.digest("hex"), publicationInputs.tiles.entry.sha256, "tile store digest disagrees with publicationInputs");
    assert.equal(records, publicationInputs.tiles.entry.records, "tile record count disagrees with publicationInputs");
  } finally {
    const after = immutableIdentity(recordsPath, "tile store");
    assert.ok(sameImmutableIdentity(after, publicationInputs.tiles.identity), "tile store changed since publication preflight");
  }
}
let firstRecord = null;
let verifiedRecordCount = 0;
for await (const record of iterateBoundRecords()) {
  if (!firstRecord) firstRecord = Buffer.from(record);
  verifiedRecordCount += 1;
}
assert.ok(firstRecord, "the store holds no records");
assert.equal(verifiedRecordCount, publicationInputs.tiles.entry.records, "tile record count disagrees with publicationInputs");

// ── THE MODULE, DRIVEN THE WAY THE FLOW DRIVES IT ──────────────────────────
//
// layer.json and every synthesized tile come out of the SHIPPED module, not
// out of this file. Two renderings of layer.json would be two tilesets, and a
// second synthesizer would be a second opinion about what an ocean tile is.
const { createBrowserModuleHarness } = await import(path.join(SDK, "src/testing/index.js"));
const { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } = await import(
  path.join(SDK, "src/http/index.js")
);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const wasm = fs.readFileSync(WASM);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const first = readDtt(firstRecord);
const provenance = readDttProvenance(firstRecord);
const tilesetId = first.tilesetId;
assert.equal(typeof tilesetId, "string", "first tile has no tileset ID");
assert.ok(Buffer.byteLength(tilesetId) > 0 && Buffer.byteLength(tilesetId) <= MAX_TILESET_ID_BYTES,
  `tileset ID exceeds ${MAX_TILESET_ID_BYTES}-byte upload-manifest bound`);
const maxzoom = layerConfig.terrain_maxzoom;
assert.ok(Number.isSafeInteger(maxzoom) && maxzoom >= 0 && maxzoom <= MAX_STATIC_DIRECTORY_LEVEL,
  `terrain_maxzoom must be an integer in [0, ${MAX_STATIC_DIRECTORY_LEVEL}] for bounded static directory planning`);

// The serving config the SHIPPED mount would run under, plus the two keys this
// lane adds. The harness gets exactly this, so a tile synthesized here is the
// tile the mount would have synthesized.
const servingConfig = {
  terrain_tileset_id: tilesetId,
  terrain_maxzoom: maxzoom,
  terrain_available: layerConfig.terrain_available,
  terrain_ocean_synth_min_level: layerConfig.terrain_ocean_synth_min_level,
  terrain_mount_path: "/api/v1/terrain/",
  terrain_version: layerConfig.terrain_version ?? "1.0.0",
  terrain_attribution: provenance.attribution ?? "",
  terrain_description: layerConfig.terrain_description ?? "",
  terrain_tiles_template: IPFS_TILES_TEMPLATE,
  // The datum, into the layer.json that goes INSIDE the directory. The
  // published directory is layer.json plus .terrain bytes and nothing else —
  // the per-tile $DTT records, which state VERTICAL_DATUM/VERTICAL_DATUM_NAME,
  // are not in it — so without this key the delivery path the owner made
  // primary carried no machine-readable statement of the datum at all, and a
  // consumer renders EGM2008 orthometric heights as WGS84 ellipsoidal ones,
  // systematically low by the local undulation (~48 m here).
  terrain_vertical_datum_name:
    layerConfig.terrain_vertical_datum_name ?? first.verticalDatumName ?? "EGM2008",
};
// Whatever lattice the MOUNT would synthesize a miss on, this uses too. Left
// unset the module defaults it, and the directory would then hold different
// bytes at an address than the same node would serve from its own store — the
// two are meant to be the same tile, and a fallback that disagrees with the
// primary is worse than no fallback.
if (layerConfig.terrain_synth_grid_size !== undefined) {
  servingConfig.terrain_synth_grid_size = layerConfig.terrain_synth_grid_size;
}

const harness = await createBrowserModuleHarness({
  wasmSource: wasm,
  manifest,
  surface: "direct",
  hostcallDispatch: (operation) => {
    if (operation === "plugin.getConfig") return servingConfig;
    throw new Error(`unexpected hostcall operation: ${operation}`);
  },
});

const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};

// A file on IPFS has ONE representation, and it is the identity one — so every
// request into the module asks for identity rather than taking the module's
// default (Accept-Encoding absent means gzip is acceptable, RFC 9110 12.5.3,
// and the module obliges). The gzip branch below is still handled: a
// representation this script did not ask for must never be written to a file
// as if it were the tile.
async function routed(urlPath) {
  const response = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: urlPath,
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
}

// $HTR headers decode as a LIST of {name, value}, not a map.
const headerOf = (http, name) =>
  (http.headers ?? []).find((h) => h.name?.toLowerCase() === name)?.value ?? "";

function inflateGzipBounded(bytes, label) {
  try {
    const output = zlib.gunzipSync(Buffer.from(bytes), { maxOutputLength: STATIC_TRANSPORT_BOUNDS.hard + 1 });
    assert.ok(output.length <= STATIC_TRANSPORT_BOUNDS.hard, `${label} exceeds static transport hard cap`);
    return output;
  } catch (error) {
    throw new Error(`${label} cannot be safely inflated within ${STATIC_TRANSPORT_BOUNDS.hard} bytes`, { cause: error });
  }
}

if (args.testGzipBomb) {
  inflateGzipBounded(
    zlib.gzipSync(Buffer.alloc(STATIC_TRANSPORT_BOUNDS.hard + 1)),
    "test gzip bomb",
  );
}

const identityBody = (http, label) => {
  const body = Buffer.from(http.body);
  if (headerOf(http, "content-encoding").toLowerCase() === "gzip") return inflateGzipBounded(body, label);
  assert.ok(body.length <= STATIC_TRANSPORT_BOUNDS.hard, `${label} exceeds static transport hard cap`);
  return body;
};

// layer.json: route it, then render the plan route produced. Going through
// route() rather than calling layer_json with a hand-built plan is the point —
// the plan is the mount's, so the body is the mount's.
async function renderLayerJson() {
  const r = await routed("/api/v1/terrain/layer.json");
  const plan = r.outputs.find((o) => o.portId === "layer_plan");
  assert.ok(plan, "route did not produce a layer plan");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [frame("plan", plan.payload)],
  });
  assert.equal(rendered.statusCode, 0, `${rendered.errorCode}: ${rendered.errorMessage}`);
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  assert.equal(http.status, 200, "layer.json did not render 200");
  return identityBody(http, "layer.json response");
}

// A tile the tileset promises and the store does not hold: ask the module for
// the body it would have served, through the same route -> respond pair the
// compiled flow wires, with the empty store stream a miss produces.
async function synthesizeTile(level, x, y) {
  const r = await routed(`/api/v1/terrain/${level}/${x}/${y}.terrain`);
  const context = r.outputs.find((o) => o.portId === "context");
  assert.ok(context, `route refused to plan ${level}/${x}/${y}`);
  const responded = await harness.invoke({
    methodId: "respond",
    inputs: [frame("stream", new Uint8Array(4)), frame("context", context.payload)],
  });
  assert.equal(responded.statusCode, 0, `${responded.errorCode}: ${responded.errorMessage}`);
  const http = decodeHttpResponse(new Uint8Array(responded.outputs[0].payload));
  assert.equal(
    http.status,
    200,
    `the mount answers ${level}/${x}/${y} with ${http.status}; a gateway would answer 404`,
  );
  return identityBody(http, `synthesized ${level}/${x}/${y}`);
}

// ── EVERY FILE IS CHECKED FOR THE MASK BEFORE IT IS WRITTEN ────────────────
//
// "Tiles carry the mask unconditionally" is the whole reason the console's
// ocean is reflective, and on a static directory there is no serve-time step
// left to add it. So the extension is asserted present in the bytes as
// written: walk the quantized-mesh header and body to the extension region and
// require extension id 2 with a length of 1 (uniform) or a square raster.
//
// The walk is the spec's, not a search for a byte value: a scan would find a 2
// in the vertex data of most tiles on Earth.
function assertWaterMaskExtension(bytes, name) {
  const buf = Buffer.from(bytes);
  assert.ok(buf.length > 92, `${name}: shorter than a quantized-mesh header`);
  const count = buf.readUInt32LE(88);
  let at = 92 + count * 6; // three zigzag u16 arrays
  const wide = count > 65536;
  const width = wide ? 4 : 2;
  const align = wide ? 4 : 2;
  while (at % align !== 0) at += 1;
  const triangles = buf.readUInt32LE(at);
  at += 4 + triangles * 3 * width;
  for (let edge = 0; edge < 4; edge += 1) {
    const n = buf.readUInt32LE(at);
    at += 4 + n * width;
  }
  assert.ok(at + 5 <= buf.length, `${name}: no extension region`);
  const extensionId = buf.readUInt8(at);
  const extensionLength = buf.readUInt32LE(at + 1);
  assert.equal(extensionId, 2, `${name}: first extension is not the water mask`);
  assert.equal(
    at + 5 + extensionLength,
    buf.length,
    `${name}: the water mask does not run to the end of the tile`,
  );
  if (extensionLength === 1) {
    const v = buf.readUInt8(at + 5);
    assert.ok(v === 0x00 || v === 0xff, `${name}: uniform mask is neither land nor water`);
    return { kind: v === 0xff ? "UNIFORM_WATER" : "UNIFORM_LAND", bytes: 1 };
  }
  const side = Math.round(Math.sqrt(extensionLength));
  assert.equal(side * side, extensionLength, `${name}: raster mask is not square`);
  return { kind: "RASTER", bytes: extensionLength, side };
}

const layerJson = await renderLayerJson();
assert.ok(layerJson.length <= MAX_LAYER_JSON_BYTES, `layer.json exceeds ${MAX_LAYER_JSON_BYTES} bytes`);

function parseTerrainAddress(address) {
  assert.equal(typeof address, "string", "terrain address must be a string");
  assert.match(address, /^\d+\/\d+\/\d+$/, `invalid available-but-unstored address ${JSON.stringify(address)}`);
  const [level, x, y] = address.split("/").map(Number);
  assert.ok(Number.isSafeInteger(level) && level >= 0 && Number.isSafeInteger(x) && x >= 0 && Number.isSafeInteger(y) && y >= 0, `unsafe terrain address ${address}`);
  assert.equal(address, `${level}/${x}/${y}`, `terrain address is not canonical ${address}`);
  return { level, x, y };
}

function terrainAddressOrderKey(address) {
  const { level, x, y } = parseTerrainAddress(address);
  return `${String(level).padStart(TERRAIN_ADDRESS_FIELD_WIDTH, "0")}|${String(y).padStart(TERRAIN_ADDRESS_FIELD_WIDTH, "0")}|${String(x).padStart(TERRAIN_ADDRESS_FIELD_WIDTH, "0")}`;
}

// Count file entries before staging. The approved global publication policy
// names a distinct static-directory ceiling, so this cannot falsely equate a
// compressed $DTT store estimate with identity files at a gateway.
async function precomputeMaterializationPlan() {
  let storedFiles = 0;
  let storedBytes = 0;
  for await (const record of iterateBoundRecords()) {
    const dtt = readDtt(record);
    assert.ok(dtt.payload?.bytes, `${dtt.level}/${dtt.x}/${dtt.y}: record carries no payload bytes`);
    const stored = Buffer.from(dtt.payload.bytes);
    const body =
      (dtt.payload.contentEncoding ?? "").toLowerCase() === "gzip" ? inflateGzipBounded(stored, `static tile ${dtt.level}/${dtt.x}/${dtt.y}`) : stored;
    assert.ok(body.length <= STATIC_TRANSPORT_BOUNDS.hard, `static tile ${body.length} exceeds hard transport cap`);
    storedFiles += 1;
    storedBytes += body.length;
  }
  let synthesizedFiles = 0;
  let previousSynthesizedKey = null;
  for await (const address of availableButUnstored()) {
    const key = terrainAddressOrderKey(address);
    assert.ok(previousSynthesizedKey === null || previousSynthesizedKey < key,
      "available-but-unstored worklist is not strictly padded level/y/x sorted");
    previousSynthesizedKey = key;
    synthesizedFiles += 1;
  }
  const files = 1 + storedFiles + synthesizedFiles;
  assert.ok(files <= MAX_MATERIALIZED_FILES, `materialization plans ${files} files; hard limit is ${MAX_MATERIALIZED_FILES}`);
  // `{z}/{x}/{y}.terrain` has one root, at most one level directory per z,
  // and at most 2^(z+1) x directories at geographic level z. This is tight
  // for the fixed layout, bounded by the tile count, and avoids a per-tile
  // fictional directory reservation or an in-memory directory set.
  const tileFiles = BigInt(storedFiles + synthesizedFiles);
  let possibleXRows = 0n;
  for (let level = 0; level <= maxzoom; level += 1) possibleXRows += 1n << BigInt(level + 1);
  const levelRows = BigInt(Math.min(maxzoom + 1, Number(tileFiles)));
  const xRows = possibleXRows < tileFiles ? possibleXRows : tileFiles;
  const directoryRows = 1n + levelRows + xRows;
  assert.ok(directoryRows <= BigInt(MAX_MATERIALIZED_FILES) + BigInt(maxzoom) + 2n,
    "materialization directory-row bound exceeds the fixed static tree limit");
  return { files, directoryRows, storedFiles, synthesizedFiles, decodedStoredBytes: storedBytes };
}

function reserveStagingSpace(plan) {
  const stats = fs.statfsSync(outDir, { bigint: true });
  const freeBytes = stats.bavail * stats.bsize;
  assert.ok(stats.bsize > 0n, "statfs returned an invalid allocation block size");
  const blockSize = stats.bsize;
  const fileCountBound = BigInt(plan.files);
  const directoryRowBound = plan.directoryRows;
  // `maxStaticDirectoryBytes` is a logical-byte policy.  On a 4 KiB volume a
  // few million small files need one allocation block each in addition to the
  // logical total, while the bounded, on-disk multipart manifest is live at
  // the same time as the directory.
  const approvedLogicalBytes = BigInt(publicationPolicy.maxStaticDirectoryBytes);
  const payloadRoundingBytes = fileCountBound * (blockSize - 1n);
  // One further block per output is reserved for inode/directory metadata.
  // Filesystems vary, so this is a conservative admission reservation, not a
  // claim that logical directoryBytes is allocated byte-for-byte on disk.
  const inodeAndDirectoryBytes = (fileCountBound + directoryRowBound) * blockSize;
  const physicalStaticBytes = approvedLogicalBytes + payloadRoundingBytes + inodeAndDirectoryBytes;
  // The file and post-order directory receipt manifests coexist during add.
  // Their row count is bounded by every file plus its at-most-two directory
  // ancestors; each row has a distinct, tighter fixed manifest cap.
  const manifestRows = fileCountBound + (directoryRowBound - 1n);
  const manifestLogicalBytes = manifestRows * BigInt(MAX_UPLOAD_MANIFEST_LINE_BYTES);
  const manifestPhysicalBytes = manifestLogicalBytes + (blockSize - 1n);
  const journalAndArtifactBytes = BigInt(MAX_CONTROL_RESPONSE_BYTES) * 8n + blockSize * 8n;
  const headroomBytes = BigInt(STAGING_HEADROOM_BYTES) + journalAndArtifactBytes;
  const requiredBytes = physicalStaticBytes + manifestPhysicalBytes + headroomBytes + args.reserveFreeBytes;
  assert.ok(
    freeBytes >= requiredBytes,
    `insufficient free space for staged IPFS directory: need ${requiredBytes} bytes, have ${freeBytes}`,
  );
  return {
    freeBytes,
    requiredBytes,
    approvedLogicalBytes,
    physicalStaticBytes,
    payloadRoundingBytes,
    inodeAndDirectoryBytes,
    directoryRowBound,
    manifestRows,
    manifestPhysicalBytes,
    headroomBytes,
    blockSize,
  };
}

async function rehashPublicationInputsForMaterialization() {
  const checks = [
    ["tiles", "tile store", null],
    ["availableButUnstored", "available-but-unstored worklist", "addresses"],
    ["layerConfig", "layer JSON config", null],
    ["oceanReceipt", "ocean skip receipt", null],
    ["oceanAddresses", "ocean skip addresses", "addresses"],
    ["globalState", "global build state", null],
    ["approvedConfig", "approved run config", null],
  ];
  for (const [key, label, countField] of checks) {
    const verified = await hashPublicationInput(publicationInputs[key].entry, label, countField, publicationInputs[key].identity);
    assert.ok(sameImmutableIdentity(verified.identity, publicationInputs[key].identity),
      `${label} changed between publication preflight and materialization`);
  }
}

// ── MATERIALIZE ────────────────────────────────────────────────────────────
await rehashPublicationInputsForMaterialization();
const materializationPlan = await precomputeMaterializationPlan();
const stagingReservation = reserveStagingSpace(materializationPlan);
const attemptToken = `${process.pid}-${randomUUID()}`;
const stagingDir = path.join(outDir, `.ipfs-staging-${attemptToken}`);
const stagedArtifactPaths = new Map();
const attemptScratchPaths = new Map();

function attemptOwnedRelativePaths(attempt) {
  assert.match(attempt, ATTEMPT_TOKEN_RE, "publication attempt token is invalid");
  return {
    staging: `.ipfs-staging-${attempt}`,
    control: `.ipfs-attempt-${attempt}`,
    scratch: [`.ipfs-upload-manifest-${attempt}.ndjson`, `.ipfs-upload-directories-${attempt}.ndjson`],
    staged: LIVE_PUBLICATION_NAMES.map((name) => `.${name}-staging-${attempt}`),
    backups: LIVE_PUBLICATION_NAMES.map((name) => `.${name}-previous-${attempt}`),
    pendingTemporary: `.pending-ipfs-pin-${attempt}.tmp`,
    journalTemporary: `.ipfs-publication-transaction-${attempt}.tmp`,
  };
}

function attemptPathsFor(attempt) {
  const owned = attemptOwnedRelativePaths(attempt);
  const resolve = (name) => path.join(outDir, name);
  return {
    owned,
    staging: resolve(owned.staging),
    control: resolve(owned.control),
    scratch: owned.scratch.map((name) => path.join(resolve(owned.control), name)),
    staged: new Map(LIVE_PUBLICATION_NAMES.map((name, index) => [name, path.join(resolve(owned.control), owned.staged[index])])),
    backups: new Map(LIVE_PUBLICATION_NAMES.map((name, index) => [name, resolve(owned.backups[index])])),
    pendingTemporary: path.join(resolve(owned.control), owned.pendingTemporary),
    journalTemporary: resolve(owned.journalTemporary),
  };
}

function emptyAttemptTransients() {
  return {
    scratch: [null, null],
    staged: LIVE_PUBLICATION_NAMES.map(() => null),
    pendingTemporary: null,
  };
}

function pathIdentityFromStat(stat, target, label) {
  assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), `${label} is not a regular file or directory: ${target}`);
  if (stat.isDirectory()) return { type: "directory", dev: stat.dev.toString(), ino: stat.ino.toString() };
  return {
    type: "file",
    dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  };
}

function lstatIfExists(target, label) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label}: could not lstat ${target}`, { cause: error });
  }
}

function pathIdentity(target, label) {
  assertOutputRootStable(label);
  return pathIdentityFromStat(fs.lstatSync(target, { bigint: true }), target, label);
}

function samePathIdentity(left, right) {
  if (!left || !right || left.type !== right.type || left.dev !== right.dev || left.ino !== right.ino) return false;
  return left.type === "directory" ||
    (left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
}

function samePathObject(left, right) {
  return left && right && left.type === right.type && left.dev === right.dev && left.ino === right.ino;
}

function assertPathIdentity(target, expected, label) {
  assert.ok(expected && typeof expected === "object", `${label} has no recorded identity`);
  const current = pathIdentity(target, label);
  assert.ok(samePathIdentity(current, expected), `${label} identity changed: ${target}`);
  return current;
}

function assertAttemptDirectory(label) {
  assert.ok(attemptJournal.stagingIdentity, `${label}: staging identity was never persisted`);
  const identity = assertPathIdentity(stagingDir, attemptJournal.stagingIdentity, label);
  assert.equal(identity.type, "directory", `${label}: staging is not a directory`);
  return identity;
}

function createExclusiveRegularFile(target, label) {
  assertOutputRootStable(`${label} before create`);
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const opened = pathIdentityFromStat(fs.fstatSync(descriptor, { bigint: true }), target, label);
    assert.equal(opened.type, "file", `${label} is not a regular file`);
    const named = pathIdentity(target, label);
    assert.ok(samePathIdentity(opened, named), `${label} changed while being created`);
    return { descriptor, identity: opened };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function writeExclusiveRegularFile(target, bytes, label, { durable = true } = {}) {
  const { descriptor, identity } = createExclusiveRegularFile(target, label);
  try {
    let offset = 0;
    const journalMidwritePhase = label === "publication attempt journal temporary"
      ? (journalLeaseIdentity === null ? "journal-temp-midwrite-prelink" : "journal-temp-midwrite-update")
      : null;
    if (journalMidwritePhase !== null && args.testCrashAt === journalMidwritePhase) {
      // Force a physical partial write before the abrupt test exit; normal
      // journal writes retain the usual single bounded loop.
      const partial = Math.max(1, Math.floor(bytes.length / 2));
      const written = fs.writeSync(descriptor, bytes, 0, partial);
      assert.equal(written, partial, `${label} could not write its test partial prefix`);
      maybeCrashTransaction(journalMidwritePhase);
      offset = partial;
    }
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      assert.ok(written > 0, `${label} could not be written`);
      offset += written;
    }
    if (durable) fs.fsyncSync(descriptor);
    assert.ok(samePathObject(pathIdentityFromStat(fs.fstatSync(descriptor, { bigint: true }), target, label), identity),
      `${label} changed while being written`);
  } finally {
    fs.closeSync(descriptor);
  }
  const finalIdentity = pathIdentity(target, label);
  assert.ok(samePathObject(finalIdentity, identity), `${label} changed after write`);
  if (durable) fsyncDirectory(path.dirname(target));
  assertOutputRootStable(`${label} after create`);
  return finalIdentity;
}

function assertSafeAttemptTree(target, label) {
  const identity = pathIdentity(target, label);
  if (identity.type === "file") return;
  for (const entry of fs.readdirSync(target)) {
    const child = path.join(target, entry);
    assert.ok(child.startsWith(`${target}${path.sep}`), `${label} child escapes attempt directory`);
    assertSafeAttemptTree(child, `${label}/${entry}`);
  }
}

function removeExactOwnedPath(target, label, expectedIdentity = null) {
  assertOutputRootStable(`${label} before cleanup`);
  if (lstatIfExists(target, label) === null) return;
  if (expectedIdentity) assertPathIdentity(target, expectedIdentity, label);
  else pathIdentity(target, label);
  assertSafeAttemptTree(target, label);
  removeSafeAttemptTree(target, label);
  assertOutputRootStable(`${label} after cleanup`);
}

function removeSafeAttemptTree(target, label) {
  const stat = fs.lstatSync(target, { bigint: true });
  assert.ok(!stat.isSymbolicLink(), `${label} was replaced by a symlink during cleanup: ${target}`);
  if (stat.isFile()) {
    fs.unlinkSync(target);
    return;
  }
  assert.ok(stat.isDirectory(), `${label} was replaced by a non-file, non-directory during cleanup: ${target}`);
  for (const entry of fs.readdirSync(target)) {
    const child = path.join(target, entry);
    assert.ok(child.startsWith(`${target}${path.sep}`), `${label} cleanup child escapes attempt directory`);
    removeSafeAttemptTree(child, `${label}/${entry}`);
  }
  // All children have durably disappeared from this exact directory before it
  // is removed from its parent.  This matters for control-dir cleanup, where
  // a journal removal must never make an interrupted unlink ambiguous.
  fsyncDirectory(target);
  fs.rmdirSync(target);
  fsyncDirectory(path.dirname(target));
}

function discardStagingDirectory() {
  // The allocation journal predeclares this exact name before mkdir.  A kill
  // between mkdir and the identity update may leave it unrecorded; it is still
  // safe to reclaim only when it remains a real non-symlink attempt directory.
  const stat = lstatIfExists(stagingDir, "attempt staging directory");
  if (stat !== null && attemptJournal.stagingIdentity === null) {
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "unrecorded attempt staging path is ambiguous");
  }
  removeExactOwnedPath(stagingDir, "attempt staging directory", attemptJournal.stagingIdentity);
}

function discardAttemptScratch() {
  discardAttemptControlDirectory();
  attemptScratchPaths.clear();
}

function stageArtifact(livePath, bytes) {
  const liveName = path.basename(livePath);
  assert.ok(LIVE_PUBLICATION_NAMES.includes(liveName), `unknown publication artifact ${liveName}`);
  assert.equal(path.dirname(livePath), outDir, `publication artifact ${liveName} leaves output root`);
  const stagedPath = attemptPaths.staged.get(liveName);
  const identity = writeExclusiveRegularFile(stagedPath, Buffer.from(bytes), `staged ${liveName}`);
  stagedArtifactPaths.set(stagedPath, identity);
  // This is deliberately before the journal record: recovery owns the whole
  // control directory, so an abrupt death cannot strand this newly-created
  // staged file merely because its individual identity was not yet recorded.
  maybeCrashTransaction(`artifact-written-${stagedArtifactPaths.size}`);
  recordAttemptTransient("staged", LIVE_PUBLICATION_NAMES.indexOf(liveName), identity);
  fsyncDirectory(path.dirname(stagedPath));
  maybeCrashTransaction(`artifact-${stagedArtifactPaths.size}`);
  return stagedPath;
}

function discardStagedArtifacts() {
  discardAttemptControlDirectory();
  stagedArtifactPaths.clear();
}

function discardAttemptControlDirectory() {
  const stat = lstatIfExists(attemptPaths.control, "attempt control directory");
  if (stat === null) return;
  if (attemptJournal.controlIdentity === null) {
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "unrecorded attempt control path is ambiguous");
  }
  removeExactOwnedPath(attemptPaths.control, "attempt control directory", attemptJournal.controlIdentity);
}

function assertTransactionPath(value, label, nullable = false) {
  if (nullable && value === null) return null;
  assert.equal(typeof value, "string", `${label} must be a path`);
  assert.equal(path.dirname(value), outDir, `${label} leaves the builder output`);
  assert.ok(LIVE_PUBLICATION_NAMES.includes(path.basename(value)), `${label} is not a known live publication target`);
  return assertWithinRealOutput(value, label);
}

function fsyncTree(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  assert.ok(!stat.isSymbolicLink(), `refusing to commit symlinked staged path ${target}`);
  if (stat.isFile()) {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return;
  }
  assert.ok(stat.isDirectory(), `staged target is neither file nor directory: ${target}`);
  for (const entry of fs.readdirSync(target)) fsyncTree(path.join(target, entry));
  fsyncDirectory(target);
}

function assertJournalIdentity(identity, label, nullable = false) {
  if (nullable && identity === null) return null;
  assert.ok(identity && typeof identity === "object" && !Array.isArray(identity), `${label} must be an identity object`);
  assert.ok(["file", "directory"].includes(identity.type), `${label}.type is invalid`);
  assertExactKeys(identity, identity.type === "file" ? ["ctimeNs", "dev", "ino", "mtimeNs", "size", "type"] : ["dev", "ino", "type"], label);
  assert.match(identity.dev, /^\d+$/, `${label}.dev is invalid`);
  assert.match(identity.ino, /^\d+$/, `${label}.ino is invalid`);
  if (identity.type === "file") {
    for (const field of ["size", "mtimeNs", "ctimeNs"]) assert.match(identity[field], /^\d+$/, `${label}.${field} is invalid`);
  }
  return identity;
}

function assertExactReplacement(replacement, paths, priorLiveIndex) {
  assertExactKeys(replacement, ["backup", "backupIdentity", "hadLive", "installedIdentity", "live", "liveIdentity", "staged", "stagedIdentity"],
    "publication transaction replacement");
  assertTransactionPath(replacement.live, "publication transaction live path");
  const liveName = path.basename(replacement.live);
  const liveIndex = LIVE_PUBLICATION_NAMES.indexOf(liveName);
  assert.ok(liveIndex >= 0 && liveIndex > priorLiveIndex, "publication transaction replacements are not ordered unique live targets");
  assert.equal(replacement.backup, paths.backups.get(liveName), "publication transaction backup is not the attempt-owned path");
  const expectedStaged = liveName === "ipfs" ? paths.staging : paths.staged.get(liveName);
  if (replacement.staged === null) {
    assert.ok(["serving-config-ipfs.json", "pending-ipfs-pin.json"].includes(liveName),
      "only stale serving config or pending pin receipts may be removed without a staged replacement");
    assert.equal(replacement.stagedIdentity, null, "a removed artifact cannot have a staged identity");
  } else {
    assert.equal(replacement.staged, expectedStaged, "publication transaction staged path is not the attempt-owned path");
    assertJournalIdentity(replacement.stagedIdentity, "publication transaction staged identity");
  }
  assertJournalIdentity(replacement.installedIdentity, "publication transaction installed identity", true);
  if (replacement.staged === null) assert.equal(replacement.installedIdentity, null, "a removed artifact cannot have an installed identity");
  assert.equal(typeof replacement.hadLive, "boolean", "publication transaction hadLive must be boolean");
  assertJournalIdentity(replacement.liveIdentity, "publication transaction live identity", !replacement.hadLive);
  assertJournalIdentity(replacement.backupIdentity, "publication transaction backup identity", true);
  if (!replacement.hadLive) assert.equal(replacement.liveIdentity, null, "missing live target cannot have an identity");
  if (!replacement.hadLive) assert.equal(replacement.backupIdentity, null, "missing live target cannot have a backup identity");
  return liveIndex;
}

function assertAttemptJournal(journal) {
  assertExactKeys(journal, ["attempt", "controlIdentity", "format", "owned", "phase", "root", "stagingIdentity", "transaction", "transients"],
    "publication attempt journal");
  assert.equal(journal.format, ATTEMPT_JOURNAL_FORMAT, "unsupported publication attempt journal format");
  assert.match(journal.attempt, ATTEMPT_TOKEN_RE, "publication attempt token is invalid");
  assertExactKeys(journal.root, ["dev", "ino"], "publication attempt root identity");
  assert.match(journal.root.dev, /^\d+$/, "publication attempt root device is invalid");
  assert.match(journal.root.ino, /^\d+$/, "publication attempt root inode is invalid");
  assert.deepEqual(journal.owned, attemptOwnedRelativePaths(journal.attempt), "publication attempt owns unexpected paths");
  assert.ok(["allocated", "staging", "materializing", "uploading", "pinning", "artifacts", "committing"].includes(journal.phase),
    "publication attempt phase is invalid");
  assertJournalIdentity(journal.stagingIdentity, "publication attempt staging identity", true);
  if (journal.stagingIdentity !== null) assert.equal(journal.stagingIdentity.type, "directory", "publication staging identity is not a directory");
  assertJournalIdentity(journal.controlIdentity, "publication attempt control identity", true);
  if (journal.controlIdentity !== null) assert.equal(journal.controlIdentity.type, "directory", "publication control identity is not a directory");
  assertExactKeys(journal.transients, ["pendingTemporary", "scratch", "staged"], "publication attempt transients");
  assert.ok(Array.isArray(journal.transients.scratch) && journal.transients.scratch.length === 2, "publication scratch transient identities are invalid");
  assert.ok(Array.isArray(journal.transients.staged) && journal.transients.staged.length === LIVE_PUBLICATION_NAMES.length,
    "publication staged transient identities are invalid");
  for (const identity of [...journal.transients.scratch, ...journal.transients.staged, journal.transients.pendingTemporary]) {
    assertJournalIdentity(identity, "publication transient identity", true);
    if (identity !== null) assert.equal(identity.type, "file", "publication transient must be a regular file");
  }
  if (journal.transaction === null) return journal;
  const transaction = journal.transaction;
  assertExactKeys(transaction, ["backingUpIndex", "backupProgress", "installProgress", "installingIndex", "replacements"], "publication transaction");
  assert.ok(Array.isArray(transaction.replacements) && transaction.replacements.length > 0 && transaction.replacements.length <= LIVE_PUBLICATION_NAMES.length,
    "publication transaction replacements are invalid");
  assert.equal(path.basename(transaction.replacements[0].live), "ipfs", "publication transaction must replace IPFS first");
  let previous = -1;
  for (const replacement of transaction.replacements) previous = assertExactReplacement(replacement, attemptPathsFor(journal.attempt), previous);
  for (const field of ["backupProgress", "installProgress"]) {
    assert.ok(Number.isSafeInteger(transaction[field]) && transaction[field] >= 0 && transaction[field] <= transaction.replacements.length,
      `publication transaction ${field} is invalid`);
  }
  assert.ok(
    transaction.backingUpIndex === null ||
      (Number.isSafeInteger(transaction.backingUpIndex) && transaction.backingUpIndex >= transaction.backupProgress && transaction.backingUpIndex < transaction.replacements.length),
    "publication transaction backingUpIndex is invalid",
  );
  assert.ok(
    transaction.installingIndex === null ||
      (Number.isSafeInteger(transaction.installingIndex) && transaction.installingIndex >= transaction.installProgress && transaction.installingIndex < transaction.replacements.length),
    "publication transaction installingIndex is invalid",
  );
  return journal;
}

function writeAttemptJournal(journal) {
  assertAttemptJournal(journal);
  assertOutputRootStable("publication attempt journal before write");
  const paths = attemptPathsFor(journal.attempt);
  assert.equal(lstatIfExists(paths.journalTemporary, "publication attempt journal temporary"), null,
    "publication attempt journal temporary already exists");
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  assert.ok(bytes.length <= MAX_CONTROL_RESPONSE_BYTES, "publication attempt journal exceeds safety cap");
  const identity = writeExclusiveRegularFile(paths.journalTemporary, bytes, "publication attempt journal temporary");
  assertPathIdentity(paths.journalTemporary, identity, "publication attempt journal temporary");
  assertOutputRootStable("publication attempt journal before replace");
  if (journalLeaseIdentity === null) {
    // Before link(2), no fixed lease exists.  Recovery may discard this exact
    // bounded candidate (including a torn write) only when its PID is dead
    // and there is no token-owned payload; see recoverInitialJournalCandidates().
    maybeCrashTransaction("journal-temp-written-prelink");
    if (args.testHoldAfterInitialJournalTempMs !== null) {
      process.stderr.write("test initial journal temporary written\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, args.testHoldAfterInitialJournalTempMs);
    }
    // link(2) gives the fixed journal pathname an O_EXCL-like reservation
    // without ever replacing another publisher's lease.  The fsynced private
    // temporary remains bounded and is removed after the directory entry is
    // durable.
    try {
      fs.linkSync(paths.journalTemporary, transactionPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        removeExactOwnedPath(paths.journalTemporary, "losing publication attempt journal temporary", identity);
        throw new Error("another publication attempt acquired the journal lease");
      }
      throw error;
    }
    fsyncDirectory(outDir);
    // Test-only crash point for the single legitimate two-link state.  It is
    // intentionally before unlink so recovery has to refresh ctime after
    // dropping the temporary hard link.
    maybeCrashTransaction("journal-linked");
  } else {
    // The fixed journal's exact attempt token authenticates this one bounded
    // temporary.  Recovery verifies its complete journal before unlinking it.
    maybeCrashTransaction("journal-temp-written-before-update-rename");
    assertPathIdentity(transactionPath, journalLeaseIdentity, "publication attempt journal lease before update");
    const existing = readBoundedJsonWithIdentity(transactionPath, MAX_CONTROL_RESPONSE_BYTES, "publication attempt journal lease");
    assert.ok(sameImmutableIdentity(existing.identity, journalLeaseIdentity), "publication attempt journal lease changed while being read");
    assert.equal(existing.value?.attempt, journal.attempt, "publication attempt journal lease belongs to another attempt");
    fs.renameSync(paths.journalTemporary, transactionPath);
  }
  assertOutputRootStable("publication attempt journal after replace");
  if (lstatIfExists(paths.journalTemporary, "publication attempt journal temporary") !== null) {
    assertRenameCompatibleIdentity(paths.journalTemporary, identity, "publication attempt journal temporary");
    assertOutputRootStable("publication attempt journal temporary before unlink");
    fs.unlinkSync(paths.journalTemporary);
    assertOutputRootStable("publication attempt journal temporary after unlink");
  }
  fsyncDirectory(outDir);
  journalLeaseIdentity = pathIdentity(transactionPath, "publication attempt journal lease after write");
}

function attemptOwnerIsLive(attempt) {
  const ownerPid = Number(attempt.slice(0, attempt.indexOf("-")));
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return true;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    // EPERM still demonstrates that a process owns this PID.  Treat any
    // unexpected probe failure as live too: concurrent recovery must fail
    // closed rather than reclaim a possibly active writer.
    return error?.code !== "ESRCH";
  }
}

function readAttemptJournal(ownedAttempt = null) {
  if (lstatIfExists(transactionPath, "publication attempt journal") === null) return null;
  assertOutputRootStable("publication attempt journal read");
  const read = readBoundedJsonWithIdentity(transactionPath, MAX_CONTROL_RESPONSE_BYTES, "publication attempt journal");
  const journal = read.value;
  assertAttemptJournal(journal);
  assert.deepEqual(journal.root, outputRootIdentity, "publication attempt journal belongs to a replaced output root");
  // Startup never grants special meaning to its own PID: a stale journal can
  // carry a recycled PID equal to this publisher.  Only a caller with the
  // exact in-memory attempt token may recover its own in-process rollback.
  const isExplicitlyOwned = ownedAttempt !== null && ownedAttempt === journal.attempt;
  assert.ok(isExplicitlyOwned || !attemptOwnerIsLive(journal.attempt),
    `publication attempt ${journal.attempt} is still owned by a live process`);
  journalLeaseIdentity = { type: "file", dev: read.identity.dev, ino: read.identity.ino, size: read.identity.size, mtimeNs: read.identity.mtimeNs, ctimeNs: read.identity.ctimeNs };
  if (args.testHoldAfterRecoveryReadMs !== null) {
    process.stderr.write("test recovery journal read\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, args.testHoldAfterRecoveryReadMs);
  }
  return journal;
}

function isAttemptOrphanName(name) {
  return /^\.ipfs-staging-\d+-[0-9a-f-]+$/.test(name) ||
    /^\.ipfs-attempt-\d+-[0-9a-f-]+$/.test(name) ||
    /^\.ipfs-upload-(?:manifest|directories)-\d+-[0-9a-f-]+\.ndjson$/.test(name) ||
    /^\.(?:ipfs|tileset-catalogue\.json|tileset-catalogue\.dttstream|ipfs-publication\.json|serving-config-ipfs\.json|pending-ipfs-pin\.json)-(?:staging|previous)-\d+-[0-9a-f-]+$/.test(name) ||
    /^\.pending-ipfs-pin-\d+-[0-9a-f-]+\.tmp$/.test(name) ||
    /^\.ipfs-publication-transaction-\d+-[0-9a-f-]+\.tmp$/.test(name);
}

function refuseAmbiguousAttemptOrphans() {
  assertOutputRootStable("publication attempt orphan scan");
  const orphans = fs.readdirSync(outDir).filter(isAttemptOrphanName);
  assert.equal(orphans.length, 0, `refusing ambiguous publication attempt orphans without a journal: ${orphans.join(", ")}`);
}

function removeAttemptJournal() {
  assert.ok(journalLeaseIdentity, "publication attempt journal lease was never acquired");
  assertPathIdentity(transactionPath, journalLeaseIdentity, "publication attempt journal lease before removal");
  assertOutputRootStable("publication attempt journal before removal");
  fs.unlinkSync(transactionPath);
  assertOutputRootStable("publication attempt journal after removal");
  fsyncDirectory(outDir);
  journalLeaseIdentity = null;
}

function removeJournalTemporary(journal, paths) {
  if (lstatIfExists(paths.journalTemporary, "publication attempt journal temporary") === null) return;
  const temporary = pathIdentity(paths.journalTemporary, "publication attempt journal temporary");
  if (samePathObject(temporary, journalLeaseIdentity)) {
    // The only legitimate same-inode case is a SIGKILL after link(temp,
    // fixedJournal) and before unlink(temp).  Dropping that extra link changes
    // ctime, so re-read and bind the fixed lease before any removal.
    assertRenameCompatibleIdentity(paths.journalTemporary, journalLeaseIdentity, "linked publication journal temporary");
    fs.unlinkSync(paths.journalTemporary);
    fsyncDirectory(outDir);
    const reread = readBoundedJsonWithIdentity(transactionPath, MAX_CONTROL_RESPONSE_BYTES, "publication attempt journal after linked-temp cleanup");
    assert.equal(reread.value?.attempt, journal.attempt, "linked publication journal temporary replaced the lease");
    journalLeaseIdentity = { type: "file", dev: reread.identity.dev, ino: reread.identity.ino, size: reread.identity.size, mtimeNs: reread.identity.mtimeNs, ctimeNs: reread.identity.ctimeNs };
    return;
  }
  // The fixed, already-validated journal authenticates exactly this attempt
  // temporary pathname.  It can have been SIGKILLed mid-write, so do not
  // require parseable bytes; bind the stable regular-file identity and remove
  // only this one bounded token path.
  assert.equal(temporary.type, "file", "publication attempt journal update temporary is not a regular file");
  assert.ok(BigInt(temporary.size) <= BigInt(MAX_CONTROL_RESPONSE_BYTES), "publication attempt journal update temporary exceeds safety cap");
  removeExactOwnedPath(paths.journalTemporary, "publication attempt journal update temporary", {
    type: "file",
    dev: temporary.dev,
    ino: temporary.ino,
    size: temporary.size,
    mtimeNs: temporary.mtimeNs,
    ctimeNs: temporary.ctimeNs,
  });
}

function recoverInitialJournalCandidates() {
  assertOutputRootStable("initial publication journal candidate scan");
  const candidates = fs.readdirSync(outDir).filter((name) => /^\.ipfs-publication-transaction-\d+-[0-9a-f-]+\.tmp$/.test(name));
  assert.ok(candidates.length <= INITIAL_JOURNAL_CANDIDATE_LIMIT,
    `refusing too many unlinked publication journal candidates: ${candidates.length}`);
  for (const name of candidates) {
    const match = /^\.ipfs-publication-transaction-(\d+-[0-9a-f-]+)\.tmp$/.exec(name);
    assert.ok(match, "publication journal candidate name is invalid");
    const attempt = match[1];
    assert.match(attempt, ATTEMPT_TOKEN_RE, "publication journal candidate attempt token is invalid");
    const paths = attemptPathsFor(attempt);
    const candidatePath = path.join(outDir, name);
    assert.equal(candidatePath, paths.journalTemporary, "publication journal candidate is not its exact attempt temporary");
    const candidateIdentity = pathIdentity(candidatePath, "unlinked publication journal candidate");
    assert.equal(candidateIdentity.type, "file", "unlinked publication journal candidate is not a regular file");
    assert.ok(BigInt(candidateIdentity.size) <= BigInt(MAX_CONTROL_RESPONSE_BYTES), "unlinked publication journal candidate exceeds safety cap");
    assert.ok(!attemptOwnerIsLive(attempt), `unlinked publication journal candidate ${attempt} is still owned by a live process`);
    for (const owned of [paths.staging, paths.control, ...paths.backups.values()]) {
      assert.equal(lstatIfExists(owned, "unlinked publication journal candidate owned path"), null,
        `unlinked publication journal candidate has ambiguous payload: ${owned}`);
    }
    removeExactOwnedPath(candidatePath, "unlinked publication journal candidate", {
      type: "file",
      dev: candidateIdentity.dev,
      ino: candidateIdentity.ino,
      size: candidateIdentity.size,
      mtimeNs: candidateIdentity.mtimeNs,
      ctimeNs: candidateIdentity.ctimeNs,
    });
  }
}

function cleanupUncommittedAttempt(journal) {
  const paths = attemptPathsFor(journal.attempt);
  for (const backup of paths.backups.values()) {
    assert.equal(lstatIfExists(backup, "uncommitted backup"), null, `refusing ambiguous backup outside a committed transaction: ${backup}`);
  }
  if (lstatIfExists(paths.control, "uncommitted attempt control directory") !== null) {
    if (journal.controlIdentity === null) {
      const stat = lstatIfExists(paths.control, "uncommitted attempt control directory");
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "unrecorded attempt control path is ambiguous");
    }
    removeExactOwnedPath(paths.control, "uncommitted attempt control directory", journal.controlIdentity);
  }
  if (lstatIfExists(paths.staging, "uncommitted staging directory") !== null) {
    if (journal.stagingIdentity === null) {
      const stat = lstatIfExists(paths.staging, "uncommitted staging directory");
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "unrecorded attempt staging path is ambiguous");
    }
    removeExactOwnedPath(paths.staging, "uncommitted staging directory", journal.stagingIdentity);
  }
  removeJournalTemporary(journal, paths);
  removeAttemptJournal();
}

function assertPathMissing(target, label) {
  assertOutputRootStable(`${label} before absence check`);
  assert.equal(lstatIfExists(target, label), null, `${label} unexpectedly exists: ${target}`);
}

function fsyncRenameParents(source, destination, label) {
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  fsyncDirectory(sourceParent);
  if (destinationParent !== sourceParent) fsyncDirectory(destinationParent);
  assertOutputRootStable(`${label} after parent fsync`);
}

function assertRenameCompatibleIdentity(target, expected, label) {
  const actual = pathIdentity(target, label);
  assert.ok(samePathObject(actual, expected), `${label} is not the expected renamed object`);
  if (actual.type === "file") {
    assert.equal(actual.size, expected.size, `${label} size changed across rename`);
    assert.equal(actual.mtimeNs, expected.mtimeNs, `${label} mtime changed across rename`);
  }
  return actual;
}

function removeAmbiguousInstalledPath(target, stagedIdentity, label) {
  const actual = assertRenameCompatibleIdentity(target, stagedIdentity, label);
  // macOS updates ctime on rename.  The install boundary is persisted before
  // rename, so a kill in that one interval cannot know the post-rename ctime;
  // retain the object, size and mtime proof and remove only the exact named
  // attempt-owned target under the stable output root.
  removeExactOwnedPath(target, label);
}

function finishPublicationTransaction(journal) {
  const { replacements } = journal.transaction;
  for (const replacement of replacements) {
    if (lstatIfExists(replacement.backup, "committed publication backup") !== null) {
      if (replacement.backupIdentity) removeExactOwnedPath(replacement.backup, "committed publication backup", replacement.backupIdentity);
      else removeAmbiguousInstalledPath(replacement.backup, replacement.liveIdentity, "committed publication backup");
    }
    if (replacement.staged !== null && lstatIfExists(replacement.staged, "committed staged publication artifact") !== null) {
      removeExactOwnedPath(replacement.staged, "committed staged publication artifact", replacement.stagedIdentity);
    }
  }
  const paths = attemptPathsFor(journal.attempt);
  // Manifests and any not-yet-installed artifacts are children of the
  // private, journal-bound control directory.  A single exact-tree cleanup
  // closes their create-before-record crash windows without inspecting or
  // deleting arbitrary dot siblings.
  if (lstatIfExists(paths.control, "committed attempt control directory") !== null) {
    removeExactOwnedPath(paths.control, "committed attempt control directory", journal.controlIdentity);
  }
  removeJournalTemporary(journal, paths);
  removeAttemptJournal();
}

function recoverCommittedPublication(journal) {
  const { replacements, installProgress, installingIndex } = journal.transaction;
  if (installProgress === replacements.length && installingIndex === null) {
    finishPublicationTransaction(journal);
    return;
  }
  // `installingIndex` is durable before staged->live.  Whether the rename
  // happened or not, only the journal-declared staged identity may be removed.
  const effectiveInstallProgress = Math.max(installProgress, installingIndex === null ? 0 : installingIndex + 1);
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (index < effectiveInstallProgress && replacement.staged !== null && lstatIfExists(replacement.live, "partially installed publication artifact") !== null) {
      if (replacement.installedIdentity) {
        removeExactOwnedPath(replacement.live, "partially installed publication artifact", replacement.installedIdentity);
      } else {
        removeAmbiguousInstalledPath(replacement.live, replacement.stagedIdentity, "partially installed publication artifact");
      }
    }
    if (replacement.hadLive && lstatIfExists(replacement.backup, "publication backup before recovery") !== null) {
      if (replacement.backupIdentity) assertPathIdentity(replacement.backup, replacement.backupIdentity, "publication backup before recovery");
      else assertRenameCompatibleIdentity(replacement.backup, replacement.liveIdentity, "publication backup before recovery");
      assertPathMissing(replacement.live, "publication live target before recovery");
      assertOutputRootStable("publication backup restore before rename");
      fs.renameSync(replacement.backup, replacement.live);
      assertRenameCompatibleIdentity(replacement.live, replacement.liveIdentity, "publication live target after recovery");
      fsyncRenameParents(replacement.backup, replacement.live, "publication backup recovery rename");
    } else if (!replacement.hadLive && lstatIfExists(replacement.live, "unexpected absent publication target") !== null) {
      // Only a staged install can occupy a previously absent target.
      assert.ok(replacement.staged !== null, "a removed-only absent publication target unexpectedly exists");
      if (replacement.installedIdentity) removeExactOwnedPath(replacement.live, "unexpected absent publication target", replacement.installedIdentity);
      else removeAmbiguousInstalledPath(replacement.live, replacement.stagedIdentity, "unexpected absent publication target");
    }
    if (replacement.staged !== null && lstatIfExists(replacement.staged, "recovery staged publication artifact") !== null) {
      removeExactOwnedPath(replacement.staged, "recovery staged publication artifact", replacement.stagedIdentity);
    }
  }
  const paths = attemptPathsFor(journal.attempt);
  if (lstatIfExists(paths.control, "recovered attempt control directory") !== null) {
    removeExactOwnedPath(paths.control, "recovered attempt control directory", journal.controlIdentity);
  }
  removeJournalTemporary(journal, paths);
  removeAttemptJournal();
}

function recoverPublicationTransaction(ownedAttempt = null) {
  const journal = readAttemptJournal(ownedAttempt);
  if (!journal) {
    recoverInitialJournalCandidates();
    refuseAmbiguousAttemptOrphans();
    return;
  }
  if (journal.transaction === null) cleanupUncommittedAttempt(journal);
  else recoverCommittedPublication(journal);
}

const attemptPaths = attemptPathsFor(attemptToken);
let attemptJournal = {
  format: ATTEMPT_JOURNAL_FORMAT,
  attempt: attemptToken,
  root: outputRootIdentity,
  phase: "allocated",
  owned: attemptPaths.owned,
  stagingIdentity: null,
  controlIdentity: null,
  transients: emptyAttemptTransients(),
  transaction: null,
};
// This durable allocation is intentionally before *any* attempt-owned
// directory, manifest or artifact exists.  A restart can therefore reclaim
// only this exact attempt's names, never a broad dot-file pattern.
writeAttemptJournal(attemptJournal);

if (args.testHoldAfterJournalMs !== null) await new Promise((resolve) => setTimeout(resolve, args.testHoldAfterJournalMs));

if (args.testReplaceOutputRootWith !== null) {
  const held = `${outDir}.attempt-root-held`;
  assertOutputRootStable("test output-root replacement before move");
  assert.equal(lstatIfExists(held, "test output-root hold path"), null, "test output-root hold path already exists");
  const replacement = fs.lstatSync(args.testReplaceOutputRootWith, { bigint: true });
  assert.ok(replacement.isDirectory() && !replacement.isSymbolicLink(), "test output-root replacement must be a real directory");
  fs.renameSync(outDir, held);
  fs.symlinkSync(args.testReplaceOutputRootWith, outDir);
}

function maybeCrashTransaction(phase) {
  if (args.testCrashAt !== phase) return;
  process.stderr.write(`test crash injected at ${phase}\n`);
  process.exit(86);
}

maybeCrashTransaction("attempt-journal");
assertOutputRootStable("attempt staging before create");
fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
maybeCrashTransaction("staging-directory-created-unrecorded");
const createdStagingIdentity = pathIdentity(stagingDir, "attempt staging after create");
assert.equal(createdStagingIdentity.type, "directory", "attempt staging is not a directory");
attemptJournal = { ...attemptJournal, phase: "staging", stagingIdentity: createdStagingIdentity };
writeAttemptJournal(attemptJournal);
maybeCrashTransaction("staging-created");
assertOutputRootStable("attempt control before create");
fs.mkdirSync(attemptPaths.control, { recursive: false, mode: 0o700 });
maybeCrashTransaction("control-directory-created-unrecorded");
const createdControlIdentity = pathIdentity(attemptPaths.control, "attempt control after create");
assert.equal(createdControlIdentity.type, "directory", "attempt control is not a directory");
attemptJournal = { ...attemptJournal, controlIdentity: createdControlIdentity };
writeAttemptJournal(attemptJournal);
attemptJournal = { ...attemptJournal, phase: "materializing" };
writeAttemptJournal(attemptJournal);

function recordAttemptTransient(kind, index, identity) {
  assertJournalIdentity(identity, "publication transient identity");
  assert.equal(identity.type, "file", "publication transient is not a file");
  const transients = {
    scratch: [...attemptJournal.transients.scratch],
    staged: [...attemptJournal.transients.staged],
    pendingTemporary: attemptJournal.transients.pendingTemporary,
  };
  if (kind === "scratch") {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < transients.scratch.length, "publication scratch transient index is invalid");
    transients.scratch[index] = identity;
  } else if (kind === "staged") {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < transients.staged.length, "publication staged transient index is invalid");
    transients.staged[index] = identity;
  } else {
    assert.equal(kind, "pending", "publication transient kind is invalid");
    transients.pendingTemporary = identity;
  }
  attemptJournal = { ...attemptJournal, transients };
  writeAttemptJournal(attemptJournal);
}

function ensureStagingParent(full) {
  assertAttemptDirectory("staging parent before create");
  assert.ok(full.startsWith(`${stagingDir}${path.sep}`), `staged path escapes attempt directory: ${full}`);
  const relativeParent = path.relative(stagingDir, path.dirname(full));
  assert.ok(relativeParent === "" || (!path.isAbsolute(relativeParent) && !relativeParent.split(path.sep).includes("..")),
    `staged parent escapes attempt directory: ${full}`);
  let current = stagingDir;
  for (const part of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, part);
    if (lstatIfExists(current, "staging parent") === null) {
      assertOutputRootStable("staging parent before mkdir");
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
      fsyncDirectory(path.dirname(current));
    }
    const identity = pathIdentity(current, "staging parent");
    assert.equal(identity.type, "directory", `staging parent is not a directory: ${current}`);
  }
  assertAttemptDirectory("staging parent after create");
}

// Each transition is persisted before the next rename. A later invocation
// rolls an interrupted partial install back, or rolls a fully installed one
// forward by deleting only its journal-declared backups.
function commitStagedPublication(artifacts) {
  assertAttemptDirectory("publication transaction staging");
  fsyncTree(stagingDir);
  for (const artifact of artifacts) if (artifact.staged !== null) fsyncTree(artifact.staged);
  fsyncDirectory(outDir);
  const replacements = [{ live: ipfsDir, staged: stagingDir }, ...artifacts].map((replacement) => {
    const live = assertTransactionPath(replacement.live, "publication live path");
    const liveName = path.basename(live);
    const staged = replacement.staged === null ? null : (liveName === "ipfs" ? stagingDir : attemptPaths.staged.get(liveName));
    assert.equal(replacement.staged, staged, "publication staged artifact is not the exact attempt-owned path");
    const existing = lstatIfExists(live, `existing ${liveName}`) === null ? null : pathIdentity(live, `existing ${liveName}`);
    const stagedIdentity = staged === null ? null : pathIdentity(staged, `staged ${liveName}`);
    return {
      live,
      staged,
      backup: attemptPaths.backups.get(liveName),
      hadLive: existing !== null,
      liveIdentity: existing,
      backupIdentity: null,
      stagedIdentity,
      installedIdentity: null,
    };
  });
  attemptJournal = {
    ...attemptJournal,
    phase: "committing",
    transaction: { backingUpIndex: null, backupProgress: 0, installProgress: 0, installingIndex: null, replacements },
  };
  writeAttemptJournal(attemptJournal);
  try {
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      attemptJournal.transaction.backingUpIndex = index;
      writeAttemptJournal(attemptJournal);
      if (replacement.hadLive) {
        assertPathIdentity(replacement.live, replacement.liveIdentity, "publication live target before backup");
        assertPathMissing(replacement.backup, "publication backup target");
        assertOutputRootStable("publication backup before rename");
        fs.renameSync(replacement.live, replacement.backup);
        replacement.backupIdentity = assertRenameCompatibleIdentity(replacement.backup, replacement.liveIdentity, "publication backup after rename");
        fsyncRenameParents(replacement.live, replacement.backup, "publication backup rename");
      }
      maybeCrashTransaction(`backup-renamed-${index + 1}`);
      attemptJournal.transaction.backupProgress = index + 1;
      attemptJournal.transaction.backingUpIndex = null;
      writeAttemptJournal(attemptJournal);
      maybeCrashTransaction(`backup-${index + 1}`);
    }
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      // Persist the exact ambiguous boundary first.  Recovery can distinguish
      // a rename that happened before installProgress was advanced from one
      // that did not, and can restore a nonempty prior directory idempotently.
      attemptJournal.transaction.installingIndex = index;
      writeAttemptJournal(attemptJournal);
      if (replacement.staged !== null) {
        assertPathIdentity(replacement.staged, replacement.stagedIdentity, "publication staged target before install");
        assertPathMissing(replacement.live, "publication live target before install");
        assertOutputRootStable("publication install before rename");
        fs.renameSync(replacement.staged, replacement.live);
        const installed = pathIdentity(replacement.live, "publication live target after install");
        assert.ok(samePathObject(installed, replacement.stagedIdentity), "publication live target object changed after install");
        if (installed.type === "file") {
          assert.equal(installed.size, replacement.stagedIdentity.size, "publication live target size changed after install");
          assert.equal(installed.mtimeNs, replacement.stagedIdentity.mtimeNs, "publication live target mtime changed after install");
        }
        replacement.installedIdentity = installed;
        stagedArtifactPaths.delete(replacement.staged);
        fsyncRenameParents(replacement.staged, replacement.live, "publication install rename");
      }
      maybeCrashTransaction(`install-renamed-${index + 1}`);
      attemptJournal.transaction.installProgress = index + 1;
      attemptJournal.transaction.installingIndex = null;
      writeAttemptJournal(attemptJournal);
      maybeCrashTransaction(`install-${index + 1}`);
    }
  } catch (error) {
    recoverPublicationTransaction(attemptToken);
    throw error;
  }
  finishPublicationTransaction(attemptJournal);
}

let fileCount = 0;
let totalBytes = 0;
const write = (rel, bytes) => {
  const full = path.join(stagingDir, rel);
  ensureStagingParent(full);
  assert.ok(BigInt(totalBytes) + BigInt(bytes.length) <= BigInt(publicationPolicy.maxStaticDirectoryBytes),
    `static directory would exceed approved ${publicationPolicy.maxStaticDirectoryBytes} bytes`);
  // The attempt journal makes an interrupted materialization reclaimable.
  // Durability happens once in fsyncTree immediately before the atomic swap;
  // fsyncing every one of millions of tile leaves here would be prohibitive.
  writeExclusiveRegularFile(full, bytes, `staged static ${rel}`, { durable: false });
  fileCount += 1;
  totalBytes += bytes.length;
  maybeCrashTransaction(`materialize-${fileCount}`);
};

function boundedDistribution(limit, bucketBytes = 1024) {
  const buckets = new Uint32Array(Math.ceil(limit / bucketBytes) + 1);
  let count = 0; let max = 0;
  return {
    add(bytes) {
      assert.ok(bytes <= limit, `static tile ${bytes} exceeds hard transport cap ${limit}`);
      buckets[Math.min(buckets.length - 1, Math.floor(bytes / bucketBytes))] += 1;
      count += 1; max = Math.max(max, bytes);
    },
    percentile(p) {
      const target = Math.max(0, Math.floor((count - 1) * p));
      let seen = 0;
      for (let i = 0; i < buckets.length; i += 1) {
        seen += buckets[i];
        if (seen > target) return Math.min(limit, (i + 1) * bucketBytes - 1);
      }
      return 0;
    },
    max: () => max,
  };
}
const identitySizes = boundedDistribution(STATIC_TRANSPORT_BOUNDS.hard);
// The stored record cap is 32 KiB, so the same fixed histogram remains tiny.
const gzipSizes = boundedDistribution(64 * 1024);
let uniformMasks = 0;
let rasterMasks = 0;
let storedTiles = 0;
let shallowStored = null;
let deepStored = null;
let harnessDestroyed = false;
let staticIdentity;
let oceanSkipsDeclared = 0;
let oceanSkipsServedAsLand = 0;
let actualStaticPhysicalUpperBytes = null;
const oceanSkipLandDiagnostics = [];

async function failMaterialization(error) {
  if (!harnessDestroyed) {
    try {
      await harness.destroy();
    } catch {
      // Preserve the original materialization error.
    }
  }
  discardStagingDirectory();
  discardStagedArtifacts();
  discardAttemptScratch();
  throw error;
}

try {
write("layer.json", layerJson);
for await (const record of iterateBoundRecords()) {
  const dtt = readDtt(record);
  const key = `${dtt.level}/${dtt.x}/${dtt.y}`;
  // verify.mjs owns global duplicate detection. Keeping every address here
  // would turn static materialization into a second unbounded verifier.
  storedTiles += 1;
  if (!shallowStored || dtt.level < Number(shallowStored.split("/")[0])) shallowStored = key;
  if (!deepStored || dtt.level > Number(deepStored.split("/")[0])) deepStored = key;
  assert.ok(dtt.payload?.bytes, `${key}: record carries no payload bytes`);
  const stored = Buffer.from(dtt.payload.bytes);
  const body =
    (dtt.payload.contentEncoding ?? "").toLowerCase() === "gzip" ? inflateGzipBounded(stored, `static tile ${key}`) : stored;
  const mask = assertWaterMaskExtension(body, key);
  if (mask.kind === "RASTER") rasterMasks += 1;
  else uniformMasks += 1;
  identitySizes.add(body.length);
  gzipSizes.add(stored.length);
  write(`${dtt.level}/${dtt.x}/${dtt.y}.terrain`, body);
}
} catch (error) {
  await failMaterialization(error);
}

// The promise layer.json makes, kept by files rather than by respond().
//
// AND WHAT EACH ONE SAYS ABOUT WATER IS COUNTED. Every synthesized tile used
// to come out UNIFORM LAND — all 36 of them — because the only addresses in
// this list were the ancestor placeholders at z0..z7, every one below the
// level where the store is authoritative, so `terrain_ocean_synth_min_level`
// could not fire on a single file this script writes. The addresses the ocean
// test skipped are now declared too (verify.mjs), they sit at built levels,
// and they come out UNIFORM WATER. The split is recorded because "the lever is
// configured" and "the lever fired" are different claims and only the second
// one is worth anything.
let synthesizedTiles = 0;
let lastSynthesized = null;
let synthesizedWater = 0;
let synthesizedLand = 0;
try {
const oceanSkips = await oceanSkipJoiner();
for await (const address of availableButUnstored()) {
  const { level, x, y } = parseTerrainAddress(address);
  const body = await synthesizeTile(level, x, y);
  const mask = assertWaterMaskExtension(body, `${address} (synthesized)`);
  if (mask.kind === "UNIFORM_WATER") synthesizedWater += 1;
  else synthesizedLand += 1;
  // The gate this lane did not have: an address the ENCODER MEASURED as all
  // water that comes out of the module as land is the exact defect — open
  // ocean rendered as flat ground with no mask — and it must stop the
  // publication rather than be counted.
  if (await oceanSkips.matches(address) && mask.kind !== "UNIFORM_WATER") {
    oceanSkipsServedAsLand += 1;
    if (oceanSkipLandDiagnostics.length < MAX_OCEAN_DIAGNOSTICS) oceanSkipLandDiagnostics.push(`${address} -> ${mask.kind}`);
  }
  write(`${level}/${x}/${y}.terrain`, body);
  synthesizedTiles += 1;
  lastSynthesized = address;
  identitySizes.add(body.length);
}
assert.deepEqual(
  oceanSkipLandDiagnostics,
  [],
  `${oceanSkipsServedAsLand} addresses the encoder measured as all water are being ` +
    "published as land — check terrain_ocean_synth_min_level against the levels this run built",
);
oceanSkipsDeclared = oceanSkips.finish();
await harness.destroy();
harnessDestroyed = true;

// Every promised unstored address is written in the single streaming loop
// above. Re-reading the complete worklist solely to build an in-memory check
// would defeat the bounded publication contract.

staticIdentity = {
  p50: identitySizes.percentile(0.5), p99: identitySizes.percentile(0.99), max: identitySizes.max(),
};
assert.ok(staticIdentity.p50 <= STATIC_TRANSPORT_BOUNDS.p50, `static identity p50 ${staticIdentity.p50} exceeds ${STATIC_TRANSPORT_BOUNDS.p50}`);
assert.ok(staticIdentity.p99 <= STATIC_TRANSPORT_BOUNDS.p99, `static identity p99 ${staticIdentity.p99} exceeds ${STATIC_TRANSPORT_BOUNDS.p99}`);
assert.ok(staticIdentity.max <= STATIC_TRANSPORT_BOUNDS.hard, `static identity max ${staticIdentity.max} exceeds ${STATIC_TRANSPORT_BOUNDS.hard}`);
assert.equal(fileCount, materializationPlan.files, "materialized file count disagrees with the preflight plan");
assert.ok(BigInt(totalBytes) <= BigInt(publicationPolicy.maxStaticDirectoryBytes), "materialized bytes exceed approved static directory bound");
actualStaticPhysicalUpperBytes = BigInt(totalBytes) + BigInt(fileCount) *
  (stagingReservation.blockSize - 1n) +
  (BigInt(fileCount) + materializationPlan.directoryRows) * stagingReservation.blockSize;
assert.ok(actualStaticPhysicalUpperBytes <= stagingReservation.physicalStaticBytes,
  "materialized staging tree exceeds its approved physical allocation reservation");
} catch (error) {
  await failMaterialization(error);
}

// ── ADD AND PIN THROUGH THE NODE'S IPFS API ────────────────────────────────
//
// kubo reconstructs the directory tree from the multipart filenames, so the
// whole pyramid goes up in one request and the LAST entry — the root name — is
// the tileset CID. cid-version=1 and raw-leaves for the same reason the
// cellular snapshot used them: base32 CIDv1 is what a subdomain gateway needs
// and raw leaves keep a small file's CID equal to its own hash, which is what
// the gateway then serves as the ETag.
function compareBytewise(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertSafeRelativePath(rel, label) {
  assert.equal(typeof rel, "string", `${label} must be a string`);
  assert.ok(rel.length > 0 && !path.isAbsolute(rel), `${label} is not a relative path`);
  assert.ok(!rel.split("/").includes(".."), `${label} escapes the staging directory`);
}

function fileIdentity(full) {
  const stat = fs.lstatSync(full, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${full} is not a regular file`);
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.size === expected.size && actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs;
}

function* sortedRegularFiles(directory, prefix = "") {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareBytewise(a.name, b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertSafeRelativePath(rel, "staged file path");
    const full = path.resolve(directory, entry.name);
    assert.ok(full.startsWith(`${directory}${path.sep}`), `staged file path escapes ${directory}`);
    const stat = fs.lstatSync(full, { bigint: true });
    assert.ok(!stat.isSymbolicLink(), `refusing staged symlink ${rel}`);
    if (stat.isDirectory()) yield* sortedRegularFiles(full, rel);
    else {
      assert.ok(stat.isFile(), `refusing non-regular staged entry ${rel}`);
      yield { full, rel, identity: fileIdentity(full) };
    }
  }
}

function multipartHeader(boundary, name) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
      `filename="${encodeURIComponent(name)}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
}

function multipartPlan(directory, boundary) {
  assertAttemptDirectory("multipart plan staging");
  if (attemptJournal.phase !== "uploading") {
    attemptJournal = { ...attemptJournal, phase: "uploading" };
    writeAttemptJournal(attemptJournal);
  }
  const manifestPath = attemptPaths.scratch[0];
  const directoryManifestPath = attemptPaths.scratch[1];
  const manifestOpened = createExclusiveRegularFile(manifestPath, "upload manifest");
  const descriptor = manifestOpened.descriptor;
  attemptScratchPaths.set(manifestPath, manifestOpened.identity);
  let expectedFiles = 0;
  let contentLength = 0n;
  try {
    for (const file of sortedRegularFiles(directory)) {
      const name = `${tilesetId}/${file.rel}`;
      const header = multipartHeader(boundary, name);
      const manifestEntry = { rel: file.rel, name, ...file.identity };
      const line = `${JSON.stringify(manifestEntry)}\n`;
      assert.ok(Buffer.byteLength(line) <= MAX_UPLOAD_MANIFEST_LINE_BYTES, `upload manifest entry for ${file.rel} exceeds ${MAX_UPLOAD_MANIFEST_LINE_BYTES} bytes`);
      fs.writeSync(descriptor, line);
      contentLength += BigInt(header.length) + BigInt(file.identity.size) + 2n;
      expectedFiles += 1;
    }
  } finally {
    fs.fsyncSync(descriptor);
    assert.ok(samePathObject(pathIdentityFromStat(fs.fstatSync(descriptor, { bigint: true }), manifestPath, "upload manifest"), manifestOpened.identity),
      "upload manifest changed while being written");
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(manifestPath));
  const manifestIdentity = pathIdentity(manifestPath, "upload manifest");
  attemptScratchPaths.set(manifestPath, manifestIdentity);
  // The private control directory is already journal-owned.  Exercise the
  // create/complete-before-individual-record boundary explicitly.
  maybeCrashTransaction("upload-manifest-written");
  recordAttemptTransient("scratch", 0, manifestIdentity);
  const closing = Buffer.from(`--${boundary}--\r\n`);
  contentLength += BigInt(closing.length);
  assert.equal(expectedFiles, fileCount, "materialized file count changed before multipart planning");
  assert.ok(contentLength <= BigInt(Number.MAX_SAFE_INTEGER), "multipart Content-Length exceeds fetch's safe range");
  // Kubo emits UnixFS intermediate-directory receipts as it closes branches.
  // A second deterministic walk writes their post-order sequence to disk;
  // only the active directory ancestry is retained (bounded by path depth).
  const directoryOpened = createExclusiveRegularFile(directoryManifestPath, "directory receipt manifest");
  const directoryDescriptor = directoryOpened.descriptor;
  attemptScratchPaths.set(directoryManifestPath, directoryOpened.identity);
  let expectedDirectories = 0;
  let openDirectories = [];
  try {
    for (const file of sortedRegularFiles(directory)) {
      const parents = file.rel.split("/").slice(0, -1);
      let common = 0;
      while (common < openDirectories.length && common < parents.length && openDirectories[common] === parents[common]) common += 1;
      for (let index = openDirectories.length - 1; index >= common; index -= 1) {
        const name = `${tilesetId}/${openDirectories.slice(0, index + 1).join("/")}`;
        const line = `${name}\n`;
        assert.ok(Buffer.byteLength(line) <= MAX_UPLOAD_MANIFEST_LINE_BYTES, `directory receipt manifest entry for ${name} exceeds ${MAX_UPLOAD_MANIFEST_LINE_BYTES} bytes`);
        fs.writeSync(directoryDescriptor, line);
        expectedDirectories += 1;
      }
      openDirectories = parents;
    }
    for (let index = openDirectories.length - 1; index >= 0; index -= 1) {
      const name = `${tilesetId}/${openDirectories.slice(0, index + 1).join("/")}`;
      const line = `${name}\n`;
      assert.ok(Buffer.byteLength(line) <= MAX_UPLOAD_MANIFEST_LINE_BYTES, `directory receipt manifest entry for ${name} exceeds ${MAX_UPLOAD_MANIFEST_LINE_BYTES} bytes`);
      fs.writeSync(directoryDescriptor, line);
      expectedDirectories += 1;
    }
  } finally {
    fs.fsyncSync(directoryDescriptor);
    assert.ok(samePathObject(pathIdentityFromStat(fs.fstatSync(directoryDescriptor, { bigint: true }), directoryManifestPath, "directory receipt manifest"), directoryOpened.identity),
      "directory receipt manifest changed while being written");
    fs.closeSync(directoryDescriptor);
  }
  fsyncDirectory(path.dirname(directoryManifestPath));
  const directoryManifestIdentity = pathIdentity(directoryManifestPath, "directory receipt manifest");
  attemptScratchPaths.set(directoryManifestPath, directoryManifestIdentity);
  maybeCrashTransaction("directory-manifest-written");
  recordAttemptTransient("scratch", 1, directoryManifestIdentity);
  assert.ok(Number.isSafeInteger(expectedDirectories) && expectedDirectories <= MAX_MATERIALIZED_FILES * 3,
    "materialization directory receipt count exceeds its bounded tree shape");
  return { manifestPath, directoryManifestPath, expectedFiles, expectedDirectories, boundary, closing, contentLength };
}

function boundedMilliseconds(value, label) {
  assert.ok(value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} is outside the supported timer range`);
  return Number(value);
}

function bulkUploadTimeoutFor(plan) {
  if (args.bulkUploadTimeoutMs !== null) return args.bulkUploadTimeoutMs;
  const bytes = plan.contentLength;
  const milliseconds = ((bytes + BigInt(MIN_BULK_UPLOAD_BYTES_PER_SECOND) - 1n) /
    BigInt(MIN_BULK_UPLOAD_BYTES_PER_SECOND)) * 1000n + BULK_UPLOAD_OVERHEAD_MS;
  return boundedMilliseconds(milliseconds, "derived bulk upload timeout");
}

function pinTraversalTimeoutFor(files) {
  if (args.pinTimeoutMs !== null) return args.pinTimeoutMs;
  const milliseconds = ((BigInt(files) + BigInt(MIN_PIN_TRAVERSAL_FILES_PER_SECOND) - 1n) /
    BigInt(MIN_PIN_TRAVERSAL_FILES_PER_SECOND)) * 1000n + PIN_TRAVERSAL_OVERHEAD_MS;
  return boundedMilliseconds(milliseconds, "derived pin traversal timeout");
}

async function* uploadManifestEntries(plan) {
  for await (const line of boundedLines(plan.manifestPath, MAX_UPLOAD_MANIFEST_LINE_BYTES, "upload manifest")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error("upload manifest contains invalid JSON", { cause: error });
    }
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "upload manifest entry is not an object");
    assertSafeRelativePath(entry.rel, "upload manifest path");
    assert.equal(entry.name, `${tilesetId}/${entry.rel}`, "upload manifest name disagrees with path");
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.match(entry[field] ?? "", /^\d+$/, `upload manifest ${field} is invalid`);
    yield entry;
  }
}

async function* directoryReceiptManifestEntries(plan) {
  for await (const name of boundedLines(plan.directoryManifestPath, MAX_UPLOAD_MANIFEST_LINE_BYTES, "directory receipt manifest")) {
    assert.equal(typeof name, "string", "directory receipt manifest entry is invalid");
    assert.ok(name.startsWith(`${tilesetId}/`), "directory receipt manifest escapes its root");
    assertSafeRelativePath(name.slice(tilesetId.length + 1), "directory receipt manifest path");
    yield name;
  }
}

// The second deterministic walk and disk manifest make the upload bounded by
// one pathname and one file stream.  They reject additions, removals,
// symlinks, reordering, and metadata changes after Content-Length is planned.
async function* multipartParts(plan) {
  const manifest = uploadManifestEntries(plan);
  let expected = await manifest.next();
  let files = 0;
  for (const current of sortedRegularFiles(stagingDir)) {
    assert.ok(!expected.done, `staged file ${current.rel} was added after multipart planning`);
    const planned = expected.value;
    assert.equal(current.rel, planned.rel, "staged file order changed after multipart planning");
    assert.ok(sameIdentity(current.identity, planned), `staged file ${current.rel} changed after multipart planning`);
    yield multipartHeader(plan.boundary, planned.name);
    for await (const chunk of regularFileChunks(current.full, `staged upload ${current.rel}`, planned)) yield chunk;
    assert.ok(sameIdentity(fileIdentity(current.full), planned), `staged file ${current.rel} changed during multipart upload`);
    yield Buffer.from("\r\n");
    files += 1;
    expected = await manifest.next();
  }
  assert.ok(expected.done, "staged file was removed after multipart planning");
  assert.equal(files, plan.expectedFiles, "multipart upload file count changed after planning");
  yield plan.closing;
}

// Kubo has accepted the byte stream by this point, but publication has not
// atomically exposed the directory.  Reuse the disk manifest rather than an
// in-memory file list to prove no one changed a staged file between upload and
// commit.  This remains one pathname/identity at a time.
async function assertMultipartPlanStillMatches(plan) {
  assertAttemptDirectory("multipart final identity check");
  const manifest = uploadManifestEntries(plan);
  let expected = await manifest.next();
  let files = 0;
  for (const current of sortedRegularFiles(stagingDir)) {
    assert.ok(!expected.done, `staged file ${current.rel} was added after Kubo upload`);
    const planned = expected.value;
    assert.equal(current.rel, planned.rel, "staged file order changed after Kubo upload");
    assert.ok(sameIdentity(current.identity, planned), `staged file ${current.rel} changed after Kubo upload`);
    files += 1;
    expected = await manifest.next();
  }
  assert.ok(expected.done, "staged file was removed after Kubo upload");
  assert.equal(files, plan.expectedFiles, "staged file count changed after Kubo upload");
  assertAttemptDirectory("multipart final identity check complete");
}

async function withRequest(url, options, label, consume, timeoutMs = args.timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    return await consume(response, controller);
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function declaredResponseLength(response, maxBytes, label, controller, exactBytes = null) {
  const value = response.headers.get("content-length");
  if (value === null) return;
  if (!/^\d+$/.test(value)) {
    controller.abort();
    throw new Error(`${label}: invalid Content-Length`);
  }
  const bytes = BigInt(value);
  if (bytes > BigInt(maxBytes) || (exactBytes !== null && bytes !== BigInt(exactBytes))) {
    controller.abort();
    throw new Error(`${label}: Content-Length ${bytes} violates the response bound`);
  }
}

async function readResponseBytes(response, maxBytes, label, controller, exactBytes = null) {
  declaredResponseLength(response, maxBytes, label, controller, exactBytes);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`${label}: response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  if (exactBytes !== null && total !== exactBytes) {
    throw new Error(`${label}: response body is ${total} bytes; expected ${exactBytes}`);
  }
  return Buffer.concat(chunks, total);
}

async function readResponseText(response, maxBytes, label, controller) {
  return (await readResponseBytes(response, maxBytes, label, controller)).toString("utf8");
}

function validateReceiptEntry(entry, index) {
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `kubo add receipt entry ${index} is not an object`);
  assert.equal(typeof entry.Name, "string", `kubo add receipt entry ${index} has no string Name`);
  assert.equal(typeof entry.Hash, "string", `kubo add receipt entry ${index} has no string Hash`);
  assert.ok(Buffer.byteLength(entry.Name) <= MAX_RECEIPT_NAME_BYTES, `kubo add receipt entry ${index} Name exceeds ${MAX_RECEIPT_NAME_BYTES} bytes`);
  assert.ok(Buffer.byteLength(entry.Hash) <= MAX_RECEIPT_HASH_BYTES, `kubo add receipt entry ${index} Hash exceeds ${MAX_RECEIPT_HASH_BYTES} bytes`);
  assert.match(entry.Hash, /^[A-Za-z0-9]+$/, `kubo add receipt entry ${index} Hash is not a CID-shaped token`);
}

async function readAddReceipt(response, plan, onRoot, controller) {
  assert.equal(response.status, 200, `kubo add: HTTP ${response.status}`);
  assert.ok(response.body, "kubo add returned an empty response body");
  const expectedEntries = plan.expectedFiles + plan.expectedDirectories + 1;
  const maxReceiptBytes = BigInt(expectedEntries) * BigInt(MAX_RECEIPT_LINE_BYTES + 1);
  declaredResponseLength(response, maxReceiptBytes, "kubo add receipt", controller);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let totalBytes = 0n;
  let entries = 0;
  let root = null;
  let layerEntry = null;
  let files = 0;
  let directories = 0;
  const fileManifest = uploadManifestEntries(plan);
  const directoryManifest = directoryReceiptManifestEntries(plan);
  let expectedFile = await fileManifest.next();
  let expectedDirectory = await directoryManifest.next();

  const consumeLine = async (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    assert.ok(line.length > 0, "kubo add receipt contains an empty NDJSON entry");
    assert.ok(Buffer.byteLength(line) <= MAX_RECEIPT_LINE_BYTES, `kubo add receipt line exceeds ${MAX_RECEIPT_LINE_BYTES} bytes`);
    entries += 1;
    assert.ok(entries <= expectedEntries, `kubo add returned more than ${expectedEntries} receipt entries`);
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`kubo add receipt entry ${entries} is invalid JSON`, { cause: error });
    }
    validateReceiptEntry(entry, entries);
    if (!expectedFile.done && entry.Name === expectedFile.value.name) {
      files += 1;
      if (entry.Name === `${tilesetId}/layer.json`) layerEntry = entry;
      expectedFile = await fileManifest.next();
    } else if (!expectedDirectory.done && entry.Name === expectedDirectory.value) {
      directories += 1;
      expectedDirectory = await directoryManifest.next();
    } else {
      assert.ok(expectedFile.done && expectedDirectory.done, "kubo add returned an unplanned file or directory receipt");
      assert.equal(entry.Name, tilesetId, `kubo add root receipt must be exactly ${tilesetId}`);
      assert.equal(root, null, `kubo add returned more than one root receipt for ${tilesetId}`);
      root = entry;
      onRoot(entry.Hash);
    }
  };

  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += BigInt(bytes.length);
    if (totalBytes > maxReceiptBytes) {
      controller.abort();
      throw new Error(`kubo add receipt exceeds derived bound ${maxReceiptBytes} bytes`);
    }
    pending += decoder.write(bytes);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      await consumeLine(line);
    }
    assert.ok(Buffer.byteLength(pending) <= MAX_RECEIPT_LINE_BYTES, `kubo add receipt line exceeds ${MAX_RECEIPT_LINE_BYTES} bytes`);
  }
  pending += decoder.end();
  if (pending.length > 0) await consumeLine(pending);
  assert.equal(entries, expectedEntries, `kubo add returned ${entries} receipt entries; expected ${expectedEntries}`);
  assert.equal(files, plan.expectedFiles, "kubo add omitted a planned file receipt");
  assert.equal(directories, plan.expectedDirectories, "kubo add omitted a planned directory receipt");
  assert.ok(expectedFile.done, "kubo add omitted a planned file receipt");
  assert.ok(expectedDirectory.done, "kubo add omitted a planned directory receipt");
  assert.ok(root, `kubo add returned no entry for the root directory ${tilesetId}`);
  assert.ok(layerEntry, `kubo add returned no entry for ${tilesetId}/layer.json`);
  return { cid: root.Hash, layerJsonCid: layerEntry.Hash, entries, directories };
}

async function addAndPin(apiURL, onRoot) {
  const boundary = `----terrain-pyramid-${randomUUID()}`;
  const plan = multipartPlan(stagingDir, boundary);
  const url =
    `${apiURL.replace(/\/$/, "")}/api/v0/add` +
    "?pin=false&cid-version=1&raw-leaves=true&wrap-with-directory=false";
  const receipt = await withRequest(
      url,
      {
        method: "POST",
        // kubo rejects a browser-shaped User-Agent on the RPC API.
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(plan.contentLength),
          "user-agent": "",
        },
        body: Readable.from(multipartParts(plan), { objectMode: false, highWaterMark: 64 * 1024 }),
        duplex: "half",
      },
      "kubo add",
      (response, controller) => readAddReceipt(response, plan, onRoot, controller),
      bulkUploadTimeoutFor(plan),
    );
  return { ...receipt, multipartPlan: plan };
}

async function pinCreatedRoot(apiURL, cid, timeoutMs) {
  return withRequest(
    `${apiURL.replace(/\/$/, "")}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`,
    { method: "POST", headers: { "user-agent": "" } },
    "kubo pin/add",
    async (response, controller) => {
      assert.equal(response.status, 200, `pin/add: HTTP ${response.status}`);
      const text = await readResponseText(response, MAX_CONTROL_RESPONSE_BYTES, "kubo pin/add", controller);
      let decoded;
      try {
        decoded = JSON.parse(text);
      } catch (error) {
        throw new Error("pin/add returned malformed JSON", { cause: error });
      }
      assert.ok(Array.isArray(decoded.Pins) && decoded.Pins.includes(cid), `pin/add did not acknowledge ${cid}`);
    },
    timeoutMs,
  );
}

async function preflightKubo(apiURL) {
  return withRequest(
    `${apiURL.replace(/\/$/, "")}/api/v0/version`,
    { method: "POST", headers: { "user-agent": "" } },
    "kubo preflight /version",
    async (response, controller) => {
      const text = await readResponseText(response, MAX_CONTROL_RESPONSE_BYTES, "kubo preflight /version", controller);
      assert.equal(response.status, 200, `kubo preflight /version: HTTP ${response.status}: ${text.slice(0, 200)}`);
      const version = JSON.parse(text);
      assert.ok(version.Version, "kubo preflight returned no Version");
      return version.Version;
    },
  );
}

function isKuboUnpinnedResponse(text, cid) {
  let error;
  try {
    error = JSON.parse(text);
  } catch {
    return false;
  }
  return error && typeof error === "object" && !Array.isArray(error) &&
    Object.keys(error).length === 3 && error.Message === `path '${cid}' is not pinned` &&
    error.Code === 0 && error.Type === "error";
}

async function lookupRecursivePin(apiURL, cid, timeoutMs) {
  return withRequest(
    `${apiURL.replace(/\/$/, "")}/api/v0/pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`,
    { method: "POST", headers: { "user-agent": "" } },
    "kubo pin/ls",
    async (response, controller) => {
      const text = await readResponseText(response, MAX_CONTROL_RESPONSE_BYTES, "kubo pin/ls", controller);
      // Kubo 0.39 reports this exact ordinary absence as HTTP 500.  Do not
      // weaken 500 handling: malformed or different errors remain fatal.
      if (response.status === 404 || (response.status === 500 && isKuboUnpinnedResponse(text, cid))) {
        return { present: false, type: null, response: text };
      }
      assert.equal(response.status, 200, `pin/ls: HTTP ${response.status}: ${text.slice(0, 200)}`);
      let decoded;
      try {
        decoded = JSON.parse(text);
      } catch (error) {
        throw new Error("pin/ls returned malformed JSON", { cause: error });
      }
      assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded), "pin/ls returned no object");
      assert.ok(decoded.Keys && typeof decoded.Keys === "object" && !Array.isArray(decoded.Keys), "pin/ls returned no Keys object");
      const entry = decoded.Keys[cid];
      if (entry === undefined) return { present: false, type: null, response: JSON.stringify(decoded) };
      assert.equal(entry.Type, "recursive", `the root ${cid} is not recursively pinned`);
      return { present: true, type: entry.Type, response: JSON.stringify(decoded) };
    },
    timeoutMs,
  );
}

function assertBoundedString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(Buffer.byteLength(value) <= MAX_CONTROL_RESPONSE_BYTES, `${label} exceeds ${MAX_CONTROL_RESPONSE_BYTES} bytes`);
  return value;
}

function assertPendingPinReceipt(receipt) {
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt), "pending IPFS pin receipt must be an object");
  assert.equal(receipt.format, "terrain-ipfs-pin-intent-v1", "pending IPFS pin receipt format is unsupported");
  assert.ok(["intent", "proven-pending"].includes(receipt.state), "pending IPFS pin receipt state is unsupported");
  const allowed = receipt.state === "intent"
    ? ["format", "state", "cid", "attempt", "recordedAt"]
    : ["format", "state", "cid", "pinProof", "preexisting", "attempt", "recordedAt"];
  assert.deepEqual(Object.keys(receipt).sort(), [...allowed].sort(), "pending IPFS pin receipt has unexpected or missing fields");
  assert.match(assertBoundedString(receipt.cid, "pending IPFS pin CID"), /^[A-Za-z0-9]+$/, "pending IPFS pin CID is not CID-shaped");
  assertBoundedString(receipt.attempt, "pending IPFS pin attempt");
  assertBoundedString(receipt.recordedAt, "pending IPFS pin time");
  assert.ok(Number.isFinite(Date.parse(receipt.recordedAt)), "pending IPFS pin time is invalid");
  if (receipt.state === "intent") return receipt;
  assert.equal(typeof receipt.preexisting, "boolean", "pending IPFS pin preexisting must be boolean");
  const proof = receipt.pinProof;
  assert.ok(proof && typeof proof === "object" && !Array.isArray(proof), "pending IPFS pin proof must be an object");
  for (const key of Object.keys(proof)) assert.ok(["api", "checkedAt", "endpoint", "type", "response", "preexisting"].includes(key), `pending IPFS pin proof has unexpected field ${key}`);
  assertBoundedString(proof.api, "pending IPFS pin proof api");
  assertBoundedString(proof.checkedAt, "pending IPFS pin proof checkedAt");
  assert.ok(Number.isFinite(Date.parse(proof.checkedAt)), "pending IPFS pin proof checkedAt is invalid");
  assertBoundedString(proof.endpoint, "pending IPFS pin proof endpoint");
  assert.equal(proof.type, "recursive", "pending IPFS pin proof must be recursive");
  assertBoundedString(proof.response, "pending IPFS pin proof response");
  assert.equal(proof.preexisting, receipt.preexisting, "pending IPFS pin proof preexisting disagrees with receipt");
  return receipt;
}

function readPendingPinReceipt() {
  if (lstatIfExists(pendingPinPath, "pending IPFS pin receipt") === null) return null;
  let receipt;
  try {
    receipt = JSON.parse(readBoundedRegularFile(pendingPinPath, MAX_CONTROL_RESPONSE_BYTES, "pending IPFS pin receipt").toString("utf8"));
  } catch (error) {
    throw new Error(`pending IPFS pin receipt is invalid JSON: ${pendingPinPath}`, { cause: error });
  }
  return assertPendingPinReceipt(receipt);
}

function fsyncDirectory(directory) {
  assertOutputRootStable(`fsync directory ${directory}`);
  const stat = fs.lstatSync(directory, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `refusing to fsync non-directory ${directory}`);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writePendingPinReceipt(cid, state, proof = null) {
  const receipt = state === "intent"
    ? {
        format: "terrain-ipfs-pin-intent-v1",
        state,
        cid,
        attempt: attemptToken,
        recordedAt: new Date().toISOString(),
      }
    : {
        format: "terrain-ipfs-pin-intent-v1",
        state,
        cid,
        pinProof: proof,
        preexisting: proof.preexisting,
        attempt: attemptToken,
        recordedAt: new Date().toISOString(),
      };
  assertPendingPinReceipt(receipt);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  assert.ok(bytes.length <= MAX_CONTROL_RESPONSE_BYTES, `pending IPFS pin receipt exceeds ${MAX_CONTROL_RESPONSE_BYTES} bytes`);
  if (attemptJournal.phase !== "pinning") {
    attemptJournal = { ...attemptJournal, phase: "pinning" };
    writeAttemptJournal(attemptJournal);
  }
  const temporary = attemptPaths.pendingTemporary;
  const prior = lstatIfExists(pendingPinPath, "existing pending IPFS pin receipt") === null ? null : pathIdentity(pendingPinPath, "existing pending IPFS pin receipt");
  const temporaryIdentity = writeExclusiveRegularFile(temporary, bytes, "pending IPFS pin receipt temporary");
  recordAttemptTransient("pending", null, temporaryIdentity);
  try {
    if (prior) assertPathIdentity(pendingPinPath, prior, "existing pending IPFS pin receipt before replace");
    assertPathIdentity(temporary, temporaryIdentity, "pending IPFS pin receipt temporary before replace");
    assertOutputRootStable("pending IPFS pin receipt before replace");
    fs.renameSync(temporary, pendingPinPath);
    const installed = pathIdentity(pendingPinPath, "pending IPFS pin receipt after replace");
    assert.ok(samePathObject(installed, temporaryIdentity), "pending IPFS pin receipt object changed after replace");
    assert.equal(installed.size, temporaryIdentity.size, "pending IPFS pin receipt size changed after replace");
    assert.equal(installed.mtimeNs, temporaryIdentity.mtimeNs, "pending IPFS pin receipt mtime changed after replace");
    fsyncRenameParents(temporary, pendingPinPath, "pending IPFS pin receipt rename");
    maybeCrashTransaction(`pending-${state}`);
  } finally {
    if (lstatIfExists(temporary, "pending IPFS pin receipt temporary") !== null) removeExactOwnedPath(temporary, "pending IPFS pin receipt temporary", temporaryIdentity);
  }
  return receipt;
}

let publication = null;

async function abortPublication(error) {
  // Kubo's local recursive pins are not reference counted.  A successful
  // pin/add therefore cannot prove exclusive ownership, even after pin/ls.
  // Keep a durable recovery receipt and never pin/rm another actor's CID.
  discardStagingDirectory();
  discardStagedArtifacts();
  discardAttemptScratch();
  if (lstatIfExists(transactionPath, "publication attempt journal") !== null) {
    const journal = readAttemptJournal(attemptToken);
    if (journal?.transaction) recoverPublicationTransaction(attemptToken);
    else cleanupUncommittedAttempt(journal);
  }
  throw error;
}

// The pin assertion's OWN EVIDENCE.  A CID is never accepted as a substitute
// for this proof, because it cannot establish that the complete directory is
// recursively retained.
let pinProof = null;
if (args.add) {
  try {
    const pending = readPendingPinReceipt();
    process.stdout.write(`adding ${fileCount} files (${(totalBytes / 1e6).toFixed(1)} MB) to ${args.api}\n`);
    const kuboVersion = await preflightKubo(args.api);
    process.stdout.write(`kubo preflight ${kuboVersion}\n`);
    publication = await addAndPin(args.api, (cid) => {
      assert.equal(publication, null, "kubo add emitted a root after a completed receipt");
      assert.ok(cid, "kubo add emitted an empty root CID");
    });
    if (pending) assert.equal(pending.cid, publication.cid, `pending IPFS pin is for ${pending.cid}, not this publication ${publication.cid}; refusing to replace recovery evidence`);
    // The CID is known before any pin mutation. Persist that fact first: an
    // interrupted/failed pin proof can be resumed for this CID but never
    // silently redirected to another deterministic directory.
    writePendingPinReceipt(publication.cid, "intent");
    // CIDs are deterministic, so inspect the recursive pin before calling
    // pin/add.  A later actor may race this point; we make no ownership claim
    // in either case and never issue pin/rm on an error path.
    const pinTimeoutMs = pinTraversalTimeoutFor(fileCount);
    const priorPin = await lookupRecursivePin(args.api, publication.cid, pinTimeoutMs);
    let pinned = priorPin;
    let pinPreexisted = priorPin.present;
    if (!priorPin.present) {
      await pinCreatedRoot(args.api, publication.cid, pinTimeoutMs);
      pinned = await lookupRecursivePin(args.api, publication.cid, pinTimeoutMs);
      assert.ok(pinned.present, `pin/add did not create a recursive pin for ${publication.cid}`);
      pinPreexisted = false;
    }
    pinProof = {
      api: args.api,
      checkedAt: new Date().toISOString(),
      endpoint: `/api/v0/pin/ls?arg=${publication.cid}&type=recursive`,
      type: pinned.type,
      response: pinned.response,
      preexisting: pinPreexisted,
    };
    // This is written before a gateway request.  If a later proof or artifact
    // transaction fails, the recursive pin remains deliberately and this
    // exact receipt lets the next invocation retry the same CID safely.
    writePendingPinReceipt(publication.cid, "proven-pending", pinProof);
    process.stdout.write(`CID ${publication.cid} pinned ${pinned.type}\n`);
  } catch (error) {
    await abortPublication(error);
  }
}

// ── THE $DTT CATALOGUE RECORD ──────────────────────────────────────────────
//
// The tileset epoch's identity as a record, so a node learns which directory
// is current from the dataset lane rather than from a hostname or a config an
// operator retyped. Themis: this MINTS NOTHING — every field below is a $DTT
// field carrying what the IDL says it carries. The mapping is written out in
// IPFS-DELIVERY.md and rendered here with IDL-EXACT KEYS.
//
// The discriminator between the catalogue record and a tile record is
// PAYLOAD.MEDIA_TYPE: a tile's payload is one quantized mesh
// (application/vnd.quantized-mesh), the catalogue's is the DIRECTORY those
// tiles live in (application/vnd.ipld.dag-pb). It is a stated field carrying a
// real difference, not a sentinel.
//
// THE ADDRESS AND THE EXTENT USED TO CONTRADICT EACH OTHER. This stated
// GEOGRAPHIC_WGS84 with LEVEL/X/Y 0/0/0 and WEST/EAST -180/180 — and under
// that scheme the IDL defines level 0 as TWO root tiles covering [-180,0] and
// [0,180], so the address named HALF of the extent the record spelled out. A
// consumer doing the ordinary thing with a $DTT (derive the extent from the
// address and the scheme) got a different answer from the record's own fields.
//
// The catalogue is not a tile: it has no address in any scheme. TILING_SCHEME
// is UNSPECIFIED — ordinal 0, which the IDL reserves so "an unset field can
// never be read as a real scheme" — LEVEL/X/Y are not stated, and the extent
// is the pyramid's OWN bounding box as verify.mjs measured it from the
// addresses actually built. The scheme of the tiles INSIDE is declared by the
// layer.json in the directory, which is where a terrain provider reads it.
function buildCatalogue(cid) {
  const extent =
    layerConfig.terrain_west_deg !== undefined
      ? {
          WEST_DEG: layerConfig.terrain_west_deg,
          SOUTH_DEG: layerConfig.terrain_south_deg,
          EAST_DEG: layerConfig.terrain_east_deg,
          NORTH_DEG: layerConfig.terrain_north_deg,
        }
      : {};
  return {
    TILESET_ID: tilesetId,
    TILESET_NAME: layerConfig.terrain_description || tilesetId,
    TILING_SCHEME: "UNSPECIFIED",
    ...extent,
    PAYLOAD_FORMAT: "QUANTIZED_MESH",
    PAYLOAD_FORMAT_VERSION: "1.0",
    // PAYLOAD is `required`: present and empty when there is no directory to
    // name, which is a record the builder can serialize and a document a
    // client reads as "this publisher is serving no IPFS tileset".
    PAYLOAD: cid
      ? {
          CID: cid,
          SIZE_BYTES: totalBytes,
          MEDIA_TYPE: "application/vnd.ipld.dag-pb",
        }
      : {},
    MAX_LEVEL: maxzoom,
    WATER_MASK_KIND: "NONE",
    // Carried from the tiles, not asserted here: the tileset record and its
    // tiles must state the SAME datum, and the catalogue is one of only two
    // documents a client on the IPFS path reads.
    VERTICAL_DATUM: "GEOID",
    VERTICAL_DATUM_NAME: first.verticalDatumName,
    REMARKS: first.remarks,
    PROVENANCE: {
      ...provenance.raw,
      // A tileset is cut from thousands of granules; the tile's granule-level
      // source fields would name exactly one of them.
      SOURCE_URL: undefined,
      SOURCE_QUERY: undefined,
      // DATASET_CID IS NOT THE TILESET. It used to be set to `cid` — the
      // directory this file publishes — so the two clients, which read two
      // different fields, agreed only because one implementation duplicated
      // the value. The IDL is explicit that DATASET_CID is "the exact dataset
      // artifact" the publisher distributes, i.e. the SOURCE DEM; a
      // provenance-complete record that put the real Copernicus artifact
      // there would have pointed a reader of that field at a non-tileset CID
      // and 404-ed every tile from a valid record. The tileset directory is
      // PAYLOAD.CID above, and it is the ONLY field either client reads for
      // it. Nothing here knows a source-artifact CID, so nothing is stated.
      GENERATED_AT: new Date().toISOString(),
      PROCESSOR: "tools/terrain-pyramid/ipfs-publish.mjs",
    },
  };
}

let catalogue;
try {
  catalogue = buildCatalogue(publication?.cid ?? null);
} catch (error) {
  await abortPublication(error);
}
attemptJournal = { ...attemptJournal, phase: "artifacts" };
writeAttemptJournal(attemptJournal);
const stagedPublicationArtifacts = [];

// The same record as SDS wire bytes, size-prefixed exactly like tiles.dttstream,
// so the dataset-publication lane ingests it with the tiles and nothing has to
// re-encode a JSON rendering into a record.
//
// WRITTEN UNCONDITIONALLY, AND THROUGH THE SHARED PROJECTOR. It used to be
// hand-transcribed field by field and only when a CID existed, which is how
// the two "identical" projections drifted: this one carried RETRIEVED_AT and
// the serving module's did not, and neither side had ever built the other's.
// dtt-projection.mjs is now the only place a $DTT JSON projection becomes a
// record, it REFUSES any key the IDL does not define, and writeFB is what
// enforces `required` — so the JSON beside these bytes cannot be a document
// that is not also a record.
{
  try {
    stagedPublicationArtifacts.push({
      live: path.join(outDir, "tileset-catalogue.json"),
      staged: stageArtifact(path.join(outDir, "tileset-catalogue.json"), `${JSON.stringify(catalogue, null, 2)}\n`),
    });
    const sds = await import(path.join(SOURCE_DIR, "node_modules", "spacedatastandards.org", "index.js"));
    const bytes = writeDttRecord(sds, catalogue);
    stagedPublicationArtifacts.push({
      live: path.join(outDir, "tileset-catalogue.dttstream"),
      staged: stageArtifact(path.join(outDir, "tileset-catalogue.dttstream"), bytes),
    });
    // And it reads back as the record the JSON says it is.
    const [read] = sds.readFB(bytes);
    assert.equal(read.TILESET_ID, catalogue.TILESET_ID);
    assert.equal(read.PROVENANCE.RETRIEVED_AT, catalogue.PROVENANCE.RETRIEVED_AT);
    assert.equal(read.PAYLOAD.CID ?? null, catalogue.PAYLOAD.CID ?? null);
    // Not just "buildDttRecord accepted it": the projection is what the SERVING
    // MODULE has to be able to answer too, so the shape is exercised here rather
    // than only where a wasm is loaded.
    assert.ok(buildDttRecord(sds, catalogue));
  } catch (error) {
    await abortPublication(error);
  }
}

// ── READ THE PUBLICATION BACK THROUGH THE GATEWAY ──────────────────────────
//
// Not "the add returned 200" — the proof is that the bytes a browser will ask
// for come back, with the headers a browser will cache them under, from the
// public path. layer.json and three tiles: the shallowest, the deepest, and
// one synthesized, because those are the three ways a tile gets into the
// directory and only one of them is the ordinary way.
async function fetchThroughGateway(cid, rel) {
  const url = `${args.gateway}/ipfs/${cid}/${rel}`;
  const started = Date.now();
  assertSafeRelativePath(rel, "gateway staged path");
  const localPath = path.resolve(stagingDir, rel);
  assert.ok(localPath.startsWith(`${stagingDir}${path.sep}`), `gateway staged path escapes ${stagingDir}`);
  const local = readBoundedRegularFile(
    localPath,
    rel === "layer.json" ? MAX_LAYER_JSON_BYTES : STATIC_TRANSPORT_BOUNDS.hard,
    `gateway local ${rel}`,
  );
  const expectedContentType = rel === "layer.json" ? "application/json" : "application/octet-stream";
  const initial = await withRequest(
    url,
    { method: "GET", headers: { "accept-encoding": "identity" } },
    `gateway GET ${rel}`,
    async (response, controller) => {
    assert.ok(response.status >= 200 && response.status < 300, `gateway ${rel}: expected 2xx, got HTTP ${response.status}`);
    const bytes = await readResponseBytes(response, local.length, `gateway ${rel}`, controller, local.length);
    const etag = response.headers.get("etag");
    const cacheControl = response.headers.get("cache-control");
    const contentType = response.headers.get("content-type");
    const contentEncoding = response.headers.get("content-encoding");
    const accessControlAllowOrigin = response.headers.get("access-control-allow-origin");
    assert.ok(etag, `gateway ${rel}: missing ETag`);
    assert.match(cacheControl ?? "", /(?:^|,)\s*public(?:,|$)/i, `gateway ${rel}: Cache-Control must be public`);
    assert.match(cacheControl ?? "", /(?:^|,)\s*immutable(?:,|$)/i, `gateway ${rel}: Cache-Control must be immutable`);
    assert.match(cacheControl ?? "", /max-age=\d+/i, `gateway ${rel}: Cache-Control must state max-age`);
    assert.equal(contentType?.split(";", 1)[0].trim().toLowerCase(), expectedContentType, `gateway ${rel}: unexpected Content-Type`);
    assert.ok(!contentEncoding || contentEncoding.toLowerCase() === "identity", `gateway ${rel}: content must be identity`);
    assert.equal(accessControlAllowOrigin, "*", `gateway ${rel}: Access-Control-Allow-Origin must be *`);
    assert.ok(bytes.equals(local), `gateway ${rel}: body differs from the staged file`);
    return {
      status: response.status,
      bytes,
      etag,
      cacheControl,
      contentType,
      contentEncoding,
      accessControlAllowOrigin,
    };
    },
  );
  const conditional = await withRequest(
    url,
    { method: "GET", headers: { "if-none-match": initial.etag, "accept-encoding": "identity" } },
    `gateway conditional GET ${rel}`,
    async (response, controller) => {
      assert.equal(response.status, 304, `gateway ${rel}: conditional request must return 304`);
      const body = await readResponseBytes(response, 0, `gateway conditional GET ${rel}`, controller, 0);
      assert.equal(body.length, 0, `gateway ${rel}: 304 response must not include a body`);
      return response.status;
    },
  );
  return {
    url,
    status: initial.status,
    bytes: initial.bytes.length,
    ms: Date.now() - started,
    contentType: initial.contentType,
    cacheControl: initial.cacheControl,
    etag: initial.etag,
    contentEncoding: initial.contentEncoding,
    accessControlAllowOrigin: initial.accessControlAllowOrigin,
    conditionalStatus: conditional,
    matchesLocal: true,
  };
}

const gatewayProof = [];
if (publication?.cid && args.verify) {
  const probes = ["layer.json", `${shallowStored}.terrain`, `${deepStored}.terrain`];
  if (lastSynthesized) probes.push(`${lastSynthesized}.terrain`);
  try {
    for (const rel of probes) gatewayProof.push(await fetchThroughGateway(publication.cid, rel));
  } catch (error) {
    await abortPublication(error);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  outDir,
  ipfsDir,
  tilesetId,
  datasetEpoch: provenance.raw.DATASET_EPOCH,
  maxzoom,
  api: args.add ? args.api : null,
  // The pin's own evidence, or an explicit null saying nothing checked it on
  // this run. `--cid` never touches the API, and a report that reads `"api":
  // null` beside a claim of "added and pinned" is a claim with no proof in it.
  pinProof,
  cid: publication?.cid ?? null,
  layerJsonCid: publication?.layerJsonCid ?? null,
  files: fileCount,
  materializationPlan: {
    files: materializationPlan.files,
    plannedDirectoryRows: materializationPlan.directoryRows.toString(),
    storedFiles: materializationPlan.storedFiles,
    synthesizedFiles: materializationPlan.synthesizedFiles,
    decodedStoredBytes: materializationPlan.decodedStoredBytes,
    approvedStaticDirectoryBytes: publicationPolicy.maxStaticDirectoryBytes,
    approvedVerifiedStoreBytes: publicationPolicy.maxVerifiedStoreBytes,
    globalConfigDigest: authoritativeGlobalInputs.state.configDigest,
    stagingFreeBytes: stagingReservation.freeBytes.toString(),
    stagingRequiredBytes: stagingReservation.requiredBytes.toString(),
    stagingAllocationBlockBytes: stagingReservation.blockSize.toString(),
    approvedStaticLogicalBytes: stagingReservation.approvedLogicalBytes.toString(),
    reservedStaticPhysicalBytes: stagingReservation.physicalStaticBytes.toString(),
    reservedPayloadRoundingBytes: stagingReservation.payloadRoundingBytes.toString(),
    reservedInodeAndDirectoryBytes: stagingReservation.inodeAndDirectoryBytes.toString(),
    reservedUploadManifestRows: stagingReservation.manifestRows.toString(),
    actualStaticPhysicalUpperBytes: actualStaticPhysicalUpperBytes?.toString() ?? null,
    reservedUploadManifestPhysicalBytes: stagingReservation.manifestPhysicalBytes.toString(),
    reservedStagingHeadroomBytes: stagingReservation.headroomBytes.toString(),
  },
  storedTiles,
  synthesizedTiles,
  // What the synthesized half STATES about water. Before the ocean skips were
  // declared this read 0 water / 36 land on a coastal region.
  synthesizedUniformWater: synthesizedWater,
  synthesizedUniformLand: synthesizedLand,
  oceanSkipsDeclared,
  lastSynthesizedAddress: lastSynthesized,
  layerJsonBytes: layerJson.length,
  directoryBytes: totalBytes,
  directoryMiB: Number((totalBytes / 1048576).toFixed(2)),
  // The pyramid is served identity over IPFS, so the wire size is the
  // UNCOMPRESSED distribution; the gzipped one is what the mount lane served
  // and is kept beside it so the cost of the move is a number, not a claim.
  tileBytesIdentity: { ...staticIdentity, bounds: STATIC_TRANSPORT_BOUNDS },
  tileBytesGzipped: { p50: gzipSizes.percentile(0.5), p99: gzipSizes.percentile(0.99), max: gzipSizes.max() },
  uniformMasks,
  rasterMasks,
  uniformMaskRatio: Number((uniformMasks / (uniformMasks + rasterMasks)).toFixed(4)),
  encoderTiles: publicationInputs.tiles.entry.records,
  gatewayProof,
  catalogue,
  // What an operator installs on the serving mount so clients resolve this CID.
  //
  // These are the keys the mount needs to answer /tileset.json AS A RECORD.
  // DTTProvenance marks DATASET_ID, DATASET_EPOCH, RETRIEVED_AT and LICENSE
  // required; the mount used to be given only the epoch, so the document it
  // answered could not be built into a $DTT at all — and a mount that is
  // given less than this now refuses to publish a catalogue rather than
  // answering 200 with something that is not a record.
  // ONLY the keys that name THIS PUBLICATION. The lineage keys moved to
  // layer-json-config.json, which verify.mjs writes and which mount-entry.json
  // already names as the source of the module `config:` block — they describe
  // the STORE, they exist before any CID does, and duplicating them into a
  // second file is how the ship step ended up installing a mount that had the
  // epoch and none of the other three required fields.
  mountConfig: publication?.cid
    ? {
        terrain_tileset_cid: publication.cid,
        terrain_tileset_size_bytes: totalBytes,
        terrain_gateway_path: "/ipfs/",
      }
    : null,
};
try {
  stagedPublicationArtifacts.push({
    live: path.join(outDir, "ipfs-publication.json"),
    staged: stageArtifact(path.join(outDir, "ipfs-publication.json"), `${JSON.stringify(report, null, 2)}\n`),
  });
  if (publication?.cid) {
    stagedPublicationArtifacts.push({
      live: path.join(outDir, "serving-config-ipfs.json"),
      staged: stageArtifact(
        path.join(outDir, "serving-config-ipfs.json"),
        `${JSON.stringify({ ...layerConfig, ...report.mountConfig }, null, 2)}\n`,
      ),
    });
    // A transaction that exposed the directory, catalogue, report and serving
    // pointer has consumed the recovery receipt.  Until this exact point it
    // stays live so a crash or a gateway failure leaves retry evidence.
    if (lstatIfExists(pendingPinPath, "pending IPFS pin receipt") !== null) {
      stagedPublicationArtifacts.push({ live: pendingPinPath, staged: null });
    }
  } else if (lstatIfExists(path.join(outDir, "serving-config-ipfs.json"), "serving IPFS config") !== null) {
    // A rehearsal has no verified CID.  Remove a prior serving pointer in the
    // same rollback-capable transaction rather than leaving it to name an old
    // directory beside a newly materialized rehearsal report.
    stagedPublicationArtifacts.push({ live: path.join(outDir, "serving-config-ipfs.json"), staged: null });
  }
  if (publication?.multipartPlan) await assertMultipartPlanStillMatches(publication.multipartPlan);
  commitStagedPublication(stagedPublicationArtifacts);
} catch (error) {
  await abortPublication(error);
}

process.stdout.write(
  `${report.files} files, ${report.directoryMiB} MiB, ${report.storedTiles} stored + ` +
    `${report.synthesizedTiles} synthesized tiles\n` +
    `identity p50 ${report.tileBytesIdentity.p50} B / p99 ${report.tileBytesIdentity.p99} B ` +
    `(gzipped p50 ${report.tileBytesGzipped.p50} B / p99 ${report.tileBytesGzipped.p99} B)\n`,
);
for (const probe of gatewayProof) {
  process.stdout.write(
    `  ${probe.status} ${probe.url} ${probe.bytes} B ${probe.ms} ms ` +
      `cc=${probe.cacheControl} inm=${probe.conditionalStatus} same=${probe.matchesLocal}\n`,
  );
}
if (report.cid) process.stdout.write(`\nCID ${report.cid}\n`);
