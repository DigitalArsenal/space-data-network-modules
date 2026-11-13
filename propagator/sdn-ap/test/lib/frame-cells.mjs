// Shared by the frames tests (SPEC 19): a seeded population of AP sets across the orbit regime, loaded one series each (distinct catalog numbers), and the calls of
// the frames entries over one instance. The module computes every number; this file moves bytes.
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { T, seedOcm, rowsThrough } from "./ocm.mjs";
import { spwRows } from "./fixture-inputs.mjs";
import { wasmPath } from "./module.mjs";
import { configuration } from "./pcf.mjs";

export const DAY = 86400000;
export const EPOCH = "2026-10-15T00:00:00.000";
export const EPOCH_MS = Date.parse(`${EPOCH}Z`);
const MU = 398600.4418, RE = 6378.137;
export const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const allRows = rowsThrough(spwRows({ first: "2026-10-10", days: 60 }).values);

// What the population says the entry does with each kind: serves (true: every time of a day in the regime), or not (never).
// `incs`: the inclinations drawn from; `fixedE`: no jitter of the eccentricity.
export const KINDS = {
  leo500: { hp: 500, e: 0.001, serves: true }, leo830: { hp: 830, e: 0.001, serves: true }, leo1400: { hp: 1400, e: 0.01, serves: true },
  drag300: { hp: 300, e: 0.0005, serves: true, drag: true }, drag250: { hp: 250, e: 0.0005, serves: true, drag: true },
  ecc: { hp: 800, e: 0.03, serves: true }, ecc05: { hp: 800, e: 0.05, serves: true, fixedE: true },
  meo: { hp: 20200, e: 0.001, serves: true }, geo: { hp: 35786, e: 0.0003, serves: true }, eqgeo: { hp: 35786, e: 0.0003, serves: true, incs: [0.3] },
  crit: { hp: 700, e: 0.001, serves: true, incs: [63.4] }, polar: { hp: 700, e: 0.001, serves: true, incs: [90] }, retro: { hp: 700, e: 0.001, serves: true, incs: [140] },
  wide: { hp: 500, e: 0.3, serves: false }, decay: { hp: 170, e: 0.0005, serves: false, drag: true },  // `decay`: served at first, then AP refuses it
  shortrows: { hp: 600, e: 0.001, serves: true, rowsFrom: "2026-10-14" },  // weather rows from the day before the epoch: AP refuses two days before the epoch
};

/** A seeded population: `plan` is a list of [kind, count]; norad ascending in plan order (the store's series order). `spreadMinutes`: epochs spread over that many minutes. */
export function population(plan, seed = 20261113, spreadMinutes = 0) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out = [];
  for (const [kind, count] of plan) {
    for (let k = 0; k < count; k++) {
      const spec = KINDS[kind];
      const e = spec.fixedE ? spec.e : spec.e * (0.5 + rnd());
      const a = (RE + spec.hp) / (1 - e);
      const incs = spec.incs ?? [20, 55, 70, 98];
      const inc = incs[Math.floor(rnd() * incs.length)];
      const o = { kind, norad: 300000 + out.length, e, a, inc, raan: rnd() * 360, argp: rnd() * 360, ma: rnd() * 360, serves: spec.serves, drag: !!spec.drag, rowsFrom: spec.rowsFrom ?? null, epochOffsetMs: 0 };
      if (spreadMinutes > 0) o.epochOffsetMs = Math.floor(rnd() * spreadMinutes * 60000);  // the epochs of a catalog are spread; each object's grid is anchored at its own
      out.push(o);
    }
  }
  return out;
}
const isoOf = (ms) => new Date(ms).toISOString().replace("Z", "");
export const epochOf = (o) => EPOCH_MS + o.epochOffsetMs;
export const ocmOfObject = (o, ap = true) => seedOcm({ epoch: o.epochOffsetMs ? isoOf(EPOCH_MS + o.epochOffsetMs) : EPOCH, n: revPerDay(o.a), e: o.e, i: o.inc, raan: o.raan, argp: o.argp, ma: o.ma, bterm: 0.01, agom: 0.01,
  norad: o.norad, msis: ap, records: ap, tesseral: ap ? 31 : 0, zonal: ap ? 20 : 0, rows: ap ? (o.rowsFrom ? allRows.filter((r) => r.DATE >= o.rowsFrom) : allRows) : [] });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };

/** An instance of the module (wasm: the one under test, or `wasm`) with the frames entries wrapped. `threads`: a pool of that many threads (the pool exists, the frames run on the calling thread). */
export async function openFrames({ wasm = wasmPath, initialMemoryBytes, threads = 0 } = {}) {
  const h = await createStandaloneHarness("browser", wasm, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0, ...(initialMemoryBytes ? { initialMemoryBytes } : {}) });
  const x = h.instance.exports, mem = () => h.memory.buffer;
  if (threads > 0) x.sdnap_threads(threads);
  let n = 0, out = 0, status = 0, scratch = 0, result = 0, posOnly = false;
  const api = {
    h, x, mem, get count() { return n; },
    async load(objects, ocms) {
      const payload = Buffer.concat((ocms ?? objects.map((o) => ocmOfObject(o))).map(prefixed));
      const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload }] });
      if (r.statusCode !== 0) throw new Error(`load_epochs ${r.errorCode}: ${r.errorMessage}`);
      api.adopt(x.sdnap_epochs_count());
    },
    /** the store was loaded by the caller (in parts): n series, the call buffers made */
    adopt(count) { n = count; out = x.sdnap_alloc(48 * n + 64); status = x.sdnap_alloc(4 * n + 64); scratch = x.sdnap_alloc(256); result = x.sdnap_alloc(64); },
    open(budget, flags = 0) { posOnly = (flags & 1) !== 0; return x.sdnap_frames_open(budget, flags); },
    jd: (ms) => { const d = Math.floor(ms / DAY); return [d + 2440587.5, (ms - d * DAY) / DAY]; },
    /** refill at `ms` (UTC ms); priority: an array of series indices; failAt: arm the allocation seam after the host's own allocation.
     *  Returns { rc, left: [not visited for now, for now + ahead], stored, tombstones, unstored, visits }. */
    refill(ms, aheadSeconds = 180, maxRows = 1 << 30, priority = [], failAt = 0) {
      const [w, f] = api.jd(ms);
      let p = 0;
      if (priority.length) { p = x.sdnap_alloc(4 * priority.length); new Uint32Array(mem(), p, priority.length).set(priority); }
      if (failAt) x.sdnap_test_fail_at(failAt);  // armed after the host's own allocation: the call's own counted allocations are counted from here
      const rc = x.sdnap_frames_refill(w, f, aheadSeconds, maxRows, p, priority.length, result);
      const r = Array.from(new Int32Array(mem(), result, 6));
      if (p) x.sdnap_free(p);
      return { rc, left: [r[0], r[1]], stored: r[2], tombstones: r[3], unstored: r[4], visits: r[5], due: r[0] + r[1] };
    },
    /** refill until a call leaves nothing to visit or stores nothing; returns the last result and the number of calls */
    fill(ms, aheadSeconds = 180, maxRows = 5000, priority = []) {
      let calls = 0, r;
      do { r = api.refill(ms, aheadSeconds, maxRows, priority); calls++; } while (r.due > 0 && r.stored + r.tombstones > 0);
      return { ...r, calls };
    },
    /** frames_at: { rc, status: Int32Array copy, planes: Float64Array copy (6 x count, or 3 x count with the position-only flag) } */
    at(ms, first = 0, count = n, frame = 0) {
      const [w, f] = api.jd(ms);
      const rc = x.sdnap_frames_at(w, f, first, count, frame, out, status);
      return { rc, status: new Int32Array(mem(), status, count).slice(), planes: new Float64Array(mem(), out, (posOnly ? 3 : 6) * count).slice() };
    },
    /** AP's own state of series i at ms: km, km/s (TEME); set k of the series (default the first) */
    ap(i, ms, k = 0) {
      const [w, f] = api.jd(ms);
      const rc = x.sdnap_epochs_set_at(i, k, w, f, scratch);
      return rc === 0 ? Array.from(new Float64Array(mem(), scratch, 6)) : null;
    },
    /** sdnap_epochs_at over the whole store: planes copy and status copy */
    epochsAt(ms, frame = 0) {
      const [w, f] = api.jd(ms);
      const o = x.sdnap_alloc(48 * n), st = x.sdnap_alloc(4 * n);
      const rc = x.sdnap_epochs_at(w, f, 0, n, frame, o, st, 0);
      const r = { rc, planes: new Float64Array(mem(), o, 6 * n).slice(), status: new Int32Array(mem(), st, n).slice() };
      x.sdnap_free(o); x.sdnap_free(st);
      return r;
    },
    /** the method propagate_epochs on the objects' records (a snapshot given with the call) at the ISO times: the output blocks' bytes */
    async propagateEpochs(ocms, isoTimes) {
      const payload = Buffer.concat(ocms.map(prefixed));
      const r = await h.invoke({ methodId: "propagate_epochs", inputs: [configuration({ epochStore: {}, output: { EPOCHS: isoTimes } }), { portId: "ocm", typeRef: T("OCM"), payload }] });
      if (r.statusCode !== 0) throw new Error(`propagate_epochs ${r.errorCode}: ${r.errorMessage}`);
      return Buffer.concat(r.outputs.map((q) => Buffer.from(q.payload)));
    },
    stats() { const p = x.sdnap_alloc(256); x.sdnap_frames_stats(p); const v = Array.from(new Float64Array(mem(), p, 20)); x.sdnap_free(p); return v; },
    close: () => x.sdnap_frames_close(),
  };
  return api;
}
export const STAT = { objects: 0, eligible: 1, cells: 2, slab: 3, used: 4, table: 5, block: 6, rows: 7, rowsOom: 8, stored: 9, split: 10, needed: 11, full: 12, apTombstones: 13, builderTombstones: 14,
  current: 15, cellBytes: 16, compactions: 17, moved: 18, visits: 19 };
export const STATUS = { served: 0, noSegment: 1, notServedHere: 2, apRefuses: 3, builderFails: 4 };
export const CODE = { badArgument: -1, outOfMemory: -2, budgetTooSmall: -3, storeChanged: -4, notOpen: -5, reopen: -6 };
