#!/usr/bin/env node
// A load_epochs refused for want of memory leaves NO snapshot (SPEC 1.6 and 14.1): after every refusal the store's series count, its kept count and its
// byte count are zero, and a load that follows is answered from its own records alone. The test builds a module whose counted allocations can be made to
// fail at the Nth one (a test-only seam in the module's own accounting: mem::malloc, mem::calloc and mem::counted), loads the same catalog once to count
// its allocations, then loads it again failing each of them in turn. The catalog holds SGP4 and AP sets, a series of several sets (the second cache slot),
// AP sets with a covariance (the matrix) and two distinct weather series, so the failing allocation reaches the arrays, the interned weather, the covariance
// set and its matrix, and the second slot, with series already installed before some of them.
// A negative control builds the same module with the clearing on refusal removed and asserts that the test would have seen a partial store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {T, rowsThrough, repackOcm, ocmOf} from './lib/ocm.mjs';
import {wasmPath} from './lib/module.mjs';
import {buildDiagnostic, failureSeam, failureProbe} from './lib/ap-diagnostic.mjs';
import {CLASSES, carriedRecord, harness as commandHarness} from './lib/carried.mjs';
// the counted allocations of one load_epochs of the catalog below and of the two forecast records (measured on this build; an equality, so a site the seam stops failing shows)
const CATALOG_ALLOCATIONS = 65, FORECAST_ALLOCATIONS = 21;
const DAY = 86400000;
const fixture = new Uint8Array(fs.readFileSync(new URL('fixtures/ap-fit-0.6.43.ocm', import.meta.url)));
const epoch = ocmOf(fixture).MEAN_ELEMENTS.EPOCH;
const ms = Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');
const iso = t => new Date(t).toISOString().replace('Z', '');
const weather = value => rowsThrough(Array.from({length: 46}, (_, k) => ({DATE: iso(ms + (k - 5) * DAY).slice(0, 10), F107_OBS: value, F107_OBS_CENTER81: value + 2, AP_AVG: 4})));
const rows = [weather(70), weather(75)];
const prefix = bytes => { const b = Buffer.alloc(bytes.length + 4); b.writeUInt32LE(bytes.length); b.set(bytes, 4); return b; };
const load = (h, records) => h.invoke({methodId: 'load_epochs', inputs: [{portId: 'ocm', typeRef: T('OCM'), payload: Buffer.concat(records.map(prefix))}]});
const open = wasm => createStandaloneHarness('browser', wasm, {surface: 'direct', maxThreads: 1, enableBrowserWasiThreads: false, initialMemoryBytes: 2 * 1048576});

// the test-only seam: the Nth counted allocation of a call fails, counted as a failed allocation
const seam = failureSeam, probe = failureProbe;   // test/lib/ap-diagnostic.mjs: every replace must match (the counted() replace stopped matching in 0.6.56 and failed no site)
const guarded = buildDiagnostic('load-refusal', probe, s => s, seam);
const unguarded = buildDiagnostic('load-refusal-control', probe, s => s, {...seam, 'epoch_store.inc': s => s
  .replace('~Unwind() { if (!installed) clear(s); }', '~Unwind() {}')
  .replace('  if (rc == 0) rc = epochs::close(st, b);\n  b.drop();\n  if (rc != 0) epochs::clear(st);\n  return rc;', '  if (rc == 0) rc = epochs::close(st, b);\n  b.drop();\n  return rc;')});

// the catalog
const records = [];
const sgp4 = async (norad, mm) => {
  const b = new fb.Builder(256), ep = b.createString(epoch);
  OMM.startOMM(b); OMM.addEpoch(b, ep); OMM.addNoradCatId(b, norad); OMM.addMeanMotion(b, mm); OMM.addEccentricity(b, 0.001); OMM.addInclination(b, 55); OMM.addMeanAnomaly(b, norad % 360);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  const r = await ingest.invoke({methodId: 'ingest_omm', inputs: [{portId: 'omm', typeRef: T('OMM'), payload: b.asUint8Array().slice()}]});
  assert.equal(r.statusCode, 0, r.errorMessage);
  return new Uint8Array(r.outputs[0].payload);
};
const ingest = await open(wasmPath);
for (let k = 0; k < 6; ++k) records.push(await sgp4(300000 + k, 15 + k / 100));
for (let k = 0; k < 8; ++k) records.push(repackOcm(fixture, t => {   // AP with covariance; two weather series
  t.METADATA.NORAD_CAT_ID = 310000 + k; t.METADATA.OBJECT_NAME = `Q${k}`; t.PERTURBATIONS.SPACE_WEATHER = rows[k % 2];
}));
for (let k = 0; k < 3; ++k) {                                       // series of several sets: the second slot
  for (let q = 0; q < 3; ++q) records.push(repackOcm(fixture, t => {
    t.METADATA.NORAD_CAT_ID = 320000 + k; t.METADATA.OBJECT_NAME = `M${k}`; t.PERTURBATIONS.SPACE_WEATHER = rows[0];
    t.MEAN_ELEMENTS.EPOCH = iso(ms - q * DAY); t.TRAJ_FRAME_EPOCH = iso(ms - q * DAY);
  }));
}
await ingest.destroy?.();

const counts = async wasm => {
  const h = await open(wasm), x = h.instance.exports, p = x.sdnap_alloc(64);
  const stats = () => { x.sdnap_epochs_stats(p); return Array.from(new Float64Array(h.memory.buffer, p, 8)); };
  return {h, x, stats};
};
const failures = [];
for (const [name, wasm] of [['guarded', guarded], ['unguarded control', unguarded]]) {
  const {h, x, stats} = await counts(wasm);
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, records)).statusCode, 0);   // the first load makes one-time allocations: count the second
  x.sdnap_test_fail_at(0);
  const ok = await load(h, records);
  assert.equal(ok.statusCode, 0, `${name}: ${ok.errorCode}: ${ok.errorMessage}`);
  const total = x.sdnap_test_alloc_count(), kept = stats()[1], series = x.sdnap_epochs_count();
  assert.ok(total === CATALOG_ALLOCATIONS && kept === 6 + 8 + 9 && series === 6 + 8 + 3, `${name}: ${total} allocations (${CATALOG_ALLOCATIONS} expected), ${kept} kept, ${series} series`);
  const bytesFull = stats()[7];
  assert.ok(bytesFull > 0);
  let partial = 0;
  for (let n = 1; n <= total; ++n) {
    x.sdnap_test_fail_at(n);
    const r = await load(h, records);
    assert.notEqual(r.statusCode, 0, `${name}: allocation ${n} of ${total} failed and the load was answered`);
    assert.equal(r.errorCode, 'out-of-memory', `${name}: allocation ${n}: ${r.errorCode}`);
    const s = stats(), left = [x.sdnap_epochs_count(), s[1], s[7]];
    if (left.some(v => v !== 0)) { partial++; failures.push(`${name}: after allocation ${n} of ${total} failed the store held ${left.join(' series, ')} (series, kept, bytes)`); }
  }
  // a load after the refusals is the new snapshot alone
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, records.slice(0, 6))).statusCode, 0);
  assert.equal(x.sdnap_epochs_count(), 6);
  console.log(`${name}: ${total} counted allocations failed in turn, ${partial} left a store behind`);
  if (name === 'guarded') assert.equal(partial, 0, failures.join('\n'));
  else assert.ok(partial > 0, 'the control (no clearing on refusal) shows no partial store: the test would not have caught the defect');
  await h.destroy?.();
}
// records that carry a forecast: the one-call install copies each out of the call's bytes (one counted allocation), and frees the series' second slot when
// that copy fails; no record of the catalog above carries one
{
  const command = await commandHarness(wasmPath);
  const forecast = [];
  for (const [c, norad] of [[CLASSES[1], 99301], [CLASSES[0], 99302]]) forecast.push((await carriedRecord(command, c, {norad})).ocm);
  await command.destroy?.();
  const {h, x, stats} = await counts(guarded);
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, forecast)).statusCode, 0);
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, forecast)).statusCode, 0);
  const total = x.sdnap_test_alloc_count();
  assert.equal(stats()[1], 2, 'the forecast records are kept');
  assert.equal(total, FORECAST_ALLOCATIONS, `the load of the forecast records makes ${total} counted allocations (a count that drops is a site the seam no longer fails)`);
  for (let n = 1; n <= total; ++n) {
    x.sdnap_test_fail_at(n);
    const r = await load(h, forecast);
    assert.equal(r.errorCode, 'out-of-memory', `forecast records: allocation ${n} of ${total}: ${r.errorCode}`);
    const s = stats();
    assert.deepEqual([x.sdnap_epochs_count(), s[1], s[7]], [0, 0, 0], `forecast records: allocation ${n} of ${total}: the store is not empty`);
  }
  console.log(`forecast records: ${total} counted allocations failed in turn, each refused out-of-memory with the store empty`);
  await h.destroy?.();
}
console.log('LOAD-REFUSAL PASS');
