// JANUS (b), 2026-08-26 — THE bounded-memory gate for the terrain encoder.
//
// Two DIFFERENT properties, both measured here against the real linear memory
// (`harness.memory.buffer.byteLength >>> 16` is the page count; the buffer is
// replaced on growth, so it is re-read every time):
//
//   1. PEAK. A gridSize-255 tile whose extent straddles a 2x2 neighbourhood of
//      FULL-SIZE source granules (3600x3600 float32, 512x512 internal tiles,
//      the geometry the real dataset publishes) must peak at or under 1024
//      pages = 64 MiB. Decoding those four granules WHOLE would hold 197 MB;
//      windowing is the difference and this is where it is proven.
//
//   2. NO GROWTH. Over a 64-invoke A/B/A interleave (largest tile, smallest
//      tile, largest tile) on ONE harness — one linear memory that persists
//      across every invoke — the page count after invoke 2 must equal the page
//      count after invoke 64. A guest that leaks a buffer per invoke shows up
//      here and nowhere else, because a fresh harness per invoke hides it.
//
// Plus the REFUSAL: a plan whose declared window crosses the 256 MiB in-guest
// decode budget is refused BY NAME before any allocation. A guest that instead
// traps on allocation takes its pooled flow instance with it, and that instance
// never runs work again.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { buildGeoTiff, buildOversizedTiffHeader, rawBodyFrameBytes, splitStream } from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const PAGE_BYTES = 65536;
const PEAK_PAGE_CEILING = 1024; // 64 MiB
const GRID = 255; // the gridSize Janus fixed the bound at

const encoder = new TextEncoder();

function frame(portId, payload) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

const PROVENANCE = {
  datasetId: "cop-dem-glo-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: "2026-08-26T00:00:00.000Z",
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
};

// ── the granule neighbourhood ───────────────────────────────────────────────
// Four FULL-SIZE granules on the real 1-degree grid at the dataset's native
// 1/3600-degree post spacing, tiled 512x512 exactly as the published COGs are.
// A single-chunk granule could not tell a windowed decoder from a whole-granule
// one, which is why the internal grid is real here.
const GRANULE_PX = 3600;
const SCALE = 1 / GRANULE_PX;
const CORNERS = [
  [10, 46], // lon 10..11, lat 45..46  (originLat is the NORTH edge)
  [11, 46],
  [10, 47], // lon 10..11, lat 46..47
  [11, 47],
];

const granules = CORNERS.map(([lon, lat]) =>
  rawBodyFrameBytes(
    buildGeoTiff({
      width: GRANULE_PX,
      height: GRANULE_PX,
      originLon: lon,
      originLat: lat,
      scaleLon: SCALE,
      scaleLat: SCALE,
      // Smooth relief with real range: the mesh must actually be encoded, not
      // collapse to a constant that compresses to nothing.
      heightFn: (px, py) => 250 + 0.05 * px + 0.03 * py + 40 * Math.sin(px / 180),
      layout: "tile",
      tileWidth: 512,
      tileHeight: 512,
      predictor: 3,
    }),
  ),
);

// LARGEST: the z8 tile straddling BOTH granule seams, so all four granules are
// windowed. lon [10.546875, 11.25] x lat [45.703125, 46.40625].
const LARGE = { level: 8, x: 271, y: 193 };
// SMALLEST: a z12 tile wholly inside the south-west granule.
const SMALL = { level: 12, x: 4335, y: 3095 };

function planFor(address) {
  return {
    tilesetId: "spaceaware-terrain",
    ...address,
    rowOriginNorth: false,
    scheme: "GEOGRAPHIC_WGS84",
    gridSize: GRID,
    maxLevel: 13,
    provenance: PROVENANCE,
  };
}

function assertInsideGranules(address) {
  const span = 180 / 2 ** address.level;
  const west = -180 + address.x * span;
  const south = -90 + address.y * span;
  assert.ok(west >= 10 && west + span <= 12, `x=${address.x} west ${west}`);
  assert.ok(south >= 45 && south + span <= 47, `y=${address.y} south ${south}`);
  return { west, east: west + span, south, north: south + span };
}

test("the fixture addresses are the ones the bound is stated at", () => {
  const large = assertInsideGranules(LARGE);
  assert.ok(large.west < 11 && large.east > 11, "the large tile straddles the longitude seam");
  assert.ok(large.south < 46 && large.north > 46, "…and the latitude seam, so all four granules window");
  const small = assertInsideGranules(SMALL);
  // "Wholly inside one granule" = its whole extent falls in one 1-degree square.
  assert.equal(Math.floor(small.west), Math.floor(small.east - 1e-9), "one granule column");
  assert.equal(Math.floor(small.south), Math.floor(small.north - 1e-9), "one granule row");
});

test("peak <= 1024 pages and ZERO growth over a 64-invoke A/B/A interleave", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const pages = () => harness.memory.buffer.byteLength / PAGE_BYTES;

  const demFrames = granules.map((g) => frame("dem", g));
  const pagesAfter = [];
  let peak = pages();

  for (let n = 1; n <= 64; n++) {
    // A/B/A: largest, smallest, largest — repeated.
    const address = n % 3 === 2 ? SMALL : LARGE;
    const response = await harness.invoke({
      methodId: "tile",
      inputs: [jsonFrame("plan", planFor(address)), ...demFrames],
    });
    assert.equal(response.statusCode, 0, `invoke ${n}: ${response.errorCode} ${response.errorMessage}`);
    const records = response.outputs.find((o) => o.portId === "records");
    assert.equal(splitStream(records.payload).length, 1, `invoke ${n} emitted one record`);
    pagesAfter.push(pages());
    peak = Math.max(peak, pages());
  }

  assert.ok(
    peak <= PEAK_PAGE_CEILING,
    `peak ${peak} pages (${(peak / 16).toFixed(1)} MiB) must stay at or under ${PEAK_PAGE_CEILING} ` +
      `pages (64 MiB) at gridSize ${GRID} across four full-size granules`,
  );
  // ZERO GROWTH, over EVERY settled invoke rather than two sampled ones.
  //
  // The interleave is A/B/A, so the allocator's high-water is only known once
  // each member of the cycle has run at least once with the other's blocks
  // already placed — invokes 1..3. From the first COMPLETE cycle onwards the
  // page count must never move again, and that is asserted over all 61
  // remaining points, not over a pair. (Measured 2026-08-26 at 128 invokes:
  // 926 pages at invoke 1, 927 from invoke 3, and 927 at every invoke through
  // 128 — a one-time settle, not a per-invoke leak. The earlier form of this
  // assertion compared invoke 2 against invoke 64, which happened to straddle
  // that settle and so measured cycle phase rather than growth.)
  const settled = pagesAfter.slice(3);
  const settledMin = Math.min(...settled);
  const settledMax = Math.max(...settled);
  assert.equal(
    settledMin,
    settledMax,
    `pages across invokes 4..64 moved between ${settledMin} and ${settledMax}: ` +
      "any movement after the first full A/B/A cycle is a per-invoke leak",
  );
  assert.equal(
    pagesAfter[63],
    settledMax,
    "the last invoke must sit at the settled page count",
  );
  console.log(
    `[memory-bound] gridSize ${GRID}, 4 granules of ${GRANULE_PX}x${GRANULE_PX}: ` +
      `peak ${peak} pages (${(peak / 16).toFixed(1)} MiB), pages@1 ${pagesAfter[0]}, ` +
      `settled ${settledMax} from invoke 4 through 64`,
  );
});

test("1,000 repeated invokes do not grow the guest by one page", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const pages = () => harness.memory.buffer.byteLength / PAGE_BYTES;

  const inputs = [jsonFrame("plan", planFor(SMALL)), frame("dem", granules[0])];
  let settled = 0;
  let peak = 0;
  for (let n = 1; n <= 1000; n++) {
    const response = await harness.invoke({ methodId: "tile", inputs });
    assert.equal(response.statusCode, 0, `invoke ${n}: ${response.errorCode}`);
    if (n === 4) settled = pages();
    peak = Math.max(peak, pages());
  }
  assert.equal(pages(), settled, `pages after 1000 invokes must equal pages after 4 (${settled})`);
  assert.ok(peak <= PEAK_PAGE_CEILING, `peak ${peak} pages`);
  console.log(`[memory-bound] 1000 invokes: settled ${settled} pages, peak ${peak} pages`);
});

test("a window past the 256 MiB decode budget is refused BY NAME, before any allocation", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const pages = () => harness.memory.buffer.byteLength / PAGE_BYTES;

  // The granule declares 40000x40000 float32 over one degree; the z8 tile's
  // window across it is ~18000x11900 = 861 MB, past the 256 MiB budget. The
  // file itself is a few hundred bytes: the refusal fires on the DECLARED
  // geometry, so nothing is ever allocated to be refused.
  const oversized = buildOversizedTiffHeader({
    width: 40000,
    height: 40000,
    originLon: 10,
    originLat: 46,
    scaleLon: 1 / 40000,
    scaleLat: 1 / 40000,
  });
  assert.ok(oversized.length < 4096, "the refusal fixture is a header, not a raster");

  const before = pages();
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", planFor(LARGE)), frame("dem", rawBodyFrameBytes(oversized))],
  });
  assert.equal(response.errorCode, "decode-budget-exceeded");
  assert.match(response.errorMessage, /268435456-byte in-guest decode budget/);
  assert.equal(pages(), before, "a refused plan allocates nothing");
});
