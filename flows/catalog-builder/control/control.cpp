// Durable progress is the committed CAT selection. A restart repeats complete
// reads and skips matching selections whose products remain available.
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "TimerTick_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "FlowNotice_generated.h"
#include <map>
#include <set>
#include <string>
#include <vector>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <ctime>
#include <algorithm>
namespace catalog_control {
namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;
std::string text(const flatbuffers::String* s) { return s ? s->str() : ""; }
const plugin_input_frame_t* input(const char* port) { const int i=plugin_find_input_index(port,0);return i<0?nullptr:plugin_get_input_frame(i); }
Bytes bytes(const plugin_input_frame_t* f) { return f?Bytes(f->payload,f->payload+f->payload_length):Bytes{}; }
std::string digest(const Bytes& b) { return ephem::sha256_hex(b.data(),b.size()); }
std::string cid(const Bytes& b) { return sdn_cid::cid_v1_raw_sha256(b.data(),b.size()); }
int64_t instant(const std::string& s) {
 int y,m,d,h,mi;double sec;
 if(std::sscanf(s.c_str(),"%4d-%2d-%2dT%2d:%2d:%lf",&y,&m,&d,&h,&mi,&sec)!=6||m<1||m>12||d<1||d>31||h>23||mi>59||!std::isfinite(sec)||sec<0||sec>=60)return -1;
 y-=m<=2;const int era=(y>=0?y:y-399)/400;const unsigned yy=y-era*400;
 const unsigned doy=(153*(m+(m>2?-3:9))+2)/5+d-1,doe=yy*365+yy/4-yy/100+doy;
 return ((int64_t(era)*146097+doe-719468)*86400+h*3600+mi*60)*1000+llround(sec*1000);
}
std::string iso(int64_t ms) {
 const time_t seconds=ms/1000;std::tm tm{};gmtime_r(&seconds,&tm);char out[40];
 std::snprintf(out,sizeof out,"%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",tm.tm_year+1900,tm.tm_mon+1,tm.tm_mday,tm.tm_hour,tm.tm_min,tm.tm_sec,int(ms%1000));return out;
}
struct Source {std::string schema,provider,name;};
struct Seed {Bytes data;int64_t epoch=0;size_t rank=0;};
struct Settings {
 std::string provider,identity_provider,identity_source,weather_provider,weather_source,recipe;
 size_t page=512,batch=128,partitions=1,partition=0,max_records=200000,max_bytes=128*1024*1024;
 double margin=0,nonres_e=.05,res_e=.3,max_rms=2,max_error=10;
 std::vector<Source> seeds;
} cfg;
enum class Phase {Idle,Scan,Chain,Annotate,ProductStored,Compose,IndexStored};
Phase phase=Phase::Idle;
std::vector<Source> scans;size_t scan_at=0,pages=0,seen=0,retained=0,done=0,at=0;
std::string cursor,signature,reason,pending_batch,pending_schema;
int64_t now=0;
std::map<uint32_t,Seed> seeds;
std::map<uint32_t,Bytes> identities,index;
std::map<std::string,Bytes> weather;
std::set<std::string> products;
std::vector<uint32_t> work;
Bytes pending,chosen,object_weather;
bool run_fit=false;
int push(const char* port,const char* code,const Bytes& data) {
 const std::string schema=std::string(code)+".fbs",id=(std::strlen(code)==3?"$":"")+std::string(code);
 return plugin_push_output_ex(port,schema.c_str(),id.c_str(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,code,0,0,data.data(),data.size())<0?500:0;
}
int notice(const std::string& message,bool failed=false) {
 R::FlowNoticeT n;n.KIND=failed?R::flowNoticeKind_Info:done?R::flowNoticeKind_Info:R::flowNoticeKind_Unchanged;
 n.SCHEMA="CAT.fbs";n.PROVIDER_ID=cfg.provider;n.SOURCE_NAME="catalog-index";n.REASON=message;n.COUNT=done;
 flatbuffers::FlatBufferBuilder b;R::FinishFlowNoticeBuffer(b,R::FlowNotice::Pack(b,&n));
 return plugin_push_output_ex("notice","FlowNotice.fbs","FNTC",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,b.GetBufferPointer(),b.GetSize())<0?500:0;
}
int stop(const std::string& message) {phase=Phase::Idle;plugin_set_error("catalog-controller",message.c_str());notice(message,true);return 1;}
int finish() {phase=Phase::Idle;return notice("Catalog reconciliation complete for the bounded selection batch.");}
bool configure() {
 const auto c=sdm_piv::get_config();if(!c.ok())return false;
 cfg.provider=std::string(c.string("catalog.provider"));cfg.identity_provider=std::string(c.string("catalog.identity_provider"));cfg.identity_source=std::string(c.string("catalog.identity_source"));
 cfg.weather_provider=std::string(c.string("catalog.weather_provider"));cfg.weather_source=std::string(c.string("catalog.weather_source"));cfg.recipe=std::string(c.string("catalog.recipe_revision","W/1"));
 const auto sources=c.strings("catalog.seed_sources"),providers=c.strings("catalog.seed_providers");
 if(sources.empty()||sources.size()!=providers.size()||sources.size()>16||cfg.provider.empty()||cfg.identity_provider.empty()||cfg.identity_source.empty()||cfg.weather_provider.empty()||cfg.weather_source.empty())return false;
 cfg.seeds.clear();for(size_t i=0;i<sources.size();++i){if(sources[i].empty()||providers[i].empty())return false;cfg.seeds.push_back({"OMM",std::string(providers[i]),std::string(sources[i])});}
 auto bound=[&](const char* key,size_t& value,size_t low,size_t high){const double v=c.number(key,value);if(!std::isfinite(v)||v<low||v>high||std::floor(v)!=v)return false;value=size_t(v);return true;};
 if(!bound("catalog.page_size",cfg.page,1,1000)||!bound("catalog.batch_size",cfg.batch,1,4096)||!bound("catalog.partition_count",cfg.partitions,1,8)||!bound("catalog.partition_index",cfg.partition,0,cfg.partitions-1)||!bound("catalog.max_records",cfg.max_records,1,2000000)||!bound("catalog.max_bytes",cfg.max_bytes,1024,512*1024*1024))return false;
 cfg.margin=c.number("catalog.validity_margin_seconds",0);cfg.nonres_e=c.number("catalog.nonresonant_max_e",.05);cfg.res_e=c.number("catalog.resonant_max_e",.3);cfg.max_rms=c.number("catalog.max_fit_rms_km",2);cfg.max_error=c.number("catalog.max_fit_error_km",10);
 return std::isfinite(cfg.margin)&&cfg.margin>=0&&cfg.nonres_e>=0&&cfg.nonres_e<=.05&&cfg.res_e>=0&&cfg.res_e<=.3&&std::isfinite(cfg.max_rms)&&cfg.max_rms>0&&std::isfinite(cfg.max_error)&&cfg.max_error>0;
}
int query() {
 if(scan_at>=scans.size())return 0;
 const auto& s=scans[scan_at];QRPT q;q.KIND=qrpKind::Request;q.SCHEMA_NAME=s.schema+".fbs";q.PROVIDER_ID=s.provider;q.SOURCE_NAME=s.name;q.LIMIT=cfg.page;q.MAX_BYTES=8*1024*1024;q.CURSOR=cursor;
 flatbuffers::FlatBufferBuilder b;FinishQRPBuffer(b,QRP::Pack(b,&q));phase=Phase::Scan;
 return push("query","QRP",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()});
}
// Page order is durable arrival order. Within a source, a newer epoch wins;
// an equal-epoch correction takes the later arrival. Earlier configured sources
// take precedence, independent of their relative ingestion order.
bool retain(const uint8_t* p,size_t n) {
 const auto& scan=scans[scan_at];Bytes data(p,p+n);retained+=scan.schema=="OCM"?128:n;
 if(retained>cfg.max_bytes||++seen>cfg.max_records)return false;
 if(scan.schema=="OMM") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedOMMBuffer(v))return false;const auto* o=GetSizePrefixedOMM(p);const auto epoch=instant(text(o->EPOCH()));const auto id=o->NORAD_CAT_ID();if(!id||epoch<0)return false;
  auto found=seeds.find(id);if(found==seeds.end()||scan_at<found->second.rank||(scan_at==found->second.rank&&epoch>=found->second.epoch))seeds[id]={std::move(data),epoch,scan_at};
 } else if(scan.schema=="SPW") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedSPWBuffer(v))return false;const auto* w=GetSizePrefixedSPW(p);if(!w->DATE())return false;weather[text(w->DATE())]=std::move(data);
 } else if(scan.schema=="CAT") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedCATBuffer(v))return false;const auto* c=GetSizePrefixedCAT(p);if(!c->NORAD_CAT_ID())return false;
  auto& target=scan.name=="catalog-index"&&scan.provider==cfg.provider?index:identities;
  const auto old=target.find(c->NORAD_CAT_ID());
  if(&target==&identities||old==target.end()||instant(text(c->PRODUCTS_AS_OF()))>=instant(text(GetSizePrefixedCAT(old->second.data())->PRODUCTS_AS_OF())))target[c->NORAD_CAT_ID()]=std::move(data);
 } else if(scan.schema=="OCM") {products.insert(cid(data));}
 else return false;
 return true;
}
int next_object();
int page(const plugin_input_frame_t* f) {
 if(phase!=Phase::Scan||!f||f->payload_length<12)return stop("Unexpected or empty complete-read response.");
 const auto* p=f->payload;const auto n=flatbuffers::ReadScalar<uint32_t>(p)+size_t(4);
 if(n>f->payload_length)return stop("Truncated complete-read header.");flatbuffers::Verifier v(p,n);
 if(!VerifySizePrefixedQRPBuffer(v))return stop("Complete read failed; restart the sweep from its first page.");
 const auto* q=GetSizePrefixedQRP(p);const auto& scan=scans[scan_at];
 if(q->KIND()!=qrpKind::Page||q->STATUS()!=qrpStatus::Ok||text(q->SCHEMA_NAME())!=scan.schema+".fbs"||text(q->PROVIDER_ID())!=scan.provider||text(q->SOURCE_NAME())!=scan.name)return stop("Complete read failed or changed its source filter.");
 if(++pages>10000)return stop("Complete sweep exceeds its page bound.");
 size_t off=n,count=0;while(off<f->payload_length){if(f->payload_length-off<4)return stop("Truncated page record.");const auto len=size_t(flatbuffers::ReadScalar<uint32_t>(p+off))+4;if(len>f->payload_length-off||!retain(p+off,len))return stop("Invalid record or complete sweep exceeds its configured bound.");off+=len;++count;}
 if(count!=q->RECORD_COUNT())return stop("Complete-read count mismatch.");
 const auto next=text(q->NEXT_CURSOR());if(!next.empty()){if(next==cursor||!count)return stop("Complete read did not advance.");cursor=next;return query();}
 cursor.clear();++scan_at;if(scan_at<scans.size())return query();
 work.clear();for(const auto& entry:identities)work.push_back(entry.first);for(const auto& entry:index)if(!identities.count(entry.first))work.push_back(entry.first);
 at=0;return next_object();
}
int compose() {
 const auto id=work[at];const auto old=index.find(id);const auto identity=identities.find(id);
 const Bytes& cat=old!=index.end()?old->second:identity->second;
 XMTT x;x.INTEGRATE_RECIPE=std::make_unique<XMTIntegrateRecipeT>();x.INTEGRATE_RECIPE->AS_OF_MS=now;
 QRPT q;q.KIND=qrpKind::Page;q.STATUS=qrpStatus::Ok;q.MESSAGE=reason+"; catalog-input="+signature;
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedXMTBuffer(b,XMT::Pack(b,&x));
 if(push("recipe","XMT",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})||push("catalog","CAT",cat))return stop("Cannot queue catalog replacement.");
 b.Clear();FinishQRPBuffer(b,QRP::Pack(b,&q));if(push("selection","QRP",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()}))return stop("Cannot queue selection reason.");
 if(!chosen.empty()&&push("selected","OCM",chosen))return stop("Cannot queue selected product.");phase=Phase::Compose;return 0;
}
int ingest(const Bytes& data,bool is_index) {
 pending=data;pending_schema=is_index?"CAT":"OCM";pending_batch="catalog-"+digest(data)+(is_index?":complete":"");
 // Each acknowledged replacement is one complete generation. Its product is
 // durable before this terminal index batch; removals need no product write.
 R::IngestRequestT request;request.SCHEMA=pending_schema+".fbs";request.RECONCILE=R::reconcileMode_Duplicates;request.TAGS=std::make_unique<R::SourceTagsT>();
 request.TAGS->PROVIDER_ID=cfg.provider;request.TAGS->SOURCE_NAME=is_index?"catalog-index":"catalog-products";request.TAGS->BATCH_ID=pending_batch;request.TAGS->CONTENT_KEY_ID="public";
 flatbuffers::FlatBufferBuilder b;R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&request));
 if(plugin_push_output_ex("meta","IngestRequest.fbs","INGQ",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"IngestRequest",0,0,b.GetBufferPointer(),b.GetSize())<0||push(is_index?"index_records":"product_records",pending_schema.c_str(),data))return stop("Cannot queue storage input.");
 phase=is_index?Phase::IndexStored:Phase::ProductStored;return 0;
}
int next_object() {
 for(;at<work.size()&&done<cfg.batch;++at){
  const auto id=work[at];if(id%cfg.partitions!=cfg.partition)continue;chosen.clear();signature.clear();reason.clear();object_weather.clear();const auto s=seeds.find(id);const auto identity=identities.find(id);const auto old=index.find(id);
  const bool removed=identity==identities.end()||s==seeds.end()||(GetSizePrefixedCAT(identity->second.data())->DECAY_DATE()&&!text(GetSizePrefixedCAT(identity->second.data())->DECAY_DATE()).empty()&&text(GetSizePrefixedCAT(identity->second.data())->DECAY_DATE())<=iso(now).substr(0,10));
  const auto* previous=old==index.end()?nullptr:GetSizePrefixedCAT(old->second.data());
  if(removed){if(!previous||!previous->PRODUCTS()||!previous->PRODUCTS()->size())continue;reason="object removed from the configured current sources";return compose();}
  const auto* omm=GetSizePrefixedOMM(s->second.data.data());
  const auto low=iso(s->second.epoch-45LL*86400000).substr(0,10),high=iso(s->second.epoch+50LL*86400000).substr(0,10);
  for(auto i=weather.lower_bound(low);i!=weather.end()&&i->first<=high;++i)object_weather.insert(object_weather.end(),i->second.begin(),i->second.end());
  const std::string policy=cfg.recipe+"/"+std::to_string(cfg.nonres_e)+"/"+std::to_string(cfg.res_e)+"/"+std::to_string(cfg.max_rms)+"/"+std::to_string(cfg.max_error);
  signature=digest(s->second.data)+"/"+digest(object_weather)+"/"+ephem::sha256_hex(reinterpret_cast<const uint8_t*>(policy.data()),policy.size());
  const double n=omm->MEAN_MOTION()*6.2831853071795864769/1440;
  const bool resonant=n>.0035003818&&n<=.015751718;
  const bool eligible=std::isfinite(omm->ECCENTRICITY())&&omm->ECCENTRICITY()>=0&&omm->ECCENTRICITY()<=(resonant?cfg.res_e:cfg.nonres_e);
  const bool expired=s->second.epoch+5LL*86400000<now+cfg.margin*1000;
  const bool future=s->second.epoch>now;
  if(previous&&previous->PRODUCTS()&&previous->PRODUCTS()->size()==1){const auto* p=previous->PRODUCTS()->Get(0);if(products.count(text(p->RECORD_CID()))&&text(p->SELECTION_REASON()).find("catalog-input="+signature)!=std::string::npos&&(!expired||p->KIND()!=catalogProductKind::ApElements))continue;}
  reason=expired?"old-span fallback":future?"future-seed fallback":!eligible?"outside configured AP class":"accepted exact-W fit";run_fit=!expired&&!future&&eligible;
  if(!run_fit){phase=Phase::Chain;return push("fallback_seed","OMM",{s->second.data.begin()+4,s->second.data.end()});}
  PCFT flight;flight.THEORY=pcfTheory::SGP4;flight.OUTPUT=std::make_unique<PCFOutputT>();flight.OUTPUT->FRAME=pcfOutputFrame::GCRF;flight.OUTPUT->START_TIME=iso(s->second.epoch-216000000);flight.OUTPUT->STOP_TIME=iso(s->second.epoch+432000000);flight.OUTPUT->STEP_SECONDS=300;
  flatbuffers::FlatBufferBuilder b;FinishPCFBuffer(b,PCF::Pack(b,&flight));if(push("flight_config","PCF",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()}))return stop("Cannot queue flight policy.");
  PCFT fit;fit.THEORY=pcfTheory::AP;fit.FORCES=std::make_unique<PCFForceModelT>();fit.FORCES->ATMOSPHERE_MODEL=pcfAtmosphereFamily::NRLMSISE00;fit.FORCES->WEATHER_SOURCE=pcfWeatherSource::RECORDS;fit.FORCES->HAS_MAXIMUM_DEGREE=true;fit.FORCES->MAXIMUM_DEGREE=20;
  if(omm->ECCENTRICITY()<=.048){fit.FORCES->HAS_MAXIMUM_TESSERAL_DEGREE=true;fit.FORCES->MAXIMUM_TESSERAL_DEGREE=31;}fit.FIT=std::make_unique<PCFFitPolicyT>();fit.FIT->WEATHER_HORIZON_DAYS=30;
  b.Clear();b.ForceDefaults(true);FinishPCFBuffer(b,PCF::Pack(b,&fit));if(push("fit_config","PCF",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})||(!object_weather.empty()&&push("weather","SPW",object_weather))||push("seed","OMM",{s->second.data.begin()+4,s->second.data.end()}))return stop("Cannot queue exact-W inputs.");phase=Phase::Chain;return 0;
 }
 return finish();
}
int chain() {
 const auto* fallback=input("fallback"),*candidate=input("candidate"),*decision=input("chain_status");if(phase!=Phase::Chain||!fallback||!decision)return stop("Incomplete chain outcome.");
 flatbuffers::Verifier qv(decision->payload,decision->payload_length);if(!VerifyQRPBuffer(qv))return stop("Invalid chain outcome.");const auto* q=GetQRP(decision->payload);
 const auto& seed=seeds.at(work[at]);const plugin_input_frame_t* use=fallback;
 if(run_fit&&candidate&&q->STATUS()==qrpStatus::Ok){flatbuffers::Verifier v(candidate->payload,candidate->payload_length);if(!VerifyOCMBuffer(v))return stop("Invalid fit record.");const auto* o=GetOCM(candidate->payload);const auto* stats=o->ORBIT_DETERMINATION()?o->ORBIT_DETERMINATION()->FIT_STATISTICS():nullptr;
  if(stats&&stats->FIT_STATES()==2161&&std::isfinite(stats->FIT_RMS_KM())&&stats->FIT_RMS_KM()<=cfg.max_rms&&std::isfinite(stats->FIT_MAX_KM())&&stats->FIT_MAX_KM()<=cfg.max_error&&instant(text(stats->FIT_START()))==seed.epoch-216000000&&instant(text(stats->FIT_STOP()))==seed.epoch+432000000)use=candidate;else reason="fit-statistics refusal fallback";
 }else if(run_fit)reason="fit refusal fallback: "+text(q->ERROR_CODE());
 flatbuffers::Verifier ov(use->payload,use->payload_length);if(!VerifyOCMBuffer(ov))return stop("Invalid selected orbit.");auto record=std::unique_ptr<OCMT>(GetOCM(use->payload)->UnPack());
 if(use==fallback){if(!record->HEADER)record->HEADER=std::make_unique<HeaderT>();record->HEADER->COMMENT.push_back(reason);}
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedOCMBuffer(b,OCM::Pack(b,record.get()));
 if(push("annotate_orbit","OCM",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})||push("annotate_seed","OMM",seed.data))return stop("Cannot queue population annotation.");phase=Phase::Annotate;return 0;
}
int advance() {
 if(input("tick")){
  if(!configure())return stop("Invalid catalog ModuleConfig.");const auto* f=input("tick");flatbuffers::Verifier v(f->payload,f->payload_length);if(!R::VerifyTimerTickBuffer(v))return stop("Invalid timer tick.");now=R::GetTimerTick(f->payload)->FIRED_MS();if(now<=0)return stop("Timer requires a positive UTC time.");
  seeds.clear();identities.clear();index.clear();weather.clear();products.clear();scans=cfg.seeds;scans.push_back({"CAT",cfg.identity_provider,cfg.identity_source});scans.push_back({"SPW",cfg.weather_provider,cfg.weather_source});scans.push_back({"CAT",cfg.provider,"catalog-index"});scans.push_back({"OCM",cfg.provider,"catalog-products"});scan_at=pages=seen=retained=done=at=0;cursor.clear();return query();
 }
 if(const auto* f=input("query_status")){flatbuffers::Verifier v(f->payload,f->payload_length);if(!VerifyQRPBuffer(v)||GetQRP(f->payload)->KIND()==qrpKind::Error)return stop("Complete read failed; no partial sweep is committed.");}
 if(const auto* f=input("page"))return page(f);
 if(input("query_status"))return 0;
 if(input("chain_status"))return chain();
 if(const auto* f=input("annotated")){
  if(phase!=Phase::Annotate)return stop("Unexpected annotation.");flatbuffers::Verifier v(f->payload,f->payload_length);if(!VerifySizePrefixedOCMBuffer(v))return stop("Invalid annotation.");chosen=bytes(f);const auto* o=GetSizePrefixedOCM(chosen.data());if(o->COV_REALISM())for(const auto* l:*o->COV_REALISM())if(text(l->EVIDENCE()).rfind("no population covariance",0)==0)reason+="; "+text(l->EVIDENCE());if(products.count(cid(chosen)))return compose();return ingest(chosen,false);
 }
 if(const auto* f=input("replacement")){if(phase!=Phase::Compose)return stop("Unexpected index replacement.");return ingest(bytes(f),true);}
 if(const auto* f=input("stored")){
  flatbuffers::Verifier v(f->payload,f->payload_length);if(!R::VerifyIngestResultBuffer(v))return stop("Invalid storage acknowledgment.");const auto* r=R::GetIngestResult(f->payload);
  if((phase!=Phase::ProductStored&&phase!=Phase::IndexStored)||!text(r->REFUSED()).empty()||text(r->SCHEMA())!=pending_schema+".fbs"||text(r->PROVIDER_ID())!=cfg.provider||text(r->BATCH_ID())!=pending_batch||text(r->SOURCE_NAME())!=(phase==Phase::ProductStored?"catalog-products":"catalog-index")||r->INSERTED()>1)return stop("Storage refused or did not acknowledge the complete deterministic batch.");
  if(phase==Phase::ProductStored){products.insert(cid(chosen));return compose();}
  index[work[at]]=pending;++done;++at;return next_object();
 }
 return stop("Incomplete controller response.");
}
}
extern "C" int advance(){return catalog_control::advance();}
