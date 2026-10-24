// THE PUBLISHED MOON RELIEF WITHOUT SLDEM2015'S NORTH-SOUTH TRACK STRIPES (terrain/301; moon-terrain-destripe-20261024).
// SLDEM2015 carries thin north-south lines along the ground tracks (a few columns a few meters off their east-west
// neighbors, drifting along the track); draped over relief and seen obliquely they read as curved lines on slopes and
// crater floors. terrain-source removes them (body_destripe.hpp) from sldem2015_128/256/512, levels 8-10 inside 59 deg.
// Read back as the console reads it, at level 10 on the 1/512 degree post grid:
//   1. Stripe anisotropy: per column, the median over rows of the east-west second difference |kink|; per row, the same
//      north-south. p90 over columns / p90 over rows is at most MAX_ANISOTROPY at Bessel, Dawes, Hadley, two mare and
//      two highland boxes (0.25 x 0.25 degrees). Before (lola-sldem2015-despike-v2-20261024): 1.3-2.1x.
//   2. A north-south feature keeps its relief: across Rupes Recta (21.65-21.85 S near 7.7 W) the median per-row step
//      between the plateaus either side of the scarp is within 5% of what the despike-v2 publish drew (and of
//      SLDEM2015_512's 380 m).
//   3. Every file read matches its line in the published SHA256SUMS, whose sha256 the MANIFEST names.
// The Hadley NAC DTM profile and the despike checks stay in moon-sldem-despike.e2e.mjs, run on the same version.
// Published files are read from terrain.spacedatanetwork.org, or first from TERRAIN_301_DIR (a local
// <dir>/terrain/301 tree, to check an encode before it is published).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { splitSized, dttOf } from "../../terrain-source/tools/body-lane.mjs";
import { decodeEdgeMatchedPlanes } from "../../terrain-source/tools/edge-matched-planes.mjs";
import { decodeQuantizedMesh } from "../../terrain-source/tests/helpers.mjs";

const BASE = "https://terrain.spacedatanetwork.org/terrain/301";
const VERSION = process.env.TERRAIN_301_VERSION ?? "lola-sldem2015-destripe-v1-20261024";
const LOCAL = process.env.TERRAIN_301_DIR;
const MAX_ANISOTROPY = 1.1;

async function get(url) {
  for (let k = 0; ; k++) {
    const r = await fetch(url).catch(() => null);
    if (r && r.status === 200) return Buffer.from(await r.arrayBuffer());
    if (k >= 4) throw new Error(`${url}: ${r?.status}`);
    await new Promise((s) => setTimeout(s, 1500 * (k + 1)));
  }
}
const read = new Map();
async function file(name) {
  const local = LOCAL && path.join(LOCAL, "terrain/301", name);
  if (local && fs.existsSync(local)) return fs.readFileSync(local);
  // A local check reads published files at the PREVIOUS version: asking the edge for an unpublished version would
  // cache the old bytes under the new version's key.
  const b = await get(`${BASE}/${name}?v=${LOCAL ? process.env.TERRAIN_301_PREVIOUS ?? "lola-sldem2015-despike-v2-20261024" : VERSION}`);
  read.set(name, b);
  return b;
}

const L = 10, DEG = 180 / 1024;
const meshes = new Map();
async function mesh(x, y) {
  const name = `${L}/${x >> 2}_${y >> 2}.dtts.gz`;
  if (!meshes.has(name)) {
    const tiles = new Map();
    for (const s of splitSized(zlib.gunzipSync(await file(name)))) {
      const t = dttOf(s.subarray(4)).unpack();
      tiles.set(`${t.X}/${t.Y}`, decodeQuantizedMesh(decodeEdgeMatchedPlanes(t.PAYLOAD.BYTES)));
    }
    meshes.set(name, tiles);
  }
  return meshes.get(name).get(`${x}/${y}`);
}
/** The level-10 meshes rasterized (linear in each triangle) on rows x cols posts of st degrees from (latTop, lonLeft). */
async function relief(latTop, lonLeft, rows, cols, st) {
  const H = new Float64Array(rows * cols).fill(NaN);
  const x0 = Math.floor((lonLeft + 180) / DEG), x1 = Math.floor((lonLeft + cols * st + 180) / DEG);
  const y0 = Math.floor((latTop - rows * st + 90) / DEG), y1 = Math.floor((latTop + 90) / DEG);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const m = await mesh(x, y);
    const q = (m.header.maxHeight - m.header.minHeight) / 32767, w = -180 + x * DEG, s = -90 + y * DEG;
    const lo = m.u.map((u) => w + (u / 32767) * DEG), la = m.v.map((v) => s + (v / 32767) * DEG), h = m.h.map((k) => m.header.minHeight + k * q);
    for (let k = 0; k < m.indices.length; k += 3) {
      const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]];
      const det = (lo[b] - lo[a]) * (la[c] - la[a]) - (lo[c] - lo[a]) * (la[b] - la[a]);
      if (!det) continue;
      const r0 = Math.max(0, Math.floor((latTop - Math.max(la[a], la[b], la[c])) / st - 0.5)), r1 = Math.min(rows - 1, Math.ceil((latTop - Math.min(la[a], la[b], la[c])) / st - 0.5));
      const c0 = Math.max(0, Math.floor((Math.min(lo[a], lo[b], lo[c]) - lonLeft) / st - 0.5)), c1 = Math.min(cols - 1, Math.ceil((Math.max(lo[a], lo[b], lo[c]) - lonLeft) / st - 0.5));
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
        const py = latTop - (r + 0.5) * st, px = lonLeft + (cc + 0.5) * st;
        const l1 = ((px - lo[a]) * (la[c] - la[a]) - (lo[c] - lo[a]) * (py - la[a])) / det;
        const l2 = ((lo[b] - lo[a]) * (py - la[a]) - (px - lo[a]) * (la[b] - la[a])) / det;
        if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
        H[r * cols + cc] = (1 - l1 - l2) * h[a] + l1 * h[b] + l2 * h[c];
      }
    }
  }
  return H;
}
const median = (v) => { const s = Float64Array.from(v).sort(), m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };
const pct = (v, p) => { const s = Float64Array.from(v).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
/** p90 over columns of the median over rows of |E-W kink|, and the same north-south (the claude-banding stripe metric). */
function kinks(z, rows, cols) {
  const at = (i, j) => z[i * cols + j];
  const col = [], row = [];
  for (let j = 1; j < cols - 1; j++) { const v = []; for (let i = 0; i < rows; i++) v.push(Math.abs(at(i, j + 1) - 2 * at(i, j) + at(i, j - 1))); col.push(median(v)); }
  for (let i = 1; i < rows - 1; i++) { const v = []; for (let j = 0; j < cols; j++) v.push(Math.abs(at(i + 1, j) - 2 * at(i, j) + at(i - 1, j))); row.push(median(v)); }
  return { ew: pct(col, 0.9), ns: pct(row, 0.9) };
}

const SITES = [
  ["bessel", 21.74, 18.01], ["dawes", 17.2, 26.35], ["hadley", 26.10, 3.65],
  ["mare-tranquillitatis", 0.67, 23.47], ["mare-imbrium", 35.0, -19.0],
  ["highland-descartes", -8.97, 15.5], ["highland-tycho", -43.3, -11.0],
];
for (const [name, lat, lon] of SITES) {
  test(`${name}: no north-south stripes (E-W/N-S kink p90 <= ${MAX_ANISOTROPY})`, { timeout: 20 * 60 * 1000 }, async () => {
    const st = 1 / 512, n = 128;
    const z = await relief(lat + 0.125, lon - 0.125, n, n, st);
    assert.ok(z.every(Number.isFinite), `${name}: every post drawn`);
    const k = kinks(z, n, n), an = k.ew / k.ns;
    console.log(`${name}: E-W kink p90 ${k.ew.toFixed(2)} m, N-S ${k.ns.toFixed(2)} m, anisotropy ${an.toFixed(2)}x`);
    assert.ok(an <= MAX_ANISOTROPY, `${name}: anisotropy ${an.toFixed(2)}x <= ${MAX_ANISOTROPY}`);
  });
}

// Rupes Recta: the plateau step across the scarp, per 1/512 degree row (the despike-v2 publish drew 381.3 m).
const RECTA_BEFORE_M = 381.3;
test("Rupes Recta keeps its relief (a north-south scarp is not a stripe)", { timeout: 20 * 60 * 1000 }, async () => {
  const st = 1 / 512, rows = 100, cols = 160, latTop = -21.65, lonLeft = 352.31 - 360 - 80 / 512;
  const z = await relief(latTop, lonLeft, rows, cols, st);
  const steps = [], slopes = [];
  const dx = (Math.PI / 180) * st * 1737400 * Math.cos((21.75 * Math.PI) / 180);
  for (let i = 0; i < rows; i++) {
    let best = 0, k = 0;
    for (let j = 25; j < cols - 26; j++) { const g = Math.abs(z[i * cols + j + 1] - z[i * cols + j]); if (g > best) { best = g; k = j; } }
    const mean = (a, b) => { let s = 0; for (let j = a; j < b; j++) s += z[i * cols + j]; return s / (b - a); };
    steps.push(Math.abs(mean(k - 25, k - 10) - mean(k + 10, k + 25)));
    slopes.push((Math.atan(best / dx) * 180) / Math.PI);
  }
  const step = median(steps), slope = median(slopes);
  console.log(`rupes recta: plateau step ${step.toFixed(1)} m (before ${RECTA_BEFORE_M}), peak slope ${slope.toFixed(1)} deg`);
  assert.ok(step >= 330, `scarp relief ${step.toFixed(1)} m >= 330 m`);
  if (Number.isFinite(RECTA_BEFORE_M)) assert.ok(Math.abs(step - RECTA_BEFORE_M) <= 0.05 * RECTA_BEFORE_M, `within 5% of ${RECTA_BEFORE_M} m`);
});

test("the MANIFEST names this version and every file read matches its SHA256SUMS line", { timeout: 10 * 60 * 1000, skip: Boolean(LOCAL) }, async () => {
  const manifest = JSON.parse((await get(`${BASE}/MANIFEST.json?v=${VERSION}`)).toString("utf8"));
  assert.equal(manifest.version, VERSION);
  const sums = await get(`${BASE}/SHA256SUMS?v=${VERSION}`);
  assert.equal(crypto.createHash("sha256").update(sums).digest("hex"), manifest.format.sha256sums_sha256, "SHA256SUMS is the MANIFEST's");
  const ledger = new Map(sums.toString("utf8").split("\n").filter(Boolean).map((l) => { const [h, k] = l.split("  "); return [k, h]; }));
  // Make sure the anisotropy tests' files are in hand even if this test runs alone.
  for (const [, lat, lon] of SITES) await relief(lat + 0.125, lon - 0.125, 128, 128, 1 / 512);
  let checked = 0;
  for (const [name, b] of read) {
    assert.equal(crypto.createHash("sha256").update(b).digest("hex"), ledger.get(`terrain/301/${name}`), `${name} matches the ledger`);
    checked++;
  }
  console.log(`ledger: ${checked} files read match SHA256SUMS (${ledger.size} entries)`);
  assert.ok(checked >= 7);
});
