/*
 * Orbit/label E2E through the shipped WASM and the resident scene surface.
 * States: DE440 excerpt, geometric ICRF, metres and m/s, 2026-07-01 00:00 TDB.
 * Epoch identity: <= 1e-6 m (roundoff only); ten-period closure: <= 1e-6
 * relative in position AND velocity (allows epoch subtraction roundoff).
 * Published sidereal periods: JPL SSD Astrodynamic Parameters
 * https://ssd.jpl.nasa.gov/astro_par.html — Moon 27.321661 d, Earth
 * 365.256363 d. Bounds 3% / 0.2% allow osculating vs mean orbital elements.
 * Scene: engine pointer-table layout from OrbPro's read-only
 * packages/orbpro-integration/propagator.solar-system-bodies/scene.js;
 * identity ICRF-to-Earth rotation is a camera fixture, not an Earth model.
 * All state propagation, projection and decluttering execute in WASM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const bsp = path.resolve(here, "../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp");
const et0 = (2461222.5 - 2451545.0) * 86400;
// NAIF gm_de440.tpc, https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc
// BODY10_GM = 1.32712440041279419E+11, BODY3_GM = 4.0350323562548019E+05,
// BODY399_GM = 3.9860043550702266E+05, BODY301_GM = 4.9028001184575496E+03
// in km^3/s^2. The module converts these caller-supplied values to SI.
const gmKernel = String.raw`KPL/PCK
\begindata
BODY10_GM = ( 1.32712440041279419E+11 )
BODY3_GM = ( 4.0350323562548019E+05 )
BODY399_GM = ( 3.9860043550702266E+05 )
BODY301_GM = ( 4.9028001184575496E+03 )
\begintext
`;

// Constant type-3 SPK records serialize independent states, not a JS orbit.
// NAIF SPK Required Reading, type 3: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html
// The zero Sun->SSB segment completes the chain at J2000 (outside DE440 excerpt).
function constantSpk(id, stateKm) {
  const bytes = Buffer.alloc(4096);
  bytes.write("DAF/SPK ", 0); bytes.write("LTL-IEEE", 88);
  for (const [at, value] of [[8, 2], [12, 6], [76, 2], [80, 2], [84, 409]]) bytes.writeInt32LE(value, at);
  bytes.writeDoubleLE(2, 1040);
  for (const [i, target, center, state] of [[0, 10, 0, [0, 0, 0, 0, 0, 0]], [1, id, 10, stateKm]]) {
    const summary = 1048 + 40 * i, start = 385 + 12 * i;
    bytes.writeDoubleLE(-1, summary); bytes.writeDoubleLE(1, summary + 8);
    [target, center, 1, 3, start, start + 11].forEach((v, k) => bytes.writeInt32LE(v, summary + 16 + 4 * k));
    [0, 1, ...state, -1, 2, 8, 1].forEach((v, k) => bytes.writeDoubleLE(v, (start - 1 + k) * 8));
  }
  return bytes;
}

test("DE440 osculating orbits and per-body labels through the shipped scene surface", async (t) => {
  // Missing committed kernels are errors, never skips or network downloads.
  assert.ok(fs.existsSync(bsp), `missing committed kernel: ${bsp}`);
  const temp = fs.mkdtempSync(path.join(here, ".orbits-labels-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const gm = path.join(temp, "gm_de440_subset.tpc");
  fs.writeFileSync(gm, gmKernel);
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(here, "../dist/isomorphic/module.wasm")),
    surface: "direct", maxThreads: 1, wasiThreadPoolSize: 1,
  });
  const x = harness.instance.exports;
  const mem = () => (harness.memory ?? x.memory).buffer;
  const load = (file) => {
    const bytes = fs.readFileSync(file), p = x.plugin_alloc(bytes.length);
    try {
      new Uint8Array(mem(), p, bytes.length).set(bytes);
      assert.ok(x.ssb_load_kernel(p, bytes.length) >= 0, `${file} loads`);
    } finally { x.plugin_free(p, bytes.length); }
  };
  const idp = x.plugin_alloc(4), statep = x.plugin_alloc(48);
  const statusp = x.plugin_alloc(4), conicp = x.plugin_alloc(56);
  t.after(async () => {
    for (const [p, size] of [[idp, 4], [statep, 48], [statusp, 4], [conicp, 56]]) x.plugin_free(p, size);
    await harness.destroy();
  });
  const conic = (id, center, et) => {
    assert.equal(x.ssb_osculating_state(et0, id, center, et, conicp), 0, `${id} about ${center} at ${et}`);
    return Array.from(new Float64Array(mem(), conicp, 7));
  };
  load(bsp);
  assert.equal(x.ssb_osculating_state(et0, 301, 399, et0, conicp), -14, "missing central GM is named");
  load(gm);
  new Int32Array(mem(), idp, 1)[0] = 301;
  assert.equal(x.ssb_states(et0, idp, 1, 399, statep, statusp), 0);
  assert.equal(new Int32Array(mem(), statusp, 1)[0], 0);
  const reference = Array.from(new Float64Array(mem(), statep, 6));
  const moon = conic(301, 399, et0), earth = conic(399, 10, et0);
  const epochError = Math.hypot(...moon.slice(0, 3).map((v, i) => v - reference[i]));
  assert.ok(epochError <= 1e-6, `Moon epoch position error ${epochError} m`);
  assert.deepEqual(moon.slice(0, 6), reference, "epoch state is bit-identical to ssb_states");
  assert.ok(Math.abs(moon[6] / (27.321661 * 86400) - 1) < 0.03, `Moon period ${moon[6] / 86400} d`);
  assert.ok(Math.abs(earth[6] / (365.256363 * 86400) - 1) < 0.002, `Earth period ${earth[6] / 86400} d`);
  let worstClosure = 0;
  for (const [id, center, start] of [[301, 399, moon], [399, 10, earth]]) {
    for (const direction of [-1, 1]) {
      const end = conic(id, center, et0 + direction * 10 * start[6]);
      for (const offset of [0, 3]) {
        const relative = Math.hypot(...end.slice(offset, offset + 3).map((v, k) => v - start[offset + k])) /
          Math.hypot(...start.slice(offset, offset + 3));
        worstClosure = Math.max(worstClosure, relative);
        assert.ok(relative <= 1e-6, `${id}: ten-period ${offset === 0 ? "position" : "velocity"} closure ${relative}`);
      }
    }
  }
  assert.equal(x.ssb_osculating_state(et0 - 1000 * 86400, 301, 399, et0, conicp), -5);
  assert.equal(x.ssb_osculating_state(et0, 123456, 399, et0, conicp), -8);
  assert.equal(x.ssb_osculating_state(et0, 501, 399, et0, conicp), -9);

  // Same pointer slots and per-body arrays as BodyScene; WASM owns every frame.
  const layout = x.ssb_scene_resize(2, 0);
  const view = (Type, slot, count) => new Type(mem(), new Uint32Array(mem(), layout, 33)[slot], count);
  const params = () => view(Float64Array, 2, 128);
  const flags = () => view(Int32Array, 5, 2);
  const drawFlags = () => Array.from(view(Int32Array, 25, 2));
  const P = { CENTRAL: 2, CAM_POS: 11, EARTH_ROT: 24, FOVY: 33, BUFFER_HEIGHT: 34,
    MIN_PIXELS: 35, DRAW_POINTS: 36, SHOW_LABELS: 37, PICK_PASS: 38,
    WIDTH: 39, HEIGHT: 40, VIEW: 41, PROJECTION: 57 };
  const F_SHOW = 2, F_NO_LABEL = 8, D_LABEL_SET = 8, D_LABEL_SHOW = 16;
  view(Int32Array, 4, 2).set([399, 301]);
  flags().fill(F_SHOW);
  view(Int32Array, 6, 2).set([1, 2]); // planet then moon: Earth wins declutter priority
  view(Int32Array, 7, 2).set([-1, 0]);
  view(Float64Array, 8, 6).set([6378137, 6378137, 6356752, 1737400, 1737400, 1737400]);
  params()[0] = 2461222; params()[1] = 43200 - 32.184; // near et0; TAI -> TDB is WASM's
  params()[P.CENTRAL] = 0;
  params().set([0, 0, 1e10], P.CAM_POS);
  params().set([1, 0, 0, 0, 1, 0, 0, 0, 1], P.EARTH_ROT);
  params()[P.FOVY] = Math.PI / 2;
  params()[P.BUFFER_HEIGHT] = params()[P.HEIGHT] = 800;
  params()[P.WIDTH] = 800;
  params()[P.MIN_PIXELS] = 20;
  params()[P.DRAW_POINTS] = params()[P.SHOW_LABELS] = params()[P.PICK_PASS] = 1;
  params().set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1e10, 1], P.VIEW);
  params().set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -2, 0], P.PROJECTION);
  assert.equal(x.ssb_scene_frame(), 1);
  assert.deepEqual(Array.from(view(Int32Array, 14, 2)), [0, 0]);
  x.ssb_scene_place();
  const draw = () => { x.ssb_scene_draw(); x.ssb_scene_declutter(); return drawFlags(); };
  draw(); // prime movement flags
  const baseline = draw();
  assert.equal(baseline[0] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET | D_LABEL_SHOW);
  assert.equal(baseline[1] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET, "Earth declutters Moon");
  flags()[0] |= F_NO_LABEL;
  x.ssb_scene_draw();
  assert.equal(drawFlags()[0] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET, "hidden before declutter too");
  x.ssb_scene_declutter();
  const hidden = drawFlags();
  assert.equal(hidden[0] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET);
  assert.equal(hidden[1] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET | D_LABEL_SHOW, "Earth frees its 36 px slot for Moon");
  for (let i = 0; i < 2; ++i) assert.equal(hidden[i] & ~(D_LABEL_SET | D_LABEL_SHOW), baseline[i] & ~(D_LABEL_SET | D_LABEL_SHOW), "point, pick and ellipsoid unchanged");
  params()[P.PICK_PASS] = 0;
  for (let frame = 0; frame < 4; ++frame) {
    x.ssb_scene_draw();
    assert.equal(drawFlags()[0] & (D_LABEL_SET | D_LABEL_SHOW), D_LABEL_SET, `hidden on frame ${frame}, including non-declutter frames`);
    if (view(Float64Array, 3, 256)[139]) x.ssb_scene_declutter();
  }
  params()[P.PICK_PASS] = 1;
  flags()[0] = F_SHOW;
  assert.deepEqual(draw(), baseline, "clearing the flag restores the exact previous draw flags");
  params()[P.SHOW_LABELS] = 0;
  assert.ok(draw().every((f) => (f & (D_LABEL_SET | D_LABEL_SHOW)) === D_LABEL_SET), "master labels off still hides both");
  console.log(`Moon epoch error: ${epochError} m; periods: Moon ${(moon[6] / 86400).toFixed(9)} d, Earth ${(earth[6] / 86400).toFixed(9)} d`);
  console.log(`Ten-period closure (both directions, position/velocity): ${worstClosure.toExponential(3)} relative`);
  console.log("Scene: Earth label on => Moon hidden; F_NO_LABEL => Earth hidden every frame, Moon shown; clearing flag restores baseline");

  // Independent closed forms in ICRF SI at J2000 TDB, roundoff bound 1e-9
  // relative per component (1e-6 m / 1e-9 m/s absolute floors at zeros).
  // Barker: mu=1e9, q=2000, D=1 => dt=16/3, r=(0,4000), v=(-500,500).
  // Hyperbola: mu=1.5e9, q=1000, a=-1500, e=5/3, H=ln(2):
  // dt=1.875-1.5*ln(2), r=(625,1500), v=(-9000/13,20000/13).
  // A missing asteroid GM uses only the Sun; missing Mars GM uses BODY4_GM.
  for (const [name, id, gmText, initial, dt, expected] of [
    ["parabolic", 2000001, "BODY10_GM = ( 1 )", [2, 0, 0, 0, 1, 0], 5.333333333333333,
      [0, 4000, 0, -500, 500, 0]],
    ["hyperbolic", 2000001, "BODY10_GM = ( 1.5 )", [1, 0, 0, 0, 2, 0], 0.835279229160082,
      [625, 1500, 0, -692.3076923076923, 1538.4615384615386, 0]],
    ["planet GM fallback", 499, "BODY10_GM = ( 1 )\nBODY4_GM = ( 0.5 )", [1, 0, 0, 0, 2, 0], 0.835279229160082,
      [625, 1500, 0, -692.3076923076923, 1538.4615384615386, 0]],
    ["loaded noncatalog body", 2000433, "BODY10_GM = ( 1.5 )", [1, 0, 0, 0, 2, 0], 0.835279229160082,
      [625, 1500, 0, -692.3076923076923, 1538.4615384615386, 0]],
  ]) {
    x.ssb_reset();
    const synthetic = path.join(temp, "closed-form.bsp");
    fs.writeFileSync(synthetic, constantSpk(id, initial));
    fs.writeFileSync(gm, `KPL/PCK\n\\begindata\n${gmText}\n\\begintext\n`);
    load(synthetic); load(gm);
    for (const sign of [-1, 1]) {
      assert.equal(x.ssb_osculating_state(0, id, 10, sign * dt, conicp), 0, name);
      const actual = Array.from(new Float64Array(mem(), conicp, 7));
      assert.ok(Number.isNaN(actual[6]), `${name} period is NaN`);
      expected.forEach((v, k) => {
        const reference = k === 1 || k === 3 ? sign * v : v;
        const tolerance = Math.max(k < 3 ? 1e-6 : 1e-9, Math.abs(reference) * 1e-9);
        assert.ok(Math.abs(actual[k] - reference) <= tolerance, `${name} sign ${sign} component ${k}: ${actual[k]} vs ${reference}`);
      });
    }
    if (name === "parabolic") {
      // Same Barker closed form at D=1000: t=4(D+D^3/3), x=q(1-D^2),
      // y=2qD, vx=-1000D/(1+D^2), vy=1000/(1+D^2), ~42-year open arc.
      const expectedLong = [-1999998000, 4000000, 0, -0.999999000001, 0.000999999000001, 0];
      for (const sign of [-1, 1]) {
        assert.equal(x.ssb_osculating_state(0, id, 10, sign * 1333337333.3333333, conicp), 0);
        const actual = Array.from(new Float64Array(mem(), conicp, 7));
        assert.ok(Number.isNaN(actual[6]));
        for (const offset of [0, 3]) {
          const ref = expectedLong.slice(offset, offset + 3).map((v, k) => offset + k === 1 || offset + k === 3 ? sign * v : v);
          const error = Math.hypot(...actual.slice(offset, offset + 3).map((v, k) => v - ref[k])) / Math.hypot(...ref);
          assert.ok(error < 1e-8, `long parabolic arc ${offset}: relative error ${error}`); // accumulated roundoff margin
        }
      }
    }
  }
  console.log("Closed-form parabolic/hyperbolic arcs and 42-year parabolic arcs pass in both directions; absent body GM and planet barycenter GM fallback pass");
});
