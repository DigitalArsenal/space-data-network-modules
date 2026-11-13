#!/usr/bin/env node
// ABI/lifecycle comparisons on synthetic records, not a physics calibration. Reference: the existing epoch and frame
// exports at the same UTC double JD; ECEF m and m/s. Layout comparisons are bit exact. AP versus direct uses the frame
// contract's 0.01 m and 0.0001 m/s 3-D bounds. Metadata uses the input elements and the definition of minutes per day.
import assert from 'node:assert/strict';
import { openFrames, population, ocmOfObject, EPOCH_MS, revPerDay } from './lib/frame-cells.mjs';
import { T, repackOcm } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { elementRows } from './lib/module.mjs';

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
const f = await openFrames({ initialMemoryBytes: 2 << 20 });
const { x, h, mem } = f;
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
  ok(await call('load_epochs_open'));
  assert.equal(x.plugin_entity_count(), 0);
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
// Repeated replacement owns no growing collection of detached records or cells.
for (let i = 0; i < 12; ++i) ok(await call('replace_epoch', [input([i % 2 ? newer : changed])]));
// Refused and incomplete loads publish no prior rows or records.
ok(await call('load_epochs_open')); assert.equal(x.plugin_entity_count(), 0);
refusal(await call('replace_epoch', [input([changed])]), 'records-not-loaded');
assert.equal((await call('load_epochs_part', [input([new Uint8Array([0])])])).statusCode, 3);
assert.equal(x.plugin_entity_count(), 0); refusal(await call('load_epochs_close'), 'load-not-open');
// The unchanged 88-byte struct input and 64-byte output are compared with the control artifact.
const data = new Uint8Array(3 * 88), view = new DataView(data.buffer);
for (let i = 0; i < 3; ++i) [jd - 1 / 24, 14 + i / 10, .001, 55, 8 * i, 30, 30 + i, .001, 0, .001].forEach((v, k) => view.setFloat64(88 * i + 8 * k, v, true));
new Uint8Array(mem(), omm, data.length).set(data);
await load(); new Uint8Array(mem(), omm, data.length).set(data);
assert.equal(x.plugin_init_omm(omm, 3), 3); assert.equal(x.sdnap_epochs_count(), 0); assert.equal(x.plugin_entity_count(), 3);
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
  cx.plugin_destroy(); cx.sdnap_free(ci); cx.sdnap_free(co); await control.h.destroy?.(); controlCompared = true;
}
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
await load(); fill();
let failedAllocations = 0;
if (x.sdnap_test_fail_at) {
  x.sdnap_test_fail_at(0); ok(await call('replace_epoch', [input([changed])]));
  const allocations = x.sdnap_test_alloc_count();
  for (let fail = 1; fail <= allocations; ++fail) {
    ok(await call('replace_epoch', [input([newer])])); f.fill((jd - 2440587.5) * 86400000, 180);
    const saved = bulk();
    x.sdnap_test_fail_at(fail); const r = await call('replace_epoch', [input([changed])]); x.sdnap_test_fail_at(0);
    refusal(r, 'out-of-memory'); assert.deepEqual(bulk(), saved); ++failedAllocations;
  }
  x.sdnap_test_plugin_dead(1);
  refusal(await call('replace_epoch', [input([changed])]), 'pool-dead'); assert.equal(state(0).rc, -6);
  assert.equal(x.plugin_init_omm(omm, 3), -4); x.plugin_destroy(); assert.equal(x.plugin_entity_count(), 7);
  x.sdnap_test_plugin_dead(0);
}
const previousBuffer = mem(); h.memory.grow(1); assert.notEqual(mem().byteLength, previousBuffer.byteLength);
assert.equal(x.plugin_propagate_all_positions(jd, positions, 7), 7);
ok(await call('load_epochs_open')); x.plugin_destroy();
assert.equal(x.plugin_entity_count(), 0); assert.equal(x.sdnap_epochs_count(), 0);
refusal(await call('load_epochs_close'), 'load-not-open'); x.plugin_destroy();
x.sdnap_free(p); await h.destroy?.();
console.log(JSON.stringify({ passed: true, syntheticEntities: 7, exactPathSamples: samples, controlCompared, failedAllocations }));
