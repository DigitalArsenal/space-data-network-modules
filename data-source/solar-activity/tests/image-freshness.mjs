// Diagnose delivery latency independently of the schema/publication gate.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEvidenceStore} from './lib/evidence-store.mjs';
import {api, channels, cadenceAuthority, captureImage} from './lib/image-evidence.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const capturedAt = new Date().toISOString();
const currentTarget = new Date(Math.floor(Date.parse(capturedAt)/900000)*900000).toISOString();
// Diagnostic backfill at a fixed offset, chosen BEFORE seeing source images.
// This does not change the E2E's current acquisition target or claim freshness.
const backfillTarget = new Date(Date.parse(currentTarget)-3*3600000).toISOString();
const {dir,get} = await createEvidenceStore(path.join(root,'tests/evidence'),`${capturedAt.slice(0,10)}-freshness-`);
const catalog = JSON.parse(await get('helioviewer-catalog','sources.json',api('getDataSources')));
await get('helioviewer-guide','user-guide.html',cadenceAuthority);
await get('helioviewer-status','status.json',api('getStatus'));
const samples = [];
for (const [mode,target] of [['current',currentTarget],['backfill',backfillTarget]]) {
  for (const [instrument,measurement] of channels) {
    const image = await captureImage(get,{catalog,instrument,measurement,target,capturedAt,prefix:`${mode}-`});
    samples.push({mode,...image});
    console.log(`${mode} ${instrument} ${measurement}: ${image.observedAt}, offset ${image.offsetSeconds}s, cadence ${image.sourceCadenceSeconds}s`);
  }
}
// Read-only JSOC availability probe; no export job, registration, or TLS bypass.
const jsoc = [];
for (const [name,url] of [
  ['jsoc-home','https://jsoc.stanford.edu/'],
  ['jsoc-hmi','https://jsoc.stanford.edu/cgi-bin/ajax/jsoc_info?'+new URLSearchParams({op:'rs_list',ds:'hmi.Ic_45s_nrt[$]',key:'T_REC,DATE-OBS,CADENCE',n:'1'})],
]) {
  try { await get(name,'response.txt',url); jsoc.push({url,reached:true}); }
  catch (error) { jsoc.push({url,reached:false,error:error.message,errorCode:error.cause?.code ?? error.code ?? null}); }
}
const summary = {status:'SOURCE_QUALIFICATION_ONLY',capturedAt,completedAt:new Date().toISOString(),
  currentTarget,backfillTarget,backfillDelaySeconds:10800,samples,jsoc,
  runtimeVerification:{browser:'blocked on approved SDS contract',nativeWasmEdge:'blocked on approved SDS contract',
    docker:'waived by owner 2026-10-22; never started'},
  publishedRecords:0,cidReadBacks:0};
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({directory:path.relative(root,dir),currentWithinCadence:samples.filter(i=>i.mode==='current'&&i.withinSourceCadence).length,
  backfillWithinCadence:samples.filter(i=>i.mode==='backfill'&&i.withinSourceCadence).length,jsoc},null,2));
