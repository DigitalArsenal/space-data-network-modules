// The sky observer of a camera at rest in the central body's frame
// (ssb_observer, corotating): the body's own velocity plus omega x r, no
// faster than the body's synchronous orbit, |omega| (GM / omega^2)^(1/3).
//
//   SSB_KERNELS_DIR=<dir with the shards from tools/build_kernels.py>
//   node --test tests/observer_state.e2e.test.mjs
//
// Owner 2026-10-16: zooming out with the Sun central, the planets slid tens of
// au across the screen and snapped back at 1e14 m. The body-fixed speed of a
// camera 1e13 m from the Sun was 2.45e7 m/s (0.08 c) and 7.7e7 m/s at 3e13 m,
// and the stellar aberration of the drawn places followed it. Checked here:
//  - inside the synchronous radius nothing changes: Earth's surface and GEO
//    get exactly omega x r (to 1e-9 relative);
//  - beyond it the added speed is the synchronous orbit's, for the Sun, Earth
//    and Jupiter, from r_s out to the Hill radius (1e14 m for the Sun; past a
//    planet's Hill radius the observer's whole velocity eases to rest, which
//    is not this rule); GM is read from the same gm_de440
//    the module is given, omega from the module's own rotation;
//  - the aberration that speed can cause stays under a pixel of a 60 degree,
//    720 px view (300" a pixel) for every central body of the table.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const kernelsDir = process.env.SSB_KERNELS_DIR;
const ready = kernelsDir && fs.existsSync(path.join(kernelsDir ?? "", "gm_de440.tpc"));

const BODIES = [10, 199, 299, 399, 301, 499, 401, 402, 599, 501, 502, 503, 504, 699, 601, 602, 603, 604, 605, 606, 608,
  799, 705, 701, 702, 703, 704, 899, 801, 999, 901, 2000001, 2000004];
const C = 299792458;

function kernelFiles() {
  const names = fs.readdirSync(kernelsDir);
  const text = ["pck00011.tpc", "gm_de440.tpc", "moon_de440_250416.tf"].filter((n) => names.includes(n));
  const daf = names.filter((n) => /\.(bsp|bpc)$/.test(n)).sort();
  return [...text, ...daf].map((n) => path.join(kernelsDir, n));
}

/** BODYnnn_GM (km^3/s^2) from the text kernel, as m^3/s^2. */
function gmOf(id) {
  const text = fs.readFileSync(path.join(kernelsDir, "gm_de440.tpc"), "utf8");
  const m = text.match(new RegExp(`BODY${id}_GM\\s*=\\s*\\(\\s*([-+0-9.EeDd]+)`));
  assert.ok(m, `GM of ${id}`);
  return Number(m[1].replace(/[Dd]/, "E")) * 1e9;
}

async function loadModule(files) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), surface: "direct" });
  const x = harness.instance.exports;
  const mem = () => (harness.memory ?? x.memory).buffer;
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const p = x.plugin_alloc(bytes.length);
    new Uint8Array(mem(), p, bytes.length).set(bytes);
    assert.ok(x.ssb_load_kernel(p, bytes.length) >= 0, `${path.basename(file)} refused`);
    x.plugin_free(p, bytes.length);
  }
  return { x, mem };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => Math.hypot(...v);

test("a body-fixed camera moves no faster than the body's synchronous orbit", { skip: !ready && "SSB_KERNELS_DIR not available" }, async () => {
  const { x, mem } = await loadModule(kernelFiles());
  const et = (2461329.5 - 2451545.0) * 86400; // 2026-10-16 TDB
  const ids = x.plugin_alloc(4), rot = x.plugin_alloc(80), st = x.plugin_alloc(4), state = x.plugin_alloc(48);
  const cam = x.plugin_alloc(48), out = x.plugin_alloc(48);
  const bodyOf = (id) => {
    new Int32Array(mem(), ids, 1)[0] = id;
    x.ssb_orientations(et, ids, 1, rot, st);
    const r = Array.from(new Float64Array(mem(), rot, 10));
    x.ssb_states(et, ids, 1, 0, state, st);
    return { pole: [r[6], r[7], r[8]], spin: r[9], vel: Array.from(new Float64Array(mem(), state, 6)).slice(3) };
  };
  /** The speed ssb_observer adds to the body's own velocity for a camera at p (ICRF, m from the body). */
  const added = (id, p, body) => {
    new Float64Array(mem(), cam, 6).set([...p, 0, 0, 0]);
    assert.equal(x.ssb_observer(et, id, cam, 1, out), 0, `observer at ${id}`);
    const v = Array.from(new Float64Array(mem(), out, 6)).slice(3);
    return v.map((c, i) => c - body.vel[i]);
  };
  /** A direction in the equator (perpendicular to the pole), so |omega x r| = |omega| r. */
  const equatorial = (pole) => {
    const e = cross(pole, [0, 0, 1]);
    const n = norm(e);
    return e.map((c) => c / n);
  };

  // Earth: the surface and GEO are exactly omega x r.
  const earth = bodyOf(399);
  const eq = equatorial(earth.pole);
  for (const r of [6378137, 42164000]) {
    const p = eq.map((c) => c * r);
    const want = cross(earth.pole.map((c) => c * earth.spin), p);
    const got = added(399, p, earth);
    const d = norm(got.map((c, i) => c - want[i])) / norm(want);
    assert.ok(d < 1e-9, `Earth at ${r} m: ${d} from omega x r`);
  }

  // The Sun, Earth, Jupiter: from r_s out to 1e14 m the added speed is |omega| r_s.
  const plateaus = {};
  for (const id of [10, 399, 599]) {
    const b = bodyOf(id);
    const rs = Math.cbrt(gmOf(id) / (b.spin * b.spin));
    const cap = Math.abs(b.spin) * rs;
    plateaus[id] = { rs, cap };
    const e = equatorial(b.pole);
    for (const k of [0.5, 0.999]) {
      const r = k * rs, got = norm(added(id, e.map((c) => c * r), b));
      assert.ok(Math.abs(got - Math.abs(b.spin) * r) <= 1e-9 * got, `${id} inside r_s (${k}): ${got}`);
    }
    const hill = x.ssb_hill_radius(et, id);
    for (const r of [1.001 * rs, 10 * rs, 1e12, 1e13, 3e13, 9.9e13].filter((r) => r > rs && r < hill)) {
      const got = norm(added(id, e.map((c) => c * r), b));
      assert.ok(Math.abs(got - cap) <= 1e-9 * cap, `${id} at ${r.toExponential(2)} m: ${got} m/s, cap ${cap}`);
    }
  }
  // The Sun's two measured points from the bug report, and the plateau's size.
  assert.ok(plateaus[10].cap < 1e5 && plateaus[10].cap > 5e4, `Sun cap ${plateaus[10].cap}`);
  assert.ok(Math.abs(plateaus[399].rs - 42164e3) < 1e3, `Earth r_s ${plateaus[399].rs} m is GEO`);

  // Every central body: the aberration the capped speed can cause, under a pixel (300").
  let worst = { id: 0, arcsec: 0 };
  for (const id of BODIES) {
    const b = bodyOf(id);
    const e = equatorial(b.pole);
    let maxSpeed = 0;
    const hill = x.ssb_hill_radius(et, id);
    for (const r of [1e5, 1e7, 1e9, 1e11, 1e13, 9.9e13].filter((r) => r < hill)) maxSpeed = Math.max(maxSpeed, norm(added(id, e.map((c) => c * r), b)));
    const arcsec = (maxSpeed / C) * 206264.806;
    if (arcsec > worst.arcsec) worst = { id, arcsec };
    assert.ok(arcsec < 300, `${id}: co-rotation aberration up to ${arcsec}"`);
  }
  console.log(`synchronous caps: Sun ${plateaus[10].cap.toFixed(0)} m/s at ${(plateaus[10].rs / 1.495978707e11).toFixed(3)} au, Earth ${plateaus[399].cap.toFixed(1)} m/s at ${(plateaus[399].rs / 1e3).toFixed(0)} km, Jupiter ${plateaus[599].cap.toFixed(0)} m/s; worst co-rotation aberration ${worst.arcsec.toFixed(1)}" (body ${worst.id})`);
});
