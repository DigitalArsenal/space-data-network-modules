#!/usr/bin/env node
// E2E (stack #489, SPEC 12.1): on an arc of 71 h or more the record's covariance is the curvature of the cost the fit
// minimized. That cost is the fit's residuals over the data sigma it weighed them at (the record's OD_DATA_WEIGHTING), plus
// each prior at its written sigma. Through 0.6.20 the fit weighed the data at 1 km under the drag and stated the covariance
// of the same residuals at their post-fit scatter. A prior then acted in the estimate about 100 times more strongly than
// the covariance said (#481's AGOM, #482's BTERM).
// The check: the profile of the cost in one parameter, against the record's variance of it. The parameter is held at the
// solution and at the solution +- 3 of its formal sigmas by a pinned prior (sigma 1e-9) while the fit settles the others.
// Each solution is flown over the arc, and its cost is computed with the record's own data sigma and the default priors.
// For a quadratic cost the second difference over that step is 2 / variance; asserted: the ratio of that variance to the
// record's formal variance is between 0.98 and 1.02. Measured 2026-11-11: 1.00006 (BTERM) and 0.99984 (AGOM). On the
// build before (the data at 1 km under the drag) the AGOM case's ratio is 332, and the BTERM case states no width.
// Two cases, on test/lib/heo-model-truth.mjs truths (FFM, named below by its SHA-256; EGM96 70 x 70, DE440 Sun and Moon,
// zero EOP, RK78 1e-12, 30-minute states over a 72 h arc):
// - a term the arc settles: BTERM, 800 km at i 50, NRLMSISE-00 drag with a true BTERM of 0.02, no SRP; the fit takes the
//   default of a 71 h arc (SPEC 12.8). The record states BTERM's width by its rule (SPEC 12.8's width 1), so the formal
//   variance is read back through the entry's figures, as the module's reader does.
// - a term a prior holds at 1 km: AGOM, on the orbit of test/radiation-sphere-agom.e2e.mjs (14.2165 rev/day, e 0.0012, i 98.6): a sphere with
//   AGOM 0.01 m^2/kg (Cr 1, 10 m^2, 1,000 kg) and the truth's conical shadow, no drag; the fit holds BTERM at 0 and takes
//   AGOM's default prior (0 +- 0.05). At 1 km that prior halves AGOM; at the data's sigma it is weak.
//   node test/fit-cost-curvature.e2e.mjs
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfAtmosphereFamily} from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import {pcfWeatherSource} from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {prwDynamicParameter} from 'spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js';
import {requireTruth} from './lib/ffm-truth.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {wasmPath} from './lib/module.mjs';
import {configuration,prior,pcfPriorForm} from './lib/pcf.mjs';
import {ocmOf,flight,T} from './lib/ocm.mjs';
const FFM_SHA256 = 'ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
requireTruth(FFM_SHA256);
const KE = 0.074366859954178854, RE = 6378.1363;
const nOf = (h) => KE * Math.pow(RE / (RE + h), 1.5) * 1440 / (2 * Math.PI);
const LO = 0.98, HI = 1.02, STEP = 3;
const LN10 = Math.LN10, FREE = {median: 0.008, sigma: 10 * LN10}, AGOM_PRIOR = 0.05;
const h = await createStandaloneHarness('browser', wasmPath, {surface: 'command'});
const call = async (methodId, inputs) => { const r = await h.invoke({methodId, inputs}); assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`); return r.outputs; };
const forcesOf = (drag) => ({EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: drag ? pcfAtmosphereFamily.NRLMSISE00 : pcfAtmosphereFamily.JACCHIA70, WEATHER_SOURCE: pcfWeatherSource.RECORDS});
const fitOf = async (input, drag, fit) => {
  const out = await call('fit', [configuration({forces: forcesOf(drag), ...(fit ? {fit} : {})}), input.spaceWeather, input.ephemeris]);
  return new Uint8Array(out.find((v) => v.portId === 'elements').payload);
};
// the arc's states (GCRF) and a set's sum of squared position residuals over them (km^2)
const arcOf = (input) => OEM.getRootAsOEM(new fb.ByteBuffer(input.ephemeris.payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const ssOf = async (set, lines) => {
  const out = await call('propagate', flight([set], {output: {EPOCHS: lines.map((L) => L.EPOCH), FRAME: pcfOutputFrame.GCRF}}));
  const flown = OEM.getRootAsOEM(new fb.ByteBuffer(out.find((v) => v.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  assert.equal(flown.length, lines.length);
  return flown.reduce((s, f, k) => s + (f.X - lines[k].X) ** 2 + (f.Y - lines[k].Y) ** 2 + (f.Z - lines[k].Z) ** 2, 0);
};
const sigmaOf = (o) => { const m = /SIGMA ([0-9.eE+-]+) KM/.exec(o.ORBIT_DETERMINATION?.OD_DATA_WEIGHTING ?? ''); return m ? Number(m[1]) : NaN; };
const variance = (o, kind) => { const kinds = o.COV_PARAMETER_KINDS ?? [], at = 6 + kinds.indexOf(kind); return kinds.includes(kind) ? o.COVARIANCE_DATA[(at * (at + 1)) / 2 + at] : NaN; };
const failures = [];
const report = (name, x) => {
  console.log(JSON.stringify({name, ...x, bounds: [LO, HI]}));
  if (!(x.ratio >= LO && x.ratio <= HI)) failures.push(`${name}: the cost's profile states variance ${x.profileVariance.toPrecision(4)} against the record's ${x.recordVariance.toPrecision(4)} (ratio ${x.ratio.toFixed(3)}; data sigma ${x.dataSigmaKm} km)`);
};

// a term the arc settles: BTERM at 800 km under the default of a 71 h arc
{
  const input = await runModelTruth({name: 'curvature, BTERM', n: nOf(800), e: 0.001, i: 50, raan: 77, argp: 90, ma: 0, drag: true, bterm: 0.02, fitPolicy: 'default', fitDays: 3, fitInput: true});
  const lines = arcOf(input), set = await fitOf(input, true, null), o = ocmOf(set), s = sigmaOf(o), B = o.MEAN_ELEMENTS.BTERM;
  // the formal sigma of ln B through width 1's figures (SPEC 12.8), as the module's reader recovers it
  const id = (o.COV_REALISM ?? []).map((c) => c.MODEL_ID).find((t) => t?.startsWith('sdn-ap drag-term width 1:'));
  assert.ok(id, 'the 71 h default states BTERM by width 1');
  const [, m, sp, cap] = /m ([0-9.eE+-]+), prior sigma ([0-9.eE+-]+), cap ([0-9.eE+-]+)/.exec(id).map(Number);
  const capped = /formal sigma of ln ([0-9.eE+-]+)/.exec(id);
  const sh2 = variance(o, prwDynamicParameter.DRAG_AREA_OVER_MASS) / (B * B);
  const varF = capped ? Number(capped[1]) ** 2 : 1 / (m * m * (1 / sh2 - 1 / (sp * sp)) + 1 / (sp * sp));
  const d = STEP * Math.sqrt(varF), agomPrior = (a) => (a / AGOM_PRIOR) ** 2;
  const cost = async (dl) => {
    const pinned = await fitOf(input, true, {DRAG_PRIOR: prior(B * Math.exp(dl), 1e-9), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL});
    const p = ocmOf(pinned);
    return (await ssOf(pinned, lines)) / (s * s) + ((Math.log(p.MEAN_ELEMENTS.BTERM) - Math.log(FREE.median)) / FREE.sigma) ** 2 + agomPrior(p.MEAN_ELEMENTS.AGOM);
  };
  const c0 = await cost(0), cp = await cost(d), cm = await cost(-d);
  const prof = 2 * d * d / (cp - 2 * c0 + cm);
  report('BTERM, 800 km, 72 h, the 71 h default', {dataSigmaKm: s, bterm: B, statedSigmaLnB: Math.sqrt(sh2), widthEntry: id, recordVariance: varF, profileVariance: prof, ratio: prof / varF});
}

// a term a prior holds at 1 km: AGOM on the 800 km sphere of test/radiation-sphere-agom.e2e.mjs
{
  const input = await runModelTruth({name: 'curvature, AGOM', n: 14.2165, e: 0.0012, i: 98.6, raan: 326.70, argp: 90, ma: 0, drag: false, bterm: 0.022,
    ffmForces: {srp: true, cr: 1.0}, fitPolicy: {mean: 0, sigma: 1e-9, form: 'GAUSSIAN_SIGNED'}, fitDays: 3, fitInput: true});
  const hold = {DRAG_PRIOR: prior(0, 1e-9), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED};
  const lines = arcOf(input), set = await fitOf(input, false, hold), o = ocmOf(set), s = sigmaOf(o), A = o.MEAN_ELEMENTS.AGOM;
  const varA = variance(o, prwDynamicParameter.SRP_AREA_OVER_MASS), d = STEP * Math.sqrt(varA);
  const cost = async (da) => {
    const pinned = await fitOf(input, false, {...hold, SRP_PRIOR: prior(A + da, 1e-9), SRP_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED});
    return (await ssOf(pinned, lines)) / (s * s) + (ocmOf(pinned).MEAN_ELEMENTS.AGOM / AGOM_PRIOR) ** 2;
  };
  const c0 = await cost(0), cp = await cost(d), cm = await cost(-d);
  const prof = 2 * d * d / (cp - 2 * c0 + cm);
  report('AGOM, case 7 sphere, 72 h, AGOM default prior', {dataSigmaKm: s, agom: A, recordVariance: varA, profileVariance: prof, ratio: prof / varA});
}
await h.close?.();
if (failures.length) {
  console.error(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('fit cost curvature E2E: PASS');
process.exit(0);
