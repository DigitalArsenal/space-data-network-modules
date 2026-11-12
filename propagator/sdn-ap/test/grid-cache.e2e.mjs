#!/usr/bin/env node
// E2E (stack #497; SPEC 1.6 and 16.11): the first-order tesseral grids' cache and the module's memory.
// The states: five AP sets above the eccentricity switch (class 0 at e 0.4, the half-day class at e 0.74, the one-day class at
// e 0.82, the long-period regime at e 0.9, and a copy of the first under another catalog number: one grid key, two sets),
// 120 times over three days, in the epoch store (load_epochs, sdnap_epochs_set_at):
// - a cold cache, set by set in time order: the reference, every component of every state a number;
// - the same instance again (a warm cache), all 600 (set, time) pairs shuffled: bit for bit;
// - a fresh instance at a 1-byte bound (sdnap_wide_grid_budget): the sets loaded one at a time, time-major, so every grid is
//   built again at each load: bit for bit, and no idle grid kept;
// - the default bound keeps idle grids (512 MiB).
// The bytes and the order: a grid's held bytes are its allocated bytes (5,069,464 at degree 12 on 128 anomalies, 169,044 at
// degree 2), and sdnap_wide_grid_cache reports the same held bytes as sdnap_wide_grid_budget; at a bound of two and a half
// grids, the least recently used idle grid is the one freed (a set loaded again after two others is built again, one loaded
// again after one other is not).
// The pool's threads: 2,050 rows of the class 0 set at five inclinations (five grid keys; 410 mean anomalies each, shuffled)
// with AP's terms selected (a test build that adds the selector), sdnap_propagate_soa at 20 instants on 1 thread, on 8 (five
// 512-row chunks: threaded batches) and on 8 at a 1-byte bound: every row flies, bit for bit.
// A failed allocation is refused by name ("out-of-memory"), never success and never another reason:
// - an instance held to 256 MB and filled through sdnap_alloc to about 4 MB free: `propagate` of the class 0 set and `fit` of
//   that set's own states answer out-of-memory, and the cache then holds as many grids as a fresh instance (a set that failed
//   to initialize keeps no reference); an epoch-store state answers the theory's refusal code; with the memory freed, the same `propagate` and the
//   same epoch-store state are bit for bit a fresh instance's;
// - the same test build fails the N-th allocation of a `fit` (N at a fifth, a half and four fifths of the fit's own count):
//   each answers out-of-memory, and the same fit on the same instance afterwards writes the fresh instance's record, byte
//   for byte;
// - the decay answers (SPEC 16.25) as well: a set at perigee 200 km, e 0.001 whose flight ends at its decay crossing within
//   four days, fitted on its own states (12 hours ending at the crossing: decayed-in-arc or a record that states where it
//   decays; 24 hours ending 6 hours before it, with held-out states to it and three past it: a record whose residuals mark
//   those three DECAYED), each with an allocation failed at a fifth, a half and four fifths of its count: out-of-memory, and
//   the fresh answer afterwards;
// - the raw fit (sdnap_fit) the same way: status -1 and its row as it came, then the fresh status, statistics and row.
// JS moves bytes and compares numbers the module produced.
//   node test/grid-cache.e2e.mjs
import assert from "node:assert/strict";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as Block } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as Line } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { ODR } from "spacedatastandards.org/lib/js/ODR/main.js";
import { ensureBuilt, wasmPath, elementRows, THEORY, openModule } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, flight, ocmOf } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

ensureBuilt();
const DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137, MB = 1 << 20;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const SETS = [
  { name: "class 0, e 0.4", n: revPerDay((RE + 3000) / 0.6), e: 0.4, i: 65, raan: 40, argp: 30, ma: 10 },
  { name: "half-day class, e 0.74", n: 2.006, e: 0.74, i: 63.4, raan: 120, argp: 270, ma: 200 },
  { name: "one-day class, e 0.82", n: 1.0027, e: 0.82, i: 10, raan: 300, argp: 80, ma: 150 },
  { name: "long-period, e 0.9", n: revPerDay((RE + 1000) / 0.1), e: 0.9, i: 55, raan: 200, argp: 150, ma: 90 },
];
SETS.push({ ...SETS[0], name: "class 0, e 0.4, another catalog number" });
const record = (s, k, tesseral = 31) => seedOcm({ epoch: iso(EPOCH), n: s.n, e: s.e, i: s.i, raan: s.raan, argp: s.argp, ma: s.ma, norad: 70000 + k, tesseral, zonal: 20 });
const RECORDS = SETS.map((s, k) => record(s, k));
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const TIMES = Array.from({ length: 120 }, (_, k) => EPOCH + k * 36 * 60000);
let seed = 4972026;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const shuffle = (a) => { for (let q = a.length - 1; q > 0; --q) { const j = Math.floor(rand() * (q + 1)); [a[q], a[j]] = [a[j], a[q]]; } return a; };
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));
// a grid's allocated bytes (SPEC 16.11): its WideGrid (64 bytes in wasm32) and a block for every family (m, w) of its degree:
// 6 x 128 x 4 floats of values and slopes, 3 x 6 x 64 x 2 half-precision derivatives, and two index bytes
const gridBytes = (degree) => 64 + degree * (2 * degree + 1) * (6 * 128 * 4 * 4 + 3 * 6 * 64 * 2 * 2 + 2);

async function open(file = wasmPath, options = {}) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", ...options });
  const x = h.instance.exports;
  const mem = () => (h.memory ?? x.memory).buffer;
  const out = x.sdnap_alloc(48), budget = x.sdnap_alloc(32), cache = x.sdnap_alloc(24);
  return {
    h, x,
    load: async (records) => {
      const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: Buffer.concat(records.map(prefixed)) }] });
      if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
    },
    rc: (i, ms) => { const [w, f] = jd(ms); return x.sdnap_epochs_set_at(i, 0, w, f, out); },
    at(i, ms) {
      const rc = this.rc(i, ms);
      if (rc !== 0) throw new Error(`sdnap_epochs_set_at ${rc}`);
      return Array.from(new Float64Array(mem(), out, 6));
    },
    // [bound, bytes held, grids held, grids idle]
    budget: (bytes = 0) => { x.sdnap_wide_grid_budget(bytes, budget); return Array.from(new Float64Array(mem(), budget, 4)); },
    // [grids held, bytes held, grids built since the instance began]
    cache: () => { x.sdnap_wide_grid_cache(cache); return Array.from(new Float64Array(mem(), cache, 3)); },
  };
}

// a cold cache, set by set in time order: the reference
const A = await open();
await A.load(RECORDS);
const ref = SETS.map((_, i) => TIMES.map((t) => A.at(i, t)));
assert.ok(ref.every((r) => r.every((s) => s.length === 6 && s.every(Number.isFinite))), "every component of every reference state is a number");
assert.ok(ref[0].every((s, k) => same(s, ref[4][k])), "the copy of the first set flies bit for bit like it");
// a warm cache, every (set, time) shuffled
await A.load(RECORDS);
const pairs = shuffle(SETS.flatMap((_, i) => TIMES.map((_, k) => [i, k])));
let differ = 0;
for (const [i, k] of pairs) if (!same(A.at(i, TIMES[k]), ref[i][k])) ++differ;
assert.equal(differ, 0, `a warm cache, shuffled: ${differ} states differ`);
console.log(`a warm cache, ${pairs.length} (set, time) pairs shuffled: bit for bit`);
// a cache that keeps no idle grid: one set loaded at a time, time-major
const B = await open();
assert.equal(B.budget(1)[0], 1, "the byte bound is set to 1");
differ = 0;
let idle = 0, held = 0;
for (let blk = 0; blk < TIMES.length; blk += 30)
  for (let i = 0; i < SETS.length; ++i) {
    await B.load([RECORDS[i]]);
    for (let k = blk; k < blk + 30; ++k) if (!same(B.at(0, TIMES[k]), ref[i][k])) ++differ;
    const [, , count, idleNow] = B.budget();
    idle = Math.max(idle, idleNow);
    held = Math.max(held, count);
  }
assert.equal(differ, 0, `a 1-byte bound: ${differ} states differ`);
assert.equal(idle, 0, `a 1-byte bound kept ${idle} idle grids`);
console.log(`a 1-byte bound (every grid built again at each of ${(TIMES.length / 30) * SETS.length} loads): bit for bit; no idle grid kept, at most ${held} held, all by the loaded set`);
// the default bound keeps idle grids
const C = await open();
for (let i = 0; i < SETS.length; ++i) { await C.load([RECORDS[i]]); C.at(0, TIMES[0]); }
const [defaultBound, , , idleDefault] = C.budget();
assert.equal(defaultBound, 512 * MB, "the default bound is 512 MiB");
assert.ok(idleDefault > 0, `the default bound keeps idle grids (${idleDefault})`);

// the bytes: one grid at degree 12 and one at degree 2, each at its allocated bytes, the two exports the same
for (const [degree, rec] of [[12, RECORDS[0]], [2, record(SETS[0], 9, 2)]]) {
  const D = await open();
  await D.load([rec]);
  D.at(0, TIMES[0]);
  const [, bytes, grids] = D.budget(), [cacheGrids, cacheBytes] = D.cache();
  assert.equal(grids, 1, `degree ${degree}: one grid held`);
  assert.equal(bytes, gridBytes(degree), `degree ${degree}: the held bytes ${bytes} are the grid's allocated ${gridBytes(degree)}`);
  assert.ok(cacheGrids === grids && cacheBytes === bytes, `degree ${degree}: sdnap_wide_grid_cache reports ${cacheGrids} grids, ${cacheBytes} bytes`);
  console.log(`one grid at degree ${degree}: ${bytes} bytes held, its allocated bytes, reported alike by both exports`);
}
// the order: a bound of two and a half grids frees the least recently used idle grid
const L = await open();
L.budget(Math.floor(2.5 * gridBytes(12)));
const builds = async (i) => { const before = L.cache()[2]; await L.load([RECORDS[i]]); L.at(0, TIMES[0]); return L.cache()[2] - before; };
assert.deepEqual([await builds(0), await builds(1), await builds(2)], [1, 1, 1], "three sets, one grid each");
assert.equal(await builds(1), 0, "the set loaded again after one other is still held (not the least recently used)");
assert.equal(await builds(0), 1, "the set loaded again after two others was freed (the least recently used)");
console.log("a bound of two and a half grids: the least recently used idle grid is the one freed");

// the pool's threads: 2,050 rows (shuffled), AP's terms selected, 1 and 8 threads, and 8 at a 1-byte bound; and the fault seam
const allocSeam = (sig, call) => (t) => t.replace(`${sig} {\n  void* p = ${call};`, `${sig} {\n  if (fail_now()) { note_failure(n); return nullptr; }\n  void* p = ${call};`);
const testBuild = buildDiagnostic("grid-cache-seams",
  'SDNAP_EXPORT("sdnap_test_select_ap") void sdnap_test_select_ap(int32_t t, int32_t z) { sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{t, z}; }\n' +
  'SDNAP_EXPORT("sdnap_test_fail_after") void sdnap_test_fail_after(uint32_t n) { sdnap::mem::g_fail_after = n; }\n' +
  'SDNAP_EXPORT("sdnap_test_allocs") uint32_t sdnap_test_allocs(int32_t reset) { const uint32_t v = sdnap::mem::g_allocs; if (reset) sdnap::mem::g_allocs = 0; return v; }\n',
  (s) => s,
  { "constants.inc": (t) => [
    (u) => u.replace("inline void* malloc(size_t n) {", "inline uint32_t g_fail_after = 0, g_allocs = 0;\ninline bool fail_now() {\n  ++g_allocs;\n  return g_fail_after != 0 && --g_fail_after == 0;\n}\ninline void* malloc(size_t n) {"),
    allocSeam("inline void* malloc(size_t n)", "std::malloc(n)"),
    (u) => u.replace("inline void* calloc(size_t k, size_t n) {\n  void* p = std::calloc(k, n);", "inline void* calloc(size_t k, size_t n) {\n  if (fail_now()) { note_failure(k * n); return nullptr; }\n  void* p = std::calloc(k, n);"),
    allocSeam("inline void* realloc(void* q, size_t n)", "std::realloc(q, n)"),
    allocSeam("inline void* aligned_alloc(size_t align, size_t n)", "std::aligned_alloc(align, n)"),
  ].reduce((u, f) => f(u), t) });
// the row store flies class 0 above its switch (the resonance classes and the long-period regime at e 0.74 to 0.9 are refused
// there part way: stack #424); five grid keys (e 0.4, i 61 to 65)
const rows = shuffle([61, 62, 63, 64, 65].flatMap((inc, k) => Array.from({ length: 410 }, (_, q) => ({ s: { ...SETS[0], i: inc }, k, q })))).map(({ s, k, q }) => {
  const [w, f] = jd(EPOCH);
  return { epochWhole: w, epochFrac: f, meanMotion: s.n, ecc: s.e, inc: s.i, raan: s.raan, argp: s.argp, ma: (s.ma + q * 0.877) % 360, norad: 71000 + k * 1000 + q, theory: THEORY.SGP4XP };
});
async function soa(threads, bytes = 0) {
  const h = await createStandaloneHarness("browser", testBuild, { surface: "direct", maxThreads: threads, enableBrowserWasiThreads: threads > 1 });
  const x = h.instance.exports, mem = () => (h.memory ?? x.memory).buffer;
  if (threads > 1) assert.equal(x.sdnap_threads(threads), threads, `sdnap_threads(${threads})`);
  if (bytes > 0) { const p = x.sdnap_alloc(32); x.sdnap_wide_grid_budget(bytes, p); }
  x.sdnap_test_select_ap(31, 20);
  const bytesIn = elementRows(rows), p = x.sdnap_alloc(bytesIn.length);
  new Uint8Array(mem(), p, bytesIn.length).set(bytesIn);
  assert.equal(x.sdnap_init_elements(p, rows.length), rows.length, "sdnap_init_elements");
  const out = x.sdnap_alloc(48 * rows.length), status = x.sdnap_alloc(4 * rows.length), all = [];
  for (let k = 0; k < 20; ++k) {
    const [w, f] = jd(EPOCH + k * 3.6 * 3600000);
    assert.equal(x.sdnap_propagate_soa(w, f, 0, rows.length, 0, out, status), 0, `sdnap_propagate_soa, ${threads} threads`);
    const st = Array.from(new Int32Array(mem(), status, rows.length));
    const bad = new Map();
    st.forEach((v, q) => { if (v !== 0) bad.set(`${rows[q].ecc}:${v}`, (bad.get(`${rows[q].ecc}:${v}`) ?? 0) + 1); });
    assert.ok(st.every((v) => v === 0), `${threads} threads at instant ${k}: every row flies (refused by e:status ${JSON.stringify([...bad])})`);
    all.push(...new Float64Array(mem(), out, 6 * rows.length), ...st);
  }
  return all;
}
const one = await soa(1), eight = await soa(8), eightBound = await soa(8, 1);
assert.ok(same(one, eight), "1 and 8 threads bit for bit");
assert.ok(same(one, eightBound), "8 threads at a 1-byte bound bit for bit");
console.log(`the pool: ${rows.length} AP rows (shuffled) at 20 instants on 1 thread, on 8 (${Math.ceil(rows.length / 512)} chunks) and on 8 at a 1-byte bound: bit for bit`);

// out of memory: refused by name
const fresh = await open();
const flightOf = (h, rec, times) => h.invoke({ methodId: "propagate", inputs: flight([rec], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
const statesOf = (r) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs.find((v) => v.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const sameLines = (a, b) => a.length === b.length && a.every((l, k) => ["X", "Y", "Z", "X_DOT", "Y_DOT", "Z_DOT"].every((f) => Object.is(l[f], b[k][f])));
const few = TIMES.slice(0, 5);
const good = await flightOf(fresh.h, RECORDS[0], few);
assert.equal(good.statusCode, 0, `a fresh instance flies: ${good.errorCode}`);
// the fit's input: the set's own states every 300 s over a day
const arc = Array.from({ length: 289 }, (_, k) => EPOCH + k * 300000);
const arcFlight = await flightOf(fresh.h, RECORDS[0], arc);
assert.equal(arcFlight.statusCode, 0, "the arc flies");
const lines = statesOf(arcFlight).map((l, k) => Object.assign(new Line(), { EPOCH: iso(arc[k]), X: l.X, Y: l.Y, Z: l.Z, X_DOT: l.X_DOT, Y_DOT: l.Y_DOT, Z_DOT: l.Z_DOT }));
const block = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 70000, OBJECT_NAME: "TEST" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"),
  TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
const oem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
const cfg = configuration({ forces: { EPHEMERIS_SOURCE: "", HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70 } });
const fitOn = (h) => h.invoke({ methodId: "fit", inputs: [cfg, { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
const recordOf = (r) => Buffer.from(r.outputs.find((v) => v.portId === "elements").payload);
const H = await open(wasmPath, { maximumMemoryBytes: 256 * MB });
await H.load([RECORDS[0]]);
const hog = [];
for (const chunk of [16 * MB, MB, 64 * 1024]) for (;;) { const p = H.x.sdnap_alloc(chunk); if (!p) break; hog.push([p, chunk]); }
// leave about 3 MB: less than a grid's build takes (its two double-precision family sets alone are 3.7 MB each at degree 12)
let freed = 0;
for (let k = hog.length - 1; k >= 0 && freed < 3 * MB; --k) if (hog[k][1] === MB || hog[k][1] === 64 * 1024) { H.x.sdnap_free(hog[k][0]); freed += hog[k][1]; hog.splice(k, 1); }
const starved = await flightOf(H.h, RECORDS[0], few);
assert.equal(starved.errorCode, "out-of-memory", `propagate with the memory exhausted: ${starved.errorCode}: ${starved.errorMessage}`);
const starvedFit = await fitOn(H.h);
assert.equal(starvedFit.errorCode, "out-of-memory", `fit with the memory exhausted: ${starvedFit.errorCode}: ${starvedFit.errorMessage}`);
const [, , heldAfter] = H.budget(), [, , heldFresh] = (await open()).budget();
assert.equal(heldAfter, heldFresh, `after the refused calls the cache holds ${heldAfter} grids; a fresh instance ${heldFresh}`);
const storeRc = H.rc(0, TIMES[3]);
assert.notEqual(storeRc, 0, "an epoch-store state with the memory exhausted is refused");
console.log(`the memory exhausted (about ${(freed / MB).toFixed(1)} MB left of 256): propagate and fit refused by name (${starved.errorMessage}); no grid kept; the epoch store refuses the state (code ${storeRc})`);
for (const [p] of hog) H.x.sdnap_free(p);
const after = await flightOf(H.h, RECORDS[0], few);
assert.equal(after.statusCode, 0, `with the memory freed: ${after.errorCode}: ${after.errorMessage}`);
assert.ok(sameLines(statesOf(after), statesOf(good)), "with the memory freed, propagate is bit for bit a fresh instance's");
assert.ok(same(H.at(0, TIMES[3]), ref[0][3]), "with the memory freed, the epoch-store state is initialized again and is bit for bit the reference");
console.log("the memory freed: the same propagate and the same epoch-store state fly, bit for bit a fresh instance");

// a fit that fails an allocation part way: out-of-memory, and the same fit afterwards writes the fresh record
const F = await open(testBuild);
F.x.sdnap_test_allocs(1);
const refFit = await fitOn(F.h);
assert.equal(refFit.statusCode, 0, `the test build's fit: ${refFit.errorCode}: ${refFit.errorMessage}`);
const count = F.x.sdnap_test_allocs(1), refRecord = recordOf(refFit);
assert.ok(count > 100, `the fit allocates (${count})`);
for (const part of [0.2, 0.5, 0.8]) {
  F.x.sdnap_test_fail_after(Math.round(part * count));
  const r = await fitOn(F.h);
  F.x.sdnap_test_fail_after(0);
  assert.equal(r.errorCode, "out-of-memory", `the fit failing its allocation ${Math.round(part * count)} of ${count}: ${r.errorCode}: ${r.errorMessage}`);
  const again = await fitOn(F.h);
  assert.equal(again.statusCode, 0, "the same fit afterwards");
  assert.ok(recordOf(again).equals(refRecord), `after a failure at ${part} of the fit, the record is the fresh instance's, byte for byte`);
}
console.log(`a fit failing its allocation at a fifth, a half and four fifths of its ${count}: out-of-memory each time, and the fresh record afterwards`);

// the decay answers (SPEC 16.25) are no answer after a failed allocation: a set at perigee 200 km, e 0.001, BTERM 0.01 (Jacchia
// 1970 on the theory's flux), whose flight ends at its decay crossing within four days, fitted on its own states
const D0 = Date.parse("2026-10-29T00:00:00Z"), HOUR = 3600000;
const msOf = (text) => Date.parse(text.endsWith("Z") ? text : `${text}Z`);
const decaySeed = (bterm) => seedOcm({ epoch: iso(D0), n: revPerDay((RE + 200) / 0.999), e: 0.001, i: 55, raan: 40, argp: 90, ma: 0, bterm, norad: 99564, tesseral: 31, zonal: 20 });
const span = await flightOf(fresh.h, decaySeed(0.01), Array.from({ length: 4 * 288 + 1 }, (_, k) => D0 + k * 300000));
assert.equal(span.statusCode, 0, `the seed's four days: ${span.errorCode}`);
const spanBlock = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(span.outputs.find((v) => v.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
const crossing = /^decayed:(\S+); \d+ epochs after it refused$/.exec(spanBlock.COMMENT ?? "");
assert.ok(crossing, `the seed decays within four days: COMMENT ${spanBlock.COMMENT}`);
const crossMs = msOf(crossing[1]);
const lineOf = (l) => Object.assign(new Line(), { EPOCH: l.EPOCH, X: l.X, Y: l.Y, Z: l.Z, X_DOT: l.X_DOT, Y_DOT: l.Y_DOT, Z_DOT: l.Z_DOT });
const seedLines = spanBlock.EPHEMERIS_DATA_LINES.map(lineOf);
const within = (a, b) => seedLines.filter((l) => msOf(l.EPOCH) >= a && msOf(l.EPOCH) < b);
const oemOf = (lines, useStart, useStop) => packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [Object.assign(new Block(), {
  OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99564, OBJECT_NAME: "TEST" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC,
  START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: useStart, USEABLE_STOP_TIME: useStop, EPHEMERIS_DATA_LINES: lines })] }));
// the arc's 12 hours before the crossing: the fitted set, or a bumped one, meets the rule at the arc's end
const lastHours = within(crossMs - 12 * HOUR, crossMs);
// 24 hours of arc ending 6 hours before the crossing, then held-out states: the seed's to the crossing, and three past it (a set
// at half the drag term flies there) that the written set has no state at
const arcEnd = within(crossMs - 30 * HOUR, crossMs - 6 * HOUR);
const twin = await flightOf(fresh.h, decaySeed(0.005), [0.5, 1, 1.5].map((h) => crossMs + h * HOUR));
assert.equal(twin.statusCode, 0, `the twin past the seed's crossing: ${twin.errorCode}`);
const pastLines = statesOf(twin).map(lineOf);
assert.equal(pastLines.length, 3, "the twin flies past the seed's crossing");
const heldLines = [...arcEnd, ...within(crossMs - 6 * HOUR, crossMs), ...pastLines];
const fitBytes = (h, bytes) => h.invoke({ methodId: "fit", inputs: [cfg, { portId: "ephemeris", typeRef: T("OEM"), payload: bytes }] });
const answerOf = (r) => r.statusCode === 0 ? JSON.stringify(r.outputs.map((v) => [v.portId, Buffer.from(v.payload).toString("hex")])) : `${r.errorCode}: ${r.errorMessage}`;
const decayCases = [
  { name: "an arc ending at the crossing", bytes: oemOf(lastHours, lastHours[0].EPOCH, lastHours.at(-1).EPOCH),
    decays: (r) => (r.errorCode ?? "").startsWith("decayed-in-arc:") ||
      (r.statusCode === 0 && (ocmOf(r.outputs.find((v) => v.portId === "elements").payload).ORBIT_DETERMINATION.COMMENT ?? []).some((l) => l.startsWith("decays at "))) },
  { name: "held-out states past the crossing", bytes: oemOf(heldLines, arcEnd[0].EPOCH, arcEnd.at(-1).EPOCH),
    decays: (r) => r.statusCode === 0 && ODR.getRootAsODR(new flatbuffers.ByteBuffer(r.outputs.find((v) => v.portId === "residuals").payload)).unpack()
      .EDITED_OBSERVATIONS.filter((e) => e.REASON === "DECAYED").length === pastLines.length },
];
for (const c of decayCases) {
  // the count from the second of two fits (the first may fill what the instance keeps)
  const ref = await fitBytes(F.h, c.bytes);
  F.x.sdnap_test_allocs(1);
  assert.equal(answerOf(await fitBytes(F.h, c.bytes)), answerOf(ref), `${c.name}: the same answer twice`);
  const n = F.x.sdnap_test_allocs(1);
  assert.ok(c.decays(ref), `${c.name}: a decay answer (${ref.errorCode ?? "a record"}: ${ref.errorMessage ?? ""})`);
  for (const part of [0.2, 0.5, 0.8]) {
    F.x.sdnap_test_fail_after(Math.round(part * n));
    const r = await fitBytes(F.h, c.bytes);
    F.x.sdnap_test_fail_after(0);
    assert.equal(r.errorCode, "out-of-memory", `${c.name}, its allocation ${Math.round(part * n)} of ${n} failed: ${r.errorCode}: ${r.errorMessage}`);
    assert.equal(answerOf(await fitBytes(F.h, c.bytes)), answerOf(ref), `${c.name}: after a failure at ${part}, the fresh answer`);
  }
  console.log(`${c.name} (${ref.statusCode === 0 ? "a record" : ref.errorCode}): out-of-memory at a fifth, a half and four fifths of its ${n} allocations, the fresh answer afterwards`);
}

// the raw fit (sdnap_fit) failing an allocation part way: status -1 and the row as it came; then the fresh status and row
const M = await openModule();
const rawSet = { epochWhole: 2461314.5, epochFrac: 0, meanMotion: 15.07, ecc: 0.001, inc: 53, raan: 10, argp: 20, ma: 30, bterm: 0, agom: 0, norad: 90401, theory: THEORY.SGP4XP };
M.init([rawSet]);
const rawMinutes = Array.from({ length: 25 }, (_, k) => 60 * k), rawPositions = [];
for (const t of rawMinutes) { const p = M.atMinutes([t]); rawPositions.push(p.x[0], p.y[0], p.z[0]); }
const fmem = () => (F.h.memory ?? F.x.memory).buffer, startRow = elementRows([{ ...rawSet, meanMotion: 15.0705, ma: 30.05 }]);
const rowPtr = F.x.sdnap_alloc(112), tPtr = F.x.sdnap_alloc(8 * 25), rPtr = F.x.sdnap_alloc(8 * 75), optPtr = F.x.sdnap_alloc(56), statsPtr = F.x.sdnap_alloc(32);
const rawFit = () => {
  new Uint8Array(fmem(), rowPtr, 112).set(startRow);
  new Float64Array(fmem(), tPtr, 25).set(rawMinutes);
  new Float64Array(fmem(), rPtr, 75).set(rawPositions);
  new Uint8Array(fmem(), optPtr, 56).fill(0);
  const rc = F.x.sdnap_fit(rowPtr, tPtr, rPtr, 25, optPtr, statsPtr);
  return { rc, stats: Array.from(new Float64Array(fmem(), statsPtr, 4)), row: Buffer.from(new Uint8Array(fmem(), rowPtr, 112)) };
};
const rawRef = rawFit();
F.x.sdnap_test_allocs(1);
assert.ok(same(rawFit().stats, rawRef.stats), "the raw fit twice alike");
const rawCount = F.x.sdnap_test_allocs(1);
assert.ok(rawRef.rc === 0 && rawRef.stats[0] === 0, `the raw fit converges: rc ${rawRef.rc}, status ${rawRef.stats[0]}`);
for (const part of [0.2, 0.5, 0.8]) {
  F.x.sdnap_test_fail_after(Math.max(1, Math.round(part * rawCount)));
  const r = rawFit();
  F.x.sdnap_test_fail_after(0);
  assert.ok(r.rc !== 0 && r.stats[0] === -1, `the raw fit, its allocation ${Math.round(part * rawCount)} of ${rawCount} failed: rc ${r.rc}, status ${r.stats[0]}`);
  assert.ok(r.row.equals(Buffer.from(startRow)), "the raw fit's row as it came");
  const again = rawFit();
  assert.ok(again.rc === 0 && same(again.stats, rawRef.stats) && again.row.equals(rawRef.row), "the raw fit afterwards: the fresh status, statistics and row");
}
console.log(`the raw fit failing its allocation at a fifth, a half and four fifths of its ${rawCount}: status -1, the row as it came, the fresh fit afterwards`);
console.log("grid cache E2E: PASS");
process.exit(0);
