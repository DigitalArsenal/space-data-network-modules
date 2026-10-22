// Test-only source qualification. No production physics, SDS encoding, or publication.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'https://api.helioviewer.org/v2/';
const noaa = 'https://services.swpc.noaa.gov/';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = value => {
  const text = value.replace(' ', 'T');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/);
  const normalized = text.endsWith('Z') ? text : `${text}Z`;
  assert.ok(Number.isFinite(Date.parse(normalized)), `Invalid timestamp ${value}`);
  return normalized;
};
const api = (method, params) => `${base}${method}/?${new URLSearchParams(params)}`;

export function parseSrs(text) {
  const issued = /:Issued: (\d{4}) (\w{3}) (\d{2}) (\d{2})(\d{2}) UTC/.exec(text);
  assert.ok(issued, 'SRS issue epoch required');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months.indexOf(issued[2]);
  assert.ok(month >= 0, 'SRS issue month');
  const issuedAt = new Date(Date.UTC(+issued[1], month, +issued[3], +issued[4], +issued[5]));
  const valid = /I\.\s+Regions with Sunspots\.\s+Locations Valid at (\d{2})\/2400Z/.exec(text);
  assert.ok(valid, 'SRS must explicitly state the supported 24:00 position epoch');
  const observationDay = new Date(issuedAt);
  observationDay.setUTCDate(observationDay.getUTCDate() - 1);
  assert.equal(+valid[1], observationDay.getUTCDate(), 'SRS observation day must precede issue day');
  const sectionI = text.split(/I\.\s+Regions with Sunspots\./)[1]?.split(/IA\./)[0];
  const sectionIa = text.split(/IA\.\s+H-alpha Plages without Spots\./)[1]?.split(/II\./)[0];
  assert.ok(sectionI && sectionIa, 'Both SRS position sections required');
  const iaEpoch = /Locations Valid at (\d{2})\/2400Z/.exec(sectionIa);
  assert.equal(iaEpoch?.[1], valid[1], 'SRS sections must use the same epoch');
  const rows = [];
  for (const [section, body] of [['I', sectionI], ['IA', sectionIa]]) {
    for (const line of body.split('\n')) {
      if (!/^\d/.test(line.trim())) continue;
      const row = /^(\d+)\s+([NS]\d{2}[EW]\d{2,3})\s+(\d+)(?:\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+))?\s*$/.exec(line.trim());
      assert.ok(row, `Unrecognized SRS row: ${line}`);
      assert.ok(section !== 'I' || row[4], 'Sunspot row requires area and class');
      rows.push({section, region: +row[1], location: row[2], carringtonLongitude: +row[3],
        area: row[4] === undefined ? null : +row[4], spotClass: row[5] ?? null, magneticClass: row[8]?.trim() ?? null});
    }
    assert.ok(rows.some(r => r.section === section) || /\bNone\b/.test(body), `SRS ${section} must state rows or None`);
  }
  assert.equal(new Set(rows.map(r => r.region)).size, rows.length, 'Duplicate SRS region');
  return {issuedAt: issuedAt.toISOString(), observationDay: observationDay.toISOString().slice(0,10),
    positionEpoch: `${issuedAt.toISOString().slice(0,10)}T00:00:00.000Z`, rows};
}

export function compareRegions(srs, rows, day) {
  const selected = rows.filter(r => r.observed_date === day);
  assert.equal(new Set(selected.map(r => r.region)).size, selected.length, 'Duplicate NOAA region/day');
  const comparisons = srs.rows.map(expected => {
    const actual = selected.find(r => r.region === expected.region);
    return {region: expected.region, expected: {location: expected.location, carringtonLongitude: expected.carringtonLongitude},
      actual: actual ? {location: actual.location, carringtonLongitude: actual.carrington_longitude} : null,
      matches: actual?.location === expected.location && actual?.carrington_longitude === expected.carringtonLongitude};
  });
  return {jsonObservationDay: day, expected: srs.rows.length, available: selected.length,
    matches: comparisons.filter(r => r.matches).length, comparisons,
    extraRegions: selected.filter(r => !srs.rows.some(s => s.region === r.region)).map(r => r.region)};
}

export function fitsFields(xml) {
  assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'XML entity declarations are not accepted');
  const fits = /<fits>([\s\S]*?)<\/fits>/.exec(xml)?.[1];
  assert.ok(fits, 'JP2 must include FITS metadata');
  const names = ['DATE-OBS','DATE_OBS','CTYPE1','CTYPE2','CUNIT1','CUNIT2','CRPIX1','CRPIX2','CRVAL1','CRVAL2',
    'CDELT1','CDELT2','CROTA2','RSUN_OBS','CRLN_OBS','CRLT_OBS','DSUN_OBS','NAXIS1','NAXIS2','CADENCE','QUALITY','CONTENT'];
  const fields = Object.fromEntries(names.map(name => {
    const matches = [...fits.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
    assert.ok(matches.length <= 1, `Duplicate FITS keyword ${name}`);
    return [name, matches[0]?.[1]?.trim() ?? null];
  }));
  assert.ok(fields['DATE-OBS'] || fields.DATE_OBS, 'Observation time required');
  for (const key of ['CRPIX1','CRPIX2','CRVAL1','CRVAL2','CDELT1','CDELT2','RSUN_OBS','CRLN_OBS','CRLT_OBS','DSUN_OBS','NAXIS1','NAXIS2']) {
    assert.ok(fields[key] !== null && fields[key] !== '' && Number.isFinite(Number(fields[key])), `Missing/nonnumeric ${key}`);
  }
  return fields;
}

export function jp2Xml(bytes) {
  assert.equal(bytes.subarray(0,12).toString('hex'), '0000000c6a5020200d0a870a', 'JPEG2000 signature');
  let xml;
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated JP2 box header');
    let length = bytes.readUInt32BE(offset), header = 8;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length === 1) {
      assert.ok(offset + 16 <= bytes.length, 'Truncated extended JP2 box');
      const extended = bytes.readBigUInt64BE(offset + 8);
      assert.ok(extended <= BigInt(Number.MAX_SAFE_INTEGER));
      length = Number(extended); header = 16;
    } else if (length === 0) length = bytes.length - offset;
    assert.ok(length >= header && offset + length <= bytes.length, 'Invalid JP2 box length');
    if (type === 'xml ') {
      assert.equal(xml, undefined, 'Ambiguous multiple JP2 XML boxes');
      xml = bytes.toString('utf8', offset + header, offset + length);
    }
    offset += length;
  }
  assert.ok(xml, 'No JP2 XML box');
  return xml;
}

export async function captureEvidence() {
  const started = new Date();
  const day = started.toISOString().slice(0,10);
  // Fixed 15-minute acquisition target from the reference provider's plan.
  // This is an acquisition schedule, NOT a claim about instrument cadence.
  const target = new Date(Math.floor(started.getTime() / 900000) * 900000).toISOString();
  const evidenceRoot = path.join(root, 'tests/evidence');
  await fs.mkdir(evidenceRoot, {recursive:true});
  const dir = await fs.mkdtemp(path.join(evidenceRoot, `${day}-`));
  const provenance = [];
  async function get(source, filename, url, maxBytes = 2 * 1024 * 1024) {
    const destination = path.join(dir, source);
    await fs.mkdir(destination, {recursive:true});
    const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(45000)});
    assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= maxBytes, `${url}: response exceeds byte limit`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    await fs.writeFile(path.join(destination, filename), bytes);
    provenance.push({source, file:`${source}/${filename}`, url, retrievedAt:new Date().toISOString(), status:response.status,
      bytes:size, sha256:sha256(bytes), contentType:response.headers.get('content-type'), lastModified:response.headers.get('last-modified')});
    // Checkpoint every completed download; downloaded content is never executed.
    await fs.writeFile(path.join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    return bytes;
  }
  const regions = JSON.parse(await get('noaa-regions','solar_regions.json',`${noaa}json/solar_regions.json`));
  const flares = JSON.parse(await get('noaa-flares','xray-flares-7-day.json',`${noaa}json/goes/primary/xray-flares-7-day.json`));
  const events = JSON.parse(await get('noaa-events','edited_events.json',`${noaa}json/edited_events.json`));
  const srs = parseSrs((await get('noaa-srs','srs.txt',`${noaa}text/srs.txt`)).toString('utf8'));
  const catalog = JSON.parse(await get('helioviewer-catalog','sources.json',api('getDataSources',{})));
  const images = [];
  for (const [instrument, measurement] of [['HMI','continuum'],['AIA','171'],['AIA','193'],['AIA','304']]) {
    const source = `helioviewer-${instrument.toLowerCase()}-${measurement}`;
    const sourceId = catalog.SDO?.[instrument]?.[measurement]?.sourceId;
    assert.ok(Number.isInteger(sourceId), `Missing SDO ${instrument} ${measurement}`);
    const closest = JSON.parse(await get(source,'closest.json',api('getClosestImage',{date:target, sourceId})));
    const apiHeader = fitsFields((await get(source,'header.xml',api('getJP2Header',{id:closest.id}))).toString('utf8'));
    const jp2 = await get(source,'image.jp2',api('getJP2Image',{date:iso(closest.date), sourceId}), 16 * 1024 * 1024);
    const embedded = fitsFields(jp2Xml(jp2));
    assert.deepEqual(embedded, apiHeader, 'Downloaded image WCS must equal metadata for the selected image ID');
    const observedAt = iso(embedded['DATE-OBS'] || embedded.DATE_OBS);
    const metadataTimeDeltaMs = Math.abs(Date.parse(observedAt) - Date.parse(iso(closest.date)));
    assert.ok(metadataTimeDeltaMs < 1000, 'Image date must match DB time at its one-second precision');
    const offsetSeconds = (Date.parse(observedAt) - Date.parse(target)) / 1000;
    const sourceCadenceSeconds = embedded.CADENCE === null ? null : Number(embedded.CADENCE);
    if (sourceCadenceSeconds !== null) assert.ok(Number.isFinite(sourceCadenceSeconds) && sourceCadenceSeconds > 0);
    images.push({instrument, measurement, sourceId, imageId:closest.id, requestedAt:target, observedAt,
      currentDay:observedAt.slice(0,10) === day, offsetSeconds, sourceCadenceSeconds,
      withinSourceCadence:sourceCadenceSeconds === null ? null : Math.abs(offsetSeconds) <= sourceCadenceSeconds,
      withinAcquisitionInterval:Math.abs(offsetSeconds) <= 900, metadataTimeDeltaMs, bytes:jp2.length, sha256:sha256(jp2), fields:embedded});
    console.log(`${instrument} ${measurement}: ${observedAt}, offset ${offsetSeconds}s, ${jp2.length} bytes`);
  }
  const aligned = compareRegions(srs, regions, srs.observationDay);
  const summary = {status:'BLOCKED_SCHEMA', capturedAt:started.toISOString(), completedAt:new Date().toISOString(),
    evidenceDirectory:path.relative(root,dir), target, currentDay:day, srs,
    positions:{aligned, sameCalendarDate:compareRegions(srs,regions,day)},
    sourceCounts:{regions:regions.length, currentDayRegions:regions.filter(r => r.observed_date === day).length,
      flares:flares.length, currentDayFlares:flares.filter(r => r.begin_time?.startsWith(day)).length,
      flaresWithRegion:flares.filter(r => r.region != null).length,
      events:events.length, currentDayEvents:events.filter(r => r.begin_datetime?.startsWith(day)).length},
    images, publishedRecords:0, cidReadBacks:0,
    blockers:['SDS oracle has not ratified a typed solar record contract; production implementation stopped per owner instruction.',
      'Local-node publication and tri-runtime module verification have not run.']};
  await fs.writeFile(path.join(dir,'summary.json'), JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({status:summary.status,evidenceDirectory:summary.evidenceDirectory,
    positions:`${aligned.matches}/${aligned.expected}`,sourceCounts:summary.sourceCounts,
    imagesCurrentDay:images.filter(i => i.currentDay).length, imagesWithinAcquisitionInterval:images.filter(i => i.withinAcquisitionInterval).length},null,2));
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await captureEvidence();
