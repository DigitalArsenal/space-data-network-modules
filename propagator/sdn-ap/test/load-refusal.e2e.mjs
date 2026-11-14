#!/usr/bin/env node
// Refused loads preserve the complete resident snapshot (SPEC 14.1); an empty resident stays empty.
// Every counted allocation of mixed and forecast catalogs fails in turn with both empty and populated residents.
// A control that clears resident records on refusal must fail the same preservation comparison.
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
const unguarded = buildDiagnostic('load-refusal-control', probe, s => s, {...seam, 'epoch_store.inc': s => {
  const before = '  epochs::clear(prepared);\n  return rc;';
  assert.equal(s.split(before).length, 2, 'the control must change exactly one publication exit');
  return s.replace(before, '  if (rc != 0) epochs::clear(epochs::resident());\n' + before);
}});

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
  const h = await open(wasm), x = h.instance.exports, p = x.sdnap_alloc(128);
  const stats = () => { x.sdnap_epochs_stats(p); return Array.from(new Float64Array(h.memory.buffer, p, 8)); };
  // The entire resident snapshot: counts, bytes, identities, epochs and exact TEME states in km and km/s.
  // The reference is the same instance before refusal; preservation permits no numerical difference.
  const snapshot = () => {
    const out = [];
    for (let i = 0; i < x.sdnap_epochs_count(); ++i) {
      assert.equal(x.sdnap_epochs_series(i, p, 0, 0), 0);
      const info = Array.from(new Float64Array(h.memory.buffer, p, 3)); out.push(info);
      const ep = x.sdnap_alloc(16 * info[2]);
      assert.equal(x.sdnap_epochs_series(i, p, ep, info[2]), 0);
      const epochs = Array.from(new Float64Array(h.memory.buffer, ep, 2 * info[2])); out.push(epochs); x.sdnap_free(ep);
      for (let k = 0; k < info[2]; ++k) {
        const rc = x.sdnap_epochs_set_at(i, k, epochs[2*k], epochs[2*k+1], p);
        out.push([rc, Buffer.from(new Uint8Array(h.memory.buffer, p, 48)).toString('hex')]);
      }
    }
    return JSON.stringify([x.sdnap_epochs_count(), stats(), out]);
  };
  return {h, x, stats, snapshot};
};
const exercise = async (name, wasm, catalog, expectedAllocations, residentRecords) => {
  const {h, x, stats, snapshot} = await counts(wasm);
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, catalog)).statusCode, 0);
  x.sdnap_test_fail_at(0);
  assert.equal((await load(h, catalog)).statusCode, 0);
  const total = x.sdnap_test_alloc_count();
  assert.equal(total, expectedAllocations, `${name}: counted allocation sites`);
  assert.ok(stats()[1] > 0);
  let changed = 0, checked = 0;
  for (const resident of [false, true]) {
    for (let n = 1; n <= total; ++n) {
      x.sdnap_test_fail_at(0);
      x.plugin_destroy();
      if (resident) assert.equal((await load(h, residentRecords)).statusCode, 0);
      const before = snapshot();
      x.sdnap_test_fail_at(n);
      const r = await load(h, catalog);
      assert.notEqual(r.statusCode, 0, `${name}: allocation ${n} of ${total} failed and the load was answered`);
      assert.equal(r.errorCode, 'out-of-memory', `${name}: allocation ${n}: ${r.errorCode}`);
      x.sdnap_test_fail_at(0);
      const after = snapshot();
      if (after !== before) changed++;
      if (name !== 'clearing control') assert.equal(after, before, `${name}: allocation ${n} of ${total}, resident ${resident}: refusal changed the resident snapshot`);
      // A subsequent successful load publishes its records alone.
      assert.equal((await load(h, residentRecords)).statusCode, 0);
      assert.equal(x.sdnap_epochs_count(), residentRecords.length);
      checked++;
    }
  }
  if (name === 'clearing control') assert.ok(changed > 0, 'clearing resident records on refusal escaped the preservation check');
  console.log(`${name}: ${total} allocation sites, ${checked} refusals with empty and populated residents, ${changed} changed snapshots`);
  await h.destroy?.();
};
await exercise('guarded', guarded, records, CATALOG_ALLOCATIONS, records.slice(0, 6));
await exercise('clearing control', unguarded, records, CATALOG_ALLOCATIONS, records.slice(0, 6));
{
  const command = await commandHarness(wasmPath), forecast = [];
  for (const [c, norad] of [[CLASSES[1], 99301], [CLASSES[0], 99302]]) forecast.push((await carriedRecord(command, c, {norad})).ocm);
  await command.destroy?.();
  await exercise('forecast records', guarded, forecast, FORECAST_ALLOCATIONS, records.slice(0, 6));
}
console.log('LOAD-REFUSAL PASS');
