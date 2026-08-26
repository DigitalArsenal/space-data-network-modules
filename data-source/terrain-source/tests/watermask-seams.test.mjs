// The water mask is cut from ONE GLOBAL POST LATTICE per level. Everything
// below is a consequence of that, and none of it is checkable any other way:
//
//   * SEAM IDENTITY. Column 255 of tile x and column 0 of tile x+1 are the SAME
//     global post; row 0 of tile y and row 255 of the tile above it are the
//     same global post. Their bytes must be EQUAL — not similar, equal — or the
//     reflective ocean draws a visible line down every tile boundary. Atlas
//     ruled no encoder-side or client-side seam fix-ups, so the identity has to
//     come from the construction, and this is where the construction is tested.
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

test("adjacent tiles share their boundary posts BYTE FOR BYTE, east-west", async (t) => {
  // Two tiles side by side across the diagonal coast, so both are mixed.
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
  assert.deepEqual(
    column(wm, 255),
    column(em, 0),
    "the east edge of tile x IS the west edge of tile x+1: same global posts, same bytes",
  );
});

test("adjacent tiles share their boundary posts BYTE FOR BYTE, north-south", async (t) => {
  const { x, y } = coastalAddress({ needsNorth: true });
  const { tiles } = await encodeBlock(t, [
    { x, y },
    { x, y: y + 1 },
  ]);
  const [lower, upper] = tiles;
  assert.equal(lower.waterMaskKind, 3, "the sample straddles the coast, so it is a real raster");
  assert.equal(upper.waterMaskKind, 3);
  const lm = maskOf(lower);
  const um = maskOf(upper);
  // Row 0 is the NORTH edge. Tile y's north edge IS tile y+1's south edge,
  // which is its row 255.
  assert.deepEqual(
    Buffer.from(row(lm, 0)),
    Buffer.from(row(um, 255)),
    "tile y's north edge IS tile y+1's south edge",
  );
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
