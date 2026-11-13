#!/usr/bin/env node
// E2E (SPEC 1.6, SPEC 9): the allocator's break. sbrk keeps the allocator's break at or below the end of the memory it has
// grown, grows the memory by at least a step (4 MiB) when the break would pass that end, never serves pages another party
// grew, and refuses at or past 4 GiB.
// 1. The break itself, through a test build that calls sbrk directly (no pool threads):
//    - sbrk(0) answers the break; a request answers the break before it and moves it by the request;
//    - a request past the end grows the memory by one step; the next request is served from the slack, after the first,
//      with no growth; a request larger than the slack and the step grows the memory by exactly what it lacks;
//    - inside a batch (the batch's flag set) a request within the slack is served with no growth, one past it refused
//      (ENOMEM, counted, the break unchanged);
//    - pages a host grew (memory.grow from the host, written by it) are never served: the next request starts past them,
//      and the host's bytes are intact;
//    - at a memory maximum a request that does not fit is refused with the break unchanged, and a small one is then served.
// Then the module's own use, each case against a test build with the step 0 (the memory grown by the request alone):
// 2. A serial pass: 3,000 AP sets at 500 km (zonal 20, tesseral 31, NRLMSISE-00 on quiet rows), one load_epochs, the whole
//    store by sdnap_epochs_at a day after epoch, no pool threads: the planes and statuses equal byte for byte; this build's
//    growths in the pass (sdnap_pool_stats [10], pages [11]) each at least a step and at most 100 (84 measured), the
//    step-0 build's thousands; the memory after the pass at most one step above the step-0 build's.
// 3. The same pass on 4 pool threads: the serial bytes, threaded batches run, no growth refused or made inside them.
// 4. A host that grows the memory by itself before the pass and writes its pages: the serial bytes, and the host's intact.
// 5. The epoch store's reserve at a memory maximum where the first slice's reserve does not fit (4 pool threads, the
//    shipped build): slices halved ([12]) and slices run on the calling thread ([13]), both counted, and the serial bytes.
// 6. The memory limit: 547 such sets flown one by one (sdnap_epochs_set_at), 128 MiB: this build answers exactly the sets
//    the step-0 build answers, each state bit for bit (a step that does not fit falls back to the request alone).
// JS moves bytes and compares numbers the module produced.
//   node test/memory-step.e2e.mjs
import assert from "node:assert/strict";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";

// a failure ends the process: the pool's threads would keep it alive
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
ensureBuilt();
const MIB = 1 << 20, PAGE = 65536, DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const STEP_PAGES = 64;  // 4 MiB (pool.inc kSbrkStepPages)
const STEP = STEP_PAGES * PAGE;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS })));
const record = (k) => seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: (120 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: 3.8e-3, agom: 0.01, norad: 80000 + k, name: `P${k}`, msis: true, records: true, rows, tesseral: 31, zonal: 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const [W, F] = (() => { const d = (EPOCH + DAY) / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; })();
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `the seam's anchor ${JSON.stringify(from)} is not unique`); return text.replace(from, to); };
// the step-0 build: the same sources, sbrk growing the memory by the allocator's request alone
const stepZero = buildDiagnostic("memory-step-0", " ", (s) => s, {
  "pool.inc": (t) => once(t, `constexpr uint64_t kSbrkStepPages = ${STEP_PAGES};`, "constexpr uint64_t kSbrkStepPages = 0;"),
});
// the probe build: the same sources and step, with sbrk, the break and the batch's flag reachable from the test
const probeBuild = buildDiagnostic("memory-step-probe", String.raw`
SDNAP_EXPORT("sdnap_test_sbrk")
double sdnap_test_sbrk(int32_t increment) {
  void* p = sbrk(increment);
  return p == reinterpret_cast<void*>(static_cast<intptr_t>(-1)) ? -1.0 : static_cast<double>(reinterpret_cast<uintptr_t>(p));
}
SDNAP_EXPORT("sdnap_test_break")
double sdnap_test_break() { return static_cast<double>(sdnap::pool::g_break); }
SDNAP_EXPORT("sdnap_test_batch_flag")
void sdnap_test_batch_flag(int32_t on) { __atomic_store_n(&sdnap::xpt::g_batch_running, on, __ATOMIC_SEQ_CST); }
`);

async function open(file, { max = 0, threads = 0 } = {}) {
  const options = { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0, initialMemoryBytes: 64 * MIB };
  if (max > 0) options.maximumMemoryBytes = max;
  const h = await createStandaloneHarness("browser", file, options);
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const memory = h.memory ?? x.memory;
  const mem = () => memory.buffer;
  const ps = x.sdnap_alloc(112);
  const stats = () => { x.sdnap_pool_stats(ps); return Array.from(new Float64Array(mem(), ps, 14)); };
  return { x, memory, mem, stats, load: (payload) => h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload }] }) };
}

// 1. the break
{
  const m = await open(probeBuild);
  const end = () => m.mem().byteLength;
  const growths = () => m.stats()[10];
  const b0 = m.x.sdnap_test_sbrk(0);
  assert.equal(b0, m.x.sdnap_test_break(), "sbrk(0) answers the break");
  // past the end: one step (the break may already sit below the end; take it to the end first)
  if (b0 < end()) assert.equal(m.x.sdnap_test_sbrk(end() - b0), b0, "a request within the slack answers the break");
  const e0 = end(), g0 = growths(), at = m.x.sdnap_test_break();
  assert.equal(at, e0, "the break at the end");
  const p1 = m.x.sdnap_test_sbrk(PAGE);
  assert.ok(p1 === at && m.x.sdnap_test_break() === at + PAGE, `a request answers the break before it (${p1}, ${at}) and moves it by the request`);
  assert.ok(end() === e0 + STEP && growths() === g0 + 1, `a request past the end: the memory grew by ${end() - e0}, not one step`);
  const p2 = m.x.sdnap_test_sbrk(2 * PAGE);
  assert.ok(p2 === p1 + PAGE && end() === e0 + STEP && growths() === g0 + 1, "the next request from the slack, after the first, with no growth");
  const before = m.x.sdnap_test_break(), big = 10 * MIB;
  const p3 = m.x.sdnap_test_sbrk(big);
  assert.ok(p3 === before && end() === before + big && growths() === g0 + 2, `a request larger than slack and step: the memory ends at the break (${end()} against ${before + big})`);
  // inside a batch: the slack, and nothing past it
  const atEnd = end();
  assert.equal(m.x.sdnap_test_sbrk(PAGE), atEnd, "a request past the end answers the break, the old end");
  const slackEnd = end(), refusedBefore = m.stats()[2], inside = m.x.sdnap_test_break();
  m.x.sdnap_test_batch_flag(1);
  const p4 = m.x.sdnap_test_sbrk(MIB);
  const p5 = m.x.sdnap_test_sbrk(4 * MIB);
  m.x.sdnap_test_batch_flag(0);
  assert.ok(p4 === inside && end() === slackEnd, "inside a batch: a request within the slack served, the memory not grown");
  assert.ok(p5 === -1 && m.x.sdnap_test_break() === inside + MIB && m.stats()[2] === refusedBefore + 1, "inside a batch: a request past the slack refused, counted, the break unchanged");
  // a host's pages
  const hostAt = end();
  m.memory.grow(16);
  new Uint8Array(m.mem(), hostAt, MIB).fill(0x5a);
  const p6 = m.x.sdnap_test_sbrk(4 * MIB);
  assert.ok(p6 >= hostAt + MIB, `the host's pages served to the allocator (${p6} below ${hostAt + MIB})`);
  m.x.sdnap_alloc(8 * MIB);
  assert.ok(new Uint8Array(m.mem(), hostAt, MIB).every((b) => b === 0x5a), "the host's pages written by the module");
  // the maximum
  const lim = await open(probeBuild, { max: 96 * MIB });
  const limitEnd = lim.mem().byteLength, br = lim.x.sdnap_test_sbrk(0);
  assert.equal(lim.x.sdnap_test_sbrk(96 * MIB - br + PAGE), -1, "a request past the maximum refused");
  assert.equal(lim.x.sdnap_test_break(), br, "the break unchanged after a refusal");
  assert.equal(lim.x.sdnap_test_sbrk(PAGE), br, "a small request served after the refusal");
  assert.ok(lim.mem().byteLength >= limitEnd, "the memory");
  console.log("part 1 (the break): requests, the slack, the step, a batch's slack and refusal, a host's pages and a maximum as stated");
}

// 2 to 4: a pass over the whole store
const N = 3000;
const snapshot = Buffer.concat(Array.from({ length: N }, (_, k) => prefixed(record(k))));
async function pass(file, n, { threads = 0, host = 0, max = 0, m = null } = {}) {
  m ??= await open(file, { threads, max });
  assert.equal((await m.load(n === N ? snapshot : Buffer.concat(Array.from({ length: n }, (_, k) => prefixed(record(k)))))).statusCode, 0, "load_epochs");
  let hostAt = 0;
  if (host) { hostAt = m.mem().byteLength; m.memory.grow(host / PAGE); new Uint8Array(m.mem(), hostAt, host).fill(0xa7); }
  const out = m.x.sdnap_alloc(48 * n), status = m.x.sdnap_alloc(4 * n);
  const before = m.stats(), memoryBefore = m.mem().byteLength;
  assert.equal(m.x.sdnap_epochs_at(W, F, 0, n, 0, out, status, 0), 0, "sdnap_epochs_at");
  const after = m.stats();
  const bytes = Buffer.concat([Buffer.from(new Uint8Array(m.mem(), out, 48 * n)), Buffer.from(new Uint8Array(m.mem(), status, 4 * n))]);
  const codes = new Int32Array(m.mem(), status, n);
  return { bytes, good: codes.filter((c) => c === 0).length, growths: after[10] - before[10], pages: after[11] - before[11], pool: after,
    batches: after[1] - before[1], refused: after[2] - before[2], memory: m.mem().byteLength, memoryBefore,
    hostIntact: host ? new Uint8Array(m.mem(), hostAt, host).every((b) => b === 0xa7) : null };
}
const step = await pass(wasmPath, N), zero = await pass(stepZero, N);
assert.equal(step.good, N, `part 2: ${step.good} of ${N} states answered`);
assert.ok(step.bytes.equals(zero.bytes), "part 2: the serial pass's planes and statuses against the step-0 build's");
assert.ok(step.growths > 0 && step.growths <= step.pages / STEP_PAGES && step.growths <= 100, `part 2: ${step.growths} growths of ${step.pages} pages: each at least a step, at most 100`);
assert.ok(zero.growths >= 1000, `part 2: the step-0 build grew ${zero.growths} times`);
assert.ok(step.memory - zero.memory <= STEP && step.memory >= zero.memory,
  `part 2: memory ${step.memory / MIB} MiB against the step-0 build's ${zero.memory / MIB} (at most one step more)`);
console.log(`part 2 (serial, ${N} AP sets): equal to the step-0 build byte for byte; memory grown ${step.growths} times (${step.pages} pages) ` +
  `against ${zero.growths} (${zero.pages} pages); memory ${step.memory / MIB} MiB against ${zero.memory / MIB}`);
const pooled = await pass(wasmPath, N, { threads: 4 });
assert.ok(pooled.bytes.equals(step.bytes), "part 3: 4 pool threads against the serial pass");
assert.ok(pooled.batches > 0 && pooled.refused === 0 && pooled.pool[4] === 0, `part 3: ${pooled.batches} threaded batches, ${pooled.refused} growths refused, ${pooled.pool[4]} grew inside one`);
console.log(`part 3 (4 pool threads): the serial bytes; ${pooled.batches} batches; memory grown ${pooled.growths} times (${pooled.pages} pages), none inside a batch`);
const hosted = await pass(wasmPath, N, { host: 4 * MIB });
assert.ok(hosted.bytes.equals(step.bytes) && hosted.hostIntact, "part 4: a host's 4 MiB grown before the pass: the serial bytes and the host's bytes intact");
console.log("part 4 (a host's pages): the serial bytes; the host's 4 MiB intact");

// 5. the reserve at a maximum: the memory the serial pass took over its load, a little more, and 4 pool threads
{
  const probe = await open(wasmPath, { threads: 4 });
  assert.equal((await probe.load(snapshot)).statusCode, 0, "part 5: load_epochs");
  const loaded = probe.mem().byteLength;
  const need = step.memory - step.memoryBefore;
  // 4 MiB over the serial pass's need: measured, 34 slices halved and 8 run serially
  const max = Math.ceil((loaded + need + 4 * MIB) / MIB) * MIB;
  const tight = await pass(wasmPath, N, { threads: 4, max });
  assert.ok(tight.pool[12] > 0 && tight.pool[13] > 0, `part 5 (maximum ${max / MIB} MiB): ${tight.pool[12]} slices halved, ${tight.pool[13]} run on the calling thread`);
  assert.ok(tight.bytes.equals(step.bytes), "part 5: the serial bytes");
  console.log(`part 5 (4 pool threads, maximum ${max / MIB} MiB): ${tight.pool[12]} slices halved, ${tight.pool[13]} run on the calling thread, ${tight.batches} batches; the serial bytes`);
}

// 6. the memory limit
{
  const K = 547;
  const limited = Buffer.concat(Array.from({ length: K }, (_, k) => prefixed(record(k))));
  const flown = [];
  for (const file of [wasmPath, stepZero]) {
    const m = await open(file, { max: 128 * MIB });
    assert.equal((await m.load(limited)).statusCode, 0, "part 6: load_epochs");
    const o = m.x.sdnap_alloc(48), r = [];
    for (let k = 0; k < K; k++) {
      let rc;
      try { rc = m.x.sdnap_epochs_set_at(k, 0, W, F, o); } catch (e) { assert.fail(`part 6, set ${k}: the module trapped (${e?.message ?? e})`); }
      r.push(rc === 0 ? Array.from(new Float64Array(m.mem(), o, 6)) : rc);
    }
    flown.push({ r, memory: m.mem().byteLength });
  }
  const [now, old] = flown;
  const answered = now.r.filter(Array.isArray).length;
  for (let k = 0; k < K; k++)
    assert.ok(Array.isArray(old.r[k]) ? Array.isArray(now.r[k]) && same(now.r[k], old.r[k]) : now.r[k] === old.r[k],
      `part 6, set ${k}: this build ${Array.isArray(now.r[k]) ? "a state" : now.r[k]}, the step-0 build ${Array.isArray(old.r[k]) ? "a state" : old.r[k]}`);
  assert.ok(answered < K, "part 6: the limit not reached");
  console.log(`part 6 (128 MiB): ${answered} of ${K} sets answered, the step-0 build's sets bit for bit; memory ${now.memory / MIB} MiB and ${old.memory / MIB}`);
}
console.log("MEMORY-STEP PASS");
process.exit(0);
