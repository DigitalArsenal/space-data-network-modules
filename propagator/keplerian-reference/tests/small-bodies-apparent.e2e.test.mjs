// E2E for kepler_small_snapshot_apparent: asteroids drawn where they are SEEN
// (coordinator decision D1, 2026-10-13). Real Lowell astorb.dat records
// (tests/fixtures/astorb-apparent.fbs: 1, 3, 4, 7, 16, 433, 1862, 4179,
// 99942, 101955 as $SBD, cut from the 2026-10-12 astorb.dat.gz by
// data-source/lowell-astorb's own parse_astorb) through the built module,
// against JPL Horizons geocentric ICRF vectors with VEC_CORR LT+S (light time
// plus stellar aberration: the apparent direction referred to ICRF axes, the
// correction the bodies module applies to planets) at the element epoch and
// 30 days either side (tests/fixtures/horizons-apparent.json; the observer's
// heliocentric place and barycentric velocity and the Sun's barycentric
// velocity are Horizons' own, so only the module is under test).
//
// Measured on this fixture (round 2): every named asteroid within 0.76" at
// the three epochs; the geometric snapshot is 2.6" to 33.5" off the same
// references, which is the shift the apparent snapshot removes. Past +40 days
// Ceres and Psyche exceed 1" (1.06" and 1.0" at +40 d, 3.0" at +60 d) from
// the two-body propagation itself, not the corrections.
// Source credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA
// grant NAG5-4741 and the Lowell Observatory endowment); JPL Horizons.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const stream = fs.readFileSync(path.join(here, "fixtures", "astorb-apparent.fbs"));
const horizons = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-apparent.json"), "utf8"));
const ORDER = ["1", "3", "4", "7", "16", "433", "1862", "4179", "99942", "101955"];
// Eros, Psyche, Bennu and two more (Juno, Iris), plus Ceres and Vesta.
const NAMED = ["433", "16", "101955", "3", "7", "1", "4"];
const ARCSEC = 206264.80624709636;

async function load() {
  const wasi = new WASI({ version: "preview1", args: ["module"], env: {} });
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const x = instance.exports;
  const p = x.plugin_alloc(stream.length);
  new Uint8Array(x.memory.buffer, p, stream.length).set(stream);
  assert.equal(x.kepler_small_ingest_sbd_stream(p, stream.length), ORDER.length);
  return x;
}

function separation(a, b) {
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.min(1, cos)) * ARCSEC;
}

// The 10 doubles a host passes: Earth's heliocentric position, its and the
// Sun's barycentric velocity, and the epoch they hold at.
const observerOf = (o) => [...o.earth_helio_m, ...o.earth_ssb_velocity_ms, ...o.sun_ssb_velocity_ms, (o.jd_tdb - 2451545.0) * 86400];

function snapshot(x, exportName, observer, et) {
  const n = ORDER.length;
  const obs = x.plugin_alloc(80);
  const out = x.plugin_alloc(16 * n);
  new Float64Array(x.memory.buffer, obs, 10).set(observer);
  const failed = x[exportName](et, 0, n, obs, out);
  return { failed, rows: Float32Array.from(new Float32Array(x.memory.buffer, out, 4 * n)) };
}

test("D1: Eros, Psyche, Bennu, Juno, Iris (and Ceres, Vesta) within 1 arcsec of Horizons LT+S at three epochs within 30 days of the element epoch", async () => {
  const x = await load();
  const lines = [];
  let worst = 0;
  let worstGeometric = Infinity;
  for (const [k, o] of horizons.observer.entries()) {
    const et = (o.jd_tdb - 2451545.0) * 86400;
    const observer = observerOf(o);
    const apparent = snapshot(x, "kepler_small_snapshot_apparent", observer, et);
    const geometric = snapshot(x, "kepler_small_snapshot", observer, et);
    assert.equal(apparent.failed, 0);
    const cells = [];
    for (const id of NAMED) {
      const i = ORDER.indexOf(id);
      const ref = horizons.targets[id].apparent_geocentric_m[k];
      const a = [0, 1, 2].map((c) => apparent.rows[4 * i + c] - o.earth_helio_m[c]);
      const g = [0, 1, 2].map((c) => geometric.rows[4 * i + c] - o.earth_helio_m[c]);
      const da = separation(a, ref);
      const dg = separation(g, ref);
      worst = Math.max(worst, da);
      worstGeometric = Math.min(worstGeometric, dg);
      cells.push(`${id} ${da.toFixed(3)}" (geometric ${dg.toFixed(1)}")`);
      assert.ok(da < 1.0, `${id} at JD ${o.jd_tdb}: ${da.toFixed(3)}" from Horizons LT+S`);
      // The light-time distance is kept (the row is drawn at the right range).
      assert.ok(Math.abs(Math.hypot(...a) / Math.hypot(...ref) - 1) < 1e-5);
    }
    lines.push(`JD ${o.jd_tdb}: ${cells.join(", ")}`);
  }
  console.log(lines.join("\n"));
  console.log(`apparent worst ${worst.toFixed(3)}"; geometric at best ${worstGeometric.toFixed(1)}" off the same references`);
});

test("D1: the apparent row keeps V and refuses outside the validity span like the geometric one", async () => {
  const x = await load();
  const o = horizons.observer[1];
  const observer = observerOf(o);
  const n = ORDER.length;
  const et = (o.jd_tdb - 2451545.0) * 86400;
  const apparent = snapshot(x, "kepler_small_snapshot_apparent", observer, et);
  const geometric = snapshot(x, "kepler_small_snapshot", observer, et);
  assert.ok(Math.abs(apparent.rows[3] - geometric.rows[3]) < 0.01, `Ceres V ${apparent.rows[3]} vs ${geometric.rows[3]}`);
  assert.ok(Number.isFinite(apparent.rows[3]) && Number.isFinite(apparent.rows[7]), "V from each record's own H and G");
  const far = snapshot(x, "kepler_small_snapshot_apparent", observer, et + 400 * 86400);
  assert.equal(far.failed, n);
  assert.ok(Number.isNaN(far.rows[0]));
  const obs = x.plugin_alloc(80);
  const out = x.plugin_alloc(16 * n);
  assert.equal(x.kepler_small_snapshot_apparent(et, 0, n, 0, out), -3, "a null observer is refused");
  assert.equal(x.kepler_small_snapshot_apparent(et, 0, n + 1, obs, out), -2, "rows past the store are refused");
});

test("D1: a selected body's double-precision shift lands it on its apparent point (kepler_small_apparent_offset)", async () => {
  const x = await load();
  const o = horizons.observer[2];
  const observer = observerOf(o);
  const et = (o.jd_tdb - 2451545.0) * 86400;
  const apparent = snapshot(x, "kepler_small_snapshot_apparent", observer, et);
  const obs = x.plugin_alloc(80);
  const out = x.plugin_alloc(24);
  const state = x.plugin_alloc(48);
  new Float64Array(x.memory.buffer, obs, 10).set(observer);
  for (const id of NAMED) {
    const i = ORDER.indexOf(id);
    assert.equal(x.kepler_small_apparent_offset(et, i, obs, out), 0);
    const shift = Array.from(new Float64Array(x.memory.buffer, out, 3));
    assert.equal(x.kepler_small_state(et, i, state), 0);
    const s = new Float64Array(x.memory.buffer, state, 6);
    const drawn = [0, 1, 2].map((c) => s[c] + shift[c] - o.earth_helio_m[c]);
    const point = [0, 1, 2].map((c) => apparent.rows[4 * i + c] - o.earth_helio_m[c]);
    const ref = horizons.targets[id].apparent_geocentric_m[2];
    assert.ok(separation(drawn, point) < 0.05, `${id}: body vs point ${separation(drawn, point)}"`);
    assert.ok(separation(drawn, ref) < 1.0, `${id}: body vs Horizons ${separation(drawn, ref)}"`);
  }
  assert.equal(x.kepler_small_apparent_offset(et + 400 * 86400, 0, obs, out), -10);
});
