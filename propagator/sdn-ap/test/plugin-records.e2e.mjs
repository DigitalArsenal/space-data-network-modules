#!/usr/bin/env node
// ABI/lifecycle comparisons on synthetic records, not a physics calibration. Reference: the existing epoch and frame
// exports at the same UTC double JD; ECEF m and m/s. Layout comparisons are bit exact. AP versus direct uses the frame
// contract's 0.01 m and 0.0001 m/s 3-D bounds. Metadata uses the input elements and the definition of minutes per day.
import assert from 'node:assert/strict';
import {buildPluginDiagnostic} from './lib/plugin-diagnostic.mjs';
import { openFrames, population, ocmOfObject, EPOCH_MS, revPerDay } from './lib/frame-cells.mjs';
import { T, repackOcm, rowsThrough } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { elementRows } from './lib/module.mjs';
import * as flatbuffers from 'flatbuffers';
import { OMM, OMMT } from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import { pcfWeatherSource } from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';

const pop = population([['leo500', 3], ['wide', 1], ['underground', 1]], 20261113);
const ap = pop.map(o => ocmOfObject(o));
const xp = ocmOfObject({ ...pop[0], norad: 400001 }, false);
const sg = repackOcm(ocmOfObject({ ...pop[1], norad: 400002 }, false), t => {
  t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 0; t.ORB_AVERAGING = 'KOZAI'; t.PERTURBATIONS.WEATHER_SOURCE = 4; t.PERTURBATIONS.ATMOSPHERIC_MODEL = null; t.PERTURBATIONS.GRAVITY_MODEL = 'WGS-72';
  t.MEAN_ELEMENTS.BTERM = 0; t.MEAN_ELEMENTS.AGOM = 0;
});
const ignored = repackOcm(ap[0], t => { t.CENTER_NAME = 'MARS'; });
const newer = repackOcm(ap[2], t => { t.MEAN_ELEMENTS.MEAN_ANOMALY += 1; });
const records = [ap[2], ignored, sg, ap[3], xp, ap[0], ap[1], ap[4], newer];
const rawOrder = [2, 6, 3, 5, 0, 1, 4];
const prefixed = bytes => { const b = Buffer.alloc(bytes.length + 4); b.writeUInt32LE(bytes.length); b.set(bytes, 4); return b; };
const input = bytes => ({ portId: 'ocm', typeRef: T('OCM'), payload: Buffer.concat(bytes.map(prefixed)) });
const wasm = process.env.SDNAP_WASM ?? buildPluginDiagnostic();
const f = await openFrames({ wasm, initialMemoryBytes: 2 << 20 });
const { x, h, mem } = f;
for (const name of ['sdnap_test_fail_at', 'sdnap_test_alloc_count', 'sdnap_test_plugin_dead',
  'sdnap_test_plugin_active', 'sdnap_test_plugin_slot_bytes', 'sdnap_test_plugin_init_tables'])
  assert.equal(typeof x[name], 'function', `${name} requires test/lib/plugin-diagnostic.mjs buildPluginDiagnostic(); unset SDNAP_WASM to build it`);
const p = x.sdnap_alloc(65536), structs = p, positions = p + 8192, planes = p + 24576, statuses = p + 32768, omm = p + 40000;
const f64 = (ptr, count) => new Float64Array(mem(), ptr, count);
const bytes = (ptr, count) => Buffer.from(new Uint8Array(mem(), ptr, count));
const jd = EPOCH_MS / 86400000 + 2440587.5 + 1 / 24;
const split = value => { const w = Math.floor(value - 0.5) + 0.5; return [w, value - w]; };
const call = (methodId, inputs = []) => h.invoke({ methodId, inputs });
const ok = r => assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
const refusal = (r, code) => { assert.equal(r.statusCode, 3); assert.equal(r.errorCode, code); };
const state = (index, when = jd) => { const rc = x.plugin_propagate(when, index, structs); return { rc, bytes: bytes(structs, 64), values: Array.from(f64(structs + 8, 6)), flags: new DataView(mem()).getUint32(structs + 60, true) }; };
const bulk = (when = jd, count = 7) => { assert.equal(x.plugin_propagate_all_positions(when, positions, count), Math.min(7, count)); return bytes(positions, Math.min(7, count) * 24); };
async function load(parts = [records]) {
  const oldCount = x.plugin_entity_count();
  ok(await call('load_epochs_open'));
  assert.equal(x.plugin_entity_count(), oldCount);
  for (const part of parts) ok(await call('load_epochs_part', [input(part)]));
  ok(await call('load_epochs_close'));
  assert.equal(x.plugin_entity_count(), 7);
  f.adopt(7);
}
function fill() { assert.equal(f.open(1 << 20), 0); assert.equal(f.fill((jd - 2440587.5) * 86400000, 180).rc, 0); }
function checkMapped() {
  const [w, frac] = split(jd);
  assert.equal(x.plugin_propagate_batch(jd, structs, 7), 0);
  const batch = bytes(structs, 448);
  const all = bulk();
  for (let i = 0; i < 7; ++i) {
    const q = state(i);
    assert.deepEqual(q.bytes, batch.subarray(64 * i, 64 * i + 64));
    assert.deepEqual(q.bytes.subarray(8, 32), all.subarray(24 * i, 24 * i + 24));
    assert.equal(q.bytes[56], 3); assert.deepEqual(q.bytes.subarray(57, 60), Buffer.alloc(3));
    assert.equal(new DataView(q.bytes.buffer, q.bytes.byteOffset).getFloat64(0, true), jd);
    const raw = rawOrder[i];
    const stock = i === 1 || i === 3;
    const rc = stock ? x.sdnap_epochs_at(w, frac, raw, 1, 3, planes, statuses, 0) : x.sdnap_frames_at(w, frac, raw, 1, 3, planes, statuses);
    assert.equal(rc, 0);
    const status = new Int32Array(mem(), statuses, 1)[0];
    if (status === 0) {
      assert.equal(q.rc, 0); assert.equal(q.flags & 1, 1);
      assert.deepEqual(q.bytes.subarray(8, 56), bytes(planes, 48));
      if (!stock) {
        assert.equal(x.sdnap_epochs_at(w, frac, raw, 1, 3, planes, statuses, 0), 0);
        const direct = Array.from(f64(planes, 6));
        assert.ok(Math.hypot(...direct.slice(0, 3).map((v, a) => v - q.values[a])) <= .01);
        assert.ok(Math.hypot(...direct.slice(3).map((v, a) => v - q.values[a + 3])) <= .0001);
      }
    } else { assert.ok(q.values.every(Number.isNaN)); assert.equal(q.flags & 1, 0); }
  }
  return all;
}
await load([records.slice(0, 2), records.slice(2, 6), records.slice(6)]);
// Mixed catalog: exactly the two stock entities are visible before any frame cell exists.
for (let i = 0; i < 7; ++i) assert.equal(state(i).rc === 0, i === 1 || i === 3);
assert.equal(x.plugin_init_omm(0, 1), -4); assert.equal(x.plugin_entity_count(), 7);
fill(); const original = checkMapped();
await load(); fill(); assert.deepEqual(checkMapped(), original);
assert.deepEqual(bulk(jd, 3), original.subarray(0, 72));
assert.equal(x.plugin_propagate_all_positions(jd, 0, 0), 0);
assert.equal(x.plugin_propagate_all_positions(NaN, positions, 7), -4);
assert.equal(x.plugin_propagate(jd, 7, structs), -2);
assert.equal(x.plugin_propagate(jd, 0, 0), -3);
assert.equal(x.plugin_propagate_batch(jd, structs, 8), -2);
assert.equal(x.plugin_propagate_batch(Infinity, structs, 7), -4);
assert.equal(x.get_orbital_period(0), 1440 / revPerDay(pop[2].a));
assert.equal(x.get_eccentricity(0), pop[2].e);
assert.equal(x.get_orbital_period(99), 0); assert.ok(Number.isNaN(x.get_eccentricity(99)));
// Every direct path sample matches the epoch API, including negative/zero steps and unsupported AP cells.
let samples = 0;
for (const [index, step, count] of [[0, 20 / 86400, 360], [1, -20 / 86400, 8], [2, 0, 3], [3, 30 / 86400, 8], [6, 10 / 86400, 3]]) {
  assert.equal(x.plugin_propagate_path(index, jd, step, count, positions), count);
  assert.equal(x.sdnap_test_plugin_slot_bytes(index), 0);
  const path = bytes(positions, 24 * count);
  for (let i = 0; i < count; ++i) {
    const [w, frac] = split(jd + i * step);
    assert.equal(x.sdnap_epochs_at(w, frac, rawOrder[index], 1, 3, planes, statuses, 0), 0);
    const status = new Int32Array(mem(), statuses, 1)[0];
    if (status === 0) assert.deepEqual(path.subarray(i * 24, i * 24 + 24), bytes(planes, 24));
    else assert.ok(new Float64Array(path.buffer, path.byteOffset + i * 24, 3).every(Number.isNaN));
    ++samples;
  }
}
assert.deepEqual(bulk(), original);
assert.equal(x.plugin_propagate_path(99, NaN, NaN, 0, 0), 0);
assert.equal(x.plugin_propagate_path(99, jd, 1, 1, positions), -2);
assert.equal(x.plugin_propagate_path(0, jd, Infinity, 1, positions), -4);
// Bad paths leave the output untouched, including arithmetic overflow and the documented cap.
for (const [start, step, count, output, code] of [
  [jd, 1, 1, 0, -3], [NaN, 1, 2, positions, -4], [jd, NaN, 2, positions, -4],
  [jd, 1, 1000001, positions, -4], [jd, 1, 0x40000000, positions, -4],
  [-Number.MAX_VALUE, Number.MAX_VALUE, 3, positions, -4]]) {
  const saved = bytes(positions, 24);
  assert.equal(x.plugin_propagate_path(0, start, step, count, output), code);
  assert.deepEqual(bytes(positions, 24), saved);
}
// Position-only cells supply bulk positions and never fabricate a struct velocity.
x.sdnap_frames_close(); assert.equal(f.open(1 << 20, 1), 0); f.fill((jd - 2440587.5) * 86400000, 180);
assert.equal(state(0).rc, -8); assert.equal(state(1).rc, 0); assert.ok(f64(positions, 3).length);
assert.equal(x.plugin_propagate_all_positions(jd, positions, 7), 7); assert.ok(f64(positions, 3).every(Number.isFinite));
x.sdnap_frames_close(); fill();
// Transaction failures preserve the old entry and every old cell.
const beforeReplace = bulk();
refusal(await call('replace_epoch', [input([ap[0], ap[0]])]), 'replace-one-record');
refusal(await call('replace_epoch', [input([repackOcm(ap[0], t => { t.METADATA.NORAD_CAT_ID += 999; })])]), 'replace-identity-missing');
assert.equal((await call('replace_epoch', [input([new Uint8Array([1, 2, 3])])])).statusCode, 3);
assert.deepEqual(bulk(), beforeReplace);
const changed = repackOcm(newer, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY += 2; });
ok(await call('replace_epoch', [input([changed])]));
assert.equal(x.plugin_entity_count(), 7); assert.equal(state(0).rc, -8);
assert.deepEqual(bulk().subarray(24), beforeReplace.subarray(24));
assert.equal(f.fill((jd - 2440587.5) * 86400000, 180).rc, 0);
assert.equal(state(0).rc, 0); assert.notDeepEqual(bulk().subarray(0, 24), beforeReplace.subarray(0, 24));
assert.deepEqual(bulk().subarray(24), beforeReplace.subarray(24));
function compareCellDirect(index, raw) {
  const q = state(index), [w, frac] = split(jd);
  assert.equal(q.rc, 0);
  assert.equal(x.sdnap_epochs_at(w, frac, raw, 1, 3, planes, statuses, 0), 0);
  assert.equal(new Int32Array(mem(), statuses, 1)[0], 0);
  const direct = Array.from(f64(planes, 6));
  assert.ok(Math.hypot(...direct.slice(0, 3).map((v, a) => v - q.values[a])) <= .01);
  assert.ok(Math.hypot(...direct.slice(3).map((v, a) => v - q.values[a + 3])) <= .0001);
}
compareCellDirect(0, rawOrder[0]);
const shifted = repackOcm(newer, t => {
  t.MEAN_ELEMENTS.EPOCH = new Date(EPOCH_MS + 120000).toISOString();
  t.TRAJ_FRAME_EPOCH = t.MEAN_ELEMENTS.EPOCH;
});
ok(await call('replace_epoch', [input([shifted])])); assert.equal(state(0).rc, -8);
f.fill((jd - 2440587.5) * 86400000, 180); compareCellDirect(0, rawOrder[0]);
const ineligible = repackOcm(newer, t => { t.MEAN_ELEMENTS.ECCENTRICITY = .4; });
const eligibleBefore = f.stats()[1];
ok(await call('replace_epoch', [input([ineligible])])); assert.equal(f.stats()[1], eligibleBefore - 1);
f.fill((jd - 2440587.5) * 86400000, 180); assert.equal(state(0).rc, -8);
ok(await call('replace_epoch', [input([newer])])); assert.equal(f.stats()[1], eligibleBefore);
f.fill((jd - 2440587.5) * 86400000, 180); compareCellDirect(0, rawOrder[0]);
const sgChanged = repackOcm(sg, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY += 7; });
const sgBefore = state(1).bytes;
ok(await call('replace_epoch', [input([sgChanged])])); assert.notDeepEqual(state(1).bytes, sgBefore);
compareCellDirect(1, rawOrder[1]);
// Weather-bearing replacements preserve other cells and intern/reclaim their own weather.
const weather = repackOcm(newer, t => {
  t.PERTURBATIONS.WEATHER_SOURCE = pcfWeatherSource.RECORDS;
  t.PERTURBATIONS.SPACE_WEATHER = rowsThrough(Array.from({length: 9}, (_, i) => ({
    DATE: new Date(EPOCH_MS + (i - 4) * 86400000).toISOString().slice(0, 10),
    F107_OBS: 140, F107_OBS_CENTER81: 140, AP_AVG: 5, F107_DATA_TYPE: 0 })));
});
const otherCells = bulk().subarray(24);
ok(await call('replace_epoch', [input([weather])]));
assert.deepEqual(bulk().subarray(24), otherCells);
f.fill((jd - 2440587.5) * 86400000, 180); compareCellDirect(0, rawOrder[0]);
ok(await call('replace_epoch', [input([newer])]));
// Repeated replacement owns no growing collection of detached records or cells.
for (let i = 0; i < 12; ++i) ok(await call('replace_epoch', [input([i % 2 ? newer : changed])]));
// Refused and incomplete loads preserve the active snapshot.
ok(await call('load_epochs_open')); assert.equal(x.plugin_entity_count(), 7);
refusal(await call('replace_epoch', [input([changed])]), 'records-not-loaded');
assert.equal((await call('load_epochs_part', [input([new Uint8Array([0])])])).statusCode, 3);
assert.equal(x.plugin_entity_count(), 7); refusal(await call('load_epochs_close'), 'load-not-open');
// The unchanged 88-byte struct input and 64-byte output are compared with the control artifact.
const data = new Uint8Array(3 * 88), view = new DataView(data.buffer);
for (let i = 0; i < 3; ++i) [jd - 1 / 24, 14 + i / 10, .001, 55, 8 * i, 30, 30 + i, .001, 0, .001].forEach((v, k) => view.setFloat64(88 * i + 8 * k, v, true));
new Uint8Array(mem(), omm, data.length).set(data);
await load(); new Uint8Array(mem(), omm, data.length).set(data);
assert.equal(x.plugin_init_omm(omm, 3), 3); assert.equal(x.sdnap_epochs_count(), 7); assert.equal(x.plugin_entity_count(), 3);
assert.equal(x.plugin_propagate_batch(jd, structs, 3), 0); const rowBytes = bytes(structs, 192);
let controlCompared = false;
if (process.env.SDNAP_CONTROL_WASM) {
  const control = await openFrames({ wasm: process.env.SDNAP_CONTROL_WASM }); const cx = control.x;
  const ci = cx.sdnap_alloc(1024), co = cx.sdnap_alloc(1024);
  new Uint8Array(control.mem(), ci, data.length).set(data);
  assert.equal(cx.plugin_init_omm(ci, 3), 3); assert.equal(cx.plugin_propagate_batch(jd, co, 3), 0);
  assert.deepEqual(Buffer.from(new Uint8Array(control.mem(), co, 192)), rowBytes);
  const rows = elementRows(Array.from({ length: 3 }, (_, i) => ({ epochWhole: split(jd)[0], epochFrac: 0, meanMotion: 14, ecc: .001, inc: 55, raan: i * 8, argp: 30, ma: 30, theory: 0, norad: 500000 + i })));
  for (const [ex, memory, ip, op] of [[x, mem, omm, structs], [cx, control.mem, ci, co]]) {
    new Uint8Array(memory(), ip, rows.length).set(rows); assert.equal(ex.sdnap_init_elements(ip, 3), 3); assert.equal(ex.plugin_propagate_batch(jd, op, 3), 0);
  }
  assert.deepEqual(bytes(structs, 192), Buffer.from(new Uint8Array(control.mem(), co, 192)));
  const invalid = data.slice(); new DataView(invalid.buffer).setFloat64(88 + 16, 2, true);
  for (const [ex, memory, ip, op] of [[x, mem, omm, structs], [cx, control.mem, ci, co]]) {
    new Uint8Array(memory(), ip, invalid.length).set(invalid); assert.equal(ex.plugin_init_omm(ip, 3), 3);
    assert.equal(ex.plugin_propagate_batch(jd, op, 3), -6);
  }
  assert.deepEqual(bytes(structs, 192), Buffer.from(new Uint8Array(control.mem(), co, 192)));
  cx.plugin_destroy(); cx.sdnap_free(ci); cx.sdnap_free(co); await control.h.destroy?.(); controlCompared = true;
}
// Both stores coexist; only successful plugin-visible ingestion selects the source.
new Uint8Array(mem(), omm, data.length).set(data);
assert.equal(x.plugin_init_omm(omm, 3), 3);
const rowsBefore = state(0).bytes;
for (const [method, inputs] of [
  ['load_epochs', [input([new Uint8Array([0])])]],
  ['load_epochs_open', [configuration({epochStore: {CACHE_DAYS: -1}})]]]) {
  assert.notEqual((await call(method, inputs)).statusCode, 0);
  assert.equal(x.plugin_entity_count(), 3); assert.deepEqual(state(0).bytes, rowsBefore);
}
ok(await call('load_epochs_open'));
assert.equal((await call('load_epochs_part', [input([new Uint8Array([0])])])).statusCode, 3);
assert.equal(x.plugin_entity_count(), 3); assert.deepEqual(state(0).bytes, rowsBefore);
ok(await call('load_epochs_open')); refusal(await call('load_epochs_close'), 'missing-ocm');
assert.equal(x.plugin_entity_count(), 3); assert.deepEqual(state(0).bytes, rowsBefore);
await load(); fill(); const recordsBefore = bulk();
const nativeRows = elementRows([{epochWhole: split(jd)[0], epochFrac: 0, meanMotion: 14,
  ecc: .001, inc: 55, raan: 0, argp: 30, ma: 30, theory: 0, norad: 500001}]);
new Uint8Array(mem(), omm, nativeRows.length).set(nativeRows);
assert.equal(x.sdnap_init_elements(omm, 1), 1); assert.equal(x.plugin_entity_count(), 7);
assert.deepEqual(bulk(), recordsBefore);
const ommObject = Object.assign(new OMMT(), {EPOCH: new Date(EPOCH_MS).toISOString(),
  MEAN_MOTION: 14, ECCENTRICITY: .001, INCLINATION: 55, RA_OF_ASC_NODE: 0,
  ARG_OF_PERICENTER: 30, MEAN_ANOMALY: 30, MEAN_ELEMENT_THEORY: 0,
  CENTER_NAME: 'EARTH', TIME_SYSTEM: 'UTC', NORAD_CAT_ID: 500001});
const builder = new flatbuffers.Builder(1024); OMM.finishOMMBuffer(builder, ommObject.pack(builder));
ok(await call('ingest_omm', [{portId: 'omm', typeRef: T('OMM'), payload: builder.asUint8Array()}]));
assert.equal(x.plugin_entity_count(), 7); assert.deepEqual(bulk(), recordsBefore);
assert.equal(x.plugin_init_omm(0, 0), 0); assert.equal(x.plugin_entity_count(), 0);
assert.equal(x.sdnap_epochs_count(), 7); assert.equal(x.plugin_propagate(jd, 0, structs), -1);
new Uint8Array(mem(), omm, data.length).set(data); assert.equal(x.plugin_init_omm(omm, 3), 3);
// All plugin output forms and scalars in row mode agree with singleton states.
assert.equal(x.plugin_propagate_batch(jd, structs, 3), 0); const rowBatch = bytes(structs, 192);
assert.equal(x.plugin_propagate_all_positions(jd, positions, 3), 3); const rowPositions = bytes(positions, 72);
for (let i = 0; i < 3; ++i) {
  const q = state(i); assert.deepEqual(q.bytes, rowBatch.subarray(i * 64, i * 64 + 64));
  assert.deepEqual(q.bytes.subarray(8, 32), rowPositions.subarray(i * 24, i * 24 + 24));
  assert.ok(Math.abs(x.get_orbital_period(i) - 1440 / (14 + i / 10)) < 1e-10);
  assert.equal(x.get_eccentricity(i), .001);
  assert.equal(x.plugin_propagate_path(i, jd, 20 / 86400, 3, positions), 3);
  const path = bytes(positions, 72);
  for (let k = 0; k < 3; ++k) assert.deepEqual(path.subarray(k * 24, k * 24 + 24), state(i, jd + k * 20 / 86400).bytes.subarray(8, 32));
}
refusal(await call('replace_epoch', [input([newer])]), 'records-not-loaded');
const activeRows = state(0).bytes;
for (const fail of [1, 2, 3, 4]) {
  x.sdnap_test_fail_at(fail); assert.equal(x.plugin_init_omm(omm, 3), -4); x.sdnap_test_fail_at(0);
  assert.equal(x.plugin_entity_count(), 3); assert.deepEqual(state(0).bytes, activeRows);
}
const ommInput = {portId: 'omm', typeRef: T('OMM'), payload: builder.asUint8Array()};
x.sdnap_test_fail_at(0); ok(await call('ingest_omm', [ommInput]));
const ingestAllocations = x.sdnap_test_alloc_count();
for (let fail = 1; fail <= ingestAllocations; ++fail) {
  new Uint8Array(mem(), omm, data.length).set(data); assert.equal(x.plugin_init_omm(omm, 3), 3);
  const saved = state(0).bytes;
  x.sdnap_test_fail_at(fail); const r = await call('ingest_omm', [ommInput]); x.sdnap_test_fail_at(0);
  refusal(r, 'out-of-memory'); assert.equal(x.plugin_entity_count(), 3); assert.deepEqual(state(0).bytes, saved);
}
// A row pool failure must block release even when the epoch store has no dead flag.
x.sdnap_test_plugin_active(1); x.plugin_destroy();
assert.equal(x.plugin_entity_count(), 3); assert.equal(x.plugin_init_omm(0, 0), -4);
x.sdnap_test_plugin_active(0);
// A multi-set identity stays one index, supports exact paths, and refuses ambiguous replacement.
const secondEpoch = repackOcm(ap[0], t => { t.MEAN_ELEMENTS.EPOCH = '2026-10-15T02:00:00.000'; t.TRAJ_FRAME_EPOCH = t.MEAN_ELEMENTS.EPOCH; });
ok(await call('load_epochs', [input([ap[0], secondEpoch])])); assert.equal(x.plugin_entity_count(), 1);
refusal(await call('replace_epoch', [input([ap[0]])]), 'replace-multiple-sets');
assert.equal(x.plugin_propagate_path(0, jd, 0, 1, positions), 1);
const [w, frac] = split(jd); assert.equal(x.sdnap_epochs_at(w, frac, 0, 1, 3, planes, statuses, 0), 0);
assert.deepEqual(bytes(positions, 24), bytes(planes, 24));
// Theory-filtered input leaves only surviving entities, ordered by their first occurrences.
ok(await call('load_epochs', [configuration({ epochStore: { THEORIES: [1] } }), input(records)]));
assert.equal(x.plugin_entity_count(), 1); assert.equal(state(0).rc, 0);
// Aged-out and capped sets retain the first occurrence of each surviving identity across parts.
const set = (id, day, ecc) => repackOcm(sg, t => {
  t.METADATA.NORAD_CAT_ID = id; t.MEAN_ELEMENTS.EPOCH = new Date(EPOCH_MS + day * 86400000).toISOString();
  t.MEAN_ELEMENTS.ECCENTRICITY = ecc;
});
const aa = set(400010, -10, .001), an = set(400010, 0, .002), gone = set(400012, -10, .003);
const bb = [set(400011, -.5, .004), set(400011, -.25, .005), set(400011, 0, .006)];
for (const [list, order] of [[[aa, gone, ...bb, an], [0, 1]], [[bb[0], an, gone, aa, ...bb.slice(1)], [1, 0]]]) {
  ok(await call('load_epochs_open', [configuration({epochStore: {CACHE_DAYS: 1, MAX_SETS_PER_OBJECT: 2}})]));
  for (const record of list) ok(await call('load_epochs_part', [input([record])]));
  ok(await call('load_epochs_close')); assert.equal(x.plugin_entity_count(), 2);
  x.sdnap_epochs_stats(planes); assert.equal(f64(planes, 8)[2], 2); assert.equal(f64(planes, 8)[3], 1);
  for (let i = 0; i < 2; ++i) {
    assert.equal(x.get_eccentricity(i), order[i] ? .006 : .002);
    const q = state(i), [w, frac] = split(jd);
    assert.equal(x.sdnap_epochs_at(w, frac, order[i], 1, 3, planes, statuses, 0), 0);
    assert.deepEqual(q.bytes.subarray(8, 56), bytes(planes, 48));
    assert.equal(x.plugin_propagate_path(i, jd, 0, 1, positions), 1);
    assert.deepEqual(bytes(positions, 24), q.bytes.subarray(8, 32));
  }
}
// A decayed direct record has the same flag as a decayed native row.
const decayed = repackOcm(sg, t => { t.MEAN_ELEMENTS.MEAN_MOTION = 20; });
ok(await call('load_epochs', [input([decayed])]));
assert.equal(state(0).flags, 4); assert.notEqual(state(0).rc, 0);
assert.equal(x.plugin_propagate_batch(jd, structs, 1), 0);
assert.equal(new DataView(mem()).getUint32(structs + 60, true), 4);
assert.equal(x.plugin_propagate_all_positions(jd, positions, 1), 1);
assert.ok(Array.from(f64(positions, 3)).every(Number.isNaN));
await load(); fill();
let failedAllocations = 0;
{
  x.sdnap_test_fail_at(0); ok(await call('replace_epoch', [input([changed])]));
  const allocations = x.sdnap_test_alloc_count();
  for (let fail = 1; fail <= allocations; ++fail) {
    ok(await call('replace_epoch', [input([newer])])); f.fill((jd - 2440587.5) * 86400000, 180);
    const saved = bulk();
    x.sdnap_test_fail_at(fail); const r = await call('replace_epoch', [input([changed])]); x.sdnap_test_fail_at(0);
    refusal(r, 'out-of-memory'); assert.deepEqual(bulk(), saved); ++failedAllocations;
  }
  const preserved = bulk();
  for (const fail of [1, 2, 3]) {
    x.sdnap_test_fail_at(fail); assert.equal(x.plugin_init_omm(omm, 3), -4); x.sdnap_test_fail_at(0);
    assert.equal(x.plugin_entity_count(), 7); assert.deepEqual(bulk(), preserved);
  }
  x.sdnap_test_plugin_dead(1);
  refusal(await call('replace_epoch', [input([changed])]), 'pool-dead'); assert.equal(state(0).rc, -6);
  assert.equal(x.plugin_init_omm(omm, 3), -4); x.plugin_destroy(); assert.equal(x.plugin_entity_count(), 7);
  x.sdnap_test_plugin_dead(0);
}
// Allocation refusals in a staged catalog preserve the old record source and its cells.
const oldSnapshot = bulk();
x.sdnap_test_fail_at(0); ok(await call('load_epochs', [input(records)]));
const loadAllocations = x.sdnap_test_alloc_count(); fill();
for (let fail = 1; fail <= loadAllocations; ++fail) {
  const saved = bulk();
  x.sdnap_test_fail_at(fail); const r = await call('load_epochs', [input(records)]); x.sdnap_test_fail_at(0);
  refusal(r, 'out-of-memory'); assert.equal(x.plugin_entity_count(), 7); assert.deepEqual(bulk(), saved);
}
const previousBuffer = mem(); h.memory.grow(1); assert.notEqual(mem().byteLength, previousBuffer.byteLength);
assert.equal(x.plugin_propagate_all_positions(jd, positions, 7), 7);
ok(await call('load_epochs_open')); x.plugin_destroy();
assert.equal(x.plugin_entity_count(), 0); assert.equal(x.sdnap_epochs_count(), 0);
assert.equal(f.stats()[0], 0); assert.equal(f.stats()[2], 0);
assert.equal(x.sdnap_frames_at(...split(jd), 0, 0, 3, planes, statuses), -5);
refusal(await call('load_epochs_close'), 'load-not-open'); x.plugin_destroy();
x.sdnap_free(p); await h.destroy?.();
console.log(JSON.stringify({ passed: true, syntheticEntities: 7, exactPathSamples: samples, controlCompared, failedAllocations }));
