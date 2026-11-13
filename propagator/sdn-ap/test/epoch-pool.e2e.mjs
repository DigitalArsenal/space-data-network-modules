#!/usr/bin/env node
// E2E (the epoch store's threaded batch, SPEC 9 and 14.5): sdnap_epochs_at on pool threads answers what the calling thread
// alone answers, byte for byte, and what the module this change was made on answered.
// The store: 2,048 seeded series, three sets each, 12 hours apart, loaded by one load_epochs (blend window one hour), flown
// at three instants (6 h, 18 h and 30 h after the first epoch: a blend of sets 0 and 1, then of 1 and 2, then set 2 alone,
// so slots are replaced inside the batches). The series, by k:
// - k < 8: AP at e 0.65, wide sets (the family-grid branch: above e 0.05 in no resonance class, above e 0.3 in one; flown
//   on the calling thread before each batch);
// - k mod 10 = 1: SGP4; k mod 10 = 2: SGP4XP without AP's terms; k mod 10 = 3: AP on Jacchia 1970 (no NRLMSISE-00);
// - the rest AP on NRLMSISE-00, at 290, 310, 500 and 830 km (node heights under and over 325 km: both of its paths);
// - two force sets alternating (tesseral 31 and zonal 20; tesseral 12 and zonal 6; tesseral 70 every 31st), two weather
//   tables alternating, a covariance on every even series, the slow set every 19th;
// so a pool thread that read another thread's binding, weather or set would change a byte.
// Every case writes the six planes and the statuses at the three instants:
// - the reference: each series alone (sdnap_epochs_at, one series a call), on the calling thread;
// - its digest equals MAIN_DIGEST, the same reference made by sdn-ap 0.6.57 (modules 6a807990), the module this change is
//   made on: the state, theory and status of every series are 0.6.57's;
// - the whole store a call on 0, 1, 4 and 15 pool threads; the store loaded in parts of 768 records (load_epochs_open,
//   _part, _close) on 0, 4 and 15; on 4 and 15, whole or in parts, the pool's statistics (sdnap_pool_stats [14] and
//   [15]) show rows run on pool threads, by at least two of them; on a test build (same sources, seams below) on 0, 1, 4 and 15
//   with each initializing thread's scratch (the table, terms, shallow, half-day, build and trigonometry scratch) and its
//   half-day evaluation cache's values poisoned before every set it builds, and on 4 with slices of 100 series (21 batches
//   a call): each equal to the reference, byte for byte;
// - after the three instants, every series' covariance at 24 h in one call (a call with a covariance plane runs on the
//   calling thread: no batch, asserted), equal to the bit to the reference's, which asks it one series at a time; every
//   series that carries a covariance answers one;
// - on 4 with no reserve (every growth of the memory inside a batch refused; up to one step of slack is still served, and
//   the case still refuses and defers, asserted): every status the reference's, and every state the reference's, byte for
//   byte, except that a series deferred at an instant may instead equal, byte for byte, the dropped control there: the
//   serial state with the series' two slots released just before its flight, which is what a deferral does. This
//   allowance covers one defect alone: an AP set of the half-day class answers differently once it was flown before (one
//   cache id for the brackets on both sides of a set's epoch in the tesseral and m-daily bake caches, and the same fault
//   in the drag-pass cache's key; the summary line prints how many deferred states took the control and the largest
//   position difference), and the store must hold such states.
// The test build counts, per thread, what each case took, asserted: rows, slots replaced and NRLMSISE-00 evaluations on
// each side of 325 km on the pool's threads (at least a quarter of each), more than one pool thread at 4 and 15 threads, the wide
// branch's rows on the calling thread, states of each family (SGP4, SGP4XP, AP), every state answered; the pool's own
// counts (no growth inside a batch, refusals and deferrals only where the reserve is off).
//   node test/epoch-pool.e2e.mjs [--count N]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pcfWeatherSource } from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { seedOcm, rowsThrough, repackOcm, ocmOf, T } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { wasmPath, ensureBuilt } from './lib/module.mjs';
import { scratchRoot } from './lib/scratch.mjs';
import { buildDiagnostic } from './lib/ap-diagnostic.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const here = path.dirname(fileURLToPath(import.meta.url));
const count = Number(arg('--count', 2048));
// the reference's digest as sdn-ap 0.6.57 (modules 6a807990, wasm 652fa229) made it, for the default store (2,048 series);
// 0.6.56 (85bc764c) gives the same
const MAIN_DIGEST = '1ca816ba472e78b0b385cad6bc56c17feba3fce835b4131640e015819c6fd5e8';
const epoch = Date.parse('2026-06-15T00:00:00Z'), day = 86400000;
const iso = t => new Date(t).toISOString().replace('Z', '');
const prefix = b => { const p = Buffer.alloc(b.length + 4); p.writeUInt32LE(b.length); Buffer.from(b).copy(p, 4); return p; };
const root = path.join(scratchRoot, 'epoch-pool-results'); fs.mkdirSync(root, { recursive: true });
const wide = Number(arg('--wide', 8));
const covTemplate = ocmOf(fs.readFileSync(path.join(here, 'fixtures/ap-fit-0.6.42.ocm')));
const INSTANTS = [0.25, 0.75, 1.25];  // days after June 15 2026 0h UTC
function records() {
  let state = 314159;
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const rows = [80, 155].map(flux => rowsThrough(Array.from({ length: 8 }, (_, k) => ({
    DATE: iso(epoch + (k - 2) * day).slice(0, 10), F107_OBS: flux, F107_OBS_CENTER81: flux + 2, AP_AVG: flux === 80 ? 4 : 15,
  }))));
  const result = [];
  for (let k = 0; k < count; ++k) {
    const h = [290, 310, 500, 830][k % 4];
    const a = 6378.137 + h;
    const isWide = k < wide, family = isWide ? 'ap' : k % 10 === 1 ? 'sgp4' : k % 10 === 2 ? 'xp' : k % 10 === 3 ? 'j70' : 'ap';
    const meo = !isWide && k % 13 === 0, geo = !isWide && k % 17 === 0;
    const n = isWide ? 2.26 : meo ? 2.0056 : geo ? 1.0027 : Math.sqrt(398600.4418 / a ** 3) * 86400 / (2 * Math.PI);
    const e = isWide ? 0.65 + k * 0.00001 : meo ? 0.005 : 0.001;
    const i = isWide ? 27 + k * 0.001 : meo ? 55 : geo ? 0.05 : 35 + rand() * 65;
    const raan = rand() * 360, ma = rand() * 360;
    const [tesseral, zonal] = k % 31 === 0 ? [70, 20] : k % 2 ? [31, 20] : [12, 6];
    for (let set = 0; set < 3; ++set) {
      const common = { epoch: iso(epoch + set * day / 2), n, e, i, raan, argp: 90, ma: (ma + set * 7) % 360, norad: 900000 + k };
      let b;
      if (family === 'sgp4' || family === 'xp') {
        b = seedOcm({ ...common, bterm: family === 'xp' ? 0.002 : 0 });
        if (family === 'sgp4') b = repackOcm(b, t => {
          t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 0; t.MEAN_ELEMENTS.BSTAR = 1e-4; t.ORB_AVERAGING = 'KOZAI';
          t.PERTURBATIONS.GRAVITY_MODEL = 'WGS-72'; t.PERTURBATIONS.WEATHER_SOURCE = pcfWeatherSource.NONE; t.PERTURBATIONS.ATMOSPHERIC_MODEL = null;
        });
      } else {
        b = seedOcm({ ...common, msis: family === 'ap', records: true, rows: rows[k % 2], bterm: 0.001, agom: 0.001, tesseral, zonal, slow: k % 19 === 0 });
        if (k % 2 === 0) b = repackOcm(b, t => {
          for (const [key, value] of Object.entries(covTemplate)) if (key.startsWith('COV')) t[key] = value;
          t.PROVENANCE = covTemplate.PROVENANCE;
          t.COV_SIZE = 6; t.COV_PARAMETER_KINDS = []; t.COV_PARAMETERS = []; t.COV_REALISM = [];
          t.COV_UNITS = ['km', 'km', 'km', 'km/s', 'km/s', 'km/s'];
          t.COVARIANCE_DATA = Array.from({ length: 21 }, (_, j) => [0, 2, 5].includes(j) ? 1e-2 : [9, 14, 20].includes(j) ? 1e-8 : 0);
          for (const key of Object.keys(t.COV_PROPAGATION)) t.COV_PROPAGATION[key] = 0;
        });
      }
      result.push(prefix(b));
    }
  }
  return Buffer.concat(result);
}
if (process.argv.includes('--case')) {
  const threads = Number(arg('--threads', 0)), file = arg('--wasm', wasmPath), label = arg('--label', 'case');
  const h = await createStandaloneHarness('browser', file, { surface: 'direct', maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads);
  const cfg = configuration({ epochStore: { BLEND_WINDOW_SECONDS: 3600 } });
  if (process.argv.includes('--parts')) {
    // the same records loaded in parts of 768 (load_epochs_open, load_epochs_part, load_epochs_close)
    const all = records(), parts = [];
    for (let o = 0, n = 0, start = 0; o < all.length; ++n) {
      o += 4 + all.readUInt32LE(o);
      if ((n + 1) % 768 === 0 || o >= all.length) { parts.push(all.subarray(start, o)); start = o; }
    }
    for (const [methodId, inputs] of [['load_epochs_open', [cfg]], ...parts.map((p) => ['load_epochs_part', [{ portId: 'ocm', typeRef: T('OCM'), payload: p }]]), ['load_epochs_close', []]]) {
      const r = await h.invoke({ methodId, inputs });
      assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`);
    }
  } else {
    const load = await h.invoke({ methodId: 'load_epochs', inputs: [cfg, { portId: 'ocm', typeRef: T('OCM'), payload: records() }] });
    assert.equal(load.statusCode, 0, `${load.errorCode}: ${load.errorMessage}`);
  }
  assert.equal(x.sdnap_epochs_count(), count);
  const mode = process.argv.includes('--refuse') ? 2 : 1;
  if (x.sdnap_test_epoch_mode) x.sdnap_test_epoch_mode(mode, Number(arg('--slice', 0)));
  const out = x.sdnap_alloc(48 * count), status = x.sdnap_alloc(4 * count), stats = x.sdnap_alloc(128), counts = x.sdnap_alloc(8 * 17 * 8);
  const all = [], deferredAt = [];
  const drop = process.argv.includes('--drop');
  const taken = x.sdnap_test_deferred_take ? x.sdnap_alloc(4 * 65536) : 0;
  let good = 0, refused = 0;
  for (const offset of INSTANTS) {
    const w = 2461206.5, f = offset;
    if (process.argv.includes('--single')) {
      const values = new Float64Array(6 * count), codes = new Int32Array(count);
      for (let k = 0; k < count; ++k) {
        if (drop) x.sdnap_test_epoch_drop(k);  // the series' sets built again for this flight, as a deferral builds them
        assert.equal(x.sdnap_epochs_at(w, f, k, 1, 0, out, status, 0), 0);
        const v = new Float64Array(h.memory.buffer, out, 6);
        for (let c = 0; c < 6; ++c) values[c * count + k] = v[c];
        codes[k] = new Int32Array(h.memory.buffer, status, 1)[0];
      }
      all.push(Buffer.from(values.buffer), Buffer.from(codes.buffer));
      good += codes.filter(s => s === 0).length; refused += codes.filter(s => s !== 0).length;
    } else {
      assert.equal(x.sdnap_epochs_at(w, f, 0, count, 0, out, status, 0), 0);
      all.push(Buffer.from(new Uint8Array(h.memory.buffer, out, 48 * count)), Buffer.from(new Uint8Array(h.memory.buffer, status, 4 * count)));
      const codes = new Int32Array(h.memory.buffer, status, count);
      good += codes.filter(s => s === 0).length; refused += codes.filter(s => s !== 0).length;
    }
    if (taken) { const n = x.sdnap_test_deferred_take(taken); deferredAt.push(Array.from(new Uint32Array(h.memory.buffer, taken, n))); }
  }
  if (taken) fs.writeFileSync(path.join(root, label + '-deferred.json'), JSON.stringify(deferredAt));
  x.sdnap_pool_stats(stats, 16);
  const pool = Array.from(new Float64Array(h.memory.buffer, stats, 16));
  let seams = null;
  if (x.sdnap_test_epoch_counts) {
    x.sdnap_test_epoch_counts(counts);
    const v = Array.from(new Float64Array(h.memory.buffer, counts, 17 * 8));
    const sum = (k, from = 0) => v.reduce((a, c, q) => a + (q % 8 === k && q >= 8 * from ? c : 0), 0);
    // totals over every thread, the same on the pool's threads alone (not the calling thread), and the pool threads with rows
    seams = { rows: sum(0), widePrePass: sum(1), replaced: sum(2), msisLow: sum(3), msisHigh: sum(4), sgp4: sum(5), xp: sum(6), ap: sum(7),
      poolRows: sum(0, 1), poolReplaced: sum(2, 1), poolMsisLow: sum(3, 1), poolMsisHigh: sum(4, 1),
      lanes: Array.from({ length: 16 }, (_, t) => v[8 * (t + 1)]).filter((n) => n > 0).length };
  }
  // a covariance after the threaded instants (SPEC 9: a call with a covariance plane runs on the calling thread): every
  // series' covariance at 24 h, one call over the store (one call a series in the reference), and the batches it ran
  const covInstant = 1.0, cov = x.sdnap_alloc(36 * 8 * count), covParts = [];
  const batchesBefore = pool[1];
  if (process.argv.includes('--single')) {
    const planesC = new Float64Array(6 * count), codesC = new Int32Array(count), covs = new Float64Array(36 * count);
    for (let k = 0; k < count; ++k) {
      assert.equal(x.sdnap_epochs_at(2461206.5, covInstant, k, 1, 0, out, status, cov), 0);
      const v = new Float64Array(h.memory.buffer, out, 6);
      for (let c = 0; c < 6; ++c) planesC[c * count + k] = v[c];
      codesC[k] = new Int32Array(h.memory.buffer, status, 1)[0];
      covs.set(new Float64Array(h.memory.buffer, cov, 36), 36 * k);
    }
    covParts.push(Buffer.from(planesC.buffer), Buffer.from(codesC.buffer), Buffer.from(covs.buffer));
  } else {
    assert.equal(x.sdnap_epochs_at(2461206.5, covInstant, 0, count, 0, out, status, cov), 0);
    covParts.push(Buffer.from(new Uint8Array(h.memory.buffer, out, 48 * count)), Buffer.from(new Uint8Array(h.memory.buffer, status, 4 * count)),
      Buffer.from(new Uint8Array(h.memory.buffer, cov, 36 * 8 * count)));
  }
  x.sdnap_pool_stats(stats, 2);
  const covBatches = new Float64Array(h.memory.buffer, stats, 2)[1] - batchesBefore;
  const covs = new Float64Array(Uint8Array.from(covParts[2]).buffer);
  const covAnswered = Array.from({ length: count }, (_, k) => Number.isFinite(covs[36 * k])).filter(Boolean).length;
  fs.writeFileSync(path.join(root, label + '-cov.bin'), Buffer.concat(covParts));
  assert.equal(pool[4], 0, 'memory grew during the batch');
  if (process.argv.includes('--refuse')) assert.ok(pool[2] > 0 && pool[3] > 0, 'no-reserve control must exercise deferral');
  else { assert.equal(pool[2], 0, 'ordinary batch refused growth'); assert.equal(pool[3], 0, 'ordinary batch deferred series'); }
  const bytes = Buffer.concat(all), digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, label + '.bin'), bytes);
  console.log(JSON.stringify({ label, threads, count, sets: 3 * count, wide, good, refused, digest, pool, seams, covBatches, covAnswered,
    deferredPerInstant: taken ? deferredAt.map((d) => d.length) : null, memoryBytes: h.memory.buffer.byteLength }));
  process.exit(0);
}
ensureBuilt();
// the test build: poison (each initializing thread's table scratch), no reserve, slices of a given size, and counters
const extra = String.raw`
// per thread (pool::g_beat_slot: 0 the calling thread, 1 to 16 the pool's), per counter
static uint64_t g_test_counts[17][8] = {};
void sdnap_test_count(int k) {
  const int32_t t = sdnap::pool::g_beat_slot;
  __atomic_add_fetch(&g_test_counts[t >= 0 && t < 17 ? t : 16][k], 1u, __ATOMIC_RELAXED);
}
// the initializing thread's scratch and its evaluation caches' values, poisoned before every set it builds: a set built
// on a thread reads none of what an earlier set left there
void sdnap_test_epoch_poison() {
  using namespace sdnap::xpt::tess;
  auto& t = sp_terms_scratch();
  std::memset(&t, 0xff, sizeof(t));
  auto& sh = shallow_scratch();
  std::memset(&sh, 0xff, sizeof(sh));
  auto& s = g_sp_table_scratch;
  if (s.comb) std::memset(s.comb, 0xff, s.comb_cap * sizeof(*s.comb));
  if (s.raw) std::memset(s.raw, 0xff, s.raw_cap * sizeof(*s.raw));
  auto& hd = g_half_day_scratch;
  if (hd.grid) std::memset(hd.grid, 0xff, hd.grid_cap * sizeof(*hd.grid));
  if (hd.values) std::memset(hd.values, 0xff, hd.values_cap * sizeof(*hd.values));
  if (hd.raw) std::memset(hd.raw, 0xff, hd.raw_cap * sizeof(*hd.raw));
  std::memset(&sp_build_scratch(), 0xff, sizeof(SpBuildScratch));
  std::memset(&g_sp_trig_scratch, 0xff, sizeof(g_sp_trig_scratch));
  auto& hc = half_day_eval_cache();
  for (float* b : {hc.b0, hc.b1, hc.b2, hc.b3, hc.b4, hc.b5, hc.b6, hc.b7}) std::memset(b, 0xff, sizeof(hc.b0));
}
SDNAP_EXPORT("sdnap_test_epoch_mode")
void sdnap_test_epoch_mode(int32_t mode, int32_t slice) {
  sdnap::epochs::g_init_hook = mode ? sdnap_test_epoch_poison : nullptr;
  sdnap::pool::g_reserve_off = mode == 2;
  if (slice > 0) sdnap::pool::epoch_slice_ref() = static_cast<uint32_t>(slice);
}
// 17 x 8 doubles: thread t's counter k at 8 t + k
SDNAP_EXPORT("sdnap_test_epoch_counts")
void sdnap_test_epoch_counts(double* out) {
  for (int t = 0; t < 17; ++t)
    for (int k = 0; k < 8; ++k) out[8 * t + k] = static_cast<double>(__atomic_load_n(&g_test_counts[t][k], __ATOMIC_RELAXED));
}
// the series the calling thread computed again after a batch (sdnap_epochs_at's deferral), in the order it did
static uint32_t g_test_deferred[1u << 16];
static uint32_t g_test_deferred_n = 0;
void sdnap_test_deferred(uint32_t k) { if (g_test_deferred_n < (1u << 16)) g_test_deferred[g_test_deferred_n++] = k; }
SDNAP_EXPORT("sdnap_test_deferred_take")
uint32_t sdnap_test_deferred_take(uint32_t* out) {
  const uint32_t n = g_test_deferred_n;
  for (uint32_t q = 0; q < n; ++q) out[q] = g_test_deferred[q];
  g_test_deferred_n = 0;
  return n;
}
// series k's two slots released, the slot to replace next kept: what a deferral does before it computes the series again
SDNAP_EXPORT("sdnap_test_epoch_drop")
void sdnap_test_epoch_drop(uint32_t k) {
  auto& s = sdnap::epochs::resident().series[k];
  const uint32_t next = s.next;
  for (auto& q : s.slots) sdnap::epochs::release(q);
  s.next = next;
}
`;
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `the seam's anchor ${JSON.stringify(from)} is not unique`); return text.replace(from, to); };
// counters, per thread: 0 rows of a batch, 1 the wide pre-pass, 2 slots replaced, 3 and 4 NRLMSISE-00 evaluations at or
// under 325 km and over it (over it also each lane of the batched high-altitude evaluation), 5 6 7 states flown per family
const declare = 'void sdnap_test_count(int k);\n';
const diagnostic = arg('--diagnostic', null) ?? buildDiagnostic('epoch-pool-poison', extra, (s) => s, {
  'epoch_store.inc': (t) => once(once(once(once(once('void sdnap_test_deferred(uint32_t k);\n' + declare + t,
    '    std::sort(deferred, deferred + n);\n', '    std::sort(deferred, deferred + n);\n    for (int32_t q = 0; q < n; ++q) sdnap_test_deferred(a + deferred[q]);\n'),
    '  const uint32_t next = s.next;\n', '  const uint32_t next = s.next;\n  sdnap_test_count(0);\n'),
    '    if (serial[k]) sdnap::epochs::write_series(', '    if (serial[k]) sdnap_test_count(1);\n    if (serial[k]) sdnap::epochs::write_series('),
    '  s.next = s.slots.second ? s.next ^ 1u : 0u;\n  release(q);\n', '  s.next = s.slots.second ? s.next ^ 1u : 0u;\n  if (q.index >= 0) sdnap_test_count(2);\n  release(q);\n'),
    '  const int32_t e = sdnap::epochs::at(st, st.series[first + k], t, r, v, cov != nullptr ? P : nullptr, have_p, jd);\n',
    '  const int32_t e = sdnap::epochs::at(st, st.series[first + k], t, r, v, cov != nullptr ? P : nullptr, have_p, jd);\n' +
    '  { const auto& en0 = st.entries[st.series[first + k].first]; sdnap_test_count(en0.row.theory == kTheorySgp4 ? 5 : (en0.forces.tesseral > 0 || en0.forces.zonal > 0) ? 7 : 6); }\n'),
  'atmosphere.inc': (t) => once(once(once(declare + t,
    '    const float* __restrict ctloc_in, const double* __restrict h_in, int n_lanes, double* __restrict rho_out) {\n',
    '    const float* __restrict ctloc_in, const double* __restrict h_in, int n_lanes, double* __restrict rho_out) {\n  for (int q = 0; q < n_lanes; ++q) sdnap_test_count(4);\n'),
    '  if (h > 325.0) {\n    double c, s, stloc, ctloc, slong, clong;\n', '  sdnap_test_count(h > 325.0 ? 4 : 3);\n  if (h > 325.0) {\n    double c, s, stloc, ctloc, slong, clong;\n'),
    '  const double sec_hr = sec * (1.0 / 3600.0);\n', '  const double sec_hr = sec * (1.0 / 3600.0);\n  sdnap_test_count(h > 325.0 ? 4 : 3);\n'),
});
const results = [];
function run(label, file, threads, options = []) {
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--case', '--label', label, '--wasm', file,
    '--threads', String(threads), '--count', String(count), '--wide', String(wide), ...options], { encoding: 'utf8', maxBuffer: 1 << 20 });
  const r = JSON.parse(output.trim().split('\n').at(-1)); results.push(r); console.log(JSON.stringify(r));
  return { bytes: fs.readFileSync(path.join(root, label + '.bin')), r };
}
const reference = run('single', wasmPath, 0, ['--single']);
if (count === 2048 && wide === 8) assert.equal(reference.r.digest, MAIN_DIGEST, `the reference against sdn-ap 0.6.57's (${MAIN_DIGEST})`);
// the shipped build's own statistics: rows run on pool threads ([14]) by at least two of them at 4 and 15 threads ([15]),
// none without the pool, so a build that flew every row on the calling thread fails here
const onPool = (c) => {
  const { label, threads, pool } = c.r;
  if (threads === 0) assert.ok(pool[14] === 0 && pool[15] === 0, `${label}: rows on pool threads ${pool[14]} with none running`);
  else assert.ok(pool[14] > 0 && pool[15] >= Math.min(threads, 2), `${label}: ${pool[14]} rows on ${pool[15]} pool threads`);
  return c;
};
for (const threads of [0, 1, 4, 15]) assert.ok(onPool(run(`threads-${threads}`, wasmPath, threads)).bytes.equals(reference.bytes), `${threads} pool threads`);
// the store loaded in parts (SPEC 14.1.1) and flown on the pool
for (const threads of [0, 4, 15]) assert.ok(onPool(run(`parts-${threads}`, wasmPath, threads, ['--parts'])).bytes.equals(reference.bytes), `loaded in parts, ${threads} pool threads`);
const seamed = [];
for (const threads of [0, 1, 4, 15]) { const c = run(`poison-${threads}`, diagnostic, threads); assert.ok(c.bytes.equals(reference.bytes), `poison, ${threads} pool threads`); seamed.push(c.r); }
const sliced = run('sliced', diagnostic, 4, ['--slice', '100']);
assert.ok(sliced.bytes.equals(reference.bytes), 'slices of 100 series');
// A deferred series is computed again from its records: its two slots released, its sets built again. An AP set of the
// half-day class answers differently once it was flown before (one cache id for the brackets on both sides of its epoch
// in the tesseral and m-daily bakes and the drag-pass cache's key), so the control for a deferred series is the serial
// state with its slots dropped just before its flight (the allowance of the header).
const dropped = run('dropped', diagnostic, 0, ['--single', '--drop']);
const deferred = run('deferred', diagnostic, 4, ['--refuse']);
const deferredAt = JSON.parse(fs.readFileSync(path.join(root, 'deferred-deferred.json'), 'utf8'));
const per = 52 * count;
const planes = (b, n, k) => Buffer.concat(Array.from({ length: 6 }, (_, c) => b.subarray(n * per + (c * count + k) * 8, n * per + (c * count + k + 1) * 8)));
const code = (b, n, k) => b.readInt32LE(n * per + 48 * count + 4 * k);
let history = 0, deferredStates = 0, tookDropped = 0, largestMm = 0;
// the position difference of a state that took the dropped control from the reference's (TEME km planes), for the summary
const apart = (a, b) => { const p = new Float64Array(Uint8Array.from(a).buffer), q = new Float64Array(Uint8Array.from(b).buffer); return 1e6 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
for (let n = 0; n < INSTANTS.length; ++n) {
  const late = new Set(deferredAt[n]);
  deferredStates += late.size;
  for (let k = 0; k < count; ++k) {
    const ref = planes(reference.bytes, n, k), drop = planes(dropped.bytes, n, k), got = planes(deferred.bytes, n, k);
    assert.equal(code(dropped.bytes, n, k), code(reference.bytes, n, k), `dropped control, series ${k} at ${INSTANTS[n]} d: status`);
    assert.equal(code(deferred.bytes, n, k), code(reference.bytes, n, k), `no reserve, series ${k} at ${INSTANTS[n]} d: status`);
    if (!ref.equals(drop)) history += 1;
    if (got.equals(ref)) continue;
    assert.ok(late.has(k) && got.equals(drop), `no reserve, series ${k} at ${INSTANTS[n]} d: ` +
      (late.has(k) ? 'deferred, but neither the reference nor the dropped control' : 'not deferred, and not the reference'));
    tookDropped += 1;
    largestMm = Math.max(largestMm, apart(got, ref));
  }
}
// the store holds states that a set's history moves (else the rule above tests nothing), and the case deferred series
assert.ok(history > 0, 'the store holds no state its set\'s history moves');
assert.ok(deferredStates > 0, 'the no-reserve case deferred no series');
console.log(JSON.stringify({ historyMoved: history, deferredStates, deferredTookDropped: tookDropped, deferredLargestMm: Number(largestMm.toFixed(3)) }));
// the coverage: every path taken, on the threaded cases, and taken on the pool's threads (not only the calling thread):
// at least a quarter of the rows, of the slots replaced and of the NRLMSISE-00 evaluations on each side of 325 km there,
// on more than one pool thread at 4 and 15 threads; every state answered
for (const r of [...seamed.filter((q) => q.threads > 0), sliced.r, deferred.r]) {
  const s = r.seams;
  assert.equal(r.good, 3 * count, `${r.label}: ${r.good} of ${3 * count} states answered`);
  assert.ok(s.widePrePass >= 3 * wide && s.replaced >= count - wide, `${r.label}: wide pre-pass ${s.widePrePass}, slots replaced ${s.replaced}`);
  assert.ok(s.msisLow > 0 && s.msisHigh > 0, `${r.label}: NRLMSISE-00 at or under 325 km ${s.msisLow}, over it ${s.msisHigh}`);
  assert.ok(s.sgp4 > 0 && s.xp > 0 && s.ap > 0, `${r.label}: states of each family: SGP4 ${s.sgp4}, SGP4XP ${s.xp}, AP ${s.ap}`);
  assert.ok(4 * s.poolRows >= 3 * (count - wide), `${r.label}: rows on pool threads ${s.poolRows} of ${3 * (count - wide)}`);
  assert.ok(4 * s.poolReplaced >= count - wide, `${r.label}: slots replaced on pool threads ${s.poolReplaced} of ${s.replaced}`);
  assert.ok(4 * s.poolMsisLow >= s.msisLow && 4 * s.poolMsisHigh >= s.msisHigh,
    `${r.label}: NRLMSISE-00 on pool threads ${s.poolMsisLow} of ${s.msisLow} at or under 325 km, ${s.poolMsisHigh} of ${s.msisHigh} over`);
  assert.ok(r.threads < 4 || s.lanes >= 2, `${r.label}: ${s.lanes} pool threads flew rows`);
}
for (const r of results.filter((q) => q.label.startsWith('threads-') || q.label.startsWith('parts-') || q.label.startsWith('poison-')))
  assert.equal(r.good, 3 * count, `${r.label}: ${r.good} of ${3 * count} states answered`);
// the covariance after the threaded instants: the reference's to the bit, on the calling thread (no batch), answered for
// every series that carries one
const covRef = fs.readFileSync(path.join(root, 'single-cov.bin'));
const carrying = Array.from({ length: count }, (_, k) => k % 2 === 0 && (k < wide || (k % 10 !== 1 && k % 10 !== 2))).filter(Boolean).length;
assert.equal(reference.r.covAnswered, carrying, `the reference's covariances: ${reference.r.covAnswered} of the ${carrying} series that carry one`);
for (const r of results.filter((q) => q.label.startsWith('threads-') || q.label.startsWith('parts-') || q.label.startsWith('poison-') || q.label === 'sliced')) {
  assert.ok(fs.readFileSync(path.join(root, r.label + '-cov.bin')).equals(covRef), `${r.label}: the covariances after the threaded instants`);
  assert.equal(r.covBatches, 0, `${r.label}: a call with a covariance plane ran ${r.covBatches} threaded batches`);
}
assert.ok(sliced.r.pool[1] >= 3 * Math.ceil(count / 100) - 3, `slices of 100: ${sliced.r.pool[1]} batches over three instants`);
assert.ok(deferred.r.pool[3] > 0, 'the deferred case deferred series');
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`PASS: ${count} series (${3 * count} records, ${wide} wide), three instants; the reference 0.6.57's; every case's planes and ` +
  `statuses the reference's, byte for byte, the no-reserve case's deferred states the dropped control's where a set's history moves them ` +
  `(${tookDropped} of ${deferredStates}; ${history} such states in the store)`);
process.exit(0);
