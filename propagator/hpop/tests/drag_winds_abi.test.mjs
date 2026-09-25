// HWM14 winds through the legacy plugin ABI of the built artifact:
// plugin_set_drag_options(includeWinds, coRotating) with 0 off, 1 total and
// 2 quiet time, and the 3-hour ap from plugin_set_solar_activity ap_a[1].
import assert from "node:assert/strict";
import test from "node:test";

import { createHPOPPropagator } from "../index.js";

const JD = 2460000.5 + 0.3;  // 2023-02-24 07:12 UT
const BAD_ARGUMENT = -4;

test("HWM14 winds change drag through the plugin ABI, independent of call order", async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(async () => {
    await plugin.destroy?.();
  });
  const ex = plugin.exports;
  const put = (values) => {
    const ptr = ex.malloc(values.length * 8);
    new Float64Array(ex.memory.buffer, ptr, values.length).set(values);
    return ptr;
  };
  assert.equal(ex.plugin_init(), 0);

  // 400 km circular orbit at 51.6 deg inclination.
  const r = 6778.137, v = Math.sqrt(398600.4418 / r), inc = (51.6 * Math.PI) / 180;
  const statePtr = put([JD, r, 0, 0, 0, v * Math.cos(inc), v * Math.sin(inc)]);
  ex.plugin_set_state(statePtr);
  // [mu, gravDeg, gravOrd, J2, J3, J4, drag, SRP, Sun, Moon, mass, dragArea, srpArea, Cd, Cr]
  const forcePtr = put([398600.4418, 2, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1, 1, 2.2, 1.3]);
  ex.plugin_set_force_model(forcePtr);
  assert.equal(ex.plugin_set_atmosphere_model(2), 0, "NRLMSISE-00");

  const apPtr = ex.malloc(7 * 8);
  const setAp = (ap3h) => {
    new Float64Array(ex.memory.buffer, apPtr, 7).set([15, ap3h, 15, 15, 15, 15, 15]);
    ex.plugin_set_solar_activity(150, 150, apPtr);
  };
  const outPtr = ex.malloc(24 * 8);
  const drag = () => {
    assert.equal(ex.plugin_get_acceleration_breakdown(JD, outPtr), 0);
    return Array.from(new Float64Array(ex.memory.buffer, outPtr + 6 * 8, 3));
  };
  const norm = (a) => Math.hypot(...a);
  const diff = (a, b) => norm(a.map((x, i) => x - b[i]));

  setAp(80);
  assert.equal(ex.plugin_set_drag_options(0, 1), 0);
  const none = drag();
  assert.ok(norm(none) > 0, "drag is active");
  assert.equal(ex.plugin_set_drag_options(1, 1), 0);
  const total = drag();
  assert.equal(ex.plugin_set_drag_options(2, 1), 0);
  const quiet = drag();

  assert.ok(diff(total, none) > 1e-6 * norm(none), "total winds change drag");
  assert.ok(diff(quiet, none) > 1e-6 * norm(none), "quiet-time winds change drag");
  assert.ok(diff(total, quiet) > 0, "the ap = 80 disturbance wind is applied");

  // Mode 1 with a negative 3-hour ap is quiet time (HWM14's convention), in
  // either order of the two setters.
  assert.equal(ex.plugin_set_drag_options(1, 1), 0);
  setAp(-1);
  assert.deepEqual(drag(), quiet);
  setAp(80);
  assert.deepEqual(drag(), total);
  setAp(-1);
  assert.equal(ex.plugin_set_drag_options(1, 1), 0);
  assert.deepEqual(drag(), quiet);

  assert.equal(ex.plugin_set_drag_options(3, 1), BAD_ARGUMENT);
  assert.equal(ex.plugin_set_drag_options(-1, 1), BAD_ARGUMENT);
  for (const p of [statePtr, forcePtr, apPtr, outPtr]) ex.free(p);
});
