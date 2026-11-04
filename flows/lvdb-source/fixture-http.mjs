// Test-only HTTP boundary: replay captured response bytes inside WASM. Production
// builds compile the unchanged hostcap/http-request source instead.
import fs from 'node:fs/promises';
import path from 'node:path';
export async function fixtureHttpSource(packageDir,encodeHttpResponse){
 const {sources:load,marker}=await import('../../data-source/lvdb-source/tests/sources.mjs');
 const sources=await load(packageDir);sources.push({url:marker,bytes:Buffer.from('v1.1.1\n'),retrievedMs:sources[0].retrievedMs});
 let declarations='',cases='';
 for(const [i,s]of sources.entries()){
  const bytes=encodeHttpResponse({url:s.url,status:200,body:s.bytes,retrievedMs:s.retrievedMs});
  declarations+=`static const unsigned char response_${i}[]={${[...bytes].join(',')}};\n`;
  declarations+=`static const char url_${i}[]={${[...Buffer.from(s.url),0].join(',')}};\n`;
  cases+=`if(r->URL()->str()==url_${i})return plugin_push_output_ex("response","HttpResponse.fbs","HRSP",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpResponse",0,0,response_${i},sizeof(response_${i}))<0?1:0;\n`;
 }
 return `#include "space_data_module_invoke.h"\n#include "HttpRequest_generated.h"\n${declarations}\nstatic int answer(const plugin_input_frame_t* f){if(!f)return 1;flatbuffers::Verifier v(f->payload,f->payload_length);if(!sdn::runtime::VerifyHttpRequestBuffer(v))return 1;auto r=sdn::runtime::GetHttpRequest(f->payload);if(!r->URL())return 1;${cases}return 1;} extern "C" int request(){for(uint32_t i=0;i<plugin_get_input_count();++i)if(answer(plugin_get_input_frame(i)))return 1;return 0;}`;
}
