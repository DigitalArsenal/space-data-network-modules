#include "space_data_module_invoke.h"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json=nlohmann::json;
namespace {
constexpr size_t maxBytes=100u*1024u*1024u+8u;
int fail(const char* message) {plugin_set_error("lowell-astorb-host-adapter",message);return 1;}
#define CHECK(condition,message) do {if(!(condition)) return fail(message);} while(0)
bool text(const Json& j,const char* key){return j.is_object()&&j.contains(key)&&j[key].is_string();}
const plugin_input_frame_t* frame(const char* port) {
 const plugin_input_frame_t* result=nullptr;
 for(uint32_t i=0;i<plugin_get_input_count();++i){const auto* f=plugin_get_input_frame(i);if(!f||!f->port_id||!f->payload||f->payload_length>maxBytes)return nullptr;if(std::strcmp(f->port_id,port)==0){if(result)return nullptr;result=f;}}
 return result;
}
Json json(const char* port){const auto* f=frame(port);return f?Json::parse(f->payload,f->payload+f->payload_length,nullptr,false):Json();}
int output(const char* port,const Json& j){const auto bytes=j.dump();return plugin_push_output_ex(port,nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,reinterpret_cast<const uint8_t*>(bytes.data()),bytes.size());}
}
// Generic host configuration and clock are the only runtime inputs here.
// HTTP, persistence, signing and IPFS remain in existing host services.
extern "C" {
__attribute__((import_module("space_data_module_host"),import_name("call")))
int32_t astorb_host_call(const uint8_t*,int32_t,const uint8_t*,int32_t);
__attribute__((import_module("space_data_module_host"),import_name("response_len")))
int32_t astorb_response_len();
__attribute__((import_module("space_data_module_host"),import_name("read_response")))
int32_t astorb_read_response(uint8_t*,int32_t);
}
namespace {
Json configuration() {
  const char* op="plugin.getConfig";
  const uint8_t request[]={2,0,0,0,'{','}',0,0,0,0};
  astorb_host_call(reinterpret_cast<const uint8_t*>(op),std::strlen(op),request,sizeof(request));
  const int32_t size=astorb_response_len();
  if(size<8 || size>65536) return Json();
  std::vector<uint8_t> bytes(size); astorb_read_response(bytes.data(),size);
  const uint32_t n=uint32_t(bytes[0]) | uint32_t(bytes[1])<<8 | uint32_t(bytes[2])<<16 | uint32_t(bytes[3])<<24;
  if(n>bytes.size()-8) return Json();
  const auto result=Json::parse(bytes.data()+4,bytes.data()+4+n,nullptr,false);
  if(!result.is_object() || (result.contains("ok") && result["ok"]!=true)) return Json();
  return result.contains("result")?result["result"]:result;
}
bool enabled(const Json& cfg) { return cfg.is_object() && cfg.contains("lowell_astorb_enabled") && cfg["lowell_astorb_enabled"]==true; }

}
extern "C" int prepare_scheduled() {
  CHECK(plugin_get_input_count()==1 && plugin_get_input_frame(0) && plugin_get_input_frame(0)->port_id && std::strcmp(plugin_get_input_frame(0)->port_id,"tick")==0,"Exactly one timer tick is required.");
  const auto cfg=configuration();
  CHECK(cfg.is_object(),"Host configuration unavailable.");
  if(!enabled(cfg)) return output("status",{{"skipped","disabled"}})<0?1:0;
  CHECK(text(cfg,"lowell_astorb_producer_peer_id") && !cfg["lowell_astorb_producer_peer_id"].get<std::string>().empty(),"Producer peer ID is required before fetching.");
  CHECK(cfg.contains("lowell_astorb_source") && cfg["lowell_astorb_source"].is_object(),"astorb source configuration missing.");
  const auto& source=cfg["lowell_astorb_source"];
  CHECK(text(source,"access") && source["access"]=="anonymous","astorb.dat is anonymous public data; set lowell_astorb_source.access to anonymous.");
  return output("config",source)<0?1:0;
}
extern "C" int receipt_scheduled() {
  CHECK(plugin_get_input_count()==2,"Exactly one job and response are required.");
  const auto cfg=configuration();
  CHECK(enabled(cfg) && text(cfg,"lowell_astorb_producer_peer_id"),"Producer configuration missing or disabled.");
  const auto* result=frame("response");
  CHECK(result && result->payload_length>=8,"HTTP response missing.");
  if(std::memcmp(result->payload,"$HRB",4)==0 && result->payload[4]==48 && result->payload[5]==1 && result->payload[6]==0 && result->payload[7]==0)
    return output("status",{{"skipped","not-modified"},{"status",304},{"unchanged",true}})<0?1:0;
  const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  CHECK(output("job",json("job"))>=0 && output("receipt",{{"retrieved_at_ms",now},{"producer_peer_id",cfg["lowell_astorb_producer_peer_id"]}})>=0,"Could not emit receipt.");
  return plugin_push_output_ex("response",nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,result->payload,result->payload_length)<0?1:0;
}
