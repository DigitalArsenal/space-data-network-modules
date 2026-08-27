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
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { readDtt, readDttProvenance, splitStream } from "./dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE_DIR = path.join(REPO, "data-source", "terrain-source");
const WASM = path.join(SOURCE_DIR, "dist", "isomorphic", "module.wasm");
const MANIFEST = path.join(SOURCE_DIR, "plugin-manifest.json");
const SDK = path.join(SOURCE_DIR, "node_modules", "space-data-module-sdk");

// The tiles template a CID needs: no `?v=` cache-key query, because the CID is
// the cache key and it is already in the path.
const IPFS_TILES_TEMPLATE = "{z}/{x}/{y}.terrain";

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
  Array.isArray(verifyReport.availableButUnstoredAddresses),
  "the verify report predates availableButUnstoredAddresses; re-run verify.mjs",
);

const layerConfig = JSON.parse(fs.readFileSync(path.join(outDir, "layer-json-config.json"), "utf8"));
const runReport = JSON.parse(fs.readFileSync(path.join(outDir, "run-report.json"), "utf8"));
const records = splitStream(fs.readFileSync(path.join(outDir, "tiles.dttstream")));
assert.ok(records.length > 0, "the store holds no records");

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

const first = readDtt(records[0]);
const provenance = readDttProvenance(records[0]);
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
};

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

const files = []; // { rel, bytes }
const write = (rel, bytes) => {
  const full = path.join(ipfsDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  files.push({ rel, bytes: bytes.length });
};

const layerJson = await renderLayerJson();
write("layer.json", layerJson);

const tileSizes = [];
const gzipSizes = [];
let uniformMasks = 0;
let rasterMasks = 0;
const seen = new Set();
for (const record of records) {
  const dtt = readDtt(record);
  const key = `${dtt.level}/${dtt.x}/${dtt.y}`;
  assert.ok(!seen.has(key), `duplicate address ${key}`);
  seen.add(key);
  assert.ok(dtt.payload?.bytes, `${key}: record carries no payload bytes`);
  const stored = Buffer.from(dtt.payload.bytes);
  const body =
    (dtt.payload.contentEncoding ?? "").toLowerCase() === "gzip" ? zlib.gunzipSync(stored) : stored;
  const mask = assertWaterMaskExtension(body, key);
  if (mask.kind === "RASTER") rasterMasks += 1;
  else uniformMasks += 1;
  tileSizes.push(body.length);
  gzipSizes.push(stored.length);
  write(`${dtt.level}/${dtt.x}/${dtt.y}.terrain`, body);
}

// The promise layer.json makes, kept by files rather than by respond().
const synthesized = [];
for (const address of verifyReport.availableButUnstoredAddresses) {
  const [level, x, y] = address.split("/").map(Number);
  const body = await synthesizeTile(level, x, y);
  assertWaterMaskExtension(body, `${address} (synthesized)`);
  write(`${level}/${x}/${y}.terrain`, body);
  synthesized.push(address);
  tileSizes.push(body.length);
}
await harness.destroy();

// Every address layer.json promises now exists as a file: assert it, rather
// than trusting the two loops above to have covered the set between them.
for (const address of verifyReport.availableButUnstoredAddresses) {
  assert.ok(
    fs.existsSync(path.join(ipfsDir, `${address}.terrain`)),
    `${address} is promised by layer.json and missing from the directory`,
  );
}

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0;
};

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
  const parts = [];
  for (const file of files) {
    const name = `${tilesetId}/${file.rel}`;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
          `filename="${encodeURIComponent(name)}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
    );
    parts.push(fs.readFileSync(path.join(ipfsDir, file.rel)));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const url =
    `${apiURL.replace(/\/$/, "")}/api/v0/add` +
    "?pin=true&cid-version=1&raw-leaves=true&wrap-with-directory=false";
  const response = await fetch(url, {
    method: "POST",
    // kubo rejects a browser-shaped User-Agent on the RPC API.
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "user-agent": "" },
    body,
  });
  const text = await response.text();
  assert.equal(response.status, 200, `kubo add: HTTP ${response.status}: ${text.slice(0, 400)}`);
  const entries = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const root = entries.find((e) => e.Name === tilesetId);
  assert.ok(root, `kubo add returned no entry for the root directory ${tilesetId}`);
  const layerEntry = entries.find((e) => e.Name === `${tilesetId}/layer.json`);
  return { cid: root.Hash, layerJsonCid: layerEntry?.Hash, entries: entries.length };
}

let publication = args.cid ? { cid: args.cid, layerJsonCid: undefined, entries: 0 } : null;
if (args.add) {
  process.stdout.write(`adding ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB) to ${args.api}\n`);
  publication = await addAndPin(args.api);
  // pin=true on add already pins the root recursively; assert it rather than
  // assume it, because an unpinned root is garbage-collected out from under
  // every client that ever resolved it.
  const pinned = await fetch(
    `${args.api.replace(/\/$/, "")}/api/v0/pin/ls?arg=${publication.cid}`,
    { method: "POST", headers: { "user-agent": "" } },
  );
  const pinText = await pinned.text();
  assert.equal(pinned.status, 200, `pin/ls: HTTP ${pinned.status}: ${pinText.slice(0, 200)}`);
  assert.ok(pinText.includes(publication.cid), `the root ${publication.cid} is not pinned`);
  process.stdout.write(`CID ${publication.cid}\n`);
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
function buildCatalogue(cid) {
  return {
    TILESET_ID: tilesetId,
    TILESET_NAME: layerConfig.terrain_description || tilesetId,
    TILING_SCHEME: "GEOGRAPHIC_WGS84",
    LEVEL: 0,
    X: 0,
    Y: 0,
    ROW_ORIGIN_NORTH: false,
    WEST_DEG: -180,
    SOUTH_DEG: -90,
    EAST_DEG: 180,
    NORTH_DEG: 90,
    PAYLOAD_FORMAT: "QUANTIZED_MESH",
    PAYLOAD_FORMAT_VERSION: "1.0",
    PAYLOAD: {
      CID: cid,
      SIZE_BYTES: totalBytes,
      MEDIA_TYPE: "application/vnd.ipld.dag-pb",
    },
    MAX_LEVEL: maxzoom,
    WATER_MASK_KIND: "NONE",
    PROVENANCE: {
      ...provenance.raw,
      // A tileset is cut from thousands of granules; the tile's granule-level
      // source fields would name exactly one of them.
      SOURCE_URL: undefined,
      SOURCE_QUERY: undefined,
      DATASET_CID: cid,
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
if (publication?.cid) {
  const sds = await import(path.join(SOURCE_DIR, "node_modules", "spacedatastandards.org", "index.js"));
  const S = sds.standards.DTT;
  const record = new S.DTTT();
  record.TILESET_ID = catalogue.TILESET_ID;
  record.TILESET_NAME = catalogue.TILESET_NAME;
  record.TILING_SCHEME = S.dttTilingScheme.GEOGRAPHIC_WGS84;
  record.WEST_DEG = catalogue.WEST_DEG;
  record.SOUTH_DEG = catalogue.SOUTH_DEG;
  record.EAST_DEG = catalogue.EAST_DEG;
  record.NORTH_DEG = catalogue.NORTH_DEG;
  record.PAYLOAD_FORMAT = S.dttPayloadFormat.QUANTIZED_MESH;
  record.PAYLOAD_FORMAT_VERSION = catalogue.PAYLOAD_FORMAT_VERSION;
  record.PAYLOAD = new S.DTTPayloadRefT();
  record.PAYLOAD.CID = catalogue.PAYLOAD.CID;
  record.PAYLOAD.SIZE_BYTES = BigInt(catalogue.PAYLOAD.SIZE_BYTES);
  record.PAYLOAD.MEDIA_TYPE = catalogue.PAYLOAD.MEDIA_TYPE;
  record.MAX_LEVEL = catalogue.MAX_LEVEL;
  record.PROVENANCE = new S.DTTProvenanceT();
  for (const [key, value] of Object.entries(catalogue.PROVENANCE)) {
    if (value !== undefined && value !== null) record.PROVENANCE[key] = value;
  }
  fs.writeFileSync(path.join(outDir, "tileset-catalogue.dttstream"), sds.writeFB(record));
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
  const stored = [...seen];
  const shallow = stored.reduce((a, b) => (Number(a.split("/")[0]) <= Number(b.split("/")[0]) ? a : b));
  const deep = stored.reduce((a, b) => (Number(a.split("/")[0]) >= Number(b.split("/")[0]) ? a : b));
  const probes = ["layer.json", `${shallow}.terrain`, `${deep}.terrain`];
  if (synthesized.length) probes.push(`${synthesized[synthesized.length - 1]}.terrain`);
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
  cid: publication?.cid ?? null,
  layerJsonCid: publication?.layerJsonCid ?? null,
  files: files.length,
  storedTiles: seen.size,
  synthesizedTiles: synthesized.length,
  synthesizedAddresses: synthesized,
  layerJsonBytes: layerJson.length,
  directoryBytes: totalBytes,
  directoryMiB: Number((totalBytes / 1048576).toFixed(2)),
  // The pyramid is served identity over IPFS, so the wire size is the
  // UNCOMPRESSED distribution; the gzipped one is what the mount lane served
  // and is kept beside it so the cost of the move is a number, not a claim.
  tileBytesIdentity: { p50: pct(tileSizes, 0.5), p99: pct(tileSizes, 0.99), max: Math.max(...tileSizes) },
  tileBytesGzipped: { p50: pct(gzipSizes, 0.5), p99: pct(gzipSizes, 0.99), max: Math.max(...gzipSizes) },
  uniformMasks,
  rasterMasks,
  uniformMaskRatio: Number((uniformMasks / (uniformMasks + rasterMasks)).toFixed(4)),
  encoderTiles: runReport.tiles,
  gatewayProof,
  catalogue,
  // What an operator installs on the serving mount so clients resolve this CID.
  mountConfig: publication?.cid
    ? {
        terrain_tileset_cid: publication.cid,
        terrain_gateway_path: "/ipfs/",
        terrain_dataset_epoch: provenance.raw.DATASET_EPOCH,
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
