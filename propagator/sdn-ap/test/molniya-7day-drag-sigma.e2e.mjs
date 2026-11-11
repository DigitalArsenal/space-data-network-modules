#!/usr/bin/env node
// E2E (stack #438): on a 7-day arc of an eccentric orbit with drag, the fitted drag coefficient lies within three of its
// own stated sigmas of the truth. A known defect (test/known-defects.json) until the fit or the stated width changes.
// Fixture: high-e-fit-arc's Molniya (n 2 rev/day, e 0.74, i 63.4, RAAN 300, argp 270, M 10, perigee 541 km). The truth is
// test/lib/heo-model-truth.mjs, FFM 2.3.0 named below, with B 0.044 m^2/kg. The fit takes the 7-day arc on a 10-minute
// grid with no drag prior, and the forecast is flown 7 days.
// The record states B to a sigma of the log of about 0.00088 (SPEC 12.8: one independent sample per revolution). The fit
// has two solutions (#392), both outside it:
// - B 0.0438541 on 0.6.12 (-0.33 %, 3.8 sigma);
// - B 0.0437610 with the E-grid read C1 (#420; -0.54 %, 6.1 sigma).
// Printed, not asserted: the day-7 position error against the record's own position covariance. It is honest, in fact
// wide: 0.06 to 0.10 sigma, the stated sigma about 1.22 km radial and in-track and 0.41 km cross-track.
//   node test/molniya-7day-drag-sigma.e2e.mjs
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {bSigmas, statedAtForecastEnd} from './lib/stated-sigma.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0

const r = await runModelTruth({name: 'Molniya', n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10, drag: true, hourly: true, gridMinutes: 10,
  agomPrior: [0, 1e-10], fitDays: 7, fitUseable: false, fitPolicy: 'default'});
const bs = bSigmas(r.fitted.bModel), stated = await statedAtForecastEnd(r, 7);
console.log(JSON.stringify({bterm: r.fitted.bterm, bModel: r.fitted.bModel, bSigmas: +bs.toFixed(2), fitRmsM: +(r.fitted.wrms * 1000).toFixed(3),
  day7AlongTrackRmsM: +r.wholeDay[7].t.toFixed(2), day7Position: Object.fromEntries(Object.entries(stated).map(([k, v]) => [k, {errorM: +v.errorM.toFixed(1), sigmaM: +v.sigmaM.toFixed(1), z: +v.z.toFixed(2)}]))}));
if (!(bs <= 3)) {
  console.error(`FAIL the 7-day arc's B ${r.fitted.bterm} lies ${bs.toFixed(2)} of its stated sigma from 0.044 (at most 3; #438)`);
  process.exit(1);
}
console.log('Molniya 7-day drag sigma E2E: PASS');
process.exit(0);
