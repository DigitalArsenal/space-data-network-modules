// Regenerates tests/fixtures/parity/* and tests/fixtures/terrain-parity.json.
//
// The parity fixture is COMMITTED, not generated at test time: the whole point
// of the tri-runtime gate is that three lanes receive THE SAME BYTES, so those
// bytes are an artifact under version control, and this script exists to
// reproduce them deterministically rather than to produce them on the fly.
//
//   node tests/fixtures/build-parity-fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGeoTiff, buildWaterTiff, buildOversizedTiffHeader, rawBodyFrameBytes } from "../helpers.mjs";

const outDir = fileURLToPath(new URL("./parity/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
const write = (name, bytes) => {
  fs.writeFileSync(path.join(outDir, name), bytes);
  return { name, byteLength: bytes.length };
};

// One 1-degree granule at 1/1200-degree posts, tiled 256x256: small enough to
// commit, real enough to have a multi-chunk internal grid (the only kind that
// can tell a windowed decoder from a whole-granule one).
const PX = 1200;
const dem = write(
  "dem-granule.hrb",
  rawBodyFrameBytes(
    buildGeoTiff({
      width: PX,
      height: PX,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / PX,
      scaleLat: 1 / PX,
      heightFn: (px, py) => 200 + 0.4 * px + 0.25 * py + 60 * Math.sin(px / 90),
      layout: "tile",
      tileWidth: 256,
      tileHeight: 256,
      predictor: 3,
    }),
  ),
);

// The water-body granule over the same square: water north of 45.6 degrees.
const water = write(
  "water-granule.hrb",
  rawBodyFrameBytes(
    buildWaterTiff({
      width: PX,
      height: PX,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / PX,
      scaleLat: 1 / PX,
      classFn: (px, py) => (46 - py / PX > 45.6 ? 1 : 0),
      layout: "tile",
      tileWidth: 256,
      tileHeight: 256,
      predictor: 2,
    }),
  ),
);

// A granule whose DECLARED geometry crosses the 256 MiB decode budget. Its
// refusal frame must be byte-identical in every lane.
const oversized = write(
  "oversized-granule.hrb",
  rawBodyFrameBytes(
    buildOversizedTiffHeader({
      width: 40000,
      height: 40000,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / 40000,
      scaleLat: 1 / 40000,
    }),
  ),
);

const PROVENANCE = {
  datasetId: "cop-dem-glo-30",
  datasetName: "Copernicus DEM GLO-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: "2026-08-26T00:00:00.000Z",
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
};
const base = {
  tilesetId: "spaceaware-terrain",
  rowOriginNorth: false,
  scheme: "GEOGRAPHIC_WGS84",
  maxLevel: 13,
  provenance: PROVENANCE,
};

// z11 span = 0.087890625 degrees. x=2166 -> west 10.3711; y=1546 -> south 45.4004.
const single = write(
  "plan-single.json",
  Buffer.from(JSON.stringify({ ...base, level: 11, x: 2166, y: 1546, gridSize: 65 })),
);
// A four-tile block: ONE granule decode, four records out.
const block = write(
  "plan-block.json",
  Buffer.from(
    JSON.stringify({
      ...base,
      level: 11,
      gridSize: 65,
      tiles: [
        { x: 2166, y: 1546 },
        { x: 2167, y: 1546 },
        { x: 2166, y: 1547 },
        { x: 2167, y: 1547 },
      ],
    }),
  ),
);
// A tile that straddles the water cut, so the mask is a real RASTER.
const maskPlan = write(
  "plan-water.json",
  Buffer.from(JSON.stringify({ ...base, level: 11, x: 2166, y: 1548, gridSize: 65 })),
);
const layerPlan = write(
  "plan-layer.json",
  Buffer.from(
    JSON.stringify({
      tilesetId: "spaceaware-terrain",
      maxzoom: 13,
      version: "1.0.0",
      attribution: "Copernicus DEM",
      description: "parity fixture",
      available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
    }),
  ),
);
const budgetPlan = write(
  "plan-oversized.json",
  Buffer.from(JSON.stringify({ ...base, level: 8, x: 271, y: 193, gridSize: 255 })),
);

const alignedInput = (portId, file) => ({
  portId,
  payloadFile: `parity/${file.name}`,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: file.byteLength },
});

const fixture = {
  name: "terrain-source-parity",
  threadEnvVar: "SDM_PARITY_THREADS",
  threadCounts: [1, 2, 4, 8],
  cases: [
    {
      id: "tile-single",
      expect: "ok",
      request: { methodId: "tile", inputs: [alignedInput("plan", single), alignedInput("dem", dem)] },
    },
    {
      id: "tile-block-amortized",
      expect: "ok",
      request: { methodId: "tile", inputs: [alignedInput("plan", block), alignedInput("dem", dem)] },
    },
    {
      id: "tile-water-raster",
      expect: "ok",
      request: {
        methodId: "tile",
        inputs: [alignedInput("plan", maskPlan), alignedInput("dem", dem), alignedInput("water", water)],
      },
    },
    {
      id: "layer-json",
      expect: "ok",
      request: { methodId: "layer_json", inputs: [alignedInput("plan", layerPlan)] },
    },
    {
      // THE REFUSAL. Same bytes in, same named error out, in every lane.
      // The exit CLASS is "ok": on the command surface a guest refusal rides
      // inside the response frame and the process exits 0. What proves the
      // refusal is byte-identical is the OUTPUT comparison across lanes, and
      // tests/parity-artifact.test.mjs asserts those bytes really do carry
      // decode-budget-exceeded rather than a silent success.
      id: "tile-over-decode-budget",
      expect: "ok",
      request: {
        methodId: "tile",
        inputs: [alignedInput("plan", budgetPlan), alignedInput("dem", oversized)],
      },
    },
    {
      id: "malformed-stdin",
      stdinUtf8: "this is not a PIV invoke frame — the trap/error class must match across every lane",
    },
  ],
};

const fixturePath = fileURLToPath(new URL("./terrain-parity.json", import.meta.url));
fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${fixturePath} and ${fs.readdirSync(outDir).length} payload files`);
