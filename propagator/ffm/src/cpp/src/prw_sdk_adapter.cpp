#include "space_data_module_invoke.h"
#include "ffm/prw_execution.h"
#include "ffm/prw_resident.h"
#include <algorithm>
#include <cstring>
#include <cerrno>
#include <cmath>
#include <climits>
#include <string>
#include <vector>

namespace {
int fail(const std::string& error) {
  // Keep the last diagnostic available for this sequential resident instance.
  // The SDK copies the strings into its invocation context. The code ends at
  // the first ": ", so a code may name its subject (frame-unsupported:TEME).
  static std::string retainedCode,retainedMessage;
  const auto separator=error.find(": ");
  const auto colon=separator==std::string::npos?error.find(':'):separator;
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
  std::vector<ffm::ResidentInput> input;
  uint64_t sequence=0;
  for(uint32_t i=0;i<plugin_get_input_count();++i){const auto* frame=plugin_get_input_frame(i);input.push_back({frame->port_id?frame->port_id:"",frame->payload,frame->payload_length});sequence=frame->sequence;}
  std::vector<std::vector<uint8_t>> output;uint64_t backlog=0;bool yielded=false;std::string error;
  {
    // SDK 0.8.18 does not expose OUTPUT_STREAM_CAP to methods. One output per
    // invocation honors every nonzero cap and leaves continuation explicit.
    if(!ffm::processPrwResident(method,input,1,output,backlog,yielded,error))return fail(error);
    for(size_t i=0;i<output.size();++i)if(emit(port,output[i],sequence+i,!yielded&&i+1==output.size()))return 1;
    plugin_set_backlog_remaining(static_cast<uint32_t>(std::min<uint64_t>(backlog,UINT32_MAX)));
    plugin_set_yielded(yielded);return 0;
  }
}
// The execution inputs beside the request, at most one record a port: the
// kernel and the environment. second_trajectory is read when the method has it.
const char* executionInputs(bool secondTrajectory,ffm::PrwEnvironment& environment,const plugin_input_frame_t*& kernel) {
  static const char* const once[][2]={{"gravity_field","invalid-gravity-field: Supply one gravity_field record."},
    {"second_trajectory","invalid-second-trajectory: Supply one second_trajectory record."},
    {"density_correction","invalid-density-correction: Supply one density_correction record."},
    {"earth_orientation","invalid-earth-orientation: Supply one earth_orientation record."},
    {"space_weather","invalid-space-weather: Supply one space_weather record."},
    {"jb2008_indices","invalid-jb2008-indices: Supply one jb2008_indices record."}};
  for(const auto& port:once)if(plugin_find_input_index(port[0],1)>=0)return port[1];
  const auto frame=[](const char* port){const int i=plugin_find_input_index(port,0);return i<0?nullptr:plugin_get_input_frame(i);};
  const auto bind=[&](const char* port,const uint8_t*& data,size_t& size){if(const auto* f=frame(port)){data=f->payload;size=f->payload_length;}};
  if(secondTrajectory)bind("second_trajectory",environment.secondTrajectory,environment.secondTrajectorySize);
  bind("gravity_field",environment.gravityField,environment.gravityFieldSize);
  bind("density_correction",environment.densityCorrection,environment.densityCorrectionSize);
  bind("earth_orientation",environment.earthOrientation,environment.earthOrientationSize);
  bind("space_weather",environment.spaceWeather,environment.spaceWeatherSize);
  bind("jb2008_indices",environment.jb2008Indices,environment.jb2008IndicesSize);
  kernel=frame("kernel");
  return nullptr;
}
}
extern "C" int invoke(void) {
  const int index=plugin_find_input_index("request",0);
  ffm::PrwEnvironment environment;const plugin_input_frame_t* kernel=nullptr;
  if(const char* refusal=executionInputs(true,environment,kernel))return fail(refusal);
  if(index<0)return fail("invalid-request: missing request");
  const auto* request=plugin_get_input_frame(index);
  std::vector<uint8_t> output;std::string error;
  if(!ffm::processPrwInvoke(request->payload,request->payload_length,kernel?kernel->payload:nullptr,kernel?kernel->payload_length:0,
                             environment,output,error))return fail(error);
  return emit("response",output,request->sequence,true);
}
// The request's execution at the $PCF OUTPUT epochs, written as one $OEM.
extern "C" int propagate_oem(void) {
  const int index=plugin_find_input_index("request",0),configurationIndex=plugin_find_input_index("configuration",0);
  ffm::PrwEnvironment environment;const plugin_input_frame_t* kernel=nullptr;
  if(const char* refusal=executionInputs(false,environment,kernel))return fail(refusal);
  if(index<0||plugin_find_input_index("request",1)>=0)return fail("invalid-request: Supply one request record.");
  if(configurationIndex<0)return fail("output-unspecified: propagate_oem writes the $PCF OUTPUT epochs; the configuration port carries none.");
  if(plugin_find_input_index("configuration",1)>=0)return fail("invalid-configuration: Supply one configuration record.");
  const auto* request=plugin_get_input_frame(index);const auto* configuration=plugin_get_input_frame(configurationIndex);
  std::vector<uint8_t> output;std::string error;
  if(!ffm::processPrwOem(request->payload,request->payload_length,configuration->payload,configuration->payload_length,
                         kernel?kernel->payload:nullptr,kernel?kernel->payload_length:0,environment,output,error))return fail(error);
  const int out=plugin_push_output_typed("ephemeris","OEM.fbs","$OEM",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"OEM",0,0,0,output.data(),output.size());
  if(out<0)return fail("output-capacity: SDK refused the $OEM");
  plugin_set_output_stream_frame(out,request->sequence,true);
  return 0;
}
extern "C" int ingest_state(void){return resident("ingest_state","state");}
extern "C" int ingest_state_gravity_only(void){return resident("ingest_state_gravity_only","state");}
extern "C" int propagate_state(void){return resident("propagate_state","state");}
extern "C" int prepare_trajectory_segments(void){return resident("prepare_trajectory_segments","result");}
extern "C" int describe_trajectory_segments(void){return resident("describe_trajectory_segments","result");}

// Diagnostic clients initialize and call the same module bytes through the
// retained C entrypoints. SDK still owns allocation, PIV and PLG exports,
// and the exported __wasm_call_ctors direct-surface initializer.
// The SDK initializer, the WASI command CRT and ffm_initialize can each
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
extern "C" void ffm_initialize(void){static bool initialized=false;if(!initialized){initialized=true;__wasm_call_ctors();}}

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
