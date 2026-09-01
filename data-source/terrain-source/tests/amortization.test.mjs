// AMORTIZATION, SIZE AND ACCURACY — the three numbers the serving lane is
// bounded by, measured on a granule with the geometry the source dataset
// actually publishes (3600x3600 float32, 512x512 internal tiles).
//
// WHY AMORTIZATION IS THE POINT. The first cut handed the encoder one tile per
// invocation, and each invocation inflated the whole granule again: about 97%
// of a 1839 ms/tile encode was re-inflating bytes it had already inflated. A
// plan that addresses a BLOCK decodes the granule ONCE and samples it per tile,
// so the per-tile cost falls to the encode itself. That is not a micro-
// optimisation — a global z11 pyramid is millions of tiles.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { buildGeoTiff, decodeDtt, decodeQuantizedMesh, rawBodyFrameBytes, splitStream } from "./helpers.mjs";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

// One granule at the dataset's native geometry: lon [10,11] x lat [45,46].
const PX = 3600;
const ORIGIN_LON = 10;
const ORIGIN_LAT = 46;
const SCALE = 1 / PX;
// Continuous relief with real range and curvature, so the sampling error below
// is a real measurement rather than a constant compared with itself.
const heightAt = (px, py) =>
  250 + 0.05 * px + 0.03 * py + 40 * Math.sin(px / 180) + 25 * Math.cos(py / 240);
const GRANULE = rawBodyFrameBytes(
  buildGeoTiff({
    width: PX,
    height: PX,
    originLon: ORIGIN_LON,
    originLat: ORIGIN_LAT,
    scaleLon: SCALE,
    scaleLat: SCALE,
    heightFn: heightAt,
    layout: "tile",
    tileWidth: 512,
    tileHeight: 512,
    predictor: 3,
  }),
);

const LEVEL = 11;
const SPAN = 180 / 2 ** LEVEL;
const X0 = Math.ceil((ORIGIN_LON + 180) / SPAN);
const Y0 = Math.ceil((ORIGIN_LAT - 1 + 90) / SPAN);
const BLOCK = 8; // 8x8 = 64 tiles, all inside the one granule
const GRID = 65;

const addresses = [];
for (let dy = 0; dy < BLOCK; dy++) {
  for (let dx = 0; dx < BLOCK; dx++) addresses.push({ x: X0 + dx, y: Y0 + dy });
}

const planBase = {
  tilesetId: "spaceaware-terrain",
  level: LEVEL,
  gridSize: GRID,
  maxLevel: 13,
  provenance: PROVENANCE,
};

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: WASM, manifest: MANIFEST, surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

test("a block decodes the granule ONCE and beats the per-tile re-decode outright", async (t) => {
  const harness = await harnessFor(t);

  // (A) the path this replaces: one tile per invocation, granule re-inflated
  // every time. Sampled over a subset — it is the slow one, that is the point.
  const perTileMs = [];
  for (const address of addresses.slice(0, 12)) {
    const started = performance.now();
    const response = await harness.invoke({
      methodId: "tile",
      inputs: [jsonFrame("plan", { ...planBase, ...address }), frame("dem", GRANULE)],
    });
    perTileMs.push(performance.now() - started);
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  }
  perTileMs.sort((a, b) => a - b);

  // (B) the amortized path: ONE invocation, 64 tiles out, one granule decode.
  const blockStarted = performance.now();
  const blockResponse = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", { ...planBase, tiles: addresses }), frame("dem", GRANULE)],
  });
  const blockMs = performance.now() - blockStarted;
  assert.equal(blockResponse.statusCode, 0, `${blockResponse.errorCode}: ${blockResponse.errorMessage}`);
  const report = JSON.parse(decoder.decode(blockResponse.outputs.find((o) => o.portId === "report").payload));
  const records = splitStream(blockResponse.outputs.find((o) => o.portId === "records").payload);

  assert.equal(records.length, addresses.length, "every addressed tile came out");
  assert.equal(report.granulesDecoded, 1, "ONE granule decode for the whole block");
  assert.equal(report.tilesEmitted, addresses.length);

  const amortizedMsPerTile = blockMs / addresses.length;
  console.log(
    `[amortization] per-tile invoke p50 ${percentile(perTileMs, 0.5).toFixed(1)} ms/tile; ` +
      `block of ${addresses.length} in ${blockMs.toFixed(1)} ms = ${amortizedMsPerTile.toFixed(1)} ms/tile ` +
      `(${(percentile(perTileMs, 0.5) / amortizedMsPerTile).toFixed(1)}x)`,
  );
  assert.ok(
    amortizedMsPerTile <= 250,
    `amortized ${amortizedMsPerTile.toFixed(1)} ms/tile must be at or under 250 ms/tile`,
  );
  assert.ok(
    amortizedMsPerTile < percentile(perTileMs, 0.5),
    "amortizing must actually be faster than re-decoding per tile",
  );
});

test("every tile fits the serving size bounds: p50 <= 4 KiB, p99 <= 12 KiB, hard 32 KiB", async (t) => {
  const harness = await harnessFor(t);
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", { ...planBase, tiles: addresses }), frame("dem", GRANULE)],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const sizes = splitStream(response.outputs.find((o) => o.portId === "records").payload)
    .map((r) => decodeDtt(r).payload.bytes.length)
    .sort((a, b) => a - b);

  const p50 = percentile(sizes, 0.5);
  const p99 = percentile(sizes, 0.99);
  const max = sizes[sizes.length - 1];
  console.log(
    `[tile-bytes] gzipped over ${sizes.length} tiles at gridSize ${GRID}: ` +
      `p50 ${p50} B, p99 ${p99} B, max ${max} B`,
  );
  assert.ok(p50 <= 4096, `p50 ${p50} B must be at or under 4 KiB`);
  assert.ok(p99 <= 12288, `p99 ${p99} B must be at or under 12 KiB`);
  assert.ok(max <= 32768, `max ${max} B must be at or under the 32 KiB hard ceiling`);
});

test("a tile past the 32 KiB ceiling is REFUSED at encode time, not discovered by a client", async (t) => {
  // Incompressible relief at gridSize 255: every quantized height is
  // independent, so the zigzag stream has no structure to deflate.
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 4000;
  };
  const noisy = rawBodyFrameBytes(
    buildGeoTiff({
      width: 1200,
      height: 1200,
      originLon: ORIGIN_LON,
      originLat: ORIGIN_LAT,
      scaleLon: 1 / 1200,
      scaleLat: 1 / 1200,
      heightFn: () => noise(),
      layout: "tile",
      tileWidth: 256,
      tileHeight: 256,
      predictor: 1,
    }),
  );
  const harness = await harnessFor(t);
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", { ...planBase, gridSize: 255, x: X0, y: Y0 }),
      frame("dem", noisy),
    ],
  });
  assert.equal(response.errorCode, "tile-size-ceiling-exceeded");
  assert.match(response.errorMessage, /32768-byte per-tile serving ceiling/);
  assert.match(response.errorMessage, /Refused at encode time/);
});

test("decoded heights track the full-resolution granule inside the stated bounds", async (t) => {
  const harness = await harnessFor(t);
  const address = { x: X0 + 3, y: Y0 + 3 };
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", { ...planBase, ...address }), frame("dem", GRANULE)],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const dtt = decodeDtt(splitStream(response.outputs.find((o) => o.portId === "records").payload)[0]);
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(dtt.payload.bytes)));

  const range = mesh.header.maxHeight - mesh.header.minHeight;
  // Independent bilinear sample of the FULL-RESOLUTION granule, computed from
  // the source height function rather than from anything the module produced.
  const sampleFullRes = (lon, lat) => {
    const px = (lon - ORIGIN_LON) / SCALE;
    const py = (ORIGIN_LAT - lat) / SCALE;
    const x0 = Math.min(Math.max(Math.floor(px), 0), PX - 1);
    const y0 = Math.min(Math.max(Math.floor(py), 0), PX - 1);
    const x1 = Math.min(x0 + 1, PX - 1);
    const y1 = Math.min(y0 + 1, PX - 1);
    const fx = px - x0;
    const fy = py - y0;
    const s = (a, b) => Math.fround(heightAt(a, b));
    return (
      (1 - fy) * ((1 - fx) * s(x0, y0) + fx * s(x1, y0)) +
      fy * ((1 - fx) * s(x0, y1) + fx * s(x1, y1))
    );
  };

  const quantBound = Math.max(0.5, range / 32767);
  const levelBound = 77067 / 2 ** LEVEL;
  let maxDelta = 0;
  let sumSq = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const i = Math.round((mesh.u[v] / 32767) * (GRID - 1));
    const j = Math.round((mesh.v[v] / 32767) * (GRID - 1));
    const lon = dtt.westDeg + ((dtt.eastDeg - dtt.westDeg) * i) / (GRID - 1);
    const lat = dtt.southDeg + ((dtt.northDeg - dtt.southDeg) * j) / (GRID - 1);
    const decoded = mesh.header.minHeight + (mesh.h[v] / 32767) * range;
    const delta = Math.abs(decoded - sampleFullRes(lon, lat));
    maxDelta = Math.max(maxDelta, delta);
    sumSq += delta * delta;
  }
  const rmse = Math.sqrt(sumSq / mesh.vertexCount);
  console.log(
    `[accuracy] level ${LEVEL}, range ${range.toFixed(1)} m: max |delta| ${maxDelta.toFixed(3)} m ` +
      `(quantization bound ${quantBound.toFixed(3)} m, level bound ${levelBound.toFixed(1)} m), ` +
      `RMSE ${rmse.toFixed(3)} m`,
  );
  assert.ok(
    maxDelta <= quantBound,
    `per-vertex |delta| ${maxDelta.toFixed(3)} m must be within the quantization bound ${quantBound.toFixed(3)} m`,
  );
  assert.ok(maxDelta <= levelBound, `max error must be within 77067/2^${LEVEL} = ${levelBound.toFixed(1)} m`);
  assert.ok(rmse <= 0.25 * levelBound, `RMSE ${rmse.toFixed(3)} m must be within 25% of the level bound`);
});
