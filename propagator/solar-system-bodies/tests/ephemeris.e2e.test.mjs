// A4 (design: graph/programs/space-catalog-beyond-earth.md): the 33 Phase-1
// bodies at 200 epochs between 2000 and 2050 against NASA/JPL CSPICE on the
// SAME kernel files, through the module's own direct surface.
//
//   SSB_KERNELS_DIR=<dir with the shards from tools/build_kernels.py>
//   SSB_PYTHON=<python with spiceypy>   node --test tests/ephemeris.e2e.test.mjs
//
// Sources, units, frames, tolerances:
//  - states: CSPICE spkgeo, J2000 (= ICRF), relative to the SSB, km -> m;
//    tolerance 1 m on position (|dr|), the design's bound, which covers
//    floating-point summation along the chain; measured values are printed.
//  - rotations: CSPICE pxform J2000 -> IAU_<body> (text PCK pck00011) and
//    J2000 -> MOON_ME (binary PCK + frame kernel); tolerance 1e-10 rad on the
//    rotation angle between the two matrices, or two units in the last place
//    of the prime-meridian angle W in radians when that is larger: W reaches
//    ~5e5 rad for Phobos and Vesta over 50 years, where one ulp is 1.16e-10
//    rad, so no double-precision evaluation can be closer than that to
//    another one.
//  - apparent V: JPL Horizons APmag (tests/fixtures/horizons-apmag.json,
//    geocentric), tolerance 0.3 mag for Mercury..Neptune.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const kernelsDir = process.env.SSB_KERNELS_DIR;
const python = process.env.SSB_PYTHON ?? "python3";

const BODIES = [10, 199, 299, 399, 301, 499, 401, 402, 599, 501, 502, 503, 504, 699, 601, 602, 603, 604, 605, 606, 608,
  799, 705, 701, 702, 703, 704, 899, 801, 999, 901, 2000001, 2000004];
const NAMES = { 10: "SUN", 199: "MERCURY", 299: "VENUS", 399: "EARTH", 499: "MARS", 401: "PHOBOS", 402: "DEIMOS",
  599: "JUPITER", 501: "IO", 502: "EUROPA", 503: "GANYMEDE", 504: "CALLISTO", 699: "SATURN", 601: "MIMAS",
  602: "ENCELADUS", 603: "TETHYS", 604: "DIONE", 605: "RHEA", 606: "TITAN", 608: "IAPETUS", 799: "URANUS",
  705: "MIRANDA", 701: "ARIEL", 702: "UMBRIEL", 703: "TITANIA", 704: "OBERON", 899: "NEPTUNE", 801: "TRITON",
  999: "PLUTO", 901: "CHARON", 2000001: "CERES", 2000004: "VESTA" };

function kernelFiles() {
  const names = fs.readdirSync(kernelsDir);
  const text = ["pck00011.tpc", "gm_de440.tpc", "moon_de440_250416.tf"].filter((n) => names.includes(n));
  const daf = names.filter((n) => /\.(bsp|bpc)$/.test(n)).sort();
  return [...text, ...daf].map((n) => path.join(kernelsDir, n));
}

async function loadModule(files) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), surface: "direct" });
  const x = harness.instance.exports;
  const mem = () => (harness.memory ?? x.memory).buffer;
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const p = x.plugin_alloc(bytes.length);
    new Uint8Array(mem(), p, bytes.length).set(bytes);
    const code = x.ssb_load_kernel(p, bytes.length);
    x.plugin_free(p, bytes.length);
    assert.ok(code >= 0, `${path.basename(file)} refused (${code})`);
  }
  return { x, mem };
}

/** Deterministic epochs: 200 points spread over 2000-01-02 .. 2049-12-30 TDB. */
function epochs() {
  const t0 = (2451545.5 - 2451545.0) * 86400, t1 = (2469805.5 - 2451545.0) * 86400;
  let s = 20261012;
  const out = [];
  for (let i = 0; i < 200; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(t0 + ((i + s / 2147483648) / 200) * (t1 - t0));
  }
  return out;
}

/** Rotation angle between two rotation matrices from the Frobenius norm of
 * their difference, ||A - B||_F = 2 sqrt(2) sin(theta / 2): exact at the 1e-12
 * rad level, where acos of the trace has already lost all precision. */
function angleBetween(a, b) {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (a[i] - b[i]) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(sum) / (2 * Math.SQRT2)));
}

const ready = kernelsDir && fs.existsSync(kernelsDir) && spawnSync(python, ["-c", "import spiceypy"]).status === 0;

test("A4: states and rotations of 33 bodies match CSPICE on the same kernels", { skip: !ready && "SSB_KERNELS_DIR / spiceypy not available" }, async () => {
  const files = kernelFiles();
  const ets = epochs();
  const frames = Object.fromEntries(BODIES.map((id) => [id, id === 301 ? "MOON_ME" : `IAU_${NAMES[id]}`]));
  const oracle = spawnSync(python, ["-I", path.join(here, "cspice_oracle.py")], {
    input: JSON.stringify({ kernels: files, epochs: ets, bodies: BODIES, frames }),
    maxBuffer: 1 << 28,
  });
  assert.equal(oracle.status, 0, String(oracle.stderr));
  const ref = JSON.parse(String(oracle.stdout));
  const { x, mem } = await loadModule(files);
  const n = BODIES.length;
  const ids = x.plugin_alloc(4 * n), out = x.plugin_alloc(8 * 10 * n), status = x.plugin_alloc(4 * n);
  new Int32Array(mem(), ids, n).set(BODIES);
  let worstPos = 0, worstRot = 0, compared = 0, rotCompared = 0;
  const worstBy = {}, worstRotBy = {};
  for (let e = 0; e < ets.length; e += 1) {
    x.ssb_states(ets[e], ids, n, 0, out, status);
    const st = new Float64Array(mem(), out, 6 * n).slice();
    const codes = new Int32Array(mem(), status, n).slice();
    for (let i = 0; i < n; i += 1) {
      const r = ref.states[e][i];
      if (!r) {
        assert.notEqual(codes[i], 0, `${BODIES[i]} at ${ets[e]}: CSPICE has no state but the module answered`);
        continue;
      }
      assert.equal(codes[i], 0, `${BODIES[i]} at ${ets[e]}: module status ${codes[i]}`);
      const d = Math.hypot(st[6 * i] - r[0] * 1000, st[6 * i + 1] - r[1] * 1000, st[6 * i + 2] - r[2] * 1000);
      worstPos = Math.max(worstPos, d);
      worstBy[BODIES[i]] = Math.max(worstBy[BODIES[i]] ?? 0, d);
      compared += 1;
    }
    x.ssb_orientations(ets[e], ids, n, out, status);
    const rot = new Float64Array(mem(), out, 10 * n).slice();
    const rcodes = new Int32Array(mem(), status, n).slice();
    for (let i = 0; i < n; i += 1) {
      const r = ref.rotations[e][i];
      if (!r) continue;
      assert.equal(rcodes[i], 0, `${BODIES[i]} rotation at ${ets[e]}: module status ${rcodes[i]}`);
      const angle = angleBetween(Array.from(rot.subarray(10 * i, 10 * i + 9)), r);
      const wMagnitude = Math.abs(rot[10 * i + 9] * ets[e]);
      const floor = Math.max(1e-10, 2 * wMagnitude * Number.EPSILON);
      assert.ok(angle <= floor, `${BODIES[i]} rotation at ${ets[e]}: ${angle} rad > ${floor} rad`);
      worstRot = Math.max(worstRot, angle / floor * 1e-10);
      worstRotBy[BODIES[i]] = Math.max(worstRotBy[BODIES[i]] ?? 0, angle);
      rotCompared += 1;
    }
  }
  console.log(`CSPICE ${ref.toolkit}: ${compared} states, worst |dr| ${worstPos.toExponential(3)} m; ${rotCompared} rotations, worst ${(worstRot * 1e10).toFixed(3)} of the bound`);
  console.log(`worst |dr| by body (m): ${JSON.stringify(Object.fromEntries(Object.entries(worstBy).map(([k, v]) => [k, Number(v.toExponential(2))])))}`);
  console.log(`worst rotation by body (rad): ${JSON.stringify(Object.fromEntries(Object.entries(worstRotBy).map(([k, v]) => [k, Number(v.toExponential(2))])))}`);
  assert.ok(compared >= 33 * 200 * 0.95, `only ${compared} states compared`);
  assert.ok(rotCompared >= 30 * 200, `only ${rotCompared} rotations compared`);
  assert.ok(worstPos <= 1, `worst position error ${worstPos} m > 1 m`);
  assert.ok(worstRot <= 1e-10, `worst rotation error ${worstRot} (scaled to its floor) > 1e-10 rad`);
});

test("A4: apparent V of the planets within 0.3 mag of JPL Horizons", { skip: !kernelsDir && "SSB_KERNELS_DIR not set" }, async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "horizons-apmag.json"), "utf8"));
  const { x, mem } = await loadModule(kernelFiles());
  const ids = x.plugin_alloc(4), out = x.plugin_alloc(8 * 7), status = x.plugin_alloc(4), obs = x.plugin_alloc(24), st = x.plugin_alloc(48);
  let worst = 0;
  for (const row of fixture.rows) {
    const et = (row.jd_tt - 2451545.0) * 86400;
    new Int32Array(mem(), ids, 1)[0] = 399;
    x.ssb_states(et, ids, 1, 0, st, status);
    new Float64Array(mem(), obs, 3).set(new Float64Array(mem(), st, 3));
    new Int32Array(mem(), ids, 1)[0] = row.id;
    x.ssb_apparent(et, obs, ids, 1, out, status);
    assert.equal(new Int32Array(mem(), status, 1)[0], 0);
    const v = new Float64Array(mem(), out, 7)[4];
    worst = Math.max(worst, Math.abs(v - row.apmag));
    assert.ok(Math.abs(v - row.apmag) <= fixture.tolerance_mag, `${row.id} at JD ${row.jd_tt}: V ${v.toFixed(3)} vs Horizons ${row.apmag}`);
  }
  console.log(`apparent V: ${fixture.rows.length} rows, worst |dV| ${worst.toFixed(3)} mag`);
});

test("an epoch outside every segment is the named failure, never a number", { skip: !kernelsDir && "SSB_KERNELS_DIR not set" }, async () => {
  const { x, mem } = await loadModule(kernelFiles());
  const ids = x.plugin_alloc(4), out = x.plugin_alloc(48), status = x.plugin_alloc(4);
  new Int32Array(mem(), ids, 1)[0] = 501;
  const et1990 = (2447892.5 - 2451545.0) * 86400; // satellites start in 2000
  x.ssb_states(et1990, ids, 1, 0, out, status);
  assert.equal(new Int32Array(mem(), status, 1)[0], -5);
  assert.deepEqual(Array.from(new Float64Array(mem(), out, 6)), [0, 0, 0, 0, 0, 0]);
});
