import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {modules,require,decodeHttpResponse,ByteBuffer,S} from './inputs.mjs';
import {localNode} from '../../../data-source/space-weather/tests/local-node.mjs';
import {offline} from './offline.mjs';
import {verifyInputs} from './verify-inputs.mjs';
const dir=process.env.OPEN_DCA_CAPTURE;assert(dir,'OPEN_DCA_CAPTURE must name prepared private real-source inputs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const {createSingleFileBundle,verifyModuleArtifact}=await import(pathToFileURL(require.resolve('space-data-module-sdk/bundle')));
const {appendPublicationRecordCollection,encodePublicationRecordCollection}=await import(pathToFileURL(require.resolve('space-data-module-sdk/transport')));
const {DPM}=await import(pathToFileURL(require.resolve('spacedatastandards.org/lib/js/DPM/DPM.js')));
const {solveCommonMode,arcCenterOffsetMs,sAt}=await import(pathToFileURL(path.join(process.env.OPEN_DCA_ORACLE,'experiments/e13-open-dca/common-mode.mjs')));
const evidence=await fs.mkdtemp(path.join(os.tmpdir(),'open-dca-node-e2e-'));
const receipt={status:'RUNNING',started:new Date().toISOString(),docker:'WAIVED: owner 2026-10-22'};
const save=()=>fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
const command=(bin,args,options)=>new Promise((resolve,reject)=>{const c=spawn(bin,args,options);c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(Error(`${path.basename(bin)} exited ${code}`)));});
let node,client,server;
try{
 const capture=JSON.parse(await fs.readFile(path.join(dir,'capture.json')));
 // A real-source replay can cross UTC midnight. The current timer's complete
 // URL window is enforced by the archive-miss check below; source timestamps
 // remain intact, and the published correction must still originate in this run.
 const runStarted=Date.parse(receipt.started),captureAge=runStarted-capture.issue;
 assert(captureAge>=0&&captureAge<86400000,'Capture must be less than 24 hours old');
 receipt.inputs=await verifyInputs(dir);await save();
 const sources=new Map();for(const group of capture.groups)for(let i=0;i<group.requests;i++){const r=decodeHttpResponse(await fs.readFile(path.join(dir,`${group.name}-${i}.fb`)));sources.set('/'+hash(r.url),r);}
 // Generic loopback HTTP archive: preserves source bodies and Last-Modified;
 // no upstream IERS/USNO requests, TLS bypass, production state, or host code.
 const misses=[];server=http.createServer((req,res)=>{const r=sources.get(req.url);if(!r){misses.push(req.url);res.writeHead(404);res.end();return;}for(const [k,v]of Object.entries(r.headers||{}))if(!['content-length','content-encoding','transfer-encoding','connection'].includes(k.toLowerCase()))res.setHeader(k,v);res.writeHead(r.status||200);res.end(r.body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 node=await localNode(process.env.SDN_NODE_BINARY);const info=await node.start();receipt.nodeDirectory=node.dir;await save();
 const approvals=[],signedFlows=[];
 for(const slug of ['space-weather','open-dca']){
  const flowDir=path.join(modules,`flows/${slug}/dist/runtime`),portable=await fs.readFile(path.join(flowDir,'runtime.wasm'));
  const response=await fetch(node.base+'/api/v1/admin/modules/sign',{method:'POST',headers:{'Content-Type':'application/wasm'},body:portable});assert(response.ok,`Sign ${slug}: ${response.status}`);const sig=await response.json();assert.equal(sig.content_hash,hash(portable));
  const bundle=await createSingleFileBundle({wasmBytes:portable,signature:sig.signature_entry});const signed=appendPublicationRecordCollection(portable,encodePublicationRecordCollection({mbl:bundle.bundle}));assert((await verifyModuleArtifact(signed,{requireSignature:true,trustedPublicKeys:[sig.public_key_hex]})).verified);
  const program=`com.digitalarsenal.flows.${slug}`;signedFlows.push({flowDir,program,signed});
  approvals.push(...['http','storage_ingest'].map(capability=>({module_hash:hash(portable),capability,plugin_id:program,signer_public_key:sig.public_key_hex,note:'Isolated DCA E2E'})));
  if(slug==='open-dca')receipt.artifactSha256=hash(portable);
 }
 await node.stop();
 for(const {flowDir,program,signed}of signedFlows){const target=path.join(node.dir,'flows',program);await fs.cp(flowDir,target,{recursive:true});for(const name of ['runtime.wasm','isomorphic/module.wasm'])await fs.writeFile(path.join(target,name),signed);}
 const ops=process.env.GAUNTLET_CANDIDATE_OPS||process.env.SPACEWX_OPS;assert(ops,'SPACEWX_OPS must name the owner installer candidate');
 const python=process.env.SPACEWX_PYTHON||'python3',deploy=path.join(ops,'deployment/space-weather-provider-node/deploy/host-config.py');
 node.config.publishing.allowed_schemas=[];
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));
 await command(python,[deploy,node.configPath,'apply'],{stdio:'inherit'});
 const merged=JSON.parse(execFileSync(python,['-c','import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',node.configPath],{encoding:'utf8'}));
 assert.deepEqual(merged.publishing.allowed_schemas,[]);assert.deepEqual(merged.admin,node.config.admin);assert.deepEqual(merged.network,node.config.network);
 Object.assign(node.config,merged);
 node.config.flows.services.find(s=>s.flow==='com.digitalarsenal.flows.open-dca').config={open_dca_archive_url:`http://127.0.0.1:${server.address().port}`};
 receipt.deploymentConfig='PASS: actual owner merger, both signed flows, capabilities before boot';
 await fs.mkdir(path.join(node.dir,'data/modules'),{recursive:true});await fs.writeFile(path.join(node.dir,'data/modules/capability_policy.json'),JSON.stringify({version:1,approvals}));
 await fs.writeFile(node.configPath,JSON.stringify(node.config,null,2));const log=await fs.open(path.join(node.dir,'prewarm.log'),'w');try{await command(process.env.SDN_NODE_BINARY,['prewarm-aot','--config',node.configPath],{cwd:node.dir,env:node.env,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
 await node.start();console.log('Signed/AOT scratch node ready; awaiting scheduled DCA: '+node.dir);await save();
 assert(process.env.SDN_JS);const sdn=await import(pathToFileURL(path.join(process.env.SDN_JS,'dist/index.mjs'))),addrs=[`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws/p2p/${info.peer_id}`];
 client=await sdn.createHeliaSDNNode({edgeRelays:addrs,enableAutoDial:false,enableDHT:false,enableIdentify:true,allowPrivateAddressDial:true});
 let publications=[];const deadline=Date.now()+90*60*1000;
 while(Date.now()<deadline&&!publications.length){assert(!(await fs.readFile(path.join(node.dir,'sdn.log'),'utf8')).includes('Configured flow service startup failed'),'Flow startup failed; '+node.dir+'/sdn.log');assert.deepEqual(misses,[],'Archive missing source: capture the current complete day window');const peer=client.libp2p.getConnections().find(c=>String(c.remotePeer)===info.peer_id)?.remotePeer;if(peer){const stream=await client.libp2p.dialProtocol(peer,sdn.FLATSQL_SYNC_LIST_PUBLISHED_PROTOCOL_ID);const chunks=[];const reading=(async()=>{for await(const c of stream)chunks.push(c instanceof Uint8Array?c:c.subarray());})();if(!stream.send(sdn.encodeFlatSqlPublishedListRequest({schema:'DCL.fbs',providerId:'open-dca',sourceName:'planet-nrlmsise00'})))await stream.onDrain?.();await stream.close();await reading;publications=sdn.decodeFlatSqlPublishedList(Buffer.concat(chunks)).publications.filter(p=>p.providerId==='open-dca'&&p.sourceName==='planet-nrlmsise00');}if(!publications.length)await new Promise(r=>setTimeout(r,5000));}
 assert(publications.length,'No DCL publication; '+node.dir+'/sdn.log');const pub=publications.sort((a,b)=>b.publishedAtMs-a.publishedAtMs)[0];
 const fetchCid=async cid=>Buffer.from(await sdn.fetchCIDBytesFromHelia(client.helia,cid,{providerAddrs:addrs,maxBytes:1048576}));const mb=await fetchCid(pub.manifestCid),manifest=(mb.subarray(8,12).toString()==='$DPM'?DPM.getSizePrefixedRootAsDPM:DPM.getRootAsDPM)(new ByteBuffer(mb)).unpack();assert.equal(manifest.PROVIDER_PEER_ID,info.peer_id);assert(manifest.PROVIDER_SIGNATURE.length);
 const source=manifest.SOURCES.find(s=>s.SOURCE_NAME==='planet-nrlmsise00');assert.match(source.LICENSE,/CC-BY-NC-4.0/);assert.match(source.CITATION,/Planet/);
 const asset=manifest.ASSETS.find(a=>a.CID===pub.shardCid&&a.SCHEMA_NAME==='DCL.fbs');assert(asset);let bytes=await fetchCid(pub.shardCid);assert.equal(hash(bytes),asset.BYTE_SHA256.toLowerCase());if(bytes[0]===31&&bytes[1]===139)bytes=gunzipSync(bytes);
 assert.equal(bytes.readUInt32LE(0)+4,bytes.length,'Exactly one aggregate');const actual=S.DCL.getSizePrefixedRootAsDCL(new ByteBuffer(bytes)).unpack();assert.equal(actual.OBJECTS.length,0);assert.equal(actual.STATES,null);assert.equal(actual.CORRECTION.FORM,S.dclCorrectionForm.LogDensityNodes);assert(actual.PROVENANCE);assert.match(actual.PROVENANCE.LINEAGE,/earth_orientation-typed-sha256=/);assert(Number(actual.CREATED_AT_MS)>=runStarted&&Number(actual.CREATED_AT_MS)<=Date.now(),'Published correction must originate in this scheduled run');
 console.log('DCL publication read by CID; comparing full independent offline E13 run');await fs.writeFile(path.join(evidence,'published.dclfb'),bytes);
 const reference=await offline(dir),issue=Number(actual.CREATED_AT_MS),arcs=reference.arcs.filter(a=>a.startMs>=issue-30*86400000),anchorMs=Math.round(Math.floor(issue/86400000)*86400000+arcCenterOffsetMs(arcs));
 const expected=solveCommonMode(arcs,{anchorMs,nodeHours:24,baseline:{kind:'randomWalk',stepSigma:0.005},smoothSigma:0.05,huberK:1.5,iterations:60,tolerance:1e-5,minDovesPerNode:6,minNodeInfo:1.5,scaleSweeps:8});assert(expected.converged);
 let maxError=0;for(let i=0;i<actual.CORRECTION.NODE_TIMES_MS.length;i++){const t=Number(actual.CORRECTION.NODE_TIMES_MS[i]);maxError=Math.max(maxError,Math.abs(actual.CORRECTION.NODE_LOG_DENSITY_SCALE_DIMENSIONLESS[i]-sAt(expected,t,null)));}assert(maxError<2e-9,`Offline E13 delta ${maxError}`);
 receipt.status='PASS';receipt.publication={manifestCid:pub.manifestCid,shardCid:pub.shardCid,publishedAtMs:pub.publishedAtMs,nodes:actual.CORRECTION.NODE_TIMES_MS.length};receipt.reference={arcs:arcs.length,maxError,maxRelativeB:reference.maxRelativeB,maxRelativeSigma:reference.maxRelativeSigma};console.log('PASS signed scheduled local node -> CID -> full offline E13 equality');
}catch(error){receipt.status='FAIL';receipt.error=error.stack;process.exitCode=1;console.error(error.stack);}finally{if(client)await client.stop();if(node)await node.stop();if(server)await new Promise(r=>server.close(r));receipt.completed=new Date().toISOString();await save();console.log('Evidence: '+evidence);}
process.exit(process.exitCode||0);
