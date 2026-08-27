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
// THE REFERENCE, AND EXACTLY WHAT IT IS NOT INDEPENDENT OF.
//
// Not the source posts directly — that would need a second GeoTIFF decoder
// here, and a second decoder is a second thing to be wrong. Instead the encoder
// itself re-samples the same extent at level+2: sixteen grandchildren of 65
// posts each, so 256 posts across the parent's edge against its own 65 — a 4x
// denser sampling of the same source raster through the same bilinear. At z11
// that is 21 m post spacing against the dataset's native 30 m.
//
// So this measures TRIANGULATION DENSITY, and only that. It runs through the
// same module.wasm, the same decode_geotiff_window, the same sample_dem and the
// same georeference assumptions as the mesh it is judging, which means it
// CANNOT see a decode error, a georeference error, or a clamped sample — and
// that is not hypothetical: the latitude-band clamp fixed in the encoder was
// worth 6.3 m of vertical error on a whole grid row and was invisible to
// exactly this comparison, and to the record's own VERTICAL_ACCURACY_M, for
// the same reason.
//
// It is therefore NOT an independent harness and must not be reported as one.
// The independent evidence for decode, georeference and clamp correctness is
// elsewhere and is structural rather than statistical: verify.mjs compares
// SHARED EDGES between adjacent tiles (two independently encoded tiles must
// agree on ground they both cover), detects whole missing post rows, gates on
// the encoder's clamp counter, and re-derives every DIGEST from the bytes; the
// module's own granule-seam, band-boundary and water-mask tests measure the
// sampler against georeferences computed in the test from the TIFF spec.
//
// What this number IS good for is the question Atlas's bound actually asks —
// how far the rendered triangles depart from the surface the encoder sampled —
// and that is what it should be quoted as.
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
// THE REFERENCE'S DEPTH IS ALSO PER LEVEL. A fixed level+2 forces the whole
// reference lattice into ONE tile's worth of posts, and at the shallow levels
// that lattice cannot encode under the 32 KiB ceiling at all. Going one level
// deeper divides the same ground into 64 tiles instead of 16, so each carries a
// quarter of the posts along its edge and the same source spacing fits. Capped
// at 3: z9 would need 4 and z8 would need 5, i.e. 1,024 child encodes per
// reference tile, which is not worth it for a level the ruling does not gate.
const MAX_REFERENCE_DEPTH = 3;
function referenceDepthFor(level) {
  return Math.min(MAX_REFERENCE_DEPTH, Math.max(2, 13 - level));
}
const GRID = 65; // the reference's lattice when nothing else decides it

// ── THE REFERENCE IS SIZED TO THE SOURCE, NOT TO A ROUND NUMBER ────────────
//
// A fixed 65 made the reference (GRID-1)*4 + 1 = 257 posts across the parent's
// edge at EVERY level, which is a different instrument at every level: at z13
// it out-resolved the dataset three times over and reported its own bilinear
// ringing as terrain error, and at z11 (316 source posts per tile edge) and z10
// (633) it UNDER-resolved the source and could not see the relief it was being
// asked to bound. The headline "worst ratio 1.122" from such a reference is a
// sample observation about smooth ground, not a bound on anything.
//
// So the reference lattice is chosen per level to land as close to the source's
// own post spacing as the module's gridSize range allows: Copernicus GLO-30
// publishes 1 arcsecond of latitude everywhere, so a child tile at level+2
// carries 648000/2^(level+2) source posts along its edge and the reference
// wants one lattice post each. Where that number is outside [5, 255] — z9 and
// shallower, where a child tile is hundreds of arcseconds across — the
// reference cannot be built at all and the level is marked UNDER-RESOLVED
// rather than judged.
const SOURCE_POSTS_PER_DEGREE = 3600;
function referenceGridFor(level) {
  const postsPerChildEdge =
    (180 / 2 ** (level + referenceDepthFor(level))) * SOURCE_POSTS_PER_DEGREE;
  return Math.min(255, Math.max(5, Math.ceil(postsPerChildEdge) + 1));
}

// …AND THE ENCODER'S 32 KiB CEILING IS HARD, INCLUDING FOR A REFERENCE. At the
// shallow levels the lattice the source would need is denser than a single tile
// can encode under the cap (measured: 10/1068/772 at 255 posts is refused with
// `tile-size-ceiling-exceeded`), and the ceiling is a ship rule with no bypass —
// correctly, since a bypass is exactly the kind of knob that ends up set in
// production. So the reference walks DOWN this ladder until a tile encodes, and
// the grid it actually reached is what the level's resolve/under-resolve flags
// are computed from. A level that had to fall back is reported and not judged,
// which is the honest outcome rather than a crash or a silent coarsening.
const REFERENCE_GRID_LADDER = Object.freeze([193, 161, 129, 97, 65, 49, 33]);

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
    // NOT the record's GRID_WIDTH. $DTT scopes that field to RASTER payloads —
    // "Unset for mesh formats" — so it is 0 on every record this pyramid holds,
    // and the fallback here used to be the harness's own GRID constant (65).
    // That is the defect this harness has been reporting as terrain error ever
    // since density became adaptive: the shipped mesh's vertices were scattered
    // into a 65x65 array whatever their real density, so a mesh COARSER than 65
    // left 65*65 - grid*grid cells holding a default 0.0, and triangleHeight
    // read those holes as sea level. It is worth exactly the terrain's own
    // height, which is why the numbers looked like terrain: 3,875.9 m on a z8
    // tile at grid 61 against 756.3 m for the SAME tile at grid 73 (denser than
    // 65, so no holes), and 1,836 m at z13 where every tile ships far below 65.
    // The harness blamed its own bilinear ringing for that in a comment. The
    // mesh states its density exactly — it is a regular lattice, so the vertex
    // count is its square — and meshLattice derives it there.
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
// Returns { grid, lattice }: the mesh's OWN density, derived from its vertex
// count, and its posts. Never a caller-supplied grid — see readDtt above for
// what that cost.
function meshLattice(mesh) {
  let at = 0;
  const f64 = () => { const v = mesh.readDoubleLE(at); at += 8; return v; };
  const f32 = () => { const v = mesh.readFloatLE(at); at += 4; return v; };
  f64(); f64(); f64();
  const minHeight = f32();
  const maxHeight = f32();
  for (let i = 0; i < 7; i += 1) f64();
  const count = mesh.readUInt32LE(at); at += 4;
  const grid = Math.round(Math.sqrt(count));
  assert.equal(
    grid * grid,
    count,
    `a mesh from this encoder is a regular ${grid}x${grid} lattice, so its vertex count must be a ` +
      `perfect square; got ${count}. A mesh that is not this shape cannot be read as one.`,
  );
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
  const filled = new Uint8Array(grid * grid);
  for (let n = 0; n < count; n += 1) {
    const i = Math.round((u[n] * (grid - 1)) / 32767);
    const j = Math.round((v[n] * (grid - 1)) / 32767);
    lattice[j * grid + i] = minHeight + (h[n] / 32767) * range;
    filled[j * grid + i] = 1;
  }
  // Every cell of the lattice must have been written. A hole reads 0.0 and
  // triangleHeight cannot tell that from sea level, which is precisely how the
  // grid mismatch above stayed invisible for a whole round.
  for (let n = 0; n < filled.length; n += 1) {
    assert.equal(filled[n], 1, `mesh vertex ${n} of ${grid}x${grid} is missing; the lattice has holes`);
  }
  return { grid, lattice };
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
  const wanted = referenceGridFor(tile.level);
  const ladder = [wanted, ...REFERENCE_GRID_LADDER.filter((g) => g < wanted)];
  for (const grid of ladder) {
    const attempt = await encodeReferenceAt(tile, harness, grid);
    if (attempt) return { grid, children: attempt };
  }
  throw new Error(`no reference lattice encodes under the ceiling for ${tile.level}/${tile.x}/${tile.y}`);
}

async function encodeReferenceAt(tile, harness, grid) {
  const depth = referenceDepthFor(tile.level);
  const step = 2 ** depth;
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
        level: tile.level + depth,
        gridSize: grid,
        // THE REFERENCE'S LATTICE IS PINNED. Density adapts to relief now
        // (coordinator 2026-08-27 (a)), and a reference that adapts is not a
        // reference: the grandchildren of a gently sloping tile would settle on
        // 5 posts each and this would "measure" the shipped mesh against
        // something COARSER than itself. It did, before this line: the first
        // adaptive-density run reported 3,492 m at z11 against a 37 m bound,
        // which is not a terrain error, it is the yardstick bending.
        minGridSize: grid,
        maxGridSize: grid,
        // …and the reference does not need to measure ITS own accuracy, which
        // is three extra source probes per cell of a 16-tile block.
        measureAccuracy: false,
        maxLevel: tile.level + depth,
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
  if (response.statusCode !== 0) {
    if (response.errorCode === "tile-size-ceiling-exceeded") return null;
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  }
  const records = splitStream(response.outputs.find((o) => o.portId === "records").payload);
  return records.map((r) => {
    const child = readDtt(r);
    return { child, ...meshLattice(zlib.gunzipSync(child.payload)) };
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
  const referenceGridsUsed = [];
  for (const tile of [...chosen, flat]) {
    const { grid: tileGrid, lattice } = meshLattice(zlib.gunzipSync(tile.payload));
    const { grid: usedGrid, children: reference } = await encodeReference(tile, harness);
    referenceGridsUsed.push(usedGrid);
    let max = 0;
    let sq = 0;
    let n = 0;
    for (const { child, grid: refGrid, lattice: refLattice } of reference) {
      for (let j = 0; j < refGrid; j += 1) {
        const lat = child.south + ((child.north - child.south) * j) / (refGrid - 1);
        const fv = (lat - tile.south) / (tile.north - tile.south);
        for (let i = 0; i < refGrid; i += 1) {
          const lon = child.west + ((child.east - child.west) * i) / (refGrid - 1);
          const fu = (lon - tile.west) / (tile.east - tile.west);
          const truth = refLattice[j * refGrid + i];
          const got = triangleHeight(lattice, tileGrid, fu, fv);
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
  // The RULED target (coordinator 2026-08-27 (a)) and the RETIRED pair, side by
  // side, exactly as verify.mjs reports them — so the change of gate is visible
  // rather than a quiet loosening, and so a reader can see what the old bound
  // would have said about the same pyramid.
  const target = (2 * 77067) / 2 ** level;
  const legacyBound = 77067 / 2 ** level;
  const rmse = Math.sqrt(levelSq / levelN);
  // ── WHERE THE REFERENCE STOPS BEING A REFERENCE ─────────────────────────
  //
  // The reference is the encoder re-sampling the same extent at level+2, which
  // is only a denser reading of the SOURCE while its posts are still coarser
  // than the source's own. Past that point it is interpolating between source
  // posts and its bilinear ringing shows up as "error" that has nothing to do
  // with the mesh: at z13 the reference lattice is 8.6e-5 degrees against the
  // dataset's 2.78e-4, three times finer than anything the granule states, and
  // this harness duly reported 1,836 m where the encoder's own probe — which
  // compares against the source posts themselves — reported 18.8 m.
  //
  // Two orders of magnitude apart means one of them is not measuring terrain.
  // It is this one, and the level is marked rather than quietly averaged in.
  // The grid the reference ACTUALLY reached on every tile of this level, not
  // the one it wanted — taken as the minimum so the level's flags describe the
  // weakest reference any of its rows was measured against.
  const referenceGrid = referenceGridsUsed.length ? Math.min(...referenceGridsUsed) : referenceGridFor(level);
  const referenceGridWanted = referenceGridFor(level);
  const referenceDepth = referenceDepthFor(level);
  const referenceSpacingDeg = 180 / 2 ** (level + referenceDepth) / (referenceGrid - 1);
  // Copernicus GLO-30 publishes 1 arcsecond of LATITUDE everywhere and widens
  // its longitude spacing by band, so 1/3600 degree is the finest the source
  // ever states and the conservative number to compare against.
  const sourceSpacingDeg = 1 / 3600;
  // MORE THAN TWICE AS FINE as the source is where a reference stops describing
  // the dataset and starts describing its own interpolation. A reference within
  // a few percent of the source spacing is exactly what is wanted and must not
  // be excluded for landing a hair on one side of it — the round-5 tolerance was
  // 0.1 %, which excluded every level and left the cross-check saying nothing.
  const referenceOutResolvesSource = referenceSpacingDeg < sourceSpacingDeg / 2;
  // THE OTHER SIDE OF THE SAME LIMIT, which had no name and no field and was
  // therefore not stated anywhere. A reference COARSER than the source cannot
  // see relief between source posts, so its max error is a SAMPLE OBSERVATION
  // about the ground it happened to look at, never a bound on the record's own
  // source-post figure. Rows carrying this flag are reported and excluded from
  // the verdict, exactly like out-resolved ones.
  const referenceUnderResolvesSource = referenceSpacingDeg > sourceSpacingDeg * 1.02;
  levels.push({
    level,
    // TRUE means the numbers on this row describe the reference's own
    // interpolation, not the shipped mesh. Read the encoder's per-record
    // VERTICAL_ACCURACY_M (and verify.mjs, which gates on it) instead.
    referenceOutResolvesSource,
    referenceUnderResolvesSource,
    referenceDepth,
    referenceGrid,
    referenceGridWanted,
    referenceGridFellBackFromCeiling: referenceGrid < referenceGridWanted,
    referencePostsPerTileEdge: (referenceGrid - 1) * 2 ** referenceDepth + 1,
    sourcePostsPerTileEdge: +((180 / 2 ** level) * SOURCE_POSTS_PER_DEGREE).toFixed(1),
    referenceSpacingDeg: +referenceSpacingDeg.toExponential(3),
    sourceSpacingDeg: +sourceSpacingDeg.toExponential(3),
    tilesInStore: byLevel.get(level).length,
    tilesMeasured: tiles.length,
    errorTargetM: +target.toFixed(2),
    legacyBoundM: +legacyBound.toFixed(2),
    legacyRmseBoundM: +(legacyBound * 0.25).toFixed(2),
    maxErrorM: +levelMax.toFixed(3),
    rmseM: +rmse.toFixed(3),
    maxWithinTarget: levelMax <= target,
    maxWithinLegacyBound: levelMax <= legacyBound,
    rmseWithinLegacyBound: rmse <= legacyBound * 0.25,
    tiles,
  });
}
harness.destroy();

const summary = {
  outDir,
  referenceDepthByLevel: Object.fromEntries(levels.map((l) => [l.level, l.referenceDepth])),
  // Per level now, not one number: see referenceGridFor. Kept as a map so a
  // reader can see at a glance which levels the reference actually resolves.
  referenceGridByLevel: Object.fromEntries(levels.map((l) => [l.level, l.referenceGrid])),
  referencePostsPerTileEdgeByLevel: Object.fromEntries(
    levels.map((l) => [l.level, l.referencePostsPerTileEdge]),
  ),
  sourcePostsPerTileEdgeByLevel: Object.fromEntries(
    levels.map((l) => [l.level, l.sourcePostsPerTileEdge]),
  ),
  // WHAT THIS HARNESS CAN AND CANNOT CONCLUDE, stated in the artefact rather
  // than in the file's own comments, because the report is what gets read.
  limits: [
    "the reference is the ENCODER re-sampling the same granules at level+2, so this cannot see a decode, georeference or clamp error — those are checked structurally in verify.mjs and in the module's granule-seam, band-boundary and water-mask tests",
    "a level flagged referenceUnderResolvesSource has a reference COARSER than the 1-arcsecond source; its max error is a sample observation, never a bound",
    "a level flagged referenceOutResolvesSource has a reference FINER than the source, so its 'error' includes the reference's own interpolation",
    "tiles are the highest-relief ones per level plus one flat control, not a sample of the store: a max over them is deliberately harsher than the per-tile share gate verify.mjs owns, and is not a distribution",
  ],
  levels,
  // The verdict is against the RULED target. It is a per-level MAX over the
  // worst-relief tiles, so it is deliberately harsher than verify.mjs's
  // per-tile share gate and is reported rather than used as a ship gate:
  // verify.mjs owns the gate (<= 5 % of tiles at the cap per level at z >= 10).
  verdict: levels
    .filter((l) => !l.referenceOutResolvesSource && !l.referenceUnderResolvesSource)
    .every((l) => l.maxWithinTarget)
    ? "WITHIN TARGET"
    : "OVER TARGET",
  legacyVerdict: levels
    .filter((l) => !l.referenceOutResolvesSource && !l.referenceUnderResolvesSource)
    .every((l) => l.maxWithinLegacyBound && l.rmseWithinLegacyBound)
    ? "WITHIN THE RETIRED BOUND"
    : "OVER THE RETIRED BOUND",
  levelsNotMeasurable: levels
    .filter((l) => l.referenceOutResolvesSource || l.referenceUnderResolvesSource)
    .map((l) => l.level),
};
fs.writeFileSync(path.join(outDir, "accuracy-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `reference depth per level ${JSON.stringify(summary.referenceDepthByLevel)}, ` +
      `lattice per level ${JSON.stringify(summary.referenceGridByLevel)}\n`,
  );
  console.log("level  tiles  target m    max m   rmse m  retired m  verdict");
  for (const l of levels) {
    console.log(
      `${String(l.level).padStart(5)}  ${String(l.tilesMeasured).padStart(5)}  ` +
        `${l.errorTargetM.toFixed(2).padStart(8)}  ${l.maxErrorM.toFixed(2).padStart(7)}  ` +
        `${l.rmseM.toFixed(2).padStart(6)}  ${l.legacyBoundM.toFixed(2).padStart(9)}  ` +
        `${
          l.referenceOutResolvesSource
            ? "n/a — reference out-resolves the source"
            : l.referenceUnderResolvesSource
              ? "n/a — reference under-resolves the source"
              : l.maxWithinTarget
                ? "within"
                : "OVER"
        }`,
    );
  }
  console.log(`\n${summary.verdict} (against the retired pair: ${summary.legacyVerdict})`);
  // AND WHAT THAT VERDICT IS NOT. It compares the max over the HIGHEST-RELIEF
  // tiles of each level against the target, so "OVER" says the roughest tiles
  // in the store miss it — which is the population coordinator (a) explicitly
  // permits ("where the cap cannot meet it the tile ships AT the cap with its
  // measured VERTICAL_ACCURACY_M stated") and gates by SHARE, at <= 5% per
  // level for z >= 10. This harness does not implement that escape and is not
  // meant to: verify.mjs is the gate. Read this as a second opinion on the
  // FIGURE each record states, not as a verdict on the pyramid.
  console.log(
    "  (the sample is each level's highest-relief tiles, so OVER means the roughest tiles miss\n" +
      "   the target — the at-the-cap population coordinator (a) permits and verify.mjs gates by\n" +
      "   share. verify.mjs is the gate; cross-check-accuracy.mjs joins these to what the records\n" +
      "   themselves state.)",
  );
}
