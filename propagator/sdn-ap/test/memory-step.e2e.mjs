#!/usr/bin/env node
// E2E (SPEC 1.6, SPEC 9; the init-threads review's item 13): the allocator's break. sbrk keeps the allocator's break below
// the memory's end and grows the memory by at least a step (4 MiB) when the break would pass it; through 0.6.56 it grew the
// memory by exactly what the allocator asked, in its small steps, and a serial first pass lost about a third of its time
// to those growths. Each case against a test build of the same sources with the step 0 (that behavior):
// 1. A serial pass: 3,000 AP sets at 500 km (zonal 20, tesseral 31, NRLMSISE-00 on quiet rows), one load_epochs, the whole
//    store by sdnap_epochs_at a day after epoch, no pool threads: the planes and statuses equal byte for byte; this build's
//    memory growths in the pass (sdnap_pool_stats [10], pages [11]) each of at least a step (growths <= pages / 64), the
//    step-0 build's at least ten times as many; the memory after the pass at most one step above the step-0 build's.
// 2. The same pass on 4 pool threads: the serial bytes; no growth of the memory inside a batch ([4] 0).
// 3. The memory limit: 547 such sets flown one by one (sdnap_epochs_set_at), 128 MiB: this build answers exactly the sets
//    the step-0 build answers, each state bit for bit (a step that does not fit falls back to the request alone).
// JS moves bytes and compares numbers the module produced.
//   node test/memory-step.e2e.mjs
import assert from "node:assert/strict";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";

ensureBuilt();
const MIB = 1 << 20, DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const STEP_PAGES = 64;  // 4 MiB (pool.inc kSbrkStepPages)
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS })));
const record = (k) => seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: (120 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: 3.8e-3, agom: 0.01, norad: 80000 + k, name: `P${k}`, msis: true, records: true, rows, tesseral: 31, zonal: 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const [W, F] = (() => { const d = (EPOCH + DAY) / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; })();
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

// the step-0 build: the same sources, sbrk growing the memory by the allocator's request alone
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `the seam's anchor ${JSON.stringify(from)} is not unique`); return text.replace(from, to); };
const stepZero = buildDiagnostic("memory-step-0", " ", (s) => s, {
  "pool.inc": (t) => once(t, `constexpr uint64_t kSbrkStepPages = ${STEP_PAGES};`, "constexpr uint64_t kSbrkStepPages = 0;"),
});

async function open(file, { max = 0, threads = 0 } = {}) {
  const options = { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0, initialMemoryBytes: 64 * MIB };
  if (max > 0) options.maximumMemoryBytes = max * MIB;
  const h = await createStandaloneHarness("browser", file, options);
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const mem = () => (h.memory ?? x.memory).buffer;
  const ps = x.sdnap_alloc(96);
  const stats = () => { x.sdnap_pool_stats(ps); return Array.from(new Float64Array(mem(), ps, 12)); };
  return { x, mem, stats, load: (payload) => h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload }] }) };
}

// 1 and 2: a pass over the whole store
async function pass(file, n, threads) {
  const m = await open(file, { threads });
  assert.equal((await m.load(Buffer.concat(Array.from({ length: n }, (_, k) => prefixed(record(k)))))).statusCode, 0, "load_epochs");
  const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n);
  const before = m.stats();
  assert.equal(m.x.sdnap_epochs_at(W, F, 0, n, 0, out, status, 0), 0, "sdnap_epochs_at");
  const after = m.stats();
  const bytes = Buffer.concat([Buffer.from(new Uint8Array(m.mem(), out, 48 * n)), Buffer.from(new Uint8Array(m.mem(), status, 4 * n))]);
  const codes = new Int32Array(m.mem(), status, n);
  return { bytes, good: codes.filter((c) => c === 0).length, growths: after[10] - before[10], pages: after[11] - before[11],
    grewInBatch: after[4], memory: m.mem().byteLength };
}
const N = 3000;
const step = await pass(wasmPath, N, 0), zero = await pass(stepZero, N, 0);
assert.equal(step.good, N, `part 1: ${step.good} of ${N} states answered`);
assert.ok(step.bytes.equals(zero.bytes), "part 1: the serial pass's planes and statuses against the step-0 build's");
assert.ok(step.growths > 0 && step.growths <= step.pages / STEP_PAGES, `part 1: ${step.growths} growths of ${step.pages} pages, each at least a step`);
assert.ok(zero.growths >= 10 * step.growths, `part 1: the step-0 build grew ${zero.growths} times against this build's ${step.growths}`);
assert.ok(step.memory - zero.memory <= STEP_PAGES * 65536 && step.memory >= zero.memory,
  `part 1: memory ${step.memory / MIB} MiB against the step-0 build's ${zero.memory / MIB} (at most one step more)`);
console.log(`part 1 (serial, ${N} AP sets): equal to the step-0 build byte for byte; memory grown ${step.growths} times (${step.pages} pages) ` +
  `against ${zero.growths} (${zero.pages} pages); memory ${step.memory / MIB} MiB against ${zero.memory / MIB}`);
const pooled = await pass(wasmPath, N, 4);
assert.ok(pooled.bytes.equals(step.bytes), "part 2: 4 pool threads against the serial pass");
assert.equal(pooled.grewInBatch, 0, "part 2: the memory grew inside a batch");
console.log(`part 2 (4 pool threads): the serial bytes; memory grown ${pooled.growths} times (${pooled.pages} pages), none inside a batch`);

// 3. the memory limit
{
  const K = 547;
  const snapshot = Buffer.concat(Array.from({ length: K }, (_, k) => prefixed(record(k))));
  const flown = [];
  for (const file of [wasmPath, stepZero]) {
    const m = await open(file, { max: 128 });
    assert.equal((await m.load(snapshot)).statusCode, 0, "part 3: load_epochs");
    const o = m.x.sdnap_alloc(48), r = [];
    for (let k = 0; k < K; k++) {
      let rc;
      try { rc = m.x.sdnap_epochs_set_at(k, 0, W, F, o); } catch (e) { assert.fail(`part 3, set ${k}: the module trapped (${e?.message ?? e})`); }
      r.push(rc === 0 ? Array.from(new Float64Array(m.mem(), o, 6)) : rc);
    }
    flown.push({ r, memory: m.mem().byteLength });
  }
  const [now, old] = flown;
  const answered = now.r.filter(Array.isArray).length;
  for (let k = 0; k < K; k++)
    assert.ok(Array.isArray(old.r[k]) ? Array.isArray(now.r[k]) && same(now.r[k], old.r[k]) : now.r[k] === old.r[k],
      `part 3, set ${k}: this build ${Array.isArray(now.r[k]) ? "a state" : now.r[k]}, the step-0 build ${Array.isArray(old.r[k]) ? "a state" : old.r[k]}`);
  assert.ok(answered < K, "part 3: the limit not reached");
  console.log(`part 3 (128 MiB): ${answered} of ${K} sets answered, the step-0 build's sets bit for bit; memory ${now.memory / MIB} MiB and ${old.memory / MIB}`);
}
console.log("MEMORY-STEP PASS");
process.exit(0);
