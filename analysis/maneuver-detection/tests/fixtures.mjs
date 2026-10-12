// Fixtures shared by tests/maneuver_detection.test.mjs and tests/parity.mjs.
// Test tooling only (reference two-body propagation, Earth-fixed rotation,
// synthetic element sets): never imported by shipped code.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Closed-form two-body cases. Each element set is a Keplerian orbit (mu =
// 398600.4418 km^3/s^2, the module's constant), propagated here by solving
// the universal Kepler equation; a burn is an instantaneous velocity change at t_b, so
// every set with an epoch after t_b describes the post-burn orbit. Expected
// values come from vis-viva and the rotation of the orbit normal, derived in
// the comment beside each assertion. Frame: EME2000. Units: km, km/s, UTC.
export const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
export const require = createRequire(path.join(root, 'package.json'));
export const flatbuffers = require('flatbuffers');
export const OEM = await import(pathToFileURL(path.join(root, 'lib/js/OEM/main.js')));
export const MNV = await import(pathToFileURL(path.join(root, 'lib/js/MNV/main.js')));
export const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
export const wasm = fs.readFileSync(wasmPath);

export const MU = 398600.4418;
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0) / 1000;           // 2026-09-01T00:00:00Z
export const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
export const seconds = (text) => Date.parse(text) / 1000;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.sqrt(dot(a, a));
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const mul = (a, s) => a.map((x) => x * s);
export const unit = (a) => mul(a, 1 / norm(a));
export const sma = (r, v) => 1 / (2 / norm(r) - dot(v, v) / MU);

// Two-body propagation from (r0, v0) at t0: Lagrange f and g with the
// universal anomaly chi (Vallado, Fundamentals of Astrodynamics, 4th ed.,
// algorithm 8), Newton iteration on the universal Kepler equation. Exact at
// t = t0 (f = 1, g = 0) for every eccentricity.
export function stumpff(z) {
  if (z > 1e-8) { const s = Math.sqrt(z); return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * z)]; }
  if (z < -1e-8) { const s = Math.sqrt(-z); return [(1 - Math.cosh(s)) / z, (Math.sinh(s) - s) / (s * -z)]; }
  return [1 / 2 - z / 24, 1 / 6 - z / 120];
}
export function kepler(r0, v0, t0) {
  const R0 = norm(r0), rv = dot(r0, v0), alpha = 2 / R0 - dot(v0, v0) / MU, sq = Math.sqrt(MU);
  return (t) => {
    const dt = t - t0;
    let chi = sq * alpha * dt;
    for (let k = 0; k < 100; k++) {
      const z = alpha * chi * chi, [C, S] = stumpff(z);
      const F = rv / sq * chi * chi * C + (1 - alpha * R0) * chi ** 3 * S + R0 * chi - sq * dt;
      const dF = rv / sq * chi * (1 - z * S) + (1 - alpha * R0) * chi * chi * C + R0;
      const step = F / dF;
      chi -= step;
      if (Math.abs(step) < 1e-13 * Math.max(1, Math.abs(chi))) break;
    }
    const z = alpha * chi * chi, [C, S] = stumpff(z);
    const f = 1 - chi * chi / R0 * C, g = dt - chi ** 3 * S / sq;
    const r = add(mul(r0, f), mul(v0, g)), R = norm(r);
    const fd = sq / (R * R0) * chi * (z * S - 1), gd = 1 - chi * chi / R * C;
    return [r, add(mul(r0, fd), mul(v0, gd))];
  };
}

// Circular orbit of radius a, inclination i, node raan (deg), argument of
// latitude 0 at T0.
export function circular(a, inc, raan) {
  const I = inc * Math.PI / 180, O = raan * Math.PI / 180;
  const node = [Math.cos(O), Math.sin(O), 0];
  const normal = [Math.sin(O) * Math.sin(I), -Math.cos(O) * Math.sin(I), Math.cos(I)];
  const along = cross(normal, node);
  return kepler(mul(node, a), mul(along, Math.sqrt(MU / a)), T0);
}

// Element-set epochs every 4 h with a deterministic +-37 min jitter, on whole minutes.
export const EPOCHS = Array.from({ length: 31 }, (_, j) => T0 + j * 14400 + (j % 2 ? 2220 : -2220) + (j === 0 ? 2220 : 0));

export function eme2000() {
  const w = new OEM.CelestialFrameWrapperT();
  w.frame = OEM.CelestialFrame.EME2000;
  const f = new OEM.RFMT();
  f.REFERENCE_FRAME_type = OEM.RFMUnion.CelestialFrameWrapper;
  f.REFERENCE_FRAME = w;
  return f;
}
// One block per element set j: its orbit sampled every 60 s from epoch j-2 to j+2.
export function block(j, orbit, { frame = eme2000(), norad = 99001, id = '2026-900A' } = {}) {
  const b = new OEM.ephemerisDataBlockT();
  const object = new OEM.CATT();
  object.NORAD_CAT_ID = norad;
  object.OBJECT_ID = id;
  b.OBJECT = object;
  b.COMMENT = `ELSET ${j}`;
  b.CENTER_NAME = 'EARTH';
  b.REFERENCE_FRAME = frame;
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  const start = EPOCHS[Math.max(0, j - 2)], stop = EPOCHS[Math.min(EPOCHS.length - 1, j + 2)];
  b.START_TIME = iso(start);
  b.STOP_TIME = iso(stop);
  b.STEP_SIZE = 60;
  const data = [];
  for (let t = start; t <= stop + 1e-9; t += 60) { const [r, v] = orbit(t); data.push(...r, ...v); }
  b.EPHEMERIS_DATA = data;
  return b;
}
export function oem(blocks) {
  const m = new OEM.OEMT();
  m.CREATION_DATE = '2026-09-29T00:00:00.000Z';
  m.EPHEMERIS_DATA_BLOCK = blocks;
  const builder = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishOEMBuffer(builder, m.pack(builder));
  return builder.asUint8Array();
}
// Sets before the burn fly `pre`; sets at or after it fly the post-burn orbit.
export function history(pre, tb, dv) {
  const [r, v] = pre(tb);
  const post = kepler(r, add(v, dv(r, v)), tb);
  return { post, blocks: EPOCHS.map((e, j) => block(j, e < tb ? pre : post)) };
}
export const rtn = (r, v) => { const R = unit(r), N = unit(cross(r, v)); return { R, T: cross(N, R), N }; };

export const LEO = () => circular(6778.137, 51.6, 30);      // 400 km circular, v = 7.6686 km/s

// Earth-fixed answers (what the propagator ABI's providers write) are turned
// to TEME by GMST (IAU 1982): the same history, rotated to Earth-fixed axes
// here by Vallado's gstime with velocity v - w x r, gives the same event. The
// rotation below is test-only reference math.
export const OMEGA = 7.292115146706979e-5;
export function gmst(t) {
  const tut1 = (t / 86400 + 2440587.5 - 2451545) / 36525;
  const sec = -6.2e-6 * tut1 ** 3 + 0.093104 * tut1 ** 2 + (876600 * 3600 + 8640184.812866) * tut1 + 67310.54841;
  return ((sec * Math.PI / 180 / 240) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}
export function toFixed(b) {
  const f = new OEM.RFMT();
  f.NAME = 'ITRF';
  b.REFERENCE_FRAME = f;
  const start = seconds(b.START_TIME), out = [];
  for (let i = 0; i * 6 < b.EPHEMERIS_DATA.length; ++i) {
    const [x, y, z, vx, vy, vz] = b.EPHEMERIS_DATA.slice(6 * i, 6 * i + 6), th = gmst(start + i * b.STEP_SIZE);
    const c = Math.cos(th), sn = Math.sin(th), xe = c * x + sn * y, ye = -sn * x + c * y;
    out.push(xe, ye, z, c * vx + sn * vy + OMEGA * ye, -sn * vx + c * vy - OMEGA * xe, vz);
  }
  b.EPHEMERIS_DATA = out;
  return b;
}

// D2: two in-track burns 9 h apart with two element sets between them are two
// events, each the vis-viva change of its own burn; one set between them (a
// set fitted across a burn looks the same) is one event.
export function burns(pre, list) {
  const orbits = [{ from: -Infinity, orbit: pre }];
  for (const { tb, dv } of list) {
    const [r, v] = orbits.at(-1).orbit(tb);
    orbits.push({ from: tb, orbit: kepler(r, add(v, mul(unit(v), dv)), tb) });
  }
  const at = (e) => orbits.filter((o) => o.from <= e).at(-1).orbit;
  return EPOCHS.map((e, j) => block(j, at(e)));
}
export const visViva = (orbit, tb, dv) => {
  const [r, v] = orbit(tb);
  const a0 = sma(r, v), a1 = sma(r, add(v, mul(unit(v), dv)));
  return MU * (a1 - a0) / (2 * a0 * a0 * norm(v));  // km/s, the module's conversion at the burn point
};

// compare_ephemerides: a version issued before a planned 1 m/s burn models
// it; the next version starts after it. Executed, the post-burn version flies
// the modelled orbit; cancelled, it flies the pre-burn one.
export function version(orbit, from, to, issued) {
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: 99001, OBJECT_ID: '2026-900A' });
  b.CENTER_NAME = 'EARTH';
  b.REFERENCE_FRAME = eme2000();
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  b.START_TIME = iso(from);
  b.STEP_SIZE = 60;
  const data = [];
  for (let s = from; s <= to + 1e-9; s += 60) { const [r, v] = orbit(s); data.push(...r, ...v); }
  b.EPHEMERIS_DATA = data;
  const m = new OEM.OEMT();
  m.CREATION_DATE = iso(issued);
  m.EPHEMERIS_DATA_BLOCK = [b];
  const builder = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishOEMBuffer(builder, m.pack(builder));
  return builder.asUint8Array();
}
// A planned maneuver of dvKms km/s at the TIG; `fields` states its UVW
// components (DELTA_VEL_V in-track, DELTA_VEL_W cross-track) and PROVENANCE.
export function planned(tig, dvKms, fields = {}) {
  const m = Object.assign(new MNV.MNVT(), { ID: 'PLAN-1', SAT_NO: 99001, STATUS: MNV.maneuverStatus.PLANNED, EVENT_START_TIME: iso(tig), DELTA_VEL: dvKms, ...fields });
  const b = new flatbuffers.Builder(512);
  MNV.MNV.finishMNVBuffer(b, m.pack(b));
  return b.asUint8Array();
}
// The query port with real providers: a synthetic GP history (one LEO object,
// a set every 8 h, mean anomaly, argument of perigee and node advancing at
// SGP4's first-order J2 secular rates, Hoots and Roehrich 1980) with a 1 m/s
// in-track burn (every later set's mean motion lowered by 3/2 n da/a,
// da = 2 a^2 v dv / mu). The detector asks for each set's trajectory; the host
// routes the queries to propagator/sgp4 (TEME) or to the keplerian reference
// through the propagator ABI (Earth-fixed metres); each finds the burn.
export function gpHistory(burnDv) {
  const XKE = 60 / Math.sqrt(6378.135 ** 3 / 398600.8), K2 = 0.5 * 0.001082616, RE = 6378.135, deg = Math.PI / 180;
  const inc = 51.6, e = 0.0008, ci = Math.cos(inc * deg), b = Math.sqrt(1 - e * e);
  const brouwer = (nRevDay) => {
    const n0 = nRevDay * 2 * Math.PI / 1440, a1 = (XKE / n0) ** (2 / 3), d1 = 1.5 * K2 / a1 ** 2 * (3 * ci * ci - 1) / b ** 3;
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 ** 3), d0 = 1.5 * K2 / a0 ** 2 * (3 * ci * ci - 1) / b ** 3;
    return { n: n0 / (1 + d0), a: a0 / (1 - d0) };
  };
  const rates = (nRevDay) => {
    const { n, a } = brouwer(nRevDay), p2 = (a * b * b) ** 2, perDay = 1440 / deg;
    return { M: n * (1 + 1.5 * K2 * b * (3 * ci * ci - 1) / p2) * perDay, w: 0.75 * K2 * n * (5 * ci * ci - 1) / p2 * perDay, O: -1.5 * K2 * n * ci / p2 * perDay, aKm: a * RE };
  };
  const t0 = 61285, n0 = 15.5, tb = t0 + 5 + 1 / 6;
  const pre = rates(n0);
  const v = Math.sqrt(398600.4418 / pre.aKm);
  const da = 2 * pre.aKm ** 2 * v * burnDv / 398600.4418 / 1000;
  const n1 = n0 * (1 - 1.5 * da / pre.aKm), post = rates(n1);
  const rows = [];
  for (let k = 0; k < 31; ++k) {
    const day = t0 + k / 3, after = burnDv && day > tb;
    const r = after ? post : pre, n = after ? n1 : n0, dt = day - t0;
    const M = after ? pre.M * (tb - t0) + post.M * (day - tb) : pre.M * dt;
    rows.push({ NORAD_CAT_ID: 99999, OBJECT_ID: '2026-999A', EPOCH: iso((day - 40587) * 86400).replace('Z', ''), MEAN_MOTION: n, ECCENTRICITY: e,
      INCLINATION: inc, RA_OF_ASC_NODE: (30 + r.O * dt) % 360, ARG_OF_PERICENTER: (90 + r.w * dt + 360) % 360, MEAN_ANOMALY: (M % 360 + 360) % 360, BSTAR: 0 });
  }
  return { tb: (tb - 40587) * 86400, rows };
}
