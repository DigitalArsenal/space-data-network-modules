// The portable core in the SDK browser harness on the typed contracts: $SRG settings and the listings' HttpResponses in,
// the $SRG discovery queue and one HttpRequest per resource (its job in CONTEXT) out; the registry as $SRG PROVIDERS;
// the artifact descriptor from a job's HttpResponse and a content receipt.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {decodeHttpRequest} from 'space-data-module-sdk/runtime-contracts';
import {fixtures,manifest,wasm,moduleRoot,standardsRoot,readSrg,settingsPort,listingPorts,responsePort,srgPort,jobResponse,outputs} from './harness.mjs';
const counts={'spacex-starlink':2,'eutelsat-oneweb':1,planet:2,iss:1,ses:1,intelsat:2,telesat:2,'css-tiangong':1,'gps-precise':1,'glonass-precise':1,'esa-pod':3,eumetsat:2,cpf:2};
const registry=JSON.parse(fs.readFileSync(path.join(moduleRoot,'sources.json'),'utf8'));
async function harness(t){const h=await createBrowserModuleHarness({wasmSource:wasm,manifest,surface:'direct'});t.after(()=>h.destroy());return h;}
const discover=(h,source_id,responses)=>h.invoke({methodId:'discover_sources',inputs:[settingsPort(source_id),...listingPorts(responses)]});
const queueOf=(r)=>{assert.equal(r.statusCode,0,r.errorMessage);return readSrg(outputs(r,'resources')[0].payload);};

for(const [source_id,responses] of Object.entries(fixtures.responses)) test(`discovers ${source_id} authoritative registry format`,async(t)=>{
 const h=await harness(t);const r=await discover(h,source_id,responses);const queue=queueOf(r);const resources=queue.RESOURCES;
 assert.equal(resources.length,counts[source_id]);assert.equal(new Set(resources.map((x)=>x.URL)).size,resources.length);assert.ok(resources.every((x)=>x.SOURCE_ID===source_id && x.FORMAT));
 assert.equal(queue.GENERATED_AT_MS,BigInt(fixtures.epoch_seconds)*1000n);
 if(source_id==='cpf')assert.ok(resources.some((x)=>x.URL.endsWith('_10.esa')));if(source_id==='gps-precise')assert.match(resources[0].URL,/OPSULT_20262480600/);
 // One GET per resource, its CONTEXT the job: an $SRG with exactly that resource.
 const requests=outputs(r,'requests').map((f)=>decodeHttpRequest(f.payload));
 assert.deepEqual(requests.map((q)=>q.url),resources.map((x)=>x.URL));
 for(const [k,q] of requests.entries()){assert.equal(q.method,'GET');const job=readSrg(q.context);assert.equal(job.RESOURCES.length,1);assert.equal(job.RESOURCES[0].URL,resources[k].URL);}
});
test('plan_source_requests asks for the listings with the settings as CONTEXT, and a missing listing response is refused',async(t)=>{
 const h=await harness(t);const plan=await h.invoke({methodId:'plan_source_requests',inputs:[settingsPort('esa-pod')]});assert.equal(plan.statusCode,0,plan.errorMessage);
 const requests=outputs(plan,'requests').map((f)=>decodeHttpRequest(f.payload));
 assert.deepEqual(requests.map((q)=>q.url),['http://navigation-office.esa.int/products/gnss-products/2435/','http://navigation-office.esa.int/products/gnss-products/2434/','http://navigation-office.esa.int/products/swarm/','http://navigation-office.esa.int/products/cryosat2/']);
 assert.ok(requests.every((q)=>q.timeoutMs===15000 && Number(q.maxBytes)===16*1024*1024 && readSrg(q.context).SETTINGS.SOURCE_ID==='esa-pod'));
 const missing=await h.invoke({methodId:'discover_sources',inputs:[settingsPort('esa-pod')]});assert.notEqual(missing.statusCode,0);assert.match(missing.errorMessage,/response missing/);
 assert.equal((await h.invoke({methodId:'plan_source_requests',inputs:[settingsPort('iss')]})).outputs.length,0,'a direct-URL provider needs no listing');
});
test('describe_sources is the compiled registry as $SRG PROVIDERS',async(t)=>{
 const h=await harness(t);const r=await h.invoke({methodId:'describe_sources',inputs:[]});assert.equal(r.statusCode,0,r.errorMessage);
 const out=readSrg(outputs(r,'sources')[0].payload);
 assert.equal(out.UPSTREAM_REVISION,registry.upstream_revision);assert.equal(out.UPSTREAM_REPOSITORY,registry.upstream_repository);assert.equal(out.REGISTRY_PATH,registry.registry_path);
 assert.deepEqual(out.PROVIDERS.map((p)=>[p.SOURCE_ID,p.NAME,p.OPERATOR,p.FORMAT,p.ORIGINS,p.REFRESH_INTERVAL_S,p.CREDENTIALED]),
  registry.sources.map((s)=>[s.source_id,s.name,s.operator,s.format,s.origins,s.refresh_interval_sec,s.credentialed]));
});
test('core and adapter both satisfy the SDK and SDS contracts',async()=>{
 for(const prefix of ['','host-adapter/']){const m=JSON.parse(fs.readFileSync(path.join(moduleRoot,prefix,'plugin-manifest.json')));const report=await validateArtifactWithStandards({wasmPath:path.join(moduleRoot,prefix,'dist/isomorphic/module.wasm'),manifest:m,standardsRoot});assert.equal(report.ok,true,JSON.stringify(report.errors??report.issues));
  for(const method of m.methods)for(const port of [...method.inputPorts,...method.outputPorts]){const types=port.acceptedTypeSets.flatMap((s)=>s.allowedTypes);assert.equal(types.length,1);assert.equal(types[0].wireFormat,'flatbuffer');assert.ok(!types[0].acceptsAnyFlatbuffer);}}
});
test('rejects a foreign source origin, a non-200 answer or a job without a resource, without emitting a descriptor',async(t)=>{
 const h=await harness(t);const receipt=srgPort('receipt',{receipts:[{CID:'testcid'}]});
 for(const response of [jobResponse({SOURCE_ID:'iss',URL:'https://foreign.example/file',FORMAT:'ccsds-oem-kvn'},'CCSDS_OEM_VERS = 2.0'),
  {...responsePort('response','https://nasa-public-data.s3.amazonaws.com/x',Buffer.from('CCSDS_OEM_VERS = 2.0'),{status:503})},
  responsePort('response','https://nasa-public-data.s3.amazonaws.com/x','CCSDS_OEM_VERS = 2.0')]) {
  const rejected=await h.invoke({methodId:'describe_artifact',inputs:[response,receipt]});assert.notEqual(rejected.statusCode,0);assert.equal(rejected.outputs.length,0);
 }
 assert.equal((await h.invoke({methodId:'describe_sources',inputs:[]})).statusCode,0);
});
test('CPF selection compares date then numeric sequence, ignores malformed names, and recovers from overflow',async(t)=>{
 const h=await harness(t);const url='http://navigation-office.esa.int/products/cpf_predictions/';
 const invoke=(body)=>discover(h,'cpf',{[url]:{status:200,body}});
 const body=['lageos1_cpf_260908_99.esa','lageos1_cpf_260909_2.esa','lageos1_cpf_260909_10.esa','lageos1_cpf_260909_9.esa','starlette_CPF_260909_1.ESA','broken_cpf_26090_4.esa','broken_cpf_260909_.esa','broken_cpf_26x909_4.esa'].map((name)=>`<a href="${name}">${name}</a>`).join('\n');
 let r=await invoke(body);assert.deepEqual(queueOf(r).RESOURCES.map((x)=>x.URL.split('/').at(-1)),['lageos1_cpf_260909_10.esa','starlette_CPF_260909_1.ESA']);
 r=await invoke('lageos1_cpf_260909_18446744073709551616.esa');assert.notEqual(r.statusCode,0);assert.match(r.errorMessage,/sequence/);
 r=await invoke(body);assert.equal(r.statusCode,0,r.errorMessage);
});
