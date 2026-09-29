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

test('Earth-fixed ephemerides are refused', async (t) => {
  const w = new OEM.CelestialFrameWrapperT();
  w.frame = OEM.CelestialFrame.ITRF2000;
  const f = new OEM.RFMT();
  f.REFERENCE_FRAME_type = OEM.RFMUnion.CelestialFrameWrapper;
  f.REFERENCE_FRAME = w;
  const { error } = await detect(t, oem([block(0, LEO(), { frame: f }), block(1, LEO(), { frame: f })]));
  assert.match(error, /inertial/);
});
