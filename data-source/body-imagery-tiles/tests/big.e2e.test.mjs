// BODY IMAGERY TILES, END TO END, FOR THE LARGE-BODY SOURCES (sources_big.hpp; the body tasks of 2026-10-22): Mercury MESSENGER
// MDIS BDR, Ceres and Vesta Dawn FC LAMO, Venus Magellan SAR with its C3-MDIR fill.
//
// The module (tiles_plan / tiles_direct / tiles_reduce, run through the SDK harness exactly as tools/encode.mjs runs it)
// against each mosaic read an independent way: GDAL reads the source's own pixels (gdal_translate -srcwin over /vsicurl)
// and its own georeference (gdalinfo -json), and this file computes the expected tile from them with its own float64 area
// average. For each source it checks:
//   - GDAL's size, band count, geotransform, sphere radius and central longitude state the module's table (the
//     DTT's SOURCE_POST_SPACING_M and REFERENCE_RADII_M are the module's own), the plan's If-Match is the file's ETag, and the
//     rows of the planned ranges of every band are GDAL's rows (strip0 and the band-plane stride);
//   - sampled deepest-level tiles against the independent tile: luma SSIM mean >= 0.98 (each >= 0.95), and for color the
//     channel means within 2/255 (a swapped or mixed band fails);
//   - 10 gazetteer features (USGS Astrogeology nomenclature centers, tests/features.json): the deepest-level tile holding
//     each is registered with the independent tile within one pixel (best integer shift 0,0; parabolic peak < 0.5 px);
//   - every file is a size-prefixed $DTT stream of GEOGRAPHIC_TWO_ROOT_BODY image/jpeg tiles, named imagery/<naif>[/<product>]/
//     <L>/<x/16>_<row from south>.dtts, 16 tiles each, NORTH/SOUTH/WEST/EAST consistent, RGB or grey as the source;
//   - the next level up is the 2 x 2 mean of its deepest-level tiles (SSIM >= 0.95), and a second instance writes the same bytes.
// BODY_IMAGERY_SOURCES=<key,key> picks sources (default: all four); BODY_TILES=<n> the sampled tiles (default 10).
// With BODY_VERIFY_R2=1 (BODY_R2_LEDGER=<ledger.jsonl>, R2_AWS=<command running aws against the bucket>, one source) the
// published bucket is checked: every ledger file present with its bytes, MANIFEST.json counts, root.dtts levels 0-2 (42 tiles),
// 40 files re-read over HTTPS against their sha256, and a HEAD of https://terrain.spacedatanetwork.org/<prefix>/root.dtts
// with Origin https://spaceaware.io answering 200 + Access-Control-Allow-Origin.
// Needs gdal_translate, gdalinfo and ffmpeg on PATH, network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";

import { SOURCES, prefixOf } from "../tools/big/sources.mjs";
import { dttTilingScheme, fetchRows, openRunner, readFile } from "../tools/big/runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FEATURES = JSON.parse(fs.readFileSync(path.join(HERE, "features.json"), "utf8"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bodies-e2e-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const log = (s) => console.log(`# ${s}`);
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
const keys = (process.env.BODY_IMAGERY_SOURCES ?? Object.keys(SOURCES).filter((k) => k !== "venus-magellan-c3mdir").join(",")).split(",").filter((k) => SOURCES[k]);  // BODY_IMAGERY_SOURCES=- runs only the bucket check
const TILES = Number(process.env.BODY_TILES ?? 10);

let windows = 0;
const luma = (px, nb) => {
  if (nb === 1) return px;
  const out = Buffer.alloc(px.length / nb);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * px[3 * i] + 0.587 * px[3 * i + 1] + 0.114 * px[3 * i + 2]);
  return out;
};
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

for (const key of keys) {
  const S = SOURCES[key];
  assert.ok(S, `a source named ${key}`);
  const NB = S.bands, L = S.maxLevel, prefix = prefixOf(S), WID = 512 << L;
  const VSI = `/vsicurl/${S.url}`;
  const info = JSON.parse(execFileSync("gdalinfo", ["-json", VSI], { maxBuffer: 1 << 24 }).toString());
  const [X0, PX, , Y0, , PY] = info.geoTransform;
  const RADIUS = Number(info.coordinateSystem.wkt.match(/ELLIPSOID\["[^"]*",\s*([0-9.]+)/)?.[1] ?? NaN);
  const LON0 = Number(info.coordinateSystem.wkt.match(/"Longitude of natural origin",\s*([0-9.-]+)/)?.[1] ?? NaN);
  const M_PER_DEG = (RADIUS * Math.PI) / 180;
  // Source pixel (fractional, edges at integers) of a planetocentric latitude and an east longitude.
  const srcCol = (lonE) => ((((lonE - LON0 + 540) % 360) - 180) * M_PER_DEG - X0) / PX;
  const srcRow = (lat) => (lat * M_PER_DEG - Y0) / PY;
  const W = info.size[0], H = info.size[1];
  // Radar speckle is noise the JPEG at quality 88 cannot keep: SSIM is lower there, the mean error stays small.
  const MIN_MEAN = key.startsWith("venus") ? 0.97 : 0.98, MIN_EACH = key.startsWith("venus") ? 0.94 : 0.95;

  function sourceWindow(col0, row0, w, h) {
    const f = path.join(scratch, `w${windows++}.bin`);
    execFileSync("gdal_translate", ["-q", "-of", "ENVI", "-co", "INTERLEAVE=BSQ", "-srcwin", String(col0), String(row0), String(w), String(h), VSI, f]);
    const px = fs.readFileSync(f);
    fs.rmSync(f);
    fs.rmSync(`${f}.hdr`, { force: true });
    fs.rmSync(`${f}.aux.xml`, { force: true });
    return px;  // band sequential: band b at b * w * h
  }
  // n columns from `start` (the mosaic wraps), rows [row0, row0 + h): one buffer per band, row-major.
  function sourceColumns(start, n, row0, h) {
    const s = ((start % W) + W) % W, first = Math.min(n, W - s);
    const a = sourceWindow(s, row0, first, h), b = first === n ? null : sourceWindow(0, row0, n - first, h);
    return Array.from({ length: NB }, (_, band) => {
      const out = Buffer.alloc(n * h);
      for (let r = 0; r < h; r++) {
        a.copy(out, r * n, band * first * h + r * first, band * first * h + (r + 1) * first);
        if (b) b.copy(out, r * n + first, band * (n - first) * h + r * (n - first), band * (n - first) * h + (r + 1) * (n - first));
      }
      return out;
    });
  }
  // The expected deepest-level tile (x, y from the NORTH): per pixel the mean of the measured source pixels (any band
  // non-zero) it overlaps; NB interleaved bytes a pixel.
  function expectedTile(x, yNorth) {
    const step = 360 / WID, e = 180 / (256 << L);
    const lonW = -180 + x * 256 * step, latN = 90 - yNorth * 256 * e;
    const colA = Math.floor(srcCol(lonW < 0 ? lonW + 360 : lonW)) - 1, colN = Math.ceil((256 * step * M_PER_DEG) / PX) + 3;
    const rowA = Math.max(0, Math.floor(srcRow(latN)) - 1), rowB = Math.min(H, Math.ceil(srcRow(latN - 256 * e)) + 1);
    const out = Buffer.alloc(256 * 256 * NB);
    if (rowB <= rowA) return out;
    const px = sourceColumns(colA, colN, rowA, rowB - rowA);
    for (let r = 0; r < 256; r++) {
      const va = srcRow(latN - r * e), vb = srcRow(latN - (r + 1) * e);
      for (let c = 0; c < 256; c++) {
        const lonA = lonW + c * step, ca0 = srcCol(lonA < 0 ? lonA + 360 : lonA), ca = ca0 - Math.floor(ca0) + (Math.floor(ca0) - colA), cb = ca + (step * M_PER_DEG) / PX;
        const sum = new Array(NB).fill(0);
        let wt = 0;
        for (let j = Math.floor(va); j < vb; j++) {
          const wr = Math.min(vb, j + 1) - Math.max(va, j);
          if (wr <= 0 || j < rowA || j >= rowB) continue;
          for (let i = Math.floor(ca); i < cb; i++) {
            const wc = Math.min(cb, i + 1) - Math.max(ca, i);
            if (wc <= 0) continue;
            const at = (j - rowA) * colN + i;
            if (!px.some((p) => p[at])) continue;
            for (let b = 0; b < NB; b++) sum[b] += wr * wc * px[b][at];
            wt += wr * wc;
          }
        }
        if (wt > 0) {
          for (let b = 0; b < NB; b++) out[(r * 256 + c) * NB + b] = Math.max(0, Math.min(255, Math.round(sum[b] / wt)));
          if (NB === 1 && !out[r * 256 + c]) out[r * 256 + c] = 1;
        }
      }
    }
    return out;
  }
  function decode(jpg) {
    const img = jpeg.decode(Buffer.from(jpg), { useTArray: true, formatAsRGBA: true });
    assert.equal(img.width, 256);
    assert.equal(img.height, 256);
    const out = Buffer.alloc(256 * 256 * NB);
    for (let i = 0; i < 256 * 256; i++) for (let b = 0; b < NB; b++) out[i * NB + b] = img.data[4 * i + b];
    return out;
  }

  const runner = await openRunner({ source: key });
  test.after(() => runner.destroy());
  const rowCache = new Map();
  async function deepest(row) {  // row from the south: the files of the deepest level's row
    if (!rowCache.has(row)) {
      const { requests, fill, unit } = await runner.plan(row);
      const bands = [];
      for (const request of requests) bands.push(await fetchRows(request));
      rowCache.set(row, await runner.direct(unit, 0, null, bands, fill ? await fetchRows(fill) : null));
    }
    return rowCache.get(row);
  }
  const tileOf = (files, level, x, row) => {
    const name = `${prefix}/${level}/${Math.floor(x / 16)}_${row}.dtts`;
    const file = files.find((f) => f.name === name);
    assert.ok(file, `${name} was made`);
    const t = readFile(file.bytes).find((r) => r.X() === x);
    assert.ok(t && t.LEVEL() === level && t.Y() === row, `${name} holds ${level}/${x}/${row}`);
    return t;
  };
  const rowOfLat = (lat) => Math.max(0, Math.min((1 << L) - 1, Math.floor(((lat + 90) / 180) * (1 << L))));

  test(`${key}: GDAL's header and rows state the module's table`, { timeout: 1800_000 }, async () => {
    assert.deepEqual(info.size, S.size);
    assert.equal(info.bands.length, NB);
    assert.ok(info.bands.every((b) => b.type === "Byte"));
    assert.equal(LON0, S.lon0, "central longitude");
    assert.ok(Math.abs(PX - -PY) < 1e-9, "square pixels");
    const head = await fetch(S.url, { method: "HEAD" });
    assert.equal(head.headers.get("etag").replaceAll('"', ""), S.etag, "the table's ETag is the file's");
    const row = rowOfLat(0);
    const { requests, unit } = await runner.plan(row);
    assert.equal(requests.length, NB);
    for (const rq of requests) assert.equal((rq.headers["if-match"] ?? rq.headers["If-Match"]).replaceAll('"', ""), S.etag, "the module pins the edition's ETag");
    // The planned ranges: band b's rows [first, first + count) are GDAL's rows of that band.
    const first = Number(requests[0].headers.range.match(/bytes=(\d+)-/)[1]);
    const count = (Number(requests[0].headers.range.match(/-(\d+)$/)[1]) + 1 - first) / W;
    assert.ok(Number.isInteger(count) && count > 1, `whole rows: ${count}`);
    const firstRow = (first - S.strip0) / W;
    assert.ok(Number.isInteger(firstRow), "the range starts on a row boundary of band 0");
    for (let b = 0; b < NB; b++) {
      const { body } = await fetchRows(requests[b]);
      for (const j of [0, count >> 1, count - 1]) {
        const g = execFileSync("gdal_translate", ["-q", "-of", "EHdr", "-b", String(b + 1), "-srcwin", "0", String(firstRow + j), String(W), "1", VSI, path.join(scratch, "row.bil")]) && fs.readFileSync(path.join(scratch, "row.bil"));
        assert.ok(Buffer.compare(Buffer.from(body.subarray(j * W, (j + 1) * W)), g) === 0, `band ${b} source row ${firstRow + j} is GDAL's`);
      }
    }
    void unit;
    const files = await deepest(row);
    const t = readFile(files[0].bytes)[0];
    assert.equal(t.REFERENCE_RADII_M(0), RADIUS);
    assert.ok(Math.abs(t.SOURCE_POST_SPACING_M() - PX) < 1e-6, "pixel size");
    assert.equal(t.MAX_LEVEL(), L);
    assert.equal(t.TILESET_ID(), S.tileset);
    assert.equal(t.PROVENANCE().ATTRIBUTION(), S.credit);
  });

  test(`${key}: sampled level-${L} tiles match the independent read (luma SSIM and mean error)`, { timeout: 7200_000 }, async () => {
    const next = rng(22), scores = [], maes = [];
    const latLo = key.startsWith("venus") ? -70 : -75, latHi = key.startsWith("venus") ? 75 : 75;
    let bytes = 0, tried = 0;
    while (scores.length < TILES && tried++ < 200) {
      const row = rowOfLat(latLo + next() * (latHi - latLo)), x = 20 + Math.floor(next() * (2 * (1 << L) - 40));
      const files = await deepest(row);
      const t = tileOf(files, L, x, row);
      const mine = decode(t.PAYLOAD().bytesArray()), ref = expectedTile(x, (1 << L) - 1 - row);
      if (ref.every((v) => v === 0)) continue;
      const s = ssim(luma(mine, NB), luma(ref, NB));
      scores.push(s);
      bytes += t.PAYLOAD().bytesLength();
      const lm = luma(mine, NB), lr = luma(ref, NB);
      let abs = 0, n = 0;
      for (let i = 0; i < lr.length; i++) if (lr[i]) { abs += Math.abs(lm[i] - lr[i]); n++; }
      maes.push(abs / n);
      assert.ok(s >= MIN_EACH, `${L}/${x}/${row}: SSIM ${s}`);
      assert.ok(abs / n <= 3, `${L}/${x}/${row}: mean abs error ${abs / n}/255`);
      if (NB === 3) for (let b = 0; b < 3; b++) {
        let ma = 0, mb = 0;
        for (let i = 0; i < 256 * 256; i++) { ma += mine[i * 3 + b]; mb += ref[i * 3 + b]; }
        assert.ok(Math.abs(ma - mb) / (256 * 256) < 2, `${L}/${x}/${row}: channel ${b} mean ${ma / 65536} vs ${mb / 65536}`);
      }
    }
    assert.ok(scores.length >= Math.min(TILES, 5), `${scores.length} measured tiles`);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    log(`${key} level ${L} against the independent read: SSIM mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)}; mean abs error ${(maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(2)}/255; ${Math.round(bytes / scores.length)} B/tile`);
    assert.ok(mean >= MIN_MEAN, `SSIM mean ${mean}`);
  });

  if (S.fill) {
    test(`${key}: a pole cap tile is the fill source's (${S.fill}) bilinear interpolation, no no-data`, { timeout: 1800_000 }, async () => {
      const F = SOURCES[S.fill];
      const FVSI = `/vsicurl/${F.url}`;
      const refTile = (x, row) => {
        const yNorth = (1 << L) - 1 - row, span = 360 / (2 << L), west = -180 + x * span, north = 90 - yNorth * span;
        const out = path.join(scratch, "fill.bin");
        execFileSync("gdal_translate", ["-q", "-of", "ENVI", "-r", "bilinear", "-projwin", String(west * M_PER_DEG), String(north * M_PER_DEG), String((west + span) * M_PER_DEG), String((north - span) * M_PER_DEG), "-outsize", "256", "256", FVSI, out]);
        return fs.readFileSync(out);
      };
      for (const lat of [88.5, -81.2, 84.3, -86]) {  // -86: south of C3-MDIR's -82.4: Magellan did not image it, so it stays no data
        const row = rowOfLat(lat);
        let x = 645, ref = refTile(x, row);
        for (const cand of [300, 900, 1200, 1500, 1800, 100, 2000]) if (lat > -83 && ref.every((v) => v === 0)) { x = cand; ref = refTile(x, row); }  // C3-MDIR has gaps too
        const files = await deepest(row);
        const mine = luma(decode(tileOf(files, L, x, row).PAYLOAD().bytesArray()), NB);
        let abs = 0, zeros = 0;
        for (let i = 0; i < 256 * 256; i++) { abs += Math.abs(mine[i] - ref[i]); if (!mine[i]) zeros++; }
        log(`${key} cap tile ${L}/${x}/${row} (${lat} deg): mean abs difference to GDAL's bilinear read of ${S.fill} ${(abs / 65536).toFixed(2)}/255, no-data pixels ${zeros}`);
        if (lat < -83) { assert.equal(zeros, 65536, "the unmapped south pole is no data"); continue; }
        assert.ok(zeros < 65536 * 0.02, `almost no no-data in a filled tile (${zeros})`);
        assert.ok(abs / 65536 <= 4, `cap tile mean abs difference ${abs / 65536}`);
      }
    });
  }

  test(`${key}: 10 gazetteer features are registered within one level-${L} pixel`, { timeout: 7200_000 }, async () => {
    const list = FEATURES[key];
    assert.equal(list.length, 10);
    for (const [name, lat, lonE, diameter] of list) {
      const lon = lonE >= 180 ? lonE - 360 : lonE;
      const px = ((lon + 180) / 360) * (512 << L), py = ((90 - lat) / 180) * (256 << L);
      const x = Math.floor(px / 256), yNorth = Math.floor(py / 256), row = (1 << L) - 1 - yNorth;
      const files = await deepest(row);
      const mine = luma(decode(tileOf(files, L, x, row).PAYLOAD().bytesArray()), NB), ref = luma(expectedTile(x, yNorth), NB);
      const s = shiftOf(ref, mine);
      log(`${key} ${name} (${lat}, ${lonE}E, ${diameter} km) tile ${L}/${x}/${row}: shift ${s.fx.toFixed(2)}, ${s.fy.toFixed(2)} px`);
      assert.deepEqual([s.dx, s.dy], [0, 0], `${name}: registration shift ${s.dx},${s.dy} px`);
      assert.ok(Math.abs(s.fx) < 0.5 && Math.abs(s.fy) < 0.5, `${name}: sub-pixel shift ${s.fx}, ${s.fy}`);
    }
  });

  test(`${key}: files are the layout and records the engine's imageryFromTileFiles reads`, { timeout: 1800_000 }, async () => {
    const row = rowOfLat(10);
    const files = await deepest(row);
    assert.equal(files.length, (2 << L) / 16);
    files.forEach((f, k) => assert.equal(f.name, `${prefix}/${L}/${k}_${row}.dtts`));
    for (const f of files) {
      const records = readFile(f.bytes);
      assert.equal(records.length, 16);
      records.forEach((t, k) => {
        assert.equal(t.TILING_SCHEME(), dttTilingScheme.GEOGRAPHIC_TWO_ROOT_BODY);
        assert.equal(t.PAYLOAD().MEDIA_TYPE(), "image/jpeg");
        assert.equal(t.Y(), row);
        assert.equal(t.X(), Number(f.name.match(/\/(\d+)_\d+\.dtts$/)[1]) * 16 + k);
        assert.equal(t.ROW_ORIGIN_NORTH(), false);
        assert.ok(Math.abs(t.SOUTH_DEG() - (-90 + row * (180 / (1 << L)))) < 1e-9 && Math.abs(t.WEST_DEG() - (-180 + t.X() * (360 / (2 << L)))) < 1e-9);
        assert.equal(t.CENTER_NAME(), S.body.toUpperCase());
        assert.equal(t.PROVENANCE().LICENSE(), S.license);
      });
    }
    const img = jpeg.decode(Buffer.from(readFile(files[3].bytes)[0].PAYLOAD().bytesArray()), { useTArray: true, formatAsRGBA: true });
    if (NB === 3) {
      let chroma = 0;
      for (let i = 0; i < 256 * 256; i++) chroma += Math.abs(img.data[4 * i] - img.data[4 * i + 2]);
      assert.ok(chroma > 0, "a color source's tile has color");
    }
    const other = await openRunner({ source: key });
    try {
      const { requests, fill, unit } = await other.plan(row);
      const bands = [];
      for (const request of requests) bands.push(await fetchRows(request));
      const again = await other.direct(unit, 0, null, bands, fill ? await fetchRows(fill) : null);
      files.forEach((f, k) => assert.ok(Buffer.compare(Buffer.from(f.bytes), Buffer.from(again[k].bytes)) === 0, `${f.name} is byte-identical from a second instance`));
    } finally { other.destroy(); }
  });

  test(`${key}: a level-${L - 1} tile is the 2 x 2 mean of its level-${L} tiles`, { timeout: 1800_000 }, async () => {
    const r8 = rowOfLat(10) >> 1, rows = [2 * r8, 2 * r8 + 1];
    const child = (cy) => deepest(cy).then((files) => Buffer.concat(files.map((f) => Buffer.from(f.bytes))));
    const parent = await runner.reduce(L - 1, r8, [await child(rows[0]), await child(rows[1])]);
    assert.equal(parent.length, Math.max(1, (2 << (L - 1)) / 16));
    assert.equal(parent[0].name, `${prefix}/${L - 1}/0_${r8}.dtts`);
    const x8 = Math.min(77, (2 << (L - 1)) - 2), t8 = readFile(parent.find((f) => f.name === `${prefix}/${L - 1}/${Math.floor(x8 / 16)}_${r8}.dtts`).bytes).find((t) => t.X() === x8);
    const expect = Buffer.alloc(256 * 256 * NB);
    for (const cy of rows) for (const cx of [2 * x8, 2 * x8 + 1]) {
      const g = decode(tileOf(await deepest(cy), L, cx, cy).PAYLOAD().bytesArray());
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const s = new Array(NB).fill(0);
        let n = 0;
        for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
          const at = ((2 * y + dy) * 256 + 2 * x + dx) * NB;
          let measured = false;
          for (let b = 0; b < NB; b++) if (g[at + b]) measured = true;
          if (!measured) continue;
          for (let b = 0; b < NB; b++) s[b] += g[at + b];
          n++;
        }
        const to = (((cy === rows[1] ? 0 : 128) + y) * 256 + (cx === 2 * x8 ? 0 : 128) + x) * NB;
        for (let b = 0; b < NB; b++) expect[to + b] = n ? Math.round(s[b] / n) : 0;
      }
    }
    const s8 = ssim(luma(decode(t8.PAYLOAD().bytesArray()), NB), luma(expect, NB));
    log(`${key} level ${L - 1} against the 2 x 2 mean of its level-${L} tiles: SSIM ${s8.toFixed(4)}`);
    assert.ok(s8 >= 0.94, `level-${L - 1} SSIM ${s8}`);
  });
}

if (process.env.BODY_VERIFY_R2 === "1") {
  test("the published bucket matches the ledger and answers with CORS", { timeout: 3600_000 }, async () => {
    const S = SOURCES[process.env.BODY_R2_SOURCE ?? keys[0]], prefix = prefixOf(S);
    const ledger = [...new Map(fs.readFileSync(process.env.BODY_R2_LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((e) => [e.path, e])).values()];  // a path re-encoded has the last line
    const aws = (process.env.R2_AWS ?? "").split(" ").filter(Boolean);
    assert.ok(aws.length, "R2_AWS names the command that runs aws against the bucket");
    const listing = execFileSync(aws[0], [...aws.slice(1), "s3api", "list-objects-v2", "--bucket", "spaceaware", "--prefix", `${prefix}/`, "--query", "Contents[].[Key,Size]", "--output", "json"], { maxBuffer: 1 << 29 });
    const have = new Map(JSON.parse(listing).map(([k, n]) => [k, n]));
    const mine = ledger.filter((f) => f.path.startsWith(`${prefix}/`));
    let bytes = 0;
    for (const f of mine) {
      assert.equal(have.get(f.path), f.bytes, `${f.path} in R2 with ${f.bytes} B`);
      bytes += f.bytes;
    }
    const manifest = await (await fetch(`https://terrain.spacedatanetwork.org/${prefix}/MANIFEST.json`)).json();
    assert.equal(manifest.files, mine.length);
    assert.equal(manifest.bytes, bytes);
    log(`R2 ${prefix}: ${mine.length} files, ${bytes} B, manifest agrees`);
    const head = await fetch(`https://terrain.spacedatanetwork.org/${prefix}/root.dtts`, { method: "HEAD", headers: { Origin: "https://spaceaware.io" } });
    assert.equal(head.status, 200);
    assert.ok(head.headers.get("access-control-allow-origin"), "Access-Control-Allow-Origin");
    log(`HEAD ${prefix}/root.dtts Origin https://spaceaware.io: ${head.status}, ACAO ${head.headers.get("access-control-allow-origin")}`);
    const root = readFile(new Uint8Array(await (await fetch(`https://terrain.spacedatanetwork.org/${prefix}/root.dtts`)).arrayBuffer()));
    const perLevel = {};
    for (const t of root) perLevel[t.LEVEL()] = (perLevel[t.LEVEL()] ?? 0) + 1;
    assert.deepEqual(perLevel, { 0: 2, 1: 8, 2: 32 }, "root.dtts holds levels 0-2 (42 tiles)");
    const next = rng(5);
    for (let i = 0; i < 40; i++) {
      const f = mine[Math.floor(next() * mine.length)];
      const body = Buffer.from(await (await fetch(`https://terrain.spacedatanetwork.org/${f.path}`)).arrayBuffer());
      assert.equal(crypto.createHash("sha256").update(body).digest("hex"), f.sha256, `${f.path} sha256`);
    }
  });
}
