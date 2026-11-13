#!/usr/bin/env node
// The load's COMMITTED claim: this build loads a catalog exactly as the build it replaced (796bacbe, main at sdn-ap 0.6.54, read with git; its epoch store source is byte-identical to 5bbdc851's, the build before this branch, so the base holds none of this branch's load changes) does, for every catalog and every refusal, and
// holds less. Both builds load the same bytes and the whole resident store is compared: the counts, every series' identity and set count, every set's epoch in
// order, the state of every set at one time after its epoch (bit for bit, with the code), and the selected state and covariance of every series. The catalogs
// cover the sets' order inside every series, a same-epoch duplicate with different content in both input orders, a capped load and theory-filtered loads, SGP4
// and SGP4XP and AP sets, AP sets with a covariance, a set carrying a forecast track, two distinct weather series (sharing and the discard of an unused one),
// and the refusals: each covariance refusal, several bad records in one load (the first one is reported), series-forces-differ; each compared by status, code
// and message with the old build's, and after every refusal the new build's store is empty (series, kept and bytes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {T, seedOcm, rowsThrough, repackOcm, ocmOf} from './lib/ocm.mjs';
import {configuration, pcfTheory} from './lib/pcf.mjs';
import {packageRoot, wasmPath} from './lib/module.mjs';
import {jdOf} from './lib/frames.mjs';
import {scratchDir} from './lib/scratch.mjs';
import {CLASSES, carriedRecord, harness as commandHarness} from './lib/carried.mjs';
const DAY = 86400000;
const fixture = new Uint8Array(fs.readFileSync(new URL('fixtures/ap-fit-0.6.43.ocm', import.meta.url)));
const epoch = ocmOf(fixture).MEAN_ELEMENTS.EPOCH;
const ms = Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');
const iso = t => new Date(t).toISOString().replace('Z', '');
const weather = value => rowsThrough(Array.from({length: 46}, (_, k) => ({DATE: iso(ms + (k - 5) * DAY).slice(0, 10), F107_OBS: value, F107_OBS_CENTER81: value + 2, AP_AVG: 4})));
const rows = [weather(70), weather(75), weather(80)];
const prefix = bytes => { const b = Buffer.alloc(bytes.length + 4); b.writeUInt32LE(bytes.length); b.set(bytes, 4); return b; };
const open = file => createStandaloneHarness('browser', file, {surface: 'direct', maxThreads: 1, enableBrowserWasiThreads: false, initialMemoryBytes: 2 * 1048576});
const load = (h, records, cfg = {}) => h.invoke({methodId: 'load_epochs', inputs: [{portId: 'ocm', typeRef: T('OCM'), payload: Buffer.concat(records.map(prefix))}, configuration({epochStore: cfg})]});
const oldPath = path.join(scratchDir('load-equivalence'), 'baseline.wasm');
fs.writeFileSync(oldPath, execFileSync('git', ['-C', packageRoot, 'show', '796bacbe:propagator/sdn-ap/dist/isomorphic/module.wasm'], {maxBuffer: 1 << 24}));
const fresh = await open(wasmPath), old = await open(oldPath);
const probe = h => { const x = h.instance.exports, p = x.sdnap_alloc(1 << 16); return {x, p, f64: (o, n) => new Float64Array(h.memory.buffer, o, n), i32: (o, n) => new Int32Array(h.memory.buffer, o, n)}; };
const pn = probe(fresh), po = probe(old);

// ---- the whole resident store, as numbers
const fingerprint = (h, q) => {
  const {x, p, f64, i32} = q, out = [];
  x.sdnap_epochs_stats(p); out.push(Array.from(f64(p, 7)));
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
    const at = jdOf(iso((epochs[0] - 2440587.5 + epochs[1]) * DAY + 5400000));
    const rc = x.sdnap_epochs_at(at.whole, at.frac, i, 1, 0, p + 1024, st, cov);
    out.push([rc, i32(st, 1)[0], ...Array.from(f64(p + 1024, 6)), ...Array.from(f64(cov, 36))]);
    x.sdnap_epochs_source_at(at.whole, at.frac, i, 1, st);   // SPEC 18.8: 1 where the state is the forecast the set carries
    out.push(['source', i32(st, 1)[0]]);
  }
  return JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
};
const bytesOf = q => { q.x.sdnap_epochs_stats(q.p); return q.f64(q.p, 8)[7]; };
const emptyAfter = (q, what) => { q.x.sdnap_epochs_stats(q.p); const s = q.f64(q.p, 8); assert.deepEqual([q.x.sdnap_epochs_count(), s[1], s[7]], [0, 0, 0], `${what}: the store after a refusal holds series, kept, bytes ${q.x.sdnap_epochs_count()}, ${s[1]}, ${s[7]}`); };
let compared = 0;
const same = async (name, records, cfg = {}) => {
  const a = await load(old, records, cfg), b = await load(fresh, records, cfg);
  assert.equal(b.statusCode, a.statusCode, `${name}: status ${b.statusCode} (${b.errorCode}) against the old build's ${a.statusCode} (${a.errorCode})`);
  if (a.statusCode !== 0) {
    assert.deepEqual([b.errorCode, b.errorMessage], [a.errorCode, a.errorMessage], `${name}: the refusal`);
    emptyAfter(pn, name);
    console.log(`${name}: refused ${b.errorCode}, store empty`);
    return b;
  }
  assert.equal(fingerprint(fresh, pn), fingerprint(old, po), `${name}: the store differs from the old build's`);
  compared += 1;
  const bn = bytesOf(pn), kept = pn.f64(pn.p, 8)[1], bo = bytesOf(po);
  console.log(`${name}: equal, ${pn.x.sdnap_epochs_count()} series, ${kept} kept, ${bn} B (old ${bo} B)`);
  return b;
};

// ---- records
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

// one catalog of every kind: series of several sets in shuffled input order, ties, the three theories, covariances, two distinct weathers
const catalog = [];
for (let k = 0; k < 4; ++k) catalog.push(await sgp4(500000 + k, 15 + k / 50, k * 7));
for (const d of [3, -2, 0, 1, -1]) catalog.push(await sgp4(500010, 15.2, d * 10, iso(ms + d * DAY)));          // a series of five SGP4 sets, shuffled
for (let k = 0; k < 4; ++k) catalog.push(stock(510000 + k, 0, 15 + k / 10));                                    // SGP4XP (stock forces)
for (const d of [2, -3, 0, -1, 1]) catalog.push(stock(510010, d));                                              // SGP4XP, five sets
for (let k = 0; k < 6; ++k) catalog.push(ap(520000 + k, t => { t.PERTURBATIONS.SPACE_WEATHER = rows[k % 2]; }));  // AP with covariance, two weather series
for (const d of [-2, 1, 0, -1]) catalog.push(ap(520010, t => at(d, t)));                                        // AP with covariance, four sets
for (let k = 0; k < 3; ++k) catalog.push(seedAp(530000 + k, 0, rows[k % 3]));                                   // AP without a covariance
// a same-epoch duplicate with different content, each order: the later record in the snapshot replaces
const dupA = ap(520020, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 100; }), dupB = ap(520020, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 200; });
catalog.push(dupA, dupB);
catalog.push(ap(520021, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 210; }), ap(520021, t => { t.MEAN_ELEMENTS.MEAN_ANOMALY = 110; }));
catalog.push(await sgp4(500020, 15.3, 10), await sgp4(500020, 15.3, 99));                                       // and an SGP4 pair
catalog.push(ap(520030, t => at(-9, t)));                                                                       // aged out of the 7 days
catalog.push(repackOcm(catalog[0], t => { t.CENTER_NAME = 'MARS'; }));                                          // not centered on the Earth
// the order of input must not matter for the order of a series: a seeded shuffle, twice
let seed = 20261113;
const shuffle = list => { const s = list.slice(); for (let k = s.length - 1; k > 0; --k) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (k + 1); [s[k], s[j]] = [s[j], s[k]]; } return s; };
const shuffled = [shuffle(catalog), shuffle(catalog)];
await same('catalog, as written', catalog);
await same('catalog, shuffled A', shuffled[0]);
await same('catalog, shuffled B', shuffled[1]);
await same('capped at 2 sets per object', catalog, {MAX_SETS_PER_OBJECT: 2});
await same('capped at 1 set per object', shuffled[0], {MAX_SETS_PER_OBJECT: 1});
await same('SGP4 sets only', catalog, {THEORIES: [pcfTheory.SGP4]});
await same('SGP4XP sets only', catalog, {THEORIES: [pcfTheory.SGP4XP]});
await same('AP sets only', shuffled[1], {THEORIES: [pcfTheory.AP]});
await same('one-day cache', catalog, {CACHE_DAYS: 1});
await same('SGP4XP and AP, capped at 3', catalog, {THEORIES: [pcfTheory.SGP4XP, pcfTheory.AP], MAX_SETS_PER_OBJECT: 3});

// a set that carries a forecast track: one SGP4XP class and one AP class, beside ordinary sets of other objects
const carried = [];
for (const [c, norad] of [[CLASSES[1], 99301], [CLASSES[0], 99302]]) carried.push((await carriedRecord(command, c, {norad})).ocm);
const carriedEpoch = ocmOf(carried[0]).MEAN_ELEMENTS.EPOCH;
const near = repackOcm(stock(99310, 0), t => { t.MEAN_ELEMENTS.EPOCH = carriedEpoch; });
await same('records carrying a forecast', [...carried, near, await sgp4(99311, 15.4, 5, carriedEpoch)]);
assert.match(fingerprint(fresh, pn), /\["source",1\]/, 'no series answers from a carried forecast: the track is not exercised');
await same('records carrying a forecast, shuffled and capped', shuffle([...carried, near]), {MAX_SETS_PER_OBJECT: 1});

// the weather: sharing, and the discard of one nothing keeps
const one = ap(520040, t => at(0, t)), sameWeather = ap(520040, t => at(-1, t)), otherWeather = ap(520040, t => { at(-2, t); t.PERTURBATIONS.SPACE_WEATHER = rows[1]; });
const unused = ap(520041, t => { at(-9, t); t.PERTURBATIONS.SPACE_WEATHER = rows[2]; });                       // aged out: nothing keeps its rows
const bytesFor = async (records, cfg = {}) => { assert.equal((await load(fresh, records, cfg)).statusCode, 0); return bytesOf(pn); };
const b1 = await bytesFor([one]), b2same = await bytesFor([one, sameWeather]), b2other = await bytesFor([one, otherWeather]), bUnused = await bytesFor([one, unused]);
const atmosphere = b2other - b2same;      // what a second distinct weather series costs beyond a second set
assert.ok(atmosphere > 2000, `a distinct weather series costs ${atmosphere} B`);
assert.ok(b2same - b1 < atmosphere / 2, `two sets of one weather series cost ${b2same - b1} B more than one: the rows are not shared`);
assert.ok(bUnused - b1 < 100, `an aged-out record's weather stays resident: ${bUnused - b1} B beyond the kept set's`);
console.log(`weather: one set ${b1} B; a second set of the same weather +${b2same - b1} B; of another weather +${b2other - b1} B; an unused weather +${bUnused - b1} B`);

// what a capped or theory-filtered load drops holds no memory: the store's bytes are those of a load of what it kept alone
const history = [];
for (let k = 0; k < 150; ++k) for (let d = 0; d < 8; ++d) history.push(stock(540000 + k, -d, 15 + k / 100));
const newest = [];
for (let k = 0; k < 150; ++k) newest.push(stock(540000 + k, 0, 15 + k / 100));
assert.equal(await bytesFor(history, {MAX_SETS_PER_OBJECT: 1}), await bytesFor(newest), 'a load capped at one set holds capacity for the sets it dropped');
const filtered = await bytesFor([...catalog.slice(0, 12), ...catalog.slice(30)], {THEORIES: [pcfTheory.AP]});
assert.equal(filtered, await bytesFor([...catalog.slice(0, 12), ...catalog.slice(30)].filter(r => ocmOf(r).MEAN_ELEMENTS.MEAN_ELEMENT_THEORY === 5)), 'a theory-filtered load holds capacity for the records it dropped');
console.log(`capped and filtered loads hold exactly what a load of the kept records alone holds (${await bytesFor(newest)} B)`);

// the refusals: each covariance refusal, several bad records, series-forces-differ; compared with the old build's code and message
const good = catalog.slice(0, 30);
const bad = {
  'garbage': new Uint8Array([1, 2, 3, 4]),
  'weather rows missing': ap(520050, t => { t.PERTURBATIONS.SPACE_WEATHER = []; }),
  'zonal degree 19': ap(520051, t => { t.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE = 19; }),
  'parameter kind unspecified': ap(520052, t => { t.COV_PARAMETER_KINDS = [0, ...t.COV_PARAMETER_KINDS.slice(1)]; }),
  'propagation invariant': ap(520053, t => { t.COV_PROPAGATION.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = t.COV_PROPAGATION.NOISE_NON_GRAVITATIONAL_RAD_DAY2 * 2 + 1; }),
  'covariance size': ap(520054, t => { t.COV_SIZE = 5; }),
  'covariance data short': ap(520055, t => { t.COVARIANCE_DATA = t.COVARIANCE_DATA.slice(1); }),
};
for (const [name, record] of Object.entries(bad)) await same(`refusal, ${name}`, [...good.slice(0, 12), record, ...good.slice(12)]);
await same('refusal, several bad records: the first is reported', [...good.slice(0, 5), bad['propagation invariant'], ...good.slice(5, 20), bad['garbage'], ...good.slice(20), bad['zonal degree 19']]);
await same('refusal, the last record bad', [...good, bad['covariance size']]);
await same('refusal, the first record bad', [bad['parameter kind unspecified'], ...good]);
await same('refusal, series-forces-differ', [...good, ap(520010, t => { at(5, t); t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 20; })]);
await same('refusal, an empty frame', []);
console.log(JSON.stringify({compared}));
await command.destroy?.(); await fresh.destroy?.(); await old.destroy?.();
console.log('LOAD-EQUIVALENCE PASS');
