/**
 * plugin_propagate_all_positions — batch native entry point tests.
 *
 * One WASM call propagates EVERY initialized entity to a shared Julian date
 * and writes a contiguous positions-only buffer ([x,y,z] float64 ECEF meters
 * per entity, indexed by entity index). Mirrors the SGP4 plugin's
 * plugin_propagate_all_positions ABI so host-side per-entity loops die.
 *
 * Parity requirement: the batch buffer must match per-entity
 * plugin_propagate() output exactly (same Chebyshev ephemeris, same
 * GCRF→ECEF rotation for the shared epoch).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHPOPPropagator } from "../index.js";

const JD0 = 2460000.5;
const MU_EARTH = 398600.4418; // km^3/s^2

/** Build a synthetic constellation of circular-ish LEO/MEO states. */
function buildStates(count) {
  const states = new Float64Array(count * 7);
  for (let i = 0; i < count; i++) {
    const radius = 6778.0 + (i % 16) * 450.0; // 6778..13528 km
    const inc = ((i * 7) % 180) * (Math.PI / 180);
    const raan = ((i * 23) % 360) * (Math.PI / 180);
    const speed = Math.sqrt(MU_EARTH / radius);

    // Position at ascending node, velocity inclined by `inc`.
    const px = radius * Math.cos(raan);
    const py = radius * Math.sin(raan);
    const pz = 0.0;
    const vx = -speed * Math.sin(raan) * Math.cos(inc);
    const vy = speed * Math.cos(raan) * Math.cos(inc);
    const vz = speed * Math.sin(inc);

    states[i * 7 + 0] = JD0;
    states[i * 7 + 1] = px;
    states[i * 7 + 2] = py;
    states[i * 7 + 3] = pz;
    states[i * 7 + 4] = vx;
    states[i * 7 + 5] = vy;
    states[i * 7 + 6] = vz;
  }
  return states;
}

function f64View(exports, ptr, length) {
  return new Float64Array(exports.memory.buffer, ptr, length);
}

test("batch propagate_all_positions matches per-entity plugin_propagate", async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(async () => {
    await plugin.destroy?.();
  });

  const ex = plugin.exports;
  assert.equal(
    typeof ex.plugin_propagate_all_positions,
    "function",
    "batch export must exist on the built artifact",
  );

  assert.equal(ex.plugin_init(), 0);

  const COUNT = 64;
  const states = buildStates(COUNT);
  const statesPtr = ex.malloc(states.byteLength);
  f64View(ex, statesPtr, COUNT * 7).set(states);
  assert.equal(ex.plugin_init_states(statesPtr, COUNT), COUNT);
  ex.free(statesPtr);
  assert.equal(ex.get_entity_count(), COUNT);

  const batchPtr = ex.malloc(COUNT * 3 * 8);
  const singlePtr = ex.malloc(7 * 8);

  // Multiple epochs: fresh Chebyshev builds AND cache-hit evaluations.
  const epochs = [JD0 + 0.005, JD0 + 0.01, JD0 + 0.0075];
  let maxDelta = 0;
  let comparisons = 0;

  for (const jd of epochs) {
    const written = ex.plugin_propagate_all_positions(jd, batchPtr, COUNT);
    assert.equal(written, COUNT, `batch must write all ${COUNT} entities`);

    // Snapshot batch output BEFORE the per-entity calls (views can detach on
    // memory growth; per-entity calls reuse the same caches so order is safe).
    const batchOut = Array.from(f64View(ex, batchPtr, COUNT * 3));

    for (let i = 0; i < COUNT; i++) {
      const rc = ex.plugin_propagate(jd, i, singlePtr);
      assert.equal(rc, 0, `plugin_propagate(${i}) must succeed`);
      const single = f64View(ex, singlePtr, 7);
      for (let k = 0; k < 3; k++) {
        const delta = Math.abs(batchOut[i * 3 + k] - single[1 + k]);
        if (delta > maxDelta) maxDelta = delta;
        comparisons++;
      }
      // Sanity: position magnitude is orbital, not garbage.
      const r = Math.hypot(single[1], single[2], single[3]);
      assert.ok(
        r > 6.3e6 && r < 1.5e7,
        `entity ${i} radius sane (got ${r} m)`,
      );
    }
  }

  console.log(
    `batch-vs-per-entity parity: ${comparisons} coordinate comparisons over ` +
      `${epochs.length} epochs x ${COUNT} entities, max |delta| = ${maxDelta} m`,
  );
  assert.ok(
    maxDelta <= 1e-6,
    `batch and per-entity positions must agree (max delta ${maxDelta} m)`,
  );

  ex.free(singlePtr);
  ex.free(batchPtr);
});

test("batch propagate_all_positions honors max_count and empty state", async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(async () => {
    await plugin.destroy?.();
  });

  const ex = plugin.exports;
  assert.equal(ex.plugin_init(), 0);

  const outPtr = ex.malloc(8 * 3 * 8);

  // No entities initialized → nothing written.
  assert.equal(ex.plugin_propagate_all_positions(JD0, outPtr, 8), 0);

  const COUNT = 8;
  const states = buildStates(COUNT);
  const statesPtr = ex.malloc(states.byteLength);
  f64View(ex, statesPtr, COUNT * 7).set(states);
  assert.equal(ex.plugin_init_states(statesPtr, COUNT), COUNT);
  ex.free(statesPtr);

  // max_count clamps the write.
  assert.equal(ex.plugin_propagate_all_positions(JD0 + 0.001, outPtr, 3), 3);
  // Zero/negative max_count is a no-op.
  assert.equal(ex.plugin_propagate_all_positions(JD0 + 0.001, outPtr, 0), 0);

  ex.free(outPtr);
});
