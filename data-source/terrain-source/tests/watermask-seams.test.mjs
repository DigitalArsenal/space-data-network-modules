// The water mask is cut from ONE GLOBAL CELL GRID per level, with AREA
// registration. Everything below is a consequence of that, and none of it is
// checkable any other way:
//
//   * THE MASK IS AN IMAGE, NOT A POST LATTICE, because that is how the
//     consumer reads it. Cesium uploads the 256x256 mask as a LUMINANCE
//     texture with a LINEAR / CLAMP_TO_EDGE sampler and samples it at the
//     tile's own texture coordinates, so texel c COVERS [c/256, (c+1)/256] of
//     the tile and its centre sits at (c+0.5)/256. This encoder used to cut it
//     as 256 POSTS at c/255, edge post to edge post — the served coastline was
//     stretched by ~0.39% of a tile width and displaced by up to half a texel,
//     zero at the tile centre and worst at both edges (~19 m at z11, ~5 m at
//     z13). The classification of the source was exact; the LATTICE CONVENTION
//     was half a texel off, and that is what changed.
//
//   * THE SEAM IS CONTIGUITY, NOT IDENTITY. Under area registration cell 255
//     of tile x and cell 0 of tile x+1 cover DIFFERENT ground and are equal
//     only when the coastline says so — so "adjacent tiles share their edge
//     bytes" is no longer a true statement about a correct encoder, and a test
//     that asserted it would be pinning the defect. What IS true, and what is
//     asserted here, is that the pair's texels tile the ground with no gap, no
//     overlap and no duplication: every texel of every tile carries the class
//     the source states AT ITS OWN CELL CENTRE, which is only expressible on
//     one global grid and is what makes seam fix-ups unnecessary. Atlas ruled
//     no encoder-side or client-side seam fix-ups, so the property has to come
//     from the construction, and this is where the construction is tested.
//
//   * UNIFORM RATIO. Over a sample of ocean and interior tiles, at least 95%
//     must reduce to a single byte. A mask that stays a 65 KB raster where the
//     whole tile agrees costs every client 65 KB to say "all water".
//
//   * OCEAN IS EXACTLY ZERO. An all-ocean tile's heights are 0, not 0.4, not
//     -0.02: min and max are exactly 0.0 so the client's bounding volume is
//     exact and the surface meets sea level.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import zlib from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { buildGeoTiff, buildWaterTiff, decodeDtt, rawBodyFrameBytes, splitStream } from "./helpers.mjs";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const encoder = new TextEncoder();

const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

const PROVENANCE = {
  datasetId: "cop-dem-glo-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: "2026-08-26T00:00:00.000Z",
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
};

// One degree, lon [10,11] x lat [45,46], at 1/1200-degree posts.
const PX = 1200;
const GEO = { originLon: 10, originLat: 46, scaleLon: 1 / PX, scaleLat: 1 / PX, width: PX, height: PX };

// A DIAGONAL coastline: water where lat > lon + 34.5 within the square, so a
// z11 tile grid over it has ocean tiles, interior-land tiles and a diagonal
// band of genuinely mixed coastal tiles.
const isWater = (lon, lat) => lat > lon + 34.5;
const demTiff = buildGeoTiff({
  ...GEO,
  heightFn: (px, py) => {
    const lon = 10 + px / PX;
    const lat = 46 - py / PX;
    return isWater(lon, lat) ? 0 : 120 + 900 * (lon + lat - 55.5);
  },
  layout: "tile",
  tileWidth: 256,
  tileHeight: 256,
  predictor: 3,
});
const waterTiff = buildWaterTiff({
  ...GEO,
  classFn: (px, py) => (isWater(10 + px / PX, 46 - py / PX) ? 1 : 0),
  layout: "tile",
  tileWidth: 256,
  tileHeight: 256,
  predictor: 2,
});

const LEVEL = 11;
const SPAN = 180 / 2 ** LEVEL; // 0.087890625
const X0 = Math.ceil((10 + 180) / SPAN);
const Y0 = Math.ceil((45 + 90) / SPAN);

async function encodeBlock(t, tiles, { gridSize = 65 } = {}) {
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", {
        tilesetId: "spaceaware-terrain",
        level: LEVEL,
        gridSize,
        maxLevel: 13,
        provenance: PROVENANCE,
        tiles,
      }),
      frame("dem", rawBodyFrameBytes(demTiff)),
      frame("water", rawBodyFrameBytes(waterTiff)),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = splitStream(response.outputs.find((o) => o.portId === "records").payload);
  return {
    tiles: records.map((r) => decodeDtt(r)),
    report: JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload)),
  };
}

// A tile's 256x256 mask, whether it was stored as a raster or reduced to one
// uniform byte — the comparison below must not care which.
function maskOf(dtt) {
  if (dtt.waterMaskKind === 3) {
    assert.equal(dtt.waterMaskWidth, 256);
    assert.equal(dtt.waterMaskHeight, 256);
    // Stored GZIPPED: 65,536 bytes of two distinct values, and the same bytes
    // already ride inside the gzipped mesh payload.
    assert.equal(dtt.waterMask.contentEncoding, "gzip");
    const bytes = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
    assert.equal(bytes.length, 256 * 256);
    assert.ok(
      dtt.waterMask.bytes.length < bytes.length / 4,
      `a two-valued 64 KiB raster must compress hard, got ${dtt.waterMask.bytes.length} B`,
    );
    return bytes;
  }
  assert.ok(dtt.waterMaskKind === 1 || dtt.waterMaskKind === 2, "uniform land or uniform water");
  return Buffer.alloc(256 * 256, dtt.waterMaskKind === 2 ? 0xff : 0x00);
}
const column = (mask, c) => Buffer.from(Array.from({ length: 256 }, (_, r) => mask[r * 256 + c]));
const row = (mask, r) => mask.subarray(r * 256, r * 256 + 256);

// A tile whose four corners disagree straddles the coast, so its mask is a real
// raster. Found rather than hard-coded: an address that silently stopped being
// coastal would turn the seam assertions below into a comparison of two uniform
// tiles, which is exactly the test passing for the wrong reason.
function coastalAddress({ needsEast = false, needsNorth = false } = {}) {
  for (let dx = 0; dx < 10; dx++) {
    for (let dy = 0; dy < 10; dy++) {
      const x = X0 + dx;
      const y = Y0 + dy;
      const mixed = (ax, ay) => {
        const west = -180 + ax * SPAN;
        const south = -90 + ay * SPAN;
        const corners = [
          [west, south],
          [west + SPAN, south],
          [west, south + SPAN],
          [west + SPAN, south + SPAN],
        ].map(([lon, lat]) => isWater(lon, lat));
        return !corners.every((c) => c === corners[0]);
      };
      if (!mixed(x, y)) continue;
      if (needsEast && !mixed(x + 1, y)) continue;
      if (needsNorth && !mixed(x, y + 1)) continue;
      if (dx + 1 >= 11 || dy + 1 >= 11) continue;
      return { x, y };
    }
  }
  throw new Error("no coastal tile in the fixture square — the fixture is wrong");
}

// THE GLOBAL CELL GRID, stated once, independently of the module. At level z
// the ellipsoid carries 2^(z+1)*256 x 2^z*256 cells; tile (x, y) takes the
// contiguous block starting at (x*256, y*256), and a texel's ground truth is
// the source class at its CENTRE. Row 0 of the served mask is the NORTH edge.
const CELLS = 256;
const cellLon = (x, c) => -180 + ((x * CELLS + c) + 0.5) * (360 / ((2 ** (LEVEL + 1)) * CELLS));
const cellLatFromSouth = (y, r) => -90 + ((y * CELLS + r) + 0.5) * (180 / ((2 ** LEVEL) * CELLS));
// The class the SOURCE states for a position: its nearest published post,
// never the analytic coastline. The source lattice here is 1/1200 degree and a
// z11 texel is 1/2916 of a degree wide, so the source is COARSER than the mask
// and a nearest-neighbour read is the only honest one — averaging class
// ordinals would invent a class the source never stated, and comparing against
// the analytic function would be asserting a resolution the granule does not
// have.
const sourceClassAt = (lon, lat) => {
  const px = Math.min(Math.max(Math.floor((lon - 10) * PX + 0.5), 0), PX - 1);
  const py = Math.min(Math.max(Math.floor((46 - lat) * PX + 0.5), 0), PX - 1);
  return isWater(10 + px / PX, 46 - py / PX) ? 0xff : 0x00;
};

// THE GRANULE'S OWN MARGIN IS NOT PART OF THIS PROPERTY. A Copernicus granule's
// posts stop one spacing short of its south and east edges, so a position in
// that last strip is held by the granule BELOW or to the EAST — and this
// fixture, deliberately, has only one granule. Whatever the encoder does there
// is the per-post ABSENCE rule, which has its own test below ("A POST NO
// GRANULE COVERS IS OCEAN, per post"). Comparing it here would be asserting two
// unrelated properties in one place and would make a registration failure
// indistinguishable from an absence-rule failure. One source spacing of margin
// is excluded, and the count of texels actually compared is asserted so the
// exclusion can never quietly swallow the test.
const MARGIN = 1 / PX;
const inSourceInterior = (lon, lat) =>
  lon >= 10 + MARGIN && lon <= 11 - 2 * MARGIN && lat >= 45 + 2 * MARGIN && lat <= 46 - MARGIN;

// Compare a served mask against the global grid, texel by texel, over the part
// of it the single fixture granule actually states. Returns how many texels
// were compared so a caller can assert the comparison was substantial.
function assertMaskMatchesGrid(mask, x, y, label) {
  let compared = 0;
  for (let r = 0; r < CELLS; r++) {
    const lat = cellLatFromSouth(y, CELLS - 1 - r);   // row 0 = NORTH
    for (let c = 0; c < CELLS; c++) {
      const lon = cellLon(x, c);
      if (!inSourceInterior(lon, lat)) continue;
      compared += 1;
      const want = sourceClassAt(lon, lat);
      const got = mask[r * CELLS + c];
      if (got !== want) {
        assert.fail(
          `${label}: texel ${r}/${c} at ${lon},${lat} is ${got}, the source states ${want} ` +
            `— the cut is not on the global CELL grid`,
        );
      }
    }
  }
  return compared;
}

test("the mask is registered as an IMAGE: every texel is the class at its own cell centre", async (t) => {
  // The half-texel that used to be wrong. A post-registered cut samples at
  // c/255 instead of (c+0.5)/256; on a diagonal coast that moves the served
  // coastline, and it moves it MOST at the tile edges — which is precisely
  // where the old byte-identity property made it invisible.
  const { x, y } = coastalAddress({ needsEast: true });
  const { tiles } = await encodeBlock(t, [{ x, y }]);
  const [tile] = tiles;
  assert.equal(tile.waterMaskKind, 3, "the sample straddles the coast, so it is a real raster");
  const compared = assertMaskMatchesGrid(maskOf(tile), x, y, `tile ${x}/${y}`);
  assert.ok(compared > 60000, `the comparison must be substantial, got ${compared} texels`);
});

test("adjacent tiles TILE THE GROUND: no gap, no overlap, no duplicated edge", async (t) => {
  // Under AREA registration the shared-edge bytes of two neighbours are equal
  // only by coincidence — they cover different ground. The property that
  // replaces identity is contiguity, and it is checkable exactly: the pair's
  // texel centres are one continuous run of the global grid, so concatenating
  // the two tiles' rows must reproduce a 512-wide cut of that grid.
  const { x, y } = coastalAddress({ needsEast: true });
  const { tiles } = await encodeBlock(t, [
    { x, y },
    { x: x + 1, y },
  ]);
  assert.equal(tiles.length, 2, "one granule decode, two records");
  const [west, east] = tiles;
  assert.equal(west.waterMaskKind, 3, "the sample straddles the coast, so it is a real raster");
  const wm = maskOf(west);
  const em = maskOf(east);

  // The centres either side of the shared meridian are ONE cell width apart —
  // the grid neither skips ground nor covers any twice.
  const width = 360 / ((2 ** (LEVEL + 1)) * CELLS);
  assert.ok(
    Math.abs(cellLon(x + 1, 0) - cellLon(x, CELLS - 1) - width) < 1e-12,
    "cell 255 of tile x and cell 0 of tile x+1 are ADJACENT cells of one grid",
  );

  // The pair, read as ONE 512-wide cut: concatenating the two tiles' rows must
  // reproduce the global grid across the shared meridian with nothing skipped
  // and nothing repeated.
  let compared = 0;
  for (let r = 0; r < CELLS; r++) {
    const joined = Buffer.concat([Buffer.from(row(wm, r)), Buffer.from(row(em, r))]);
    const lat = cellLatFromSouth(y, CELLS - 1 - r);
    for (let c = 0; c < CELLS * 2; c++) {
      const lon = -180 + (x * CELLS + c + 0.5) * width;
      if (!inSourceInterior(lon, lat)) continue;
      compared += 1;
      assert.equal(
        joined[c],
        sourceClassAt(lon, lat),
        `row ${r} cell ${c} at ${lon},${lat}: the pair is not one cut of the global grid`,
      );
    }
  }
  assert.ok(compared > 100000, `the comparison must be substantial, got ${compared} texels`);
});

test("EVERY tile in the block is the same cut of ONE global grid", async (t) => {
  // Two hand-picked pairs are not the property. On the real regional pyramid
  // 34 of 4,446 vertically adjacent pairs disagreed on 1-4 shared posts while
  // the two pairs above passed: 31 of them from the zeroed-south-row planner
  // bug, and 3 at ordinary latitudes purely because tile y computed the shared
  // parallel as `north - 255*dlat` and tile y+1 computed it as
  // `south' + 0*dlat'` — equal in exact arithmetic, not always equal in
  // doubles, and std::lround then flipped on the tie.
  //
  // Cutting cells by GLOBAL CELL INDEX makes both the seam and the
  // registration structural at once: every one of the block's 121 tiles is
  // compared, texel for texel, against the global grid computed here — 7.9
  // million independent classifications. If any tile were cut on a different
  // lattice, or offset by half a texel, or seam-fixed, this fails.
  const addresses = [];
  for (let dx = 0; dx < 11; dx++) {
    for (let dy = 0; dy < 11; dy++) addresses.push({ x: X0 + dx, y: Y0 + dy });
  }
  const { tiles } = await encodeBlock(t, addresses);
  const masks = new Map(tiles.map((dtt) => [`${dtt.x}/${dtt.y}`, maskOf(dtt)]));
  assert.equal(masks.size, addresses.length);

  let checked = 0;
  let compared = 0;
  for (const { x, y } of addresses) {
    compared += assertMaskMatchesGrid(masks.get(`${x}/${y}`), x, y, `tile ${x}/${y}`);
    checked += 1;
  }
  assert.equal(checked, 121);
  assert.ok(compared > 7_000_000, `${compared} texels compared against the global grid`);
  console.log(`[watermask] ${compared.toLocaleString()} texels compared against the global cell grid`);

  // …and the block's tiles are CONTIGUOUS, which is the seam property stated
  // over every adjacency rather than over two hand-picked pairs.
  let eastWest = 0;
  let northSouth = 0;
  const width = 360 / ((2 ** (LEVEL + 1)) * CELLS);
  const height = 180 / ((2 ** LEVEL) * CELLS);
  for (const { x, y } of addresses) {
    if (masks.get(`${x + 1}/${y}`)) {
      assert.ok(
        Math.abs(cellLon(x + 1, 0) - cellLon(x, CELLS - 1) - width) < 1e-12,
        `east-west contiguity at ${x}/${y}`,
      );
      eastWest += 1;
    }
    if (masks.get(`${x}/${y + 1}`)) {
      assert.ok(
        Math.abs(cellLatFromSouth(y + 1, 0) - cellLatFromSouth(y, CELLS - 1) - height) < 1e-12,
        `north-south contiguity at ${x}/${y}`,
      );
      northSouth += 1;
    }
  }
  assert.equal(eastWest, 110);
  assert.equal(northSouth, 110);
});

test("ocean and interior tiles are >= 95% uniform, and ocean is EXACTLY zero", async (t) => {
  // Sample the whole 1-degree square, then split it: a tile whose own extent is
  // entirely on one side of the coast is an ocean or interior tile, and those
  // are the ones the ratio is stated over. Coastal tiles are genuinely mixed
  // and are supposed to be rasters.
  const addresses = [];
  for (let dx = 0; dx < 11; dx++) {
    for (let dy = 0; dy < 11; dy++) addresses.push({ x: X0 + dx, y: Y0 + dy });
  }
  const { tiles, report } = await encodeBlock(t, addresses);
  assert.equal(tiles.length, addresses.length, "one granule decode, every tile out");
  assert.equal(report.granulesDecoded, 1, "the granule was decoded ONCE for all of them");

  let sampled = 0;
  let uniform = 0;
  let oceanTiles = 0;
  for (const dtt of tiles) {
    const corners = [
      [dtt.westDeg, dtt.southDeg],
      [dtt.eastDeg, dtt.southDeg],
      [dtt.westDeg, dtt.northDeg],
      [dtt.eastDeg, dtt.northDeg],
    ].map(([lon, lat]) => isWater(lon, lat));
    const homogeneous = corners.every((c) => c === corners[0]);
    if (!homogeneous) continue; // a coastal tile is not part of this sample
    sampled++;
    if (dtt.waterMaskKind !== 3) uniform++;
    if (dtt.waterMaskKind === 2) {
      oceanTiles++;
      assert.equal(dtt.minHeightM, 0, "an ocean tile's minimum is EXACTLY zero");
      assert.equal(dtt.maxHeightM, 0, "an ocean tile's maximum is EXACTLY zero");
    }
  }
  const ratio = uniform / sampled;
  console.log(
    `[watermask] ocean-and-interior sample: ${sampled} tiles, ${uniform} uniform ` +
      `(${(ratio * 100).toFixed(1)}%), ${oceanTiles} uniform-water`,
  );
  assert.ok(sampled >= 40, `the sample must be substantial, got ${sampled}`);
  assert.ok(oceanTiles > 0, "the sample must actually contain ocean");
  assert.ok(ratio >= 0.95, `uniform ratio ${(ratio * 100).toFixed(1)}% must be at least 95%`);
});

test("every record states DIGEST and ETAG over the GZIPPED bytes, MEDIA_TYPE only", async (t) => {
  const { x, y } = coastalAddress({ needsEast: true });
  const { tiles } = await encodeBlock(t, [{ x, y }, { x: x + 1, y }]);
  const { createHash } = await import("node:crypto");
  for (const dtt of tiles) {
    const bytes = Buffer.from(dtt.payload.bytes);
    assert.equal(dtt.payload.contentEncoding, "gzip");
    assert.equal(dtt.payload.mediaType, "application/vnd.quantized-mesh");
    assert.equal(Number(dtt.payload.sizeBytes), bytes.length, "SIZE_BYTES is over the gzipped bytes");
    assert.equal(
      dtt.payload.digest,
      `1220${createHash("sha256").update(bytes).digest("hex")}`,
      "DIGEST is the sha2-256 multihash of the gzipped bytes",
    );
    assert.equal(dtt.etag, `"${dtt.payload.digest}"`, "ETAG is that digest, strong");
  }
});

test("a MEASURED flat-at-zero water tile is skipped as ocean, coverage notwithstanding", async (t) => {
  // The trap this closes: the source dataset publishes real granules over most
  // sea, full of measured 0.0 metres. A tile in the middle of a bay therefore
  // has coverage 1.0, and an ocean test that required coverage == 0 stored
  // every one of them — 1,217 identical flat records in the first regional
  // run. What makes a tile ocean is what it SAYS, not how it was covered.
  const seaGeo = { originLon: 10, originLat: 46, scaleLon: 1 / 600, scaleLat: 1 / 600, width: 600, height: 600 };
  const seaDem = buildGeoTiff({ ...seaGeo, heightFn: () => 0, layout: "tile", tileWidth: 256, tileHeight: 256 });
  const seaWater = buildWaterTiff({ ...seaGeo, classFn: () => 1, layout: "tile", tileWidth: 256, tileHeight: 256 });

  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  const address = { x: X0 + 5, y: Y0 + 5 };
  const inputs = (skipOceanTiles) => [
    jsonFrame("plan", {
      tilesetId: "spaceaware-terrain",
      level: LEVEL,
      gridSize: 65,
      maxLevel: 13,
      provenance: PROVENANCE,
      skipOceanTiles,
      tiles: [address],
    }),
    frame("dem", rawBodyFrameBytes(seaDem)),
    frame("water", rawBodyFrameBytes(seaWater)),
  ];

  const kept = await harness.invoke({ methodId: "tile", inputs: inputs(false) });
  assert.equal(kept.statusCode, 0, `${kept.errorCode}: ${kept.errorMessage}`);
  const keptRecords = splitStream(kept.outputs.find((o) => o.portId === "records").payload);
  assert.equal(keptRecords.length, 1, "without the flag the record is produced as asked");
  const dtt = decodeDtt(keptRecords[0]);
  assert.equal(dtt.waterMaskKind, 2, "UNIFORM_WATER");
  assert.equal(dtt.minHeightM, 0);
  assert.equal(dtt.maxHeightM, 0);
  assert.equal(dtt.dataCoverageFraction, 1, "…and it was FULLY covered by real measurements");

  const skipped = await harness.invoke({ methodId: "tile", inputs: inputs(true) });
  assert.equal(skipped.statusCode, 0, `${skipped.errorCode}: ${skipped.errorMessage}`);
  const report = JSON.parse(new TextDecoder().decode(skipped.outputs.find((o) => o.portId === "report").payload));
  assert.equal(report.tilesEmitted, 0, "nothing stored");
  assert.equal(report.tilesSkippedOcean, 1, "…and it is COUNTED as skipped, not silently dropped");
});

test("A POST NO GRANULE COVERS IS OCEAN, per post — never land because a NEIGHBOUR cell has one", async (t) => {
  // THE DEFECT THIS CLOSES, measured on the real regional pyramid: the mask's
  // no-classification fallback was `dem_absent ? water : land` where dem_absent
  // was a flag over the WHOLE granule set. Copernicus publishes no object over
  // open ocean, so a 1-degree cell out at sea 404s for both DEM and WBM; when
  // such a cell shared a 2x2 block with a land cell the flag was false and
  // every unclassifiable post in it was written 0x00 = LAND. That fabricated
  // 40,527 LAND samples over the open Ligurian Sea — hard-edged rectangles
  // exactly the shape of the missing granule, on tiles flat at 0 m and
  // kilometres deep — which the client renders as non-reflective blocks in the
  // middle of the water. It also defeated the ocean-skip rule, and the pyramid
  // verifier could not see it because those tiles are RASTER, not
  // UNIFORM_WATER.
  //
  // The fixture is that exact shape: ONE granule covering lon [10,11] only,
  // and a tile block that reaches WEST of it into a cell the dataset does not
  // publish.
  const oneDegree = { originLon: 10, originLat: 46, scaleLon: 1 / 600, scaleLat: 1 / 600, width: 600, height: 600 };
  const landDem = buildGeoTiff({ ...oneDegree, heightFn: () => 500, layout: "tile", tileWidth: 256, tileHeight: 256 });
  const landWater = buildWaterTiff({ ...oneDegree, classFn: () => 0, layout: "tile", tileWidth: 256, tileHeight: 256 });

  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());

  // A tile entirely WEST of the granule (lon < 10): no elevation, no mask.
  const westX = Math.floor((9.2 + 180) / SPAN);
  const insideY = Math.floor((45.4 + 90) / SPAN);
  const insideX = Math.floor((10.4 + 180) / SPAN);

  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", {
        tilesetId: "spaceaware-terrain",
        level: LEVEL,
        gridSize: 65,
        maxLevel: 13,
        provenance: PROVENANCE,
        tiles: [{ x: westX, y: insideY }, { x: insideX, y: insideY }],
      }),
      frame("dem", rawBodyFrameBytes(landDem)),
      frame("water", rawBodyFrameBytes(landWater)),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = splitStream(response.outputs.find((o) => o.portId === "records").payload);
  const byX = new Map(records.map((r) => { const d = decodeDtt(r); return [d.x, d]; }));

  const uncovered = byX.get(westX);
  assert.ok(uncovered, "the uncovered tile is still emitted");
  assert.equal(uncovered.waterMaskKind, 2, "UNIFORM_WATER: nothing published there, so it is sea");
  const uncoveredMask = maskOf(uncovered);
  assert.equal(
    uncoveredMask.filter((b) => b === 0x00).length,
    0,
    "not one fabricated LAND sample over a cell the dataset does not publish",
  );
  assert.equal(uncovered.minHeightM, 0);
  assert.equal(uncovered.maxHeightM, 0);

  // …and the covered neighbour in the SAME invoke is still land, so the fix is
  // per post rather than a block-wide flip in the other direction.
  const covered = byX.get(insideX);
  assert.equal(covered.waterMaskKind, 1, "UNIFORM_LAND where the granule really covers");

  // The two counts are reported separately: an ocean inference and a genuine
  // gap in the mask lane are different facts and a run must not hide either.
  const report = JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload));
  assert.ok(report.maskFromAbsenceSamples > 0, "the ocean inference is counted");
  assert.equal(report.maskUnclassifiedSamples, 0, "no post has elevation but no classification");
});

test("an all-ocean cell still emits a records frame, so the walk cannot stall", async (t) => {
  // Skipping the push on an empty batch leaves the downstream scheduler with
  // no `records` input: its node never runs, the resume mark never advances,
  // and the pyramid walk stops dead at the first open-ocean cell. The first
  // regional run did exactly that, four cells in.
  const seaGeo = { originLon: 10, originLat: 46, scaleLon: 1 / 600, scaleLat: 1 / 600, width: 600, height: 600 };
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", {
        tilesetId: "spaceaware-terrain",
        level: LEVEL,
        gridSize: 65,
        maxLevel: 13,
        provenance: PROVENANCE,
        skipOceanTiles: true,
        tiles: [{ x: X0 + 5, y: Y0 + 5 }],
      }),
      frame("dem", rawBodyFrameBytes(buildGeoTiff({ ...seaGeo, heightFn: () => 0, layout: "tile", tileWidth: 256, tileHeight: 256 }))),
      frame("water", rawBodyFrameBytes(buildWaterTiff({ ...seaGeo, classFn: () => 1, layout: "tile", tileWidth: 256, tileHeight: 256 }))),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = response.outputs.find((o) => o.portId === "records");
  assert.ok(records, "the frame EXISTS even though it carries no records");
  assert.equal(records.payload.length, 4, "one zero-length size prefix: the store's own empty framing");
  assert.deepEqual(splitStream(records.payload), [], "…and it decodes to no records at all");
});
