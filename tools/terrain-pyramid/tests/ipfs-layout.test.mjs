// THE DIRECTORY A GATEWAY SERVES, held to what a browser will ask of it.
//
// OWNER 2026-08-27: terrain files are requested over IPFS, so the pyramid
// leaves this repo as a content-addressed DIRECTORY — layer.json plus one file
// per tile — instead of a record stream a module answers requests from. Every
// property the mount used to provide at request time has to be a property of
// the FILES now, and each of these tests is one of them:
//
//   * a tile file is the tile, DECODED. A gateway does no content negotiation
//     and kubo does not compress (measured: identity in, identity out), so a
//     file holding the gzipped payload would reach the browser as garbage.
//   * the water mask is IN the file. There is no serve-time step left to add
//     it, and the mask is what the reflective ocean reads.
//   * every address layer.json promises EXISTS. respond() synthesizes a miss;
//     a gateway 404s, and Atlas set the browser-4xx bound at zero.
//   * layer.json is the module's own rendering, with the tiles template a CID
//     needs.
//
// The records under test come from the module's own encoder, so what is
// published is measured against the bytes the ingest path actually stores.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { readDtt, splitStream } from "../dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SOURCE = path.join(REPO, "data-source", "terrain-source");
const { buildGeoTiff, decodeQuantizedMesh } = await import(path.join(SOURCE, "tests", "helpers.mjs"));

const encoder = new TextEncoder();

// One granule of real relief, and a water mask with a coast through it so the
// block yields both a RASTER-mask tile and a uniform one.
// originLat is the NORTH edge and rows run south, as the source granules do.
// One degree square at 7.9E/45.5N, so the four level-9 tiles below sit wholly
// inside it — a tile the granule only partly covers would be measuring
// coverage, not layout.
const GRANULE = {
  width: 256,
  height: 256,
  originLon: 7.9,
  originLat: 45.5,
  scaleLon: 1 / 256,
  scaleLat: 1 / 256,
  layout: "tile",
  tileWidth: 64,
  tileHeight: 64,
  predictor: 1,
};
const dem = buildGeoTiff({
  ...GRANULE,
  heightFn: (px, py) => (px < 96 ? 0 : 40 + 30 * Math.sin(px / 9) + 20 * Math.cos(py / 7)),
});
const wbm = buildGeoTiff({ ...GRANULE, classFn: (px) => (px < 96 ? 1 : 0) });

const PLAN = {
  tilesetId: "ipfs-layout-test",
  gridSize: 33,
  maxGridSize: 33,
  maxLevel: 9,
  skipOceanTiles: true,
  waterMask: { kind: "RASTER", width: 256, height: 256 },
  // The plan is an intra-flow control frame, so its keys are camelCase; the
  // RECORD it produces carries them as the IDL spells them.
  provenance: {
    datasetId: "test-dataset",
    datasetName: "test",
    datasetEpoch: "2023-04-01T00:00:00.000Z",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    license: "test licence",
    attribution: "test attribution",
  },
  scheme: "GEOGRAPHIC_WGS84",
  rowOriginNorth: false,
};

// hostcap/http-request responseWire "raw-body-v1": "$HRB", little-endian
// status, body verbatim — an 8-byte header, no length (the frame carries it).
const rawBodyFrame = (portId, body) => {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.write("$HRB", 0, "latin1");
  bytes.writeUInt32LE(200, 4);
  Buffer.from(body).copy(bytes, 8);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length },
    payload: new Uint8Array(bytes),
  };
};
const jsonFrame = (portId, value) => {
  const bytes = encoder.encode(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};

// Cut a small block of real tiles, then lay the run out on disk exactly as the
// builder does, so ipfs-publish.mjs runs against it unchanged.
async function buildFixture() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(SOURCE, "dist", "isomorphic", "module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(SOURCE, "plugin-manifest.json"), "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return {};
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  // A 2x2 block at level 9 inside the granule's own extent. The coast at
  // px 96 (lon 8.275) runs through x=535 and misses x=536, so the block yields
  // a RASTER-mask tile and a uniform one — both file shapes in one fixture.
  const tiles = [];
  for (let x = 535; x <= 536; x += 1) for (let y = 383; y <= 384; y += 1) tiles.push({ level: 9, x, y });
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", { ...PLAN, tiles }), rawBodyFrame("dem", dem), rawBodyFrame("water", wbm)],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const stream = Buffer.from(response.outputs.find((o) => o.portId === "records").payload);
  await harness.destroy();

  const records = splitStream(stream);
  assert.ok(records.length > 0, "the fixture block yielded no records");
  const addresses = records.map((r) => {
    const d = readDtt(r);
    return { level: d.level, x: d.x, y: d.y };
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-"));
  fs.writeFileSync(path.join(outDir, "tiles.dttstream"), stream);
  const available = [];
  for (let level = 0; level <= 9; level += 1) available.push([]);
  for (const a of addresses) available[9].push({ startX: a.x, startY: a.y, endX: a.x, endY: a.y });
  // The ancestor closure the client walks down: one rectangle per level above,
  // which makes those addresses promised-but-unstored — the case that has to
  // become a FILE.
  for (let level = 8; level >= 0; level -= 1) {
    const shift = 9 - level;
    const xs = addresses.map((a) => a.x >> shift);
    const ys = addresses.map((a) => a.y >> shift);
    available[level].push({
      startX: Math.min(...xs), startY: Math.min(...ys),
      endX: Math.max(...xs), endY: Math.max(...ys),
    });
  }
  const layerConfig = {
    terrain_maxzoom: 9,
    terrain_ocean_synth_min_level: 9,
    terrain_mount_path: "/api/v1/terrain/",
    terrain_available: available,
  };
  fs.writeFileSync(path.join(outDir, "layer-json-config.json"), JSON.stringify(layerConfig));
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify({ tiles: records.length }));
  const promised = [];
  const stored = new Set(addresses.map((a) => `${a.level}/${a.x}/${a.y}`));
  for (let level = 0; level <= 8; level += 1) {
    const r = available[level][0];
    for (let y = r.startY; y <= r.endY; y += 1) {
      for (let x = r.startX; x <= r.endX; x += 1) {
        const key = `${level}/${x}/${y}`;
        if (!stored.has(key)) promised.push(key);
      }
    }
  }
  fs.writeFileSync(
    path.join(outDir, "verify-report.json"),
    JSON.stringify({ problems: [], availableButUnstoredAddresses: promised }),
  );
  return { outDir, records, addresses, promised };
}

const fixture = await buildFixture();
execFileSync(
  process.execPath,
  [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", fixture.outDir, "--no-add"],
  { stdio: "pipe" },
);
const ipfsDir = path.join(fixture.outDir, "ipfs");
const layerJson = JSON.parse(fs.readFileSync(path.join(ipfsDir, "layer.json"), "utf8"));

test("layer.json declares the tiles template a CID needs, and the watermask extension", () => {
  // No `?v=` query: the CID is the cache key and it is already in the path.
  assert.deepEqual(layerJson.tiles, ["{z}/{x}/{y}.terrain"]);
  assert.deepEqual(layerJson.extensions, ["watermask"]);
  assert.equal(layerJson.format, "quantized-mesh-1.0");
  assert.equal(layerJson.scheme, "tms");
  assert.equal(layerJson.projection, "EPSG:4326");
  assert.ok(Array.isArray(layerJson.available), "available must be an array");
  assert.ok(layerJson.available[0].length > 0, "level 0 must be covered or the client never asks");
});

test("every tile file is the identity mesh the record carries, not the stored gzip", () => {
  for (const record of fixture.records) {
    const dtt = readDtt(record);
    const file = fs.readFileSync(path.join(ipfsDir, `${dtt.level}/${dtt.x}/${dtt.y}.terrain`));
    assert.equal(dtt.payload.contentEncoding, "gzip", "the record stores gzip");
    assert.ok(
      file.equals(zlib.gunzipSync(Buffer.from(dtt.payload.bytes))),
      `${dtt.level}/${dtt.x}/${dtt.y}: the file is not the decoded payload`,
    );
    // The gzip magic in a file a gateway serves identity would reach the
    // browser as an unparseable tile.
    assert.notEqual(file.readUInt16BE(0), 0x1f8b, "a tile file must not be gzip");
  }
});

test("every tile file carries its water mask, uniform or raster", () => {
  const kinds = { 1: 0, 65536: 0 };
  for (const rel of fs.readdirSync(ipfsDir, { recursive: true })) {
    if (!String(rel).endsWith(".terrain")) continue;
    const bytes = fs.readFileSync(path.join(ipfsDir, String(rel)));
    const mesh = decodeQuantizedMesh(bytes);
    assert.equal(mesh.bytesRead, bytes.length, `${rel}: the file does not parse to its own end`);
    const mask = mesh.extensions.find((e) => e.id === 2);
    assert.ok(mask, `${rel}: no water-mask extension`);
    if (mask.bytes.length === 1) {
      assert.ok(mask.bytes[0] === 0 || mask.bytes[0] === 0xff, `${rel}: uniform mask is not 0/255`);
    } else {
      const side = Math.round(Math.sqrt(mask.bytes.length));
      assert.equal(side * side, mask.bytes.length, `${rel}: raster mask is not square`);
    }
    kinds[mask.bytes.length] = (kinds[mask.bytes.length] ?? 0) + 1;
  }
  assert.ok(kinds[65536] > 0, "the coastal fixture must yield at least one raster mask");
});

test("every address layer.json promises exists as a file", () => {
  assert.ok(fixture.promised.length > 0, "the fixture must exercise the promised-but-unstored case");
  for (const address of fixture.promised) {
    const file = path.join(ipfsDir, `${address}.terrain`);
    assert.ok(fs.existsSync(file), `${address} is promised and missing: a gateway would 404`);
    // A synthesized tile is flat and states a mask; it is a real tile, not a
    // placeholder the client has to tolerate.
    const mesh = decodeQuantizedMesh(fs.readFileSync(file));
    assert.ok(mesh.extensions.some((e) => e.id === 2), `${address}: synthesized without a mask`);
  }
});

test("the publication report and the directory agree on what was published", () => {
  const report = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "ipfs-publication.json"), "utf8"));
  let files = 0;
  for (const rel of fs.readdirSync(ipfsDir, { recursive: true })) {
    if (fs.statSync(path.join(ipfsDir, String(rel))).isFile()) files += 1;
  }
  assert.equal(report.files, files);
  assert.equal(report.storedTiles, fixture.records.length);
  assert.equal(report.synthesizedTiles, fixture.promised.length);
  assert.equal(files, report.storedTiles + report.synthesizedTiles + 1, "tiles plus layer.json");
});

test("an unverified run is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-unverified-"));
  fs.copyFileSync(path.join(fixture.outDir, "tiles.dttstream"), path.join(dir, "tiles.dttstream"));
  fs.copyFileSync(path.join(fixture.outDir, "layer-json-config.json"), path.join(dir, "layer-json-config.json"));
  fs.copyFileSync(path.join(fixture.outDir, "run-report.json"), path.join(dir, "run-report.json"));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", dir, "--no-add"],
        { stdio: "pipe" },
      ),
    /run verify\.mjs first/,
    "a CID is permanent; an unverified pyramid must not get one",
  );
});

test("a run verify.mjs failed is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-failed-"));
  for (const name of ["tiles.dttstream", "layer-json-config.json", "run-report.json"]) {
    fs.copyFileSync(path.join(fixture.outDir, name), path.join(dir, name));
  }
  fs.writeFileSync(
    path.join(dir, "verify-report.json"),
    JSON.stringify({ problems: ["p99 over the byte bound"], availableButUnstoredAddresses: [] }),
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", dir, "--no-add"],
        { stdio: "pipe" },
      ),
    /unmet bounds/,
  );
});
