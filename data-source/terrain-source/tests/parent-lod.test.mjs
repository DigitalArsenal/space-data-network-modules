// Compiled parent reduction against independently decoded mesh coordinates,
// an analytic height plane, canonical SDS records and adversarial wire inputs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { Builder, ByteBuffer } from 'flatbuffers';
import * as sds from 'spacedatastandards.org';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { buildGeoTiff, buildWaterTiff, decodeQuantizedMesh, splitStream } from './helpers.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const S = sds.standards.DTT;
const digest = bytes => `1220${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const frame = (portId, payload, typed = false) => ({ portId, payload: Uint8Array.from(payload),
  typeRef: typed ? { schemaName: 'DTT.fbs', fileIdentifier: '$DTT', rootTypeName: 'DTT', wireFormat: 'flatbuffer' }
    : { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } });
const json = (port, value) => frame(port, Buffer.from(JSON.stringify(value)));
function raw(port, body, status = 200) {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.write('$HRB'); bytes.writeUInt32LE(status, 4); Buffer.from(body).copy(bytes, 8);
  return frame(port, bytes);
}
function stream(records) {
  return Buffer.concat(records.map(record => {
    const size = Buffer.alloc(4); size.writeUInt32LE(record.length);
    return Buffer.concat([size, Buffer.from(record)]);
  }));
}
function read(record) { return S.DTT.getRootAsDTT(new ByteBuffer(Uint8Array.from(record))).unpack(); }
function write(record) {
  const builder = new Builder(4096);
  S.DTT.finishDTTBuffer(builder, record.pack(builder));
  return Buffer.from(builder.asUint8Array());
}
function modify(bytes, edit) { const record = read(bytes); edit(record); return write(record); }
function mesh(record) { return decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(record.PAYLOAD.BYTES))); }
function mask(record) {
  if (record.WATER_MASK_KIND === S.dttWaterMask.RASTER)
    return zlib.gunzipSync(Buffer.from(record.WATER_MASK.BYTES));
  return Buffer.alloc(65536, record.WATER_MASK_KIND === S.dttWaterMask.UNIFORM_WATER ? 255 : 0);
}
function ok(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.find(output => output.portId === 'records').payload;
}
async function harness(t, source = wasm) {
  const instance = await createBrowserModuleHarness({ wasmSource: source, manifest, surface: 'direct' });
  t.after(() => instance.destroy());
  return instance;
}
async function reduce(instance, records) {
  return instance.invoke({ methodId: 'reduce_parent', inputs: [frame('children', stream(records), true)] });
}
const provenance = {
  datasetId: 'parent-lod-analytic-fixture', datasetName: 'Analytic terrain fixture',
  datasetEpoch: '2023-04-01T00:00:00.000Z', retrievedAt: '2026-09-09T12:00:00.000Z',
  license: 'CC0 synthetic fixture', attribution: 'Analytic test data, not published terrain',
};
async function children(instance, { level = 8, parentX = 135, parentY = 96, ocean = false,
                                      heightFn = (x, y) => -100 + x + 2 * y } = {}) {
  const span = 180 / 2 ** (level - 1), west = -180 + parentX * span;
  const north = -90 + (parentY + 1) * span;
  const geometry = { width: 65, height: 65, originLon: west, originLat: north,
    scaleLon: span / 64, scaleLat: span / 64 };
  const dem = buildGeoTiff({ ...geometry, heightFn });
  const water = buildWaterTiff({ ...geometry, classFn: (_x, y) => y < 32 ? 1 : 0 });
  const records = [];
  for (let q = 0; q < 4; q++) {
    const plan = { tilesetId: 'parent-lod-test', scheme: 'GEOGRAPHIC_WGS84', rowOriginNorth: false,
      level, x: parentX * 2 + q % 2, y: parentY * 2 + Math.floor(q / 2),
      gridSize: 9, minGridSize: 9, maxGridSize: 9, maxLevel: level,
      skipOceanTiles: false, measureAccuracy: true, verticalDatumName: 'EGM2008', provenance };
    const result = await instance.invoke({ methodId: 'tile', inputs: [json('plan', plan),
      raw('dem', ocean ? Buffer.alloc(0) : dem, ocean ? 404 : 200),
      raw('water', ocean ? Buffer.alloc(0) : water, ocean ? 404 : 200)] });
    const batch = splitStream(ok(result));
    assert.equal(batch.length, 1, 'native tile retains an observed ocean sibling when requested');
    records.push(Buffer.from(batch[0]));
  }
  return records;
}

test('native parent preserves the analytic height plane, north-oriented coast, and complete lineage', async t => {
  const instance = await harness(t), records = await children(instance);
  const result = Buffer.from(ok(await reduce(instance, records)));
  const parent = read(splitStream(result)[0]), decoded = mesh(parent);
  assert.equal(parent.LEVEL, 7); assert.equal(parent.X, 135); assert.equal(parent.Y, 96);
  assert.equal(parent.CHILD_AVAILABILITY, 15); assert.equal(parent.MAX_LEVEL, 8);
  assert.equal(parent.VERTICAL_DATUM, S.dttVerticalDatum.GEOID);
  assert.equal(parent.VERTICAL_DATUM_NAME, 'EGM2008');
  assert.equal(decoded.vertexCount, 65 * 65);
  assert.equal(decoded.triangleCount, 64 * 64 * 2);
  assert.equal(decoded.bytesRead, zlib.gunzipSync(Buffer.from(parent.PAYLOAD.BYTES)).length);
  // Height truth is the fixture's analytic source plane, independent of both
  // native encoders. Quantized horizontal coordinates introduce <0.02 m here.
  for (let i = 0; i < decoded.vertexCount; i++) {
    const u = decoded.u[i] / 32767, v = decoded.v[i] / 32767;
    const expected = -100 + 64 * u + 128 * (1 - v);
    const actual = decoded.header.minHeight +
      (decoded.header.maxHeight - decoded.header.minHeight) * decoded.h[i] / 32767;
    assert.ok(Math.abs(actual - expected) < 0.03, `${actual} vs analytic ${expected}`);
  }
  const water = mask(parent);
  assert.equal(water[0], 255, 'row zero is north, not TMS south');
  assert.equal(water.at(-1), 0, 'below-sea-level southern land is still land');
  const query = JSON.parse(parent.PROVENANCE.SOURCE_QUERY);
  assert.deepEqual(query.children, records.map(bytes => {
    const child = read(bytes); return { level: child.LEVEL, x: child.X, y: child.Y, digest: digest(bytes) };
  }));
  assert.equal(query.heightBound, 'child-cell-parent-cell-envelope-v1');
  assert.equal(query.waterReduction, 'coverage-2x2-round-half-up-v1');
  assert.equal(query.inheritedAccuracyComplete, true);
  assert.ok(query.meshDifferenceBoundM > 0);
  assert.ok(parent.VERTICAL_ACCURACY_M >= query.meshDifferenceBoundM - 1e-7);
  assert.equal(parent.ACCURACY_CONFIDENCE, 1);
  assert.equal(parent.PROVENANCE.GENERATED_AT, null, 'does not mislabel retrieval as production time');
  assert.equal(parent.PROVENANCE.PROCESSOR, 'com.digitalarsenal.data-source.terrain-source/reduce_parent@0.1.1');
  assert.equal(parent.PAYLOAD.DIGEST, digest(Buffer.from(parent.PAYLOAD.BYTES)));
  const reordered = Buffer.from(ok(await reduce(instance, records.toReversed())));
  assert.equal(digest(reordered), digest(result),
    'input ordering cannot change the canonical output');
});

test('actual native ocean records reduce to zero-height water without inventing source-post accuracy', async t => {
  const instance = await harness(t), records = await children(instance, { ocean: true });
  const parent = read(splitStream(ok(await reduce(instance, records)))[0]);
  assert.equal(parent.WATER_MASK_KIND, S.dttWaterMask.UNIFORM_WATER);
  assert.equal(parent.MIN_HEIGHT_M, 0); assert.equal(parent.MAX_HEIGHT_M, 0);
  assert.equal(parent.ACCURACY_CONFIDENCE, 0);
  assert.equal(parent.DATA_COVERAGE_FRACTION, 0);
  const query = JSON.parse(parent.PROVENANCE.SOURCE_QUERY);
  assert.equal(query.inheritedAccuracyComplete, false);
  assert.equal(query.meshDifferenceBoundM, 0);
});

test('rounded coverage preserves mixed coastline values rather than inventing categorical water', async t => {
  const instance = await harness(t), original = await children(instance, { ocean: true });
  const records = original.map(bytes => modify(bytes, record => {
    const coverage = Buffer.alloc(65536);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) coverage[y * 256 + x] = x % 2 ? 255 : 0;
    const encoded = zlib.gunzipSync(Buffer.from(record.PAYLOAD.BYTES));
    const changed = Buffer.concat([encoded.subarray(0, -6), Buffer.from([2, 0, 0, 1, 0]), coverage]);
    const payload = zlib.gzipSync(changed, { mtime: 0 });
    record.PAYLOAD.BYTES = [...payload]; record.PAYLOAD.SIZE_BYTES = BigInt(payload.length);
    record.PAYLOAD.DIGEST = digest(payload);
    record.WATER_MASK_KIND = S.dttWaterMask.RASTER;
    record.WATER_MASK_WIDTH = record.WATER_MASK_HEIGHT = 256;
    const stored = zlib.gzipSync(coverage, { mtime: 0 });
    record.WATER_MASK = new S.DTTPayloadRefT(null, [...stored], BigInt(stored.length), digest(stored), 'gzip', 'application/octet-stream');
  }));
  const parent = read(splitStream(ok(await reduce(instance, records)))[0]);
  assert.equal(parent.WATER_MASK_KIND, S.dttWaterMask.RASTER);
  assert.ok(mask(parent).every(value => value === 128), 'two water and two land samples give half coverage');
});

test('native parent refuses missing, duplicate, surplus, mixed and corrupt child records', async t => {
  const instance = await harness(t), records = await children(instance);
  const cases = [
    ['missing', records.slice(0, 3)], ['duplicate', [records[0], records[0], records[2], records[3]]],
    ['surplus', [...records, records[0]]],
    ...[
      ['epoch', r => { r.PROVENANCE.DATASET_EPOCH = '2024-04-01T00:00:00.000Z'; }],
      ['datum', r => { r.VERTICAL_DATUM_NAME = 'EGM96'; }],
      ['licence', r => { r.PROVENANCE.LICENSE = 'different terms'; }],
      ['address', r => { r.X += 2; }], ['extent', r => { r.WEST_DEG += 0.5; }],
      ['row origin', r => { r.ROW_ORIGIN_NORTH = true; }],
      ['digest', r => { r.PAYLOAD.DIGEST = '1220' + '0'.repeat(64); }],
      ['mask mismatch', r => { r.WATER_MASK_KIND = S.dttWaterMask.UNIFORM_WATER; }],
      ['gzip CRC', r => {
        const bytes = Buffer.from(r.PAYLOAD.BYTES); bytes[bytes.length - 8] ^= 1;
        r.PAYLOAD.BYTES = [...bytes]; r.PAYLOAD.DIGEST = digest(bytes);
      }],
      ['gzip allocation', r => {
        const bytes = Buffer.from(r.PAYLOAD.BYTES); bytes.writeUInt32LE(0x7fffffff, bytes.length - 4);
        r.PAYLOAD.BYTES = [...bytes]; r.PAYLOAD.DIGEST = digest(bytes);
      }],
    ].map(([name, edit]) => [name, [modify(records[0], edit), ...records.slice(1)]]),
  ];
  for (const [name, input] of cases) {
    const response = await reduce(instance, input);
    assert.equal(response.statusCode, 400, name);
    assert.equal(response.errorCode, 'invalid-parent-children', name);
    assert.equal(response.outputs.length, 0, `${name}: no partial parent publication`);
  }
  const extraFrame = await instance.invoke({ methodId: 'reduce_parent', inputs: [
    frame('children', stream(records), true), frame('children', stream(records), true)] });
  assert.notEqual(extraFrame.statusCode, 0, 'surplus frame is refused rather than dropped');
  assert.equal(extraFrame.outputs.length, 0);
});

test('root-address reduction retains western and eastern hemispheres and polar extents', async t => {
  const instance = await harness(t);
  for (const parentX of [0, 1]) {
    const records = await children(instance, { level: 1, parentX, parentY: 0, ocean: true });
    const parent = read(splitStream(ok(await reduce(instance, records)))[0]);
    assert.equal(parent.LEVEL, 0); assert.equal(parent.X, parentX); assert.equal(parent.Y, 0);
    assert.equal(parent.WEST_DEG, -180 + parentX * 180);
    assert.equal(parent.EAST_DEG, parentX * 180);
    assert.equal(parent.SOUTH_DEG, -90); assert.equal(parent.NORTH_DEG, 90);
    assert.ok(mesh(parent).indices.every(index => index < 65 * 65));
  }
});

test('derived accuracy conservatively combines independent quadrant maxima and survives another reduction', async t => {
  const instance = await harness(t), parents = [];
  for (let q = 0; q < 4; q++) {
    const records = await children(instance, { level: 3, parentX: q % 2, parentY: Math.floor(q / 2),
      heightFn: (x, y) => q === 0 ? 10 : -100 + x + 2 * y });
    const modified = records.map((bytes, i) => modify(bytes, record => {
      record.ACCURACY_CONFIDENCE = 1;
      record.VERTICAL_ACCURACY_M = i === 0 ? 1000 : 0;
    }));
    const bytes = Buffer.from(splitStream(ok(await reduce(instance, modified)))[0]);
    const parent = read(bytes), query = JSON.parse(parent.PROVENANCE.SOURCE_QUERY);
    assert.ok(parent.VERTICAL_ACCURACY_M >= 1000 + query.meshDifferenceBoundM,
      'largest child source error and largest mesh difference need not occur in the same quadrant');
    parents.push(bytes);
  }
  const next = read(splitStream(ok(await reduce(instance, parents)))[0]);
  const query = JSON.parse(next.PROVENANCE.SOURCE_QUERY);
  assert.equal(next.LEVEL, 1); assert.equal(next.ACCURACY_CONFIDENCE, 1);
  assert.equal(query.inheritedAccuracyComplete, true);
  assert.deepEqual(query.children.map(child => child.digest), parents.map(digest));
  assert.ok(next.VERTICAL_ACCURACY_M >= Math.max(...parents.map(bytes => read(bytes).VERTICAL_ACCURACY_M)) +
    query.meshDifferenceBoundM);
});

test('matching parent edges retain analytic heights across the prime meridian and high-latitude seam', async t => {
  const instance = await harness(t), parents = [];
  for (const parentX of [255, 256]) {
    // Both sources describe h=longitude+latitude on either side of the same edge.
    const level = 9, parentY = 250, span = 180 / 2 ** (level - 1);
    const west = -180 + parentX * span, north = -90 + (parentY + 1) * span;
    const records = await children(instance, { level, parentX, parentY,
      heightFn: (x, y) => west + span * x / 64 + north - span * y / 64 });
    parents.push(mesh(read(splitStream(ok(await reduce(instance, records)))[0])));
  }
  const edge = (decoded, which) => decoded.edges[which].map(index => ({
    v: decoded.v[index], h: decoded.header.minHeight +
      (decoded.header.maxHeight - decoded.header.minHeight) * decoded.h[index] / 32767,
  })).sort((a, b) => a.v - b.v);
  const east = edge(parents[0], 'east'), west = edge(parents[1], 'west');
  assert.deepEqual(east.map(p => p.v), west.map(p => p.v));
  for (let i = 0; i < east.length; i++) assert.ok(Math.abs(east[i].h - west[i].h) < 0.0001,
    'shared edge differs by no more than the independently bounded quantization error');
});

test('shipped and bridge-free diagnostic artifacts agree on frozen parent inputs and refusal', async t => {
  const shipped = await harness(t);
  const diagnostic = await harness(t, fs.readFileSync(new URL('../dist/parity/module.wasm', import.meta.url)));
  const fixtureRoot = new URL('./fixtures/parent-lod/', import.meta.url);
  const inventory = JSON.parse(fs.readFileSync(new URL('inputs.json', fixtureRoot)));
  for (const file of inventory.files) {
    const bytes = fs.readFileSync(new URL(file.name, fixtureRoot));
    assert.equal(bytes.length, file.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256,
      'frozen parity input has explicit provenance');
    const request = {methodId:'reduce_parent',inputs:[frame('children',bytes,true)]};
    const a = await shipped.invoke(request), b = await diagnostic.invoke(request);
    const refusal = file.name === 'missing-child.dttstream';
    assert.equal(a.statusCode, refusal ? 400 : 0);
    assert.equal(a.errorCode, refusal ? 'invalid-parent-children' : null);
    assert.equal(b.statusCode, a.statusCode);
    assert.equal(b.errorCode, a.errorCode);
    assert.equal(b.outputs.length, a.outputs.length);
    for (let i = 0; i < a.outputs.length; i++) {
      assert.equal(b.outputs[i].portId, a.outputs[i].portId);
      assert.equal(digest(b.outputs[i].payload), digest(a.outputs[i].payload));
    }
  }
});
