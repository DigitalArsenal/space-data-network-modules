// Real Chromium headless-shell, one instance, with COOP/COEP for the shared
// wasi-sequential artifact. This proves module parity, not console rendering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = path.resolve(root, '../../data-source/terrain-ingest/tests/fixtures/body-raster');
const scratch = process.env.BODY_TERRAIN_SCRATCH;
assert.ok(scratch && !/^\/(?:private\/)?tmp(?:\/|$)/.test(scratch), 'BODY_TERRAIN_SCRATCH must name durable scratch');
fs.mkdirSync(scratch, {recursive: true});
const executablePath = process.env.HEADLESS_SHELL;
assert.ok(executablePath && /(?:chrome-)?headless[-_]shell$/.test(executablePath) && fs.existsSync(executablePath), 'HEADLESS_SHELL must name Chromium headless shell');
assert.ok(os.loadavg()[0] < 25, 'load must be below 25 before starting the browser');
const cases = JSON.parse(fs.readFileSync(path.join(fixtures,'cases.json')));
const entry = `
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import * as flatbuffers from 'flatbuffers';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
const cases = ${JSON.stringify(cases)};
window.run = async () => {
  if (!crossOriginIsolated) throw new Error('browser is not cross-origin isolated');
  const get = async (name) => { const r=await fetch(name); if(!r.ok)throw new Error(name+': '+r.status);return new Uint8Array(await r.arrayBuffer()); };
  const manifest=await (await fetch('/manifest.json')).json();
  const h=await createBrowserModuleHarness({wasmSource:await get('/module.wasm'),manifest,surface:'direct'});
  const report=[];
  try {
    for (const {file:name, reference:oracle, mask} of cases) {
      const file=await get('/fixtures/'+name), expected=new Float64Array((await get('/fixtures/'+oracle)).buffer), expectedMask=await get('/fixtures/'+mask);
      const b=new flatbuffers.Builder(128), title=b.createString('Planetary raster');
      NCD.startNCD(b);NCD.addFormat(b,255);NCD.addProviderDefinedFormatName(b,title);NCD.addSourceByteLength(b,BigInt(file.length));NCD.finishSizePrefixedNCDBuffer(b,NCD.endNCD(b));
      const ranges=new Uint8Array(file.length+16), v=new DataView(ranges.buffer);v.setUint32(0,1,true);v.setBigUint64(4,0n,true);v.setUint32(12,file.length,true);ranges.set(file,16);
      const r=await h.invoke({methodId:'samples',inputs:[
        {portId:'descriptor',typeRef:{schemaName:'NCD.fbs',fileIdentifier:'$NCD',rootTypeName:'NCD'},payload:b.asUint8Array()},
        {portId:'ranges',typeRef:{acceptsAnyFlatbuffer:true},payload:ranges},
        {portId:'request',typeRef:{acceptsAnyFlatbuffer:true},payload:new Uint8Array(new Float64Array([1,0,0,32,32]).buffer)},
      ]});
      if(r.statusCode!==0)throw new Error(r.errorCode+': '+r.errorMessage);
      const bytes=(port)=>Uint8Array.from(r.outputs.find(o=>o.portId===port).payload);
      const values=new Float64Array(bytes('values').buffer), valid=bytes('valid');
      if(values.length!==expected.length)throw new Error(name+': wrong output length');
      let missing=0;
      for(let i=0;i<expected.length;++i) {
        const ok=expectedMask[i]===0?0:1;
        if(valid[i]!==ok||values[i]!== (ok?expected[i]:0))throw new Error(name+': wrong sample '+i);
        if(!ok)missing++;
      }
      report.push({file:name,exactPosts:values.length,missing});
    }
  }finally{await h.destroy();}
  document.body.textContent=JSON.stringify(report,null,2);
  return {crossOriginIsolated,checks:report};
};`;
const bundle = await build({stdin: {contents: entry, resolveDir: root}, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022'});
const files = new Map([
  ['/module.wasm', path.join(root, 'dist/isomorphic/module.wasm')],
  ['/manifest.json', path.join(root, 'plugin-manifest.json')],
  ...[...new Set(cases.flatMap(c=>[c.file,c.reference,c.mask]))].map(name => ['/fixtures/' + name, path.join(fixtures, name)]),
]);
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.url === '/') {res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body><script type="module" src="/bundle.js"></script></body></html>');}
  if (req.url === '/bundle.js') {res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents);}
  const file = files.get(req.url);
  if (!file) {res.statusCode=404;return res.end();}
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({headless:true, executablePath});
  const page = await browser.newPage();
  const errors = [], failures = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
  page.on('requestfailed', r => failures.push(r.url()));
  page.on('response', r => {if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.run === 'function');
  const report = await page.evaluate(() => window.run());
  assert.deepEqual(errors, []);assert.deepEqual(failures, []);
  const screenshot = path.join(scratch, 'scalar-browser.png');
  await page.screenshot({path:screenshot});
  const evidence = {...report, errors, failures, screenshot, uptimeLoad:os.loadavg(), docker:'waived by owner 2026-10-22'};
  fs.writeFileSync(path.join(scratch,'scalar-browser.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
