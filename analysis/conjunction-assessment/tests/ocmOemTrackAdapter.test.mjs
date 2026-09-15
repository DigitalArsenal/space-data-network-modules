import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptOcmToConjunctionSource, adaptOemToConjunctionSource } from '../index.js';
import { initCqrFlatc, encodeCqr, decodeCqr, pairRequest, earthFrame } from './lib/cqr.mjs';

// This is a transport preservation check, not a generated numerical oracle.
// Native OCM/OEM epoch, frame, and state units are passed unchanged to C++.
test('OCM/OEM adapters retain canonical records without JS time or frame conversion', async () => {
  const ocm = { METADATA: { OBJECT_NAME: 'A', OBJECT_DESIGNATOR: '99001', START_TIME: '2026-03-09T00:00:00Z' }, STATE_STEP_SIZE: 60, STATE_VECTOR_SIZE: 6, STATE_DATA: [7000,0,0,0,7.5,0,7000,450,0,0,7.5,0] };
  const oem = { EPHEMERIS_DATA_BLOCK: [{ OBJECT: { OBJECT_NAME: 'B', OBJECT_ID: 'B', NORAD_CAT_ID: 99002 }, TIME_SYSTEM: 'UTC', START_TIME: '2026-03-09T00:00:00Z', STEP_SIZE: 60, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: [7000.1,0,0,0,7.5,0,7000.1,450,0,0,7.5,0] }] };
  const primary = adaptOcmToConjunctionSource(ocm);
  const secondary = adaptOemToConjunctionSource(oem);
  assert.equal(primary.COMPREHENSIVE_ORBIT, ocm);
  assert.equal(secondary.EPHEMERIS, oem);
  assert.equal(primary.OBJECT_ID, '99001');
  assert.equal(secondary.OBJECT_ID, 'B');
  const flatc = await initCqrFlatc();
  const bytes = encodeCqr(flatc, pairRequest({ PRIMARY: primary, SECONDARY: secondary, startJd: 2461108.5, durationSeconds: 60, EVALUATION_FRAME: earthFrame('GCRF') }));
  const record = decodeCqr(flatc, bytes).PAIR_REQUEST;
  assert.deepEqual(record.PRIMARY.COMPREHENSIVE_ORBIT.STATE_DATA, ocm.STATE_DATA);
  assert.deepEqual(record.SECONDARY.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA, oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA);
  assert.equal(record.SECONDARY.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0].START_TIME, '2026-03-09T00:00:00Z');
});
