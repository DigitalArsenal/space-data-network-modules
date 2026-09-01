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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
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

function parseArgs(argv) {
  const args = {
    api: process.env.SDN_IPFS_API || "http://127.0.0.1:5002",
    gateway: "https://sdn.spaceaware.io",
    add: true,
    verify: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--out") args.out = argv[++i];
    else if (flag === "--api") args.api = argv[++i];
    else if (flag === "--gateway") args.gateway = argv[++i];
    else if (flag === "--no-add") args.add = false;
    // Re-emit the catalogue and the operator config for a directory that is
    // ALREADY published, without pushing 358 MiB through the tunnel again.
    // The materialized bytes are deterministic, so the CID is a fact about
    // them and re-asserting it costs nothing; --add would have proven it.
    else if (flag === "--cid") { args.cid = argv[++i]; args.add = false; }
    else if (flag === "--no-verify") args.verify = false;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.out) throw new Error("--out <builder output dir> is required");
  while (args.gateway.endsWith("/")) args.gateway = args.gateway.slice(0, -1);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
const ipfsDir = path.join(outDir, "ipfs");

// ── THE RUN HAS TO HAVE PASSED ─────────────────────────────────────────────
const verifyPath = path.join(outDir, "verify-report.json");
assert.ok(
  fs.existsSync(verifyPath),
  `run verify.mjs first: ${verifyPath} does not exist. A CID is permanent; an ` +
    "unverified pyramid published under one cannot be withdrawn from anyone " +
    "who has it.",
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

async function* availableButUnstored() {
  if (Array.isArray(verifyReport.availableButUnstoredAddresses)) {
    yield* verifyReport.availableButUnstoredAddresses;
    return;
  }
  const file = path.join(outDir, verifyReport.availableButUnstoredPath);
  assert.ok(fs.existsSync(file), `verify worklist missing: ${file}`);
  for await (const line of createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (line) yield line;
  }
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

// ── MATERIALIZE ────────────────────────────────────────────────────────────
fs.rmSync(ipfsDir, { recursive: true, force: true });
fs.mkdirSync(ipfsDir, { recursive: true });

let fileCount = 0;
let totalBytes = 0;
const write = (rel, bytes) => {
  const full = path.join(ipfsDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  fileCount += 1;
  totalBytes += bytes.length;
};

const layerJson = await renderLayerJson();
write("layer.json", layerJson);

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
const oceanSkipsDeclared = new Set(
  JSON.parse(
    fs.existsSync(path.join(outDir, "ocean-skipped.json"))
      ? fs.readFileSync(path.join(outDir, "ocean-skipped.json"), "utf8")
      : '{"addresses":[]}',
  ).addresses ?? [],
);
const oceanSkipsServedAsLand = [];
for await (const address of availableButUnstored()) {
  const [level, x, y] = address.split("/").map(Number);
  const body = await synthesizeTile(level, x, y);
  const mask = assertWaterMaskExtension(body, `${address} (synthesized)`);
  if (mask.kind === "UNIFORM_WATER") synthesizedWater += 1;
  else synthesizedLand += 1;
  // The gate this lane did not have: an address the ENCODER MEASURED as all
  // water that comes out of the module as land is the exact defect — open
  // ocean rendered as flat ground with no mask — and it must stop the
  // publication rather than be counted.
  if (oceanSkipsDeclared.has(address) && mask.kind !== "UNIFORM_WATER") {
    oceanSkipsServedAsLand.push(`${address} -> ${mask.kind}`);
  }
  write(`${level}/${x}/${y}.terrain`, body);
  synthesizedTiles += 1;
  lastSynthesized = address;
  identitySizes.add(body.length);
}
assert.deepEqual(
  oceanSkipsServedAsLand.slice(0, 8),
  [],
  `${oceanSkipsServedAsLand.length} addresses the encoder measured as all water are being ` +
    "published as land — check terrain_ocean_synth_min_level against the levels this run built",
);
await harness.destroy();

// Every promised unstored address is written in the single streaming loop
// above. Re-reading the complete worklist solely to build an in-memory check
// would defeat the bounded publication contract.

const staticIdentity = {
  p50: identitySizes.percentile(0.5), p99: identitySizes.percentile(0.99), max: identitySizes.max(),
};
assert.ok(staticIdentity.p50 <= STATIC_TRANSPORT_BOUNDS.p50, `static identity p50 ${staticIdentity.p50} exceeds ${STATIC_TRANSPORT_BOUNDS.p50}`);
assert.ok(staticIdentity.p99 <= STATIC_TRANSPORT_BOUNDS.p99, `static identity p99 ${staticIdentity.p99} exceeds ${STATIC_TRANSPORT_BOUNDS.p99}`);
assert.ok(staticIdentity.max <= STATIC_TRANSPORT_BOUNDS.hard, `static identity max ${staticIdentity.max} exceeds ${STATIC_TRANSPORT_BOUNDS.hard}`);

// ── ADD AND PIN THROUGH THE NODE'S IPFS API ────────────────────────────────
//
// kubo reconstructs the directory tree from the multipart filenames, so the
// whole pyramid goes up in one request and the LAST entry — the root name — is
// the tileset CID. cid-version=1 and raw-leaves for the same reason the
// cellular snapshot used them: base32 CIDv1 is what a subdomain gateway needs
// and raw leaves keep a small file's CID equal to its own hash, which is what
// the gateway then serves as the ETag.
async function addAndPin(apiURL) {
  const boundary = "----terrain-pyramid-" + Date.now().toString(16);
  async function* parts() {
    const walk = function* (dir, prefix = "") {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) yield rel;
      }
    };
    for (const rel of walk(ipfsDir)) {
      const name = `${tilesetId}/${rel}`;
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
          `filename="${encodeURIComponent(name)}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      );
      for await (const chunk of fs.createReadStream(path.join(ipfsDir, rel), { highWaterMark: 64 * 1024 })) yield chunk;
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }
  const url =
    `${apiURL.replace(/\/$/, "")}/api/v0/add` +
    "?pin=true&cid-version=1&raw-leaves=true&wrap-with-directory=false";
  const response = await fetch(url, {
    method: "POST",
    // kubo rejects a browser-shaped User-Agent on the RPC API.
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "user-agent": "" },
    body: Readable.from(parts()),
    duplex: "half",
  });
  assert.equal(response.status, 200, `kubo add: HTTP ${response.status}`);
  let root = null;
  let layerEntry = null;
  let entries = 0;
  let pending = "";
  for await (const chunk of response.body) {
    pending += Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line) continue;
      const entry = JSON.parse(line); entries += 1;
      if (entry.Name === tilesetId) root = entry;
      if (entry.Name === `${tilesetId}/layer.json`) layerEntry = entry;
    }
  }
  if (pending.trim()) {
    const entry = JSON.parse(pending); entries += 1;
    if (entry.Name === tilesetId) root = entry;
    if (entry.Name === `${tilesetId}/layer.json`) layerEntry = entry;
  }
  assert.ok(root, `kubo add returned no entry for the root directory ${tilesetId}`);
  return { cid: root.Hash, layerJsonCid: layerEntry?.Hash, entries };
}

async function preflightKubo(apiURL) {
  const response = await fetch(`${apiURL.replace(/\/$/, "")}/api/v0/version`, {
    method: "POST", headers: { "user-agent": "" }, signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `kubo preflight /version: HTTP ${response.status}: ${text.slice(0, 200)}`);
  const version = JSON.parse(text);
  assert.ok(version.Version, "kubo preflight returned no Version");
  return version.Version;
}

async function unpinCreatedRoot(apiURL, cid) {
  const response = await fetch(`${apiURL.replace(/\/$/, "")}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}&recursive=true`, {
    method: "POST", headers: { "user-agent": "" }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `could not remove failed publication pin ${cid}: HTTP ${response.status}`);
}

let publication = args.cid ? { cid: args.cid, layerJsonCid: undefined, entries: 0 } : null;
// The pin assertion's OWN EVIDENCE. `--cid` re-emits the catalogue for a
// directory that is already published and never touches the API, so the
// committed publication record said `"api": null` while the run report claimed
// "added+pinned through host-01's kubo RPC" — the pin was real, and nothing in
// the repo established it. The proof now rides with the claim, and its absence
// is stated rather than implied.
let pinProof = null;
if (args.add) {
  process.stdout.write(`adding ${fileCount} files (${(totalBytes / 1e6).toFixed(1)} MB) to ${args.api}\n`);
  const kuboVersion = await preflightKubo(args.api);
  process.stdout.write(`kubo preflight ${kuboVersion}\n`);
  publication = await addAndPin(args.api);
  // pin=true on add already pins the root recursively; assert it rather than
  // assume it, because an unpinned root is garbage-collected out from under
  // every client that ever resolved it.
  const pinned = await fetch(
    `${args.api.replace(/\/$/, "")}/api/v0/pin/ls?arg=${publication.cid}&type=recursive`,
    { method: "POST", headers: { "user-agent": "" } },
  );
  const pinText = await pinned.text();
  let pinType = null;
  try {
    assert.equal(pinned.status, 200, `pin/ls: HTTP ${pinned.status}: ${pinText.slice(0, 200)}`);
    assert.ok(pinText.includes(publication.cid), `the root ${publication.cid} is not pinned`);
    try {
      pinType = JSON.parse(pinText)?.Keys?.[publication.cid]?.Type ?? null;
    } catch {
      pinType = null;
    }
    assert.equal(
    pinType,
    "recursive",
    `the root ${publication.cid} is pinned as ${pinType ?? "an unreadable type"}, not recursive — ` +
      "only a recursive pin holds the tiles under it",
    );
  } catch (error) {
    // This invocation created the root, so removing only its pin is safe. Do
    // not leave a malformed or unverifiable directory pinned after a fault.
    await unpinCreatedRoot(args.api, publication.cid);
    throw error;
  }
  pinProof = {
    api: args.api,
    checkedAt: new Date().toISOString(),
    endpoint: `/api/v0/pin/ls?arg=${publication.cid}&type=recursive`,
    type: pinType,
    response: pinText.trim().slice(0, 400),
  };
  process.stdout.write(`CID ${publication.cid} pinned ${pinType}\n`);
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

const catalogue = buildCatalogue(publication?.cid ?? null);
fs.writeFileSync(
  path.join(outDir, "tileset-catalogue.json"),
  `${JSON.stringify(catalogue, null, 2)}\n`,
);

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
  const sds = await import(path.join(SOURCE_DIR, "node_modules", "spacedatastandards.org", "index.js"));
  const bytes = writeDttRecord(sds, catalogue);
  fs.writeFileSync(path.join(outDir, "tileset-catalogue.dttstream"), bytes);
  // And it reads back as the record the JSON says it is.
  const [read] = sds.readFB(bytes);
  assert.equal(read.TILESET_ID, catalogue.TILESET_ID);
  assert.equal(read.PROVENANCE.RETRIEVED_AT, catalogue.PROVENANCE.RETRIEVED_AT);
  assert.equal(read.PAYLOAD.CID ?? null, catalogue.PAYLOAD.CID ?? null);
  // Not just "buildDttRecord accepted it": the projection is what the SERVING
  // MODULE has to be able to answer too, so the shape is exercised here rather
  // than only where a wasm is loaded.
  assert.ok(buildDttRecord(sds, catalogue));
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
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const etag = response.headers.get("etag");
  let conditional = null;
  if (etag) {
    const again = await fetch(url, { headers: { "if-none-match": etag } });
    conditional = again.status;
    await again.arrayBuffer();
  }
  return {
    url,
    status: response.status,
    bytes: bytes.length,
    ms: Date.now() - started,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    etag,
    contentEncoding: response.headers.get("content-encoding"),
    accessControlAllowOrigin: response.headers.get("access-control-allow-origin"),
    conditionalStatus: conditional,
    matchesLocal: bytes.equals(fs.readFileSync(path.join(ipfsDir, rel))),
  };
}

const gatewayProof = [];
if (publication?.cid && args.verify) {
  const probes = ["layer.json", `${shallowStored}.terrain`, `${deepStored}.terrain`];
  if (lastSynthesized) probes.push(`${lastSynthesized}.terrain`);
  for (const rel of probes) gatewayProof.push(await fetchThroughGateway(publication.cid, rel));
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
  storedTiles,
  synthesizedTiles,
  // What the synthesized half STATES about water. Before the ocean skips were
  // declared this read 0 water / 36 land on a coastal region.
  synthesizedUniformWater: synthesizedWater,
  synthesizedUniformLand: synthesizedLand,
  oceanSkipsDeclared: oceanSkipsDeclared.size,
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
fs.writeFileSync(path.join(outDir, "ipfs-publication.json"), `${JSON.stringify(report, null, 2)}\n`);

// ── THE COMPLETE `config:` BLOCK FOR THE SERVING MOUNT ─────────────────────
//
// One file an operator installs, rather than two the operator has to merge.
// It is layer-json-config.json — which the mount still needs, because the
// mount still answers layer.json and tiles for a node with no CID and for
// every same-origin fallback — plus the three keys that make this node point
// its clients at the published directory.
//
// terrain_tiles_template is deliberately NOT among them: the mount's own
// layer.json keeps its `?v=` cache-key query, because the mount's tiles are
// not content-addressed and that query is what keys them. Only the layer.json
// INSIDE the CID drops it, and that one is rendered here.
if (publication?.cid) {
  fs.writeFileSync(
    path.join(outDir, "serving-config-ipfs.json"),
    `${JSON.stringify({ ...layerConfig, ...report.mountConfig }, null, 2)}\n`,
  );
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
