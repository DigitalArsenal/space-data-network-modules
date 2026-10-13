// E2E for the small-body path (kepler_small_*): real Lowell astorb.dat
// records as SDS $SBD small-body records (tests/fixtures/astorb-sample.fbs,
// 1,004 numbered asteroids cut from the 2026-10-12 astorb.dat.gz by
// data-source/lowell-astorb's own parse_astorb) through the built
// module, against
//   1. a test-only two-body oracle written independently below (A8: within
//      1 m for every row, double and float32 snapshot paths);
//   2. JPL Horizons heliocentric ICRF vectors 30 days either side of the
//      element epoch along the perturbed path (A8: median within 300 km,
//      worst within 2,000 km; values printed);
//   3. the named refusals.
// Source credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA
// grant NAG5-4741 and the Lowell Observatory endowment).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const stream = fs.readFileSync(path.join(here, "fixtures", "astorb-sample.fbs"));
const records = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "astorb-sample.json"), "utf8"));
const horizons = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-astorb-sample.json"), "utf8"));

async function load() {
  const wasi = new WASI({ version: "preview1", args: ["module"], env: {} });
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const x = instance.exports;
  const copyIn = (bytes) => {
    const p = x.plugin_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
    return p;
  };
  return { x, copyIn };
}

// ---- test-only oracle: two-body from the catalog's own numbers ----
const DEG = Math.PI / 180;
const AU = 149597870.7e3;
const GM_SUN = 1.3271244004127942e20;
const EPS = (84381.448 / 3600) * DEG;
const SECONDS_PER_DAY = 86400;

function jdOfIso(iso) {
  const [date] = iso.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000 + 2440587.5;
}

function oracle(r, et) {
  const a = r.a_au * AU;
  const n = Math.sqrt(GM_SUN / (a * a * a));
  const epochEt = (jdOfIso(r.epoch) - 2451545.0) * SECONDS_PER_DAY;
  let M = (r.m_deg * DEG + n * (et - epochEt)) % (2 * Math.PI);
  if (M < 0) M += 2 * Math.PI;
  // Bisection on [0, 2pi) then Newton polish: a different route to E.
  let lo = 0, hi = 2 * Math.PI;
  for (let i = 0; i < 60; ++i) {
    const mid = 0.5 * (lo + hi);
    if (mid - r.e * Math.sin(mid) - M > 0) hi = mid; else lo = mid;
  }
  let E = 0.5 * (lo + hi);
  for (let i = 0; i < 3; ++i) E -= (E - r.e * Math.sin(E) - M) / (1 - r.e * Math.cos(E));
  // True anomaly and radius, then the orbit-plane position rotated by
  // Rz(node) Rx(i) Rz(argp + nu) in the ecliptic, then Rx(-eps).
  const nu = 2 * Math.atan2(Math.sqrt(1 + r.e) * Math.sin(E / 2), Math.sqrt(1 - r.e) * Math.cos(E / 2));
  const rad = a * (1 - r.e * Math.cos(E));
  const u = r.argp_deg * DEG + nu, O = r.node_deg * DEG, inc = r.i_deg * DEG;
  const xe = rad * (Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(inc));
  const ye = rad * (Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(inc));
  const ze = rad * (Math.sin(u) * Math.sin(inc));
  return [xe, Math.cos(EPS) * ye - Math.sin(EPS) * ze, Math.sin(EPS) * ye + Math.cos(EPS) * ze];
}

test("the astorb $SBD stream ingests: every record, in order, with its display fields", async () => {
  const { x, copyIn } = await load();
  const p = copyIn(stream);
  assert.equal(x.kepler_small_ingest_sbd_stream(p, stream.length), records.length);
  assert.equal(x.kepler_small_count(), records.length);
  // The display fields a host searches and labels by, from the same stream.
  const n = records.length;
  const numbers = x.plugin_alloc(4 * n);
  const hgd = x.plugin_alloc(12 * n);
  const offsets = x.plugin_alloc(4 * (n + 1));
  const names = x.plugin_alloc(stream.length);
  assert.equal(x.kepler_small_describe_sbd_stream(p, stream.length, n, numbers, hgd, offsets, names, stream.length), n);
  const num = new Uint32Array(x.memory.buffer, numbers, n);
  const f = new Float32Array(x.memory.buffer, hgd, 3 * n);
  const off = new Uint32Array(x.memory.buffer, offsets, n + 1);
  const bytes = new Uint8Array(x.memory.buffer, names, off[n]);
  const nameAt = (i) => new TextDecoder().decode(bytes.subarray(off[i], off[i + 1]));
  records.forEach((r, i) => {
    assert.equal(num[i], r.number);
    assert.equal(nameAt(i), r.name);
    if (r.h != null) assert.ok(Math.abs(f[3 * i] - r.h) < 1e-5, `${r.number} H`);
  });
});

// The record's conic is drawn as it is near the element epoch: within two
// days of it (the module's rebase span) a row is the osculating conic
// itself, so it must match a plain two-body oracle of the record to the metre
// (decoding, units, frames). Farther out the row follows its perturbed path
// (next test).
test("A8: every row within 1 m of the two-body oracle of its record within the rebase span (double and float32 snapshot)", async () => {
  const { x, copyIn } = await load();
  x.kepler_small_ingest_sbd_stream(copyIn(stream), stream.length);
  const n = records.length;
  const out = x.plugin_alloc(48);
  const snap = x.plugin_alloc(16 * n);
  let worst = 0, worstSnapshotRelative = 0;
  for (const days of [-1.9, -0.5, 0, 0.5, 1.9]) {
    const et = (2461300.5 + days - 2451545.0) * SECONDS_PER_DAY;
    assert.equal(x.kepler_small_snapshot(et, 0, n, 0, snap), 0);
    const rows = new Float32Array(x.memory.buffer, snap, 4 * n);
    for (let i = 0; i < n; ++i) {
      assert.equal(x.kepler_small_state(et, i, out), 0);
      const s = new Float64Array(x.memory.buffer, out, 6);
      const o = oracle(records[i], et);
      const d = Math.hypot(s[0] - o[0], s[1] - o[1], s[2] - o[2]);
      worst = Math.max(worst, d);
      // float32 rows: within float32 rounding of the double state
      const f = Math.hypot(rows[4 * i] - s[0], rows[4 * i + 1] - s[1], rows[4 * i + 2] - s[2]);
      worstSnapshotRelative = Math.max(worstSnapshotRelative, f / Math.hypot(s[0], s[1], s[2]));
      assert.ok(Number.isNaN(rows[4 * i + 3]), "V is NaN without an observer");
    }
  }
  console.log(`oracle: ${n} rows x 5 epochs, worst |dr| ${worst.toExponential(2)} m; float32 snapshot worst relative ${worstSnapshotRelative.toExponential(2)}`);
  assert.ok(worst < 1.0, `worst ${worst} m`);
  assert.ok(worstSnapshotRelative < 1.2e-7);
});

test("A8: against JPL Horizons 30 days either side of the element epoch along the perturbed path: median within 300 km, worst within 2,000 km", async () => {
  const { x, copyIn } = await load();
  x.kepler_small_ingest_sbd_stream(copyIn(stream), stream.length);
  const index = new Map(records.map((r, i) => [r.number, i]));
  const out = x.plugin_alloc(48);
  const errors = [];
  for (const row of horizons.rows) {
    const et = (row.jd_tdb - 2451545.0) * SECONDS_PER_DAY;
    assert.equal(x.kepler_small_state(et, index.get(row.number), out), 0);
    const s = new Float64Array(x.memory.buffer, out, 6);
    errors.push(Math.hypot(s[0] / 1e3 - row.position_km[0], s[1] / 1e3 - row.position_km[1], s[2] / 1e3 - row.position_km[2]));
  }
  errors.sort((a, b) => a - b);
  const median = errors[errors.length >> 1];
  console.log(`Horizons: ${errors.length} states, median ${median.toFixed(0)} km, 90th ${errors[Math.floor(0.9 * errors.length)].toFixed(0)} km, worst ${errors.at(-1).toFixed(0)} km`);
  // Two-body alone (keplerian-reference 1.5.0): median 366 km, worst 3,485 km;
  // the perturbed path: median 87 km, worst 876 km.
  assert.ok(median < 300, `median ${median} km`);
  assert.ok(errors.at(-1) < 2000, `worst ${errors.at(-1)} km`);
});

test("V from the record's H and G and the observer: brighter when nearer", async () => {
  const { x, copyIn } = await load();
  x.kepler_small_ingest_sbd_stream(copyIn(stream), stream.length);
  const n = records.length;
  const et = (2461300.5 - 2451545.0) * SECONDS_PER_DAY;
  const obs = x.plugin_alloc(24);
  const snap = x.plugin_alloc(16 * n);
  // Observer at 1 AU on the x axis, then at 30 AU.
  new Float64Array(x.memory.buffer, obs, 3).set([AU, 0, 0]);
  x.kepler_small_snapshot(et, 0, n, obs, snap);
  const near = Float32Array.from(new Float32Array(x.memory.buffer, snap, 4 * n));
  new Float64Array(x.memory.buffer, obs, 3).set([30 * AU, 0, 0]);
  x.kepler_small_snapshot(et, 0, n, obs, snap);
  const far = new Float32Array(x.memory.buffer, snap, 4 * n);
  const ceres = records.findIndex((r) => r.number === 1);
  assert.ok(near[4 * ceres + 3] > 3 && near[4 * ceres + 3] < 10, `Ceres V ${near[4 * ceres + 3]}`);
  let fainter = 0;
  for (let i = 0; i < n; ++i) {
    if (far[4 * i + 3] > near[4 * i + 3]) ++fainter;
  }
  assert.ok(fainter > 0.95 * n);
});

test("refusals are named: a truncated stream, a record not centred on the Sun", async () => {
  const { x, copyIn } = await load();
  // Truncated: the first size prefix promises more bytes than there are.
  const cut = stream.subarray(0, 100);
  assert.equal(x.kepler_small_ingest_sbd_stream(copyIn(cut), cut.length), -4);
  assert.equal(x.kepler_small_failed_record(), 0);
  assert.equal(x.kepler_small_count(), 0, "all or nothing");
  // A record whose CENTER_NAME is not SUN: patch "SUN" to "EAR" in a copy.
  const first = new DataView(stream.buffer, stream.byteOffset).getUint32(0, true);
  const one = Uint8Array.from(stream.subarray(0, 4 + first));
  const text = Buffer.from(one).indexOf("SUN");
  one.set(Buffer.from("EAR"), text);
  assert.equal(x.kepler_small_ingest_sbd_stream(copyIn(one), one.length), -7);
  assert.equal(x.kepler_small_diameter_from_h(3.34, 0.09) > 9e5, true);
});

test("outside 60 days of the element epoch a row is refused, never drawn at a two-body guess", async () => {
  // Measured (verify round 1): Apophis at its 2029-04-13 Earth approach drawn
  // 111,299 km from the geocentre instead of 38,011 km by two-body from a
  // 2026 epoch. The default span refuses it.
  const { x, copyIn } = await load();
  x.kepler_small_ingest_sbd_stream(copyIn(stream), stream.length);
  const n = records.length;
  const range = x.plugin_alloc(32);
  assert.equal(x.kepler_small_validity_range(range), 0);
  const [lo, hi, anyLo, anyHi] = new Float64Array(x.memory.buffer, range, 4);
  assert.ok(lo <= hi && anyLo <= lo && anyHi >= hi);
  assert.ok(Math.abs(hi - lo - 120 * SECONDS_PER_DAY) < 120 * SECONDS_PER_DAY, `common span ${(hi - lo) / SECONDS_PER_DAY} d`);
  const out = x.plugin_alloc(48);
  const snap = x.plugin_alloc(16 * n);
  const inside = 0.5 * (lo + hi);
  assert.equal(x.kepler_small_snapshot(inside, 0, n, 0, snap), 0);
  assert.equal(x.kepler_small_state(inside, 0, out), 0);
  const apophis2029 = (2462240.5 - 2451545.0) * SECONDS_PER_DAY; // 2029-04-13 TDB
  assert.equal(x.kepler_small_snapshot(apophis2029, 0, n, 0, snap), n, "every row refused");
  const rows = new Float32Array(x.memory.buffer, snap, 4 * n);
  for (let i = 0; i < n; ++i) assert.ok(Number.isNaN(rows[4 * i]), "a refused row is NaN");
  assert.equal(x.kepler_small_state(apophis2029, 0, out), -10);
  assert.equal(x.kepler_small_state(anyHi + 1, 0, out), -10);
  assert.equal(x.kepler_small_set_validity(0), 60 * SECONDS_PER_DAY, "non-positive restores the default");
});

// Owner 2026-10-13: the rest of the numbered asteroids load only when turned
// on, by size band and class. The module selects the records (the host never
// reads one): the kept records come back unchanged and in stream order.
test("kepler_small_select_sbd_stream keeps records by class, H band and an excluded-number bitmap", async () => {
  const { x, copyIn } = await load();
  const p = copyIn(stream);
  const out = x.plugin_alloc(stream.length);
  const frames = (bytes) => {
    const list = [];
    for (let o = 0; o < bytes.length;) {
      const n = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0, true);
      list.push(Buffer.from(bytes.subarray(o, o + 4 + n)).toString("hex"));
      o += 4 + n;
    }
    return list;
  };
  const all = frames(stream);
  const select = (mask, hMin, hMax, exclude = null) => {
    let ex = 0, bits = 0;
    if (exclude) {
      bits = Math.max(...exclude) + 1;
      const bitmap = new Uint8Array((bits + 7) >> 3);
      for (const n of exclude) bitmap[n >> 3] |= 1 << (n & 7);
      ex = copyIn(bitmap);
    }
    const written = x.kepler_small_select_sbd_stream(p, stream.length, mask, hMin, hMax, ex, bits, out, stream.length);
    assert.ok(written >= 0, `select refused (${written})`);
    return frames(new Uint8Array(x.memory.buffer, out, written).slice());
  };
  // No selection keeps everything, byte for byte.
  assert.deepEqual(select(0, NaN, NaN), all);
  // An H band: exactly the records whose H lies in it, in stream order.
  const band = records.map((r, i) => [r, all[i]]).filter(([r]) => r.h != null && r.h >= 12 && r.h < 15).map(([, f]) => f);
  assert.ok(band.length > 10 && band.length < records.length);
  assert.deepEqual(select(0, 12, 15), band);
  // Classes partition the stream: main belt (MBA = 7) and everything else.
  const mba = select(1 << 7, NaN, NaN);
  const rest = select(~(1 << 7) >>> 0, NaN, NaN);
  assert.ok(mba.length > 0 && rest.length > 0);
  assert.equal(mba.length + rest.length, all.length);
  // An excluded number is left out (Ceres and Eros).
  const kept = select(0, NaN, NaN, [1, 433]);
  assert.equal(kept.length, all.length - 2);
  // Too small an output is refused, never truncated.
  assert.equal(x.kepler_small_select_sbd_stream(p, stream.length, 0, NaN, NaN, 0, 0, out, 16), -11);
});
