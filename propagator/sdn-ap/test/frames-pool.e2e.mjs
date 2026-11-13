#!/usr/bin/env node
// Synthetic UTC records, TEME km and km/s. Thread and slicing comparisons require identical
// cell bytes and IEEE state bits; numerical bounds are independently checked by frames.e2e.mjs.
// Failure seams select an object before its counted allocation, independent of scheduling.
import assert from "node:assert/strict";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { openFrames, population, EPOCH_MS, DAY, STAT } from "./lib/frame-cells.mjs";

process.env.SDM_MODULE_UNSIGNED_BUILD = "1";
delete process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH;
const once = (s, a, b) => { assert.equal(s.split(a).length, 2, a); return s.replace(a, b); };
const probe = String.raw`
static uint32_t test_index = UINT32_MAX, test_mode = 0;
static uint32_t test_hold = 0, test_held = 0;
static void test_attempt(uint32_t i, bool pooled) {
  sdnap::mem::test_failure = i == test_index && (pooled || test_mode == 2) ? test_mode : 0;
}
static void test_chunk(int32_t, bool pooled) {
  if (test_hold == 0) return;
  if (!pooled) { while (__atomic_load_n(&test_held, __ATOMIC_SEQ_CST) == 0) {} return; }
  uint32_t expected = 0;
  if (!__atomic_compare_exchange_n(&test_held, &expected, 1u, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) return;
  if (test_hold == 2) __builtin_trap();
  while (__atomic_load_n(&test_hold, __ATOMIC_SEQ_CST) != 0) {}
  __atomic_store_n(&test_held, 2u, __ATOMIC_SEQ_CST);
}
SDNAP_EXPORT("test_config") void test_config(uint32_t i, uint32_t mode, uint32_t reserves, uint32_t staging) {
  test_index = i; test_mode = mode;
  sdnap::pool::test_reserve_fail = reserves;
  sdnap::frames::test_staging_fail = staging;
  sdnap::frames::g_attempt_hook = test_attempt;
}
SDNAP_EXPORT("test_hold") void test_hold_set(uint32_t mode) {
  __atomic_store_n(&test_hold, mode, __ATOMIC_SEQ_CST);
  sdnap::pool::g_chunk_hook = test_chunk;
  sdnap::pool::dead_polls() = 100000;
}
SDNAP_EXPORT("test_active") int32_t test_active() { return sdnap::pool::load(&sdnap::pool::job().active); }
SDNAP_EXPORT("test_reserves") uint32_t test_reserves() { return sdnap::pool::test_reserve_calls; }
SDNAP_EXPORT("test_batch_rows") uint32_t test_batch_rows() { return sdnap::frames::g_batch ? sdnap::frames::g_batch->count : 0; }
SDNAP_EXPORT("test_cell") uint32_t test_cell(uint32_t i, uint32_t slot) {
  const auto& s = sdnap::frames::state();
  if (i >= s.objects) return 0;
  return reinterpret_cast<uintptr_t>(sdnap::frames::cell_at(s, slot ? s.obj[i].nxt : s.obj[i].cur));
}
SDNAP_EXPORT("test_cell_size") uint32_t test_cell_size(uint32_t p) {
  const auto* c = reinterpret_cast<const uint8_t*>(p);
  return sdnap::frames::bytes_of_cell(c[16], c[17], c[18], c[19]);
}
SDNAP_EXPORT("test_staging_bytes") uint32_t test_staging_bytes() { return sizeof(sdnap::frames::Batch); }
SDNAP_EXPORT("test_init") void test_init(uint32_t i) { sdnap::frames::test_init_refuse = i; }
SDNAP_EXPORT("test_warm") uint32_t test_warm(uint32_t site) {
  sdnap::pool::test_warm_site = site;
  return __atomic_load_n(&sdnap::pool::test_warm_max, __ATOMIC_RELAXED);
}
`;
const wasm = process.env.FRAMES_POOL_DIAGNOSTIC ?? buildDiagnostic("frames-pool", probe, s => s, {
  "constants.inc": s => once(once(once(once(s, "inline uint32_t g_failures = 0;", "inline uint32_t g_failures = 0;\ninline thread_local uint32_t test_failure = 0, test_warm_count = 0, test_warm_at = 0;\ninline thread_local bool test_warming = false;\ninline bool test_warm_refuse() { return test_warming && ++test_warm_count == test_warm_at; }"),
    "inline void* calloc(size_t k, size_t n) {\n  void* p = std::calloc(k, n);",
    "inline void* calloc(size_t k, size_t n) {\n  if (test_failure || test_warm_refuse()) { note_failure(k * n); return nullptr; }\n  void* p = std::calloc(k, n);"),
    "inline void* malloc(size_t n) {\n  void* p = std::malloc(n);",
    "inline void* malloc(size_t n) {\n  if (test_warm_refuse()) { note_failure(n); return nullptr; }\n  void* p = std::malloc(n);"),
    "inline T* counted(T* p, size_t n = sizeof(T)) {\n  if (p == nullptr) note_failure(n);",
    "inline T* counted(T* p, size_t n = sizeof(T)) {\n  if (p != nullptr && test_warm_refuse()) { if (n == sizeof(T)) { p->~T(); ::operator delete(p); } else ::operator delete[](p); p = nullptr; }\n  if (p == nullptr) note_failure(n);"),
  "frames.inc": s => once(once(once(once(s, "inline Batch* g_batch = nullptr;", "inline Batch* g_batch = nullptr;\ninline uint32_t test_staging_fail = 0, test_init_refuse = UINT32_MAX;"),
    "void* memory = std::malloc(sizeof(Batch));", "void* memory = test_staging_fail ? nullptr : std::malloc(sizeof(Batch));"),
    "if (g_attempt_hook != nullptr) g_attempt_hook(i, xpt::batch_running());",
    "if (g_attempt_hook != nullptr) g_attempt_hook(i, xpt::batch_running());\n  if (mem::test_failure == 1 && ::sbrk(1u << 30) != reinterpret_cast<void*>(-1)) std::abort();"),
    "err = xp == nullptr ? kPropRefused : xpt::xp_init(e, *xp);", "err = i == test_init_refuse ? kPropRefused : (xp == nullptr ? kPropRefused : xpt::xp_init(e, *xp));"),
  "pool.inc": s => once(once(once(once(s, "inline bool reserve_room(size_t bytes) {",
    "inline uint32_t test_reserve_fail = 0, test_reserve_calls = 0;\ninline bool reserve_room(size_t bytes) {\n  ++test_reserve_calls;\n  if (test_reserve_fail) { --test_reserve_fail; return false; }"),
    "inline bool warm_thread() {", "inline uint32_t test_warm_site = 0, test_warm_max = 0;\ninline bool warm_thread() {"),
    "  if (g_warm) return true;", "  if (g_warm) return true;\n  mem::test_warming = true; mem::test_warm_count = 0; mem::test_warm_at = test_warm_site;"),
    "  return g_warm;", "  mem::test_warming = false;\n  uint32_t old = __atomic_load_n(&test_warm_max, __ATOMIC_RELAXED);\n  while (old < mem::test_warm_count && !__atomic_compare_exchange_n(&test_warm_max, &old, mem::test_warm_count, false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {}\n  return g_warm;")
});
const pop = population([["leo500", 34], ["hp490", 2], ["ecc05", 2], ["geo", 2], ["underground", 2], ["wide", 2]], 20261113, 48);
const open = async threads => { const f = await openFrames({ wasm, threads }); await f.load(pop); return f; };
const cells = f => {
  const all = [];
  for (let i = 0; i < f.count; ++i) for (let slot = 0; slot < 2; ++slot) {
    const p = f.x.test_cell(i, slot);
    if (!p) { all.push(null); continue; }
    const b = Buffer.from(new Uint8Array(f.mem(), p, f.x.test_cell_size(p)));
    b.fill(0, 20, 24); all.push(b);
  }
  return all;
};
const equal = (a, b, t) => {
  assert.deepEqual(b.stats(), a.stats(), "logical counters");
  assert.deepEqual(cells(b), cells(a), "canonical cells");
  for (const dt of [0, 30000, 2880000]) assert.deepEqual(b.at(t + dt), a.at(t + dt), "frame bits");
};
let compared = 0;
const warmOnly = process.argv.includes("--warm-only");
const initOnly = process.argv.includes("--init-only");
const deadOnly = process.argv.includes("--dead-only") || warmOnly || initOnly;
const refusalOnly = process.argv.includes("--refusal-only") || warmOnly || initOnly;
for (const threads of deadOnly || refusalOnly ? [] : [4, 15]) {
  const a = await open(0), b = await open(threads);
  for (const flags of [0, 1]) for (const budget of [20000, 2e6]) {
    assert.equal(a.open(budget, flags), 0); assert.equal(b.open(budget, flags), 0);
    for (const day of [-1, 0, 2]) {
      const t = EPOCH_MS + day * DAY + 37000;
      for (const max of [1, 31, 32, 33, 8, 5000]) {
        const priorities = [1, 1, 3, 0xffffffff, 0, 0];
        assert.deepEqual(b.refill(t, 2880, max, priorities), a.refill(t, 2880, max, priorities));
        equal(a, b, t); ++compared;
      }
    }
  }
  assert.ok(b.poolStats()[14] > 0 && b.poolStats()[15] > 0, "pool threads completed rows");
  assert.equal(b.poolStats()[4], 0, "no memory growth in a batch");
  await a.h.destroy(); await b.h.destroy();
}
if (!deadOnly && !refusalOnly) console.log(`ordered calls: ${compared}, equal cells, counters, results and frame bits at 0/4/15 threads`);

for (const threads of deadOnly || refusalOnly ? [] : [0, 4, 15]) {
  const a = await open(threads), b = await open(threads), t = EPOCH_MS + DAY;
  a.open(2e6); b.open(2e6);
  assert.equal(a.fill(t, 2880, 8).due, 0); assert.equal(b.fill(t, 2880, 5000).due, 0);
  equal(a, b, t);
  await a.h.destroy(); await b.h.destroy();
}
if (!deadOnly && !refusalOnly) console.log("two slicings: identical cells, states and accumulated counters");

for (const mode of deadOnly ? [] : [1, 2]) {
  const a = await open(0), b = await open(4), t = EPOCH_MS + DAY;
  a.open(2e6); b.open(2e6);
  if (mode === 2) a.x.test_config(3, mode, 0, 0);
  b.x.test_config(3, mode, 0, 0);
  const before = b.poolStats();
  assert.deepEqual(b.refill(t, 2880, 32), a.refill(t, 2880, 32));
  equal(a, b, t);
  if (mode === 1) {
    assert.ok(b.poolStats()[2] > before[2], "sbrk growth was refused inside the batch");
    assert.ok(b.poolStats()[3] > before[3], "refused row retried");
  }
  else { assert.equal(b.stats()[STAT.rowsOom], 1); assert.equal(b.stats()[STAT.rows], 4, "speculative suffix uncommitted"); }
  await a.h.destroy(); await b.h.destroy();
}
for (const [reserves, staging] of deadOnly ? [] : [[2, 0], [99, 0], [0, 1]]) {
  const a = await open(0), b = await open(4), t = EPOCH_MS + DAY;
  a.open(2e6); b.open(2e6); b.x.test_config(0xffffffff, 0, reserves, staging);
  assert.deepEqual(b.refill(t, 0, 32), a.refill(t, 0, 32)); equal(a, b, t);
  if (reserves) assert.ok(b.x.test_reserves() >= 3, "reserve retry exercised");
  if (staging) assert.equal(b.x.test_batch_rows(), 0, "staging refusal uses serial path");
  await a.h.destroy(); await b.h.destroy();
}
if (!deadOnly) console.log("deferred growth refusal, counted OOM, reserve halving and serial fallbacks: pass");

for (const mode of refusalOnly ? [] : [1, 2]) {
  const f = await open(4), t = EPOCH_MS + DAY;
  f.open(2e6); assert.equal(f.refill(t, 2880, 1).stored, 1);
  const old = { stats: f.stats(), cells: cells(f), frame: f.at(t) };
  f.x.test_hold(mode);
  const r = f.refill(t, 2880, 32);
  assert.equal(r.rc, -20); assert.equal(r.stored, 0); assert.equal(r.tombstones, 0);
  assert.deepEqual(f.stats(), old.stats); assert.deepEqual(cells(f), old.cells);
  assert.equal(f.open(2e6), -20); assert.equal(f.refill(t, 2880, 32).rc, -20);
  f.close(); assert.deepEqual(f.at(t), old.frame);
  assert.equal(f.x.sdnap_propagate_soa(0, 0, 0, 0, 0, 0, 0), -20, "descriptor reuse refused");
  const load = await f.h.invoke({ methodId: "load_epochs_open", inputs: [] });
  assert.equal(load.errorCode, "pool-dead");
  if (mode === 1) {
    f.x.test_hold(0);
    for (let k = 0; f.x.test_active() !== 0; ++k) {
      assert.ok(k < 1000, "late claim finishes"); await new Promise(r => setTimeout(r, 10));
    }
    assert.deepEqual(f.stats(), old.stats); assert.deepEqual(cells(f), old.cells); assert.deepEqual(f.at(t), old.frame);
    assert.equal(f.open(2e6), -20, "quarantine remains after late completion");
    assert.equal((await f.h.invoke({ methodId: "load_epochs_open", inputs: [] })).errorCode, "pool-dead");
  }
  await f.h.destroy();
}
if (!refusalOnly) console.log("delayed and trapped pool claims: quarantine and stable committed reads pass");
if (warmOnly || (!deadOnly && !refusalOnly)) {
  const reference = await open(0), t = EPOCH_MS + DAY;
  reference.open(2e6); const wanted = reference.refill(t, 2880, 32);
  const probe = await openFrames({ wasm });
  assert.equal(probe.x.sdnap_threads(4), 4);
  const sites = probe.x.test_warm(0); assert.equal(sites, 8, "counted startup allocations");
  await probe.h.destroy();
  for (let site = 1; site <= sites; ++site) {
    const f = await openFrames({ wasm });
    f.x.test_warm(site); assert.equal(f.x.sdnap_threads(4), 4); f.x.test_warm(0);
    await f.load(pop); f.open(2e6);
    assert.deepEqual(f.refill(t, 2880, 32), wanted); equal(reference, f, t);
    assert.equal(f.poolStats()[4], 0); await f.h.destroy();
  }
  console.log(`startup cache failures: ${sites} counted sites on each of four pool threads, exact recovered cells and counters`);
  console.log(`bounded staging: ${reference.x.test_staging_bytes()} bytes`);
  await reference.h.destroy();
}
if (initOnly || (!deadOnly && !refusalOnly)) {
  for (const threads of [4, 15]) {
    const a = await open(0), b = await open(threads), t = EPOCH_MS + DAY;
    a.open(2e6); b.open(2e6); a.x.test_init(3); b.x.test_init(3);
    assert.deepEqual(b.fill(t, 2880, 32, [3, 3, 0]), a.fill(t, 2880, 32, [3, 3, 0]));
    equal(a, b, t); assert.equal(b.at(t).status[3], 3);
    assert.equal(b.stats()[STAT.rowsOom], 0);
    await a.h.destroy(); await b.h.destroy();
  }
  console.log("initialization refusals: equal serial and 4/15-thread results with repeated priorities");
}
console.log("FRAMES-POOL PASS");
