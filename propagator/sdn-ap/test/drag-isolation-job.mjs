// modules-sdn-ap-drag-high-eccentricity-20261103, step 1 (measurement; no theory change): one job of the isolation
// matrix. node drag-isolation-job.mjs <out.json> <job json>
//   job.kind 'iso'  : a fixture with drag on and off against FFM, Sun and Moon off on both sides (AP: a test build with
//                     the Sun's and Moon's masses zero, job.module; FFM: thirdBody false), BTERM at the truth 0.044 either
//                     as the seeded mean-element set (job.mode 'seed': no fit, the FFM state is AP's own epoch state) or
//                     as a fit pinned at 0.044 (job.mode 'pinned': GAUSSIAN_SIGNED, sigma 1e-7), on a 10 minute grid
//   job.kind 'scan': the day-7 error with BTERM pinned at job.b, on a 10 minute grid
//   job.agom0       : the pinned fits also pin AGOM at 0 (the truth has no SRP; otherwise the fit's SRP coefficient is free)
//   job.kind 'fit'  : a fit of job.fitDays days (prior job.prior: 'gauss' the model-truth library's Gaussian at the
//                     truth with sigma 0.1, 'default' the band default) on the release module with the Sun and Moon on
//                     both sides, 60 minute grid over job.forecastDays days after the fit
import fs from 'node:fs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
const [out, jobText] = process.argv.slice(2);
const job = JSON.parse(jobText);
const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const slim = (r) => ({fitted: r.fitted, perigeeKm: r.perigeeKm, fixture: {initialGcrfKm: r.fixture.initialGcrfKm}, omm: r.omm, profile: r.profile, flown: r.flown,
  reference: r.referenceStates.map((s) => [...s.position, ...s.velocity]), wholeDay: r.wholeDay, apSha256: r.apSha256, ffmSha256: r.ffmSha256});
const f = FIXTURES[job.fixture];
let result;
if (job.kind === 'iso') {
  const common = {...f, thirdBody: false, modulePath: job.module};
  if (job.mode === 'seed') Object.assign(common, {mode: 'seed', seedGridMin: 10, seedDays: 7});
  else Object.assign(common, {hourly: true, gridMinutes: 10});
  const onPolicy = job.mode === 'pinned' ? {fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: 0.044, sigma: 1e-7}, ...(job.agom0 ? {agomPrior: [0, 1e-10]} : {})} : {};
  result = {job, on: slim(await runModelTruth({name: job.fixture + '-on', ...common, drag: true, ...onPolicy})),
    off: slim(await runModelTruth({name: job.fixture + '-off', ...common, drag: false}))};
} else if (job.kind === 'scan') {
  // the day-7 error with BTERM pinned at job.b (the truth is 0.044), Sun and Moon off (job.thirdBody false) or on, 10 minute grid
  const c = {...f, drag: true, hourly: true, gridMinutes: 10, thirdBody: job.thirdBody ?? false, modulePath: job.module,
    fitPolicy: {form: 'GAUSSIAN_SIGNED', mean: job.b, sigma: 1e-7}, ...(job.agom0 ? {agomPrior: [0, 1e-10]} : {})};
  result = {job, run: slim(await runModelTruth({name: job.fixture, ...c}))};
} else {
  const c = {...f, drag: true, hourly: true, gridMinutes: 60, fitDays: job.fitDays, forecastDays: job.forecastDays, modulePath: job.module, thirdBody: job.thirdBody ?? true};
  if (job.prior === 'default') c.fitPolicy = 'default';
  result = {job, run: slim(await runModelTruth({name: job.fixture, ...c}))};
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({job, wholeDay: result.run?.wholeDay ?? result.on.wholeDay, fitted: (result.run ?? result.on).fitted}));
