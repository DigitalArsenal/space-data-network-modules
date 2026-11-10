#!/usr/bin/env node
// E2E (SPEC 16.7; review 0, finding M5): a record whose mean motion leaves its resonance class during the flight keeps
// flying continuously. Registered fixture (2026-11-03): AP mean-element GTO at 2026-10-29 00:00 UTC, n 2.40 rev/day,
// e 0.72, i 27, RAAN 40, argp 270, M 0, BTERM 0.06 m^2/kg (the B its registered grid selected on every build since: the first
// of .04, .06, .08, .1 whose primary leaves the half-day band in the week and whose companion does not), AGOM 0, FORCES
// 31,20, NRLMSISE-00 on the constant rows of test/lib/spw-constant.mjs. Its drag carries the mean motion past the half-day
// class's upper limit, 2.4066852459 rev/day, between days 3 and 7 (2.4035 at day 3, 2.4084 at day 7). The companion
// starts at 2.3966852459 and stays inside the band. The AP seed's GCRF state seeds FFM (16.6's gravity, DE440, zero EOP;
// the FFM build named by its SHA-256 below, any other refused); no fit.
// - Continuity in time: the primary flown in GCRF every 10 s from day 3 to day 7 (34,561 states): the jump detector
//   |d_k - (d_(k-1) + d_(k+1)) / 2|, d the second difference of position less h^2 times the two-body acceleration
//   (mu 398600.4415 km^3/s^2), stays below 1 m away from perigee (10 min each side of each of the 9 passages left out).
//   A step J in the output gives about 1.5 J there; the flight's own smooth terms give 0.14 m. Within 10 min of perigee
//   the detector reaches 129 m: the perigee drag passage's step (SPEC 16.12), the same on 0.6.7, printed and not asserted.
//   This fixture's set lies above e 0.3 (its first-order families on the grid), so 0.6.7's rebuilt tables did not change
//   its output table and it passes this check too; continuity at the class limits proper is test/branch-at-epoch.e2e.mjs.
// - The day-7 signed along-track error of the primary against FFM within 25 % of the companion's: -168,218.829 m against
//   -136,267.630 m with the class held (0.6.7, its tables rebuilt for the current class: -167,341.326 m).
// Every number comes from the built module's own calls (propagate) and FFM's. JS only moves bytes and compares numbers
// the modules produced.
//   node test/class-crossing.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {wasmPath} from './lib/module.mjs';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {seedOcm, rowsThrough, flight} from './lib/ocm.mjs';
import {spwFixtureRows} from './lib/spw-constant.mjs';
// the truth's FFM build (propagator/ffm 2.3.0, dist/isomorphic/module.wasm); test/lib/heo-model-truth.mjs keys its cached
// truths by that file's bytes, so a truth of another build is never read, and another build is refused here by name
const FFM_SHA256='ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934';
{
 const ffm=createHash('sha256').update(fs.readFileSync(new URL('../../ffm/dist/isomorphic/module.wasm',import.meta.url))).digest('hex');
 assert.equal(ffm,FFM_SHA256,`the truth's FFM build is ${FFM_SHA256}, not ${ffm}: the registered numbers are that build's`);
}
const edge=2.4066852459,bterm=.06,MU=398600.4415,epoch='2026-10-29T00:00:00.000',t0=Date.parse(epoch+'Z'),DAY=86400000;
const fixture={e:.72,i:27,raan:40,argp:270,ma:0,drag:true,bterm,dragSigma:1e-10,mode:'seed'};
const a=await runModelTruth({...fixture,name:'crossing',n:2.40}),b=await runModelTruth({...fixture,name:'companion',n:edge-.01});
assert.ok(a.ffmSha256===FFM_SHA256&&b.ffmSha256===FFM_SHA256,'both truths flown by the named FFM build');
const ratio=a.days[7].t/b.days[7].t;
// the primary's own flight, days 3 to 7 every 10 s
const rows=rowsThrough(spwFixtureRows());
const seed=seedOcm({epoch,n:2.40,e:.72,i:27,raan:40,argp:270,ma:0,bterm,norad:99001,msis:true,records:true,tesseral:31,zonal:20,rows});
const h=await createStandaloneHarness('browser',wasmPath,{surface:'command'});
const step=10,first=3*86400,K=Math.round(4*86400/step),iso=(s)=>new Date(t0+s*1000).toISOString().replace('Z','');
const states=[];
for(let k0=0;k0<=K;k0+=20000){
 const times=Array.from({length:Math.min(20000,K+1-k0)},(_,j)=>first+(k0+j)*step);
 const r=await h.invoke({methodId:'propagate',inputs:flight([seed],{output:{EPOCHS:times.map(iso),FRAME:pcfOutputFrame.GCRF}})});
 assert.equal(r.statusCode,0,`propagate: ${r.errorCode} ${r.errorMessage}`);
 for(const l of OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find(o=>o.portId==='ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES)states.push([l.X,l.Y,l.Z]);
}
assert.equal(states.length,K+1,'every state flown');
const d=[];
for(let k=1;k<K;++k){const r=states[k],rn=Math.hypot(...r);d.push([0,1,2].map(c=>(states[k+1][c]-2*r[c]+states[k-1][c]+step*step*MU*r[c]/rn**3)*1000));}
// perigee passages (local minima of |r|): the drag passage's step at perigee is SPEC 16.12's, not a class's; 10 min each
// side of each is left out
const rn=states.map(r=>Math.hypot(...r)),perigees=[];
for(let k=1;k<K;++k)if(rn[k]<rn[k-1]&&rn[k]<=rn[k+1])perigees.push(first+k*step);
const nearPerigee=(s)=>perigees.some(p=>Math.abs(s-p)<=600);
let worst=0,at=0,worstPerigee=0;
for(let k=1;k+1<d.length;++k){
 const s=first+(k+1)*step,j=Math.hypot(...[0,1,2].map(c=>d[k][c]-0.5*(d[k-1][c]+d[k+1][c])));
 if(nearPerigee(s)){worstPerigee=Math.max(worstPerigee,j);continue;}
 if(j>worst){worst=j;at=s;}
}
const report={ffmSha256:FFM_SHA256,bterm,day7AlongTrackMeters:[a.days[7].t,b.days[7].t],ratio,allowed:[.75,1.25],jumpDetectorWorstMeters:worst,atDays:at/86400,bound:1,perigees:perigees.length,worstWithin10MinOfPerigeeMeters:worstPerigee};
console.log(JSON.stringify(report));
if(process.env.SDN_AP_CLASS_REPORT)fs.writeFileSync(process.env.SDN_AP_CLASS_REPORT,JSON.stringify({edge,report,pair:[a,b].map(r=>({name:r.name,n:r.n,days:r.days,apSha256:r.apSha256}))},null,2)+'\n');
await h.close?.();
assert.ok(worst<1,`the primary's output steps by about ${(worst/1.5).toFixed(2)} m near day ${(at/86400).toFixed(3)}`);
assert.ok(Math.abs(ratio-1)<=.25,'crossing signed along-track error within 25% of companion');
console.log('Class crossing E2E: PASS');
