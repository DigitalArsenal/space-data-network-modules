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

import {
  createSortedJsonRunWriter,
  evaluateTerrainEdgeFacts,
  iterateBoundedLines,
  iterateJsonStringArrayProperty,
  mergeSortedJsonRuns,
} from "./build-support.mjs";
import { iterateStreamFile, readDtt, readDttProvenance } from "./dtt-reader.mjs";

// ── THE BOUNDS THIS PYRAMID HAS TO SATISFY TO BE PUBLISHABLE ───────────────
//
// Coordinator reconciliation 2026-08-27, which supersedes the pair these
// numbers used to be:
//
//   (a) mesh density adapts per tile to relief inside a 32 KiB gzipped HARD
//       cap, targeting worst-post vertical error <= 2 x 77067/2^level m; where
//       the cap cannot meet it the tile ships AT the cap STATING its measured
//       VERTICAL_ACCURACY_M, and this verifier reports the count and % of such
//       tiles per level — gated at <= 5% for z >= 10, unbounded for z <= 9.
//   (b) bytes: p50 <= 10 KiB, p99 <= 24 KiB, hard 32 KiB.
//
// AND COORDINATOR RESOLUTIONS 2026-08-27 (1) and (2), which move both:
//
//   (1) "worst post" means EVERY 1-ARCSEC SOURCE POST the granule carries
//       inside the tile, with the mesh interpolated at the post — never the
//       encoder's own resampled lattice and never a level+2 reference that does
//       not resolve the source. The encoder measures it that way now
//       (measure_mesh_accuracy), so the VERTICAL_ACCURACY_M this file reads off
//       each record IS the source-post figure and the gate below is a gate on
//       the real quantity rather than on the instrument.
//   (2) bytes revised so the accuracy target can be met on rugged coast:
//       p99 <= 28 KiB (was 24). p50 and the hard cap are unchanged.
//
// The OLD accuracy pair (77067/2^level with RMSE <= 25%) is retired AS A GATE
// and kept AS A NUMBER: both figures are reported per level below, so the
// change of gate is visible rather than a quiet loosening.
const BOUNDS = { p50: 10240, p99: 28672, hard: 32768 };
// The share of tiles per level that may ship at the cap without meeting the
// error target, and the level from which that share is gated at all.
import { memoryPagesAdvice, memoryPagesFor } from "./memory-pages.mjs";

const CEILING_SHARE = { max: 0.05, gatedFromLevel: 10 };

// ── THE SKIRT THE CLIENT WILL DRAW, COMPUTED THE CLIENT'S OWN WAY ──────────
//
// Cesium hides the crack between two neighbouring tiles of different density
// behind a skirt: CesiumTerrainProvider.js builds it as
// `provider.getLevelMaximumGeometricError(level) * 5.0`, and that error is
// `levelZeroMaximumGeometricError / 2^level` where level zero is
// `ellipsoid.maximumRadius * 2 * PI * heightmapTerrainQuality /
// (tileImageWidth * numberOfTilesAtLevelZero)` = 6378137 * 2pi * 0.25 /
// (65 * 2) = 77067.34 m (TerrainProvider.js, heightmapTerrainQuality 0.25).
//
// The density-step crack used to be reported here with the words "the LOD crack
// quantized-mesh skirts exist for" and never compared to the skirt. At z11 it
// EXCEEDED it — 207.46 m of gap against a 188.15 m skirt, ~19 m of open sky
// between two same-level neighbours — so the sentence that dismissed it was
// the one thing that could have caught it. It is a gate now.
const errorTargetM = (level) => (2 * 77067) / 2 ** level;
const legacyBoundM = (level) => 77067 / 2 ** level;

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

function encodeMeshEdge(edge) {
  const bytes = Buffer.allocUnsafe(edge.length * 8);
  for (let index = 0; index < edge.length; index += 1) bytes.writeDoubleLE(edge[index], index * 8);
  return bytes.toString("base64");
}

function physicalEdgeKey(kind, level, x, y, side) {
  if (side === "west") return `${kind}|${level}|V|${x}|${y}`;
  if (side === "east") return `${kind}|${level}|V|${x + 1}|${y}`;
  if (side === "south") return `${kind}|${level}|H|${x}|${y}`;
  assert.equal(side, "north", "terrain edge side must be cardinal");
  return `${kind}|${level}|H|${x}|${y + 1}`;
}

// A fact names the PHYSICAL edge, rather than the tile that happened to emit
// it.  Thus an interior edge has exactly two facts even when its two payloads
// land in different sort runs; an exterior edge is a harmless singleton.
function spoolTileEdges(writer, { kind, level, x, y, ownerOrdinal, grid, step, edges }) {
  const ownerAddress = `${level}/${x}/${y}`;
  for (const side of ["west", "east", "south", "north"]) {
    writer.push({
      key: physicalEdgeKey(kind, level, x, y, side),
      kind,
      level,
      orientation: side === "west" || side === "east" ? "V" : "H",
      boundaryX: side === "west" ? x : side === "east" ? x + 1 : x,
      boundaryY: side === "south" ? y : side === "north" ? y + 1 : y,
      ownerAddress,
      ownerOrdinal,
      side,
      grid,
      step,
      edgeBytes: kind === "mesh" ? encodeMeshEdge(edges[side]) : Buffer.from(edges[side]).toString("base64"),
    });
  }
}

const ADDRESS_FIELD_WIDTH = 12;

function addressFactKey(level, x, y) {
  assert.ok(Number.isSafeInteger(level) && level >= 0, "terrain address level must be a non-negative integer");
  assert.ok(Number.isSafeInteger(x) && x >= 0, "terrain address x must be a non-negative integer");
  assert.ok(Number.isSafeInteger(y) && y >= 0, "terrain address y must be a non-negative integer");
  return `${String(level).padStart(ADDRESS_FIELD_WIDTH, "0")}|${String(y).padStart(ADDRESS_FIELD_WIDTH, "0")}|${String(x).padStart(ADDRESS_FIELD_WIDTH, "0")}`;
}

function terrainAddress(level, x, y) {
  return `${level}/${x}/${y}`;
}

function parseTerrainAddress(value, source) {
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(value);
  assert.ok(match, `invalid terrain address in ${source}: ${JSON.stringify(value)}`);
  const [level, x, y] = match.slice(1).map(Number);
  assert.ok(Number.isSafeInteger(level) && Number.isSafeInteger(x) && Number.isSafeInteger(y), `unsafe terrain address in ${source}: ${JSON.stringify(value)}`);
  return { level, x, y };
}

const OCEAN_SKIP_MAX_RECEIPT_BYTES = 64 * 1024;
const OCEAN_SKIP_MAX_LINES_BYTES = 512 * 1024 * 1024;
const OCEAN_SKIP_MAX_ROW_BYTES = 256;

async function fileSha256(file, maxBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert.ok(bytes <= maxBytes, `ocean skip address list exceeds ${maxBytes} bytes: ${file}`);
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return { bytes, digest: hash.digest("hex") };
}

// New global cuts write a compact receipt beside a separately streamed raw
// ASCII address list (one `level/x/y` line each).  Regional evidence retains
// the older JSON array.  Both paths are bounded and return the same async
// address stream to the verifier.
async function* iterateOceanSkippedAddresses(outDir, legacyPath) {
  if (!fs.existsSync(legacyPath)) return;
  const receiptStat = fs.statSync(legacyPath);
  assert.ok(receiptStat.isFile(), `ocean skip receipt is not a regular file: ${legacyPath}`);
  assert.ok(receiptStat.size <= OCEAN_SKIP_MAX_LINES_BYTES,
    `ocean skip input exceeds ${OCEAN_SKIP_MAX_LINES_BYTES} bytes: ${legacyPath}`);
  let receipt = null;
  if (receiptStat.size <= OCEAN_SKIP_MAX_RECEIPT_BYTES) {
    try { receipt = JSON.parse(fs.readFileSync(legacyPath, "utf8")); } catch { receipt = null; }
  }
  if (!Object.hasOwn(receipt ?? {}, "format")) {
    for await (const address of iterateJsonStringArrayProperty(legacyPath, "addresses", {
      maxFileBytes: OCEAN_SKIP_MAX_LINES_BYTES,
      maxStringBytes: OCEAN_SKIP_MAX_ROW_BYTES,
    })) {
      yield address;
    }
    return;
  }
  assert.equal(receipt.format, "terrain-ocean-skips-lines-v1", `unsupported ocean skip receipt format ${receipt.format}`);
  assert.equal(typeof receipt.addressesPath, "string", "ocean skip receipt addressesPath must be a string");
  assert.ok(Number.isSafeInteger(receipt.count) && receipt.count >= 0, "ocean skip receipt count must be a non-negative integer");
  assert.match(receipt.digest, /^[a-f0-9]{64}$/, "ocean skip receipt digest must be a SHA-256 hex digest");
  const receiptDir = fs.realpathSync(outDir);
  const candidate = path.resolve(path.dirname(legacyPath), receipt.addressesPath);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(receiptDir, resolved);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative),
    `ocean skip receipt target escapes output directory: ${receipt.addressesPath}`);
  const stat = fs.statSync(resolved);
  assert.ok(stat.isFile(), `ocean skip receipt target is not a regular file: ${resolved}`);
  assert.ok(stat.size <= OCEAN_SKIP_MAX_LINES_BYTES, `ocean skip address list exceeds ${OCEAN_SKIP_MAX_LINES_BYTES} bytes: ${resolved}`);
  const hashed = await fileSha256(resolved, OCEAN_SKIP_MAX_LINES_BYTES);
  assert.equal(hashed.digest, receipt.digest, `ocean skip receipt digest mismatch for ${resolved}`);
  let count = 0;
  let previous = null;
  for await (const line of iterateBoundedLines(resolved, { maxRowBytes: OCEAN_SKIP_MAX_ROW_BYTES })) {
    const address = line.toString("utf8");
    assert.ok(Buffer.byteLength(address) === line.length, `ocean skip line ${count + 1} is not valid UTF-8`);
    const parsed = parseTerrainAddress(address, resolved);
    assert.equal(address, terrainAddress(parsed.level, parsed.x, parsed.y), `ocean skip line ${count + 1} is not canonical`);
    assert.ok(previous === null || previous < address, `ocean skip lines must be sorted and unique at ${address}`);
    previous = address;
    count += 1;
    yield address;
  }
  assert.equal(count, receipt.count, `ocean skip receipt count mismatch for ${resolved}`);
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);

// ── THE ENCODER'S OWN COUNTERS, IF THE RUN LEFT THEM ───────────────────────
//
// Everything else in this file is re-derived from the RECORD BYTES, on purpose:
// the builder's run report is the builder's word for it. But two facts are not
// in the records at all and cannot be — how many posts the encoder CLAMPED
// (a displaced sample, the residual of the cross-granule stencil and the signal
// that a neighbour granule is missing from the plan) and how many crossed a
// latitude-band boundary. The encoder emits both per block, the flow lands them
// on egress, run.mjs carries them into run-report.json, and this reads them.
//
// It is OPTIONAL by design: verify.mjs still runs against a bare tile store.
// When the report is absent the counters are reported as null rather than as
// zero, because "nobody counted" and "the count was zero" are different claims.
const runReportPath = path.join(outDir, "run-report.json");
const runReport = fs.existsSync(runReportPath)
  ? JSON.parse(fs.readFileSync(runReportPath, "utf8"))
  : null;
const encoderCounters = runReport?.encoderCounters ?? null;

// ── THE ADDRESSES THE OCEAN TEST SKIPPED ───────────────────────────────────
//
// A tile the encoder dropped because it measured the address as all water is
// NOT an absence of knowledge, and this file used to treat it as one:
// `available` was derived from STORED tiles, so a skipped address vanished
// from the published index, a client over open water refined until
// availability ran out, and it then rendered the shallowest ANCESTOR — a
// height-0 tile with a UNIFORM LAND mask, because an ancestor sits below the
// level where the store is authoritative and correctly fails safe to land.
// Measured on the regional pyramid: 24.3% of the ocean inside the tileset's
// own extent came back as land, and `terrain_ocean_synth_min_level` — the
// lever built to prevent exactly that — could never fire, because the only
// addresses it could have applied to were not in the index.
//
// A skipped address is DECLARED here and answered by the module's synthesized
// UNIFORM_WATER path, which is what that path exists for. Optional, like the
// run report: an older store has no such file and behaves as it always did.
const oceanSkippedPath = path.join(outDir, "ocean-skipped.json");

const recordsPath = path.join(outDir, "tiles.dttstream");
// These directories are disposable, attempt-scoped external-sort state.  The
// writer and merger each reclaim stale material before use; the successful
// path below removes it too, so a global run never leaves a second tile index.
const edgeFactRunDir = path.join(outDir, ".verify-edge-facts");
const edgeFactScratchDir = path.join(outDir, ".verify-edge-merge");
const edgeFactWriter = createSortedJsonRunWriter(edgeFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 64 * 1024,
});
const addressFactRunDir = path.join(outDir, ".verify-address-facts");
const addressFactScratchDir = path.join(outDir, ".verify-address-merge");
const addressFactWriter = createSortedJsonRunWriter(addressFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 4096,
});
const sizeFactRunDir = path.join(outDir, ".verify-size-facts");
const sizeFactScratchDir = path.join(outDir, ".verify-size-merge");
const sizeFactWriter = createSortedJsonRunWriter(sizeFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 256,
});
let recordCount = 0;
let firstRecord = null;

let uniform = 0;
let raster = 0;
let oceanStored = 0;
// Stored tiles the mask calls water EVERYWHERE whose mesh is nonetheless not
// flat at sea level. REPORTED, never gated: a genuine one is real data (an
// all-water tile whose source carries relief), and the encoder's ocean test now
// reads the SOURCE POSTS rather than the interpolated lattice precisely so the
// spurious ones — an all-water tile whose corner VERTEX is lifted by a coast on
// the far side of its boundary — stop being stored. Kept visible so the residue
// is a number somebody can look at rather than an assumption.
let uniformWaterNotFlat = 0;
const uniformWaterNotFlatSample = [];
let digestMismatch = 0;
let overCeiling = 0;
let maxLevel = 0;
let maskBytes = 0;
let minLevel = Infinity;
let partialCoverage = 0;
const partialCoverageDetail = [];
let wholeRowsMissing = 0;
let flatWithLandMask = 0;
let flatOverMeasuredRelief = 0;
const flatWithLandMaskExamples = [];
let accuracyMeasured = 0;
const accuracyByLevel = new Map();
// Per level: how many tiles state a measured accuracy, and how many of those
// exceed the ruled target — i.e. ship AT the cap. Derived from the records
// rather than from the encoder's own atCeiling flag, so the number the gate
// reads is not the number the encoder chose to write.
const atCeilingByLevel = new Map();
const atCeilingExamples = [];
const problems = [];
const PROBLEM_EXAMPLE_LIMIT = 64;
let problemCount = 0;
const appendProblemExample = (problem) => {
  if (problems.length < PROBLEM_EXAMPLE_LIMIT) problems.push(problem);
};
const recordProblem = (problem) => {
  problemCount += 1;
  appendProblemExample(problem);
};

for await (const record of iterateStreamFile(recordsPath)) {
  recordCount += 1;
  if (!firstRecord) firstRecord = Buffer.from(record);
  const dtt = readDtt(record);
  const key = terrainAddress(dtt.level, dtt.x, dtt.y);
  maxLevel = Math.max(maxLevel, dtt.level);
  minLevel = Math.min(minLevel, dtt.level);

  const bytes = Buffer.from(dtt.payload.bytes);
  addressFactWriter.push({
    key: addressFactKey(dtt.level, dtt.x, dtt.y),
    kind: "stored",
    level: dtt.level,
    x: dtt.x,
    y: dtt.y,
    address: key,
    ordinal: recordCount - 1,
    childAvailability: dtt.childAvailability,
  });
  sizeFactWriter.push({
    key: `${String(bytes.length).padStart(12, "0")}|${String(recordCount - 1).padStart(16, "0")}`,
    bytes: bytes.length,
  });
  if (bytes.length > BOUNDS.hard) overCeiling += 1;

  // DIGEST is stated over the GZIPPED bytes; re-derive it.
  const expected = `1220${createHash("sha256").update(bytes).digest("hex")}`;
  if (dtt.payload.digest !== expected) digestMismatch += 1;
  if (dtt.etag !== `"${expected}"`) recordProblem(`ETAG does not match DIGEST at ${key}`);

  if (dtt.waterMaskKind === 3) {
    raster += 1;
    maskBytes += dtt.waterMask?.bytes?.length ?? 0;
    if (dtt.waterMaskWidth !== 256 || dtt.waterMaskHeight !== 256) {
      recordProblem(`raster mask at ${key} is ${dtt.waterMaskWidth}x${dtt.waterMaskHeight}`);
    }
    // Stored gzipped, and it must really decompress to the stated geometry.
    const raw = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
    if (raw.length !== 256 * 256) recordProblem(`mask at ${key} decompresses to ${raw.length} B`);
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
  //
  // A FLAT-AT-ZERO MESH OVER A MASK THAT SAYS LAND IS COUNTED, ALWAYS — AND
  // THE NARROWING THAT HID EIGHT OF THEM IS GONE.
  //
  // This used to skip every tile whose record stated a non-zero
  // VERTICAL_ACCURACY_M, on the reasoning that such a tile is "the ruling
  // working": density adapted, the flat mesh is deliberate, and the record
  // says so. The reasoning was sound and the premise was false. The number it
  // trusted came from an accuracy probe whose three samples per cell were
  // COLLINEAR on the split diagonal, so "non-zero accuracy" meant nothing
  // about whether the source was flat — and independent measurement against
  // the real posts found eight of these tiles sitting over real terrain, up to
  // 812.9 m of it (the tip of Cap Corse, rendered as flat ocean at z8). Three
  // were excluded from the published count purely by the narrowing.
  //
  // So the count is unconditional now, and it is SPLIT rather than skipped:
  //
  //   flatAtZeroWithLandMask          every one of them
  //   flatAtZeroOverMeasuredRelief    the subset the encoder itself says it
  //                                   flattened (VERTICAL_ACCURACY_M > 0)
  //
  // and the subset whose flattening also breaks the level's error target is a
  // GATE. With an honest probe that case cannot arise from the ladder choosing
  // badly — the ladder climbs on exactly that signal — so if it appears, either
  // the byte cap stopped the climb over real land or something upstream is
  // wrong, and both are worth stopping a publish for.
  if (dtt.minHeightM === 0 && dtt.maxHeightM === 0 && dtt.waterMaskKind === 2) {
    // Unconditional: a flat-at-zero tile whose mask is UNIFORM_WATER is open
    // ocean whatever its accuracy figure says, and the serving flow synthesizes
    // those. Storing them inflates the pyramid with identical flat records.
    oceanStored += 1;
    recordProblem(`all-ocean tile stored at ${key}`);
  }
  if (dtt.waterMaskKind === 2 && !(dtt.minHeightM === 0 && dtt.maxHeightM === 0)) {
    uniformWaterNotFlat += 1;
    if (uniformWaterNotFlatSample.length < 20) {
      uniformWaterNotFlatSample.push({ key, minHeightM: dtt.minHeightM, maxHeightM: dtt.maxHeightM });
    }
  }
  if (dtt.minHeightM === 0 && dtt.maxHeightM === 0) {
    let landSamples = 0;
    if (dtt.waterMaskKind === 3) {
      const raw = zlib.gunzipSync(Buffer.from(dtt.waterMask.bytes));
      for (const b of raw) if (b === 0x00) landSamples += 1;
    } else if (dtt.waterMaskKind === 1) {
      landSamples = 256 * 256; // UNIFORM_LAND: the whole tile
    }
    if (landSamples > 0 && dtt.waterMaskKind !== 2) {
      // COUNTED. A DEM that reads exactly 0 m where the water mask says land
      // can be the SOURCE disagreeing with itself — reclaimed land, lagoons and
      // salt flats really do sit at 0 m, and the two Copernicus products are
      // independent. Land INVENTED from an absent DEM granule is a different
      // measurement with its own counter (`maskFromAbsenceSamples`), gated
      // below.
      flatWithLandMask += 1;
      const detail = dtt.waterMaskKind === 1 ? "UNIFORM_LAND" : `${landSamples} land samples`;
      if (flatWithLandMaskExamples.length < 16) {
        flatWithLandMaskExamples.push(`${key}: ${detail}, states ${dtt.verticalAccuracyM.toFixed(3)} m`);
      }
      if (dtt.verticalAccuracyM > 0) {
        // The MESH flattened relief the encoder measured. Not the source
        // disagreeing with itself: the tile saying, in its own record, that it
        // renders real ground as sea level.
        flatOverMeasuredRelief += 1;
        if (dtt.verticalAccuracyM > errorTargetM(dtt.level)) {
          recordProblem(
            `${key} renders land as flat sea level: mesh min == max == 0 m over a mask with ` +
              `${detail}, while the record states ${dtt.verticalAccuracyM.toFixed(3)} m of ` +
              `departure against a ${errorTargetM(dtt.level).toFixed(2)} m target ` +
              `(${bytes.length} B of a ${BOUNDS.hard} B cap)`,
          );
        }
      }
    }
  }

  // The tile's own MEASURED departure from the source between posts. Absent
  // (confidence 0) means the encoder did not measure it, which is itself worth
  // saying: an unmeasured pyramid cannot be judged against Atlas's bound.
  if (dtt.accuracyConfidence > 0) {
    accuracyByLevel.set(dtt.level, Math.max(accuracyByLevel.get(dtt.level) ?? 0, dtt.verticalAccuracyM));
    accuracyMeasured += 1;
    const seenAtLevel = atCeilingByLevel.get(dtt.level) ?? { total: 0, over: 0 };
    seenAtLevel.total += 1;
    if (dtt.verticalAccuracyM > errorTargetM(dtt.level)) {
      seenAtLevel.over += 1;
      if (atCeilingExamples.length < 16) {
        atCeilingExamples.push({
          address: key,
          statedAccuracyM: +dtt.verticalAccuracyM.toFixed(3),
          targetM: +errorTargetM(dtt.level).toFixed(2),
          payloadBytes: bytes.length,
        });
      }
    }
    atCeilingByLevel.set(dtt.level, seenAtLevel);
  }
  // The payload really is a gzipped quantized-mesh whose header agrees with
  // the record's stated height range.
  const mesh = zlib.gunzipSync(bytes);
  const minHeight = mesh.readFloatLE(24);
  const maxHeight = mesh.readFloatLE(28);
  if (Math.abs(minHeight - dtt.minHeightM) > 1e-3 || Math.abs(maxHeight - dtt.maxHeightM) > 1e-3) {
    recordProblem(`mesh header height range disagrees with the record at ${key}`);
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
    if (partialCoverageDetail.length < 32) {
      partialCoverageDetail.push({
        address: key,
        missingPosts: missing,
        fraction: +(missing / posts).toFixed(4),
        extentDeg: [dtt.westDeg, dtt.southDeg, dtt.eastDeg, dtt.northDeg].map((v) => +v.toFixed(4)),
        waterMaskKind: dtt.waterMaskKind,
        flatAtZero: dtt.minHeightM === 0 && dtt.maxHeightM === 0,
      });
    }
    partialCoverage += 1;
    const width = grid;
    if (missing % width === 0 && missing / width <= 4) {
      wholeRowsMissing += 1;
      recordProblem(
        `${key} is missing ${missing / width} whole post row(s)/column(s) ` +
          `(coverage ${dtt.dataCoverageFraction.toFixed(6)}): a granule the plan did not fetch`,
      );
    }
  }

  const tileMeshEdges = meshEdges(mesh, dtt);
  spoolTileEdges(edgeFactWriter, {
    kind: "mesh",
    level: dtt.level,
    x: dtt.x,
    y: dtt.y,
    ownerOrdinal: recordCount - 1,
    grid: tileMeshEdges.grid,
    step: tileMeshEdges.step,
    edges: tileMeshEdges,
  });

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
    const column = (c) => {
      const edge = Buffer.allocUnsafe(256);
      for (let row = 0; row < 256; row += 1) edge[row] = raw[row * 256 + c];
      return edge;
    };
    spoolTileEdges(edgeFactWriter, {
      kind: "mask",
      level: dtt.level,
      x: dtt.x,
      y: dtt.y,
      ownerOrdinal: recordCount - 1,
      grid: 256,
      step: 0,
      edges: {
      west: column(0),
      east: column(255),
      north: Buffer.from(raw.subarray(0, 256)),
      south: Buffer.from(raw.subarray(255 * 256, 256 * 256)),
      },
    });
  }
}

for await (const address of iterateOceanSkippedAddresses(outDir, oceanSkippedPath)) {
  const { level, x, y } = parseTerrainAddress(address, oceanSkippedPath);
  addressFactWriter.push({
    key: addressFactKey(level, x, y),
    kind: "ocean",
    level,
    x,
    y,
    address: terrainAddress(level, x, y),
  });
}

// ── EDGE CONTINUITY, which no per-tile check can see ───────────────────────
//
// The old verifier held four mesh edges and four mask edges for every address.
// A global cut cannot afford that index.  The writer above emits one compact
// fact per physical edge, and the external merge below holds only the two facts
// that meet at one boundary.  The evaluator preserves the former shared-post,
// mixed-density crack and mask-statistic rules verbatim.
const LEVEL_ZERO_GEOMETRIC_ERROR_M = (6378137 * 2 * Math.PI * 0.25) / (65 * 2);
const skirtHeightM = (level) => (LEVEL_ZERO_GEOMETRIC_ERROR_M / 2 ** level) * 5;

const edgeFactRuns = edgeFactWriter.finish();
let edgeChecks;
try {
  edgeChecks = await evaluateTerrainEdgeFacts(edgeFactRuns, {
    maxOpenRuns: 32,
    maxRowBytes: 64 * 1024,
    scratchDir: edgeFactScratchDir,
  });
} finally {
  fs.rmSync(edgeFactRunDir, { recursive: true, force: true });
  fs.rmSync(edgeFactScratchDir, { recursive: true, force: true });
}
// Edge diagnostics are deliberately capped inside the external-sort consumer:
// a global seam regression can produce millions of bad shared posts, and this
// report needs the count plus deterministic evidence, not another O(N) array.
for (const problem of edgeChecks.problemExamples) appendProblemExample(problem);
const {
  adjacencies,
  worstSeam,
  worstSeamAt,
  mixedDensityAdjacencies,
  crackByLevel,
  maskAdjacencies,
  maskByteDisagreements,
  maskSeamExamples,
  seamProblemCount,
  edgeGroupOverflowCount,
  problemCount: edgeFactProblemCount,
} = edgeChecks;
// Reported, not gated; see above.
const maskEdgeBytesCompared = maskAdjacencies * 256;

// Payload quantiles used to retain one number per record and sort it in RAM.
// The fact key is byte length followed by original ordinal, so this one
// bounded merge has the same order statistic (including equal lengths).
const sizeFactRuns = sizeFactWriter.finish();
const payloadQuantileIndexes = {
  p50: recordCount ? Math.floor((recordCount - 1) * 0.5) : -1,
  p99: recordCount ? Math.floor((recordCount - 1) * 0.99) : -1,
  max: recordCount - 1,
};
const payloadQuantiles = { p50: 0, p99: 0, max: 0 };
let sizeOrdinal = 0;
try {
  await mergeSortedJsonRuns(sizeFactRuns, {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 256,
    scratchDir: sizeFactScratchDir,
    onRow: async (fact) => {
      if (sizeOrdinal === payloadQuantileIndexes.p50) payloadQuantiles.p50 = fact.bytes;
      if (sizeOrdinal === payloadQuantileIndexes.p99) payloadQuantiles.p99 = fact.bytes;
      if (sizeOrdinal === payloadQuantileIndexes.max) payloadQuantiles.max = fact.bytes;
      sizeOrdinal += 1;
    },
  });
} finally {
  fs.rmSync(sizeFactRunDir, { recursive: true, force: true });
  fs.rmSync(sizeFactScratchDir, { recursive: true, force: true });
}
assert.equal(sizeOrdinal, recordCount, "payload fact count must match tile records");
const pct = (p) => {
  if (p === 0.5) return payloadQuantiles.p50;
  if (p === 0.99) return payloadQuantiles.p99;
  if (p === 1) return payloadQuantiles.max;
  throw new Error(`unsupported payload percentile ${p}`);
};

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
const addressFactRuns = addressFactWriter.finish();
const closureFactRunDir = path.join(outDir, ".verify-closure-facts");
const closureFactScratchDir = path.join(outDir, ".verify-closure-merge");
const closureFactWriter = createSortedJsonRunWriter(closureFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 256,
});
const membershipFactRunDir = path.join(outDir, ".verify-membership-facts");
const membershipFactScratchDir = path.join(outDir, ".verify-membership-merge");
const membershipFactWriter = createSortedJsonRunWriter(membershipFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 512,
});
const tilesPerLevel = new Map();
let distinctAddresses = 0;
let oceanSkipsDeclared = 0;
let oceanSkipsBelowFloorCount = 0;
const oceanSkipsBelowFloorExamples = [];
let extentWest = Infinity;
let extentSouth = Infinity;
let extentEast = -Infinity;
let extentNorth = -Infinity;
const foldTilesetExtent = (level, x, y) => {
  const cols = 2 ** (level + 1);
  const rows = 2 ** level;
  extentWest = Math.min(extentWest, -180 + (x * 360) / cols);
  extentEast = Math.max(extentEast, -180 + ((x + 1) * 360) / cols);
  extentSouth = Math.min(extentSouth, -90 + (y * 180) / rows);
  extentNorth = Math.max(extentNorth, -90 + ((y + 1) * 180) / rows);
};

// The address catalogue replaces every former per-address map, set and array.
// A group contains one logical address and keeps only its counters plus the
// last record ordinal, so even a pathological duplicate storm cannot become
// an in-memory index.
let groupedAddress = null;
const finishAddressGroup = () => {
  if (!groupedAddress) return;
  const group = groupedAddress;
  if (group.storedCount) {
    distinctAddresses += 1;
    tilesPerLevel.set(group.level, (tilesPerLevel.get(group.level) ?? 0) + group.storedCount);
    for (let duplicate = 1; duplicate < group.storedCount; duplicate += 1) {
      recordProblem(`duplicate address ${group.address}`);
    }
  }
  if (group.ocean) {
    oceanSkipsDeclared += 1;
    if (group.level < minLevel) {
      oceanSkipsBelowFloorCount += 1;
      if (oceanSkipsBelowFloorExamples.length < 4) oceanSkipsBelowFloorExamples.push(group.address);
    }
  }
  if (group.storedCount && group.ocean) {
    recordProblem(
      `${group.address} is both stored and reported as an ocean skip — the encoder cannot have ` +
        "done both, and a client would be served bytes the index says are synthesized",
    );
  }
  if (group.storedCount || group.ocean) {
    if (group.level >= minLevel) foldTilesetExtent(group.level, group.x, group.y);
    membershipFactWriter.push({
      key: group.key,
      kind: "membership",
      level: group.level,
      x: group.x,
      y: group.y,
      address: group.address,
      stored: group.storedCount > 0,
      ocean: group.ocean,
      childAvailability: group.lastChildAvailability,
    });
    // A declared address makes every ancestor available.  Those facts are
    // deduplicated by the next bounded merge before rectangles are emitted.
    for (let ancestorLevel = group.level; ancestorLevel >= 0; ancestorLevel -= 1) {
      const shift = group.level - ancestorLevel;
      closureFactWriter.push({
        key: addressFactKey(ancestorLevel, group.x >> shift, group.y >> shift),
        level: ancestorLevel,
        x: group.x >> shift,
        y: group.y >> shift,
      });
    }
  }
  groupedAddress = null;
};
try {
  await mergeSortedJsonRuns(addressFactRuns, {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 4096,
    scratchDir: addressFactScratchDir,
    onRow: async (fact) => {
      assert.equal(typeof fact.key, "string", "address fact must have a key");
      if (!groupedAddress || groupedAddress.key !== fact.key) {
        finishAddressGroup();
        groupedAddress = {
          key: fact.key,
          level: fact.level,
          x: fact.x,
          y: fact.y,
          address: fact.address,
          storedCount: 0,
          ocean: false,
          lastOrdinal: -1,
          lastChildAvailability: 0,
        };
      }
      assert.equal(fact.level, groupedAddress.level, `address fact level mismatch at ${fact.key}`);
      assert.equal(fact.x, groupedAddress.x, `address fact x mismatch at ${fact.key}`);
      assert.equal(fact.y, groupedAddress.y, `address fact y mismatch at ${fact.key}`);
      if (fact.kind === "stored") {
        groupedAddress.storedCount += 1;
        if (fact.ordinal >= groupedAddress.lastOrdinal) {
          groupedAddress.lastOrdinal = fact.ordinal;
          groupedAddress.lastChildAvailability = fact.childAvailability;
        }
      } else {
        assert.equal(fact.kind, "ocean", `unknown address fact kind at ${fact.key}`);
        groupedAddress.ocean = true;
      }
    },
  });
  finishAddressGroup();
} finally {
  fs.rmSync(addressFactRunDir, { recursive: true, force: true });
  fs.rmSync(addressFactScratchDir, { recursive: true, force: true });
}

const membershipFactRuns = membershipFactWriter.finish();
const closureFactRuns = closureFactWriter.finish();
const available = Array.from({ length: maxLevel + 1 }, () => []);
available[0] = [{ startX: 0, startY: 0, endX: 1, endY: 0 }];
let rectangleLevel = null;
let rectangleY = null;
let rectangleStartX = null;
let rectangleEndX = null;
const flushAvailabilityRectangle = () => {
  if (rectangleLevel === null || rectangleLevel === 0) return;
  available[rectangleLevel].push({
    startX: rectangleStartX,
    startY: rectangleY,
    endX: rectangleEndX,
    endY: rectangleY,
  });
};
try {
  await mergeSortedJsonRuns(closureFactRuns, {
    maxOpenRuns: 32,
    maxRowBytes: 256,
    scratchDir: closureFactScratchDir,
    onRow: async (fact) => {
      // The legacy verifier's maxLevel is based only on stored records, so an
      // out-of-range skip is reported but cannot widen the published index.
      if (fact.level > maxLevel || fact.level === 0) return;
      if (rectangleLevel === fact.level && rectangleY === fact.y && fact.x === rectangleEndX + 1) {
        rectangleEndX = fact.x;
        return;
      }
      flushAvailabilityRectangle();
      rectangleLevel = fact.level;
      rectangleY = fact.y;
      rectangleStartX = fact.x;
      rectangleEndX = fact.x;
    },
  });
  flushAvailabilityRectangle();
} finally {
  fs.rmSync(closureFactRunDir, { recursive: true, force: true });
  fs.rmSync(closureFactScratchDir, { recursive: true, force: true });
}

// ── THE INDEX IS ANCESTOR-CLOSED, AND THAT IS ASSERTED, NOT ASSUMED ────────
//
// Everything downstream of here — the module's availability test, this file's
// enumeration, and the equivalence between the two — rests on the index being
// ancestor-closed: if a rectangle covers (level, x, y) then some rectangle at
// level-1 covers (x>>1, y>>1), all the way to level 0. The closure is BUILT
// above, so this cannot fail on an index this file produced; it is asserted
// anyway because the config is a FILE, an operator can edit it, and the
// serving module reads `terrain_available` from config rather than from
// anything that re-derives it. This is the one place the property is stated
// where a hand-edited index would be checked against it.
const closureBreaks = [];
for (let level = available.length - 1; level >= 1; level -= 1) {
  const parents = available[level - 1];
  for (const r of available[level]) {
    for (const [x, y] of [
      [r.startX, r.startY],
      [r.endX, r.endY],
    ]) {
      const px = x >> 1;
      const py = y >> 1;
      if (!parents.some((q) => px >= q.startX && px <= q.endX && py >= q.startY && py <= q.endY)) {
        if (closureBreaks.length < 16) closureBreaks.push(`z${level} ${x}/${y} has no parent at z${level - 1}`);
      }
    }
  }
}
if (closureBreaks.length) {
  recordProblem(
    `the availability index is NOT ancestor-closed (${closureBreaks.length} breaks): ` +
      `${closureBreaks.slice(0, 4).join("; ")} — a client computes availability by the max ` +
      "level at a position, so an unclosed index promises tiles at levels nothing covers",
  );
}

// ── A SKIPPED ADDRESS MUST LAND WHERE THE MODULE CALLS IT WATER ────────────
//
// Declaring an ocean skip only helps if the serving module synthesizes WATER
// there, and it does that at and above `terrain_ocean_synth_min_level` — the
// shallowest level this run BUILT — and flat LAND below it. A skip reported
// below that floor would be declared and then answered as land, which is the
// defect this whole path exists to close, so it is a gate rather than a note.
if (oceanSkipsBelowFloorCount) {
  recordProblem(
    `${oceanSkipsBelowFloorCount} ocean skips sit below the authoritative floor z${minLevel} ` +
      `(${oceanSkipsBelowFloorExamples.join(", ")}) — the serving module synthesizes flat ` +
      "LAND there, so declaring them would publish ocean as land",
  );
}

// ── THE TILESET'S OWN EXTENT ───────────────────────────────────────────────
//
// The union of the extents of every address this pyramid actually built —
// stored or measured-and-skipped — and NOT the ancestor closure's, which
// overhangs the built region by whole tiles at the shallow levels. It is
// stated by the $DTT catalogue record, which is not a tile and therefore has
// no address to derive an extent from: the record used to claim the whole
// globe under an address that covers half of it, and now it states this
// instead, or states nothing when nobody computed it.
const tilesetExtent = Number.isFinite(extentWest)
  ? { west: extentWest, south: extentSouth, east: extentEast, north: extentNorth }
  : null;

// ── WHAT THE CLIENT WILL ACTUALLY ASK FOR ──────────────────────────────────
//
// The MODULE's rule, re-implemented here — and the difference from Cesium's is
// worth naming rather than glossed. Cesium's TileAvailability uses
// rectangleContainsPosition, which is INCLUSIVE on all four edges, and
// findMaxLevelFromNode recurses into every quadrant a boundary position falls
// on and takes the max; the floor below is half-open (east/north wins). The two
// can only differ for a position exactly on a tile boundary — which is where a
// coarse tile's CENTRE always lands at deeper levels — and for an
// ancestor-closed index they provably cannot differ at all, because the deeper
// quadrant Cesium would also visit has an ancestor covering the same position
// at every level in between. The closure is asserted immediately above, so the
// re-implementation is exact for every index this file will ever see.
//
// Every address the rule makes available is then enumerated: an address that is
// available but NOT stored is one the serving module must synthesize. Before
// the module's availability test was changed to this rule, those addresses were
// 404s — 14 of them on the regional pyramid, 2 at z6 and 12 at z7 — reaching
// the browser against the zero-4xx bound.
// The global all-water set can be millions of addresses.  Keep the complete
// publication worklist on disk; reports retain counts and a bounded sample.
const availableButUnstoredPath = path.join(outDir, "available-but-unstored.ndjson");
const candidateFactRunDir = path.join(outDir, ".verify-available-candidates");
const candidateFactScratchDir = path.join(outDir, ".verify-available-candidate-merge");
const candidateFactWriter = createSortedJsonRunWriter(candidateFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 256,
});
const availableChildFactRunDir = path.join(outDir, ".verify-available-children");
const availableChildFactWriter = createSortedJsonRunWriter(availableChildFactRunDir, {
  maxRows: 4096,
  maxRowBytes: 256,
});
// The closure check above proves a directly declared address is exactly what
// the serving module sees at its centre.  Enumerating each rectangle therefore
// avoids the former bounding-box scan and repeated all-level rectangle search.
for (let level = 0; level <= maxLevel; level += 1) {
  for (const rect of available[level]) {
    for (let y = rect.startY; y <= rect.endY; y += 1) {
      for (let x = rect.startX; x <= rect.endX; x += 1) {
        candidateFactWriter.push({
          key: addressFactKey(level, x, y),
          kind: "candidate",
          level,
          x,
          y,
          address: terrainAddress(level, x, y),
        });
        if (level > 0) {
          const bit = (x & 1 ? 2 : 1) | (y & 1 ? 4 : 0);
          availableChildFactWriter.push({
            key: addressFactKey(level - 1, x >> 1, y >> 1),
            kind: "available-child",
            childBit: bit,
          });
        }
      }
    }
  }
}
const candidateFactRuns = candidateFactWriter.finish();
const availableChildFactRuns = availableChildFactWriter.finish();
const availableButUnstoredSample = [];
let ancestorPlaceholders = 0;
const unstoredByLevel = {};
let availableButUnstored = 0;
let joinedCandidate = null;
const availableButUnstoredHandle = fs.openSync(availableButUnstoredPath, "w");
const finishCandidateGroup = () => {
  if (!joinedCandidate) return;
  const group = joinedCandidate;
  if (group.candidate && !group.stored) {
    fs.writeSync(availableButUnstoredHandle, `${group.address}\n`);
    availableButUnstored += 1;
    unstoredByLevel[group.level] = (unstoredByLevel[group.level] ?? 0) + 1;
    if (!group.ocean) ancestorPlaceholders += 1;
    if (availableButUnstoredSample.length < 32) availableButUnstoredSample.push(group.address);
  }
  joinedCandidate = null;
};
try {
  await mergeSortedJsonRuns([...candidateFactRuns, ...membershipFactRuns], {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 512,
    scratchDir: candidateFactScratchDir,
    onRow: async (fact) => {
      if (!joinedCandidate || joinedCandidate.key !== fact.key) {
        finishCandidateGroup();
        joinedCandidate = {
          key: fact.key,
          level: fact.level,
          address: fact.address,
          candidate: false,
          stored: false,
          ocean: false,
        };
      }
      if (fact.kind === "candidate") joinedCandidate.candidate = true;
      else {
        assert.equal(fact.kind, "membership", `unknown membership join fact at ${fact.key}`);
        joinedCandidate.stored ||= fact.stored;
        joinedCandidate.ocean ||= fact.ocean;
      }
    },
  });
  finishCandidateGroup();
} finally {
  fs.closeSync(availableButUnstoredHandle);
  fs.rmSync(candidateFactRunDir, { recursive: true, force: true });
  fs.rmSync(candidateFactScratchDir, { recursive: true, force: true });
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
let childAvailabilityGroup = null;
const finishChildAvailabilityGroup = () => {
  if (!childAvailabilityGroup?.stored) return;
  const group = childAvailabilityGroup;
  const claimed = group.childAvailability & 0x0f;
  if (claimed === 0) return;
  childBitsClaimed += 1;
  // Every bit the record SETS must be a child the tileset really serves.
  if ((claimed & ~group.actual) !== 0) {
    childBitsWrong += 1;
    if (childBitExamples.length < 8) {
      childBitExamples.push(`${group.address} claims children ${claimed}, availability serves ${group.actual}`);
    }
  }
};
try {
  await mergeSortedJsonRuns([...membershipFactRuns, ...availableChildFactRuns], {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 512,
    scratchDir: membershipFactScratchDir,
    onRow: async (fact) => {
      if (!childAvailabilityGroup || childAvailabilityGroup.key !== fact.key) {
        finishChildAvailabilityGroup();
        childAvailabilityGroup = {
          key: fact.key,
          stored: false,
          address: null,
          childAvailability: 0,
          actual: 0,
        };
      }
      if (fact.kind === "available-child") childAvailabilityGroup.actual |= fact.childBit;
      else {
        assert.equal(fact.kind, "membership", `unknown child-availability fact at ${fact.key}`);
        childAvailabilityGroup.stored ||= fact.stored;
        if (fact.stored) {
          childAvailabilityGroup.address = fact.address;
          childAvailabilityGroup.childAvailability = fact.childAvailability;
        }
      }
    },
  });
  finishChildAvailabilityGroup();
} finally {
  fs.rmSync(membershipFactRunDir, { recursive: true, force: true });
  fs.rmSync(membershipFactScratchDir, { recursive: true, force: true });
  fs.rmSync(availableChildFactRunDir, { recursive: true, force: true });
}
if (childBitsWrong) {
  recordProblem(
    `${childBitsWrong} records CLAIM a CHILD_AVAILABILITY bit for a child the published ` +
      `availability does not serve (e.g. ${childBitExamples[0]})`,
  );
}

// ── THE VERTICAL-ERROR TARGET, against the tiles' OWN measurement ──────────
//
// Each record states the departure its encoder measured between posts against
// the source it was cut from, so this needs no reference decoder and no second
// sampling of the granules: it reads what the pyramid says about itself and
// compares it with the ruled target.
//
// WHAT IS STATED HERE IS THE ENCODER'S OWN NUMBER, and that has a limit worth
// naming: the accuracy probe compares the mesh against the same sampler that
// produced its vertices, so it can see triangulation density and CANNOT see a
// decode, georeference or clamp error. The independent checks for those live
// elsewhere in this file (edge continuity across adjacent tiles, whole-post-row
// detection, coverage) and in the module's own granule-seam and band-boundary
// tests. The gate below is honest about what it measures.
//
// A tile that does not meet the target is NOT a failure on its own: the ruling
// is that the 32 KiB cap is hard and a tile the cap cannot satisfy ships AT it
// stating what it achieved. What IS gated is the SHARE of such tiles per level
// at z >= 10, which is where the ruling puts it.
const accuracy = [];
for (const level of [...accuracyByLevel.keys()].sort((a, b) => a - b)) {
  const worst = accuracyByLevel.get(level);
  const target = errorTargetM(level);
  const total = atCeilingByLevel.get(level)?.total ?? 0;
  const over = atCeilingByLevel.get(level)?.over ?? 0;
  const share = total ? over / total : 0;
  const gated = level >= CEILING_SHARE.gatedFromLevel;
  accuracy.push({
    level,
    // The ruled target (coordinator (a)) and the RETIRED pair, side by side.
    errorTargetM: +target.toFixed(2),
    legacyBoundM: +legacyBoundM(level).toFixed(2),
    worstMeasuredM: +worst.toFixed(3),
    withinTarget: worst <= target,
    withinLegacyBound: worst <= legacyBoundM(level),
    // Tiles that ship AT the cap: as accurate as the encoder was allowed to
    // be, and not as accurate as the target asks. Derived HERE from each
    // record's own stated accuracy against the target, not read from the
    // encoder's flag, so the encoder cannot mark its own homework.
    tiles: total,
    // The gated quantity, under the name that says what it is: tiles whose own
    // stated SOURCE-POST accuracy exceeds the level's target. `tilesAtCeiling`
    // is the same number under its older name and is kept so a reader
    // comparing this report with an earlier one is not comparing two things.
    tilesOverTarget: over,
    overTargetShare: +share.toFixed(4),
    tilesAtCeiling: over,
    atCeilingShare: +share.toFixed(4),
    ceilingShareGated: gated,
    withinCeilingShare: !gated || share <= CEILING_SHARE.max,
  });
}

// ── THE CRACK AGAINST THE SKIRT ────────────────────────────────────────────
const densityStepCrack = [...crackByLevel.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([level, v]) => ({
    level,
    worstCrackM: +v.m.toFixed(3),
    skirtHeightM: +skirtHeightM(level).toFixed(3),
    hiddenBySkirt: v.m <= skirtHeightM(level),
    worstAt: v.at,
  }));
const crackOverSkirt = densityStepCrack.filter((c) => !c.hiddenBySkirt);

const availableBytes = Buffer.byteLength(JSON.stringify(available));
const verifierProblemCount = problemCount + edgeFactProblemCount;

const summary = {
  outDir,
  tiles: recordCount,
  distinctAddresses,
  storeBytes: fs.statSync(path.join(outDir, "tiles.dttstream")).size,
  levels: [...tilesPerLevel.keys()].sort((a, b) => a - b),
  tilesPerLevel: Object.fromEntries([...tilesPerLevel.entries()].sort((a, b) => a[0] - b[0])),
  payloadBytes: { p50: pct(0.5), p99: pct(0.99), max: pct(1), bounds: BOUNDS },
  uniformMasks: uniform,
  rasterMasks: raster,
  uniformMaskRatio: recordCount ? +(uniform / recordCount).toFixed(4) : 0,
  maskBytesStored: maskBytes,
  oceanTilesStored: oceanStored,
  uniformWaterTilesNotFlat: uniformWaterNotFlat,
  uniformWaterTilesNotFlatSample: uniformWaterNotFlatSample,
  // Tiles flat at exactly sea level over their whole extent whose mask still
  // claims land somewhere. The old ocean test could not see these because it
  // required a UNIFORM_WATER mask, and the four the encoder shipped were
  // RASTER precisely BECAUSE of the fabricated land in them.
  // Tiles whose SHIPPED mesh is flat at exactly 0 m while their mask claims
  // land somewhere. UNCONDITIONAL: the previous cut skipped every tile stating
  // a non-zero VERTICAL_ACCURACY_M, and that number came from a probe whose
  // samples were collinear on the split diagonal, so the exclusion was resting
  // on a measurement that could not see the thing it was excluding for.
  flatAtZeroWithLandMask: flatWithLandMask,
  // Of those, the ones the encoder itself says it flattened — the mesh renders
  // real measured ground as sea level. Gated above when the departure also
  // breaks the level's error target.
  flatAtZeroOverMeasuredRelief: flatOverMeasuredRelief,
  flatAtZeroWithLandMaskExamples: flatWithLandMaskExamples.slice(0, 16),
  digestMismatches: digestMismatch,
  tilesOverCeiling: overCeiling,
  tilesWithPartialCoverage: partialCoverage,
  partialCoverageDetail: partialCoverageDetail.slice(0, 32),
  tilesMissingWholePostRows: wholeRowsMissing,
  // Every address the CLIENT computes as available (max level at the tile
  // centre) that the store does not hold. Each is served by synthesis, never a
  // 404 — that is the contract; the count is here so nobody has to assume it.
  availableButUnstored,
  availableButUnstoredByLevel: unstoredByLevel,
  // THE ADDRESSES, not just the count. Under IPFS delivery these are the tiles
  // the publisher has to MATERIALIZE into the directory: a static gateway has
  // no respond() to synthesize a miss with, so an address layer.json promises
  // and the directory does not hold is a 404 in the browser — the exact bound
  // Atlas set at zero. The count told a reviewer the promise was kept; the
  // list is what keeps it.
  availableButUnstoredPath: path.basename(availableButUnstoredPath),
  availableButUnstoredSample,
  // How many of those are addresses the ENCODER measured as all water and
  // skipped, as against the ancestor placeholders the closure adds. The two
  // are answered differently by the serving module — water and flat land —
  // and conflating them is what published an ocean as a continent.
  oceanSkipsDeclared,
  oceanSkipsBelowAuthoritativeFloor: oceanSkipsBelowFloorCount,
  ancestorPlaceholders,
  tilesetExtent,
  childAvailabilityClaims: childBitsClaimed,
  childAvailabilityUnservedClaims: childBitsWrong,
  childAvailabilityExamples: childBitExamples,
  // WHAT THE ACCURACY NUMBERS IN THIS REPORT ARE MEASURED AGAINST. Stated
  // rather than assumed, because this lane has now shipped two different
  // answers to that question and both of them read the same field name.
  accuracyBasis: {
    measuredAt: "source-posts",
    definition:
      "every source post the granule set carries inside the tile bounds, with the mesh " +
      "interpolated at the post; no-data posts excluded, no resampling on the truth side",
    // From the run report: how many source posts a tile edge carries at the
    // deepest level built, and the lattice the ladder was allowed to climb to.
    sourcePostsPerTileEdge: runReport?.sourcePostsPerTileEdgeByLevel ?? null,
    latticeMaxGridSize: runReport?.latticeMaxGridSize ?? null,
  },
  verticalAccuracy: accuracy,
  tilesStatingMeasuredAccuracy: accuracyMeasured,
  // Tiles as accurate as the cap allowed and no more — reported ALWAYS, so the
  // ruling's "never silently" is a number a reviewer can read rather than an
  // absence they have to notice.
  tilesAtCeiling: accuracy.reduce((n, a) => n + a.tilesAtCeiling, 0),
  atCeilingExamples,
  ceilingShareBound: CEILING_SHARE,
  edgeAdjacenciesChecked: adjacencies,
  // A global bad cut can fail at every shared post.  Keep the total visible,
  // while `problems` carries only the deterministic bounded examples emitted by
  // the streamed edge consumer.
  problemCount: verifierProblemCount,
  edgeContinuityProblemCount: edgeFactProblemCount,
  edgeSeamProblemCount: seamProblemCount,
  edgeFactGroupOverflowCount: edgeGroupOverflowCount,
  edgeContinuityProblemExamples: edgeChecks.problemExamples,
  maskAdjacenciesChecked: maskAdjacencies,
  // NOT a defect count. Under area registration two neighbouring edge texels
  // cover different ground, so a difference is a coastline crossing the seam.
  // Kept as a statistic because a sudden change in it is worth looking at, and
  // because the number was previously published as a defect count and the
  // change should be visible rather than silent.
  maskEdgeTexelsCompared: maskEdgeBytesCompared,
  maskEdgeTexelDifferences: maskByteDisagreements,
  maskEdgeTexelExamples: maskSeamExamples,
  worstSharedEdgeDeltaM: +worstSeam.toFixed(6),
  worstSharedEdgeAt: worstSeamAt,
  // Adjacencies where the two tiles settled on different densities, and the
  // worst gap that leaves BETWEEN their shared posts — now COMPARED TO THE
  // SKIRT the client draws over it, which is the only thing that decides
  // whether the gap is visible. A crack under the skirt is the ruling's cost;
  // a crack over it is open sky between two same-level neighbours.
  mixedDensityAdjacencies,
  worstDensityStepCrackM: Object.fromEntries(
    [...crackByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([l, v]) => [l, +v.m.toFixed(3)]),
  ),
  densityStepCrackVsSkirt: densityStepCrack,
  // What the deployment must set for the mount serving THIS index, and whether
  // the host's 1024-page default is enough. See tools/terrain-pyramid/
  // memory-pages.mjs for the measured curve this comes from.
  servingMemory: memoryPagesAdvice(availableBytes),
  layerJson: { maxzoom: maxLevel, extensions: ["watermask"], available },
  // null, not 0, when no run report was left beside the store: "nobody counted"
  // and "the count was zero" are different claims.
  encoderCounters,
  problems,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(JSON.stringify({ ...summary, layerJson: { ...summary.layerJson, available: `<${available.length} levels>` } }, null, 2));
}

fs.writeFileSync(path.join(outDir, "verify-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
// ── THE DEPLOY CONFIG IS COMPLETE, OR THE SHIP STEP TURNS 401 INTO 503 ─────
//
// This file used to carry eight keys — maxzoom, the ocean floor, the mount
// path, availability and the four extent degrees — and mount-entry.json names
// it as THE source of "the module config keys ... INSIDE `config:`". Meanwhile
// the module started REFUSING to publish a catalogue without the four
// DTTProvenance fields the IDL marks required. An operator who did exactly
// what the ship step said therefore installed a mount that answered
// /api/v1/terrain/tileset.json with 503 "terrain catalogue not configured" —
// measured, not inferred — so discovery failed for both clients and no client
// ever got a CID. The 503 is correct behaviour for an unbuildable record; the
// defect was that the committed config could not build one.
//
// The lineage is READ OFF A TILE, never invented here: the tileset record has
// to redistribute under the same terms its own contents carry, and a config
// file may have moved since the run that produced the store. Same rule
// ipfs-publish.mjs already follows.
//
// The two keys NOT written here are terrain_tileset_cid and
// terrain_tileset_size_bytes: they name the published directory, which does
// not exist until ipfs-publish.mjs has added it. Everything else the mount
// needs to answer a $DTT catalogue is here, so the publish step adds exactly
// those two and nothing has to be invented at deploy time.
assert.ok(firstRecord, "the pyramid has no $DTT records");
const datum = readDtt(firstRecord);
const lineage = readDttProvenance(firstRecord).raw;
const deployLineage = {
  terrain_tileset_id: datum.tilesetId,
  terrain_dataset_id: lineage.DATASET_ID,
  terrain_dataset_name: lineage.DATASET_NAME,
  terrain_dataset_epoch: lineage.DATASET_EPOCH,
  terrain_dataset_retrieved_at: lineage.RETRIEVED_AT,
  terrain_license: lineage.LICENSE,
  terrain_license_url: lineage.LICENSE_URL,
  terrain_attribution: lineage.ATTRIBUTION,
  // The datum the tiles state, carried onto the tileset record and into
  // layer.json. Dropping it left both documents a delivery-path client reads
  // at VERTICAL_DATUM UNSPECIFIED while every tile said GEOID/EGM2008.
  terrain_vertical_datum_name: datum.verticalDatumName,
};
// A required key the store cannot answer is a REFUSAL, not a default: a mount
// configured with an empty string satisfies FlatBuffers and tells a consumer
// nothing, which is the exact failure the module's own 503 exists to prevent.
for (const key of [
  "terrain_dataset_id",
  "terrain_dataset_epoch",
  "terrain_dataset_retrieved_at",
  "terrain_license",
]) {
  assert.ok(
    typeof deployLineage[key] === "string" && deployLineage[key].length > 0,
    `${key} is required by the serving module's $DTT catalogue and the store's own records do not state it`,
  );
}

fs.writeFileSync(
  path.join(outDir, "layer-json-config.json"),
  `${JSON.stringify(
    {
      ...deployLineage,
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
      // The tileset's own bounding extent, for the $DTT catalogue record. The
      // record is the DIRECTORY, not a tile: it has no address in any tiling
      // scheme, so its extent cannot be derived and has to be carried.
      ...(tilesetExtent
        ? {
            terrain_west_deg: tilesetExtent.west,
            terrain_south_deg: tilesetExtent.south,
            terrain_east_deg: tilesetExtent.east,
            terrain_north_deg: tilesetExtent.north,
          }
        : {}),
    },
    null,
    2,
  )}\n`,
);

// ── memory_pages BELONGS ONE LEVEL UP, ON THE MOUNT ENTRY ───────────────────
//
// It was written into layer-json-config.json beside terrain_maxzoom /
// terrain_ocean_synth_min_level / terrain_mount_path / terrain_available. Those
// four ARE module config keys, delivered to the guest through plugin.getConfig.
// `memory_pages` is not: it is config.FlowMount.MemoryPages
// (sdn-server/internal/config/config.go, `yaml:"memory_pages,omitempty"`), a
// SIBLING of the mount's `config:` block, and its only reader is
// internal/flowrt/httpmount.go — `if mount.MemoryPages > 0 { deps.MaxMemoryPages
// = mount.MemoryPages }`. Nothing anywhere reads it from inside a config map.
//
// An operator who pastes layer-json-config.json into the mount's `config:` —
// which is exactly what the other four keys require — would have landed the key
// where nothing reads it, left MaxMemoryPages at the 1024-page default, and run
// the pool hundreds of pages under its measured need with no error anywhere. So
// the two levels are now two FILES and cannot be conflated by a copy.
// Coordinator resolution 2026-08-27 (4).
fs.writeFileSync(
  path.join(outDir, "mount-entry.json"),
  `${JSON.stringify(
    {
      "//": "flows.mounts[] entry keys for config.module-delivery-sidecar.yaml. `memory_pages` is a SIBLING of `config:`, never a member of it; the module config keys live in layer-json-config.json and go INSIDE `config:`.",
      path: "/api/v1/terrain/",
      flow: "com.digitalarsenal.flows.terrain-serving",
      memory_pages: memoryPagesFor(availableBytes),
      "// pool": memoryPagesAdvice(availableBytes),
    },
    null,
    2,
  )}\n`,
);

const overCeilingShare = accuracy.filter((a) => !a.withinCeilingShare);
const failures = [
  verifierProblemCount ? `${verifierProblemCount} problems` : null,
  wholeRowsMissing ? `${wholeRowsMissing} tiles missing a whole post row` : null,
  digestMismatch ? `${digestMismatch} digest mismatches` : null,
  overCeiling ? `${overCeiling} tiles over the ${BOUNDS.hard}-byte ceiling` : null,
  pct(0.5) > BOUNDS.p50 ? `p50 ${pct(0.5)} B over ${BOUNDS.p50}` : null,
  pct(0.99) > BOUNDS.p99 ? `p99 ${pct(0.99)} B over ${BOUNDS.p99}` : null,
  accuracyMeasured === 0
    ? "no tile states a measured vertical accuracy, so the pyramid cannot be judged against the target"
    : null,
  // The ruled gate: a tile at the cap is allowed, a LEVEL that is mostly at
  // the cap is not. z <= 9 is unbounded by the same ruling.
  overCeilingShare.length
    ? `over ${(CEILING_SHARE.max * 100).toFixed(0)}% of tiles at the cap at ${overCeilingShare
        .map((a) => `z${a.level} ${(a.atCeilingShare * 100).toFixed(1)}% (${a.tilesAtCeiling}/${a.tiles})`)
        .join(", ")}`
    : null,
  // THE ENCODER'S OWN CLAMP COUNTER, which nothing used to read. A clamped
  // post is a displaced sample — the residual of the cross-granule stencil and
  // the signal that a neighbour granule is missing from the plan — and it is
  // invisible to every other gate here: the record's own accuracy probe uses
  // the same clamped sampler, and a clamped grid-INTERIOR row is not a tile
  // edge so the seam check cannot see it either. Zero is the only right
  // answer, and it is only readable from the run report.
  // FABRICATED LAND. Samples the DEM covers but no water granule classifies
  // fall back to LAND, and that is the defect this lane already shipped once —
  // 40,527 invented LAND samples in the open Ligurian Sea. (Samples NO granule
  // covers are a different case: Copernicus publishes no object over open
  // ocean, so absence is the dataset saying sea, and those are counted
  // separately and never gated.)
  encoderCounters && encoderCounters.maskUnclassifiedSamples > 0
    ? `${encoderCounters.maskUnclassifiedSamples} water-mask samples sit on ground the DEM covers ` +
      "but no water granule classifies, so they were filled in as LAND — the plan fetched " +
      "elevation for ground it did not fetch a water mask for"
    : null,
  // THE CRACK MUST FIT UNDER THE SKIRT. Reporting it was right; concluding
  // "skirts exist for this" without ever computing the skirt was not.
  crackOverSkirt.length
    ? `the density-step crack exceeds the skirt the client draws over it at ` +
      crackOverSkirt
          .map((c) => `z${c.level} ${c.worstCrackM} m vs ${c.skirtHeightM} m (${c.worstAt})`)
          .join(", ")
    : null,
  encoderCounters && encoderCounters.edgeClampedPosts > 0
    ? `${encoderCounters.edgeClampedPosts} clamped posts reported by the encoder ` +
      `(a clamp is a displaced sample; the plan is missing a neighbour granule)`
    : null,
].filter(Boolean);
if (failures.length) {
  console.error(`\nNOT PUBLISHABLE: ${failures.join("; ")}`);
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nPUBLISHABLE: every bound met.");
