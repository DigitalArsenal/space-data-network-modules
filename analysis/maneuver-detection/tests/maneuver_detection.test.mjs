import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// Closed-form two-body cases. Each element set is a Keplerian orbit (mu =
// 398600.4418 km^3/s^2, the module's constant), propagated here by solving
// the universal Kepler equation; a burn is an instantaneous velocity change at t_b, so
// every set with an epoch after t_b describes the post-burn orbit. Expected
// values come from vis-viva and the rotation of the orbit normal, derived in
// the comment beside each assertion. Frame: EME2000. Units: km, km/s, UTC.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const OEM = await import(pathToFileURL(path.join(root, 'lib/js/OEM/main.js')));
const MNV = await import(pathToFileURL(path.join(root, 'lib/js/MNV/main.js')));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(wasmPath);

const MU = 398600.4418;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0) / 1000;           // 2026-09-01T00:00:00Z
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const seconds = (text) => Date.parse(text) / 1000;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const add = (a, b) => a.map((x, i) => x + b[i]);
const mul = (a, s) => a.map((x) => x * s);
const unit = (a) => mul(a, 1 / norm(a));
const sma = (r, v) => 1 / (2 / norm(r) - dot(v, v) / MU);

// Two-body propagation from (r0, v0) at t0: Lagrange f and g with the
// universal anomaly chi (Vallado, Fundamentals of Astrodynamics, 4th ed.,
// algorithm 8), Newton iteration on the universal Kepler equation. Exact at
// t = t0 (f = 1, g = 0) for every eccentricity.
function stumpff(z) {
  if (z > 1e-8) { const s = Math.sqrt(z); return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * z)]; }
  if (z < -1e-8) { const s = Math.sqrt(-z); return [(1 - Math.cosh(s)) / z, (Math.sinh(s) - s) / (s * -z)]; }
  return [1 / 2 - z / 24, 1 / 6 - z / 120];
}
function kepler(r0, v0, t0) {
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
function circular(a, inc, raan) {
  const I = inc * Math.PI / 180, O = raan * Math.PI / 180;
  const node = [Math.cos(O), Math.sin(O), 0];
  const normal = [Math.sin(O) * Math.sin(I), -Math.cos(O) * Math.sin(I), Math.cos(I)];
  const along = cross(normal, node);
  return kepler(mul(node, a), mul(along, Math.sqrt(MU / a)), T0);
}

// Element-set epochs every 4 h with a deterministic +-37 min jitter, on whole minutes.
const EPOCHS = Array.from({ length: 31 }, (_, j) => T0 + j * 14400 + (j % 2 ? 2220 : -2220) + (j === 0 ? 2220 : 0));

function eme2000() {
  const w = new OEM.CelestialFrameWrapperT();
  w.frame = OEM.CelestialFrame.EME2000;
  const f = new OEM.RFMT();
  f.REFERENCE_FRAME_type = OEM.RFMUnion.CelestialFrameWrapper;
  f.REFERENCE_FRAME = w;
  return f;
}
// One block per element set j: its orbit sampled every 60 s from epoch j-2 to j+2.
function block(j, orbit, { frame = eme2000(), norad = 99001, id = '2026-900A' } = {}) {
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
function oem(blocks) {
  const m = new OEM.OEMT();
  m.CREATION_DATE = '2026-09-29T00:00:00.000Z';
  m.EPHEMERIS_DATA_BLOCK = blocks;
  const builder = new flatbuffers.Builder(1 << 20);
  OEM.OEM.finishOEMBuffer(builder, m.pack(builder));
  return builder.asUint8Array();
}
// Sets before the burn fly `pre`; sets at or after it fly the post-burn orbit.
function history(pre, tb, dv) {
  const [r, v] = pre(tb);
  const post = kepler(r, add(v, dv(r, v)), tb);
  return { post, blocks: EPOCHS.map((e, j) => block(j, e < tb ? pre : post)) };
}
const rtn = (r, v) => { const R = unit(r), N = unit(cross(r, v)); return { R, T: cross(N, R), N }; };

async function detect(t, bytes, options) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const inputs = [{ portId: 'ephemerides', payload: Buffer.from(bytes), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }];
  if (options) inputs.push({ portId: 'options', payload: Buffer.from(JSON.stringify(options)), typeRef: { schemaName: 'application/json' } });
  const result = await h.invoke({ methodId: 'detect_maneuvers', inputs });
  if (result.statusCode !== 0) return { error: result.errorMessage };
  const events = result.outputs.filter((f) => f.portId === 'maneuvers')
    .map((f) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack());
  const report = JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString());
  return { events, report };
}

const LEO = () => circular(6778.137, 51.6, 30);      // 400 km circular, v = 7.6686 km/s

test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('an unburned history yields no event', async (t) => {
  const { events, report, error } = await detect(t, oem(EPOCHS.map((e, j) => block(j, LEO()))));
  assert.equal(error, undefined, error);
  assert.equal(events.length, 0);
  assert.equal(report.objects[0].status, 'screened');
  assert.equal(report.objects[0].element_sets, 31);
});

test('a 1 m/s in-track burn on a grid node: exact time and vis-viva delta-V', async (t) => {
  const pre = LEO();
  const tb = EPOCHS[15] + 3600;                        // a whole minute, so a 60 s grid node of every block
  const { blocks } = history(pre, tb, (r, v) => mul(unit(v), 0.001));
  // Shuffled input: blocks are ordered by the midpoint of their span.
  const shuffled = blocks.map((b, i) => [(i * 7919) % 31, b]).sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  const { events, error } = await detect(t, oem(shuffled));
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  const e = events[0];
  // The trajectories meet only at t_b (separation |dv| |t - t_b| nearby), and
  // t_b is a sample of both blocks, so the crossing is exact.
  assert.equal(seconds(e.EVENT_START_TIME), tb);
  assert.equal(e.EVENT_END_TIME, e.EVENT_START_TIME);
  // The post-burn orbit is rebuilt from elements, so its state at t_b
  // matches the pre-burn one to double-precision round trip (~1e-9 km).
  assert.ok(e.MANEUVER_UNC < 1e-6, `separation at the crossing ${e.MANEUVER_UNC} km`);
  // In-track estimate v da / (2a): with v^2 = mu/a and eps = dv/v, vis-viva
  // gives a1 = a / (1 - 2 eps - eps^2), so the estimate is dv (1 + 2.5 eps) to
  // second order. Computed exactly here from the sampled pre-burn state.
  const [r, v] = pre(tb);
  const a0 = sma(r, v), a1 = sma(r, add(v, mul(unit(v), 0.001)));
  const expected = norm(v) * (a1 - a0) / (2 * a0);
  // Tolerance 1e-9 km/s (1 um/s): the element round trip of the post orbit.
  assert.ok(Math.abs(e.DELTA_VEL_U - expected) < 1e-9, `U ${e.DELTA_VEL_U} vs ${expected} km/s`);
  assert.ok(Math.abs(expected - 0.001) < 0.001 * 3.5 / 7668, 'second-order term is 2.5 eps');
  assert.ok(Math.abs(e.DELTA_VEL_V) < 1e-9, 'an in-plane burn leaves the orbit normal unchanged');
  assert.equal(e.DELTA_VEL_W, 0);
  assert.equal(e.STATUS, MNV.maneuverStatus.DETECTED);
  assert.equal(e.CHARACTERIZATION, MNV.maneuverCharacterization.ORBIT_RAISING);
  assert.equal(e.SAT_NO, 99001);
  assert.equal(e.ORIG_OBJECT_ID, '2026-900A');
  assert.deepEqual(e.SOURCED_DATA, ['ELSET 15', 'ELSET 16']);
  // PRE_EVENT / POST_EVENT are the osculating states at t_b.
  assert.ok(Math.abs(e.PRE_EVENT.SMA - a0) < 1e-6 && Math.abs(e.POST_EVENT.SMA - a1) < 1e-6);
  assert.ok(Math.abs(e.PRE_EVENT.INCLINATION - 51.6) < 1e-9);
  assert.ok(Math.abs(e.PRE_EVENT.RAAN - 30) < 1e-9);
});

test('a 1 m/s in-track burn between grid nodes: time and delta-V within the interpolation bound', async (t) => {
  const pre = LEO();
  const tb = EPOCHS[15] + 3600 + 23.7;
  const { blocks } = history(pre, tb, (r, v) => mul(unit(v), 0.001));
  const { events, error } = await detect(t, oem(blocks));
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  const e = events[0];
  // Cubic Hermite over 60 s at 400 km interpolates position to ~0.4 m
  // (h^4 max|r''''| / 384 = 60^4 * w^4 r / 384 with w = 1.13e-3 rad/s). Near
  // t_b the separation grows at 1 m/s, so the crossing is found within ~0.5 s.
  assert.ok(Math.abs(seconds(e.EVENT_START_TIME) - tb) < 0.5, `crossing ${e.EVENT_START_TIME}`);
  const [r, v] = pre(tb);
  const expected = norm(v) * (sma(r, add(v, mul(unit(v), 0.001))) - sma(r, v)) / (2 * sma(r, v));
  // Both orbits are interpolated on one grid and differ by 1e-4 in speed, so
  // their interpolation errors cancel in the energy difference to ~1e-4 of
  // the Hermite velocity error (~2e-2 m/s): 1 mm/s bounds it.
  assert.ok(Math.abs(e.DELTA_VEL_U - expected) < 1e-6, `U ${e.DELTA_VEL_U} vs ${expected} km/s`);
});

test('a 2 m/s cross-track burn: out-of-plane, delta-V from the orbit-normal rotation', async (t) => {
  const pre = LEO();
  const tb = EPOCHS[12] + 5400;
  const { events, report, error } = await detect(t, oem(history(pre, tb, (r, v) => mul(rtn(r, v).N, 0.002)).blocks));
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(seconds(e.EVENT_START_TIME), tb);
  // Circular orbit: r x (v T + dv N) = r v N - r dv T, so the new normal is
  // cos(theta) N - sin(theta) T with tan(theta) = dv / v. The estimate is
  // -v (h_hat1 - h_hat0) . T = v sin(theta) = v dv / sqrt(v^2 + dv^2),
  // positive for a burn along +N. Tolerance: element round trip, 1e-9 km/s.
  const [r, v] = pre(tb);
  const vs = norm(v);
  assert.ok(Math.abs(e.DELTA_VEL_V - vs * 0.002 / Math.hypot(vs, 0.002)) < 1e-9, `V ${e.DELTA_VEL_V}`);
  // Speed rises from v to sqrt(v^2 + dv^2), so the in-track jump is the
  // vis-viva term dv^2 / (2v) = 2.6e-4 m/s, under the 0.08 m/s floor: the
  // in-track step does not fire and the reported component is 0.
  assert.equal(e.DELTA_VEL_U, 0);
  const expectedU = norm(v) * (sma(r, add(v, mul(rtn(r, v).N, 0.002))) - sma(r, v)) / (2 * sma(r, v));
  const reported = report.objects[0].events[0];
  assert.ok(Math.abs(reported.raw_in_track_mps / 1000 - expectedU) < 1e-9);
  assert.equal(reported.in_track_fired, false);
  assert.equal(reported.cross_track_fired, true);
  assert.equal(e.CHARACTERIZATION, MNV.maneuverCharacterization.OUT_OF_PLANE);
});

test('one outlying element set is not a maneuver', async (t) => {
  // Set 14 alone flies an orbit 0.5 km higher (a 0.28 m/s in-track
  // equivalent): the pairs 13-14 and 14-15 jump by +x and -x, the per-set
  // level returns to its old value, and a median of three levels ignores it.
  const nominal = LEO();
  const [r, v] = nominal(EPOCHS[14]);
  const high = kepler(r, mul(unit(v), Math.sqrt(MU * (2 / norm(r) - 1 / (sma(r, v) + 0.5)))), EPOCHS[14]);
  const { events, report, error } = await detect(t, oem(EPOCHS.map((e, j) => block(j, j === 14 ? high : nominal))));
  assert.equal(error, undefined, error);
  assert.equal(events.length, 0);
  const pairs = report.objects[0].pairs;
  assert.ok(pairs[13].in_track_mps > 0.25 && pairs[14].in_track_mps < -0.25, 'both single-pair jumps are present');
  // The two jumps use each pair's own starting orbit (v / 2a), so they cancel
  // to second order, x (da / a) / 2 = 0.283 * (0.5 / 6778) / 2 = 1e-5 m/s.
  assert.ok(pairs.every((p) => Math.abs(p.step_in_track_mps) < 2e-5), 'the median step stays at the second-order residue');
});

test('a GEO in-plane trim is station keeping', async (t) => {
  // 0.05 m/s at GEO (v = 3.0747 km/s) changes a by 2 a dv / v = 1.37 km,
  // under the 5 km station-keeping bound; the default 0.08 m/s floor is for
  // LEO, so this history states a 0.02 m/s floor.
  const pre = circular(42164.17, 0.05, 80);
  const tb = EPOCHS[16] + 7200;
  const { events, error } = await detect(t, oem(history(pre, tb, (r, v) => mul(unit(v), 0.00005)).blocks), { floor_in_track_mps: 0.02 });
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(seconds(e.EVENT_START_TIME), tb);
  assert.ok(Math.abs(e.POST_EVENT.SMA - e.PRE_EVENT.SMA - 2 * 42164.17 * 0.05 / 3074.66) < 0.01);
  assert.equal(e.CHARACTERIZATION, MNV.maneuverCharacterization.STATION_KEEPING);
});

// Earth-fixed answers (what the propagator ABI's providers write) are turned
// to TEME by GMST (IAU 1982): the same history, rotated to Earth-fixed axes
// here by Vallado's gstime with velocity v - w x r, gives the same event. The
// rotation below is test-only reference math.
const OMEGA = 7.292115146706979e-5;
function gmst(t) {
  const tut1 = (t / 86400 + 2440587.5 - 2451545) / 36525;
  const sec = -6.2e-6 * tut1 ** 3 + 0.093104 * tut1 ** 2 + (876600 * 3600 + 8640184.812866) * tut1 + 67310.54841;
  return ((sec * Math.PI / 180 / 240) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}
function toFixed(b) {
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

test('an Earth-fixed history gives the inertial history\'s event', async (t) => {
  const pre = LEO();
  const tb = EPOCHS[15] + 3600;
  const inertial = await detect(t, oem(history(pre, tb, (r, v) => mul(unit(v), 0.001)).blocks));
  const fixed = await detect(t, oem(history(pre, tb, (r, v) => mul(unit(v), 0.001)).blocks.map(toFixed)));
  assert.equal(fixed.error, undefined, fixed.error);
  assert.equal(fixed.events.length, 1);
  assert.equal(fixed.report.objects[0].frame, 'TEMEOFDATE');
  // One rotation per instant, shared by both trajectories: the crossing and
  // the energy jump are unchanged to rounding (1 ms, 1 um/s).
  assert.ok(Math.abs(seconds(fixed.events[0].EVENT_START_TIME) - seconds(inertial.events[0].EVENT_START_TIME)) <= 0.001);
  assert.ok(Math.abs(fixed.events[0].DELTA_VEL_U - inertial.events[0].DELTA_VEL_U) < 1e-9);
});

// D2: two in-track burns 9 h apart with two element sets between them are two
// events, each the vis-viva change of its own burn; one set between them (a
// set fitted across a burn looks the same) is one event.
function burns(pre, list) {
  const orbits = [{ from: -Infinity, orbit: pre }];
  for (const { tb, dv } of list) {
    const [r, v] = orbits.at(-1).orbit(tb);
    orbits.push({ from: tb, orbit: kepler(r, add(v, mul(unit(v), dv)), tb) });
  }
  const at = (e) => orbits.filter((o) => o.from <= e).at(-1).orbit;
  return EPOCHS.map((e, j) => block(j, at(e)));
}
const visViva = (orbit, tb, dv) => {
  const [r, v] = orbit(tb);
  const a0 = sma(r, v), a1 = sma(r, add(v, mul(unit(v), dv)));
  return MU * (a1 - a0) / (2 * a0 * a0 * norm(v));  // km/s, the module's conversion at the burn point
};

test('D2: two burns with two sets between them are two events', async (t) => {
  const pre = LEO();
  const t1 = EPOCHS[14] + 1800, t2 = t1 + 9 * 3600;
  assert.equal(EPOCHS.filter((e) => e > t1 && e < t2).length, 2);
  const { events, report, error } = await detect(t, oem(burns(pre, [{ tb: t1, dv: 0.0005 }, { tb: t2, dv: 0.0007 }])), { detectors: ['D2'] });
  assert.equal(error, undefined, error);
  assert.equal(events.length, 2, JSON.stringify(report.objects[0].D2));
  // Each level is the orbit-averaged semi-major axis, exact for two-body
  // orbits, so each step is the burn's own da; its time is the crossing of
  // the sets on either side (exact at a sample, within 0.5 s off one).
  const [r, v] = pre(t1);
  const second = kepler(r, add(v, mul(unit(v), 0.0005)), t1);
  assert.ok(Math.abs(seconds(events[0].EVENT_START_TIME) - t1) < 1, events[0].EVENT_START_TIME);
  assert.ok(Math.abs(seconds(events[1].EVENT_START_TIME) - t2) < 1, events[1].EVENT_START_TIME);
  assert.ok(Math.abs(events[0].DELTA_VEL_U - visViva(pre, t1, 0.0005)) < 1e-8, `${events[0].DELTA_VEL_U}`);
  assert.ok(Math.abs(events[1].DELTA_VEL_U - visViva(second, t2, 0.0007)) < 1e-8, `${events[1].DELTA_VEL_U}`);
});

test('D2: two burns with one set between them are one event', async (t) => {
  const pre = LEO();
  const t1 = EPOCHS[14] + 1800, t2 = EPOCHS[15] + 1800;
  assert.equal(EPOCHS.filter((e) => e > t1 && e < t2).length, 1);
  const { events, error } = await detect(t, oem(burns(pre, [{ tb: t1, dv: 0.0005 }, { tb: t2, dv: 0.0007 }])), { detectors: ['D2'] });
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  // The step spans both burns: 1.2 m/s to first order.
  assert.ok(Math.abs(events[0].DELTA_VEL_U * 1000 - 1.2) < 0.01, `${events[0].DELTA_VEL_U * 1000} m/s`);
});

// compare_ephemerides: a version issued before a planned 1 m/s burn models
// it; the next version starts after it. Executed, the post-burn version flies
// the modelled orbit; cancelled, it flies the pre-burn one.
function version(orbit, from, to, issued) {
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
function planned(tig, dvKms) {
  const m = Object.assign(new MNV.MNVT(), { ID: 'PLAN-1', SAT_NO: 99001, STATUS: MNV.maneuverStatus.PLANNED, EVENT_START_TIME: iso(tig), DELTA_VEL: dvKms });
  const b = new flatbuffers.Builder(512);
  MNV.MNV.finishMNVBuffer(b, m.pack(b));
  return b.asUint8Array();
}
async function compare(t, versions, plan) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const typeRef = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };
  const result = await h.invoke({ methodId: 'compare_ephemerides', inputs: [
    ...versions.map((v) => ({ portId: 'versions', payload: Buffer.from(v), typeRef })),
    { portId: 'planned', payload: Buffer.from(plan), typeRef: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' } }] });
  if (result.statusCode !== 0) return { error: result.errorMessage };
  return { checks: result.outputs.filter((f) => f.portId === 'maneuvers').map((f) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack()),
    report: JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString()) };
}

test('compare_ephemerides: a planned burn executed and cancelled', async (t) => {
  const pre = LEO();
  const tig = T0 + 86400;
  const [r, v] = pre(tig);
  const post = kepler(r, add(v, mul(unit(v), 0.001)), tig);
  const plan = (s) => (s < tig ? pre : post)(s);
  const before = version(plan, T0, T0 + 3 * 86400, tig - 7200);
  // The executed burn: the planned 1 m/s in-track change, as vis-viva gives it
  // at the burn (the pre-burn version's own model; two-body, so exact).
  const expected = norm(v) * (sma(r, add(v, mul(unit(v), 0.001))) - sma(r, v)) / (2 * sma(r, v));
  const done = await compare(t, [before, version(post, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)], planned(tig, 0.001));
  assert.equal(done.error, undefined, done.error);
  assert.equal(done.checks.length, 1);
  assert.equal(done.checks[0].STATUS, MNV.maneuverStatus.EXECUTED);
  // The orbit-averaged a over whole revolutions of a two-body orbit is its a:
  // 1e-6 km/s (1 mm/s) bounds the Hermite interpolation of the averages.
  assert.ok(Math.abs(done.checks[0].DELTA_VEL_U - expected) < 1e-6, `${done.checks[0].DELTA_VEL_U} vs ${expected}`);
  const skipped = await compare(t, [before, version(pre, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)], planned(tig, 0.001));
  assert.equal(skipped.checks[0].STATUS, MNV.maneuverStatus.CANCELLED);
  assert.ok(Math.abs(skipped.checks[0].DELTA_VEL_U) < 1e-6);
});

// The query port with real providers: a synthetic GP history (one LEO object,
// a set every 8 h, mean anomaly, argument of perigee and node advancing at
// SGP4's first-order J2 secular rates, Hoots and Roehrich 1980) with a 1 m/s
// in-track burn (every later set's mean motion lowered by 3/2 n da/a,
// da = 2 a^2 v dv / mu). The detector asks for each set's trajectory; the host
// routes the queries to propagator/sgp4 (TEME) or to the keplerian reference
// through the propagator ABI (Earth-fixed metres); each finds the burn.
function gpHistory(burnDv) {
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

test('the propagator query port: SGP4 and an ABI provider each answer, and each finds the burn', async () => {
  const host = await import('../study/lib/host.mjs');
  const detector = await host.loadModule('analysis/maneuver-detection');
  try {
    const { tb, rows } = gpHistory(1);
    const options = { propagator_port_id: 'test', detectors: ['D1', 'D2'] };
    const first = await detector.invoke('detect_maneuvers', [{ portId: 'element_sets', payload: host.ommStream(rows), typeRef: host.TYPES.OMM }, host.json('options', options)]);
    const requests = host.jsonOf(first, 'propagation_requests');
    assert.equal(requests.queries.length, 31);
    assert.equal(requests.propagator_port_id, 'test');
    // Set 5's span: from set 3's epoch to set 7's.
    assert.equal(requests.queries[5].start, `${rows[3].EPOCH}Z`);
    assert.equal(requests.queries[5].stop, `${rows[7].EPOCH}Z`);
    for (const provider of [await host.sgp4Provider(), await host.keplerianProvider()]) {
      const { results } = await host.detectWith(detector, provider, rows, [options]);
      // The synthetic sets' nodes advance at first-order J2 rates, which SGP4
      // does not reproduce exactly, so their planes disagree by metres per
      // second and D2's plane test reports that; the in-track events are
      // asserted: exactly one, the burn.
      const events = results[0].maneuvers.map(host.unpackMnv).filter((m) => m.DELTA_VEL_U !== 0);
      assert.equal(events.length, 1, `${provider.name}: ${JSON.stringify(results[0].report.objects[0].events)}`);
      const [m] = events;
      assert.ok(m.DELTA_VEL_U > 0, provider.name);
      // Within the sets bracketing the burn (8 h apart).
      assert.ok(Math.abs(seconds(m.EVENT_START_TIME) - tb) < 8 * 3600, `${provider.name}: ${m.EVENT_START_TIME}`);
      // Mean-element changes map to the osculating jump only to first order in
      // J2 (SGP4); the keplerian reference reads mean motion as two-body.
      assert.ok(Math.abs(m.DELTA_VEL_U * 1000 - 1) < 0.1, `${provider.name}: ${m.DELTA_VEL_U * 1000} m/s`);
    }
    // Answers out of order are refused, never matched to the wrong set.
    const { answer } = await host.sgp4Provider();
    const answers = await answer(requests, rows);
    const swapped = host.OEM.OEM.getRootAsOEM(new host.flatbuffers.ByteBuffer(answers[0])).unpack();
    swapped.EPHEMERIS_DATA_BLOCK.reverse();
    await assert.rejects(detector.invoke('detect_maneuvers', [{ portId: 'element_sets', payload: host.ommStream(rows), typeRef: host.TYPES.OMM },
      host.json('options', options), { portId: 'propagation', payload: host.oemFrame(swapped.EPHEMERIS_DATA_BLOCK), typeRef: host.TYPES.OEM }]), /does not cover|span/);
  } finally {
    await detector.destroy();
  }
});

// score_detections: two truth burns and three events; the third event is in
// no truth window. Recall 2/2 with its Wilson interval, one false alarm in
// half a year.
test('score_detections: matches, recall and false alarms per object-year', async (t) => {
  const mnv = (fields) => {
    const m = Object.assign(new MNV.MNVT(), { SAT_NO: 99001, ...fields });
    const b = new flatbuffers.Builder(512);
    MNV.MNV.finishSizePrefixedMNVBuffer(b, m.pack(b));
    return Buffer.from(b.asUint8Array());
  };
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const typeRef = { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' };
  const result = await h.invoke({ methodId: 'score_detections', inputs: [
    { portId: 'truth', payload: Buffer.concat([mnv({ ID: 'a', EVENT_START_TIME: iso(T0), DELTA_VEL: 0.001 }), mnv({ ID: 'b', EVENT_START_TIME: iso(T0 + 10 * 86400), DELTA_VEL: 0.002 })]), typeRef },
    { portId: 'detected', payload: Buffer.concat([mnv({ ID: 'x', EVENT_START_TIME: iso(T0 + 1800), DELTA_VEL: 0.0009 }),
      mnv({ ID: 'y', EVENT_START_TIME: iso(T0 + 10 * 86400 + 7200), DELTA_VEL: 0.0021 }), mnv({ ID: 'z', EVENT_START_TIME: iso(T0 + 5 * 86400), DELTA_VEL: 0.0001 })]), typeRef },
    { portId: 'options', payload: Buffer.from(JSON.stringify({ spans: [{ object: 'NORAD:99001', from: iso(T0), to: iso(T0 + 365.25 * 43200) }] })), typeRef: { schemaName: 'application/json' } }] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const { summary, matches } = JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString());
  assert.equal(summary.detected, 2);
  // Wilson 95 % for 2/2: [n / (n + z^2), 1] = [0.3424, 1] with z = 1.95996.
  assert.ok(Math.abs(summary.wilson95[0] - 2 / (2 + 1.959963984540054 ** 2)) < 1e-12);
  assert.equal(summary.false_alarms, 1);
  assert.ok(Math.abs(summary.false_alarms_per_object_year - 2) < 1e-12);
  assert.deepEqual(matches.map((m) => m.time_error_s), [1800, 7200]);
  assert.ok(Math.abs(matches[0].dv_ratio - 0.9) < 1e-12);
});
