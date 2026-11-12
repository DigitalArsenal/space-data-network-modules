#!/usr/bin/env node
// E2E (stack #497; SPEC 1.6 and 16.11): the first-order tesseral grids' cache and the module's memory.
// - An AP state is a function of its set and its time alone, whatever the grid cache held: five AP sets above the
//   eccentricity switch (class 0 at e 0.4, the half-day class at e 0.74, the one-day class at e 0.82, the long-period
//   regime at e 0.9, and a copy of the first under another catalog number: one grid key, two sets), 120 times over three
//   days. Flown in the epoch store (load_epochs, sdnap_epochs_set_at):
//   - a cold cache, set by set in time order: the reference;
//   - the same instance again (a warm cache), every (set, time) shuffled: bit for bit;
//   - a fresh instance whose cache's byte bound (sdnap_wide_grid_budget) is 1 byte, so no idle grid is kept: the sets
//     loaded one at a time, time-major (every grid built again at each load), bit for bit; the cache then holds no more
//     than the one live set's grid.
//   The pool's threads: the same five sets' elements as rows with AP's terms selected (a test build that adds the
//   selector), sdnap_propagate_soa at 20 instants on 1 and on 8 threads, and on 8 threads with the cache's bound at 1 byte:
//   bit for bit.
// - An allocation that fails is refused by name ("out-of-memory"), never as the theory's refusal of the elements nor as a
//   fit that did not converge: on an instance whose memory is held to 256 MB and then filled from outside through
//   sdnap_alloc to within about 3 MB (less than a grid's build takes), `propagate` of the class 0 set and `fit` of that set's
//   own states each fail with errorCode out-of-memory; with the memory freed the same `propagate` flies, bit for bit the
//   states of a fresh instance.
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
import { ensureBuilt, wasmPath, elementRows, THEORY } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, flight } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

ensureBuilt();
const DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const SETS = [
  { name: "class 0, e 0.4", n: revPerDay((RE + 3000) / 0.6), e: 0.4, i: 65, raan: 40, argp: 30, ma: 10 },
  { name: "half-day class, e 0.74", n: 2.006, e: 0.74, i: 63.4, raan: 120, argp: 270, ma: 200 },
  { name: "one-day class, e 0.82", n: 1.0027, e: 0.82, i: 10, raan: 300, argp: 80, ma: 150 },
  { name: "long-period, e 0.9", n: revPerDay((RE + 1000) / 0.1), e: 0.9, i: 55, raan: 200, argp: 150, ma: 90 },
];
SETS.push({ ...SETS[0], name: "class 0, e 0.4, another catalog number" });
const record = (s, k) => seedOcm({ epoch: iso(EPOCH), n: s.n, e: s.e, i: s.i, raan: s.raan, argp: s.argp, ma: s.ma, norad: 70000 + k, tesseral: 31, zonal: 20 });
const RECORDS = SETS.map(record);
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const TIMES = Array.from({ length: 120 }, (_, k) => EPOCH + k * 36 * 60000);
let seed = 4972026;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

async function open(file = wasmPath, options = {}) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", ...options });
  const x = h.instance.exports;
  const mem = () => (h.memory ?? x.memory).buffer;
  const out = x.sdnap_alloc(48), budget = x.sdnap_alloc(32);
  return {
    h, x,
    load: async (records) => {
      const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: Buffer.concat(records.map(prefixed)) }] });
      if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
    },
    at: (i, ms) => {
      const [w, f] = jd(ms);
      const rc = x.sdnap_epochs_set_at(i, 0, w, f, out);
      if (rc !== 0) throw new Error(`sdnap_epochs_set_at ${rc}`);
      return Array.from(new Float64Array(mem(), out, 6));
    },
    budget: (bytes = 0) => { x.sdnap_wide_grid_budget(bytes, budget); return Array.from(new Float64Array(mem(), budget, 4)); },
  };
}

// a cold cache, set by set in time order: the reference
const A = await open();
await A.load(RECORDS);
const ref = SETS.map((_, i) => TIMES.map((t) => A.at(i, t)));
assert.ok(ref.every((r, i) => same(r[0].map(Number.isFinite), [true, true, true, true, true, true]) && i >= 0), "the reference flies");
// the copy flies its own elements bit for bit like the first (one grid key)
assert.ok(ref[0].every((s, k) => same(s, ref[4][k])), "the copy of the first set flies bit for bit like it");
// a warm cache, every (set, time) shuffled
await A.load(RECORDS);
const pairs = SETS.flatMap((_, i) => TIMES.map((_, k) => [i, k]));
for (let q = pairs.length - 1; q > 0; --q) { const j = Math.floor(rand() * (q + 1)); [pairs[q], pairs[j]] = [pairs[j], pairs[q]]; }
let differ = 0;
for (const [i, k] of pairs) if (!same(A.at(i, TIMES[k]), ref[i][k])) ++differ;
assert.equal(differ, 0, `a warm cache, shuffled: ${differ} states differ`);
console.log(`a warm cache, ${pairs.length} (set, time) pairs shuffled: bit for bit`);
// a cache that keeps no idle grid: one set loaded at a time, time-major
const B = await open();
const [bound] = B.budget(1);
assert.equal(bound, 1, "the byte bound is set");
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
assert.equal(differ, 0, `a cache of one grid: ${differ} states differ`);
assert.equal(idle, 0, `a cache bound at 1 byte kept ${idle} idle grids`);
console.log(`a cache bound at 1 byte (no idle grid kept: every grid built again at each of ${(TIMES.length / 30) * SETS.length} loads): bit for bit; at most ${held} grids held, all by the loaded set`);
// the default bound keeps idle grids: the same loads on a fresh instance end with grids idle
const C = await open();
for (let i = 0; i < SETS.length; ++i) { await C.load([RECORDS[i]]); C.at(0, TIMES[0]); }
const [defaultBound, , , idleDefault] = C.budget();
assert.ok(idleDefault > 0 && defaultBound === 512 * 1048576, `the default bound ${defaultBound} keeps ${idleDefault} idle grids`);

// the pool's threads: the sets as rows, AP's terms selected (test build), 1 and 8 threads, and 8 at a 1-byte bound
const testBuild = buildDiagnostic("grid-cache-select",
  'SDNAP_EXPORT("sdnap_test_select_ap") void sdnap_test_select_ap(int32_t t, int32_t z) { sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{t, z}; }\n');
const rows = SETS.map((s, k) => { const [w, f] = jd(EPOCH); return { epochWhole: w, epochFrac: f, meanMotion: s.n, ecc: s.e, inc: s.i, raan: s.raan, argp: s.argp, ma: s.ma, norad: 71000 + k, theory: THEORY.SGP4XP }; });
async function soa(threads, bytes = 0) {
  const h = await createStandaloneHarness("browser", testBuild, { surface: "direct", maxThreads: threads, enableBrowserWasiThreads: threads > 1 });
  const x = h.instance.exports, mem = () => (h.memory ?? x.memory).buffer;
  if (threads > 1) x.sdnap_threads(threads);
  if (bytes > 0) { const p = x.sdnap_alloc(24); x.sdnap_wide_grid_budget(bytes, p); }
  x.sdnap_test_select_ap(31, 20);
  const bytesIn = elementRows(rows), p = x.sdnap_alloc(bytesIn.length);
  new Uint8Array(mem(), p, bytesIn.length).set(bytesIn);
  assert.equal(x.sdnap_init_elements(p, rows.length), rows.length, "sdnap_init_elements");
  const out = x.sdnap_alloc(48 * rows.length), status = x.sdnap_alloc(4 * rows.length), all = [];
  for (let k = 0; k < 20; ++k) {
    const [w, f] = jd(EPOCH + k * 3.6 * 3600000);
    assert.equal(x.sdnap_propagate_soa(w, f, 0, rows.length, 0, out, status), 0, `sdnap_propagate_soa, ${threads} threads`);
    all.push(...new Float64Array(mem(), out, 6 * rows.length), ...new Int32Array(mem(), status, rows.length));
  }
  return all;
}
const one = await soa(1), eight = await soa(8), eightBound = await soa(8, 1);
assert.ok(same(one, eight), "1 and 8 threads bit for bit");
assert.ok(same(one, eightBound), "8 threads at a 1-byte bound bit for bit");
console.log(`the pool: ${SETS.length} AP rows at 20 instants on 1 and 8 threads, and on 8 at a 1-byte bound: bit for bit`);

// out of memory: refused by name
const fresh = await open();
const flightOf = async (h, rec, times) => {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([rec], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  return r;
};
const statesOf = (r) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(r.outputs.find((v) => v.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
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
const MB = 1 << 20;
const H = await open(wasmPath, { maximumMemoryBytes: 256 * MB });
const hog = [];
for (const chunk of [16 * MB, MB, 64 * 1024]) for (;;) { const p = H.x.sdnap_alloc(chunk); if (!p) break; hog.push([p, chunk]); }
// leave about 3 MB: less than a grid's build takes (its two double-precision family sets alone are 3.7 MB each at degree 12)
let freed = 0;
for (let k = hog.length - 1; k >= 0 && freed < 3 * MB; --k) if (hog[k][1] === MB || hog[k][1] === 64 * 1024) { H.x.sdnap_free(hog[k][0]); freed += hog[k][1]; hog.splice(k, 1); }
const starved = await flightOf(H.h, RECORDS[0], few);
assert.equal(starved.errorCode, "out-of-memory", `propagate with the memory exhausted: ${starved.errorCode}: ${starved.errorMessage}`);
const starvedFit = await fitOn(H.h);
assert.equal(starvedFit.errorCode, "out-of-memory", `fit with the memory exhausted: ${starvedFit.errorCode}: ${starvedFit.errorMessage}`);
console.log(`the memory exhausted (about ${(freed / MB).toFixed(1)} MB left of 256): propagate and fit refused by name (${starved.errorMessage})`);
for (const [p] of hog) H.x.sdnap_free(p);
const after = await flightOf(H.h, RECORDS[0], few);
assert.equal(after.statusCode, 0, `with the memory freed: ${after.errorCode}: ${after.errorMessage}`);
const a = statesOf(after), b = statesOf(good);
assert.ok(a.every((l, k) => ["X", "Y", "Z", "X_DOT", "Y_DOT", "Z_DOT"].every((f) => Object.is(l[f], b[k][f]))), "with the memory freed, bit for bit a fresh instance");
console.log("the memory freed: the same propagate flies, bit for bit a fresh instance");
console.log("grid cache E2E: PASS");
process.exit(0);
