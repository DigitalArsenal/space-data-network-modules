/**
 * The small-body layer's snapshot schedule (src/small_body_display.hpp,
 * kepler_small_schedule), multi-body round 3:
 *  - a drawn snapshot taken for an observer far from the present one is
 *    stale (the layer does not draw it: apparent places are the observer's);
 *  - a pair far wider than the present spacing (left by a fast run) is
 *    refined to the present epoch once the clock slows, so a straight mix
 *    across 12 h never stands (up to ~1" for a near-Earth asteroid).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadedExports } from "./threaded.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const SI = {
  ET: 0, RATE: 1, T_OLDER: 2, T_NEWER: 3, SAME_SLOT: 4, HAS_SNAPSHOT: 5, MAX_SPAN: 6, MIN_SPAN: 7,
  INTERVAL: 8, BUSY: 9, ROWS_CHANGED: 10, OBSERVER_VALID: 11, OBSERVER: 12, SNAPSHOT_OBSERVER_VALID: 15,
  SNAPSHOT_OBSERVER: 16, VALIDITY_VALID: 19, DRAWN_OBSERVER_VALID: 22, DRAWN_OBSERVER: 23,
};
const SO = { MIX: 0, REQUEST: 1, TARGET: 2, JUMP: 3, STALE: 4 };
const AU = 1.495978707e11;

async function schedule() {
  const x = await threadedExports(fs.readFileSync(wasmPath), { threads: 1 });
  const pin = x.plugin_alloc(8 * 32);
  const pout = x.plugin_alloc(8 * 8);
  return (fill) => {
    const input = new Float64Array(x.memory.buffer, pin, 32).fill(0);
    fill(input);
    x.kepler_small_schedule(pin, pout);
    return Array.from(new Float64Array(x.memory.buffer, pout, 8));
  };
}

function base(i, { et = 1000, rate = 1, older = 0, newer = 600, observer = [AU, 0, 0], snapshotObserver = observer, drawnObserver = observer } = {}) {
  i[SI.ET] = et;
  i[SI.RATE] = rate;
  i[SI.T_OLDER] = older;
  i[SI.T_NEWER] = newer;
  i[SI.HAS_SNAPSHOT] = 1;
  i[SI.MAX_SPAN] = 43200;
  i[SI.MIN_SPAN] = 600;
  i[SI.INTERVAL] = 2;
  i[SI.OBSERVER_VALID] = 1;
  i.set(observer, SI.OBSERVER);
  i[SI.SNAPSHOT_OBSERVER_VALID] = 1;
  i.set(snapshotObserver, SI.SNAPSHOT_OBSERVER);
  i[SI.DRAWN_OBSERVER_VALID] = 1;
  i.set(drawnObserver, SI.DRAWN_OBSERVER);
}

test("a snapshot drawn for a far observer is stale, even while the next one is computed", async () => {
  const run = await schedule();
  const far = [2 * AU, 0, 0];
  const near = run((i) => base(i, { et: 300 }));
  assert.equal(near[SO.STALE], 0, "the drawn snapshot is this observer's");
  // The camera came back from 2 AU; the snapshot asked for out there is
  // still being computed (busy): the drawn one is not drawn.
  const busy = run((i) => { base(i, { et: 300, drawnObserver: far, snapshotObserver: far }); i[SI.BUSY] = 1; });
  assert.equal(busy[SO.STALE], 1);
  assert.equal(busy[SO.REQUEST], 0, "one snapshot at a time");
  const idle = run((i) => base(i, { et: 300, drawnObserver: far, snapshotObserver: far }));
  assert.equal(idle[SO.STALE], 1);
  assert.equal(idle[SO.REQUEST], 1, "a snapshot for this observer is asked for at once");
  assert.equal(idle[SO.JUMP], 1);
  assert.equal(idle[SO.TARGET], 300);
  // Asked for here, not yet drawn: still stale until it is.
  const asked = run((i) => { base(i, { et: 300, drawnObserver: far }); i[SI.BUSY] = 1; });
  assert.equal(asked[SO.STALE], 1);
});

test("a pair left 12 h apart by a fast run is refined to the present epoch once the clock stops", async () => {
  const run = await schedule();
  const fast = run((i) => base(i, { et: 20000, rate: 21600, older: 0, newer: 43200 }));
  assert.equal(fast[SO.REQUEST], 0, "at 21600x a 12 h pair is the spacing asked for");
  const stopped = run((i) => base(i, { et: 20000, rate: 0, older: 0, newer: 43200 }));
  assert.equal(stopped[SO.REQUEST], 1);
  assert.equal(stopped[SO.JUMP], 1);
  assert.equal(stopped[SO.TARGET], 20000);
  const fine = run((i) => base(i, { et: 300, rate: 0, older: 0, newer: 600 }));
  assert.equal(fine[SO.REQUEST], 0, "a 10 min pair is kept");
});
