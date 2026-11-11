#!/usr/bin/env node
// E2E (stack #477, SPEC 16.18, the low table's part): the record states the slow set exactly when the fitted set carries a term
// of it, and every flight reads it from the record.
// Fixtures: AP's own flight of a seeded set (FORCES 31,20, Jacchia 1970 on the fixture rows, epoch 2026-10-29 00:00 UTC), its
// states every 300 s over 72 h fitted with the same forces: a SWOT-like set (891 km, 14:1, BTERM 0.001) and a LAGEOS-like one
// (6.39 rev/day, BTERM 0.0005), whose largest slow term is 0.089 m, under the 0.5 m cut.
// Asserted:
// - the SWOT-like record states PERTURBATIONS.GRAVITY_MODEL "EGM-96; slow tesseral terms to degree 70", the LAGEOS-like one
//   "EGM-96" (its record is the one a build without the slow set writes);
// - the LAGEOS-like record with the slow text written in flies bit for bit as without it over 7 days (every 30 min): an empty
//   slow set changes no state;
// - the SWOT-like record with the text taken out flies differently (the slow set's terms act): at least 1 m apart within 7 days;
// - the slow text on an SGP4XP set is refused (elements-other-theory).
//   node test/slow-set-record.e2e.mjs
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM, OEMT } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { pcfAtmosphereFamily } from 'spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js';
import { pcfWeatherSource } from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import { wasmPath } from './lib/module.mjs';
import { packOem } from './lib/frames.mjs';
import { configuration } from './lib/pcf.mjs';
import { seedOcm, flight, rowsThrough, spwStream, repackOcm, ocmOf, T } from './lib/ocm.mjs';
import { spwFixtureRows } from './lib/spw-constant.mjs';

const SLOW = 'EGM-96; slow tesseral terms to degree 70';
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const fixture = spwFixtureRows();
const rows = rowsThrough(Array.isArray(fixture) ? fixture : fixture.rows);
const h = await createStandaloneHarness('browser', wasmPath, { surface: 'command' });
const call = async (methodId, inputs) => {
  const r = await h.invoke({ methodId, inputs });
  return r;
};
const ok = async (methodId, inputs) => {
  const r = await call(methodId, inputs);
  assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`);
  return r.outputs;
};
const fly = async (set, secs) => {
  const out = await ok('propagate', flight([set], { output: { EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF } }));
  return OEM.getRootAsOEM(new fb.ByteBuffer(out.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
};
const forces = { EPHEMERIS_SOURCE: '', HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, WEATHER_SOURCE: pcfWeatherSource.RECORDS };
/** The record of a 72 h fit to AP's own flight of the seeded set (no slow set in the seed's flight). */
async function fitted(o) {
  const seed = seedOcm({ epoch, ...o, norad: 99478, records: true, rows, tesseral: 31, zonal: 20 });
  const grid = Array.from({ length: 72 * 12 + 1 }, (_, k) => k * 300);
  const out = await ok('propagate', flight([seed], { output: { EPOCHS: grid.map(iso), FRAME: pcfOutputFrame.GCRF } }));
  const t = OEM.getRootAsOEM(new fb.ByteBuffer(out.find((v) => v.portId === 'ephemeris').payload)).unpack();
  const b = t.EPHEMERIS_DATA_BLOCK[0];
  b.USEABLE_START_TIME = b.START_TIME;
  b.USEABLE_STOP_TIME = b.STOP_TIME;
  const fitOut = await ok('fit', [configuration({ forces }), { portId: 'space_weather', typeRef: T('SPW'), payload: spwStream(rows) },
    { portId: 'ephemeris', typeRef: T('OEM'), payload: packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [b] })) }]);
  return fitOut.find((v) => v.portId === 'elements').payload;
}
const week = Array.from({ length: 7 * 48 + 1 }, (_, k) => 72 * 3600 + k * 1800);
const gap = (a, b) => Math.max(...a.map((p, k) => Math.hypot(p.X - b[k].X, p.Y - b[k].Y, p.Z - b[k].Z) * 1000));
const same = (a, b) => a.every((p, k) => ['X', 'Y', 'Z', 'X_DOT', 'Y_DOT', 'Z_DOT'].every((f) => Object.is(p[f], b[k][f])));

const swot = await fitted({ n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0, bterm: 0.001 });
const lageos = await fitted({ n: 6.39, e: 0.0045, i: 109.8, raan: 50, argp: 90, ma: 0, bterm: 0.0005 });
const gm = (bytes) => ocmOf(bytes).PERTURBATIONS.GRAVITY_MODEL;
assert.equal(gm(swot), SLOW, `the SWOT-like record states the slow set (${gm(swot)})`);
assert.equal(gm(lageos), 'EGM-96', `the LAGEOS-like record states no slow set (${gm(lageos)})`);

const lageosMarked = repackOcm(lageos, (t) => { t.PERTURBATIONS.GRAVITY_MODEL = SLOW; });
const la = await fly(lageos, week), lb = await fly(lageosMarked, week);
assert.ok(same(la, lb), `LAGEOS-like: the slow text changes no state (largest gap ${gap(la, lb).toExponential(3)} m)`);

const swotPlain = repackOcm(swot, (t) => { t.PERTURBATIONS.GRAVITY_MODEL = 'EGM-96'; });
const sa = await fly(swot, week), sb = await fly(swotPlain, week);
const swotGap = gap(sa, sb);
assert.ok(swotGap >= 1, `SWOT-like: the record's slow set acts in its flight (${swotGap.toFixed(3)} m apart within 7 days; at least 1 m)`);

const xp = seedOcm({ epoch, n: 13.905, e: 0.0001, i: 77.6, raan: 200, argp: 90, ma: 0, bterm: 0.001, norad: 99478 });
const xpMarked = repackOcm(xp, (t) => { t.PERTURBATIONS.GRAVITY_MODEL = SLOW; });
const refused = await call('propagate', flight([xpMarked], { output: { EPOCHS: [iso(3600)], FRAME: pcfOutputFrame.GCRF } }));
assert.notEqual(refused.statusCode, 0, 'the slow text on an SGP4XP set is refused');
assert.equal(refused.errorCode, 'elements-other-theory', `refused by name (${refused.errorCode}: ${refused.errorMessage})`);
await h.close?.();
console.log(JSON.stringify({ swotGravityModel: gm(swot), lageosGravityModel: gm(lageos), swotSlowSetGapM: +swotGap.toFixed(3), lageosBitIdentical: true }));
console.log('slow-set record E2E: PASS');
process.exit(0);
