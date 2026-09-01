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
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

import {
  canonicalJson,
  createSortedJsonRunWriter,
  evaluateTerrainEdgeFacts,
  iterateJsonStringArrayProperty,
  mergeSortedJsonRunSources,
  mergeSortedJsonRuns,
  sha256,
} from "./build-support.mjs";
import { iterateStreamFd, readDtt, readDttProvenance } from "./dtt-reader.mjs";

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
const PUBLICATION_LIMITS = {
  maxVerifiedStoreBytes: 12 * 1024 ** 3,
  maxStaticDirectoryBytes: 128 * 1024 ** 3,
};
// The published terrain scheme is geographic and its current approved global
// cut stops at z10.  Permit a little headroom for the regional proof while
// retaining arithmetic that is exact in JavaScript and cannot make an input
// header allocate an array indexed by an arbitrary u32.
const MAX_TERRAIN_LEVEL = 30;
const MAX_MESH_GRID = 512;
const MAX_MESH_BYTES = 4 * 1024 * 1024;
const MAX_COMPRESSED_PAYLOAD_BYTES = 1024 * 1024;
const MAX_MASK_BYTES = 256 * 256;
const MAX_RUN_REPORT_BYTES = 1024 * 1024;

// Every non-padding DTT frame costs a u32 prefix plus at least one record
// byte.  Every compact ocean address costs at least `0/0/0` (five bytes).
// These deliberately pessimistic lower bounds make the maximum number of
// external-sort runs finite without excluding any workload allowed by the
// absolute publication ceilings.  The actual global z10 cut is orders of
// magnitude smaller; these caps protect the stream/manifest arithmetic should
// a future approved policy approach its byte ceiling.
const MIN_NON_PADDING_DTT_FRAME_BYTES = 5;
const MIN_OCEAN_ADDRESS_LINE_BYTES = 5;
const ceilDivide = (numerator, denominator) => Math.ceil(numerator / denominator);
const MAX_VERIFIED_RECORDS = Math.floor(PUBLICATION_LIMITS.maxVerifiedStoreBytes / MIN_NON_PADDING_DTT_FRAME_BYTES);
const MAX_OCEAN_ADDRESS_LINES = Math.floor(PUBLICATION_LIMITS.maxStaticDirectoryBytes / MIN_OCEAN_ADDRESS_LINE_BYTES);
const MAX_ADDRESS_FACTS = MAX_VERIFIED_RECORDS + MAX_OCEAN_ADDRESS_LINES;
const MAX_CLOSURE_FACTS = MAX_ADDRESS_FACTS * (MAX_TERRAIN_LEVEL + 1);
const MAX_EDGE_FACT_RUNS = ceilDivide(MAX_VERIFIED_RECORDS * 8, 128); // mesh plus optional raster-mask edges
const MAX_ADDRESS_FACT_RUNS = ceilDivide(MAX_ADDRESS_FACTS, 512);
const MAX_SIZE_FACT_RUNS = ceilDivide(MAX_VERIFIED_RECORDS, 1024);
const MAX_CLOSURE_FACT_RUNS = ceilDivide(MAX_CLOSURE_FACTS, 512);
const MAX_MEMBERSHIP_FACT_RUNS = MAX_ADDRESS_FACT_RUNS;
const MAX_CANDIDATE_FACT_RUNS = ceilDivide(MAX_CLOSURE_FACTS + 2, 512);
const MAX_AVAILABLE_CHILD_FACT_RUNS = ceilDivide(MAX_CLOSURE_FACTS, 512);
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

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Do not turn an output-sized availability index back into a heap allocation
// merely to nest it in one of the three delivery documents.  These writers
// stage beside the final document and rename only a complete JSON value.
//
// The raw value has just been generated by this invocation, but a path is not
// an identity: a concurrent writer could exchange it for a same-size regular
// file (or a symlink) before this document reaches its receipt.  Keep the
// descriptor open while copying and prove the path still names that exact
// generated inode before and after the copy.
function copyStableRegularFileToHandle(file, handle, {
  expectedMutation,
  maxBytes,
  label,
}) {
  const pathBeforeStat = fs.lstatSync(file, { bigint: true });
  assert.ok(pathBeforeStat.isFile(), `${label} is not a regular file`);
  const pathBefore = fileMutationSnapshot(pathBeforeStat);
  assert.ok(sameFileMutation(pathBefore, expectedMutation), `${label} pathname changed before layer config copy`);
  assert.ok(Number.isSafeInteger(pathBefore.bytes) && pathBefore.bytes >= 0 && pathBefore.bytes <= maxBytes,
    `${label} exceeds ${maxBytes} byte publication-policy bound`);

  const input = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fileMutationSnapshot(fs.fstatSync(input, { bigint: true }));
    assert.ok(sameFileMutation(pathBefore, opened), `${label} changed before opening`);
    let at = 0;
    for (;;) {
      const read = fs.readSync(input, buffer, 0, buffer.length, at);
      if (!read) break;
      at += read;
      assert.ok(at <= opened.bytes, `${label} grew while copying`);
      hash.update(buffer.subarray(0, read));
      fs.writeSync(handle, buffer, 0, read);
    }
    assert.equal(at, opened.bytes, `${label} changed size while copying`);
    const closed = fileMutationSnapshot(fs.fstatSync(input, { bigint: true }));
    const pathAfter = fileMutationSnapshot(fs.lstatSync(file, { bigint: true }));
    assert.ok(sameFileMutation(opened, closed), `${label} changed while copying`);
    assert.ok(sameFileMutation(opened, pathAfter), `${label} pathname changed while copying`);
    return { bytes: opened.bytes, sha256: hash.digest("hex"), mutation: opened };
  } finally {
    fs.closeSync(input);
  }
}

// This is deliberately not a command-line feature. It gives the integration
// suite a deterministic interprocess hand-off *after* an output's identity has
// been captured but *before* it is receipted. Without that hand-off a child
// can rename and receipt a small file in the same scheduling quantum in which
// a parent first sees the rename, making a genuine pathname-exchange test
// probabilistic. It is inert outside the explicitly marked test process.
function waitForTestReceiptBarrier() {
  const barrier = process.env.TERRAIN_VERIFY_TEST_RECEIPT_BARRIER;
  if (!barrier) return;
  assert.equal(process.env.NODE_ENV, "test", "receipt barrier is test-only");
  assert.ok(path.isAbsolute(barrier), "receipt barrier path must be absolute");
  const ready = `${barrier}.ready`;
  const release = `${barrier}.release`;
  fs.writeFileSync(ready, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 30_000;
  const waitWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!fs.existsSync(release)) {
    assert.ok(Date.now() < deadline, "test receipt barrier timed out");
    Atomics.wait(waitWord, 0, 0, 10);
  }
}

let verifierStaging = null;

function requireVerifierStaging() {
  assert.ok(verifierStaging, "verifier publication staging was not acquired");
  return verifierStaging;
}

function atomicWriteWithRawTopLevelProperty(file, object, property, rawFile, rawOptions, stageName) {
  const staging = requireVerifierStaging();
  const encoded = JSON.stringify(object, null, 2);
  assert.ok(encoded.endsWith("}"), "top-level JSON object must end with a brace");
  let published = false;
  const stage = staging.open(stageName);
  try {
    fs.writeSync(stage.handle, `${encoded.slice(0, -1)},\n  ${JSON.stringify(property)}: `);
    const raw = copyStableRegularFileToHandle(rawFile, stage.handle, rawOptions);
    fs.writeSync(stage.handle, "\n}\n");
    staging.seal(stage);
    staging.publish(stage, file);
    published = true;
    return raw;
  } finally {
    if (!published) staging.discard(stage);
  }
}

function atomicWriteJson(file, value, stageName) {
  const staging = requireVerifierStaging();
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  const stage = staging.open(stageName);
  let published = false;
  try {
    fs.writeSync(stage.handle, encoded);
    staging.seal(stage);
    staging.publish(stage, file);
    published = true;
  } finally {
    if (!published) staging.discard(stage);
  }
}

// ── the four EDGE post rows of a quantized mesh, in metres ─────────────────
//
// Only the edges are kept: 4,621 tiles x 4,225 vertices x three arrays is half
// a gigabyte, and the property under test is entirely about shared posts.
// Vertices are identified by their QUANTISED u/v, so the encoder's index
// reordering cannot move them.
function gunzipBounded(bytes, maxOutputLength, label) {
  try {
    return zlib.gunzipSync(bytes, { maxOutputLength });
  } catch (error) {
    throw new Error(`${label} is not a bounded valid gzip payload: ${error.message}`);
  }
}

function validateMeshStructure(mesh, label) {
  assert.ok(mesh.length >= 92, `${label} is shorter than a quantized-mesh header`);
  for (const offset of [0, 8, 16, 32, 40, 48, 56, 64, 72, 80]) {
    assert.ok(Number.isFinite(mesh.readDoubleLE(offset)), `${label} has a non-finite header coordinate`);
  }
  const headerMinimum = mesh.readFloatLE(24);
  const headerMaximum = mesh.readFloatLE(28);
  assert.ok(Number.isFinite(headerMinimum) && Number.isFinite(headerMaximum) && headerMinimum <= headerMaximum,
    `${label} has an invalid header height range`);
  assert.ok(mesh.readDoubleLE(56) >= 0, `${label} has a negative bounding-sphere radius`);
  const count = mesh.readUInt32LE(88);
  const grid = Math.round(Math.sqrt(count));
  assert.ok(grid >= 2 && grid <= MAX_MESH_GRID && grid * grid === count,
    `${label} has unsupported regular-lattice vertex count ${count}`);
  // Decode every delta rather than wrapping an out-of-range coordinate into a
  // Uint16Array.  The shipping encoder writes one exact regular lattice; a
  // wrapped coordinate makes an invisible or partial mesh look well-framed.
  let at = 92;
  const zigzag = (name) => {
    const out = new Uint16Array(count);
    let previous = 0;
    for (let index = 0; index < count; index += 1) {
      const raw = mesh.readUInt16LE(at);
      at += 2;
      const value = previous + ((raw >>> 1) ^ -(raw & 1));
      assert.ok(value >= 0 && value <= 32767, `${label} ${name} coordinate is outside [0, 32767]`);
      out[index] = value;
      previous = value;
    }
    return out;
  };
  assert.ok(92 + count * 6 <= mesh.length, `${label} truncates its u/v/h vertex sections`);
  const u = zigzag("u");
  const v = zigzag("v");
  const h = zigzag("height");
  assert.ok(at <= mesh.length, `${label} truncates its u/v/h vertex sections`);
  const wide = count > 65536;
  const indexWidth = wide ? 4 : 2;
  const align = wide ? 4 : 2;
  while (at % align) at += 1;
  const requireBytes = (bytes, section) => {
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && at + bytes <= mesh.length,
      `${label} truncates ${section}`);
  };
  requireBytes(4, "triangle count");
  const triangleCount = mesh.readUInt32LE(at);
  at += 4;
  const expectedTriangleCount = 2 * (grid - 1) ** 2;
  assert.equal(triangleCount, expectedTriangleCount,
    `${label} must contain the shipping regular-grid triangle count ${expectedTriangleCount}`);
  assert.ok(triangleCount <= Math.floor((mesh.length - at) / (3 * indexWidth)),
    `${label} triangle count exceeds remaining mesh bytes`);
  const readIndex = () => {
    requireBytes(indexWidth, "triangle indices");
    const value = wide ? mesh.readUInt32LE(at) : mesh.readUInt16LE(at);
    at += indexWidth;
    return value;
  };
  const latticeAxis = new Map();
  for (let index = 0; index < grid; index += 1) latticeAxis.set(Math.floor((32767 * index) / (grid - 1)), index);
  const vertexLattice = new Uint32Array(count);
  const seenLattice = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const latticeX = latticeAxis.get(u[index]);
    const latticeY = latticeAxis.get(v[index]);
    assert.notEqual(latticeX, undefined, `${label} u coordinate is not on the shipping lattice`);
    assert.notEqual(latticeY, undefined, `${label} v coordinate is not on the shipping lattice`);
    const latticeVertex = latticeY * grid + latticeX;
    assert.equal(seenLattice[latticeVertex], 0, `${label} repeats a regular-lattice vertex`);
    seenLattice[latticeVertex] = 1;
    vertexLattice[index] = latticeVertex;
  }
  const expectedTriangleVertex = (triangle, corner) => {
    const cell = Math.floor(triangle / 2);
    const x = cell % (grid - 1);
    const y = Math.floor(cell / (grid - 1));
    const bottomLeft = y * grid + x;
    const bottomRight = bottomLeft + 1;
    const topLeft = bottomLeft + grid;
    const topRight = topLeft + 1;
    if (triangle % 2 === 0) return corner === 0 ? bottomLeft : corner === 1 ? bottomRight : topRight;
    return corner === 0 ? bottomLeft : corner === 1 ? topRight : topLeft;
  };
  let highWater = 0;
  for (let index = 0; index < triangleCount * 3; index += 1) {
    const code = readIndex();
    assert.ok(code <= highWater, `${label} has invalid high-water triangle index`);
    const decoded = highWater - code;
    assert.ok(decoded < count, `${label} triangle index exceeds vertex count`);
    if (code === 0) highWater += 1;
    assert.ok(highWater <= count, `${label} triangle high-water mark exceeds vertex count`);
    assert.equal(vertexLattice[decoded], expectedTriangleVertex(Math.floor(index / 3), index % 3),
      `${label} triangle topology is not the shipping regular grid`);
  }
  assert.equal(highWater, count, `${label} regular-grid triangles must reference every vertex`);
  const shippingEdges = {
    west: [], south: [], east: [], north: [],
  };
  for (let candidate = 0; candidate < count; candidate += 1) {
    if (u[candidate] === 0) shippingEdges.west.push(candidate);
    if (v[candidate] === 0) shippingEdges.south.push(candidate);
    if (u[candidate] === 32767) shippingEdges.east.push(candidate);
    if (v[candidate] === 32767) shippingEdges.north.push(candidate);
  }
  for (const edge of ["west", "south", "east", "north"]) {
    requireBytes(4, `${edge} edge count`);
    const edgeCount = mesh.readUInt32LE(at);
    at += 4;
    assert.equal(edgeCount, grid, `${label} ${edge} edge must contain exactly ${grid} vertices`);
    requireBytes(edgeCount * indexWidth, `${edge} edge indices`);
    for (let index = 0; index < edgeCount; index += 1) {
      const vertex = wide ? mesh.readUInt32LE(at) : mesh.readUInt16LE(at);
      at += indexWidth;
      assert.ok(vertex < count, `${label} ${edge} edge index exceeds vertex count`);
      assert.equal(vertex, shippingEdges[edge][index], `${label} ${edge} edge is not the shipping edge list`);
    }
  }
  requireBytes(5, "watermask extension header");
  const extensionId = mesh.readUInt8(at);
  const extensionBytes = mesh.readUInt32LE(at + 1);
  at += 5;
  assert.equal(extensionId, 2, `${label} must contain the shipping watermask extension id 2`);
  assert.ok(extensionBytes === 1 || extensionBytes === MAX_MASK_BYTES,
    `${label} watermask extension must be one uniform byte or a ${MAX_MASK_BYTES}-byte raster`);
  requireBytes(extensionBytes, "watermask extension body");
  const waterMask = mesh.subarray(at, at + extensionBytes);
  at += extensionBytes;
  assert.equal(at, mesh.length, `${label} has trailing mesh bytes`);
  return { count, grid, u, v, h, waterMask };
}

function meshEdges(mesh, dtt, structure = validateMeshStructure(mesh, "quantized mesh")) {
  // GRID_WIDTH/GRID_HEIGHT are unset on a mesh payload — the schema says so
  // ("Unset for mesh formats, whose vertex count varies") — so the lattice is
  // read from the MESH, which is where it actually lives. Reading a record
  // field that is legitimately absent and defaulting it to 65 would have
  // silently mis-parsed every pyramid built at another grid size.
  void dtt;
  const { count, grid, u, v, h } = structure;
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

function validateMeshWaterMask(meshWaterMask, dtt, key) {
  if (dtt.waterMaskKind === 1 || dtt.waterMaskKind === 2) {
    assert.equal(meshWaterMask.length, 1, `mesh watermask at ${key} must be uniform`);
    assert.equal(meshWaterMask[0], dtt.waterMaskKind === 2 ? 0xff : 0x00,
      `mesh watermask at ${key} disagrees with DTT uniform WATER_MASK_KIND`);
    return;
  }
  assert.equal(meshWaterMask.length, MAX_MASK_BYTES,
    `mesh watermask at ${key} must contain the full DTT raster`);
  const raw = gunzipBounded(Buffer.from(dtt.waterMask.bytes), MAX_MASK_BYTES, `mask at ${key}`);
  assert.equal(raw.length, MAX_MASK_BYTES, `mask at ${key} decompresses to ${raw.length} B`);
  assert.ok(raw.equals(meshWaterMask), `mesh watermask at ${key} disagrees with DTT WATER_MASK bytes`);
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

function validateTerrainAddress(level, x, y, source) {
  assert.ok(Number.isSafeInteger(level) && level >= 0 && level <= MAX_TERRAIN_LEVEL,
    `terrain level outside approved [0, ${MAX_TERRAIN_LEVEL}] range in ${source}`);
  assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0,
    `terrain coordinate is not a non-negative safe integer in ${source}`);
  const columns = 2 ** (level + 1);
  const rows = 2 ** level;
  assert.ok(x < columns && y < rows, `terrain coordinate ${level}/${x}/${y} is outside geographic scheme bounds`);
}

function validateDtt(dtt, record) {
  validateTerrainAddress(dtt.level, dtt.x, dtt.y, "tile record");
  assert.ok(dtt.payload?.bytes, "tile record has no inline quantized-mesh payload");
  assert.ok([1, 2, 3].includes(dtt.waterMaskKind), `unsupported water-mask kind ${dtt.waterMaskKind}`);
  assert.ok((dtt.childAvailability & ~0x0f) === 0, `child availability has reserved bits set at ${terrainAddress(dtt.level, dtt.x, dtt.y)}`);
  for (const [name, value] of Object.entries({
    westDeg: dtt.westDeg, southDeg: dtt.southDeg, eastDeg: dtt.eastDeg, northDeg: dtt.northDeg,
    minHeightM: dtt.minHeightM, maxHeightM: dtt.maxHeightM,
    verticalAccuracyM: dtt.verticalAccuracyM, accuracyConfidence: dtt.accuracyConfidence,
    dataCoverageFraction: dtt.dataCoverageFraction,
  })) assert.ok(Number.isFinite(value), `tile ${terrainAddress(dtt.level, dtt.x, dtt.y)} has non-finite ${name}`);
  assert.ok(dtt.westDeg < dtt.eastDeg && dtt.southDeg < dtt.northDeg, "tile extent is inverted");
  assert.ok(dtt.westDeg >= -180 && dtt.eastDeg <= 180 && dtt.southDeg >= -90 && dtt.northDeg <= 90,
    "tile extent is outside geographic WGS84 bounds");
  assert.ok(dtt.dataCoverageFraction >= 0 && dtt.dataCoverageFraction <= 1, "tile coverage is outside [0, 1]");
  assert.ok(dtt.accuracyConfidence >= 0 && dtt.accuracyConfidence <= 1, "tile accuracy confidence is outside [0, 1]");
  assert.ok(dtt.verticalAccuracyM >= 0, "tile vertical accuracy is negative");
  assert.ok(dtt.maxHeightM >= dtt.minHeightM, "tile height range is inverted");
  assert.equal(dtt.payload.sizeBytes, dtt.payload.bytes.length, "tile payload size does not match inline bytes");
  assert.equal(dtt.payload.contentEncoding, "gzip", "shipping quantized-mesh payload must state gzip encoding");
  assert.ok(dtt.payload.bytes.length <= MAX_COMPRESSED_PAYLOAD_BYTES, "tile compressed payload exceeds verifier safety bound");
  if (dtt.waterMaskKind === 3) {
    assert.ok(dtt.waterMask?.bytes, "raster water mask has no inline bytes");
    assert.equal(dtt.waterMaskWidth, 256, "raster water mask must state width 256");
    assert.equal(dtt.waterMaskHeight, 256, "raster water mask must state height 256");
    assert.equal(dtt.waterMask.sizeBytes, dtt.waterMask.bytes.length, "raster water-mask size does not match inline bytes");
    assert.equal(dtt.waterMask.contentEncoding, "gzip", "shipping raster water mask must state gzip encoding");
    assert.equal(dtt.waterMask.digest, `1220${createHash("sha256").update(dtt.waterMask.bytes).digest("hex")}`,
      "raster water-mask digest does not match inline bytes");
  } else {
    assert.equal(dtt.waterMask?.bytes ?? null, null, "uniform DTT water mask must not carry raster bytes");
    assert.equal(dtt.waterMaskWidth, 0, "uniform DTT water mask must not state a width");
    assert.equal(dtt.waterMaskHeight, 0, "uniform DTT water mask must not state a height");
  }
  void record;
}

const OCEAN_SKIP_MAX_RECEIPT_BYTES = 64 * 1024;
// Global all-water membership can be output-sized.  The bounded line reader
// retains only one row, while this ceiling matches the independently approved
// static-directory absolute maximum rather than inventing a smaller heap-era
// file cap.
const OCEAN_SKIP_MAX_LINES_BYTES = PUBLICATION_LIMITS.maxStaticDirectoryBytes;
const OCEAN_SKIP_MAX_ROW_BYTES = 256;

const NO_FOLLOW = fs.constants.O_NOFOLLOW;
assert.ok(Number.isInteger(NO_FOLLOW) && NO_FOLLOW !== 0,
  "this verifier requires O_NOFOLLOW for publication receipts");

function fileMutationSnapshot(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    bytes: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFileMutation(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.bytes === right.bytes
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function stablePublicationInput(outDir, relativePath, {
  maxBytes,
  extra = {},
  retainBytes = false,
} = {}) {
  assert.equal(relativePath, path.basename(relativePath), "publication receipt path must be a fixed relative filename");
  const file = path.join(outDir, relativePath);
  const pathBeforeStat = fs.lstatSync(file, { bigint: true });
  assert.ok(pathBeforeStat.isFile(), `publication input is not a regular file: ${relativePath}`);
  const pathBefore = fileMutationSnapshot(pathBeforeStat);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  const chunks = retainBytes ? [] : null;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fileMutationSnapshot(fs.fstatSync(fd, { bigint: true }));
    assert.ok(Number.isSafeInteger(opened.bytes) && opened.bytes >= 0 && opened.bytes <= maxBytes,
      `publication input exceeds ${maxBytes} byte verifier bound: ${relativePath}`);
    assert.ok(sameFileMutation(pathBefore, opened), `publication input changed before opening: ${relativePath}`);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      position += read;
      assert.ok(position <= opened.bytes, `publication input grew while hashing: ${relativePath}`);
      hash.update(buffer.subarray(0, read));
      if (chunks) chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    assert.equal(position, opened.bytes, `publication input changed size while hashing: ${relativePath}`);
    const closed = fileMutationSnapshot(fs.fstatSync(fd, { bigint: true }));
    const pathAfter = fileMutationSnapshot(fs.lstatSync(file, { bigint: true }));
    assert.ok(sameFileMutation(opened, closed), `publication input changed while hashing: ${relativePath}`);
    assert.ok(sameFileMutation(opened, pathAfter), `publication input pathname changed while hashing: ${relativePath}`);
    const receipt = {
      path: relativePath,
      bytes: opened.bytes,
      sha256: hash.digest("hex"),
      ...extra,
    };
    return { receipt, mutation: opened, bytes: chunks ? Buffer.concat(chunks) : null };
  } finally {
    fs.closeSync(fd);
  }
}

function publicationInputReceipt(outDir, relativePath, extra = {}, maxBytes = OCEAN_SKIP_MAX_LINES_BYTES) {
  return stablePublicationInput(outDir, relativePath, { maxBytes, extra }).receipt;
}

function stableJsonInput(outDir, relativePath, maxBytes) {
  const stable = stablePublicationInput(outDir, relativePath, { maxBytes, retainBytes: true });
  let value;
  try {
    value = JSON.parse(stable.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
  return { value, receipt: stable.receipt, mutation: stable.mutation };
}

// Every publishable verifier output is staged under one exact directory.  A
// single deterministic name means SIGKILL cannot grow an unbounded collection
// of PID/timestamp files.  The owner record pins the inode of each stage before
// it is written: recovery can remove only a regular file that this verifier
// created, and refuses a symlink, replacement, corrupt record, or unknown
// entry.  A live or identity-ambiguous owner is never reclaimed.
const VERIFIER_STAGING_FORMAT = "terrain-verifier-staging-v1";
const VERIFIER_STAGING_DIRECTORY = ".terrain-verifier-staging-v1";
const VERIFIER_RECOVERY_DIRECTORY = ".terrain-verifier-recovery-v1";
const VERIFIER_LEASE_PATH = ".terrain-verifier-lease-v1";
const VERIFIER_LEASE_LINK_PREFIX = "terrain-verifier-lease-v1:";
const VERIFIER_STAGING_OWNER_SLOTS = Object.freeze(["owner.a.json", "owner.b.json"]);
const VERIFIER_STAGE_FILES = Object.freeze({
  availability: "terrain-available.json.stage",
  availableButUnstored: "available-but-unstored.ndjson.stage",
  layerConfig: "layer-json-config.json.stage",
  mountEntry: "mount-entry.json.stage",
  verifyReport: "verify-report.json.stage",
});
const VERIFIER_SCRATCH_DIRECTORIES = Object.freeze({
  edgeFacts: ".verify-edge-facts", edgeMerge: ".verify-edge-merge",
  addressFacts: ".verify-address-facts", addressMerge: ".verify-address-merge",
  sizeFacts: ".verify-size-facts", sizeMerge: ".verify-size-merge",
  closureFacts: ".verify-closure-facts", closureMerge: ".verify-closure-merge",
  membershipFacts: ".verify-membership-facts", membershipMerge: ".verify-membership-merge",
  candidateFacts: ".verify-available-candidates", candidateMerge: ".verify-available-candidate-merge",
  availableChildren: ".verify-available-children",
});
const VERIFIER_STAGE_MAX_OWNER_BYTES = 16 * 1024;

function stageIdentity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameStageIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function stageFileStat(file, label) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(stat.isFile(), `${label} is not a regular file`);
  return stat;
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateVerifierLease(value) {
  exactObjectKeys(value, ["format", "token", "pid", "identity", "digest"], "verifier staging lease");
  assert.equal(value.format, VERIFIER_STAGING_FORMAT, "unsupported verifier staging lease format");
  assert.match(value.token, /^[0-9a-f-]{36}$/i, "verifier staging lease token is invalid");
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, "verifier staging lease PID is invalid");
  exactObjectKeys(value.identity, ["pid", "startToken"], "verifier staging lease identity");
  assert.equal(value.identity.pid, value.pid, "verifier staging lease identity PID mismatches lease PID");
  assert.ok(value.identity.startToken === null || typeof value.identity.startToken === "string",
    "verifier staging lease start token is invalid");
  const { digest, ...unsigned } = value;
  assert.match(digest, /^[a-f0-9]{64}$/, "verifier staging lease digest is invalid");
  assert.equal(digest, sha256(canonicalJson(unsigned)), "verifier staging lease digest mismatches its contents");
  return value;
}

function signedVerifierLease(lease) {
  const { digest: _discarded, ...unsigned } = lease;
  return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
}

function readStableVerifierLease(file) {
  // The lease is an atomically-created symbolic-link value, not a file which
  // could be killed half way through a write.  We never follow the link: its
  // target is an encoded, bounded metadata record and lstat/readlink/lstat
  // must all observe the same exact pathname identity.
  const beforeStat = fs.lstatSync(file, { bigint: true });
  assert.ok(beforeStat.isSymbolicLink(), "verifier staging lease is not a symbolic link");
  const before = fileMutationSnapshot(beforeStat);
  assert.ok(before.bytes <= VERIFIER_STAGE_MAX_OWNER_BYTES, "verifier staging lease exceeds bounded metadata size");
  const target = fs.readlinkSync(file, "utf8");
  const after = fileMutationSnapshot(fs.lstatSync(file, { bigint: true }));
  assert.ok(sameFileMutation(before, after), "verifier staging lease pathname changed while reading");
  assert.ok(target.startsWith(VERIFIER_LEASE_LINK_PREFIX), "verifier staging lease has an invalid link target");
  const encoded = target.slice(VERIFIER_LEASE_LINK_PREFIX.length);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "verifier staging lease has invalid encoded metadata");
  let value;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { assert.fail("verifier staging lease is not JSON"); }
  assert.equal(Buffer.from(JSON.stringify(value)).toString("base64url"), encoded,
    "verifier staging lease metadata is not canonically encoded");
  return { value: validateVerifierLease(value), mutation: before };
}

function unlinkOwnedPath(file, expectedMutation, label, { symbolicLink = false } = {}) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(symbolicLink ? stat.isSymbolicLink() : stat.isFile(), `${label} has an unexpected file type`);
  const actual = fileMutationSnapshot(stat);
  assert.ok(sameFileMutation(actual, expectedMutation), `${label} was exchanged before unlink`);
  fs.unlinkSync(file);
}

function readStableStagingOwner(ownerPath) {
  const before = fileMutationSnapshot(stageFileStat(ownerPath, "verifier staging owner"));
  assert.ok(before.bytes <= VERIFIER_STAGE_MAX_OWNER_BYTES, "verifier staging owner exceeds bounded metadata size");
  const handle = fs.openSync(ownerPath, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fileMutationSnapshot(fs.fstatSync(handle, { bigint: true }));
    assert.ok(sameFileMutation(before, opened), "verifier staging owner changed before opening");
    const bytes = Buffer.alloc(opened.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      assert.ok(read > 0, "verifier staging owner truncated while reading");
      offset += read;
    }
    const closed = fileMutationSnapshot(fs.fstatSync(handle, { bigint: true }));
    const after = fileMutationSnapshot(stageFileStat(ownerPath, "verifier staging owner"));
    assert.ok(sameFileMutation(opened, closed), "verifier staging owner changed while reading");
    assert.ok(sameFileMutation(opened, after), "verifier staging owner pathname changed while reading");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { assert.fail("verifier staging owner is not JSON"); }
    return { value, mutation: opened };
  } finally {
    fs.closeSync(handle);
  }
}

function exactObjectKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unexpected keys`);
}

function validateStageOwner(value) {
  exactObjectKeys(value, ["format", "sequence", "token", "pid", "identity", "directory", "stages", "scratch", "digest"], "verifier staging owner");
  assert.equal(value.format, VERIFIER_STAGING_FORMAT, "unsupported verifier staging owner format");
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0, "verifier staging owner sequence is invalid");
  assert.match(value.token, /^[0-9a-f-]{36}$/i, "verifier staging owner token is invalid");
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, "verifier staging owner PID is invalid");
  exactObjectKeys(value.identity, ["pid", "startToken"], "verifier staging owner identity");
  assert.equal(value.identity.pid, value.pid, "verifier staging owner identity PID mismatches owner PID");
  assert.ok(value.identity.startToken === null || typeof value.identity.startToken === "string",
    "verifier staging owner start token is invalid");
  exactObjectKeys(value.directory, ["device", "inode"], "verifier staging owner directory");
  assert.ok(typeof value.directory.device === "string" && typeof value.directory.inode === "string",
    "verifier staging owner directory identity is invalid");
  exactObjectKeys(value.stages, Object.keys(VERIFIER_STAGE_FILES), "verifier staging owner stages");
  for (const [name, identity] of Object.entries(value.stages)) {
    if (identity === null) continue;
    if (identity?.state === "creating") {
      exactObjectKeys(identity, ["state"], `verifier staging owner stage ${name}`);
      continue;
    }
    const identityKeys = Object.keys(identity).sort();
    const inodeKeys = ["device", "inode"].sort();
    const mutationKeys = ["device", "inode", "bytes", "mtimeNs", "ctimeNs"].sort();
    assert.ok(JSON.stringify(identityKeys) === JSON.stringify(inodeKeys)
      || JSON.stringify(identityKeys) === JSON.stringify(mutationKeys),
    `verifier staging owner stage ${name} identity is invalid`);
    assert.ok(typeof identity.device === "string" && typeof identity.inode === "string",
      `verifier staging owner stage ${name} identity is invalid`);
  }
  exactObjectKeys(value.scratch, Object.keys(VERIFIER_SCRATCH_DIRECTORIES), "verifier staging owner scratch");
  for (const [name, identity] of Object.entries(value.scratch)) {
    if (identity === null) continue;
    if (identity?.state === "creating") {
      exactObjectKeys(identity, ["state"], `verifier staging owner scratch ${name}`);
      continue;
    }
    exactObjectKeys(identity, ["device", "inode"], `verifier staging owner scratch ${name}`);
  }
  const { digest, ...unsigned } = value;
  assert.match(digest, /^[a-f0-9]{64}$/, "verifier staging owner digest is invalid");
  assert.equal(digest, sha256(canonicalJson(unsigned)), "verifier staging owner digest mismatches its contents");
  return value;
}

function signedStageOwner(owner) {
  const { digest: _discarded, ...unsigned } = owner;
  return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
}

function verifierPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function verifierProcessIdentity(pid) {
  try {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const start = fields[19];
    return { pid, startToken: start ? `${boot}:${start}` : null };
  } catch {
    return { pid, startToken: null };
  }
}

function ownerIsDefinitelyStale(owner) {
  if (!verifierPidAlive(owner.pid)) return true;
  const expected = owner.identity.startToken;
  const observed = verifierProcessIdentity(owner.pid).startToken;
  return Boolean(expected && observed && expected !== observed);
}

function createVerifierLease(outDir, lease) {
  const file = path.join(outDir, VERIFIER_LEASE_PATH);
  const target = `${VERIFIER_LEASE_LINK_PREFIX}${Buffer.from(JSON.stringify(signedVerifierLease(lease))).toString("base64url")}`;
  assert.ok(Buffer.byteLength(target) <= VERIFIER_STAGE_MAX_OWNER_BYTES, "verifier staging lease metadata exceeds bounded size");
  // symlink(2) is atomic: unlike a fixed candidate regular file it cannot
  // leave a torn, unrecoverable metadata record when this process is killed.
  fs.symlinkSync(target, file);
  waitForTestStagingBarrier("lease-created-before-fsync");
  fsyncDirectory(outDir);
  return fileMutationSnapshot(fs.lstatSync(file, { bigint: true }));
}

function recoverVerifierLease(outDir, staleLease, staleMutation) {
  assert.ok(ownerIsDefinitelyStale(staleLease),
    "verifier staging lease is owned by a live or identity-ambiguous process; refusing concurrent verification");
  const staging = path.join(outDir, VERIFIER_STAGING_DIRECTORY);
  const recovery = path.join(outDir, VERIFIER_RECOVERY_DIRECTORY);
  if (lstatOrNull(recovery)) reclaimVerifierStagingDirectory(outDir, recovery, { alreadyRecovery: true, expectedToken: staleLease.token });
  if (lstatOrNull(staging)) reclaimVerifierStagingDirectory(outDir, staging, { expectedToken: staleLease.token });
  unlinkOwnedPath(path.join(outDir, VERIFIER_LEASE_PATH), staleMutation, "verifier staging lease", { symbolicLink: true });
  fsyncDirectory(outDir);
}

function acquireVerifierLease(outDir) {
  const leasePath = path.join(outDir, VERIFIER_LEASE_PATH);
  const lease = {
    format: VERIFIER_STAGING_FORMAT,
    token: randomUUID(),
    pid: process.pid,
    identity: verifierProcessIdentity(process.pid),
  };
  try {
    // A single symlink creation arbitrates the lease atomically and its link
    // target contains all durable metadata.  There is no writable candidate
    // pathname whose partial contents could strand a future verifier.
    waitForTestStagingBarrier("lease-before-create");
    const createdMutation = createVerifierLease(outDir, lease);
    const stable = readStableVerifierLease(leasePath);
    assert.equal(stable.value.token, lease.token, "verifier staging lease changed during acquisition");
    assert.ok(sameFileMutation(stable.mutation, createdMutation), "verifier staging lease changed after acquisition");
    return { value: stable.value, mutation: stable.mutation };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readStableVerifierLease(leasePath);
    recoverVerifierLease(outDir, existing.value, existing.mutation);
    return acquireVerifierLease(outDir);
  }
}

function releaseVerifierLease(outDir, lease, mutation) {
  const file = path.join(outDir, VERIFIER_LEASE_PATH);
  const stable = readStableVerifierLease(file);
  assert.equal(stable.value.token, lease.token, "verifier staging lease ownership changed before release");
  assert.ok(sameFileMutation(stable.mutation, mutation), "verifier staging lease pathname changed before release");
  unlinkOwnedPath(file, mutation, "verifier staging lease", { symbolicLink: true });
  fsyncDirectory(outDir);
}

function waitForTestStagingBarrier(point) {
  const requested = process.env.TERRAIN_VERIFY_TEST_STAGING_BARRIER;
  if (requested !== point) return;
  const requestedOccurrence = Number(process.env.TERRAIN_VERIFY_TEST_STAGING_BARRIER_OCCURRENCE ?? "1");
  assert.ok(Number.isSafeInteger(requestedOccurrence) && requestedOccurrence > 0,
    "staging barrier occurrence must be a positive integer");
  const counts = globalThis.__terrainVerifierStagingBarrierCounts ??= new Map();
  const occurrence = (counts.get(point) ?? 0) + 1;
  counts.set(point, occurrence);
  if (occurrence !== requestedOccurrence) return;
  assert.equal(process.env.NODE_ENV, "test", "staging barrier is test-only");
  const root = process.env.TERRAIN_VERIFY_TEST_STAGING_BARRIER_PATH;
  assert.ok(root && path.isAbsolute(root), "staging barrier path must be absolute");
  const ready = `${root}.${point}.ready`;
  const release = `${root}.${point}.release`;
  fs.writeFileSync(ready, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 30_000;
  const waitWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!fs.existsSync(release)) {
    assert.ok(Date.now() < deadline, `test staging barrier ${point} timed out`);
    Atomics.wait(waitWord, 0, 0, 10);
  }
}

function ownerSlotPath(directory, slot) {
  assert.ok(VERIFIER_STAGING_OWNER_SLOTS.includes(slot), "unknown verifier staging owner slot");
  return path.join(directory, slot);
}

function writeStagingOwnerSlot(directory, slot, owner, expectedMutation = null) {
  const file = ownerSlotPath(directory, slot);
  const bytes = Buffer.from(`${JSON.stringify(signedStageOwner(owner))}\n`);
  assert.ok(bytes.length <= VERIFIER_STAGE_MAX_OWNER_BYTES, "verifier staging owner exceeds bounded metadata size");
  let handle = null;
  try {
    if (expectedMutation === null) {
      handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    } else {
      const before = fileMutationSnapshot(stageFileStat(file, "verifier staging owner slot"));
      assert.ok(sameFileMutation(before, expectedMutation), "verifier staging owner slot was exchanged before update");
      handle = fs.openSync(file, fs.constants.O_WRONLY | NO_FOLLOW);
      const opened = fileMutationSnapshot(fs.fstatSync(handle, { bigint: true }));
      assert.ok(sameFileMutation(opened, expectedMutation), "verifier staging owner slot was exchanged while opening");
      fs.ftruncateSync(handle, 0);
    }
    waitForTestStagingBarrier("owner-before-write");
    fs.writeSync(handle, bytes, 0, bytes.length, 0);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  fsyncDirectory(directory);
  waitForTestStagingBarrier("owner-after-write");
  return fileMutationSnapshot(stageFileStat(file, "verifier staging owner slot"));
}

function readStagingOwnerSlots(directory) {
  const names = fs.readdirSync(directory);
  const allowed = new Set([
    ...VERIFIER_STAGING_OWNER_SLOTS,
    ...Object.values(VERIFIER_STAGE_FILES),
    ...Object.values(VERIFIER_SCRATCH_DIRECTORIES),
  ]);
  for (const name of names) assert.ok(allowed.has(name), `verifier staging found unknown entry ${name}`);
  const slots = [];
  for (const slot of VERIFIER_STAGING_OWNER_SLOTS) {
    const file = ownerSlotPath(directory, slot);
    if (!lstatOrNull(file)) continue;
    try {
      const stable = readStableStagingOwner(file);
      slots.push({ slot, owner: validateStageOwner(stable.value), mutation: stable.mutation });
    } catch (error) {
      slots.push({ slot, invalid: error });
    }
  }
  const valid = slots.filter((entry) => entry.owner);
  if (valid.length) {
    const tokens = new Set(valid.map((entry) => entry.owner.token));
    assert.equal(tokens.size, 1, "verifier staging owner slots disagree on owner token");
  }
  valid.sort((left, right) => right.owner.sequence - left.owner.sequence);
  return { names: new Set(names), slots, active: valid[0] ?? null };
}

function removeKnownRegularFile(file, label) {
  const mutation = fileMutationSnapshot(stageFileStat(file, label));
  unlinkOwnedPath(file, mutation, label);
}

// These are the only names the bounded external sorter may create below one
// of the verifier-owned scratch roots.  A root inode belongs to the lease;
// validating both the root and every direct entry means recovery never turns
// a convenient recursive reset into deletion of a substituted tree.
const VERIFIER_SCRATCH_ENTRY = /^(?:runs\.manifest\.ndjson|run-\d{6,12}\.ndjson|pass-\d{4}(?:\.manifest|-run-\d{6,12})\.ndjson)(?:\.\d+\.[0-9a-f-]+\.tmp)?$/;

function ownedScratchEntries(directory, expectedIdentity, label) {
  const before = fs.lstatSync(directory, { bigint: true });
  assert.ok(before.isDirectory() && sameStageIdentity(expectedIdentity, stageIdentity(before)),
    `${label} was exchanged before entry scan`);
  const entries = fs.readdirSync(directory).map((name) => {
    assert.match(name, VERIFIER_SCRATCH_ENTRY, `${label} contains an unknown entry ${name}`);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file, { bigint: true });
    assert.ok(stat.isFile(), `${label} contains a non-regular entry ${name}`);
    return { file, mutation: fileMutationSnapshot(stat) };
  });
  const after = fs.lstatSync(directory, { bigint: true });
  assert.ok(after.isDirectory() && sameStageIdentity(expectedIdentity, stageIdentity(after)),
    `${label} was exchanged during entry scan`);
  return entries;
}

function removeOwnedScratchDirectory(directory, expectedIdentity, label) {
  for (const entry of ownedScratchEntries(directory, expectedIdentity, label)) {
    // Rebind the parent immediately before each deletion as well as binding
    // the child mutation.  A rename/replacement race therefore fails closed.
    const parent = fs.lstatSync(directory, { bigint: true });
    assert.ok(parent.isDirectory() && sameStageIdentity(expectedIdentity, stageIdentity(parent)),
      `${label} was exchanged before entry deletion`);
    unlinkOwnedPath(entry.file, entry.mutation, `${label} entry`);
  }
  const final = fs.lstatSync(directory, { bigint: true });
  assert.ok(final.isDirectory() && sameStageIdentity(expectedIdentity, stageIdentity(final)),
    `${label} was exchanged before removal`);
  fs.rmdirSync(directory);
}

function assertOwnedStagingDirectory(directory, expectedIdentity, label) {
  const stat = fs.lstatSync(directory, { bigint: true });
  assert.ok(stat.isDirectory() && sameStageIdentity(expectedIdentity, stageIdentity(stat)), `${label} was exchanged`);
}

class VerifierStaging {
  constructor(outDir, directory, owner, activeSlot, slotMutations) {
    this.outDir = outDir;
    this.directory = directory;
    this.owner = owner;
    this.activeSlot = activeSlot;
    this.slotMutations = slotMutations;
    this.released = false;
  }

  stagePath(name) {
    assert.ok(Object.hasOwn(VERIFIER_STAGE_FILES, name), `unknown verifier stage ${name}`);
    return path.join(this.directory, VERIFIER_STAGE_FILES[name]);
  }

  scratchPath(name) {
    assert.ok(Object.hasOwn(VERIFIER_SCRATCH_DIRECTORIES, name), `unknown verifier scratch ${name}`);
    return path.join(this.directory, VERIFIER_SCRATCH_DIRECTORIES[name]);
  }

  openScratch(name) {
    const directory = this.scratchPath(name);
    assertOwnedStagingDirectory(this.directory, this.owner.directory, "verifier staging directory before scratch creation");
    this.owner.scratch[name] = { state: "creating" };
    this.persistOwner();
    waitForTestStagingBarrier(`scratch-${name}-creating`);
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(this.directory);
    const stat = fs.lstatSync(directory, { bigint: true });
    assert.ok(stat.isDirectory(), `verifier scratch ${name} is not a directory`);
    const identity = stageIdentity(stat);
    waitForTestStagingBarrier(`scratch-${name}-created`);
    this.owner.scratch[name] = identity;
    this.persistOwner();
    waitForTestStagingBarrier(`scratch-${name}-opened`);
    return directory;
  }

  clearScratch(name) {
    const directory = this.scratchPath(name);
    const expected = this.owner.scratch[name];
    assert.ok(expected, `verifier scratch ${name} is not owned`);
    assert.notEqual(expected.state, "creating", `verifier scratch ${name} creation is incomplete`);
    assertOwnedStagingDirectory(this.directory, this.owner.directory, "verifier staging directory before scratch cleanup");
    removeOwnedScratchDirectory(directory, expected, `verifier scratch ${name}`);
    fsyncDirectory(this.directory);
    this.owner.scratch[name] = null;
    this.persistOwner();
  }

  persistOwner() {
    assertOwnedStagingDirectory(this.directory, this.owner.directory, "verifier staging directory before owner update");
    const nextSlot = VERIFIER_STAGING_OWNER_SLOTS.find((slot) => slot !== this.activeSlot);
    this.owner = { ...this.owner, sequence: this.owner.sequence + 1 };
    const mutation = writeStagingOwnerSlot(this.directory, nextSlot, this.owner, this.slotMutations[nextSlot] ?? null);
    this.slotMutations[nextSlot] = mutation;
    this.activeSlot = nextSlot;
  }

  open(name) {
    assertOwnedStagingDirectory(this.directory, this.owner.directory, "verifier staging directory before output creation");
    this.owner.stages[name] = { state: "creating" };
    this.persistOwner();
    waitForTestStagingBarrier(`stage-${name}-creating`);
    const file = this.stagePath(name);
    const handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    const identity = stageIdentity(fs.fstatSync(handle, { bigint: true }));
    fsyncDirectory(this.directory);
    waitForTestStagingBarrier(`stage-${name}-created`);
    this.owner.stages[name] = identity;
    this.persistOwner();
    waitForTestStagingBarrier(`stage-${name}-opened`);
    return { name, file, handle, identity, sealed: false };
  }

  assertOwnedStage(stage) {
    const actualStat = stageFileStat(stage.file, `verifier stage ${stage.name}`);
    const actual = stageIdentity(actualStat);
    assert.ok(sameStageIdentity(stage.identity, actual), `verifier stage ${stage.name} was exchanged`);
    assert.ok(this.owner.stages[stage.name]?.state !== "creating", `verifier stage ${stage.name} owner record is incomplete`);
    const recorded = this.owner.stages[stage.name];
    if (Object.hasOwn(recorded, "bytes")) {
      assert.ok(sameFileMutation(recorded, fileMutationSnapshot(actualStat)),
        `verifier stage ${stage.name} bytes changed after sealing`);
    } else {
      assert.ok(sameStageIdentity(recorded, actual), `verifier stage ${stage.name} owner record mismatches`);
    }
  }

  seal(stage) {
    assert.notEqual(stage.handle, null, `verifier stage ${stage.name} is already closed`);
    fs.fsyncSync(stage.handle);
    fs.closeSync(stage.handle);
    stage.handle = null;
    this.assertOwnedStage(stage);
    this.owner.stages[stage.name] = fileMutationSnapshot(stageFileStat(stage.file, `verifier stage ${stage.name}`));
    this.persistOwner();
    stage.sealed = true;
    waitForTestStagingBarrier(`stage-${stage.name}-sealed`);
  }

  publish(stage, finalPath) {
    assert.ok(stage.sealed, `verifier stage ${stage.name} must be sealed before publication`);
    this.assertOwnedStage(stage);
    fs.renameSync(stage.file, finalPath);
    fsyncDirectory(path.dirname(finalPath));
    this.owner.stages[stage.name] = null;
    this.persistOwner();
  }

  discard(stage) {
    if (stage.handle !== null) {
      fs.closeSync(stage.handle);
      stage.handle = null;
    }
    try {
      this.assertOwnedStage(stage);
      unlinkOwnedPath(stage.file, fileMutationSnapshot(stageFileStat(stage.file, `verifier stage ${stage.name}`)),
        `verifier stage ${stage.name}`);
      fsyncDirectory(this.directory);
      this.owner.stages[stage.name] = null;
      this.persistOwner();
    } catch (error) {
      // A malformed/exchanged stage is intentionally retained for a later
      // fail-closed operator decision rather than deleting an unverified path.
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }

  release() {
    if (this.released) return;
    const slots = readStagingOwnerSlots(this.directory);
    assert.ok(slots.active, "verifier staging owner is missing at release");
    const owner = slots.active.owner;
    assert.equal(slots.active.slot, this.activeSlot, "verifier staging owner slot changed before release");
    assert.ok(sameFileMutation(slots.active.mutation, this.slotMutations[this.activeSlot]),
      "verifier staging owner pathname changed before release");
    assert.equal(owner.token, this.owner.token, "verifier staging ownership changed before release");
    assert.ok(Object.values(owner.stages).every((stage) => stage === null), "verifier staging retains an unfinished output");
    assert.ok(Object.values(owner.scratch).every((scratch) => scratch === null), "verifier staging retains unfinished scratch");
    for (const name of Object.values(VERIFIER_STAGE_FILES)) {
      assert.equal(slots.names.has(name), false, "verifier staging has an unfinished stage at release");
    }
    for (const name of Object.values(VERIFIER_SCRATCH_DIRECTORIES)) {
      assert.equal(slots.names.has(name), false, "verifier staging has unfinished scratch at release");
    }
    assertOwnedStagingDirectory(this.directory, owner.directory, "verifier staging directory before release");
    for (const slot of VERIFIER_STAGING_OWNER_SLOTS) {
      const expected = this.slotMutations[slot];
      if (!expected) continue;
      const actual = fileMutationSnapshot(stageFileStat(ownerSlotPath(this.directory, slot), "verifier staging owner slot"));
      assert.ok(sameFileMutation(actual, expected),
        "verifier staging owner slot was exchanged before release");
      fs.unlinkSync(ownerSlotPath(this.directory, slot));
    }
    fsyncDirectory(this.directory);
    fs.rmdirSync(this.directory);
    fsyncDirectory(this.outDir);
    this.released = true;
  }
}

function reclaimVerifierStagingDirectory(outDir, directory, { alreadyRecovery = false, expectedToken = null } = {}) {
  const directoryStat = fs.lstatSync(directory, { bigint: true });
  assert.ok(directoryStat.isDirectory(), "verifier staging path is not a directory");
  const directoryIdentity = stageIdentity(directoryStat);
  const slots = readStagingOwnerSlots(directory);
  if (!slots.active) {
    assert.ok(Object.values(VERIFIER_STAGE_FILES).every((name) => !slots.names.has(name)),
      "verifier staging without a valid owner contains an unverified stage");
    assert.ok(Object.values(VERIFIER_SCRATCH_DIRECTORIES).every((name) => !slots.names.has(name)),
      "verifier staging without a valid owner contains unverified scratch");
    assert.ok(expectedToken, "verifier staging owner initialization is in progress; refusing concurrent verification");
    for (const slot of VERIFIER_STAGING_OWNER_SLOTS) {
      if (slots.names.has(slot)) removeKnownRegularFile(ownerSlotPath(directory, slot), "verifier staging damaged owner slot");
    }
    fsyncDirectory(directory);
    fs.rmdirSync(directory);
    fsyncDirectory(outDir);
    return;
  }
  const owner = slots.active.owner;
  assert.ok(sameStageIdentity(owner.directory, directoryIdentity), "verifier staging directory was exchanged");
  if (expectedToken !== null) assert.equal(owner.token, expectedToken, "verifier staging owner does not match its lease");
  assert.ok(ownerIsDefinitelyStale(owner),
    "verifier staging is owned by a live or identity-ambiguous process; refusing concurrent verification");
  const recoveryDirectory = path.join(outDir, VERIFIER_RECOVERY_DIRECTORY);
  if (!alreadyRecovery) {
    assert.equal(lstatOrNull(recoveryDirectory), null, "verifier staging recovery is already pending; refusing verification");
    fs.renameSync(directory, recoveryDirectory);
    fsyncDirectory(outDir);
    assert.ok(sameStageIdentity(directoryIdentity, stageIdentity(fs.lstatSync(recoveryDirectory, { bigint: true }))),
      "verifier staging directory changed during recovery rename");
    waitForTestStagingBarrier("recovery-after-rename");
    return reclaimVerifierStagingDirectory(outDir, recoveryDirectory, { alreadyRecovery: true, expectedToken });
  }
  for (const [name, filename] of Object.entries(VERIFIER_STAGE_FILES)) {
    assertOwnedStagingDirectory(directory, owner.directory, "verifier staging directory before stage recovery");
    const expected = owner.stages[name];
    const present = slots.names.has(filename);
    if (expected === null) {
      assert.equal(present, false, `verifier staging recovery found unowned stage ${filename}`);
      continue;
    }
    if (expected.state === "creating") {
      if (present) removeKnownRegularFile(path.join(directory, filename), `verifier creating stage ${name}`);
      continue;
    }
    // A crash after rename but before clearing the owner record leaves no
    // stage to reclaim, which is safe because the completed final already won.
    if (!present) continue;
    const stagePath = path.join(directory, filename);
    const stageStat = stageFileStat(stagePath, `verifier stage ${name}`);
    const actual = stageIdentity(stageStat);
    assert.ok(sameStageIdentity(expected, actual), `verifier staging recovery refuses exchanged stage ${filename}`);
    if (Object.hasOwn(expected, "bytes")) {
      assert.ok(sameFileMutation(expected, fileMutationSnapshot(stageStat)),
        `verifier staging recovery refuses changed sealed stage ${filename}`);
    }
    unlinkOwnedPath(stagePath, fileMutationSnapshot(stageStat), `verifier stage ${name}`);
    fsyncDirectory(directory);
    waitForTestStagingBarrier("recovery-after-stage-delete");
  }
  for (const [name, dirname] of Object.entries(VERIFIER_SCRATCH_DIRECTORIES)) {
    assertOwnedStagingDirectory(directory, owner.directory, "verifier staging directory before scratch recovery");
    const expected = owner.scratch[name];
    const scratchPath = path.join(directory, dirname);
    if (expected === null) {
      assert.equal(lstatOrNull(scratchPath), null, `verifier staging recovery found unowned scratch ${dirname}`);
      continue;
    }
    if (expected.state === "creating") {
      // The durable owner transition precedes mkdir.  A dead creator can have
      // left either no root or only this fixed, verifier-reserved root; it
      // must still meet the same bounded-name/non-symlink rules before it is
      // removed.  A live creator was rejected above.
      const creatingStat = lstatOrNull(scratchPath);
      if (creatingStat) {
        assert.ok(creatingStat.isDirectory(), `verifier staging recovery refuses non-directory creating scratch ${dirname}`);
        removeOwnedScratchDirectory(scratchPath, stageIdentity(creatingStat), `verifier staging recovery creating scratch ${dirname}`);
        fsyncDirectory(directory);
      }
      continue;
    }
    removeOwnedScratchDirectory(scratchPath, expected, `verifier staging recovery scratch ${dirname}`);
    fsyncDirectory(directory);
  }
  for (const slot of VERIFIER_STAGING_OWNER_SLOTS) {
    assertOwnedStagingDirectory(directory, owner.directory, "verifier staging directory before owner-slot recovery");
    if (slots.names.has(slot)) removeKnownRegularFile(ownerSlotPath(directory, slot), "verifier staging owner slot");
  }
  fsyncDirectory(directory);
  fs.rmdirSync(directory);
  fsyncDirectory(outDir);
}

function acquireVerifierStaging(outDir, lease) {
  const directory = path.join(outDir, VERIFIER_STAGING_DIRECTORY);
  const recoveryDirectory = path.join(outDir, VERIFIER_RECOVERY_DIRECTORY);
  assert.equal(lstatOrNull(recoveryDirectory), null, "verifier staging recovery is pending after lease acquisition");
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("verifier staging directory exists after lease acquisition; refusing verification");
    throw error;
  }
  fsyncDirectory(outDir);
  waitForTestStagingBarrier("mkdir-before-owner");
  const owner = {
    format: VERIFIER_STAGING_FORMAT,
    sequence: 1,
    token: lease.value.token,
    pid: lease.value.pid,
    identity: lease.value.identity,
    directory: stageIdentity(fs.lstatSync(directory, { bigint: true })),
    stages: Object.fromEntries(Object.keys(VERIFIER_STAGE_FILES).map((name) => [name, null])),
    scratch: Object.fromEntries(Object.keys(VERIFIER_SCRATCH_DIRECTORIES).map((name) => [name, null])),
  };
  try {
    const firstSlot = VERIFIER_STAGING_OWNER_SLOTS[0];
    const firstMutation = writeStagingOwnerSlot(directory, firstSlot, owner);
    return new VerifierStaging(outDir, directory, signedStageOwner(owner), firstSlot, { [firstSlot]: firstMutation });
  } catch (error) {
    // The fixed, fully-arbitrated lease remains durable. Its stale recovery
    // owns this exact directory and can distinguish this bootstrap window from
    // a live concurrent creator without an unsafe time-based grace period.
    throw error;
  }
}

// New global cuts write a compact receipt beside a separately streamed raw
// ASCII address list (one `level/x/y` line each).  It is read once through a
// no-follow descriptor: the digest, the address facts, and the later receipt
// all name the same bytes rather than a pathname that a concurrent producer
// can exchange between those steps.
async function* iterateStableOceanLines(outDir, receipt, evidence) {
  const relativePath = "ocean-skipped.lines";
  const file = path.join(outDir, relativePath);
  const pathBeforeStat = fs.lstatSync(file, { bigint: true });
  assert.ok(pathBeforeStat.isFile(), "ocean skip address list is not a regular file");
  const pathBefore = fileMutationSnapshot(pathBeforeStat);
  assert.ok(pathBefore.bytes <= OCEAN_SKIP_MAX_LINES_BYTES, "ocean skip address list exceeds verifier bound");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  let position = 0;
  let count = 0;
  try {
    const opened = fileMutationSnapshot(fs.fstatSync(fd, { bigint: true }));
    assert.ok(sameFileMutation(pathBefore, opened), "ocean skip address list changed before opening");
    const emit = async function* (line) {
      const withoutCr = line.length && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
      assert.ok(withoutCr.length > 0 && withoutCr.length <= OCEAN_SKIP_MAX_ROW_BYTES,
        "ocean skip line exceeds bounded row size");
      const address = withoutCr.toString("utf8");
      assert.equal(Buffer.byteLength(address), withoutCr.length, `ocean skip line ${count + 1} is not valid UTF-8`);
      count += 1;
      yield address;
    };
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      position += read;
      assert.ok(position <= opened.bytes, "ocean skip address list grew while being read");
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) break;
        const piece = chunk.subarray(start, newline);
        assert.ok(carry.length + piece.length <= OCEAN_SKIP_MAX_ROW_BYTES, "ocean skip line exceeds bounded row size");
        const line = carry.length ? Buffer.concat([carry, piece]) : Buffer.from(piece);
        carry = Buffer.alloc(0);
        yield* emit(line);
        start = newline + 1;
      }
      const tail = chunk.subarray(start);
      assert.ok(carry.length + tail.length <= OCEAN_SKIP_MAX_ROW_BYTES, "ocean skip line exceeds bounded row size");
      carry = carry.length ? Buffer.concat([carry, tail]) : Buffer.from(tail);
    }
    if (carry.length) yield* emit(carry);
    assert.equal(position, opened.bytes, "ocean skip address list changed size while being read");
    assert.equal(hash.digest("hex"), receipt.digest, "ocean skip receipt digest mismatch for ocean-skipped.lines");
    assert.equal(count, receipt.count, "ocean skip receipt count mismatch for ocean-skipped.lines");
    const closed = fileMutationSnapshot(fs.fstatSync(fd, { bigint: true }));
    const pathAfter = fileMutationSnapshot(fs.lstatSync(file, { bigint: true }));
    assert.ok(sameFileMutation(opened, closed), "ocean skip address list changed while being read");
    assert.ok(sameFileMutation(opened, pathAfter), "ocean skip address list pathname changed while being read");
    evidence.oceanAddresses = { path: relativePath, bytes: opened.bytes, sha256: receipt.digest, addresses: count };
    evidence.oceanAddressesMutation = opened;
  } finally {
    fs.closeSync(fd);
  }
}

async function* iterateOceanSkippedAddresses(outDir, legacyPath, evidence) {
  if (!fs.existsSync(legacyPath)) return;
  const beforeStat = fs.lstatSync(legacyPath, { bigint: true });
  assert.ok(beforeStat.isFile(), `ocean skip receipt is not a regular file: ${legacyPath}`);
  const before = fileMutationSnapshot(beforeStat);
  assert.ok(before.bytes <= OCEAN_SKIP_MAX_LINES_BYTES,
    `ocean skip input exceeds ${OCEAN_SKIP_MAX_LINES_BYTES} bytes: ${legacyPath}`);
  let small = null;
  if (before.bytes <= OCEAN_SKIP_MAX_RECEIPT_BYTES) small = stablePublicationInput(outDir, "ocean-skipped.json", {
    maxBytes: OCEAN_SKIP_MAX_RECEIPT_BYTES, retainBytes: true,
  });
  let receipt = null;
  try { receipt = small ? JSON.parse(small.bytes.toString("utf8")) : null; } catch { receipt = null; }
  if (Object.hasOwn(receipt ?? {}, "format")) {
    assert.equal(receipt.format, "terrain-ocean-skips-lines-v1", `unsupported ocean skip receipt format ${receipt.format}`);
    const target = path.resolve(outDir, String(receipt.addressesPath));
    const targetRelative = path.relative(outDir, target);
    assert.ok(targetRelative && !targetRelative.startsWith(`..${path.sep}`) && targetRelative !== ".." && !path.isAbsolute(targetRelative),
      `ocean skip receipt target escapes output directory: ${receipt.addressesPath}`);
    assert.equal(receipt.addressesPath, "ocean-skipped.lines", "global ocean receipt must name the fixed address artifact");
    assert.ok(Number.isSafeInteger(receipt.count) && receipt.count >= 0, "ocean skip receipt count must be a non-negative integer");
    assert.match(receipt.digest, /^[a-f0-9]{64}$/, "ocean skip receipt digest must be a SHA-256 hex digest");
    evidence.oceanReceipt = small.receipt;
    evidence.oceanReceiptMutation = small.mutation;
    let previousKey = null;
    for await (const address of iterateStableOceanLines(outDir, receipt, evidence)) {
      const parsed = parseTerrainAddress(address, "ocean-skipped.lines");
      validateTerrainAddress(parsed.level, parsed.x, parsed.y, "ocean-skipped.lines");
      assert.equal(address, terrainAddress(parsed.level, parsed.x, parsed.y), `ocean skip line is not canonical`);
      const key = addressFactKey(parsed.level, parsed.x, parsed.y);
      assert.ok(previousKey === null || previousKey < key,
        `ocean skip lines must be sorted and unique by level/y/x at ${address}`);
      previousKey = key;
      yield address;
    }
    return;
  }
  // Legacy regional JSON retains its parser, but its path is guarded before
  // and after the stream so a symlink/swap cannot silently become an input.
  const guard = fs.openSync(legacyPath, fs.constants.O_RDONLY | NO_FOLLOW);
  const opened = fileMutationSnapshot(fs.fstatSync(guard, { bigint: true }));
  fs.closeSync(guard);
  assert.ok(sameFileMutation(before, opened), "legacy ocean skip input changed before opening");
  let previousKey = null;
  for await (const address of iterateJsonStringArrayProperty(legacyPath, "addresses", {
    maxFileBytes: OCEAN_SKIP_MAX_LINES_BYTES,
    maxStringBytes: OCEAN_SKIP_MAX_ROW_BYTES,
  })) {
    const parsed = parseTerrainAddress(address, legacyPath);
    validateTerrainAddress(parsed.level, parsed.x, parsed.y, legacyPath);
    assert.equal(address, terrainAddress(parsed.level, parsed.x, parsed.y), `legacy ocean address is not canonical: ${address}`);
    const key = addressFactKey(parsed.level, parsed.x, parsed.y);
    assert.ok(previousKey === null || previousKey < key,
      `legacy ocean addresses must be sorted and unique by level/y/x at ${address}`);
    previousKey = key;
    yield address;
  }
  const after = fileMutationSnapshot(fs.lstatSync(legacyPath, { bigint: true }));
  assert.ok(sameFileMutation(before, after), "legacy ocean skip input changed while being read");
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
const verifyReportPath = path.join(outDir, "verify-report.json");
const verifierLease = acquireVerifierLease(outDir);
const releaseVerifierStagingOnExit = () => {
  try { verifierStaging?.release(); } catch {}
  if (!verifierStaging || verifierStaging.released) {
    try { releaseVerifierLease(outDir, verifierLease.value, verifierLease.mutation); } catch {}
  }
};
process.once("exit", releaseVerifierStagingOnExit);
try {
  verifierStaging = acquireVerifierStaging(outDir, verifierLease);
} catch (error) {
  // Keep the fixed lease if bootstrap was interrupted. Its stale-owner path
  // owns the exact directory and is the only code allowed to reclaim it.
  throw error;
}
// A previous successful receipt must never survive a later failed invocation.
fs.rmSync(verifyReportPath, { force: true });
// The unlink is itself a publication-state transition.  A malformed input can
// fail before any later output is renamed, so acknowledge the parent directory
// now rather than relying on an incidental fsync on a success-only path.
fsyncDirectory(outDir);

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
function validatePublicationPolicy(value) {
  if (value === null || value === undefined) return null;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "publicationPolicy must be a JSON object");
  assert.equal(value.format, "terrain-publication-policy-v1", "unsupported publicationPolicy format");
  assert.match(value.globalConfigDigest, /^[a-f0-9]{64}$/, "publicationPolicy.globalConfigDigest must be SHA-256 hex");
  for (const key of ["maxVerifiedStoreBytes", "maxStaticDirectoryBytes"]) {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0, `publicationPolicy.${key} must be a positive safe integer`);
  }
  assert.ok(value.maxVerifiedStoreBytes <= PUBLICATION_LIMITS.maxVerifiedStoreBytes,
    `publicationPolicy.maxVerifiedStoreBytes exceeds ${PUBLICATION_LIMITS.maxVerifiedStoreBytes}`);
  assert.ok(value.maxStaticDirectoryBytes <= PUBLICATION_LIMITS.maxStaticDirectoryBytes,
    `publicationPolicy.maxStaticDirectoryBytes exceeds ${PUBLICATION_LIMITS.maxStaticDirectoryBytes}`);
  assert.ok(value.maxStaticDirectoryBytes >= value.maxVerifiedStoreBytes,
    "publicationPolicy.maxStaticDirectoryBytes must cover maxVerifiedStoreBytes");
  assert.ok(Number.isSafeInteger(value.synthGridSize) && value.synthGridSize >= 2 && value.synthGridSize <= 255,
    "publicationPolicy.synthGridSize must be an integer in [2, 255]");
  return {
    format: value.format,
    globalConfigDigest: value.globalConfigDigest,
    maxVerifiedStoreBytes: value.maxVerifiedStoreBytes,
    maxStaticDirectoryBytes: value.maxStaticDirectoryBytes,
    synthGridSize: value.synthGridSize,
  };
}
function normalizeApprovedPublicationPolicy(value, globalConfigDigest, source) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${source} must be a JSON object`);
  assert.deepEqual(Object.keys(value).sort(), [
    "max_static_directory_bytes",
    "max_verified_store_bytes",
    "static_directory_basis",
    "synthesized_tile_grid_size",
    "version",
  ], `${source} must have exactly the approved snake_case policy keys`);
  assert.equal(value.version, 1, `${source}.version must be 1`);
  assert.ok(typeof value.static_directory_basis === "string" && value.static_directory_basis.length > 0,
    `${source}.static_directory_basis must be a non-empty string`);
  return validatePublicationPolicy({
    format: "terrain-publication-policy-v1",
    globalConfigDigest,
    maxVerifiedStoreBytes: value.max_verified_store_bytes,
    maxStaticDirectoryBytes: value.max_static_directory_bytes,
    synthGridSize: value.synthesized_tile_grid_size,
  });
}
function validateAuthoritativePolicyWrapper(value, approvedPolicy, approvedConfigDigest, source) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${source} publicationPolicy must be a JSON object`);
  assert.deepEqual(Object.keys(value).sort(), ["digest", "globalConfigDigest", "policy"],
    `${source} publicationPolicy must have exactly policy, digest, and globalConfigDigest`);
  assert.deepEqual(value.policy, approvedPolicy, `${source} publicationPolicy does not match approvedConfig.publication_policy`);
  assert.match(value.digest, /^[a-f0-9]{64}$/, `${source} publicationPolicy.digest must be SHA-256 hex`);
  assert.equal(value.digest, sha256(canonicalJson(approvedPolicy)),
    `${source} publicationPolicy.digest does not bind approvedConfig.publication_policy`);
  assert.match(value.globalConfigDigest, /^[a-f0-9]{64}$/, `${source} publicationPolicy.globalConfigDigest must be SHA-256 hex`);
  assert.equal(value.globalConfigDigest, approvedConfigDigest,
    `${source} publicationPolicy.globalConfigDigest does not bind approved-run-config.json`);
  return normalizeApprovedPublicationPolicy(value.policy, value.globalConfigDigest, `${source} publicationPolicy.policy`);
}
function boundedCounterObject(value, name, { maxEntries = 64, integer = false } = {}) {
  if (value === null || value === undefined) return null;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${name} must be a JSON object`);
  const entries = Object.entries(value);
  assert.ok(entries.length <= maxEntries, `${name} has more than ${maxEntries} bounded entries`);
  const compact = {};
  for (const [key, count] of entries) {
    assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(key), `${name} has an unsafe counter key`);
    assert.ok(Number.isFinite(count) && count >= 0 && (!integer || Number.isSafeInteger(count)), `${name}.${key} is not a valid non-negative counter`);
    compact[key] = count;
  }
  return compact;
}
let runReport = null;
if (fs.existsSync(runReportPath)) {
  const { value: parsed } = stableJsonInput(outDir, "run-report.json", MAX_RUN_REPORT_BYTES);
  // Never retain runner detail (notably cellsDetail): verifier decisions use
  // only these compact counters and provenance geometry summaries.  The file
  // cap plus these fixed-size projections prevents a malicious report from
  // becoming a second input-cardinality index in this process.
  runReport = {
    encoderCounters: boundedCounterObject(parsed?.encoderCounters, "encoderCounters", { integer: true }),
    sourcePostsPerTileEdgeByLevel: boundedCounterObject(parsed?.sourcePostsPerTileEdgeByLevel, "sourcePostsPerTileEdgeByLevel"),
    latticeMaxGridSize: parsed?.latticeMaxGridSize ?? null,
    publicationPolicy: parsed?.publicationPolicy ?? null,
    globalConfigDigest: parsed?.globalConfigDigest ?? null,
  };
  if (runReport.latticeMaxGridSize !== null) {
    assert.ok(Number.isSafeInteger(runReport.latticeMaxGridSize) && runReport.latticeMaxGridSize >= 2 && runReport.latticeMaxGridSize <= MAX_MESH_GRID,
      "latticeMaxGridSize is outside the verifier's bounded mesh range");
  }
}
const encoderCounters = runReport?.encoderCounters ?? null;
const globalMergePath = path.join(outDir, "global-merge-report.json");
const globalStatePath = path.join(outDir, "global-build-state.json");
const approvedConfigPath = path.join(outDir, "approved-run-config.json");
const globalVerification = fs.existsSync(globalMergePath)
  || fs.existsSync(globalStatePath)
  || fs.existsSync(approvedConfigPath)
  || runReport?.publicationPolicy != null;
let publicationPolicy = null;
let globalStateInput = null;
let approvedConfigInput = null;
let globalStateMutation = null;
let approvedConfigMutation = null;
let globalMergedRecords = null;
if (globalVerification) {
  assert.ok(fs.existsSync(globalStatePath), "global verification requires global-build-state.json");
  assert.ok(fs.existsSync(approvedConfigPath), "global verification requires approved-run-config.json");
  const stateStable = stableJsonInput(outDir, "global-build-state.json", MAX_RUN_REPORT_BYTES);
  const configStable = stableJsonInput(outDir, "approved-run-config.json", MAX_RUN_REPORT_BYTES);
  globalStateInput = stateStable.receipt;
  approvedConfigInput = configStable.receipt;
  globalStateMutation = stateStable.mutation;
  approvedConfigMutation = configStable.mutation;
  const state = stateStable.value;
  const approvedConfig = configStable.value;
  assert.ok(state && typeof state === "object" && !Array.isArray(state), "global build state must be a JSON object");
  assert.ok(approvedConfig && typeof approvedConfig === "object" && !Array.isArray(approvedConfig),
    "approved run config must be a JSON object");
  assert.equal(state.version, 1, "global build state must be version 1");
  assert.equal(state.completed, true, "global build state must be completed before verification");
  assert.ok(state.merged && typeof state.merged === "object" && !Array.isArray(state.merged),
    "global build state must include merged completion evidence");
  assert.equal(state.merged.completion, "complete", "global merged completion must be complete");
  assert.equal(state.merged.approvedConfigPath, "approved-run-config.json",
    "global merged approvedConfigPath must name approved-run-config.json");
  assert.ok(Number.isSafeInteger(state.merged.records) && state.merged.records >= 0,
    "global merged records must be a non-negative safe integer");
  globalMergedRecords = state.merged.records;
  const canonicalDigest = sha256(canonicalJson(approvedConfig));
  for (const [name, digest] of [["state", state.configDigest], ["merged", state.merged.configDigest]]) {
    assert.match(digest, /^[a-f0-9]{64}$/, `${name} global configDigest must be SHA-256 hex`);
    assert.equal(digest, canonicalDigest, `${name} global configDigest does not bind approved-run-config.json`);
  }
  const approvedPolicy = approvedConfig.publication_policy;
  const normalizedApprovedPolicy = normalizeApprovedPublicationPolicy(approvedPolicy, canonicalDigest, "approvedConfig.publication_policy");
  const statePolicy = validatePublicationPolicy(state.publicationPolicy);
  const mergedPolicy = validatePublicationPolicy(state.merged.publicationPolicy);
  assert.deepEqual(state.publicationPolicy, normalizedApprovedPolicy,
    "global state publicationPolicy must be the exact normalized approved policy");
  assert.deepEqual(state.merged.publicationPolicy, normalizedApprovedPolicy,
    "global merged publicationPolicy must be the exact normalized approved policy");
  assert.deepEqual(statePolicy, normalizedApprovedPolicy,
    "global state publicationPolicy does not match normalized approved policy");
  assert.deepEqual(mergedPolicy, normalizedApprovedPolicy,
    "global merged publicationPolicy does not match normalized approved policy");
  publicationPolicy = normalizedApprovedPolicy;
  assert.equal(publicationPolicy.globalConfigDigest, canonicalDigest,
    "publicationPolicy.globalConfigDigest does not bind approved-run-config.json");
  if (runReport?.publicationPolicy != null) {
    const reportPolicy = validateAuthoritativePolicyWrapper(
      runReport.publicationPolicy, approvedPolicy, canonicalDigest, "run report",
    );
    assert.deepEqual(reportPolicy, normalizedApprovedPolicy,
      "run report publicationPolicy does not match normalized approved policy");
  }
  if (runReport?.globalConfigDigest != null) {
    assert.equal(runReport.globalConfigDigest, canonicalDigest,
      "run report globalConfigDigest does not match approved-run-config.json");
  }
} else if (runReport?.publicationPolicy != null) {
  // Regional runs retain the direct report form because they have no approved
  // global-state/config pair to bind a shard wrapper against.
  publicationPolicy = validatePublicationPolicy(runReport.publicationPolicy);
}

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
const tilesPathBeforeStat = fs.lstatSync(recordsPath, { bigint: true });
assert.ok(tilesPathBeforeStat.isFile(), "tiles.dttstream must be a regular file");
const tilesPathBefore = fileMutationSnapshot(tilesPathBeforeStat);
const tilesFd = fs.openSync(recordsPath, fs.constants.O_RDONLY | NO_FOLLOW);
const tilesIdentityBefore = fileMutationSnapshot(fs.fstatSync(tilesFd, { bigint: true }));
assert.ok(sameFileMutation(tilesPathBefore, tilesIdentityBefore),
  "tiles.dttstream changed before descriptor verification began");
const digestOpenFile = (fd, expectedBytes) => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!read) break;
    position += read;
    assert.ok(position <= expectedBytes, "tiles.dttstream grew while being verified");
    hash.update(buffer.subarray(0, read));
  }
  assert.equal(position, expectedBytes, "tiles.dttstream changed size while being verified");
  return hash.digest("hex");
};
let verifiedTilesSha256 = null;
// These directories are disposable, attempt-scoped external-sort state.  The
// writer and merger each reclaim stale material before use; the successful
// path below removes it too, so a global run never leaves a second tile index.
const edgeFactRunDir = verifierStaging.openScratch("edgeFacts");
const edgeFactScratchDir = verifierStaging.openScratch("edgeMerge");
const edgeFactWriter = createSortedJsonRunWriter(edgeFactRunDir, {
  maxRows: 128,
  maxRowBytes: 64 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxRuns: MAX_EDGE_FACT_RUNS,
  returnManifest: true,
  reset: false,
});
const addressFactRunDir = verifierStaging.openScratch("addressFacts");
const addressFactScratchDir = verifierStaging.openScratch("addressMerge");
const addressFactWriter = createSortedJsonRunWriter(addressFactRunDir, {
  maxRows: 512,
  maxRowBytes: 4096,
  maxBufferedBytes: 1024 * 1024,
  maxRuns: MAX_ADDRESS_FACT_RUNS,
  returnManifest: true,
  reset: false,
});
const sizeFactRunDir = verifierStaging.openScratch("sizeFacts");
const sizeFactScratchDir = verifierStaging.openScratch("sizeMerge");
const sizeFactWriter = createSortedJsonRunWriter(sizeFactRunDir, {
  maxRows: 1024,
  maxRowBytes: 256,
  maxBufferedBytes: 256 * 1024,
  maxRuns: MAX_SIZE_FACT_RUNS,
  returnManifest: true,
  reset: false,
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

const processedTilesHash = createHash("sha256");
try {
for await (const record of iterateStreamFd(tilesFd, { onChunk: (chunk) => processedTilesHash.update(chunk) })) {
  recordCount += 1;
  if (!firstRecord) firstRecord = Buffer.from(record);
  const dtt = readDtt(record);
  validateDtt(dtt, record);
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
    const raw = gunzipBounded(Buffer.from(dtt.waterMask.bytes), MAX_MASK_BYTES, `mask at ${key}`);
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
      const raw = gunzipBounded(Buffer.from(dtt.waterMask.bytes), MAX_MASK_BYTES, `mask at ${key}`);
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
  const mesh = gunzipBounded(bytes, MAX_MESH_BYTES, `mesh at ${key}`);
  const meshStructure = validateMeshStructure(mesh, `mesh at ${key}`);
  const minHeight = mesh.readFloatLE(24);
  const maxHeight = mesh.readFloatLE(28);
  assert.ok(Number.isFinite(minHeight) && Number.isFinite(maxHeight) && minHeight <= maxHeight,
    `mesh header has an invalid height range at ${key}`);
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

  validateMeshWaterMask(meshStructure.waterMask, dtt, key);
  const tileMeshEdges = meshEdges(mesh, dtt, meshStructure);
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
    if (dtt.waterMaskKind === 3) raw = gunzipBounded(Buffer.from(dtt.waterMask.bytes), MAX_MASK_BYTES, `mask at ${key}`);
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
  const streamedDigest = processedTilesHash.digest("hex");
  const afterRead = fileMutationSnapshot(fs.fstatSync(tilesFd, { bigint: true }));
  assert.ok(sameFileMutation(tilesIdentityBefore, afterRead), "tiles.dttstream changed during verification");
  const postDigest = digestOpenFile(tilesFd, tilesIdentityBefore.bytes);
  assert.equal(streamedDigest, postDigest, "tiles.dttstream bytes changed during verification");
  verifiedTilesSha256 = streamedDigest;
} finally {
  const beforeClose = fileMutationSnapshot(fs.fstatSync(tilesFd, { bigint: true }));
  fs.closeSync(tilesFd);
  assert.ok(sameFileMutation(tilesIdentityBefore, beforeClose), "tiles.dttstream changed before close");
}
const tilesPathAfter = fs.lstatSync(recordsPath, { bigint: true });
assert.ok(tilesPathAfter.isFile() && sameFileMutation(tilesIdentityBefore, fileMutationSnapshot(tilesPathAfter)),
  "tiles.dttstream pathname changed after verification");
if (globalVerification) {
  assert.equal(globalMergedRecords, recordCount,
    "global merged records does not match the verified tiles.dttstream record count");
}

const oceanInputEvidence = {};
for await (const address of iterateOceanSkippedAddresses(outDir, oceanSkippedPath, oceanInputEvidence)) {
  const { level, x, y } = parseTerrainAddress(address, oceanSkippedPath);
  validateTerrainAddress(level, x, y, oceanSkippedPath);
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
    resetScratch: false,
  });
} finally {
  verifierStaging.clearScratch("edgeFacts");
  verifierStaging.clearScratch("edgeMerge");
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
    resetScratch: false,
    onRow: async (fact) => {
      if (sizeOrdinal === payloadQuantileIndexes.p50) payloadQuantiles.p50 = fact.bytes;
      if (sizeOrdinal === payloadQuantileIndexes.p99) payloadQuantiles.p99 = fact.bytes;
      if (sizeOrdinal === payloadQuantileIndexes.max) payloadQuantiles.max = fact.bytes;
      sizeOrdinal += 1;
    },
  });
} finally {
  verifierStaging.clearScratch("sizeFacts");
  verifierStaging.clearScratch("sizeMerge");
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
const closureFactRunDir = verifierStaging.openScratch("closureFacts");
const closureFactScratchDir = verifierStaging.openScratch("closureMerge");
const closureFactWriter = createSortedJsonRunWriter(closureFactRunDir, {
  maxRows: 512,
  maxRowBytes: 256,
  maxBufferedBytes: 256 * 1024,
  maxRuns: MAX_CLOSURE_FACT_RUNS,
  returnManifest: true,
  reset: false,
});
const membershipFactRunDir = verifierStaging.openScratch("membershipFacts");
const membershipFactScratchDir = verifierStaging.openScratch("membershipMerge");
const membershipFactWriter = createSortedJsonRunWriter(membershipFactRunDir, {
  maxRows: 512,
  maxRowBytes: 512,
  maxBufferedBytes: 512 * 1024,
  maxRuns: MAX_MEMBERSHIP_FACT_RUNS,
  returnManifest: true,
  reset: false,
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
        key: addressFactKey(ancestorLevel, Math.floor(group.x / 2 ** shift), Math.floor(group.y / 2 ** shift)),
        level: ancestorLevel,
        x: Math.floor(group.x / 2 ** shift),
        y: Math.floor(group.y / 2 ** shift),
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
    resetScratch: false,
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
  verifierStaging.clearScratch("addressFacts");
  verifierStaging.clearScratch("addressMerge");
}

const membershipFactRuns = membershipFactWriter.finish();
const closureFactRuns = closureFactWriter.finish();
const availabilityPath = path.join(outDir, "terrain-available.json");
const availabilityStage = verifierStaging.open("availability");
const availabilityStagedPath = availabilityStage.file;
const candidateFactRunDir = verifierStaging.openScratch("candidateFacts");
const candidateFactScratchDir = verifierStaging.openScratch("candidateMerge");
const candidateFactWriter = createSortedJsonRunWriter(candidateFactRunDir, {
  maxRows: 512, maxRowBytes: 256, maxBufferedBytes: 256 * 1024, maxRuns: MAX_CANDIDATE_FACT_RUNS, returnManifest: true, reset: false,
});
const availableChildFactRunDir = verifierStaging.openScratch("availableChildren");
const availableChildFactWriter = createSortedJsonRunWriter(availableChildFactRunDir, {
  maxRows: 512, maxRowBytes: 256, maxBufferedBytes: 256 * 1024, maxRuns: MAX_AVAILABLE_CHILD_FACT_RUNS, returnManifest: true, reset: false,
});
// Level zero is forced into layer availability even for a one-hemisphere
// regional cut.  It is therefore a serving promise too: seed both roots into
// the disk-backed candidate join so neither can disappear from the static
// materialization worklist merely because no input tile happened to close it.
for (const x of [0, 1]) {
  candidateFactWriter.push({ key: addressFactKey(0, x, 0), kind: "candidate", level: 0, x, y: 0, address: terrainAddress(0, x, 0) });
}
// Availability is an output-sized JSON value.  Keep it on disk while closure
// facts stream through; no verifier decision needs a resident rectangle index.
const availabilityHandle = availabilityStage.handle;
fs.writeSync(availabilityHandle, "[");
let availabilityLevel = -1;
let availabilityLevelOpen = false;
let availabilityLevelRectangles = 0;
let availabilityClosed = false;
let availabilityComplete = false;
const openAvailabilityLevel = (level) => {
  while (availabilityLevel < level) {
    if (availabilityLevelOpen) fs.writeSync(availabilityHandle, "]");
    if (availabilityLevel >= 0) fs.writeSync(availabilityHandle, ",");
    availabilityLevel += 1;
    fs.writeSync(availabilityHandle, "[");
    availabilityLevelOpen = true;
    availabilityLevelRectangles = 0;
  }
};
// Cesium requires a level-zero promise even for an otherwise empty regional
// cut.  Preserve the historical full geographic level-zero rectangle without
// retaining the rest of the availability tree in memory.
openAvailabilityLevel(0);
fs.writeSync(availabilityHandle, JSON.stringify({ startX: 0, startY: 0, endX: 1, endY: 0 }));
availabilityLevelRectangles = 1;
let rectangleLevel = null;
let rectangleY = null;
let rectangleStartX = null;
let rectangleEndX = null;
const flushAvailabilityRectangle = () => {
  if (rectangleLevel === null || rectangleLevel === 0) return;
  openAvailabilityLevel(rectangleLevel);
  if (availabilityLevelRectangles) fs.writeSync(availabilityHandle, ",");
  fs.writeSync(availabilityHandle, JSON.stringify({
    startX: rectangleStartX,
    startY: rectangleY,
    endX: rectangleEndX,
    endY: rectangleY,
  }));
  availabilityLevelRectangles += 1;
  rectangleLevel = null;
  rectangleY = null;
  rectangleStartX = null;
  rectangleEndX = null;
};
try {
  await mergeSortedJsonRuns(closureFactRuns, {
    maxOpenRuns: 32,
    maxRowBytes: 256,
    scratchDir: closureFactScratchDir,
    resetScratch: false,
    onRow: async (fact) => {
      // The legacy verifier's maxLevel is based only on stored records, so an
      // out-of-range skip is reported but cannot widen the published index.
      if (fact.level > maxLevel) return;
      candidateFactWriter.push({ key: fact.key, kind: "candidate", level: fact.level, x: fact.x, y: fact.y, address: terrainAddress(fact.level, fact.x, fact.y) });
      if (fact.level > 0) {
        const bit = (fact.x % 2 ? 2 : 1) | (fact.y % 2 ? 4 : 0);
        availableChildFactWriter.push({ key: addressFactKey(fact.level - 1, Math.floor(fact.x / 2), Math.floor(fact.y / 2)), kind: "available-child", childBit: bit });
      }
      if (fact.level === 0) return;
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
  while (availabilityLevel < maxLevel) openAvailabilityLevel(availabilityLevel + 1);
  if (availabilityLevelOpen) fs.writeSync(availabilityHandle, "]");
  fs.writeSync(availabilityHandle, "]");
  verifierStaging.seal(availabilityStage);
  availabilityClosed = true;
  availabilityComplete = true;
} finally {
  if (!availabilityClosed) fs.closeSync(availabilityHandle);
  if (!availabilityComplete) verifierStaging.discard(availabilityStage);
  verifierStaging.clearScratch("closureFacts");
  verifierStaging.clearScratch("closureMerge");
}
verifierStaging.publish(availabilityStage, availabilityPath);
// This is the exact generated value that layer-json-config.json is allowed to
// embed.  A later stable descriptor copy compares every identity field, not
// merely the size, so an in-place rewrite or an exchanged same-size file cannot
// become a receipted serving configuration.
const availabilityStat = fs.lstatSync(availabilityPath, { bigint: true });
assert.ok(availabilityStat.isFile(), "generated terrain availability is not a regular file");
const generatedAvailabilityMutation = fileMutationSnapshot(availabilityStat);
const availabilityPolicyMaxBytes = publicationPolicy?.maxStaticDirectoryBytes ?? PUBLICATION_LIMITS.maxStaticDirectoryBytes;
assert.ok(generatedAvailabilityMutation.bytes <= availabilityPolicyMaxBytes,
  `generated terrain availability exceeds ${availabilityPolicyMaxBytes} byte publication-policy bound`);

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
// Every closure fact is emitted directly from each declared member for every
// ancestor, then de-duplicated before the streamed rectangles/candidate joins.
// That construction is the parent proof and avoids the former O(rectangles^2)
// in-memory search.

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
const availableButUnstoredStage = verifierStaging.open("availableButUnstored");
const availableButUnstoredStagedPath = availableButUnstoredStage.file;
// The closure check above proves a directly declared address is exactly what
// the serving module sees at its centre.  Enumerating each rectangle therefore
// avoids the former bounding-box scan and repeated all-level rectangle search.
const candidateFactRuns = candidateFactWriter.finish();
const availableChildFactRuns = availableChildFactWriter.finish();
const availableButUnstoredSample = [];
let ancestorPlaceholders = 0;
const unstoredByLevel = {};
let availableButUnstored = 0;
let joinedCandidate = null;
let availableButUnstoredHandle = availableButUnstoredStage.handle;
let availableButUnstoredPublished = false;
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
  // Never truncate a final publication input in place.  In particular, opening
  // a pre-existing symlink with "w" follows it and can corrupt a file outside
  // this run directory.  A same-directory wx stage is complete and durable
  // before rename replaces the final name atomically (without following it).
  await mergeSortedJsonRunSources([candidateFactRuns, membershipFactRuns], {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 512,
    scratchDir: candidateFactScratchDir,
    resetScratch: false,
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
  verifierStaging.seal(availableButUnstoredStage);
  availableButUnstoredHandle = null;
  verifierStaging.publish(availableButUnstoredStage, availableButUnstoredPath);
  availableButUnstoredPublished = true;
} finally {
  if (availableButUnstoredHandle !== null) availableButUnstoredStage.handle = availableButUnstoredHandle;
  if (!availableButUnstoredPublished) verifierStaging.discard(availableButUnstoredStage);
  verifierStaging.clearScratch("candidateFacts");
  verifierStaging.clearScratch("candidateMerge");
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
  await mergeSortedJsonRunSources([membershipFactRuns, availableChildFactRuns], {
    dedupe: false,
    maxOpenRuns: 32,
    maxRowBytes: 512,
    scratchDir: membershipFactScratchDir,
    resetScratch: false,
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
  verifierStaging.clearScratch("membershipFacts");
  verifierStaging.clearScratch("membershipMerge");
  verifierStaging.clearScratch("availableChildren");
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

const availableBytes = generatedAvailabilityMutation.bytes;
const storeBytes = fs.statSync(path.join(outDir, "tiles.dttstream")).size;
if (publicationPolicy) {
  assert.ok(storeBytes <= publicationPolicy.maxVerifiedStoreBytes,
    `tiles.dttstream ${storeBytes} B exceeds approved maxVerifiedStoreBytes ${publicationPolicy.maxVerifiedStoreBytes} B`);
}
const verifierProblemCount = problemCount + edgeFactProblemCount;

const summary = {
  outDir,
  tiles: recordCount,
  distinctAddresses,
  storeBytes,
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
  // Availability is deliberately a separate output-sized artifact.  Keeping
  // it out of verify-report.json lets this operator-facing report remain
  // bounded for a global cut while layer-json-config.json receives the exact
  // streamed bytes the serving module needs.
  layerJson: { maxzoom: maxLevel, extensions: ["watermask"], availabilityPath: path.basename(availabilityPath) },
  publicationPolicy,
  publicationPolicyLegacyUnbound: publicationPolicy === null,
  // null, not 0, when no run report was left beside the store: "nobody counted"
  // and "the count was zero" are different claims.
  encoderCounters,
  problems,
};

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

const layerConfig = {
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
      ...(publicationPolicy ? { terrain_synth_grid_size: publicationPolicy.synthGridSize } : {}),
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
};
if (publicationPolicy) {
  assert.equal(layerConfig.terrain_synth_grid_size, publicationPolicy.synthGridSize,
    "layer config terrain_synth_grid_size must match publication policy");
}
waitForTestReceiptBarrier();
atomicWriteWithRawTopLevelProperty(
  path.join(outDir, "layer-json-config.json"),
  layerConfig,
  "terrain_available",
  availabilityPath,
  {
    expectedMutation: generatedAvailabilityMutation,
    maxBytes: availabilityPolicyMaxBytes,
    label: "generated terrain availability",
  },
  "layerConfig",
);

// Bind the publication lane to the exact bytes this verifier accepted.  The
// report itself stays bounded: it names and hashes output files rather than
// embedding availability or a global address list a second time.
let oceanReceiptInput = null;
let oceanAddressesInput = null;
let oceanLegacyUnbound = true;
if (oceanInputEvidence.oceanReceipt) {
  assert.equal(oceanInputEvidence.oceanAddresses.addresses, oceanSkipsDeclared,
    "streamed ocean receipt address count disagrees with address facts");
  const receiptNow = stablePublicationInput(outDir, "ocean-skipped.json", { maxBytes: OCEAN_SKIP_MAX_RECEIPT_BYTES });
  const addressesNow = stablePublicationInput(outDir, "ocean-skipped.lines", { maxBytes: OCEAN_SKIP_MAX_LINES_BYTES });
  assert.deepEqual(receiptNow.receipt, oceanInputEvidence.oceanReceipt,
    "ocean skip receipt changed after streamed validation");
  assert.ok(sameFileMutation(receiptNow.mutation, oceanInputEvidence.oceanReceiptMutation),
    "ocean skip receipt was modified after streamed validation");
  assert.deepEqual(addressesNow.receipt, {
    path: oceanInputEvidence.oceanAddresses.path,
    bytes: oceanInputEvidence.oceanAddresses.bytes,
    sha256: oceanInputEvidence.oceanAddresses.sha256,
  }, "ocean skip address artifact changed after streamed validation");
  assert.ok(sameFileMutation(addressesNow.mutation, oceanInputEvidence.oceanAddressesMutation),
    "ocean skip address artifact was modified after streamed validation");
  oceanReceiptInput = oceanInputEvidence.oceanReceipt;
  oceanAddressesInput = oceanInputEvidence.oceanAddresses;
  oceanLegacyUnbound = false;
}
if (globalVerification) {
  assert.ok(oceanReceiptInput && oceanAddressesInput && oceanLegacyUnbound === false,
    "global verification requires bound ocean receipt and address artifacts");
  const stateNow = stablePublicationInput(outDir, "global-build-state.json", { maxBytes: MAX_RUN_REPORT_BYTES });
  const configNow = stablePublicationInput(outDir, "approved-run-config.json", { maxBytes: MAX_RUN_REPORT_BYTES });
  assert.deepEqual(stateNow.receipt, globalStateInput, "global build state changed after authoritative policy validation");
  assert.ok(sameFileMutation(stateNow.mutation, globalStateMutation),
    "global build state was modified after authoritative policy validation");
  assert.deepEqual(configNow.receipt, approvedConfigInput, "approved run config changed after authoritative policy validation");
  assert.ok(sameFileMutation(configNow.mutation, approvedConfigMutation),
    "approved run config was modified after authoritative policy validation");
  globalStateInput = stateNow.receipt;
  approvedConfigInput = configNow.receipt;
  globalStateMutation = stateNow.mutation;
  approvedConfigMutation = configNow.mutation;
}
summary.publicationInputs = {
  format: "terrain-publication-inputs-v2",
  tiles: (() => {
    assert.match(verifiedTilesSha256, /^[a-f0-9]{64}$/, "tiles receipt requires the verified stream digest");
    return {
      path: "tiles.dttstream",
      bytes: tilesIdentityBefore.bytes,
      sha256: verifiedTilesSha256,
      records: recordCount,
    };
  })(),
  availableButUnstored: publicationInputReceipt(
    outDir, "available-but-unstored.ndjson", { addresses: availableButUnstored },
    publicationPolicy?.maxStaticDirectoryBytes ?? OCEAN_SKIP_MAX_LINES_BYTES,
  ),
  layerConfig: publicationInputReceipt(
    outDir, "layer-json-config.json", {}, publicationPolicy?.maxStaticDirectoryBytes ?? OCEAN_SKIP_MAX_LINES_BYTES,
  ),
  oceanReceipt: oceanReceiptInput,
  oceanAddresses: oceanAddressesInput,
  globalState: globalStateInput,
  approvedConfig: approvedConfigInput,
  oceanLegacyUnbound,
};
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
atomicWriteJson(
  path.join(outDir, "mount-entry.json"),
  {
      "//": "flows.mounts[] entry keys for config.module-delivery-sidecar.yaml. `memory_pages` is a SIBLING of `config:`, never a member of it; the module config keys live in layer-json-config.json and go INSIDE `config:`.",
      path: "/api/v1/terrain/",
      flow: "com.digitalarsenal.flows.terrain-serving",
      memory_pages: memoryPagesFor(availableBytes),
      "// pool": memoryPagesAdvice(availableBytes),
  },
  "mountEntry",
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
summary.format = "terrain-verification-report-v1";
summary.publishable = true;
atomicWriteJson(verifyReportPath, summary, "verifyReport");
verifierStaging.release();
releaseVerifierLease(outDir, verifierLease.value, verifierLease.mutation);
process.removeListener("exit", releaseVerifierStagingOnExit);
if (args.json) console.log(JSON.stringify(summary, null, 2));
else console.log(JSON.stringify(summary, null, 2));
console.log("\nPUBLISHABLE: every bound met.");
