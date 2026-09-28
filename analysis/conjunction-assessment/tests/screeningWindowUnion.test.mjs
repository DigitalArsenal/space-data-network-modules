// A long screening window reports exactly the conjunctions of its parts.
//
// Source: CelesTrak GP element sets (https://celestrak.org/NORAD/elements/),
// SGP4 mean elements in TEME of date, UTC, as cached in OrbPro's sandcastle
// gallery sgp4-propagation/omm-cache.fb: fixtures/decaying/gp_2026-07-06.json
// holds EXPLORER 7 (NORAD 22) and eight objects that pass within 5 km of it
// on 2026-07-06. Its three reentering objects are left out here (their
// exclusion is tests/coarseExclusion.test.mjs). Screening: EXPLORER 7 against
// the eight, 5 km threshold, 60 s coarse step, 1 ms refinement tolerance,
// 2026-07-06T00:00Z + 7 days. Units: metres and UTC Julian dates in CQR.
//
// A conjunction is a local minimum of a pair's range within the threshold,
// and it belongs to the window that holds its TCA. So seven consecutive
// one-day windows and one seven-day window over the same span report the same
// events: the same pairs, TCAs within the 1 ms refinement tolerance, and the
// same miss distance (each close approach is refined on its own coarse
// bracket, which does not depend on the window around it; the 60 s grids of
// the windows coincide). Before this was fixed, the resident seven-day window
// (10080 coarse steps, past the 10000-step chunk) returned 2 of the day's 9
// conjunctions, and one-day windows missed EXPLORER 7 - STARLINK-4714's second
// pass of the day (08:15 UTC, 4.86 km): one record per pair kept one event.
//
// Completeness is checked against a separate solver: the pair method with
// LAAS_2015 runs ConjunctionEngine's own TCA search (not the screener's
// coarse pass or refinement) on 35-minute tiles, 5 minutes overlapping, over
// the week (tests/lib/tiledPairSolver.mjs); a minimum within the threshold
// strictly inside a tile is a conjunction. A tile yields its closest approach
// only; conjunctions of one pair are at least half an orbit (45 minutes)
// apart, so no tile holds two. The two solvers agree to the NLRV TCA bound
// (10 ms) and the tool-to-tool miss bound (0.10 m) of
// tests/lib/caParityTolerances.mjs; they share the SGP4 implementation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CA_PARITY_TOLERANCES as T } from './lib/caParityTolerances.mjs';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';

const REENTERING = [8301, 60875, 69729];
const GP = JSON.parse(fs.readFileSync(new URL('./fixtures/decaying/gp_2026-07-06.json', import.meta.url), 'utf8'))
  .filter((g) => !REENTERING.includes(g.NORAD_CAT_ID));
const PRIMARY = 22;
const START_JD = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
const DAYS = 7;
const THRESHOLD_KM = 5;
const TOLERANCE_S = 0.001;
const controls = (startJd, durationDays, workers) => screeningControls({
  startJd, durationDays, numThreads: workers, thresholdKm: THRESHOLD_KM, coarseStepSec: 60, fineTolSec: TOLERANCE_S,
});

const flatc = await initCqrFlatc();
const ommBytes = (g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false });
const primaryFirst = [...GP.filter((g) => g.NORAD_CAT_ID === PRIMARY), ...GP.filter((g) => g.NORAD_CAT_ID !== PRIMARY)];

function read(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const results = response.outputs.filter((f) => f.portId === 'result').map((f) => decodeCqr(flatc, f.payload).CATALOG_RESULT);
  assert.equal(results.length, 1);
  assert.equal(results[0].FINAL_CHUNK, true);
  assert.equal(results[0].STATISTICS.FAILED_PAIRS, 0);
  return results[0].EVENTS ?? [];
}

const pairKey = (e) => [e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID].sort((a, b) => a - b).join('-');
const byTime = (events) => [...events].sort((a, b) => a.TCA.JULIAN_DATE - b.TCA.JULIAN_DATE || pairKey(a).localeCompare(pairKey(b)));

// The events of the whole window are those of its days: every one-day event
// has one window event of its pair within the refinement tolerance, with the
// same miss distance, and no window event is left over.
function assertSameConjunctions(days, whole, label) {
  const union = byTime(days.flat());
  const window = byTime(whole);
  assert.ok(union.length > 0, `${label}: the fixture has conjunctions`);
  assert.deepEqual(window.map(pairKey), union.map(pairKey), `${label}: same pairs in the same TCA order`);
  for (const [i, e] of union.entries()) {
    const w = window[i];
    const dt = Math.abs(w.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400;
    assert.ok(dt <= TOLERANCE_S, `${label}: ${pairKey(e)} TCA differs by ${dt} s`);
    assert.equal(w.MISS_DISTANCE_M, e.MISS_DISTANCE_M, `${label}: ${pairKey(e)} miss distance`);
    assert.ok(w.MISS_DISTANCE_M <= THRESHOLD_KM * 1000);
    // Event state epochs are the TCA in UTC text, to the millisecond.
    for (const state of [w.PRIMARY_STATE, w.SECONDARY_STATE]) {
      const epochMs = Date.parse(state.STATE.EPOCH);
      assert.ok(Number.isFinite(epochMs), `${label}: ${state.STATE.EPOCH} is a UTC epoch`);
      assert.ok(Math.abs(epochMs - (w.TCA.JULIAN_DATE - 2440587.5) * 86400000) <= 0.5, `${label}: ${state.STATE.EPOCH}`);
    }
  }
}

const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser', surface: 'direct' });
test.after(() => harness.destroy());
const invoke = (methodId, record, extra = []) =>
  harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }, ...extra] });

let generation = 0;
async function residentWindow(startJd, durationDays, workers = 4) {
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'window-union', GENERATION: ++generation };
  const prepared = await invoke('prepare_screening_index', { INDEX_REQUEST: { INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY',
    SOURCES: GP.map((g) => ({ ...gpSource(g), SOURCE_HANDLE: g.NORAD_CAT_ID })), PRIMARY_SOURCE_HANDLES: [PRIMARY] } });
  assert.equal(prepared.statusCode, 0, prepared.errorMessage);
  const index = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
  return invoke('screen_window', { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: index.SCREENING_INDEX_HANDLE,
    CONTROLS: controls(startJd, durationDays, workers), EVALUATION_FRAME: earthFrame('TEME') } });
}

// OrbPro's Live-catalog request shape: the primary first, the rest as
// secondaries, by ordered ranges over catalog port frames.
function catalogWindow(startJd, durationDays, workers = 4) {
  return invoke('screen_catalog', { CATALOG_REQUEST: { CONTROLS: controls(startJd, durationDays, workers), EVALUATION_FRAME: earthFrame('TEME'),
    START_ORDER_INDEX: 0, HAS_START_ORDER_INDEX: true, END_ORDER_INDEX: 1, HAS_END_ORDER_INDEX: true,
    SECONDARY_START_ORDER_INDEX: 1, HAS_SECONDARY_START_ORDER_INDEX: true,
    SECONDARY_END_ORDER_INDEX: primaryFirst.length, HAS_SECONDARY_END_ORDER_INDEX: true } },
  primaryFirst.map((g) => ({ portId: 'catalog', payload: ommBytes(g) })));
}

const bytes = (response) => Buffer.concat(response.outputs.map((f) => Buffer.from(f.payload))).toString('hex');
const results = {};

for (const [name, screen] of [['resident screen_window', residentWindow], ['screen_catalog', catalogWindow]]) {
  test(`${name}: one seven-day window reports the conjunctions of its seven days`, async () => {
    const days = [];
    for (let d = 0; d < DAYS; d++) days.push(read(await screen(START_JD + d, 1)));
    const wholeResponse = await screen(START_JD, DAYS);
    const whole = read(wholeResponse);
    assertSameConjunctions(days, whole, name);
    assert.equal(bytes(await screen(START_JD, DAYS, 1)), bytes(wholeResponse), `${name}: worker count changes no byte`);
    results[name] = whole;
  });
}

test('the week holds exactly the conjunctions a separate TCA solver finds on short tiles', async () => {
  const solver = fileURLToPath(new URL('./lib/tiledPairSolver.mjs', import.meta.url));
  const primary = GP.find((g) => g.NORAD_CAT_ID === PRIMARY);
  const secondaries = GP.filter((g) => g.NORAD_CAT_ID !== PRIMARY);
  const solve = async (secondary) => {
    const { stdout } = await promisify(execFile)(process.execPath, [solver, JSON.stringify({
      primary, secondary, startJd: START_JD, durationSeconds: DAYS * 86400,
      tileSeconds: 35 * 60, strideSeconds: 30 * 60, thresholdKm: THRESHOLD_KM, fineTolSec: TOLERANCE_S,
    })], { maxBuffer: 1 << 20 });
    return JSON.parse(stdout).map((e) => ({ PRIMARY_NORAD_ID: PRIMARY, SECONDARY_NORAD_ID: secondary.NORAD_CAT_ID,
      TCA: { JULIAN_DATE: e.tcaJd }, MISS_DISTANCE_M: e.missM }));
  };
  const found = [];
  for (let i = 0; i < secondaries.length; i += 4) {
    for (const events of await Promise.all(secondaries.slice(i, i + 4).map(solve))) found.push(...events);
  }
  for (const name of ['resident screen_window', 'screen_catalog']) {
    const window = byTime(results[name]);
    const oracle = byTime(found);
    assert.deepEqual(window.map(pairKey), oracle.map(pairKey), `${name}: the same conjunctions as the tiled solver`);
    for (const [i, e] of oracle.entries()) {
      assert.ok(Math.abs(window[i].TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400 <= T.tca.NLRV.hardFailSec, `${name}: ${pairKey(e)} TCA`);
      assert.ok(Math.abs(window[i].MISS_DISTANCE_M - e.MISS_DISTANCE_M) <= T.missDistance.aerospaceHardFailM, `${name}: ${pairKey(e)} miss`);
    }
  }
  // EXPLORER 7 and STARLINK-4714 meet twice on 2026-07-06, 94 minutes apart.
  assert.equal(found.filter((e) => pairKey(e) === '22-53704').length, 2);
});
