#include "space_data_module_invoke.h"
#include <chrono>
#include <ctime>
#include <cstring>
#include <limits>

namespace ephemeris {
using Bytes=std::vector<uint8_t>;
constexpr size_t hardMaxBytes=32*1024*1024, maxEnvelope=48*1024*1024;
#ifndef EPHEMERIS_MODULE_ID
#define EPHEMERIS_MODULE_ID "com.digitalarsenal.data-source.ephemeris-source-host"
#endif
constexpr const char* moduleId=EPHEMERIS_MODULE_ID;
struct Reply {Json value;std::vector<Bytes> segments;};
const Json& registry(){static const Json value=Json::parse(EPHEMERIS_REGISTRY);return value;}
std::string iso(int64_t seconds) {
  std::time_t t=seconds; std::tm* tm=std::gmtime(&t); require(tm,"Invalid UTC epoch.");
  char value[32];std::strftime(value,sizeof(value),"%Y-%m-%dT%H:%M:%S.000Z",tm);return value;
}
int64_t now() {return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
const plugin_input_frame_t* frame(const char* port) {
  const plugin_input_frame_t* out=nullptr;
  for(uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i); require(f && f->port_id && f->payload_length<=maxEnvelope,"Invalid input frame.");
    if(std::strcmp(f->port_id,port)==0){require(!out,"Duplicate input frame.");out=f;}
  }
  return out;
}
Json input(const char* port) {
  const auto* f=frame(port);if(!f)return Json();
  auto j=Json::parse(f->payload,f->payload+f->payload_length,nullptr,false);require(!j.is_discarded(),"Invalid JSON input.");return j;
}
int emit_json(const char* port,const Json& j) {
  if(has_error())return -1;const auto s=j.dump();return plugin_push_output_ex(port,nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,reinterpret_cast<const uint8_t*>(s.data()),s.size());
}
int emit_record(const char* port,const char* schema,const char* identifier,const char* root,const Bytes& bytes) {
  if(has_error())return -1;return plugin_push_output_ex(port,schema,identifier,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,bytes.data(),bytes.size());
}
std::string digest(const Bytes& b){return ephem::sha256_hex(b.data(),b.size());}
std::string digest(const std::string& s){return ephem::sha256_hex(reinterpret_cast<const uint8_t*>(s.data()),s.size());}
std::string hex(const Bytes& b){static constexpr char h[]="0123456789abcdef";std::string s;for(uint8_t c:b){s+=h[c>>4];s+=h[c&15];}return s;}
Bytes base64(const std::string& value) {
  Bytes out;require(sdm_keyslot::detail::decode_base64_bytes(value,&out),"Invalid binary capability response.");return out;
}
Reply call(const std::string& op,const Json& params,const std::vector<sdm_hostcall::Segment>& segments={}) {
#ifdef EPHEMERIS_HOST_ADAPTER
  if(has_error())return {};
  const auto request=sdm_hostcall::build_envelope(params.dump(),segments);
  sdm_host_call(op.data(),op.size(),reinterpret_cast<const char*>(request.data()),request.size());
  const auto size=sdm_host_response_len();require(size>=8 && size<=int32_t(maxEnvelope),"Host capability response exceeds bounds.");
  Bytes bytes(size);require(sdm_host_read_response(reinterpret_cast<char*>(bytes.data()),size)==size,"Incomplete host response.");sdm_host_clear_response();
  sdm_hostcall::Response envelope;require(sdm_hostcall::parse_envelope(bytes.data(),bytes.size(),&envelope),"Invalid capability envelope.");
  const auto j=Json::parse(envelope.meta,nullptr,false);
  // Do not echo host errors: authenticated providers may include request bodies.
  require(j.is_object() && j.value("ok",false),"A required host capability failed.");
  return {j.value("result",Json()),std::move(envelope.segments)};
#else
  record_error("Portable core requires explicit response frames; host capabilities belong to the scheduled adapter.");return {};
#endif
}
Bytes binary(const Reply& r,const Json& field) {
  if(field.is_object() && field.contains("$bin")) {
    const auto i=field["$bin"].get<size_t>(); require(i<r.segments.size(),"Invalid binary segment reference.");return r.segments[i];
  }
  require(field.is_string(),"Missing binary capability payload.");return base64(field.get<std::string>());
}
Json source_for(const std::string& id) {for(const auto& s:registry()["sources"])if(s["source_id"]==id)return s;record_error("Unknown ephemeris source ID.");return {};}
int bounded_config(const Json& config,const char* name,int fallback,int low,int high) {
  if(!config.contains(name))return fallback;
  require(config[name].is_number_integer(),"Retriever limits must be integers.");const auto n=config[name].get<int64_t>();
  require(n>=low && n<=high,"Retriever limit is outside its permitted bounds.");return int(n);
}
struct Http {int status=0;Bytes body;Json headers=Json::object(),header_values=Json::object();};
#ifdef EPHEMERIS_AUTH_SUPPORT
struct Context;void authenticated_cleanup(Context&);
#endif
struct Context {
  Json source,config,fixtures,private_state=Json::object();int64_t epoch;int timeout=15000;size_t maxBytes=16*1024*1024;size_t requests=0;std::chrono::steady_clock::time_point deadline;
  bool ready=false;
  Context(Json cfg,Json responses=Json()):config(std::move(cfg)),fixtures(std::move(responses)){ready=initialize();}
#ifdef EPHEMERIS_AUTH_SUPPORT
  ~Context(){authenticated_cleanup(*this);}
#endif
  bool initialize() {
    require(config.is_object() && config.contains("source_id") && config["source_id"].is_string(),"A source_id is required.");source=source_for(config["source_id"]);
    if(config.contains("epoch_seconds"))require(config["epoch_seconds"].is_number_integer(),"Retrieval epoch must be an integer.");epoch=config.value("epoch_seconds",now());require(epoch>315964800 && epoch<4102444800LL,"Invalid retrieval epoch.");
    deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(bounded_config(config,"max_runtime_ms",90000,1000,300000));
    timeout=bounded_config(config,"timeout_ms",15000,1000,30000);maxBytes=bounded_config(config,"max_bytes",16*1024*1024,1024,hardMaxBytes);require(!has_error(),"Invalid context limits.");return true;
  }
  Http request(const std::string& url,const std::string& method="GET",const std::string& body="",Json headers=Json::object()) {
    validate_url(source,url);require(++requests<=128,"Per-invocation HTTP request budget exceeded.");
    const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-std::chrono::steady_clock::now()).count();require(remaining>=1000,"Retrieval deadline reached; durable position is unchanged.");const int requestTimeout=std::min<int64_t>(timeout,remaining);
    Http out;
    if(fixtures.is_object()) {
      require(fixtures.contains(url),"Discovery response fixture missing.");const auto& f=fixtures[url];out.status=f.value("status",200);out.headers=f.value("headers",Json::object());out.header_values=f.value("header_values",Json::object());
      const auto text=f.value("body",std::string());out.body=f.value("body_encoding",std::string())=="base64"?base64(text):Bytes(text.begin(),text.end());
    } else {
      Json params={{"url",url},{"method",method},{"body",body},{"headers",headers},{"timeout_ms",requestTimeout},{"timeoutMs",requestTimeout},{"max_bytes",maxBytes},{"maxBytes",maxBytes}};
#ifdef EPHEMERIS_AUTH_SUPPORT
      params["follow_redirects"]=false;
#endif
      auto r=call("http.request",params);require(r.value.is_object(),"Invalid HTTP capability response.");out.status=r.value.value("status",0);out.headers=r.value.value("headers",Json::object());out.header_values=r.value.value("header_values",Json::object());
      const auto f=r.value.value("body",Json());
      if(f.is_object())out.body=binary(r,f);
      else if(f.is_string()){const auto text=f.get<std::string>();out.body=r.value.value("body_encoding",std::string())=="base64"?base64(text):Bytes(text.begin(),text.end());}
    }
    require(out.body.size()<=maxBytes,"HTTP response exceeds the byte budget; no truncated artifact is accepted.");return out;
  }
  Http full(const std::string& url,const std::string& method="GET",const std::string& body="",Json headers=Json::object()) {
    auto r=request(url,method,body,headers);
    if(r.status==304) {
      // Hosts may remember a validator even after a failed local commit. A
      // full-byte retrieval cannot use 304 as proof that this node archived it.
      headers["If-None-Match"]="\"sdn-ephemeris-force-full-v1\"";
      headers["If-Modified-Since"]="Thu, 01 Jan 1970 00:00:00 GMT";
      r=request(url,method,body,headers);
    }
    require(r.status==200 && !r.body.empty(),"Upstream did not return a complete nonempty HTTP 200 response.");return r;
  }
};
#ifdef EPHEMERIS_AUTH_SUPPORT
bool authenticated_ready(Context&);
Json discover_authenticated(Context&);
Http fetch_authenticated(Context&,const Json&);
#endif
Json discover(Context& ctx) {
  if(ctx.source["credentialed"]==true) {
#ifdef EPHEMERIS_AUTH_SUPPORT
    return discover_authenticated(ctx);
#else
    record_error("Credentials required: install the restricted source adapter for this source.");return {};
#endif
  }
  return discover_public(ctx.source,ctx.epoch,[&](const std::string& url)->std::string{const auto r=ctx.request(url); if(r.status==404 && url.find("/products/")!=std::string::npos)return std::string(); require(r.status==200 && !r.body.empty(),"Discovery requires a complete HTTP 200 listing.");return std::string(r.body.begin(),r.body.end());});
}
Http fetch_resource(Context& ctx,const Json& item) {
  require(item.is_object() && item.contains("source_id") && item["source_id"].is_string() && item.contains("url") && item["url"].is_string() && item.contains("format") && item["format"].is_string(),"Invalid source resource descriptor.");
  require(item["source_id"]==ctx.source["source_id"],"Resource source mismatch.");
  if(ctx.source["credentialed"]==true) {
#ifdef EPHEMERIS_AUTH_SUPPORT
    return fetch_authenticated(ctx,item);
#else
    record_error("Credentials required: install the restricted source adapter for this source.");return {};
#endif
  }
  return ctx.full(item.at("url").get<std::string>());
}
bool validate_raw(const Json& item,const Bytes& bytes) {
  require(item.is_object() && item.contains("format") && item["format"].is_string(),"Raw format descriptor missing.");require(!bytes.empty() && bytes.size()<=hardMaxBytes,"Invalid raw artifact size.");const auto format=item["format"].get<std::string>();require(format!="vimpel-html","Provider HTML is not an orbital container and cannot be represented as NCD.");
  if(format=="sp3-gzip")require(bytes.size()>2 && bytes[0]==31 && bytes[1]==139,"SP3 archive is not gzip data.");
  else if(format=="css-oem-zip")require(bytes.size()>4 && bytes[0]=='P' && bytes[1]=='K',"CSS archive is not ZIP data.");
  else if(format!="vimpel-html") {
    auto head=std::string(bytes.begin(),bytes.begin()+std::min<size_t>(bytes.size(),512));
    std::transform(head.begin(),head.end(),head.begin(),[](unsigned char c){return char(std::tolower(c));});
    require(head.find("<!doctype html")==std::string::npos && head.find("<html")==std::string::npos,"Upstream returned an HTML page instead of the requested source file.");
  }
  return true;
}
#ifdef EPHEMERIS_HOST_ADAPTER
std::string ipfs_add(const Bytes& bytes) {
  auto r=call("ipfs.add",{{"content",{{"$bin",0}}}},{{bytes.data(),bytes.size()}});std::string cid;
  if(r.value.is_object())cid=r.value.value("Hash",r.value.value("cid",std::string()));
  require(!cid.empty() && cid.size()<200 && cid.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")==std::string::npos,"IPFS did not return a valid content identifier.");return cid;
}
Bytes ipfs_cat(const std::string& cid) {auto r=call("ipfs.cat",{{"cid",cid}});if(r.value.is_object() && r.value.contains("data"))return binary(r,r.value["data"]);return binary(r,r.value);}
bool store(const char* schema,const Bytes& bytes) {
  auto r=call("storage.write",{{"schema",schema},{"data",{{"$bin",0}}}},{{bytes.data(),bytes.size()}});
  require(r.value.is_object() && !r.value.value("cid",std::string()).empty(),"Storage did not confirm the durable record.");return true;
}
#endif
Bytes finish(flatbuffers::FlatBufferBuilder& b){return Bytes(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());}
Bytes descriptor(const Json& item,const Bytes& raw,const std::string& cid) {
  flatbuffers::FlatBufferBuilder b(512);auto format=ncdContainerFormat_PROVIDER_DEFINED;
  const auto kind=item["format"].get<std::string>();if(kind=="ccsds-oem-kvn")format=ncdContainerFormat_CCSDS_OEM_KVN;
  const auto name=b.CreateString(kind),hash=b.CreateString(digest(raw)),content=b.CreateString(cid);
  NCDBuilder record(b);record.add_FORMAT(format);if(format==ncdContainerFormat_PROVIDER_DEFINED)record.add_PROVIDER_DEFINED_FORMAT_NAME(name);
  record.add_SOURCE_BYTE_LENGTH(raw.size());record.add_SOURCE_SHA256(hash);record.add_SOURCE_CID(content);
  b.FinishSizePrefixed(record.Finish(),"$NCD");return finish(b);
}
#ifdef EPHEMERIS_HOST_ADAPTER
struct Resume {uint64_t sequence=0,bytes=0;uint32_t next=0;std::string queueCid;bool complete=false;std::string updated;};
Resume restore(const std::string& job) {
  const auto r=call("storage.flatsql_query_stream",{{"sql","SELECT _data FROM IRM WHERE JOB_ID = ? ORDER BY SEQUENCE DESC LIMIT 1"},{"params",Json::array({{{"t","str"},{"v",job}}})}});
  require(r.value.is_object(),"Invalid resume query result.");if(r.value.value("rows",0)==0)return {};
  const auto bytes=binary(r,r.value.at("stream"));flatbuffers::Verifier verifier(bytes.data(),bytes.size());require(VerifySizePrefixedIRMBuffer(verifier),"Invalid durable resume record.");
  const auto* mark=GetSizePrefixedIRM(bytes.data());require(mark->JOB_ID() && mark->JOB_ID()->str()==job && mark->SOURCE() && mark->SOURCE()->SOURCE_CID() && mark->UPDATED_AT(),"Resume mark identity mismatch.");
  require(mark->RANGE_MODE()==irmRangeMode_PART_INDEX,"Resume mark has incompatible addressing.");
  return {mark->SEQUENCE(),mark->BYTES_COMMITTED(),mark->NEXT_CHUNK_INDEX(),mark->SOURCE()->SOURCE_CID()->str(),mark->STATE()==irmJobState_COMPLETE,mark->UPDATED_AT()->str()};
}
Bytes checkpoint(const Context& ctx,const Resume& resume,const std::string& job,size_t total,const std::string& rawHash,size_t rawBytes,const std::string& stamp) {
  flatbuffers::FlatBufferBuilder b(2048);auto cid=b.CreateString(resume.queueCid),locator=b.CreateString("ipfs://"+resume.queueCid),object=b.CreateString(ctx.source["source_id"].get<std::string>());
  IRMSourceBuilder source(b);source.add_SOURCE_URL(locator);source.add_SOURCE_CID(cid);source.add_SOURCE_OBJECT_ID(object);source.add_VALIDATOR_MATCH(irmValidatorMatch_MATCHED);const auto src=source.Finish();
  const auto batch=b.CreateString(rawHash),time=b.CreateString(stamp);IRMChunkBuilder chunk(b);chunk.add_CHUNK_INDEX(resume.next?resume.next-1:0);chunk.add_BATCH_ID(batch);chunk.add_BYTE_LENGTH(rawBytes);chunk.add_CHUNK_SHA256(batch);chunk.add_RECORDS_DECODED(1);chunk.add_RECORDS_STORED(1);chunk.add_ATTEMPTS(1);chunk.add_COMMITTED_AT(time);const auto part=chunk.Finish();
  const auto name=b.CreateString(job),ingestor=b.CreateString(moduleId),standard=b.CreateString("$NCD"),reconcile=b.CreateString("append"),merge=b.CreateString("content-sha256"),note=b.CreateString("PART_INDEX enumerates the immutable credential-free resource index. Next part advances only after raw file and attributed NCD are durable. SDN source publication retries independently.");
  IRMBuilder mark(b);mark.add_JOB_ID(name);mark.add_SEQUENCE(resume.sequence);mark.add_PROVIDER_ID(object);mark.add_INGESTOR_ID(ingestor);mark.add_SOURCE(src);mark.add_STATE(resume.next==total?irmJobState_COMPLETE:irmJobState_IN_PROGRESS);mark.add_RANGE_MODE(irmRangeMode_PART_INDEX);mark.add_NEXT_CHUNK_INDEX(resume.next);mark.add_CHUNK_BYTE_BUDGET(ctx.maxBytes);if(resume.next)mark.add_LAST_CHUNK(part);mark.add_CHUNKS_COMMITTED(resume.next);mark.add_BYTES_COMMITTED(resume.bytes);mark.add_RECORDS_COMMITTED(resume.next);mark.add_TARGET_STANDARD(standard);mark.add_RECONCILE_MODE(reconcile);mark.add_MERGE_POLICY(merge);mark.add_UPDATED_AT(time);mark.add_NOTES(note);if(resume.next==total)mark.add_COMPLETED_AT(time);
  b.FinishSizePrefixed(mark.Finish(),"$IRM");return finish(b);
}
const std::set<std::string>& option_names(){static const std::set<std::string> names={"ephemeris_enabled","ephemeris_source_id","ephemeris_max_resources","ephemeris_max_bytes","ephemeris_timeout_ms","ephemeris_max_runtime_ms","ephemeris_refresh_interval_sec","ephemeris_secret_id","ephemeris_spire_paths"};return names;}
Json& configured_options(){static Json value=Json::object();return value;}
Json validate_options(const Json& value){
  require(value.is_object(),"Retriever configuration must be an object.");
  for(auto i=value.begin();i!=value.end();++i)require(option_names().count(i.key()),"Unknown retriever option; credentials never belong in module inputs.");
  if(value.contains("ephemeris_enabled"))require(value["ephemeris_enabled"].is_boolean(),"ephemeris_enabled must be boolean.");
  if(value.contains("ephemeris_source_id")){require(value["ephemeris_source_id"].is_string(),"source_id must be a string.");const auto source=source_for(value["ephemeris_source_id"]);require(!has_error(),"Unknown source configuration.");
#ifdef EPHEMERIS_FIXED_SOURCE_ID
    require(value["ephemeris_source_id"]==EPHEMERIS_FIXED_SOURCE_ID,"This artifact only serves its compiled provider.");
#endif
  }
  if(value.value("ephemeris_enabled",false))require(value.contains("ephemeris_source_id"),"Enabled retrieval requires a source_id.");
  bounded_config(value,"ephemeris_max_resources",4,1,64);bounded_config(value,"ephemeris_max_bytes",16*1024*1024,1024,hardMaxBytes);bounded_config(value,"ephemeris_timeout_ms",15000,1000,30000);bounded_config(value,"ephemeris_max_runtime_ms",90000,1000,300000);bounded_config(value,"ephemeris_refresh_interval_sec",86400,3600,604800);
  if(value.contains("ephemeris_secret_id")){require(value["ephemeris_secret_id"].is_string(),"A secret lane ID must be a string.");const auto lane=value["ephemeris_secret_id"].get<std::string>();require(lane.size()>=2 && lane.size()<=64 && lane.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-")==std::string::npos,"Invalid secret lane identifier.");}
  if(value.contains("ephemeris_spire_paths")){const auto& paths=value["ephemeris_spire_paths"];require(paths.is_array() && !paths.empty() && paths.size()<=16,"Spire paths must be a bounded nonempty array.");for(const auto& path:paths){require(path.is_string(),"Spire paths must be strings.");const auto text=path.get<std::string>();require(text.size()<=128 && !text.empty() && text[0]=='/' && text.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/")==std::string::npos && text.find("//")==std::string::npos,"Spire paths must be safe absolute API paths without query parameters.");}}
  require(!has_error(),"Invalid retriever configuration.");return value;
}
int execute_configure(){const auto options=validate_options(input("request"));require(!has_error(),"Invalid retriever configuration.");configured_options()=options;return emit_json("status",{{"status","configured"},{"source_id",options.value("ephemeris_source_id",std::string())},{"enabled",options.value("ephemeris_enabled",false)}})<0?1:0;}
int execute_pull() {
  auto supplied=call("plugin.getConfig",Json::object()).value;require(supplied.is_null() || supplied.is_object(),"Host configuration unavailable.");if(supplied.is_null())supplied=Json::object();
  Json merged=configured_options();for(const auto& key:option_names())if(supplied.contains(key))merged[key]=supplied[key];const auto host=validate_options(merged);require(!has_error(),"Invalid retriever configuration.");
  if(!host.value("ephemeris_enabled",false))return emit_json("status",{{"status","disabled"}})<0?1:0;
  Json cfg={{"source_id",host.value("ephemeris_source_id",std::string())},{"max_bytes",host.value("ephemeris_max_bytes",16*1024*1024)},{"timeout_ms",host.value("ephemeris_timeout_ms",15000)},{"max_runtime_ms",host.value("ephemeris_max_runtime_ms",90000)}};
  if(host.contains("ephemeris_secret_id"))cfg["secret_id"]=host["ephemeris_secret_id"];
  if(host.contains("ephemeris_spire_paths"))cfg["spire_paths"]=host["ephemeris_spire_paths"];
  Context ctx(cfg);require(ctx.ready,"Invalid source configuration.");const auto sourceId=ctx.source["source_id"].get<std::string>();
#ifdef EPHEMERIS_FIXED_SOURCE_ID
  require(sourceId==EPHEMERIS_FIXED_SOURCE_ID,"This artifact only serves its compiled provider.");
#endif
#ifdef EPHEMERIS_AUTH_SUPPORT
  if(!authenticated_ready(ctx))return emit_json("status",{{"source_id",sourceId},{"status","credential-unavailable"},{"normalized_records",0}})<0?1:0;
#endif
  const int cap=bounded_config(host,"ephemeris_max_resources",4,1,64),wall=bounded_config(host,"ephemeris_max_runtime_ms",90000,1000,300000);
  const auto started=std::chrono::steady_clock::now();const auto job=std::string(moduleId)+":"+sourceId;auto resume=restore(job);Json queue;
  const auto refresh=bounded_config(host,"ephemeris_refresh_interval_sec",ctx.source["refresh_interval_sec"].get<int>(),3600,604800);
  if(resume.complete && resume.updated>iso(ctx.epoch-refresh))return emit_json("status",{{"source_id",sourceId},{"status","waiting-refresh"},{"completed",resume.next},{"normalized_records",0}})<0?1:0;
  if(!resume.queueCid.empty() && !resume.complete) {
    const auto bytes=ipfs_cat(resume.queueCid);const auto envelope=Json::parse(bytes,nullptr,false);require(envelope.is_object() && envelope.contains("resources"),"Invalid pinned discovery envelope.");queue=envelope["resources"];require(queue.is_array() && !queue.empty() && queue.size()<=100000,"Invalid pinned discovery queue.");
  } else {
    queue=discover(ctx);require(queue.is_array() && !queue.empty() && queue.size()<=100000,"Discovery must return a bounded nonempty source queue.");const auto text=Json{{"discovered_at",iso(ctx.epoch)},{"resources",queue}}.dump();resume.queueCid=ipfs_add(Bytes(text.begin(),text.end()));resume.next=0;resume.bytes=0;resume.complete=false;++resume.sequence;store("IRM.fbs",checkpoint(ctx,resume,job,queue.size(),"",0,iso(ctx.epoch)));
  }
  require(resume.next<=queue.size(),"Resume position exceeds the resource index.");int fetched=0;
  for(;resume.next<queue.size() && fetched<cap;++fetched) {
    if(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count()>=wall)break;
    const auto& item=queue[resume.next];const auto response=fetch_resource(ctx,item);
    if(item["format"]=="vimpel-html")return emit_json("status",{{"source_id",sourceId},{"status","provider-page-only"},{"source_url",item["url"]},{"bytes",response.body.size()},{"sha256",digest(response.body)},{"normalized_records",0},{"note","Authenticated provider page is not an orbital export; no NCD was stored."}})<0?1:0;
    validate_raw(item,response.body);
    const auto stamp=iso(now()),rawCid=ipfs_add(response.body),hash=digest(response.body);const auto ncd=descriptor(item,response.body,rawCid);
    const auto provenance=Json{{"source_id",sourceId},{"source_url",item["url"]},{"format",item["format"]},{"source_cid",rawCid},{"source_sha256",hash},{"source_byte_length",response.body.size()},{"retrieved_at",stamp},{"normalized_records",0},{"discovery_queue_cid",resume.queueCid},{"discovery_job_id",digest(resume.queueCid)},{"parser_version","raw-preservation/0.1.0"}}.dump();
    const auto ingested=call("storage.ingest_with_source",{{"schema","NCD.fbs"},{"provider_id","ephemeris-provider:"+sourceId},{"source_name",sourceId},{"source_url",item["url"]},{"batch_id",hash},{"reconcile","duplicates"},{"records",{{"$bin",0}}},{"provenance",{{"source",sourceId},{"json",{{"$bin",1}}}}}},{{ncd.data(),ncd.size()},{reinterpret_cast<const uint8_t*>(provenance.data()),provenance.size()}});
    require(ingested.value.is_object() && ingested.value.contains("inserted"),"Source ingestion did not confirm durable records.");
    ++resume.next;++resume.sequence;resume.bytes+=response.body.size();store("IRM.fbs",checkpoint(ctx,resume,job,queue.size(),hash,response.body.size(),stamp));
    require(emit_record("descriptor","NCD.fbs","$NCD","NCD",ncd)>=0,"Could not emit acquisition receipt.");
  }
  return emit_json("status",{{"source_id",sourceId},{"retrieved",fetched},{"completed",resume.next},{"total",queue.size()},{"remaining",queue.size()-resume.next},{"queue_cid",resume.queueCid},{"normalized_records",0},{"status",resume.next==queue.size()?"complete":"in-progress"}})<0?1:0;
}
#endif
int guarded(const std::function<int()>& action){clear_error();const auto status=action();if(has_error()){plugin_set_error("ephemeris-retrieval-failed",error_text().c_str());return 1;}return status;}
}
extern "C" int describe_sources(){return ephemeris::guarded([]()->int{return ephemeris::emit_json("sources",ephemeris::registry())<0?1:0;});}
extern "C" int plan_source_requests(){return ephemeris::guarded([]()->int{using namespace ephemeris;Context ctx(input("config"));require(ctx.ready,"Invalid source configuration.");auto requests=initial_requests(ctx.source,ctx.epoch);for(auto& r:requests){r["timeout_ms"]=ctx.timeout;r["max_bytes"]=ctx.maxBytes;}return emit_json("requests",requests)<0?1:0;});}
extern "C" int discover_sources(){return ephemeris::guarded([]()->int{ephemeris::Context ctx(ephemeris::input("config"),ephemeris::input("responses"));require(ctx.ready,"Invalid source configuration.");return ephemeris::emit_json("resources",ephemeris::discover(ctx))<0?1:0;});}
extern "C" int describe_artifact(){return ephemeris::guarded([]()->int{using namespace ephemeris;const auto item=input("resource"),receipt=input("receipt");require(item.is_object() && item.contains("source_id") && item["source_id"].is_string() && item.contains("url") && item["url"].is_string() && receipt.is_object() && receipt.contains("cid") && receipt["cid"].is_string(),"Invalid artifact descriptor inputs.");const auto* payload=frame("body");require(payload,"Raw body frame missing.");const Bytes bytes(payload->payload,payload->payload+payload->payload_length);validate_url(source_for(item.at("source_id")),item.at("url"));validate_raw(item,bytes);const auto cid=receipt.value("cid",std::string());require(!cid.empty(),"Content identifier missing.");return emit_record("descriptor","NCD.fbs","$NCD","NCD",descriptor(item,bytes,cid))<0?1:0;});}
#ifdef EPHEMERIS_HOST_ADAPTER
extern "C" int configure(){return ephemeris::guarded(ephemeris::execute_configure);}
extern "C" int pull(){return ephemeris::guarded(ephemeris::execute_pull);}

#endif
