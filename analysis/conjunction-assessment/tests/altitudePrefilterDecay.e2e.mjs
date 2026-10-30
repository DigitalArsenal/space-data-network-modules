// A pair whose epoch altitude bands lie apart is still screened when an orbit
// decays into the other's band inside the window (the radial gate,
// src/cpp/src/screening_internal.cpp): screen_catalog on its explicit-pairs path
// (inline primaries and secondaries, and catalog order ranges as SOCRATES-style
// units use) and on its all-vs-all path, and screen_window on a resident index
// (every object primary, and one primary), report the conjunction the pair
// method finds; the pair method uses no altitude filter.
// Run: node --test tests/altitudePrefilterDecay.e2e.mjs
//
// Synthetic (invented element sets, SGP4 mean elements, TEME, UTC):
// SYN-DECAY-A circular at 400 km, i 53 deg, BSTAR 0.05 per Earth radius;
// SYN-LOW-B circular at 250 km, i 97.6 deg, BSTAR 1e-4; epoch
// 2026-10-28T17:00Z. Their epoch bands are 148 km apart, beyond the bands'
// 50 km margin each. A decays through B's altitude and passes 4.230 km from it
// 3.620 days after the epoch (B's mean anomaly, 305.7 deg, was chosen for that
// pass with the pair method). Window: 6 h about the pass. The all-vs-all case
// adds tests/lib/syntheticCatalog.mjs's 721 invented sets, so the screen takes
// its large-catalog path. Control: the same pair without decay (both BSTAR
// 1e-4) never meets, and the bands still count it prefiltered.
//
// Named (private fixture: Space-Track GP editions SOCRATES used, from the
// SOCRATES parity run's catalog, and SOCRATES Plus rows): every SOCRATES event
// that run attributed to the altitude prefilter, 8 in 6 pairs, epoch bands
// 120-190 km apart, one object of each decaying (BSTAR 0.03-0.13). Among
// them 48603 STARLINK-2714 (BSTAR 0.032) x 68828 COSMOS 2617, 120 km apart,
// SOCRATES TCA 2026-11-04T03:28:00.307Z, 2.865 km; 45695 STARLINK-1420 x
// 48667 STARLINK-2735 (BSTAR 0.054), 190 km apart, 2026-11-04T04:42:17.641Z,
// 4.280 km. Window: 6 h about each TCA.
//
// Tolerances: every screen against the pair method, TCA within 1 ms and miss
// within 1 cm (the screener refines on its own brackets to the 1 ms
// refinement tolerance). Against SOCRATES, which prints the TCA to the
// millisecond and the range to the metre: TCA within 1.5 ms (the refinement
// tolerance and SOCRATES's rounding) and miss within 1 m (measured: 0.48 ms
// and 0.22 m, 0.04 ms and 0.03 m).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { syntheticGp } from './lib/syntheticCatalog.mjs';
import { privateFixtureSkip, readPrivateFixtureJson } from './lib/privateFixtures.mjs';

const FIXTURE = 'socrates/decaying-pairs-2026-10-28.json';
const NAMED_SKIP = privateFixtureSkip(FIXTURE);
const NAMED = readPrivateFixtureJson(FIXTURE, { gp: [], socrates: [] });

const JD_UNIX = 2440587.5, jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
const EPOCH = '2026-10-28T17:00:00.000000';
const element = (name, norad, meanMotion, inclination, meanAnomaly, bstar) => ({ OBJECT_NAME: name, OBJECT_ID: name, NORAD_CAT_ID: norad,
  EPOCH, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: bstar, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
  MEAN_MOTION: meanMotion, ECCENTRICITY: 0.0001, INCLINATION: inclination, RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: meanAnomaly });
// Mean motions of circular orbits at 400 km and 250 km (two-body, WGS 72).
const A = element('SYN-DECAY-A', 900201, 15.55741523, 53, 0, 0.05);
const B = element('SYN-LOW-B', 900202, 16.08850695, 97.6, 305.7, 0.0001);
const SYNTHETIC_PASS_JD = jdOf('2026-10-28T17:00:00Z') + 3.620;

const flatc = await initCqrFlatc();
const THRESHOLD_KM = 5, STEP_S = 60;
const controls = (startJd, durationSeconds) => ({ ...screeningControls({ startJd, durationSeconds, coarseStepSec: STEP_S,
  thresholdKm: THRESHOLD_KM, numThreads: 2 }), ALGORITHM: 'ALFANO_MAXIMUM' });
const ommBytes = (g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false });
let generation = 0;

async function invoke(harness, methodId, record, extra = []) {
  const response = await harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }, ...extra] });
  assert.equal(response.statusCode, 0, `${methodId} ${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.filter((f) => f.portId === 'result').map((f) => decodeCqr(flatc, f.payload));
}
const catalogResult = (records) => {
  const results = records.map((r) => r.CATALOG_RESULT);
  assert.equal(results.at(-1).FINAL_CHUNK, true);
  return { events: results.flatMap((r) => r.EVENTS ?? []), statistics: results.at(-1).STATISTICS };
};
const pairOf = (e) => [Number(e.PRIMARY_NORAD_ID), Number(e.SECONDARY_NORAD_ID)].sort((x, y) => x - y).join('-');

// The pair method's conjunction near a TCA (no altitude filter on that path).
async function pairMethod(harness, a, b, tcaJd) {
  const [result] = await invoke(harness, 'assess_conjunction', { PAIR_REQUEST: { PRIMARY: gpSource(a), SECONDARY: gpSource(b),
    CONTROLS: controls(tcaJd - 600 / 86400, 1200), PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });
  return result.EVENT_RESULT;
}
function assertFound(events, reference, label) {
  const key = [Number(reference.PRIMARY_NORAD_ID), Number(reference.SECONDARY_NORAD_ID)].sort((x, y) => x - y).join('-');
  const found = events.filter((e) => pairOf(e) === key && Math.abs(e.TCA.JULIAN_DATE - reference.TCA.JULIAN_DATE) * 86400 < 60);
  assert.equal(found.length, 1, `${label}: the conjunction is reported once (${events.length} events)`);
  assert.ok(Math.abs(found[0].TCA.JULIAN_DATE - reference.TCA.JULIAN_DATE) * 86400 <= 0.001, `${label}: TCA against the pair method`);
  assert.ok(Math.abs(found[0].MISS_DISTANCE_M - reference.MISS_DISTANCE_M) <= 0.01, `${label}: miss against the pair method`);
  return found[0];
}

// Every screen of one pair in one window: the conjunction, as the pair method gives it.
async function screenEverywhere(harness, a, b, tcaJd, label, fillers = []) {
  const startJd = tcaJd - 3 / 24, seconds = 6 * 3600;
  const reference = await pairMethod(harness, a, b, tcaJd);
  assert.ok(reference.MISS_DISTANCE_M < THRESHOLD_KM * 1000, `${label}: pair method miss ${reference.MISS_DISTANCE_M} m`);
  const found = [];
  // Explicit pairs: inline primary and secondary.
  found.push(assertFound(catalogResult(await invoke(harness, 'screen_catalog', { CATALOG_REQUEST: { PRIMARIES: [gpSource(a)],
    SECONDARIES: [gpSource(b)], CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } })).events, reference, `${label} inline`));
  // Explicit pairs: catalog port, a SOCRATES-style unit (primary range [0, 1) against the catalog).
  const catalog = [a, b, ...fillers];
  const frames = catalog.map((g) => ({ portId: 'catalog', payload: ommBytes(g) }));
  found.push(assertFound(catalogResult(await invoke(harness, 'screen_catalog', { CATALOG_REQUEST: { CONTROLS: controls(startJd, seconds),
    EVALUATION_FRAME: earthFrame('TEME'), ORDERED_CATALOG_INDICES: catalog.map((_, i) => i), START_ORDER_INDEX: 0, HAS_START_ORDER_INDEX: true,
    END_ORDER_INDEX: 1, HAS_END_ORDER_INDEX: true, SECONDARY_START_ORDER_INDEX: 0, HAS_SECONDARY_START_ORDER_INDEX: true,
    SECONDARY_END_ORDER_INDEX: catalog.length, HAS_SECONDARY_END_ORDER_INDEX: true } }, frames)).events, reference, `${label} catalog unit`));
  // All vs all over the catalog port.
  if (fillers.length) {
    found.push(assertFound(catalogResult(await invoke(harness, 'screen_catalog', { CATALOG_REQUEST: { CONTROLS: controls(startJd, seconds),
      EVALUATION_FRAME: earthFrame('TEME') } }, frames)).events, reference, `${label} all vs all`));
  }
  // Resident index: every object primary, then one primary (the pairwise scan).
  for (const primaries of [[], [a.NORAD_CAT_ID]]) {
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'decaying-prefilter', GENERATION: ++generation };
    const [prepared] = await invoke(harness, 'prepare_screening_index', { INDEX_REQUEST: { INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS',
      REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: catalog.map((g) => ({ ...gpSource(g), SOURCE_HANDLE: g.NORAD_CAT_ID })), PRIMARY_SOURCE_HANDLES: primaries } });
    const handle = prepared.INDEX_RESULT.SCREENING_INDEX_HANDLE;
    found.push(assertFound(catalogResult(await invoke(harness, 'screen_window', { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: handle,
      CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } })).events, reference,
      `${label} screen_window ${primaries.length ? 'one primary' : 'all primary'}`));
    await invoke(harness, 'destroy_screening_index', { DESTROY_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: handle } });
  }
  return { reference, found };
}

test('a decaying orbit entering another band: every screen finds the pass the pair method finds', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const fillers = syntheticGp({ epoch: EPOCH });
    const { reference } = await screenEverywhere(harness, A, B, SYNTHETIC_PASS_JD, 'synthetic', fillers);
    assert.ok(Math.abs(reference.MISS_DISTANCE_M - 4230) < 1, `synthetic pass ${reference.MISS_DISTANCE_M} m`);
    // The control: without decay the bands are right; the pair is not met and stays prefiltered.
    const steadyA = { ...A, BSTAR: 0.0001 };
    const startJd = SYNTHETIC_PASS_JD - 3 / 24;
    const steady = catalogResult(await invoke(harness, 'screen_catalog', { CATALOG_REQUEST: { PRIMARIES: [gpSource(steadyA)],
      SECONDARIES: [gpSource(B)], CONTROLS: controls(startJd, 6 * 3600), EVALUATION_FRAME: earthFrame('TEME') } }));
    assert.equal(steady.events.length, 0, 'steady pair: no conjunction');
    assert.equal(Number(steady.statistics.PAIRS_PREFILTERED), 1, 'steady pair: prefiltered by its bands');
    assert.equal(Number(steady.statistics.PAIRS_SCREENED), 0, 'steady pair: not screened');
  } finally {
    await harness.destroy?.();
  }
});

test('SOCRATES pairs with a decaying object: every screen finds SOCRATES\'s conjunction', { skip: NAMED_SKIP }, async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const byNorad = new Map(NAMED.gp.map((g) => [Number(g.NORAD_CAT_ID), g]));
    for (const row of NAMED.socrates) {
      const label = `${row.norad1} x ${row.norad2}`;
      const tcaJd = jdOf(row.tca);
      const { reference } = await screenEverywhere(harness, byNorad.get(row.norad1), byNorad.get(row.norad2), tcaJd, label);
      const dtMs = (reference.TCA.JULIAN_DATE - tcaJd) * 86400000, dMissM = reference.MISS_DISTANCE_M - row.rangeKm * 1000;
      assert.ok(Math.abs(dtMs) <= 1.5 && Math.abs(dMissM) <= 1, `${label}: SOCRATES's event, TCA ${dtMs} ms and miss ${dMissM} m from SOCRATES's`);
    }
  } finally {
    await harness.destroy?.();
  }
});
