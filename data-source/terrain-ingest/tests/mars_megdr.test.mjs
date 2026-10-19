// MARS, ON THE REAL LANE (mars-terrain-mola-ingest-20261019): the built terrain-ingest:body_plan (config body mars)
// plans the walk, its requests are answered from local copies of the NASA MGS MOLA MEGDR files (public domain) exactly
// as the PDS server answers them, and the built terrain-source:tile encodes them. Every height is checked against an
// independent reading of the PDS files written here from their labels, not from the module:
//   megr*hb / gb / fb / eb / cb (SIMPLE CYLINDRICAL): MSB int16, radius = DN + 3,396,000 m; line 1 of a file is centred
//   on MAXIMUM_LATITUDE - 0.5/ppd, sample 1 on WESTERNMOST_LONGITUDE + 0.5/ppd (east-positive, planetocentric);
//   megr_{n,s}_512 (POLAR STEREOGRAPHIC): big-endian float32 radius - 3,396,000 m, r = 2 R tan(colat/2) at
//   R pi / 180 / 512 m per pixel about the centre post (N + 1)/2 (1-based).
//
// Needs MOLA_DIR (default ~/software/data/mola) holding megr90n000cb, every meg128 megr*hb and megr_n_512 (.img and
// .lbl) from https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/. A missing file FAILS: this is
// the change's end-to-end check, not an optional extra.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { decodeQuantizedMesh } from "../../terrain-source/tests/helpers.mjs";
import { createBodyLane, dttOf, MARS_CONFIG } from "../../terrain-source/tools/body-lane.mjs";

const MOLA_DIR = process.env.MOLA_DIR ?? path.join(os.homedir(), "software/data/mola");
const R = 3396000;
const L8 = 180 / 256;  // level-8 tile size, degrees

// ── the independent reader ──────────────────────────────────────────────────
function cylFile(name) {
  const file = path.join(MOLA_DIR, `${name}.img`);
  assert.ok(fs.existsSync(file), `${file} is missing (see the header for the files this check reads)`);
  const label = fs.readFileSync(path.join(MOLA_DIR, `${name}.lbl`), "utf8");
  const num = (k) => Number(label.match(new RegExp(`^\\s*${k}\\s*=\\s*([-0-9.]+)`, "m"))[1]);
  const fd = fs.openSync(file, "r");
  const n = num("LINE_SAMPLES"), ppd = num("MAP_RESOLUTION"), cache = new Map();
  const line = (j) => {
    if (!cache.has(j)) {
      const buf = Buffer.alloc(n * 2);
      fs.readSync(fd, buf, 0, buf.length, j * n * 2);
      cache.set(j, buf);
    }
    return cache.get(j);
  };
  return { n, lines: num("LINES"), ppd, maxLat: num("MAXIMUM_LATITUDE"), west: num("WESTERNMOST_LONGITUDE"), at: (j, i) => line(j).readInt16BE(i * 2) };
}
const MEG128 = ["88n", "44n", "00n", "44s"].flatMap((b) => ["000", "090", "180", "270"].map((w) => `megr${b}${w}hb`));
let files128;
// Radius - 3,396,000 m at (lat, lon E) by bilinear over the 128 ppd posts, across file boundaries and the 0/360 wrap.
function megr128(lat, lon) {
  files128 ??= MEG128.map(cylFile);
  const ppd = 128, gl = (90 - lat) * ppd - 0.5, gs = ((((lon % 360) + 360) % 360) * ppd) - 0.5;
  const post = (j, i) => {
    i = ((i % (360 * ppd)) + 360 * ppd) % (360 * ppd);
    for (const f of files128) {
      const lj = j - (90 - f.maxLat) * ppd, li = i - f.west * ppd;
      if (lj >= 0 && lj < f.lines && li >= 0 && li < f.n) return f.at(lj, li);
    }
    throw new Error(`no 128 ppd file holds global post ${j},${i}`);
  };
  const j0 = Math.floor(gl), i0 = Math.floor(gs), fy = gl - j0, fx = gs - i0;
  return (1 - fy) * ((1 - fx) * post(j0, i0) + fx * post(j0, i0 + 1)) + fy * ((1 - fx) * post(j0 + 1, i0) + fx * post(j0 + 1, i0 + 1));
}
let north512;
function polar512(lat, lon) {
  if (!north512) {
    const file = path.join(MOLA_DIR, "megr_n_512.img");
    assert.ok(fs.existsSync(file), `${file} is missing`);
    north512 = { fd: fs.openSync(file, "r"), n: 12288, cache: new Map() };
  }
  const { fd, n, cache } = north512;
  const at = (j, i) => {
    if (!cache.has(j)) {
      const buf = Buffer.alloc(n * 4);
      fs.readSync(fd, buf, 0, buf.length, j * n * 4);
      cache.set(j, buf);
    }
    return cache.get(j).readFloatBE(i * 4);
  };
  const scale = (R * Math.PI) / 180 / 512, c = n / 2 - 0.5;
  const r = (2 * R * Math.tan(((90 - lat) * Math.PI) / 360)) / scale, a = (lon * Math.PI) / 180;
  const s = c + r * Math.sin(a), l = c + r * Math.cos(a);
  const i0 = Math.floor(s), j0 = Math.floor(l), fx = s - i0, fy = l - j0;
  return (1 - fy) * ((1 - fx) * at(j0, i0) + fx * at(j0, i0 + 1)) + fy * ((1 - fx) * at(j0 + 1, i0) + fx * at(j0 + 1, i0 + 1));
}

// ── decoded tiles ───────────────────────────────────────────────────────────
function tileOf(sized) {
  const t = dttOf(sized.subarray(4)).unpack();
  return { t, mesh: decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(t.PAYLOAD.BYTES))) };
}
// Vertices on the tile's 321-post lattice (every candidate density divides 320 intervals), heights above the sphere.
function vertices({ t, mesh }) {
  const out = [];
  for (let i = 0; i < mesh.vertexCount; i++) {
    const col = Math.round((mesh.u[i] / 32767) * 320), row = Math.round((mesh.v[i] / 32767) * 320);
    const lon = t.WEST_DEG + (col / 320) * (t.EAST_DEG - t.WEST_DEG);
    const lat = t.SOUTH_DEG + (row / 320) * (t.NORTH_DEG - t.SOUTH_DEG);
    const h = mesh.header.minHeight + (mesh.h[i] / 32767) * (mesh.header.maxHeight - mesh.header.minHeight);
    out.push({ lon, lat, h, u: mesh.u[i], v: mesh.v[i] });
  }
  return out;
}
const quantum = (mesh) => (mesh.header.maxHeight - mesh.header.minHeight) / 32767;
// Seeded, so a failure names the same posts on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

let lane;
const units = [];
test.before(async () => {
  lane = await createBodyLane({ dataDir: MOLA_DIR, config: MARS_CONFIG });
  for (let i = 0; ; i++) {
    const u = await lane.planUnit(i);
    if (!u) break;
    units.push(u);
  }
});
test.after(() => lane?.destroy());

const l8 = (lat, lon) => ({ level: 8, x: Math.floor((lon + 180) / L8), y: Math.floor((lat + 90) / L8) });
const unitOf = ({ level, x, y }) => units.find((u) => u.headers.some((h) => h.level === level && h.x === x && h.y === y));

test("the walk: 385 units, every tile of levels 0-8 once, the polar caps at 9-10, at most 16 requests a unit", () => {
  assert.equal(units.length, 385);
  const seen = new Map();
  for (const u of units) {
    assert.ok(u.requests.length >= 2 && u.requests.length <= 16, `unit ${u.index}: ${u.requests.length} requests`);
    assert.ok(u.requests[0].url.endsWith(".lbl"), `unit ${u.index} starts with a label`);
    for (const r of u.requests) assert.ok(r.url.endsWith(".lbl") || (r.headers.range && r.headers["if-match"]), r.url);
    for (const h of u.headers) {
      const key = `${h.level}/${h.x}/${h.y}`;
      assert.ok(!seen.has(key), `${key} planned twice`);
      seen.set(key, u.index);
    }
  }
  for (let level = 0; level <= 8; level++) {
    const count = [...seen.keys()].filter((k) => k.startsWith(`${level}/`)).length;
    assert.equal(count, 2 * 4 ** level, `level ${level}`);
  }
  // Level 9 beyond 78.75 degrees and level 10 beyond 84.375: 32 tile rows a pole each.
  assert.equal([...seen.keys()].filter((k) => k.startsWith("9/")).length, 2 * 32 * 1024);
  assert.equal([...seen.keys()].filter((k) => k.startsWith("10/")).length, 2 * 32 * 2048);
});

test("the source convention: the 128 ppd post at 87 N 0.5 E (its north-west corner) is radius 3,375,202 m", () => {
  // Line 128, sample 64 of megr88n000hb (0-based): centred on 86.99609375 N, 0.50390625 E.
  assert.equal(R + megr128(87 - 0.5 / 128, 0.5 + 0.5 / 128), 3375202);
});

// One encoded unit, its tiles' vertices against the independent reader.
async function checkUnit(name, address, truth, { samples = 1000, seed = 1 } = {}) {
  const unit = unitOf(address);
  assert.ok(unit, `${name}: no unit plans ${JSON.stringify(address)}`);
  const keep = (k) => {
    const [level, x, y] = k.split("/").map(Number);
    return level === address.level && Math.abs(y - address.y) <= 1 && Math.abs(x - address.x) <= 2;
  };
  const { response, byKey } = await lane.encode(unit, keep);
  assert.equal(response.statusCode, 0, `${name}: ${response.errorCode} ${response.errorMessage}`);
  const tiles = [...byKey.values()].map(tileOf);
  const all = tiles.flatMap((tile) => vertices(tile).map((v) => ({ ...v, q: quantum(tile.mesh) })));
  const next = rng(seed);
  let worst = 0;
  for (let k = 0; k < samples; k++) {
    const v = all[Math.floor(next() * all.length)];
    const d = Math.abs(v.h - truth(v.lat, v.lon));
    worst = Math.max(worst, d - v.q);
    assert.ok(d <= 1 + v.q, `${name}: vertex ${v.lat.toFixed(5)},${v.lon.toFixed(5)} is ${v.h.toFixed(2)} m, MEGDR ${truth(v.lat, v.lon).toFixed(2)} m`);
  }
  return { tiles, all, worst };
}

// The highest (lowest) vertex of the encoded tiles against the source's own extreme post over the same extent: the
// mesh is decimated to its RMS target, so a summit or a pit may sit a few tens of metres off its post.
function sourceExtreme(tiles, pick) {
  let best = pick === Math.max ? -Infinity : Infinity;
  for (const { t } of tiles)
    for (let lat = t.SOUTH_DEG + 0.5 / 128; lat < t.NORTH_DEG; lat += 1 / 128)
      for (let lon = t.WEST_DEG + 0.5 / 128; lon < t.EAST_DEG; lon += 1 / 128) best = pick(best, megr128(lat, lon));
  return best;
}

test("Olympus Mons: 1,000 vertices equal MEGDR 128 ppd within 1 m; the summit ~21.4 km above the sphere, as MEGDR's", async () => {
  const { tiles, all } = await checkUnit("Olympus Mons", l8(18.65, -133.8), megr128, { seed: 7 });
  const top = Math.max(...all.map((v) => v.h)), source = sourceExtreme(tiles, Math.max);
  assert.ok(top > 21000 && top < 21500 && Math.abs(top - source) <= 100, `highest vertex ${top} m, MEGDR ${source} m`);
});

test("Hellas: 1,000 vertices equal MEGDR within 1 m; the floor's low point as MEGDR's", async () => {
  const { tiles, all } = await checkUnit("Hellas", l8(-42.4, 70.5), megr128, { seed: 11 });
  const low = Math.min(...all.map((v) => v.h)), source = sourceExtreme(tiles, Math.min);
  assert.ok(Math.abs(low - source) <= 100, `lowest vertex ${low} m, MEGDR ${source} m`);
});

test("87 N, a block row reading the 88-44 N files, and the 0/360 meridian: vertices equal MEGDR within 1 m", async () => {
  await checkUnit("87 N 0.5 E", l8(87, 0.5), megr128, { seed: 13 });
  await checkUnit("44 N at 90 E", l8(43.9, 90.1), megr128, { seed: 17 });
});

test("the north polar cap (level 10, MEGDR 512 ppd): vertices equal the polar product within 1 m", async () => {
  const size = 180 / 1024;
  await checkUnit("north cap", { level: 10, x: Math.floor((45 + 180) / size), y: Math.floor((88 + 90) / size) }, polar512, { seed: 19 });
});

test("seams: neighbours across the 270 E file boundary and the antimeridian carry identical edge posts", async () => {
  for (const [lat, west, east] of [[18.4, l8(18.4, -90.2).x, l8(18.4, -89.8).x], [18.4, 511, 0]]) {
    const y = l8(lat, 0).y;
    // Each tile from its own unit: the antimeridian pair lies in different 64-block runs of the row.
    const one = async (x) => {
      const { byKey } = await lane.encode(unitOf({ level: 8, x, y }), (k) => k === `8/${x}/${y}`);
      return vertices(tileOf(byKey.get(`8/${x}/${y}`)));
    };
    const a = (await one(west)).filter((v) => v.u === 32767).sort((p, q) => p.v - q.v);
    const b = (await one(east)).filter((v) => v.u === 0).sort((p, q) => p.v - q.v);
    assert.deepEqual(a.map((v) => v.v), b.map((v) => v.v), `8/${west}/${y} | 8/${east}/${y}: edge posts differ`);
    a.forEach((v, i) => assert.ok(Math.abs(v.h - b[i].h) <= 0.5, `edge height ${v.h} vs ${b[i].h}`));
  }
});
