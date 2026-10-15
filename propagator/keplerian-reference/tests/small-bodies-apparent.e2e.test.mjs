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
// The rows follow their perturbed paths (the module's small_rebase: Encke
// under the Sun and the eight planets), not two-body conics, so the 1" holds to
// the edges of the 60-day span.
// Source credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA
// grant NAG5-4741 and the Lowell Observatory endowment); JPL Horizons.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadedExports } from "./threaded.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const stream = fs.readFileSync(path.join(here, "fixtures", "astorb-apparent.fbs"));
const horizons = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-apparent.json"), "utf8"));
const ORDER = ["1", "3", "4", "7", "16", "433", "1862", "4179", "99942", "101955"];
// Eros, Psyche, Bennu and two more (Juno, Iris), plus Ceres and Vesta.
const NAMED = ["433", "16", "101955", "3", "7", "1", "4"];
const ARCSEC = 206264.80624709636;

async function load() {
  const x = await threadedExports(fs.readFileSync(wasmPath));
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

// The whole validity span (coordinator D1: 1" at three epochs within 60 days,
// no waiver): eleven real astorb rows (tests/fixtures/astorb-edges.fbs: the
// seven above plus 1036 Ganymed, 1862 Apollo, 4179 Toutatis and 99942 Apophis,
// cut the same way) against Horizons LT+S at the element epoch, +-30, +-45 and
// +-59.5 days (tests/fixtures/horizons-edges.json, fetched 2026-10-13). Two
// loads: one asked each epoch straight from the element epoch, one walked
// through them in order (the console's rebase as its clock runs and jumps).
// Measured: worst 0.79" (Vesta at +30 d, already 0.75" at the element epoch:
// astorb's orbit against JPL's); Psyche 0.10" at +45 d and 0.12" at +59.5 d
// (1.44" and 3.0" on two-body alone).
const edgesStream = fs.readFileSync(path.join(here, "fixtures", "astorb-edges.fbs"));
const edges = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-edges.json"), "utf8"));
const EDGE_ORDER = ["1", "3", "4", "7", "16", "433", "1036", "1862", "4179", "99942", "101955"];
async function loadEdges() {
  const x = await threadedExports(fs.readFileSync(wasmPath));
  const p = x.plugin_alloc(edgesStream.length);
  new Uint8Array(x.memory.buffer, p, edgesStream.length).set(edgesStream);
  assert.equal(x.kepler_small_ingest_sbd_stream(p, edgesStream.length), EDGE_ORDER.length);
  return x;
}

test("D1: eleven asteroids within 1 arcsec of Horizons LT+S across the whole +-60 day span (perturbed path, not two-body)", async () => {
  const walked = await loadEdges();
  const lines = [];
  let worst = 0;
  for (const [k, o] of edges.observer.entries()) {
    const et = (o.jd_tdb - 2451545.0) * 86400;
    const days = o.jd_tdb - 2461300.5;
    const direct = await loadEdges();
    for (const [label, x] of [["direct", direct], ["walked", walked]]) {
      const n = EDGE_ORDER.length;
      const obs = x.plugin_alloc(80);
      const out = x.plugin_alloc(16 * n);
      new Float64Array(x.memory.buffer, obs, 10).set(observerOf(o));
      assert.equal(x.kepler_small_snapshot_apparent(et, 0, n, obs, out), 0, `${label} at ${days} d`);
      const rows = new Float32Array(x.memory.buffer, out, 4 * n);
      const cells = [];
      for (const id of Object.keys(edges.targets)) {
        const i = EDGE_ORDER.indexOf(id);
        const a = [0, 1, 2].map((c) => rows[4 * i + c] - o.earth_helio_m[c]);
        const d = separation(a, edges.targets[id].apparent_geocentric_m[k]);
        worst = Math.max(worst, d);
        cells.push(`${id} ${d.toFixed(2)}"`);
        assert.ok(d < 1.0, `${label}: ${id} at ${days} d: ${d.toFixed(3)}" from Horizons LT+S`);
      }
      if (label === "direct") lines.push(`${days >= 0 ? "+" : ""}${days} d: ${cells.join(", ")}`);
    }
  }
  console.log(lines.join("\n"));
  console.log(`worst ${worst.toFixed(3)}"`);
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
