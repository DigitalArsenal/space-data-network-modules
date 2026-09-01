// Offline representative parity rehearsal for the bounded global-build lane.
//
// It cuts a two-region, four-tile block through the shipped terrain-source
// artifact. The single lane and two concurrent shard lanes see the exact same
// DEM/WBM fixture; their order-independent $DTT record-set digests must match.
// No network, flow mount, IPFS API, or node is involved.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { recordSetDigest } from "./build-support.mjs";
import { readDtt, splitStream } from "./dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE = path.join(REPO, "data-source", "terrain-source");
const { buildGeoTiff } = await import(path.join(SOURCE, "tests", "helpers.mjs"));

let out;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--out") out = process.argv[++i];
  else throw new Error(`unknown argument ${process.argv[i]}`);
}
assert.ok(out, "--out <report.json> is required");

const encoder = new TextEncoder();
const granule = { width: 256, height: 256, originLon: 7.9, originLat: 45.5, scaleLon: 1 / 256, scaleLat: 1 / 256, layout: "tile", tileWidth: 64, tileHeight: 64, predictor: 1 };
const dem = buildGeoTiff({ ...granule, heightFn: (px, py) => (px < 96 ? 0 : 40 + 30 * Math.sin(px / 9) + 20 * Math.cos(py / 7)) });
const wbm = buildGeoTiff({ ...granule, classFn: (px) => (px < 96 ? 1 : 0) });
const planBase = {
  tilesetId: "global-rehearsal", gridSize: 33, maxGridSize: 33, maxLevel: 9, skipOceanTiles: true,
  waterMask: { kind: "RASTER", width: 256, height: 256 }, scheme: "GEOGRAPHIC_WGS84", rowOriginNorth: false,
  provenance: { datasetId: "test-dataset", datasetName: "test", datasetEpoch: "2023-04-01T00:00:00.000Z", retrievedAt: "2026-09-01T00:00:00.000Z", license: "test licence", attribution: "test attribution" },
};
const frame = (portId, bytes) => ({ portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length }, payload: bytes });
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));
const rawBody = (portId, body) => {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.write("$HRB", 0, "latin1"); bytes.writeUInt32LE(200, 4); Buffer.from(body).copy(bytes, 8);
  return frame(portId, bytes);
};

async function cut(tiles) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(SOURCE, "dist", "isomorphic", "module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(SOURCE, "plugin-manifest.json"), "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => { if (operation === "plugin.getConfig") return {}; throw new Error(`unexpected ${operation}`); },
  });
  try {
    const response = await harness.invoke({ methodId: "tile", inputs: [jsonFrame("plan", { ...planBase, tiles }), rawBody("dem", dem), rawBody("water", wbm)] });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    return splitStream(Buffer.from(response.outputs.find((item) => item.portId === "records").payload));
  } finally { await harness.destroy(); }
}

const regions = [
  { name: "west", tiles: [{ level: 9, x: 535, y: 383 }, { level: 9, x: 535, y: 384 }] },
  { name: "east", tiles: [{ level: 9, x: 536, y: 383 }, { level: 9, x: 536, y: 384 }] },
];
const startedSingle = performance.now();
const single = await cut(regions.flatMap((region) => region.tiles));
const singleMs = performance.now() - startedSingle;
const startedShards = performance.now();
const sharded = (await Promise.all(regions.map((region) => cut(region.tiles)))).flat();
const shardMs = performance.now() - startedShards;
const digest = (records) => recordSetDigest(records.map((record) => {
  const dtt = readDtt(record);
  return [`${dtt.level}/${dtt.x}/${dtt.y}`, createHash("sha256").update(record).digest("hex")];
}));
const singleDigest = digest(single);
const shardDigest = digest(sharded);
assert.equal(shardDigest, singleDigest, "two concurrent region shards must produce the single-lane $DTT record set");
const report = { regions: regions.map(({ name, tiles }) => ({ name, tiles: tiles.length })), records: single.length, singleLaneMs: +singleMs.toFixed(3), concurrentShardMs: +shardMs.toFixed(3), recordSetDigest: singleDigest, parity: "PASS" };
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
