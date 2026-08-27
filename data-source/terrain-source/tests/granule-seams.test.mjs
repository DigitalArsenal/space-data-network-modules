// GRANULE SEAMS — the two defects a real regional build found, held down here.
//
// Both come from the same fact about the source dataset and neither is visible
// on a fixture that fits inside one granule, which is why the suite missed
// them until 4,621 real tiles were decoded and compared against the DEM.
//
// THE FACT: a Copernicus granule's tiepoint is its NORTH-WEST corner and its
// posts stop ONE SPACING SHORT of its south and east edges. Granule (lat, lon)
// therefore holds latitudes (lat, lat+1] and longitudes [lon, lon+1) — the post
// at latitude exactly `lat` is row 0 of the granule BELOW, and the post at
// longitude exactly `lon+1` is column 0 of the granule to the EAST.
//
//   1. THE ZEROED SOUTH ROW. A tile whose south edge lands on a whole-degree
//      parallel takes its whole bottom post row from the granule below it. The
//      planner did not fetch that granule and the encoder found no cover, so
//      all 65 posts of mesh row 0 were emitted as 0 m — measured on the real
//      pyramid as 90 tiles at lat 45.000 across levels 8-11, each a 340-metre
//      cliff against its southern neighbour.
//
//   2. THE HALF-POST SHIFT. A position between the last post of one granule and
//      the first of the next was CLAMPED to the edge post instead of
//      interpolated across the seam — up to half a post (~15 m) of horizontal
//      displacement, measured at p50 3.28 m / max 11.56 m of vertical error on
//      straddling z13 tiles against 0.018 m on interior ones, breaching the
//      z13 error bound on tiles that are otherwise exact.
//
// The fixture is a coarser lattice than the real dataset (1/720 degree rather
// than 1/3600) because the GEOMETRY is what is under test, not the resolution:
// origin at the north-west corner, posts one spacing short of south and east.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { buildGeoTiff, decodeDtt, decodeQuantizedMesh, rawBodyFrameBytes, splitStream } from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const POSTS = 720;              // posts per degree
const SCALE = 1 / POSTS;
const GRID = 65;
const encoder = new TextEncoder();

// ONE continuous relief over the whole neighbourhood, in GLOBAL coordinates.
// Continuity is the point: any discontinuity the mesh shows is the encoder's,
// not the source's.
const relief = (lon, lat) =>
  400 + 220 * Math.sin((lon - 9) * 3.1) + 180 * Math.cos((lat - 44) * 2.7) + 90 * (lon - 9) * (lat - 44);

// Granule (lat, lon): tiepoint at its NORTH-WEST corner, posts running south
// and east from there, stopping one spacing short of the far edges.
function granule(lat, lon) {
  return rawBodyFrameBytes(
    buildGeoTiff({
      width: POSTS,
      height: POSTS,
      originLon: lon,
      originLat: lat + 1,
      scaleLon: SCALE,
      scaleLat: SCALE,
      heightFn: (px, py) => relief(lon + px * SCALE, lat + 1 - py * SCALE),
      layout: "tile",
      tileWidth: 240,
      tileHeight: 240,
      predictor: 3,
    }),
  );
}

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

async function encodeTile(t, address, cells) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", {
        tilesetId: "spaceaware-terrain",
        ...address,
        rowOriginNorth: false,
        scheme: "GEOGRAPHIC_WGS84",
        gridSize: GRID,
        maxLevel: 13,
        provenance: PROVENANCE,
      }),
      ...cells.map(([lat, lon]) => frame("dem", granule(lat, lon))),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = response.outputs.find((o) => o.portId === "records");
  const dtt = decodeDtt(splitStream(Buffer.from(records.payload))[0]);
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(dtt.payload.bytes)));
  const report = JSON.parse(new TextDecoder().decode(response.outputs.find((o) => o.portId === "report").payload));
  // Real metres, back out of the quantised heights: v is the SOUTH-north axis.
  const range = mesh.header.maxHeight - mesh.header.minHeight;
  const heights = new Map();
  for (let n = 0; n < mesh.vertexCount; n += 1) {
    const i = Math.round((mesh.u[n] * (GRID - 1)) / 32767);
    const j = Math.round((mesh.v[n] * (GRID - 1)) / 32767);
    heights.set(`${i}/${j}`, mesh.header.minHeight + (mesh.h[n] / 32767) * range);
  }
  return { dtt, mesh, report, heightAt: (i, j) => heights.get(`${i}/${j}`) };
}

// z11: span 0.087890625 degrees. y = 1536 puts the SOUTH edge on exactly 45.0.
const SPAN = 180 / 2 ** 11;
const ON_PARALLEL = { level: 11, x: 2155, y: 1536 };
const BELOW_PARALLEL = { level: 11, x: 2155, y: 1535 };
const west = (a) => -180 + a.x * SPAN;
const south = (a) => -90 + a.y * SPAN;

test("the fixture really does put a tile edge on a whole degree", () => {
  assert.equal(south(ON_PARALLEL), 45, "south edge exactly on the parallel");
  assert.equal(south(BELOW_PARALLEL) + SPAN, 45, "the tile below shares that edge");
  assert.ok(west(ON_PARALLEL) > 9 && west(ON_PARALLEL) + SPAN < 10, "one granule column");
});

test("THE SOUTH POST ROW IS MEASURED, NOT ZERO, when the edge is a whole degree", async (t) => {
  // The granule holding the row is N44 — one cell SOUTH of the tile.
  const { dtt, report, heightAt } = await encodeTile(t, ON_PARALLEL, [[44, 9], [45, 9]]);
  assert.equal(dtt.dataCoverageFraction, 1, "every post is covered: none fell between granules");
  assert.equal(report.tiles[0].edgeClampedPosts, 0, "no post fell back to a clamped stencil");

  const step = SPAN / (GRID - 1);
  let worst = 0;
  for (let i = 0; i < GRID; i += 1) {
    const truth = relief(west(ON_PARALLEL) + i * step, 45);
    const got = heightAt(i, 0);
    assert.ok(got > 1, `post ${i} of the south row is ${got} m: the row was not sampled at all`);
    worst = Math.max(worst, Math.abs(got - truth));
  }
  // The lattice post sits ON a source post, so only quantisation separates them.
  const quant = (dtt.maxHeightM - dtt.minHeightM) / 32767;
  assert.ok(worst <= Math.max(0.5, quant), `south row worst |delta| ${worst} m`);
});

test("the shared edge is CONTINUOUS: the tile below reads the same parallel", async (t) => {
  const above = await encodeTile(t, ON_PARALLEL, [[44, 9], [45, 9]]);
  const below = await encodeTile(t, BELOW_PARALLEL, [[43, 9], [44, 9]]);
  let worst = 0;
  for (let i = 0; i < GRID; i += 1) {
    worst = Math.max(worst, Math.abs(above.heightAt(i, 0) - below.heightAt(i, GRID - 1)));
  }
  // Both tiles sample the SAME global post; only their own quantisation ranges
  // differ, so the disagreement is bounded by the coarser of the two steps.
  const step = Math.max(
    (above.dtt.maxHeightM - above.dtt.minHeightM) / 32767,
    (below.dtt.maxHeightM - below.dtt.minHeightM) / 32767,
  );
  assert.ok(worst <= step, `shared parallel disagrees by ${worst} m (quantisation step ${step} m)`);
  assert.ok(worst < 1, `a 340-metre cliff is what this test exists to refuse; got ${worst} m`);
});

test("NO HALF-POST SHIFT: posts either side of a granule meridian interpolate across it", async (t) => {
  // A z11 tile whose EXTENT contains longitude 10.0: west 9.931640625,
  // east 10.01953125. Post 49 of its lattice lands at 9.998931884765625 —
  // between granule E009's last post (9.998611...) and granule E010's first
  // (10.0), which is precisely the position the old code clamped.
  const straddle = { level: 11, x: 2161, y: 1540 };
  assert.ok(west(straddle) < 10 && west(straddle) + SPAN > 10, "the tile really straddles it");
  const { report, heightAt } = await encodeTile(t, straddle, [
    [45, 9], [45, 10], [46, 9], [46, 10],
  ]);
  assert.equal(report.tiles[0].edgeClampedPosts, 0, "the stencil completed across the seam");
  const step = SPAN / (GRID - 1);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < GRID; i += 1) {
    const lon = west(straddle) + i * step;
    const truth = relief(lon, south(straddle) + 32 * step);
    const delta = Math.abs(heightAt(i, 32) - truth);
    if (delta > worst) { worst = delta; worstAt = i; }
  }
  // Bilinear over a 1/720-degree lattice on this relief is exact to well under
  // a metre; a clamped seam post lands tens of metres out.
  console.log(`[seams] straddling-row worst |delta| ${worst.toFixed(6)} m at column ${worstAt}`);
  assert.ok(worst < 0.05, `worst |delta| ${worst} m at column ${worstAt}`);

  // AND the seam column specifically is not the clamped answer. The clamp
  // served granule E009's LAST post verbatim for any position east of it, so
  // its value is the relief at longitude 9 + 719/720 — a fixed, computable
  // wrong answer. The emitted post must be far closer to the truth than to it,
  // which is the difference the numeric bound above would not by itself prove.
  const lastPostLon = 9 + (POSTS - 1) / POSTS;
  let seam = -1;
  for (let i = 0; i < GRID; i += 1) {
    const lon = west(straddle) + i * step;
    if (lon > lastPostLon && lon < 10) seam = i;
  }
  assert.ok(seam >= 0, "the fixture must contain a post inside the inter-granule gap");
  const lat = south(straddle) + 32 * step;
  const seamLon = west(straddle) + seam * step;
  const truth = relief(seamLon, lat);
  const clamped = relief(lastPostLon, lat);
  const emitted = heightAt(seam, 32);
  assert.ok(
    Math.abs(emitted - truth) * 20 < Math.abs(clamped - truth),
    `seam post ${seam} at ${seamLon}: emitted ${emitted}, truth ${truth}, clamped answer ${clamped}`,
  );
});
