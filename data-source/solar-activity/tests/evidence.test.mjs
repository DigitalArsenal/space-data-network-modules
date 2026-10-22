import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseSrs, compareRegions, fitsFields, jp2Xml, sha256} from './source-evidence.mjs';

const fixture = new URL('./evidence/2026-10-22-ts940s/', import.meta.url);
const bytes = name => fs.readFile(new URL(name, fixture));
const text = async name => (await bytes(name)).toString('utf8');

// Authority: NOAA's original 2026-10-22 00:30 UTC SRS, saved verbatim.
// Location: heliographic latitude / central-meridian distance in integer degrees;
// Lo: Carrington longitude in degrees. Position epoch: 2026-10-21 24:00 UTC.
// Area: corrected millionths of the solar hemisphere (SWPC User Guide).
// Zero tolerance: exact source transcription, with no propagation/interpolation.
test('seven independently transcribed SRS positions agree exactly at the explicit observation epoch', async () => {
  const srs = parseSrs(await text('noaa-srs/srs.txt'));
  assert.equal(srs.issuedAt, '2026-10-22T00:30:00.000Z');
  assert.equal(srs.observationDay, '2026-10-21');
  assert.equal(srs.positionEpoch, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(srs.rows.map(r => [r.region,r.location,r.carringtonLongitude]), [
    [4551,'S16W85',102], [4557,'N07W55',72], [4560,'N13W28',45],
    [4553,'N06W82',99], [4554,'N07W68',85], [4556,'N03W55',72], [4559,'S20W78',95],
  ]);
  const regions = JSON.parse(await text('noaa-regions/solar_regions.json'));
  const aligned = compareRegions(srs,regions,srs.observationDay);
  assert.equal(aligned.matches, 7);
  assert.deepEqual(aligned.extraRegions, []);
  assert.equal(compareRegions(srs,regions,'2026-10-22').matches, 0,
    'Same calendar date is not the same observation epoch');
  assert.equal(srs.rows.find(r => r.region === 4560).area,130);
  assert.equal(regions.find(r => r.region === 4560 && r.observed_date === '2026-10-21').area,150,
    'Preserve source disagreement; do not claim JSON morphology equals the SRS');
});

test('missing and duplicate source rows cannot be counted as exact matches', async () => {
  const srs = parseSrs(await text('noaa-srs/srs.txt'));
  assert.equal(compareRegions(srs,[],srs.observationDay).matches,0);
  const row = {region:4551,observed_date:srs.observationDay,location:'S16W85',carrington_longitude:102};
  assert.throws(() => compareRegions(srs,[row,row],srs.observationDay), /Duplicate/);
  assert.throws(() => parseSrs('malformed source'), /issue epoch/);
});

test('all retained public source bytes match their capture hashes and HTTP receipts', async () => {
  for (const [capture,count] of [['2026-10-22-ts940s',17],['2026-10-22-AfCFXB',18]]) {
    const root = new URL(`./evidence/${capture}/`,import.meta.url);
    const provenance = JSON.parse(await fs.readFile(new URL('provenance.json',root)));
    assert.equal(provenance.length,count);
    for (const item of provenance) {
      const data = await fs.readFile(new URL(item.file,root));
      assert.equal(data.length,item.bytes,item.file);
      assert.equal(sha256(data),item.sha256,item.file);
      assert.equal(item.status,200);
      assert.match(item.url,/^https:\/\/(services\.swpc\.noaa\.gov|api\.helioviewer\.org|helioviewer-project\.github\.io)\//);
    }
  }
});

// Authority: HMI's embedded FITS header in the captured JP2, not module output.
// Helioprojective TAN; reference pixels are FITS one-based; scale arcsec/pixel;
// apparent radius arcsec; Carrington observer longitude / latitude degrees.
// DATE-OBS is preserved as supplied; T_OBS/T_REC have explicit TAI labels and
// are never substituted. Zero numeric tolerance: no geometry is calculated.
test('original HMI WCS and cadence retain the published values', async () => {
  const fields = fitsFields(jp2Xml(await bytes('helioviewer-hmi-continuum/image.jp2')));
  assert.equal(fields['DATE-OBS'],'2026-10-22T13:36:28.100');
  assert.equal(fields.CTYPE1,'HPLN-TAN');
  assert.equal(fields.CTYPE2,'HPLT-TAN');
  assert.equal(fields.CUNIT1,'arcsec');
  assert.equal(fields.CUNIT2,'arcsec');
  for (const [key,value] of Object.entries({CRPIX1:2048.5,CRPIX2:2048.5,CDELT1:0.60000002,CDELT2:0.60000002,
    RSUN_OBS:964.29584,CRLN_OBS:9.8589335,CRLT_OBS:5.2907505,DSUN_OBS:148876330000,CADENCE:45})) {
    assert.equal(Number(fields[key]),value,key);
  }
});

test('each full-disk JP2 is bound to its API header without inventing absent cadence', async () => {
  for (const source of ['hmi-continuum','aia-171','aia-193','aia-304']) {
    const fields = fitsFields(jp2Xml(await bytes(`helioviewer-${source}/image.jp2`)));
    assert.deepEqual(fields,fitsFields(await text(`helioviewer-${source}/header.xml`)));
    assert.equal(Number(fields.NAXIS1),4096);
    assert.equal(Number(fields.NAXIS2),4096);
    if (source.startsWith('aia')) assert.equal(fields.CADENCE,null);
  }
  const summary = JSON.parse(await text('summary.json'));
  assert.equal(summary.images.filter(i => i.currentDay).length,4);
  assert.equal(summary.images.filter(i => i.withinAcquisitionInterval).length,0);
  assert.equal(summary.publishedRecords,0);
  assert.equal(summary.cidReadBacks,0);
});

test('truncated JP2 and unsafe XML fail before metadata is used', async () => {
  const image = await bytes('helioviewer-hmi-continuum/image.jp2');
  assert.throws(() => jp2Xml(image.subarray(0,20)),/JP2/);
  assert.throws(() => fitsFields('<!DOCTYPE meta><meta/>'),/entity declarations/);
  assert.throws(() => fitsFields('<meta><fits/></meta>'),/FITS/);
});
