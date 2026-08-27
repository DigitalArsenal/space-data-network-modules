// Read a built pyramid back and state what it is — independently of the
// encoder that produced it.
//
// This exists because the builder's own run report is the builder's word for
// it. Everything here is re-derived from the RECORD BYTES: the FlatBuffer is
// walked by hand, the payload is gunzipped and the quantized-mesh header read
// from the spec, so a bug in the encoder cannot also hide itself here.
//
//   node tools/terrain-pyramid/verify.mjs --out <dir> [--json]

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

// The serving bounds this pyramid has to satisfy to be publishable.
const BOUNDS = { p50: 4096, p99: 12288, hard: 32768 };

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  return args;
}

// ── a hand-written $DTT reader (field ids follow schema/DTT/main.fbs) ───────
function readDtt(record) {
  const buf = Buffer.from(record);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "$DTT", "every record is a $DTT");
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
  const i8 = (id) => { const p = at(id); return p ? buf.readInt8(p) : 0; };
  const str = (id) => {
    const p = at(id);
    if (!p) return undefined;
    const sp = p + buf.readUInt32LE(p);
    return buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
  };
  const payload = (id) => {
    const p0 = at(id);
    if (!p0) return null;
    const p = p0 + buf.readUInt32LE(p0);
    const pat = table(p);
    const bytesAt = pat(1);
    let bytes = null;
    if (bytesAt) {
      const vp = bytesAt + buf.readUInt32LE(bytesAt);
      bytes = buf.subarray(vp + 4, vp + 4 + buf.readUInt32LE(vp));
    }
    const digestAt = pat(3);
    let digest;
    if (digestAt) {
      const sp = digestAt + buf.readUInt32LE(digestAt);
      digest = buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
    }
    return { bytes, digest };
  };
  return {
    tilesetId: str(0),
    level: u32(3),
    x: u32(4),
    y: u32(5),
    westDeg: f64(7),
    southDeg: f64(8),
    eastDeg: f64(9),
    northDeg: f64(10),
    minHeightM: f64(11),
    maxHeightM: f64(12),
    payload: payload(15),
    gridWidth: u32(16),
    gridHeight: u32(17),
    dataCoverageFraction: f64(26),
    waterMask: payload(29),
    waterMaskKind: i8(28),
    waterMaskWidth: u32(30),
    waterMaskHeight: u32(31),
    maxLevel: u32(36),
    etag: str(40),
  };
}

// ── the four EDGE post rows of a quantized mesh, in metres ─────────────────
//
// Only the edges are kept: 4,621 tiles x 4,225 vertices x three arrays is half
// a gigabyte, and the property under test is entirely about shared posts.
// Vertices are identified by their QUANTISED u/v, so the encoder's index
// reordering cannot move them.
function meshEdges(mesh, dtt) {
  const grid = dtt.gridWidth || 65;
  const count = mesh.readUInt32LE(88);
  let at = 92;
  const zigzag = () => {
    const out = new Uint16Array(count);
    let prev = 0;
    for (let i = 0; i < count; i += 1) {
      const raw = mesh.readUInt16LE(at);
      at += 2;
      prev += (raw >> 1) ^ -(raw & 1);
      out[i] = prev & 0xffff;
    }
    return out;
  };
  const u = zigzag();
  const v = zigzag();
  const h = zigzag();
  const range = dtt.maxHeightM - dtt.minHeightM;
  const edges = {
    north: new Float64Array(grid).fill(NaN),
    south: new Float64Array(grid).fill(NaN),
    west: new Float64Array(grid).fill(NaN),
    east: new Float64Array(grid).fill(NaN),
    step: range / 32767,
    grid,
  };
  const index = (q) => Math.round((q * (grid - 1)) / 32767);
  for (let i = 0; i < count; i += 1) {
    const metres = dtt.minHeightM + (h[i] / 32767) * range;
    if (v[i] === 32767) edges.north[index(u[i])] = metres;
    if (v[i] === 0) edges.south[index(u[i])] = metres;
    if (u[i] === 0) edges.west[index(v[i])] = metres;
    if (u[i] === 32767) edges.east[index(v[i])] = metres;
  }
  return edges;
}

function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    offset += 4;
    if (length === 0) continue;
    assert.ok(offset + length <= buf.length, "a length prefix must not run past the stream");
    records.push(buf.subarray(offset, offset + length));
    offset += length;
  }
  assert.equal(offset, buf.length, "the stream ends exactly on a record boundary");
  return records;
}

// Collapse a level's addresses into the rectangles layer.json declares. The
// availability index is a PROMISE the endpoint must keep, so it is derived
// from the records that exist — never widened to a convenient bounding box,
// which would promise tiles nobody built.
function availabilityFor(addresses) {
  const rows = new Map();
  for (const { x, y } of addresses) {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  const rects = [];
  for (const [y, xs] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    let startX = xs[0];
    let prev = xs[0];
    for (let i = 1; i <= xs.length; i += 1) {
      if (i < xs.length && xs[i] === prev + 1) {
        prev = xs[i];
        continue;
      }
      rects.push({ startX, startY: y, endX: prev, endY: y });
      if (i < xs.length) {
        startX = xs[i];
        prev = xs[i];
      }
    }
  }
  return rects;
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
const records = splitStream(fs.readFileSync(path.join(outDir, "tiles.dttstream")));

const byLevel = new Map();
const seen = new Set();
const sizes = [];
let uniform = 0;
let raster = 0;
let oceanStored = 0;
let digestMismatch = 0;
let overCeiling = 0;
let maxLevel = 0;
let maskBytes = 0;
let minLevel = Infinity;
let partialCoverage = 0;
let wholeRowsMissing = 0;
const edgesByAddress = new Map();
const problems = [];

for (const record of records) {
  const dtt = readDtt(record);
  const key = `${dtt.level}/${dtt.x}/${dtt.y}`;
  if (seen.has(key)) problems.push(`duplicate address ${key}`);
  seen.add(key);
  maxLevel = Math.max(maxLevel, dtt.level);
  minLevel = Math.min(minLevel, dtt.level);
  if (!byLevel.has(dtt.level)) byLevel.set(dtt.level, []);
  byLevel.get(dtt.level).push({ x: dtt.x, y: dtt.y });

  const bytes = Buffer.from(dtt.payload.bytes);
  sizes.push(bytes.length);
  if (bytes.length > BOUNDS.hard) overCeiling += 1;

  // DIGEST is stated over the GZIPPED bytes; re-derive it.
  const expected = `1220${createHash("sha256").update(bytes).digest("hex")}`;
  if (dtt.payload.digest !== expected) digestMismatch += 1;
  if (dtt.etag !== `"${expected}"`) problems.push(`ETAG does not match DIGEST at ${key}`);

  if (dtt.waterMaskKind === 3) {
    raster += 1;
    maskBytes += dtt.waterMask?.bytes?.length ?? 0;
    if (dtt.waterMaskWidth !== 256 || dtt.waterMaskHeight !== 256) {
      problems.push(`raster mask at ${key} is ${dtt.waterMaskWidth}x${dtt.waterMaskHeight}`);
    }
    // Stored gzipped, and it must really decompress to the stated geometry.
    const raw = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
    if (raw.length !== 256 * 256) problems.push(`mask at ${key} decompresses to ${raw.length} B`);
  } else {
    uniform += 1;
  }

  // An all-ocean tile must never have been STORED: the serving flow
  // synthesizes those, and storing them inflates the pyramid with millions of
  // identical flat records.
  if (dtt.minHeightM === 0 && dtt.maxHeightM === 0 && dtt.waterMaskKind === 2) {
    oceanStored += 1;
    problems.push(`all-ocean tile stored at ${key}`);
  }

  // The payload really is a gzipped quantized-mesh whose header agrees with
  // the record's stated height range.
  const mesh = zlib.gunzipSync(bytes);
  const minHeight = mesh.readFloatLE(24);
  const maxHeight = mesh.readFloatLE(28);
  if (Math.abs(minHeight - dtt.minHeightM) > 1e-3 || Math.abs(maxHeight - dtt.maxHeightM) > 1e-3) {
    problems.push(`mesh header height range disagrees with the record at ${key}`);
  }

  // ── COVERAGE, which the run itself wrote and this verifier used to ignore ──
  // The encoder states the fraction of posts it actually sampled. A deficit
  // that is an exact non-zero multiple of the grid width is a WHOLE POST ROW OR
  // COLUMN with no source behind it — the signature of a granule the planner
  // did not fetch, and exactly the shape of the 90 zeroed-south-row tiles a
  // clean-looking run shipped in August 2026. A ragged deficit is ordinary
  // coastline against an absent ocean granule and is only counted.
  const posts = (dtt.gridWidth || 65) * (dtt.gridHeight || 65);
  const missing = Math.round((1 - dtt.dataCoverageFraction) * posts);
  if (missing > 0) {
    partialCoverage += 1;
    const width = dtt.gridWidth || 65;
    if (missing % width === 0 && missing / width <= 4) {
      wholeRowsMissing += 1;
      problems.push(
        `${key} is missing ${missing / width} whole post row(s)/column(s) ` +
          `(coverage ${dtt.dataCoverageFraction.toFixed(6)}): a granule the plan did not fetch`,
      );
    }
  }

  edgesByAddress.set(key, meshEdges(mesh, dtt));
}

// ── EDGE CONTINUITY, which no per-tile check can see ───────────────────────
// Two adjacent tiles share a post row. They sample it from the same global
// lattice, so the only thing that may separate their answers is their own
// quantisation step. Anything larger is a seam a person will see: the zeroed
// south row showed up here as a 340-metre disagreement.
let adjacencies = 0;
let worstSeam = 0;
let worstSeamAt = null;
for (const [key, here] of edgesByAddress) {
  const [level, x, y] = key.split("/").map(Number);
  const pairs = [
    [`${level}/${x + 1}/${y}`, "east", "west"],
    [`${level}/${x}/${y + 1}`, "north", "south"],
  ];
  for (const [otherKey, mine, theirs] of pairs) {
    const other = edgesByAddress.get(otherKey);
    if (!other) continue;
    adjacencies += 1;
    const tolerance = Math.max(here.step, other.step) + 1e-6;
    for (let i = 0; i < here.grid; i += 1) {
      const a = here[mine][i];
      const b = other[theirs][i];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const delta = Math.abs(a - b);
      if (delta > worstSeam) {
        worstSeam = delta;
        worstSeamAt = `${key} ${mine} vs ${otherKey} ${theirs} post ${i}`;
      }
      if (delta > tolerance) {
        problems.push(
          `seam at ${key} ${mine} vs ${otherKey} ${theirs} post ${i}: ` +
            `${a.toFixed(3)} m vs ${b.toFixed(3)} m (tolerance ${tolerance.toFixed(3)} m)`,
        );
      }
    }
  }
}

sizes.sort((a, b) => a - b);
const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor((sizes.length - 1) * p))] : 0);

// layer.json availability: level 0 FIRST and always present (a native terrain
// provider with no level-0 availability rejects its tile promise and the globe
// stays an ellipsoid), then every level this run actually built.
const available = [];
for (let level = 0; level <= maxLevel; level += 1) {
  if (level === 0) {
    available.push([{ startX: 0, startY: 0, endX: 1, endY: 0 }]);
    continue;
  }
  available.push(availabilityFor(byLevel.get(level) ?? []));
}

const summary = {
  outDir,
  tiles: records.length,
  distinctAddresses: seen.size,
  storeBytes: fs.statSync(path.join(outDir, "tiles.dttstream")).size,
  levels: [...byLevel.keys()].sort((a, b) => a - b),
  tilesPerLevel: Object.fromEntries([...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([l, v]) => [l, v.length])),
  payloadBytes: { p50: pct(0.5), p99: pct(0.99), max: sizes[sizes.length - 1] ?? 0, bounds: BOUNDS },
  uniformMasks: uniform,
  rasterMasks: raster,
  uniformMaskRatio: records.length ? +(uniform / records.length).toFixed(4) : 0,
  maskBytesStored: maskBytes,
  oceanTilesStored: oceanStored,
  digestMismatches: digestMismatch,
  tilesOverCeiling: overCeiling,
  tilesWithPartialCoverage: partialCoverage,
  tilesMissingWholePostRows: wholeRowsMissing,
  edgeAdjacenciesChecked: adjacencies,
  worstSharedEdgeDeltaM: +worstSeam.toFixed(6),
  worstSharedEdgeAt: worstSeamAt,
  layerJson: { maxzoom: maxLevel, extensions: ["watermask"], available },
  problems,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(JSON.stringify({ ...summary, layerJson: { ...summary.layerJson, available: `<${available.length} levels>` } }, null, 2));
}

fs.writeFileSync(path.join(outDir, "verify-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, "layer-json-config.json"),
  `${JSON.stringify(
    {
      terrain_maxzoom: maxLevel,
      // The shallowest level this run actually BUILT. Below it the store is not
      // authoritative, so the serving module must not read a miss inside
      // availability as "measured all-ocean and skipped" — it synthesizes flat
      // LAND there instead of painting the continents as specular ocean. The
      // key is written here rather than hand-set because only the run knows it.
      terrain_ocean_synth_min_level: Number.isFinite(minLevel) ? minLevel : 0,
      terrain_available: available,
    },
    null,
    2,
  )}\n`,
);

const failures = [
  problems.length ? `${problems.length} problems` : null,
  wholeRowsMissing ? `${wholeRowsMissing} tiles missing a whole post row` : null,
  digestMismatch ? `${digestMismatch} digest mismatches` : null,
  overCeiling ? `${overCeiling} tiles over the ${BOUNDS.hard}-byte ceiling` : null,
  pct(0.5) > BOUNDS.p50 ? `p50 ${pct(0.5)} B over ${BOUNDS.p50}` : null,
  pct(0.99) > BOUNDS.p99 ? `p99 ${pct(0.99)} B over ${BOUNDS.p99}` : null,
].filter(Boolean);
if (failures.length) {
  console.error(`\nNOT PUBLISHABLE: ${failures.join("; ")}`);
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nPUBLISHABLE: every bound met.");
