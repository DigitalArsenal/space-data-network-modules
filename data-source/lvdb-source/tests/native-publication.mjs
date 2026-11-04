import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createSingleFileBundle,verifyModuleArtifact} from 'space-data-module-sdk/bundle';
import {appendPublicationRecordCollection,encodePublicationRecordCollection} from 'space-data-module-sdk/transport';
import {localNode} from './local-node.mjs';
import {hash} from './sources.mjs';
import {readbackSeries} from './readback-series.mjs';
export async function nativePublication(root,binary){
 const node=await localNode(binary),program='com.digitalarsenal.flows.lvdb-source';
 node.config.publishing.allowed_schemas=['SSY','SSY.fbs'];
 node.config.publishing.auto_publish=['SSY'].map(c=>({schema:c+'.fbs',provider_id:'lvdb',source_name:'comb-all',min_interval:'1s',settle:'1s',max_shard_bytes:1048576}));
 const flowDir=path.join(root,'tests/fixture-flow/runtime');
 try{
  await node.start();
  const portable=await fs.readFile(path.join(flowDir,'runtime.wasm'));
  const r=await fetch(node.base+'/api/v1/admin/modules/sign',{method:'POST',headers:{'Content-Type':'application/wasm'},body:portable,signal:AbortSignal.timeout(30000)});assert(r.ok,'Scratch-node signing '+r.status);const sig=await r.json();assert.equal(sig.content_hash,hash(portable));
  const bundle=await createSingleFileBundle({wasmBytes:portable,signature:sig.signature_entry});
  const signed=appendPublicationRecordCollection(portable,encodePublicationRecordCollection({mbl:bundle.bundle}));
  assert((await verifyModuleArtifact(signed,{requireSignature:true,trustedPublicKeys:[sig.public_key_hex]})).verified);
  await node.stop();
  const target=path.join(node.dir,'flows',program);await fs.cp(flowDir,target,{recursive:true});await fs.writeFile(path.join(target,'runtime.wasm'),signed);await fs.writeFile(path.join(target,'isomorphic/module.wasm'),signed);
  node.config.flows.services=[{flow:program,memory_pages:8192,intervals:{minute:'1h'},retrieval_interval:'59m',exclusive_group:'lvdb-source',release_after_run:true}];
  await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals:[{module_hash:hash(portable),capability:'storage_ingest',plugin_id:program,approved_at:new Date().toISOString(),approved_by:'lvdb-source-e2e',note:'Isolated fixture replay'}]}));
  await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
  const log=await fs.open(path.join(node.dir,'prewarm.log'),'w');try{await new Promise((resolve,reject)=>{const p=spawn(binary,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('prewarm '+code+'; '+node.dir)));});}finally{await log.close();}
  const info=await node.start();console.log('Native fixture flow running: '+node.dir);
  const cids={};let batchId,recordCount;const deadline=Date.now()+180000;
  while(Date.now()<deadline&&Object.keys(cids).length<1){const log=await fs.readFile(path.join(node.dir,'sdn.log'),'utf8');for(const m of log.matchAll(/auto-published (SSY)\.fbs lvdb\/comb-all batch ([^\s]+): (\d+) records, manifest ([^\s]+)/g)){cids[m[1]]=m[4];batchId=m[2];recordCount=Number(m[3]);}if(Object.keys(cids).length<1)await new Promise(r=>setTimeout(r,1000));}
  assert.equal(Object.keys(cids).length,1,'No SSY lane publication: '+node.dir+'/sdn.log');
  assert.equal(recordCount,1727,'Auto-publisher completed the full batch');
  const series=await readbackSeries({root,node,peerId:info.peer_id,batchId,firstManifestCid:cids.SSY,expectedCount:1727});
  return {records:{SSY:series.records},cids,shards:series.shards,uniqueRecords:series.uniqueRecords,nodeDirectory:node.dir};
 }finally{await node.stop();}
}
