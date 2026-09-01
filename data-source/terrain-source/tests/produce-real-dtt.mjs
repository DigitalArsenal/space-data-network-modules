// LOCAL VERIFY (sdn-terrain-serving-module): produce a REAL $DTT record
// stream from two real Copernicus GLO-30 granules (Grand Canyon area) via the
// module's own `tile` encoder, using the SDK testing harness. Output: a
// FlatSQL LE-u32 size-prefixed record stream ready for the node's
// /api/v1/admin/publish/batch?schema=DTT.fbs lane, plus a manifest of the
// addresses produced. NOT COMMITTED — verify tooling only.
//
// Usage: node tests/produce-real-dtt.mjs <granuleDir> <outStream.bin>

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const [, , granuleDir, outPath] = process.argv;
assert.ok(granuleDir && outPath, "usage: produce-real-dtt.mjs <granuleDir> <out.bin>");

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(portId, payload) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));
const responseFrame = (portId, body, extra = {}) =>
  jsonFrame(portId, {
    status: 200,
    headers: {},
    bodyB64: Buffer.from(body).toString("base64"),
    ...extra,
  });

const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
const provFor = (name) => ({
  datasetId: "cop-dem-glo-30",
  datasetName: "Copernicus DEM GLO-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: now,
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
  licenseUrl:
    "https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf",
  attribution:
    "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
  sourceUrl: `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${name}/${name}.tif`,
  nativeId: name,
});

const W113 = "Copernicus_DSM_COG_10_N36_00_W113_00_DEM";
const W112 = "Copernicus_DSM_COG_10_N36_00_W112_00_DEM";
const demW113 = fs.readFileSync(path.join(granuleDir, "N36_W113.tif"));
const demW112 = fs.readFileSync(path.join(granuleDir, "N36_W112.tif"));

// Tiles (GEOGRAPHIC_WGS84, TMS row origin south):
//  z8 x95 y179  [-113.203,-112.5]x[35.859,36.563]  — Grand Canyon west (W113)
//  z8 x96 y179  [-112.5,-111.797]x[35.859,36.563]  — spans both granules
//  z0 x0  y0    west root, sparse real coverage
const TILES = [
  { level: 8, x: 95, y: 179, dems: [[demW113, W113]] },
  { level: 8, x: 96, y: 179, dems: [[demW113, W113], [demW112, W112]] },
  { level: 0, x: 0, y: 0, dems: [[demW113, W113], [demW112, W112]] },
];

const streams = [];
const produced = [];
for (const t of TILES) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(fileURLToPath(MANIFEST_PATH), "utf8")),
    surface: "direct",
  });
  const plan = {
    tilesetId: "spaceaware-terrain",
    level: t.level,
    x: t.x,
    y: t.y,
    rowOriginNorth: false,
    scheme: "GEOGRAPHIC_WGS84",
    gridSize: 65,
    maxLevel: 8,
    childAvailability: 0,
    provenance: provFor(t.dems[0][1]),
  };
  const inputs = [jsonFrame("plan", plan), ...t.dems.map(([d]) => responseFrame("dem", d))];
  const response = await harness.invoke({ methodId: "tile", inputs });
  assert.equal(
    response.statusCode,
    0,
    `tile z${t.level}/${t.x}/${t.y}: ${response.errorCode}: ${response.errorMessage}`,
  );
  const outs = new Map(response.outputs.map((o) => [o.portId, o.payload]));
  const records = outs.get("records");
  assert.ok(records && records.byteLength > 8, "records stream present");
  const report = JSON.parse(decoder.decode(outs.get("report")));
  console.log(`z${t.level}/${t.x}/${t.y}:`, JSON.stringify(report));
  streams.push(Buffer.from(records));
  produced.push({ level: t.level, x: t.x, y: t.y, bytes: records.byteLength, report });
  harness.destroy();
}

fs.writeFileSync(outPath, Buffer.concat(streams));
fs.writeFileSync(outPath + ".manifest.json", JSON.stringify(produced, null, 1));
console.log("wrote", outPath, fs.statSync(outPath).size, "bytes");
