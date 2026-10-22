import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {iso, parseRegions, parseFlares, parseEvents, parseSrs, fitsFields} from './lib/source-parsers.mjs';

const fixture = new URL('./evidence/2026-10-22-ts940s/', import.meta.url);
const text = name => fs.readFile(new URL(name,fixture),'utf8');
const json = async name => JSON.parse(await text(name));

// Authority: original NOAA JSON captured 2026-10-22 (provenance.json).
// Source coordinates are heliographic integer degrees; NOAA longitude is kept
// in its own convention. Dates are UTC labels, not inferred instants. Tolerance
// is zero because these assertions transcribe values without physical conversion.
test('all region rows preserve nulls, morphology, and flagged source locations', async () => {
  const raw = await json('noaa-regions/solar_regions.json');
  const rows = parseRegions(raw);
  assert.equal(rows.length,222);
  const first = rows[0];
  assert.deepEqual([first.region,first.observed_date,first.location,first.latitude,first.longitude],
    [4556,'2026-10-22','N03W69',3,-69]);
  assert.equal(first.area,null); assert.equal(first.spot_class,null);
  const flagged = rows.find(r => r.region === 4558 && r.observed_date === '2026-10-19');
  assert.equal(flagged.location,'S08W0*'); assert.equal(flagged.positionComplete,false);
  assert.equal(flagged.longitude,-104);
  assert.throws(() => parseRegions([raw[0],raw[0]]),/Duplicate/);
  assert.throws(() => parseRegions([{...raw[0],latitude:NaN}]),/latitude/);
  assert.throws(() => parseRegions([{...raw[0],location:'N99E02'}]),/location/);
  assert.throws(() => parseRegions({error:'upstream error'}),/array/);
});

// Authority: GOES primary 7-day product; first event is 2026-10-15 UTC.
// Peak flux W/m^2 and integrated fluence J/m^2 in the GOES long X-ray channel;
// reference frame not applicable. Exact binary64 parse of independently copied
// decimal values: zero tolerance, no inference from a rounded class label.
test('GOES classes, interval, flux, and missing associations are retained', async () => {
  const raw = await json('noaa-flares/xray-flares-7-day.json');
  const rows = parseFlares(raw);
  assert.equal(rows.length,78);
  assert.deepEqual([rows[0].begin,rows[0].peak,rows[0].end],
    ['2026-10-15T17:32:00Z','2026-10-15T17:55:00Z','2026-10-15T18:03:00Z']);
  assert.equal(rows[0].goesClass,'C2.8');
  assert.equal(rows[0].peakFluxWm2,2.875177415262442e-6);
  assert.equal(rows[0].fluenceJm2,0.0039602299220860004);
  assert.equal(rows[0].satellite,18);
  assert.ok(rows.every(r => r.region === null));
  const incomplete = rows.find(r => r.begin === '2026-10-16T15:38:00Z');
  assert.equal(incomplete.peak,null); assert.equal(incomplete.goesClass,null);
  assert.equal(incomplete.peakFluxWm2,null); assert.equal(incomplete.fluenceJm2,null);
  assert.deepEqual(rows.map(r => r.raw),raw);
  assert.throws(() => parseFlares([{...raw[0],max_time:'2026-10-15T16:00:00Z'}]),/precedes/);
  assert.throws(() => parseFlares([{...raw[0],max_xrlong:-1}]),/flux/);
  assert.throws(() => parseFlares([{...raw[0],max_class:'SF'}]));
});

// Authority: NOAA edited events, captured 2026-10-22 UTC. UTC times and source
// qualifiers are transcribed exactly; region/bin/obsid are identifiers, not
// physical quantities. FLA location is heliographic, untouched. Zero tolerance.
test('edited events preserve observers, revisions, quality, and optical importance', async () => {
  const raw = await json('noaa-events/edited_events.json');
  const rows = parseEvents(raw);
  assert.equal(rows.length,700);
  const xra = rows[0];
  assert.deepEqual([xra.bin,xra.obsid,xra.observatory,xra.type,xra.goesClass,xra.region],
    [2820,0,'G19','XRA','B9.3',4560]);
  assert.deepEqual([xra.begin,xra.peak,xra.end],
    ['2026-10-22T08:04:00Z','2026-10-22T08:12:00Z','2026-10-22T08:22:00Z']);
  const optical = rows.find(r => r.type === 'FLA');
  assert.deepEqual([optical.bin,optical.observatory,optical.opticalImportance,optical.goesClass],
    [2810,'SVI','SF',null]);
  assert.equal(optical.beginQuality,' ');
  assert.equal(optical.raw.location,'N10W33');
  assert.equal(rows.filter(r => r.type === 'XRA').length,450);
  assert.equal(rows.filter(r => r.type === 'FLA').length,109);
  assert.equal(rows.filter(r => !['XRA','FLA'].includes(r.type)).length,141);
  assert.deepEqual(rows.map(r => r.raw),raw);
  assert.ok(rows.some(r => [r.beginQuality,r.peakQuality,r.endQuality].includes('U')));
  assert.equal(parseEvents([raw[0],raw[0]]).length,2,'Never merge records by bin or time proximity');
});

// Calendar boundary/invalid-input cases, not scientific golden outputs.
test('UTC parser rejects silent date rollover and unsupported time scales', () => {
  assert.equal(iso('2024-02-29 23:59:59.123456'),'2024-02-29T23:59:59.123456Z');
  for (const value of ['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-10-22T24:00:00Z',
    '2026-10-22T10:60:00Z','2026-10-22T10:00:60Z','2026.10.22_13:37:30_TAI','2026-10-22']) {
    assert.throws(() => iso(value),undefined,value);
  }
});

test('SRS carries all morphology and handles year rollover without guessing positions', async () => {
  const raw = await text('noaa-srs/srs.txt');
  const srs = parseSrs(raw);
  assert.deepEqual([srs.rows[0].area,srs.rows[0].spotClass,srs.rows[0].longitudinalExtent,srs.rows[0].spotCount,srs.rows[0].magneticClass],
    [340,'Eko',13,4,'Beta-Gamma']);
  assert.equal(srs.rows[3].spotCount,null);
  const rollover = parseSrs(raw.replace('2026 Oct 22','2027 Jan 01').replaceAll('21/2400Z','31/2400Z'));
  assert.equal(rollover.observationDay,'2026-12-31');
  assert.equal(rollover.positionEpoch,'2027-01-01T00:00:00.000Z');
  assert.throws(() => parseSrs(raw.replace('4551 S16W85','broken S16W85')),/Unrecognized/);
  assert.throws(() => parseSrs(raw.replace('4551 S16W85','None\n4551 S16W85')),/exclusively/);
});

test('WCS refuses ambiguous timestamps, missing units, orientation, and singular scales', async () => {
  const raw = await text('helioviewer-hmi-continuum/header.xml');
  assert.throws(() => fitsFields(raw.replace(/<DATE_OBS>.*?<\/DATE_OBS>/,'<DATE_OBS>2026-10-21T13:36:28.100</DATE_OBS>')),/Conflicting/);
  assert.throws(() => fitsFields(raw.replace('<CUNIT1>arcsec</CUNIT1>','')));
  assert.throws(() => fitsFields(raw.replace(/<CROTA2>.*?<\/CROTA2>/,'')),/orientation/);
  assert.throws(() => fitsFields(raw.replace(/<CDELT1>.*?<\/CDELT1>/,'<CDELT1>0</CDELT1>')),/Zero WCS scale/);
  assert.throws(() => fitsFields(raw.replace('</fits>','<PC1_1>1</PC1_1></fits>')),/Incomplete PC/);
  assert.throws(() => fitsFields(raw.replace('</fits>','<TIMESYS>TAI</TIMESYS></fits>')),/time scale/);
});
