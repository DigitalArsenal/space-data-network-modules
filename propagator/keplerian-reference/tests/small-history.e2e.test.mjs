// E2E for keplerian-reference 1.8.1/1.8.2: a row's drawn place depends on the epoch
// asked for and nothing else. 1.8.0 replaced a row's elements in place from
// wherever the clock had last been, with a fixed 6-day RK4 step that was twice
// (3200) Phaethon's dynamical time at perihelion: after the clock visited
// -50 days, Phaethon brought back to its element epoch was 12,886 km off
// (verifier, 2026-10-14). Now the perturbed path runs on checkpoints keyed to
// the element epoch, each reached only from its neighbour toward the epoch,
// with the step refined near the Sun. 1.8.2 caches anchor checkpoints on the
// way out, so a run back toward the epoch restarts from the nearest one.
//   1. Bit-identical states and snapshots whatever the clock visited first
//      (the 1,004-row astorb sample and three low-perihelion asteroids).
//   2. The low-perihelion rows against JPL Horizons (geometric heliocentric
//      ICRF) at 11 epochs from -55 to +55 days, after any clock history.
// Rows: Lowell astorb.dat 2026-10-12 (epoch 2026-09-17.0 TDB) as $SBD:
// (3200) Phaethon q 0.140 AU, (137924) 2000 BD19 q 0.092 AU, (329915)
// 2005 MB q 0.204 AU. Lowell's 2005 MB orbit (computed 2025-08-02, CEU 0.46")
// is itself 2,192 km from JPL's at the element epoch, before any propagation,
// so it is held to history independence and to its epoch offset only.
// Credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA grant
// NAG5-4741 and the Lowell Observatory endowment).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadedExports } from "./threaded.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = fs.readFileSync(path.join(here, "..", "dist", "isomorphic", "module.wasm"));
const low = fs.readFileSync(path.join(here, "fixtures", "astorb-low-perihelion.fbs"));
const sample = fs.readFileSync(path.join(here, "fixtures", "astorb-sample.fbs"));
const horizons = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-low-perihelion.json"), "utf8"));
const EPOCH = horizons.element_epoch_et;
const DAY = 86400;

let x;
test.before(async () => {
  x = await threadedExports(wasm);
});
test.after(() => x?.harness?.destroy?.());

function ingest(bytes) {
  x.kepler_small_clear();
  const p = x.plugin_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
  const n = x.kepler_small_ingest_sbd_stream(p, bytes.length);
  x.plugin_free?.(p, bytes.length);
  assert.ok(n > 0, `ingest ${n}`);
  return n;
}

function state(index, et) {
  const out = x.plugin_alloc(48);
  const rc = x.kepler_small_state(et, index, out);
  const s = rc === 0 ? Array.from(new Float64Array(x.memory.buffer, out, 6)) : null;
  x.plugin_free?.(out, 48);
  return s;
}

function snapshot(count, et) {
  const out = x.plugin_alloc(16 * count);
  x.kepler_small_snapshot(et, 0, count, 0, out);
  const bytes = new Uint8Array(x.memory.buffer, out, 16 * count).slice();
  x.plugin_free?.(out, 16 * count);
  return bytes;
}

const HISTORIES = { fresh: [], "via -50 d": [-50], "via +55 d": [55], "via -55, +55, -3 d": [-55, 55, -3] };

test("a row's state at an epoch is bit-identical whatever epochs the clock visited before", () => {
  for (const [days, k] of horizons.days.map((d, i) => [d, i])) {
    const reference = [];
    for (const [name, visits] of Object.entries(HISTORIES)) {
      const n = ingest(low);
      for (const d of visits) for (let i = 0; i < n; i++) state(i, EPOCH + d * DAY);
      for (let i = 0; i < n; i++) {
        const s = state(i, EPOCH + days * DAY);
        assert.ok(s, `row ${i} at ${days} d`);
        if (name === "fresh") reference[i] = s;
        else assert.deepEqual(s, reference[i], `row ${i} at ${days} d ${name}`);
      }
    }
    assert.ok(k >= 0);
  }
});

test("a snapshot of the 1,004-row astorb sample is bit-identical after a -50 day excursion and return", () => {
  const n = ingest(sample);
  const fresh = snapshot(n, EPOCH + 27 * DAY);
  ingest(sample);
  snapshot(n, EPOCH - 50 * DAY);
  snapshot(n, EPOCH + 3 * DAY);
  const back = snapshot(n, EPOCH + 27 * DAY);
  assert.deepEqual(back, fresh);
});

test("a clock run back toward the epoch and across it draws what a fresh catalog draws at every epoch (1.8.2 anchored restarts)", () => {
  const n = ingest(sample);
  const days = [];
  for (let d = 58; d >= -58; d -= 1.5) days.push(d);
  const run = days.map((d) => snapshot(n, EPOCH + d * DAY));
  days.forEach((d, i) => {
    ingest(sample);
    assert.deepEqual(run[i], snapshot(n, EPOCH + d * DAY), `${d} d`);
  });
});

test("low-perihelion asteroids follow JPL Horizons within 300 km over +-55 days after any clock history (2005 MB: its epoch offset + 1,500 km)", () => {
  const lines = [];
  for (const [name, visits] of Object.entries(HISTORIES)) {
    const n = ingest(low);
    for (const d of visits) for (let i = 0; i < n; i++) state(i, EPOCH + d * DAY);
    horizons.rows.forEach((row, i) => {
      const errs = horizons.days.map((d, k) => {
        const s = state(i, EPOCH + d * DAY);
        const h = row.vectors[k];
        return Math.hypot(s[0] - h[0], s[1] - h[1], s[2] - h[2]) / 1e3;
      });
      const atEpoch = errs[horizons.days.indexOf(0)];
      const limit = row.number === 329915 ? atEpoch + 1500 : 300;
      lines.push(`${name.padEnd(20)} ${row.name.padEnd(9)} q ${row.q_au} AU: ${errs.map((e) => e.toFixed(0)).join(" ")} km (limit ${limit.toFixed(0)})`);
      for (const [k, e] of errs.entries()) assert.ok(e <= limit, `${row.name} ${horizons.days[k]} d ${name}: ${e.toFixed(1)} km`);
    });
  }
  console.log(`days ${horizons.days.join(" ")}\n${lines.join("\n")}`);
});
