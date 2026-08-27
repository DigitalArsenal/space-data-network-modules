// CAN BOTH RULED BOUNDS HOLD AT ONCE? Measured, on the pyramid's own tiles.
//
// Two oracles rule on the same bytes and the rulings pull opposite ways:
//
//   Hermes  per-tile gzipped p50 <= 4 KiB, p99 <= 12 KiB, hard 32 KiB
//   Atlas   max vertical error <= 77067 / 2^level metres vs the full-res source
//
// A denser regular lattice buys accuracy with bytes; a coarser one buys bytes
// with accuracy. measure-grid.mjs shows that trade on ONE tile. The question
// this tool answers is the one neither bound can be settled without: is there
// ANY encoding of this terrain that satisfies both — including the adaptive
// mesh (RTIN, the same right-triangulated refinement the browser-side
// terrarium decoder uses) that quantized-mesh exists to carry?
//
// It reports, per level, on the HIGHEST-RELIEF tile the store holds — a max
// bound is a claim about the worst tile, and sampling the median measures the
// median:
//
//   * regular grids at 33 / 65 / 129 posts, and
//   * RTIN meshes refined to fractions of the level's bound, in the two vertex
//     orders that change how well the index stream compresses,
//
// each with its gzipped size and its MEASURED max error against a 257-post
// reference read from the same source granules through the same encoder.
//
//   node tools/terrain-pyramid/measure-tradeoff.mjs --out <store dir> [--json]

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
const GRID = 65;
const DEPTH = 2; // 16 grandchildren of 65 posts = 257 posts across the parent
const BOUNDS = { p50: 4096, p99: 12288, hard: 32768 };

const args = { json: false, perLevel: 1 };
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
const frame = (portId, bytes) => ({
  portId,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length },
  payload: bytes,
});
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));

// ── the store, read back by hand (field ids follow schema/DTT/main.fbs) ─────
function readDtt(record) {
  const buf = Buffer.from(record);
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
    verticalAccuracyM: f64(23),
    payload: payloadBytes(),
  };
}

function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    offset += 4;
    if (length === 0) continue;
    out.push(buf.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}

// A quantized mesh's regular lattice, dequantized to metres.
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

const stem = (lat, lon) =>
  `Copernicus_DSM_COG_10_${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
  `${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_00`;
const demUrl = (lat, lon) => `${GRANULE_BASE}${stem(lat, lon)}_DEM/${stem(lat, lon)}_DEM.tif`;
const cachePath = (url) =>
  path.join(granuleDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.bin`);

function granulesFor(tile) {
  const frames = [];
  const lat0 = Math.floor(tile.south - 1e-9);
  const lat1 = Math.floor(tile.north - 1e-9);
  const lon0 = Math.floor(tile.west);
  const lon1 = Math.floor(tile.east);
  for (let lat = lat0; lat <= lat1; lat += 1) {
    for (let lon = lon0; lon <= lon1; lon += 1) {
      const file = cachePath(demUrl(lat, lon));
      if (!fs.existsSync(file) || !fs.existsSync(`${file}.status`)) continue;
      if (fs.readFileSync(`${file}.status`, "utf8").trim() !== "200") continue;
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

// The 257x257 truth lattice: the encoder's own level+2 output over the same
// granules, stitched. Not a second decoder — a second SAMPLING, four times
// denser, through the code under test.
async function denseLattice(tile, harness) {
  const step = 2 ** DEPTH;
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
        tilesetId: "tradeoff",
        level: tile.level + DEPTH,
        gridSize: GRID,
        maxLevel: tile.level + DEPTH,
        scheme: "GEOGRAPHIC_WGS84",
        rowOriginNorth: false,
        skipOceanTiles: false,
        measureAccuracy: false,
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
  const size = (GRID - 1) * step + 1;
  const dense = new Float64Array(size * size);
  for (const record of splitStream(response.outputs.find((o) => o.portId === "records").payload)) {
    const child = readDtt(record);
    const lattice = meshLattice(zlib.gunzipSync(child.payload), GRID);
    const dx = child.x - tile.x * step;
    const dy = child.y - tile.y * step;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        dense[(dy * (GRID - 1) + j) * size + dx * (GRID - 1) + i] = lattice[j * GRID + i];
      }
    }
  }
  return { dense, size };
}

// ── RTIN (right-triangulated irregular network) over a (2^k+1)^2 lattice ────
function rtinErrors(terrain, size) {
  const tileSize = size - 1;
  const numTriangles = tileSize * tileSize * 2 - 2;
  const numParentTriangles = numTriangles - tileSize * tileSize;
  const coords = new Uint16Array(numTriangles * 4);
  for (let i = 0; i < numTriangles; i += 1) {
    let id = i + 2;
    let ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0;
    if (id & 1) { bx = by = cx = tileSize; } else { ax = ay = cy = tileSize; }
    while ((id >>= 1) > 1) {
      const mx = (ax + bx) >> 1;
      const my = (ay + by) >> 1;
      if (id & 1) { bx = ax; by = ay; ax = cx; ay = cy; }
      else { ax = bx; ay = by; bx = cx; by = cy; }
      cx = mx; cy = my;
    }
    const k = i * 4;
    coords[k] = ax; coords[k + 1] = ay; coords[k + 2] = bx; coords[k + 3] = by;
  }
  const errors = new Float32Array(size * size);
  for (let i = numTriangles - 1; i >= 0; i -= 1) {
    const k = i * 4;
    const ax = coords[k], ay = coords[k + 1], bx = coords[k + 2], by = coords[k + 3];
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    const cx = mx + my - ay, cy = my + ax - mx;
    const middle = my * size + mx;
    const interpolated = (terrain[ay * size + ax] + terrain[by * size + bx]) / 2;
    errors[middle] = Math.max(errors[middle], Math.abs(interpolated - terrain[middle]));
    if (i < numParentTriangles) {
      errors[middle] = Math.max(
        errors[middle],
        errors[((ay + cy) >> 1) * size + ((ax + cx) >> 1)],
        errors[((by + cy) >> 1) * size + ((bx + cx) >> 1)],
      );
    }
  }
  return errors;
}

function rtinTriangles(errors, size, maxError) {
  const tileSize = size - 1;
  const triangles = [];
  function walk(ax, ay, bx, by, cx, cy) {
    const mx = (ax + bx) >> 1;
    const my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * size + mx] > maxError) {
      walk(cx, cy, ax, ay, mx, my);
      walk(bx, by, cx, cy, mx, my);
    } else {
      triangles.push([ax, ay, bx, by, cx, cy]);
    }
  }
  walk(0, 0, tileSize, tileSize, tileSize, 0);
  walk(tileSize, tileSize, 0, 0, 0, tileSize);
  return triangles;
}

function regularTriangles(size, grid) {
  const step = (size - 1) / (grid - 1);
  const triangles = [];
  for (let j = 0; j + 1 < grid; j += 1) {
    for (let i = 0; i + 1 < grid; i += 1) {
      const x0 = i * step, x1 = (i + 1) * step, y0 = j * step, y1 = (j + 1) * step;
      triangles.push([x0, y0, x1, y0, x1, y1]);
      triangles.push([x0, y0, x1, y1, x0, y1]);
    }
  }
  return triangles;
}

const zigzag16 = (n) => ((n << 1) ^ (n >> 31)) & 0xffff;

// The same wire shape the encoder writes: 88-byte header, three zigzag-delta
// u16 arrays, a high-water-mark index stream, four edge lists, one uniform
// water-mask extension. Only the mesh varies, so the bytes are comparable.
function encodeQuantizedMesh(triangles, terrain, size) {
  const ids = new Map();
  const vx = [];
  const vy = [];
  const indices = [];
  for (const [ax, ay, bx, by, cx, cy] of triangles) {
    for (const [x, y] of [[ax, ay], [bx, by], [cx, cy]]) {
      const key = y * size + x;
      let id = ids.get(key);
      if (id === undefined) { id = vx.length; ids.set(key, id); vx.push(x); vy.push(y); }
      indices.push(id);
    }
  }
  const n = vx.length;
  const heights = new Float64Array(n);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const h = terrain[vy[i] * size + vx[i]];
    heights[i] = h;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const range = maxH - minH;
  const qu = new Uint16Array(n);
  const qv = new Uint16Array(n);
  const qh = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) {
    qu[i] = Math.round((32767 * vx[i]) / (size - 1));
    qv[i] = Math.round((32767 * vy[i]) / (size - 1));
    qh[i] = range > 0 ? Math.round((32767 * (heights[i] - minH)) / range) : 0;
  }
  const parts = [Buffer.alloc(88)];
  const vertexBlock = Buffer.alloc(4 + n * 6);
  vertexBlock.writeUInt32LE(n, 0);
  let at = 4;
  for (const array of [qu, qv, qh]) {
    let prev = 0;
    for (let i = 0; i < n; i += 1) {
      vertexBlock.writeUInt16LE(zigzag16(array[i] - prev), at);
      at += 2;
      prev = array[i];
    }
  }
  parts.push(vertexBlock);
  const wide = n > 65536;
  const indexBlock = Buffer.alloc(4 + indices.length * (wide ? 4 : 2));
  indexBlock.writeUInt32LE(indices.length / 3, 0);
  at = 4;
  let highest = 0;
  for (const index of indices) {
    const code = highest - index;
    if (wide) { indexBlock.writeUInt32LE(code >>> 0, at); at += 4; }
    else { indexBlock.writeUInt16LE(code & 0xffff, at); at += 2; }
    if (code === 0) highest += 1;
  }
  parts.push(indexBlock);
  const edges = [[], [], [], []];
  for (let i = 0; i < n; i += 1) {
    if (qu[i] === 0) edges[0].push(i);
    if (qv[i] === 0) edges[1].push(i);
    if (qu[i] === 32767) edges[2].push(i);
    if (qv[i] === 32767) edges[3].push(i);
  }
  for (const edge of edges) {
    const block = Buffer.alloc(4 + edge.length * (wide ? 4 : 2));
    block.writeUInt32LE(edge.length, 0);
    let p = 4;
    for (const v of edge) {
      if (wide) { block.writeUInt32LE(v, p); p += 4; } else { block.writeUInt16LE(v, p); p += 2; }
    }
    parts.push(block);
  }
  const extension = Buffer.alloc(6);
  extension.writeUInt8(2, 0);
  extension.writeUInt32LE(1, 1);
  parts.push(extension);
  const body = Buffer.concat(parts);
  return { vertices: n, triangles: triangles.length, raw: body.length, gz: zlib.gzipSync(body, { level: 9 }).length };
}

// The surface a client renders, sampled anywhere: planar per triangle.
function surfaceSampler(triangles, terrain, size) {
  const buckets = Array.from({ length: 256 }, () => []);
  const cell = (size - 1) / 16;
  triangles.forEach((t, index) => {
    const [ax, ay, bx, by, cx, cy] = t;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / cell));
    const x1 = Math.min(15, Math.floor(Math.max(ax, bx, cx) / cell));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / cell));
    const y1 = Math.min(15, Math.floor(Math.max(ay, by, cy) / cell));
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) buckets[y * 16 + x].push(index);
  });
  return (px, py) => {
    const bx = Math.min(15, Math.floor(px / cell));
    const by = Math.min(15, Math.floor(py / cell));
    for (const index of buckets[by * 16 + bx]) {
      const [ax, ay, bx2, by2, cx, cy] = triangles[index];
      const d = (by2 - cy) * (ax - cx) + (cx - bx2) * (ay - cy);
      if (d === 0) continue;
      const l1 = ((by2 - cy) * (px - cx) + (cx - bx2) * (py - cy)) / d;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      return l1 * terrain[ay * size + ax] + l2 * terrain[by2 * size + bx2] + l3 * terrain[cy * size + cx];
    }
    return NaN;
  };
}

function measureAgainst(triangles, dense, size) {
  const sample = surfaceSampler(triangles, dense, size);
  let max = 0;
  let sumSq = 0;
  let n = 0;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const got = sample(i, j);
      if (Number.isNaN(got)) continue;
      const delta = Math.abs(got - dense[j * size + i]);
      if (delta > max) max = delta;
      sumSq += delta * delta;
      n += 1;
    }
  }
  return { maxErrorM: max, rmseM: Math.sqrt(sumSq / n) };
}

// ── main ────────────────────────────────────────────────────────────────────
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
  const bound = 77067 / 2 ** level;
  const candidates = [...byLevel.get(level)].sort(
    (a, b) => b.maxHeightM - b.minHeightM - (a.maxHeightM - a.minHeightM),
  );
  for (const tile of candidates.slice(0, args.perLevel)) {
    const { dense, size } = await denseLattice(tile, harness);
    const variants = [];

    for (const grid of [33, 65, 129]) {
      if ((size - 1) % (grid - 1) !== 0) continue;
      const triangles = regularTriangles(size, grid);
      const encoded = encodeQuantizedMesh(triangles, dense, size);
      const error = measureAgainst(triangles, dense, size);
      variants.push({
        encoding: `regular-grid-${grid}`,
        vertices: encoded.vertices,
        gzippedBytes: encoded.gz,
        maxErrorM: +error.maxErrorM.toFixed(2),
        rmseM: +error.rmseM.toFixed(2),
        withinAccuracyBound: error.maxErrorM <= bound,
        withinP50: encoded.gz <= BOUNDS.p50,
        withinHardCeiling: encoded.gz <= BOUNDS.hard,
      });
    }

    const errors = rtinErrors(dense, size);
    for (const fraction of [1, 0.5, 0.25]) {
      const triangles = rtinTriangles(errors, size, bound * fraction);
      const encoded = encodeQuantizedMesh(triangles, dense, size);
      const error = measureAgainst(triangles, dense, size);
      variants.push({
        encoding: `rtin-${fraction}x-bound`,
        vertices: encoded.vertices,
        gzippedBytes: encoded.gz,
        maxErrorM: +error.maxErrorM.toFixed(2),
        rmseM: +error.rmseM.toFixed(2),
        withinAccuracyBound: error.maxErrorM <= bound,
        withinP50: encoded.gz <= BOUNDS.p50,
        withinHardCeiling: encoded.gz <= BOUNDS.hard,
      });
    }

    levels.push({
      level,
      address: `${tile.level}/${tile.x}/${tile.y}`,
      reliefM: +(tile.maxHeightM - tile.minHeightM).toFixed(0),
      boundM: +bound.toFixed(2),
      shippedGzippedBytes: tile.payload.length,
      shippedStatedAccuracyM: +tile.verticalAccuracyM.toFixed(2),
      variants,
      // THE QUESTION THIS TOOL EXISTS TO ANSWER.
      satisfiesBothBounds: variants.some((v) => v.withinAccuracyBound && v.withinP50),
      cheapestWithinAccuracyBound: variants
        .filter((v) => v.withinAccuracyBound)
        .sort((a, b) => a.gzippedBytes - b.gzippedBytes)[0]?.gzippedBytes ?? null,
    });
    process.stderr.write(`measured ${tile.level}/${tile.x}/${tile.y}\n`);
  }
}
harness.destroy();

const summary = {
  outDir,
  referencePostsPerTileEdge: (GRID - 1) * 2 ** DEPTH + 1,
  bounds: { serving: BOUNDS, accuracy: "77067 / 2^level metres" },
  levels,
  // A single sentence a coordinator can act on.
  verdict: levels.every((l) => l.satisfiesBothBounds)
    ? "BOTH BOUNDS SATISFIABLE"
    : "NO ENCODING MEASURED SATISFIES BOTH BOUNDS",
};
fs.writeFileSync(path.join(outDir, "tradeoff-report.json"), `${JSON.stringify(summary, null, 2)}\n`);

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const entry of levels) {
    console.log(
      `\nz${entry.level} ${entry.address}  relief ${entry.reliefM} m  bound ${entry.boundM} m  ` +
        `shipped ${entry.shippedGzippedBytes} B (states ${entry.shippedStatedAccuracyM} m)`,
    );
    console.log(`  ${"encoding".padEnd(20)} ${"verts".padStart(7)} ${"gz B".padStart(8)} ${"max m".padStart(9)} ${"rmse m".padStart(8)}  bounds`);
    for (const v of entry.variants) {
      const flags = `${v.withinAccuracyBound ? "accuracy" : "        "} ${v.withinP50 ? "p50" : "   "} ${v.withinHardCeiling ? "32KiB" : "     "}`;
      console.log(
        `  ${v.encoding.padEnd(20)} ${String(v.vertices).padStart(7)} ${String(v.gzippedBytes).padStart(8)} ` +
          `${v.maxErrorM.toFixed(2).padStart(9)} ${v.rmseM.toFixed(2).padStart(8)}  ${flags}`,
      );
    }
    console.log(
      `  cheapest encoding inside the accuracy bound: ` +
        `${entry.cheapestWithinAccuracyBound ?? "none measured"} B ` +
        `(p50 bound ${BOUNDS.p50} B, hard ceiling ${BOUNDS.hard} B)`,
    );
  }
  console.log(`\n${summary.verdict}`);
}
