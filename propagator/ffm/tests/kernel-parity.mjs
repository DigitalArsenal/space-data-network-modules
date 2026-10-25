// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the DE440 kernel requests: the same byte payload in every lane.
import fs from 'node:fs';
import { hexRequestFor } from './lib/prwCodec.mjs';
import { parity } from './lib/parity.mjs';
const kernel=fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp',import.meta.url));
const request=(operation,params,useKernel=true)=>hexRequestFor(operation,params,useKernel?kernel:undefined);
const propagation={epochJD:2461041.5,targetJD:2461041.5+60/86400,position:[7000,0,0],velocity:[0,7.5,1],forces:{j2:false,thirdBody:true,srp:true}};
const cases=[
  ...[10,301,5].map(target=>({id:`de440-target-${target}`,request:request('ephemeris',{target,center:399,epochTDBJD:2461041.5})})),
  {id:'de440-out-of-coverage',request:request('ephemeris',{target:10,center:399,epochTDBJD:2451545})},
  {id:'de440-propagation',request:request('propagate',propagation)},
  {id:'analytical-propagation',request:request('propagate',propagation,false)},
];
await parity({ name: 'TMPL lane13 canonical PRW DE440 artifact', cases, receipt: 'lane13/kernel-parity.json' });
