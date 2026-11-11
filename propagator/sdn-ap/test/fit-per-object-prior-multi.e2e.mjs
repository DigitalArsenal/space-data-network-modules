#!/usr/bin/env node
// Registration (2026-11-03, modules-sdn-ap-fit-per-object-prior-multi-20261103): one fit call, two objects, each with
// its own BTERM and AGOM priors (SPEC 12.8: after the call's $PCF, one $PCF per 'ephemeris' frame stating only
// FIT.DRAG_PRIOR, FIT.SRP_PRIOR and their forms). Model truth as test/fit-bterm-700-1400-km.e2e.mjs (FFM EGM2008 70x70,
// Sun and Moon from DE440, NRLMSISE-00 at constant weather on both sides; AP FORCES 31,20 with NRLMSISE-00; 72 h fits;
// day-3 3D RMS over 2-minute samples) on the SWOT-like orbit (true BTERM 0.044 m^2/kg) and the Sentinel-3-like orbit
// (true BTERM 0.001).
// Acceptance:
// 1. fit 1, one call on the band defaults: each object's $OCM the bytes of its single-object fit, and its posterior in
//    the record (BTERM and its sigma of the log, sigma_B / B, and AGOM and its sigma from COVARIANCE_DATA: the $OBD and
//    its model text are gone, modules-sdn-ap-ocm-write-20261103); fit 2, one call, each object's own posterior as its prior (BTERM LOG_NORMAL with the posterior
//    median and, as the sigma of the log, the larger of the posterior's and 0.3; AGOM GAUSSIAN_SIGNED with the posterior
//    value and the larger of its sigma and 0.01): each object's $OMM the bytes of its single-object fit with that prior;
//    the day-3 errors printed;
// 2. 0.4.12's per-object path in one call (each object's true BTERM, sigma of the log 0.3): SWOT-like within 2 m of
//    17.31 m, the slow set's (SPEC 16.18; 0.4.12's single-object 21.33 m, held through 0.6.20); Sentinel-3-like printed;
// 3. the shared prior (SWOT-like's carried prior for both objects in the call's one $PCF, the only way before 0.4.13):
//    the Sentinel-3-like object worse than under its own posterior, by the amount printed;
// 4. default-FORCES XP digest bit-exact.
import assert from 'node:assert/strict';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
import {reproduceConformance} from './lib/conformance-step.mjs';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {configuration, pcfPriorForm, prior} from './lib/pcf.mjs';
import {fittedOf} from './lib/ocm.mjs';

const FIXTURES = {
  'SWOT-like': {name: 'SWOT-like', n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0, drag: true, bterm: 0.044},
  'Sentinel-3-like': {name: 'Sentinel-3-like', n: 14.26, e: 0.0011, i: 98.65, raan: 40, argp: 90, ma: 0, drag: true, bterm: 0.001},
};
const NAMES = Object.keys(FIXTURES);
const COMMON = {hourly: true, gridMinutes: 2, fitPolicy: 'default'};
const input = {};
for (const name of NAMES) input[name] = await runModelTruth({...FIXTURES[name], ...COMMON, fitInput: true});
const call = input[NAMES[0]].configuration, weather = input[NAMES[0]].spaceWeather;

const h = await createStandaloneHarness('browser', wasmPath, {surface: 'command'});
/** One fit call: the call's $PCF, the object $PCFs (none or one per ephemeris), the weather and the ephemerides. */
const fit = async (config, objectPcfs, names) => {
  const r = await h.invoke({methodId: 'fit', inputs: [config, ...objectPcfs, weather, ...names.map((n) => input[n].ephemeris)]});
  assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
  const omms = r.outputs.filter((o) => o.portId === 'elements').map((o) => Buffer.from(o.payload));
  assert.equal(omms.length, names.length);
  return names.map((name, k) => ({name, omm: omms[k], obd: fittedOf(omms[k])}));
};
const day3 = async (name, omm) => (await runModelTruth({...FIXTURES[name], ...COMMON, omm})).wholeDay[3].e;
const number = (re, text) => { const m = re.exec(text ?? ''); return m ? Number(m[1]) : null; };
/** The posterior the record states (SPEC 12.8): BTERM (the median under LOG_NORMAL) and its sigma of the log, AGOM and its sigma. */
const posterior = (f) => ({bterm: f.bterm, sigmaLog: f.sigmaLog, agom: f.agom, agomSigma: f.agomSigma});
/** An object's $PCF: only FIT.DRAG_PRIOR (LOG_NORMAL) and, when given, FIT.SRP_PRIOR (GAUSSIAN_SIGNED). */
const objectPcf = (drag, srp) => configuration({fit: {
  DRAG_PRIOR: prior(drag.median, drag.sigmaLog), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL,
  ...(srp ? {SRP_PRIOR: prior(srp.value, srp.sigma), SRP_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED} : {}),
}});
const carried = (p) => [{median: p.bterm, sigmaLog: Math.max(p.sigmaLog, 0.3)}, {value: p.agom, sigma: Math.max(p.agomSigma, 0.01)}];
const report = {};

// 1. fit 1 on the band defaults, then fit 2 on each object's own posterior; each object as its single-object fit
const fit1 = await fit(call, [], NAMES);
const post = Object.fromEntries(fit1.map((f) => [f.name, posterior(f.obd)]));
const pcfs = Object.fromEntries(NAMES.map((n) => [n, objectPcf(...carried(post[n]))]));
const fit2 = await fit(call, NAMES.map((n) => pcfs[n]), NAMES);
for (const name of NAMES) {
  const k = NAMES.indexOf(name);
  const alone1 = (await fit(call, [], [name]))[0], alone2 = (await fit(call, [pcfs[name]], [name]))[0];
  report[name] = {posterior: post[name], fit1Day3: await day3(name, fit1[k].omm), fit2Day3: await day3(name, fit2[k].omm),
    fit2Posterior: posterior(fit2[k].obd), sameAsSingleObject: fit1[k].omm.equals(alone1.omm) && fit2[k].omm.equals(alone2.omm)};
}
// 2. 0.4.12's per-object path (each object's true BTERM, sigma of the log 0.3) in one call
const truth = await fit(call, NAMES.map((n) => objectPcf({median: FIXTURES[n].bterm, sigmaLog: 0.3})), NAMES);
for (const [k, name] of NAMES.entries()) report[name].trueBtermDay3 = await day3(name, truth[k].omm);
// 3. the shared prior: SWOT-like's carried BTERM prior for both objects in the call's one $PCF
const shared = (await runModelTruth({...FIXTURES[NAMES[0]], ...COMMON, fitInput: true,
  fitPolicy: {form: 'LOG_NORMAL', mean: carried(post[NAMES[0]])[0].median, sigma: carried(post[NAMES[0]])[0].sigmaLog}})).configuration;
const sharedFit = await fit(shared, [], NAMES);
for (const [k, name] of NAMES.entries()) report[name].sharedDay3 = await day3(name, sharedFit[k].omm);
await h.close?.();
for (const name of NAMES) console.log(JSON.stringify({object: name, trueBterm: FIXTURES[name].bterm, ...report[name]}));

for (const name of NAMES) {
  const r = report[name];
  assert.ok(r.sameAsSingleObject, `${name}: the two-object call gives the bytes of the single-object fit`);
  assert.ok(r.posterior.bterm > 0 && r.posterior.sigmaLog > 0 && r.posterior.agom !== null && r.posterior.agomSigma > 0, `${name}: fit 1's record states the posterior`);
  assert.ok(r.fit2Posterior.bterm > 0 && r.fit2Posterior.sigmaLog > 0, `${name}: fit 2's record states the posterior`);
}
// the day-3 error against the model truth: 21.33 m on 0.4.12 (and through 0.6.20), 17.31 m from 0.6.25, whose slow set
// (SPEC 16.18) carries the SWOT-like orbit's 14:1 family to degree 70
assert.ok(Math.abs(report['SWOT-like'].trueBtermDay3 - 17.31) <= 2, `SWOT-like per-object path: ${report['SWOT-like'].trueBtermDay3} m, the slow set's 17.31 m (0.4.12 21.33 m)`);
assert.ok(report['Sentinel-3-like'].sharedDay3 > report['Sentinel-3-like'].fit2Day3,
  `Sentinel-3-like: the shared prior ${report['Sentinel-3-like'].sharedDay3} m against its own ${report['Sentinel-3-like'].fit2Day3} m`);
console.log(JSON.stringify({sharedPriorCostOnSentinel3Like: report['Sentinel-3-like'].sharedDay3 - report['Sentinel-3-like'].fit2Day3}));
reproduceConformance();
console.log('fit per-object prior multi E2E: PASS');
