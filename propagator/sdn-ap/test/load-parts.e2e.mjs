#!/usr/bin/env node
// A load taken in parts (SPEC 14.1.1):load_epochs_open, load_epochs_part (any number of times), load_epochs_close.
//   1. Partition equivalence: for every catalog of load-equivalence (shuffled, capped, theory-filtered, duplicates whichever part they fall in, SGP4, SGP4XP and
//      AP sets, covariances, forecasts, shared and unused weather) the store built from one part, two, seven uneven parts (some of two frames) and one record
//      a part equals the store load_epochs builds from the whole list: the counts and bytes, every series, every set's epoch and state, and the selected state
//      and the covariance of every series, bit for bit.
//   2. Refusals: a bad record in a middle part is refused with the code and message load_epochs gives on the whole list; the load is then closed and the store
//      empty (a part or a close after it is refused load-not-open); series-forces-differ comes at the close, with the store empty.
//   3. Misuse: a part or a close with no load open is refused load-not-open and leaves a loaded store as it was; a second open starts over; a close with no part
//      is refused missing-ocm; the store is empty from the open to the close (a state asked of it is -1, no such series).
//   4. Allocation failure: every counted allocation of every call of a three-part load is made to fail in turn (a test-only seam in the module's accounting);
//      each is refused out-of-memory, the store is empty, and the load is closed.
//   5. Memory: a catalog taken in parts of 100 grows the instance by a fraction of what the same catalog taken in one payload does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {T, seedOcm, rowsThrough, repackOcm, ocmOf} from './lib/ocm.mjs';
import {configuration, pcfTheory} from './lib/pcf.mjs';
import {wasmPath} from './lib/module.mjs';
import {jdOf} from './lib/frames.mjs';
import {buildDiagnostic, failureSeam, failureProbe} from './lib/ap-diagnostic.mjs';
import {CLASSES, carriedRecord, harness as commandHarness} from './lib/carried.mjs';
const DAY = 86400000, MIB = 1048576;
const fixture = new Uint8Array(fs.readFileSync(new URL('fixtures/ap-fit-0.6.43.ocm', import.meta.url)));
const epoch = ocmOf(fixture).MEAN_ELEMENTS.EPOCH;
const ms = Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');
const iso = t => new Date(t).toISOString().replace('Z', '');
const weather = value => rowsThrough(Array.from({length: 46}, (_, k) => ({DATE: iso(ms + (k - 5) * DAY).slice(0, 10), F107_OBS: value, F107_OBS_CENTER81: value + 2, AP_AVG: 4})));
const rows = [weather(70), weather(75), weather(80)];
const prefix = bytes => { const b = Buffer.alloc(bytes.length + 4); b.writeUInt32LE(bytes.length); b.set(bytes, 4); return b; };
const open = (file, initial = 2) => createStandaloneHarness('browser', file, {surface: 'direct', maxThreads: 1, enableBrowserWasiThreads: false, initialMemoryBytes: initial * MIB});
const frame = records => ({portId: 'ocm', typeRef: T('OCM'), payload: Buffer.concat(records.map(prefix))});
const whole = (h, records, cfg = {}) => h.invoke({methodId: 'load_epochs', inputs: [frame(records), configuration({epochStore: cfg})]});
const call = (h, methodId, inputs = []) => h.invoke({methodId, inputs});
const opened = (h, cfg = {}) => call(h, 'load_epochs_open', [configuration({epochStore: cfg})]);
const part = (h, chunks) => call(h, 'load_epochs_part', chunks.map(frame));
const close = h => call(h, 'load_epochs_close');
/** The load in parts: `sizes` records a part, the records of a part in frames of at most three. The first refusal is returned (and no call follows it). */
const inParts = async (h, records, sizes, cfg = {}) => {
  let r = await opened(h, cfg);
  if (r.statusCode !== 0) return r;
  let at = 0;
  for (const size of sizes) {
    const mine = records.slice(at, at + size); at += size;
    const chunks = []; for (let k = 0; k < mine.length; k += 3) chunks.push(mine.slice(k, k + 3));
    r = await part(h, chunks.length ? chunks : [[]]);
    if (r.statusCode !== 0) return r;
  }
  assert.equal(at, records.length, 'the partition covers every record');
  return close(h);
};
const evenly = (n, k) => Array.from({length: k}, (_, i) => Math.floor(n * (i + 1) / k) - Math.floor(n * i / k)).filter(s => s > 0);
const uneven = n => { const cuts = [1, 2, 5, 9, 14, 22].map(c => Math.min(n, c)); const out = []; let prev = 0; for (const c of [...cuts, n]) { if (c > prev) out.push(c - prev); prev = Math.max(prev, c); } return out; };
const partitions = n => [['one part', [n]], ['two parts', evenly(n, 2)], ['seven uneven parts', uneven(n).length >= 7 ? uneven(n) : evenly(n, 7)], ['one record a part', Array(n).fill(1)]];

const fresh = await open(wasmPath);
const q = (() => { const x = fresh.instance.exports, p = x.sdnap_alloc(1 << 16); return {x, p, f64: (o, n) => new Float64Array(fresh.memory.buffer, o, n), i32: (o, n) => new Int32Array(fresh.memory.buffer, o, n)}; })();
const probeOf = h => { const x = h.instance.exports, p = x.sdnap_alloc(1 << 16); return {x, p, f64: (o, n) => new Float64Array(h.memory.buffer, o, n), i32: (o, n) => new Int32Array(h.memory.buffer, o, n)}; };
const fingerprint = (pr = q) => {
  const {x, p, f64, i32} = pr, out = [];
  x.sdnap_epochs_stats(p); out.push(Array.from(f64(p, 8)));   // the eighth statistic, the bytes held, too: one copy of a weather series, the discard of an unused one
  const count = x.sdnap_epochs_count(); out.push(count);
  const ep = p + 4096, st = p + 8192, cov = p + 12288, one = p + 2048;
  for (let i = 0; i < count; ++i) {
    assert.equal(x.sdnap_epochs_series(i, p, ep, 512), 0);
    const info = Array.from(f64(p, 3)); out.push(info);
    const epochs = Array.from(f64(ep, 2 * info[2])); out.push(epochs);
    for (let k = 0; k < info[2]; ++k) {
      const at = jdOf(iso((epochs[2 * k] - 2440587.5 + epochs[2 * k + 1]) * DAY + 1800000));
      const rc = x.sdnap_epochs_set_at(i, k, at.whole, at.frac, one);
      out.push([rc, ...Array.from(f64(one, 6))]);
    }
    // every switch of a series of several sets: the selection (a, b, the weight), the blended state and the covariance mixture before, at and after the
    // switch's midpoint, inside its blend window
    for (let k = 0; k + 1 < info[2]; ++k) {
      for (const off of [-600, 0, 600]) {
        const whole = epochs[2 * k], frac = epochs[2 * k + 1] + ((epochs[2 * k + 2] - epochs[2 * k]) + (epochs[2 * k + 3] - epochs[2 * k + 1])) / 2 + off / 86400;
        const sr = x.sdnap_epochs_select(i, whole, frac, p + 512);
        out.push(['switch', k, off, sr, ...Array.from(f64(p + 512, 3))]);
        const rc = x.sdnap_epochs_at(whole, frac, i, 1, 0, p + 1024, st, cov);
        out.push(['switch-at', k, off, rc, i32(st, 1)[0], ...Array.from(f64(p + 1024, 6)), ...Array.from(f64(cov, 36))]);
      }
    }
    for (const lag of [5400000, 4 * 3600000]) {   // two times: the covariance values are compared at both
      const at = jdOf(iso((epochs[0] - 2440587.5 + epochs[1]) * DAY + lag));
      const rc = x.sdnap_epochs_at(at.whole, at.frac, i, 1, 0, p + 1024, st, cov);
      out.push([rc, i32(st, 1)[0], ...Array.from(f64(p + 1024, 6)), ...Array.from(f64(cov, 36))]);
      x.sdnap_epochs_source_at(at.whole, at.frac, i, 1, st);
      out.push(['source', i32(st, 1)[0]]);
    }
  }
  return JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
};
const emptyStore = what => { q.x.sdnap_epochs_stats(q.p); const s = q.f64(q.p, 8); assert.deepEqual([q.x.sdnap_epochs_count(), s[0], s[1], s[7]], [0, 0, 0, 0], `${what}: the store holds series, records, kept, bytes ${q.x.sdnap_epochs_count()}, ${s[0]}, ${s[1]}, ${s[7]}`); };
const refused = (r, code, what) => { assert.equal(r.statusCode, 3, `${what}: status ${r.statusCode}`); assert.equal(r.errorCode, code, `${what}: ${r.errorCode}: ${r.errorMessage}`); };

// ---- the catalogs of load-equivalence
const command = await commandHarness(wasmPath);
const sgp4 = async (norad, mm, mean = 0, when = epoch) => {
  const b = new fb.Builder(256), e = b.createString(when);
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addNoradCatId(b, norad); OMM.addMeanMotion(b, mm); OMM.addEccentricity(b, 0.001); OMM.addInclination(b, 55); OMM.addMeanAnomaly(b, mean);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  const r = await fresh.invoke({methodId: 'ingest_omm', inputs: [{portId: 'omm', typeRef: T('OMM'), payload: b.asUint8Array().slice()}]});
  assert.equal(r.statusCode, 0, r.errorMessage);
  return new Uint8Array(r.outputs[0].payload);
};
const ap = (norad, edit = () => {}) => repackOcm(fixture, t => { t.METADATA.NORAD_CAT_ID = norad; t.METADATA.OBJECT_NAME = `Q${norad}`; t.PERTURBATIONS.SPACE_WEATHER = rows[0]; edit(t); });
const at = (days, t) => { t.MEAN_ELEMENTS.EPOCH = iso(ms + days * DAY); t.TRAJ_FRAME_EPOCH = iso(ms + days * DAY); };
const stock = (norad, days, mm = 15.1) => seedOcm({epoch: iso(ms + days * DAY), n: mm, e: 0.001, i: 53, raan: 20, argp: 90, ma: 10, bterm: 0.0002, norad, name: `X${norad}`});
const seedAp = (norad, days, rowsOf) => seedOcm({epoch: iso(ms + days * DAY), n: 15, e: 0.001, i: 55, raan: norad % 360, argp: 90, ma: 10, norad, name: `S${norad}`, msis: true, records: true, rows: rowsOf, tesseral: 31, zonal: 20});
const catalog = [];
for (let k = 0; k < 4; ++k) catalog.push(await sgp4(500000 + k, 15 + k / 50, k * 7));
for (const d of [3, -2, 0, 1, -1]) catalog.push(await sgp4(500010, 15.2, d * 10, iso(ms + d * DAY)));
for (let k = 0; k < 4; ++k) catalog.push(stock(510000 + k, 0, 15 + k / 10));
for (const d of [2, -3, 0, -1, 1]) catalog.push(stock(510010, d));
for (let k = 0; k < 6; ++k) catalog.push(ap(520000 + k, t => { t.PERTURBATIONS.SPACE_WEATHER = rows[k % 2]; }));
for (const d of [-2, 1, 0, -1]) catalog.push(ap(520010, t => at(d, t)));
for (let k = 0; k < 3; ++k) catalog.push(seedAp(530000 + k, 0, rows[k % 3]));
const dupA = ap(520020, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 100; }), dupB = ap(520020, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 200; });
catalog.push(dupA, dupB);
catalog.push(ap(520021, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 210; }), ap(520021, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 110; }));
catalog.push(await sgp4(500020, 15.3, 10), await sgp4(500020, 15.3, 99));
catalog.push(ap(520030, t => at(-9, t)));
catalog.push(repackOcm(catalog[0], t => { t.CENTER_NAME = 'MARS'; }));
let seed = 20261113;
const shuffle = list => { const s = list.slice(); for (let k = s.length - 1; k > 0; --k) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (k + 1); [s[k], s[j]] = [s[j], s[k]]; } return s; };
const shuffled = [shuffle(catalog), shuffle(catalog)];
const carried = [];
for (const [c, norad] of [[CLASSES[1], 99301], [CLASSES[0], 99302]]) carried.push((await carriedRecord(command, c, {norad})).ocm);
const carriedEpoch = ocmOf(carried[0]).MEAN_ELEMENTS.EPOCH;
const near = repackOcm(stock(99310, 0), t => { t.MEAN_ELEMENTS.EPOCH = carriedEpoch; });
const withForecast = [...carried, near, await sgp4(99311, 15.4, 5, carriedEpoch)];
const weatherCases = [ap(520040, t => at(0, t)), ap(520040, t => at(-1, t)), ap(520040, t => { at(-2, t); t.PERTURBATIONS.SPACE_WEATHER = rows[1]; }), ap(520041, t => { at(-9, t); t.PERTURBATIONS.SPACE_WEATHER = rows[2]; })];

// ---- 1. partition equivalence
let compared = 0;
const equal = async (name, records, cfg = {}) => {
  const w = await whole(fresh, records, cfg);
  assert.equal(w.statusCode, 0, `${name}: load_epochs refused ${w.errorCode}`);
  q.x.sdnap_epochs_stats(q.p);
  const kept = q.f64(q.p, 8)[1], expect = fingerprint();
  assert.ok(kept > 0);
  for (const [label, sizes] of partitions(records.length)) {
    const r = await inParts(fresh, records, sizes, cfg);
    assert.equal(r.statusCode, 0, `${name}, ${label}: ${r.errorCode}: ${r.errorMessage}`);
    assert.equal(fingerprint(), expect, `${name}, ${label}: the store differs from the one load_epochs builds`);
    compared += 1;
  }
  console.log(`${name}: ${records.length} records, ${kept} kept, equal in ${partitions(records.length).length} partitions`);
};
await equal('catalog, as written', catalog);
await equal('catalog, shuffled A', shuffled[0]);
await equal('catalog, shuffled B', shuffled[1]);
await equal('capped at 2 sets per object', catalog, {MAX_SETS_PER_OBJECT: 2});
await equal('capped at 1 set per object, shuffled', shuffled[0], {MAX_SETS_PER_OBJECT: 1});
await equal('SGP4 sets only', catalog, {THEORIES: [pcfTheory.SGP4]});
await equal('AP sets only, shuffled', shuffled[1], {THEORIES: [pcfTheory.AP]});
await equal('one-day cache', catalog, {CACHE_DAYS: 1});
await equal('LATEST_BEFORE, HERMITE, a 7,200 s blend window', shuffled[0], {SELECTION: 1, BLEND_SHAPE: 1, BLEND_WINDOW_SECONDS: 7200});
await equal('records carrying a forecast', withForecast);
{
  // one record a part: the forecast of every record is answered by the store (the staging buffer's reuse is section 4b)
  const r = await inParts(fresh, withForecast, Array(withForecast.length).fill(1));
  assert.equal(r.statusCode, 0);
  assert.match(fingerprint(), /\["source",1\]/, 'no series answers from a carried forecast');
}
await equal('records carrying a forecast, shuffled and capped', shuffle(withForecast), {MAX_SETS_PER_OBJECT: 1});
await equal('weather shared, distinct and unused', weatherCases);
// a same-epoch duplicate whichever part it falls in: the two records of the pair are put in different parts, in both orders
for (const [a, b] of [[dupA, dupB], [dupB, dupA]]) {
  const records = [a, ...catalog.slice(0, 6), b];
  const w = await whole(fresh, records);
  assert.equal(w.statusCode, 0);
  const expect = fingerprint();
  const r = await inParts(fresh, records, [1, 6, 1]);
  assert.equal(r.statusCode, 0);
  assert.equal(fingerprint(), expect, 'a same-epoch duplicate across parts');
  compared += 1;
}
console.log(`duplicates across parts: equal; ${compared} stores compared`);

// ---- 2. refusals
const good = catalog.slice(0, 30);
const bad = {
  'garbage': new Uint8Array([1, 2, 3, 4]),
  'weather rows missing': ap(520050, t => { t.PERTURBATIONS.SPACE_WEATHER = []; }),
  'propagation invariant': ap(520053, t => { t.COV_PROPAGATION.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = t.COV_PROPAGATION.NOISE_NON_GRAVITATIONAL_RAD_DAY2 * 2 + 1; }),
  'covariance size': ap(520054, t => { t.COV_SIZE = 5; }),
};
for (const [name, record] of Object.entries(bad)) {
  const records = [...good.slice(0, 14), record, ...good.slice(14)];
  const w = await whole(fresh, records);
  assert.equal(w.statusCode, 3, `${name}: load_epochs answered the list with the bad record`);
  emptyStore(`${name}, whole`);
  // the bad record falls in the middle part: parts of 10 records, the record is the 15th (the second part's fifth)
  const r = await inParts(fresh, records, [10, 10, 11]);
  assert.deepEqual([r.statusCode, r.errorCode, r.errorMessage], [w.statusCode, w.errorCode, w.errorMessage], `${name}: the refusal of a middle part`);
  emptyStore(`${name}, in parts`);
  refused(await part(fresh, [good.slice(0, 2)]), 'load-not-open', `${name}: a part after the refusal`);
  refused(await close(fresh), 'load-not-open', `${name}: a close after the refusal`);
}
{
  const records = [...good.slice(0, 5), bad.garbage, ...good.slice(5, 20), bad['covariance size'], ...good.slice(20)];
  const w = await whole(fresh, records);
  const r = await inParts(fresh, records, [4, 8, 8, 8, 8]);   // the garbage is the sixth record, before the second bad one
  assert.deepEqual([r.errorCode, r.errorMessage], [w.errorCode, w.errorMessage], 'several bad records: the first is reported');
  emptyStore('several bad records');
}
{
  const clash = ap(520010, t => { at(5, t); t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 20; });
  const records = [...good, clash];
  const w = await whole(fresh, records);
  assert.equal(w.errorCode, 'series-forces-differ');
  // the four sets of series 520010 (records 25 to 28) are in the second part, the clashing record of that series alone in the third
  const r = await inParts(fresh, records, [24, 6, 1]);
  assert.deepEqual([r.statusCode, r.errorCode, r.errorMessage], [w.statusCode, w.errorCode, w.errorMessage], 'series-forces-differ arrives at the close');
  emptyStore('series-forces-differ');
  refused(await close(fresh), 'load-not-open', 'a close after series-forces-differ');
}
{
  // a part of another type is refused by its type, as load_epochs refuses it
  assert.equal((await opened(fresh)).statusCode, 0);
  const omm = Buffer.alloc(40); omm.writeUInt32LE(36, 0); omm.write('$OMM', 8, 'latin1');
  const r = await call(fresh, 'load_epochs_part', [{portId: 'ocm', typeRef: T('OCM'), payload: omm}]);
  const w = await call(fresh, 'load_epochs', [{portId: 'ocm', typeRef: T('OCM'), payload: omm}]);
  assert.deepEqual([r.statusCode, r.errorCode, r.errorMessage], [w.statusCode, w.errorCode, w.errorMessage]);
  assert.equal(r.errorCode, 'omm-not-flown');
  emptyStore('a part of another type');
  refused(await close(fresh), 'load-not-open', 'after a part of another type');
}

// ---- 3. misuse
{
  assert.equal((await whole(fresh, catalog)).statusCode, 0);
  fingerprint();   // flying the sets allocates their records, which the byte statistic counts: compare after that
  const loaded = fingerprint();
  refused(await part(fresh, [catalog.slice(0, 3)]), 'load-not-open', 'a part with no load open');
  refused(await close(fresh), 'load-not-open', 'a close with no load open');
  assert.equal(fingerprint(), loaded, 'a part or a close with no load open changed the store');
  // an open empties the store, and the store stays empty until the close
  assert.equal((await opened(fresh)).statusCode, 0);
  emptyStore('after an open');
  assert.equal((await part(fresh, [catalog.slice(0, 10)])).statusCode, 0);
  // the store holds no series and keeps no set; what the open load holds is in the byte statistic, growing with its parts and gone when it is closed
  q.x.sdnap_epochs_stats(q.p);
  const afterOne = q.f64(q.p, 8).slice();
  assert.deepEqual([q.x.sdnap_epochs_count(), afterOne[0], afterOne[1]], [0, 0, 0], 'the store holds series or counts during a load');
  assert.ok(afterOne[7] > 2000, `an open load holding 10 records reports ${afterOne[7]} bytes`);
  assert.equal((await part(fresh, [catalog.slice(10, 20)])).statusCode, 0);
  q.x.sdnap_epochs_stats(q.p);
  assert.ok(q.f64(q.p, 8)[7] > afterOne[7], 'the byte statistic does not grow with the parts of an open load');   // the records' strings and covariances; the blocks are allocated whole
  const out = q.p + 40000;
  assert.equal(q.x.sdnap_epochs_series(0, q.p, 0, 0), -1);
  assert.equal(q.x.sdnap_epochs_select(0, 2460000.5, 0, out), -1);
  assert.equal(q.x.sdnap_epochs_at(2460000.5, 0, 0, 1, 0, out, 0, 0), -1);
  assert.equal(q.x.sdnap_epochs_set_at(0, 0, 2460000.5, 0, out), -1);
  // every answer SPEC 14.1.1 lists for an open load: the count 0, the source and the states -1 for a request of one series, 0 for a request of none, the drag check -4
  assert.equal(q.x.sdnap_epochs_count(), 0);
  assert.equal(q.x.sdnap_epochs_source_at(2460000.5, 0, 0, 1, out), -1);
  assert.equal(q.x.sdnap_epochs_source_at(2460000.5, 0, 0, 0, out), 0);
  assert.equal(q.x.sdnap_epochs_at(2460000.5, 0, 0, 0, 0, out, 0, 0), 0);
  assert.equal(q.x.sdnap_drag_orbit_check(0, 0, 8, out), -4);
  // a second open starts over: what the first took is dropped
  assert.equal((await opened(fresh)).statusCode, 0);
  assert.equal((await part(fresh, [catalog.slice(10, 20)])).statusCode, 0);
  assert.equal((await close(fresh)).statusCode, 0);
  const second = fingerprint();
  assert.equal((await whole(fresh, catalog.slice(10, 20))).statusCode, 0);
  assert.equal(second, fingerprint(), 'a second open did not start over');
  // a close with no part, and the load is closed
  assert.equal((await opened(fresh)).statusCode, 0);
  refused(await close(fresh), 'missing-ocm', 'a close with no part');
  emptyStore('a close with no part');
  refused(await close(fresh), 'load-not-open', 'a second close');
  // a part with no frame
  assert.equal((await opened(fresh)).statusCode, 0);
  refused(await call(fresh, 'load_epochs_part', []), 'missing-ocm', 'a part with no frame');
  emptyStore('a part with no frame');
  // load_epochs while a load is open starts its own (the open one is dropped)
  assert.equal((await opened(fresh)).statusCode, 0);
  assert.equal((await part(fresh, [catalog.slice(0, 3)])).statusCode, 0);
  assert.equal((await whole(fresh, catalog.slice(3, 8))).statusCode, 0);
  refused(await close(fresh), 'load-not-open', 'a close after load_epochs');
  // any non-zero status of an open drops the load in progress and empties the store (the rule a host relies on), a bad configuration included
  const badConfig = {CACHE_DAYS: -1};
  assert.equal((await opened(fresh)).statusCode, 0);
  assert.equal((await part(fresh, [catalog.slice(0, 3)])).statusCode, 0);
  const badOpen = await opened(fresh, badConfig);
  assert.equal(badOpen.statusCode, 3, 'an open with a bad configuration was accepted');
  emptyStore('a refused open');
  refused(await part(fresh, [catalog.slice(3, 6)]), 'load-not-open', 'a part after a refused open: the earlier load was dropped');
  refused(await close(fresh), 'load-not-open', 'a close after a refused open');
  assert.equal((await whole(fresh, catalog)).statusCode, 0);
  assert.equal((await opened(fresh, badConfig)).statusCode, 3);
  emptyStore('a refused open of a loaded store');
  // load_epochs refused while a load is open abandons it; refused with none open it leaves the store as it was (it always did)
  assert.equal((await opened(fresh)).statusCode, 0);
  assert.equal((await part(fresh, [catalog.slice(0, 3)])).statusCode, 0);
  refused(await call(fresh, 'load_epochs', []), 'missing-ocm', 'load_epochs with no frame while a load is open');
  refused(await part(fresh, [catalog.slice(3, 6)]), 'load-not-open', 'a part after a refused load_epochs');
  emptyStore('load_epochs refused while a load is open');
  assert.equal((await whole(fresh, catalog)).statusCode, 0);
  fingerprint();
  const kept = fingerprint();
  refused(await call(fresh, 'load_epochs', []), 'missing-ocm', 'load_epochs with no frame');
  assert.equal(fingerprint(), kept, 'a load_epochs refused before it began changed the store');
  console.log('misuse: refused by name, the store untouched or empty as stated');
}

// ---- 3b. a zero-length part, and a payload cut in the middle of a frame at a part boundary
{
  const empty = {portId: 'ocm', typeRef: T('OCM'), payload: Buffer.alloc(0)};
  const w = await call(fresh, 'load_epochs', [empty]);
  assert.equal(w.statusCode, 3);
  assert.equal((await opened(fresh)).statusCode, 0);
  assert.equal((await part(fresh, [catalog.slice(0, 4)])).statusCode, 0);
  const z = await call(fresh, 'load_epochs_part', [empty]);
  assert.deepEqual([z.statusCode, z.errorCode, z.errorMessage], [w.statusCode, w.errorCode, w.errorMessage], 'a zero-length part is refused as load_epochs refuses it');
  emptyStore('a zero-length part');
  refused(await close(fresh), 'load-not-open', 'a close after a zero-length part');
  // the byte stream of five records cut in the middle of the third record: the first part ends inside a frame
  const stream = Buffer.concat(catalog.slice(0, 5).map(prefix)), cut = prefix(catalog[0]).length * 2 + 100;
  assert.equal((await opened(fresh)).statusCode, 0);
  const head = await call(fresh, 'load_epochs_part', [{portId: 'ocm', typeRef: T('OCM'), payload: stream.subarray(0, cut)}]);
  const wholeCut = await call(fresh, 'load_epochs', [{portId: 'ocm', typeRef: T('OCM'), payload: stream.subarray(0, cut)}]);
  assert.deepEqual([head.statusCode, head.errorCode, head.errorMessage], [wholeCut.statusCode, wholeCut.errorCode, wholeCut.errorMessage], 'a part cut in a frame');
  assert.equal(head.errorCode, 'invalid-ocm');
  emptyStore('a part cut in a frame');
  refused(await part(fresh, [catalog.slice(2, 3)]), 'load-not-open', 'the rest of a cut frame');
  console.log('zero-length part and a frame cut at a part boundary: refused as load_epochs refuses them, the load closed, the store empty');
}

// ---- 4. allocation failure in any call of a load in parts
const seam = failureSeam, probe = failureProbe;   // test/lib/ap-diagnostic.mjs: every replace must match
// the counted allocations per call (open, three parts, close) of the two scenarios below, measured on this build
const MIXED_COUNTS = [0, 2, 15, 19, 8], FORECAST_COUNTS = [0, 9, 7, 0, 5];
const seamedWasm = buildDiagnostic('load-parts-seam', probe, s => s, seam);
{
  const seamed = seamedWasm;
  const h = await open(seamed), x = h.instance.exports, p = x.sdnap_alloc(64);
  const stats = () => { x.sdnap_epochs_stats(p); return Array.from(new Float64Array(h.memory.buffer, p, 8)); };
  const inject = async (label, records, sizes, expected) => {
  // the calls of the load, as thunks: open, three parts, close
  const calls = () => {
    const out = [() => opened(h)];
    let from = 0;
    for (const s of sizes) { const mine = records.slice(from, from + s); from += s; out.push(() => part(h, [mine])); }
    out.push(() => close(h));
    return out;
  };
  const run = async (failCall, failAt) => {
    const list = calls();
    let r;
    for (let c = 0; c < list.length; ++c) {
      x.sdnap_test_fail_at(c === failCall ? failAt : 0);
      r = await list[c]();
      if (c === failCall) return {r, count: x.sdnap_test_alloc_count()};
      assert.equal(r.statusCode, 0, `call ${c}: ${r.errorCode}`);
    }
  };
  await run(-1, 0);   // the first load makes one-time allocations: count the second
  const counts = [];
  const ok = calls();
  for (let c = 0; c < ok.length; ++c) { x.sdnap_test_fail_at(0); assert.equal((await ok[c]()).statusCode, 0); counts.push(x.sdnap_test_alloc_count()); }
  assert.ok(stats()[1] > 0, `the load kept ${stats()[1]} sets`);
  // an equality, the open's count included: a count that drops is a counted site the seam no longer fails (the seam's replaces must all match, and these are measured)
  assert.deepEqual(counts, expected, `${label}: counted allocations per call (open, parts, close)`);
  let failed = 0;
  for (let c = 0; c < ok.length; ++c) {   // the open, the parts and the close, each failed one counted allocation at a time
    for (let n = 1; n <= counts[c]; ++n) {
      const {r} = await run(c, n);
      refused(r, 'out-of-memory', `allocation ${n} of ${counts[c]} of call ${c}`);
      const s = stats();
      assert.deepEqual([x.sdnap_epochs_count(), s[0], s[1], s[7]], [0, 0, 0, 0], `allocation ${n} of call ${c}: the store is not empty`);
      refused(await part(h, [records.slice(0, 2)]), 'load-not-open', `allocation ${n} of call ${c}: the load is not closed`);
      failed += 1;
    }
  }
  // a load after the refusals is the new snapshot alone
  x.sdnap_test_fail_at(0);
  assert.equal((await opened(h)).statusCode, 0);
  assert.equal((await part(h, [records.slice(0, 6)])).statusCode, 0);
  assert.equal((await close(h)).statusCode, 0);
  assert.ok(x.sdnap_epochs_count() > 0);
  console.log(`allocation failure, ${label}: ${failed} counted allocations of the parts and the close (${counts.join(', ')} per call) failed in turn, each refused out-of-memory with the store empty and the load closed`);
  return failed;
  };
  const mixed = [...catalog.slice(0, 6), ...catalog.slice(14, 24), ...catalog.slice(30, 34), ...catalog.slice(34, 36)];
  await inject('a mixed catalog', mixed, evenly(mixed.length, 3), MIXED_COUNTS);
  // records that carry a forecast: the copy of each record out of the part's bytes, and the track's arrays, are counted allocations that refuse by name
  await inject('records carrying a forecast', withForecast, [1, 1, 2], FORECAST_COUNTS);   // a forecast record in each of the first two parts
  await h.destroy?.();
}

// ---- 4b. a host that stages every part in one buffer: after each part the exact region the part used is overwritten, and the store must still equal the
// one load_epochs builds (a record's forecast is read from the part's bytes, which the module must have copied; no pointer into a part survives its call).
// The control is a build whose forecast copy is removed: it must NOT equal the one-call store after the same overwrite.
const staged = async (h, records, sizes) => {
  const x = h.instance.exports;
  let widest = 0, at = 0;
  const parts = sizes.map(s => { const mine = records.slice(at, at + s); at += s; const payload = Buffer.concat(mine.map(prefix)); widest = Math.max(widest, payload.length); return payload; });
  const staging = x.plugin_alloc(widest);
  assert.ok(staging);
  let r = await call(h, 'load_epochs_open', [configuration({epochStore: {}})]);
  for (let k = 0; r.statusCode === 0 && k < parts.length; ++k) {
    new Uint8Array(h.memory.buffer, staging, parts[k].length).set(parts[k]);
    r = await h.invoke({methodId: 'load_epochs_part', externalArena: new Uint8Array(h.memory.buffer), inputs: [{portId: 'ocm', typeRef: T('OCM'), offset: staging, size: parts[k].length, alignment: 8}]});
    new Uint8Array(h.memory.buffer, staging, widest).fill(0xA5);   // the host reuses its buffer: the region the part used holds something else now
  }
  if (r.statusCode === 0) r = await close(h);
  x.plugin_free?.(staging, widest);
  return r;
};
{
  const forecastCatalog = [...withForecast, ...catalog.slice(0, 8), ...catalog.slice(18, 24)];
  assert.equal((await whole(fresh, forecastCatalog)).statusCode, 0);
  const expect = fingerprint();
  assert.match(expect, /\["source",1\]/, 'no series answers from a carried forecast: the copy is not exercised');
  const r = await staged(fresh, forecastCatalog, evenly(forecastCatalog.length, 5));
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  assert.equal(fingerprint(), expect, 'a store built from a reused staging buffer differs from the one load_epochs builds');
  // the control
  const control = buildDiagnostic('load-parts-control', '', s => s, {'carried.inc': s => s.replace('inline bool keep(Track& t) {\n  if (t.recs == nullptr) return true;', 'inline bool keep(Track& t) {\n  if (true) return true;\n  if (t.recs == nullptr) return true;')});
  const ch = await open(control), cq = probeOf(ch);
  // the control reads the overwritten region: its load is answered and the states of the forecast records differ from the one-call store's (its fingerprint
  // differs in a series whose forecast the store answers from), or a segment's refusal names the overwritten bytes; any other outcome is not the defect
  let reason = null;
  try {
    const cr = await staged(ch, forecastCatalog, evenly(forecastCatalog.length, 5));
    if (cr.statusCode !== 0) reason = `refused ${cr.errorCode}`;
    else {
      const got = JSON.parse(fingerprint(cq)), want = JSON.parse(expect);
      const differing = got.map((v, k) => (JSON.stringify(v) !== JSON.stringify(want[k]) ? k : -1)).filter(k => k >= 0);
      if (differing.length > 0) reason = `${differing.length} entries of the fingerprint differ (first at ${differing[0]})`;
    }
  } catch (e) { reason = `the module trapped (${e?.message ?? e})`; }
  assert.ok(reason !== null, 'the control (no forecast copy) equals the one-call store after the staging buffer is overwritten: the test would not catch a missing copy');
  assert.match(reason, /^(refused carried-|\d+ entries of the fingerprint differ|the module trapped)/, `the control broke for another reason: ${reason}`);
  console.log(`staging buffer reused: the store equals the one-call store; the control without the forecast copy does not (${reason})`);
  await ch.destroy?.();
}

// ---- 5. memory: parts of 100 against one payload
{
  const many = Array.from({length: 3000}, (_, k) => stock(600000 + k, 0, 15 + (k % 97) / 100));
  const grown = async sizes => {
    const h = await open(wasmPath);
    const before = h.memory.buffer.byteLength;
    const r = sizes === null ? await whole(h, many) : await inParts(h, many, sizes);
    assert.equal(r.statusCode, 0, r.errorMessage);
    const x = h.instance.exports, p = x.sdnap_alloc(64); x.sdnap_epochs_stats(p);
    const kept = new Float64Array(h.memory.buffer, p, 8)[1];
    const out = {grown: h.memory.buffer.byteLength - before, kept};
    await h.destroy?.();
    return out;
  };
  const one = await grown(null), parts = await grown(Array(30).fill(100));
  assert.equal(one.kept, parts.kept);
  assert.ok(parts.grown < 0.6 * one.grown, `3000 records in parts of 100 grew the instance by ${parts.grown} bytes, in one payload ${one.grown}`);
  console.log(`memory: 3000 records grew the instance by ${parts.grown} B in parts of 100 and ${one.grown} B in one payload`);
}
// ---- 6. memory returned after a refusal: repeated refused loads do not keep growing the instance
{
  // What this can see: the instance's memory (memory.buffer.byteLength) does not keep growing over repeated refused loads of records that own something (a covariance
  // set, two distinct weather series, a forecast copy, a second slot), refused three ways: a record that cannot be decoded, a failed allocation (the test build's
  // seam, here the fifth counted allocation of a part), and a close that refuses. What it cannot see: the byte statistic, which reads 0 after any drop by
  // construction; a leak the heap reuses is invisible to it, and only a growth of the memory shows.
  const h = await open(seamedWasm), x = h.instance.exports, p = x.sdnap_alloc(64);
  const held = () => { x.sdnap_epochs_stats(p); return new Float64Array(h.memory.buffer, p, 8)[7]; };
  const garbage = new Uint8Array([1, 2, 3, 4]);
  const owning = [...good.slice(0, 24), ...withForecast];
  const trial = async () => {
    x.sdnap_test_fail_at(0);
    assert.equal((await opened(h)).statusCode, 0);
    assert.equal((await part(h, [owning.slice(0, 12)])).statusCode, 0);
    assert.equal((await part(h, [owning.slice(12)])).statusCode, 0);
    // SPEC 14.1.1: a record that carries a forecast holds the whole record (its bytes), and a record its covariance set, while the load is open
    assert.ok(held() >= withForecast.reduce((s, r) => s + r.length, 0), `an open load holding ${withForecast.length} forecast records reports ${held()} bytes`);
    refused(await part(h, [[garbage]]), 'invalid-ocm', 'a part that cannot be decoded');   // the load is dropped
    assert.equal(held(), 0, 'a refused load still holds bytes');
    assert.equal((await opened(h)).statusCode, 0);
    assert.equal((await part(h, [owning.slice(0, 12)])).statusCode, 0);
    x.sdnap_test_fail_at(5);
    refused(await part(h, [owning.slice(12)]), 'out-of-memory', 'a part whose fifth counted allocation fails');
    x.sdnap_test_fail_at(0);
    assert.equal(held(), 0, 'an out-of-memory load still holds bytes');
    const c = await inParts(h, [...good, ap(520010, t => { at(5, t); t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 20; })], [24, 6, 1]);
    assert.equal(c.errorCode, 'series-forces-differ');   // a close that refuses
    assert.equal(held(), 0, 'a refused close still holds bytes');
  };
  for (let k = 0; k < 3; ++k) await trial();   // warm-up: the high-water of one trial
  const settled = h.memory.buffer.byteLength;
  for (let k = 0; k < 12; ++k) await trial();
  assert.ok(h.memory.buffer.byteLength - settled <= 1048576, `twelve more refused loads grew the instance from ${settled} to ${h.memory.buffer.byteLength}`);
  console.log(`memory after refusals: the instance stays at ${h.memory.buffer.byteLength} B over 12 repeated refused loads of records that own something`);
  await h.destroy?.();
}
console.log(JSON.stringify({compared}));
await command.destroy?.(); await fresh.destroy?.();
console.log('LOAD-PARTS PASS');
