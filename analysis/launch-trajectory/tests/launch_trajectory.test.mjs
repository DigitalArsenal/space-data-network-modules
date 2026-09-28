import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// Fixtures (tests/fixtures/make-fixtures.py records how each was built):
// broadcast telemetry of three Falcon 9 ascents (The Unlicense), and for each
// the first catalog element set propagated with python-sgp4 to osculating
// TEME elements, second by second around engine cutoff. Nothing expected here
// is produced by the module under test.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const L = await import(pathToFileURL(path.join(root, 'lib/js/LAM/main.js')));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(wasmPath);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const crs16 = fixture('crs16'), crs14 = fixture('crs14'), paz = fixture('paz'), iss = fixture('iss-teme-crew13');
const lamType = { schemaName: 'LAM.fbs', fileIdentifier: '$LAM', rootTypeName: 'LAM', wireFormat: 'flatbuffer' };
const wrap = (d) => ((d % 360) + 540) % 360 - 180;

function site(latitude, longitude) {
  const s = new L.SITT();
  s.LATITUDE = latitude;
  s.LONGITUDE = longitude;
  const launch = new L.LDMT();
  launch.SITE = s;
  return launch;
}
function target(fields) {
  const t = new L.lamTargetOrbitT();
  Object.assign(t, fields);
  return t;
}
function cutoffEvent(seconds) {
  const e = new L.lamAscentEventT();
  e.EVENT_ID = 'seco-1';
  e.EVENT_TYPE = 'SECO-1';
  e.TIME_FROM_LAUNCH_S = seconds;
  return e;
}
function request(fx, { upTo = Infinity, targetOrbit, liftoff = fx.liftoff, launch, events } = {}) {
  const lam = new L.LAMT();
  lam.MISSION_NAME = fx.mission;
  if (liftoff) lam.LAUNCH_EPOCH = liftoff;
  lam.LAUNCH_DATA = launch ?? site(fx.pad.latitude_deg, fx.pad.longitude_deg);
  lam.SPEED_REFERENCE = L.lamSpeedReference.EARTH_RELATIVE;
  const keep = fx.telemetry.time_s.map((t, i) => i).filter((i) => fx.telemetry.time_s[i] <= upTo);
  lam.TIME_FROM_LAUNCH_S = keep.map((i) => fx.telemetry.time_s[i]);
  lam.ALTITUDE_M = keep.map((i) => fx.telemetry.altitude_km[i] * 1000);
  lam.SPEED_M_PER_S = keep.map((i) => fx.telemetry.velocity_m_s[i]);
  lam.TARGET_ORBIT = targetOrbit;
  if (events) lam.ASCENT_EVENTS = events;
  return lam;
}
function pack(lam) {
  const b = new flatbuffers.Builder(1 << 16);
  L.LAM.finishLAMBuffer(b, lam.pack(b));
  return b.asUint8Array();
}
async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  return h;
}
async function invoke(h, methodId, portId, lam) {
  const payload = pack(lam);
  const result = await h.invoke({ methodId, inputs: [{ portId, payload, typeRef: lamType }] });
  if (result.statusCode !== 0) return { result };
  const out = result.outputs.find((f) => f.portId !== 'report');
  const bytes = out.payload;
  assert.equal(Buffer.from(bytes.slice(4, 8)).toString(), '$LAM');
  const lamOut = L.LAM.getRootAsLAM(new flatbuffers.ByteBuffer(bytes)).unpack();
  const report = JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString());
  return { result, lam: lamOut, report };
}
function truthAt(fx, seconds) {
  const s = Math.round(seconds);
  const row = fx.catalog.elements.find((e) => e.time_from_launch_s === s);
  assert.ok(row, `no truth at T+${s} s`);
  return row;
}
const truthInclination = (fx) => fx.catalog.elements[30].inclination_deg;

test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('reconstructs the CRS-16 ascent from broadcast telemetry and matches the catalog orbit at cutoff', async (t) => {
  const h = await harness(t);
  // The broadcast ends as the upper stage shuts down, so no coast confirms the
  // cutoff; SECO-1 is supplied as an event at the end of acceleration.
  const { result, lam, report } = await invoke(h, 'track_ascent', 'telemetry', request(crs16, {
    targetOrbit: target({ INCLINATION_DEG: truthInclination(crs16), PASS_DIRECTION: L.lamPassDirection.NORTHBOUND }),
    events: [cutoffEvent(crs16.cutoff_s)],
  }));
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(lam.TRAJECTORY_SOURCE, L.lamTrajectorySource.TELEMETRY);
  assert.equal(lam.PHASE, L.lamMissionPhase.ORBIT_INSERTION);
  const ins = lam.INSERTION;
  assert.equal(ins.TIME_FROM_LAUNCH_S, crs16.cutoff_s);
  const truth = truthAt(crs16, ins.TIME_FROM_LAUNCH_S);
  assert.equal(ins.REF_FRAME, 'TEME');
  assert.ok(Math.abs(ins.INCLINATION_DEG - truth.inclination_deg) < 0.01);
  // The study's one-sigma accuracy: RAAN 0.45 deg, argument of latitude 0.6 deg,
  // periapsis 2 km, apoapsis 20 km.
  assert.ok(Math.abs(wrap(ins.RAAN_DEG - truth.raan_deg)) < 0.4, `RAAN ${ins.RAAN_DEG} vs ${truth.raan_deg}`);
  assert.ok(Math.abs(wrap(ins.ARGUMENT_OF_LATITUDE_DEG - truth.argument_of_latitude_deg)) < 1.0);
  assert.ok(Math.abs(ins.PERIAPSIS_ALTITUDE_M / 1000 - truth.periapsis_altitude_km) < 3);
  assert.ok(Math.abs(ins.APOAPSIS_ALTITUDE_M / 1000 - truth.apoapsis_altitude_km) < 40);
  assert.equal(ins.RAAN_UNCERTAINTY_DEG, 0.45);
  assert.equal(lam.BURN_OUT_VECTORS.length, 1);
  assert.equal(report.phase, 'orbit-insertion');
  // Samples run from liftoff to insertion; the insertion sample is orbital.
  const n = lam.TIME_FROM_LAUNCH_S.length;
  assert.equal(lam.TIME_FROM_LAUNCH_S[0], 0);
  assert.ok(Math.abs(lam.TIME_FROM_LAUNCH_S[n - 1] - ins.TIME_FROM_LAUNCH_S) < 1e-6);
  assert.ok(Number.isNaN(lam.IIP_LATITUDE_DEG[n - 1]));
  assert.ok(lam.INSTANTANEOUS_PERIAPSIS_ALTITUDE_M[n - 1] > 150000);
  // Northeast from Cape Canaveral: latitude and longitude both grow.
  assert.ok(lam.LATITUDE_DEG[n - 1] > crs16.pad.latitude_deg + 5 && lam.LONGITUDE_DEG[n - 1] > crs16.pad.longitude_deg + 5);
  // The Earth-fixed ephemeris is one compact block of six-element states.
  const block = lam.TRAJECTORY_OEM.EPHEMERIS_DATA_BLOCK[0];
  assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, L.CelestialFrame.EFG);
  assert.equal(block.EPHEMERIS_DATA.length, n * 6);
});

test('reconstructs a southbound sun-synchronous ascent (PAZ) to the catalog orbit', async (t) => {
  const h = await harness(t);
  // The broadcast runs 20 s past cutoff: the coast confirms it without an event.
  const { result, lam } = await invoke(h, 'track_ascent', 'telemetry', request(paz, {
    targetOrbit: target({ INCLINATION_DEG: truthInclination(paz), PASS_DIRECTION: L.lamPassDirection.SOUTHBOUND }),
  }));
  assert.equal(result.statusCode, 0, result.errorMessage);
  const ins = lam.INSERTION;
  assert.ok(Math.abs(ins.TIME_FROM_LAUNCH_S - paz.cutoff_s) < 2, `cutoff T+${ins.TIME_FROM_LAUNCH_S}`);
  const truth = truthAt(paz, ins.TIME_FROM_LAUNCH_S);
  assert.ok(Math.abs(wrap(ins.RAAN_DEG - truth.raan_deg)) < 0.4, `RAAN ${ins.RAAN_DEG} vs ${truth.raan_deg}`);
  assert.ok(Math.abs(wrap(ins.ARGUMENT_OF_LATITUDE_DEG - truth.argument_of_latitude_deg)) < 1.0);
  assert.ok(Math.abs(ins.PERIAPSIS_ALTITUDE_M / 1000 - truth.periapsis_altitude_km) < 5);
  assert.ok(Math.abs(ins.APOAPSIS_ALTITUDE_M / 1000 - truth.apoapsis_altitude_km) < 5);
  assert.ok(lam.LATITUDE_DEG.at(-1) < paz.pad.latitude_deg - 10, 'the ground track runs south');
});

test('tracks an ascent in progress: suborbital, with an impact point downrange, and no insertion yet', async (t) => {
  const h = await harness(t);
  const { result, lam, report } = await invoke(h, 'track_ascent', 'telemetry', request(crs16, {
    upTo: 300,
    targetOrbit: target({ INCLINATION_DEG: truthInclination(crs16), PASS_DIRECTION: L.lamPassDirection.NORTHBOUND }),
  }));
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(lam.INSERTION, null);
  assert.equal(lam.BURN_OUT_VECTORS.length, 0);
  assert.notEqual(lam.PHASE, L.lamMissionPhase.ORBIT_INSERTION);
  const n = lam.TIME_FROM_LAUNCH_S.length;
  assert.ok(Math.abs(lam.TIME_FROM_LAUNCH_S[n - 1] - 300) < 1);
  assert.ok(lam.INSTANTANEOUS_PERIAPSIS_ALTITUDE_M[n - 1] < 0, 'still suborbital at T+300 s');
  // The vacuum impact point lies ahead of the vehicle along the track.
  const toRad = Math.PI / 180;
  const arc = (lat, lon) => Math.acos(Math.sin(crs16.pad.latitude_deg * toRad) * Math.sin(lat * toRad) +
    Math.cos(crs16.pad.latitude_deg * toRad) * Math.cos(lat * toRad) * Math.cos((lon - crs16.pad.longitude_deg) * toRad)) * 6371;
  const vehicle = arc(lam.LATITUDE_DEG[n - 1], lam.LONGITUDE_DEG[n - 1]);
  const impact = arc(lam.IIP_LATITUDE_DEG[n - 1], lam.IIP_LONGITUDE_DEG[n - 1]);
  assert.ok(Number.isFinite(impact) && impact > vehicle + 500, `impact ${impact} km, vehicle ${vehicle} km`);
  assert.equal(report.cutoff_s, null);
});

test('projects the CRS-16 insertion from the CRS-14 broadcast profile', async (t) => {
  const h = await harness(t);
  const truth = truthAt(crs16, crs16.cutoff_s);
  const lam = request(crs14, {
    liftoff: crs16.liftoff,
    launch: site(crs16.pad.latitude_deg, crs16.pad.longitude_deg),
    targetOrbit: target({
      INCLINATION_DEG: truthInclination(crs16), PASS_DIRECTION: L.lamPassDirection.NORTHBOUND,
      PERIAPSIS_ALTITUDE_M: truth.periapsis_altitude_km * 1000, APOAPSIS_ALTITUDE_M: truth.apoapsis_altitude_km * 1000,
      INSERTION_TIME_FROM_LAUNCH_S: crs16.cutoff_s,
    }),
  });
  const { result, lam: out } = await invoke(h, 'project_insertion', 'request', lam);
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(out.TRAJECTORY_SOURCE, L.lamTrajectorySource.PROJECTED);
  assert.equal(out.PHASE, L.lamMissionPhase.PRELAUNCH);
  const ins = out.INSERTION;
  assert.equal(ins.TIME_FROM_LAUNCH_S, crs16.cutoff_s);
  // The study's one-sigma for projections: RAAN 0.25 deg, argument of latitude 1.25 deg.
  assert.ok(Math.abs(wrap(ins.RAAN_DEG - truth.raan_deg)) < 0.3, `RAAN ${ins.RAAN_DEG} vs ${truth.raan_deg}`);
  assert.ok(Math.abs(wrap(ins.ARGUMENT_OF_LATITUDE_DEG - truth.argument_of_latitude_deg)) < 2.0);
  // Inserted at the targeted apsides.
  assert.ok(Math.abs(ins.PERIAPSIS_ALTITUDE_M - truth.periapsis_altitude_km * 1000) < 1);
  assert.ok(Math.abs(ins.APOAPSIS_ALTITUDE_M - truth.apoapsis_altitude_km * 1000) < 1);
  assert.ok(Number.isNaN(ins.PERIAPSIS_ALTITUDE_UNCERTAINTY_M));
});

test('finds the Crew-13 liftoff that joins the ISS plane', async (t) => {
  const h = await harness(t);
  // Crew-13: SLC-40, net 2026-10-01T15:10:06Z (instantaneous), SECO-1 at T+8:47
  // (Launch Library 2, 2026-09-28). The ISS plane is the TEME ephemeris of its
  // newest catalog element set.
  const block = new L.ephemerisDataBlockT();
  block.CENTER_NAME = 'EARTH';
  const frame = new L.RFMT();
  frame.REFERENCE_FRAME_type = L.RFMUnion.CelestialFrameWrapper;
  frame.REFERENCE_FRAME = new L.CelestialFrameWrapperT(L.CelestialFrame.TEMEOFDATE);
  block.REFERENCE_FRAME = frame;
  block.TIME_SYSTEM = L.timingStandard.UTC;
  block.START_TIME = iss.start;
  block.STEP_SIZE = iss.stepSeconds;
  block.STATE_VECTOR_SIZE = 6;
  block.EPHEMERIS_DATA = iss.states;
  const plane = new L.OEMT();
  plane.EPHEMERIS_DATA_BLOCK = [block];
  const launch = site(28.56194122, -80.57735736);
  launch.EARLIEST_LAUNCH_TIMES = ['2026-10-01T15:10:06Z'];
  launch.LATEST_LAUNCH_TIMES = ['2026-10-01T15:10:06Z'];
  const lam = request(crs16, {
    liftoff: null,
    launch,
    targetOrbit: target({
      PASS_DIRECTION: L.lamPassDirection.NORTHBOUND, INSERTION_TIME_FROM_LAUNCH_S: 527,
      PERIAPSIS_ALTITUDE_M: 200000, APOAPSIS_ALTITUDE_M: 360000, PLANE_REFERENCE: plane,
    }),
  });
  const { result, lam: out, report } = await invoke(h, 'project_insertion', 'request', lam);
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.ok(out.IN_PLANE_LIFTOFF_EPOCHS.length >= 1);
  const net = Date.parse('2026-10-01T15:10:06Z');
  const nearest = Math.min(...out.IN_PLANE_LIFTOFF_EPOCHS.map((e) => Math.abs(Date.parse(e) - net)));
  // One minute of liftoff time is a quarter degree of RAAN: the projection's
  // accuracy, not a scheduling claim.
  assert.ok(nearest < 120000, `in-plane liftoff ${nearest / 1000} s from the published time`);
  assert.equal(out.LAUNCH_EPOCH, out.IN_PLANE_LIFTOFF_EPOCHS.reduce((a, e) => (Math.abs(Date.parse(e) - net) < Math.abs(Date.parse(a) - net) ? e : a)));
  assert.ok(Math.abs(report.plane_offset_deg) < 0.01, 'the projected insertion lies in the ISS plane');
});

test('refuses requests it cannot answer', async (t) => {
  const h = await harness(t);
  const north = target({ INCLINATION_DEG: 51.6, PASS_DIRECTION: L.lamPassDirection.NORTHBOUND });
  const noSpeedReference = request(crs16, { targetOrbit: north });
  noSpeedReference.SPEED_REFERENCE = L.lamSpeedReference.UNSPECIFIED;
  const noSite = request(crs16, { targetOrbit: north });
  noSite.LAUNCH_DATA = null;
  const uneven = request(crs16, { targetOrbit: north });
  uneven.ALTITUDE_M = uneven.ALTITUDE_M.slice(1);
  const noDirection = request(crs16, { targetOrbit: target({ INCLINATION_DEG: 51.6 }) });
  // 20 degrees from Vandenberg (34.6 N) needs a plane change.
  const unreachable = request(paz, { targetOrbit: target({ INCLINATION_DEG: 20, PASS_DIRECTION: L.lamPassDirection.SOUTHBOUND }) });
  for (const [name, lam] of Object.entries({ noSpeedReference, noSite, uneven, noDirection, unreachable })) {
    const { result } = await invoke(h, 'track_ascent', 'telemetry', lam);
    assert.notEqual(result.statusCode, 0, name);
    assert.equal(result.outputs.length, 0, name);
  }
  const { result } = await invoke(h, 'track_ascent', 'telemetry', unreachable);
  assert.match(result.errorMessage ?? '', /not reachable/);
});
