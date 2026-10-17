// The configured resident profile (ingest_state with a configuration): full
// force on the resident catalog path.
//
// (a) Equivalence. A resident object is its configuration (an execution
//     request) with its own state and coefficients; the module integrates it
//     forward with the execution path's steps and restarts. Authority: the
//     execution path itself, which the Orekit, GMAT and Tudat suites validate
//     (tests/orekit_reference.test.mjs, tests/xval_reference.test.mjs). The
//     same request (state, Cd*A/m, Cr*A/m, every force, the catalog
//     integrator) is sent once per epoch to `invoke` with that TARGET_EPOCH,
//     and compared with propagate_state on one resident instance holding all
//     four orbits (LEO 400 km, GPS, GEO, Molniya), over three days forward and
//     one backward, at epochs on and between the space-weather restarts. Tolerance 1 mm: the
//     interpolation of the dense output (measured: micrometres), far below
//     the integration's own truncation (decimetres in LEO at 1e-12).
// (c) Interpolation. The exported PPE is evaluated (Clenshaw, in this file,
//     as conformance tooling) every 61 s over the four days and compared
//     with the dense output, and at the equivalence epochs with the
//     execution path. Tolerance 1 mm. Each segment's SAMPLED_RESIDUAL (its
//     largest difference from the integrator's own accepted states) must
//     not exceed the same 1 mm.
// (e) Refusals: the configuration is required on ingest_state; what the
//     resident profile cannot carry fails with a named error.
//
// Frame GCRF, epochs on TT (states in on UTC), SI units. Environment: DE440 (2026
// excerpt), IERS finals2000A Earth orientation and synthetic daily space
// weather (tests/fixtures/resident).
import assert from 'node:assert/strict';
import test from 'node:test';
import { residentHarness } from './lib/residentRuntime.mjs';
import { TYPE, encodePrw, decodePrw, makeTable, coordinateSystem, nativeInput, sds } from './lib/prwCodec.mjs';
import {
  CATALOG_INTEGRATOR, GM, KERNEL, environmentInputs, evaluatePpe, fullForceRequest, isoAfter, isoInstant, residentRecord,
} from './lib/fullForce.mjs';

const EPOCH_UTC = '2026-08-02T00:00:00.000';
const EPOCH_TT = '2026-08-02T00:01:09.184000000';    // TT - UTC = 69.184 s
const orbit = (a, e, incDeg) => {   // perigee on +x, velocity in the inclined plane (m, m/s)
  const rp = a * (1 - e), vp = Math.sqrt(GM * (1 + e) / rp), i = incDeg * Math.PI / 180;
  return [rp, 0, 0, 0, vp * Math.cos(i), vp * Math.sin(i)];
};
const OBJECTS = [
  { handle: 1, name: 'LEO 400 km', state: orbit(6778137, 0.0005, 51.6), cdAm: 0.02, crAm: 0.02 },
  { handle: 2, name: 'GPS', state: orbit(26560000, 0.01, 55), cdAm: 0.005, crAm: 0.01 },
  { handle: 3, name: 'GEO', state: orbit(42164000, 0.0002, 0.1), cdAm: 0.005, crAm: 0.03 },
  { handle: 4, name: 'Molniya', state: orbit(26600000, 0.72, 63.4), cdAm: 0.01, crAm: 0.02 },
];
// Seconds from the epoch (TT): forward an hour, a quarter day, on restarts
// (3 h of UTC from the epoch is a restart) and between them, to three days;
// and backward to a day before the epoch.
const OFFSETS = [3600, 21600, 0.5 * 86400 + 1234.5, 86400, 1.5 * 86400 - 317.25, 2 * 86400 + 4321.125, 2.5 * 86400, 3 * 86400 - 69.184,
  -3600, -0.5 * 86400 - 1234.5, -86400 + 600];
const instance = (generation = 1n, id = 'configured') => makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.hpop', INSTANCE_ID: id, GENERATION: generation });
const frame = (port, arm, value) => ({ portId: port, typeRef: TYPE, payload: encodePrw(arm, value) });
const configuration = (edit) => { const r = fullForceRequest({ epoch: EPOCH_UTC, state: OBJECTS[0].state }); if (edit) edit(r); return frame('configuration', 'EXECUTION_REQUEST', r); };
const states = (generation = 1n, objects = OBJECTS, extra = {}) => objects.map((o) => frame('state', 'RESIDENT_STATE',
  residentRecord({ instance: instance(generation), handle: o.handle, epoch: EPOCH_UTC, state: o.state, cdAm: o.cdAm, crAm: o.crAm, extra })));
const ok = (r, what) => { assert.equal(r.statusCode, 0, `${what}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs.map((o) => decodePrw(o.payload)); };
const refused = (r, code) => { assert.notEqual(r.statusCode, 0); assert.equal(r.outputs.length, 0); assert.equal(r.errorCode, code, r.errorMessage); };
const ingest = (h, inputs) => h.invoke({ methodId: 'ingest_state', inputs });

async function residentAt(h, handle, iso) {
  const out = ok(await h.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', {
    INSTANCE: instance(), TARGET_EPOCH: isoInstant(iso, 'TT'), ENTITY_HANDLES: [handle], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] }), 'propagate_state');
  const s = out[0].RESIDENT_STATE.STATE;
  assert.equal(s.EPOCH_TIME_SYSTEM, 'TDB');
  return [s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z];
}
async function executionAt(h, o, iso) {
  const out = ok(await h.invoke({ methodId: 'invoke', inputs: [
    frame('request', 'EXECUTION_REQUEST', fullForceRequest({ epoch: EPOCH_UTC, state: o.state, target: iso, targetScale: 'TT', cdAm: o.cdAm, crAm: o.crAm })),
    ...environmentInputs()] }), 'invoke');
  const s = out[0].EXECUTION_RESULT.FINAL_SAMPLE.STATE.STATE;
  assert.equal(s.EPOCH_TIME_SYSTEM, 'TDB');
  return [s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z];
}
const dr = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dv = (a, b) => Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5]);

test('configured resident trajectories equal the execution path within 1 mm over three days (LEO, GPS, GEO, Molniya)', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  ok(await ingest(h, [...states(), configuration(), ...environmentInputs()]), 'ingest_state');
  for (const o of OBJECTS) {
    let worst = 0, worstV = 0;
    for (const offset of OFFSETS) {
      const iso = isoAfter(EPOCH_TT, offset);
      const resident = await residentAt(h, o.handle, iso), execution = await executionAt(h, o, iso);
      worst = Math.max(worst, dr(resident, execution));
      worstV = Math.max(worstV, dv(resident, execution));
    }
    t.diagnostic(`${o.name}: resident - execution, largest |dr| ${worst.toExponential(2)} m, |dv| ${worstV.toExponential(2)} m/s over ${OFFSETS.length} epochs`);
    assert.ok(worst <= 1e-3, `${o.name}: ${worst} m`);
    assert.ok(worstV <= 1e-5, `${o.name}: ${worstV} m/s`);
  }
});

test('exported PPE interpolates the dense output and the execution path within 1 mm; segments report their residuals', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  ok(await ingest(h, [...states(), configuration(), ...environmentInputs()]), 'ingest_state');
  const start = isoAfter(EPOCH_TT, -86400), seconds = 4 * 86400 - 69.184;
  const prepared = ok(await h.invoke({ methodId: 'prepare_trajectory_segments', inputs: [frame('request', 'PREPARE_REQUEST', makeTable('PRWPrepareRequest', {
    INSTANCE: instance(), START_EPOCH: isoInstant(start, 'TT'), DURATION_SECONDS: seconds, PROFILE: 'conjunction-screening' }))] }), 'prepare')[0].PREPARE_RESULT;
  assert.equal(prepared.COVERAGE_COMPLETE, true);
  assert.equal(prepared.QUALITY.EVIDENCE_KIND, sds.prwQualityEvidence.SAMPLED_RESIDUAL);
  assert.match(prepared.QUALITY.METHOD, /Chebyshev/);
  assert.ok(prepared.QUALITY.HAS_MAXIMUM_POSITION_ERROR_M && prepared.QUALITY.MAXIMUM_POSITION_ERROR_M <= 1e-3, `prepare quality ${prepared.QUALITY.MAXIMUM_POSITION_ERROR_M} m`);
  const describe = { methodId: 'describe_trajectory_segments', inputs: [frame('request', 'DESCRIBE_REQUEST', makeTable('PRWDescribeRequest', {
    INSTANCE: instance(), SEGMENT_SET_HANDLE: prepared.SEGMENT_SET_HANDLE }))] };
  const sources = [];
  for (;;) {
    const chunk = ok(await h.invoke(describe), 'describe')[0].DESCRIBE_RESULT;
    sources.push(...chunk.SOURCES);
    if (chunk.FINAL_CHUNK) break;
  }
  assert.equal(sources.length, OBJECTS.length);
  for (const o of OBJECTS) {
    const source = sources.find((s) => s.SOURCE_HANDLE === o.handle), ppe = source.EPHEMERIS;
    assert.equal(ppe.EPHEMERIS_SOURCE, 'com.orbpro.hpop@1.4.0');
    assert.equal(ppe.TIME_SYSTEM, sds.timingStandard.TT);
    assert.equal(source.SEGMENT_QUALITY.length, ppe.POSITION_RECORDS.length);
    let reported = 0, samples = 0;
    for (const q of source.SEGMENT_QUALITY) {
      assert.equal(q.EVIDENCE_KIND, sds.prwQualityEvidence.SAMPLED_RESIDUAL);
      assert.equal(q.METHOD, null);   // stated once, in the PPE comment and the prepare result
      reported = Math.max(reported, q.MAXIMUM_POSITION_ERROR_M);
    }
    let worstDense = 0, worstExecution = 0;
    for (let s = 0; s <= seconds; s += 61) {
      const iso = isoAfter(start, s), p = evaluatePpe(ppe, iso), d = await residentAt(h, o.handle, iso);
      worstDense = Math.max(worstDense, dr(p.position.map((x) => x * 1000), d));
      ++samples;
    }
    for (const offset of OFFSETS) {
      const iso = isoAfter(EPOCH_TT, offset), p = evaluatePpe(ppe, iso), e = await executionAt(h, o, iso);
      worstExecution = Math.max(worstExecution, dr(p.position.map((x) => x * 1000), e));
    }
    t.diagnostic(`${o.name}: ${ppe.POSITION_RECORDS.length} segments; PPE - dense output ${worstDense.toExponential(2)} m over ${samples} epochs; ` +
      `PPE - execution ${worstExecution.toExponential(2)} m; reported segment residual ${reported.toExponential(2)} m`);
    assert.ok(worstDense <= 1e-3 && worstExecution <= 1e-3 && reported <= 1e-3, `${o.name}`);
  }
});

test('the configured profile refuses what it cannot carry', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());
  const env = environmentInputs();
  refused(await ingest(h, [...states()]), 'missing-required-input');   // the manifest requires the port
  refused(await ingest(h, [...states(), configuration((r) => { r.SAMPLE_EPOCHS = [isoInstant(EPOCH_TT, 'TT')]; }), ...env]), 'unsupported-configuration');
  refused(await ingest(h, [...states(), configuration((r) => { r.INCLUDE_STM = true; }), ...env]), 'unsupported-configuration');
  refused(await ingest(h, [...states(), configuration((r) => { r.INTEGRATOR.ALGORITHM = sds.prwSolverAlgorithm.RKF45; }), ...env]), 'unsupported-integrator');
  refused(await ingest(h, [...states(), configuration((r) => { r.FORCES.ENABLE_DRAG = false; }), ...env.filter((f) => f.portId !== 'space_weather')]), 'unsupported-configuration');
  refused(await ingest(h, [...states(1n, OBJECTS, { DRAG_AREA_OVER_MASS_RATE_M2_KG_S: 1e-9, HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S: true }), configuration(), ...env]), 'unsupported-configuration');
  refused(await ingest(h, [...states(), configuration(), ...env, env[0]]), 'invalid-request');
  const tampered = nativeInput(KERNEL); tampered[tampered.length >> 1] ^= 1;   // inside CONTENT
  refused(await ingest(h, [...states(), configuration(), { ...env[0], payload: tampered }, ...env.slice(1)]), 'invalid-kernel');
  refused(await h.invoke({ methodId: 'ingest_state_gravity_only', inputs: [...states(), configuration()] }), 'unknown-input-port');
  // Accepted, then queries outside what the instance holds fail by name.
  ok(await ingest(h, [...states(), configuration(), ...env]), 'ingest_state');
  const before = await h.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', {
    INSTANCE: instance(), TARGET_EPOCH: isoInstant('2026-07-29T12:00:00.000000000'), ENTITY_HANDLES: [3], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
  refused(before, 'space-weather-out-of-range');
  const beyond = await h.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', {
    INSTANCE: instance(), TARGET_EPOCH: isoInstant('2026-08-12T00:00:00.000000000'), ENTITY_HANDLES: [3], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
  refused(beyond, 'space-weather-out-of-range');
});
