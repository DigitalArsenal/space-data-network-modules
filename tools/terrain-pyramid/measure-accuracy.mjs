// ATLAS'S VERTICAL-ACCURACY BOUND, measured on the SHIPPED pyramid.
//
//   max |error| vs the full-resolution source <= 77067 / 2^level metres
//   RMSE <= 25% of that
//
// measure-grid.mjs answers a different question (what does gridSize cost on ONE
// tile against a denser encode of the same granule). This one takes the store a
// run actually produced, samples the tiles that matter — the highest-relief
// ones, because a max-error bound is a statement about the worst tile, not the
// median — and evaluates THE TRIANGULATION THE CLIENT RENDERS against a
// reference read from the same source granules.
//
// THE REFERENCE. Not the source posts directly (that would need a second
// GeoTIFF decoder here, and a second decoder is a second thing to be wrong).
// Instead the encoder itself re-samples the same extent at level+2: sixteen
// grandchildren of 65 posts each, so 256 posts across the parent's edge against
// its own 65 — a 4x denser sampling of the same source raster through the same
// bilinear. At z11 that is 21 m post spacing against the dataset's native 30 m,
// so the reference is the source surface to within the source's own resolution.
// Errors reported here are therefore the TRIANGULATION's departure from the
// source, which is exactly what Atlas's bound is about.
//
//   node tools/terrain-pyramid/measure-accuracy.mjs --out <store dir> [--per-level 6] [--json]

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SDK_DIR = path.join(REPO, "flows", "terrain-ingest", "node_modules", "space-data-module-sdk");
const WASM = path.join(REPO, "data-source", "terrain-source", "dist", "isomorphic", "module.wasm");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO, "data-source", "terrain-source", "plugin-manifest.json"), "utf8"),
);
const GRANULE_BASE = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/";
const REFERENCE_DEPTH = 2; // levels below the tile under test
const GRID = 65;

const args = { perLevel: 6, json: false };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--out") args.out = process.argv[++i];
  else if (process.argv[i] === "--per-level") args.perLevel = Number(process.argv[++i]);
  else if (process.argv[i] === "--json") args.json = true;
  else throw new Error(`unknown argument ${process.argv[i]}`);
}
assert.ok(args.out, "--out <store dir> is required");
const outDir = path.resolve(args.out);
const granuleDir = path.join(outDir, "granules");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frame = (portId, bytes) => ({
  portId,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length },
  payload: bytes,
});
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));

// ── the store, read back by hand (field ids follow schema/DTT/main.fbs) ─────
function readDtt(record) {
  const buf = Buffer.from(record);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "$DTT");
  const pos = buf.readUInt32LE(0);
  const table = (p) => {
    const vtable = p - buf.readInt32LE(p);
    return (id) => {
      const vo = 4 + 2 * id;
      if (vo >= buf.readUInt16LE(vtable)) return 0;
      const off = buf.readUInt16LE(vtable + vo);
      return off === 0 ? 0 : p + off;
    };
  };
  const at = table(pos);
  const u32 = (id) => { const p = at(id); return p ? buf.readUInt32LE(p) : 0; };
  const f64 = (id) => { const p = at(id); return p ? buf.readDoubleLE(p) : 0; };
  const payloadBytes = () => {
    const p0 = at(15);
    const p = p0 + buf.readUInt32LE(p0);
    const bytesAt = table(p)(1);
    const vp = bytesAt + buf.readUInt32LE(bytesAt);
    return buf.subarray(vp + 4, vp + 4 + buf.readUInt32LE(vp));
  };
  return {
    level: u32(3), x: u32(4), y: u32(5),
    west: f64(7), south: f64(8), east: f64(9), north: f64(10),
    minHeightM: f64(11), maxHeightM: f64(12),
    gridWidth: u32(16) || GRID,
    payload: payloadBytes(),
  };
}

function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    offset += 4;
    if (length === 0) continue;
    records.push(buf.subarray(offset, offset + length));
    offset += length;
  }
  return records;
}

// ── quantized-mesh -> a height lattice in metres ────────────────────────────
function meshLattice(mesh, grid) {
  let at = 0;
  const f64 = () => { const v = mesh.readDoubleLE(at); at += 8; return v; };
  const f32 = () => { const v = mesh.readFloatLE(at); at += 4; return v; };
  f64(); f64(); f64();
  const minHeight = f32();
  const maxHeight = f32();
  for (let i = 0; i < 7; i += 1) f64();
  const count = mesh.readUInt32LE(at); at += 4;
  const unzig = () => {
    const out = new Int32Array(count);
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const z = mesh.readUInt16LE(at); at += 2;
      value += (z >> 1) ^ -(z & 1);
      out[i] = value;
    }
    return out;
  };
  const u = unzig();
  const v = unzig();
  const h = unzig();
  const range = maxHeight - minHeight;
  const lattice = new Float64Array(grid * grid);
  for (let n = 0; n < count; n += 1) {
    const i = Math.round((u[n] * (grid - 1)) / 32767);
    const j = Math.round((v[n] * (grid - 1)) / 32767);
    lattice[j * grid + i] = minHeight + (h[n] / 32767) * range;
  }
  return lattice;
}

// The surface the CLIENT renders: the encoder's regular triangulation, each
// cell split along its bottom-left/top-right diagonal (terrain_source_module.cpp
// emits (bl, br, tr) and (bl, tr, tl)), evaluated as a plane on whichever half
// the query lands in. Not bilinear — bilinear is a different surface and would
// flatter the mesh by up to the cell's own curvature.
function triangleHeight(lattice, grid, fu, fv) {
  const x = Math.min(Math.max(fu, 0), 1) * (grid - 1);
  const y = Math.min(Math.max(fv, 0), 1) * (grid - 1);
  const i = Math.min(Math.floor(x), grid - 2);
  const j = Math.min(Math.floor(y), grid - 2);
  const dx = x - i;
  const dy = y - j;
  const bl = lattice[j * grid + i];
  const br = lattice[j * grid + i + 1];
  const tl = lattice[(j + 1) * grid + i];
  const tr = lattice[(j + 1) * grid + i + 1];
  return dy <= dx ? bl + dx * (br - bl) + dy * (tr - br) : bl + dy * (tl - bl) + dx * (tr - tl);
}

// ── the granules a tile needs, from the run's own on-disk cache ─────────────
const stem = (lat, lon) =>
  `Copernicus_DSM_COG_10_${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
  `${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_00`;
const demUrl = (lat, lon) => `${GRANULE_BASE}${stem(lat, lon)}_DEM/${stem(lat, lon)}_DEM.tif`;
const cachePath = (url) => path.join(granuleDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.bin`);

function granulesFor(tile) {
  const frames = [];
  // The granule that HOLDS a post: latitudes (lat, lat+1], longitudes [lon, lon+1).
  const lat0 = Math.floor(tile.south - 1e-9);
  const lat1 = Math.floor(tile.north - 1e-9);
  const lon0 = Math.floor(tile.west);
  const lon1 = Math.floor(tile.east);
  for (let lat = lat0; lat <= lat1; lat += 1) {
    for (let lon = lon0; lon <= lon1; lon += 1) {
      const file = cachePath(demUrl(lat, lon));
      const statusFile = `${file}.status`;
      if (!fs.existsSync(file) || !fs.existsSync(statusFile)) continue;
      if (fs.readFileSync(statusFile, "utf8").trim() !== "200") continue;
      const body = fs.readFileSync(file);
      const hrb = Buffer.alloc(8 + body.length);
      hrb.write("$HRB", 0, "latin1");
      hrb.writeUInt32LE(200, 4);
      body.copy(hrb, 8);
      frames.push(frame("dem", hrb));
    }
  }
  return frames;
}

const { createBrowserModuleHarness } = await import(path.join(SDK_DIR, "src/testing/index.js"));

async function encodeReference(tile, harness) {
  const step = 2 ** REFERENCE_DEPTH;
  const tiles = [];
  for (let dy = 0; dy < step; dy += 1) {
    for (let dx = 0; dx < step; dx += 1) {
      tiles.push({ x: tile.x * step + dx, y: tile.y * step + dy, childAvailability: 0 });
    }
  }
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      jsonFrame("plan", {
        tilesetId: "measure",
        level: tile.level + REFERENCE_DEPTH,
        gridSize: GRID,
        maxLevel: tile.level + REFERENCE_DEPTH,
        scheme: "GEOGRAPHIC_WGS84",
        rowOriginNorth: false,
        skipOceanTiles: false,
        tiles,
        provenance: {
          datasetId: "cop-dem-glo-30",
          datasetEpoch: "2023-04-01T00:00:00.000Z",
          retrievedAt: "2026-08-26T00:00:00.000Z",
          license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
        },
      }),
      ...granulesFor(tile),
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = splitStream(response.outputs.find((o) => o.portId === "records").payload);
  return records.map((r) => {
    const child = readDtt(r);
    return { child, lattice: meshLattice(zlib.gunzipSync(child.payload), GRID) };
  });
}

const records = splitStream(fs.readFileSync(path.join(outDir, "tiles.dttstream")));
const byLevel = new Map();
for (const record of records) {
  const dtt = readDtt(record);
  if (!byLevel.has(dtt.level)) byLevel.set(dtt.level, []);
  byLevel.get(dtt.level).push(dtt);
}

const harness = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(WASM),
  manifest: MANIFEST,
  surface: "direct",
});
const levels = [];
for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
  // The highest-relief tiles: a max-error bound is a claim about the worst
  // tile, and picking at random measures the median instead.
  const candidates = [...byLevel.get(level)].sort(
    (a, b) => b.maxHeightM - b.minHeightM - (a.maxHeightM - a.minHeightM),
  );
  const chosen = candidates.slice(0, args.perLevel);
  const flat = candidates[candidates.length - 1];
  const tiles = [];
  let levelMax = 0;
  let levelSq = 0;
  let levelN = 0;
  for (const tile of [...chosen, flat]) {
    const lattice = meshLattice(zlib.gunzipSync(tile.payload), tile.gridWidth);
    const reference = await encodeReference(tile, harness);
    let max = 0;
    let sq = 0;
    let n = 0;
    for (const { child, lattice: refLattice } of reference) {
      for (let j = 0; j < GRID; j += 1) {
        const lat = child.south + ((child.north - child.south) * j) / (GRID - 1);
        const fv = (lat - tile.south) / (tile.north - tile.south);
        for (let i = 0; i < GRID; i += 1) {
          const lon = child.west + ((child.east - child.west) * i) / (GRID - 1);
          const fu = (lon - tile.west) / (tile.east - tile.west);
          const truth = refLattice[j * GRID + i];
          const got = triangleHeight(lattice, tile.gridWidth, fu, fv);
          const delta = Math.abs(got - truth);
          if (delta > max) max = delta;
          sq += delta * delta;
          n += 1;
        }
      }
    }
    const isFlat = tile === flat;
    tiles.push({
      address: `${tile.level}/${tile.x}/${tile.y}`,
      reliefM: +(tile.maxHeightM - tile.minHeightM).toFixed(1),
      maxErrorM: +max.toFixed(3),
      rmseM: +Math.sqrt(sq / n).toFixed(3),
      samples: n,
      role: isFlat ? "lowest-relief control" : "high-relief",
    });
    if (!isFlat) {
      levelMax = Math.max(levelMax, max);
      levelSq += sq;
      levelN += n;
    }
  }
  const bound = 77067 / 2 ** level;
  levels.push({
    level,
    tilesInStore: byLevel.get(level).length,
    tilesMeasured: tiles.length,
    boundM: +bound.toFixed(2),
    rmseBoundM: +(bound * 0.25).toFixed(2),
    maxErrorM: +levelMax.toFixed(3),
    rmseM: +Math.sqrt(levelSq / levelN).toFixed(3),
    maxWithinBound: levelMax <= bound,
    rmseWithinBound: Math.sqrt(levelSq / levelN) <= bound * 0.25,
    tiles,
  });
}
harness.destroy();

const summary = {
  outDir,
  gridSize: GRID,
  referenceDepth: REFERENCE_DEPTH,
  referencePostsPerTileEdge: (GRID - 1) * 2 ** REFERENCE_DEPTH + 1,
  levels,
  verdict: levels.every((l) => l.maxWithinBound && l.rmseWithinBound) ? "WITHIN BOUND" : "OVER BOUND",
};
fs.writeFileSync(path.join(outDir, "accuracy-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`gridSize ${GRID}, reference = level+${REFERENCE_DEPTH} (${summary.referencePostsPerTileEdge} posts per tile edge)\n`);
  console.log("level  tiles  bound m   max m   rmse m  rmse bound  verdict");
  for (const l of levels) {
    console.log(
      `${String(l.level).padStart(5)}  ${String(l.tilesMeasured).padStart(5)}  ` +
        `${l.boundM.toFixed(2).padStart(7)}  ${l.maxErrorM.toFixed(2).padStart(6)}  ` +
        `${l.rmseM.toFixed(2).padStart(6)}  ${l.rmseBoundM.toFixed(2).padStart(10)}  ` +
        `${l.maxWithinBound && l.rmseWithinBound ? "within" : "OVER"}`,
    );
  }
  console.log(`\n${summary.verdict}`);
}
