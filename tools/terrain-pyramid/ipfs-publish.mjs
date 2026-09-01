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
import { iterateStreamFile, readDtt, readDttProvenance } from "./dtt-reader.mjs";

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
const MAX_MATERIALIZED_BYTES = 1024 * 1024 * 1024 * 1024;
const STAGING_HEADROOM_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_LINE_BYTES = 64 * 1024;
const MAX_RECEIPT_NAME_BYTES = 4 * 1024;
const MAX_RECEIPT_HASH_BYTES = 256;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const MAX_WORKLIST_LINE_BYTES = 1024;
const MAX_LEGACY_WORKLIST_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_WORKLIST_ADDRESSES = 100_000;
const MAX_OCEAN_DIAGNOSTICS = 8;
const OCEAN_SKIP_MAX_RECEIPT_BYTES = 64 * 1024;
const OCEAN_SKIP_MAX_LINES_BYTES = 512 * 1024 * 1024;
const OCEAN_SKIP_MAX_LINE_BYTES = 256;
const TERRAIN_ADDRESS_FIELD_WIDTH = 12;

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
    reserveFreeBytes: 0n,
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
    else if (flag === "--reserve-free-bytes") args.reserveFreeBytes = parseByteCount(argv[++i], "--reserve-free-bytes");
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

// ── THE RUN HAS TO HAVE PASSED ─────────────────────────────────────────────
const verifyPath = path.join(outDir, "verify-report.json");
assert.ok(
  fs.existsSync(verifyPath),
  `run verify.mjs first: ${verifyPath} does not exist. A CID is permanent; an ` +
    "unverified pyramid published under one cannot be withdrawn from anyone " +
    "who has it.",
);
assert.ok(
  fs.statSync(verifyPath).size <= MAX_LEGACY_WORKLIST_BYTES,
  `verify report exceeds legacy safety cap ${MAX_LEGACY_WORKLIST_BYTES} bytes; use its streamed worklist path`,
);
const verifyReport = JSON.parse(fs.readFileSync(verifyPath, "utf8"));
assert.deepEqual(
  verifyReport.problems,
  [],
  `verify.mjs reported ${verifyReport.problems?.length ?? "?"} unmet bounds; fix them before publishing`,
);
assert.ok(
  Array.isArray(verifyReport.availableButUnstoredAddresses) || typeof verifyReport.availableButUnstoredPath === "string",
  "the verify report predates the streamed available-but-unstored worklist; re-run verify.mjs",
);

function outputFile(relative, label) {
  assert.equal(typeof relative, "string", `${label} path must be a string`);
  const resolved = path.resolve(outDir, relative);
  assert.ok(resolved.startsWith(`${outDir}${path.sep}`), `${label} path escapes the builder output`);
  return resolved;
}

async function* boundedLines(file, maxLineBytes, label) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    pending += decoder.write(Buffer.from(chunk));
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

async function* availableButUnstored() {
  if (Array.isArray(verifyReport.availableButUnstoredAddresses)) {
    assert.ok(
      verifyReport.availableButUnstoredAddresses.length <= MAX_LEGACY_WORKLIST_ADDRESSES,
      `legacy available-but-unstored array exceeds ${MAX_LEGACY_WORKLIST_ADDRESSES} addresses; use NDJSON`,
    );
    for (const address of verifyReport.availableButUnstoredAddresses) yield address;
    return;
  }
  const file = outputFile(verifyReport.availableButUnstoredPath, "verify worklist");
  assert.ok(fs.existsSync(file), `verify worklist missing: ${file}`);
  yield* boundedLines(file, MAX_WORKLIST_LINE_BYTES, "available-but-unstored worklist");
}

function compareTerrainAddress(a, b) {
  const left = terrainAddressOrderKey(a);
  const right = terrainAddressOrderKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

async function* arrayEntries(entries) {
  yield* entries;
}

function oceanReceiptPath() {
  return path.join(outDir, "ocean-skipped.json");
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

function readOceanReceiptOrLegacy() {
  const receiptPath = oceanReceiptPath();
  if (!fs.existsSync(receiptPath)) return { kind: "none" };
  const stat = fs.lstatSync(receiptPath, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `ocean skip receipt is not a regular file: ${receiptPath}`);
  assert.ok(stat.size <= BigInt(OCEAN_SKIP_MAX_LINES_BYTES), `ocean skip input exceeds ${OCEAN_SKIP_MAX_LINES_BYTES} bytes: ${receiptPath}`);
  // The exact receipt is deliberately tiny.  An oversized JSON document is
  // never interpreted as a legacy array, because that would quietly turn the
  // compact global contract back into an unbounded in-memory payload.
  assert.ok(stat.size <= BigInt(MAX_LEGACY_WORKLIST_BYTES), `ocean skip receipt exceeds ${MAX_LEGACY_WORKLIST_BYTES} bytes`);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`ocean skip receipt is invalid JSON: ${receiptPath}`, { cause: error });
  }
  if (Object.hasOwn(document ?? {}, "format")) {
    assert.ok(stat.size <= BigInt(OCEAN_SKIP_MAX_RECEIPT_BYTES), `ocean skip receipt exceeds ${OCEAN_SKIP_MAX_RECEIPT_BYTES} bytes`);
    return { kind: "receipt", receipt: assertOceanReceipt(document) };
  }
  assert.ok(document && typeof document === "object" && !Array.isArray(document), "legacy ocean skip document must be an object");
  const addresses = document.addresses;
  assert.ok(Array.isArray(addresses), "legacy ocean skip list addresses must be an array");
  assert.ok(addresses.length <= MAX_LEGACY_WORKLIST_ADDRESSES, `legacy ocean skip list exceeds ${MAX_LEGACY_WORKLIST_ADDRESSES} addresses; use the compact receipt`);
  if (document.count !== undefined) assert.equal(document.count, addresses.length, "legacy ocean skip receipt count disagrees with addresses");
  addresses.sort(compareTerrainAddress);
  return { kind: "legacy", addresses };
}

async function* exactOceanReceiptLines(receipt) {
  const linesPath = outputFile(receipt.addressesPath, "ocean skip receipt");
  assert.equal(linesPath, path.join(outDir, "ocean-skipped.lines"), "ocean skip receipt path is not contained in this output");
  const stat = fs.lstatSync(linesPath, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `ocean skip receipt target is not a regular file: ${linesPath}`);
  const countBound = BigInt(receipt.count) * BigInt(OCEAN_SKIP_MAX_LINE_BYTES + 1);
  const statBound = countBound < BigInt(OCEAN_SKIP_MAX_LINES_BYTES) ? countBound : BigInt(OCEAN_SKIP_MAX_LINES_BYTES);
  assert.ok(stat.size <= statBound, `ocean skip address list exceeds its declared byte bound: ${linesPath}`);

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
  const stream = fs.createReadStream(linesPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
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
  } finally {
    stream.destroy();
  }
  assert.equal(count, receipt.count, "ocean skip receipt count disagrees with streamed worklist");
  assert.equal(hash.digest("hex"), receipt.digest, "ocean skip receipt digest disagrees with streamed worklist");
}

async function oceanSkipJoiner() {
  const input = readOceanReceiptOrLegacy();
  let declaredByReceipt = 0;
  let source;
  if (input.kind === "receipt") {
    source = exactOceanReceiptLines(input.receipt);
    declaredByReceipt = input.receipt.count;
  } else if (input.kind === "legacy") {
    source = arrayEntries(input.addresses);
    declaredByReceipt = input.addresses.length;
  } else {
    source = arrayEntries([]);
  }

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

const layerConfig = JSON.parse(fs.readFileSync(path.join(outDir, "layer-json-config.json"), "utf8"));
const runReport = JSON.parse(fs.readFileSync(path.join(outDir, "run-report.json"), "utf8"));
const recordsPath = path.join(outDir, "tiles.dttstream");
let firstRecord = null;
for await (const record of iterateStreamFile(recordsPath)) { firstRecord = Buffer.from(record); break; }
assert.ok(firstRecord, "the store holds no records");

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

const identityBody = (http) =>
  headerOf(http, "content-encoding").toLowerCase() === "gzip"
    ? zlib.gunzipSync(Buffer.from(http.body))
    : Buffer.from(http.body);

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
  return identityBody(http);
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
  return identityBody(http);
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

// Count and bound the output before a staging directory is made.  A static
// directory needs room beside an already-complete one, so this is an upper
// bound rather than a hopeful post-write observation: stored files are sized
// exactly and synthesized files reserve their transport hard cap.
async function precomputeMaterializationPlan() {
  let storedFiles = 0;
  let storedBytes = 0;
  for await (const record of iterateStreamFile(recordsPath)) {
    const dtt = readDtt(record);
    assert.ok(dtt.payload?.bytes, `${dtt.level}/${dtt.x}/${dtt.y}: record carries no payload bytes`);
    const stored = Buffer.from(dtt.payload.bytes);
    const body =
      (dtt.payload.contentEncoding ?? "").toLowerCase() === "gzip" ? zlib.gunzipSync(stored) : stored;
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
  const byteUpperBound = BigInt(layerJson.length + storedBytes) +
    BigInt(synthesizedFiles) * BigInt(STATIC_TRANSPORT_BOUNDS.hard);
  assert.ok(files <= MAX_MATERIALIZED_FILES, `materialization plans ${files} files; hard limit is ${MAX_MATERIALIZED_FILES}`);
  assert.ok(
    byteUpperBound <= BigInt(MAX_MATERIALIZED_BYTES),
    `materialization reserves ${byteUpperBound} bytes; hard limit is ${MAX_MATERIALIZED_BYTES}`,
  );
  return { files, storedFiles, synthesizedFiles, byteUpperBound };
}

function reserveStagingSpace(plan) {
  const stats = fs.statfsSync(outDir, { bigint: true });
  const freeBytes = stats.bavail * stats.bsize;
  const requiredBytes = plan.byteUpperBound + BigInt(STAGING_HEADROOM_BYTES) + args.reserveFreeBytes;
  assert.ok(
    freeBytes >= requiredBytes,
    `insufficient free space for staged IPFS directory: need ${requiredBytes} bytes, have ${freeBytes}`,
  );
  return { freeBytes, requiredBytes };
}

// ── MATERIALIZE ────────────────────────────────────────────────────────────
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
  stagedArtifactPaths.add(stagedPath);
  return stagedPath;
}

function discardStagedArtifacts() {
  for (const stagedPath of stagedArtifactPaths) {
    if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true });
  }
  stagedArtifactPaths.clear();
}

// Each old target is first moved to an attempt-token sibling.  Only after all
// staged replacements are live are those prior copies removed; any intervening
// failure restores every old target and leaves the completed ipfs/ untouched.
function commitStagedPublication(artifacts) {
  const replacements = [{ live: ipfsDir, staged: stagingDir }, ...artifacts];
  const backups = [];
  const installed = [];
  try {
    for (const replacement of replacements) {
      const backup = path.join(outDir, `.${path.basename(replacement.live)}-previous-${attemptToken}`);
      if (fs.existsSync(replacement.live)) {
        fs.renameSync(replacement.live, backup);
        backups.push({ live: replacement.live, backup });
      }
    }
    for (const replacement of replacements) {
      if (replacement.staged === null) continue;
      fs.renameSync(replacement.staged, replacement.live);
      installed.push(replacement);
      stagedArtifactPaths.delete(replacement.staged);
    }
  } catch (error) {
    for (const replacement of [...installed].reverse()) {
      if (fs.existsSync(replacement.live)) {
        fs.renameSync(replacement.live, replacement.staged);
        if (replacement.staged !== stagingDir) stagedArtifactPaths.add(replacement.staged);
      }
    }
    for (const { live, backup } of [...backups].reverse()) {
      if (fs.existsSync(backup)) fs.renameSync(backup, live);
    }
    throw error;
  }
  for (const { backup } of backups) {
    // Completion already succeeded; a cleanup fault preserves the old sibling
    // instead of deleting either valid completed state.
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      // The unique sibling is recoverable and intentionally left in place.
    }
  }
}

let fileCount = 0;
let totalBytes = 0;
const write = (rel, bytes) => {
  const full = path.join(stagingDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
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
for await (const record of iterateStreamFile(recordsPath)) {
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
    (dtt.payload.contentEncoding ?? "").toLowerCase() === "gzip" ? zlib.gunzipSync(stored) : stored;
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
assert.ok(BigInt(totalBytes) <= materializationPlan.byteUpperBound, "materialized bytes exceed the reserved bound");
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
  const descriptor = fs.openSync(manifestPath, "wx", 0o600);
  attemptScratchPaths.add(manifestPath);
  let expectedFiles = 0;
  let contentLength = 0n;
  try {
    for (const file of sortedRegularFiles(directory)) {
      const name = `${tilesetId}/${file.rel}`;
      const header = multipartHeader(boundary, name);
      const manifestEntry = { rel: file.rel, name, ...file.identity };
      const line = `${JSON.stringify(manifestEntry)}\n`;
      assert.ok(Buffer.byteLength(line) <= MAX_WORKLIST_LINE_BYTES, `upload manifest entry for ${file.rel} exceeds ${MAX_WORKLIST_LINE_BYTES} bytes`);
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
  return { manifestPath, expectedFiles, boundary, closing, contentLength };
}

async function* uploadManifestEntries(plan) {
  for await (const line of boundedLines(plan.manifestPath, MAX_WORKLIST_LINE_BYTES, "upload manifest")) {
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

async function withRequest(url, options, label, consume) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    return await consume(response, controller);
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out after ${args.timeoutMs} ms`, { cause: error });
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
  const expectedEntries = plan.expectedFiles + 1;
  const maxReceiptBytes = BigInt(expectedEntries) * BigInt(MAX_RECEIPT_LINE_BYTES + 1);
  declaredResponseLength(response, maxReceiptBytes, "kubo add receipt", controller);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let totalBytes = 0n;
  let entries = 0;
  let root = null;
  let layerEntry = null;
  const manifest = uploadManifestEntries(plan);
  let expected = await manifest.next();

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
    if (entries <= plan.expectedFiles) {
      assert.ok(!expected.done, "kubo add returned a file receipt after the manifest ended");
      assert.equal(entry.Name, expected.value.name, `kubo add receipt ${entries} is not the planned file`);
      if (entry.Name === `${tilesetId}/layer.json`) layerEntry = entry;
      expected = await manifest.next();
    } else {
      assert.ok(expected.done, "kubo add returned its root before every planned file receipt");
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
  assert.ok(expected.done, "kubo add omitted a planned file receipt");
  assert.ok(root, `kubo add returned no entry for the root directory ${tilesetId}`);
  assert.ok(layerEntry, `kubo add returned no entry for ${tilesetId}/layer.json`);
  return { cid: root.Hash, layerJsonCid: layerEntry.Hash, entries };
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
    );
  } finally {
    discardAttemptScratch();
  }
}

async function pinCreatedRoot(apiURL, cid) {
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

async function lookupRecursivePin(apiURL, cid) {
  return withRequest(
    `${apiURL.replace(/\/$/, "")}/api/v0/pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`,
    { method: "POST", headers: { "user-agent": "" } },
    "kubo pin/ls",
    async (response, controller) => {
      const text = await readResponseText(response, MAX_CONTROL_RESPONSE_BYTES, "kubo pin/ls", controller);
      if (response.status === 404) return { present: false, type: null, response: text };
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
  );
}

function assertBoundedString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(Buffer.byteLength(value) <= MAX_CONTROL_RESPONSE_BYTES, `${label} exceeds ${MAX_CONTROL_RESPONSE_BYTES} bytes`);
  return value;
}

function assertPendingPinReceipt(receipt) {
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt), "pending IPFS pin receipt must be an object");
  const allowed = new Set(["format", "cid", "pinProof", "preexisting", "attempt", "recordedAt"]);
  for (const key of Object.keys(receipt)) assert.ok(allowed.has(key), `pending IPFS pin receipt has unexpected field ${key}`);
  assert.equal(receipt.format, "terrain-ipfs-pending-pin-v1", "pending IPFS pin receipt format is unsupported");
  assert.match(assertBoundedString(receipt.cid, "pending IPFS pin CID"), /^[A-Za-z0-9]+$/, "pending IPFS pin CID is not CID-shaped");
  assert.equal(typeof receipt.preexisting, "boolean", "pending IPFS pin preexisting must be boolean");
  assertBoundedString(receipt.attempt, "pending IPFS pin attempt");
  assertBoundedString(receipt.recordedAt, "pending IPFS pin time");
  assert.ok(Number.isFinite(Date.parse(receipt.recordedAt)), "pending IPFS pin time is invalid");
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
  const stat = fs.lstatSync(pendingPinPath, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `pending IPFS pin receipt is not a regular file: ${pendingPinPath}`);
  assert.ok(stat.size <= BigInt(MAX_CONTROL_RESPONSE_BYTES), `pending IPFS pin receipt exceeds ${MAX_CONTROL_RESPONSE_BYTES} bytes`);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(pendingPinPath, "utf8"));
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

function writePendingPinReceipt(cid, proof) {
  const receipt = {
    format: "terrain-ipfs-pending-pin-v1",
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
    // CIDs are deterministic, so inspect the recursive pin before calling
    // pin/add.  A later actor may race this point; we make no ownership claim
    // in either case and never issue pin/rm on an error path.
    const priorPin = await lookupRecursivePin(args.api, publication.cid);
    let pinned = priorPin;
    let pinPreexisted = priorPin.present;
    if (!priorPin.present) {
      await pinCreatedRoot(args.api, publication.cid);
      pinned = await lookupRecursivePin(args.api, publication.cid);
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
    writePendingPinReceipt(publication.cid, pinProof);
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
  const local = fs.readFileSync(path.join(stagingDir, rel));
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
    storedFiles: materializationPlan.storedFiles,
    synthesizedFiles: materializationPlan.synthesizedFiles,
    byteUpperBound: materializationPlan.byteUpperBound.toString(),
    stagingFreeBytes: stagingReservation.freeBytes.toString(),
    stagingRequiredBytes: stagingReservation.requiredBytes.toString(),
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
  encoderTiles: runReport.tiles,
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
