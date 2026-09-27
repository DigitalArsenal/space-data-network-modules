// Headless acceptance probe using the actual embedded APP and host bridge.
// Run with PLAYWRIGHT_MODULE and SDN_APP_BRIDGE_MODULE pointing to installed
// tooling / the host repository. No daemon is launched or reconfigured.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {parseSingleFileBundle,computeCanonicalModuleHash} from 'space-data-module-sdk/bundle';
import {decodeAppManifest} from 'space-data-module-sdk/app';
import {opm} from '../tests/epoch-fixture.mjs';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=fileURLToPath(new URL('../',import.meta.url)),repo=path.resolve(root,'../..');
const bundle=await parseSingleFileBundle(await fs.readFile(path.join(root,'dist/isomorphic/module.wasm')));
const appBytes=bundle.entries.find(e=>e.entryId==='app.app').payloadBytes,app=decodeAppManifest(appBytes);
const page=gunzipSync(Buffer.from(app.pages[0].content,'base64'));
const modules=new Map([[bundle.manifest.pluginId,bundle.canonicalWasmBytes]]);
for(const relative of ['files/orbit-products','foundation/frames','foundation/time','propagator/hpop']) {
 const manifest=JSON.parse(await fs.readFile(path.join(repo,relative,'plugin-manifest.json')));
 const artifact=await computeCanonicalModuleHash(await fs.readFile(path.join(repo,relative,'dist/isomorphic/module.wasm')));modules.set(manifest.pluginId,artifact.canonicalWasmBytes);
}
const parent=await build({stdin:{resolveDir:root,contents:`import {createAppBridge,decodeModuleApp} from ${JSON.stringify(process.env.SDN_APP_BRIDGE_MODULE)};
const app=await decodeModuleApp(new Uint8Array(await (await fetch('/app.bin')).arrayBuffer()),${JSON.stringify(bundle.manifest.pluginId)});
const frame=document.createElement('iframe'); frame.title='Catalog Editor';frame.style='border:0;width:100%;height:100vh';
frame.sandbox='allow-scripts allow-forms allow-downloads';
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.type!=='sdn-app-ready')return;const bridge=createAppBridge({app,nodeId:'catalog-verification-local-node'}),channel=new MessageChannel();channel.port1.onmessage=({data})=>bridge.handle(data,reply=>channel.port1.postMessage(reply));frame.contentWindow.postMessage({type:'sdn-app-connect'},'*',[channel.port2]);});frame.src='/editor';document.body.append(frame);`},bundle:true,write:false,format:'esm',platform:'browser'});
const nodeOrigin=process.env.SDN_DEV_ORIGIN||'http://127.0.0.1:7184';
const observed=[];
const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><body style="margin:0"><script type="module" src="/parent.js"></script>');}
  else if(req.url==='/parent.js'){res.setHeader('Content-Type','text/javascript');res.end(parent.outputFiles[0].text);}
  else if(req.url==='/editor'){res.setHeader('Content-Type','text/html');res.end(page);}
  else if(req.url==='/app.bin')res.end(appBytes);
  else if(/^\/api\/v1\/modules\/apps\/[^/]+\/artifact$/.test(req.url)){const id=decodeURIComponent(req.url.split('/').at(-2));const bytes=modules.get(id);if(!bytes){res.statusCode=404;res.end();}else res.end(bytes);}
  else if(req.url==='/api/v1/sync'){const response=await fetch(nodeOrigin+req.url,{signal:AbortSignal.timeout(10000)});observed.push({path:req.url,status:response.status});res.statusCode=response.status;res.end(new Uint8Array(await response.arrayBuffer()));}
  else if(req.url==='/favicon.ico'){res.statusCode=204;res.end();}
  else {res.statusCode=404;res.end();}
 }catch(error){res.statusCode=502;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,errors=[],requests=[];
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>requests.push(r.url()));
 await page.goto(origin);const frame=page.frameLocator('iframe');await frame.locator('#matching-open').waitFor();
 await frame.locator('#matching-open').click();
 const speed=Math.sqrt(398600.4418/7000),state=Buffer.from(opm([7000,0,0,0,speed,0],{frame:'GCRF'}));
 for(const [side,provider,id] of [['left','fixture-a','1'],['right','fixture-b','2']]) {
  await frame.locator(`#matching-${side}-provider`).fill(provider);await frame.locator(`#matching-${side}-id`).fill(id);
  await frame.locator(`#matching-${side}-format`).selectOption('opm');await frame.locator(`#matching-${side}`).setInputFiles({name:side+'.opm',mimeType:'application/octet-stream',buffer:state});
 }
 await frame.locator('#matching-crosswalk').setInputFiles({name:'datefirst.txt',mimeType:'text/plain',buffer:Buffer.from('Nvym t_det_v Nnor t_det_n\n1 20260921 2 20260921\n')});
 await frame.locator('#matching-tab-policy').click();await frame.locator('#matching-start').fill('2026-09-21T00:00:00Z');await frame.locator('#matching-step').fill('10');await frame.locator('#matching-samples').fill('13');await frame.locator('#matching-minimumSpanSeconds').fill('120');
 await frame.locator('#matching-run').click();await frame.locator('#matching-run').waitFor({state:'visible'});
 await page.waitForFunction(()=>{const f=document.querySelector('iframe');return !!f;});
 await frame.locator('#matching-accepted:enabled').waitFor({timeout:20000}).catch(async error=>{throw new Error((await frame.locator('#status').textContent())+' / '+(await frame.locator('#matching-result').textContent())+' / '+error.message);});
 assert.match(await frame.locator('#matching-result').textContent(),/^COMPATIBLE:/);
 await frame.locator('#matching-reason').fill('Closed-form browser verification fixture.');await frame.locator('#matching-accepted').click();
 await frame.locator('#matching-history').filter({hasText:'1 accepted associations'}).waitFor();
 await frame.locator('#matching-tab-sources').click();
 const screenshot=process.env.CATALOG_SCREENSHOT||'/tmp/catalog-editor-review.png';await page.screenshot({path:screenshot,fullPage:true});
 await page.reload();await frame.locator('#matching-open').click();await frame.locator('#matching-history').filter({hasText:'1 accepted associations'}).waitFor();
 assert.equal(requests.filter(url=>!url.startsWith(origin)&&!url.startsWith('blob:')&&!url.startsWith('data:')).length,0);
 // A 503 discovery result is recorded independently of browser execution.
 const unexpected=errors.filter(e=>!e.includes('503 (Service Unavailable)'));
 assert.deepEqual(unexpected,[]);
 console.log(JSON.stringify({artifactHash:bundle.canonicalModuleHashHex,appPageHash:app.pages[0].contentSha256,headless:true,viewport:{width:1440,height:1000},automaticCommonGrid:'compatible',acceptedDecisionPersists:true,externalOriginRequests:0,errors:unexpected,nodeOrigin,nodeDiscovery:observed,screenshot},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
