// One scenario (modules-eop-publication-flow-20261023): a signed, AOT-prewarmed flow on a scratch node runs on its daily schedule,
// fetches the USNO finals2000A file through the node's archive mirror and publishes it as SDS EOP records on lane
// EOP.fbs eop/usno-finals2000a; a separate SDN client reads the publication back by CID, and every record equals eop-parser's
// offline parse of the same file. The next runs of the unchanged file publish nothing; a later edition replaces the first.
// The file is the copy this machine keeps (no IERS/USNO fetch). JS only routes bytes and compares.
//
//   SDN_NODE_BINARY   a native node built from sdn origin/main        SDN_JS   its built sdn-js checkout
//   GAUNTLET_CANDIDATE_OPS (or SPACEWX_OPS)   the stack checkout whose owner installer and live check run here
//   SPACEWX_PYTHON    a Python with PyYAML (default python3)          EOP_ARCHIVE_ROOT   default /opt/data/sdn-archive/hac/iers-eop
//   EOP_KEEP_EVIDENCE=1 keeps the scratch node and evidence after a pass
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {ByteBuffer} from 'flatbuffers';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeHttpResponse,decodeIngestRequest} from 'space-data-module-sdk/runtime-contracts';
import {createSingleFileBundle,verifyModuleArtifact} from 'space-data-module-sdk/bundle';
import {appendPublicationRecordCollection,encodePublicationRecordCollection} from 'space-data-module-sdk/transport';
import {localNode} from '../../../data-source/space-weather/tests/local-node.mjs';
import {runtimeParity} from '../../../data-source/space-weather/tests/runtime-parity.mjs';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),modules=path.resolve(root,'../..');
const sds=path.dirname(require.resolve('spacedatastandards.org/package.json'));
const {EOP}=await import(pathToFileURL(path.join(sds,'lib/js/EOP/EOP.js')));
const {DPM}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/DPM.js')));
const {publicationAssetKind}=await import(pathToFileURL(path.join(sds,'lib/js/DPM/publicationAssetKind.js')));
const program='com.digitalarsenal.flows.eop',lane={schema:'EOP.fbs',providerId:'eop',sourceName:'usno-finals2000a'};
const USNO_URL='https://maia.usno.navy.mil/ser7/finals2000A.all',LICENSE='LicenseRef-US-Government-Work-Public-Domain',WHOLE_FILE='Thu, 01 Jan 1970 00:00:00 GMT';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'eop-flow-e2e-'));
const receipt={status:'RUNNING',docker:'WAIVED: owner ruling 2026-10-22',startedAt:new Date().toISOString()};
const save=()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
const command=(bin,args,options)=>new Promise((resolve,reject)=>{const child=spawn(bin,args,options);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(bin)} exited ${code}`)));});
const frame=(portId,payload,schemaName,fileIdentifier,rootTypeName)=>({portId,payload,typeRef:{schemaName,fileIdentifier,rootTypeName,wireFormat:'flatbuffer',byteLength:payload.length}});
// [uint32 little-endian length][standalone $EOP] records: the parser's stream and the published shard.
function records(bytes){const rows=[];for(let at=0;at<bytes.length;){const n=bytes.readUInt32LE(at);assert(n>8&&at+4+n<=bytes.length,'Truncated record stream');rows.push({bytes:bytes.subarray(at+4,at+4+n),row:EOP.getRootAsEOP(new ByteBuffer(bytes.subarray(at+4,at+4+n))).unpack()});at+=4+n;}return rows;}
let parser,node,client,mirror,passed=false;
try {
 await save();
 // The file: this machine's verbatim copy of the Rapid Service product, bound to the digest its archive recorded.
 const archiveRoot=process.env.EOP_ARCHIVE_ROOT||'/opt/data/sdn-archive/hac/iers-eop';
 const latest=JSON.parse(await fs.readFile(path.join(archiveRoot,'latest.json'),'utf8')),entry=latest.files['finals.all.iau2000.txt'];
 const sourcePath=path.resolve(path.dirname(archiveRoot),entry.path);
 assert(sourcePath.startsWith(path.resolve(archiveRoot)+path.sep),'The archive path must stay inside its root');
 const body=await fs.readFile(sourcePath);assert.equal(hash(body),entry.sha256,'The archived file must match its recorded digest');
 receipt.source={archive:sourcePath,bytes:body.length,sha256:entry.sha256};
 // A later edition of the same product: the Rapid Service re-issues its predictions, here the last predicted day's x polar motion
 // (columns 19-27, arcseconds) moved by one millisecond of arc.
 const lines=body.toString('latin1').split('\n'),last=lines.findLastIndex(line=>line.slice(16).trim().length>0);
 lines[last]=lines[last].slice(0,18)+(Number(lines[last].slice(18,27))+0.001).toFixed(6).padStart(9)+lines[last].slice(27);
 const laterBody=Buffer.from(lines.join('\n'),'latin1');

 // Offline: the committed standalone eop-parser on each edition, through the SDK's JS host. Its row logic is the flow's (one
 // source, last changed with the parser); the standalone eop-request artifact predates the USNO source and is not used.
 const parserWasm=path.join(modules,'data-source/eop-parser/dist/isomorphic/module.wasm'),parserManifest=JSON.parse(await fs.readFile(path.join(modules,'data-source/eop-parser/plugin-manifest.json'),'utf8'));
 parser=await createBrowserModuleHarness({wasmSource:await fs.readFile(parserWasm),manifest:parserManifest,surface:'direct'});
 async function edition(text){
  const input=frame('response',encodeHttpResponse({url:USNO_URL,status:200,body:text,headers:{},retrievedMs:Date.now()}),'HttpResponse.fbs','HRSP','HttpResponse');
  const parsed=await parser.invoke({methodId:'parse_finals2000a',inputs:[input]});assert.equal(parsed.statusCode,0,parsed.errorMessage);
  const stream=Buffer.from(parsed.outputs.find(o=>o.portId==='records').payload),rows=records(stream);
  const meta=decodeIngestRequest(parsed.outputs.find(o=>o.portId==='meta').payload),cid='f01551220'+hash(text);
  assert.equal(rows.length,Number(meta.provenance.normalizedCount));assert(rows.length>19000,`${rows.length} rows`);
  assert(rows.every(({row})=>row.DATA_SET_CID===cid),'Every row names the exact file by CID');
  return {body:text,sha256:hash(text),cid,input,stream,rows};
 }
 const first=await edition(body),later=await edition(laterBody);
 const unlike=first.rows.filter(({row},i)=>{const {DATA_SET_CID,...rest}=row,{DATA_SET_CID:other,...next}=later.rows[i].row;return !Object.is(JSON.stringify(rest),JSON.stringify(next));});
 assert.equal(unlike.length,1,'The later edition differs by one day');
 receipt.offline={streamBytes:first.stream.length,rows:first.rows.length,first:first.rows[0].row.DATE,last:first.rows.at(-1).row.DATE,dataSetCid:first.cid,laterEditionDay:unlike[0].row.DATE};await save();
 console.log(`PASS offline parse: ${first.rows.length} rows ${first.rows[0].row.DATE} .. ${first.rows.at(-1).row.DATE}; a later edition differs on ${unlike[0].row.DATE}`);
 await parser.destroy();parser=null;
 // The same parse on the headless browser and on native WasmEdge: identical output bytes (Docker waived by owner ruling).
 receipt.runtimeParity=await runtimeParity({wasmPath:parserWasm,manifest:parserManifest,evidence,cases:[{methodId:'parse_finals2000a',inputs:[first.input]}]});
 await save();console.log('PASS headless-browser/native WasmEdge byte parity on the real file; Docker waived by owner ruling');

 // The node's archive mirror: the edition under the digest of the URL the flow asks for, with every request kept.
 const served=[],missed=[];let serving=first;
 mirror=http.createServer((request,response)=>{
  served.push({path:request.url,validator:request.headers['if-modified-since']||null,edition:serving.sha256});
  if(request.url!=='/'+hash(Buffer.from(USNO_URL))){missed.push(request.url);response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':'text/plain','content-length':serving.body.length,'last-modified':new Date().toUTCString()});response.end(serving.body);
 });
 await new Promise(resolve=>mirror.listen(0,'127.0.0.1',resolve));

 // The scratch node, the signed flow, the owner's installer config and AOT, all before the first scheduled run.
 assert(process.env.SDN_NODE_BINARY&&process.env.SDN_JS,'SDN_NODE_BINARY and SDN_JS must name builds of SDN origin/main');
 const ops=process.env.GAUNTLET_CANDIDATE_OPS||process.env.SPACEWX_OPS;assert(ops,'GAUNTLET_CANDIDATE_OPS (or SPACEWX_OPS) must name the owner installer candidate');
 const binary=path.resolve(process.env.SDN_NODE_BINARY);
 node=await localNode(binary);node.program=program;receipt.nodeDirectory=node.dir;await save();
 const info=await node.start();console.log('PASS scratch node ready');
 const flowDir=path.join(modules,'flows/eop/dist/runtime'),portable=await fs.readFile(path.join(flowDir,'runtime.wasm'));
 const signing=await fetch(node.base+'/api/v1/admin/modules/sign',{method:'POST',headers:{'Content-Type':'application/wasm'},body:portable,signal:AbortSignal.timeout(30000)});
 assert(signing.ok,`Sign ${signing.status}`);const signature=await signing.json();assert.equal(signature.content_hash,hash(portable));
 assert(info.keys.some(k=>k.public_key===signature.public_key_hex&&k.address_type==='ed25519'));
 const bundle=await createSingleFileBundle({wasmBytes:portable,signature:signature.signature_entry});
 const signed=appendPublicationRecordCollection(portable,encodePublicationRecordCollection({mbl:bundle.bundle}));
 assert((await verifyModuleArtifact(signed,{requireSignature:true,trustedPublicKeys:[signature.public_key_hex]})).verified);
 await node.stop();
 const target=path.join(node.dir,'flows',program);await fs.cp(flowDir,target,{recursive:true});
 for(const name of ['runtime.wasm','isomorphic/module.wasm'])await fs.writeFile(path.join(target,name),signed);
 await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});
 await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals:['http','storage_ingest'].map(capability=>({module_hash:hash(portable),capability,plugin_id:program,
  approved_at:new Date().toISOString(),approved_by:'eop-flow-e2e',note:'Isolated scratch-node acceptance'}))}));
 // The owner's installer merges the joint services and lanes; this node installs only the EOP flow, so only its service stays.
 node.config.publishing.allowed_schemas=[]; // Empty means unrestricted, not EOP-only.
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 const python=process.env.SPACEWX_PYTHON||'python3';
 await command(python,[path.join(ops,'deployment/space-weather-provider-node/deploy/host-config.py'),node.configPath,'apply'],{stdio:'inherit'});
 const merged=JSON.parse(execFileSync(python,['-c','import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',node.configPath],{encoding:'utf8'}));
 assert.deepEqual(merged.publishing.allowed_schemas,[],'The installer preserves unrestricted publication');
 assert.deepEqual(merged.admin,node.config.admin);assert.deepEqual(merged.network,node.config.network);
 const service=merged.flows.services.find(s=>s.flow===program);assert(service,'The installer schedules the EOP flow');
 assert.deepEqual(service.intervals,{daily:'24h'});assert.equal(service.retrieval_interval,'23h');assert.equal(service.exclusive_group,'space-weather');
 const eopLane=merged.publishing.auto_publish.find(l=>l.schema==='EOP.fbs');
 assert.deepEqual(eopLane,{schema:'EOP.fbs',provider_id:'eop',source_name:'usno-finals2000a',min_interval:'23h',max_shard_bytes:16777216,settle:'10s'});
 assert(merged.publishing.retention.lanes.some(l=>l.schema==='EOP.fbs'&&l.provider_id==='eop'&&l.source_name==='usno-finals2000a'&&l.keep_series===2));
 receipt.installer='PASS: the owner config merger scheduled the flow and armed and retained the lane';
 // Only the clock is shortened on this scratch node, so the daily runs that follow the first happen within the test: a run every 25 s,
 // the lane's spacing 1 s. The lane, its license, the shard budget and the mirror are as merged.
 Object.assign(node.config,merged);
 node.config.flows.services=[{...service,intervals:{daily:'25s'},retrieval_interval:'1s',config:{eop_archive_url:`http://127.0.0.1:${mirror.address().port}`}}];
 node.config.publishing.auto_publish=merged.publishing.auto_publish.map(l=>l.schema==='EOP.fbs'?{...l,min_interval:'1s'}:l);
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 const log=await fs.open(path.join(node.dir,'prewarm.log'),'w');
 try{await command(binary,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
 receipt.aot={status:'PASS: the node prewarm-aot compiled the exact signed artifact (WasmEdge 0.16.4)',portableSha256:hash(portable),signedSha256:hash(signed),binarySha256:hash(await fs.readFile(binary))};
 await save();await node.start();console.log('PASS signed flow installed, AOT prewarmed, scratch node ready');

 // A separate SDN client finds the publications over binary sync and reads manifest and shard by CID.
 const sdn=await import(pathToFileURL(path.join(process.env.SDN_JS,'dist/index.mjs')));
 const addrs=[`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws/p2p/${info.peer_id}`];
 client=await sdn.createHeliaSDNNode({edgeRelays:addrs,enableAutoDial:false,enableDHT:false,enableIdentify:true,allowPrivateAddressDial:true});
 const healthy=async()=>assert(!(await fs.readFile(path.join(node.dir,'sdn.log'),'utf8')).includes('Configured flow service startup failed'),'Flow startup failed; '+node.dir+'/sdn.log');
 async function publications(){
  const peer=client.libp2p.getConnections().find(c=>String(c.remotePeer)===info.peer_id)?.remotePeer;if(!peer)return [];
  const listing=await client.libp2p.dialProtocol(peer,sdn.FLATSQL_SYNC_LIST_PUBLISHED_PROTOCOL_ID),chunks=[];const reading=(async()=>{for await(const c of listing)chunks.push(c instanceof Uint8Array?c:c.subarray());})();
  if(!listing.send(sdn.encodeFlatSqlPublishedListRequest(lane)))await listing.onDrain?.();await listing.close();await reading;
  return sdn.decodeFlatSqlPublishedList(Buffer.concat(chunks)).publications.filter(p=>p.providerId===lane.providerId&&p.sourceName===lane.sourceName).sort((a,b)=>b.publishedAtMs-a.publishedAtMs);
 }
 async function until(what,ms,test){for(const end=Date.now()+ms;;){await healthy();const value=await test();if(value)return value;assert(Date.now()<end,`${what} did not happen within ${ms/1000} seconds; ${node.dir}/sdn.log`);await new Promise(r=>setTimeout(r,2000));}}
 const fetchCid=async cid=>Buffer.from(await sdn.fetchCIDBytesFromHelia(client.helia,cid,{providerAddrs:addrs,maxBytes:64<<20}));
 // One publication: the signed manifest (provider, license, citation) and its one shard, decoded.
 async function readBack(publication){
  const manifestBytes=await fetchCid(publication.manifestCid);
  const dpm=(manifestBytes.subarray(8,12).toString()==='$DPM'?DPM.getSizePrefixedRootAsDPM:DPM.getRootAsDPM)(new ByteBuffer(manifestBytes)).unpack();
  assert.equal(dpm.PROVIDER_PEER_ID,info.peer_id);assert(dpm.PROVIDER_SIGNATURE.length>0);
  const source=dpm.SOURCES.find(s=>s.SOURCE_NAME===lane.sourceName);assert(source,'Manifest source');
  assert.equal(source.LICENSE,LICENSE);assert(source.CITATION.includes('Naval Observatory')&&source.CITATION.includes('public domain'),source.CITATION);
  const shards=dpm.ASSETS.filter(a=>a.ASSET_KIND===publicationAssetKind.DATA_SHARD&&a.SCHEMA_NAME==='EOP.fbs');assert.equal(shards.length,1,'One shard holds the edition');
  const asset=shards[0];assert.equal(asset.CID,publication.shardCid);
  let shard=await fetchCid(asset.CID);assert.equal(hash(shard),asset.BYTE_SHA256.toLowerCase());assert.equal(shard.length,Number(asset.BYTE_LENGTH));
  const shardBytes=shard.length;if(shard[0]===31&&shard[1]===139)shard=gunzipSync(shard);
  return {manifestCid:publication.manifestCid,shardCid:asset.CID,publishedAtMs:publication.publishedAtMs,rows:records(shard),shardBytes,recordBytes:shard.length,license:source.LICENSE,citation:source.CITATION};
 }
 // The values: every published record equals eop-parser's offline parse of the edition, field for field (and byte for byte).
 function equal(published,offline){
  assert.equal(published.length,offline.rows.length);
  const byDate=new Map(published.map(({row})=>[row.DATE,row]));assert.equal(byDate.size,published.length,'No date twice');
  for(const {row} of offline.rows)assert.deepStrictEqual(byDate.get(row.DATE),row,'Row '+row.DATE);
  const bytes=new Map(offline.rows.map(({row,bytes})=>[row.DATE,bytes]));
  return {rows:offline.rows.length,fieldForField:true,bytewise:published.every(({row,bytes:b})=>bytes.get(row.DATE).equals(b))};
 }
 const firstPublication=(await until('The first EOP publication',300000,async()=>(await publications())[0]));
 const one=await readBack(firstPublication);
 receipt.publication={provider:info.peer_id,manifestCid:one.manifestCid,shardCid:one.shardCid,publishedAtMs:one.publishedAtMs,rows:one.rows.length,shardBytes:one.shardBytes,recordBytes:one.recordBytes,license:one.license,citation:one.citation};
 await save();console.log(`PASS scheduled native flow -> signed EOP publication -> independent SDN CID readback: ${one.rows.length} rows`);
 receipt.equality=equal(one.rows,first);
 assert(missed.length===0&&served.length>=1,`Mirror requests ${JSON.stringify(served)}`);
 assert(served.every(s=>s.validator===WHOLE_FILE),'Every request asks for the whole file');
 receipt.mirror={requests:served.length,validator:WHOLE_FILE};
 console.log(`PASS equality: ${first.rows.length} records equal the offline parse (bytewise: ${receipt.equality.bytewise})`);

 // The owner's live check, unchanged, against this scratch node: the same code the coordinator runs on host-02.
 const live=execFileSync(process.execPath,[path.join(ops,'deployment/space-weather-provider-node/live-check.mjs'),modules,process.env.SDN_JS],
  {encoding:'utf8',timeout:240000,env:{...process.env,SPACEWX_LIVE_LANES:'eop',SPACEWX_LIVE_PEER:info.peer_id,SPACEWX_LIVE_ADDR:`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws`}});
 assert(live.includes('PASS EOP.fbs'),live);receipt.liveCheck=live.split('\n').slice(0,2).join(' ');
 console.log(live.split('\n')[0]);

 // The daily timer keeps running. The same file again publishes nothing; a later edition replaces the first.
 await until('A second daily run of the unchanged file',120000,async()=>served.filter(s=>s.edition===first.sha256).length>=2);
 await new Promise(r=>setTimeout(r,30000)); // past the lane's settle time and the next run's ingest
 const unchanged=await publications();
 assert.equal(unchanged.length,1,'An unchanged file publishes nothing');assert.equal(unchanged[0].manifestCid,one.manifestCid);
 receipt.refresh={unchangedRuns:served.filter(s=>s.edition===first.sha256).length,republished:false};
 console.log(`PASS the unchanged file ran ${receipt.refresh.unchangedRuns} times and published nothing`);
 serving=later;
 const second=await readBack(await until('The later edition\'s publication',180000,async()=>(await publications()).find(p=>p.manifestCid!==one.manifestCid)));
 const replaced=equal(second.rows,later);
 assert(second.rows.every(({row})=>row.DATA_SET_CID===later.cid),'The later edition names its own file');
 const before=new Map(one.rows.map(({row})=>[row.DATE,row])),moved=second.rows.filter(({row})=>{const {DATA_SET_CID,...rest}=row,{DATA_SET_CID:other,...old}=before.get(row.DATE);return JSON.stringify(rest)!==JSON.stringify(old);});
 assert.equal(moved.length,1);assert.equal(moved[0].row.DATE,unlike[0].row.DATE);
 receipt.refresh={...receipt.refresh,republished:true,laterEdition:{manifestCid:second.manifestCid,shardCid:second.shardCid,rows:second.rows.length,changedDay:moved[0].row.DATE,equality:replaced}};
 console.log(`PASS the later edition published ${second.rows.length} rows, equal to its offline parse; one day changed: ${moved[0].row.DATE}`);
 await healthy();
 receipt.status='PASS';passed=true;await save();
 console.log('PASS '+JSON.stringify({rows:one.rows.length,manifestCid:one.manifestCid,shardCid:one.shardCid,equality:receipt.equality,mirror:receipt.mirror,refresh:receipt.refresh,aot:receipt.aot.signedSha256}));
} catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.stack);}
finally{
 if(parser)await parser.destroy();
 if(client)await client.stop();
 if(node)await node.stop();
 if(mirror)await new Promise(resolve=>mirror.close(resolve));
 receipt.completedAt=new Date().toISOString();await save();
 // A pass leaves nothing behind; a failure keeps the scratch node and its log for inspection.
 if(passed&&!process.env.EOP_KEEP_EVIDENCE){if(node)await fs.rm(node.dir,{recursive:true,force:true});await fs.rm(evidence,{recursive:true,force:true});console.log('Scratch directories removed');}
 else console.log('Evidence: '+evidence+(node?'\nNode: '+node.dir:''));
}
// All owned runtimes and nodes are stopped above; terminate residual third-party client timers.
process.exit(process.exitCode||0);
