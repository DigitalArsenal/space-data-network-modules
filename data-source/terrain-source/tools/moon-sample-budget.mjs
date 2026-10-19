// THE MOON LANE'S SIZE, PROJECTED BEFORE IT IS BUILT (moon-terrain-lane-20261013).
//
// Runs the real lane on local copies of the PDS LOLA products: terrain-ingest:body_plan enumerates every unit of the
// walk, each request it makes is answered from the local files as the PDS server answers it (label 200, image ranges
// 206 with Content-Range; If-Match required but its value not checked, lola-frames.mjs localResponse), and
// terrain-source:tile encodes the SAMPLED tiles of each unit with
// the production options (normals, the density ladder, the 32 KiB ceiling, gzip). Levels 0-4 are encoded whole; every
// deeper level gets 1,000 tiles stratified by tile row (proportional allocation, at least 2 a row, seeded by
// sha256("moon-terrain-sample-v1")).
//
// Per tile the cost is its stored $DTT record plus its 4-byte size prefix in the packed file. A level's total is the
// sum over its rows of N_h x the row's mean; the 95% upper bound adds 1.96 sqrt(sum N_h^2 (1 - n_h/N_h) s_h^2 / n_h).
// The encoder's report gives each tile's RMS and residual histogram against the source posts, so a level's RMS and
// p99 are exact over its sampled tiles; "over cap" is a tile the 32 KiB ceiling stopped before it met its error target.
// If the upper bound passes 1.6 GB the caps are narrowed from the per-row means, no re-encode, in the order the lane
// gives up least: north L9 to 85, north L8 to 80, south L8 to 78, south L9 to 82, then south L10 a degree at a time.
//
// Usage: LOLA_DIR=~/software/data/lola node tools/moon-sample-budget.mjs [out.json]
// (The peak RSS it prints is this tool's, which holds the whole walk's plans; one unit's encode is measured by
// tools/moon-unit.mjs.)

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBodyLane } from "./body-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR ?? path.join(os.homedir(), "software/data/lola");
const OUT = process.argv[2];
const BUDGET = 1.6e9;
const SAMPLES = 1000;
const FULL_LEVELS = 4;
const RESIDUAL_OVERFLOW_BIN = 8192;  // terrain-source kResidualHistogramBins - 1
let peakRss = 0;
const rss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

// ── 1. the sample ───────────────────────────────────────────────────────────
function rng(seedText) {
  let seed = createHash("sha256").update(seedText).digest().readUInt32LE(0);
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(units) {
  const rows = new Map();  // `${level}/${y}` -> [{x, unit}]
  for (const u of units) for (const h of u.headers) {
    const key = `${h.level}/${h.y}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: h.x, unit: u.index });
  }
  const byLevel = new Map();
  for (const [key, tiles] of rows) {
    const level = Number(key.split("/")[0]);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push({ y: Number(key.split("/")[1]), tiles });
  }
  const random = rng("moon-terrain-sample-v1");
  const chosen = new Set();
  const strata = [];
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const levelRows = byLevel.get(level).sort((a, b) => a.y - b.y);
    const N = levelRows.reduce((n, r) => n + r.tiles.length, 0);
    for (const r of levelRows) {
      const Nh = r.tiles.length;
      const nh = level <= FULL_LEVELS ? Nh : Math.min(Nh, Math.max(2, Math.round((SAMPLES * Nh) / N)));
      const pool = [...r.tiles].sort((a, b) => a.x - b.x);
      for (let i = 0; i < nh; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
        chosen.add(`${level}/${pool[i].x}/${r.y}`);
      }
      strata.push({ level, y: r.y, N: Nh, keys: pool.slice(0, nh).map((t) => `${level}/${t.x}/${r.y}`) });
    }
  }
  return { chosen, strata };
}

// ── 2. encode the sample, unit by unit ──────────────────────────────────────
async function encodeUnit(lane, unit, keep) {
  if (!unit.headers.some((h) => keep(`${h.level}/${h.x}/${h.y}`))) return [];
  const { response, ms, byKey, report } = await lane.encode(unit, keep);
  rss();
  if (response.statusCode !== 0) throw new Error(`unit ${unit.index}: ${response.errorCode}: ${response.errorMessage}`);
  return report.tiles.map((t) => ({ ...t, key: `${t.level}/${t.x}/${t.y}`, bytes: byKey.get(`${t.level}/${t.x}/${t.y}`).length, ms: ms / report.tiles.length }));
}

// ── 3. per-level statistics and the projection ──────────────────────────────
function histogramOf(text) {
  const h = new Map();
  for (const pair of String(text ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split(":").map(Number);
    h.set(k, v);
  }
  return h;
}

function levelStats(level, strata, tiles) {
  let total = 0, variance = 0, n = 0, N = 0, overCap = 0, probes = 0, sumSq = 0, worst = 0, ms = 0;
  const hist = new Map();
  for (const s of strata.filter((x) => x.level === level)) {
    const bytes = s.keys.map((k) => tiles.get(k).bytes);
    const nh = bytes.length, mean = bytes.reduce((a, b) => a + b, 0) / nh;
    const s2 = nh > 1 ? bytes.reduce((a, b) => a + (b - mean) ** 2, 0) / (nh - 1) : 0;
    total += s.N * mean;
    variance += nh < s.N ? (s.N ** 2 * (1 - nh / s.N) * s2) / nh : 0;
    n += nh;
    N += s.N;
    for (const k of s.keys) {
      const t = tiles.get(k);
      if (t.overCap) overCap++;
      probes += t.accuracyProbes;
      sumSq += t.rmsM ** 2 * t.accuracyProbes;
      worst = Math.max(worst, t.verticalAccuracyM);
      ms += t.ms;
      for (const [b, c] of histogramOf(t.residualHistogramM)) hist.set(b, (hist.get(b) ?? 0) + c);
    }
  }
  // The bin's upper edge, metres; in the encoder's last (overflow) bin it is only a lower bound, and says so.
  let acc = 0, p99 = null, p99Floor = false;
  for (const b of [...hist.keys()].sort((a, c) => a - c)) {
    acc += hist.get(b);
    if (p99 === null && acc >= 0.99 * probes) { p99 = b + 1; p99Floor = b === RESIDUAL_OVERFLOW_BIN; }
  }
  return {
    level, tiles: N, sampled: n, totalBytes: total, upper95: total + 1.96 * Math.sqrt(variance),
    meanBytes: total / N, overCapShare: overCap / n, rmsM: Math.sqrt(sumSq / probes), p99M: p99, p99Floor, worstM: worst,
    probes, msPerTile: ms / n,
  };
}

// The caps after narrowing, applied to the per-row means (rows are tile rows; a row survives when its whole extent
// lies inside the narrowed band).
const RECAP = [
  { name: "north L9 to >= 85", level: 9, north: true, limit: 85 },
  { name: "north L8 to >= 80", level: 8, north: true, limit: 80 },
  { name: "south L8 to >= 78", level: 8, north: false, limit: 78 },
  { name: "south L9 to >= 82", level: 9, north: false, limit: 82 },
  ...[86, 87, 88, 89].map((limit) => ({ name: `south L10 to >= ${limit}`, level: 10, north: false, limit })),
];

function rowSurvives(level, y, steps) {
  const size = 180 / 2 ** level, south = -90 + y * size, north = south + size;
  for (const s of steps) {
    if (s.level !== level) continue;
    if (s.north && south >= 0 && south < s.limit) return false;
    if (!s.north && north <= 0 && -north < s.limit) return false;
  }
  return true;
}

function projection(strata, tiles, steps) {
  let total = 0, variance = 0;
  for (const s of strata) {
    if (!rowSurvives(s.level, s.y, steps)) continue;
    const bytes = s.keys.map((k) => tiles.get(k).bytes);
    const nh = bytes.length, mean = bytes.reduce((a, b) => a + b, 0) / nh;
    const s2 = nh > 1 ? bytes.reduce((a, b) => a + (b - mean) ** 2, 0) / (nh - 1) : 0;
    total += s.N * mean;
    variance += nh < s.N ? (s.N ** 2 * (1 - nh / s.N) * s2) / nh : 0;
  }
  return { total, upper95: total + 1.96 * Math.sqrt(variance) };
}

async function main() {
  const t0 = performance.now();
  const lane = await createBodyLane({ dataDir: LOLA_DIR });
  const units = [];
  for (let i = 0; ; i++) {
    const u = await lane.planUnit(i);
    if (!u) break;
    units.push(u);
    rss();
  }
  console.log(`walk: ${units.length} units, ${units.reduce((n, u) => n + u.headers.length, 0)} tiles`);
  const { chosen, strata } = sample(units);
  const tiles = new Map();
  for (const u of units) {
    for (const t of await encodeUnit(lane, u, (k) => chosen.has(k))) tiles.set(t.key, t);
  }
  lane.destroy();
  const levels = [...new Set(strata.map((s) => s.level))].sort((a, b) => a - b).map((l) => levelStats(l, strata, tiles));
  const base = projection(strata, tiles, []);
  const applied = [];
  let current = base;
  for (const step of RECAP) {
    if (current.upper95 <= BUDGET) break;
    applied.push(step);
    current = projection(strata, tiles, applied);
  }
  const result = {
    generatedAt: new Date().toISOString(),
    units: units.length,
    levels,
    projectedBytes: base.total,
    projectedUpper95Bytes: base.upper95,
    recap: applied.map((s) => s.name),
    recappedBytes: current.total,
    recappedUpper95Bytes: current.upper95,
    peakRssBytes: peakRss,
    seconds: (performance.now() - t0) / 1000,
    // Per sampled tile: level, x, y, stored bytes, shipped grid, RMS (m), worst (m), over cap.
    tiles: [...tiles.values()].map((t) => [t.level, t.x, t.y, t.bytes, t.gridSize, +t.rmsM.toFixed(3), +t.verticalAccuracyM.toFixed(2), t.overCap ? 1 : 0]),
  };
  for (const l of levels) {
    console.log(`L${l.level}: ${l.tiles} tiles (${l.sampled} encoded), mean ${l.meanBytes.toFixed(0)} B, total ` +
      `${(l.totalBytes / 1e6).toFixed(1)} MB (95% <= ${(l.upper95 / 1e6).toFixed(1)}), RMS ${l.rmsM.toFixed(2)} m, ` +
      `p99 ${l.p99Floor ? ">= " : ""}${l.p99M} m, worst ${l.worstM.toFixed(1)} m, over cap ${(100 * l.overCapShare).toFixed(1)}%, ${l.msPerTile.toFixed(0)} ms/tile`);
  }
  console.log(`total ${(base.total / 1e9).toFixed(3)} GB (95% <= ${(base.upper95 / 1e9).toFixed(3)} GB); ` +
    `re-cap [${result.recap.join("; ")}] -> ${(current.total / 1e9).toFixed(3)} GB (95% <= ${(current.upper95 / 1e9).toFixed(3)} GB); ` +
    `peak RSS ${(peakRss / 2 ** 20).toFixed(0)} MiB, ${result.seconds.toFixed(0)} s`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
}

await main();
