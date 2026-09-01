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

const outStat = fs.lstatSync(outDir, { bigint: true });
assert.ok(outStat.isDirectory() && !outStat.isSymbolicLink(), `builder output is not a real directory: ${outDir}`);

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
  assert.ok(file === outDir || file.startsWith(`${outDir}${path.sep}`), `${label} escapes the builder output`);
  const relative = path.relative(outDir, file);
  let current = outDir;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current, { bigint: true });
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

function readBoundedRegularFile(file, maxBytes, label, expectedIdentity = null) {
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
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedJson(file, maxBytes, label, expectedIdentity = null) {
  try {
    return JSON.parse(readBoundedRegularFile(file, maxBytes, label, expectedIdentity).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is invalid JSON: ${file}`, { cause: error });
    throw error;
  }
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

function policyDigest(policy) {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
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

function assertGlobalPolicyReceipt(receipt, approvedPolicy, label) {
  assertExactKeys(receipt, ["policy", "digest", "globalConfigDigest"], label);
  assert.equal(canonicalJson(receipt.policy), canonicalJson(approvedPolicy), `${label}.policy disagrees with approved run config publication_policy`);
  assert.equal(receipt.digest, policyDigest(approvedPolicy), `${label}.digest disagrees with approved run config publication_policy`);
  assert.equal(receipt.globalConfigDigest, publicationPolicy.globalConfigDigest, `${label}.globalConfigDigest disagrees with verify publicationPolicy`);
  assert.deepEqual(
    normalizeApprovedPublicationPolicy(receipt.policy, receipt.globalConfigDigest, `${label}.policy`),
    publicationPolicy,
    `${label}.policy normalized form disagrees with verify publicationPolicy`,
  );
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
  assertGlobalPolicyReceipt(state.publicationPolicy, approvedPolicy, "global build state publicationPolicy");
  const merged = state.merged;
  assert.ok(merged && typeof merged === "object" && !Array.isArray(merged), "global build state lacks merged completion receipt");
  assert.equal(merged.completion, "complete", "global merged receipt is not complete");
  assert.equal(merged.configDigest, publicationPolicy.globalConfigDigest,
    "global merged receipt configDigest disagrees with verify publicationPolicy");
  assert.equal(merged.approvedConfigPath, "approved-run-config.json", "global merged receipt names an unexpected approved config");
  assert.equal(merged.records, publicationInputs.tiles.entry.records,
    "global merged receipt record count disagrees with publicationInputs tiles");
  assertGlobalPolicyReceipt(merged.publicationPolicy, approvedPolicy, "global merged receipt publicationPolicy");
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
  // Static terrain paths have at most two parent directory rows (`z/x`) per
  // file.  This deliberately over-reserves repeated rows while avoiding an
  // in-memory set just to count them before materialization.
  const directoryRows = 1 + files * 2;
  assert.ok(Number.isSafeInteger(directoryRows), "materialization directory-row bound exceeds safe range");
  return { files, directoryRows, storedFiles, synthesizedFiles, decodedStoredBytes: storedBytes };
}

function reserveStagingSpace(plan) {
  const stats = fs.statfsSync(outDir, { bigint: true });
  const freeBytes = stats.bavail * stats.bsize;
  assert.ok(stats.bsize > 0n, "statfs returned an invalid allocation block size");
  const blockSize = stats.bsize;
  const fileCountBound = BigInt(plan.files);
  const directoryRowBound = BigInt(plan.directoryRows);
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
fs.mkdirSync(stagingDir, { recursive: false });
const stagedArtifactPaths = new Set();
const attemptScratchPaths = new Set();

function discardStagingDirectory() {
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
}

function discardAttemptScratch() {
  for (const scratchPath of attemptScratchPaths) {
    if (fs.existsSync(scratchPath)) fs.rmSync(scratchPath, { force: true });
  }
  attemptScratchPaths.clear();
}

function stageArtifact(livePath, bytes) {
  const stagedPath = path.join(outDir, `.${path.basename(livePath)}-staging-${attemptToken}`);
  fs.writeFileSync(stagedPath, bytes);
  const descriptor = fs.openSync(stagedPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(outDir);
  stagedArtifactPaths.add(stagedPath);
  return stagedPath;
}

function discardStagedArtifacts() {
  for (const stagedPath of stagedArtifactPaths) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true });
  }
  stagedArtifactPaths.clear();
}

function assertTransactionPath(value, label, nullable = false) {
  if (nullable && value === null) return null;
  assert.equal(typeof value, "string", `${label} must be a path`);
  assert.equal(path.dirname(value), outDir, `${label} leaves the builder output`);
  assert.ok(path.basename(value).startsWith("." ) || ["ipfs", "tileset-catalogue.json", "tileset-catalogue.dttstream", "ipfs-publication.json", "serving-config-ipfs.json", "pending-ipfs-pin.json"].includes(path.basename(value)),
    `${label} is not a publication transaction target`);
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

function writeTransactionJournal(journal) {
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  assert.ok(bytes.length <= MAX_CONTROL_RESPONSE_BYTES, "publication transaction journal exceeds safety cap");
  const temporary = path.join(outDir, `.ipfs-publication-transaction-${journal.attempt}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, transactionPath);
  fsyncDirectory(outDir);
}

function readTransactionJournal() {
  if (!fs.existsSync(transactionPath)) return null;
  const journal = readBoundedJson(transactionPath, MAX_CONTROL_RESPONSE_BYTES, "publication transaction journal");
  assertExactKeys(journal, ["format", "attempt", "backupProgress", "installProgress", "installingIndex", "replacements"], "publication transaction journal");
  assert.equal(journal.format, "terrain-ipfs-publication-transaction-v1", "unsupported publication transaction journal format");
  assert.equal(typeof journal.attempt, "string", "publication transaction attempt must be a string");
  assert.ok(Array.isArray(journal.replacements) && journal.replacements.length > 0 && journal.replacements.length <= 8,
    "publication transaction replacements are invalid");
  for (const replacement of journal.replacements) {
    assertExactKeys(replacement, ["backup", "hadLive", "live", "staged"], "publication transaction replacement");
    assertTransactionPath(replacement.live, "publication transaction live path");
    assertTransactionPath(replacement.staged, "publication transaction staged path", true);
    assertTransactionPath(replacement.backup, "publication transaction backup path");
    assert.equal(typeof replacement.hadLive, "boolean", "publication transaction hadLive must be boolean");
  }
  for (const field of ["backupProgress", "installProgress"]) {
    assert.ok(Number.isSafeInteger(journal[field]) && journal[field] >= 0 && journal[field] <= journal.replacements.length,
      `publication transaction ${field} is invalid`);
  }
  assert.ok(
    journal.installingIndex === null ||
      (Number.isSafeInteger(journal.installingIndex) && journal.installingIndex >= journal.installProgress && journal.installingIndex < journal.replacements.length),
    "publication transaction installingIndex is invalid",
  );
  return journal;
}

function removePublicationPath(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function finishPublicationTransaction(journal) {
  for (const replacement of journal.replacements) {
    removePublicationPath(replacement.backup);
    if (replacement.staged !== null) removePublicationPath(replacement.staged);
  }
  fsyncDirectory(outDir);
  if (fs.existsSync(transactionPath)) fs.rmSync(transactionPath, { force: true });
  fsyncDirectory(outDir);
}

function recoverPublicationTransaction() {
  const journal = readTransactionJournal();
  if (!journal) return;
  if (journal.installProgress === journal.replacements.length && journal.installingIndex === null) {
    finishPublicationTransaction(journal);
    return;
  }
  // `installingIndex` is written and fsynced *before* its staged->live rename.
  // Therefore a crash after that rename but before installProgress is durable
  // has an unambiguous recovery state: treat that one replacement as installed
  // long enough to remove its new live object before restoring its backup.
  const effectiveInstallProgress = Math.max(
    journal.installProgress,
    journal.installingIndex === null ? 0 : journal.installingIndex + 1,
  );
  for (let index = journal.replacements.length - 1; index >= 0; index -= 1) {
    const replacement = journal.replacements[index];
    if (index < effectiveInstallProgress && replacement.staged !== null) removePublicationPath(replacement.live);
    if (replacement.hadLive && fs.existsSync(replacement.backup)) fs.renameSync(replacement.backup, replacement.live);
    else if (!replacement.hadLive) removePublicationPath(replacement.live);
    if (replacement.staged !== null) removePublicationPath(replacement.staged);
    fsyncDirectory(outDir);
  }
  if (fs.existsSync(transactionPath)) fs.rmSync(transactionPath, { force: true });
  fsyncDirectory(outDir);
}

function maybeCrashTransaction(phase) {
  if (args.testCrashAt !== phase) return;
  process.stderr.write(`test crash injected at ${phase}\n`);
  process.exit(86);
}

// Each transition is persisted before the next rename. A later invocation
// rolls an interrupted partial install back, or rolls a fully installed one
// forward by deleting only its journal-declared backups.
function commitStagedPublication(artifacts) {
  const replacements = [{ live: ipfsDir, staged: stagingDir }, ...artifacts].map((replacement) => ({
    live: assertTransactionPath(replacement.live, "publication live path"),
    staged: replacement.staged === null ? null : assertTransactionPath(replacement.staged, "publication staged path"),
    backup: path.join(outDir, `.${path.basename(replacement.live)}-previous-${attemptToken}`),
    hadLive: fs.existsSync(replacement.live),
  }));
  fsyncTree(stagingDir);
  for (const replacement of replacements) if (replacement.staged !== null && replacement.staged !== stagingDir) fsyncTree(replacement.staged);
  fsyncDirectory(outDir);
  const journal = {
    format: "terrain-ipfs-publication-transaction-v1",
    attempt: attemptToken,
    backupProgress: 0,
    installProgress: 0,
    installingIndex: null,
    replacements,
  };
  writeTransactionJournal(journal);
  try {
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      if (replacement.hadLive) fs.renameSync(replacement.live, replacement.backup);
      journal.backupProgress = index + 1;
      writeTransactionJournal(journal);
      maybeCrashTransaction(`backup-${index + 1}`);
    }
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      // Persist the exact ambiguous boundary first.  Recovery can distinguish
      // a rename that happened before installProgress was advanced from one
      // that did not, and can restore a nonempty prior directory idempotently.
      journal.installingIndex = index;
      writeTransactionJournal(journal);
      if (replacement.staged !== null) {
        fs.renameSync(replacement.staged, replacement.live);
        stagedArtifactPaths.delete(replacement.staged);
      }
      maybeCrashTransaction(`install-renamed-${index + 1}`);
      journal.installProgress = index + 1;
      journal.installingIndex = null;
      writeTransactionJournal(journal);
      maybeCrashTransaction(`install-${index + 1}`);
    }
  } catch (error) {
    recoverPublicationTransaction();
    throw error;
  }
  finishPublicationTransaction(journal);
}

let fileCount = 0;
let totalBytes = 0;
const write = (rel, bytes) => {
  const full = path.join(stagingDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  assert.ok(BigInt(totalBytes) + BigInt(bytes.length) <= BigInt(publicationPolicy.maxStaticDirectoryBytes),
    `static directory would exceed approved ${publicationPolicy.maxStaticDirectoryBytes} bytes`);
  fs.writeFileSync(full, bytes);
  fileCount += 1;
  totalBytes += bytes.length;
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
  (BigInt(fileCount) + BigInt(materializationPlan.directoryRows)) * stagingReservation.blockSize;
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
  assert.ok(stat.isFile(), `${full} is not a regular file`);
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function sameIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.size === expected.size && actual.mtimeNs === expected.mtimeNs;
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
  const manifestPath = path.join(outDir, `.ipfs-upload-manifest-${attemptToken}.ndjson`);
  const directoryManifestPath = path.join(outDir, `.ipfs-upload-directories-${attemptToken}.ndjson`);
  const descriptor = fs.openSync(manifestPath, "wx", 0o600);
  attemptScratchPaths.add(manifestPath);
  attemptScratchPaths.add(directoryManifestPath);
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
    fs.closeSync(descriptor);
  }
  const closing = Buffer.from(`--${boundary}--\r\n`);
  contentLength += BigInt(closing.length);
  assert.equal(expectedFiles, fileCount, "materialized file count changed before multipart planning");
  assert.ok(contentLength <= BigInt(Number.MAX_SAFE_INTEGER), "multipart Content-Length exceeds fetch's safe range");
  // Kubo emits UnixFS intermediate-directory receipts as it closes branches.
  // A second deterministic walk writes their post-order sequence to disk;
  // only the active directory ancestry is retained (bounded by path depth).
  const directoryDescriptor = fs.openSync(directoryManifestPath, "wx", 0o600);
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
    fs.closeSync(directoryDescriptor);
  }
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
    for (const field of ["dev", "ino", "size", "mtimeNs"]) assert.match(entry[field] ?? "", /^\d+$/, `upload manifest ${field} is invalid`);
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
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    for await (const chunk of fs.createReadStream(current.full, { flags, highWaterMark: 64 * 1024 })) yield chunk;
    assert.ok(sameIdentity(fileIdentity(current.full), planned), `staged file ${current.rel} changed during multipart upload`);
    yield Buffer.from("\r\n");
    files += 1;
    expected = await manifest.next();
  }
  assert.ok(expected.done, "staged file was removed after multipart planning");
  assert.equal(files, plan.expectedFiles, "multipart upload file count changed after planning");
  yield plan.closing;
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
  try {
    return await withRequest(
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
  } finally {
    discardAttemptScratch();
  }
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
  if (!fs.existsSync(pendingPinPath)) return null;
  let receipt;
  try {
    receipt = JSON.parse(readBoundedRegularFile(pendingPinPath, MAX_CONTROL_RESPONSE_BYTES, "pending IPFS pin receipt").toString("utf8"));
  } catch (error) {
    throw new Error(`pending IPFS pin receipt is invalid JSON: ${pendingPinPath}`, { cause: error });
  }
  return assertPendingPinReceipt(receipt);
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
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
  const temporary = path.join(outDir, `.pending-ipfs-pin-${attemptToken}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, pendingPinPath);
    fsyncDirectory(outDir);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
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
    plannedDirectoryRows: materializationPlan.directoryRows,
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
    if (fs.existsSync(pendingPinPath)) {
      stagedPublicationArtifacts.push({ live: pendingPinPath, staged: null });
    }
  } else if (fs.existsSync(path.join(outDir, "serving-config-ipfs.json"))) {
    // A rehearsal has no verified CID.  Remove a prior serving pointer in the
    // same rollback-capable transaction rather than leaving it to name an old
    // directory beside a newly materialized rehearsal report.
    stagedPublicationArtifacts.push({ live: path.join(outDir, "serving-config-ipfs.json"), staged: null });
  }
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
