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
// The node config that switches gp-error-model's $OCM output on (dotted keys of one flow service's config), and the same
// recipe as nested values for the offline run.
const objectSource={id:'celestrak-gp',kind:'element-set',originator:'CelesTrak',provider:'sdn-object-covariance',lineage:'celestrak-gp',licence:{class:'cite-only',id:'synthetic-test'}};
const objectConfig={'object.source.id':objectSource.id,'object.source.kind':objectSource.kind,'object.source.originator':objectSource.originator,'object.source.provider':objectSource.provider,
 'object.source.lineage':objectSource.lineage,'object.source.licence.class':objectSource.licence.class,'object.source.licence.id':objectSource.licence.id};
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
 // 900003 is in a high-eccentricity orbit the default population model has no cells for: its record has rows without covariance.
 const row=(id,i)=>id===900003?`SYNTHETIC-${id},2026-001A,${epoch(i)},2.0,0.7,63.4,20,270,40,0,U,${id},${i+1},1000,0.0001,0,0`:`SYNTHETIC-${id},2026-001A,${epoch(i)},15.5,0.001,51.6,20,30,40,0,U,${id},${i+1},1000,0.0001,0,0`;
 let csv=columns+'\n'+[900001,900002,900003].flatMap(id=>Array.from({length:96},(_,i)=>row(id,i))).join('\n')+'\n';
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
 node.config.flows.services=[{flow:gpProgram,memory_pages:8192,intervals:{'timer-gp':'2s'},retrieval_interval:'1s',exclusive_group:'covreactor-test',release_after_run:true,config:{celestrak_gp_url:`http://127.0.0.1:${origin.address().port}/gp.csv`,celestrak_license:'synthetic-test'}},{flow:program,memory_pages:8192,intervals:{refresh:'2s'},retrieval_interval:'1s',exclusive_group:'covreactor-test',release_after_run:true,config:objectConfig}];
 await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals}));
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 const log=await fs.open(path.join(evidence,'prewarm.log'),'w');try{await command(process.env.SDN_NODE_BINARY,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
 receipt.aot='PASS: exact signed GP ingest and covariance flows, node prewarm-aot';await save();await node.start();
 const covariances=async()=> (await scan(api,node.base,'OCM.fbs',source)).map(b=>unpack(api,'OCM',b));
 const waitFor=async predicate=>{const deadline=Date.now()+180000;while(Date.now()<deadline){const rows=await covariances();if(predicate(rows))return rows;await new Promise(r=>setTimeout(r,2000));}throw Error('No expected covariance result; '+node.dir+'/sdn.log');};
 const of=(rows,id)=>rows.filter(r=>r.METADATA.OBJECT_DESIGNATOR===String(id));
 const before=await waitFor(rows=>[900001,900002,900003].every(id=>of(rows,id).length===1));
 const heo=of(before,900003)[0];assert(heo.COV_REALISM.every(c=>c.RULE===0&&c.EVIDENCE.includes('NO_MODEL')),'no model cells: rows say why');assert(heo.COVARIANCE_DATA.every(Number.isNaN),'and carry no covariance');
 csv=columns+'\n'+[row(900001,96),row(900002,95)].join('\n')+'\n';
 const same=(a,b)=>Date.parse(a)===Date.parse(b);
 const after=await waitFor(rows=>of(rows,900001).some(r=>same(r.METADATA.START_TIME,epoch(96))));
 assert.equal(of(after,900001).length,of(before,900001).length+1);assert.equal(of(after,900002).length,of(before,900002).length);
 const ages=[0,0.5,1,2,3,5,7],stored=of(after,900001).find(r=>same(r.METADATA.START_TIME,epoch(96)));
 assert.equal(stored.STATE_EPOCHS.length,ages.length);assert.equal(stored.COVARIANCE_DATA.length,21*ages.length);assert.equal(stored.COV_REALISM.length,ages.length);assert(stored.PROVENANCE);
 assert(same(stored.STATE_EPOCHS[0],epoch(96)),'the first row is at the new OMM epoch');
 assert(stored.COV_REALISM.some(c=>c.RULE===5),'EmpiricalHistoryShrunk rows (SDS 1.261.0 covarianceRule 5)');assert(stored.COV_REALISM.every(c=>c.RULE!==2),'ScaledFit never stands in for the empirical rule');
 const history=(await scan(api,node.base,'OMM.fbs','celestrak-gp')).filter(b=>unpack(api,'OMM',b).NORAD_CAT_ID===900001);
 const newest=history.map(b=>unpack(api,'OMM',b)).find(o=>same(o.EPOCH+(/[zZ]$/.test(o.EPOCH)?'':'Z'),epoch(96)));assert(newest,'the new OMM is stored');
 // The request id is the position the record carries in its message id (object-covariance|<key>|<epoch>|<method>|<request id>).
 const requestId=stored.HEADER.MESSAGE_ID.split('|').at(-1);assert(/^omm-rowid:\d+$/.test(requestId),stored.HEADER.MESSAGE_ID);
 const request=new api.ERM.ERMT();request.CALIBRATED_COVARIANCES=new api.ERM.ERMCalibratedCovariancesT();
 request.CALIBRATED_COVARIANCES.OBJECTS=ages.map((age,i)=>{const object=new api.ERM.ERMCalibrationObjectT();Object.assign(object,{ID:requestId,SET_NORAD_CAT_ID:900001,SET_EPOCH:newest.EPOCH,AGE_DAYS:age});return object;});
 const inputs=[frame('elements','OMM',Buffer.concat(history)),frame('request','ERM',pack(api,'ERM',request))];
 const wasmPath=path.join(modules,'analysis/gp-error-model/dist/isomorphic/module.wasm');
 harness=await createBrowserModuleHarness({wasmSource:await fs.readFile(wasmPath),manifest,surface:'direct',hostOptions:{config:{object:{source:objectSource}}}});
 const recomputed=await harness.invoke({methodId:'object_covariance',inputs});assert.equal(recomputed.statusCode,0,recomputed.errorMessage);
 const offline=unpack(api,'OCM',frames(Buffer.from(recomputed.outputs.find(o=>o.portId==='ocm').payload))[0]);
 // The whole record, not only its matrix: the node's WasmEdge run and the offline run (SDK browser host) are the same bytes.
 assert.deepStrictEqual(stored,offline);
 // And the matrix is the covariance port's GCRF matrix in SDS units (km**2 family), row by row.
 const results=unpack(api,'ERM',frames(Buffer.from(recomputed.outputs.find(o=>o.portId==='covariance').payload))[0]).CALIBRATED_COVARIANCES.RESULTS;
 results.forEach((result,i)=>{let k=0;for(let a=0;a<6;a++)for(let b=0;b<=a;b++,k++)assert.equal(stored.COVARIANCE_DATA[21*i+k],result.COVARIANCE_INERTIAL[6*a+b]/1e6,`row ${i} element ${k}`);});
 await harness.destroy();harness=null;
 // The real-browser leg of the parity helper: the SDK browser host cannot answer plugin.getConfig of a shared-memory module (the
 // TextDecoder-on-shared-view defect, graph task upstream-module-sdk-1), for the released 0.9.0 module as for this one. Only that
 // refusal is reported as blocked; any other disagreement between the browser and native WasmEdge still fails the run.
 try{receipt.runtimeParity=await runtimeParity({wasmPath,manifest,cases:[{methodId:'object_covariance',inputs}],evidence,config:{object:{source:objectSource}}});}
 catch(error){if(!/host answered without a \$PIV response/.test(String(error.message)))throw error;
  receipt.runtimeParity={status:'BLOCKED',reason:'upstream-module-sdk-1: the SDK browser host cannot answer plugin.getConfig of a shared-memory module; the node (native WasmEdge) and the SDK JS host agree byte for byte above',docker:'WAIVED: owner ruling 2026-10-22'};}
 const settled=await covariances();assert.equal(of(settled,900001).length,of(after,900001).length);assert.equal(of(settled,900002).length,of(before,900002).length);assert.equal(of(settled,900003).length,1,'a record without covariance is still the cursor: the object is not retried');
 receipt.status='PASS';receipt.result={changedObject:900001,epoch:epoch(96),record:'bit-identical to offline WASM (whole $OCM)',rows:ages.length,rules:stored.COV_REALISM.map(c=>c.RULE),unchangedObject:900002,unchangedCount:of(settled,900002).length};
 console.log('PASS: scheduled new OMM -> matching OCM; offline matrix equality; unchanged object untouched');
} catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.message);}finally{if(harness)await harness.destroy();if(node)await node.stop();if(origin)await new Promise(r=>origin.close(r));await save();console.log('Evidence: '+evidence);}
