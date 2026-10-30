// Objects SGP4 refuses during the screening window are reported and screened
// for as long as SGP4 propagates them, instead of failing the whole request.
//
// Source: CelesTrak GP element sets (https://celestrak.org/NORAD/elements/),
// SGP4 mean elements in TEME of date, UTC epochs 2026-06-25..2026-07-06, as
// cached in OrbPro's sandcastle gallery sgp4-propagation/omm-cache.fb
// (OrbPro 8afe810111). fixtures/decaying/gp_2026-07-06.json holds EXPLORER 7
// (NORAD 22), eight objects that pass within 5 km of it during 2026-07-06, and
// three reentering objects: THORAD DELTA 1 DEB (8301, ndot 0.065 rev/day^2),
// CZ-6A DEB (60875) and STARLINK-34343 DEB (69729, epoch ten days before the
// window). SGP4 refuses 8301 and 60875 part-way through the week and 69729
// from its start.
//
// Every assertion is a computable property, not a golden output:
// - an object refused from the window start is excluded, the same as leaving
//   it out; an object refused part-way is screened up to its last valid
//   instant, its conjunctions lying before it; every other pair's events are
//   identical to a screening whose catalog never contained them;
// - the reported record is the object's own OMM (identity and elements equal
//   the input), Earth/TEME, with its span in COMMENT (README, "Objects the
//   propagator refuses");
// - a span does not depend on the window: a window whose last coarse epoch
//   lies well before the refusal reports nothing, and one that reaches the
//   first refused coarse epoch reports the same span as the week;
// - OBJECTS_PARSED - TOTAL_OBJECTS is the number of excluded records
//   (LAST_VALID=NONE);
// - the bytes do not depend on the worker count.
// Units: km/km/s inside the guest, metres and UTC Julian dates in CQR.
// No tolerance is involved: comparisons are exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, parseFlatcJson, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { privateFixtureSkip, readPrivateFixtureJson, privateFixturePath } from './lib/privateFixtures.mjs';

const GP_SKIP = privateFixtureSkip('decaying/gp_2026-07-06.json');
const GP = readPrivateFixtureJson('decaying/gp_2026-07-06.json');
const START_JD = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
const STEP_S = 60;
const PRIMARY = 22;

const flatc = await initCqrFlatc();
const ommBytes = (g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false });
const ommJson = (bytes) => parseFlatcJson(flatc.generateJSON(publishedSchema('OMM'), { path: '/omm.bin', data: bytes }, { defaultsJson: true }));

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

const ISO = '(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)';
const SPAN = new RegExp(`^Screened until LAST_VALID; SGP4 refuses it from FIRST_REFUSAL\\. LAST_VALID=${ISO}; FIRST_REFUSAL=${ISO}; REFUSAL=(.*SGP4.*)$`);
const EXCLUDED = new RegExp(`^Excluded from conjunction screening; SGP4 refuses it from the window start\\. LAST_VALID=NONE; FIRST_REFUSAL=${ISO}; REFUSAL=(.*SGP4.*)$`);
const jdOf = (iso) => Date.parse(iso) / 86400000 + 2440587.5;

// expected: [NORAD, 'excluded' | 'span'] in the order of the records.
function checkRefusedRecords(run, expected) {
  assert.deepEqual(run.excludedJson.map((o) => o.NORAD_CAT_ID), expected.map(([norad]) => norad));
  const spans = new Map();
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
    if (expected[index][1] === 'excluded') {
      const match = EXCLUDED.exec(COMMENT);
      assert.ok(match, `${omm.NORAD_CAT_ID}: ${COMMENT}`);
      assert.equal(jdOf(match[1]), START_JD, `${omm.NORAD_CAT_ID}: refused from the window start`);
    } else {
      const match = SPAN.exec(COMMENT);
      assert.ok(match, `${omm.NORAD_CAT_ID}: ${COMMENT}`);
      const last = jdOf(match[1]), first = jdOf(match[2]);
      assert.ok(last > START_JD && first > last && (first - last) * 86400 <= 0.003, `${omm.NORAD_CAT_ID}: ${COMMENT}`);
      spans.set(omm.NORAD_CAT_ID, { comment: COMMENT, last });
    }
    assert.equal(Buffer.from(run.excluded[index].payload.subarray(4, 8)).toString('latin1'), '$OMM');
  }
  assert.equal(run.result.OBJECTS_PARSED - run.result.STATISTICS.TOTAL_OBJECTS,
               expected.filter(([, kind]) => kind === 'excluded').length);
  assert.equal(run.result.STATISTICS.FAILED_PAIRS, 0);
  return spans;
}

// A refused object's events lie before its last valid instant.
function checkEventsInSpans(events, spans, excluded) {
  for (const e of events) {
    for (const norad of [e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID]) {
      assert.ok(!excluded.includes(norad), `an event of excluded ${norad}`);
      const span = spans.get(norad);
      if (span) assert.ok(e.TCA.JULIAN_DATE <= span.last, `${norad}: an event after its last valid instant`);
    }
  }
}
const without = (events, norads) => events.filter((e) => !norads.includes(e.PRIMARY_NORAD_ID) && !norads.includes(e.SECONDARY_NORAD_ID));
const REFUSED = [8301, 60875, 69729];

const eventKey = (events) => JSON.stringify(events);

test('screen_catalog completes on a catalog with reentering objects, screening each for as long as SGP4 propagates it', { skip: GP_SKIP }, async (t) => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  t.after(() => harness.destroy());
  const week = 7 * 86400;

  const runs = [];
  for (const workers of [1, 4]) runs.push(await harness.invoke(catalogInvoke(GP, { durationSeconds: week, workers })));
  const bytes = (r) => Buffer.concat(r.outputs.map((f) => Buffer.from(f.payload))).toString('hex');
  assert.equal(bytes(runs[1]), bytes(runs[0]), 'worker count changes nothing');

  const run = read(runs[0]);
  const spans = checkRefusedRecords(run, [[8301, 'span'], [60875, 'span'], [69729, 'excluded']]);
  assert.equal(run.result.OBJECTS_PARSED, GP.length);
  assert.ok(run.events.length > 0);
  for (const e of run.events) assert.equal(e.PRIMARY_NORAD_ID, PRIMARY);
  checkEventsInSpans(run.events, spans, [69729]);

  const kept = read(await harness.invoke(catalogInvoke(GP.filter((g) => !REFUSED.includes(g.NORAD_CAT_ID)), { durationSeconds: week })));
  assert.equal(kept.excluded.length, 0);
  assert.equal(eventKey(without(run.events, REFUSED)), eventKey(kept.events), 'the other pairs are screened as if the refused objects were absent');
  assert.equal(run.result.STATISTICS.TOTAL_OBJECTS, kept.result.STATISTICS.TOTAL_OBJECTS + 2, 'objects screened in part are covered');

  // A span does not depend on the window. 8301's first refused coarse epoch
  // is step k, the one after its last valid instant. A window ending at step
  // k - 2 reports nothing; one reaching step k reports the week's span.
  const k = Math.floor((spans.get(8301).last - START_JD) * 86400 / STEP_S) + 1;
  assert.ok(k > 2);
  const pair = GP.filter((g) => [PRIMARY, 8301].includes(g.NORAD_CAT_ID));
  const before = read(await harness.invoke(catalogInvoke(pair, { durationSeconds: (k - 2) * STEP_S })));
  assert.equal(before.excluded.length, 0, 'propagates through the window');
  assert.equal(before.result.STATISTICS.TOTAL_OBJECTS, 2);
  const at = read(await harness.invoke(catalogInvoke(pair, { durationSeconds: (k + 0.5) * STEP_S })));
  assert.deepEqual(checkRefusedRecords(at, [[8301, 'span']]).get(8301), spans.get(8301));
});

test('resident screen_window reports the same spans on the implicit and chunked coarse paths', { skip: GP_SKIP }, async (t) => {
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
  // crosses the 10000-step chunk boundary, and match screen_catalog's spans.
  const week = read(await harness.invoke(catalogInvoke(GP, { durationSeconds: 7 * 86400 })));
  const catalogSpans = checkRefusedRecords(week, [[8301, 'span'], [60875, 'span'], [69729, 'excluded']]);
  for (const [days, expected] of [[1, [[69729, 'excluded']]], [7, [[8301, 'span'], [60875, 'span'], [69729, 'excluded']]]]) {
    const run = await screen(GP, days * 86400);
    const spans = checkRefusedRecords(run, expected);
    const refused = expected.map(([norad]) => norad);
    checkEventsInSpans(run.events, spans, [69729]);
    if (days === 7) assert.deepEqual([...spans], [...catalogSpans], 'the spans screen_catalog reports');
    const kept = await screen(GP.filter((g) => !refused.includes(g.NORAD_CAT_ID)), days * 86400);
    assert.equal(kept.excluded.length, 0);
    assert.equal(eventKey(without(run.events, refused)), eventKey(kept.events), `${days} d: other pairs unchanged`);
  }
});

test('a reported catalog OMM without OBJECT_ID is reported without one', { skip: GP_SKIP }, async (t) => {
  // OMM OBJECT_ID is optional; the screening then identifies the object by its
  // catalog number, which must not come back as an international designator.
  // 8301 is refused part-way through these two days, so it is reported.
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
