// Provider decisions stay in the SDK module; the host supplies HTTP and storage.
#include "space_data_module_invoke.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
using Json = nlohmann::json;
extern "C" {
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t catalog_host_call(const uint8_t*, int32_t, const uint8_t*, int32_t);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t catalog_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t catalog_read_response(uint8_t*, int32_t);
}
namespace catalog_fetch {
constexpr size_t budget = 128 * 1024 * 1024;
uint16_t u16(const uint8_t* p) { return uint16_t(p[0]) | uint16_t(p[1])<<8; }
uint32_t u32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24; }
int error(const char* message) { plugin_set_error("catalog-fetch", message); return 1; }
std::string text(const Json& j, const char* key) { return j.contains(key) && j[key].is_string() ? j[key].get<std::string>() : ""; }
Json input(const char* port) {
  Json result;
  bool found=false;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id,port)==0 && f->payload && f->payload_length<=65536) {
      if (found) return Json();
      found=true; result=Json::parse(f->payload,f->payload+f->payload_length,nullptr,false);
    }
  }
  return result;
}
int emit(const char* port,const std::string& bytes) {
  return plugin_push_output_ex(port,nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,
    reinterpret_cast<const uint8_t*>(bytes.data()),static_cast<uint32_t>(bytes.size()))<0 ? 1 : 0;
}
Json config() {
  const uint8_t request[]={2,0,0,0,'{','}',0,0,0,0};
  const char* op="plugin.getConfig";
  catalog_host_call(reinterpret_cast<const uint8_t*>(op),std::strlen(op),request,sizeof(request));
  const int32_t size=catalog_response_len();
  if (size<8 || size>65536) return Json();
  std::vector<uint8_t> bytes(size); catalog_read_response(bytes.data(),size);
  const auto length=u32(bytes.data());
  if (length>bytes.size()-8) return Json();
  auto value=Json::parse(bytes.data()+4,bytes.data()+4+length,nullptr,false);
  return value.is_object() && value.contains("result") ? value["result"] : value;
}
Json product(const std::string& id) {
  if (id=="gcat-satcat" || id=="gcat-satcat100k") {
    const auto edition=id=="gcat-satcat" ? "satcat" : "satcat100k";
    return {{"source_name",id},{"source_url",std::string("https://planet4589.org/space/gcat/tsv/cat/")+edition+".tsv"},
      {"origin_id","planet4589.org"},{"origin_name","Jonathan McDowell"},{"license","CC-BY-4.0"},
      {"license_url","https://creativecommons.org/licenses/by/4.0/"},
      {"citation","McDowell, J., General Catalog of Artificial Space Objects, https://planet4589.org/space/gcat"}};
  }
  if (id=="mccants-classfd" || id=="mccants-inttles") {
    const auto edition=id=="mccants-classfd" ? "classfd" : "inttles";
    return {{"source_name",id},{"source_url",std::string("https://mmccants.org/tles/")+edition+".zip"},
      {"member",std::string(edition)+".tle"},{"origin_id","mmccants.org"},{"origin_name","Mike McCants"},
      {"citation","Mike McCants, Satellite Tracking TLE Files, https://mmccants.org/tles/"}};
  }
  return Json();
}
bool unsignedNumber(const std::string& value, uint32_t& out) {
  if (value.empty() || value.size()>5 || !std::all_of(value.begin(),value.end(),[](char c){return c>='0'&&c<='9';})) return false;
  out=static_cast<uint32_t>(std::strtoul(value.c_str(),nullptr,10)); return out>0;
}
bool loopback(const std::string& url) {
  const std::string prefix="http://127.0.0.1:";
  if (url.rfind(prefix,0)!=0) return false;
  const auto slash=url.find('/',prefix.size());
  const auto port=url.substr(prefix.size(),slash-prefix.size());
  uint32_t number=0;
  return unsignedNumber(port,number) && number<=65535 && slash!=std::string::npos &&
    url.substr(slash)=="/api/v1/admin/dataset-updates/publish";
}
std::string base64(const std::string& bytes) {
  const char* alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i=0;i<bytes.size();i+=3) {
    const size_t n=std::min(size_t(3),bytes.size()-i);
    const uint32_t v=uint32_t(uint8_t(bytes[i]))<<16 | (n>1 ? uint32_t(uint8_t(bytes[i+1]))<<8 : 0) | (n>2 ? uint8_t(bytes[i+2]) : 0);
    out+=alphabet[v>>18]; out+=alphabet[(v>>12)&63]; out+=n>1 ? alphabet[(v>>6)&63] : '='; out+=n>2 ? alphabet[v&63] : '=';
  }
  return out;
}
bool unzip(const uint8_t* bytes,size_t size,const std::string& name,std::string& out) {
  // Complete, single-member ZIP only. Bound output before allocating/inflating.
  if (size<22) return false;
  size_t end=size;
  for (size_t p=size-22+1;p--> (size>65557 ? size-65557 : 0);)
    if (u32(bytes+p)==0x06054b50 && p+22+u16(bytes+p+20)==size) {end=p;break;}
  if (end==size || u16(bytes+end+4) || u16(bytes+end+6) || u16(bytes+end+8)!=1 || u16(bytes+end+10)!=1) return false;
  const size_t central=u32(bytes+end+16), centralSize=u32(bytes+end+12);
  if (central>end || centralSize!=end-central || centralSize<46 || u32(bytes+central)!=0x02014b50) return false;
  const auto* c=bytes+central;
  const size_t compressed=u32(c+20), expanded=u32(c+24), local=u32(c+42);
  const auto flags=u16(c+8), method=u16(c+10), nameSize=u16(c+28);
  if ((flags & ~uint16_t(0x0808)) || (method!=0 && method!=8) || !expanded || expanded>budget || !compressed ||
      compressed>budget || local>central || central-local<30 || 46u+nameSize+u16(c+30)+u16(c+32)!=centralSize ||
      u16(c+34) || std::string(reinterpret_cast<const char*>(c+46),nameSize)!=name) return false;
  const auto* l=bytes+local;
  if (u32(l)!=0x04034b50 || u16(l+6)!=flags || u16(l+8)!=method || u16(l+26)!=nameSize) return false;
  const size_t data=local+30u+u16(l+26)+u16(l+28);
  if (data>central || compressed>central-data || std::string(reinterpret_cast<const char*>(l+30),nameSize)!=name) return false;
  if (!(flags & 8) && (u32(l+14)!=u32(c+16) || u32(l+18)!=compressed || u32(l+22)!=expanded)) return false;
  out.resize(expanded);
  if (method==0) { if (compressed!=expanded) return false; std::memcpy(out.data(),bytes+data,expanded); }
  else {
    tinfl_decompressor inflater; tinfl_init(&inflater);
    size_t in=compressed, written=expanded;
    const auto status=tinfl_decompress(&inflater,bytes+data,&in,reinterpret_cast<uint8_t*>(out.data()),
      reinterpret_cast<uint8_t*>(out.data()),&written,TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    if (status!=TINFL_STATUS_DONE || in!=compressed || written!=expanded) return false;
  }
  return mz_crc32(0,reinterpret_cast<const uint8_t*>(out.data()),out.size())==u32(c+16);
}
}

extern "C" int catalog_prepare_fetch(void) {
  using namespace catalog_fetch;
  const auto cfg=config(); auto job=product(text(cfg,"catalog_product"));
  if (!job.is_object()) return error("Select a supported GCAT or McCants product.");
  const auto provider=text(cfg,"catalog_provider_id"), publish=text(cfg,"catalog_publish_url");
  if (provider.empty() || provider.size()>128 || !loopback(publish)) return error("Provider identity and local dataset publication endpoint are required.");
  job["provider_id"]=provider;
  const Json request={{"method","GET"},{"url",job["source_url"]},{"timeoutMs",90000},
    {"maxBytes",budget},{"responseWire","raw-body-v1"}};
  return emit("request",request.dump()) || emit("job",job.dump());
}

extern "C" int catalog_unpack_fetch(void) {
  using namespace catalog_fetch;
  auto job=input("job"); const auto expected=product(text(job,"source_name"));
  if (!expected.is_object() || text(job,"source_url")!=text(expected,"source_url") || text(job,"provider_id").empty())
    return error("Source identity does not match a supported original catalog product.");
  decltype(plugin_get_input_frame(0)) response=nullptr;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i);
    if (f && f->port_id && !std::strcmp(f->port_id,"response")) { if(response) return error("Duplicate response."); response=f; }
  }
  if (!response || !response->payload || response->payload_length<8 || response->payload_length>budget+8 || std::memcmp(response->payload,"$HRB",4))
    return error("A complete bounded HTTP response is required.");
  const auto status=u32(response->payload+4);
  if (status==304) return emit("unchanged",Json({{"source_name",job["source_name"]},{"status",304}}).dump());
  if (status!=200) return error("The catalog origin did not return a complete edition (HTTP 200).");
  const auto* bytes=response->payload+8; const size_t size=response->payload_length-8;
  if (!size) return error("The catalog origin returned an empty edition.");
  std::string source;
  const auto member=text(expected,"member");
  if (!member.empty()) { if (!unzip(bytes,size,member,source)) return error("The original catalog ZIP failed size, member or CRC validation."); }
  else source.assign(reinterpret_cast<const char*>(bytes),size);
  auto meta=expected;
  meta.erase("member"); meta["schema"]="CAT.fbs"; meta["provider_id"]=job["provider_id"];
  meta["batch_id"]=ephem::sha256_hex(bytes,size); meta["reconcile"]="current";
  meta["_source_text_sha256"]=ephem::sha256_hex(reinterpret_cast<const uint8_t*>(source.data()),source.size());
  return emit("source",source) || emit("meta",meta.dump());
}

extern "C" int catalog_publish_request(void) {
  using namespace catalog_fetch;
  const auto result=input("result"), cfg=config();
  const auto source=product(text(cfg,"catalog_product"));
  if (plugin_get_input_count()!=1 || !result.is_object() || text(result,"schema")!="CAT.fbs" ||
      !result.contains("inserted") || !result["inserted"].is_number_integer() || result["inserted"]<0)
    return error("Catalog ingest did not confirm this edition; no publication was requested.");
  const auto url=text(cfg,"catalog_publish_url"), provider=text(cfg,"catalog_provider_id"), batch=text(result,"batch_id");
  if (!source.is_object() || !loopback(url) || batch.size()!=64 || provider.empty() ||
      !std::all_of(batch.begin(),batch.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}))
    return error("Complete edition identity and local publication endpoint are required.");
  const Json body={{"schema","CAT.fbs"},{"providerId",provider},{"sourceName",source["source_name"]},{"batchId",batch}};
  // Only the small publication request uses the HTTP node's control envelope.
  const Json request={{"method","POST"},{"url",url},{"headers",{{"Content-Type","application/json"}}},
    {"bodyB64",base64(body.dump())},{"timeoutMs",600000},{"maxBytes",1048576},{"responseWire","raw-body-v1"}};
  return emit("request",request.dump());
}
