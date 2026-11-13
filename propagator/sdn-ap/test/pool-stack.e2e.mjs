#!/usr/bin/env node
// E2E (SPEC 1.6, SPEC 9): the pool threads' stacks. The epoch store's threaded call builds sets on pool threads: a lane runs
// slot_of, xp_init, ap_init and every table build (one frame alone, the half-day terms', is 25,936 bytes), the decay
// probe with drag and NRLMSISE-00, and the flight. A test build of this checkout paints each pool thread's stack with a
// pattern when the thread starts, and after the call reads how deep each thread wrote (the high-water). The store: every
// class AP builds, each on several series, so every lane builds every kind:
// - low orbit at 500 km and at 290 km (NRLMSISE-00 under 325 km), tesseral 31 / zonal 20 and 70 with the slow set;
// - the half-day class (a 12-hour orbit) and the one-day class (geostationary), at 31 and at 70 with the slow set;
// - an eccentric orbit under the wide branch's switch (e 0.2), at 31 and 70;
// - a decaying set (a 150 km perigee and a large BTERM: its flight ends decayed);
// - SGP4XP without AP's terms.
// Asserted: every thread's high-water at most half its stack (a factor of two of margin), every series answered or decayed
// as the serial pass answers it, and the thread-local block (__builtin_wasm_tls_size) with the stack inside the room
// start makes for a thread.
//   node test/pool-stack.e2e.mjs
import assert from "node:assert/strict";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { ensureBuilt } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";

ensureBuilt();
const DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: F107DataType.OBS })));
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `the seam's anchor ${JSON.stringify(from)} is not unique`); return text.replace(from, to); };

const extra = String.raw`
#include <pthread.h>
struct StackSpan { uintptr_t lo, hi; };
static StackSpan g_stack_spans[32];
static int32_t g_stack_span_n = 0;
// the pattern from the stack's floor to just under the painting frame
void sdnap_test_paint_stack() {
  pthread_attr_t a;
  void* addr = nullptr;
  size_t size = 0;
  if (pthread_getattr_np(pthread_self(), &a) != 0) return;
  pthread_attr_getstack(&a, &addr, &size);
  pthread_attr_destroy(&a);
  volatile uint8_t marker[16];
  marker[0] = 1;
  const uintptr_t lo = reinterpret_cast<uintptr_t>(addr), here = reinterpret_cast<uintptr_t>(&marker[0]);
  for (uintptr_t q = lo; q + 256 < here; ++q) *reinterpret_cast<volatile uint8_t*>(q) = 0xA5;
  const int32_t i = __atomic_fetch_add(&g_stack_span_n, 1, __ATOMIC_SEQ_CST);
  if (i < 32) g_stack_spans[i] = StackSpan{lo, lo + size};
}
// per painted thread: its stack's size and the bytes written from its top down to the deepest byte not the pattern
SDNAP_EXPORT("sdnap_test_stack_depths")
int32_t sdnap_test_stack_depths(double* out) {
  const int32_t n = g_stack_span_n < 32 ? g_stack_span_n : 32;
  for (int32_t i = 0; i < n; ++i) {
    uintptr_t q = g_stack_spans[i].lo;
    while (q < g_stack_spans[i].hi && *reinterpret_cast<volatile uint8_t*>(q) == 0xA5) ++q;
    out[2 * i] = static_cast<double>(g_stack_spans[i].hi - g_stack_spans[i].lo);
    out[2 * i + 1] = static_cast<double>(g_stack_spans[i].hi - q);
  }
  return n;
}
SDNAP_EXPORT("sdnap_test_tls_size")
uint32_t sdnap_test_tls_size() { return static_cast<uint32_t>(__builtin_wasm_tls_size()); }
SDNAP_EXPORT("sdnap_test_thread_room")
uint32_t sdnap_test_thread_room() { return static_cast<uint32_t>(sdnap::pool::kThreadRoom); }
`;
const probe = buildDiagnostic("pool-stack", extra, (s) => s, {
  "pool.inc": (t) => once("void sdnap_test_paint_stack();\n" + t, "  g_pool_thread = true;\n", "  g_pool_thread = true;\n  sdnap_test_paint_stack();\n"),
});

// the store: each kind on COPIES series
const COPIES = 12;
const kinds = [];
const ap = (name, o) => kinds.push({ name, make: (k, norad) => seedOcm({ epoch: iso(EPOCH), argp: 90, raan: (37 * k) % 360, ma: (53 * k) % 360, norad, msis: true, records: true, rows, bterm: 0.001, agom: 0.01, ...o }) });
for (const [deg, slow] of [[[31, 20], false], [[70, 20], true]]) {
  const [tesseral, zonal] = deg, tag = `${tesseral}${slow ? " slow" : ""}`;
  ap(`500 km ${tag}`, { n: revPerDay(RE + 500), e: 0.001, i: 97.4, tesseral, zonal, slow });
  ap(`290 km ${tag}`, { n: revPerDay(RE + 290), e: 0.001, i: 51.6, tesseral, zonal, slow });
  ap(`half-day ${tag}`, { n: 2.0056, e: 0.005, i: 55, tesseral, zonal, slow });
  ap(`one-day ${tag}`, { n: 1.0027, e: 0.0002, i: 0.05, tesseral, zonal, slow });
  ap(`e 0.2 ${tag}`, { n: revPerDay((RE + 800) / 0.8), e: 0.2, i: 63.4, tesseral, zonal, slow });
}
ap("decaying 150 km", { n: revPerDay(RE + 150), e: 0.001, i: 51.6, bterm: 0.05, tesseral: 31, zonal: 20 });
kinds.push({ name: "SGP4XP", make: (k, norad) => seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 700), e: 0.001, i: 98, raan: (37 * k) % 360, argp: 90, ma: (53 * k) % 360, bterm: 0.002, norad }) });
const records = [], names = [];
for (let c = 0; c < COPIES; c++) for (const [q, kind] of kinds.entries()) { records.push(prefixed(kind.make(c, 70000 + 100 * q + c))); names.push(kind.name); }
const N = records.length, snapshot = Buffer.concat(records);
const [W, F] = (() => { const d = (EPOCH + DAY) / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; })();

async function fly(threads) {
  const h = await createStandaloneHarness("browser", probe, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const load = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: snapshot }] });
  assert.equal(load.statusCode, 0, `load_epochs: ${load.errorCode} ${load.errorMessage}`);
  const out = x.sdnap_alloc(48 * N), status = x.sdnap_alloc(4 * N), ps = x.sdnap_alloc(112), depths = x.sdnap_alloc(16 * 32);
  assert.equal(x.sdnap_epochs_at(W, F, 0, N, 0, out, status, 0), 0, "sdnap_epochs_at");
  x.sdnap_pool_stats(ps);
  const pool = Array.from(new Float64Array(h.memory.buffer, ps, 14));
  const n = x.sdnap_test_stack_depths(depths);
  const d = Array.from(new Float64Array(h.memory.buffer, depths, 2 * n));
  return { states: Buffer.from(new Uint8Array(h.memory.buffer, out, 48 * N)), codes: Array.from(new Int32Array(h.memory.buffer, status, N)), pool,
    stacks: Array.from({ length: n }, (_, i) => ({ size: d[2 * i], used: d[2 * i + 1] })), tls: x.sdnap_test_tls_size(), room: x.sdnap_test_thread_room() };
}
const serial = await fly(0), pooled = await fly(4);
assert.ok(pooled.pool[1] > 0 && pooled.pool[3] === 0, `a threaded batch ran (${pooled.pool[1]}) and deferred nothing (${pooled.pool[3]})`);
assert.deepEqual(pooled.codes, serial.codes, "every series' status as the serial pass gives it");
assert.ok(pooled.states.equals(serial.states), "the states as the serial pass gives them");
const answered = serial.codes.filter((c) => c === 0).length;
assert.ok(answered >= N - COPIES, `${answered} of ${N} series answered (only the decaying ones may not be)`);
assert.equal(pooled.stacks.length, 4, `${pooled.stacks.length} pool threads painted`);
const deepest = Math.max(...pooled.stacks.map((s) => s.used)), size = pooled.stacks[0].size;
for (const s of pooled.stacks) assert.ok(s.used > 0 && s.used * 2 <= s.size, `a pool thread wrote ${s.used} of its ${s.size}-byte stack: under a factor of two of margin`);
assert.ok(size + pooled.tls <= pooled.room, `the stack (${size}) and the thread-local block (${pooled.tls}) outgrow the room a thread is given (${pooled.room})`);
console.log(`${N} series (${kinds.length} kinds x ${COPIES}), 4 pool threads: deepest stack ${deepest} of ${size} bytes (${pooled.stacks.map((s) => s.used).join(", ")}); ` +
  `thread-local block ${pooled.tls} bytes; room per thread ${pooled.room}; ${answered} answered, codes ${[...new Set(serial.codes)].join(",")}`);
console.log("POOL-STACK PASS");
process.exit(0);
