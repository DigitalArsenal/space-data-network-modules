#!/usr/bin/env node
// E2E (stack #487): the pool's own pattern of growth traps no thread. A pool thread that bulk-fills a block in pages it
// does not see traps (memory access out of bounds); the module's rule is that a threaded batch grows nothing, opens only
// after the calling thread has made its room and published the memory's size, and that a pool thread runs a chunk only
// once its own view covers that size (src/pool.inc). This runs the pattern that tests the rule, on a test build of the
// same sources that adds one export:
// - 4 pool threads, 4,096 SGP4 rows in the row store, 3,000 batches;
// - before each batch the calling thread grows the memory (the batch's reserve, 512 KiB, the blocks of the batch before
//   kept, so it always takes new pages), while the pool threads are parked;
// - in each batch every chunk (the pool threads' and the calling thread's) takes blocks from the heap's top, the new
//   pages, until its share is taken or a growth is refused, and fills (memory.fill) and copies within (memory.copy) each.
// 20 fresh processes, one at a time: every one completes its 3,000 batches, none takes the pool for dead, no thread
// traps. The engine behavior it guards against is measured, not read in the standard, so it runs on every landing.
// What it needs to be able to fail: an oversubscribed machine. The fault needs a pool thread descheduled between its
// claim and its fill, so on an idle machine the unfixed pool passed too (0 of 100). With SDN_AP_POOL_GROWTH_LOAD=1 the
// test loads the machine itself: busy threads in its own process, twice the cores, while the processes run, everything
// at the lowest priority (the processes inherit it). Under that load the unfixed pool (the chunk total stored before
// the room was made) trapped 18 of 20 processes of the same pattern. Without it (the default, so that a suite run does
// not load a shared machine) it can fail only when the machine is busy already.
//   SDN_AP_POOL_GROWTH_LOAD=1 node test/pool-growth.e2e.mjs
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { ensureBuilt, elementRows, THEORY } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";

const PROCESSES = 20, THREADS = 4, ROUNDS = 3000, RESERVE = 512 * 1024, ROWS = 4096, LIMIT_S = 120;

// A busy thread of the load: spins until its stop word is set.
const BUSY = `const { workerData } = require("node:worker_threads"); const stop = new Int32Array(workerData); let x = 0;
  while (Atomics.load(stop, 0) === 0) for (let k = 0; k < 1e6; ++k) x = (x * 1664525 + 1013904223) >>> 0;
  if (x === 0.5) console.log(x);`;

// One process: open the test build at argv[3], run the stress, print one line of counts.
if (process.argv[2] === "--one") {
  const h = await createStandaloneHarness("browser", process.argv[3], { surface: "direct", maxThreads: THREADS + 1, enableBrowserWasiThreads: true });
  const x = h.instance.exports;
  const mem = () => (h.memory ?? x.memory).buffer;
  const made = x.sdnap_threads(THREADS);
  const rows = Array.from({ length: ROWS }, (_, k) => ({ epochWhole: 2461328.5, epochFrac: 0, meanMotion: 15.2, ecc: 0.001, inc: 51.6,
    raan: (7.3 * k) % 360, argp: 0, ma: (11.9 * k) % 360, bstar: 1e-4, norad: k + 1, theory: THEORY.SGP4 }));
  const bytes = elementRows(rows);
  const p = x.sdnap_alloc(bytes.length);
  new Uint8Array(mem(), p, bytes.length).set(bytes);
  if (x.sdnap_init_elements(p, ROWS) !== ROWS) throw new Error("the row store refused the rows");
  const out = x.sdnap_alloc(128), ps = x.sdnap_alloc(112);
  x.sdnap_test_growth_stress(ROUNDS, RESERVE, out);
  x.sdnap_pool_stats(ps);
  const v = Array.from(new Float64Array(mem(), out, 12)), s = Array.from(new Float64Array(mem(), ps, 10));
  console.log(JSON.stringify({ threads: made, rounds: v[0], grew: v[1], poolChunks: v[2], poolBlocks: v[3], callerBlocks: v[4], dead: v[5],
    marked: v[6] < 0 ? null : { pool: v[6], block: v[7], bytes: v[8], pagesSeen: v[9], pagesNow: v[10] }, views: s[8], mostYields: s[9] }));
  process.exit(0);
}

ensureBuilt();
const testBuild = buildDiagnostic("pool-growth", String.raw`
#include <cstring>
namespace sdnap_test_growth {
static int32_t g_pool_chunks = 0, g_pool_blocks = 0, g_caller_blocks = 0, g_next_slot = 0;
static uint32_t g_share = 0;
static void* volatile g_sink = nullptr;
// a thread's block before its fill and copy, marked until both are done: a thread that trapped leaves its slot marked
struct Slot { int32_t mark, pool; uint32_t p, n, pages_seen; };
static Slot g_slots[32];
static thread_local int32_t t_slot = -1;
static void take(int32_t, bool pool_thread) {
  if (t_slot < 0) t_slot = __atomic_fetch_add(&g_next_slot, 1, __ATOMIC_SEQ_CST) & 31;
  Slot& s = g_slots[t_slot];
  s.pool = pool_thread ? 1 : 0;
  if (pool_thread) __atomic_add_fetch(&g_pool_chunks, 1, __ATOMIC_SEQ_CST);
  static const size_t kSizes[4] = {11248, 1376, 59664, 2560};
  uint32_t taken = 0;
  for (int32_t i = 0; taken < g_share; ++i) {
    const size_t n = kSizes[i & 3];
    char* p = static_cast<char*>(std::malloc(n));
    if (p == nullptr) return;  // a growth refused: the batch's room is taken
    s.p = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p));
    s.n = static_cast<uint32_t>(n);
    s.pages_seen = static_cast<uint32_t>(__builtin_wasm_memory_size(0));
    __atomic_store_n(&s.mark, 1, __ATOMIC_SEQ_CST);
    std::memset(p, i & 0xff, n);
    std::memcpy(p, p + 64, n - 64);
    __atomic_store_n(&s.mark, 0, __ATOMIC_SEQ_CST);
    g_sink = p;
    taken += static_cast<uint32_t>(n);
    __atomic_add_fetch(pool_thread ? &g_pool_blocks : &g_caller_blocks, 1, __ATOMIC_SEQ_CST);
  }
}
}  // namespace sdnap_test_growth
// 12 doubles: batches run, batches whose reserve grew the memory, chunks run by pool threads, blocks they took, blocks
// the calling thread took, batches that took the pool for dead; the first marked slot (-1: none): pool thread or not,
// the block, its size, the pages that thread saw before its fill, the pages now
SDNAP_EXPORT("sdnap_test_growth_stress")
int32_t sdnap_test_growth_stress(int32_t rounds, uint32_t reserve, double* out) {
  using namespace sdnap;
  const uint32_t count = store().count;
  pool::Job& j = pool::job();
  if (j.threads == 0 || count <= pool::kChunk || out == nullptr) return -1;
  double* minutes = static_cast<double*>(std::calloc(count, sizeof(double)));
  double* planes = static_cast<double*>(std::malloc(48u * count));
  int32_t* status = static_cast<int32_t*>(std::malloc(4u * count));
  sdnap_test_growth::g_share = reserve / ((count + pool::kChunk - 1) / pool::kChunk) + 16384;
  pool::g_chunk_hook = sdnap_test_growth::take;
  pool::dead_polls() = 1ull << 32;  // a trapped thread ends the process's run in seconds, not the default's minute
  int32_t grew = 0, dead = 0, r = 0;
  for (; r < rounds; ++r) {
    j.kind = pool::kJobMinutes; j.minutes = minutes; j.first = 0; j.count = count; j.frame = ORBPRO_FRAME_TEME;
    j.out = planes; j.status = status; j.deferred = nullptr;
    const uint32_t before = __builtin_wasm_memory_size(0);
    const int32_t rc = pool::run(count, reserve);
    if (__builtin_wasm_memory_size(0) > before) ++grew;
    if (rc != 0) { ++dead; break; }
  }
  pool::g_chunk_hook = nullptr;
  double v[12] = {double(r), double(grew), double(sdnap_test_growth::g_pool_chunks), double(sdnap_test_growth::g_pool_blocks),
                  double(sdnap_test_growth::g_caller_blocks), double(dead), -1, -1, -1, -1, -1, -1};
  for (const auto& s : sdnap_test_growth::g_slots)
    if (__atomic_load_n(&s.mark, __ATOMIC_SEQ_CST) != 0) {
      v[6] = s.pool; v[7] = s.p; v[8] = s.n; v[9] = s.pages_seen; v[10] = __builtin_wasm_memory_size(0);
      break;
    }
  for (int k = 0; k < 12; ++k) out[k] = v[k];
  return 0;
}`);

const self = fileURLToPath(import.meta.url);
// the load, when asked for: this process at the lowest priority (the processes below inherit it), then twice the cores
// in busy threads
const loaded = process.env.SDN_AP_POOL_GROWTH_LOAD === "1";
if (loaded) os.setPriority(19);
const stopWord = new SharedArrayBuffer(4), busy = [];
const LOAD = loaded ? 2 * os.availableParallelism() : 0;
for (let k = 0; k < LOAD; ++k) busy.push(new Worker(BUSY, { eval: true, workerData: stopWord }));
const failures = [];
let views = 0, mostYields = 0, poolBlocks = 0, grewAll = 0;
for (let run = 0; run < PROCESSES; ++run) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [self, "--one", testBuild], { timeout: LIMIT_S * 1000, killSignal: "SIGKILL", encoding: "utf8" });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const trapped = text.split("\n").find((l) => l.includes("trapped")) ?? "";
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("{"));
  const c = line ? JSON.parse(line) : null;
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (!c || trapped || c.rounds !== ROUNDS || c.dead !== 0 || c.threads !== THREADS) {
    failures.push(`process ${run} (${seconds} s, signal ${r.signal ?? "-"}): ${trapped || "no trap reported"}; ${line ?? text.slice(0, 300)}`);
    continue;
  }
  views += c.views; mostYields = Math.max(mostYields, c.mostYields);
  poolBlocks += c.poolBlocks; grewAll += c.grew;
}
Atomics.store(new Int32Array(stopWord), 0, 1);
await Promise.all(busy.map((w) => new Promise((resolve) => w.once("exit", resolve))));
const done = PROCESSES - failures.length;
console.log(`under ${LOAD} busy threads, ${done} of ${PROCESSES} processes: ${ROUNDS} batches each, ${grewAll} grown by their reserve, ${poolBlocks} blocks filled by pool threads in fresh pages; view waits ${views} (most yields ${mostYields})`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`POOL-GROWTH FAIL: ${failures.length} of ${PROCESSES} processes`);
  process.exit(1);
}
console.log("POOL-GROWTH PASS: the pool's own growth pattern trapped no thread");
process.exit(0);
