// The GPU all-vs-all path (coarse_grid -> candidate search -> refine_candidates,
// gpu/allVsAll.mjs) reports what screen_catalog reports for the same request.
//
// Source: fixtures/decaying/gp_2026-07-06.json (CelesTrak GP, see
// coarseExclusion.test.mjs): EXPLORER 7, eight objects that pass within 5 km
// of it on 2026-07-06, and three reentering objects, one of which SGP4 cannot
// propagate on 2026-07-06.
// All-vs-all, one day from 2026-07-06T00:00Z, 60 s steps, 5 km, ALFANO_MAXIMUM.
//
// The candidate search here proposes every pair at every coarse step, so the
// module's own f64 test decides every candidate; the WGSL kernel only narrows
// this set (scripts/run-all-vs-all-gpu.mjs runs it on a GPU). Checked:
// - the excluded objects and their records are screen_catalog's, byte for byte;
// - refine_candidates without candidates (its CPU scan) and with them find
//   screen_catalog's pairs, TCAs within 10 ms and misses within 10 cm
//   (tests/lib/caParityTolerances.mjs; encounters start from different
//   coarse windows, so the solver converges from different brackets).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, initCqrFlatc, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { CA_PARITY_TOLERANCES as T } from './lib/caParityTolerances.mjs';
import { parseGridFrame } from '../gpu/gpuScreen.mjs';
import { screenAllVsAllOnGpu } from '../gpu/allVsAll.mjs';

const GP = JSON.parse(fs.readFileSync(new URL('./fixtures/decaying/gp_2026-07-06.json', import.meta.url), 'utf8'));
const START_JD = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
const STEP_S = 60, THRESHOLD_KM = 5;

const flatc = await initCqrFlatc();
const catalog = GP.map((g) => flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false }));
const request = encodeCqr(flatc, { CATALOG_REQUEST: {
  CONTROLS: { ...screeningControls({ startJd: START_JD, durationDays: 1, numThreads: 2, coarseStepSec: STEP_S, thresholdKm: THRESHOLD_KM }), ALGORITHM: 'ALFANO_MAXIMUM' },
  EVALUATION_FRAME: earthFrame('TEME'),
} });
const decodeCatalogResult = (bytes) => decodeCqr(flatc, bytes).CATALOG_RESULT;

const everyPair = {
  async screenBlock(frame) {
    const { objects, firstStep, stepCount } = parseGridFrame(frame);
    const triples = [];
    for (let s = 0; s < stepCount; s++) for (let i = 0; i < objects; i++) for (let j = i + 1; j < objects; j++) triples.push(i, j, firstStep + s);
    return { triples: Uint32Array.from(triples), gpuMs: 0 };
  },
};

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

test('GPU all-vs-all path reports screen_catalog\'s conjunctions and exclusions', async () => {
  const harness = await createConjunctionCommandHarness();
  try {
    const inputs = [{ portId: 'request', payload: request }, ...catalog.map((payload) => ({ portId: 'catalog', payload }))];
    const reference = await drain(harness, 'screen_catalog', inputs);
    assert.ok(reference.events.length > 0);
    assert.ok(reference.excluded.length > 0);

    const scan = await drain(harness, 'refine_candidates', inputs);
    assertSameEvents(scan.events, reference.events, 'CPU scan');
    assert.deepEqual(scan.excluded, reference.excluded);

    const run = await screenAllVsAllOnGpu({
      invoke: (methodId, frames) => harness.invoke({ methodId, inputs: frames }),
      decodeCatalogResult, request, catalog, screener: everyPair, thresholdKm: THRESHOLD_KM, coarseStepSec: STEP_S,
    });
    assertSameEvents(run.events, reference.events, 'candidate path');
    assert.deepEqual(run.excludedRecords, reference.excluded);
  } finally {
    await harness.destroy?.();
  }
});
