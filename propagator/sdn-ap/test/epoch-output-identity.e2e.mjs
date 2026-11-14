// Binary method compatibility against the committed 0.6.60 artifact. Made-up
// records, UTC and TEME/GCRF/EME2000, km and km/s; tolerance is byte equality.
// The polynomial is a codec fixture, not an orbit-accuracy reference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {PPEPositionRecordT} from 'spacedatastandards.org/lib/js/OCM/PPEPositionRecord.js';
import {OCMTrajectoryBlockT} from 'spacedatastandards.org/lib/js/OCM/OCMTrajectoryBlock.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import * as fb from 'flatbuffers';
import {wasmPath,packageRoot,ensureBuilt} from './lib/module.mjs';
import {scratchTemp} from './lib/scratch.mjs';
import {seedOcm,repackOcm,rowsThrough,flight} from './lib/ocm.mjs';
import {spwConstantText} from './lib/spw-constant.mjs';
ensureBuilt();
const baseFile=path.join(scratchTemp('epoch-output-identity-'),'base.wasm');
fs.writeFileSync(baseFile,execFileSync('git',['show','6eeff4b6:propagator/sdn-ap/dist/isomorphic/module.wasm'],{cwd:path.resolve(packageRoot,'../..'),maxBuffer:1<<26}));
const epoch='2026-10-29T00:00:00.000',start=Date.parse(epoch+'Z'),iso=s=>new Date(start+s*1000).toISOString().slice(0,-1);
const rows=rowsThrough(JSON.parse(spwConstantText()));
const seed=(norad,extra={})=>seedOcm({epoch,n:14.8,e:.001,i:55,raan:40,argp:90,ma:0,norad,...extra});
const xp=seed(910001),sgp4=repackOcm(seed(910002),o=>{o.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY=0;o.MEAN_ELEMENTS.BSTAR=0;});
const ap=seed(910003,{tesseral:12,zonal:6});
const carry=repackOcm(seed(910004,{tesseral:12,zonal:6}),o=>{
 o.TRAJ_TYPE=2;o.TRAJ_BASIS='PREDICTED';o.STATE_DATA=[];o.METADATA.START_TIME=iso(0);o.METADATA.STOP_TIME=iso(86400);
 o.POLYNOMIAL_POSITION_RECORDS=[new PPEPositionRecordT(iso(43200),43200,2,0,[7000,0],[0,100],[0,0],false,[],[],[],0,0)];
 o.TRAJECTORY_BLOCKS=[Object.assign(new OCMTrajectoryBlockT(),{TRAJ_ID:'CARRIED FORECAST',TRAJ_BASIS:'PREDICTED',INTERPOLATION:'CHEBYSHEV',INTERPOLATION_DEGREE:1,PROPAGATOR:'AP',CENTER_NAME:'EARTH',TRAJ_REF_FRAME:'TEMEOFEPOCH',TRAJ_FRAME_EPOCH:epoch,USEABLE_START_TIME:iso(0),USEABLE_STOP_TIME:iso(86400),TRAJ_TYPE:'POLYNOMIAL_POS',TRAJ_UNITS:'km'})];
});
const a=(6378.137+200)/.999,n=Math.sqrt(398600.4418/a**3)*86400/(2*Math.PI);
const decay=seed(910005,{n,bterm:.01,tesseral:31,zonal:20,slow:true,solidTides:true,records:true,rows});
const base=await createStandaloneHarness('browser',baseFile,{surface:'direct'}),now=await createStandaloneHarness('browser',wasmPath,{surface:'direct'});
let compared=0;
try{
 for(const frame of [pcfOutputFrame.TEME,pcfOutputFrame.GCRF,pcfOutputFrame.EME2000]){
  for(const [records,times] of [[[sgp4,xp,ap,carry],[0,60,3600,86400]],[[sgp4,xp,ap,carry,decay],[0,21600,86400,259200,345600]]]){
   const inputs=flight(records,{output:{EPOCHS:times.map(iso),FRAME:frame}});
   const old=await base.invoke({methodId:'propagate_epochs',inputs}),got=await now.invoke({methodId:'propagate_epochs',inputs});
   assert.equal(old.statusCode,0,old.errorCode);assert.deepEqual(got,old);compared++;
  }
 }
 const inputs=flight([decay],{output:{EPOCHS:[iso(345600)],FRAME:pcfOutputFrame.TEME}});
 const old=await base.invoke({methodId:'propagate_epochs',inputs}),got=await now.invoke({methodId:'propagate_epochs',inputs});
 assert.equal(old.statusCode,3);assert.match(old.errorCode,/^decayed:/);assert.equal(got.statusCode,old.statusCode);assert.equal(got.errorCode,old.errorCode);assert.equal(got.errorMessage,old.errorMessage);
 assert.equal(got.outputs.length,1);const block=OEM.getRootAsOEM(new fb.ByteBuffer(got.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
 assert.equal(block.EPHEMERIS_DATA_LINES.length,0);assert.match(block.COMMENT,/status=refused/);
 console.log(JSON.stringify({complete:true,byteEqualCalls:compared,fullyDecayedNamedError:true}));
}finally{await base.destroy();await now.destroy();}
