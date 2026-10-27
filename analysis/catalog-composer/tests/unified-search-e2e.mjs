// Real published APP -> composer WASM -> SDS XMT -> unified FlatSQL -> search UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseSingleFileBundle } from 'space-data-module-sdk/bundle';
import { decodeAppManifest } from 'space-data-module-sdk/app';
import { FlatcRunner } from 'flatc-wasm/runner';
const root=new URL('../',import.meta.url), evidence=process.env.FLATSQL_BROWSER_RESULTS??await fs.mkdtemp(path.join(os.tmpdir(),'catalog-unified-e2e-'));
await fs.mkdir(evidence,{recursive:true});
const bundle=await parseSingleFileBundle(await fs.readFile(new URL('dist/isomorphic/module.wasm',root)));
const app=decodeAppManifest(bundle.entries.find(e=>e.entryId==='app.app').payloadBytes);
const page=gunzipSync(Buffer.from(app.pages.find(p=>p.entry).content,'base64'));
const compiler=await FlatcRunner.init();
const schema={};
for(const code of ['CAT','DSS']) {
 const files={};
 const visit=async family=>{const name=family+'/main.fbs';if(files[name])return;const source=await fs.readFile(new URL(`node_modules/spacedatastandards.org/schema/${name}`,root),'utf8');files[name]=source;for(const match of source.matchAll(/include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/g))await visit(match[1]);};
 await visit(code);schema[code]={entry:code+'/main.fbs',files};
}
const binary=(code,fields)=>compiler.generateBinary(schema[code],JSON.stringify(fields),{sizePrefix:true,strictJson:true});
const records=Array.from({length:205},(_,i)=>binary('CAT',{OBJECT_NAME:i===204?'München optical payload':`Orbit object ${i+1}`,OBJECT_ID:`2020-${String(i+1).padStart(3,'0')}A`,NORAD_CAT_ID:i===204?25544:i+1}));
const streams={catalog:Buffer.concat(records),alpha:Buffer.concat(records),beta:Buffer.from(records.at(-1))};
const node='peer-e2e',source='objects',hash=b=>createHash('sha256').update(b).digest('hex');
const lanes=Object.entries(streams).map(([provider,stream])=>({provider,stream,count:provider==='beta'?1:205,manifest:`manifest-${provider}`}));
const discovery=Buffer.concat(lanes.flatMap(l=>['CAT',...(l.provider==='catalog'?[]:['OMM'])].map(code=>binary('DSS',{SCHEMA_NAME:code+'.fbs',PROVIDER_PEER_ID:node,PROVIDER_ID:l.provider,SOURCE_NAME:source,LAST_PUBLICATION_CID:l.manifest,TOTAL_ROWS:l.count,FEED_HEAD:`head-${l.provider}`}))));
let configuration={version:2,layers:[],stateSources:['alpha','beta'].map(p=>JSON.stringify([node,p,source])),asOf:1700000000,overrides:{}};
const headers={'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','cross-origin-resource-policy':'same-origin'};
const jsonResponse=(res,data)=>{res.writeHead(200,{'content-type':'application/json',...headers});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://local');
 if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html',...headers});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style><iframe id="app" src="/app" allow="cross-origin-isolated"></iframe><script>
 addEventListener('message',event=>{if(event.data?.type!=='sdn-app-ready')return;const channel=new MessageChannel();channel.port1.onmessage=async({data})=>{try{let value;if(data.method==='module'){value={bytes:new Uint8Array(await(await fetch('/module')).arrayBuffer())};}else{const params={...data.params};if(params.body)params.body=Array.from(params.body);const response=await fetch('/bridge',{method:'POST',body:JSON.stringify({method:data.method,params})});value=await response.json();if(value?.body)value.body=new Uint8Array(value.body);}channel.port1.postMessage({id:data.id,value});}catch(error){channel.port1.postMessage({id:data.id,error:String(error)})}};event.source.postMessage({type:'sdn-app-connect'},'*',[channel.port2]);});</script>`);return;}
 if(url.pathname==='/app'){res.writeHead(200,{'content-type':'text/html',...headers});res.end(page);return;}
 if(url.pathname==='/module'){res.writeHead(200,{'content-type':'application/wasm',...headers});res.end(bundle.canonicalWasmBytes);return;}
 if(url.pathname==='/favicon.ico'){res.writeHead(204,headers);res.end();return;}
 if(url.pathname==='/bridge'){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const {method,params}=JSON.parse(Buffer.concat(chunks));
  if(method==='configuration.read'){jsonResponse(res,configuration);return;}
  if(method==='configuration.write'){configuration=params.value;jsonResponse(res,null);return;}
  if(method==='cancel'){jsonResponse(res,null);return;}
  if(method!=='request')throw new Error('Unexpected host method '+method);
  if(params.path==='/api/v1/sync'){jsonResponse(res,{status:200,headers:{},body:Array.from(discovery)});return;}
  const q=JSON.parse(Buffer.from(params.body).subarray(4)),lane=lanes.find(l=>l.provider===q.provider_id);assert(lane);
  const scope={schema:'CAT.fbs',provider_id:lane.provider,source_name:source,query_profile:'dataset-publication-offset-v1'};
  const pub={...scope,offset:0,record_count:lane.count,byte_count:lane.stream.length,batch_id:'current',manifest_cid:lane.manifest,shard_cid:`bafypublication${lane.provider}`,shard_sha256:hash(lane.stream),feed_head:`head-${lane.provider}`};
  let metadata,body=Buffer.alloc(0);
  if(q.op==='list_published_shards')metadata={...scope,status:'ok',publication_offset:0,publication_count:1,total_publication_count:1,publications:[pub]};
  else{assert.equal(q.op,'read_published_shard');body=lane.stream.subarray(q.byte_offset,q.byte_offset+q.byte_length);metadata={...scope,status:'ok',immutable_bytes:true,cid:pub.shard_cid,batch_id:pub.batch_id,shard_sha256:pub.shard_sha256,total_byte_count:pub.byte_count,byte_offset:q.byte_offset,byte_length:q.byte_length};}
  const encoded=Buffer.from(JSON.stringify(metadata)),length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);
  jsonResponse(res,{status:200,headers:{'X-SDN-Remote-Peer':node},body:Array.from(Buffer.concat([length,encoded,body]))});return;
 }
 res.writeHead(404,headers);res.end();
}catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function shell(){if(process.env.GAUNTLET_HEADLESS_SHELL)return process.env.GAUNTLET_HEADLESS_SHELL;const cache=process.env.PLAYWRIGHT_BROWSERS_PATH??path.join(os.homedir(),process.platform==='darwin'?'Library/Caches/ms-playwright':'.cache/ms-playwright');for(const dir of (await fs.readdir(cache)).filter(d=>/^chromium_headless_shell-\d+$/.test(d)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])))for(const sub of await fs.readdir(path.join(cache,dir))){const bin=path.join(cache,dir,sub,'chrome-headless-shell');try{await fs.access(bin);return bin;}catch{}}throw new Error('Chromium headless shell required');}
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-headless-'));
const child=spawn(await shell(),['--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader',...(process.platform==='linux'?['--no-sandbox']:[]),'about:blank'],{stdio:['ignore','ignore','pipe']});let socket;
try{
 const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Browser startup timed out')),20000);child.on('error',reject);child.stderr.on('data',b=>{output+=b;const m=output.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);if(m){clearTimeout(timer);resolve(Number(m[1]));}});});
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let serial=0;const pending=new Map(),errors=[];socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails?.exception?.description??m.params.exceptionDetails.text);else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map(a=>a.value??a.description).join(' '));};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 const doc="document.getElementById('app').contentDocument";
 const value=id=>`${doc}.getElementById(${JSON.stringify(id)})`;
 const wait=async(expression,label)=>{const until=Date.now()+45000;while(Date.now()<until){try{if(await evaluate(expression))return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(`Timed out ${label}: ${await evaluate(`${doc}?.body.innerText`)}\n${await evaluate("document.getElementById('app').contentWindow.__decodeFailure")}`);};
 const click=async id=>evaluate(`${value(id)}.click()`);
 const shot=async name=>{const s=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'));};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:"const originalDecode=TextDecoder.prototype.decode;TextDecoder.prototype.decode=function(...args){try{return originalDecode.apply(this,args)}catch(error){globalThis.__decodeFailure=error.stack;throw error}}"});await send('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await wait(`${value('status')}?.textContent==='Ready'`,'APP ready');
 assert.equal(await evaluate("document.getElementById('app').contentWindow.crossOriginIsolated"),true);
 await evaluate(`${value('source-picker')}.value=${JSON.stringify(JSON.stringify([node,'catalog',source,'CAT']))}`);await click('add');await click('compose');
 await wait(`${value('count')}.textContent==='205 objects'`,'composition/search index');assert.equal(await evaluate(`${value('rows')}.children.length`),100);
 await click('next');await wait(`${value('page-info')}.textContent==='Page 2 of 3'`,'page 2');await click('next');await wait(`${value('rows')}.children.length===5`,'page 3');
 const search=async text=>{await evaluate(`${value('search')}.value=${JSON.stringify(text)};${value('search')}.dispatchEvent(new Event('input'))`);};
 await search('optical munchen');await wait(`${value('count')}.textContent==='1 objects'`,'full-catalog Unicode search');assert.match(await evaluate(`${value('rows')}.innerText`),/München optical payload/);await shot('catalog-search-desktop');
 await search('2020-205A');await wait(`${value('rows')}.innerText.includes('München')`,'nested designator search');
 await search('');await wait(`${value('count')}.textContent==='205 objects'`,'clear search');await click('review-overlaps');await wait(`${value('count')}.textContent==='1 objects'`,'overlap filter');
 await evaluate(`${value('rows')}.firstElementChild.click()`);await wait(`${value('object-editor')}.open`,'review selected object');assert.match(await evaluate(`${value('object-title')}.textContent`),/München/);
 await evaluate(`${value('object-editor')}.close()`);
 await click('compose');await wait(`!${value('compose')}.disabled`,'repeated composition');assert.equal(await evaluate(`${value('status')}.classList.contains('error')`),false,await evaluate(`${value('status')}.textContent`));await wait(`${value('count')}.textContent==='1 objects'`,'replacement index');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await evaluate(`${value('search')}.scrollIntoView({block:'start'})`);await search('munchen');await wait(`${value('count')}.textContent==='1 objects'`,'mobile search');await shot('catalog-search-mobile');
 assert.deepEqual(errors,[]);
 console.log(`CATALOG UNIFIED E2E PASS: published APP, real composer, XMT binary FTS, all-page Unicode/designator search, pagination, overlap filter, object review. Screenshots: ${evidence}`);
}finally{socket?.close();child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000);});if(child.exitCode===null)child.kill('SIGKILL');server.close();await fs.rm(profile,{recursive:true,force:true});}
