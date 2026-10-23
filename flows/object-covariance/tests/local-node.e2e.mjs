// One integration scenario: real scheduled ingest -> covariance -> storage;
// unchanged B stays untouched; A's new row equals offline WASM recomputation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {createSingleFileBundle,verifyModuleArtifact} from 'space-data-module-sdk/bundle';
import {appendPublicationRecordCollection,encodePublicationRecordCollection} from 'space-data-module-sdk/transport';
import {localNode} from '../../../data-source/space-weather/tests/local-node.mjs';
import {runtimeParity} from '../../../data-source/space-weather/tests/runtime-parity.mjs';
import {bindings,frames,pack,unpack,scan} from './bindings.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),modules=path.resolve(root,'../..');
const program='com.digitalarsenal.flows.object-covariance',gpProgram='com.digitalarsenal.flows.celestrak-gp-ingest',source='celestrak-gp-object-covariance';
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'sdn-object-covariance-reactor-20261022-'));
const receipt={status:'RUNNING',docker:'WAIVED: owner 2026-10-22',evidence};
const save=()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex');
const command=(bin,args,options)=>new Promise((resolve,reject)=>{const p=spawn(bin,args,options);p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error(`${path.basename(bin)} exited ${code}`)));});
const frame=(portId,code,payload)=>({portId,payload,typeRef:{schemaName:code+'.fbs',fileIdentifier:'$'+code,rootTypeName:code,wireFormat:'flatbuffer'}});
let node,origin,harness;
try {
 const manifest=JSON.parse(await fs.readFile(path.join(modules,'analysis/gp-error-model/plugin-manifest.json'),'utf8'));
 assert(manifest.methods.find(m=>m.methodId==='object_covariance')?.outputPorts.some(p=>p.portId==='ocm'),'BLOCKED: standards-correct object_covariance OCM output is not available');
 assert(process.env.SDN_NODE_BINARY,'SDN_NODE_BINARY must be freshly built from SDN origin/main');
 const api=await bindings(evidence);
 // Synthetic integration fixtures, not Space-Track records or numerical truth.
 // Values are fixed plausible elements; no dynamics is computed in JavaScript.
 const columns='OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
 const epoch=i=>new Date(Date.UTC(2026,9,1)+i*6*3600000).toISOString();
 const row=(id,i)=>`SYNTHETIC-${id},2026-001A,${epoch(i)},15.5,0.001,51.6,20,30,40,0,U,${id},${i+1},1000,0.0001,0,0`;
 let csv=columns+'\n'+[900001,900002].flatMap(id=>Array.from({length:96},(_,i)=>row(id,i))).join('\n')+'\n';
 origin=http.createServer((req,res)=>{res.setHeader('Content-Type','text/csv');res.end(csv);});
 await new Promise(r=>origin.listen(0,'127.0.0.1',r));
 node=await localNode(path.resolve(process.env.SDN_NODE_BINARY));node.program=program;
 node.config.publishing.allowed_schemas=['OMM','OMM.fbs','OCM','OCM.fbs','MPE','MPE.fbs'];
 node.config.publishing.auto_publish=[{schema:'OCM.fbs',provider_id:'object-covariance',source_name:source,min_interval:'1s',settle:'1s',max_shard_bytes:1048576}];
 node.config.publishing.retention={keep_series:2,lanes:[{schema:'OCM.fbs',provider_id:'object-covariance',source_name:source,keep_series:2,snapshot_batches:false}]};
 receipt.nodeDirectory=node.dir;await save();
 const info=await node.start(),approvals=[];
 for(const [id,relative,capabilities] of [[program,'flows/object-covariance/dist/runtime',['storage_query','storage_ingest','clock']],[gpProgram,'flows/celestrak-ingest/dist/gp',['http','storage_ingest']]]) {
  const dir=path.join(modules,relative),portable=await fs.readFile(path.join(dir,'runtime.wasm'));
  const response=await fetch(node.base+'/api/v1/admin/modules/sign',{method:'POST',headers:{'Content-Type':'application/wasm'},body:portable});assert(response.ok,`Sign ${response.status}`);
  const signature=await response.json();assert.equal(signature.content_hash,hash(portable));assert(info.keys.some(k=>k.public_key===signature.public_key_hex));
  const bundle=await createSingleFileBundle({wasmBytes:portable,signature:signature.signature_entry});
  const signed=appendPublicationRecordCollection(portable,encodePublicationRecordCollection({mbl:bundle.bundle}));
  assert((await verifyModuleArtifact(signed,{requireSignature:true,trustedPublicKeys:[signature.public_key_hex]})).verified);
  const target=path.join(node.dir,'flows',id);await fs.cp(dir,target,{recursive:true});
  await fs.writeFile(path.join(target,'runtime.wasm'),signed);await fs.writeFile(path.join(target,'isomorphic/module.wasm'),signed);
  approvals.push(...capabilities.map(capability=>({module_hash:hash(portable),capability,plugin_id:id,approved_at:new Date().toISOString(),approved_by:'covreactor-e2e',note:'Isolated synthetic acceptance'})));
 }
 await node.stop();
 node.config.flows.services=[{flow:gpProgram,memory_pages:8192,intervals:{'timer-gp':'2s'},retrieval_interval:'1s',exclusive_group:'covreactor-test',release_after_run:true,config:{celestrak_gp_url:`http://127.0.0.1:${origin.address().port}/gp.csv`,celestrak_license:'synthetic-test'}},{flow:program,memory_pages:8192,intervals:{refresh:'2s'},retrieval_interval:'1s',exclusive_group:'covreactor-test',release_after_run:true}];
 await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals}));
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 const log=await fs.open(path.join(evidence,'prewarm.log'),'w');try{await command(process.env.SDN_NODE_BINARY,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
 receipt.aot='PASS: exact signed GP ingest and covariance flows, node prewarm-aot';await save();await node.start();
 const covariances=async()=> (await scan(api,node.base,'OCM.fbs',source)).map(b=>unpack(api,'OCM',b));
 const waitFor=async predicate=>{const deadline=Date.now()+180000;while(Date.now()<deadline){const rows=await covariances();if(predicate(rows))return rows;await new Promise(r=>setTimeout(r,2000));}throw Error('No expected covariance result; '+node.dir+'/sdn.log');};
 const of=(rows,id)=>rows.filter(r=>r.METADATA.OBJECT_DESIGNATOR===String(id));
 const before=await waitFor(rows=>of(rows,900001).length===1&&of(rows,900002).length===1);
 csv=columns+'\n'+[row(900001,96),row(900002,95)].join('\n')+'\n';
 const after=await waitFor(rows=>of(rows,900001).some(r=>r.METADATA.START_TIME===epoch(96)));
 assert.equal(of(after,900001).length,of(before,900001).length+1);assert.equal(of(after,900002).length,of(before,900002).length);
 const stored=of(after,900001).find(r=>r.METADATA.START_TIME===epoch(96));assert.equal(stored.COVARIANCE_DATA.length,21);assert(stored.PROVENANCE);assert.equal(stored.COV_REALISM.length,1);
 const history=(await scan(api,node.base,'OMM.fbs','celestrak-gp')).filter(b=>unpack(api,'OMM',b).NORAD_CAT_ID===900001);
 const request=new api.ERM.ERMT();request.CALIBRATED_COVARIANCES=new api.ERM.ERMCalibratedCovariancesT();
 const object=new api.ERM.ERMCalibrationObjectT();Object.assign(object,{ID:'NORAD:900001',SET_NORAD_CAT_ID:900001,SET_EPOCH:epoch(96),AGE_DAYS:0});request.CALIBRATED_COVARIANCES.OBJECTS=[object];
 const inputs=[frame('elements','OMM',Buffer.concat(history)),frame('request','ERM',pack(api,'ERM',request))];
 const wasmPath=path.join(modules,'analysis/gp-error-model/dist/isomorphic/module.wasm');
 harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(wasmPath),manifest,surface:'direct'});
 const recomputed=await harness.invoke({methodId:'object_covariance',inputs});assert.equal(recomputed.statusCode,0,recomputed.errorMessage);
 const offline=unpack(api,'OCM',frames(Buffer.from(recomputed.outputs.find(o=>o.portId==='ocm').payload))[0]);
 assert.deepEqual(stored.COVARIANCE_DATA,offline.COVARIANCE_DATA);assert.equal(offline.METADATA.START_TIME,epoch(96));
 await harness.destroy();harness=null;
 receipt.runtimeParity=await runtimeParity({wasmPath,manifest,cases:[{methodId:'object_covariance',inputs}],evidence});
 const settled=await covariances();assert.equal(of(settled,900001).length,of(after,900001).length);assert.equal(of(settled,900002).length,of(before,900002).length);
 receipt.status='PASS';receipt.result={changedObject:900001,epoch:epoch(96),matrix:'bit-identical to offline WASM',unchangedObject:900002,unchangedCount:of(settled,900002).length};
 console.log('PASS: scheduled new OMM -> matching OCM; offline matrix equality; unchanged object untouched');
} catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.message);}finally{if(harness)await harness.destroy();if(node)await node.stop();if(origin)await new Promise(r=>origin.close(r));await save();console.log('Evidence: '+evidence);}
