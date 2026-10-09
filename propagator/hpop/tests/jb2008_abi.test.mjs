// JB2008 on the resident plugin ABI: the label is published once its drivers
// are supplied (plugin_set_jb2008_indices), refused before, and the drag it
// reports reads every driver. The model itself is checked against Orekit in
// atmosphere_ports.test.mjs and on the execution path in
// orekit_reference.test.mjs (J1 cases); this checks the wiring.
import assert from "node:assert/strict";
import test from "node:test";

import { createHPOPPropagator } from "../index.js";

const JD = 2461254.5 + 0.3;
const BAD_ARGUMENT = -4, NOT_LOADED = -6, JB2008 = 4, NRLMSISE00 = 2;

test("JB2008 is refused until its drivers are set, then reads all of them", async (t) => {
  const plugin = await createHPOPPropagator();
  t.after(async () => { await plugin.destroy?.(); });
  const ex = plugin.exports;
  const put = (values) => {
    const ptr = ex.malloc(values.length * 8);
    new Float64Array(ex.memory.buffer, ptr, values.length).set(values);
    return ptr;
  };
  assert.equal(ex.plugin_init(), 0);
  const r = 6778.137, v = Math.sqrt(398600.4418 / r), inc = (51.6 * Math.PI) / 180;
  const statePtr = put([JD, r, 0, 0, 0, v * Math.cos(inc), v * Math.sin(inc)]);
  ex.plugin_set_state(statePtr);
  const forcePtr = put([398600.4418, 2, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1, 1, 2.2, 1.3]);
  ex.plugin_set_force_model(forcePtr);
  const apPtr = put([15, 15, 15, 15, 15, 15, 15]);
  ex.plugin_set_solar_activity(150, 150, apPtr);

  assert.equal(ex.plugin_get_atmosphere_model_status(JB2008), 1, "published");
  const cString = (p) => { const b = new Uint8Array(ex.memory.buffer); let e = p; while (b[e]) ++e; return new TextDecoder().decode(b.subarray(p, e)); };
  assert.match(cString(ex.plugin_get_atmosphere_model_provenance(JB2008)), /Jacchia-Bowman 2008/);
  assert.equal(ex.plugin_set_atmosphere_model(JB2008), NOT_LOADED, "refused without its drivers");

  const indices = [150, 150, 140, 140, 145, 145, 160, 160, 40];
  const ptr = put(indices);
  assert.equal(ex.plugin_set_jb2008_indices(ptr, 8), BAD_ARGUMENT);
  const bad = put([...indices.slice(0, 2), 0, ...indices.slice(3)]);
  assert.equal(ex.plugin_set_jb2008_indices(bad, 9), BAD_ARGUMENT, "a nonpositive index");
  assert.equal(ex.plugin_set_jb2008_indices(ptr, 9), 0);
  assert.equal(ex.plugin_set_atmosphere_model(JB2008), 0);

  const outPtr = ex.malloc(24 * 8);
  const drag = () => {
    assert.equal(ex.plugin_get_acceleration_breakdown(JD, outPtr), 0);
    return Array.from(new Float64Array(ex.memory.buffer, outPtr + 6 * 8, 3));
  };
  const norm = (a) => Math.hypot(...a);
  const base = drag();
  assert.ok(norm(base) > 1e-12 && Number.isFinite(norm(base)), `drag ${norm(base)} km/s^2`);
  // Each driver moves the density: the model is not reading F10.7 alone.
  for (const [k, name] of [[2, "S10"], [4, "M10"], [6, "Y10"], [8, "DSTDTC"]]) {
    const changed = indices.slice(); changed[k] += k === 8 ? 100 : 60;
    new Float64Array(ex.memory.buffer, ptr, 9).set(changed);
    assert.equal(ex.plugin_set_jb2008_indices(ptr, 9), 0);
    assert.ok(norm(drag()) > 1.01 * norm(base), `${name} raises the density`);
  }
  new Float64Array(ex.memory.buffer, ptr, 9).set(indices);
  assert.equal(ex.plugin_set_jb2008_indices(ptr, 9), 0);
  assert.deepEqual(drag(), base);
  // Not a substitution: NRLMSISE-00 on the same F10.7 answers differently,
  // within the factor the two models differ by at 400 km.
  assert.equal(ex.plugin_set_atmosphere_model(NRLMSISE00), 0);
  const msis = drag();
  assert.notDeepEqual(msis, base);
  assert.ok(norm(base) / norm(msis) > 0.5 && norm(base) / norm(msis) < 2, `JB2008/NRLMSISE-00 ${norm(base) / norm(msis)}`);
  for (const p of [statePtr, forcePtr, apPtr, ptr, bad, outPtr]) ex.free(p);
});
