// Independent frame gate using the existing SGP4 reference scorer. Private
// SupGP rows are read in RAM; only an aggregate REFERENCE_RMS is returned.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import {OMM} from 'spacedatastandards.org/lib/js/OMM/OMM.js';
import {OBD} from 'spacedatastandards.org/lib/js/OBD/OBD.js';
import {fil} from './operator-environment.mjs';
export async function referenceFrameGate(root,run){
 const publicDir=path.join(root,'tests/data/supgp-reference/starlink/meme');
 const name=fs.readdirSync(publicDir).sort().find(n=>n.startsWith('MEME_'));
 const id=Number(name.split('_')[1]);
 const csv=process.env.OD_REFERENCE_CSV||'/opt/data/sdn-archive/private-fixtures/space-data-network-modules/analysis/od/tests/data/supgp-reference/starlink/celestrak_supgp_2026-034.csv';
 const [header,...lines]=fs.readFileSync(csv,'utf8').trim().split(/\r?\n/).filter(l=>!l.startsWith('#'));
 const keys=header.split(','),rows=lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[keys[i],v]))).filter(r=>Number(r.NORAD_CAT_ID)===id);
 assert(rows.length,'The independently captured reference row must exist');
 const request={methodId:'fit',inputs:[fil(fs.readFileSync(path.join(publicDir,name)),name)]};
 const config={inputFormat:'meme',dataSource:'SpaceX-E',noradCatId:id};
 const fit=await run(request,config);assert.equal(fit.statusCode,0,fit.errorMessage);
 const omm=OMM.getSizePrefixedRootAsOMM(new fb.ByteBuffer(fit.outputs.find(o=>o.portId==='omm').payload));
 const epoch=Date.parse(omm.EPOCH()+'Z');
 const reference=rows.sort((a,b)=>Math.abs(Date.parse(a.EPOCH+'Z')-epoch)-Math.abs(Date.parse(b.EPOCH+'Z')-epoch))[0];
 const mapping={refEpoch:'EPOCH',refMeanMotion:'MEAN_MOTION',refEccentricity:'ECCENTRICITY',refInclination:'INCLINATION',refRaan:'RA_OF_ASC_NODE',refArgPericenter:'ARG_OF_PERICENTER',refMeanAnomaly:'MEAN_ANOMALY',refBstar:'BSTAR',refMeanMotionDot:'MEAN_MOTION_DOT',refMeanMotionDdot:'MEAN_MOTION_DDOT'};
 for(const [key,column]of Object.entries(mapping))config[key]=key==='refEpoch'?reference[column]:Number(reference[column]||0);
 const scored=await run(request,config);assert.equal(scored.statusCode,0,scored.errorMessage);
 const obd=scored.outputs.filter(o=>o.portId==='obd').map(o=>OBD.getSizePrefixedRootAsOBD(new fb.ByteBuffer(o.payload))).find(r=>r.METHOD_SOURCE()==='reference');
 assert(obd,'The existing reference scorer must emit its reference OBD');
 const rms=obd.WRMS();assert(Number.isFinite(rms)&&rms<=5,`REFERENCE_RMS ${rms} km exceeds the 5 km frame gate`);
 return {referenceRmsKm:rms,limitKm:5,source:'local captured SupGP; no raw row persisted'};
}
