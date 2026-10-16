// EARTH STAYS BYTE-IDENTICAL (moon-terrain-lane-20261013). The body
// generalisation (radii, two-root body scheme, normals, PDS products) and the
// SDS 1.251.0 bump must not move one Earth byte. 1,000 tiles sampled from real
// Copernicus GLO-30 granules (two 2x2 neighbourhoods: the western Alps, and
// western Norway across the 60 N longitude-spacing band boundary, each with its
// water-body masks) are encoded by the 0.2.0 artifact (git 67c64ecc) and by the
// current build with production options; every record stream and every report
// must be equal byte for byte.
//
// Needs the granules under TERRAIN_EARTH_GRANULES (<cell>_DEM.tif /
// <cell>_WBM.tif, e.g. N45_00_E006_DEM.tif, fetched from
// https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/); skipped without.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { granuleFrame, planInputs } from "./helpers.mjs";

const GRANULES = process.env.TERRAIN_EARTH_GRANULES;
const BASELINE_COMMIT = "67c64ecc";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));

const NEIGHBOURHOODS = [
  { lat: 45, lon: 6 },
  { lat: 59, lon: 5 },
];
const PER_LEVEL = { 8: "all", 9: "all", 10: 200, 11: 340, 12: "rest" };
const TOTAL = 1000;

// A deterministic sample: every candidate tile fully inside a neighbourhood's
// 2x2 degrees (a hair of margin), drawn without replacement by a seeded PRNG.
function sampleTiles() {
  let seed = createHash("sha256").update("earth-identity-v1").digest().readUInt32LE(0);
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (const [levelText, quota] of Object.entries(PER_LEVEL)) {
    const level = Number(levelText);
    const span = 180 / 2 ** level;
    const candidates = [];
    NEIGHBOURHOODS.forEach((n, hood) => {
      const x0 = Math.ceil((n.lon + 0.001 + 180) / span), x1 = Math.floor((n.lon + 1.999 + 180) / span) - 1;
      const y0 = Math.ceil((n.lat + 0.001 + 90) / span), y1 = Math.floor((n.lat + 1.999 + 90) / span) - 1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) candidates.push({ hood, level, x, y });
    });
    const take = quota === "all" ? candidates.length : quota === "rest" ? TOTAL - out.length : quota;
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(random() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      out.push(candidates[i]);
    }
  }
  return out;
}

const cell = (lat, lon) => `N${String(lat).padStart(2, "0")}_00_E${String(lon).padStart(3, "0")}`;

test("1,000 sampled Earth tiles are byte-identical to the 0.2.0 artifact", { skip: !GRANULES && "TERRAIN_EARTH_GRANULES unset" }, async () => {
  const baseline = execFileSync("git", ["show", `${BASELINE_COMMIT}:data-source/terrain-source/dist/isomorphic/module.wasm`], {
    cwd: packageRoot, maxBuffer: 64 << 20,
  });
  const current = fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm"));
  const harnesses = await Promise.all([baseline, current].map((wasmSource) =>
    createBrowserModuleHarness({ wasmSource, manifest, surface: "direct" })));
  const granules = NEIGHBOURHOODS.map((n) => {
    const frames = [];
    for (const kind of ["DEM", "WBM"]) {
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const body = fs.readFileSync(path.join(GRANULES, `${cell(n.lat + dy, n.lon + dx)}_${kind}.tif`));
        frames.push(granuleFrame(kind === "DEM" ? "dem" : "water", body));
      }
    }
    return frames;
  });
  const tiles = sampleTiles();
  assert.equal(tiles.length, TOTAL);

  // Blocks of up to 16 tiles of one level and neighbourhood, as the ingest hands them over.
  const blocks = new Map();
  for (const t of tiles) {
    const key = `${t.hood}/${t.level}`;
    if (!blocks.has(key)) blocks.set(key, []);
    const list = blocks.get(key);
    if (!list.length || list.at(-1).length === 16) list.push([]);
    list.at(-1).push(t);
  }
  let compared = 0;
  for (const [key, list] of blocks) {
    const hood = Number(key.split("/")[0]);
    for (const block of list) {
      const plan = {
        tilesetId: "earth-identity",
        scheme: "GEOGRAPHIC_WGS84",
        gridSize: 65,
        maxGridSize: 129,
        skipOceanTiles: true,
        maxLevel: 12,
        sourceClass: "SPACEBORNE_RADAR_INTERFEROMETRIC",
        verticalDatumName: "EGM2008",
        tiles: block.map(({ level, x, y }) => ({ level, x, y })),
        waterMask: { kind: "RASTER", provenance: { datasetId: "cop-dem-glo-30-wbm", datasetEpoch: "2023-04-01T00:00:00.000Z", retrievedAt: "2026-10-16T00:00:00.000Z", license: "Copernicus WBM licence" } },
        provenance: {
          datasetId: "cop-dem-glo-30",
          datasetEpoch: "2023-04-01T00:00:00.000Z",
          retrievedAt: "2026-10-16T00:00:00.000Z",
          license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
        },
      };
      const inputs = [...planInputs(plan), ...granules[hood]];
      const [before, after] = await Promise.all(harnesses.map((h) => h.invoke({ methodId: "tile", inputs })));
      assert.equal(after.statusCode, before.statusCode, `${key}: status`);
      assert.equal(before.statusCode, 0, `${key}: ${before.errorCode} ${before.errorMessage}`);
      const port = (r, id) => Buffer.from(r.outputs.find((o) => o.portId === id).payload);
      assert.ok(port(before, "records").equals(port(after, "records")), `${key}: record stream differs`);
      assert.ok(port(before, "report").equals(port(after, "report")), `${key}: report differs`);
      compared += block.length;
    }
  }
  assert.equal(compared, TOTAL);
  console.log(`earth identity: ${compared} tiles in ${[...blocks.values()].flat().length} blocks, byte-identical`);
  for (const h of harnesses) h.destroy();
});
