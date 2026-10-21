// One lossless format E2E. The independent reference is the published 1fb1f1d4 encoder on the same NASA PDS
// Moon/Mars inputs, clock and walk units. Coordinates/height arrays are quantized-mesh integers; header distances
// are metres in the body's fixed frame, with the unchanged PDS dataset epoch carried by each DTT. Tolerance is
// exactly zero bytes/integers: this storage-only change must preserve every numerical result and metadata field.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createBodyLane, MOON_CONFIG, MARS_CONFIG, splitSized, dttOf } from '../tools/body-lane.mjs';
import { decodeEdgeMatchedPlanes, EDGE_MATCHED_PLANES } from '../tools/edge-matched-planes.mjs';
import { minizSourceFragments } from '../miniz-source.mjs';
import { decodeQuantizedMesh } from './helpers.mjs';
import { TYPE, configFrame, storeAnswer, granuleFrame, STANDARDS_ROOT, flatbuffers } from '../typed-frames.mjs';
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from 'space-data-module-sdk/http';
import { tickFrame, outputs } from '../../terrain-ingest/tests/typed.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = path.join(root, 'data-source/terrain-source');
console.log(`lossless E2E pid=${process.pid}`);
const previous = '1fb1f1d4';
const outDir = process.env.LOSSLESS_OUT;
const dirs = { moon: process.env.LOLA_DIR, mars: process.env.MOLA_DIR };
for (const [body, dir] of Object.entries(dirs)) assert.ok(dir && fs.statSync(dir).isDirectory(), `${body}: local PDS directory is required`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-e2e-'));
const digest = (b) => '1220' + createHash('sha256').update(b).digest('hex');
const keyOf = (t) => `${t.LEVEL}/${t.X}/${t.Y}`;
const PNM = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);
const summary = new Map();
let totalFiles = 0, totalTiles = 0, totalOld = 0, totalNew = 0, checkedServing = false;
const index = [];

function run(exe, args, options = {}) {
  return execFileSync(exe, args, { maxBuffer: 128 * 1024 * 1024, ...options });
}
function extractDist(pkg) {
  const dest = path.join(temp, pkg);
  for (const name of ['isomorphic/module.wasm', 'plugin-manifest.json']) {
    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, run('git', ['-C', root, 'show', `${previous}:data-source/${pkg}/dist/${name}`]));
  }
  return dest;
}
// Compile the in-tree gzip_compress itself with the pinned miniz fragments. No zlib reimplementation of its
// compression settings: the exact function used by pack is the byte oracle, while Node zlib independently inflates.
async function gzipOracle() {
  const source = fs.readFileSync(path.join(sourceRoot, 'src/terrain_source_module.cpp'), 'utf8');
  const gzip = source.slice(source.indexOf('bool gzip_compress('), source.indexOf('\n// The reverse,', source.indexOf('bool gzip_compress(')));
  const cpp = `${(await minizSourceFragments()).join('\n')}\n#include <vector>\n#include <cstdint>\n#include <cstdio>\n
void put_u32(std::vector<uint8_t>* out, uint32_t v) { for (int i=0;i<4;i++) out->push_back(v >> (8*i)); }
${gzip}
int main(int argc, char** argv) { if (argc != 3) return 3; std::FILE* fi = std::fopen(argv[1], "rb"); if (!fi) return 4;
std::vector<uint8_t> in; uint8_t chunk[65536]; size_t n;
while ((n=std::fread(chunk,1,sizeof(chunk),fi))) in.insert(in.end(),chunk,chunk+n);
std::fclose(fi); std::vector<uint8_t> out; if (!gzip_compress(in,&out)) return 1;
std::FILE* fo = std::fopen(argv[2], "wb"); if (!fo) return 5;
const bool ok = std::fwrite(out.data(),1,out.size(),fo)==out.size(); std::fclose(fo); return ok ? 0 : 2; }`;
  const sourcePath = path.join(temp, 'gzip.cpp'), binary = path.join(temp, 'gzip');
  fs.writeFileSync(sourcePath, cpp);
  run('c++', ['-std=c++17', '-O2', '-Wno-pragma-once-outside-header', sourcePath, '-o', binary]);
  // Files, not pipes: the input and output go through the temp directory, so no pipe can stall the oracle.
  const input = path.join(temp, 'gzip-in'), output = path.join(temp, 'gzip-out');
  return (bytes) => { fs.writeFileSync(input, bytes); run(binary, [input, output], { stdio: 'ignore' }); return fs.readFileSync(output); };
}
function writeFile(side, file) {
  if (!outDir) return;
  const target = path.join(outDir, side, file.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.bytes);
}
function validateInputs(unit, dataDir) {
  for (const r of unit.requests) {
    const filename = path.join(dataDir, path.basename(new URL(r.url).pathname));
    const size = fs.statSync(filename).size;
    assert.ok(size > 0, `${filename}: empty input`);
    if (r.headers?.range) {
      const [, a, b] = r.headers.range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
      assert.ok(a <= b && b < size, `${filename}: requested range is missing`);
    }
  }
}
// Element-wise comparison of two parsed meshes: arrays by length and value (a plain loop, so thousands of tiles of
// tens of thousands of elements stay fast), everything else by deep equality.
function sameMesh(a, b, label, at = '') {
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    assert.ok(Array.isArray(b) || ArrayBuffer.isView(b), `${label}${at}: not an array`);
    assert.equal(a.length, b.length, `${label}${at}: length`);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] && typeof a[i] === 'object') sameMesh(a[i], b[i], label, `${at}[${i}]`);
      else assert.fail(`${label}${at}[${i}]: ${a[i]} != ${b[i]}`);
    }
    return;
  }
  if (a && typeof a === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${label}${at}: keys`);
    for (const k of Object.keys(a)) sameMesh(a[k], b[k], label, `${at}.${k}`);
    return;
  }
  assert.ok(Object.is(a, b), `${label}${at}: ${a} != ${b}`);
}
function unchanged(record) {
  const copy = structuredClone(record);
  for (const k of ['BYTES', 'CONTENT_ENCODING', 'SIZE_BYTES', 'DIGEST']) delete copy.PAYLOAD[k];
  delete copy.ETAG;
  return copy;
}
async function serving(lane, sized, raw, gzip) {
  const t = dttOf(sized.subarray(4)).unpack();
  const config = { terrain_tileset_id: t.TILESET_ID, terrain_maxzoom: 12 };
  for (const acceptsGzip of [true, false]) {
    let etag;
    for (const conditional of [false, true]) {
      const headers = [{ name: 'accept-encoding', value: acceptsGzip ? 'gzip' : 'identity' }];
      if (conditional) headers.push({ name: 'if-none-match', value: etag });
      const request = encodeHttpRequest({ method: 'GET', path: `/api/v1/terrain/${t.LEVEL}/${t.X}/${t.Y}.terrain`, headers });
      const r = await lane.source.invoke({ methodId: 'respond', inputs: [
        ...storeAnswer(sized), configFrame(config), { portId: 'context', typeRef: HTTP_REQUEST_TYPE_REF, payload: request },
      ] });
      assert.equal(r.statusCode, 0, r.errorMessage);
      const http = decodeHttpResponse(r.outputs[0].payload);
      const header = (name) => http.headers.find((h) => h.name === name)?.value;
      assert.equal(http.status, conditional ? 304 : 200);
      assert.equal(header('vary'), 'accept-encoding');
      if (conditional) assert.equal(http.body.length, 0);
      else {
        etag = header('etag');
        assert.equal(etag, acceptsGzip ? t.ETAG : `"identity-${t.PAYLOAD.DIGEST}"`);
        assert.equal(header('content-encoding'), acceptsGzip ? 'gzip' : undefined);
        assert.ok(Buffer.from(http.body).equals(acceptsGzip ? gzip(raw) : raw), "served representation bytes");
      }
    }
  }
  const refused = await lane.source.invoke({ methodId: 'reduce_parent', inputs: [
    { portId: 'children', typeRef: TYPE.DTT, payload: Uint8Array.from(sized) },
  ] });
  assert.notEqual(refused.statusCode, 0);
  assert.match(refused.errorMessage, /Earth.*regular grids.*body tiles/i);
  checkedServing = true;
}
async function importFiles(lane, files) {
  const names = [];
  for (const file of files) {
    const b = new flatbuffers.Builder(128);
    const n = new PNM.PNMT(); n.FILE_NAME = file.name;
    b.finishSizePrefixed(n.pack(b), '$PNM');
    names.push(Buffer.from(b.asUint8Array()));
  }
  const r = await lane.ingest.invoke({ methodId: 'import_files', inputs: [
    { portId: 'names', typeRef: TYPE.PNM ?? { schemaName: 'PNM.fbs', fileIdentifier: '$PNM', rootTypeName: 'PNM', wireFormat: 'flatbuffer' }, payload: Buffer.concat(names) },
    ...files.map((f) => granuleFrame('responses', f.bytes, 200, { url: `https://lossless.invalid/${f.name}` })),
  ] });
  assert.equal(r.statusCode, 0, `import_files: ${r.errorMessage}`);
  assert.deepEqual(r.outputs.filter((o) => o.portId === 'file').map((o) => Buffer.from(o.payload)), files.map((f) => f.bytes));
}

try {
  const oldSource = extractDist('terrain-source'), oldIngest = extractDist('terrain-ingest');
  const gzip = await gzipOracle();
  // Root unit includes every tile of levels 0, 1 and 2. Subsequent units are whole walk units, not sampled tiles.
  // Each cap is one level of the production table, so its first unit is deterministic without traversing earlier
  // caps. L11/L12 deliberately reuse the locally available 60 m south product in the -90..-85 band.
  const cap = (product, min_level, max_level, lat_min = -90, lat_max = 90) => ({ product, min_level, max_level, lat_min, lat_max });
  const cases = [{ body: 'moon', label: 'Moon L0-2 root', index: 0, caps: [cap('ldem_4', 0, 2)] }];
  for (let level = 3; level <= 12; level++) {
    const product = level <= 3 ? 'ldem_4' : level <= 5 ? 'ldem_16' : level <= 7 ? 'ldem_64' :
      level === 8 ? 'ldem_75s_240m' : level === 9 ? 'ldem_75s_120m' : 'ldem_75s_60m';
    const latMax = level <= 7 ? 90 : level === 8 ? -75 : level === 9 ? -80 : -85;
    // Mid-latitude cylindrical rows exercise relief; polar batches start at the cap's rim, where relief is dense.
    const unitIndex = level <= 7 ? 1 + Math.floor((2 ** level / 4) * 0.375) * Math.max(1, 2 ** level / 64) : 1;
    cases.push({ body: 'moon', level, label: `Moon L${level}`, index: unitIndex, caps: [cap('ldem_4', 0, 2), cap(product, level, level, -90, latMax)] });
  }
  cases.push({ body: 'mars', label: 'Mars L0-2 root', index: 0, caps: [cap('megr_4', 0, 2)] });
  for (const [product, lo, hi, label] of [['megr_128', -87.1875, 87.1875, 'cylindrical'], ['megr_s_512', -90, -87.1875, 'south pole'], ['megr_n_512', 87.1875, 90, 'north pole']])
    cases.push({ body: 'mars', label: `Mars L8 ${label}`, index: 1, caps: [cap('megr_4', 0, 2), cap(product, 8, 8, lo, hi)] });
  for (const c of cases) {
    // Dense L11/12 proof units: tighten the target so the unchanged gzip ceiling selects the density,
    // and bound the walk's range budget to its supported minimum (one complete polar block per unit).
    const dense = c.level >= 11 ? { max_range_bytes: 1024 * 1024, level_zero_error_m: 0.001 } : {};
    const config = { ...dense, ...(c.body === 'moon' ? MOON_CONFIG : MARS_CONFIG), caps: c.caps,
      import_base_url: 'https://lossless.invalid', import_from_unit: c.index, import_max_files: 1 };
    const args = { dataDir: dirs[c.body], config, clock: '2026-10-21T12:00:00.000Z' };
    const old = await createBodyLane({ ...args, sourceDist: oldSource, ingestDist: oldIngest });
    const current = await createBodyLane(args);
    try {
      const before = await old.planUnit(c.index), after = await current.planUnit(c.index);
      assert.ok(before && after, `${c.label}: required walk unit is missing`);
      validateInputs(before, args.dataDir); validateInputs(after, args.dataDir);
      assert.deepEqual(after.headers, before.headers, `${c.label}: plan changed`);
      assert.deepEqual(after.requests, before.requests, `${c.label}: source requests changed`);
      assert.deepEqual(after.options, before.options);
      console.log(`RUN ${c.label}: unit ${c.index}, ${before.headers.length} tiles`);
      const a = await old.encode(before);
      console.log(`ENCODED previous ${c.label}: ${(a.ms / 1000).toFixed(1)} s`);
      const b = await current.encode(after);
      console.log(`ENCODED current ${c.label}: ${(b.ms / 1000).toFixed(1)} s`);
      assert.equal(a.response.statusCode, 0, `previous ${c.label}: ${a.response.errorMessage}`);
      assert.equal(b.response.statusCode, 0, `current ${c.label}: ${b.response.errorMessage}`);
      const oldFiles = await old.pack(before, a.records), newFiles = await current.pack(after, b.records);
      const maxGzip = Math.max(...[...a.byKey.values()].map((s) => Number(dttOf(s.subarray(4)).PAYLOAD().SIZE_BYTES())));
      console.log(`DENSITY ${c.label}: max previous gzip=${maxGzip}, ceiling-limited=${b.report.tiles.filter((t) => t.overCap).length}`);
      if (c.level >= 11) assert.ok(b.report.tiles.some((t) => t.overCap), `${c.label}: exercise ceiling-selected density`);
      assert.deepEqual(newFiles.map((f) => f.name), oldFiles.map((f) => `${f.name}.gz`));
      const planned = await current.ingest.invoke({ methodId: 'import_plan', inputs: [tickFrame(args.clock)] });
      assert.equal(planned.statusCode, 0, planned.errorMessage);
      const plannedNames = splitSized(outputs(planned).get('names')[0]).map((s) => PNM.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(s)).FILE_NAME());
      assert.deepEqual([...plannedNames].sort(), newFiles.map((f) => f.name).sort());
      await importFiles(current, newFiles);
      for (let f = 0; f < oldFiles.length; f++) {
        const oldFile = oldFiles[f], newFile = newFiles[f];
        const stream = gunzipSync(newFile.bytes);
        assert.ok(gzip(stream).equals(newFile.bytes), `${newFile.name}: exact miniz gzip`);
        const originals = splitSized(oldFile.bytes), revised = splitSized(stream);
        assert.deepEqual(revised.map((s) => keyOf(dttOf(s.subarray(4)).unpack())), originals.map((s) => keyOf(dttOf(s.subarray(4)).unpack())));
        const fileLevels = new Map();
        for (let k = 0; k < originals.length; k++) {
          const x = dttOf(originals[k].subarray(4)).unpack(), y = dttOf(revised[k].subarray(4)).unpack();
          const stored = Buffer.from(y.PAYLOAD.BYTES), raw = gunzipSync(Buffer.from(x.PAYLOAD.BYTES));
          assert.equal(x.PAYLOAD.CONTENT_ENCODING, 'gzip');
          assert.equal(y.PAYLOAD.CONTENT_ENCODING, EDGE_MATCHED_PLANES);
          const decoded = decodeEdgeMatchedPlanes(stored);
          assert.ok(decoded.equals(raw), `${c.label} ${keyOf(x)}: exact QM bytes`);
          sameMesh(decodeQuantizedMesh(decoded), decodeQuantizedMesh(raw), `${keyOf(x)}: u/v/height, indices, edges and oct normals`);
          assert.deepEqual(unchanged(y), unchanged(x), `${keyOf(x)}: all other DTT fields`);
          assert.equal(y.PAYLOAD.DIGEST, digest(stored));
          assert.equal(y.PAYLOAD.SIZE_BYTES, BigInt(stored.length));
          assert.equal(y.ETAG, `"${digest(stored)}"`);
          assert.ok(x.PAYLOAD.BYTES.length <= 32768, `${keyOf(x)}: unchanged serving ceiling`);
          const row = `${c.body} L${x.LEVEL}`;
          if (!summary.has(row)) summary.set(row, { tiles: 0, old: 0, new: 0 });
          summary.get(row).tiles++;
          fileLevels.set(row, (fileLevels.get(row) ?? 0) + 1);
          if (!checkedServing) await serving(current, revised[k], raw, gzip);
        }
        // A root file spans levels 0-2: report its bytes together, without attributing gzip savings to a tile.
        const byteRow = fileLevels.size === 1 ? [...fileLevels.keys()][0] : `${c.body} L0-2 files`;
        if (!summary.has(byteRow)) summary.set(byteRow, { tiles: 0, old: 0, new: 0 });
        summary.get(byteRow).old += oldFile.bytes.length; summary.get(byteRow).new += newFile.bytes.length;
        totalTiles += originals.length; totalFiles++; totalOld += oldFile.bytes.length; totalNew += newFile.bytes.length;
        writeFile('old', oldFile); writeFile('new', newFile);
        index.push(`${c.label}\tunit=${c.index}\ttiles=${originals.length}\told/${oldFile.name}\tnew/${newFile.name}`);
      }
      console.log(`PASS ${c.label}: ${oldFiles.length} files, ${a.byKey.size} tiles, old=${oldFiles.reduce((n,f)=>n+f.bytes.length,0)} new=${newFiles.reduce((n,f)=>n+f.bytes.length,0)} bytes`);
      if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'units.txt'), index.join('\n') + '\n'); }
    } finally { old.destroy(); current.destroy(); }
  }
  console.log('LOSSLESS FORMAT E2E SUMMARY');
  for (const [level, s] of summary) console.log(`${level}: tiles=${s.tiles} old=${s.old} new=${s.new} bytes`);
  console.log(`TOTAL: files=${totalFiles} tiles=${totalTiles} old=${totalOld} new=${totalNew} bytes saved=${totalOld-totalNew} (${(100*(1-totalNew/totalOld)).toFixed(2)}%)`);
  console.log('PASS: exact QM bytes/arrays/extensions, unchanged DTT fields, stored-byte digests/sizes/ETags, exact miniz file gzip, names/tile sets, import plan/files, respond gzip/identity/304, body parent refusal');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
