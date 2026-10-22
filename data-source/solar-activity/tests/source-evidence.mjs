// Test-only source qualification. No production physics, SDS encoding, or publication.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSrs, compareRegions, fitsFields, jp2Xml, iso} from './lib/source-parsers.mjs';
export {parseSrs, compareRegions, fitsFields, jp2Xml} from './lib/source-parsers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'https://api.helioviewer.org/v2/';
const noaa = 'https://services.swpc.noaa.gov/';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const api = (method, params) => `${base}${method}/?${new URLSearchParams(params)}`;

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
