// Test-only C++ WASM provider; no test host computes dynamics.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileModuleFromSource} from 'space-data-module-sdk/compiler';
import {loadKnownTypeCatalog} from 'space-data-module-sdk/standards';
const root=fileURLToPath(new URL('..',import.meta.url));
const strip=s=>s.replace(/^#include "[^\"]+(?:_generated\.h|estimation\.hpp)"\n/gm,'').replace(/^#include "estimation\.hpp"\n/gm,'');
const manifest=JSON.parse(await fs.readFile(path.join(root,'plugin-manifest.json'),'utf8'));
manifest.id='analysis.estimation.test-provider';manifest.name='Estimation independent two-body test provider';manifest.description='Test-only Newtonian RK4 provider; never a production force-model selection.';
manifest.methods=[{...manifest.methods[0],methodId:'test_propagate',inputPorts:[manifest.methods[0].inputPorts[0]],outputPorts:[manifest.methods[0].outputPorts[0]]}];
manifest.schemasUsed=[manifest.schemasUsed[0]];
manifest.buildArtifacts=[{...manifest.buildArtifacts[0],path:'dist/isomorphic/module.wasm'}];
const headers=[];for(const name of ['BaseTypes','Propagator','Estimation'])headers.push(strip(await fs.readFile(path.join(root,`src/generated/invoke/${name}_generated.h`),'utf8')));
const code=`
#include "space_data_module_invoke.h"
#include <memory>
namespace wire=orbpro::estimation;
extern "C" int test_propagate() {
 plugin_reset_output_state();const auto* frame=plugin_get_input_frame(0);
 if(!frame)return 3;
 flatbuffers::Verifier verifier(frame->payload,frame->payload_length);
 if(!wire::VerifyEstimationEnvelopeBuffer(verifier))return 3;
 const auto* in=wire::GetEstimationEnvelope(frame->payload);
 if(!in->result() || !in->result()->propagation_requests())return 3;
 wire::EstimationEnvelopeT out;
 for(const auto* query:*in->result()->propagation_requests()) {
   auto answer=std::make_unique<wire::PropagationAnswerT>();answer->query=std::unique_ptr<wire::PropagationQueryT>(query->UnPack());
   sdn::estimation::CartesianState seed{};for(int i=0;i<6;++i)seed.value[i]=query->seed()->state()->Get(i);
   const double dt=(query->target_epoch()->jd_day()-query->seed()->epoch().jd_day())*86400+query->target_epoch()->seconds()-query->seed()->epoch().seconds();
   sdn::estimation::PropagatorSample sample{};test_provider::two_body(seed,dt,&sample);
   answer->sample=std::make_unique<wire::EstimationPropagatorSample>(*query->target_epoch(),flatbuffers::span<const double,6>(sample.state.value.data(),6),flatbuffers::span<const double,36>(sample.stm.data(),36));
   out.propagation_answers.push_back(std::move(answer));
 }
 flatbuffers::FlatBufferBuilder b;wire::FinishEstimationEnvelopeBuffer(b,wire::EstimationEnvelope::Pack(b,&out));
 return plugin_push_output("result","Estimation.fbs","$EST",b.GetBufferPointer(),b.GetSize())<0?3:0;
}`;
const standardsRoot=path.join(root,'node_modules/spacedatastandards.org');
const catalog=[...await loadKnownTypeCatalog({standardsRoot})];
if(!catalog.some(t=>t.fileIdentifier==='$EST'))catalog.push({schemaCode:'ESTIMATION',schemaName:'Estimation.fbs',fileIdentifier:'$EST',rootTypeName:'EstimationEnvelope',source:'module-local'});
const outputPath=path.join(root,'tests/.generated/provider/dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath),{recursive:true});
const r=await compileModuleFromSource({manifest,sourceCode:[...headers,await fs.readFile(path.join(root,'src/estimation.hpp'),'utf8'),strip(await fs.readFile(path.join(root,'tests/two_body_provider.hpp'),'utf8')),code].join('\n'),language:'c++',outputPath,threadModel:manifest.threadModel,standardsRoot,catalog});
if(!r.report?.ok)throw Error(JSON.stringify(r.report));
console.log('PASS built independent C++ WASM two-body test provider');
