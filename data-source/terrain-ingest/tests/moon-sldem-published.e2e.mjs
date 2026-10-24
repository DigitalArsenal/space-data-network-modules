// THE PUBLISHED MOON RELIEF (terrain/301 on R2, version lola-sldem2015-pole-axis-v1-20261023; moon-terrain-wall-banding-
// 20261023 + body-terrain-pole-normals-encoder-20261023), read back as the console reads it:
//   1. MANIFEST.json names the version and credits LOLA and SELENE/Kaguya TC (Barker et al. 2016); SHA256SUMS hashes to
//      the MANIFEST's sha256sums_sha256 and lists every file; a sample of files hashes to its SHA256SUMS line.
//   2. Crater walls inside 59 degrees carry SLDEM2015, not LDEM_512's north-south track facets: the level-10 meshes over
//      Bessel (21.74 N, 18.01 E) and Dawes (17.21 N, 26.33 E), rasterized on the 512 px/deg grid, sit within 1.5 m
//      (median) of SLDEM2015_512 and at most a quarter of their median distance from LDEM_512, with an east-west to
//      north-south second-difference ratio (p90) at most 2 (LDEM_512 there: 7-8).
//   3. Every pole-edge post of every polar tile in the root file has the body's axis as its normal (within 3 degrees).
// The products' lines come from PDS by byte range; nothing is cached between runs.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import zlib from "node:zlib";

import { splitSized, dttOf } from "../../terrain-source/tools/body-lane.mjs";
import { decodeEdgeMatchedPlanes } from "../../terrain-source/tools/edge-matched-planes.mjs";
import { decodeQuantizedMesh } from "../../terrain-source/tests/helpers.mjs";

const BASE = "https://terrain.spacedatanetwork.org/terrain/301";
const VERSION = "lola-sldem2015-pole-axis-v1-20261023";
const PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data";

async function get(url, headers = {}) {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { headers }).catch(() => null);
    if (r && (r.status === 200 || r.status === 206)) return Buffer.from(await r.arrayBuffer());
    if (k >= 4) throw new Error(`${url}: ${r?.status}`);
    await new Promise((s) => setTimeout(s, 1500 * (k + 1)));
  }
}
const file = (name) => get(`${BASE}/${name}?v=${VERSION}`);
/** The tiles of one published file: key "L/X/Y" -> decoded quantized mesh. */
function tilesOf(gz) {
  const out = new Map();
  for (const s of splitSized(zlib.gunzipSync(gz))) {
    const t = dttOf(s.subarray(4)).unpack();
    out.set(`${t.LEVEL}/${t.X}/${t.Y}`, decodeQuantizedMesh(decodeEdgeMatchedPlanes(t.PAYLOAD.BYTES)));
  }
  return out;
}

test("MANIFEST, SHA256SUMS and a file sample agree", { timeout: 20 * 60 * 1000 }, async () => {
  const manifest = JSON.parse((await file("MANIFEST.json")).toString("utf8"));
  assert.equal(manifest.version, VERSION);
  assert.match(manifest.credit, /LOLA/);
  assert.match(manifest.credit, /SELENE\/Kaguya Terrain Camera/);
  assert.match(manifest.credit, /Barker et al\. 2016/);
  const sums = await file("SHA256SUMS");
  assert.equal(crypto.createHash("sha256").update(sums).digest("hex"), manifest.format.sha256sums_sha256);
  const lines = sums.toString("utf8").trim().split("\n").map((l) => l.split("  "));
  assert.equal(lines.length, manifest.total_files);
  // 40 files spread over the list (every level), each hashing to its line.
  const step = Math.floor(lines.length / 40);
  for (let i = 0; i < lines.length; i += step) {
    const [hash, key] = lines[i];
    const bytes = await get(`https://terrain.spacedatanetwork.org/${key}?v=${VERSION}`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), hash, key);
  }
});

const L = 10, DEG = 180 / 1024, ST = 1 / 512, N = 360;
async function pdsGrid(url, maxLat, recordBytes, latTop, lonLeft) {
  const line0 = Math.round((maxLat - latTop) * 512), sample0 = Math.round(lonLeft * 512);
  const buf = await get(url, { Range: `bytes=${line0 * recordBytes}-${(line0 + N) * recordBytes - 1}` });
  const z = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) z[i * N + j] = buf.readFloatLE(i * recordBytes + (sample0 + j) * 4) * 1000;
  return z;
}
async function published(latTop, lonLeft) {
  const H = new Float64Array(N * N).fill(NaN), files = new Map();
  const x0 = Math.floor((lonLeft + 180) / DEG), x1 = Math.floor((lonLeft + N * ST + 180) / DEG);
  const y0 = Math.floor((latTop - N * ST + 90) / DEG), y1 = Math.floor((latTop + 90) / DEG);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const name = `${L}/${x >> 2}_${y >> 2}.dtts.gz`;
    if (!files.has(name)) files.set(name, tilesOf(await file(name)));
    const m = files.get(name).get(`${L}/${x}/${y}`);
    const q = (m.header.maxHeight - m.header.minHeight) / 32767, w = -180 + x * DEG, s = -90 + y * DEG;
    const lo = m.u.map((u) => w + (u / 32767) * DEG), la = m.v.map((v) => s + (v / 32767) * DEG), h = m.h.map((k) => m.header.minHeight + k * q);
    for (let k = 0; k < m.indices.length; k += 3) {
      const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]];
      const det = (lo[b] - lo[a]) * (la[c] - la[a]) - (lo[c] - lo[a]) * (la[b] - la[a]);
      if (!det) continue;
      const r0 = Math.max(0, Math.floor((latTop - Math.max(la[a], la[b], la[c])) / ST - 0.5)), r1 = Math.min(N - 1, Math.ceil((latTop - Math.min(la[a], la[b], la[c])) / ST - 0.5));
      const c0 = Math.max(0, Math.floor((Math.min(lo[a], lo[b], lo[c]) - lonLeft) / ST - 0.5)), c1 = Math.min(N - 1, Math.ceil((Math.max(lo[a], lo[b], lo[c]) - lonLeft) / ST - 0.5));
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
        const py = latTop - (r + 0.5) * ST, px = lonLeft + (cc + 0.5) * ST;
        const l1 = ((px - lo[a]) * (la[c] - la[a]) - (lo[c] - lo[a]) * (py - la[a])) / det;
        const l2 = ((lo[b] - lo[a]) * (py - la[a]) - (px - lo[a]) * (la[b] - la[a])) / det;
        if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
        H[r * N + cc] = (1 - l1 - l2) * h[a] + l1 * h[b] + l2 * h[c];
      }
    }
  }
  return H;
}
const quantile = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
/** p90 over columns of the per-column median |E-W second difference|, over the same for rows (N-S). */
function anisotropy(z) {
  const kink = (at, d) => Math.abs(z[at + d] - z[at] - 0.5 * ((z[at] - z[at - d]) + (z[at + 2 * d] - z[at + d])));
  const cols = [], rows = [];
  for (let j = 1; j < N - 2; j++) { const v = []; for (let i = 0; i < N; i++) v.push(kink(i * N + j, 1)); cols.push(quantile(v, 0.5)); }
  for (let i = 1; i < N - 2; i++) { const v = []; for (let j = 0; j < N; j++) v.push(kink(i * N + j, N)); rows.push(quantile(v, 0.5)); }
  return quantile(cols, 0.9) / quantile(rows, 0.9);
}

for (const [name, c] of Object.entries({ bessel: { lat: 21.74, lon: 18.01 }, dawes: { lat: 17.21, lon: 26.33 } })) {
  test(`${name}: the level-10 wall is SLDEM2015, not LDEM_512's track facets`, { timeout: 20 * 60 * 1000 }, async () => {
    const latTop = Math.ceil((c.lat + 0.35) * 512) / 512, lonLeft = Math.floor((c.lon - 0.35) * 512) / 512;
    const [sldem, ldem, pub] = await Promise.all([
      pdsGrid(`${PDS}/sldem2015/tiles/float_img/sldem2015_512_00n_30n_000_045_float.img`, 30, 92160, latTop, lonLeft),
      pdsGrid(`${PDS}/lola_gdr/cylindrical/float_img/ldem_512_00n_45n_000_090_float.img`, 45, 184320, latTop, lonLeft),
      published(latTop, lonLeft),
    ]);
    const toS = [], toL = [];
    for (let k = 0; k < N * N; k++) if (Number.isFinite(pub[k])) { toS.push(Math.abs(pub[k] - sldem[k])); toL.push(Math.abs(pub[k] - ldem[k])); }
    assert.ok(toS.length > 0.99 * N * N, `${name}: the published meshes cover the grid`);
    const dS = quantile(toS, 0.5), dL = quantile(toL, 0.5), an = anisotropy(pub), anL = anisotropy(ldem);
    console.log(`${name}: median |published - SLDEM2015| ${dS.toFixed(2)} m, |published - LDEM_512| ${dL.toFixed(2)} m; anisotropy published ${an.toFixed(2)}, LDEM_512 ${anL.toFixed(2)}`);
    assert.ok(dS <= 1.5, `${name}: median |published - SLDEM2015| ${dS} m <= 1.5 m`);
    assert.ok(dS <= 0.25 * dL, `${name}: published is SLDEM2015 (${dS} m), not LDEM_512 (${dL} m)`);
    assert.ok(an <= 2, `${name}: east-west/north-south anisotropy ${an} <= 2 (LDEM_512 ${anL})`);
  });
}

test("the root file's pole-edge posts carry the axis normal", { timeout: 10 * 60 * 1000 }, async () => {
  const oct = (x, y) => {
    let fx = (x / 255) * 2 - 1, fy = (y / 255) * 2 - 1;
    const z = 1 - Math.abs(fx) - Math.abs(fy);
    if (z < 0) { const ox = fx; fx = (1 - Math.abs(fy)) * Math.sign(ox || 1); fy = (1 - Math.abs(ox)) * Math.sign(fy || 1); }
    const l = Math.hypot(fx, fy, z);
    return [fx / l, fy / l, z / l];
  };
  let posts = 0, worst = 0;
  for (const [key, m] of tilesOf(await file("root.dtts.gz"))) {
    const [level, , y] = key.split("/").map(Number);
    const rows = 1 << level;
    if (y !== 0 && y !== rows - 1) continue;
    const normals = m.extensions.find((e) => e.id === 1).bytes;
    for (let i = 0; i < m.vertexCount; i++) {
      const sign = y === rows - 1 && m.v[i] === 32767 ? 1 : y === 0 && m.v[i] === 0 ? -1 : 0;
      if (!sign) continue;
      const n = oct(normals[2 * i], normals[2 * i + 1]);
      worst = Math.max(worst, (Math.acos(Math.min(1, sign * n[2])) * 180) / Math.PI);
      posts++;
    }
  }
  console.log(`root: ${posts} pole-edge posts, worst ${worst.toFixed(2)} deg from the axis`);
  assert.ok(posts > 0 && worst <= 3, `worst ${worst} deg`);
});
