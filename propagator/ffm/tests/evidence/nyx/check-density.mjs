#!/usr/bin/env node
// NRLMSISE-00 total mass density, Nyx against FFM, at the same points: a grid
// of geodetic latitude, longitude, height and UTC time on the drag cases' day,
// with the constant drivers (F10.7 = F10.7a = 150, Ap 15). FFM's side is its
// PRW atmosphere diagnostic (ATMOSPHERE_REQUEST, anomalous oxygen included,
// mean local solar time); Nyx's is msise00_density with its default flags
// and mean local solar time (the runner's "density" mode). Isolates the
// density model from the propagation.
//
//   node tests/evidence/nyx/check-density.mjs <ffm-xval-nyx binary> [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { decodeResult, encodePrw, instant, makeTable, TYPE } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [bin, outArg] = process.argv.slice(2);
if (!bin) throw new Error('usage: check-density.mjs <ffm-xval-nyx binary> [out.json]');
const CASES = JSON.parse(fs.readFileSync(path.join(here, '../cases/ffm-reference-cases.json'), 'utf8'));
const W = CASES.spaceWeather.constant;
const wasm = fs.readFileSync(new URL('../../../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../../../plugin-manifest.json', import.meta.url), 'utf8'));

const points = [];
for (const hour of [0, 3, 6, 9, 12, 15, 18, 21, 23.5]) for (const altKm of [300, 400, 500, 700, 800]) for (const latDeg of [-75, -30, 0, 30, 75])
  for (const lonDeg of [-150, -60, 0, 60, 150]) {
    const ms = Date.parse('2026-08-02T00:00:00Z') + hour * 3600000;
    points.push({ utc: new Date(ms).toISOString().replace('Z', ''), jdUtc: ms / 86400000 + 2440587.5, latDeg, lonDeg, altKm, f107: W.f107, f107a: W.f107a, ap: W.ap });
  }
const nyx = JSON.parse(execFileSync(bin, { input: JSON.stringify({ mode: 'density', points }), encoding: 'utf8', maxBuffer: 64 << 20 })).density;
const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
const rows = [];
try {
  for (const [i, p] of points.entries()) {
    const payload = encodePrw('ATMOSPHERE_REQUEST', makeTable('PRWAtmosphereRequest', {
      EPOCH: instant(p.jdUtc, 'UTC'), ALTITUDE_M: p.altKm * 1000, LATITUDE_RAD: p.latDeg * Math.PI / 180, LONGITUDE_RAD: p.lonDeg * Math.PI / 180,
      F107: p.f107, F107_AVERAGE: p.f107a, AP_INDEX: p.ap, INCLUDE_ANOMALOUS_OXYGEN: true,
    }));
    const response = await harness.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: TYPE, payload }] });
    if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    const h = decodeResult(response), n = nyx[i];
    const species = Object.fromEntries(Object.entries(h.numberDensitiesCm3).map(([k, v]) => [k, v > 0 ? n[k] / v - 1 : n[k]]));
    rows.push({ ...p, ffm: h.densityKgM3, nyx: n.rho, rel: n.rho / h.densityKgM3 - 1, tExoK: [h.exosphericTemperatureK, n.tExo], tK: [h.temperatureK, n.tAlt], speciesRel: species });
  }
} finally { harness.destroy(); }
const byAlt = Object.fromEntries([300, 400, 500, 700, 800].map((h) => {
  const r = rows.filter((x) => x.altKm === h).map((x) => x.rel);
  return [h, { meanRel: r.reduce((s, v) => s + v, 0) / r.length, maxAbsRel: Math.max(...r.map(Math.abs)) }];
}));
const out = outArg ?? path.join(here, 'density.json');
fs.writeFileSync(out, `${JSON.stringify({
  about: 'NRLMSISE-00 total mass density (anomalous oxygen included), Nyx msise00_density against FFM\'s PRW atmosphere diagnostic at the same geodetic points and UTC times on 2026-08-02, F10.7 = F10.7a = 150, Ap 15 (check-density.mjs). rel = Nyx / FFM - 1.',
  points: rows.length, byAltitudeKm: byAlt, maxAbsRel: Math.max(...rows.map((x) => Math.abs(x.rel))),
  rows: rows.map(({ jdUtc, f107, f107a, ap, ...r }) => r),
}, null, 1).replace(/\{\n\s+("utc"[^{}]*?)\n\s+\}/g, (m, body) => `{${body.replace(/\n\s+/g, ' ')}}`)}\n`);
for (const [h, v] of Object.entries(byAlt)) console.log(`${h} km: mean ${(v.meanRel * 100).toFixed(4)} %, max |rel| ${(v.maxAbsRel * 100).toFixed(4)} %`);
