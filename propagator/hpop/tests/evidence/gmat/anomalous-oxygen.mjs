#!/usr/bin/env node
// Why HPOP and GMAT differ on the NRLMSISE-00 drag cases. GMAT's NRLMSISE-00
// plugin takes the total mass density of gtd7 (NRLMsise00Atmosphere::Density:
// gtd7_, d[5] without anomalous oxygen); HPOP, like Orekit, takes gtd7d's
// (lib/nrlmsise00.cpp: anomalous oxygen included, the drag-effective density
// of Picone et al. 2002). This script measures that difference along GMAT's
// own trajectory and shows it accounts for the drag cases' gap:
//
//   1. GMAT's geodetic latitude, longitude and height every 60 s
//      (run-gmat.mjs --geodetic 60);
//   2. at each, HPOP's NRLMSISE-00 diagnostic (PRW ATMOSPHERE_REQUEST) with
//      and without anomalous oxygen, with the case's drivers: eps = the
//      day's mean gtd7d density over the mean gtd7 density, minus one;
//   3. GMAT again with Cd * (1 + eps) (drag acceleration is linear in Cd*rho),
//      and HPOP (steps <= 30 s) against both GMAT runs.
//
//   node tests/evidence/gmat/anomalous-oxygen.mjs <GmatConsole> <work dir> [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from '../../lib/orekitCases.mjs';
import { decodeResult, encodePrw, instant, makeTable, TYPE } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [gmat, workArg, outArg] = process.argv.slice(2);
if (!workArg) throw new Error('usage: anomalous-oxygen.mjs <GmatConsole> <work dir> [out.json]');
const work = path.resolve(workArg);
const out = outArg ?? path.join(here, 'anomalous-oxygen.json');
const CASES = JSON.parse(fs.readFileSync(path.join(here, '../cases/hpop-reference-cases.json'), 'utf8'));
const IDS = ['LEO400 F6-field-sun-moon-srp-drag', 'LEO400 Z3-zonal20-sun-moon-srp-drag', 'LEO400 W1-field-sun-moon-srp-drag-cssi',
  'SSO700 F6-field-sun-moon-srp-drag', 'SSO700 Z3-zonal20-sun-moon-srp-drag', 'SSO700 W1-field-sun-moon-srp-drag-cssi'];
const BASE = { F6: 'F5-field-sun-moon-srp', Z3: 'Z2-zonal20-sun-moon-srp', W1: 'F5-field-sun-moon-srp' };
const wasm = fs.readFileSync(new URL('../../../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../../../plugin-manifest.json', import.meta.url), 'utf8'));
const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });

// The drivers HPOP reads on the case's day (run-gmat.mjs cssiConstants).
function drivers(c) {
  if (c.forces.drag.spaceWeather !== 'cssi') return { f107: CASES.spaceWeather.constant.f107, f107a: CASES.spaceWeather.constant.f107a, ap: CASES.spaceWeather.constant.ap };
  const day = (k) => new Date(Date.parse(`${c.epochUtc.slice(0, 10)}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
  const rows = CASES.spaceWeather.cssi.rows, today = rows.find((r) => r.DATE === day(0)), yesterday = rows.find((r) => r.DATE === day(-1));
  return { f107: yesterday.F107_OBS, f107a: today.F107_OBS_CENTER81, ap: today.AP_AVG };
}
async function density(jdUtc, latDeg, lonDeg, altKm, w, anomalous) {
  const payload = encodePrw('ATMOSPHERE_REQUEST', makeTable('PRWAtmosphereRequest', {
    EPOCH: instant(jdUtc, 'UTC'), ALTITUDE_M: altKm * 1000, LATITUDE_RAD: latDeg * Math.PI / 180,
    LONGITUDE_RAD: (((lonDeg + 540) % 360) - 180) * Math.PI / 180,
    F107: w.f107, F107_AVERAGE: w.f107a, AP_INDEX: w.ap, INCLUDE_ANOMALOUS_OXYGEN: anomalous,
  }));
  const response = await harness.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: TYPE, payload }] });
  if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
  return decodeResult(response).densityKgM3;
}
const runGmat = (id, outFile, extra) => execFileSync(process.execPath, [path.join(here, 'run-gmat.mjs'), gmat, path.join(work, 'anomalous-oxygen'), outFile, '--only', id, ...extra], { stdio: 'ignore' });
const worst = (a, b) => Math.max(...a.map((s, i) => Math.hypot(s[1] - b[i][1], s[2] - b[i][2], s[3] - b[i][3])));

const rows = [];
try {
  for (const id of IDS) {
    const c = CASES.cases.find((x) => x.id === id), w = drivers(c);
    const geoOut = path.join(work, 'anomalous-oxygen', 'geo.json');
    runGmat(id, geoOut, ['--geodetic', '60']);
    const geo = fs.readFileSync(path.join(work, 'anomalous-oxygen', `${id.replace(/\s+/g, '_')}.geo.txt`), 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    let sum7 = 0, sum7d = 0;
    for (const [mjd, lat, lon, alt] of geo) {
      const jd = mjd + 2430000.0;   // GMAT's UTC modified Julian date is JD - 2430000
      sum7 += await density(jd, lat, lon, alt, w, false);
      sum7d += await density(jd, lat, lon, alt, w, true);
    }
    const eps = sum7d / sum7 - 1;
    const plain = path.join(work, 'anomalous-oxygen', 'plain.json'), scaled = path.join(work, 'anomalous-oxygen', 'scaled.json');
    runGmat(id, plain, []);
    runGmat(id, scaled, ['--cd', String(CASES.constants.spacecraft.cd * (1 + eps))]);
    const ref = REFERENCE.cases.find((x) => `${x.orbit} ${x.forces}` === id);
    const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(ref, { maxStep: 30 }) });
    if (response.statusCode !== 0) throw new Error(`${id}: ${response.errorCode}`);
    const hpop = [ref.samples[0], ...decodeResult(response).samples.map((s, i) => [ref.samples[i + 1][0], ...s.position.map((v) => v * 1000)])];
    const base = REFERENCE.cases.find((x) => x.orbit === c.orbit && x.forces === BASE[c.forceSet.slice(0, 2)]);
    const dragEffectM = worst(ref.samples, base.samples);
    const row = {
      id, drivers: w, samples: geo.length, meanDensityGtd7KgM3: sum7 / geo.length, meanDensityGtd7dKgM3: sum7d / geo.length, eps,
      dragEffectM, epsTimesDragEffectM: eps * dragEffectM,
      hpopMinusGmatM: worst(hpop, JSON.parse(fs.readFileSync(plain, 'utf8')).cases[0].samples),
      hpopMinusGmatCdScaledM: worst(hpop, JSON.parse(fs.readFileSync(scaled, 'utf8')).cases[0].samples),
    };
    rows.push(row);
    console.error(`${id}: eps ${eps.toExponential(3)}, drag effect ${dragEffectM.toFixed(1)} m (x eps ${row.epsTimesDragEffectM.toFixed(3)} m); HPOP-GMAT ${row.hpopMinusGmatM.toFixed(3)} m, with Cd*(1+eps) ${row.hpopMinusGmatCdScaledM.toFixed(3)} m`);
  }
} finally { harness.destroy(); }

console.log('| Case | Anomalous-oxygen share of the mean density | Drag effect over the day | HPOP - GMAT | HPOP - GMAT with Cd x (1 + share) |');
console.log('|---|---:|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.id} | ${(r.eps * 100).toFixed(4)} % | ${r.dragEffectM < 1000 ? `${r.dragEffectM.toFixed(0)} m` : `${(r.dragEffectM / 1000).toFixed(1)} km`} | ${r.hpopMinusGmatM.toFixed(2)} m | ${r.hpopMinusGmatCdScaledM < 0.1 ? `${(r.hpopMinusGmatCdScaledM * 100).toFixed(1)} cm` : `${r.hpopMinusGmatCdScaledM.toFixed(2)} m`} |`);
fs.writeFileSync(out, `${JSON.stringify({
  about: 'NRLMSISE-00 total mass density with (gtd7d: HPOP, Orekit) and without (gtd7: GMAT R2026a) anomalous oxygen, along GMAT\'s trajectory every 60 s, from HPOP\'s PRW atmosphere diagnostic; and HPOP (steps <= 30 s) against GMAT with Cd and with Cd x (1 + eps). tests/evidence/gmat/anomalous-oxygen.mjs.',
  gmatSettings: 'run-gmat.mjs defaults (RK89 1e-14, steps <= 30 s); W1 with the drivers HPOP reads as constants',
  rows,
}, null, 1)}\n`);
