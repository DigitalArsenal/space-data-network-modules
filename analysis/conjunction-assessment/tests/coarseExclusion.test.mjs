// Objects SGP4 cannot propagate over the screening window are excluded from
// the screening and reported, instead of failing the whole request.
//
// Source: CelesTrak GP element sets (https://celestrak.org/NORAD/elements/),
// SGP4 mean elements in TEME of date, UTC epochs 2026-06-25..2026-07-06, as
// cached in OrbPro's sandcastle gallery sgp4-propagation/omm-cache.fb
// (OrbPro 8afe810111). fixtures/decaying/gp_2026-07-06.json holds EXPLORER 7
// (NORAD 22), eight objects that pass within 5 km of it during 2026-07-06, and
// three reentering objects: THORAD DELTA 1 DEB (8301, ndot 0.065 rev/day^2),
// CZ-6A DEB (60875) and STARLINK-34343 DEB (69729, epoch ten days before the
// window). Before this change 22 vs 8301 alone returned 422
// "screening-failed: Satellite has decayed".
//
// Every assertion is a computable property, not a golden output:
// - excluding an object is the same as leaving it out: the events of the other
//   pairs are identical to a screening whose catalog never contained it;
// - the reported record is the object's own OMM (identity and elements equal
//   the input), Earth/TEME, with the reason in COMMENT;
// - the reported epoch is the earliest failing coarse epoch: a window whose
//   last coarse epoch is one step earlier screens the object normally;
// - OBJECTS_PARSED - TOTAL_OBJECTS is the number of excluded records;
// - the bytes do not depend on the worker count.
// Units: km/km/s inside the guest, metres and UTC Julian dates in CQR.
// No tolerance is involved: comparisons are exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';

const GP = JSON.parse(fs.readFileSync(new URL('./fixtures/decaying/gp_2026-07-06.json', import.meta.url), 'utf8'));
const START_JD = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
const STEP_S = 60;
const PRIMARY = 22;

const flatc = await initCqrFlatc();
const ommBytes = (g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false });
const ommJson = (bytes) => JSON.parse(flatc.generateJSON(publishedSchema('OMM'), { path: '/omm.bin', data: bytes }, { defaultsJson: true }));

// Primary first, every other fixture object a secondary: OrbPro's Live
// catalog request shape (ordered ranges over catalog port frames).
function catalogInvoke(set, { durationSeconds, workers = 1 }) {
  const primaryFirst = [...set.filter((g) => g.NORAD_CAT_ID === PRIMARY), ...set.filter((g) => g.NORAD_CAT_ID !== PRIMARY)];
  const request = encodeCqr(flatc, { CATALOG_REQUEST: {
    CONTROLS: screeningControls({ startJd: START_JD, durationSeconds, numThreads: workers, coarseStepSec: STEP_S }),
    EVALUATION_FRAME: earthFrame('TEME'),
    START_ORDER_INDEX: 0, HAS_START_ORDER_INDEX: true, END_ORDER_INDEX: 1, HAS_END_ORDER_INDEX: true,
    SECONDARY_START_ORDER_INDEX: 1, HAS_SECONDARY_START_ORDER_INDEX: true,
    SECONDARY_END_ORDER_INDEX: primaryFirst.length, HAS_SECONDARY_END_ORDER_INDEX: true,
  } });
  return { methodId: 'screen_catalog', inputs: [{ portId: 'request', payload: request }, ...primaryFirst.map((g) => ({ portId: 'catalog', payload: ommBytes(g) }))] };
}

function read(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const results = response.outputs.filter((f) => f.portId === 'result').map((f) => decodeCqr(flatc, f.payload).CATALOG_RESULT);
  assert.equal(results.length, 1);
  assert.equal(results[0].FINAL_CHUNK, true);
  const excluded = response.outputs.filter((f) => f.portId === 'excluded');
  return { result: results[0], events: results[0].EVENTS ?? [], excluded, excludedJson: excluded.map((f) => ommJson(f.payload)) };
}

const FIRST_FAILURE = /^Excluded from conjunction screening: SGP4 cannot propagate this object over the screening window\. First failure at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z): (.+)$/;

function checkExcludedRecords(run, expectedNorads) {
  assert.deepEqual(run.excludedJson.map((o) => o.NORAD_CAT_ID), expectedNorads);
  const failures = new Map();
  for (const [index, omm] of run.excludedJson.entries()) {
    const input = ommJson(ommBytes(GP.find((g) => g.NORAD_CAT_ID === omm.NORAD_CAT_ID)));
    const { COMMENT } = omm;
    // The input records carry no COMMENT; every other field round-trips exactly.
    for (const key of new Set([...Object.keys(input), ...Object.keys(omm)])) {
      if (key !== 'COMMENT') assert.deepEqual(omm[key], input[key], `${omm.NORAD_CAT_ID} ${key}`);
    }
    assert.equal(omm.CENTER_NAME, 'EARTH');
    assert.equal(omm.REFERENCE_FRAME.REFERENCE_FRAME_type, 'CelestialFrameWrapper');
    assert.equal(omm.REFERENCE_FRAME.REFERENCE_FRAME.frame, 'TEMEOFDATE');
    const match = FIRST_FAILURE.exec(COMMENT);
    assert.ok(match, `${omm.NORAD_CAT_ID}: ${COMMENT}`);
    const failureJd = Date.parse(match[1]) / 86400000 + 2440587.5;
    const stepsFromStart = (failureJd - START_JD) * 86400 / STEP_S;
    assert.ok(Math.abs(stepsFromStart - Math.round(stepsFromStart)) < 1e-6, `${match[1]} is a coarse epoch`);
    failures.set(omm.NORAD_CAT_ID, { iso: match[1], steps: Math.round(stepsFromStart), reason: match[2] });
    assert.equal(Buffer.from(run.excluded[index].payload.subarray(4, 8)).toString('latin1'), '$OMM');
  }
  assert.equal(run.result.OBJECTS_PARSED - run.result.STATISTICS.TOTAL_OBJECTS, expectedNorads.length);
  assert.equal(run.result.STATISTICS.FAILED_PAIRS, 0);
  return failures;
}

const eventKey = (events) => JSON.stringify(events);

test('screen_catalog completes on a catalog with reentering objects and lists them as excluded', async (t) => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  const week = 7 * 86400;

  const runs = [];
  for (const workers of [1, 4]) runs.push(await harness.invoke(catalogInvoke(GP, { durationSeconds: week, workers })));
  const bytes = (r) => Buffer.concat(r.outputs.map((f) => Buffer.from(f.payload))).toString('hex');
  assert.equal(bytes(runs[1]), bytes(runs[0]), 'worker count changes nothing');

  const run = read(runs[0]);
  const failures = checkExcludedRecords(run, [8301, 60875, 69729]);
  assert.equal(failures.get(8301).reason, 'Satellite has decayed');
  assert.equal(failures.get(60875).reason, 'Satellite has decayed');
  assert.equal(failures.get(69729).reason, 'Error: (e <= -0.001)');
  assert.equal(failures.get(69729).steps, 0, 'elements already invalid at the window start');
  assert.equal(run.result.OBJECTS_PARSED, GP.length);
  assert.ok(run.events.length > 0);
  for (const e of run.events) {
    assert.equal(e.PRIMARY_NORAD_ID, PRIMARY);
    assert.ok(![8301, 60875, 69729].includes(e.SECONDARY_NORAD_ID));
  }

  const kept = read(await harness.invoke(catalogInvoke(GP.filter((g) => ![8301, 60875, 69729].includes(g.NORAD_CAT_ID)), { durationSeconds: week })));
  assert.equal(kept.excluded.length, 0);
  assert.equal(eventKey(run.events), eventKey(kept.events), 'the other pairs are screened as if the excluded objects were absent');
  assert.equal(kept.result.STATISTICS.TOTAL_OBJECTS, run.result.STATISTICS.TOTAL_OBJECTS);

  // Earliest failing coarse epoch: 8301 first fails at step k. A window whose
  // last coarse epoch is step k-1 screens it without exclusion; one whose last
  // epoch is step k excludes it with the same epoch and reason. (Half a step of
  // slack keeps floor((end-start)/step) off a Julian-date rounding edge.)
  const k = failures.get(8301).steps;
  assert.ok(k > 0);
  const pair = GP.filter((g) => [PRIMARY, 8301].includes(g.NORAD_CAT_ID));
  const before = read(await harness.invoke(catalogInvoke(pair, { durationSeconds: (k - 0.5) * STEP_S })));
  assert.equal(before.excluded.length, 0, 'propagates through step k-1');
  assert.equal(before.result.STATISTICS.TOTAL_OBJECTS, 2);
  const at = read(await harness.invoke(catalogInvoke(pair, { durationSeconds: (k + 0.5) * STEP_S })));
  const atFailure = checkExcludedRecords(at, [8301]);
  assert.deepEqual(atFailure.get(8301), failures.get(8301));
});

test('resident screen_window excludes the same objects on the implicit and chunked coarse paths', async (t) => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser', surface: 'direct' });
  t.after(() => harness.destroy());
  let generation = 0;
  const invoke = (methodId, record) => harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
  async function screen(set, durationSeconds) {
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'decaying-catalog', GENERATION: ++generation };
    const prepared = await invoke('prepare_screening_index', { INDEX_REQUEST: { INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY',
      SOURCES: set.map((g) => ({ ...gpSource(g), SOURCE_HANDLE: g.NORAD_CAT_ID })), PRIMARY_SOURCE_HANDLES: [PRIMARY] } });
    assert.equal(prepared.statusCode, 0, prepared.errorMessage);
    const index = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
    return read(await invoke('screen_window', { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: index.SCREENING_INDEX_HANDLE,
      CONTROLS: screeningControls({ startJd: START_JD, durationSeconds, numThreads: 4, coarseStepSec: STEP_S }), EVALUATION_FRAME: earthFrame('TEME') } }));
  }
  // One day stays in one implicit window; seven days (10080 coarse steps)
  // crosses the 10000-step chunk boundary.
  for (const [days, expected] of [[1, [69729]], [7, [8301, 60875, 69729]]]) {
    const run = await screen(GP, days * 86400);
    checkExcludedRecords(run, expected);
    const kept = await screen(GP.filter((g) => !expected.includes(g.NORAD_CAT_ID)), days * 86400);
    assert.equal(kept.excluded.length, 0);
    assert.equal(eventKey(run.events), eventKey(kept.events), `${days} d: other pairs unchanged`);
  }
});

test('an excluded catalog OMM without OBJECT_ID is reported without one', async (t) => {
  // OMM OBJECT_ID is optional; the screening then identifies the object by its
  // catalog number, which must not come back as an international designator.
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  const invocation = catalogInvoke(GP.filter((g) => [PRIMARY, 8301].includes(g.NORAD_CAT_ID)), { durationSeconds: 2 * 86400 });
  const record = gpRecord(GP.find((g) => g.NORAD_CAT_ID === 8301));
  delete record.OBJECT_ID;
  invocation.inputs[2] = { portId: 'catalog', payload: flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(record), { sizePrefix: false }) };
  const run = read(await harness.invoke(invocation));
  assert.deepEqual(run.excludedJson.map((o) => o.NORAD_CAT_ID), [8301]);
  assert.equal(run.excludedJson[0].OBJECT_ID, undefined);
  assert.equal(run.excludedJson[0].OBJECT_NAME, 'THORAD DELTA 1 DEB');
});
