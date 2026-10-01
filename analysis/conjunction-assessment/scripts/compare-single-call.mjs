// screen_catalog (one call) against the windowed screen (the module's CPU
// search) on the same catalog: run times, and the largest TCA and miss
// distance differences over matched conjunctions.
//
// usage: node scripts/compare-single-call.mjs <omm.uint32be.bin> <days>
// screen_catalog holds every encounter in memory: use a stride sample of a
// few thousand objects.
import fs from 'node:fs';
import { createConjunctionCommandHarness } from '../tests/lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls } from '../tests/lib/cqr.mjs';
import { splitCatalog, screenCatalog, screenWindows } from '../gpu/catalogScreen.mjs';

const [catalogPath, daysArg] = process.argv.slice(2);
if (!catalogPath || !daysArg) throw new Error('usage: compare-single-call.mjs <omm.uint32be.bin> <days>');

const flatc = await initCqrFlatc();
const days = Number(daysArg), startJd = 2461314.5, threads = 27;
const omm = splitCatalog(new Uint8Array(fs.readFileSync(catalogPath)));
const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
const pair = (a, b) => [a, b].sort((x, y) => x - y).join('-');
try {
  let t = performance.now();
  const inputs = [{ portId: 'request', payload: encodeCqr(flatc, { CATALOG_REQUEST: {
    CONTROLS: { ...screeningControls({ startJd, durationDays: days, numThreads: threads, coarseStepSec: 60, thresholdKm: 5 }), ALGORITHM: 'ALFANO_MAXIMUM' },
    EVALUATION_FRAME: earthFrame('TEME') } }) }, ...omm.map((payload) => ({ portId: 'catalog', payload }))];
  const single = [];
  for (;;) {
    const r = await harness.invoke({ methodId: 'screen_catalog', inputs });
    if (r.statusCode !== 0) throw new Error(`screen_catalog: ${r.errorCode} ${r.errorMessage}`);
    const res = decodeCqr(flatc, r.outputs.find((f) => f.portId === 'result').payload).CATALOG_RESULT;
    single.push(...res.EVENTS);
    if (res.FINAL_CHUNK) break;
  }
  const singleMs = performance.now() - t;

  t = performance.now();
  const windowed = await screenCatalog({ invoke: (methodId, i) => harness.invoke({ methodId, inputs: i }), propagator: 'sgp4',
    catalog: omm, windows: screenWindows(startJd, days, days * 24), controls: { thresholdKm: 5, coarseStepSec: 60, workers: threads }, screener: null });
  const windowedMs = performance.now() - t;

  const ref = new Map(single.map((e) => [pair(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID) + '@' + Math.round(e.TCA.JULIAN_DATE * 8640), e]));
  let matched = 0, dt = 0, dm = 0;
  for (const e of windowed.events) {
    const k = pair(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID) + '@' + Math.round(e.TCA.JULIAN_DATE * 8640);
    const x = ref.get(k);
    if (!x) continue;
    matched++;
    dt = Math.max(dt, Math.abs(x.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 864e5);
    dm = Math.max(dm, Math.abs(x.MISS_DISTANCE_M - e.MISS_DISTANCE_M) * 1000);
  }
  console.log(JSON.stringify({ objects: omm.length, days, singleMs: Math.round(singleMs), windowedMs: Math.round(windowedMs),
    single: single.length, windowed: windowed.events.length, matched, maxTcaMs: +dt.toFixed(3), maxMissMm: +dm.toFixed(2) }));
} finally {
  await harness.destroy?.();
}
