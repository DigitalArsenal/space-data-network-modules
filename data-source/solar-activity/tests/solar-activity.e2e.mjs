// Live acceptance: today's SWPC/SDO sources become typed SDS records (SRO, SFE, SDI,
// SDS 1.262.0), are published to a real native SDN node and read back by CID.
// SDN_NODE_BINARY and SOLAR_NODE_WORK name the node binary and a durable lane directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {captureEvidence} from './source-evidence.mjs';
import {parseRegions, parseFlares, parseEvents, parseSrs} from './lib/source-parsers.mjs';
import {createLocalNode} from './lib/local-node.mjs';
import {sha256} from './lib/evidence-store.mjs';
import {regionRecord, flareRecord, eventRecord, imageRecord, encode, decode} from './lib/sds-records.mjs';

const home = process.env.HOME;
const binary = process.env.SDN_NODE_BINARY ?? `${home}/software/spacedatanetwork-stack/repos/main-packages/space-data-network/sdn-server/spacedatanetwork`;
const work = process.env.SOLAR_NODE_WORK ?? `${home}/software/terrain-work/body-look/solar-activity-data-sources-20261022`;
// Images are requested at a fixed 3-hour backfill slot: the providers' delivery latency exceeds
// their cadence at the current slot (recorded in REPORT.md), so cadence is judged at the slot.
const backfillSeconds = 3 * 3600;

const summary = await captureEvidence({backfillSeconds});
const dir = new URL(`../${summary.evidenceDirectory.replace(/^.*?tests\//,'tests/')}/`, import.meta.url);
const read = file => fs.readFile(new URL(file, dir));
const provenance = JSON.parse(await read('provenance.json'));
const retrievedAt = file => provenance.find(r => r.file === file && r.status === 200).retrievedAt;

const node = await createLocalNode(binary, work);
let pass = false;
try {
  await node.start();
  const add = async bytes => {
    const form = new FormData(); form.append('file', new Blob([bytes]), 'r');
    const r = await fetch(`${node.rpc}/api/v0/add?pin=true&cid-version=1`, {method:'POST', body:form, signal:AbortSignal.timeout(30000)});
    assert.equal(r.status, 200, 'node add');
    return JSON.parse((await r.text()).trim()).Hash;
  };
  const cat = async cid => {
    const r = await fetch(`${node.rpc}/api/v0/cat?arg=${encodeURIComponent(cid)}`, {method:'POST', signal:AbortSignal.timeout(30000)});
    assert.equal(r.status, 200, 'node cat');
    return Buffer.from(await r.arrayBuffer());
  };
  const source = async file => {
    const bytes = await read(file);
    return {cid:await add(bytes), sha256:sha256(bytes), retrievedAt:retrievedAt(file), bytes};
  };
  const stats = {SRO:0, SFE:0, SDI:0};
  const publish = async (record, standard, check) => {
    const cid = await add(encode(record, standard));
    const back = decode(await cat(cid), standard);
    check(back);
    stats[standard]++;
    return cid;
  };
  const same = (back, want, keys) => { for (const k of keys) assert.deepEqual(back[k], want[k], k); };

  // Regions: SRS positions are authoritative and must read back exactly.
  const srs = parseSrs((await read('noaa-srs/srs.txt')).toString('utf8'));
  assert.ok(srs.rows.length > 0, 'SRS lists regions');
  const srsSrc = await source('noaa-srs/srs.txt');
  const regionCids = [];
  for (const row of srs.rows) {
    const rec = regionRecord(row, srs, srsSrc);
    regionCids.push(await publish(rec, 'SRO', back => {
      same(back, rec, ['REGION_NUMBER','LOCATION_TOKEN','CARRINGTON_LONGITUDE_DEG','HG_LATITUDE_DEG','HG_LONGITUDE_DEG','AREA_MSH',
        'MCINTOSH_CLASS','MAGNETIC_CLASS','POSITION_EPOCH','SOURCE_CID']);
      assert.equal(back.LOCATION_TOKEN, row.location);
      assert.equal(back.SOURCE_CID, srsSrc.cid);
    }));
  }
  // Same-day JSON positions agree with the SRS for the SRS observation day.
  const regionsJson = parseRegions(JSON.parse(await read('noaa-regions/solar_regions.json')));
  let positionMatches = 0;
  for (const row of srs.rows) {
    const json = regionsJson.find(r => r.region === row.region && r.observed_date === srs.observationDay);
    if (json?.location === row.location && json.carrington_longitude === row.carringtonLongitude) positionMatches++;
  }
  assert.equal(positionMatches, srs.rows.length, 'SRO positions equal the same-day SWPC JSON positions');

  const flareSrc = await source('noaa-flares/xray-flares-7-day.json');
  const flares = parseFlares(JSON.parse(flareSrc.bytes.toString('utf8')));
  for (const f of flares) {
    const rec = flareRecord(f, flareSrc);
    await publish(rec, 'SFE', back => same(back, rec, ['EVENT_ID','BEGIN_TIME','PEAK_TIME','END_TIME','XRAY_CLASS','PEAK_FLUX_W_M2','HAS_REGION_NUMBER']));
  }
  const eventSrc = await source('noaa-events/edited_events.json');
  const events = parseEvents(JSON.parse(eventSrc.bytes.toString('utf8')));
  for (const e of events) {
    const rec = eventRecord(e, eventSrc);
    await publish(rec, 'SFE', back => same(back, rec, ['EVENT_ID','EVENT_TYPE_CODE','BEGIN_TIME','XRAY_CLASS','OPTICAL_IMPORTANCE','REGION_NUMBER']));
  }

  // Images: observation time within the source cadence of the requested slot.
  const imageCids = [];
  for (const img of summary.images) {
    const folder = `helioviewer-${img.instrument.toLowerCase()}-${img.measurement}`;
    const jp2 = await source(`${folder}/image.jp2`), header = await source(`${folder}/header.xml`);
    assert.equal(jp2.sha256, img.sha256, 'image bytes are the captured bytes');
    assert.equal(img.withinSourceCadence, true, `${folder} DATE-OBS within ${img.sourceCadenceSeconds}s of the slot (offset ${img.offsetSeconds}s)`);
    const rec = imageRecord(img, jp2, header.cid);
    imageCids.push(await publish(rec, 'SDI', back => {
      same(back, rec, ['OBSERVED_AT','REQUESTED_AT','IMAGE_CID','HEADER_CID','WIDTH','HEIGHT','CTYPE1','CRPIX1','CDELT1','RSUN_OBS_ARCSEC','IMAGE_SIZE_BYTES']);
      assert.equal(back.OBSERVED_AT, img.observedAt);
    }));
    assert.deepEqual(await cat(jp2.cid), jp2.bytes, 'JP2 read back by CID');
  }
  assert.equal(stats.SDI, 4);
  assert.ok(stats.SRO === srs.rows.length && stats.SFE === flares.length + events.length);
  const receipt = {status:'PASS', checkedAt:new Date().toISOString(), evidence:summary.evidenceDirectory, srsPositionMatches:`${positionMatches}/${srs.rows.length}`,
    typedRecordsPublishedAndReadBack:stats, sampleCids:{SRO:regionCids[0], SDI:imageCids}, imageOffsetsSeconds:summary.images.map(i => i.offsetSeconds)};
  await fs.writeFile(new URL('typed-records-receipt.json', dir), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  pass = true;
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error.message}`);
} finally {
  await node.stop();
}
process.exitCode = pass ? 0 : 1;
