#!/usr/bin/env node
// Epoch-store concurrency equivalence: seeded elements, TEME km and km/s, UTC June 15-16, 2026.
// Reference: the same records through one-series serial calls, plus an optional earlier module. Tolerance: zero bytes;
// this tests scheduling independence, without registering a new physical accuracy reference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { seedOcm, rowsThrough, repackOcm, ocmOf, T } from './lib/ocm.mjs';
import { configuration } from './lib/pcf.mjs';
import { wasmPath, ensureBuilt } from './lib/module.mjs';
import { scratchRoot } from './lib/scratch.mjs';
import { buildDiagnostic } from './lib/ap-diagnostic.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const here = path.dirname(fileURLToPath(import.meta.url));
const count = Number(arg('--count', 2048));
const epoch = Date.parse('2026-06-15T00:00:00Z'), day = 86400000;
const iso = t => new Date(t).toISOString().replace('Z', '');
const prefix = b => { const p = Buffer.alloc(b.length + 4); p.writeUInt32LE(b.length); Buffer.from(b).copy(p, 4); return p; };
const root = path.join(scratchRoot, 'epoch-pool-results'); fs.mkdirSync(root, { recursive: true });
const wide = Number(arg('--wide', 8));
const covTemplate = ocmOf(fs.readFileSync(path.join(here, 'fixtures/ap-fit-0.6.42.ocm')));
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
    const isWide = k < wide;
    const meo = !isWide && k % 13 === 0, geo = !isWide && k % 17 === 0;
    const n = isWide ? 2.26 : meo ? 2.0056 : geo ? 1.0027 : Math.sqrt(398600.4418 / a ** 3) * 86400 / (2 * Math.PI);
    const e = isWide ? 0.65 + k * 0.00001 : meo ? 0.005 : 0.001;
    const i = isWide ? 27 + k * 0.001 : meo ? 55 : geo ? 0.05 : 35 + rand() * 65;
    const raan = rand() * 360, ma = rand() * 360;
    for (let set = 0; set < 3; ++set) {
      let b = seedOcm({ epoch: iso(epoch + set * day / 2), n, e, i, raan, argp: 90, ma: (ma + set * 7) % 360,
        norad: 900000 + k, msis: true, records: true, rows: rows[k % 2], bterm: 0.001, agom: 0.001,
        tesseral: k % 31 === 0 ? 70 : k % 2 ? 31 : 12, zonal: 20, slow: k % 19 === 0 });
      if (k % 2 === 0) b = repackOcm(b, t => {
        for (const [key, value] of Object.entries(covTemplate)) if (key.startsWith('COV')) t[key] = value;
        t.PROVENANCE = covTemplate.PROVENANCE;
        t.COV_SIZE = 6; t.COV_PARAMETER_KINDS = []; t.COV_PARAMETERS = []; t.COV_REALISM = [];
        t.COV_UNITS = ['km', 'km', 'km', 'km/s', 'km/s', 'km/s'];
        t.COVARIANCE_DATA = Array.from({ length: 21 }, (_, j) => [0, 2, 5].includes(j) ? 1e-2 : [9, 14, 20].includes(j) ? 1e-8 : 0);
        for (const key of Object.keys(t.COV_PROPAGATION)) t.COV_PROPAGATION[key] = 0;
      });
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
  const load = await h.invoke({ methodId: 'load_epochs', inputs: [configuration({ epochStore: { BLEND_WINDOW_SECONDS: 3600 } }),
    { portId: 'ocm', typeRef: T('OCM'), payload: records() }] });
  assert.equal(load.statusCode, 0, `${load.errorCode}: ${load.errorMessage}`);
  assert.equal(x.sdnap_epochs_count(), count);
  if (x.sdnap_test_epoch_mode) x.sdnap_test_epoch_mode(process.argv.includes('--refuse') ? 2 : 1);
  const out = x.sdnap_alloc(48 * count), status = x.sdnap_alloc(4 * count), stats = x.sdnap_alloc(80);
  const all = [];
  let good = 0, refused = 0;
  for (const offset of [0.25, 1.25]) {
    const w = 2461206.5, f = offset; // June 15, 2026 UTC, split JD
    if (process.argv.includes('--single')) {
      const values = new Float64Array(6 * count), codes = new Int32Array(count);
      for (let k = 0; k < count; ++k) {
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
  }
  x.sdnap_pool_stats(stats);
  const pool = Array.from(new Float64Array(h.memory.buffer, stats, 10));
  assert.equal(pool[4], 0, 'memory grew during the batch');
  if (threads && !process.argv.includes('--single')) assert.equal(pool[1], 2);
  if (process.argv.includes('--refuse')) assert.ok(pool[2] > 0 && pool[3] > 0, 'no-reserve control must exercise deferral');
  else { assert.equal(pool[2], 0, 'ordinary batch refused growth'); assert.equal(pool[3], 0, 'ordinary batch deferred series'); }
  const bytes = Buffer.concat(all), digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, label + '.bin'), bytes);
  console.log(JSON.stringify({ label, threads, count, sets: 3 * count, wide, good, refused, digest, pool, memoryBytes: h.memory.buffer.byteLength }));
  process.exit(0);
}
ensureBuilt();
const extra = `
void sdnap_test_epoch_poison() {
  auto& t = sdnap::xpt::tess::sp_terms_scratch();
  std::memset(&t, 0xff, sizeof(t));
  auto& sh = sdnap::xpt::tess::shallow_scratch();
  std::memset(&sh, 0xff, sizeof(sh));
  auto& s = sdnap::xpt::tess::g_sp_table_scratch;
  if (s.comb) std::memset(s.comb, 0xff, s.comb_cap * sizeof(*s.comb));
  if (s.raw) std::memset(s.raw, 0xff, s.raw_cap * sizeof(*s.raw));
}
SDNAP_EXPORT("sdnap_test_epoch_mode")
void sdnap_test_epoch_mode(int32_t mode) {
  sdnap::epochs::g_init_hook = mode ? sdnap_test_epoch_poison : nullptr;
  sdnap::pool::g_reserve_off = mode == 2;
}
`;
const diagnostic = arg('--diagnostic', null) ?? buildDiagnostic('epoch-pool-poison', extra);
const results = [];
function run(label, file, threads, options = []) {
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--case', '--label', label, '--wasm', file,
    '--threads', String(threads), '--count', String(count), '--wide', String(wide), ...options], { encoding: 'utf8', maxBuffer: 1 << 20 });
  const r = JSON.parse(output.trim().split('\n').at(-1)); results.push(r); console.log(JSON.stringify(r));
  return fs.readFileSync(path.join(root, label + '.bin'));
}
const reference = run('single', wasmPath, 0, ['--single']);
for (const threads of [0, 1, 4, 15]) assert.deepEqual(run(`threads-${threads}`, wasmPath, threads), reference);
for (const threads of [0, 1, 4, 15]) assert.deepEqual(run(`poison-${threads}`, diagnostic, threads), reference);
assert.deepEqual(run('deferred', diagnostic, 4, ['--refuse']), reference);
const baseline = arg('--baseline', null);
if (baseline) assert.deepEqual(run('baseline', baseline, 0), reference);
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`PASS: ${count} series, ${3 * count} records, ${wide} wide series, two instants, six planes and statuses equal to every byte`);
process.exit(0);
