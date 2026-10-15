#include "space_data_module_invoke.h"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
namespace {
constexpr size_t maxBytes=100u*1024u*1024u+8u;
int fail(const char* message) {plugin_set_error("lowell-astorb-host-adapter",message);return 1;}
#undef CHECK
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

// ── ingest_astorb: the retrieval straight into the node's store, in parts ──
// The same validation and records as the portable parse_astorb (the shared
// astorb_core.hpp), but nothing the size of the catalog is ever held: the
// three range frames are read in place, inflated through a 32 KiB window, and
// the $SBD records go to the host's storage.ingest_with_source in parts of
// about 12 MiB as they are built (the storage_ingest capability, the same
// hostcall the generic storage-ingest node makes). A first pass validates
// the whole download (gzip CRC-32 and length, fixed columns, at least 100,000
// rows) before the first part is stored, so a broken download never touches
// the stored catalog. Every part carries the same batch (the file's SHA-256)
// and reconcile "current": the previous batch's rows go once the new batch
// starts landing; the node's auto-publisher announces the batch when it has
// been quiet for the lane's settle time (publishing.auto_publish[].settle).
// Coordinator D3 (2026-10-13): host-01 (7 GB, 2 CPUs) ingests with peak RSS
// under 2 GB; the one-frame path held the 372 MB stream in four places.
namespace {
// Under the module-SDK hostcall request ceiling (16 MiB with the meta).
constexpr size_t partBytes = 12u * 1024u * 1024u;
void put32(std::vector<uint8_t>& v, size_t at, uint32_t x) { v[at]=uint8_t(x); v[at+1]=uint8_t(x>>8); v[at+2]=uint8_t(x>>16); v[at+3]=uint8_t(x>>24); }
// One storage.ingest_with_source call: [u32 meta][meta][u32 1 segment][u32 n][records].
// Returns the host's result object, or an empty Json with `why` set.
Json storePart(const std::string& meta, const std::vector<uint8_t>& records, std::string& why) {
  const char* op="storage.ingest_with_source";
  std::vector<uint8_t> request(4+meta.size()+4+4+records.size());
  put32(request,0,uint32_t(meta.size()));
  std::memcpy(request.data()+4,meta.data(),meta.size());
  put32(request,4+meta.size(),1);
  put32(request,8+meta.size(),uint32_t(records.size()));
  std::memcpy(request.data()+12+meta.size(),records.data(),records.size());
  astorb_host_call(reinterpret_cast<const uint8_t*>(op),int32_t(std::strlen(op)),request.data(),int32_t(request.size()));
  std::vector<uint8_t>().swap(request);
  const int32_t size=astorb_response_len();
  if(size<4){why="storage.ingest_with_source returned nothing.";return Json();}
  std::vector<uint8_t> bytes(size); astorb_read_response(bytes.data(),size);
  const uint32_t n=uint32_t(bytes[0]) | uint32_t(bytes[1])<<8 | uint32_t(bytes[2])<<16 | uint32_t(bytes[3])<<24;
  if(n>bytes.size()-4){why="storage.ingest_with_source response is malformed.";return Json();}
  const auto response=Json::parse(bytes.data()+4,bytes.data()+4+n,nullptr,false);
  if(!response.is_object() || response.value("ok",false)!=true){
    why=response.is_object()&&response.contains("message")&&response["message"].is_string()?response["message"].get<std::string>():std::string("storage.ingest_with_source refused a part.");
    return Json();
  }
  return response.contains("result")?response["result"]:Json::object();
}
}
extern "C" int ingest_astorb() {
  astorb::GzipInput gz;
  std::string peer;
  int64_t retrieved=0;
  if(const char* refused=astorb::readRetrieval(gz,peer,retrieved)) return fail(refused);
  astorb::Survey s;
  if(!astorb::survey(gz,s)) return fail(astorb::error);
  CHECK(s.rows>=100000,"astorb.dat holds fewer than 100,000 numbered asteroids; refusing a partial catalog.");
  const std::string sourceSha=astorb::sourceSha256(gz);
  // The meta names the records as binary segment 0 (the storage-ingest node's
  // rewrite, done here because this node calls the host itself).
  std::string meta=astorb::ingestMeta(sourceSha,peer).dump();
  meta.insert(meta.size()-1,",\"records\":{\"$bin\":0}");
  std::vector<uint8_t> part;
  part.reserve(partBytes+65536);
  flatbuffers::FlatBufferBuilder b(512);
  size_t parts=0, stored=0, inserted=0, recordBytes=0;
  std::string why;
  bool failed=false;
  const auto flush=[&]() {
    if(part.empty()||failed) return;
    const Json result=storePart(meta,part,why);
    if(result.is_null()){failed=true;return;}
    ++parts;
    inserted+=result.value("inserted",size_t(0));
    part.clear();
  };
  for(int wanted=0;wanted<4 && !failed;++wanted){
    const bool ok=astorb::forEachRecordInBand(gz,wanted,b,[&](const uint8_t* p,size_t n){
      if(failed) return;
      part.insert(part.end(),p,p+n);
      ++stored; recordBytes+=n;
      if(part.size()>=partBytes) flush();
    });
    if(!ok) return fail(astorb::error);
  }
  flush();
  if(failed){
    std::string message="Storing the astorb batch failed after "+std::to_string(parts)+" part(s): "+why;
    return fail(message.c_str());
  }
  CHECK(stored==s.rows,"The record pass disagrees with the validation pass; the batch is incomplete.");
  // The largest tenth: the same records again, under their own lane (the
  // store keeps one copy of a record and tags it with both lanes).
  const size_t mainParts=parts;
  meta=astorb::ingestMeta(sourceSha,peer,astorb::largestSourceName).dump();
  meta.insert(meta.size()-1,",\"records\":{\"$bin\":0}");
  size_t largest=0;
  const bool largestOk=astorb::forEachLargestRecord(gz,s.largest,b,[&](const uint8_t* p,size_t n){
    if(failed) return;
    part.insert(part.end(),p,p+n);
    ++largest;
    if(part.size()>=partBytes) flush();
  });
  if(!largestOk) return fail(astorb::error);
  flush();
  if(failed){
    std::string message="Storing the largest-10% lane failed after "+std::to_string(parts-mainParts)+" part(s): "+why;
    return fail(message.c_str());
  }
  CHECK(largest==s.largest.count,"The largest-10% pass disagrees with the validation pass.");
  // The catalog listing: the two $EGP groups (lane astorb-groups).
  meta=astorb::ingestMeta(sourceSha,peer,astorb::groupsSourceName,retrieved).dump();
  meta.insert(meta.size()-1,",\"records\":{\"$bin\":0}");
  part=astorb::groupRecords(s,sourceSha,retrieved);
  flush();
  if(failed){
    std::string message="Storing the asteroid groups failed: "+why;
    return fail(message.c_str());
  }
  Json report=astorb::surveyReport(s,sourceSha,gz.size,recordBytes,retrieved);
  report["parts"]=parts;
  report["inserted"]=inserted;
  report["part_bytes"]=partBytes;
  report["largest"]["stored"]=largest;
  report["groups"]=2;
  return output("result",report)<0?1:0;
}

// The range plan, the portable module's own (astorb_core.hpp): the flow runs
// this adapter alone, so the portable core is not linked in twice.
extern "C" int plan_astorb() { return astorb::planAstorb(); }
