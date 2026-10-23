// Test-only source qualification. No production physics, SDS encoding, or publication.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSrs, compareRegions, parseRegions, parseFlares, parseEvents} from './lib/source-parsers.mjs';
import {createEvidenceStore} from './lib/evidence-store.mjs';
import {api, channels, cadenceAuthority, captureImage} from './lib/image-evidence.mjs';
export {parseSrs, compareRegions, fitsFields, jp2Xml} from './lib/source-parsers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const noaa = 'https://services.swpc.noaa.gov/';
export {sha256} from './lib/evidence-store.mjs';

export async function captureEvidence({backfillSeconds = 0} = {}) {
  const started = new Date();
  const day = started.toISOString().slice(0,10);
  // Fixed 15-minute acquisition target from the reference provider's plan.
  // This is an acquisition schedule, NOT a claim about instrument cadence.
  const target = new Date(Math.floor((started.getTime() - backfillSeconds * 1000) / 900000) * 900000).toISOString();
  const {dir, get} = await createEvidenceStore(path.join(root,'tests/evidence'), `${day}-`);
  const regions = JSON.parse(await get('noaa-regions','solar_regions.json',`${noaa}json/solar_regions.json`));
  const flares = JSON.parse(await get('noaa-flares','xray-flares-7-day.json',`${noaa}json/goes/primary/xray-flares-7-day.json`));
  const events = JSON.parse(await get('noaa-events','edited_events.json',`${noaa}json/edited_events.json`));
  const srs = parseSrs((await get('noaa-srs','srs.txt',`${noaa}text/srs.txt`)).toString('utf8'));
  const catalog = JSON.parse(await get('helioviewer-catalog','sources.json',api('getDataSources',{})));
  parseRegions(regions); parseFlares(flares); parseEvents(events);
  await get('helioviewer-guide','user-guide.html',cadenceAuthority);
  const images = [];
  for (const [instrument, measurement] of channels) {
    const image = await captureImage(get,{catalog,instrument,measurement,target,capturedAt:started.toISOString()});
    images.push(image);
    console.log(`${instrument} ${measurement}: ${image.observedAt}, offset ${image.offsetSeconds}s, ${image.bytes} bytes`);
  }
  const aligned = compareRegions(srs, regions, srs.observationDay);
  const summary = {status:'CAPTURED', capturedAt:started.toISOString(), completedAt:new Date().toISOString(),
    evidenceDirectory:path.relative(root,dir), target, currentDay:day, srs,
    positions:{aligned, sameCalendarDate:compareRegions(srs,regions,day)},
    sourceCounts:{regions:regions.length, currentDayRegions:regions.filter(r => r.observed_date === day).length,
      flares:flares.length, currentDayFlares:flares.filter(r => r.begin_time?.startsWith(day)).length,
      flaresWithRegion:flares.filter(r => r.region != null).length,
      events:events.length, currentDayEvents:events.filter(r => r.begin_datetime?.startsWith(day)).length},
    images, publishedRecords:0, cidReadBacks:0,
    blockers:[]};
  await fs.writeFile(path.join(dir,'summary.json'), JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({status:summary.status,evidenceDirectory:summary.evidenceDirectory,
    positions:`${aligned.matches}/${aligned.expected}`,sourceCounts:summary.sourceCounts,
    imagesCurrentDay:images.filter(i => i.currentDay).length, imagesWithinAcquisitionInterval:images.filter(i => i.withinAcquisitionInterval).length},null,2));
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await captureEvidence();
