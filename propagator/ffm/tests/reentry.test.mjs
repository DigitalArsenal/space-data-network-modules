// A propagation ends at reentry (lib/reentry.h): once the trajectory descends
// below 100 km geodetic altitude, the module stops it with the named error
// `reentry`, giving the UTC epoch and, on the resident path, the object.
// Integrated further, a decaying object reaches the Earth's interior, where
// the gravity field diverges and the exported trajectory leaves the solar
// system.
//
// Case: a circular orbit at 140 km (51.6 degrees) with Cd*A/m 0.02 m^2/kg
// under the full force model loses about 20 km of semi-major axis per orbit
// and descends below 100 km within hours. Both paths, the execution request
// and the resident instance, take the same integration steps, so they report
// the same reentry epoch. A second resident object (LEO 400 km) in the same
// instance stays preparable, and the decaying object stays preparable for a
// window before its reentry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { residentHarness } from './lib/residentRuntime.mjs';
import { TYPE, encodePrw, decodePrw, makeTable, coordinateSystem } from './lib/prwCodec.mjs';
import { GM, environmentInputs, fullForceRequest, isoAfter, isoInstant, residentRecord } from './lib/fullForce.mjs';

const EPOCH_UTC = '2026-08-02T00:00:00.000';
const EPOCH_TT = '2026-08-02T00:01:09.184000000';
const circular = (altitudeM, incDeg) => {
  const r = 6378137 + altitudeM, v = Math.sqrt(GM / r), i = incDeg * Math.PI / 180;
  return [r, 0, 0, 0, v * Math.cos(i), v * Math.sin(i)];
};
const DECAYING = { handle: 1, state: circular(140e3, 51.6), cdAm: 0.02, crAm: 0.02 };
const LEO = { handle: 2, state: circular(400e3, 51.6), cdAm: 0.02, crAm: 0.02 };
const instance = () => makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.ffm', INSTANCE_ID: 'reentry', GENERATION: 1n });
const frame = (port, arm, value) => ({ portId: port, typeRef: TYPE, payload: encodePrw(arm, value) });
const ok = (r, what) => { assert.equal(r.statusCode, 0, `${what}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs.map((o) => decodePrw(o.payload)); };
const reentryEpoch = (r) => {
  assert.notEqual(r.statusCode, 0, 'the propagation must stop');
  assert.equal(r.outputs.length, 0);
  assert.equal(r.errorCode, 'reentry', r.errorMessage);
  const m = / below 100 km geodetic altitude \((-?[0-9.]+) km\) at (\d{4}-\d\d-\d\dT\d\d:\d\d:[0-9.]+) UTC/.exec(r.errorMessage);
  assert.ok(m, r.errorMessage);
  assert.ok(Number(m[1]) < 100, r.errorMessage);
  return m[2];
};
const prepare = (h, handles, seconds) => h.invoke({ methodId: 'prepare_trajectory_segments', inputs: [frame('request', 'PREPARE_REQUEST',
  makeTable('PRWPrepareRequest', { INSTANCE: instance(), SOURCE_HANDLES: handles, START_EPOCH: isoInstant(EPOCH_TT, 'TT'), DURATION_SECONDS: seconds,
    PROFILE: 'conjunction-screening' }))] });

test('a trajectory that descends below 100 km stops with reentry, at the same epoch on both paths', async (t) => {
  const h = await residentHarness('browser');
  t.after(() => h.destroy());

  // The execution path.
  const execution = await h.invoke({ methodId: 'invoke', inputs: [
    frame('request', 'EXECUTION_REQUEST', fullForceRequest({ epoch: EPOCH_UTC, state: DECAYING.state, target: isoAfter(EPOCH_TT, 86400),
      targetScale: 'TT', cdAm: DECAYING.cdAm, crAm: DECAYING.crAm })), ...environmentInputs()] });
  const executionEpoch = reentryEpoch(execution);
  const hours = (Date.parse(`${executionEpoch}Z`) - Date.parse(`${EPOCH_UTC}Z`)) / 3.6e6;
  t.diagnostic(`execution: ${execution.errorMessage}`);
  assert.ok(hours > 0.5 && hours < 24, `reentry ${hours} h after the epoch`);

  // The resident path: the instance holds the decaying object and LEO 400 km.
  ok(await h.invoke({ methodId: 'ingest_state', inputs: [
    ...[DECAYING, LEO].map((o) => frame('state', 'RESIDENT_STATE', residentRecord({ instance: instance(), handle: o.handle, epoch: EPOCH_UTC,
      state: o.state, cdAm: o.cdAm, crAm: o.crAm }))),
    frame('configuration', 'EXECUTION_REQUEST', fullForceRequest({ epoch: EPOCH_UTC, state: LEO.state })), ...environmentInputs()] }), 'ingest_state');
  const both = await prepare(h, [1, 2], 86400);
  assert.equal(reentryEpoch(both), executionEpoch, 'the resident and execution paths take the same steps');
  assert.match(both.errorMessage, /^reentry: handle 1 \(object-1, catalog 1\): /);
  const propagated = await h.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', {
    INSTANCE: instance(), TARGET_EPOCH: isoInstant(isoAfter(EPOCH_TT, 86400), 'TT'), ENTITY_HANDLES: [1], TARGET_COORDINATE_SYSTEM: coordinateSystem() }))] });
  assert.equal(reentryEpoch(propagated), executionEpoch);

  // The other object, and the decaying one before its reentry, stay preparable.
  ok(await prepare(h, [2], 86400), 'prepare LEO 400 km');
  const early = ok(await prepare(h, [1], 1800), 'prepare the decaying object for 30 minutes')[0].PREPARE_RESULT;
  assert.equal(early.COVERAGE_COMPLETE, true);
  const described = ok(await h.invoke({ methodId: 'describe_trajectory_segments', inputs: [frame('request', 'DESCRIBE_REQUEST',
    makeTable('PRWDescribeRequest', { INSTANCE: instance(), SEGMENT_SET_HANDLE: early.SEGMENT_SET_HANDLE }))] }), 'describe')[0].DESCRIBE_RESULT;
  assert.equal(described.SOURCES[0].SOURCE_HANDLE, 1);
  assert.ok(described.SOURCES[0].EPHEMERIS.POSITION_RECORDS.length >= 6);
});
