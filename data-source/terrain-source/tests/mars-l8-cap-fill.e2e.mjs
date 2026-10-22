// NASA PDS MGS MOLA MEGDR (MEG128 labels + big-endian int16 image posts),
// independently read below: Mars body-fixed planetocentric latitude/east longitude,
// heights in metres above R=3396000 m; dataset epoch 2003-03-21T00:00:00.000Z (UTC).
// Seam tolerance is q_cap + q_band + 0.01 m: two mesh quantizers and float header
// rounding only. Raw MEG128 comparisons allow q + 0.01 m for the same reason.
// Health limits: |h| < 30 km and a 3x3 outlier bound max(10*MAD + 2q, 200 m),
// allowing real local relief while rejecting nodata/zero substitution and spikes.
// Unfilled records and packed files must match the pinned pre-fix artifact exactly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBodyLane, MARS_CONFIG, dttOf } from '../tools/body-lane.mjs';
import { decodeEdgeMatchedPlanes } from '../tools/edge-matched-planes.mjs';
import { decodeQuantizedMesh } from './helpers.mjs';
import { configFrame } from '../typed-frames.mjs';
import { decodeModuleConfig } from '../../terrain-ingest/tests/typed.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseline = 'a58d8e0fc22ec2898870993ccbf302d3e96ea752';
const grid = 321, columns = [0, 255, 511], clock = '2026-10-21T12:00:00.000Z';
const cap = (product, min_level, max_level, lat_min = -90, lat_max = 90, fill, feather_posts) =>
  ({ product, min_level, max_level, lat_min, lat_max, ...(fill ? { fill, feather_posts } : {}) });
const config = {
  ...MARS_CONFIG, path_prefix: 'terrain/499', grid_size: 65, max_grid_size: grid, fill_diagnostics: 1,
  caps: [cap('megr_4', 0, 2), cap('megr_128', 8, 8, -87.1875, 87.1875),
    cap('megr_s_512', 8, 8, -90, -87.1875, 'megr_128', 58),
    cap('megr_n_512', 8, 8, 87.1875, 90, 'megr_128', 56)],
};
const key = h => `${h.level}/${h.x}/${h.y}`;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const poleOf = u => u.headers.every(h => h.level === 8 && h.y < 4) ? 'south' :
  u.headers.every(h => h.level === 8 && h.y >= 252) ? 'north' : null;
const seamTile = h => h.level === 8 && columns.includes(h.x) && [3, 252].includes(h.y);
const bandTile = h => h.level === 8 && columns.includes(h.x) && [4, 251].includes(h.y);
function success(result, label) {
  assert.equal(result.response.statusCode, 0, `${label}: ${result.response.errorCode}: ${result.response.errorMessage}`);
  return result;
}
function mesh(sized) {
  const t = dttOf(sized.subarray(4)).unpack();
  const m = decodeQuantizedMesh(decodeEdgeMatchedPlanes(t.PAYLOAD.BYTES));
  const q = (m.header.maxHeight - m.header.minHeight) / 32767;
  const posts = new Float64Array(grid * grid).fill(NaN);
  for (let k = 0; k < m.vertexCount; k++) {
    const i = Math.round(m.u[k] / 32767 * (grid - 1)), j = Math.round(m.v[k] / 32767 * (grid - 1));
    posts[j * grid + i] = m.header.minHeight + m.h[k] * q;
  }
  return { t, m, q, posts };
}
function healthy(a, interiorGrid) {
  const stride = (grid - 1) / (interiorGrid - 1);
  assert.ok(Number.isInteger(stride));
  let checked = 0;
  for (let k = 0; k < a.m.vertexCount; k++) {
    const i = Math.round(a.m.u[k] / 32767 * (grid - 1)), j = Math.round(a.m.v[k] / 32767 * (grid - 1));
    const h = a.posts[j * grid + i];
    assert.ok(Number.isFinite(h) && h !== 0 && Math.abs(h) < 30000,
      `${a.t.X}/${a.t.Y} ${i}/${j}: invalid height ${h}`);
    // Interior density may differ from the 321-post boundary. Check complete
    // 3x3 stencils on each encoded lattice, without inventing missing vertices.
    const step = i % stride === 0 && j % stride === 0 ? stride : 1;
    if (i < step || j < step || i + step >= grid || j + step >= grid) continue;
    const neighbours = [];
    for (let y = j - step; y <= j + step; y += step)
      for (let x = i - step; x <= i + step; x += step) neighbours.push(a.posts[y * grid + x]);
    if (!neighbours.every(Number.isFinite)) continue;
    const med = median(neighbours), mad = median(neighbours.map(v => Math.abs(v - med)));
    assert.ok(Math.abs(h - med) <= Math.max(10 * mad + 2 * a.q, 200),
      `${a.t.X}/${a.t.Y} ${i}/${j}: 3x3 spike ${h - med} m, MAD=${mad}, q=${a.q}`);
    checked++;
  }
  return checked;
}
function edge(a, name) {
  return new Map(a.m.edges[name].map(k => [a.m.u[k], a.m.header.minHeight + a.m.h[k] * a.q]));
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return `median=${sorted[Math.floor(sorted.length / 2)].toFixed(6)} p99=${sorted[Math.ceil(sorted.length * .99) - 1].toFixed(6)} max=${sorted.at(-1).toFixed(6)} m`;
}
function withoutFill(unit) {
  const options = decodeModuleConfig(unit.options);
  assert.ok(options.bodyFillFrame > 0);
  const plain = Object.fromEntries(Object.entries(options).filter(([k]) =>
    !k.startsWith('body') && !k.startsWith('fill') && k !== 'featherPosts'));
  return { ...unit, requests: unit.requests.slice(0, options.bodyFillFrame), options: configFrame(plain, 'options').payload };
}
function extractBaseline(temp) {
  for (const name of ['isomorphic/module.wasm', 'plugin-manifest.json']) {
    const target = path.join(temp, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync('git', ['--no-optional-locks', '-C', root, 'show',
      `${baseline}:data-source/terrain-source/dist/${name}`], { maxBuffer: 32 * 1024 * 1024 }));
  }
  return temp;
}
function megrLocation(j, i) {
  i = (i % 46080 + 46080) % 46080;
  const band = Math.floor((j - 256) / 5632), sector = Math.floor(i / 11520);
  assert.ok(band >= 0 && band < 4, `MEG128 holds global line ${j}`);
  return { name: `megr${['88n', '44n', '00n', '44s'][band]}${['000', '090', '180', '270'][sector]}hb.img`,
    offset: ((j - 256 - band * 5632) * 11520 + i % 11520) * 2 };
}
function megrOracle(dir) {
  const fds = new Map(), rows = new Map();
  function at(j, i) {
    const { name, offset } = megrLocation(j, i), row = Math.floor(offset / 23040), id = `${name}/${row}`;
    if (!fds.has(name)) fds.set(name, fs.openSync(path.join(dir, name), 'r'));
    if (!rows.has(id)) {
      const bytes = Buffer.alloc(23040);
      assert.equal(fs.readSync(fds.get(name), bytes, 0, bytes.length, row * bytes.length), bytes.length);
      rows.set(id, bytes);
    }
    const value = rows.get(id).readInt16BE(offset % 23040);
    assert.notEqual(value, -32768, 'independent MEG128 seam post is measured');
    return value;
  }
  return { sample(lat, lon) {
    const x = ((lon + 360) % 360) * 128 - .5, y = (90 - lat) * 128 - .5;
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    return (1 - fy) * ((1 - fx) * at(j, i) + fx * at(j, i + 1)) +
      fy * ((1 - fx) * at(j + 1, i) + fx * at(j + 1, i + 1));
  }, close() { for (const fd of fds.values()) fs.closeSync(fd); } };
}

// One real-data E2E, with sequential encoding (one worker). Missing data is a failure.
test('Mars L8: fill outside MEG128 coverage, every cap unit, seam and unchanged unfilled bytes',
  { timeout: 600000 }, async t => {
    const dir = process.env.MARS_HD_DIR;
    assert.ok(dir && fs.statSync(dir).isDirectory(), 'MARS_HD_DIR must name the Mars HD PDS directory');
    const free = fs.statfsSync(dir);
    assert.ok(free.bavail * free.bsize > 20 * 1024 ** 3, 'keep more than 20 GiB free');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-l8-cap-fill-'));
    const lanes = [], oracle = megrOracle(dir);
    t.after(() => { oracle.close(); for (const l of lanes) l.destroy(); fs.rmSync(temp, { recursive: true, force: true }); });
    const lane = async sourceDist => {
      const l = await createBodyLane({ dataDir: dir, config, clock, ...(sourceDist ? { sourceDist } : {}) });
      lanes.push(l); return l;
    };
    const current = await lane(), rootUnit = await current.planUnit(0), capUnits = [], bandUnits = [];
    for (let i = 1; i <= rootUnit.backlog; i++) {
      const unit = await current.planUnit(i);
      assert.ok(unit, `walk unit ${i}`);
      if (poleOf(unit)) capUnits.push(unit);
      else if (unit.headers.some(bandTile)) bandUnits.push(unit);
    }
    assert.equal(capUnits.filter(u => poleOf(u) === 'south').length, 48);
    assert.equal(capUnits.filter(u => poleOf(u) === 'north').length, 44);
    console.log(`L8 walk: ${rootUnit.backlog + 1} units; caps south=48 north=44; selected band units=${bandUnits.length}`);
    const seams = new Map(), bands = new Map(), counts = { south: 0, north: 0 }, tiles = { south: 0, north: 0 };
    let posts = 0, stencils = 0, packed = 0;
    function inspect(result, selected, saved) {
      const reports = new Map(result.report.tiles.map(r => [key(r), r]));
      for (const [k, sized] of result.byKey) {
        if (!selected(reports.get(k))) continue;
        const m = mesh(sized), report = reports.get(k);
        stencils += healthy(m, report.gridSize); posts += m.m.vertexCount;
        saved.set(k, m);
      }
    }
    const selected = capUnits.filter(u => u.headers.some(seamTile));
    for (const unit of selected) {
      const pole = poleOf(unit), result = success(await current.encode(unit), `cap ${unit.index}`);
      assert.equal(result.byKey.size, unit.headers.length);
      counts[pole]++; tiles[pole] += result.byKey.size;
      // Decode every post of the paired seam tiles; still encode and pack
      // their complete units. The remaining cap walk is checked below.
      inspect(result, seamTile, seams);
      const files = await current.pack(unit, result.records);
      assert.ok(files.length > 0); packed += files.length;
    }
    for (const unit of bandUnits) {
      const result = success(await current.encode(unit), `band ${unit.index}`);
      assert.equal(result.byKey.size, unit.headers.length);
      inspect(result, bandTile, bands);
      const files = await current.pack(unit, result.records);
      assert.ok(files.length > 0); packed += files.length;
    }
    assert.equal(seams.size, 6); assert.equal(bands.size, 6);
    const beforeMeshes = new Map();
    for (const unit of selected) {
      const result = success(await current.encode(withoutFill(unit)), `unfilled ${unit.index}`);
      inspect(result, seamTile, beforeMeshes);
    }
    for (const pole of ['south', 'north']) {
      const before = [], after = [], y = pole === 'south' ? 3 : 252, other = pole === 'south' ? 4 : 251;
      const side = pole === 'south' ? 'north' : 'south', opposite = pole === 'south' ? 'south' : 'north';
      let maxQuantum = 0, oracleChecks = 0;
      for (const x of columns) {
        const a = seams.get(`8/${x}/${y}`), b = bands.get(`8/${x}/${other}`), old = beforeMeshes.get(`8/${x}/${y}`);
        const ae = edge(a, side), be = edge(b, opposite), oe = edge(old, side);
        assert.ok(ae.size >= 2);
        assert.deepEqual([...ae.keys()].sort((a,b)=>a-b), [...be.keys()].sort((a,b)=>a-b));
        const lat = pole === 'south' ? a.t.NORTH_DEG : a.t.SOUTH_DEG;
        for (const [u, h] of ae) {
          assert.ok(be.has(u), 'pair edge posts by quantized u');
          const delta = Math.abs(h - be.get(u));
          after.push(delta);
          // Adaptive edge densities can differ without fill. Compare their
          // shared posts, as for any pair of encoded edges, without resampling.
          if (oe.has(u)) before.push(Math.abs(oe.get(u) - be.get(u)));
          assert.ok(delta <= a.q + b.q + .01, `seam ${x}/${y} u=${u}: ${delta} > ${a.q + b.q + .01}`);
          // Recover the exact unquantized lattice longitude, not the rounded u.
          const i = Math.round(u / 32767 * (grid - 1));
          const lon = a.t.WEST_DEG + i * (a.t.EAST_DEG - a.t.WEST_DEG) / (grid - 1);
          const expected = oracle.sample(lat, lon);
          assert.ok(Math.abs(h - expected) <= a.q + .01, 'cap matches independent MEG128 bilinear heights');
          assert.ok(Math.abs(be.get(u) - expected) <= b.q + .01, 'band matches independent MEG128 bilinear heights');
          oracleChecks++;
        }
        maxQuantum = Math.max(maxQuantum, a.q + b.q + .01);
      }
      assert.ok(Math.max(...before) > 1, 'unfilled seam demonstrates the original discontinuity');
      console.log(`${pole} seam BEFORE ${summary(before)} (${before.length} pairs); AFTER ${summary(after)} (${after.length} pairs); max allowance=${maxQuantum.toFixed(6)} m; raw oracle=${oracleChecks} posts`);
    }
    const bare = withoutFill(selected[0]), oldLane = await lane(extractBaseline(temp));
    const old = success(await oldLane.encode(bare), 'baseline unfilled'), now = success(await current.encode(bare), 'current unfilled');
    assert.ok(now.records.equals(old.records), 'unfilled DTT records byte-identical to a58d8e0f');
    const oldFiles = await oldLane.pack(bare, old.records), newFiles = await current.pack(bare, now.records);
    assert.deepEqual(newFiles, oldFiles, 'unfilled packed files byte-identical to a58d8e0f');
    console.log(`byte-identity a58d8e0f: unit=${bare.index}, tiles=${now.byKey.size}, records=${now.records.length} bytes, packed=${newFiles.length} files: PASS`);

    // Move the test band's edge to -87.5 with 64 fill posts (0.5 degrees).
    // At row 271 of tile Y=2, lat=-87.998291015625: the fill stencil crosses
    // measured global line 22783 and uncovered line 22784, while the post is
    // strictly inside the band. Real PDS bytes stay unchanged. This proves
    // that uncovered bilinear neighbours make valid_f false.
    const sample = selected.find(u => u.headers.some(h => h.x === 0 && h.y === 3));
    const header = sample.headers.find(h => h.x === 0 && h.y === 3), tile = seams.get(key(header));
    assert.ok(sample.headers.some(h => h.x === 0 && h.y === 2));
    const boundaryLat = -90 + (2 + 271 / (grid - 1)) * 180 / 256;
    const boundaryLine = (90 - boundaryLat) * 128 - .5;
    assert.equal(Math.floor(boundaryLine), 22783);
    assert.ok(boundaryLine > 22783 && boundaryLine < 22784);
    assert.ok((-87.5 - boundaryLat) * 128 < 64, 'stencil crossing lies inside the fill band');
    const boundary = { ...sample, options: configFrame({ ...decodeModuleConfig(sample.options),
      bodyLatMax: -87.5, featherPosts: 64 }, 'options').payload };
    const refused = await current.encode(boundary, k => k === '8/0/2');
    assert.equal(refused.response.statusCode, 422); assert.equal(refused.response.errorCode, 'fill-nodata');
    assert.match(refused.response.errorMessage, /required height-field post/);
    const lon = (tile.t.WEST_DEG + tile.t.EAST_DEG) / 2, lat = tile.t.NORTH_DEG;
    const corner = megrLocation(Math.floor((90 - lat) * 128 - .5),
      Math.floor(((lon + 360) % 360) * 128 - .5));
    // A labelled, covered line still needs actual range bytes even for fill.
    const broken = { ...sample, requests: sample.requests.map(r => {
      if (path.basename(r.url) !== corner.name) return r;
      const start = Number(r.headers.range.match(/=(\d+)/)[1]);
      return { ...r, headers: { ...r.headers, range: `bytes=${start}-${start + 23040 - 1}` } };
    }) };
    const gap = await current.encode(broken, k => k === key(header));
    assert.equal(gap.response.statusCode, 422); assert.equal(gap.response.errorCode, 'pds-fill-gap');
    console.log('bilinear stencil touching uncovered line: fill-nodata 422; missing covered range: pds-fill-gap 422');
    // Full walk proof: every cap unit, including the pole-only tiles. Keep
    // the detailed seam checks first so a failure does not wait for the sweep.
    const encoded = new Set(selected.map(u => u.index));
    for (const unit of capUnits) {
      if (encoded.has(unit.index)) continue;
      const pole = poleOf(unit), result = success(await current.encode(unit), `cap ${unit.index}`);
      assert.equal(result.byKey.size, unit.headers.length);
      counts[pole]++; tiles[pole] += result.byKey.size;
      if ((counts.south + counts.north) % 8 === 0) console.log(`encoded caps south=${counts.south} north=${counts.north}`);
    }
    assert.deepEqual(counts, { south: 48, north: 44 });
    assert.deepEqual(tiles, { south: 2048, north: 2048 });
    assert.ok(stencils > 0);
    console.log(`PASS units encoded south=${counts.south} north=${counts.north}; cap tiles south=${tiles.south} north=${tiles.north}; healthy posts=${posts}; 3x3 checks=${stencils}; packed files=${packed}`);
  });
