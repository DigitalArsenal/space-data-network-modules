#include "space_data_module_invoke.h"
#include "hpop/prw_execution.h"
#include "hpop/prw_resident.h"
#include <algorithm>
#include <cstring>
#include <exception>
#include <cerrno>
#include <cmath>
#include <climits>
#include <string>
#include <vector>

namespace {
int fail(const std::string& error) {
  // Keep the last diagnostic available for this sequential resident instance.
  // The SDK copies the strings into its invocation context.
  static std::string retainedCode,retainedMessage;
  const auto colon=error.find(':');
  retainedCode=colon==std::string::npos?error:error.substr(0,colon);
  retainedMessage=error;
  plugin_set_error(retainedCode.empty()?"invalid-request":retainedCode.c_str(),retainedMessage.c_str());
  return 1;
}
int emit(const char* port, const std::vector<uint8_t>& bytes, uint64_t sequence, bool final) {
  const int index=plugin_push_output_typed(port,"PRW.fbs","$PRW",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"PRW",0,0,0,bytes.data(),bytes.size());
  if(index<0)return fail("output-capacity: SDK refused PRW response");
  plugin_set_output_stream_frame(index,sequence,final);
  return 0;
}
int resident(const char* method, const char* port) {
  std::vector<std::pair<const uint8_t*,size_t>> input;
  uint64_t sequence=0;
  for(uint32_t i=0;i<plugin_get_input_count();++i){const auto* frame=plugin_get_input_frame(i);input.emplace_back(frame->payload,frame->payload_length);sequence=frame->sequence;}
  std::vector<std::vector<uint8_t>> output;uint64_t backlog=0;bool yielded=false;std::string error;
  try {
    // SDK 0.8.18 does not expose OUTPUT_STREAM_CAP to methods. One output per
    // invocation honors every nonzero cap and leaves continuation explicit.
    if(!hpop::processPrwResident(method,input,1,output,backlog,yielded,error))return fail(error);
    for(size_t i=0;i<output.size();++i)if(emit(port,output[i],sequence+i,!yielded&&i+1==output.size()))return 1;
    plugin_set_backlog_remaining(static_cast<uint32_t>(std::min<uint64_t>(backlog,UINT32_MAX)));
    plugin_set_yielded(yielded);return 0;
  }catch(const std::exception& e){return fail(std::string("unsupported-configuration: ")+e.what());}
}
}
extern "C" int invoke(void) {
  const int index=plugin_find_input_index("request",0);const int kernelIndex=plugin_find_input_index("kernel",0);
  const int eopIndex=plugin_find_input_index("earth_orientation",0);const int weatherIndex=plugin_find_input_index("space_weather",0);
  const int jb2008Index=plugin_find_input_index("jb2008_indices",0);
  if(index<0)return fail("invalid-request: missing request");
  if(plugin_find_input_index("earth_orientation",1)>=0)return fail("invalid-earth-orientation: Supply one earth_orientation record.");
  if(plugin_find_input_index("space_weather",1)>=0)return fail("invalid-space-weather: Supply one space_weather record.");
  if(plugin_find_input_index("jb2008_indices",1)>=0)return fail("invalid-jb2008-indices: Supply one jb2008_indices record.");
  const auto* request=plugin_get_input_frame(index);const auto* kernel=kernelIndex<0?nullptr:plugin_get_input_frame(kernelIndex);
  const auto* eop=eopIndex<0?nullptr:plugin_get_input_frame(eopIndex);const auto* weather=weatherIndex<0?nullptr:plugin_get_input_frame(weatherIndex);
  const auto* jb2008=jb2008Index<0?nullptr:plugin_get_input_frame(jb2008Index);
  hpop::PrwEnvironment environment;
  if(eop){environment.earthOrientation=eop->payload;environment.earthOrientationSize=eop->payload_length;}
  if(weather){environment.spaceWeather=weather->payload;environment.spaceWeatherSize=weather->payload_length;}
  if(jb2008){environment.jb2008Indices=jb2008->payload;environment.jb2008IndicesSize=jb2008->payload_length;}
  std::vector<uint8_t> output;std::string error;
  try {
    if(!hpop::processPrwInvoke(request->payload,request->payload_length,kernel?kernel->payload:nullptr,kernel?kernel->payload_length:0,
                               environment,output,error))return fail(error);
    return emit("response",output,request->sequence,true);
  }catch(const std::exception& e){return fail(std::string("unsupported-configuration: ")+e.what());}
}
extern "C" int ingest_state(void){return resident("ingest_state","state");}
extern "C" int propagate_state(void){return resident("propagate_state","state");}
extern "C" int prepare_trajectory_segments(void){return resident("prepare_trajectory_segments","result");}
extern "C" int describe_trajectory_segments(void){return resident("describe_trajectory_segments","result");}

// Diagnostic clients initialize and call the same module bytes through the
// retained C entrypoints. SDK still owns allocation, PIV and PLG exports,
// and the exported __wasm_call_ctors direct-surface initializer.
// The SDK initializer, the WASI command CRT and hpop_initialize can each
// request C++ constructors; the build's --wrap=__wasm_call_ctors sends all of
// them here, so they run once per resident instance. The artifact has one
// entry model (command: _start) and no reactor _initialize. The build defers
// global C++ destruction to instance teardown, so command exit cannot
// invalidate the SDK context or resident catalog before the next invoke.
extern "C" void __real___wasm_call_ctors(void);
extern "C" void __wrap___wasm_call_ctors(void) {
  static bool initialized=false;
  if(!initialized){initialized=true;__real___wasm_call_ctors();}
}
extern "C" void __wasm_call_ctors(void);
extern "C" void hpop_initialize(void){static bool initialized=false;if(!initialized){initialized=true;__wasm_call_ctors();}}

// LLVM's shared-memory C++ ABI archives use these futex ABI symbols in local
// static initialization. Implement them with standard Wasm instructions so no
// Emscripten JS runtime hooks or guest thread creation enter the artifact.
extern "C" int emscripten_futex_wait(volatile void* address,uint32_t expected,double timeoutMs){
  const int64_t timeout=std::isfinite(timeoutMs)?static_cast<int64_t>(timeoutMs*1000000.0):-1;
  const int result=__builtin_wasm_memory_atomic_wait32(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)),static_cast<int32_t>(expected),timeout);
  return result==0?0:result==1?-EWOULDBLOCK:-ETIMEDOUT;
}
extern "C" int emscripten_futex_wake(volatile void* address,int count){
  return __builtin_wasm_memory_atomic_notify(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)),count);
}
