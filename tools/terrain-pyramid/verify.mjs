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
  const u8 = (id) => { const p = at(id); return p ? buf.readUInt8(p) : 0; };
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
    sourcePostSpacingM: f64(19),
    verticalAccuracyM: f64(23),
    accuracyConfidence: f64(24),
    dataCoverageFraction: f64(26),
    waterMask: payload(29),
    waterMaskKind: i8(28),
    waterMaskWidth: u32(30),
    waterMaskHeight: u32(31),
    childAvailability: u8(35),
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
  // GRID_WIDTH/GRID_HEIGHT are unset on a mesh payload — the schema says so
  // ("Unset for mesh formats, whose vertex count varies") — so the lattice is
  // read from the MESH, which is where it actually lives. Reading a record
  // field that is legitimately absent and defaulting it to 65 would have
  // silently mis-parsed every pyramid built at another grid size.
  void dtt;
  const count = mesh.readUInt32LE(88);
  const grid = Math.round(Math.sqrt(count));
  assert.equal(grid * grid, count, "a regular-lattice mesh has a square vertex count");
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
const partialCoverageDetail = [];
let wholeRowsMissing = 0;
let flatWithLandMask = 0;
let accuracyMeasured = 0;
const accuracyByLevel = new Map();
const childBits = new Map();
const edgesByAddress = new Map();
const maskEdgesByAddress = new Map();
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

  // ── AN ALL-OCEAN TILE MUST NEVER HAVE BEEN STORED ────────────────────────
  //
  // The serving flow synthesizes those, and storing them inflates the pyramid
  // with millions of identical flat records. The test used to require
  // waterMaskKind === UNIFORM_WATER, and that is exactly why it could not see
  // the defect this lane shipped: the mask's block-wide absence fallback wrote
  // LAND over posts in a cell the dataset does not publish, so four tiles flat
  // at exactly 0 m in the open Ligurian Sea carried RASTER masks with 40,527
  // fabricated LAND samples — kind 3, not 2, and therefore invisible here.
  //
  // A tile FLAT AT SEA LEVEL is the thing to look at; what its mask says is
  // then the verdict. Water everywhere: it should have been skipped. Any land
  // at all: the mask is claiming dry ground on a surface that is flat at zero
  // over its whole extent, which is a fabrication until something measured it.
  if (dtt.minHeightM === 0 && dtt.maxHeightM === 0) {
    if (dtt.waterMaskKind === 2) {
      oceanStored += 1;
      problems.push(`all-ocean tile stored at ${key}`);
    } else if (dtt.waterMaskKind === 3) {
      const raw = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
      let land = 0;
      for (const b of raw) if (b === 0x00) land += 1;
      if (land > 0) {
        flatWithLandMask += 1;
        problems.push(
          `${key} is flat at exactly 0 m over its whole extent yet its mask marks ${land} ` +
            "samples as LAND: dry ground claimed on a surface nothing measured above sea level",
        );
      }
    } else if (dtt.waterMaskKind === 1) {
      flatWithLandMask += 1;
      problems.push(`${key} is flat at exactly 0 m yet states UNIFORM_LAND`);
    }
  }

  // The tile's own MEASURED departure from the source between posts. Absent
  // (confidence 0) means the encoder did not measure it, which is itself worth
  // saying: an unmeasured pyramid cannot be judged against Atlas's bound.
  if (dtt.accuracyConfidence > 0) {
    accuracyByLevel.set(dtt.level, Math.max(accuracyByLevel.get(dtt.level) ?? 0, dtt.verticalAccuracyM));
    accuracyMeasured += 1;
  }
  childBits.set(key, dtt.childAvailability);

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
  const grid = Math.round(Math.sqrt(mesh.readUInt32LE(88)));
  const posts = grid * grid;
  const missing = Math.round((1 - dtt.dataCoverageFraction) * posts);
  if (missing > 0) {
    // NARRATED, not counted. "4 tiles with partial coverage" was reported as
    // "ragged coastline, honest" on a run where all four were the rectangular
    // footprint of a granule the source does not publish — the same four tiles
    // that carried the fabricated mask. The geometry is the difference.
    partialCoverageDetail.push({
      address: key,
      missingPosts: missing,
      fraction: +(missing / posts).toFixed(4),
      extentDeg: [dtt.westDeg, dtt.southDeg, dtt.eastDeg, dtt.northDeg].map((v) => +v.toFixed(4)),
      waterMaskKind: dtt.waterMaskKind,
      flatAtZero: dtt.minHeightM === 0 && dtt.maxHeightM === 0,
    });
    partialCoverage += 1;
    const width = grid;
    if (missing % width === 0 && missing / width <= 4) {
      wholeRowsMissing += 1;
      problems.push(
        `${key} is missing ${missing / width} whole post row(s)/column(s) ` +
          `(coverage ${dtt.dataCoverageFraction.toFixed(6)}): a granule the plan did not fetch`,
      );
    }
  }

  edgesByAddress.set(key, meshEdges(mesh, dtt));

  // ── THE WATER MASK'S OWN SHARED EDGES ──────────────────────────────────
  //
  // Column 255 of tile x is the SAME GLOBAL POST as column 0 of tile x+1, and
  // row 0 of tile y is the same post as row 255 of the tile to its south. The
  // encoder's claim is that those bytes are equal BY CONSTRUCTION, from one
  // global lattice — and on a real regional pyramid three of 8,885 adjacencies
  // disagreed on exactly one byte, because the sample index was computed
  // against the per-invoke decode WINDOW's origin rather than the granule's.
  // "By construction" is only worth saying if it is measured, so it is.
  {
    let raw;
    if (dtt.waterMaskKind === 3) raw = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
    else raw = Buffer.alloc(256 * 256, dtt.waterMaskKind === 2 ? 0xff : 0x00);
    const column = (c) => Buffer.from(Array.from({ length: 256 }, (_, r) => raw[r * 256 + c]));
    maskEdgesByAddress.set(key, {
      west: column(0),
      east: column(255),
      north: Buffer.from(raw.subarray(0, 256)),
      south: Buffer.from(raw.subarray(255 * 256, 256 * 256)),
    });
  }
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

// The mask's shared bytes, over every adjacency, both axes. Row 0 is the NORTH
// edge of the mask raster, so the tile to the NORTH shares its south row with
// this tile's north row.
let maskAdjacencies = 0;
let maskByteDisagreements = 0;
const maskSeamExamples = [];
for (const [key, here] of maskEdgesByAddress) {
  const [level, x, y] = key.split("/").map(Number);
  const pairs = [
    [`${level}/${x + 1}/${y}`, "east", "west"],
    [`${level}/${x}/${y + 1}`, "north", "south"],
  ];
  for (const [otherKey, mine, theirs] of pairs) {
    const other = maskEdgesByAddress.get(otherKey);
    if (!other) continue;
    maskAdjacencies += 1;
    for (let i = 0; i < 256; i += 1) {
      if (here[mine][i] === other[theirs][i]) continue;
      maskByteDisagreements += 1;
      if (maskSeamExamples.length < 8) {
        maskSeamExamples.push(
          `${key} ${mine}[${i}] = 0x${here[mine][i].toString(16).padStart(2, "0")} but ` +
            `${otherKey} ${theirs}[${i}] = 0x${other[theirs][i].toString(16).padStart(2, "0")}`,
        );
      }
    }
  }
}
if (maskByteDisagreements) {
  problems.push(
    `${maskByteDisagreements} shared water-mask bytes disagree across ${maskAdjacencies} ` +
      `adjacencies (e.g. ${maskSeamExamples[0]})`,
  );
}

sizes.sort((a, b) => a - b);
const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor((sizes.length - 1) * p))] : 0);

// ── layer.json availability, WITH ITS ANCESTOR CLOSURE ─────────────────────
//
// Level 0 is first and always present: a native terrain provider whose
// availability has no level-0 entry rejects its own tile promise and the globe
// stays an ellipsoid. Every level this run BUILT contributes its stored
// addresses.
//
// And every level BETWEEN them contributes those addresses' ancestors, which
// is not decoration. CesiumTerrainProvider does not ask "is (level,x,y) listed
// at level" — TileAvailability.isTileAvailable is
// computeMaximumLevelAtPosition(centre of the tile) >= level, whose own comment
// states the assumption the index has to satisfy: "if a tile at level n exists,
// then all its parent tiles back to level 0 exist too". A regional pyramid
// declaring nothing at levels 1..7 and rectangles at 8..13 breaks that
// assumption on its face, and the client duly computed shallow addresses as
// available and asked for them. Declaring the closure makes the published index
// say what the client is going to conclude from it anyway.
const available = [];
{
  const byLevelClosed = new Map();
  for (const [level, addresses] of byLevel) {
    byLevelClosed.set(level, new Set(addresses.map(({ x, y }) => `${x}/${y}`)));
  }
  for (let level = maxLevel; level >= 1; level -= 1) {
    const here = byLevelClosed.get(level);
    if (!here) continue;
    const parents = byLevelClosed.get(level - 1) ?? new Set();
    for (const key of here) {
      const [x, y] = key.split("/").map(Number);
      parents.add(`${x >> 1}/${y >> 1}`);
    }
    byLevelClosed.set(level - 1, parents);
  }
  for (let level = 0; level <= maxLevel; level += 1) {
    if (level === 0) {
      available.push([{ startX: 0, startY: 0, endX: 1, endY: 0 }]);
      continue;
    }
    const set = byLevelClosed.get(level) ?? new Set();
    available.push(
      availabilityFor([...set].map((key) => {
        const [x, y] = key.split("/").map(Number);
        return { x, y };
      })),
    );
  }
}

// ── WHAT THE CLIENT WILL ACTUALLY ASK FOR ──────────────────────────────────
//
// Cesium's own rule, re-implemented here, and every address it makes available
// enumerated: an address that is available but NOT stored is one the serving
// module must synthesize. Before the module's availability test was changed to
// this rule, those addresses were 404s — 14 of them on the regional pyramid,
// 2 at z6 and 12 at z7 — reaching the browser against the zero-4xx bound.
const tileCentre = (level, x, y) => [
  -180 + ((x + 0.5) * 360) / 2 ** (level + 1),
  -90 + ((y + 0.5) * 180) / 2 ** level,
];
function maxLevelAtPosition(lon, lat) {
  for (let level = available.length - 1; level >= 0; level -= 1) {
    const cols = 2 ** (level + 1);
    const rows = 2 ** level;
    const x = Math.min(cols - 1, Math.max(0, Math.floor(((lon + 180) * cols) / 360)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor(((lat + 90) * rows) / 180)));
    for (const r of available[level]) {
      if (x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY) return level;
    }
  }
  return -1;
}
const clientSeesAvailable = (level, x, y) => maxLevelAtPosition(...tileCentre(level, x, y)) >= level;

const availableButUnstored = [];
for (let level = 0; level <= maxLevel; level += 1) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let deeper = level; deeper < available.length; deeper += 1) {
    const shift = deeper - level;
    for (const r of available[deeper]) {
      x0 = Math.min(x0, r.startX >> shift);
      x1 = Math.max(x1, r.endX >> shift);
      y0 = Math.min(y0, r.startY >> shift);
      y1 = Math.max(y1, r.endY >> shift);
    }
  }
  if (!Number.isFinite(x0)) continue;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (!clientSeesAvailable(level, x, y)) continue;
      const key = `${level}/${x}/${y}`;
      if (!seen.has(key)) availableButUnstored.push(key);
    }
  }
}
const unstoredByLevel = {};
for (const key of availableButUnstored) {
  const level = Number(key.split("/")[0]);
  unstoredByLevel[level] = (unstoredByLevel[level] ?? 0) + 1;
}

// ── CHILD_AVAILABILITY: A SET BIT IS A CLAIM, AND EVERY CLAIM IS CHECKED ───
//
// "A set bit states the child exists in this tileset." A CLEAR bit is an
// absence of claim, not a claim of absence, so a record that sets nothing is
// not asserting a childless tile — it is declining to assert, which is the
// honest position for a shallow-to-deep walk that cannot know which children
// the ocean skip will drop. What is NOT allowed is a set bit that disagrees
// with what the tileset actually serves: measured on a real regional store,
// the old region-block rule set 114 bits for children the tileset does not
// hold and cleared 18 for children it does.
let childBitsWrong = 0;
let childBitsClaimed = 0;
const childBitExamples = [];
for (const [key, bits] of childBits) {
  const claimed = bits & 0x0f;
  if (claimed === 0) continue;
  childBitsClaimed += 1;
  const [level, x, y] = key.split("/").map(Number);
  let actual = 0;
  if (clientSeesAvailable(level + 1, x * 2, y * 2)) actual |= 1;
  if (clientSeesAvailable(level + 1, x * 2 + 1, y * 2)) actual |= 2;
  if (clientSeesAvailable(level + 1, x * 2, y * 2 + 1)) actual |= 4;
  if (clientSeesAvailable(level + 1, x * 2 + 1, y * 2 + 1)) actual |= 8;
  // Every bit the record SETS must be a child the tileset really serves.
  if ((claimed & ~actual) !== 0) {
    childBitsWrong += 1;
    if (childBitExamples.length < 8) {
      childBitExamples.push(`${key} claims children ${claimed}, availability serves ${actual}`);
    }
  }
}
if (childBitsWrong) {
  problems.push(
    `${childBitsWrong} records CLAIM a CHILD_AVAILABILITY bit for a child the published ` +
      `availability does not serve (e.g. ${childBitExamples[0]})`,
  );
}

// ── ATLAS'S VERTICAL-ERROR BOUND, against the tiles' OWN measurement ───────
//
// Each record states the departure its encoder measured between posts against
// the source it was cut from, so this needs no reference decoder and no second
// sampling of the granules: it reads what the pyramid says about itself and
// compares it with the ruled bound. A level the pyramid cannot meet is named
// in the verdict, so a ship gate cannot read the run as green.
const accuracy = [];
for (const level of [...accuracyByLevel.keys()].sort((a, b) => a - b)) {
  const bound = 77067 / 2 ** level;
  const worst = accuracyByLevel.get(level);
  accuracy.push({
    level,
    boundM: +bound.toFixed(2),
    worstMeasuredM: +worst.toFixed(3),
    withinBound: worst <= bound,
  });
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
  // Tiles flat at exactly sea level over their whole extent whose mask still
  // claims land somewhere. The old ocean test could not see these because it
  // required a UNIFORM_WATER mask, and the four the encoder shipped were
  // RASTER precisely BECAUSE of the fabricated land in them.
  flatAtZeroWithLandMask: flatWithLandMask,
  digestMismatches: digestMismatch,
  tilesOverCeiling: overCeiling,
  tilesWithPartialCoverage: partialCoverage,
  partialCoverageDetail: partialCoverageDetail.slice(0, 32),
  tilesMissingWholePostRows: wholeRowsMissing,
  // Every address the CLIENT computes as available (max level at the tile
  // centre) that the store does not hold. Each is served by synthesis, never a
  // 404 — that is the contract; the count is here so nobody has to assume it.
  availableButUnstored: availableButUnstored.length,
  availableButUnstoredByLevel: unstoredByLevel,
  childAvailabilityClaims: childBitsClaimed,
  childAvailabilityUnservedClaims: childBitsWrong,
  childAvailabilityExamples: childBitExamples,
  verticalAccuracy: accuracy,
  tilesStatingMeasuredAccuracy: accuracyMeasured,
  edgeAdjacenciesChecked: adjacencies,
  maskAdjacenciesChecked: maskAdjacencies,
  maskSharedByteDisagreements: maskByteDisagreements,
  maskSeamExamples,
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
      // The mount the serving flow answers on. Written here because route()
      // has no fallback any more: a path that does not start with it is a 404,
      // which is the point — but it means a deployment that mounts the flow
      // somewhere else MUST state it, and a config file that omits the key
      // would silently 404 every tile.
      terrain_mount_path: "/api/v1/terrain/",
      terrain_available: available,
    },
    null,
    2,
  )}\n`,
);

const overAccuracyBound = accuracy.filter((a) => !a.withinBound);
const failures = [
  problems.length ? `${problems.length} problems` : null,
  wholeRowsMissing ? `${wholeRowsMissing} tiles missing a whole post row` : null,
  digestMismatch ? `${digestMismatch} digest mismatches` : null,
  overCeiling ? `${overCeiling} tiles over the ${BOUNDS.hard}-byte ceiling` : null,
  pct(0.5) > BOUNDS.p50 ? `p50 ${pct(0.5)} B over ${BOUNDS.p50}` : null,
  pct(0.99) > BOUNDS.p99 ? `p99 ${pct(0.99)} B over ${BOUNDS.p99}` : null,
  accuracyMeasured === 0
    ? "no tile states a measured vertical accuracy, so the pyramid cannot be judged against the bound"
    : null,
  overAccuracyBound.length
    ? `vertical error over 77067/2^level at ${overAccuracyBound
        .map((a) => `z${a.level} ${a.worstMeasuredM} m vs ${a.boundM} m`)
        .join(", ")}`
    : null,
].filter(Boolean);
if (failures.length) {
  console.error(`\nNOT PUBLISHABLE: ${failures.join("; ")}`);
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nPUBLISHABLE: every bound met.");
