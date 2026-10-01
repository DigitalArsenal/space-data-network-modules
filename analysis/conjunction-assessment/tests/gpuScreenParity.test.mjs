// The GPU all-vs-all path (resident index -> coarse_grid -> candidate search
// -> refine_candidates, gpu/allVsAll.mjs) reports what the module's own
// screening reports for the same trajectories, whichever propagator made them.
//
// SGP4: fixtures/decaying/gp_2026-07-06.json (CelesTrak GP, see
// coarseExclusion.test.mjs): EXPLORER 7, eight objects that pass within 5 km
// of it on 2026-07-06, and three reentering objects, one of which SGP4 cannot
// propagate on 2026-07-06. Mean elements in a resident index, all-vs-all, one
// day from 2026-07-06T00:00Z, TEME; reference: screen_catalog over the same
// element sets as catalog frames.
//
// HPOP: fixtures/hpop-ppe/crossing-orbits.json
// (scripts/generate-hpop-ppe-fixture.mjs): four objects on crossing planes
// that meet at 2026-10-01T00:00 TDB, integrated by propagator/hpop and
// exported as its conjunction-screening PPE (Chebyshev, GCRF, TDB). Resident
// PPE index, 2026-09-30T23:45Z UTC for 0.11 day, GCRF. The candidate path
// must equal the exhaustive CPU scan, and hold each pair's closest approach as
// screen_window's generic pair solver finds it on the same index (that solver
// reports one approach per pair; the tight path reports every one).
//
// Both run at 60 s steps, 5 km, ALFANO_MAXIMUM. The candidate search proposes
// every pair at every coarse step, so the module's f64 test decides every
// candidate; the WGSL kernel only narrows this set
// (scripts/run-all-vs-all-gpu.mjs runs it on a GPU). Events must match the
// reference pair for pair, TCAs within 10 ms and misses within 10 cm
// (tests/lib/caParityTolerances.mjs: encounters start from different coarse
// windows, so the solver converges from different brackets); exclusions name
// the same objects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { CA_PARITY_TOLERANCES as T } from './lib/caParityTolerances.mjs';
import { parseGridFrame } from '../gpu/gpuScreen.mjs';
import { screenAllVsAllOnGpu } from '../gpu/allVsAll.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const GP = fixture('decaying/gp_2026-07-06.json');
const HPOP = fixture('hpop-ppe/crossing-orbits.json');
const STEP_S = 60, THRESHOLD_KM = 5;

const flatc = await initCqrFlatc();
const decodeCatalogResult = (bytes) => decodeCqr(flatc, bytes).CATALOG_RESULT;
const controls = (startJd, durationDays) => ({
  ...screeningControls({ startJd, durationDays, numThreads: 2, coarseStepSec: STEP_S, thresholdKm: THRESHOLD_KM }),
  ALGORITHM: 'ALFANO_MAXIMUM',
});

const everyPair = {
  async screenBlock(frame) {
    const { objects, firstStep, stepCount } = parseGridFrame(frame);
    const triples = [];
    for (let s = 0; s < stepCount; s++) for (let i = 0; i < objects; i++) for (let j = i + 1; j < objects; j++) triples.push(i, j, firstStep + s);
    return { triples: Uint32Array.from(triples), gpuMs: 0 };
  },
};

const request = (record) => ({ portId: 'request', payload: encodeCqr(flatc, record) });
async function drain(harness, methodId, inputs) {
  const events = [], excluded = [];
  for (;;) {
    const response = await harness.invoke({ methodId, inputs });
    assert.equal(response.statusCode, 0, `${methodId}: ${response.errorMessage}`);
    const result = decodeCatalogResult(response.outputs.find((f) => f.portId === 'result').payload);
    events.push(...result.EVENTS);
    excluded.push(...response.outputs.filter((f) => f.portId === 'excluded').map((f) => f.payload));
    if (result.FINAL_CHUNK) return { events, excluded };
  }
}

const pairOf = (e) => [e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID].sort((a, b) => a - b).join('-');
function assertSameEvents(actual, expected, label) {
  const order = (list) => [...list].sort((a, b) => pairOf(a).localeCompare(pairOf(b)) || a.TCA.JULIAN_DATE - b.TCA.JULIAN_DATE);
  const a = order(actual), e = order(expected);
  assert.deepEqual(a.map(pairOf), e.map(pairOf), `${label}: pairs`);
  for (let k = 0; k < e.length; k++) {
    assert.ok(Math.abs(a[k].TCA.JULIAN_DATE - e[k].TCA.JULIAN_DATE) * 86400 <= T.tca.NLRV.hardFailSec, `${label} ${pairOf(e[k])}: TCA`);
    assert.ok(Math.abs(a[k].MISS_DISTANCE_M - e[k].MISS_DISTANCE_M) <= T.missDistance.aerospaceHardFailM, `${label} ${pairOf(e[k])}: miss`);
  }
}
const excludedNorads = (frames) => frames.map((bytes) =>
  JSON.parse(flatc.generateJSON(publishedSchema('OMM'), { path: '/omm.bin', data: bytes }, { defaultsJson: true })).NORAD_CAT_ID).sort();

// Prepares a resident index and returns the window request the GPU path takes.
let generation = 0;
async function residentWindow(harness, sources, startJd, durationDays, frame) {
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'gpu-parity', GENERATION: ++generation };
  const prepared = await harness.invoke({ methodId: 'prepare_screening_index', inputs: [request({ INDEX_REQUEST: {
    INSTANCE, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: sources } })] });
  assert.equal(prepared.statusCode, 0, prepared.errorMessage);
  const { SCREENING_INDEX_HANDLE } = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT;
  return { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE, CONTROLS: controls(startJd, durationDays), EVALUATION_FRAME: earthFrame(frame) } };
}

async function gpuPath(harness, windowRecord) {
  const windowRequest = encodeCqr(flatc, windowRecord);
  return screenAllVsAllOnGpu({
    invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }),
    decodeCatalogResult, request: windowRequest, screener: everyPair, thresholdKm: THRESHOLD_KM, coarseStepSec: STEP_S,
  });
}

test('SGP4 element sets: the GPU path reports screen_catalog\'s conjunctions and exclusions', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
    const omm = GP.map((g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false }));
    const reference = await drain(harness, 'screen_catalog', [
      request({ CATALOG_REQUEST: { CONTROLS: controls(startJd, 1), EVALUATION_FRAME: earthFrame('TEME') } }),
      ...omm.map((payload) => ({ portId: 'catalog', payload }))]);
    assert.ok(reference.events.length > 0);
    assert.ok(reference.excluded.length > 0);

    const windowRecord = await residentWindow(harness, GP.map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1 })), startJd, 1, 'TEME');
    const scan = await drain(harness, 'refine_candidates', [request(windowRecord)]);
    assertSameEvents(scan.events, reference.events, 'CPU scan');
    assert.deepEqual(excludedNorads(scan.excluded), excludedNorads(reference.excluded));

    const run = await gpuPath(harness, windowRecord);
    assertSameEvents(run.events, reference.events, 'candidate path');
    assert.deepEqual(excludedNorads(run.excludedRecords), excludedNorads(reference.excluded));
  } finally {
    await harness.destroy?.();
  }
});

test('HPOP trajectories (PPE, GCRF, TDB): the GPU path finds every approach', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = 2461314.5 - 15 / 1440;   // 2026-09-30T23:45Z UTC, inside the TDB-converted coverage
    const windowRecord = await residentWindow(harness, HPOP.sources, startJd, 0.11, 'GCRF');
    const closest = await drain(harness, 'screen_window', [request(windowRecord)]);
    assert.equal(closest.events.length, 6, 'every pair meets within the threshold');

    const scan = await drain(harness, 'refine_candidates', [request(windowRecord)]);
    const run = await gpuPath(harness, windowRecord);
    assertSameEvents(run.events, scan.events, 'candidate path');
    assert.equal(run.excludedRecords.length, 0);
    const found = scan.events.filter((e) => closest.events.some((c) => pairOf(c) === pairOf(e) &&
      Math.abs(c.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400 <= T.tca.NLRV.hardFailSec));
    assertSameEvents(found, closest.events, 'closest approaches');
  } finally {
    await harness.destroy?.();
  }
});
