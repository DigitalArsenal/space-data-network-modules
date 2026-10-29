import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeTimerTick,decodeHttpRequest,encodeHttpResponse,decodeIngestRequest} from 'space-data-module-sdk/runtime-contracts';
import {createSingleFileBundle,verifyModuleArtifact} from 'space-data-module-sdk/bundle';
import {appendPublicationRecordCollection,encodePublicationRecordCollection} from 'space-data-module-sdk/transport';
import {localNode} from './local-node.mjs';
import {verifySources,SOURCE_URLS} from './source-oracle.mjs';
import {runtimeParity} from './runtime-parity.mjs';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),modules=path.resolve(root,'../..');
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {SPW}=await import(pathToFileURL(path.join(sds,'lib/js/SPW/SPW.js')));
const {DPM}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/DPM.js')));
const {publicationAssetKind}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/publicationAssetKind.js')));
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'))),wasm=await fs.readFile(path.join(root,'dist/isomorphic/module.wasm'));
const evidence=await fs.mkdtemp(path.join(root,'tests/evidence-'));
const receipt={status:'RUNNING',artifactSha256:hash(wasm),startedAt:new Date().toISOString()};
const save=()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
const input=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
function decodeRecords(bytes){const rows=[];for(let at=0;at<bytes.length;){const n=bytes.readUInt32LE(at);assert(n>8&&at+4+n<=bytes.length);rows.push(SPW.getSizePrefixedRootAsSPW(new ByteBuffer(bytes.subarray(at,at+4+n))).unpack());at+=4+n;}return rows;}
const command=(bin,args,options)=>new Promise((resolve,reject)=>{const child=spawn(bin,args,options);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(bin)} exited ${code}`)));});
let harness,node,client;
try {
 await save();harness=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});
 const planned=await harness.invoke({methodId:'plan_weather',inputs:[input('tick',encodeTimerTick({triggerId:'hourly',firedMs:Date.now()}),'TimerTick.fbs','TICK','TimerTick')]});
 assert.equal(planned.statusCode,0,planned.errorMessage);
 const requests=planned.outputs.filter(o=>o.portId==='request').map(o=>decodeHttpRequest(o.payload));assert.deepEqual(requests.map(r=>r.url),SOURCE_URLS,'the five sources, in canonical order');assert(requests.every(r=>r.headers['if-modified-since']));
 const bodies=[];const inputs=[];
 for(const [i,r] of requests.entries()) {const response=await fetch(r.url,{headers:r.headers,signal:AbortSignal.timeout(90000)});assert.equal(response.status,200,r.url);const body=Buffer.from(await response.arrayBuffer());bodies.push(body);await fs.writeFile(path.join(evidence,`source-${i}.txt`),body);inputs.push(input('response',encodeHttpResponse({url:r.url,status:200,body,retrievedMs:Date.now()}),'HttpResponse.fbs','HRSP','HttpResponse'));}
 const result=await harness.invoke({methodId:'parse_weather',inputs});assert.equal(result.statusCode,0,result.errorMessage);
 const records=Buffer.from(result.outputs.find(o=>o.portId==='records').payload);const rows=decodeRecords(records);
 verifySources(rows,bodies,new Date().toISOString().slice(0,10));
 const meta=decodeIngestRequest(result.outputs.find(o=>o.portId==='meta').payload);assert.match(meta.tags.license,/CC-BY-4.0/);assert.match(meta.tags.citation,/Matzka/);
 // A corrupt source cannot replace a good batch, even when three others succeeded.
 const invalid=inputs.slice();invalid[0]=input('response',encodeHttpResponse({url:requests[0].url,status:200,body:Buffer.from('truncated'),retrievedMs:Date.now()}),'HttpResponse.fbs','HRSP','HttpResponse');
 const refused=await harness.invoke({methodId:'parse_weather',inputs:invalid});assert.notEqual(refused.statusCode,0);assert(!refused.outputs.some(o=>o.portId==='records'));
 receipt.sourceChecks={rows:rows.length,sourceSha256:bodies.map(hash),urls:requests.map(r=>r.url),corruptSourceRefused:true};await save();console.log(`PASS WASM source equality: ${rows.length} days, today included; corrupt source refused`);
 await harness.destroy();harness=null;
 receipt.runtimeParity=await runtimeParity({wasmPath:path.join(root,'dist/isomorphic/module.wasm'),manifest,evidence,cases:[{methodId:'plan_weather',inputs:[input('tick',encodeTimerTick({triggerId:'hourly',firedMs:Date.now()}),'TimerTick.fbs','TICK','TimerTick')]},{methodId:'parse_weather',inputs},{methodId:'parse_weather',inputs:invalid}]});await save();console.log('PASS headless-browser/native WasmEdge byte parity; Docker waived by owner');
 node=await localNode(process.env.SDN_NODE_BINARY);receipt.nodeDirectory=node.dir;await save();const info=await node.start();console.log('PASS scratch node ready');
 const flowDir=path.join(modules,'flows/space-weather/dist/runtime'),portable=await fs.readFile(path.join(flowDir,'runtime.wasm'));
 const response=await fetch(node.base+'/api/v1/admin/modules/sign',{method:'POST',headers:{'Content-Type':'application/wasm'},body:portable,signal:AbortSignal.timeout(30000)});assert(response.ok,`Sign ${response.status}`);const signature=await response.json();assert.equal(signature.content_hash,hash(portable));
 assert(info.keys.some(k=>k.public_key===signature.public_key_hex&&k.address_type==='ed25519'));
 const bundle=await createSingleFileBundle({wasmBytes:portable,signature:signature.signature_entry});
 const signed=appendPublicationRecordCollection(portable,encodePublicationRecordCollection({mbl:bundle.bundle}));
 const verified=await verifyModuleArtifact(signed,{requireSignature:true,trustedPublicKeys:[signature.public_key_hex]});assert(verified.verified);
 await node.stop();
 const target=path.join(node.dir,'flows',node.program);await fs.cp(flowDir,target,{recursive:true});await fs.writeFile(path.join(target,'runtime.wasm'),signed);await fs.writeFile(path.join(target,'isomorphic/module.wasm'),signed);
 node.config.flows.services=[{flow:node.program,memory_pages:8192,intervals:{hourly:'1h'},retrieval_interval:'59m',exclusive_group:'space-weather',release_after_run:true}];
 await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals:['http','storage_ingest'].map(capability=>({module_hash:hash(portable),capability,plugin_id:node.program,approved_at:new Date().toISOString(),approved_by:'space-weather-e2e',note:'Isolated scratch-node acceptance'}))}));
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 // In the cross-component gate, run the actual owner rollout config merger
 // before AOT/boot. The same publication acceptance below exercises its result.
 if(process.env.GAUNTLET_CANDIDATE_OPS) {
  node.config.publishing.allowed_schemas=[]; // Empty means unrestricted, not SPW-only.
  await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
  const deploy=path.join(process.env.GAUNTLET_CANDIDATE_OPS,'deployment/space-weather-provider-node/deploy/host-config.py');
  const python=process.env.SPACEWX_PYTHON||'python3';
  await command(python,[deploy,node.configPath,'apply'],{stdio:'inherit'});
  const merged=JSON.parse(execFileSync(python,['-c','import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',node.configPath],{encoding:'utf8'}));
  assert.deepEqual(merged.publishing.allowed_schemas,[],'Rollout preserves unrestricted publication');
  assert.deepEqual(merged.admin,node.config.admin);assert.deepEqual(merged.network,node.config.network);
  Object.assign(node.config,merged);await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
  receipt.deploymentConfig='PASS: owner config merger used for signed/AOT scheduled publication';await save();
 }
 const log=await fs.open(path.join(node.dir,'prewarm.log'),'w');try{await command(process.env.SDN_NODE_BINARY,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
 await node.start();console.log('PASS signed flow installed, AOT prewarmed, scratch node ready');
 assert(process.env.SDN_JS,'Set SDN_JS to the built sdn-js checkout');const sdn=await import(pathToFileURL(path.join(process.env.SDN_JS,'dist/index.mjs')));
 const addrs=[`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws/p2p/${info.peer_id}`];
 client=await sdn.createHeliaSDNNode({edgeRelays:addrs,enableAutoDial:false,enableDHT:false,enableIdentify:true,allowPrivateAddressDial:true});
 let publications=[];const deadline=Date.now()+180000;
 while(Date.now()<deadline&&!publications.length) {
  const peer=client.libp2p.getConnections().find(c=>String(c.remotePeer)===info.peer_id)?.remotePeer;
  if(peer){const stream=await client.libp2p.dialProtocol(peer,sdn.FLATSQL_SYNC_LIST_PUBLISHED_PROTOCOL_ID);const chunks=[];const reading=(async()=>{for await(const c of stream)chunks.push(c instanceof Uint8Array?c:c.subarray());})();
   if(!stream.send(sdn.encodeFlatSqlPublishedListRequest({schema:'SPW.fbs',providerId:'space-weather',sourceName:'gfz-noaa'})))await stream.onDrain?.();await stream.close();await reading;
   publications=sdn.decodeFlatSqlPublishedList(Buffer.concat(chunks)).publications.filter(p=>p.providerId==='space-weather'&&p.sourceName==='gfz-noaa');
  }
  if(!publications.length)await new Promise(r=>setTimeout(r,2000));
 }
 assert(publications.length,'No SPW publication within 180 seconds; '+node.dir+'/sdn.log');
 const newest=publications.sort((a,b)=>b.publishedAtMs-a.publishedAtMs)[0];
 const manifestBytes=Buffer.from(await sdn.fetchCIDBytesFromHelia(client.helia,newest.manifestCid,{providerAddrs:addrs,maxBytes:1048576}));
 await fs.writeFile(path.join(evidence,'manifest.dpmfb'),manifestBytes);
 const dpm=(manifestBytes.subarray(8,12).toString()==='$DPM'?DPM.getSizePrefixedRootAsDPM:DPM.getRootAsDPM)(new ByteBuffer(manifestBytes)).unpack();assert.equal(dpm.PROVIDER_PEER_ID,info.peer_id);assert(dpm.PROVIDER_SIGNATURE.length>0);
 const source=dpm.SOURCES.find(s=>s.SOURCE_NAME==='gfz-noaa');assert(source,'Manifest source');assert.match(source.LICENSE,/CC-BY-4.0/);assert.match(source.CITATION,/Matzka/);assert.match(source.CITATION,/DRAO/);assert.match(source.CITATION,/NOAA/);
 const asset=dpm.ASSETS.find(a=>a.ASSET_KIND===publicationAssetKind.DATA_SHARD&&a.SCHEMA_NAME==='SPW.fbs');assert(asset);assert.equal(asset.CID,newest.shardCid);
 let readback=Buffer.from(await sdn.fetchCIDBytesFromHelia(client.helia,asset.CID,{providerAddrs:addrs,maxBytes:1048576}));
 assert.equal(hash(readback),asset.BYTE_SHA256.toLowerCase());assert.equal(readback.length,Number(asset.BYTE_LENGTH));
 await fs.writeFile(path.join(evidence,'published-shard.bin'),readback);
 if(readback[0]===31&&readback[1]===139)readback=gunzipSync(readback);
 const actual=decodeRecords(readback);verifySources(actual,bodies,new Date().toISOString().slice(0,10));
 receipt.publication={provider:info.peer_id,manifestCid:newest.manifestCid,shardCid:asset.CID,rows:actual.length,license:source.LICENSE,citation:source.CITATION,sha256:hash(readback)};receipt.status='PASS';console.log(`PASS scheduled native flow -> signed SPW publication -> independent SDN CID readback: ${actual.length} days`);
} catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.stack);}finally{if(harness)await harness.destroy();if(client)await client.stop();if(node)await node.stop();receipt.completedAt=new Date().toISOString();await save();console.log('Evidence: '+evidence);}

// All owned runtimes/nodes are stopped above; terminate residual third-party client timers.
process.exit(process.exitCode || 0);
