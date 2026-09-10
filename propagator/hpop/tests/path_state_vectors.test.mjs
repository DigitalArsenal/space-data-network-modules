import test from 'node:test';
import assert from 'node:assert/strict';
import { createHPOPPropagator } from '../index.js';

// Seed identity is an independent closed-form case: at t0 the supplied ECEF
// state must be unchanged by native ECEF->GCRF->ECEF conversion. UTC JD,
// metres, m/s. A double UTC JD has ~40 microsecond spacing here; a fit
// boundary rounded by half that spacing moves this 7.5 km/s state ~0.16 m.
// 0.4 m / 1 mm/s bounds this time quantization plus polynomial fit error.
const epoch = 2460310.5;
const seed = [epoch, 7000000, 0, 0, 0, 7500, 1000];
test('HPOP native tracks preserve ECEF seed and match the single-state API', async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(() => plugin.destroy());
  const e = plugin.exports;
  e.plugin_init();
  const input = e.malloc(14 * 8), output = e.malloc(18 * 8), single = e.malloc(7 * 8);
  t.after(() => { e.free(input); e.free(output); e.free(single); });
  new Float64Array(e.memory.buffer, input, 14).set([...seed, ...new Array(7).fill(0)]);
  assert.equal(e.plugin_init_states_ecef(input, 2), 2);
  assert.equal(e.plugin_propagate_path_sv(0, epoch, 0, 1, output), 1);
  const first = Array.from(new Float64Array(e.memory.buffer, output, 6));
  first.forEach((v, k) => assert.ok(Math.abs(v - seed[k + 1]) < (k < 3 ? 0.4 : 1e-3)));
  for (const step of [60 / 86400, -60 / 86400, 0]) {
    assert.equal(e.plugin_propagate_path_sv(0, epoch, step, 3, output), 3);
    const track = Array.from(new Float64Array(e.memory.buffer, output, 18));
    for (let i = 0; i < 3; i++) {
      assert.equal(e.plugin_propagate(epoch + i * step, 0, single), 0);
      const state = new Float64Array(e.memory.buffer, single, 7);
      for (let k = 0; k < 6; k++) assert.ok(Math.abs(state[k + 1] - track[i * 6 + k]) < 1e-6);
    }
  }
  assert.equal(e.plugin_propagate_path_sv(1, epoch, 0, 1, output), 0);
  assert.equal(e.plugin_propagate(epoch, 1, single), -1);
  assert.equal(e.get_orbital_period(1), 0);
  assert.equal(e.plugin_propagate_path_sv(0, epoch, 0, 0, output), 0);
  assert.equal(e.plugin_propagate_path_sv(-1, epoch, 0, 1, output), 0);
  const mask = e.malloc(2);
  t.after(() => e.free(mask));
  new Uint8Array(e.memory.buffer, mask, 2).set([0, 1]);
  e.plugin_set_visibility_mask(mask, 2);
  assert.equal(e.plugin_ensure_coverage(epoch + 1, 0, 2), 0);
  assert.equal(e.plugin_eval_states(epoch, output, 2), 2);
  assert.deepEqual(Array.from(new Float64Array(e.memory.buffer, output, 12)), Array(12).fill(0));
  new Uint8Array(e.memory.buffer, mask, 2)[0] = 1;
  e.plugin_ensure_coverage(epoch + 120 / 86400, 0, 2);
  e.plugin_eval_states(epoch, output, 2);
  const evaluated = new Float64Array(e.memory.buffer, output, 12);
  evaluated.slice(0, 6).forEach((v, k) => assert.ok(Math.abs(v - first[k]) < 1e-6));
  assert.deepEqual(Array.from(evaluated.slice(6)), Array(6).fill(0));
});
