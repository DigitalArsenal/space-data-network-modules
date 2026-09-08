import test from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../app/read-page.js';
const response = (status, retry) => new Response(null, { status, headers: retry == null ? {} : { 'Retry-After': String(retry) } });
test('resumes the same cursor after rate limiting and obeys Retry-After', async () => {
  const options={body:new Uint8Array([1,2,3]),signal:new AbortController().signal}, calls=[], waits=[];
  const result=await readPage(async (path, value)=>{calls.push([path,value]);return response(calls.length===1?429:200,6);}, '/page', options, {wait:async ms=>waits.push(ms)});
  assert.equal(result.status,200);assert.deepEqual(waits,[6000]);assert.equal(calls.length,2);
  for(const [path,value] of calls){assert.equal(path,'/page');assert.equal(value,options);}
});
test('bounds retries and does not retry permanent errors or shorten a long Retry-After', async () => {
  let count=0;const result=await readPage(async()=>{++count;return response(503);},'/page',{}, {wait:async()=>{}});
  assert.equal(result.status,503);assert.equal(count,5);
  for(const status of [401,403,404,409]) {count=0;await readPage(async()=>{++count;return response(status);},'/page',{});assert.equal(count,1);}
  count=0;await readPage(async()=>{++count;return response(429,60);},'/page',{});assert.equal(count,1);
});
test('cancellation interrupts a retry delay', async () => {
  const controller=new AbortController();
  const result=readPage(async()=>response(429,2),'/page',{signal:controller.signal},{onRetry:()=>controller.abort()});
  await assert.rejects(result,{name:'AbortError'});
});
