#!/usr/bin/env node
// The environment frames the whole-catalog run reads (scripts/
// benchmark-catalog.mjs --environment): kernel.prw (the repository's DE440
// 2026 excerpt), earth_orientation.prw (IERS finals2000A rows, observed and
// Bulletin A predicted) and space_weather.prw (constant CSSI-layout rows:
// F10.7 = F10.7a = 150, every Ap 15, Kp 3o, the per-orbit benchmark's
// weather; synthetic, disclosed with every result). Also eop.json for Orekit.
//
//   node tests/evidence/engines/catalog-environment.mjs <out dir> <from YYYY-MM-DD> <to YYYY-MM-DD> [--finals <finals2000A.all>]
//
// Representation only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as flatbuffers from 'flatbuffers';
import { kernelRecord } from '../../../catalog.mjs';
import { encodePrw, makeTable, sds } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ffm = path.resolve(here, '../../..');
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  finals: { type: 'string', default: '/Users/tj/software/gmat09-authority/orekit-data/orekit-data-main/Earth-Orientation-Parameters/IAU-2000/finals2000A.all' },
} });
const [outArg, from, to] = positionals;
if (!to) throw new Error('usage: catalog-environment.mjs <out dir> <from YYYY-MM-DD> <to YYYY-MM-DD>');
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const mjd = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000 + 40587;

fs.writeFileSync(path.join(out, 'kernel.prw'), kernelRecord(fs.readFileSync(path.join(ffm, '../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp'))));

execFileSync(process.execPath, [path.join(ffm, 'tests/fixtures/orekit/make-eop.mjs'), o.finals, String(mjd(from)), String(mjd(to)), path.join(out, 'eop.json')], { stdio: 'inherit' });
const eop = JSON.parse(fs.readFileSync(path.join(out, 'eop.json'), 'utf8'));
const bytes = Buffer.from(eop.payloadBase64, 'base64'), rows = [];
for (let at = 0; at < bytes.length;) {
  const n = bytes.readUInt32LE(at);
  rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
  at += 4 + n;
}
fs.writeFileSync(path.join(out, 'earth_orientation.prw'), encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: rows })));

const days = [];
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
const spw = days.map((DATE, i) => makeTable('SPW', {
  DATE, BSRN: 2661 + i, ND: 1 + (i % 27), KP1: 30, KP2: 30, KP3: 30, KP4: 30, KP5: 30, KP6: 30, KP7: 30, KP8: 30, KP_SUM: 240,
  AP1: 15, AP2: 15, AP3: 15, AP4: 15, AP5: 15, AP6: 15, AP7: 15, AP8: 15, AP_AVG: 15, CP: 0.7, C9: 3, ISN: 100,
  F107_ADJ: 150, F107_DATA_TYPE: 0, F107_ADJ_CENTER81: 150, F107_ADJ_LAST81: 150, F107_OBS: 150, F107_OBS_CENTER81: 150, F107_OBS_LAST81: 150,
}));
fs.writeFileSync(path.join(out, 'space_weather.prw'), encodePrw('SPACE_WEATHER', makeTable('PRWSpaceWeatherTable', { ROWS: spw })));
console.log(`${out}: kernel.prw, earth_orientation.prw (${rows.length} rows), space_weather.prw (${spw.length} constant rows)`);
