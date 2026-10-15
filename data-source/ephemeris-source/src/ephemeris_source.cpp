// Ephemeris source retrieval on the typed contracts (1.0): every frame between modules and every hostcall is an SDS
// FlatBuffer. $SRG (data source registry) carries the registry, discovery queues, single jobs, content receipts,
// retrieval settings and status; HttpRequest / HttpResponse (HREQ / HRSP) carry the fetches; $NCD the raw-container
// descriptors and $CAT the declared object coverage. The scheduled adapter (EPHEMERIS_HOST_ADAPTER) reaches the host
// through sdm_piv (typedHostcall.hpp): plugin.getConfig, http.request, ipfs.add / ipfs.cat, storage.write,
// storage.flatsql_query_stream and storage.ingest_with_source. JSON stays inside the module (the compiled registry
// and discovery's working values); none crosses a port, a hostcall or a stored record.
#include <chrono>
#include <cmath>
#include <ctime>
#include <cstring>
#include <limits>

namespace ephemeris {
using Bytes=std::vector<uint8_t>;
namespace R=sdn::runtime;
// A compiled provider may admit larger native containers. Runtime options can
// only lower this ceiling; the generic public adapter keeps its 32 MiB limit.
#ifndef EPHEMERIS_MAX_RESOURCE_BYTES
#define EPHEMERIS_MAX_RESOURCE_BYTES (32*1024*1024)
#endif
constexpr size_t hardMaxBytes=EPHEMERIS_MAX_RESOURCE_BYTES;
static_assert(hardMaxBytes>=1024 && hardMaxBytes<=96*1024*1024,"Invalid compiled resource ceiling");
constexpr size_t maxEnvelope=hardMaxBytes+hardMaxBytes/2;
#ifndef EPHEMERIS_MODULE_ID
#define EPHEMERIS_MODULE_ID "com.digitalarsenal.data-source.ephemeris-source-host"
#endif
constexpr const char* moduleId=EPHEMERIS_MODULE_ID;
constexpr const char* ledgerFormat="srg-retrieval-status";
constexpr const char* ledgerVersion="1";
const Json& registry(){static const Json value=Json::parse(EPHEMERIS_REGISTRY);return value;}
std::string iso(int64_t seconds) {
  std::time_t t=seconds; std::tm* tm=std::gmtime(&t); require(tm,"Invalid UTC epoch.");
  char value[32];std::strftime(value,sizeof(value),"%Y-%m-%dT%H:%M:%S.000Z",tm);return value;
}
int64_t now() {return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
std::string text(const flatbuffers::String* s){return s?s->str():std::string();}
Bytes finish(flatbuffers::FlatBufferBuilder& b){return Bytes(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());}

// ---- input frames ------------------------------------------------------------------------------------------------
std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for(uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* f=plugin_get_input_frame(i); require(f && f->port_id && f->payload_length<=maxEnvelope,"Invalid input frame.");
    if(std::strcmp(f->port_id,port)==0)out.push_back(f);
  }
  return out;
}
const plugin_input_frame_t* frame(const char* port) {
  const auto all=frames(port);require(all.size()<=1,"Duplicate input frame.");return all.empty()?nullptr:all.front();
}
// One size-prefixed $SRG.
const SRG* srg_bytes(const uint8_t* data,size_t size) {
  require(data && size>=8,"Missing $SRG record.");
  flatbuffers::Verifier verifier(data,size,64,1000000,false);require(VerifySizePrefixedSRGBuffer(verifier),"The frame is not a size-prefixed $SRG record.");
  return GetSizePrefixedSRG(data);
}
const SRG* srg_input(const char* port,bool required=true) {
  const auto* f=frame(port);if(!f){require(!required,"A $SRG input frame is required.");return nullptr;}
  return srg_bytes(f->payload,f->payload_length);
}
// The one HttpResponse of a port: verified; its CONTEXT, when the caller needs it, is a job (an $SRG with one resource).
const R::HttpResponse* response_input(const char* port) {
  const auto* f=frame(port);require(f && f->payload_length,"An HttpResponse (HRSP) frame is required.");
  flatbuffers::Verifier verifier(f->payload,f->payload_length,64,1000000,false);require(R::VerifyHttpResponseBuffer(verifier),"The frame is not an HttpResponse (HRSP).");
  return R::GetHttpResponse(f->payload);
}

// ---- $SRG records --------------------------------------------------------------------------------------------------
Json source_for(const std::string& id) {for(const auto& s:registry()["sources"])if(s["source_id"]==id)return s;record_error("Unknown ephemeris source ID.");return {};}
Json resource_json(const SRGResource* r) {
  require(r,"Missing resource.");Json item={{"source_id",text(r->SOURCE_ID())},{"resource_id",text(r->RESOURCE_ID())},{"url",text(r->URL())},{"format",text(r->FORMAT())}};
  if(item["format"]=="" && item["source_id"]!="") {const auto source=source_for(item["source_id"]);if(!has_error())item["format"]=source["format"];}
  return item;
}
// The resource of a job: an $SRG carrying exactly one RESOURCES entry.
Json job_resource(const SRG* job) {require(job && job->RESOURCES() && job->RESOURCES()->size()==1,"A job is one $SRG with exactly one resource.");return resource_json(job->RESOURCES()->Get(0));}
flatbuffers::Offset<SRGResource> resource_fb(flatbuffers::FlatBufferBuilder& b,const Json& item,int64_t discovered_ms) {
  return CreateSRGResourceDirect(b,item.value("source_id",std::string()).c_str(),item.value("resource_id",std::string()).c_str(),item.value("url",std::string()).c_str(),
    item.value("format",std::string()).c_str(),0,0,0,discovered_ms);
}
Bytes finish_srg(flatbuffers::FlatBufferBuilder& b,flatbuffers::Offset<SRG> root){FinishSizePrefixedSRGBuffer(b,root);return finish(b);}
// A discovery queue: the resources in retrieval order, GENERATED_AT_MS the time of discovery.
Bytes srg_queue(const Json& queue,int64_t generated_ms) {
  flatbuffers::FlatBufferBuilder b(1024+queue.size()*192);std::vector<flatbuffers::Offset<SRGResource>> items;
  for(const auto& item:queue)items.push_back(resource_fb(b,item,generated_ms));
  const auto list=b.CreateVector(items);SRGBuilder srg(b);srg.add_GENERATED_AT_MS(generated_ms);srg.add_RESOURCES(list);return finish_srg(b,srg.Finish());
}
Json queue_resources(const SRG* queue) {
  require(queue && queue->RESOURCES(),"A discovery queue carries resources.");Json out=Json::array();
  for(const auto* r:*queue->RESOURCES())out.push_back(resource_json(r));return out;
}
Bytes srg_job(const Json& item,int64_t discovered_ms) {
  flatbuffers::FlatBufferBuilder b(512);const auto one=resource_fb(b,item,discovered_ms);const auto list=b.CreateVector(&one,1);
  SRGBuilder srg(b);srg.add_RESOURCES(list);return finish_srg(b,srg.Finish());
}
Bytes srg_registry() {
  const auto& reg=registry();flatbuffers::FlatBufferBuilder b(16384);std::vector<flatbuffers::Offset<SRGProvider>> providers;
  for(const auto& s:reg["sources"]) {
    std::vector<flatbuffers::Offset<flatbuffers::String>> origins;for(const auto& o:s["origins"])origins.push_back(b.CreateString(o.get<std::string>()));
    providers.push_back(CreateSRGProviderDirect(b,s.value("source_id",std::string()).c_str(),s.value("name",std::string()).c_str(),s.value("operator",std::string()).c_str(),
      s.value("format",std::string()).c_str(),&origins,s.value("refresh_interval_sec",0u),s.value("credentialed",false)));
  }
  const auto list=b.CreateVector(providers);const auto repository=b.CreateString(reg.value("upstream_repository",std::string())),revision=b.CreateString(reg.value("upstream_revision",std::string())),
    path=b.CreateString(reg.value("registry_path",std::string())),id=b.CreateString("ephemeris-source");
  SRGBuilder srg(b);srg.add_REGISTRY_ID(id);srg.add_UPSTREAM_REPOSITORY(repository);srg.add_UPSTREAM_REVISION(revision);srg.add_REGISTRY_PATH(path);srg.add_PROVIDERS(list);return finish_srg(b,srg.Finish());
}
// Retrieval settings as the context's working values (a zero or empty field takes the default).
Json settings_json(const SRGRetrievalSettings* s) {
  Json out=Json::object();if(!s)return out;
  if(s->SOURCE_ID())out["source_id"]=s->SOURCE_ID()->str();
  if(s->EPOCH_MS())out["epoch_seconds"]=s->EPOCH_MS()/1000;
  if(s->TIMEOUT_MS())out["timeout_ms"]=int64_t(s->TIMEOUT_MS());
  if(s->MAX_BYTES())out["max_bytes"]=int64_t(std::min<uint64_t>(s->MAX_BYTES(),uint64_t(std::numeric_limits<int64_t>::max())));
  if(s->MAX_RUNTIME_MS())out["max_runtime_ms"]=int64_t(s->MAX_RUNTIME_MS());
  if(s->CREDENTIAL_REFERENCE())out["secret_id"]=s->CREDENTIAL_REFERENCE()->str();
  if(s->PATHS()){Json paths=Json::array();for(const auto* p:*s->PATHS())paths.push_back(p->str());out["spire_paths"]=paths;}
  return out;
}
// What a retriever reports: one $SRG with STATUS.
struct Status {
  std::string source_id,queue_cid,resource_url,sha256,note;srgRetrievalState state=srgRetrievalState_Unknown;bool enabled=false;
  uint32_t retrieved=0,completed=0,total=0,remaining=0,scanned=0,supported=0,next_offset=0;uint64_t reserved=0,archive_max=0,normalized=0,bytes=0;
};
flatbuffers::Offset<SRGRetrievalStatus> status_fb(flatbuffers::FlatBufferBuilder& b,const Status& s,int64_t at_ms) {
  return CreateSRGRetrievalStatusDirect(b,s.source_id.empty()?nullptr:s.source_id.c_str(),s.state,s.enabled,at_ms,s.retrieved,s.completed,s.total,s.remaining,
    s.queue_cid.empty()?nullptr:s.queue_cid.c_str(),s.reserved,s.archive_max,s.normalized,s.resource_url.empty()?nullptr:s.resource_url.c_str(),s.bytes,
    s.sha256.empty()?nullptr:s.sha256.c_str(),s.scanned,s.supported,s.next_offset,s.note.empty()?nullptr:s.note.c_str());
}
Bytes srg_status(const Status& s) {
  const int64_t at=now()*1000;flatbuffers::FlatBufferBuilder b(512);const auto status=status_fb(b,s,at);SRGBuilder srg(b);srg.add_GENERATED_AT_MS(at);srg.add_STATUS(status);return finish_srg(b,srg.Finish());
}

// ---- output frames ---------------------------------------------------------------------------------------------------
int emit_srg(const char* port,const Bytes& bytes) {
  if(has_error())return -1;return plugin_push_output_ex(port,"SRG.fbs","$SRG",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"SRG",0,0,bytes.data(),bytes.size());
}
int emit_status(const Status& s){return emit_srg("status",srg_status(s))<0?1:0;}
int emit_record(const char* port,const char* schema,const char* identifier,const char* root,const Bytes& bytes) {
  if(has_error())return -1;return plugin_push_output_ex(port,schema,identifier,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,bytes.data(),bytes.size());
}
// One GET HttpRequest, its CONTEXT a size-prefixed $SRG (the settings or a job) echoed in the HttpResponse.
int emit_request(const char* port,const std::string& url,uint32_t timeout,uint64_t max_bytes,const Bytes& context) {
  if(has_error())return -1;flatbuffers::FlatBufferBuilder b(512+url.size()+context.size());
  R::FinishHttpRequestBuffer(b,R::CreateHttpRequestDirect(b,"GET",url.c_str(),nullptr,nullptr,timeout,max_bytes,context.empty()?nullptr:&context));
  return plugin_push_output_ex(port,"HttpRequest.fbs",R::HttpRequestIdentifier(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpRequest",0,0,b.GetBufferPointer(),b.GetSize());
}
std::string digest(const Bytes& b){return ephem::sha256_hex(b.data(),b.size());}
std::string digest(const std::string& s){return ephem::sha256_hex(reinterpret_cast<const uint8_t*>(s.data()),s.size());}
int bounded_config(const Json& config,const char* name,int fallback,int low,int high) {
  if(!config.contains(name))return fallback;
  require(config[name].is_number_integer(),"Retriever limits must be integers.");const auto n=config[name].get<int64_t>();
  require(n>=low && n<=high,"Retriever limit is outside its permitted bounds.");return int(n);
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------
struct Http {int status=0;Bytes body;Json headers=Json::object(),header_values=Json::object();};
Http http_of(const R::HttpResponse& r) {
  Http out;out.status=r.ERROR() && r.ERROR()->size()?0:r.STATUS();
  if(r.BODY())out.body.assign(r.BODY()->begin(),r.BODY()->end());
  if(r.HEADERS())for(const auto* h:*r.HEADERS())out.headers[text(h->NAME())]=text(h->VALUE());
  return out;
}
#ifdef EPHEMERIS_HOST_ADAPTER
// http.request through sdm_piv: the url, the header block ("name: value" lines) and the body as raw frames.
Http host_request(const std::string& url,const std::string& method,const std::string& body,const Json& headers,uint32_t timeout,uint64_t max_bytes) {
  if(has_error())return {};
  R::Aligned::HttpParams params{};require(sdm_piv::put(params.METHOD,method),"Invalid HTTP method.");params.set_has_METHOD(true);params.TIMEOUT_MS=timeout;params.MAX_BYTES=max_bytes;
#ifdef EPHEMERIS_AUTH_SUPPORT
  params.NO_REDIRECTS=true;
#endif
  std::string block;for(auto i=headers.begin();i!=headers.end();++i)block+=i.key()+": "+i.value().get<std::string>()+"\r\n";
  std::vector<sdm_piv::Frame> frames{{"params",reinterpret_cast<const uint8_t*>(&params),sizeof(params),"HttpParams",uint32_t(sizeof(params)),uint16_t(alignof(R::Aligned::HttpParams))},sdm_piv::raw("url",url)};
  if(!block.empty())frames.push_back(sdm_piv::raw("headers",block));
  if(!body.empty())frames.push_back(sdm_piv::raw("body",body));
  const auto response=sdm_piv::call_frames("http.request",frames);
  // Do not echo host errors: authenticated providers may include request bodies.
  require(response.ok(),"A required host capability failed.");
  const auto* result=response.result<R::Aligned::HttpResult>();require(result,"Invalid HTTP capability response.");
  Http out;out.status=result->STATUS;const auto bytes=response.raw("body");out.body.assign(bytes.begin(),bytes.end());
  const auto lines=response.raw("headers");size_t from=0;
  while(from<lines.size()){auto end=lines.find('\n',from);if(end==std::string_view::npos)end=lines.size();const auto line=trim(std::string(lines.substr(from,end-from)));const auto colon=line.find(':');
    if(colon!=std::string::npos){auto name=line.substr(0,colon);std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return char(std::tolower(c));});out.headers[name]=trim(line.substr(colon+1));}from=end+1;}
  return out;
}
#endif

#ifdef EPHEMERIS_AUTH_SUPPORT
struct Context;void authenticated_cleanup(Context&);
#endif
struct Context {
  Json source,config,private_state=Json::object();const std::map<std::string,Http>* replies=nullptr;int64_t epoch;int timeout=15000;size_t maxBytes=16*1024*1024;size_t requests=0;std::chrono::steady_clock::time_point deadline;
  bool ready=false;
  Context(Json cfg,const std::map<std::string,Http>* responses=nullptr):config(std::move(cfg)),replies(responses){ready=initialize();}
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
    if(replies) {
      const auto found=replies->find(url);require(found!=replies->end(),"Discovery response missing: supply the HttpResponse of every planned request.");out=found->second;
    } else {
#ifdef EPHEMERIS_HOST_ADAPTER
      out=host_request(url,method,body,headers,uint32_t(requestTimeout),maxBytes);
#else
      record_error("Portable core requires explicit HttpResponse frames; host capabilities belong to the scheduled adapter.");return {};
#endif
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
  require(item.is_object() && item.contains("format") && item["format"].is_string() && !item["format"].get<std::string>().empty(),"Raw format descriptor missing.");require(!bytes.empty() && bytes.size()<=hardMaxBytes,"Invalid raw artifact size.");const auto format=item["format"].get<std::string>();require(format!="vimpel-html","Provider HTML is not an orbital container and cannot be represented as NCD.");
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
// ---- host capabilities through sdm_piv ---------------------------------------------------------------------------------
std::string ipfs_add(const Bytes& bytes) {
  if(has_error())return {};
  R::Aligned::IpfsParams params{};const auto response=sdm_piv::call("ipfs.add","IpfsParams",params,{sdm_piv::raw("data",bytes.data(),bytes.size())});
  require(response.ok(),"A required host capability failed.");const auto* result=response.result<R::Aligned::IpfsResult>();
  const auto cid=result?result->CID.str():std::string();
  require(!cid.empty() && cid.size()<200 && cid.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")==std::string::npos,"IPFS did not return a valid content identifier.");return cid;
}
Bytes ipfs_cat(const std::string& cid) {
  if(has_error())return {};
  R::Aligned::IpfsParams params{};require(sdm_piv::put(params.CID,cid),"Invalid content identifier.");params.set_has_CID(true);
  const auto response=sdm_piv::call("ipfs.cat","IpfsParams",params);require(response.ok(),"A required host capability failed.");
  const auto data=response.raw("data");return Bytes(data.begin(),data.end());
}
bool store(const char* schema,const Bytes& bytes) {
  if(has_error())return false;
  R::Aligned::StorageWriteParams params{};sdm_piv::put(params.SCHEMA,schema);params.set_has_SCHEMA(true);
  const auto response=sdm_piv::call("storage.write","StorageWriteParams",params,{sdm_piv::raw("data",bytes.data(),bytes.size())});
  const auto* result=response.ok()?response.result<R::Aligned::StorageWriteResult>():nullptr;
  require(result && !result->CID.str().empty(),"Storage did not confirm the durable record.");return true;
}
// One attributed batch (NCD or CAT) through storage.ingest_with_source, its provenance typed (Provenance and
// ProvenanceAttribute records, never a JSON document).
struct Attribution {std::string url,batch,sha256,parser_version;uint64_t retrieved_ms=0;std::vector<std::pair<std::string,std::string>> attributes;};
bool ingest(const char* schema,const std::string& sourceId,const Bytes& records,const Attribution& a) {
  if(has_error())return false;
  R::Aligned::StorageIngestParams params{};
  require(sdm_piv::put(params.SCHEMA,schema) && sdm_piv::put(params.PROVIDER_ID,"ephemeris-provider:"+sourceId) && sdm_piv::put(params.SOURCE_NAME,sourceId) &&
    sdm_piv::put(params.BATCH_ID,a.batch) && sdm_piv::put(params.SOURCE_URL,a.url),"Source attribution exceeds its record (a URL is at most 255 bytes).");
  params.set_has_SCHEMA(true);params.set_has_PROVIDER_ID(true);params.set_has_SOURCE_NAME(true);params.set_has_BATCH_ID(true);params.set_has_SOURCE_URL(true);params.RECONCILE=R::Aligned::reconcileKind_Duplicates;
  R::Aligned::Provenance provenance{};
  require(sdm_piv::put(provenance.SOURCE_URL,a.url) && sdm_piv::put(provenance.PARSER,moduleId) && sdm_piv::put(provenance.PARSER_VERSION,a.parser_version) && sdm_piv::put(provenance.SOURCE_SHA256,a.sha256),"Provenance exceeds its record.");
  provenance.set_has_SOURCE_URL(true);provenance.set_has_PARSER(true);provenance.set_has_PARSER_VERSION(true);provenance.set_has_SOURCE_SHA256(true);
  provenance.RETRIEVED_MS=a.retrieved_ms;provenance.NORMALIZED_COUNT=0;
  std::vector<R::Aligned::ProvenanceAttribute> attributes(a.attributes.size());
  for(size_t i=0;i<a.attributes.size();++i){require(sdm_piv::put(attributes[i].NAME,a.attributes[i].first) && sdm_piv::put(attributes[i].VALUE,a.attributes[i].second),"Provenance attribute exceeds its record.");attributes[i].set_has_NAME(true);attributes[i].set_has_VALUE(true);}
  std::vector<sdm_piv::Frame> frames{{"params",reinterpret_cast<const uint8_t*>(&params),sizeof(params),"StorageIngestParams",uint32_t(sizeof(params)),uint16_t(alignof(R::Aligned::StorageIngestParams))},
    sdm_piv::raw("records",records.data(),records.size()),sdm_piv::list("provenance","Provenance",&provenance,1)};
  if(!attributes.empty())frames.push_back(sdm_piv::list("provenance_attributes","ProvenanceAttribute",attributes.data(),attributes.size()));
  const auto response=sdm_piv::call_frames("storage.ingest_with_source",frames);
  require(response.ok() && response.result<R::Aligned::StorageIngestResult>(),"Source ingestion did not confirm durable records.");return true;
}
#endif
Bytes descriptor(const Json& item,const Bytes& raw,const std::string& cid) {
  flatbuffers::FlatBufferBuilder b(512);auto format=ncdContainerFormat_PROVIDER_DEFINED;
  const auto kind=item["format"].get<std::string>();if(kind=="ccsds-oem-kvn")format=ncdContainerFormat_CCSDS_OEM_KVN;
  const auto name=b.CreateString(kind),hash=b.CreateString(digest(raw)),content=b.CreateString(cid);
  NCDBuilder record(b);record.add_FORMAT(format);if(format==ncdContainerFormat_PROVIDER_DEFINED)record.add_PROVIDER_DEFINED_FORMAT_NAME(name);
  record.add_SOURCE_BYTE_LENGTH(raw.size());record.add_SOURCE_SHA256(hash);record.add_SOURCE_CID(content);
  b.FinishSizePrefixed(record.Finish(),"$NCD");return finish(b);
}
// Coverage is an assertion extracted from object metadata, never guessed from
// filenames, numeric catalog IDs, or arbitrary designators elsewhere in a file.
Bytes object_coverage(const Json& item, const Bytes& raw) {
  const auto format=item.value("format",std::string());
  if (format != "ccsds-oem-kvn" && format != "tle" && format != "eumetsat-tle-js") return {};
  const std::string input(raw.begin(),raw.end());
  std::map<std::string,std::string> objects;
  bool metadata=false;std::string id,name;
  auto trim_value=[](std::string value) {const auto first=value.find_first_not_of(" \t\r");if(first==std::string::npos)return std::string();return value.substr(first,value.find_last_not_of(" \t\r")-first+1);};
  auto valid=[](const std::string& value) {if(value.size()<9||value.size()>11||value[4]!='-')return false;for(size_t i=0;i<value.size();++i){if(i==4)continue;if(i<8?(value[i]<'0'||value[i]>'9'):(value[i]<'A'||value[i]>'Z'))return false;}return true;};
  auto tle_checksum=[](const std::string& line) {if(line.size()!=69 || line[68]<'0' || line[68]>'9')return false;int sum=0;for(size_t i=0;i<68;++i){if(line[i]>='0'&&line[i]<='9')sum+=line[i]-'0';else if(line[i]=='-')++sum;}return sum%10==line[68]-'0';};
  std::string firstTle;
  size_t at=0;
  while(at<input.size()) {
    const auto end=input.find('\n',at);auto line=trim_value(input.substr(at,end==std::string::npos?std::string::npos:end-at));at=end==std::string::npos?input.size():end+1;
    if(format!="ccsds-oem-kvn") {
      if(format=="eumetsat-tle-js") {
        const auto marker=line.find("[i++]");if(marker==std::string::npos || marker==0)continue;
        const auto variable=line.substr(0,marker);if(variable.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")!=std::string::npos)continue;
        auto value=trim_value(line.substr(marker+5));if(value.empty() || value[0]!='=')continue;value=trim_value(value.substr(1));if(!value.empty() && value.back()==';')value.pop_back();
        const auto literal=Json::parse(value,nullptr,false);if(!literal.is_string())continue;line=literal.get<std::string>();
      }
      if(line.rfind("0 ",0)==0){name=trim_value(line.substr(2));firstTle.clear();continue;}
      if(line.rfind("1 ",0)==0){firstTle=tle_checksum(line)?line:"";continue;}
      if(line.rfind("2 ",0)!=0 || firstTle.empty() || !tle_checksum(line) || line.substr(2,5)!=firstTle.substr(2,5)){firstTle.clear();continue;}
      const auto token=trim_value(firstTle.substr(9,8));firstTle.clear();
      if(token.size()<6 || token.size()>8 || token.substr(0,5).find_first_not_of("0123456789")!=std::string::npos)continue;
      const int year=(token[0]-'0')*10+token[1]-'0';
      const auto designator=std::to_string(year>=57?1900+year:2000+year)+"-"+token.substr(2);
      if(valid(designator))objects[designator]=name;
      continue;
    }
    if(line=="META_START"){metadata=true;id.clear();name.clear();continue;}
    if(line=="META_STOP"){if(id.size()>8 && id[8]=='-')id.erase(8,1);if(metadata&&valid(id))objects[id]=name;metadata=false;continue;}
    if(!metadata)continue;
    const auto equals=line.find('=');if(equals==std::string::npos)continue;
    const auto key=trim_value(line.substr(0,equals)),value=trim_value(line.substr(equals+1));
    if(key=="OBJECT_ID")id=value;else if(key=="OBJECT_NAME")name=value;
  }
  Bytes result;
  for(const auto& [designator,label]:objects) {
    flatbuffers::FlatBufferBuilder b(256);const auto objectId=b.CreateString(designator),objectName=b.CreateString(label);
    CATBuilder cat(b);cat.add_OBJECT_ID(objectId);cat.add_OBJECT_NAME(objectName);b.FinishSizePrefixed(cat.Finish(),"$CAT");
    const auto frame=finish(b);result.insert(result.end(),frame.begin(),frame.end());
  }
  return result;
}
#ifdef EPHEMERIS_HOST_ADAPTER
// ---- durable position: $IRM; its archive ledger is an $SRG STATUS in the IRM decode context (never JSON in NOTES) ----
struct Resume {uint64_t sequence=0,bytes=0,reserved=0,lastBytes=0;uint32_t next=0;std::string queueCid;bool complete=false;std::string updated,lastHash,lastStamp;};
Resume restore(const std::string& job) {
  if(has_error())return {};
  sdm_piv::SqlValues values;values.str(job);R::Aligned::SqlStreamParams params{};
  const auto response=sdm_piv::call("storage.flatsql_query_stream","SqlStreamParams",params,{sdm_piv::raw("sql","SELECT _data FROM IRM WHERE JOB_ID = ? ORDER BY SEQUENCE DESC LIMIT 1"),values.frame()});
  require(response.ok(),"A required host capability failed.");const auto* result=response.result<R::Aligned::StreamResult>();require(result,"Invalid resume query result.");
  if(result->ROWS==0)return {};
  const auto stream=response.raw("stream");const Bytes bytes(stream.begin(),stream.end());flatbuffers::Verifier verifier(bytes.data(),bytes.size());require(VerifySizePrefixedIRMBuffer(verifier),"Invalid durable resume record.");
  const auto* mark=GetSizePrefixedIRM(bytes.data());require(mark->JOB_ID() && mark->JOB_ID()->str()==job && mark->SOURCE() && mark->UPDATED_AT(),"Resume mark identity mismatch.");
  require(mark->RANGE_MODE()==irmRangeMode_PART_INDEX,"Resume mark has incompatible addressing.");
  const auto* context=mark->DECODE_CONTEXT();
  require(context && text(context->FORMAT())==ledgerFormat && text(context->DECODER_STATE_FORMAT())=="$SRG" && text(context->DECODER_STATE_VERSION())==ledgerVersion && context->DECODER_STATE(),
    "Legacy or invalid archive ledger; operator migration is required.");
  const auto* ledger=srg_bytes(context->DECODER_STATE()->data(),context->DECODER_STATE()->size());require(ledger && ledger->STATUS(),"Legacy or invalid archive ledger; operator migration is required.");
  Resume out;out.sequence=mark->SEQUENCE();out.bytes=mark->BYTES_COMMITTED();out.reserved=ledger->STATUS()->ARCHIVE_RESERVED_BYTES();out.next=mark->NEXT_CHUNK_INDEX();out.complete=mark->STATE()==irmJobState_COMPLETE;out.updated=mark->UPDATED_AT()->str();
  if(mark->SOURCE()->SOURCE_CID())out.queueCid=mark->SOURCE()->SOURCE_CID()->str();require(!out.queueCid.empty() || (!out.next && !out.complete),"Committed resume position has no pinned queue.");
  if(out.next){const auto* chunk=mark->LAST_CHUNK();require(chunk && chunk->CHUNK_SHA256() && chunk->COMMITTED_AT(),"Committed resume position has no chunk receipt.");out.lastHash=chunk->CHUNK_SHA256()->str();out.lastBytes=chunk->BYTE_LENGTH();out.lastStamp=chunk->COMMITTED_AT()->str();}
  return out;
}
Bytes checkpoint(const Context& ctx,const Resume& resume,const std::string& job,const std::string& stamp) {
  Status ledger;ledger.source_id=ctx.source["source_id"].get<std::string>();ledger.queue_cid=resume.queueCid;ledger.reserved=resume.reserved;ledger.completed=resume.next;
  ledger.state=resume.complete?srgRetrievalState_Complete:srgRetrievalState_InProgress;
  ledger.note="Archive reservation is cumulative and conservative; the source cursor advances only after raw pin and attributed NCD ingestion.";
  const auto state=srg_status(ledger);
  flatbuffers::FlatBufferBuilder b(4096);auto cid=b.CreateString(resume.queueCid),locator=b.CreateString(resume.queueCid.empty()?ctx.source["origins"][0].get<std::string>():"ipfs://"+resume.queueCid),object=b.CreateString(ctx.source["source_id"].get<std::string>());
  IRMSourceBuilder source(b);source.add_SOURCE_URL(locator);if(!resume.queueCid.empty())source.add_SOURCE_CID(cid);source.add_SOURCE_OBJECT_ID(object);source.add_VALIDATOR_MATCH(resume.queueCid.empty()?irmValidatorMatch_UNVERIFIABLE:irmValidatorMatch_MATCHED);const auto src=source.Finish();
  const auto batch=b.CreateString(resume.lastHash),time=b.CreateString(stamp),committed=b.CreateString(resume.lastStamp);IRMChunkBuilder chunk(b);chunk.add_CHUNK_INDEX(resume.next?resume.next-1:0);chunk.add_BATCH_ID(batch);chunk.add_BYTE_LENGTH(resume.lastBytes);chunk.add_CHUNK_SHA256(batch);chunk.add_RECORDS_DECODED(1);chunk.add_RECORDS_STORED(1);chunk.add_ATTEMPTS(1);chunk.add_COMMITTED_AT(committed);const auto part=chunk.Finish();
  const auto format=b.CreateString(ledgerFormat),stateFormat=b.CreateString("$SRG"),stateVersion=b.CreateString(ledgerVersion);const auto stateBytes=b.CreateVector(state);
  IRMDecodeContextBuilder decode(b);decode.add_FORMAT(format);decode.add_DECODER_STATE(stateBytes);decode.add_DECODER_STATE_FORMAT(stateFormat);decode.add_DECODER_STATE_VERSION(stateVersion);decode.add_DECODER_STATE_BYTE_LENGTH(state.size());const auto context=decode.Finish();
  const auto name=b.CreateString(job),ingestor=b.CreateString(moduleId),standard=b.CreateString("$NCD"),reconcile=b.CreateString("append"),merge=b.CreateString("content-sha256"),
    note=b.CreateString("Archive ledger: an $SRG retrieval status in DECODE_CONTEXT (ARCHIVE_RESERVED_BYTES). SDN source publication retries independently.");
  IRMBuilder mark(b);mark.add_JOB_ID(name);mark.add_SEQUENCE(resume.sequence);mark.add_PROVIDER_ID(object);mark.add_INGESTOR_ID(ingestor);mark.add_SOURCE(src);mark.add_STATE(resume.complete?irmJobState_COMPLETE:irmJobState_IN_PROGRESS);mark.add_RANGE_MODE(irmRangeMode_PART_INDEX);mark.add_NEXT_CHUNK_INDEX(resume.next);mark.add_CHUNK_BYTE_BUDGET(ctx.maxBytes);mark.add_DECODE_CONTEXT(context);if(resume.next)mark.add_LAST_CHUNK(part);mark.add_CHUNKS_COMMITTED(resume.next);mark.add_BYTES_COMMITTED(resume.bytes);mark.add_RECORDS_COMMITTED(resume.next);mark.add_TARGET_STANDARD(standard);mark.add_RECONCILE_MODE(reconcile);mark.add_MERGE_POLICY(merge);mark.add_UPDATED_AT(time);mark.add_NOTES(note);if(resume.complete)mark.add_COMPLETED_AT(time);
  b.FinishSizePrefixed(mark.Finish(),"$IRM");return finish(b);
}
const std::set<std::string>& option_names(){static const std::set<std::string> names={"ephemeris_enabled","ephemeris_source_id","ephemeris_max_resources","ephemeris_max_bytes","ephemeris_timeout_ms","ephemeris_max_runtime_ms","ephemeris_refresh_interval_sec","ephemeris_archive_max_bytes","ephemeris_secret_id","ephemeris_spire_paths"};return names;}
uint64_t archive_limit(const Json& config){
  constexpr uint64_t maximum=32ULL*1024*1024*1024;
  if(!config.contains("ephemeris_archive_max_bytes"))return 1024ULL*1024*1024;
  const auto& value=config["ephemeris_archive_max_bytes"];require(value.is_number_integer(),"Archive budget must be an integer byte count.");const auto n=value.get<int64_t>();require(n>=1024 && uint64_t(n)<=maximum,"Archive budget must be between 1024 bytes and 32 GiB.");return uint64_t(n);
}
bool reserve_archive(const Context& ctx,Resume& resume,const std::string& job,uint64_t bytes,uint64_t limit){
  if(resume.reserved>limit || bytes>limit-resume.reserved)return false;
  resume.reserved+=bytes;++resume.sequence;return store("IRM.fbs",checkpoint(ctx,resume,job,iso(now())));
}
int budget_status(const std::string& sourceId,const Resume& resume,uint64_t limit,size_t total){
  Status s;s.source_id=sourceId;s.enabled=true;s.state=srgRetrievalState_ArchiveBudgetReached;s.reserved=resume.reserved;s.archive_max=limit;s.completed=resume.next;
  if(total){s.total=uint32_t(total);s.remaining=uint32_t(total-resume.next);}return emit_status(s);
}
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
  archive_limit(value);
  if(value.contains("ephemeris_secret_id")){require(value["ephemeris_secret_id"].is_string(),"A secret lane ID must be a string.");const auto lane=value["ephemeris_secret_id"].get<std::string>();require(lane.size()>=2 && lane.size()<=64 && lane.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-")==std::string::npos,"Invalid secret lane identifier.");}
  if(value.contains("ephemeris_spire_paths")){const auto& paths=value["ephemeris_spire_paths"];require(paths.is_array() && !paths.empty() && paths.size()<=16,"Spire paths must be a bounded nonempty array.");for(const auto& path:paths){require(path.is_string(),"Spire paths must be strings.");const auto text=path.get<std::string>();require(text.size()<=128 && !text.empty() && text[0]=='/' && text.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/")==std::string::npos && text.find("//")==std::string::npos,"Spire paths must be safe absolute API paths without query parameters.");}}
  require(!has_error(),"Invalid retriever configuration.");return value;
}
// $SRG SETTINGS as retriever options: a zero or empty field is left to the default.
Json settings_options(const SRGRetrievalSettings* s) {
  require(s,"The $SRG carries no SETTINGS.");Json out={{"ephemeris_enabled",s->ENABLED()}};
  if(s->SOURCE_ID() && s->SOURCE_ID()->size())out["ephemeris_source_id"]=s->SOURCE_ID()->str();
  auto put=[&](const char* key,uint64_t v){if(v)out[key]=int64_t(std::min<uint64_t>(v,uint64_t(std::numeric_limits<int64_t>::max())));};
  put("ephemeris_max_resources",s->MAX_RESOURCES());put("ephemeris_max_bytes",s->MAX_BYTES());put("ephemeris_timeout_ms",s->TIMEOUT_MS());put("ephemeris_max_runtime_ms",s->MAX_RUNTIME_MS());
  put("ephemeris_refresh_interval_sec",s->REFRESH_INTERVAL_S());put("ephemeris_archive_max_bytes",s->ARCHIVE_MAX_BYTES());
  if(s->CREDENTIAL_REFERENCE() && s->CREDENTIAL_REFERENCE()->size())out["ephemeris_secret_id"]=s->CREDENTIAL_REFERENCE()->str();
  if(s->PATHS() && s->PATHS()->size()){Json paths=Json::array();for(const auto* p:*s->PATHS())paths.push_back(p->str());out["ephemeris_spire_paths"]=paths;}
  return out;
}
// plugin.getConfig (one ModuleConfig, read in place): the known ephemeris_* keys only.
Json host_options() {
  const sdm_piv::Config config=sdm_piv::get_config();require(config.ok(),"Host configuration unavailable.");Json out=Json::object();
  for(const auto& key:option_names()) {
    const auto* e=config.entry(key);if(!e)continue;
    switch(e->KIND()) {
      case R::configValueKind_Bool:out[key]=e->BOOL_VALUE();break;
      case R::configValueKind_Number:{const double v=e->NUMBER_VALUE();if(std::floor(v)==v && std::fabs(v)<9.0e15)out[key]=int64_t(v);else out[key]=v;break;}
      case R::configValueKind_String:out[key]=std::string(config.string(key));break;
      case R::configValueKind_StringList:{Json list=Json::array();for(std::string_view item:config.strings(key))list.push_back(std::string(item));out[key]=list;break;}
      default:record_error("Unsupported retriever option kind.");return {};
    }
  }
  return out;
}
int execute_configure(){
  const auto* settings=srg_input("settings");require(settings,"Retrieval settings ($SRG SETTINGS) are required.");const auto options=validate_options(settings_options(settings->SETTINGS()));require(!has_error(),"Invalid retriever configuration.");
  configured_options()=options;Status s;s.state=srgRetrievalState_Configured;s.source_id=options.value("ephemeris_source_id",std::string());s.enabled=options.value("ephemeris_enabled",false);return emit_status(s);
}
int execute_pull() {
  const auto supplied=host_options();require(!has_error(),"Host configuration unavailable.");
  Json merged=configured_options();for(const auto& key:option_names())if(supplied.contains(key))merged[key]=supplied[key];const auto host=validate_options(merged);require(!has_error(),"Invalid retriever configuration.");
  if(!host.value("ephemeris_enabled",false)){Status s;s.state=srgRetrievalState_Disabled;s.source_id=host.value("ephemeris_source_id",std::string());return emit_status(s);}
  Json cfg={{"source_id",host.value("ephemeris_source_id",std::string())},{"max_bytes",host.value("ephemeris_max_bytes",16*1024*1024)},{"timeout_ms",host.value("ephemeris_timeout_ms",15000)},{"max_runtime_ms",host.value("ephemeris_max_runtime_ms",90000)}};
  if(host.contains("ephemeris_secret_id"))cfg["secret_id"]=host["ephemeris_secret_id"];
  if(host.contains("ephemeris_spire_paths"))cfg["spire_paths"]=host["ephemeris_spire_paths"];
  Context ctx(cfg);require(ctx.ready,"Invalid source configuration.");const auto sourceId=ctx.source["source_id"].get<std::string>();
#ifdef EPHEMERIS_FIXED_SOURCE_ID
  require(sourceId==EPHEMERIS_FIXED_SOURCE_ID,"This artifact only serves its compiled provider.");
#endif
#ifdef EPHEMERIS_AUTH_SUPPORT
  if(!authenticated_ready(ctx)){Status s;s.source_id=sourceId;s.enabled=true;s.state=srgRetrievalState_CredentialUnavailable;return emit_status(s);}
#endif
  const int cap=bounded_config(host,"ephemeris_max_resources",4,1,64),wall=bounded_config(host,"ephemeris_max_runtime_ms",90000,1000,300000);
  const auto started=std::chrono::steady_clock::now();const auto job=std::string(moduleId)+":"+sourceId;auto resume=restore(job);require(!has_error(),"Could not restore source state.");const auto archiveMax=archive_limit(host);Json queue;
  if(resume.reserved>=archiveMax && (resume.complete || resume.queueCid.empty()))return budget_status(sourceId,resume,archiveMax,resume.complete?resume.next:0);
  const auto refresh=bounded_config(host,"ephemeris_refresh_interval_sec",ctx.source["refresh_interval_sec"].get<int>(),3600,604800);
  if(resume.complete && resume.updated>iso(ctx.epoch-refresh)){Status s;s.source_id=sourceId;s.enabled=true;s.state=srgRetrievalState_WaitingRefresh;s.completed=resume.next;return emit_status(s);}
  if(!resume.queueCid.empty() && !resume.complete) {
    const auto bytes=ipfs_cat(resume.queueCid);require(!has_error(),"Could not read the pinned discovery queue.");queue=queue_resources(srg_bytes(bytes.data(),bytes.size()));require(queue.is_array() && !queue.empty() && queue.size()<=100000,"Invalid pinned discovery queue.");
  } else {
    queue=discover(ctx);require(queue.is_array() && !queue.empty() && queue.size()<=100000,"Discovery must return a bounded nonempty source queue.");const auto envelope=srg_queue(queue,ctx.epoch*1000);require(envelope.size()<=hardMaxBytes,"Discovery queue exceeds its byte budget.");
    resume.queueCid.clear();resume.next=0;resume.bytes=0;resume.complete=false;resume.lastHash.clear();resume.lastStamp.clear();resume.lastBytes=0;
    if(!reserve_archive(ctx,resume,job,envelope.size(),archiveMax))return budget_status(sourceId,resume,archiveMax,queue.size());
    resume.queueCid=ipfs_add(envelope);require(!has_error(),"Could not pin discovery queue.");++resume.sequence;store("IRM.fbs",checkpoint(ctx,resume,job,iso(ctx.epoch)));
  }
  require(resume.next<=queue.size(),"Resume position exceeds the resource index.");if(resume.reserved>=archiveMax)return budget_status(sourceId,resume,archiveMax,queue.size());int fetched=0;
  for(;resume.next<queue.size() && fetched<cap;++fetched) {
    if(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count()>=wall)break;
    const auto& item=queue[resume.next];const auto response=fetch_resource(ctx,item);
    if(item["format"]=="vimpel-html"){Status s;s.source_id=sourceId;s.enabled=true;s.state=srgRetrievalState_ProviderPageOnly;s.resource_url=item["url"].get<std::string>();s.bytes=response.body.size();s.sha256=digest(response.body);
      s.note="Authenticated provider page is not an orbital export; no NCD was stored.";return emit_status(s);}
    require(validate_raw(item,response.body),"Raw source validation failed.");
    if(!reserve_archive(ctx,resume,job,response.body.size(),archiveMax))return budget_status(sourceId,resume,archiveMax,queue.size());
    const auto stamp=iso(now()),rawCid=ipfs_add(response.body),hash=digest(response.body);const auto ncd=descriptor(item,response.body,rawCid);
    Attribution a;a.url=item["url"].get<std::string>();a.batch=hash;a.sha256=hash;a.parser_version="raw-preservation/0.2.0";a.retrieved_ms=uint64_t(now())*1000;
    a.attributes={{"source_id",sourceId},{"format",item["format"].get<std::string>()},{"source_cid",rawCid},{"source_byte_length",std::to_string(response.body.size())},
      {"retrieved_at",stamp},{"discovery_queue_cid",resume.queueCid},{"discovery_job_id",digest(resume.queueCid)}};
    require(ingest("NCD.fbs",sourceId,ncd,a),"Source ingestion did not confirm durable records.");
    const auto coverage=object_coverage(item,response.body);
    if(!coverage.empty())require(ingest("CAT.fbs",sourceId,coverage,a),"Object coverage ingestion did not confirm durable records.");
    ++resume.next;++resume.sequence;resume.bytes+=response.body.size();resume.lastHash=hash;resume.lastBytes=response.body.size();resume.lastStamp=stamp;resume.complete=resume.next==queue.size();store("IRM.fbs",checkpoint(ctx,resume,job,stamp));
    require(emit_record("descriptor","NCD.fbs","$NCD","NCD",ncd)>=0,"Could not emit acquisition receipt.");
  }
  Status s;s.source_id=sourceId;s.enabled=true;s.retrieved=uint32_t(fetched);s.completed=resume.next;s.total=uint32_t(queue.size());s.remaining=uint32_t(queue.size()-resume.next);s.queue_cid=resume.queueCid;
  s.reserved=resume.reserved;s.archive_max=archiveMax;s.state=resume.next==queue.size()?srgRetrievalState_Complete:srgRetrievalState_InProgress;return emit_status(s);
}
#endif
int guarded(const std::function<int()>& action){clear_error();const auto status=action();if(has_error()){plugin_set_error("ephemeris-retrieval-failed",error_text().c_str());return 1;}return status;}
// The body of a job's HttpResponse: a complete HTTP 200 answer, its CONTEXT the job.
Bytes job_body(const R::HttpResponse* r,Json* item) {
  require(r && !(r->ERROR() && r->ERROR()->size()) && r->STATUS()==200 && r->BODY() && r->BODY()->size(),"The resource's HttpResponse is not a complete nonempty HTTP 200 answer.");
  require(r->CONTEXT(),"The HttpResponse carries no job (an $SRG with one resource) in CONTEXT.");
  *item=job_resource(srg_bytes(r->CONTEXT()->data(),r->CONTEXT()->size()));return Bytes(r->BODY()->begin(),r->BODY()->end());
}
}
extern "C" int describe_sources(){return ephemeris::guarded([]()->int{return ephemeris::emit_srg("sources",ephemeris::srg_registry())<0?1:0;});}
extern "C" int plan_source_requests(){return ephemeris::guarded([]()->int{using namespace ephemeris;
  const auto* settings=srg_input("settings");require(settings,"Retrieval settings are required.");const auto* f=frame("settings");
  Context ctx(settings_json(settings->SETTINGS()));require(ctx.ready,"Invalid source configuration.");const auto requests=initial_requests(ctx.source,ctx.epoch);
  const Bytes context(f->payload,f->payload+f->payload_length);
  for(const auto& r:requests)if(emit_request("requests",r["url"].get<std::string>(),uint32_t(ctx.timeout),ctx.maxBytes,context)<0)return 1;return 0;});}
extern "C" int discover_sources(){return ephemeris::guarded([]()->int{using namespace ephemeris;
  const auto* settings=srg_input("settings");require(settings,"Retrieval settings are required.");std::map<std::string,Http> replies;
  for(const auto* f:frames("responses")) {
    flatbuffers::Verifier verifier(f->payload,f->payload_length,64,1000000,false);require(R::VerifyHttpResponseBuffer(verifier),"A responses frame is not an HttpResponse (HRSP).");
    const auto* r=R::GetHttpResponse(f->payload);const auto url=text(r->URL());require(!url.empty() && !replies.count(url),"Each listing response names its own URL once.");replies[url]=http_of(*r);
  }
  require(!has_error(),"Invalid listing responses.");
  Context ctx(settings_json(settings->SETTINGS()),&replies);require(ctx.ready,"Invalid source configuration.");const auto queue=discover(ctx);require(!has_error(),"Discovery failed.");
  const int64_t at=ctx.epoch*1000;if(emit_srg("resources",srg_queue(queue,at))<0)return 1;
  for(const auto& item:queue)if(emit_request("requests",item["url"].get<std::string>(),uint32_t(ctx.timeout),ctx.maxBytes,srg_job(item,at))<0)return 1;return 0;});}
extern "C" int describe_artifact(){return ephemeris::guarded([]()->int{using namespace ephemeris;
  Json item;const auto bytes=job_body(response_input("response"),&item);require(!has_error(),"Invalid artifact.");
  require(item.contains("source_id") && item["source_id"].get<std::string>().size() && item["url"].get<std::string>().size(),"The job names no source or URL.");
  const auto* receipt=srg_input("receipt");require(receipt && receipt->RECEIPTS() && receipt->RECEIPTS()->size()==1,"One content receipt ($SRG RECEIPTS) is required.");
  const auto cid=text(receipt->RECEIPTS()->Get(0)->CID());require(!cid.empty(),"Content identifier missing.");
  validate_url(source_for(item.at("source_id")),item.at("url"));validate_raw(item,bytes);
  return emit_record("descriptor","NCD.fbs","$NCD","NCD",descriptor(item,bytes,cid))<0?1:0;});}
#ifdef EPHEMERIS_HOST_ADAPTER
extern "C" int configure(){return ephemeris::guarded(ephemeris::execute_configure);}
extern "C" int pull(){return ephemeris::guarded(ephemeris::execute_pull);}
#endif

extern "C" int describe_coverage(){return ephemeris::guarded([]()->int{using namespace ephemeris;
  Json item;const auto bytes=job_body(response_input("response"),&item);require(!has_error() && validate_raw(item,bytes),"Invalid source bytes.");
  const auto coverage=object_coverage(item,bytes);if(coverage.empty())return 0;return emit_record("catalog","CAT.fbs","$CAT","CAT",coverage)<0?1:0;});}

#ifdef EPHEMERIS_HOST_ADAPTER
extern "C" int backfill_coverage(){return ephemeris::guarded([]()->int{using namespace ephemeris;
  const auto* page=srg_input("page",false);const auto host=configured_options();
  std::string sourceId=host.value("ephemeris_source_id",std::string());uint32_t offset=0,limit=4;
  if(page){if(page->SETTINGS()){if(page->SETTINGS()->SOURCE_ID() && page->SETTINGS()->SOURCE_ID()->size())sourceId=page->SETTINGS()->SOURCE_ID()->str();if(page->SETTINGS()->MAX_RESOURCES())limit=page->SETTINGS()->MAX_RESOURCES();}if(page->STATUS())offset=page->STATUS()->NEXT_OFFSET();}
  source_for(sourceId);require(!has_error() && !sourceId.empty(),"Source configuration required.");
#ifdef EPHEMERIS_FIXED_SOURCE_ID
  require(sourceId==EPHEMERIS_FIXED_SOURCE_ID,"This artifact only serves its compiled provider.");
#endif
  require(sourceId.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-")==std::string::npos,"Invalid source ID.");
  require(offset<=100000 && limit>=1 && limit<=4,"Invalid coverage page.");
  const auto* descriptors=frame("descriptors");require(descriptors && descriptors->payload_length<=256*1024,"A bounded NCD descriptor page is required.");
  const Bytes stream(descriptors->payload,descriptors->payload+descriptors->payload_length);size_t at=0;uint32_t supported=0,count=0;uint64_t processedBytes=0;
  while(at<stream.size()) {
    require(++count<=limit,"Too many descriptors in this coverage page.");
    require(at+4<=stream.size(),"Truncated descriptor frame.");const auto size=flatbuffers::ReadScalar<uint32_t>(stream.data()+at);require(size>=8 && size+4<=stream.size()-at,"Invalid descriptor frame.");
    flatbuffers::Verifier verifier(stream.data()+at,size+4);require(VerifySizePrefixedNCDBuffer(verifier),"Invalid NCD.");const auto* ncd=GetSizePrefixedNCD(stream.data()+at);at+=size+4;
    const auto format=ncd->FORMAT()==ncdContainerFormat_CCSDS_OEM_KVN?std::string("ccsds-oem-kvn"):ncd->FORMAT()==ncdContainerFormat_PROVIDER_DEFINED && ncd->PROVIDER_DEFINED_FORMAT_NAME()?ncd->PROVIDER_DEFINED_FORMAT_NAME()->str():std::string();
    if(format!="ccsds-oem-kvn" && format!="tle" && format!="eumetsat-tle-js")continue;
    require(ncd->SOURCE_CID() && ncd->SOURCE_SHA256(),"Descriptor lacks immutable source binding.");require(ncd->SOURCE_BYTE_LENGTH()<=hardMaxBytes && processedBytes+ncd->SOURCE_BYTE_LENGTH()<=64*1024*1024,"Coverage page exceeds its byte budget.");processedBytes+=ncd->SOURCE_BYTE_LENGTH();const auto cid=ncd->SOURCE_CID()->str(),hash=ncd->SOURCE_SHA256()->str();const auto raw=ipfs_cat(cid);require(digest(raw)==hash && raw.size()==ncd->SOURCE_BYTE_LENGTH(),"Archived source does not match its descriptor.");
    const auto coverage=object_coverage({{"format",format}},raw);if(coverage.empty())continue;
    Attribution a;a.url="ipfs://"+cid;a.batch=hash;a.sha256=hash;a.parser_version="primary-object-coverage/0.2.0";a.attributes={{"source_id",sourceId},{"source_cid",cid}};
    require(ingest("CAT.fbs",sourceId,coverage,a),"Coverage was not stored.");++supported;
  }
  Status s;s.source_id=sourceId;s.scanned=count;s.supported=supported;s.next_offset=offset+count;s.state=count<limit?srgRetrievalState_Complete:srgRetrievalState_InProgress;return emit_status(s);
});}
#endif
