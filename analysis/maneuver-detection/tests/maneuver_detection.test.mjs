import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import {
  EPOCHS, LEO, MNV, MU, OEM, OMEGA, T0, add, block, burns, circular, cross, dot, eme2000, flatbuffers, gmst, gpHistory, history, iso, kepler, manifest, mul, norm, oem, planned, require, root, rtn, seconds, sma, stumpff, toFixed, unit, version, visViva, wasm, wasmPath,
} from './fixtures.mjs';
import { reportOf, decodeRecord } from '../study/lib/mde.mjs';

// PROVENANCE.PRODUCER of every $MNV the module writes: itself and its version.
const PRODUCER = `${manifest.pluginId} ${manifest.version}`;

// D1's closed-form cases run D1 alone (the module's default is C, D1 + D2);
// a test that names its detectors runs those.
async function detect(t, bytes, given) {
  const options = { detectors: ['D1'], ...given };
  // The options are the node's configuration under `detect.*`: the host serves them on plugin.getConfig as a ModuleConfig.
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config: { detect: options } } });
  t.after(() => h.destroy());
  const inputs = [{ portId: 'ephemerides', payload: Buffer.from(bytes), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } }];
  const result = await h.invoke({ methodId: 'detect_maneuvers', inputs });
  if (result.statusCode !== 0) return { error: result.errorMessage };
  const events = result.outputs.filter((f) => f.portId === 'maneuvers')
    .map((f) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack());
  const report = await reportOf(new Uint8Array(result.outputs.find((f) => f.portId === 'report').payload));
  return { events, report };
}


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
  assert.ok(Math.abs(e.DELTA_VEL_V - expected) < 1e-9, `U ${e.DELTA_VEL_V} vs ${expected} km/s`);
  assert.ok(Math.abs(expected - 0.001) < 0.001 * 3.5 / 7668, 'second-order term is 2.5 eps');
  assert.ok(Math.abs(e.DELTA_VEL_W) < 1e-9, 'an in-plane burn leaves the orbit normal unchanged');
  assert.equal(e.DELTA_VEL_U, 0);
  assert.equal(e.STATUS, MNV.maneuverStatus.DETECTED);
  assert.equal(e.CHARACTERIZATION, MNV.maneuverCharacterization.ORBIT_RAISING);
  assert.equal(e.SAT_NO, 99001);
  assert.equal(e.ORIG_OBJECT_ID, '2026-900A');
  assert.deepEqual(e.SOURCED_DATA, ['ELSET 15', 'ELSET 16']);
  // An $OEM names no source: the record names its producer only, and its
  // licence class stays Unspecified, which is never a grant.
  assert.equal(e.PROVENANCE.PRODUCER, PRODUCER);
  assert.ok(e.ALGORITHM.startsWith(PRODUCER));
  assert.deepEqual([e.PROVENANCE.SOURCE_ID, e.PROVENANCE.ORIGINATOR, e.PROVENANCE.PROVIDER_ID, e.PROVENANCE.LICENSE_ID, e.PROVENANCE.LINEAGE], [null, null, null, null, null]);
  assert.equal(e.PROVENANCE.SOURCE_KIND, MNV.pvnSourceKind.Unspecified);
  assert.equal(e.PROVENANCE.LICENSE_CLASS, MNV.pvnLicenseClass.Unspecified);
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
  assert.ok(Math.abs(e.DELTA_VEL_V - expected) < 1e-6, `U ${e.DELTA_VEL_V} vs ${expected} km/s`);
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
  assert.ok(Math.abs(e.DELTA_VEL_W - vs * 0.002 / Math.hypot(vs, 0.002)) < 1e-9, `V ${e.DELTA_VEL_W}`);
  // Speed rises from v to sqrt(v^2 + dv^2), so the in-track jump is the
  // vis-viva term dv^2 / (2v) = 2.6e-4 m/s, under the 0.08 m/s floor: the
  // in-track step does not fire and the reported component is 0.
  assert.equal(e.DELTA_VEL_V, 0);
  const expectedU = norm(v) * (sma(r, add(v, mul(rtn(r, v).N, 0.002))) - sma(r, v)) / (2 * sma(r, v));
  const reported = report.objects[0].events[0];
  assert.ok(Math.abs(reported.raw_in_track_mps / 1000 - expectedU) < 1e-9);
  assert.equal(reported.in_track_fired, false);
  assert.equal(reported.cross_track_fired, true);
  // The $MDE event names the $MNV it became.
  assert.equal(reported.mnv_id, e.ID);
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
  assert.ok(Math.abs(fixed.events[0].DELTA_VEL_V - inertial.events[0].DELTA_VEL_V) < 1e-9);
});

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
  assert.ok(Math.abs(events[0].DELTA_VEL_V - visViva(pre, t1, 0.0005)) < 1e-8, `${events[0].DELTA_VEL_V}`);
  assert.ok(Math.abs(events[1].DELTA_VEL_V - visViva(second, t2, 0.0007)) < 1e-8, `${events[1].DELTA_VEL_V}`);
});

test('D2: two burns with one set between them are one event', async (t) => {
  const pre = LEO();
  const t1 = EPOCHS[14] + 1800, t2 = EPOCHS[15] + 1800;
  assert.equal(EPOCHS.filter((e) => e > t1 && e < t2).length, 1);
  const { events, error } = await detect(t, oem(burns(pre, [{ tb: t1, dv: 0.0005 }, { tb: t2, dv: 0.0007 }])), { detectors: ['D2'] });
  assert.equal(error, undefined, error);
  assert.equal(events.length, 1);
  // The step spans both burns: 1.2 m/s to first order.
  assert.ok(Math.abs(events[0].DELTA_VEL_V * 1000 - 1.2) < 0.01, `${events[0].DELTA_VEL_V * 1000} m/s`);
});

async function compare(t, versions, plan) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const typeRef = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };
  const result = await h.invoke({ methodId: 'compare_ephemerides', inputs: [
    ...versions.map((v) => ({ portId: 'versions', payload: Buffer.from(v), typeRef })),
    { portId: 'planned', payload: Buffer.from(plan), typeRef: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' } }] });
  if (result.statusCode !== 0) return { error: result.errorMessage };
  return { checks: result.outputs.filter((f) => f.portId === 'maneuvers').map((f) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(new Uint8Array(f.payload))).unpack()),
    report: await reportOf(new Uint8Array(result.outputs.find((f) => f.portId === 'report').payload)) };
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
  assert.ok(Math.abs(done.checks[0].DELTA_VEL_V - expected) < 1e-6, `${done.checks[0].DELTA_VEL_V} vs ${expected}`);
  const skipped = await compare(t, [before, version(pre, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)], planned(tig, 0.001));
  assert.equal(skipped.checks[0].STATUS, MNV.maneuverStatus.CANCELLED);
  assert.ok(Math.abs(skipped.checks[0].DELTA_VEL_V) < 1e-6);
});

test('compare_ephemerides: a plan is out of plane when it states DELTA_VEL_W (UVW cross-track), in plane when it states only DELTA_VEL_V', async (t) => {
  // A 2 m/s burn along the orbit normal at the TIG, flown as modelled. Its
  // size is all cross-track: a plan that states DELTA_VEL_W is judged by the
  // hypotenuse and the burn is EXECUTED. The same flight against a plan that
  // states only DELTA_VEL_V (2 m/s in-track) is judged by the in-track change,
  // the vis-viva term dv^2 / (2 v) = 2.6e-4 m/s, under the 25 % bound: the
  // in-track burn did not happen, CANCELLED.
  const pre = LEO();
  const tig = T0 + 86400;
  const [r, v] = pre(tig);
  const post = kepler(r, add(v, mul(rtn(r, v).N, 0.002)), tig);
  const versions = [version((s) => (s < tig ? pre : post)(s), T0, T0 + 3 * 86400, tig - 7200), version(post, tig + 6 * 3600, T0 + 3 * 86400, tig + 8 * 3600)];
  const source = Object.assign(new MNV.PVNT(), { SOURCE_ID: 'operator-ephemeris', SOURCE_KIND: MNV.pvnSourceKind.Ephemeris, ORIGINATOR: 'Test operator',
    PROVIDER_ID: 'sdn-test-node', PRODUCER: 'plan-editor 1.0', LICENSE_CLASS: MNV.pvnLicenseClass.CiteOnly, LICENSE_ID: 'operator-terms', LINEAGE: 'operator' });
  const cross = await compare(t, versions, planned(tig, 0.002, { DELTA_VEL_W: 0.002, PROVENANCE: source }));
  assert.equal(cross.error, undefined, cross.error);
  assert.equal(cross.checks[0].STATUS, MNV.maneuverStatus.EXECUTED);
  // The executed cross-track delta-V is the orbit-normal rotation, v dv / sqrt(v^2 + dv^2) as in the D1 case; the
  // two-body versions have no nodal regression, so 1e-6 km/s (1 mm/s) bounds the Hermite interpolation of the averages.
  const vs = norm(v);
  assert.ok(Math.abs(cross.checks[0].DELTA_VEL_W - vs * 0.002 / Math.hypot(vs, 0.002)) < 1e-6, `${cross.checks[0].DELTA_VEL_W}`);
  // The check names the plan's source and this module as its producer.
  const named = cross.checks[0].PROVENANCE;
  assert.deepEqual([named.SOURCE_ID, named.SOURCE_KIND, named.ORIGINATOR, named.PROVIDER_ID, named.LICENSE_CLASS, named.LICENSE_ID, named.LINEAGE],
    ['operator-ephemeris', MNV.pvnSourceKind.Ephemeris, 'Test operator', 'sdn-test-node', MNV.pvnLicenseClass.CiteOnly, 'operator-terms', 'operator']);
  assert.equal(named.PRODUCER, PRODUCER);
  const inTrack = await compare(t, versions, planned(tig, 0.002, { DELTA_VEL_V: 0.002 }));
  assert.equal(inTrack.error, undefined, inTrack.error);
  assert.equal(inTrack.checks[0].STATUS, MNV.maneuverStatus.CANCELLED);
  assert.equal(inTrack.checks[0].PROVENANCE.PRODUCER, PRODUCER);
  assert.equal(inTrack.checks[0].PROVENANCE.SOURCE_ID, null);
});

test('detected maneuvers name their producer and the source their element sets agree on', async () => {
  const host = await import('../study/lib/host.mjs');
  const detector = await host.loadModule('analysis/maneuver-detection');
  try {
    const { rows } = gpHistory(1);
    const source = (fields) => Object.assign(new host.MNV.PVNT(), { SOURCE_KIND: MNV.pvnSourceKind.ElementSet, ORIGINATOR: 'Test catalog', PRODUCER: 'gp-parser 3.0',
      LICENSE_CLASS: MNV.pvnLicenseClass.Reproducible, LICENSE_ID: 'CC0-1.0', LINEAGE: 'test-catalog', ...fields });
    const options = { propagator_port_id: 'test', detectors: ['D1', 'D2'] };
    const provider = await host.sgp4Provider();
    const detectWith = async (sets) => {
      const { results } = await host.detectWith(detector, provider, sets, [options]);
      const events = results[0].maneuvers.map(host.unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
      assert.equal(events.length, 1, JSON.stringify(results[0].report.objects[0].events));
      return events[0].PROVENANCE;
    };
    // One source: the event names it, and this module replaces the parser as producer.
    const one = await detectWith(rows.map((row) => ({ ...row, PROVENANCE: source({ SOURCE_ID: 'test-gp', PROVIDER_ID: 'node-a' }) })));
    assert.deepEqual([one.SOURCE_ID, one.SOURCE_KIND, one.ORIGINATOR, one.PROVIDER_ID, one.LICENSE_CLASS, one.LICENSE_ID, one.LINEAGE],
      ['test-gp', MNV.pvnSourceKind.ElementSet, 'Test catalog', 'node-a', MNV.pvnLicenseClass.Reproducible, 'CC0-1.0', 'test-catalog']);
    assert.equal(one.PRODUCER, PRODUCER);
    // Two sources, one lineage: the event keeps what they agree on and names no single source or provider; a licence
    // class that differs is never a grant, CiteOnly.
    const mixed = await detectWith(rows.map((row, i) => ({ ...row, PROVENANCE: i < 15
      ? source({ SOURCE_ID: 'test-gp', PROVIDER_ID: 'node-a' })
      : source({ SOURCE_ID: 'test-gp-mirror', PROVIDER_ID: 'node-b', LICENSE_CLASS: MNV.pvnLicenseClass.CiteOnly, LICENSE_ID: 'mirror-terms' }) })));
    assert.deepEqual([mixed.SOURCE_ID, mixed.PROVIDER_ID, mixed.LICENSE_ID], [null, null, null]);
    assert.deepEqual([mixed.SOURCE_KIND, mixed.ORIGINATOR, mixed.LINEAGE, mixed.LICENSE_CLASS], [MNV.pvnSourceKind.ElementSet, 'Test catalog', 'test-catalog', MNV.pvnLicenseClass.CiteOnly]);
    assert.equal(mixed.PRODUCER, PRODUCER);
  } finally {
    await detector.destroy();
  }
});

test('the propagator query port: SGP4 and an ABI provider each answer, and each finds the burn', async () => {
  const host = await import('../study/lib/host.mjs');
  const detector = await host.loadModule('analysis/maneuver-detection');
  try {
    const { tb, rows } = gpHistory(1);
    const options = { propagator_port_id: 'test', detectors: ['D1', 'D2'] };
    const first = await detector.invoke('detect_maneuvers', [{ portId: 'element_sets', payload: host.ommStream(rows), typeRef: host.TYPES.OMM }, host.config(options)]);
    // The queries are one $PRW WINDOW_REQUEST, the report one $MDE DETECT_REPORT that says propagation is needed.
    const [prwFrame] = host.outputsOf(first, 'propagation_requests');
    assert.equal(Buffer.from(prwFrame.subarray(4, 8)).toString(), '$PRW');
    const prw = await decodeRecord('PRW', prwFrame);
    assert.equal(prw.WINDOW_REQUEST.QUERIES.length, 31);
    assert.equal(prw.WINDOW_REQUEST.QUERIES[5].SET_INDEX, 5);
    assert.equal(prw.WINDOW_REQUEST.QUERIES[5].STEP_SECONDS, 60);
    assert.equal(prw.WINDOW_REQUEST.NEIGHBOUR_SETS, 2);
    const needs = await host.reportFrom(first);
    assert.deepEqual([needs.status, needs.queries], ['needs-propagation', 31]);
    const requests = await host.queriesFrom(first);
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
      const events = results[0].maneuvers.map(host.unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
      assert.equal(events.length, 1, `${provider.name}: ${JSON.stringify(results[0].report.objects[0].events)}`);
      const [m] = events;
      assert.ok(m.DELTA_VEL_V > 0, provider.name);
      // Within the sets bracketing the burn (8 h apart).
      assert.ok(Math.abs(seconds(m.EVENT_START_TIME) - tb) < 8 * 3600, `${provider.name}: ${m.EVENT_START_TIME}`);
      // Mean-element changes map to the osculating jump only to first order in
      // J2 (SGP4); the keplerian reference reads mean motion as two-body.
      assert.ok(Math.abs(m.DELTA_VEL_V * 1000 - 1) < 0.1, `${provider.name}: ${m.DELTA_VEL_V * 1000} m/s`);
    }
    // Answers out of order are refused, never matched to the wrong set.
    const { answer } = await host.sgp4Provider();
    const answers = await answer(requests, rows);
    const swapped = host.OEM.OEM.getRootAsOEM(new host.flatbuffers.ByteBuffer(answers[0])).unpack();
    swapped.EPHEMERIS_DATA_BLOCK.reverse();
    await assert.rejects(detector.invoke('detect_maneuvers', [{ portId: 'element_sets', payload: host.ommStream(rows), typeRef: host.TYPES.OMM },
      host.config(options), { portId: 'propagation', payload: host.oemFrame(swapped.EPHEMERIS_DATA_BLOCK), typeRef: host.TYPES.OEM }]), /does not cover|span/);
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
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config: { detect: { spans: [{ object: 'NORAD:99001', from: iso(T0), to: iso(T0 + 365.25 * 43200) }] } } } });
  t.after(() => h.destroy());
  const typeRef = { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' };
  const result = await h.invoke({ methodId: 'score_detections', inputs: [
    { portId: 'truth', payload: Buffer.concat([mnv({ ID: 'a', EVENT_START_TIME: iso(T0), DELTA_VEL: 0.001 }), mnv({ ID: 'b', EVENT_START_TIME: iso(T0 + 10 * 86400), DELTA_VEL: 0.002 })]), typeRef },
    { portId: 'detected', payload: Buffer.concat([mnv({ ID: 'x', EVENT_START_TIME: iso(T0 + 1800), DELTA_VEL: 0.0009 }),
      mnv({ ID: 'y', EVENT_START_TIME: iso(T0 + 10 * 86400 + 7200), DELTA_VEL: 0.0021 }), mnv({ ID: 'z', EVENT_START_TIME: iso(T0 + 5 * 86400), DELTA_VEL: 0.0001 })]), typeRef }] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  const reportFrame = new Uint8Array(result.outputs.find((f) => f.portId === 'report').payload);
  assert.equal(Buffer.from(reportFrame.subarray(4, 8)).toString(), '$MDE');
  const { summary, matches } = await reportOf(reportFrame);
  assert.equal(summary.detected, 2);
  // Wilson 95 % for 2/2: [n / (n + z^2), 1] = [0.3424, 1] with z = 1.95996.
  assert.ok(Math.abs(summary.wilson95[0] - 2 / (2 + 1.959963984540054 ** 2)) < 1e-12);
  assert.equal(summary.false_alarms, 1);
  assert.ok(Math.abs(summary.false_alarms_per_object_year - 2) < 1e-12);
  assert.deepEqual(matches.map((m) => m.time_error_s), [1800, 7200]);
  assert.ok(Math.abs(matches[0].dv_ratio - 0.9) < 1e-12);
});

// A flow shares one config across its nodes, each module under its own prefix: keys outside `detect.*` are other
// modules' and are not read; an unknown key inside `detect.*` is still refused.
test('config: only detect.* is read, an unknown detect.* key is refused', async (t) => {
  const run = async (config) => {
    const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config } });
    t.after(() => h.destroy());
    const typeRef = { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' };
    const one = (() => { const b = new flatbuffers.Builder(256); MNV.MNV.finishSizePrefixedMNVBuffer(b, Object.assign(new MNV.MNVT(), { SAT_NO: 99001, ID: 'a', EVENT_START_TIME: iso(T0), DELTA_VEL: 0.001 }).pack(b)); return Buffer.from(b.asUint8Array()); })();
    return h.invoke({ methodId: 'score_detections', inputs: [{ portId: 'truth', payload: one, typeRef }, { portId: 'detected', payload: one, typeRef }] });
  };
  const foreign = { attach: { version: 1, source: { id: 's' } }, attribute: { version: 1 }, derive: { ages: [1, 2] } };
  const shared = await run({ ...foreign, detect: { before_s: 3600 } });
  assert.equal(shared.statusCode, 0, shared.errorMessage);
  const none = await run(foreign);
  assert.equal(none.statusCode, 0, none.errorMessage);
  const typo = await run({ ...foreign, detect: { befor_s: 3600 } });
  assert.notEqual(typo.statusCode, 0);
  assert.match(typo.errorMessage, /Unknown option: befor_s/);
});
