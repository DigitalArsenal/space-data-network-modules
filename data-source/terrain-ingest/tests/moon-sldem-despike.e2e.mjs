// THE PUBLISHED MOON RELIEF WITHOUT SLDEM2015'S BAD LOLA SHOTS (terrain/301 version lola-sldem2015-despike-v2-20261024;
// moon-relief-hadley-pit-20261024). SLDEM2015_512 inherits isolated bad LOLA shots: posts tens to hundreds of metres
// off the surface, one or two posts wide. terrain-source removes them (body_despike.hpp); read back as the console
// reads it:
//   1. Hadley (26.128-26.152 N at 3.5873 E): the level-10 relief along the profile is within 6 m of the 5 m LROC NAC
//      DTM APOLLO15_2 (mean over each 59 m post), and nowhere in 26.12-26.16 N, 3.56-3.61 E more than 15 m below it.
//      Before: a pit 93 m below the DTM (SLDEM2015 150 m below), drawn as a hard dark streak at 4 km.
//   2. At the scan's worst SLDEM2015_512 spikes and pits (300-620 m off their 5x5 median), the published relief is
//      within 25 m of its 5x5 median; over 0.35 x 0.35 degrees at Apollo 11, 15 and 17 no post is more than 40 m off it.
// Published files are read from terrain.spacedatanetwork.org, or first from TERRAIN_301_DIR (a local
// <dir>/terrain/301 tree, to check an encode before it is published). The NAC DTM is a checksummed fixture of its PDS
// image lines (tests/fixtures/nac-dtm-apollo15-2-hadley.json: product LIDVID, label md5, lines and samples).

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
const VERSION = process.env.TERRAIN_301_VERSION ?? "lola-sldem2015-despike-v2-20261024";
const LOCAL = process.env.TERRAIN_301_DIR;

async function get(url, headers = {}) {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { headers }).catch(() => null);
    if (r && (r.status === 200 || r.status === 206)) return Buffer.from(await r.arrayBuffer());
    if (k >= 4) throw new Error(`${url}: ${r?.status}`);
    await new Promise((s) => setTimeout(s, 1500 * (k + 1)));
  }
}
async function file(name) {
  const local = LOCAL && path.join(LOCAL, "terrain/301", name);
  if (local && fs.existsSync(local)) return fs.readFileSync(local);
  // A local check reads published files at the PREVIOUS version: asking the edge for an unpublished version would
  // cache the old bytes under the new version's key.
  return get(`${BASE}/${name}?v=${LOCAL ? process.env.TERRAIN_301_PREVIOUS ?? "lola-sldem2015-pole-axis-v1-20261023" : VERSION}`);
}

test("the published MANIFEST names this version", { timeout: 5 * 60 * 1000, skip: Boolean(LOCAL) }, async () => {
  const manifest = JSON.parse((await file("MANIFEST.json")).toString("utf8"));
  assert.equal(manifest.version, VERSION);
});

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
const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };
/** |z - median of its 5x5| on a rows x cols grid, NaN within 2 posts of the edge. */
function residual5(z, rows, cols) {
  const r = new Float64Array(rows * cols).fill(NaN);
  for (let i = 2; i < rows - 2; i++) for (let j = 2; j < cols - 2; j++) {
    const v = [];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) v.push(z[(i + a) * cols + j + b]);
    r[i * cols + j] = Math.abs(z[i * cols + j] - median(v));
  }
  return r;
}

test("Hadley: the level-10 relief is the NAC DTM's flat mare, not SLDEM2015's 150 m pit", { timeout: 20 * 60 * 1000 }, async () => {
  // The DTM's lines over the box: a checksummed fixture (fixtures/nac-dtm-apollo15-2-hadley.json names the PDS product,
  // its label's md5 and the image lines and samples it holds), not a live PDS read.
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/nac-dtm-apollo15-2-hadley.json", import.meta.url), "utf8"));
  const buf = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/nac-dtm-apollo15-2-hadley.f32.gz", import.meta.url)));
  assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), fx.fixture.sha256_raw, "fixture checksum");
  const { north, south, west, east } = fx.bounding;
  const dlat = (north - south) / fx.file_lines, dlon = (east - west) / fx.file_samples;
  const l0 = fx.fixture.first_line, s0 = fx.fixture.first_sample, samples = fx.fixture.samples;
  /** The DTM's mean over the 59 m post centred on (lat, lon). */
  const nac = (lat, lon) => {
    const h = 1 / 1024, vals = [];
    for (let i = Math.ceil((north - lat - h) / dlat - 0.5); i <= Math.floor((north - lat + h) / dlat - 0.5); i++)
      for (let j = Math.ceil((lon - h - west) / dlon - 0.5); j <= Math.floor((lon + h - west) / dlon - 0.5); j++) {
        const v = buf.readFloatLE(((i - l0) * samples + (j - s0)) * 4);
        if (v > -1e30) vals.push(v);
      }
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  // The box 26.12-26.16 N, 3.56-3.61 E on a 1/1024 degree grid.
  const st = 1 / 1024, latTop = 26.16, lonLeft = 3.56, rows = Math.round(0.04 / st), cols = Math.round(0.05 / st);
  const pub = await relief(latTop, lonLeft, rows, cols, st);
  let worstBelow = 0, profileWorst = 0;
  const col = Math.floor((3.5873 - lonLeft) / st), prof = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const lat = latTop - (i + 0.5) * st, lon = lonLeft + (j + 0.5) * st, d = pub[i * cols + j] - nac(lat, lon);
    worstBelow = Math.min(worstBelow, d);
    if (j === col && lat >= 26.128 && lat <= 26.152) { profileWorst = Math.max(profileWorst, Math.abs(d)); prof.push(`${lat.toFixed(4)}:${d.toFixed(1)}`); }
  }
  console.log(`hadley profile (published - NAC, m) ${prof.join(" ")}; worst |d| ${profileWorst.toFixed(1)} m; box worst below ${worstBelow.toFixed(1)} m`);
  assert.ok(profileWorst <= 6, `profile within 6 m of the NAC DTM (worst ${profileWorst.toFixed(1)} m)`);
  assert.ok(worstBelow >= -15, `nothing in the box more than 15 m below the NAC DTM (worst ${worstBelow.toFixed(1)} m)`);
});

// The SLDEM2015_512 posts the scan found furthest off their 5x5 median (moon-relief-hadley-pit-20261024 scan, m).
const SPOTS = [
  [25.6885, 38.0537, -604], [26.2139, 41.8018, -547], [26.4639, 41.8115, 548], [0.7549, 5.2705, -349],
  [1.1377, 34.8564, -323], [-43.4092, -30.2549, -620], [-43.0244, -12.7861, -394], [-3.958, -1.2803, -435],
  [-2.7236, -40.8662, 402], [-3.6377, -15.0635, -320],
];
test("the scan's worst SLDEM2015 spikes and pits are gone", { timeout: 20 * 60 * 1000 }, async () => {
  const st = 1 / 512, n = 15;
  for (const [lat, lon, was] of SPOTS) {
    const i = Math.round((90 - lat) * 512 - 0.5), j = Math.round((lon + 180) * 512 - 0.5);
    const latTop = 90 - (i - 7) / 512, lonLeft = -180 + (j - 7) / 512;
    const r = residual5(await relief(latTop, lonLeft, n, n, st), n, n);
    const worst = Math.max(...r.filter(Number.isFinite));
    console.log(`spot ${lat} ${lon} (SLDEM2015 ${was} m): published worst |z - 5x5 median| ${worst.toFixed(1)} m`);
    assert.ok(worst <= 25, `spot ${lat} ${lon}: ${worst.toFixed(1)} m <= 25 m`);
  }
});

for (const [name, lat, lon] of [["apollo-11", 0.674, 23.473], ["apollo-15", 26.132, 3.634], ["apollo-17", 20.191, 30.772]]) {
  test(`${name}: no post more than 40 m off its 5x5 median`, { timeout: 20 * 60 * 1000 }, async () => {
    const st = 1 / 512, n = Math.round(0.35 * 512);
    const r = residual5(await relief(lat + 0.175, lon - 0.175, n, n, st), n, n);
    const over = r.filter((v) => v > 40).length;
    console.log(`${name}: ${over} posts more than 40 m off their 5x5 median (max ${Math.max(...r.filter(Number.isFinite)).toFixed(1)} m)`);
    assert.equal(over, 0);
  });
}
