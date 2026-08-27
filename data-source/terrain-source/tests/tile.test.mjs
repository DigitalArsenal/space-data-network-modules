// Encode correctness for the terrain lane. Every assertion is a computable
// outcome — a quantized-mesh header value, an index-stream invariant, a
// FlatBuffer field that must carry a plan value verbatim — checked against an
// independent quantized-mesh decoder and DEM sampler written from the spec
// (tests/helpers.mjs), never against the module's own arithmetic.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse } from "space-data-module-sdk/http";

import {
  buildGeoTiff,
  buildWaterTiff,
  decodeQuantizedMesh,
  decodeDtt,
  splitStream,
  geodeticToEcef,
} from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── the tile under test ─────────────────────────────────────────────────────
// GEOGRAPHIC_WGS84, TMS row origin: level 8 tiles span 180/256 = 0.703125
// degrees; (x=271, y=192) is [10.546875, 11.25] x [45.0, 45.703125] — inside
// the synthetic granule below.
const LEVEL = 8;
const TILE_X = 271;
const TILE_Y = 192;
const SPAN = 180 / 2 ** LEVEL;
const WEST = -180 + TILE_X * SPAN;
const EAST = WEST + SPAN;
const SOUTH = -90 + TILE_Y * SPAN;
const NORTH = SOUTH + SPAN;
const GRID = 65;

// The synthetic 64x64 granule: [10.5, 11.3] x [44.9, 45.8], a plane
// h = 100 + px + 2*py (exact in float32).
const GRANULE = {
  width: 64,
  height: 64,
  originLon: 10.5,
  originLat: 45.8,
  scaleLon: 0.8 / 63,
  scaleLat: 0.9 / 63,
  heightFn: (px, py) => 100 + px + 2 * py,
};

// The dataset contract, verbatim as the source publishes it (terms verified
// against the live licence document; see tests/fixtures/PROVENANCE.md).
const PROVENANCE = {
  datasetId: "cop-dem-glo-30",
  datasetName: "Copernicus DEM GLO-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: "2026-08-15T12:00:00.000Z",
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
  licenseUrl:
    "https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf",
  attribution:
    "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
  sourceUrl:
    "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E010_00_DEM/Copernicus_DSM_COG_10_N45_00_E010_00_DEM.tif",
};

const PLAN = {
  tilesetId: "spaceaware-terrain",
  level: LEVEL,
  x: TILE_X,
  y: TILE_Y,
  rowOriginNorth: false,
  scheme: "GEOGRAPHIC_WGS84",
  gridSize: GRID,
  maxLevel: 10,
  childAvailability: 15,
  sourceClass: "SPACEBORNE_RADAR_INTERFEROMETRIC",
  provenance: PROVENANCE,
};

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

// hostcap/http-request responseWire "raw-body-v1": "$HRB", little-endian
// status, body verbatim. This is the lane both granule ports actually run on;
// the JSON dialect above stays exercised so a recorded fixture keeps working.
export function rawBody(body, status = 200) {
  const out = Buffer.alloc(8 + body.length);
  out.write("$HRB", 0, "latin1");
  out.writeUInt32LE(status >>> 0, 4);
  Buffer.from(body).copy(out, 8);
  return out;
}

const rawBodyFrame = (portId, body, status = 200) => frame(portId, rawBody(body, status));

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) map.set(out.portId, out.payload);
  return map;
}

const asJson = (bytes) => JSON.parse(decoder.decode(bytes));

// Independent DEM sampler mirroring the stated contract: bilinear over the
// float32 raster at the post lattice.
function expectedHeights(granule = GRANULE) {
  const raster = [];
  for (let py = 0; py < granule.height; py++) {
    const row = [];
    for (let px = 0; px < granule.width; px++) row.push(Math.fround(granule.heightFn(px, py)));
    raster.push(row);
  }
  const heights = [];
  for (let j = 0; j < GRID; j++) {
    const lat = SOUTH + ((NORTH - SOUTH) * j) / (GRID - 1);
    for (let i = 0; i < GRID; i++) {
      const lon = WEST + ((EAST - WEST) * i) / (GRID - 1);
      const px = (lon - granule.originLon) / granule.scaleLon;
      const py = (granule.originLat - lat) / granule.scaleLat;
      const cx = Math.min(Math.max(px, 0), granule.width - 1);
      const cy = Math.min(Math.max(py, 0), granule.height - 1);
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(x0 + 1, granule.width - 1);
      const y1 = Math.min(y0 + 1, granule.height - 1);
      const fx = cx - x0;
      const fy = cy - y0;
      heights.push(
        (1 - fy) * ((1 - fx) * raster[y0][x0] + fx * raster[y0][x1]) +
          fy * ((1 - fx) * raster[y1][x0] + fx * raster[y1][x1]),
      );
    }
  }
  return heights;
}

async function encodeTile(
  t,
  { layout = "strip", predictor = 1, plan = PLAN, water = null, records: expect = 1 } = {},
) {
  const tiff = buildGeoTiff({ ...GRANULE, layout, predictor });
  const inputs = [jsonFrame("plan", plan), rawBodyFrame("dem", tiff)];
  if (water) inputs.push(rawBodyFrame("water", water));
  const outputs = outputsByPort(await invoke(t, "tile", inputs));
  const records = splitStream(outputs.get("records"));
  assert.equal(records.length, expect, "the plan yields exactly the records it addresses");
  return {
    dtt: expect === 1 ? decodeDtt(records[0]) : undefined,
    records: records.map((r) => decodeDtt(r)),
    report: asJson(outputs.get("report")),
  };
}

function meshOf(dtt) {
  assert.equal(dtt.payload.contentEncoding, "gzip");
  assert.equal(dtt.payload.mediaType, "application/vnd.quantized-mesh");
  assert.equal(Number(dtt.payload.sizeBytes), dtt.payload.bytes.length);
  return decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(dtt.payload.bytes)));
}

// ---------------------------------------------------------------------------
// tile — quantized-mesh encoding correctness
// ---------------------------------------------------------------------------

test("tile decodes a strip/deflate granule and the mesh reproduces the sampled heights", async (t) => {
  const { dtt, report } = await encodeTile(t);
  const expected = expectedHeights();
  const expMin = Math.min(...expected);
  const expMax = Math.max(...expected);

  assert.ok(Math.abs(dtt.minHeightM - expMin) < 1e-6, `min ${dtt.minHeightM} != ${expMin}`);
  assert.ok(Math.abs(dtt.maxHeightM - expMax) < 1e-6, `max ${dtt.maxHeightM} != ${expMax}`);
  assert.equal(report.granulesDecoded, 1);
  assert.equal(report.noDataSamples, 0);
  assert.equal(report.uncoveredSamples, 0);
  assert.equal(dtt.dataCoverageFraction, 1);

  const mesh = meshOf(dtt);
  assert.equal(mesh.vertexCount, GRID * GRID, "vertex count is gridSize^2");
  assert.equal(mesh.triangleCount, (GRID - 1) * (GRID - 1) * 2);
  assert.equal(mesh.bytesRead, zlib.gunzipSync(Buffer.from(dtt.payload.bytes)).length,
    "the mesh parses to exactly its own end");

  // Header min/max are float32 of the true range.
  assert.ok(Math.abs(mesh.header.minHeight - expMin) < 1e-3);
  assert.ok(Math.abs(mesh.header.maxHeight - expMax) < 1e-3);

  // Every decoded vertex reproduces the independently sampled height at its
  // (u,v) grid post within one quantization step.
  const qStep = (expMax - expMin) / 32767;
  for (let n = 0; n < mesh.vertexCount; n++) {
    const i = Math.round((mesh.u[n] * (GRID - 1)) / 32767);
    const j = Math.round((mesh.v[n] * (GRID - 1)) / 32767);
    const decodedHeight = expMin + (mesh.h[n] / 32767) * (expMax - expMin);
    assert.ok(
      Math.abs(decodedHeight - expected[j * GRID + i]) <= qStep + 1e-9,
      `vertex ${n} at post (${i},${j}): ${decodedHeight} vs ${expected[j * GRID + i]}`,
    );
  }
});

test("tile's index stream satisfies the high-water-mark and triangle invariants", async (t) => {
  const { dtt } = await encodeTile(t);
  const mesh = meshOf(dtt);
  // The high-water-mark decode (in helpers) only yields valid indices when
  // the encoder introduced every vertex exactly as it became the highest.
  let seenMax = -1;
  const covered = new Set();
  for (const idx of mesh.indices) {
    assert.ok(idx >= 0 && idx < mesh.vertexCount, `index ${idx} out of range`);
    assert.ok(idx <= seenMax + 1, "a vertex must first appear as the next highest index");
    seenMax = Math.max(seenMax, idx);
    covered.add(idx);
  }
  assert.equal(covered.size, mesh.vertexCount, "the triangulation touches every vertex");
  for (let n = 0; n < mesh.indices.length; n += 3) {
    const [a, b, c] = mesh.indices.slice(n, n + 3);
    assert.ok(a !== b && b !== c && a !== c, "no degenerate triangles");
  }
  // Edge index lists hold exactly the boundary posts.
  assert.equal(mesh.edges.west.length, GRID);
  assert.equal(mesh.edges.south.length, GRID);
  assert.equal(mesh.edges.east.length, GRID);
  assert.equal(mesh.edges.north.length, GRID);
  for (const n of mesh.edges.west) assert.equal(mesh.u[n], 0);
  for (const n of mesh.edges.south) assert.equal(mesh.v[n], 0);
  for (const n of mesh.edges.east) assert.equal(mesh.u[n], 32767);
  for (const n of mesh.edges.north) assert.equal(mesh.v[n], 32767);
});

test("tile's header geometry bounds every vertex and the occlusion point clears the ellipsoid", async (t) => {
  const { dtt } = await encodeTile(t);
  const mesh = meshOf(dtt);
  const expected = expectedHeights();
  // Recompute each vertex's ECEF position independently and check the
  // bounding sphere contains it.
  for (let n = 0; n < mesh.vertexCount; n++) {
    const lon = WEST + (mesh.u[n] / 32767) * (EAST - WEST);
    const lat = SOUTH + (mesh.v[n] / 32767) * (NORTH - SOUTH);
    const i = Math.round((mesh.u[n] * (GRID - 1)) / 32767);
    const j = Math.round((mesh.v[n] * (GRID - 1)) / 32767);
    const p = geodeticToEcef(lat, lon, expected[j * GRID + i]);
    const d = Math.hypot(
      p.x - mesh.header.sphereX,
      p.y - mesh.header.sphereY,
      p.z - mesh.header.sphereZ,
    );
    assert.ok(d <= mesh.header.sphereRadius + 1.0, `vertex ${n} escapes the bounding sphere`);
  }
  // The tile centre sits near the surface under the tile.
  const center = geodeticToEcef((SOUTH + NORTH) / 2, (WEST + EAST) / 2, 0);
  const centerError = Math.hypot(
    center.x - mesh.header.centerX,
    center.y - mesh.header.centerY,
    center.z - mesh.header.centerZ,
  );
  assert.ok(centerError < 100e3, "tile centre is where the tile is");
  // THE HORIZON OCCLUSION POINT IS IN ELLIPSOID-SCALED SPACE, NOT ECEF METRES.
  // CesiumTerrainProvider reads this field verbatim into
  // QuantizedMeshTerrainData._horizonOcclusionPoint and passes it to
  // EllipsoidalOccluder.isScaledSpacePointVisible as `occludeePointInScaledSpace`,
  // so a spec-conforming value has magnitude of order 1, never of order 1e6.
  // (Until 2026-08-26 the encoder multiplied the radii back in and THIS test
  // asserted `> 6356752.0`, i.e. it enforced the violation. The bound below is
  // the contract; the reference recomputation under it is the proof.)
  const occ = {
    x: mesh.header.occlusionX,
    y: mesh.header.occlusionY,
    z: mesh.header.occlusionZ,
  };
  const occMag = Math.hypot(occ.x, occ.y, occ.z);
  assert.ok(Number.isFinite(occMag));
  assert.ok(occMag >= 1.0, "occlusion point must lie on or outside the unit (scaled) ellipsoid");
  assert.ok(occMag < 10.0, `occlusion point must be SCALED, not ECEF metres (got ${occMag})`);

  // Reference implementation: Cesium EllipsoidalOccluder.computeHorizonCullingPoint
  // (computeMagnitude + magnitudeToPoint), transcribed and run over the same
  // vertices this tile encoded.
  const A = 6378137.0;
  const B = 6356752.3142451793;
  const toScaled = (p) => ({ x: p.x / A, y: p.y / A, z: p.z / B });
  const positions = [];
  for (let n = 0; n < mesh.vertexCount; n++) {
    const lon = WEST + (mesh.u[n] / 32767) * (EAST - WEST);
    const lat = SOUTH + (mesh.v[n] / 32767) * (NORTH - SOUTH);
    const i = Math.round((mesh.u[n] * (GRID - 1)) / 32767);
    const j = Math.round((mesh.v[n] * (GRID - 1)) / 32767);
    positions.push(geodeticToEcef(lat, lon, expected[j * GRID + i]));
  }
  const sc = toScaled({ x: mesh.header.centerX, y: mesh.header.centerY, z: mesh.header.centerZ });
  const cMag = Math.hypot(sc.x, sc.y, sc.z);
  const dir = { x: sc.x / cMag, y: sc.y / cMag, z: sc.z / cMag };
  let maxMagnitude = 0;
  for (const p of positions) {
    const sp = toScaled(p);
    let magSq = sp.x * sp.x + sp.y * sp.y + sp.z * sp.z;
    let mag = Math.sqrt(magSq);
    const u = { x: sp.x / mag, y: sp.y / mag, z: sp.z / mag };
    magSq = Math.max(1.0, magSq);
    mag = Math.max(1.0, mag);
    const cosAlpha = u.x * dir.x + u.y * dir.y + u.z * dir.z;
    const cross = {
      x: u.y * dir.z - u.z * dir.y,
      y: u.z * dir.x - u.x * dir.z,
      z: u.x * dir.y - u.y * dir.x,
    };
    const sinAlpha = Math.hypot(cross.x, cross.y, cross.z);
    const cosBeta = 1.0 / mag;
    const sinBeta = Math.sqrt(magSq - 1.0) * cosBeta;
    const denom = cosAlpha * cosBeta - sinAlpha * sinBeta;
    if (denom <= 0) continue;
    maxMagnitude = Math.max(maxMagnitude, 1.0 / denom);
  }
  const reference = { x: dir.x * maxMagnitude, y: dir.y * maxMagnitude, z: dir.z * maxMagnitude };
  for (const axis of ["x", "y", "z"]) {
    assert.ok(
      Math.abs(occ[axis] - reference[axis]) <= 1e-9 * Math.max(1, Math.abs(reference[axis])),
      `occlusion ${axis}: ${occ[axis]} != Cesium reference ${reference[axis]}`,
    );
  }
  // The point must actually occlude every vertex: each scaled vertex lies on
  // the near side of the plane through it, which is what the culling test asks.
  for (const p of positions) {
    const sp = toScaled(p);
    // Vertices BELOW the ellipsoid are the clamped case in Cesium's own
    // computeMagnitude and carry no such guarantee; the client recomputes the
    // point for those tiles (minimumHeight < 0) anyway.
    if (Math.hypot(sp.x, sp.y, sp.z) < 1.0) continue;
    const dot = sp.x * occ.x + sp.y * occ.y + sp.z * occ.z;
    assert.ok(dot >= 1.0 - 1e-9, "every vertex must be occluded by the emitted point");
  }
});

test("tile decodes the tiled + floating-point-predictor layout to the same heights", async (t) => {
  const strip = await encodeTile(t, { layout: "strip", predictor: 1 });
  const tiled = await encodeTile(t, { layout: "tile", predictor: 3 });
  assert.ok(Math.abs(strip.dtt.minHeightM - tiled.dtt.minHeightM) < 1e-9);
  assert.ok(Math.abs(strip.dtt.maxHeightM - tiled.dtt.maxHeightM) < 1e-9);
  // Identical rasters must produce byte-identical meshes.
  assert.deepEqual(
    zlib.gunzipSync(Buffer.from(tiled.dtt.payload.bytes)),
    zlib.gunzipSync(Buffer.from(strip.dtt.payload.bytes)),
  );
});

test("tile carries the $DTT contract: address, extents, datum, class, provenance verbatim", async (t) => {
  const { dtt } = await encodeTile(t);
  assert.equal(dtt.tilesetId, "spaceaware-terrain");
  assert.equal(dtt.tilingScheme, 1, "GEOGRAPHIC_WGS84");
  assert.equal(dtt.level, LEVEL);
  assert.equal(dtt.x, TILE_X);
  assert.equal(dtt.y, TILE_Y);
  assert.equal(dtt.rowOriginNorth, false, "TMS row origin");
  assert.equal(dtt.westDeg, WEST);
  assert.equal(dtt.southDeg, SOUTH);
  assert.equal(dtt.eastDeg, EAST);
  assert.equal(dtt.northDeg, NORTH);
  assert.equal(dtt.payloadFormat, 1, "QUANTIZED_MESH");
  assert.equal(dtt.payloadFormatVersion, "1.0");
  // GRID_WIDTH/GRID_HEIGHT are for GRIDDED payloads. The schema says "Unset
  // for mesh formats, whose vertex count varies" and this payload is
  // QUANTIZED_MESH, so the sampling lattice is NOT stated as the served
  // geometry; POST_SPACING_M carries the effective resolution.
  assert.equal(dtt.gridWidth, 0, "unset for a mesh payload");
  assert.equal(dtt.gridHeight, 0, "unset for a mesh payload");
  assert.ok(dtt.postSpacingM > 1100 && dtt.postSpacingM < 1300, "≈1.2 km posts at level 8 / grid 65");
  assert.equal(dtt.verticalDatum, 2, "GEOID — heights redistributed as published, not converted");
  assert.equal(dtt.verticalDatumName, "EGM2008");
  assert.equal(dtt.noDataValue, -32767);
  assert.equal(dtt.childAvailability, 15);
  assert.equal(dtt.maxLevel, 10);
  // SOURCE_CLASS comes from the PLAN, like every other provenance field; it
  // is not a compile-time constant that would keep asserting radar
  // interferometry after an operator repointed the module at another dataset.
  assert.equal(dtt.sourceClass, 1, "SPACEBORNE_RADAR_INTERFEROMETRIC, as the plan states");
  assert.ok(
    dtt.sourcePostSpacingM > 0,
    "the source raster's own post spacing is stated, not left at 0",
  );
  // The fixture's source surface is a PLANE (100 + px + 2*py), which a
  // triangulated lattice reproduces exactly, so the measured departure is
  // legitimately 0 here. What the record must state is that it was MEASURED:
  // ACCURACY_CONFIDENCE 1.0 is written only when probes actually ran.
  assert.equal(dtt.accuracyConfidence, 1, "the accuracy figure is measured, not asserted");
  assert.equal(dtt.verticalAccuracyM, 0, "a planar source is reproduced exactly");
  assert.ok(dtt.remarks.includes("geoid"), "the datum decision is stated on the record");
  // Provenance rides VERBATIM from the plan — never invented, never edited.
  assert.equal(dtt.provenance.datasetId, PROVENANCE.datasetId);
  assert.equal(dtt.provenance.datasetName, PROVENANCE.datasetName);
  assert.equal(dtt.provenance.datasetEpoch, PROVENANCE.datasetEpoch);
  assert.equal(dtt.provenance.retrievedAt, PROVENANCE.retrievedAt);
  assert.equal(dtt.provenance.license, PROVENANCE.license);
  assert.equal(dtt.provenance.licenseUrl, PROVENANCE.licenseUrl);
  assert.equal(dtt.provenance.attribution, PROVENANCE.attribution);
  assert.equal(dtt.provenance.sourceUrl, PROVENANCE.sourceUrl);
});

test("tile writes the watermask extension: uniform by default, raster from the water granule", async (t) => {
  const land = await encodeTile(t);
  assert.equal(land.dtt.waterMaskKind, 1, "UNIFORM_LAND when a granule exists and the plan is silent");
  const landMesh = meshOf(land.dtt);
  const landExt = landMesh.extensions.find((e) => e.id === 2);
  assert.ok(landExt, "watermask extension (id 2) present");
  assert.equal(landExt.bytes.length, 1);
  assert.equal(landExt.bytes[0], 0x00);

  // Janus (e): the mask is CLASSIFIED from a water-body granule that arrived
  // over the same http lane, never handed to the encoder as base64 inside the
  // plan. The granule below is water north of a fixed parallel inside the
  // tile, so the cut mask must be a RASTER, not a uniform byte.
  const CUT = (NORTH + SOUTH) / 2;
  const waterGranule = buildWaterTiff({
    width: 240,
    height: 240,
    originLon: GRANULE.originLon,
    originLat: GRANULE.originLat,
    scaleLon: 0.8 / 239,
    scaleLat: 0.9 / 239,
    // class 1 = ocean in the source convention; 0 = no water.
    classFn: (px, py) => (GRANULE.originLat - (py * 0.9) / 239 > CUT ? 1 : 0),
    layout: "tile",
    tileWidth: 64,
    tileHeight: 64,
  });
  const { dtt } = await encodeTile(t, { water: waterGranule });
  assert.equal(dtt.waterMaskKind, 3, "RASTER");
  assert.equal(dtt.waterMaskWidth, 256, "WATER_MASK_WIDTH is set with the bytes, never alone");
  assert.equal(dtt.waterMaskHeight, 256);
  // Stored GZIPPED (DTTPayloadRef.CONTENT_ENCODING): a 64 KiB two-valued
  // raster whose bytes also ride inside the gzipped mesh payload.
  assert.equal(dtt.waterMask.contentEncoding, "gzip");
  const mask = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
  assert.equal(mask.length, 256 * 256);
  assert.ok(dtt.waterMask.digest?.startsWith("1220"), "the mask states its own sha2-256 multihash");

  // Row 0 is the NORTH edge (Atlas), and the classification is the granule's,
  // sampled NEAREST-NEIGHBOUR — a category is never interpolated, so the
  // expectation is the class of the NEAREST SOURCE PIXEL, not of the
  // continuous cut. Mirrored here independently of the module.
  const nearestClass = (lat) => {
    const py = Math.round((GRANULE.originLat - lat) / (0.9 / 239));
    const clamped = Math.min(Math.max(py, 0), 239);
    return GRANULE.originLat - (clamped * 0.9) / 239 > CUT ? 255 : 0;
  };
  let water = 0;
  for (let r = 0; r < 256; r++) {
    const expected = nearestClass(NORTH - (r * (NORTH - SOUTH)) / 255);
    for (let c = 0; c < 256; c++) {
      assert.equal(mask[r * 256 + c], expected, `mask post r=${r} c=${c}`);
    }
    if (expected === 255) water += 256;
  }
  assert.ok(water > 0 && water < 256 * 256, "the cut tile really is mixed, not uniform");

  // The extension carries exactly those bytes.
  const ext = meshOf(dtt).extensions.find((e) => e.id === 2);
  assert.equal(ext.bytes.length, 256 * 256);
  assert.deepEqual(Buffer.from(ext.bytes), mask);

  // A directive whose geometry is not the 256x256 this encoder cuts is
  // refused: the shared-edge identity between adjacent tiles depends on it.
  const mismatch = await invoke(t, "tile", [
    jsonFrame("plan", { ...PLAN, waterMask: { kind: "RASTER", width: 128, height: 128 } }),
    rawBodyFrame("dem", buildGeoTiff({ ...GRANULE })),
    rawBodyFrame("water", waterGranule),
  ]);
  assert.equal(mismatch.errorCode, "water-mask-size-mismatch");

  // And a RASTER directive with no granule to classify is refused rather than
  // fabricated from the directive alone.
  const noGranule = await invoke(t, "tile", [
    jsonFrame("plan", { ...PLAN, waterMask: { kind: "RASTER" } }),
    rawBodyFrame("dem", buildGeoTiff({ ...GRANULE })),
  ]);
  assert.equal(noGranule.errorCode, "missing-water-granule");
});

test("an absent granule (404) is open ocean: height 0, UNIFORM_WATER, coverage 0", async (t) => {
  const outputs = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", PLAN),
      jsonFrame("dem", { status: 404, headers: {}, bodyB64: "" }),
    ]),
  );
  const dtt = decodeDtt(splitStream(outputs.get("records"))[0]);
  assert.equal(dtt.minHeightM, 0);
  assert.equal(dtt.maxHeightM, 0);
  assert.equal(dtt.waterMaskKind, 2, "UNIFORM_WATER unless the plan says otherwise");
  assert.equal(dtt.dataCoverageFraction, 0, "sea level here is a fill, not a measurement");
  const mesh = meshOf(dtt);
  assert.equal(mesh.header.minHeight, 0);
  assert.equal(mesh.header.maxHeight, 0);
  const ext = mesh.extensions.find((e) => e.id === 2);
  assert.equal(ext.bytes[0], 0xff, "uniform water byte");
  const report = asJson(outputs.get("report"));
  assert.equal(report.granulesAbsent, 1);
  assert.equal(report.waterMaskKind, "UNIFORM_WATER");
  // …and the plan can still overrule the ocean default.
  const overruled = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", { ...PLAN, waterMask: { kind: "UNIFORM_LAND" } }),
      jsonFrame("dem", { status: 404, headers: {}, bodyB64: "" }),
    ]),
  );
  assert.equal(decodeDtt(splitStream(overruled.get("records"))[0]).waterMaskKind, 1);
});

test("NO_DATA samples decode to 0 and are counted in DATA_COVERAGE_FRACTION, never hidden", async (t) => {
  // A granule of constant 50 m with a NO_DATA hole over the tile's south-west
  // quarter.
  const holed = {
    ...GRANULE,
    heightFn: (px, py) => (px < 20 && py > 44 ? -32767 : 50),
  };
  const tiff = buildGeoTiff({ ...holed, layout: "strip", predictor: 1 });
  const outputs = outputsByPort(
    await invoke(t, "tile", [jsonFrame("plan", PLAN), responseFrame("dem", tiff)]),
  );
  const dtt = decodeDtt(splitStream(outputs.get("records"))[0]);
  const report = asJson(outputs.get("report"));
  assert.equal(dtt.minHeightM, 0, "a NO_DATA post reads 0");
  assert.equal(dtt.maxHeightM, 50);
  assert.ok(report.noDataSamples > 0);
  assert.ok(dtt.dataCoverageFraction < 1 && dtt.dataCoverageFraction > 0);
  assert.equal(dtt.dataCoverageFraction, 1 - report.noDataSamples / (GRID * GRID));
});

test("tile refuses what must never be defaulted or silently decoded", async (t) => {
  const tiff = buildGeoTiff({ ...GRANULE, layout: "strip", predictor: 1 });
  // A plan that cannot state the dataset contract.
  for (const missing of ["datasetId", "datasetEpoch", "retrievedAt", "license"]) {
    const provenance = { ...PROVENANCE };
    delete provenance[missing];
    const response = await invoke(t, "tile", [
      jsonFrame("plan", { ...PLAN, provenance }),
      responseFrame("dem", tiff),
    ]);
    assert.notEqual(response.statusCode, 0, `${missing} must not be defaultable`);
    assert.equal(response.errorCode, "incomplete-dataset-contract");
    assert.equal(response.outputs.length, 0, "nothing is published under a guessed epoch");
  }
  // A failed fetch is not open ocean.
  const failed = await invoke(t, "tile", [
    jsonFrame("plan", PLAN),
    jsonFrame("dem", { status: 503, headers: {}, bodyB64: "" }),
  ]);
  assert.notEqual(failed.statusCode, 0);
  assert.equal(failed.errorCode, "upstream-status");
  // A truncated granule is refused, never decoded to a partial raster.
  const truncated = await invoke(t, "tile", [
    jsonFrame("plan", PLAN),
    responseFrame("dem", tiff.subarray(0, Math.floor(tiff.length / 2))),
  ]);
  assert.notEqual(truncated.statusCode, 0);
  assert.equal(truncated.errorCode, "geotiff-undecodable");
});

test("tile accepts multiple granules but refuses a batched plan and a granule surplus", async (t) => {
  // Two granules splitting the tile east/west decode cleanly together.
  const westGranule = buildGeoTiff({
    ...GRANULE, originLon: 10.5, scaleLon: 0.45 / 63, heightFn: () => 10,
  });
  const eastGranule = buildGeoTiff({
    ...GRANULE, originLon: 10.94, scaleLon: 0.45 / 63, heightFn: () => 10,
  });
  const outputs = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", PLAN),
      responseFrame("dem", westGranule),
      responseFrame("dem", eastGranule),
    ]),
  );
  const dtt = decodeDtt(splitStream(outputs.get("records"))[0]);
  assert.equal(dtt.dataCoverageFraction, 1, "the two granules cover the whole tile");
  assert.equal(dtt.minHeightM, 10);
  assert.equal(dtt.maxHeightM, 10);

  // A second plan frame is a surplus the runtime would otherwise destroy.
  const doublePlan = await invoke(t, "tile", [
    jsonFrame("plan", PLAN),
    jsonFrame("plan", PLAN),
    responseFrame("dem", westGranule),
  ]);
  assert.notEqual(doublePlan.statusCode, 0);
  assert.equal(doublePlan.errorCode, "batched-input-frames");

  // Five dem frames exceed the four-corner-granule budget.
  const five = await invoke(t, "tile", [
    jsonFrame("plan", PLAN),
    ...Array.from({ length: 5 }, () => responseFrame("dem", westGranule)),
  ]);
  assert.notEqual(five.statusCode, 0);
  assert.equal(five.errorCode, "batched-input-frames");
});

// ---------------------------------------------------------------------------
// layer_json
// ---------------------------------------------------------------------------

test("layer_json renders the complete body inside the canonical $HTR envelope", async (t) => {
  const available = [
    [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
    [{ startX: 0, startY: 0, endX: 3, endY: 1 }],
  ];
  const response = await invoke(t, "layer_json", [
    jsonFrame("plan", {
      tilesetId: "spaceaware-terrain",
      maxzoom: 10,
      attribution: PROVENANCE.attribution,
      available,
    }),
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");
  const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
  assert.equal(http.status, 200);
  assert.equal(
    http.headers.find((h) => h.name === "content-type")?.value,
    "application/json",
  );
  const body = JSON.parse(Buffer.from(http.body).toString("utf8"));
  assert.equal(body.tilejson, "2.1.0");
  assert.equal(body.name, "spaceaware-terrain");
  assert.equal(body.format, "quantized-mesh-1.0");
  assert.equal(body.scheme, "tms");
  assert.deepEqual(body.tiles, ["{z}/{x}/{y}.terrain?v={version}"]);
  assert.equal(body.projection, "EPSG:4326");
  assert.deepEqual(body.bounds, [-180, -90, 180, 90]);
  assert.equal(body.minzoom, 0);
  assert.equal(body.maxzoom, 10);
  assert.deepEqual(body.extensions, ["watermask"], "octvertexnormals omitted until normals ship");
  assert.deepEqual(body.available, available, "availability rides through verbatim");
  assert.equal(body.attribution, PROVENANCE.attribution);
});

test("layer_json refuses a plan that cannot state maxzoom or availability", async (t) => {
  const noZoom = await invoke(t, "layer_json", [
    jsonFrame("plan", { tilesetId: "x", available: [[]] }),
  ]);
  assert.notEqual(noZoom.statusCode, 0);
  assert.equal(noZoom.errorCode, "missing-maxzoom");
  const noAvail = await invoke(t, "layer_json", [
    jsonFrame("plan", { tilesetId: "x", maxzoom: 4 }),
  ]);
  assert.notEqual(noAvail.statusCode, 0);
  assert.equal(noAvail.errorCode, "missing-availability");
});
