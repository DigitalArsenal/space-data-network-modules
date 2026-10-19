// MARS THEMIS DAY IR OVER SDN, END TO END (mars-themis-imagery-module-20261019).
//
// A local provider node (SDN_NODE_BINARY, built from sdn main) runs the imagery flow once over one band of the
// mosaic (body_imagery_tiles_bands [16]: level-9 rows 256-271, 0 to 5.625 S, across Gale crater and Valles Marineris)
// through a caching range proxy to the USGS file (THEMIS_RANGE_CACHE; offline after the first fill). Then, as a
// consumer finds it over SDN (list_published_shards, $DPM, shards), the lane PNM.fbs usgs-astrogeology /
// mars-themis-day-ir:
//  - lists the band's files: 1,024 level-9 packs, 256 level-8, 64 level-7, 16 level-6 and 4 level-5 (the rows the
//    band completes), each FILE_NAME imagery/499/themis-day-ir/<L>/<y>_<x/16>.pack and nothing coarser;
//  - every pack fetched by CID is an SDNTILE1 of its row's 16 tiles (level, x, y as named), at most 256 KB;
//  - 24 level-9 tiles (seeded) against GDAL's own area average of the same window of the source (gdal_translate
//    -projwin in the file's CRS, -r average, read straight from USGS: a second channel to the bytes): SSIM >= 0.98
//    mean and >= 0.95 each, and the best registration shift within +/- 3 px is 0 in both axes;
//  - a level-6 tile equals the 8 x 8 mean of its level-9 tiles within JPEG tolerance (the pyramid);
//  - the node's peak resident memory, sampled by its PID, is at most 2 GB.
// The run's bytes per tile and per band are logged: the whole body is 32 bands.
//
// env: SDN_NODE_BINARY (required), STACK_ROOT (deployment/solar-system-provider-node/sign-flow.mjs),
//      SDN_JS (sdn-js with dist/), THEMIS_RANGE_CACHE, THEMIS_RANGE_OFFLINE=1. Needs gdal_translate, magick and ffmpeg.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startRangeProxy} from './lib/range-proxy.mjs';
import {createProviderNode, waitFor, PROGRAM} from './lib/provider-node.mjs';
import {openLanes} from './lib/sdn-lanes.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const STACK = process.env.STACK_ROOT || path.join(os.homedir(), 'software/spacedatanetwork-stack');
const SDN_JS = process.env.SDN_JS || path.join(STACK, 'repos/main-packages/space-data-network/sdn-js');
const BINARY = process.env.SDN_NODE_BINARY;
const CACHE = process.env.THEMIS_RANGE_CACHE || path.join(os.homedir(), '.cache/body-imagery-tiles-themis');
const SOURCE = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif';
const BAND = 16;  // a band is one level-5 tile row: 16 level-9 rows
const RSS_LIMIT_KIB = 2 * 1024 * 1024;
const M_PER_DEG = (3396190 * Math.PI) / 180;
const log = (s) => console.log(`# ${s}`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'themis-e2e-'));
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

function readPack(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.subarray(0, 8).toString('latin1'), 'SDNTILE1');
  assert.equal(b.readUInt32LE(8), 1);
  const count = b.readUInt32LE(12), tiles = [];
  for (let i = 0; i < count; i++) {
    const e = 20 + 16 * i;
    tiles.push({level: b[e], x: b.readUInt16LE(e + 2), y: b.readUInt16LE(e + 4), jpeg: b.subarray(b.readUInt32LE(e + 8), b.readUInt32LE(e + 8) + b.readUInt32LE(e + 12))});
  }
  return {maxLevel: b[16], channels: b[17], tiles};
}
// A JPEG tile as 256 x 256 gray bytes (ImageMagick).
function gray(jpeg) {
  const f = path.join(scratch, 'tile.jpg');
  fs.writeFileSync(f, jpeg);
  return execFileSync('magick', [f, '-colorspace', 'Gray', '-depth', '8', 'gray:-'], {maxBuffer: 1 << 20});
}
// GDAL's area average of a level-9 tile's window of the source, 256 x 256 gray bytes.
function gdalTile(x, y) {
  const size = 180 / 512, west = -180 + x * size, north = 90 - y * size;
  const lonE = west < 0 ? west + 360 : west;
  const ulx = (lonE - 180) * M_PER_DEG, uly = north * M_PER_DEG, lrx = ulx + size * M_PER_DEG, lry = uly - size * M_PER_DEG;
  const out = path.join(scratch, `ref-${x}-${y}.tif`);
  execFileSync('gdal_translate', ['-q', '-of', 'GTiff', '-r', 'average', '-outsize', '256', '256', '-projwin', String(ulx), String(uly), String(lrx), String(lry),
    `/vsicurl/${SOURCE}`, out], {env: {...process.env, GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif'}});
  return execFileSync('magick', [out, '-depth', '8', 'gray:-'], {maxBuffer: 1 << 20});
}
function ssim(a, b) {
  const fa = path.join(scratch, 'a.gray'), fb = path.join(scratch, 'b.gray');
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '256x256', '-i', fa, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '256x256', '-i', fb,
    '-lavfi', 'ssim', '-f', 'null', '-'], {encoding: 'utf8'});
  return Number(r.stderr.match(/All:([0-9.]+)/)[1]);
}
// The integer shift (dx, dy) within +/- r that best correlates b onto a (zero-mean, over the overlap).
function bestShift(a, b, r = 3) {
  let best = {dx: 0, dy: 0, c: -Infinity};
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      let sa = 0, sb = 0, n = 0;
      for (let y = r; y < 256 - r; y++) for (let x = r; x < 256 - r; x++) { sa += a[y * 256 + x]; sb += b[(y + dy) * 256 + x + dx]; n++; }
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let y = r; y < 256 - r; y++) for (let x = r; x < 256 - r; x++) {
        const u = a[y * 256 + x] - ma, v = b[(y + dy) * 256 + x + dx] - mb;
        num += u * v; da += u * u; db += v * v;
      }
      const c = num / Math.sqrt(da * db);
      if (c > best.c) best = {dx, dy, c};
    }
  return best;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('Mars THEMIS Day IR over SDN: one band from a local provider node', {timeout: 6 * 3600_000}, async () => {
  assert.ok(BINARY && fs.existsSync(BINARY), 'set SDN_NODE_BINARY (an sdn binary built from sdn main)');
  if (!fs.existsSync(path.join(PKG, 'dist/flow/runtime/runtime.wasm'))) {
    assert.equal(spawnSync(process.execPath, ['build.mjs'], {cwd: PKG, stdio: 'inherit'}).status, 0, 'build.mjs');
  }
  const proxy = await startRangeProxy({upstream: SOURCE, cacheDir: CACHE, offline: process.env.THEMIS_RANGE_OFFLINE === '1'});
  const node = await createProviderNode({binary: BINARY, stackRoot: STACK, packageDir: PKG});
  let lanes;
  try {
    const {peerId, ws} = await node.start();
    const capabilities = await node.install({body_imagery_tiles_enabled: true, body_imagery_tiles_producer_peer_id: peerId,
      body_imagery_tiles_source_url: proxy.url, body_imagery_tiles_bands: [BAND]});
    log(`${PROGRAM} signed by the node, ${capabilities.join(', ')} approved, installed`);
    const t0 = Date.now();
    await node.start();
    lanes = await openLanes({sdnJs: SDN_JS, provider: peerId, addrs: [ws]});
    const lane = {schema: 'PNM.fbs', providerId: 'usgs-astrogeology', sourceName: 'mars-themis-day-ir'};
    const ended = /flow service "com\.digitalarsenal\.flows\.mars-themis-imagery-ingest".*(failed|error)/i;
    const listed = await waitFor('the band published', async () => {
      const failed = node.log().match(ended);
      if (failed) throw new Error(`the flow failed: ${failed[0]} (proxy errors: ${proxy.stats.errors.slice(-3).join(' | ')})`);
      const r = await lanes.records(lane);
      return r && r.records.length >= 1364 ? r : null;
    }, 5 * 3600_000, node.child, 15_000);
    log(`published in ${((Date.now() - t0) / 60000).toFixed(1)} min; proxy hits ${proxy.stats.hits}, misses ${proxy.stats.misses}, ${(proxy.stats.bytes / 1e9).toFixed(2)} GB`);

    const PNM = await import(pathToFileURL(path.join(SDN_JS, 'node_modules/spacedatastandards.org/lib/js/PNM/PNM.js')).href);
    const flatbuffers = await import(pathToFileURL(path.join(SDN_JS, 'node_modules/flatbuffers/mjs/flatbuffers.js')).href);
    const files = new Map();
    for (const r of listed.records) {
      const p = PNM.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(new Uint8Array(r)));
      files.set(String(p.FILE_NAME()), String(p.CID()));
    }
    const perLevel = {};
    for (const name of files.keys()) {
      const m = name.match(/^imagery\/499\/themis-day-ir\/(\d+)\/(\d+)_(\d+)\.pack$/);
      assert.ok(m, `unexpected FILE_NAME ${name}`);
      perLevel[m[1]] = (perLevel[m[1]] ?? 0) + 1;
    }
    assert.deepEqual(perLevel, {9: 1024, 8: 256, 7: 64, 6: 16, 5: 4});

    // The level-9 tiles of the band, sampled; each against GDAL's own average of the source.
    const next = rng(19), tiles9 = new Map();
    const fetchPack = async (name) => readPack(await lanes.fetchCid(files.get(name), 1 << 20));
    let largest = 0, bytes = 0;
    const scores = [];
    for (let i = 0; i < 24; i++) {
      const y = 16 * BAND + Math.floor(next() * 16), x = Math.floor(next() * 1024);
      const name = `imagery/499/themis-day-ir/9/${y}_${Math.floor(x / 16)}.pack`;
      const pack = await fetchPack(name);
      largest = Math.max(largest, pack.tiles.reduce((n, t) => n + t.jpeg.length, 0));
      assert.equal(pack.maxLevel, 9);
      assert.equal(pack.channels, 1);
      const t = pack.tiles.find((u) => u.x === x);
      assert.ok(t && t.level === 9 && t.y === y, `${name} holds 9/${x}/${y}`);
      bytes += t.jpeg.length;
      const mine = gray(t.jpeg), ref = gdalTile(x, y);
      const s = ssim(mine, ref), shift = bestShift(ref, mine);
      scores.push(s);
      assert.ok(s >= 0.95, `9/${x}/${y}: SSIM ${s} against GDAL`);
      assert.deepEqual([shift.dx, shift.dy], [0, 0], `9/${x}/${y}: registration shift ${shift.dx},${shift.dy}`);
      tiles9.set(`${x}/${y}`, mine);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    log(`level 9 against GDAL: SSIM mean ${mean.toFixed(4)}, min ${Math.min(...scores).toFixed(4)}; ${Math.round(bytes / 24)} B/tile`);
    assert.ok(mean >= 0.98, `SSIM mean ${mean}`);
    assert.ok(largest <= 256 * 1024, `largest pack ${largest} B`);

    // The pyramid: a level-6 tile is the 8 x 8 mean of its 64 level-9 tiles.
    const x6 = 20, y6 = 2 * BAND, l6 = readPack(await lanes.fetchCid(files.get(`imagery/499/themis-day-ir/6/${y6}_${Math.floor(x6 / 16)}.pack`), 1 << 20));
    const mine6 = gray(l6.tiles.find((t) => t.x === x6).jpeg);
    const sum = new Float64Array(256 * 256), cnt = new Float64Array(256 * 256);
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const x9 = 8 * x6 + dx, y9 = 8 * y6 + dy;
      const p = readPack(await lanes.fetchCid(files.get(`imagery/499/themis-day-ir/9/${y9}_${Math.floor(x9 / 16)}.pack`), 1 << 20));
      const g = gray(p.tiles.find((t) => t.x === x9).jpeg);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const v = g[y * 256 + x], o = (dy * 32 + (y >> 3)) * 256 + dx * 32 + (x >> 3);
        if (v) { sum[o] += v; cnt[o] += 1; }
      }
    }
    const expect6 = Buffer.alloc(256 * 256);
    for (let i = 0; i < expect6.length; i++) expect6[i] = cnt[i] ? Math.round(sum[i] / cnt[i]) : 0;
    const s6 = ssim(mine6, expect6);
    log(`level 6 against the 8 x 8 mean of its level-9 tiles: SSIM ${s6.toFixed(4)}`);
    assert.ok(s6 >= 0.97, `level-6 pyramid SSIM ${s6}`);

    const total = [...files.keys()].length;
    log(`band ${BAND}: ${total} files; the body is 32 bands (~${(32 * 1364 * 216e3 / 1e9).toFixed(1)} GB at the sampled pack size)`);
    log(`node peak RSS ${(node.rss.peakKiB / 1024).toFixed(0)} MiB over ${node.rss.samples} samples; footprint peak ${node.footprintPeak() ?? 'n/a'}`);
    assert.ok(node.rss.peakKiB <= RSS_LIMIT_KIB, `peak RSS ${node.rss.peakKiB} KiB`);
  } catch (error) {
    log(`FAILED: ${error?.stack ?? error}`);
    throw error;
  } finally {
    await lanes?.close();
    await node.stop();
    await proxy.close();
    if (process.env.KEEP_NODE !== '1') node.remove();
  }
});
