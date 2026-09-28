import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// Every expected value below is closed-form geometry, derived in the comment
// beside it. Inputs are straight-line or stationary Earth-fixed tracks, which
// cubic Hermite interpolation reproduces exactly, so the only numerical error
// is the 0.1 ms golden-section tolerance on the time of closest approach.
// Frame: Earth-fixed (BODY_FIXED, body 399). Units: metres, seconds, UTC.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const CQR = await import(pathToFileURL(path.join(root, 'lib/js/CQR/main.js')));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(wasmPath);

const NOMINAL = Date.UTC(2026, 9, 1, 18, 18, 0) / 1000;   // 2026-10-01T18:18:00Z
const WGS84_B = 6378137 * (1 - 1 / 298.257223563);          // polar radius, m
const iso = (seconds) => new Date(Math.round(seconds * 1000)).toISOString();
const seconds = (text) => Date.parse(text) / 1000;

function instant(t) {
  const x = new CQR.TIMInstantT();
  x.TIME_SYSTEM = CQR.timingStandard.UTC;
  x.EPOCH_FORMAT = CQR.timEpochRepresentation.ISO8601;
  x.ISO8601 = iso(t);
  return x;
}
// Uniform-step OEM of a track given by position(t) and velocity(t), in km.
function oem(start, stop, step, position, velocity) {
  const block = new CQR.ephemerisDataBlockT();
  block.CENTER_NAME = 'EARTH';
  block.TIME_SYSTEM = CQR.timingStandard.UTC;
  block.START_TIME = iso(start);
  block.STEP_SIZE = step;
  const data = [];
  for (let t = start; t <= stop + 1e-9; t += step) data.push(...position(t).map((v) => v / 1000), ...velocity(t).map((v) => v / 1000));
  block.EPHEMERIS_DATA = data;
  const message = new CQR.OEMT();
  message.EPHEMERIS_DATA_BLOCK = [block];
  return message;
}
const linear = (p0, v, t0) => [(t) => p0.map((x, i) => x + v[i] * (t - t0)), () => v];
function segment(id, track) {
  const s = new CQR.CQRLaunchSegmentT();
  s.SEGMENT_ID = id;
  s.TRAJECTORY = track;
  return s;
}
function orbiting(id, objectClass, track, rendezvous = false) {
  const source = new CQR.CQRObjectSourceT();
  source.OBJECT_ID = id;
  source.EPHEMERIS = track;
  const o = new CQR.CQRLaunchObjectT();
  o.SOURCE = source;
  o.OBJECT_CLASS = objectClass;
  o.RENDEZVOUS_COORDINATED = rendezvous;
  return o;
}
function criterion(objectClass, screening, fields) {
  const c = new CQR.CQRLaunchCriterionT();
  c.OBJECT_CLASS = objectClass;
  c.SCREENING = screening;
  Object.assign(c, fields);
  return c;
}
const K = CQR.cqrLaunchObjectClass, S = CQR.cqrLaunchScreening;
// The rule's criteria: 200 x 50 x 50 km ellipsoid, 25 km, 2.5 km.
const RULE = [
  criterion(K.INHABITABLE, S.ELLIPSOIDAL, { RADIAL_M: 50000, IN_TRACK_M: 200000, CROSS_TRACK_M: 50000 }),
  criterion(K.NON_DEBRIS, S.SPHERICAL, { RADIUS_M: 25000 }),
  criterion(K.DEBRIS, S.SPHERICAL, { RADIUS_M: 2500 }),
];
function request({ open, close, segments, objects, criteria = RULE, ...extra }) {
  const r = new CQR.CQRLaunchRequestT();
  r.MISSION_NAME = 'closed-form';
  r.NOMINAL_LIFTOFF = instant(NOMINAL);
  r.WINDOW_OPEN = instant(open);
  r.WINDOW_CLOSE = instant(close);
  r.SEGMENTS = segments;
  r.OBJECTS = objects;
  r.CRITERIA = criteria;
  const frame = new CQR.RFMCoordinateSystemT();
  frame.NAME = 'ITRF';
  frame.AXIS_TYPE = CQR.rfmAxisType.BODY_FIXED;
  frame.AXIS_REFERENCE_BODY_ID = 399;
  r.EVALUATION_FRAME = frame;
  Object.assign(r, extra);
  const message = new CQR.CQRT();
  message.LAUNCH_REQUEST = r;
  const builder = new flatbuffers.Builder(1 << 16);
  CQR.CQR.finishCQRBuffer(builder, message.pack(builder));
  return builder.asUint8Array();
}
async function screen(t, bytes) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const payload = Buffer.from(bytes);
  const result = await h.invoke({ methodId: 'screen_launch_window', inputs: [{ portId: 'request', payload, typeRef: { schemaName: 'CQR.fbs', fileIdentifier: '$CQR', rootTypeName: 'CQR', wireFormat: 'flatbuffer' } }] });
  if (result.statusCode !== 0) return { error: result.errorMessage };
  const out = result.outputs.find((f) => f.portId === 'result').payload;
  const launch = CQR.CQR.getRootAsCQR(new flatbuffers.ByteBuffer(new Uint8Array(out))).unpack().LAUNCH_RESULT;
  const report = JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString());
  return { launch, report };
}

// Crossing geometry (radius R0 ~ 400 km altitude on the x axis):
//   orbiting object q(t) = (R0, 0, 0) + (0, 7500, 0)(t - tN - 200)
//   launched object p(tau) = (R0 + 10 km, 0, 0) + (0, 0, 7000)(tau - 200)
// For liftoff tN + dT the relative position is a + b s with
//   a = (10 km, -7500 dT, 0), b = (0, -7500, 7000), s = tau - 200.
// Its minimum over s is |a_perp| = sqrt(10000^2 + (k dT)^2), k = 7000*7500/|b|
// = 5117.38 m/s, at s* = -(a.b)/|b|^2 = -0.534442 dT. Against 25 km it
// violates for |dT| < sqrt(25000^2 - 10000^2)/k = 4.4775 s.
const R0 = 6778137;
const crossingSegment = () => segment('stage-2', oem(NOMINAL, NOMINAL + 600, 10, ...linear([R0 + 10000, 0, 0], [0, 0, 7000], NOMINAL + 200)));
const crossingObject = (cls, rendezvous) => orbiting('40001', cls, oem(NOMINAL - 120, NOMINAL + 900, 10, ...linear([R0, 0, 0], [0, 7500, 0], NOMINAL + 200)), rendezvous);

test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('closes exactly the liftoff times within 25 km of a crossing track', async (t) => {
  const { launch, report, error } = await screen(t, request({
    open: NOMINAL - 60, close: NOMINAL + 60, segments: [crossingSegment()], objects: [crossingObject(K.NON_DEBRIS)],
  }));
  assert.equal(error, undefined, error);
  assert.equal(launch.LIFTOFF_TIMES_EVALUATED, 121n);
  // Violating grid liftoffs dT = -4..4; the closure is widened to the
  // neighbouring clear liftoffs, [-5, +5) s, and contains (-4.4775, 4.4775).
  assert.equal(launch.CLOSURES.length, 1);
  assert.equal(seconds(launch.CLOSURES[0].START.ISO8601) - NOMINAL, -5);
  assert.equal(seconds(launch.CLOSURES[0].END.ISO8601) - NOMINAL, 5);
  assert.deepEqual(launch.CLOSURES[0].OBJECT_IDS, ['40001']);
  assert.deepEqual(report.closures, [`${iso(NOMINAL - 5)}/${iso(NOMINAL + 5)}`]);
  assert.equal(launch.APPROACHES.length, 1);
  const a = launch.APPROACHES[0];
  assert.equal(seconds(a.LIFTOFF.ISO8601), NOMINAL);
  assert.equal(seconds(a.RUN_START.ISO8601) - NOMINAL, -4);
  assert.equal(seconds(a.RUN_END.ISO8601) - NOMINAL, 4);
  assert.ok(Math.abs(a.MISS_DISTANCE_M - 10000) < 1e-3, `${a.MISS_DISTANCE_M}`);
  assert.ok(Math.abs(a.CRITERION_RATIO - 0.4) < 1e-7);
  assert.ok(Math.abs(seconds(a.TCA.ISO8601) - (NOMINAL + 200)) <= 0.001);
  assert.equal(a.VIOLATES, true);
  // Inertial relative velocity = (v_p - v_q) + omega x rel. At TCA rel =
  // (10 km, 0, 0), so omega x rel = (0, 7.2921150e-5 * 10000, 0) and the
  // speed is |(0, -7500 + 0.72921150, 7000)|.
  assert.ok(Math.abs(a.RELATIVE_SPEED_M_S - Math.hypot(7500 - 7.2921150e-5 * 10000, 7000)) < 1e-3, `${a.RELATIVE_SPEED_M_S}`);
});

test('a coordinated rendezvous is reported but never closes the window', async (t) => {
  const { launch, error } = await screen(t, request({
    open: NOMINAL - 60, close: NOMINAL + 60, segments: [crossingSegment()], objects: [crossingObject(K.NON_DEBRIS, true)],
  }));
  assert.equal(error, undefined, error);
  assert.equal(launch.CLOSURES.length, 0);
  assert.equal(launch.APPROACHES.length, 1);
  assert.equal(launch.APPROACHES[0].VIOLATES, true);
  assert.equal(launch.APPROACHES[0].RENDEZVOUS_COORDINATED, true);
});

test('closure pad widens both ends', async (t) => {
  const { launch } = await screen(t, request({
    open: NOMINAL - 60, close: NOMINAL + 60, segments: [crossingSegment()], objects: [crossingObject(K.NON_DEBRIS)], CLOSURE_PAD_SECONDS: 30,
  }));
  assert.equal(seconds(launch.CLOSURES[0].START.ISO8601) - NOMINAL, -35);
  assert.equal(seconds(launch.CLOSURES[0].END.ISO8601) - NOMINAL, 35);
});

// Ellipsoid geometry on the polar axis, one liftoff (window = nominal).
//   orbiting object q(t) = (0, 0, Rq) + (7500, 0, 0)(t - tN - 200)
//   launched object p(tau) = (0, 0, Rq + 30 km) + (7500, 7000, 0)(tau - 200)
// At TCA the object sits on +z moving along +x, so omega x q = 0 and its
// radial/in-track/cross-track axes are z, x, y exactly. The relative position
// is (0, 7000 s, 30 km): miss 30 km, RTN (30 km, 0, 0). Against the
// 50 x 200 x 50 km ellipsoid the ratio is 30/50 = 0.6 (violates); against a
// 25 km sphere it is 30/25 = 1.2 (does not).
const Rq = 6778137;
const polarSegment = () => segment('stage-2', oem(NOMINAL, NOMINAL + 600, 10, ...linear([0, 0, Rq + 30000], [7500, 7000, 0], NOMINAL + 200)));
const polarObject = (cls) => orbiting('25544', cls, oem(NOMINAL - 60, NOMINAL + 900, 10, ...linear([0, 0, Rq], [7500, 0, 0], NOMINAL + 200)));

test('an inhabitable object uses the radial/in-track/cross-track ellipsoid', async (t) => {
  const { launch, error } = await screen(t, request({ open: NOMINAL, close: NOMINAL, segments: [polarSegment()], objects: [polarObject(K.INHABITABLE)] }));
  assert.equal(error, undefined, error);
  assert.equal(launch.LIFTOFF_TIMES_EVALUATED, 1n);
  const a = launch.APPROACHES[0];
  assert.ok(Math.abs(a.MISS_DISTANCE_M - 30000) < 1e-3);
  assert.ok(Math.abs(a.CRITERION_RATIO - 0.6) < 1e-6, `${a.CRITERION_RATIO}`);
  assert.ok(Math.abs(a.RELATIVE_POSITION_RTN.X - 30000) < 1e-3);
  assert.ok(Math.abs(a.RELATIVE_POSITION_RTN.Y) < 1e-3 && Math.abs(a.RELATIVE_POSITION_RTN.Z) < 1);
  assert.equal(a.VIOLATES, true);
  assert.equal(launch.CLOSURES.length, 1);
});

test('the same pass against a non-debris object is clear of its 25 km sphere', async (t) => {
  const { launch, error } = await screen(t, request({
    open: NOMINAL, close: NOMINAL, segments: [polarSegment()], objects: [polarObject(K.NON_DEBRIS)], REPORT_RATIO: 2,
  }));
  assert.equal(error, undefined, error);
  assert.equal(launch.CLOSURES.length, 0);
  assert.equal(launch.APPROACHES.length, 1);
  assert.ok(Math.abs(launch.APPROACHES[0].CRITERION_RATIO - 1.2) < 1e-7);
  assert.equal(launch.APPROACHES[0].VIOLATES, false);
});

// Altitude floor. On the polar axis the WGS 84 height is exactly z - b.
// The launched object rises along +z at 1 km/s from 100 km: p(tau) =
// (0, 0, b + 100 km + 1000 tau). A stationary debris object 1 km off the axis
// at height 140 km is passed at tau = 40 s, 10 km below the 150 km floor; the
// nearest screened point (tau = 50) is sqrt(1000^2 + 10000^2) = 10.05 km away,
// clear of 2.5 km. The same object at 160 km is passed at tau = 60 s at 1 km.
function risingCase(height) {
  const rising = segment('stage-1', oem(NOMINAL, NOMINAL + 100, 1, ...linear([0, 0, WGS84_B + 100000], [0, 0, 1000], NOMINAL)));
  const debris = orbiting('90001', K.DEBRIS, oem(NOMINAL - 10, NOMINAL + 200, 10, () => [1000, 0, WGS84_B + height], () => [0, 0, 0]));
  return request({ open: NOMINAL, close: NOMINAL, segments: [rising], objects: [debris], REPORT_RATIO: 10 });
}

test('nothing below the 150 km altitude floor is screened', async (t) => {
  const low = await screen(t, risingCase(140000));
  assert.equal(low.error, undefined, low.error);
  assert.equal(low.launch.CLOSURES.length, 0);
  const a = low.launch.APPROACHES[0];
  assert.ok(Math.abs(a.MISS_DISTANCE_M - Math.hypot(1000, 10000)) < 1e-3, `${a.MISS_DISTANCE_M}`);
  assert.ok(Math.abs(seconds(a.TCA.ISO8601) - (NOMINAL + 50)) <= 0.001);
  const high = await screen(t, risingCase(160000));
  assert.equal(high.error, undefined, high.error);
  assert.equal(high.launch.CLOSURES.length, 1);
  assert.ok(Math.abs(high.launch.APPROACHES[0].MISS_DISTANCE_M - 1000) < 1e-3);
  assert.ok(Math.abs(seconds(high.launch.APPROACHES[0].TCA.ISO8601) - (NOMINAL + 60)) <= 0.001);
});

test('refuses what it cannot screen instead of approximating', async (t) => {
  const probability = await screen(t, request({
    open: NOMINAL, close: NOMINAL, segments: [crossingSegment()], objects: [crossingObject(K.NON_DEBRIS)],
    criteria: [criterion(K.NON_DEBRIS, S.PROBABILITY, { MAX_PROBABILITY: 1e-5 })],
  }));
  assert.match(probability.error, /covariance/);
  const uncovered = await screen(t, request({
    open: NOMINAL - 3600, close: NOMINAL, segments: [crossingSegment()], objects: [crossingObject(K.NON_DEBRIS)],
  }));
  assert.match(uncovered.error, /does not cover/);
  const unclassified = await screen(t, request({
    open: NOMINAL, close: NOMINAL, segments: [crossingSegment()], objects: [crossingObject(K.UNSPECIFIED)],
  }));
  assert.match(unclassified.error, /OBJECT_CLASS/);
});
