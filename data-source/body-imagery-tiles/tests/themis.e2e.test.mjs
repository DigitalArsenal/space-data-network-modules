// MARS THEMIS DAY IR TILES, END TO END (mars-themis-imagery-module-20261019).
//
// The module (tiles_plan / tiles_direct / tiles_reduce, run through the SDK harness exactly as tools/encode.mjs runs it)
// against the USGS mosaic read an independent way: GDAL reads the source's own pixels (gdal_translate -srcwin over
// /vsicurl) and its own georeference (gdalinfo -json), and this file computes the expected tile from them with its own
// float64 area average. Checked:
//   - the BigTIFF header and strip offsets state the module's table (width, height, contiguous 1-row strips, ETag);
//   - 24 sampled level-9 tiles (seeded) against the independent tile: SSIM mean >= 0.98, each >= 0.95;
//   - 20 IAU features (planetocentric, east longitude): the level-9 tile holding each is registered with the
//     independent tile within one level-9 pixel (best integer shift 0,0; parabolic peak < 0.5 px);
//   - every file is a size-prefixed $DTT stream of GEOGRAPHIC_TWO_ROOT_BODY image/jpeg tiles, named as imageryFromTileFiles
//     reads them (imagery/499/9/<x/16>_<row from south>.dtts), 16 tiles each, NORTH/SOUTH/WEST/EAST consistent;
//   - a level-8 tile is the 2 x 2 mean of its four level-9 tiles (SSIM >= 0.95);
//   - byte-identical output at any worker count: the same row encoded by two instances is the same bytes.
// With THEMIS_VERIFY_R2=1 (and THEMIS_R2_LEDGER=<ledger.jsonl>, R2_AWS=<command running aws against the bucket>) the
// published bucket is checked: root.dtts holds the 42 tiles of levels 0-2, every ledger file present in imagery/499/ with its bytes and sha256 metadata, the
// MANIFEST.json counts, and a HEAD of https://terrain.spacedatanetwork.org/imagery/499/root.dtts with
// Origin https://spaceaware.io answering 200 + Access-Control-Allow-Origin.
// Needs gdal_translate, gdalinfo and ffmpeg on PATH, network (about 1.5 GB of ranged reads).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import jpeg from "jpeg-js";

import { dttTilingScheme, fetchRows, openRunner, readFile, SOURCE } from "../tools/unit-runner.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "themis-e2e-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const log = (s) => console.log(`# ${s}`);
const VSI = `/vsicurl/${SOURCE.url}`;
const GDAL_ENV = process.env;
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

// 20 IAU-named features: [name, planetocentric latitude, east longitude].
const FEATURES = [
  ["Olympus Mons", 18.65, 226.2], ["Arsia Mons", -8.35, 239.9], ["Pavonis Mons", 0.8, 247.0], ["Ascraeus Mons", 11.8, 255.5],
  ["Elysium Mons", 24.8, 146.9], ["Alba Mons", 40.5, 250.4], ["Gale", -5.4, 137.8], ["Jezero", 18.38, 77.58],
  ["Huygens", -13.8, 55.5], ["Lyot", 50.5, 29.3], ["Gusev", -14.5, 175.4], ["Eberswalde", -24.3, 326.3],
  ["Holden", -26.4, 325.9], ["Nili Patera", 8.7, 67.3], ["Hale", -35.7, 323.4], ["Victoria", -2.05, 354.5],
  ["Nicholson", 0.3, 195.2], ["Korolev", 73.2, 196.5], ["Cassini", 23.4, 328.1], ["Herschel", -14.5, 130.1],
];

// ── the independent read ───────────────────────────────────────────────────
const info = JSON.parse(execFileSync("gdalinfo", ["-json", VSI], { env: GDAL_ENV, maxBuffer: 1 << 24 }).toString());
const [X0, PX, , Y0, , PY] = info.geoTransform;
const WKT = info.coordinateSystem.wkt;
const RADIUS = Number(WKT.match(/ELLIPSOID\["[^"]*",\s*([0-9.]+)/)?.[1] ?? NaN);
const LON0 = Number(WKT.match(/"Longitude of natural origin",\s*([0-9.-]+)/)?.[1] ?? NaN);
const M_PER_DEG = (RADIUS * Math.PI) / 180;
// Source pixel (fractional, edges at integers) of a planetocentric latitude and east longitude (0..360).
const srcCol = (lonE) => (((lonE - LON0) * M_PER_DEG) - X0) / PX;
const srcRow = (lat) => (lat * M_PER_DEG - Y0) / PY;

let windows = 0;
function sourceWindow(col0, row0, w, h) {
  const f = path.join(scratch, `w${windows++}.bil`);
  execFileSync("gdal_translate", ["-q", "-of", "EHdr", "-srcwin", String(col0), String(row0), String(w), String(h), VSI, f], { env: GDAL_ENV });
  const px = fs.readFileSync(f);
  fs.rmSync(f);
  return px;
}
// n columns from `start` (the mosaic wraps: its 213390 columns span 360 degrees), rows [row0, row0 + h), row-major.
function sourceColumns(start, n, row0, h) {
  const W = info.size[0], s = ((start % W) + W) % W, first = Math.min(n, W - s);
  const a = sourceWindow(s, row0, first, h);
  if (first === n) return a;
  const b = sourceWindow(0, row0, n - first, h), out = Buffer.alloc(n * h);
  for (let r = 0; r < h; r++) { a.copy(out, r * n, r * first, (r + 1) * first); b.copy(out, r * n + first, r * (n - first), (r + 1) * (n - first)); }
  return out;
}
// The expected level-9 tile (x, y from the NORTH): the mean of the measured source pixels each output pixel overlaps.
function expectedTile(x, yNorth) {
  const W = 512 << 9, step = 360 / W, e = 180 / (256 << 9);
  const lonW = -180 + x * 256 * step, latN = 90 - yNorth * 256 * e;
  const colA = Math.floor(srcCol(lonW < 0 ? lonW + 360 : lonW)) - 1, colN = Math.ceil((256 * step * M_PER_DEG) / PX) + 3;
  const rowA = Math.max(0, Math.floor(srcRow(latN)) - 1), rowB = Math.min(info.size[1], Math.ceil(srcRow(latN - 256 * e)) + 1);
  const px = sourceColumns(colA, colN, rowA, rowB - rowA);
  const out = Buffer.alloc(256 * 256);
  for (let r = 0; r < 256; r++) {
    const va = srcRow(latN - r * e), vb = srcRow(latN - (r + 1) * e);
    for (let c = 0; c < 256; c++) {
      const lonA = lonW + c * step, ca0 = srcCol(lonA < 0 ? lonA + 360 : lonA), ca = ca0 - Math.floor(ca0) + (Math.floor(ca0) - colA), cb = ca + (step * M_PER_DEG) / PX;
      let sum = 0, wt = 0;
      for (let j = Math.floor(va); j < vb; j++) {
        const wr = Math.min(vb, j + 1) - Math.max(va, j);
        if (wr <= 0 || j < rowA || j >= rowB) continue;
        for (let i = Math.floor(ca); i < cb; i++) {
          const wc = Math.min(cb, i + 1) - Math.max(ca, i);
          if (wc <= 0) continue;
          const v = px[(j - rowA) * colN + i];
          if (v) { sum += wr * wc * v; wt += wr * wc; }
        }
      }
      out[r * 256 + c] = wt > 0 ? Math.max(1, Math.min(255, Math.round(sum / wt))) : 0;
    }
  }
  return out;
}
function gray(jpg) {
  const img = jpeg.decode(Buffer.from(jpg), { useTArray: true, formatAsRGBA: true });
  assert.equal(img.width, 256);
  assert.equal(img.height, 256);
  const out = Buffer.alloc(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = img.data[4 * i];
  return out;
}
function ssim(a, b) {
  const fa = path.join(scratch, "a.gray"), fb = path.join(scratch, "b.gray");
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  const args = (f) => ["-f", "rawvideo", "-pix_fmt", "gray", "-s", "256x256", "-i", f];
  const r = spawnSync("ffmpeg", ["-hide_banner", ...args(fa), ...args(fb), "-lavfi", "ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(r.stderr.match(/All:([0-9.]+)/)[1]);
}
// The sub-pixel shift (dx, dy) of b against a: best integer shift within +/- 3, refined by a parabola through the peak.
function shiftOf(a, b, r = 3) {
  const corr = (dx, dy) => {
    let sa = 0, sb = 0, n = 0;
    for (let y = r; y < 256 - r; y++) for (let x = r; x < 256 - r; x++) { sa += a[y * 256 + x]; sb += b[(y + dy) * 256 + x + dx]; n++; }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let y = r; y < 256 - r; y++) for (let x = r; x < 256 - r; x++) {
      const u = a[y * 256 + x] - ma, v = b[(y + dy) * 256 + x + dx] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    return num / Math.sqrt(da * db);
  };
  let best = { dx: 0, dy: 0, c: -Infinity };
  for (let dy = -r + 1; dy <= r - 1; dy++) for (let dx = -r + 1; dx <= r - 1; dx++) { const c = corr(dx, dy); if (c > best.c) best = { dx, dy, c }; }
  const peak = (m, c, p) => { const d = m - 2 * c + p; return d === 0 ? 0 : (0.5 * (m - p)) / d; };
  const sx = peak(corr(best.dx - 1, best.dy), best.c, corr(best.dx + 1, best.dy)), sy = peak(corr(best.dx, best.dy - 1), best.c, corr(best.dx, best.dy + 1));
  return { dx: best.dx, dy: best.dy, fx: best.dx + sx, fy: best.dy + sy };
}

const runner = await openRunner();
test.after(() => runner.destroy());
const rowCache = new Map();
async function levelNine(row) {  // row from the south: the 64 files
  if (!rowCache.has(row)) {
    const { request, unit } = await runner.plan(row);
    const { status, body } = await fetchRows(request);
    rowCache.set(row, await runner.direct(unit, status, body));
  }
  return rowCache.get(row);
}
const tileOf = (files, x, row) => {
  const name = `imagery/499/9/${Math.floor(x / 16)}_${row}.dtts`;
  const file = files.find((f) => f.name === name);
  assert.ok(file, `${name} was made`);
  const t = readFile(file.bytes).find((r) => r.X() === x);
  assert.ok(t && t.LEVEL() === 9 && t.Y() === row, `${name} holds 9/${x}/${row}`);
  return t;
};

test("the source's header states the module's table", async () => {
  assert.deepEqual(info.size, [SOURCE.width, SOURCE.height]);
  assert.equal(info.bands[0].type, "Byte");
  assert.equal(RADIUS, 3396190);
  assert.equal(LON0, 180);
  assert.equal(PX, 100);
  assert.equal(PY, -100);
  const head = await fetch(SOURCE.url, { method: "HEAD" });
  const { request } = await runner.plan(0);
  assert.equal(request.headers["if-match"] ?? request.headers["If-Match"], head.headers.get("etag"), "the module pins the edition's ETag");
  // BigTIFF: the StripOffsets array (tag 273) states row r at strip0 + r * width, contiguous.
  const get = async (a, n) => Buffer.from((await fetchRows({ url: SOURCE.url, headers: { range: `bytes=${a}-${a + n - 1}` } })).body);
  const h = await get(0, 4096);
  assert.equal(h.readUInt16LE(2), 43);
  const ifd = Number(h.readBigUInt64LE(8)), n = Number(h.readBigUInt64LE(ifd));
  let at = 0, count = 0;
  for (let k = 0; k < n; k++) {
    const e = ifd + 8 + 20 * k;
    if (h.readUInt16LE(e) === 273) { at = Number(h.readBigUInt64LE(e + 12)); count = Number(h.readBigUInt64LE(e + 4)); }
  }
  assert.equal(count, SOURCE.height);
  const arr = await get(at, 8 * count);
  for (let r = 0; r < count; r++) assert.equal(Number(arr.readBigUInt64LE(8 * r)), SOURCE.strip0 + r * SOURCE.width, `strip ${r}`);
});

test("24 sampled level-9 tiles match the independent read (SSIM mean >= 0.98)", { timeout: 3600_000 }, async () => {
  const next = rng(22), scores = [];
  let bytes = 0;
  while (scores.length < 24) {
    const row = 40 + Math.floor(next() * 432), x = 20 + Math.floor(next() * 984);  // |lat| < 80, off the seam
    const files = await levelNine(row);
    const t = tileOf(files, x, row);
    const mine = gray(t.PAYLOAD().bytesArray()), ref = expectedTile(x, 511 - row);
    if (ref.every((v) => v === 0)) continue;
    const s = ssim(mine, ref);
    scores.push(s);
    bytes += t.PAYLOAD().bytesLength();
    assert.ok(s >= 0.95, `9/${x}/${row}: SSIM ${s}`);
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  log(`level 9 against the independent read: SSIM mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)}; ${Math.round(bytes / 24)} B/tile`);
  assert.ok(mean >= 0.98, `SSIM mean ${mean}`);
});

test("20 IAU features: the level-9 tiles are registered within one level-9 pixel", { timeout: 3600_000 }, async () => {
  for (const [name, lat, lonE] of FEATURES) {
    const lon = lonE >= 180 ? lonE - 360 : lonE;
    const px = ((lon + 180) / 360) * (512 << 9), py = ((90 - lat) / 180) * (256 << 9);
    const x = Math.floor(px / 256), yNorth = Math.floor(py / 256), row = 511 - yNorth;
    const files = await levelNine(row);
    const mine = gray(tileOf(files, x, row).PAYLOAD().bytesArray());
    const s = shiftOf(expectedTile(x, yNorth), mine);
    log(`${name} (${lat}, ${lonE}E) tile 9/${x}/${row}: shift ${s.fx.toFixed(2)}, ${s.fy.toFixed(2)} px`);
    assert.deepEqual([s.dx, s.dy], [0, 0], `${name}: registration shift ${s.dx},${s.dy} px`);
    assert.ok(Math.abs(s.fx) < 0.5 && Math.abs(s.fy) < 0.5, `${name}: sub-pixel shift ${s.fx}, ${s.fy}`);
  }
});

test("files are the layout and records the engine's imageryFromTileFiles reads", async () => {
  const files = await levelNine(300);
  assert.equal(files.length, 64);
  files.forEach((f, k) => assert.equal(f.name, `imagery/499/9/${k}_300.dtts`));
  for (const f of files) {
    const records = readFile(f.bytes);
    assert.equal(records.length, 16);
    records.forEach((t, k) => {
      assert.equal(t.TILING_SCHEME(), dttTilingScheme.GEOGRAPHIC_TWO_ROOT_BODY);
      assert.equal(t.PAYLOAD().MEDIA_TYPE(), "image/jpeg");
      assert.equal(t.MAX_LEVEL(), 9);
      assert.equal(t.Y(), 300);
      assert.equal(t.X(), Number(f.name.match(/9\/(\d+)_/)[1]) * 16 + k);
      assert.equal(t.ROW_ORIGIN_NORTH(), false);
      assert.ok(Math.abs(t.SOUTH_DEG() - (-90 + 300 * (180 / 512))) < 1e-9 && Math.abs(t.WEST_DEG() - (-180 + t.X() * (360 / 1024))) < 1e-9);
      assert.equal(t.CENTER_NAME(), "MARS");
      assert.match(t.PROVENANCE().ATTRIBUTION(), /NASA\/JPL\/ASU/);
      assert.equal(t.PROVENANCE().LICENSE(), "Public domain (NASA/JPL/ASU)");
    });
  }
  const again = await (async () => {
    const other = await openRunner();
    try {
      const { request, unit } = await other.plan(300);
      const { status, body } = await fetchRows(request);
      return await other.direct(unit, status, body);
    } finally { other.destroy(); }
  })();
  files.forEach((f, k) => assert.ok(Buffer.compare(Buffer.from(f.bytes), Buffer.from(again[k].bytes)) === 0, `${f.name} is byte-identical from a second instance`));
});

test("a level-8 tile is the 2 x 2 mean of its level-9 tiles; ", { timeout: 1800_000 }, async () => {
  const rows = [301, 300];  // level-8 row 150 is level-9 rows 300 and 301
  const child = (cy) => levelNine(cy).then((files) => Buffer.concat(files.map((f) => Buffer.from(f.bytes))));
  const l8 = await runner.reduce(8, 150, [await child(300), await child(301)]);
  assert.equal(l8.length, 32);
  assert.equal(l8[0].name, "imagery/499/8/0_150.dtts");
  const x8 = 77, t8 = readFile(l8.find((f) => f.name === `imagery/499/8/${Math.floor(x8 / 16)}_150.dtts`).bytes).find((t) => t.X() === x8);
  // Build the expected parent explicitly: rows from the north, the child at row 301 on top.
  const expect = Buffer.alloc(256 * 256);
  for (const cy of rows) for (const cx of [2 * x8, 2 * x8 + 1]) {
    const g = gray(tileOf(await levelNine(cy), cx, cy).PAYLOAD().bytesArray());
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      let s = 0, n = 0;
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) { const v = g[(2 * y + dy) * 256 + 2 * x + dx]; if (v) { s += v; n++; } }
      expect[((cy === 301 ? 0 : 128) + y) * 256 + (cx === 2 * x8 ? 0 : 128) + x] = n ? Math.round(s / n) : 0;
    }
  }
  const s8 = ssim(gray(t8.PAYLOAD().bytesArray()), expect);
  log(`level 8 against the 2 x 2 mean of its level-9 tiles: SSIM ${s8.toFixed(4)}`);
  assert.ok(s8 >= 0.95, `level-8 SSIM ${s8}`);
});

test("the published bucket matches the ledger and answers with CORS", { skip: process.env.THEMIS_VERIFY_R2 !== "1", timeout: 3600_000 }, async () => {
  const ledger = fs.readFileSync(process.env.THEMIS_R2_LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
  assert.ok(aws.length, "R2_AWS names the command that runs aws against the bucket");
  const listing = execFileSync(aws[0], [...aws.slice(1), "s3api", "list-objects-v2", "--bucket", "spaceaware", "--prefix", "imagery/499/", "--query", "Contents[].[Key,Size]", "--output", "json"], { maxBuffer: 1 << 28 });
  const have = new Map(JSON.parse(listing).map(([k, n]) => [k, n]));
  let bytes = 0;
  for (const f of ledger) {
    assert.equal(have.get(f.path), f.bytes, `${f.path} in R2 with ${f.bytes} B`);
    bytes += f.bytes;
  }
  const manifest = await (await fetch("https://terrain.spacedatanetwork.org/imagery/499/MANIFEST.json")).json();
  assert.equal(manifest.files, ledger.length);
  assert.equal(manifest.bytes, bytes);
  log(`R2: ${ledger.length} files, ${bytes} B, manifest agrees`);
  const head = await fetch("https://terrain.spacedatanetwork.org/imagery/499/root.dtts", { method: "HEAD", headers: { Origin: "https://spaceaware.io" } });
  assert.equal(head.status, 200);
  assert.ok(head.headers.get("access-control-allow-origin"), "Access-Control-Allow-Origin");
  log(`HEAD root.dtts Origin https://spaceaware.io: ${head.status}, ACAO ${head.headers.get("access-control-allow-origin")}`);
  const root = readFile(new Uint8Array(await (await fetch("https://terrain.spacedatanetwork.org/imagery/499/root.dtts")).arrayBuffer()));
  const perLevel = {};
  for (const t of root) perLevel[t.LEVEL()] = (perLevel[t.LEVEL()] ?? 0) + 1;
  assert.deepEqual(perLevel, { 0: 2, 1: 8, 2: 32 }, "root.dtts holds levels 0-2 (42 tiles)");
  // sampled bytes: 40 files re-read over HTTPS and hashed
  const next = rng(5);
  for (let i = 0; i < 40; i++) {
    const f = ledger[Math.floor(next() * ledger.length)];
    const body = Buffer.from(await (await fetch(`https://terrain.spacedatanetwork.org/${f.path}`)).arrayBuffer());
    assert.equal(crypto.createHash("sha256").update(body).digest("hex"), f.sha256, `${f.path} sha256`);
  }
});
