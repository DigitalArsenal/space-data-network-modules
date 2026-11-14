#!/usr/bin/env node
// E2E (the epoch store's threaded batch, SPEC 9 and 14.1.1): a set is never freed while another thread's cache reclaim
// still writes into it, and after a batch that ends with the pool dead the store's slots are not read again until the
// store is replaced.
// 1. Reclaim against release. 256 AP series at 500 km (tesseral 31, zonal 20, NRLMSISE-00 on made-up quiet rows), three
//    sets each, 12 hours apart, a 12-hour blend window, and two instants in turn at the switches between sets 0 and 1 and
//    between 1 and 2: every batch flies set 1 again and replaces a slot with set 0 or 2. The sets' cache budget is held to
//    1 MiB (cache_budget_mb), so a set asking for room again reclaims others' caches. 45 batches on the calling thread
//    alone, on 4 and on 15 pool threads. A test build of the same sources adds three seams:
//    - a reclaim on any thread, between dropping a set's caches and storing the unlock of its cache_lock, names the set
//      and spins;
//    - the epoch store, about to free a set it released, counts it when a reclaim names it: a set freed while that reclaim
//      still held it (the reclaim's unlock would then land in freed memory);
//    - the epoch store counts the slots it replaces.
//    Every batch: no mark seen; reclaims and slot replacements both happen within one batch (counted); every state and
//    status equal to the bit to the same batches on the calling thread alone.
// 2. A dead batch. The same store on 4 pool threads, the batch's dead-poll count lowered, one pool thread's first chunk
//    held for seconds (the calling thread goes on only once a pool thread holds it, so the hold is certain): the batch is
//    taken for dead (-20, every status 9). Then, while that thread is still in its chunk: sdnap_epochs_at answers -20
//    with status 9, sdnap_epochs_set_at and sdnap_drag_orbit_check 9, the store's bytes NaN; load_epochs and
//    load_epochs_open answer "pool-dead" (the open also with a configuration a fresh instance refuses otherwise), and the
//    store is still there (sdnap_epochs_count, the bytes still NaN, sdnap_epochs_at still -20); load_epochs_part and
//    load_epochs_close answer "load-not-open". Once it has left, load_epochs_open, one part and load_epochs_close install
//    the store, and then load_epochs replaces it: each time its states equal a fresh instance's to the bit.
// JS moves bytes and compares numbers the module produced.
//   node test/epoch-pool-safety.e2e.mjs [--dead-only]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { ensureBuilt } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";

ensureBuilt();
const SERIES = 256, ROUNDS = 45, DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const widePool = process.env.SDNAP_TEST_WIDE_POOL === "1";
const n500 = (Math.sqrt(MU / (RE + 500) ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 12 }, (_, k) => ({ DATE: iso(EPOCH + (k - 3) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4 })));
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const SNAPSHOT = Buffer.concat(Array.from({ length: SERIES }, (_, k) => [0, 1, 2].map((s) => prefixed(seedOcm({ epoch: iso(EPOCH + s * DAY / 2), n: widePool && k < 32 ? 2.26 + k * 1e-5 : n500,
  e: widePool && k < 32 ? 0.65 : 0.001, i: 40 + (k % 50), raan: (7.3 * k) % 360, argp: 90, ma: (11.1 * k + 30 * s) % 360, bterm: 0.004, agom: 0.01, norad: 70000 + k,
  msis: true, records: true, rows, tesseral: 31, zonal: 20 })))).flat());
// two instants in turn, at the switch between sets 0 and 1 and at the one between 1 and 2 (split Julian dates of June 15 2026
// 0h plus a fraction of a day): with a 12-hour blend window every batch flies set 1 again (a set asking for room again may
// reclaim others') and replaces a slot with set 2 or set 0
const W = 2461206.5, FRACTIONS = [0.25, 0.75];

const SEAMS = String.raw`
static uint32_t g_test_spin = 0, g_test_hooked = 0, g_test_hold_first = 0, g_test_held = 0;
static void test_reclaim_hook(sdnap::xpt::XpSat& v) {
  __atomic_add_fetch(&g_test_hooked, 1u, __ATOMIC_RELAXED);
  __atomic_store_n(&sdnap::xpt::g_test_reclaim_target, &v, __ATOMIC_SEQ_CST);
  for (volatile uint32_t i = 0; i < g_test_spin; i = i + 1) {}
  __atomic_store_n(&sdnap::xpt::g_test_reclaim_target, static_cast<sdnap::xpt::XpSat*>(nullptr), __ATOMIC_SEQ_CST);
}
static void test_chunk_hook(int32_t, bool pool_thread) {
  if (g_test_hold_first == 0) return;
  // the calling thread goes on only once a pool thread holds its first chunk: the hold is certain, whoever claims first
  if (!pool_thread) {
    while (__atomic_load_n(&g_test_held, __ATOMIC_SEQ_CST) == 0) {}
    return;
  }
  uint32_t expected = 0;
  if (!__atomic_compare_exchange_n(&g_test_held, &expected, 1u, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) return;
  for (volatile uint32_t i = 0; i < g_test_hold_first; i = i + 1) {}
  __atomic_store_n(&g_test_held, 2u, __ATOMIC_SEQ_CST);
}
SDNAP_EXPORT("sdnap_test_safety")
void sdnap_test_safety(uint32_t spin, uint32_t budget_mb, uint32_t hold, double polls, double* out) {
  sdnap::xpt::g_test_reclaim_hook = test_reclaim_hook;
  sdnap::pool::g_chunk_hook = test_chunk_hook;
  g_test_spin = spin;
  g_test_hold_first = hold;
  if (polls > 0) sdnap::pool::dead_polls() = static_cast<uint64_t>(polls);
  if (budget_mb > 0) sdnap::xpt::cache_budget_mb(budget_mb);
  out[0] = __atomic_load_n(&g_test_hooked, __ATOMIC_RELAXED);
  out[1] = __atomic_load_n(&sdnap::xpt::g_test_late, __ATOMIC_RELAXED);
  out[2] = __atomic_load_n(&sdnap::epochs::g_test_replaced, __ATOMIC_RELAXED);
  out[3] = __atomic_load_n(&g_test_held, __ATOMIC_SEQ_CST);
  out[4] = sdnap::pool::load(&sdnap::pool::job().active);
}`;
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `the seam's anchor ${JSON.stringify(from)} is not unique`); return text.replace(from, to); };
const testBuild = buildDiagnostic(widePool ? "wide-pool-safety" : "epoch-pool-safety", SEAMS,
  (t) => once(once(t, "inline bool pool_reclaim_locked(",
    "inline void (*g_test_reclaim_hook)(XpSat&) = nullptr;\ninline XpSat* g_test_reclaim_target = nullptr;\ninline uint32_t g_test_late = 0;\ninline bool pool_reclaim_locked("),
    "    p.reclaimed += 1;\n", "    p.reclaimed += 1;\n    if (g_test_reclaim_hook != nullptr) g_test_reclaim_hook(*v);\n"),
  { "epoch_store.inc": (t) => once(once(once(t, "inline void release(Slot& s) {", "inline uint32_t g_test_replaced = 0;\ninline void release(Slot& s) {"),
      "  std::free(s.xp);\n",
      "  if (s.xp != nullptr && __atomic_load_n(&xpt::g_test_reclaim_target, __ATOMIC_SEQ_CST) == s.xp) __atomic_add_fetch(&xpt::g_test_late, 1u, __ATOMIC_SEQ_CST);\n  std::free(s.xp);\n"),
    "  s.next = s.slots.second ? s.next ^ 1u : 0u;\n  release(q);\n",
    "  s.next = s.slots.second ? s.next ^ 1u : 0u;\n  if (q.index >= 0) __atomic_add_fetch(&g_test_replaced, 1u, __ATOMIC_RELAXED);\n  release(q);\n") });

async function open(threads) {
  const h = await createStandaloneHarness("browser", testBuild, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const out = x.sdnap_alloc(48 * SERIES), status = x.sdnap_alloc(4 * SERIES), probe = x.sdnap_alloc(48);
  const mem = () => (h.memory ?? x.memory).buffer;
  const seams = (spin, budget, hold = 0, polls = 0) => { x.sdnap_test_safety(spin, budget, hold, polls, probe); const v = new Float64Array(mem(), probe, 5); return { hooked: v[0], late: v[1], replaced: v[2], held: v[3], active: v[4] }; };
  const cfg = (store = { BLEND_WINDOW_SECONDS: 43200 }) => configuration({ epochStore: store });
  const load = () => h.invoke({ methodId: "load_epochs", inputs: [cfg(),{ portId: "ocm", typeRef: T("OCM"), payload: SNAPSHOT }] });
  // the three-call load (SPEC 14.1.1): the open (its configuration given), the whole snapshot as one part, the close
  const openLoad = (config = cfg()) => h.invoke({ methodId: "load_epochs_open", inputs: [config] });
  const part = () => h.invoke({ methodId: "load_epochs_part", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: SNAPSHOT }] });
  const close = () => h.invoke({ methodId: "load_epochs_close", inputs: [] });
  const buffer = x.sdnap_alloc(96);
  const storeBytes = () => { x.sdnap_epochs_stats(buffer); return new Float64Array(mem(), buffer, 8)[7]; };
  const at = (f) => {
    const rc = x.sdnap_epochs_at(W, f, 0, SERIES, 0, out, status, 0);
    return { rc, bytes: Buffer.concat([Buffer.from(new Uint8Array(mem(), out, 48 * SERIES)), Buffer.from(new Uint8Array(mem(), status, 4 * SERIES))]) };
  };
  return { x, mem, buffer, seams, cfg, load, openLoad, part, close, storeBytes, at, setAt: (i, k, f) => x.sdnap_epochs_set_at(i, k, W, f, probe) };
}

// 1. reclaim against release (--dead-only: only 2)
const runs = {};
for (const threads of process.argv.includes("--dead-only") ? [] : [0, 4, 15]) {
  const m = await open(threads);
  assert.equal((await m.load()).statusCode, 0, "load_epochs");
  m.seams(threads ? 20000 : 0, 1);
  const digest = createHash("sha256");
  let both = 0, reclaims = 0, replaced = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const before = m.seams(threads ? 20000 : 0, 0);
    const { rc, bytes } = m.at(FRACTIONS[r % 2]);
    assert.equal(rc, 0, `${threads} threads, batch ${r}: ${rc}`);
    const after = m.seams(threads ? 20000 : 0, 0);
    assert.equal(after.late, 0, `${threads} threads, batch ${r}: a set was freed while a reclaim on another thread still held it (${after.late} seen)`);
    if (after.hooked > before.hooked && after.replaced > before.replaced) both += 1;
    reclaims += after.hooked - before.hooked;
    replaced += after.replaced - before.replaced;
    digest.update(bytes);
  }
  runs[threads] = digest.digest("hex");
  if (threads) assert.ok(both >= 10, `${threads} threads: reclaims and slot replacements in one batch in only ${both} of ${ROUNDS} batches`);
  console.log(`${threads} pool threads: ${ROUNDS} batches, ${reclaims} reclaims and ${replaced} slot replacements, both in ${both} batches; no set freed under a reclaim; digest ${runs[threads].slice(0, 16)}`);
}
if (!process.argv.includes("--dead-only")) {
  assert.equal(runs[4], runs[0], "4 pool threads against the calling thread alone");
  assert.equal(runs[15], runs[0], "15 pool threads against the calling thread alone");
}

// 2. a dead batch
const fresh = await open(0);
// a configuration the open refuses for itself (CACHE_DAYS below 0), on an instance whose pool is not dead: not pool-dead
const BAD = { CACHE_DAYS: -1 };
const badOpen = await fresh.openLoad(fresh.cfg(BAD));
assert.ok(badOpen.statusCode !== 0 && badOpen.errorCode !== "pool-dead", `the bad configuration on a fresh instance: ${badOpen.statusCode} ${badOpen.errorCode}`);
assert.equal((await fresh.load()).statusCode, 0, "load_epochs (fresh)");
const reference = fresh.at(FRACTIONS[0]);
const m = await open(4);
assert.equal((await m.load()).statusCode, 0, "load_epochs");
m.seams(0, 0, 3_000_000_000, 2e6);
const dead = m.at(FRACTIONS[0]);
assert.equal(dead.rc, -20, `the held batch: ${dead.rc}, not taken for dead`);
const statuses = (b) => Array.from(new Int32Array(b.buffer.slice(b.byteOffset + 48 * SERIES, b.byteOffset + 52 * SERIES)));
assert.ok(statuses(dead.bytes).every((s) => s === 9), "the dead batch's statuses");
const after = m.at(FRACTIONS[1]);
assert.equal(after.rc, -20, `a call after the dead batch: ${after.rc}, the store read again`);
assert.ok(statuses(after.bytes).every((s) => s === 9), "a call after the dead batch: every status 9");
assert.equal(m.setAt(0, 0, FRACTIONS[1]), 9, "sdnap_epochs_set_at after the dead batch");
assert.equal(m.x.sdnap_drag_orbit_check(0, 60, 16, m.buffer), 9, "sdnap_drag_orbit_check after the dead batch");
assert.ok(Number.isNaN(m.storeBytes()), "the store's bytes after the dead batch read NaN");
const early = m.seams(0, 0);
assert.equal(early.held, 1, "the held thread is still in its chunk");
const poolDead = (r, what) => assert.ok(r.statusCode !== 0 && r.errorCode === "pool-dead", `${what} while the held thread is in its chunk: ${r.statusCode} ${r.errorCode}`);
const notOpen = (r, what) => assert.ok(r.statusCode !== 0 && r.errorCode === "load-not-open", `${what} while the held thread is in its chunk: ${r.statusCode} ${r.errorCode}`);
poolDead(await m.load(), "load_epochs");
poolDead(await m.openLoad(), "load_epochs_open");
poolDead(await m.openLoad(m.cfg(BAD)), "load_epochs_open with a bad configuration");
// the refused opens freed nothing: the store is still there, its slots still refused
assert.equal(m.x.sdnap_epochs_count(), SERIES, "the store's series after the refused opens");
assert.ok(Number.isNaN(m.storeBytes()), "the store's bytes after the refused opens read NaN");
const stillDead = m.at(FRACTIONS[1]);
assert.ok(stillDead.rc === -20 && statuses(stillDead.bytes).every((s) => s === 9), `a call after the refused opens: ${stillDead.rc}`);
// no load is open: a part and a close are refused as with none
notOpen(await m.part(), "load_epochs_part");
notOpen(await m.close(), "load_epochs_close");
assert.equal(m.x.sdnap_epochs_count(), SERIES, "the store's series after the refused part and close");
const late = m.seams(0, 0);
assert.ok(late.held === 1 && late.active !== 0, `the held thread left its chunk before the refusals were checked (held ${late.held}, active ${late.active})`);
let waited = 0;
while (m.seams(0, 0).active !== 0) { await new Promise((r) => setTimeout(r, 250)); waited += 0.25; assert.ok(waited < 600, "the held thread never left its chunk"); }
// once no pool thread is active: the three-call load installs the store, then load_epochs replaces it; both fly as a
// fresh instance's store (on the calling thread: the pool is dead)
for (const [methodId, r] of [["load_epochs_open", await m.openLoad()], ["load_epochs_part", await m.part()], ["load_epochs_close", await m.close()]])
  assert.equal(r.statusCode, 0, `${methodId} once no pool thread is active: ${r.errorCode} ${r.errorMessage}`);
assert.equal(m.x.sdnap_epochs_count(), SERIES, "the store loaded in parts");
const parts = m.at(FRACTIONS[0]);
assert.equal(parts.rc, 0, "the store loaded in parts: its call");
assert.ok(parts.bytes.equals(reference.bytes), "the store loaded in parts: its states and statuses against a fresh instance's");
const reloaded = await m.load();
assert.equal(reloaded.statusCode, 0, `load_epochs once no pool thread is active: ${reloaded.errorCode} ${reloaded.errorMessage}`);
const again = m.at(FRACTIONS[0]);
assert.equal(again.rc, 0, "the reloaded store's call (on the calling thread: the pool is dead)");
assert.ok(again.bytes.equals(reference.bytes), "the reloaded store's states and statuses against a fresh instance's");
console.log(`dead batch: -20 and status 9; then the store refused (-20, status 9; set_at 9; bytes NaN; load_epochs and load_epochs_open pool-dead, ` +
  `the store kept; part and close load-not-open) while the held thread ran; after ${waited} s loaded in parts, then by load_epochs: a fresh instance's bytes`);
console.log("EPOCH-POOL-SAFETY PASS");
process.exit(0);
