// Close approaches of one pair found by the pair method (ConjunctionEngine's
// TCA search, selected by LAAS_2015) on overlapping tiles of a window, apart
// from the screener's coarse pass and refinement. A tile yields its closest
// approach; one within the threshold and strictly inside the tile (1 s from
// either edge) is a conjunction. Run as a child process, one per pair: an
// instance fails after about 1780 pair-method calls (a separate defect), and
// a process holds the count.
//
// argv[2]: JSON { primary, secondary (GP records), startJd, durationSeconds,
// tileSeconds, strideSeconds, thresholdKm, fineTolSec }. Prints a JSON array
// of { tcaJd, missM } in TCA order.
import { createConjunctionCommandHarness } from './conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, screeningControls } from './cqr.mjs';

const o = JSON.parse(process.argv[2]);
const flatc = await initCqrFlatc();
const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser', surface: 'direct' });
const found = [];
try {
  for (let offset = 0; offset < o.durationSeconds; offset += o.strideSeconds) {
    const tileStart = o.startJd + offset / 86400;
    const tileSeconds = Math.min(o.tileSeconds, o.durationSeconds - offset);
    const response = await harness.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { PAIR_REQUEST: {
      PRIMARY: gpSource(o.primary), SECONDARY: gpSource(o.secondary),
      CONTROLS: { ...screeningControls({ startJd: tileStart, durationSeconds: tileSeconds, coarseStepSec: 5, thresholdKm: o.thresholdKm, fineTolSec: o.fineTolSec }), ALGORITHM: 'LAAS_2015' },
      PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME'),
    } }) }] });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    const e = decodeCqr(flatc, response.outputs[0].payload).EVENT_RESULT;
    const intoTile = (e.TCA.JULIAN_DATE - tileStart) * 86400;
    if (e.MISS_DISTANCE_M > o.thresholdKm * 1000 || intoTile < 1 || intoTile > tileSeconds - 1) continue;
    if (!found.some((f) => Math.abs(f.tcaJd - e.TCA.JULIAN_DATE) * 86400 < 1)) found.push({ tcaJd: e.TCA.JULIAN_DATE, missM: e.MISS_DISTANCE_M });
  }
} finally {
  await harness.destroy();
}
process.stdout.write(JSON.stringify(found.sort((a, b) => a.tcaJd - b.tcaJd)));
