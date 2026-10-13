/**
 * The threaded small-body catalog surface (src/small_body_catalog.hpp):
 * one instance on a shared memory, a pool of pthreads, jobs begun through
 * control words and read in place. Its snapshot must be the single-thread
 * export's, row for row and bit for bit (the threads only split the rows);
 * its ingest the select and describe exports'; its promoted rows the state
 * export's.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadedExports } from "./threaded.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const stream = fs.readFileSync(path.join(here, "fixtures", "astorb-edges.fbs"));
const ROWS = 11;
// layout slots, control words and params (src/small_body_catalog.hpp)
const S = { COUNT: 2, THREADS: 3, CONTROL: 4, PARAMS: 5, SNAPSHOT: 6, NUMBERS: 7, NAME_OFFSETS: 9, NAMES: 10, VALIDITY: 12, RESULTS: 13, QUERY: 14 };
const C = { DONE_SEQ: 1, RESULT: 3 };
const P = { ET: 0, OBSERVER: 1, OBSERVER_COUNT: 11, DATA: 12, LENGTH: 13, CLASS_MASK: 14, H_MIN: 15, H_MAX: 16, EXCLUDE: 17 };

async function catalog(threads) {
  const x = await threadedExports(fs.readFileSync(wasmPath), { threads });
  const table = new Uint32Array(x.memory.buffer, x.kepler_catalog_init(64, 32, threads), 16);
  const view = (Type, slot, n) => new Type(x.memory.buffer, table[slot], n);
  const control = view(Int32Array, S.CONTROL, 8);
  const params = view(Float64Array, S.PARAMS, 32);
  const until = async (seq) => {
    while (Atomics.load(control, C.DONE_SEQ) - seq < 0) await new Promise((r) => setTimeout(r, 1));
    return Atomics.load(control, C.RESULT);
  };
  return { x, table, view, control, params, until };
}

async function ingest(c, select = {}) {
  const p = c.x.plugin_alloc(stream.length);
  new Uint8Array(c.x.memory.buffer, p, stream.length).set(stream);
  c.params[P.DATA] = p;
  c.params[P.LENGTH] = stream.length;
  c.params[P.CLASS_MASK] = select.classMask ?? 0;
  c.params[P.H_MIN] = select.hMin ?? NaN;
  c.params[P.H_MAX] = select.hMax ?? NaN;
  c.params[P.EXCLUDE] = 0;
  const added = await c.until(c.x.kepler_catalog_ingest_begin());
  c.x.plugin_free(p, stream.length);
  return added;
}

test("a pool of pthreads runs and the catalog ingests the shard (select and describe as the exports)", async () => {
  const c = await catalog(3);
  assert.equal(c.table[S.THREADS], 3, "three pool threads started");
  assert.equal(await ingest(c), ROWS);
  assert.equal(c.table[S.COUNT], ROWS);
  const numbers = Array.from(c.view(Uint32Array, S.NUMBERS, ROWS));
  assert.deepEqual(numbers, [1, 3, 4, 7, 16, 433, 1036, 1862, 4179, 99942, 101955]);
  const offsets = c.view(Uint32Array, S.NAME_OFFSETS, ROWS + 1);
  const names = c.view(Uint8Array, S.NAMES, offsets[ROWS]);
  assert.equal(new TextDecoder().decode(names.slice(offsets[5], offsets[6])), "Eros");
  // search: number first, then prefixes, then inner matches
  const query = c.view(Uint8Array, S.QUERY, 256);
  query.set(new TextEncoder().encode("ER"));
  const found = c.x.kepler_catalog_search(2, 20);
  const results = Array.from(c.view(Int32Array, S.RESULTS, found));
  assert.ok(results.includes(5), "Eros found by a case-folded prefix");
  assert.equal(c.x.kepler_catalog_find_number(99942), 9);
});

test("a selection keeps what kepler_small_select_sbd_stream keeps", async () => {
  const c = await catalog(2);
  const added = await ingest(c, { hMax: 10 });
  const x = c.x;
  const p = x.plugin_alloc(stream.length);
  new Uint8Array(x.memory.buffer, p, stream.length).set(stream);
  const kept = x.kepler_small_select_sbd_stream(p, stream.length, 0, NaN, 10, 0, 0, p, stream.length);
  let records = 0;
  const dv = new DataView(x.memory.buffer, p, kept);
  for (let o = 0; o < kept; o += 4 + dv.getUint32(o, true)) ++records;
  assert.equal(added, records);
  assert.ok(added > 0 && added < ROWS);
});

test("the threaded snapshot is the single-thread export's, bit for bit; promoted rows match kepler_small_state", async () => {
  const threaded = await catalog(4);
  await ingest(threaded);
  const single = await catalog(4);
  await ingest(single);
  const validity = threaded.view(Float64Array, S.VALIDITY, 2);
  const et = 0.5 * (validity[0] + validity[1]) + 12345.0;
  const observer = Float64Array.of(1.4e11, 2e10, 1e9, 1e3, 2e4, 3e3, 10, 5, 1, et - 600);
  threaded.params[P.ET] = et;
  threaded.params.set(observer, P.OBSERVER);
  threaded.params[P.OBSERVER_COUNT] = 10;
  const failed = await threaded.until(threaded.x.kepler_catalog_snapshot_begin());
  assert.equal(failed, 0);
  const rows = Float32Array.from(threaded.view(Float32Array, S.SNAPSHOT, 4 * ROWS));
  // the single-thread export, on the other instance
  const x = single.x;
  const obs = x.plugin_alloc(80);
  const out = x.plugin_alloc(16 * ROWS);
  new Float64Array(x.memory.buffer, obs, 10).set(observer);
  assert.equal(x.kepler_small_snapshot_apparent(et, 0, ROWS, obs, out), 0);
  const reference = new Float32Array(x.memory.buffer, out, 4 * ROWS);
  assert.deepEqual(Array.from(rows), Array.from(reference));
  // a promoted row evaluates as the store's row
  assert.equal(threaded.x.kepler_catalog_promote(5, 0), 0);
  const a = threaded.x.plugin_alloc(48);
  const b = x.plugin_alloc(48);
  assert.equal(threaded.x.kepler_catalog_state(et + 3600, 0, a), 0);
  assert.equal(x.kepler_small_state(et + 3600, 5, b), 0);
  assert.deepEqual(
    Array.from(new Float64Array(threaded.x.memory.buffer, a, 6)),
    Array.from(new Float64Array(x.memory.buffer, b, 6)),
  );
});
