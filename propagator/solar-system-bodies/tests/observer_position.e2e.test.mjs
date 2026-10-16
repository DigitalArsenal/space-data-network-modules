// The observer's position at every scale (ssb_observer_position), against
// NASA/JPL CSPICE on the SAME kernel files, through the module's own direct
// surface.
//
//   SSB_KERNELS_DIR=<dir with the shards from tools/build_kernels.py>
//   SSB_PYTHON=<python with spiceypy>   node --test tests/observer_position.e2e.test.mjs
//
// Cases: every body of the table, cameras from just above the surface out to
// a million radii in deterministic directions at deterministic epochs
// (2000-2049), the Sun's out past the Milky Way (1e23 m), and body-fixed
// special points (the poles, the axes, the centre, inside) placed through the
// module's own rotation. The expected regime is decided from CSPICE's
// numbers: the first body, walking out from the focused one, whose sphere
// (Hill radius from spkgeo and the GM pool; the Sun's 18.8 solar radii, only
// when the Sun is focused) holds the camera; else heliocentric inside 120.3
// au; else Galactic. Cases within 1e-9 of a boundary are not judged.
// References, tolerances:
//  - planetographic: recpgr on the spheroid (RADII[0], RADII[2]);
//    planetocentric: reclat; triaxial: nearpt + surfnm. Angles within 2e-10
//    rad (two units in the last place of W for Phobos and Vesta, the
//    rotation bound of the ephemeris test), heights and radii within 1e-6 m
//    + 1e-12 of the distance (nearpt's own convergence).
//  - heliocentric: reclat of pxform(J2000, ECLIPJ2000) on spkgeo from the
//    Sun; angles within 1e-12 rad, au within 1e-12 relative.
//  - Galactic: the module is the Hipparcos definition (pole 192.85948,
//    27.12825; l of the node 32.93192); CSPICE's GALACTIC is the FK4-based
//    one. The two differ by 9.7 mas, so angles are held to 15 mas against
//    CSPICE and, exactly, to the defining pole and node.
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

const PARENT = { 10: 0, 199: 10, 299: 10, 399: 10, 301: 399, 499: 10, 401: 499, 402: 499, 599: 10, 501: 599,
  502: 599, 503: 599, 504: 599, 699: 10, 601: 699, 602: 699, 603: 699, 604: 699, 605: 699, 606: 699, 608: 699,
  799: 10, 705: 799, 701: 799, 702: 799, 703: 799, 704: 799, 899: 10, 801: 899, 999: 10, 901: 999, 2000001: 10,
  2000004: 10 };
const NAMES = { 10: "SUN", 199: "MERCURY", 299: "VENUS", 399: "EARTH", 499: "MARS", 401: "PHOBOS", 402: "DEIMOS",
  599: "JUPITER", 501: "IO", 502: "EUROPA", 503: "GANYMEDE", 504: "CALLISTO", 699: "SATURN", 601: "MIMAS",
  602: "ENCELADUS", 603: "TETHYS", 604: "DIONE", 605: "RHEA", 606: "TITAN", 608: "IAPETUS", 799: "URANUS",
  705: "MIRANDA", 701: "ARIEL", 702: "UMBRIEL", 703: "TITANIA", 704: "OBERON", 899: "NEPTUNE", 801: "TRITON",
  999: "PLUTO", 901: "CHARON", 2000001: "CERES", 2000004: "VESTA" };
const BODIES = Object.keys(PARENT).map(Number);
const frameOf = (id) => (id === 301 ? "MOON_ME" : `IAU_${NAMES[id]}`);
const chainOf = (id) => {
  const out = [];
  for (let b = id; b; b = PARENT[b]) out.push(b);
  if (out[out.length - 1] !== 10) out.push(10);
  return out;
};

const AU = 149597870700, LY = 9460730472580800, PC = (AU * 648000) / Math.PI;
const HELIOPAUSE = 120.3 * AU, ALFVEN = 18.8;
const L = { regime: 0, reference: 1, distance: 2, boundary: 3, pgrLon: 4, pgrLat: 5, pgrAlt: 6, pcLon: 7, pcLat: 8,
  pcRadius: 9, pdLon: 10, pdLat: 11, pdHeight: 12, lonSense: 13, eclLon: 4, eclLat: 5, eclAu: 6, eclX: 7,
  galL: 4, galB: 5, galLy: 6, galPc: 7, gcLy: 8, gcPc: 9, length: 14 };

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

let seed = 20261016;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const direction = () => {
  const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), h = Math.sqrt(1 - z * z);
  return [h * Math.cos(a), h * Math.sin(a), z];
};
const T0 = (2451545.5 - 2451545.0) * 86400, T1 = (2469805.5 - 2451545.0) * 86400;
const epoch = () => T0 + rand() * (T1 - T0);

/** Signed angular difference folded into (-pi, pi]. */
const dAngle = (a, b) => {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};

const ready = kernelsDir && fs.existsSync(kernelsDir) && spawnSync(python, ["-c", "import spiceypy"]).status === 0;

test("observer position at every scale matches CSPICE (body grids, heliocentric ecliptic, Galactic)", { skip: !ready && "SSB_KERNELS_DIR / spiceypy not available" }, async () => {
  const files = kernelFiles();
  const { x, mem } = await loadModule(files);
  const radiusPtr = x.plugin_alloc(8 * 3);
  const meanRadius = (id) => {
    assert.equal(x.ssb_radii(id, radiusPtr), 0, `radii of ${id}`);
    const r = new Float64Array(mem(), radiusPtr, 3);
    return (r[0] + r[1] + r[2]) / 3;
  };
  const rotPtr = x.plugin_alloc(8 * 10), idPtr = x.plugin_alloc(4), stPtr = x.plugin_alloc(4);
  const rotationOf = (et, id) => {
    new Int32Array(mem(), idPtr, 1)[0] = id;
    x.ssb_orientations(et, idPtr, 1, rotPtr, stPtr);
    assert.equal(new Int32Array(mem(), stPtr, 1)[0], 0, `rotation of ${id}`);
    return Array.from(new Float64Array(mem(), rotPtr, 9));
  };
  /** A body-fixed point (m) as an ICRF camera: R^T p. */
  const fromBodyFixed = (rot, p) => [0, 1, 2].map((j) => rot[j] * p[0] + rot[3 + j] * p[1] + rot[6 + j] * p[2]);

  const cases = [];
  const scales = [0.2, 0.999, 1.0005, 1.05, 2, 10, 100, 1e3, 1e4, 1e5, 1e6];
  for (const id of BODIES) {
    const R = meanRadius(id);
    for (const k of scales) {
      for (let rep = 0; rep < 3; rep += 1) {
        const d = direction();
        cases.push({ et: epoch(), focused: id, cam: d.map((v) => v * k * R) });
      }
    }
    // Body-fixed special points: both poles, the three axes, the centre.
    const et = epoch();
    const rot = rotationOf(et, id);
    const r = new Float64Array(mem(), radiusPtr, 3);
    x.ssb_radii(id, radiusPtr);
    const [a, b, c] = Array.from(r);
    for (const p of [[0, 0, 1.5 * c], [0, 0, -1.5 * c], [2 * a, 0, 0], [0, -2 * b, 0], [0, 0, 0], [0.5 * a, 0, 0],
      [0, 0, 0.3 * c], [a * 1.0001, 0, 0]]) {
      cases.push({ et, focused: id, cam: fromBodyFixed(rot, p), special: p });
    }
  }
  // The Sun out past the Milky Way.
  for (const d of [7.2e8, 5e9, 1.4e10, 1e11, 1.5e12, 1.5e13, 1.75e13, 2e13, 1e16, 3e19, 2.6e20, 3e21, 1e23]) {
    for (let rep = 0; rep < 2; rep += 1) cases.push({ et: epoch(), focused: 10, cam: direction().map((v) => v * d) });
  }
  // Earth far out: the walk from a planet straight to heliocentric and Galactic.
  for (const d of [1e10, 1e13, 2e13, 3e21]) cases.push({ et: epoch(), focused: 399, cam: direction().map((v) => v * d) });

  const request = {
    kernels: files,
    observer: cases.map((c) => ({
      et: c.et, focused: c.focused, cam: c.cam.map((v) => v / 1000), chain: chainOf(c.focused),
      frames: Object.fromEntries(chainOf(c.focused).map((id) => [id, frameOf(id)])),
    })),
  };
  const oracle = spawnSync(python, ["-I", path.join(here, "cspice_oracle.py")], {
    input: JSON.stringify(request), maxBuffer: 1 << 28,
  });
  assert.equal(oracle.status, 0, String(oracle.stderr));
  const ref = JSON.parse(String(oracle.stdout));

  const camPtr = x.plugin_alloc(8 * 3), outPtr = x.plugin_alloc(8 * L.length);
  const worst = { bodyAngle: 0, bodyLength: 0, helioAngle: 0, helioAu: 0, galAngle: 0 };
  const counts = { body: 0, heliocentric: 0, galactic: 0, boundary: 0 };
  const regimesSeen = new Set();
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i], o = ref.observer[i], chain = chainOf(c.focused);
    new Float64Array(mem(), camPtr, 3).set(c.cam);
    const code = x.ssb_observer_position(c.et, c.focused, camPtr, outPtr);
    assert.equal(code, 0, `case ${i} (${c.focused}): status ${code}`);
    const out = Array.from(new Float64Array(mem(), outPtr, L.length));
    const label = `case ${i}: focused ${c.focused} at ${Math.hypot(...c.cam).toExponential(3)} m`;

    // The regime CSPICE's numbers call for.
    let expected = null, nearBoundary = false;
    for (const id of chain) {
      if (id === 10 && c.focused !== 10) continue;
      const b = o.bodies[String(id)];
      const edge = id === 10 ? ALFVEN * b.radii[0] : b.hill;
      if (edge === undefined) continue;
      const dist = Math.hypot(...b.rel);
      if (Math.abs(dist / edge - 1) < 1e-9) nearBoundary = true;
      if (dist < edge) { expected = { regime: 0, id }; break; }
    }
    const sunDist = Math.hypot(...o.sun.rel) * 1000;
    if (!expected) {
      if (Math.abs(sunDist / HELIOPAUSE - 1) < 1e-9) nearBoundary = true;
      expected = sunDist < HELIOPAUSE ? { regime: 1, id: 10 } : { regime: 2, id: 0 };
    }
    if (nearBoundary) { counts.boundary += 1; continue; }
    assert.equal(out[L.regime], expected.regime, `${label}: regime ${out[L.regime]}, CSPICE says ${expected.regime}`);
    assert.equal(out[L.reference], expected.id, `${label}: reference ${out[L.reference]}, CSPICE says ${expected.id}`);
    regimesSeen.add(`${expected.regime}:${expected.id}`);

    if (expected.regime === 0) {
      counts.body += 1;
      const b = o.bodies[String(expected.id)];
      const dist = Math.hypot(...b.rel) * 1000;
      const lenTol = 1e-6 + 1e-12 * dist;
      const angTol = 2e-10;
      const checkAngle = (got, want, what) => {
        const d = dAngle(got, want);
        worst.bodyAngle = Math.max(worst.bodyAngle, d);
        assert.ok(d <= angTol, `${label}: ${what} ${got} vs CSPICE ${want} (${d} rad)`);
      };
      const checkLength = (got, want, what) => {
        const d = Math.abs(got - want);
        worst.bodyLength = Math.max(worst.bodyLength, d / Math.max(1, dist));
        assert.ok(d <= lenTol, `${label}: ${what} ${got} m vs CSPICE ${want} m (${d} m)`);
      };
      // Longitude is undefined on the polar axis (the rotation's last-place
      // residue picks one at random there), so a polar point is not judged on it.
      const polar = c.special && c.special[0] === 0 && c.special[1] === 0;
      // An inside point on the equatorial plane is equally near the northern
      // and the southern surface: the latitude's sign is a tie, its size is not.
      const tie = c.special && c.special[2] === 0 && Math.hypot(...c.special) < Math.min(...b.radii) * 1000;
      const lat = (v) => (tie ? Math.abs(v) : v);
      if (!polar) checkAngle(out[L.pgrLon], b.pgr[0], "planetographic longitude");
      checkAngle(lat(out[L.pgrLat]), lat(b.pgr[1]), "planetographic latitude");
      checkLength(out[L.pgrAlt], b.pgr[2] * 1000, "planetographic altitude");
      checkLength(out[L.pcRadius], b.lat[0] * 1000, "planetocentric radius");
      if (!polar) checkAngle(out[L.pcLon], b.lat[1], "planetocentric longitude");
      checkAngle(out[L.pcLat], b.lat[2], "planetocentric latitude");
      if (!polar) checkAngle(out[L.pdLon], b.nearpt[0], "triaxial longitude");
      checkAngle(lat(out[L.pdLat]), lat(b.nearpt[1]), "triaxial latitude");
      checkLength(out[L.pdHeight], b.nearpt[2] * 1000, "triaxial height");
      assert.ok(out[L.pgrLon] >= 0 && out[L.pgrLon] < 2 * Math.PI, `${label}: planetographic longitude range`);
      assert.ok(Math.abs(out[L.distance] - dist) <= lenTol, `${label}: distance`);
    } else if (expected.regime === 1) {
      counts.heliocentric += 1;
      const [r, lon, lat] = o.sun.ecl;
      const dl = dAngle(out[L.eclLon], lon), db = Math.abs(out[L.eclLat] - lat);
      const dau = Math.abs(out[L.eclAu] - (r * 1000) / AU) / ((r * 1000) / AU);
      worst.helioAngle = Math.max(worst.helioAngle, dl * Math.cos(lat), db);
      worst.helioAu = Math.max(worst.helioAu, dau);
      assert.ok(dl * Math.cos(lat) <= 1e-12 && db <= 1e-12, `${label}: ecliptic (${dl}, ${db}) rad`);
      assert.ok(dau <= 1e-12, `${label}: au ${out[L.eclAu]} vs ${(r * 1000) / AU}`);
      const xyz = [out[L.eclX], out[L.eclX + 1], out[L.eclX + 2]];
      assert.ok(Math.abs(Math.hypot(...xyz) - out[L.eclAu]) <= 1e-12 * out[L.eclAu], `${label}: ecliptic x, y, z`);
    } else {
      counts.galactic += 1;
      const [r, l, b] = o.sun.gal;
      const mas = (Math.PI / 180) / 3.6e6;
      const dl = dAngle(out[L.galL], l) * Math.cos(b), db = Math.abs(out[L.galB] - b);
      worst.galAngle = Math.max(worst.galAngle, dl / mas, db / mas);
      assert.ok(dl <= 15 * mas && db <= 15 * mas, `${label}: Galactic (${dl / mas}, ${db / mas}) mas`);
      const d = r * 1000;
      assert.ok(Math.abs(out[L.galLy] - d / LY) <= 1e-12 * (d / LY), `${label}: ly`);
      assert.ok(Math.abs(out[L.galPc] - d / PC) <= 1e-12 * (d / PC), `${label}: pc`);
      assert.ok(out[L.gcPc] > 0, `${label}: distance from the Galactic centre`);
    }
  }
  console.log(`CSPICE ${ref.toolkit}: ${cases.length} cases (${counts.body} body, ${counts.heliocentric} heliocentric, ${counts.galactic} Galactic, ${counts.boundary} on a boundary)`);
  console.log(`worst: body angle ${worst.bodyAngle.toExponential(2)} rad, body length ${worst.bodyLength.toExponential(2)} of the distance; ecliptic ${worst.helioAngle.toExponential(2)} rad, au ${worst.helioAu.toExponential(2)} relative; Galactic ${worst.galAngle.toFixed(2)} mas against CSPICE's FK4-based frame`);
  assert.ok(counts.body > 500 && counts.heliocentric > 50 && counts.galactic >= 10, JSON.stringify(counts));
  // Every body's own grid was reached, and a moon's camera beyond its sphere found its planet's.
  for (const id of BODIES) assert.ok(regimesSeen.has(`0:${id}`), `no case on ${id}'s grid`);
});

test("the Galactic regime is the Hipparcos definition: the pole, the node, the centre", { skip: !ready && "SSB_KERNELS_DIR / spiceypy not available" }, async () => {
  const { x, mem } = await loadModule(kernelFiles());
  const camPtr = x.plugin_alloc(24), outPtr = x.plugin_alloc(8 * L.length);
  const deg = Math.PI / 180, et = 0;
  const at = (ra, dec, d) => {
    const cam = [Math.cos(dec) * Math.cos(ra) * d, Math.cos(dec) * Math.sin(ra) * d, Math.sin(dec) * d];
    new Float64Array(mem(), camPtr, 3).set(cam);
    assert.equal(x.ssb_observer_position(et, 10, camPtr, outPtr), 0);
    return Array.from(new Float64Array(mem(), outPtr, L.length));
  };
  const far = 1e20;
  const pole = at(192.85948 * deg, 27.12825 * deg, far);
  assert.equal(pole[L.regime], 2);
  assert.ok(Math.abs(pole[L.galB] - Math.PI / 2) < 1e-12, `pole b ${pole[L.galB]}`);
  // The celestial pole lies at l = 122.93192 deg (180 deg minus the node's 32.93192... plus 90): the definition.
  const ncp = at(0, 90 * deg, far);
  assert.ok(Math.abs(ncp[L.galL] - 122.93192 * deg) < 1e-12, `l of the north celestial pole ${ncp[L.galL] / deg}`);
  // From the Galactic centre's own direction the distance to the centre is |d - R0| (to the plane's tilt).
  const galPtr = x.plugin_alloc(8 * 14);
  x.ssb_galactic(galPtr);
  const g = new Float64Array(mem(), galPtr, 14);
  const c = [g[9], g[10], g[11]], r0 = Math.hypot(...c);
  new Float64Array(mem(), camPtr, 3).set(c);
  assert.equal(x.ssb_observer_position(et, 10, camPtr, outPtr), 0);
  const atCentre = Array.from(new Float64Array(mem(), outPtr, L.length));
  assert.ok(atCentre[L.gcPc] < 1e-9 * (r0 / PC), `at the centre: ${atCentre[L.gcPc]} pc from it`);
  assert.ok(Math.abs(atCentre[L.galPc] - 8178) < 1e-9 * 8178, `R0 ${atCentre[L.galPc]} pc`);
  // 3e21 m (the console's Milky Way view) and 1e23 m stay in the Galactic regime with finite numbers.
  for (const d of [3e21, 1e23]) {
    const o = at(10 * deg, -20 * deg, d);
    assert.equal(o[L.regime], 2);
    assert.ok(o.every(Number.isFinite), `finite at ${d} m`);
    assert.ok(Math.abs(o[L.galLy] - d / LY) <= 1e-12 * (d / LY));
  }
});

test("the ecliptic export is SPICE's ECLIPJ2000 and the regime edges are the measured ones", { skip: !ready && "SSB_KERNELS_DIR / spiceypy not available" }, async () => {
  const { x, mem } = await loadModule(kernelFiles());
  const m = x.plugin_alloc(72);
  assert.equal(x.ssb_ecliptic(m), 0);
  const e = Array.from(new Float64Array(mem(), m, 9));
  const oracle = spawnSync(python, ["-I", "-c", "import json,spiceypy as sp;print(json.dumps([float(v) for v in sp.pxform('J2000','ECLIPJ2000',0.0).flatten()]))"]);
  assert.equal(oracle.status, 0, String(oracle.stderr));
  const want = JSON.parse(String(oracle.stdout));
  for (let i = 0; i < 9; i += 1) assert.ok(Math.abs(e[i] - want[i]) < 1e-15, `ECLIPJ2000[${i}] ${e[i]} vs ${want[i]}`);
  const camPtr = x.plugin_alloc(24), outPtr = x.plugin_alloc(8 * L.length);
  const probe = (focused, d) => {
    new Float64Array(mem(), camPtr, 3).set([d, 0, 0]);
    assert.equal(x.ssb_observer_position(1e8, focused, camPtr, outPtr), 0);
    return Array.from(new Float64Array(mem(), outPtr, L.length));
  };
  const sunGrid = probe(10, 1e9);
  assert.equal(sunGrid[L.regime], 0);
  const sunRadii = x.plugin_alloc(24);
  assert.equal(x.ssb_radii(10, sunRadii), 0);
  const solarRadius = new Float64Array(mem(), sunRadii, 3)[0];
  assert.ok(Math.abs(sunGrid[L.boundary] - 18.8 * solarRadius) < 1, `Alfven edge ${sunGrid[L.boundary]}`);
  assert.equal(sunGrid[L.lonSense], 1, "the Sun's longitude is east-positive");
  const helio = probe(10, 1e11);
  assert.equal(helio[L.regime], 1);
  assert.equal(helio[L.boundary], HELIOPAUSE);
  // Senses: Mars prograde (west), Venus retrograde (east), the Moon east.
  assert.equal(probe(499, 4e6)[L.lonSense], -1);
  assert.equal(probe(299, 7e6)[L.lonSense], 1);
  assert.equal(probe(301, 2e6)[L.lonSense], 1);
  // An unknown body is the named failure.
  new Float64Array(mem(), camPtr, 3).set([1, 0, 0]);
  assert.equal(x.ssb_observer_position(0, 12345, camPtr, outPtr), -8);
});
