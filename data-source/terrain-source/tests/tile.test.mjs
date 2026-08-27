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
  // THE LATTICE IS PINNED for the encoding invariants below. Density otherwise
  // adapts to relief inside the 32 KiB cap (coordinator 2026-08-27 (a)), and
  // this fixture is an exact plane — the coarsest candidate describes it to
  // quantisation, which is the feature working, and would leave assertions
  // about "the mesh at GRID posts" with a different mesh to look at. The
  // adaptation itself has its own test at the end of this file.
  minGridSize: GRID,
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
  // The body is gzipped when the caller accepts it (a plan with no negotiation
  // states nothing, and RFC 9110 12.5.3 reads that as "anything is
  // acceptable"), so the policy headers say so and the body is read through
  // the coding it declares.
  assert.equal(
    http.headers.find((h) => h.name === "content-encoding")?.value,
    "gzip",
    "layer.json compresses, like every tile",
  );
  const body = JSON.parse(zlib.gunzipSync(Buffer.from(http.body)).toString("utf8"));
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

// ── DENSITY ADAPTS TO RELIEF, INSIDE A CAP THAT NEVER MOVES ────────────────
//
// Coordinator reconciliation 2026-08-27 (a): "Mesh density adapts per tile to
// relief inside a 32 KiB gzipped HARD cap (never exceeded), targeting
// worst-post vertical error <= 2 x 77067/2^level m; where the cap cannot meet
// it the tile ships AT the cap with its measured VERTICAL_ACCURACY_M stated in
// the record (never silently)."
//
// A fixed gridSize was wrong in both directions at once: a flat or gently
// rolling tile paid 65x65 posts to describe a plane, while a tile whose relief
// genuinely needed them could only be made coarser plan-wide. What is asserted
// here is the RULING, in all three of its parts.
const ERROR_TARGET_M = (level) => (2 * 77067) / 2 ** level;

async function encodeRelief(t, heightFn, plan = {}) {
  const tiff = buildGeoTiff({ ...GRANULE, width: 256, height: 256, scaleLon: 0.8 / 255, scaleLat: 0.9 / 255, heightFn, layout: "strip", predictor: 1 });
  const outputs = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", { ...PLAN, minGridSize: 5, ...plan }),
      responseFrame("dem", tiff),
    ]),
  );
  const report = asJson(outputs.get("report"));
  return {
    dtt: decodeDtt(splitStream(outputs.get("records"))[0]),
    tile: report.tiles[0],
    // maxGridSize is a property of the PLAN and therefore of the block, not of
    // one tile; it is read where it lives.
    report,
  };
}

test("a tile the source describes exactly ships COARSE, and says which lattice it shipped", async (t) => {
  // An exact plane: every candidate reproduces it, so the coarsest one meets
  // the target and the search stops there.
  const { dtt, tile } = await encodeRelief(t, (px, py) => 100 + px + 2 * py);
  assert.ok(tile.gridSize < GRID, `a plane must not cost ${GRID} posts, got ${tile.gridSize}`);
  assert.equal(tile.atCeiling, false, "the target was met, so nothing was compromised");
  // The report renders doubles at a fixed precision, so the target is compared
  // to the tolerance it is printed at rather than bit for bit.
  assert.ok(
    Math.abs(tile.errorTargetM - ERROR_TARGET_M(LEVEL)) < 1e-3,
    `2 x 77067/2^level, as ruled: ${tile.errorTargetM} vs ${ERROR_TARGET_M(LEVEL)}`,
  );
  assert.ok(
    dtt.verticalAccuracyM <= tile.errorTargetM,
    `measured ${dtt.verticalAccuracyM} m against a target of ${tile.errorTargetM} m`,
  );
  // …and the record STATES what it achieved, always — an unstated accuracy is
  // the one field a consumer would read to reason about exactly this.
  assert.ok(tile.accuracyProbes > 0, "the figure is a measurement, not a default");
});

test("a tile with real relief ships DENSER, and still meets the target", async (t) => {
  // Relief the coarse candidates cannot describe: the search must climb.
  const rough = (px, py) => 800 * Math.sin(px / 3.1) + 700 * Math.cos(py / 2.7);
  const flat = await encodeRelief(t, (px, py) => 100 + px + 2 * py);
  const { dtt, tile } = await encodeRelief(t, rough);
  assert.ok(
    tile.gridSize > flat.tile.gridSize,
    `relief must buy posts: rough ${tile.gridSize} vs flat ${flat.tile.gridSize}`,
  );
  if (!tile.atCeiling) {
    assert.ok(
      dtt.verticalAccuracyM <= tile.errorTargetM,
      `measured ${dtt.verticalAccuracyM} m against a target of ${tile.errorTargetM} m`,
    );
  }
});

test("THE CAP IS HARD: a tile that cannot meet the target ships AT it, stating what it achieved", async (t) => {
  // Relief no lattice this plan admits can describe, so the search runs out.
  // Whatever happens, the two invariants hold: the payload is under the cap,
  // and the record does not claim an accuracy it does not have.
  const violent = (px, py) => 4000 * Math.sin(px * 1.7) * Math.cos(py * 1.9) + 3000 * Math.sin(px * 0.9 + py * 1.3);
  const { dtt, tile } = await encodeRelief(t, violent);
  assert.ok(
    tile.payloadBytes <= 32 * 1024,
    `the 32 KiB gzipped ceiling is HARD: ${tile.payloadBytes} B`,
  );
  assert.ok(tile.accuracyProbes > 0, "and it is measured, not asserted");
  assert.ok(
    Math.abs(dtt.verticalAccuracyM - tile.verticalAccuracyM) < 1e-3,
    "the number the record states is the number the search measured — one measurement, not two",
  );
  if (tile.atCeiling) {
    assert.ok(
      dtt.verticalAccuracyM > tile.errorTargetM,
      "atCeiling means the target was NOT met; a tile that met it must not claim otherwise",
    );
  }
});

test("with the accuracy measurement OFF, density is the plan's own gridSize — never the coarsest", async (t) => {
  // The first cut of the search broke out of the loop on the FIRST candidate
  // when there was no error signal, and the loop runs coarsest-first: it
  // shipped 5x5 meshes for every tile whenever a caller turned measurement
  // off, while the comment above it claimed the opposite. With no signal there
  // is nothing that could justify shipping fewer posts than were asked for.
  const { tile } = await encodeRelief(t, (px, py) => 100 + px + 2 * py, {
    measureAccuracy: false,
  });
  assert.equal(tile.gridSize, GRID, "no measurement, no coarsening");
  assert.equal(tile.accuracyProbes, 0, "…and no accuracy is claimed either");
});

test("THE CAP is what stops the climb, not the plan's gridSize", async (t) => {
  // The ruling is that density adapts "inside a 32 KiB gzipped HARD cap" and
  // that a tile ships at the cap where the CAP cannot meet the target. The cap
  // can only be the limit if the search is allowed to climb past the plan's own
  // number — a ladder topped at gridSize makes gridSize the limit and the cap
  // decorative, which is what the first cut did: the regional run shipped
  // 8.4 KB tiles (a quarter of the cap) that still missed the target at z10
  // and z11.
  // Relief a 33-post mesh cannot describe to this level's target (z8, so
  // 2 x 77067/256 = 602 m): the search has to WANT more posts before "let it
  // climb" is a testable claim at all. The pair is 33 -> 65 rather than
  // 65 -> 129 because the 32 KiB cap is real: a 129-post mesh of this fixture
  // is ~297 KB uncompressed and does not fit, which is the cap doing its job
  // and would test the wrong half of the sentence.
  const rough = (px, py) =>
    3200 * Math.sin(px / 1.9) * Math.cos(py / 1.6) + 2600 * Math.sin(px / 0.9 + py / 1.1);
  const capped = await encodeRelief(t, rough, { gridSize: 33 });     // maxGridSize defaults to gridSize
  const climbing = await encodeRelief(t, rough, { gridSize: 33, maxGridSize: 65 });

  assert.equal(capped.report.maxGridSize, 33, "the default is the plan's own gridSize: no surprises");
  assert.equal(climbing.report.maxGridSize, 65);
  assert.equal(capped.tile.gridSize, 33, "capped at the plan's own number");
  assert.ok(
    climbing.tile.gridSize > capped.tile.gridSize,
    `the climb must actually happen: ${climbing.tile.gridSize} vs ${capped.tile.gridSize}`,
  );
  assert.ok(
    climbing.dtt.verticalAccuracyM < capped.dtt.verticalAccuracyM,
    `and it must buy accuracy: ${climbing.dtt.verticalAccuracyM} m vs ${capped.dtt.verticalAccuracyM} m`,
  );
  // The cap is still hard on the way up.
  assert.ok(climbing.tile.payloadBytes <= 32 * 1024, `${climbing.tile.payloadBytes} B`);

  // …and the record describes the mesh it SHIPPED, not the one the plan asked
  // for. POST_SPACING_M is the MESH's own lattice (it used to be derived from
  // the plan's gridSize, which with adaptive density describes a mesh nobody
  // has); SOURCE_POST_SPACING_M is the granule's and is unchanged by any of
  // this, which is the distinction the two fields exist for.
  assert.ok(
    climbing.dtt.postSpacingM < capped.dtt.postSpacingM,
    `a denser mesh states a finer post spacing: ${climbing.dtt.postSpacingM} vs ${capped.dtt.postSpacingM}`,
  );
  assert.equal(
    climbing.dtt.sourcePostSpacingM,
    capped.dtt.sourcePostSpacingM,
    "the SOURCE's spacing is a fact about the granule and does not move with the mesh",
  );
});

test("every candidate is a SUBSET of one lattice, so neighbours agree on shared posts", async (t) => {
  // Two adjacent tiles may settle on different densities. Their shared edge
  // posts still come from the same global lattice — post j of an M-post tile is
  // post j*(N-1)/(M-1) of an N-post tile at the same address, exactly — and
  // that is the property the pyramid's seam check rests on. Asserted here on
  // ONE tile encoded at two densities: the coarse mesh's posts must be present,
  // to quantisation, in the fine mesh at the strided indices.
  const rough = (px, py) => 300 * Math.sin(px / 5.5) + 250 * Math.cos(py / 4.5);
  const coarse = await encodeRelief(t, rough, { minGridSize: 9, maxGridSize: 9, gridSize: 9 });
  const fine = await encodeRelief(t, rough, { minGridSize: 65, maxGridSize: 65 });
  assert.equal(coarse.tile.gridSize, 9);
  assert.equal(fine.tile.gridSize, 65);

  const posts = (result, grid) => {
    const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(result.dtt.payload.bytes)));
    const range = mesh.header.maxHeight - mesh.header.minHeight;
    const out = new Map();
    for (let n = 0; n < mesh.vertexCount; n += 1) {
      const i = Math.round((mesh.u[n] * (grid - 1)) / 32767);
      const j = Math.round((mesh.v[n] * (grid - 1)) / 32767);
      out.set(`${i}/${j}`, mesh.header.minHeight + (mesh.h[n] / 32767) * range);
    }
    return out;
  };
  const coarsePosts = posts(coarse, 9);
  const finePosts = posts(fine, 65);
  const stride = 64 / 8;
  const tolerance =
    Math.max(
      (coarse.dtt.maxHeightM - coarse.dtt.minHeightM) / 32767,
      (fine.dtt.maxHeightM - fine.dtt.minHeightM) / 32767,
    ) + 1e-9;
  let compared = 0;
  for (let j = 0; j < 9; j += 1) {
    for (let i = 0; i < 9; i += 1) {
      const a = coarsePosts.get(`${i}/${j}`);
      const b = finePosts.get(`${i * stride}/${j * stride}`);
      assert.ok(a !== undefined && b !== undefined, `post ${i}/${j} missing`);
      assert.ok(
        Math.abs(a - b) <= tolerance,
        `post ${i}/${j}: coarse ${a} m vs fine ${b} m (tolerance ${tolerance} m)`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, 81);
});

// ── THE PROBE LOOKS INSIDE BOTH TRIANGLES, NOT ALONG THE DIAGONAL ──────────
//
// The first cut of measure_mesh_accuracy evaluated three positions per cell at
// du == dv == {0.5, 1/3, 2/3}. All three lie ON THE SPLIT DIAGONAL, so the
// interior of both triangles was never looked at — while the comment above it
// claimed "the centre and both triangle centroids". The real centroids are
// (2/3, 1/3) and (1/3, 2/3).
//
// That is not a cosmetic slip. The SAME function selects the density ladder
// and writes $DTT.VERTICAL_ACCURACY_M, so a blind probe stopped the climb
// early and then stated the resulting error as small: re-measured against the
// source over this lane's whole regional store, it reported 4.496 m on a tile
// whose true worst departure is 290.5 m, and 8.8% of z11 tiles missed the
// ruled target while their records said they met it.
//
// THE FIXTURE IS BLIND TO A DIAGONAL PROBE BY CONSTRUCTION. The granule is a
// flat 100 m plane carrying two 3x3-post plateaus per mesh cell, centred
// exactly on the two real centroids and nowhere near the diagonal. Every mesh
// VERTEX sits on the plane, so the rendered surface is flat at 100 m; every
// position with du == dv reads exactly 100 m, so the old probe reports 0.000;
// and the true worst-post departure is exactly 500 m. A run that reports 0 on
// this fixture is the defect, and it cannot report 500 without evaluating a
// position off the diagonal.
const PROBE_CELLS = 4; // gridSize 5 -> 4 cells across
const PROBE_SUB = 18; // granule posts per mesh cell (1/3 of a cell = 6 posts)
const PROBE_MARGIN = 2;
const PROBE_SPAN_POSTS = PROBE_CELLS * PROBE_SUB; // 72 granule intervals across the tile
const PROBE_STEP = SPAN / PROBE_SPAN_POSTS;
const PROBE_BASE_M = 100;
const PROBE_RELIEF_M = 500;

// A plateau rather than a single post so that a sub-pixel difference between
// the encoder's lattice arithmetic and this granule's georeference still lands
// on it — the assertion is about WHERE the probe looks, not about float
// reproducibility between two different orders of operations.
const onCentroidPlateau = (ic, jc) => {
  const near = (v, c) => v >= c - 1 && v <= c + 1;
  return (
    (near(ic, PROBE_SUB / 3) && near(jc, (2 * PROBE_SUB) / 3)) ||
    (near(ic, (2 * PROBE_SUB) / 3) && near(jc, PROBE_SUB / 3))
  );
};

const probeGranule = (withRelief) => ({
  width: PROBE_SPAN_POSTS + 2 * PROBE_MARGIN + 1,
  height: PROBE_SPAN_POSTS + 2 * PROBE_MARGIN + 1,
  originLon: WEST - PROBE_MARGIN * PROBE_STEP,
  originLat: NORTH + PROBE_MARGIN * PROBE_STEP,
  scaleLon: PROBE_STEP,
  scaleLat: PROBE_STEP,
  layout: "strip",
  predictor: 1,
  heightFn: (px, py) => {
    if (!withRelief) return PROBE_BASE_M;
    const it = px - PROBE_MARGIN; // west -> east across the tile
    const jt = PROBE_MARGIN + PROBE_SPAN_POSTS - py; // south -> north, the lattice's own direction
    if (it < 0 || it > PROBE_SPAN_POSTS || jt < 0 || jt > PROBE_SPAN_POSTS) return PROBE_BASE_M;
    return onCentroidPlateau(it % PROBE_SUB, jt % PROBE_SUB)
      ? PROBE_BASE_M + PROBE_RELIEF_M
      : PROBE_BASE_M;
  },
});

async function encodeProbeFixture(t, { maxGridSize, withRelief = true }) {
  const outputs = outputsByPort(
    await invoke(t, "tile", [
      jsonFrame("plan", { ...PLAN, gridSize: 5, minGridSize: 5, maxGridSize }),
      responseFrame("dem", buildGeoTiff(probeGranule(withRelief))),
    ]),
  );
  const report = asJson(outputs.get("report"));
  return { dtt: decodeDtt(splitStream(outputs.get("records"))[0]), tile: report.tiles[0] };
}

// What the OLD probe would have found on this fixture, computed here rather
// than asserted in prose: bilinear over the same granule at du == dv ==
// {0.5, 1/3, 2/3} of every cell. The mesh is flat at PROBE_BASE_M, so this IS
// the departure a diagonal-only probe reports.
function diagonalOnlyWorstDeparture() {
  const g = probeGranule(true);
  const sample = (lon, lat) => {
    const px = (lon - g.originLon) / g.scaleLon;
    const py = (g.originLat - lat) / g.scaleLat;
    const i0 = Math.floor(px);
    const j0 = Math.floor(py);
    const fx = px - i0;
    const fy = py - j0;
    const at = (i, j) =>
      Math.fround(
        g.heightFn(Math.min(Math.max(i, 0), g.width - 1), Math.min(Math.max(j, 0), g.height - 1)),
      );
    return (
      (1 - fy) * ((1 - fx) * at(i0, j0) + fx * at(i0 + 1, j0)) +
      fy * ((1 - fx) * at(i0, j0 + 1) + fx * at(i0 + 1, j0 + 1))
    );
  };
  let worst = 0;
  for (let j = 0; j < PROBE_CELLS; j++) {
    for (let i = 0; i < PROBE_CELLS; i++) {
      for (const d of [0.5, 1 / 3, 2 / 3]) {
        const lon = WEST + ((i + d) * SPAN) / PROBE_CELLS;
        const lat = SOUTH + ((j + d) * SPAN) / PROBE_CELLS;
        worst = Math.max(worst, Math.abs(sample(lon, lat) - PROBE_BASE_M));
      }
    }
  }
  return worst;
}

test("the accuracy probe evaluates BOTH TRIANGLES, not just the split diagonal", async (t) => {
  // MEASURED, not asserted: the fixture really is invisible to the old pattern.
  assert.ok(
    diagonalOnlyWorstDeparture() < 1e-3,
    `every du == dv position on this fixture reads the plane, so the collinear probe ` +
      `reports ${diagonalOnlyWorstDeparture()} m — that is what made it blind`,
  );
  // stride == 1: the mesh carries every post the plan sampled, so the probe
  // goes back to the source — at the centre and BOTH REAL CENTROIDS. This is
  // the exact position set the old comment described and the old code did not
  // evaluate.
  const { dtt, tile } = await encodeProbeFixture(t, { maxGridSize: 5 });
  assert.equal(tile.gridSize, 5, "the plan pins the lattice, so the mesh is the lattice");
  assert.equal(tile.accuracyProbes, 3 * (5 - 1) ** 2, "three positions per cell at stride 1");
  assert.ok(
    Math.abs(dtt.verticalAccuracyM - PROBE_RELIEF_M) < 1e-3,
    `the centroids carry ${PROBE_RELIEF_M} m of relief the diagonal cannot see; ` +
      `the record states ${dtt.verticalAccuracyM} m (a diagonal-only probe reports 0)`,
  );
});

test("the probe count scales with CELL SIZE: every sampled post the mesh dropped", async (t) => {
  // stride > 1: every post of the finest lattice the plan admits that the
  // candidate does NOT carry is a source measurement strictly inside one of its
  // cells. That is the worst-post error the target names, it costs no source
  // sampling at all, and for stride >= 3 the position set CONTAINS both real
  // centroids exactly — so the collinear failure cannot recur at any density.
  const { dtt, tile } = await encodeProbeFixture(t, { maxGridSize: 13 });
  assert.equal(tile.gridSize, 5, "500 m clears the level-8 target, so the ladder stops at 5");
  assert.equal(
    tile.accuracyProbes,
    13 ** 2 - 5 ** 2,
    "every lattice post except the mesh's own vertices — 144, not the fixed 48",
  );
  assert.ok(
    Math.abs(dtt.verticalAccuracyM - PROBE_RELIEF_M) < 1e-3,
    `worst-post departure ${dtt.verticalAccuracyM} m against ${PROBE_RELIEF_M} m of real relief`,
  );
});

test("…and the same probe reports ZERO on the same fixture with the relief removed", async (t) => {
  // The control. Without it, both assertions above would also pass on a probe
  // that returned 500 for every input.
  for (const maxGridSize of [5, 13]) {
    const { dtt, tile } = await encodeProbeFixture(t, { maxGridSize, withRelief: false });
    assert.ok(tile.accuracyProbes > 0, `stride ${maxGridSize === 5 ? 1 : 3}: it still measured`);
    assert.ok(
      dtt.verticalAccuracyM < 1e-3,
      `a plane departs from itself by nothing: ${dtt.verticalAccuracyM} m`,
    );
  }
});
