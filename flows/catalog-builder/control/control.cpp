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
#include <cstdlib>
#include <ctime>
#include <chrono>
#include <algorithm>
#include <cassert>
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
 size_t page=512,batch=128,partitions=1,partition=0,max_records=400000,max_bytes=64*1024*1024;
 size_t budget_ms=540000,allowance_ms=2000;
 double max_removal_fraction=.25,margin=0,nonres_e=.05,res_e=.3,max_rms=2,max_error=10;
 std::vector<Source> seeds;
} cfg;
enum class Phase {Idle,Scan,Lookup,AttemptStored,FailureStored,PoisonStored,SuccessStored,Chain,Annotate,ProductStored,Compose,GenerationPrepared,IndexStored};
Phase phase=Phase::Idle;
std::vector<Source> scans;size_t scan_at=0,pages=0,seen=0,retained=0,done=0,at=0;
std::string cursor,signature,reason,pending_batch,pending_schema;
int64_t now=0;unsigned storage_failures=0;bool clock_reported=false;
using Clock=std::chrono::steady_clock;Clock::time_point tick_start,object_start;double allowance=2000;
std::map<uint32_t,Seed> seeds;
std::map<uint32_t,Bytes> identities,index;
std::map<std::string,Bytes> weather;
std::set<std::string> products;
std::vector<uint32_t> work;
std::set<uint32_t> dropped;
Bytes pending,chosen,object_weather;
// Selection construction and generation persistence have separate lifetimes.
constexpr size_t product_batch_bytes=4*1024*1024,index_batch_bytes=4*1024*1024,generation_bytes=32*1024*1024;
struct Selection {uint32_t id;Bytes product,record;bool retry;};
struct ProductBatch {Bytes data;size_t count=0;std::vector<uint32_t> ids;};
std::vector<Selection> staged;
std::vector<ProductBatch> product_batches;
Bytes generation_index;size_t staged_bytes=0,product_batch_at=0,pending_count=0;
std::string lookup_batch,lookup_cursor,recovery_batch;
bool chosen_stored=false;
std::set<std::string> checked_batches;
int flush_generation();
int stage_selection(const Bytes& record);
bool metadata_only=false,retry_fallback=false;Bytes fallback_annotation;
bool compose_only=false,run_fit=false,complete_scan=true,capacity_limited=false,seed_complete=true,identity_complete=true,index_complete=true,weather_complete=true,removal_guard=false,index_defects=false;
struct Poison {unsigned count=0;std::string source;uint64_t sequence=0;};
constexpr size_t state_limit=4096,max_batch_size=1024;
static_assert(max_batch_size+1<state_limit,"A generation and its interruption suspect fit in the attempt cache.");
bool state_evicted=false;uint32_t interruption_suspect=0;
size_t state_rows=0,state_appends=0;uint64_t state_sequence=0;bool state_complete=true,state_history_oversized=false,scan_exhausted=false;
std::string state_source(){return "catalog-attempts"+(cfg.partitions==1?std::string():"-"+std::to_string(cfg.partition)+"-of-"+std::to_string(cfg.partitions));}
std::map<std::string,Poison> poisons;
std::set<std::string> poison_seen;
Bytes poison_updates;
struct Retry {unsigned attempts=0;int64_t after=0;std::string reason;};
struct Attempt {Bytes data;std::string signature;unsigned count=0;int64_t time=0;bool final=false;uint64_t sequence=0;std::string product_batch;size_t read_bytes=0;bool recovery_pin=true;};
std::map<uint32_t,Attempt> attempts;
std::set<uint32_t> dirty_attempts;
std::string attempt_detail(const Attempt& a){return text(GetSizePrefixedNEV(a.data.data())->EVENTS()->Get(0)->DETAIL());}
void ready_or_suspect(Attempt& a,bool suspect){
 auto log=std::unique_ptr<NEVT>(GetSizePrefixedNEV(a.data.data())->UnPack());auto& detail=log->EVENTS[0]->DETAIL;
 detail.replace(0,std::string("in progress ").size(),suspect?"retry ":"ready ");
 if(suspect)detail+=" instance-interrupted;";
 const auto seq=detail.find("sequence="),end=detail.find(';',seq);a.sequence=++state_sequence;
 detail.replace(seq+9,end-seq-9,std::to_string(a.sequence));
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,log.get()));a.data.assign(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
}
bool transient_refusal(const std::string& code);
int save_attempt(bool final=false,const std::string& failure="");
int start_chain();
int complete_reads();
struct Diagnostics {
 size_t invalid=0,failed=0,deferred=0,removed=0,evicted=0;std::map<std::string,std::vector<std::string>> examples;
 void add(const std::string& value,const std::string& category="general"){auto& group=examples[category];if(group.size()<4)group.push_back(value);}
 std::string summary()const{std::string out="invalid="+std::to_string(invalid)+" failed="+std::to_string(failed)+" deferred="+std::to_string(deferred);out+=" removed="+std::to_string(removed)+" evicted="+std::to_string(evicted);for(const auto& group:examples)for(const auto& e:group.second)out+="; "+e;return out;}
} diagnostics;
// Recovery references are pinned; all other entries share one event-sequence FIFO.
bool protected_attempt(uint32_t id,uint64_t latest){
 const auto& a=attempts.at(id);
 return id==interruption_suspect||(a.recovery_pin&&!a.product_batch.empty())||
  (a.sequence==latest&&attempt_detail(a).rfind("in progress ",0)==0)||
  std::any_of(staged.begin(),staged.end(),[&](const Selection& item){return item.id==id;});
}
void trim_state(){
 while(attempts.size()+poisons.size()>state_limit){
  uint64_t latest=0;for(const auto& item:attempts)latest=std::max(latest,item.second.sequence);
  auto victim=attempts.end();auto poison=poisons.end();uint64_t oldest=UINT64_MAX;
  for(auto i=attempts.begin();i!=attempts.end();++i)if(i->second.sequence<oldest&&!protected_attempt(i->first,latest)){oldest=i->second.sequence;victim=i;}
  for(auto i=poisons.begin();i!=poisons.end();++i)if(i->second.sequence<oldest){oldest=i->second.sequence;poison=i;}
  if(victim==attempts.end()&&poison==poisons.end()){
   // Old preparation references are hints; products are re-sent on recovery.
   for(auto i=attempts.begin();i!=attempts.end();++i)if(i->second.sequence<oldest&&!std::any_of(staged.begin(),staged.end(),[&](const Selection& item){return item.id==i->first;})){oldest=i->second.sequence;victim=i;}
   if(victim==attempts.end())victim=std::min_element(attempts.begin(),attempts.end(),[](const auto& a,const auto& b){return a.second.sequence<b.second.sequence;});
   diagnostics.add("warning: oldest protected recovery entry evicted at attempt bound","bounds");
  }
  if(poison!=poisons.end())poisons.erase(poison);else {retained-=victim->second.read_bytes;attempts.erase(victim);}
  ++diagnostics.evicted;state_evicted=true;
 }
}
std::string poison_detail(const Poison& p){return p.source+"; sequence="+std::to_string(p.sequence)+";";}
bool budget_left(){return std::chrono::duration<double,std::milli>(Clock::now()-tick_start).count()+allowance<cfg.budget_ms;}
int next_object();
int fail_object(const std::string& message,bool final=false){
 if(at>=work.size())return 1;
 ++diagnostics.failed;diagnostics.add("object="+std::to_string(work[at])+" reason="+message+"; durable failure recorded","failure");
 return save_attempt(final,message);
}
int push(const char* port,const char* code,const Bytes& data) {
 const std::string schema=std::string(code)+".fbs",id=(std::strlen(code)==3?"$":"")+std::string(code);
 return plugin_push_output_ex(port,schema.c_str(),id.c_str(),PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,code,0,0,data.data(),data.size())<0?500:0;
}
int notice(const std::string& message,bool failed=false) {
 R::FlowNoticeT n;n.KIND=(failed||scan_exhausted)?R::flowNoticeKind_Missing:(done||diagnostics.deferred||diagnostics.evicted)?R::flowNoticeKind_Info:R::flowNoticeKind_Unchanged;
 n.SCHEMA="CAT.fbs";n.PROVIDER_ID=cfg.provider;n.SOURCE_NAME="catalog-index";n.REASON=message+"; "+diagnostics.summary();n.COUNT=done;
 flatbuffers::FlatBufferBuilder b;R::FinishFlowNoticeBuffer(b,R::FlowNotice::Pack(b,&n));
 return plugin_push_output_ex("notice","FlowNotice.fbs","FNTC",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"FlowNotice",0,0,b.GetBufferPointer(),b.GetSize())<0?500:0;
}
int stop(const std::string& message) {phase=Phase::Idle;plugin_set_error("catalog-controller",message.c_str());notice(message,true);return 1;}
int finished() {phase=Phase::Idle;return notice("Catalog reconciliation complete for the bounded selection batch.");}
int persist_events(Phase after);
int finish(){if(scan_at<scans.size())return finished();return staged.empty()?persist_events(Phase::SuccessStored):flush_generation();}
bool configure() {
 const auto c=sdm_piv::get_config();if(!c.ok())return false;
 cfg.provider=std::string(c.string("catalog.provider"));cfg.identity_provider=std::string(c.string("catalog.identity_provider"));cfg.identity_source=std::string(c.string("catalog.identity_source"));
 cfg.weather_provider=std::string(c.string("catalog.weather_provider"));cfg.weather_source=std::string(c.string("catalog.weather_source"));cfg.recipe=std::string(c.string("catalog.recipe_revision","W/1"));
 const auto sources=c.strings("catalog.seed_sources"),providers=c.strings("catalog.seed_providers");
 if(sources.empty()||sources.size()!=providers.size()||sources.size()>16||cfg.provider.empty()||cfg.identity_provider.empty()||cfg.identity_source.empty()||cfg.weather_provider.empty()||cfg.weather_source.empty())return false;
 cfg.seeds.clear();for(size_t i=0;i<sources.size();++i){if(sources[i].empty()||providers[i].empty())return false;cfg.seeds.push_back({"OMM",std::string(providers[i]),std::string(sources[i])});}
 auto bound=[&](const char* key,size_t& value,size_t low,size_t high){const double v=c.number(key,value);if(!std::isfinite(v)||v<low||v>high||std::floor(v)!=v)return false;value=size_t(v);return true;};
 if(!bound("catalog.invocation_budget_ms",cfg.budget_ms,1000,540000)||!bound("catalog.object_allowance_ms",cfg.allowance_ms,2000,60000)||!bound("catalog.page_size",cfg.page,1,1000)||!bound("catalog.batch_size",cfg.batch,1,max_batch_size)||!bound("catalog.partition_count",cfg.partitions,1,8)||!bound("catalog.partition_index",cfg.partition,0,cfg.partitions-1)||!bound("catalog.max_records",cfg.max_records,1,500000)||!bound("catalog.max_bytes",cfg.max_bytes,1024,96*1024*1024))return false;
 if(cfg.batch+1>=state_limit)return false;
 cfg.max_removal_fraction=c.number("catalog.max_removal_fraction",.25);cfg.margin=c.number("catalog.validity_margin_seconds",0);cfg.nonres_e=c.number("catalog.nonresonant_max_e",.05);cfg.res_e=c.number("catalog.resonant_max_e",.3);cfg.max_rms=c.number("catalog.max_fit_rms_km",2);cfg.max_error=c.number("catalog.max_fit_error_km",10);
 return std::isfinite(cfg.max_removal_fraction)&&cfg.max_removal_fraction>=0&&cfg.max_removal_fraction<=1&&std::isfinite(cfg.margin)&&cfg.margin>=0&&cfg.nonres_e>=0&&cfg.nonres_e<=.05&&cfg.res_e>=0&&cfg.res_e<=.3&&std::isfinite(cfg.max_rms)&&cfg.max_rms>0&&std::isfinite(cfg.max_error)&&cfg.max_error>0;
}
int query() {
 if(scan_at>=scans.size())return 0;if(!budget_left()){scan_exhausted=true;++diagnostics.deferred;diagnostics.add("scan elapsed budget exhausted before all sources completed","bounds");return finish();}
 const auto& s=scans[scan_at];QRPT q;q.KIND=qrpKind::Request;q.SCHEMA_NAME=s.schema+".fbs";q.PROVIDER_ID=s.provider;q.SOURCE_NAME=s.name;q.LIMIT=cfg.page;q.MAX_BYTES=8*1024*1024;q.CURSOR=cursor;
 flatbuffers::FlatBufferBuilder b;FinishQRPBuffer(b,QRP::Pack(b,&q));phase=Phase::Scan;
 return push("query","QRP",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()});
}
// Page order is durable arrival order. Within a source, a newer epoch wins;
// an equal-epoch correction takes the later arrival. Earlier configured sources
// take precedence, independent of their relative ingestion order.
bool retain(const uint8_t* p,size_t n) {
 const auto& scan=scans[scan_at];Bytes data(p,p+n);++seen;
 auto room=[&](size_t old_size){const size_t cost=old_size?old_size+256:0;return retained-cost+n+256<=cfg.max_bytes&&(old_size||seeds.size()+identities.size()+index.size()+weather.size()+attempts.size()<cfg.max_records);};
 auto account=[&](size_t old_size){retained=retained-(old_size?old_size+256:0)+n+256;};
 if(scan.schema=="NEV") {
  ++state_rows;
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedNEVBuffer(v))return false;const auto* log=GetSizePrefixedNEV(p);
  if(text(log->NODE_ID())!=cfg.provider)return false;
  if(!log->EVENTS())return true;
  for(const auto* e:*log->EVENTS()){
   const auto subject=text(e->SUBJECT());
   if(subject.rfind("catalog-invalid/",0)==0){
    const auto detail=text(e->DETAIL());const auto seq_at=detail.find("; sequence=");uint64_t seq=0;
    if(seq_at!=std::string::npos){char* end=nullptr;seq=std::strtoull(detail.c_str()+seq_at+11,&end,10);if(end==detail.c_str()+seq_at+11||*end!=';')return false;}
    state_sequence=std::max(state_sequence,seq);
    auto& item=poisons[subject];if(seq>item.sequence||(seq==item.sequence&&e->COUNT()>item.count))item={unsigned(std::min<uint64_t>(e->COUNT(),3)),detail.substr(0,seq_at),seq};trim_state();continue;
   }
   unsigned id=0;char tail=0;if(std::sscanf(subject.c_str(),"catalog-object/%u%c",&id,&tail)!=1||!id)return false;if(id%cfg.partitions!=cfg.partition)continue;
   const auto detail=text(e->DETAIL());const auto first=detail.find("input="),last=detail.find(';',first),seq_at=detail.find("sequence=");
   if(first==std::string::npos||last==std::string::npos||e->TIME_MS()<=0)return false;
   uint64_t seq=0;if(seq_at!=std::string::npos){char* end=nullptr;seq=std::strtoull(detail.c_str()+seq_at+9,&end,10);if(end==detail.c_str()+seq_at+9||*end!=';')return false;}state_sequence=std::max(state_sequence,seq);
   auto old=attempts.find(id);
   if(old==attempts.end()||seq>old->second.sequence||(seq==old->second.sequence&&e->TIME_MS()>old->second.time)){
    NEVT single;single.NODE_ID=cfg.provider;single.EVENTS.emplace_back(e->UnPack());flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,&single));
    Bytes one(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());const auto size=old==attempts.end()?0:old->second.data.size();
    if(retained-(size?size+256:0)+one.size()+256>cfg.max_bytes){state_complete=false;continue;}
    retained=retained-(size?size+256:0)+one.size()+256;
    const auto batch_at=detail.find("product-batch="),batch_end=detail.find(';',batch_at);
    const auto batch=batch_at==std::string::npos||batch_end==std::string::npos?std::string():detail.substr(batch_at+14,batch_end-batch_at-14);
    attempts[id]={std::move(one),detail.substr(first+6,last-first-6),unsigned(std::min<uint64_t>(e->COUNT(),8)),e->TIME_MS(),detail.rfind("final ",0)==0,seq,batch};attempts.at(id).read_bytes=attempts.at(id).data.size()+256;
    const bool suspect=detail.find("instance-interrupted;")!=std::string::npos;
    if(id==interruption_suspect&&!suspect)interruption_suspect=0;
    if(suspect&&(!interruption_suspect||!attempts.count(interruption_suspect)||seq>=attempts.at(interruption_suspect).sequence))interruption_suspect=id;
    trim_state();
   }
  }
 } else if(scan.schema=="OMM") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedOMMBuffer(v))return false;const auto* o=GetSizePrefixedOMM(p);const auto epoch=instant(text(o->EPOCH()));const auto id=o->NORAD_CAT_ID();if(!id||epoch<0)return false;if(id%cfg.partitions!=cfg.partition)return true;
  auto found=seeds.find(id);if(found==seeds.end()||scan_at<found->second.rank||(scan_at==found->second.rank&&epoch>=found->second.epoch)){
   const auto old_size=found==seeds.end()?0:found->second.data.size();if(!room(old_size)){dropped.insert(id);complete_scan=false;capacity_limited=true;return true;}account(old_size);seeds[id]={std::move(data),epoch,scan_at};}
 } else if(scan.schema=="SPW") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedSPWBuffer(v))return false;const auto* w=GetSizePrefixedSPW(p);if(!w->DATE()||instant(text(w->DATE())+"T00:00:00Z")<0)return false;const auto old=weather.find(text(w->DATE()));const auto size=old==weather.end()?0:old->second.size();if(!room(size)){weather_complete=false;complete_scan=false;capacity_limited=true;return true;}account(size);weather[text(w->DATE())]=std::move(data);
 } else if(scan.schema=="CAT") {
  flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedCATBuffer(v))return false;const auto* c=GetSizePrefixedCAT(p);if(!c->NORAD_CAT_ID())return false;if(c->NORAD_CAT_ID()%cfg.partitions!=cfg.partition)return true;
  auto& target=scan.name=="catalog-index"&&scan.provider==cfg.provider?index:identities;
  const auto old=target.find(c->NORAD_CAT_ID());
  if(&target==&identities||old==target.end()||instant(text(c->PRODUCTS_AS_OF()))>=instant(text(GetSizePrefixedCAT(old->second.data())->PRODUCTS_AS_OF()))){const auto size=old==target.end()?0:old->second.size();if(!room(size)){dropped.insert(c->NORAD_CAT_ID());if(&target==&index)index_complete=false;complete_scan=false;capacity_limited=true;return true;}account(size);target[c->NORAD_CAT_ID()]=std::move(data);}
 } else if(scan.schema=="OCM") {flatbuffers::Verifier v(p,n);if(!VerifySizePrefixedOCMBuffer(v))return false;products.insert(cid(data));}
 else return false;
 return true;
}
int next_object();
bool decayed(const Bytes& identity){const auto date=text(GetSizePrefixedCAT(identity.data())->DECAY_DATE());return !date.empty()&&date<=iso(now).substr(0,10);}
int build_work(){
 size_t triples=0;for(const auto& e:identities)if(seeds.count(e.first)&&index.count(e.first)&&!dropped.count(e.first))++triples;
 diagnostics.add("resident-bytes="+std::to_string(retained)+" retained-triples="+std::to_string(triples));
 work.clear();for(const auto& entry:identities)work.push_back(entry.first);for(const auto& entry:index)if(!identities.count(entry.first))work.push_back(entry.first);
 size_t active=0,removed=0;for(const auto& entry:index){const auto* c=GetSizePrefixedCAT(entry.second.data());if(!c->PRODUCTS()||!c->PRODUCTS()->size())continue;++active;
  const auto identity=identities.find(entry.first);if(dropped.count(entry.first))continue;const bool known_decay=identity!=identities.end()&&decayed(identity->second);const bool absent=!capacity_limited&&complete_scan&&seed_complete&&identity_complete&&index_complete&&!index_defects&&(identity==identities.end()||!seeds.count(entry.first));if(known_decay||absent)++removed;}
 if(active&&double(removed)/active>cfg.max_removal_fraction){removal_guard=true;diagnostics.add("mass-removal guard: proposed="+std::to_string(removed)+" active="+std::to_string(active)+"; raise catalog.max_removal_fraction explicitly","bounds");}
 if(!index_complete){++diagnostics.deferred;diagnostics.add("index scan incomplete; unselected objects deferred and source retried on the following tick","bounds");}
 if(!complete_scan)++diagnostics.deferred;if(capacity_limited){diagnostics.add("scan partial: read="+std::to_string(seen)+" retained-bytes="+std::to_string(retained)+" catalog.max_records="+std::to_string(cfg.max_records)+" catalog.max_bytes="+std::to_string(cfg.max_bytes)+"; raise the binding setting or partition the catalog; removals disabled","bounds");}
 std::stable_sort(work.begin(),work.end(),[](uint32_t a,uint32_t b){
  auto age=[](uint32_t id){const auto p=index.find(id);return p==index.end()?int64_t(0):instant(text(GetSizePrefixedCAT(p->second.data())->PRODUCTS_AS_OF()));};
  return age(a)<age(b);});
 at=0;return next_object();
}
int page(const plugin_input_frame_t* f) {
 if(phase!=Phase::Scan||!f||f->payload_length<12)return stop("Unexpected or empty complete-read response.");
 const auto* p=f->payload;const auto n=flatbuffers::ReadScalar<uint32_t>(p)+size_t(4);
 if(n>f->payload_length)return stop("Truncated complete-read header.");flatbuffers::Verifier v(p,n);
 if(!VerifySizePrefixedQRPBuffer(v))return stop("Complete read failed; restart the sweep from its first page.");
 const auto* q=GetSizePrefixedQRP(p);const auto& scan=scans[scan_at];
 if(q->KIND()!=qrpKind::Page||q->STATUS()!=qrpStatus::Ok||text(q->SCHEMA_NAME())!=scan.schema+".fbs"||text(q->PROVIDER_ID())!=scan.provider||text(q->SOURCE_NAME())!=scan.name)return stop("Complete read failed or changed its source filter.");
 // A legacy history can hold three markers per entry. Read every page before
 // Current reconciliation so an unread newer failure cannot be erased.
 if(scan.schema=="NEV"&&seen>2*state_limit+1&&!state_history_oversized){state_history_oversized=true;diagnostics.add("Operational state history exceeds marker threshold; complete read followed by compaction.","bounds");}
 const size_t page_limit=scan.schema=="NEV"?3*state_limit+3:10000;
 if(++pages>page_limit){if(scan.schema=="SPW")weather_complete=false;if(scan.schema=="NEV")state_complete=false;if(scan.schema=="OMM")seed_complete=false;if(scan.schema=="CAT"){if(scan.name=="catalog-index"&&scan.provider==cfg.provider)index_complete=false;else identity_complete=false;}complete_scan=false;diagnostics.add("source="+scan.name+" exceeds "+std::to_string(page_limit)+" pages; increase catalog.page_size");cursor.clear();pages=0;++scan_at;return scan_at<scans.size()?query():complete_reads();}
 size_t off=n,count=0;while(off<f->payload_length){if(f->payload_length-off<4)return stop("Truncated page record.");const auto len=size_t(flatbuffers::ReadScalar<uint32_t>(p+off))+4;if(len>f->payload_length-off)return stop("Truncated page record.");
 if(!retain(p+off,len)){
  if(scan.schema=="SPW")weather_complete=false;
  ++diagnostics.invalid;const auto source=scan.schema+"/"+scan.provider+"/"+scan.name;const auto key="catalog-invalid/"+digest(Bytes(p+off,p+off+len))+"/"+digest(Bytes(source.begin(),source.end()));
  unsigned count=poisons.count(key)?poisons[key].count:0;
  if(count==0)diagnostics.add(source+" invalid record-sha256="+digest(Bytes(p+off,p+off+len)),"invalid");
  if(poison_seen.insert(key).second){count=std::min(count+1,3u);poisons[key]={count,source,++state_sequence};trim_state();
   NEVT log;log.NODE_ID=cfg.provider;log.GENERATED_AT_MS=now;auto e=std::make_unique<NEVEventT>();e->TIME_MS=now;e->KIND=nevEventKind::Warning;e->SUBJECT=key;e->COUNT=count;e->DETAIL=poison_detail(poisons.at(key));log.EVENTS.push_back(std::move(e));
   flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,&log));poison_updates.insert(poison_updates.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());}
  if(count<3){if(scan.schema=="OMM")seed_complete=false;if(scan.schema=="CAT"&&scan.provider==cfg.identity_provider&&scan.name==cfg.identity_source)identity_complete=false;}
  if(count<3&&scan.schema=="CAT"&&scan.provider==cfg.provider&&scan.name=="catalog-index")index_defects=true;
 }
 off+=len;++count;}
 if(count!=q->RECORD_COUNT())return stop("Complete-read count mismatch.");
 const auto next=text(q->NEXT_CURSOR());if(!next.empty()){if(next==cursor||!count)return stop("Complete read did not advance.");cursor=next;return query();}
 cursor.clear();pages=0;++scan_at;if(scan_at<scans.size())return query();
 return complete_reads();
}
int compose() {
 const auto id=work[at];const auto old=index.find(id);const auto identity=identities.find(id);
 if(retry_fallback&&old!=index.end()&&identity!=identities.end()){
  const auto* previous=GetSizePrefixedCAT(old->second.data());
  if(previous->PRODUCTS()&&previous->PRODUCTS()->size()==1){const auto* product=previous->PRODUCTS()->Get(0);const auto selected=text(product->SELECTION_REASON());
   if(text(product->RECORD_CID())==cid(chosen)&&selected.find("catalog-input="+signature+";")!=std::string::npos&&selected.find("catalog-identity="+digest(identity->second)+";")!=std::string::npos){++at;return next_object();}
  }
 }
 Bytes cat=old!=index.end()?old->second:identity->second;
 if(identity!=identities.end()){
  auto fresh=std::unique_ptr<CATT>(GetSizePrefixedCAT(identity->second.data())->UnPack());
  if(old!=index.end())fresh->PRODUCTS_AS_OF=text(GetSizePrefixedCAT(old->second.data())->PRODUCTS_AS_OF());
  flatbuffers::FlatBufferBuilder b;FinishSizePrefixedCATBuffer(b,CAT::Pack(b,fresh.get()));cat.assign(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
 }
 XMTT x;x.INTEGRATE_RECIPE=std::make_unique<XMTIntegrateRecipeT>();x.INTEGRATE_RECIPE->AS_OF_MS=now;
 QRPT q;q.KIND=qrpKind::Page;q.STATUS=qrpStatus::Ok;q.MESSAGE=reason+"; catalog-input="+signature+";"+(identity==identities.end()?std::string():" catalog-identity="+digest(identity->second)+";");
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedXMTBuffer(b,XMT::Pack(b,&x));
 if(push("recipe","XMT",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})||push("catalog","CAT",cat))return stop("Cannot queue catalog replacement.");
 b.Clear();FinishQRPBuffer(b,QRP::Pack(b,&q));if(push("selection","QRP",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()}))return stop("Cannot queue selection reason.");
 if(!chosen.empty()&&push("selected","OCM",chosen))return stop("Cannot queue selected product.");phase=Phase::Compose;return 0;
}
size_t frame_count(const Bytes& data){size_t count=0;for(size_t off=0;off<data.size();++count){if(data.size()-off<4)return 0;const size_t n=size_t(flatbuffers::ReadScalar<uint32_t>(data.data()+off))+4;if(n>data.size()-off||n<12)return 0;off+=n;}return count;}
int ingest(const Bytes& data,bool is_index) {
 pending=data;pending_schema=is_index?"CAT":"OCM";pending_batch="catalog-"+digest(data)+(is_index?":complete":"");
 // Only the terminal index batch declares this tick complete.
 pending_count=frame_count(data);if(!pending_count)return stop("Invalid generation stream.");
 R::IngestRequestT request;request.SCHEMA=pending_schema+".fbs";request.RECONCILE=R::reconcileMode_Duplicates;request.TAGS=std::make_unique<R::SourceTagsT>();
 request.TAGS->PROVIDER_ID=cfg.provider;request.TAGS->SOURCE_NAME=is_index?"catalog-index":"catalog-products";request.TAGS->BATCH_ID=pending_batch;request.TAGS->CONTENT_KEY_ID="public";
 flatbuffers::FlatBufferBuilder b;R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&request));
 if(plugin_push_output_ex("meta","IngestRequest.fbs","INGQ",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"IngestRequest",0,0,b.GetBufferPointer(),b.GetSize())<0||push(is_index?"index_records":"product_records",pending_schema.c_str(),data))return stop("Cannot queue storage input.");
 phase=is_index?Phase::IndexStored:Phase::ProductStored;return 0;
}
// Markers and preparation deltas append; one terminal snapshot compacts the run.
// Replay applies the same FIFO to earlier snapshots and their later appends.
int persist_events(Phase after) {
 if(!state_complete)return stop("Operational state incomplete; no replacement or dispatch is safe.");
 const bool compact=after==Phase::SuccessStored;
 const bool single=after==Phase::AttemptStored||after==Phase::FailureStored;
 NEVT log;log.NODE_ID=cfg.provider;log.GENERATED_AT_MS=now;
 auto add_attempt=[&](uint32_t id){const auto i=attempts.find(id);if(i!=attempts.end())log.EVENTS.emplace_back(GetSizePrefixedNEV(i->second.data.data())->EVENTS()->Get(0)->UnPack());};
 if(single)add_attempt(work[at]);
 else if(compact)for(const auto& item:attempts)add_attempt(item.first);
 else for(auto id:dirty_attempts)add_attempt(id);
 if(compact)for(const auto& item:poisons){auto e=std::make_unique<NEVEventT>();e->TIME_MS=now;e->KIND=nevEventKind::Warning;e->SUBJECT=item.first;e->COUNT=item.second.count;e->DETAIL=poison_detail(item.second);log.EVENTS.push_back(std::move(e));}
 else if(!single)for(size_t off=0;off<poison_updates.size();){const auto* row=GetSizePrefixedNEV(poison_updates.data()+off);for(const auto* e:*row->EVENTS())log.EVENTS.emplace_back(e->UnPack());off+=size_t(flatbuffers::ReadScalar<uint32_t>(poison_updates.data()+off))+4;}
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,&log));pending.assign(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
 if(pending.size()>8*1024*1024)return stop("Operational state exceeds 8 MiB; dispatch deferred.");
 pending_schema="NEV";pending_batch="catalog-attempt-"+digest(pending);
 R::IngestRequestT request;request.SCHEMA="NEV.fbs";request.RECONCILE=compact?R::reconcileMode_Current:R::reconcileMode_None;request.TAGS=std::make_unique<R::SourceTagsT>();request.TAGS->PROVIDER_ID=cfg.provider;request.TAGS->SOURCE_NAME=state_source();request.TAGS->BATCH_ID=pending_batch;request.TAGS->CONTENT_KEY_ID="public";
 b.Clear();R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&request));
 if(plugin_push_output_ex("meta","IngestRequest.fbs","INGQ",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"IngestRequest",0,0,b.GetBufferPointer(),b.GetSize())<0||push("state_records","NEV",pending))return stop("Cannot persist operational state.");
 if(single)dirty_attempts.erase(work[at]);else {dirty_attempts.clear();poison_updates.clear();}
 state_appends=compact?0:state_appends+1;state_evicted=false;phase=after;return 0;
}
int store_generation_part(){
 if(product_batch_at<product_batches.size())return ingest(product_batches[product_batch_at].data,false);
 return ingest(generation_index,true);
}
void mark_product_batch(uint32_t id,const std::string& batch){
 auto& a=attempts.at(id);a.product_batch=batch;dirty_attempts.insert(id);
 auto log=std::unique_ptr<NEVT>(GetSizePrefixedNEV(a.data.data())->UnPack());
 auto& detail=log->EVENTS[0]->DETAIL;const auto pos=detail.find(" product-batch=");if(pos!=std::string::npos)detail.erase(pos);
 if(!batch.empty())detail+=" product-batch="+batch+"; prepared-generation;";
 // Preparation is newer than the dispatch snapshot, even at the same UTC time.
 const auto seq=detail.find("sequence="),end=detail.find(';',seq);a.sequence=++state_sequence;
 detail.replace(seq+9,end-seq-9,std::to_string(a.sequence));
 flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,log.get()));a.data.assign(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
}
int flush_generation(){
 product_batches.clear();generation_index.clear();product_batch_at=0;
 for(const auto& item:staged){
  generation_index.insert(generation_index.end(),item.record.begin(),item.record.end());
  if(item.product.empty())continue;
  if(product_batches.empty()||product_batches.back().data.size()+item.product.size()>product_batch_bytes||product_batches.back().count==1000)product_batches.emplace_back();
  auto& batch=product_batches.back();batch.data.insert(batch.data.end(),item.product.begin(),item.product.end());++batch.count;batch.ids.push_back(item.id);
 }
 for(const auto& batch:product_batches){const auto name="catalog-"+digest(batch.data);for(auto id:batch.ids)mark_product_batch(id,name);}
 // A crash at any product/index boundary preserves the batch lookup references.
 return persist_events(Phase::GenerationPrepared);
}
int stage_selection(const Bytes& record){
 flatbuffers::Verifier v(record.data(),record.size());
 if(!VerifySizePrefixedCATBuffer(v)||GetSizePrefixedCAT(record.data())->NORAD_CAT_ID()!=work[at])return fail_object("Invalid composed selection.",true);
 const auto product=metadata_only?Bytes{}:chosen;
 if(record.size()>index_batch_bytes||product.size()>product_batch_bytes)return fail_object("Object exceeds generation record bound.",true);
 size_t index_bytes=record.size();for(const auto& item:staged)index_bytes+=item.record.size();
 if(index_bytes>index_batch_bytes||staged_bytes+record.size()+product.size()>generation_bytes){++diagnostics.deferred;diagnostics.add("generation byte bound reached","bounds");return finish();}
 staged.push_back({work[at],product,record,retry_fallback});staged_bytes+=record.size()+product.size();
 allowance=std::max(allowance,2*std::chrono::duration<double,std::milli>(Clock::now()-object_start).count());storage_failures=0;++at;return next_object();
}
int lookup_product(){
 QRPT q;q.KIND=qrpKind::Request;q.SCHEMA_NAME="OCM.fbs";q.PROVIDER_ID=cfg.provider;q.SOURCE_NAME="catalog-products";q.BATCH_ID=lookup_batch;q.CURSOR=lookup_cursor;q.LIMIT=1000;q.MAX_BYTES=8*1024*1024;
 flatbuffers::FlatBufferBuilder b;FinishQRPBuffer(b,QRP::Pack(b,&q));phase=Phase::Lookup;return push("query","QRP",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()});
}
int complete_reads(){
 if(!state_complete)return stop("Operational state incomplete; retry the bounded source read.");
 bool pruned=false;
 // The latest unprepared in-progress marker is the suspect, even if its work finished.
 uint64_t latest=0,suspect_sequence=0;for(const auto& item:attempts){latest=std::max(latest,item.second.sequence);if(item.second.sequence>=suspect_sequence&&attempt_detail(item.second).find("instance-interrupted;")!=std::string::npos){suspect_sequence=item.second.sequence;interruption_suspect=item.first;}}
 for(auto& item:attempts){auto& a=item.second;const auto detail=attempt_detail(a);
  a.recovery_pin=false; // A complete read makes prior preparation eligible for redispatch.
  if(detail.rfind("in progress ",0)==0){const bool suspect=a.sequence==latest&&detail.find("prepared-generation;")==std::string::npos;if(suspect)interruption_suspect=item.first;ready_or_suspect(a,suspect);dirty_attempts.insert(item.first);pruned=true;}
 }
 for(auto i=attempts.begin();i!=attempts.end();){const auto c=index.find(i->first);bool committed=false;
  if(c!=index.end()){const auto* row=GetSizePrefixedCAT(c->second.data());if(row->PRODUCTS())for(const auto* product:*row->PRODUCTS())if(text(product->SELECTION_REASON()).find("catalog-input="+i->second.signature+";")!=std::string::npos&&text(product->SELECTION_REASON()).find("retry-fit;")==std::string::npos)committed=true;}
  const bool orphan=complete_scan&&identity_complete&&index_complete&&!identities.count(i->first)&&!index.count(i->first)&&!protected_attempt(i->first,state_sequence);
  if(committed||orphan){retained-=i->second.read_bytes;i=attempts.erase(i);pruned=true;}else ++i;
 }
 if(poison_updates.empty()&&!pruned&&!state_evicted&&state_rows<=1)return build_work();return persist_events(Phase::PoisonStored);
}
int save_attempt(bool final,const std::string& failure) {
 const auto id=work[at];const auto old=attempts.find(id);const bool starting=failure.empty();
 if(starting&&!staged.empty()&&old!=attempts.end()&&attempt_detail(old->second).find("instance-interrupted;")!=std::string::npos){++diagnostics.deferred;diagnostics.add("staged selections committed before interrupted object retry");return finish();}
 const unsigned count=old!=attempts.end()&&old->second.signature==signature?std::min(old->second.count+(starting?1:0),8u):1;
 NEVT log;log.NODE_ID=cfg.provider;log.GENERATED_AT_MS=now;
 auto e=std::make_unique<NEVEventT>();e->TIME_MS=now;e->KIND=starting?nevEventKind::Other:nevEventKind::Failure;
 e->SUBJECT="catalog-object/"+std::to_string(id);e->COUNT=count;e->DETAIL=(final?"final ":starting?"in progress ":"retry ")+std::string("input=")+signature+"; sequence="+std::to_string(++state_sequence)+"; "+failure;
 log.EVENTS.push_back(std::move(e));flatbuffers::FlatBufferBuilder b;FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,&log));
 const auto batch=old==attempts.end()?std::string():old->second.product_batch;
 if(!batch.empty())log.EVENTS[0]->DETAIL+=" product-batch="+batch+";";
 b.Clear();FinishSizePrefixedNEVBuffer(b,NEV::Pack(b,&log));
 const size_t read_bytes=old==attempts.end()?0:old->second.read_bytes;
 attempts[id]={{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()},signature,count,now,final,state_sequence,batch,read_bytes};trim_state();
 return persist_events(starting?Phase::AttemptStored:Phase::FailureStored);
}
// Match the numerical fields and ingestion guards read by ingest_omm.
std::string fit_seed_signature(const OMM* o){
 OMMT n;n.NORAD_CAT_ID=o->NORAD_CAT_ID();n.EPOCH=text(o->EPOCH());n.CENTER_NAME=text(o->CENTER_NAME());n.MEAN_ELEMENT_THEORY=o->MEAN_ELEMENT_THEORY();
 n.MEAN_MOTION=o->MEAN_MOTION();n.ECCENTRICITY=o->ECCENTRICITY();n.INCLINATION=o->INCLINATION();n.RA_OF_ASC_NODE=o->RA_OF_ASC_NODE();n.ARG_OF_PERICENTER=o->ARG_OF_PERICENTER();n.MEAN_ANOMALY=o->MEAN_ANOMALY();n.BSTAR=o->BSTAR();n.MEAN_MOTION_DOT=o->MEAN_MOTION_DOT();n.MEAN_MOTION_DDOT=o->MEAN_MOTION_DDOT();n.BTERM=o->BTERM();n.AGOM=o->AGOM();
 const auto* t=reinterpret_cast<const flatbuffers::Table*>(o);
 const std::string guards=std::to_string(t->CheckField(OMM::VT_BTERM))+"/"+std::to_string(t->CheckField(OMM::VT_AGOM))+"/"+std::to_string(o->USER_DEFINED_PARAMETERS()?o->USER_DEFINED_PARAMETERS()->size():0);
 flatbuffers::FlatBufferBuilder b;FinishOMMBuffer(b,OMM::Pack(b,&n));return digest({b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})+"/"+guards;
}
std::string weather_signature(){
 Bytes relevant;
 for(size_t at=0;at<object_weather.size();){const auto* w=GetSizePrefixedSPW(object_weather.data()+at);SPWT n;n.DATE=text(w->DATE());n.F107_OBS=w->F107_OBS();n.F107_OBS_CENTER81=w->F107_OBS_CENTER81();n.AP_AVG=w->AP_AVG();n.F107_DATA_TYPE=w->F107_DATA_TYPE();
  flatbuffers::FlatBufferBuilder b;FinishSizePrefixedSPWBuffer(b,SPW::Pack(b,&n));relevant.insert(relevant.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());at+=size_t(flatbuffers::ReadScalar<uint32_t>(object_weather.data()+at))+4;}
 return digest(relevant);
}
bool attempt_deferred(){const auto id=work[at];
  const auto attempt=attempts.find(id);
  if(attempt!=attempts.end()&&attempt->second.signature==signature){const auto& a=attempt->second;const auto after=a.time+std::min<int64_t>(86400000,1200000LL*(1LL<<(std::max(1u,a.count)-1)));
   if(a.final||(attempt_detail(a).rfind("ready ",0)!=0&&now<after)){++diagnostics.deferred;diagnostics.add(a.final?"unchanged final failure":"in-progress attempt deferred after instance interruption");return true;}}
 return false;
}
int next_object() {
 for(;at<work.size()&&staged.size()<cfg.batch;++at){
  if(!budget_left()){++diagnostics.deferred;diagnostics.add("object elapsed budget reserve exhausted","bounds");return finish();}object_start=Clock::now();
  const auto id=work[at];if(id%cfg.partitions!=cfg.partition)continue;compose_only=false;metadata_only=false;retry_fallback=false;chosen_stored=false;recovery_batch=attempts.count(id)?attempts.at(id).product_batch:std::string();chosen.clear();signature.clear();reason.clear();object_weather.clear();const auto s=seeds.find(id);const auto identity=identities.find(id);const auto old=index.find(id);
  if(dropped.count(id)||(!index_complete&&old==index.end())||(capacity_limited&&(old==index.end()||s==seeds.end()||identity==identities.end()))){++diagnostics.deferred;continue;}
  const bool removed=identity==identities.end()||s==seeds.end()||decayed(identity->second);
  const auto* previous=old==index.end()?nullptr:GetSizePrefixedCAT(old->second.data());
  if(previous&&instant(text(previous->PRODUCTS_AS_OF()))>now){++diagnostics.deferred;if(!clock_reported){diagnostics.add("clock precedes a stored selection; affected objects deferred before dispatch","clock");clock_reported=true;}continue;}
  if(removed){const bool decay=identity!=identities.end()&&decayed(identity->second);if(removal_guard||(!decay&&(!complete_scan||!seed_complete||!identity_complete))||(!decay&&(!index_complete||index_defects)))continue;if(!previous||!previous->PRODUCTS()||!previous->PRODUCTS()->size())continue;reason="object removed from the configured current sources";signature=digest(old->second)+"/removed/"+(identity==identities.end()?"absent":digest(identity->second));if(attempt_deferred())continue;compose_only=true;++diagnostics.removed;diagnostics.add("object="+std::to_string(id)+" removal: "+reason,"removal");return save_attempt();}
  const auto* omm=GetSizePrefixedOMM(s->second.data.data());
  const double n=omm->MEAN_MOTION()*6.2831853071795864769/1440;
  const bool resonant=n>.0035003818&&n<=.015751718;
  const bool eligible=std::isfinite(omm->ECCENTRICITY())&&omm->ECCENTRICITY()>=0&&omm->ECCENTRICITY()<=(resonant?cfg.res_e:cfg.nonres_e);
  const bool expired=s->second.epoch+5LL*86400000<now+cfg.margin*1000;
  const bool future=s->second.epoch>now;
  run_fit=!expired&&!future&&eligible;
  if(run_fit&&!weather_complete){++diagnostics.deferred;diagnostics.add("fit deferred: weather scan incomplete","weather");continue;}
  const auto low=iso(s->second.epoch-216000000-86400000).substr(0,10),high=iso(s->second.epoch-216000000+30LL*86400000).substr(0,10);
  if(run_fit)for(auto i=weather.lower_bound(low);i!=weather.end()&&i->first<=high;++i)object_weather.insert(object_weather.end(),i->second.begin(),i->second.end());
  const std::string policy=cfg.recipe+"/"+std::to_string(cfg.nonres_e)+"/"+std::to_string(cfg.res_e)+"/"+std::to_string(cfg.max_rms)+"/"+std::to_string(cfg.max_error);
  signature=fit_seed_signature(omm)+"/"+(run_fit?weather_signature():std::string("no-weather"))+"/"+ephem::sha256_hex(reinterpret_cast<const uint8_t*>(policy.data()),policy.size());
  signature+="/"+std::string(expired?"old":future?"future":eligible?"fit":"excluded");
  if(previous&&previous->PRODUCTS()&&previous->PRODUCTS()->size()==1){const auto* p=previous->PRODUCTS()->Get(0);const auto selection=text(p->SELECTION_REASON());
   if(!text(p->RECORD_CID()).empty()&&selection.find("catalog-input="+signature+";")!=std::string::npos&&selection.find("retry-fit;")==std::string::npos&&(!expired||p->KIND()!=catalogProductKind::ApElements)){
    if(selection.find("catalog-identity="+digest(identity->second)+";")!=std::string::npos)continue;
    if(attempt_deferred())continue;metadata_only=true;return save_attempt();
   }
  }
  reason=expired?"old-span fallback":future?"future-seed fallback":!eligible?"outside configured AP class":"accepted exact-W fit";run_fit=!expired&&!future&&eligible;
  if(attempt_deferred())continue;
  return save_attempt();
 }
 return finish();
}
int start_chain() {
 if(metadata_only){const auto id=work[at];auto fresh=std::unique_ptr<CATT>(GetSizePrefixedCAT(identities.at(id).data())->UnPack());auto old=std::unique_ptr<CATT>(GetSizePrefixedCAT(index.at(id).data())->UnPack());
  fresh->PRODUCTS=std::move(old->PRODUCTS);fresh->PRODUCTS_AS_OF=iso(now);
  for(auto& product:fresh->PRODUCTS){auto& r=product->SELECTION_REASON;const auto pos=r.find(" catalog-identity=");if(pos!=std::string::npos)r.erase(pos);r+=" catalog-identity="+digest(identities.at(id))+";";}
  flatbuffers::FlatBufferBuilder b;FinishSizePrefixedCATBuffer(b,CAT::Pack(b,fresh.get()));return stage_selection({b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()});
 }
 if(compose_only)return compose();
 const auto& seed=seeds.at(work[at]);const auto s=seeds.find(work[at]);const auto* omm=GetSizePrefixedOMM(seed.data.data());
  if(!run_fit){phase=Phase::Chain;return push("fallback_seed","OMM",{s->second.data.begin()+4,s->second.data.end()});}
  PCFT flight;flight.THEORY=pcfTheory::SGP4;flight.OUTPUT=std::make_unique<PCFOutputT>();flight.OUTPUT->FRAME=pcfOutputFrame::GCRF;flight.OUTPUT->START_TIME=iso(s->second.epoch-216000000);flight.OUTPUT->STOP_TIME=iso(s->second.epoch+432000000);flight.OUTPUT->STEP_SECONDS=300;
  flatbuffers::FlatBufferBuilder b;FinishPCFBuffer(b,PCF::Pack(b,&flight));if(push("flight_config","PCF",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()}))return stop("Cannot queue flight policy.");
  PCFT fit;fit.THEORY=pcfTheory::AP;fit.FORCES=std::make_unique<PCFForceModelT>();fit.FORCES->ATMOSPHERE_MODEL=pcfAtmosphereFamily::NRLMSISE00;fit.FORCES->WEATHER_SOURCE=pcfWeatherSource::RECORDS;fit.FORCES->HAS_MAXIMUM_DEGREE=true;fit.FORCES->MAXIMUM_DEGREE=20;
  if(omm->ECCENTRICITY()<=.048){fit.FORCES->HAS_MAXIMUM_TESSERAL_DEGREE=true;fit.FORCES->MAXIMUM_TESSERAL_DEGREE=31;}fit.FIT=std::make_unique<PCFFitPolicyT>();fit.FIT->WEATHER_HORIZON_DAYS=30;
  b.Clear();b.ForceDefaults(true);FinishPCFBuffer(b,PCF::Pack(b,&fit));if(push("fit_config","PCF",{b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()})||(!object_weather.empty()&&push("weather","SPW",object_weather))||push("seed","OMM",{s->second.data.begin()+4,s->second.data.end()}))return stop("Cannot queue exact-W inputs.");phase=Phase::Chain;return 0;
}
// Only resource and delivery failures can change without a changed input.
// Unknown codes fail closed as deterministic; recipe revision permits retry.
bool transient_refusal(const std::string& code) {
 return code=="out-of-memory"||code=="pool-dead"||code=="output-failed"||code=="output"||code=="host-failed";
}
int chain() {
 const auto* fallback=input("fallback"),*candidate=input("candidate"),*decision=input("chain_status");if(phase!=Phase::Chain||!decision)return stop("Unexpected chain outcome.");
 flatbuffers::Verifier qv(decision->payload,decision->payload_length);if(!VerifyQRPBuffer(qv))return fail_object("Invalid chain outcome.",true);const auto* q=GetQRP(decision->payload);if(!fallback)return fail_object("chain: "+text(q->ERROR_CODE())+" "+text(q->MESSAGE()),!transient_refusal(text(q->ERROR_CODE())));
 const auto& seed=seeds.at(work[at]);const plugin_input_frame_t* use=fallback;
 if(run_fit&&candidate&&q->STATUS()==qrpStatus::Ok){flatbuffers::Verifier v(candidate->payload,candidate->payload_length);if(!VerifyOCMBuffer(v))return fail_object("Invalid fit record.",true);const auto* o=GetOCM(candidate->payload);const auto* stats=o->ORBIT_DETERMINATION()?o->ORBIT_DETERMINATION()->FIT_STATISTICS():nullptr;
  if(stats&&stats->FIT_STATES()==2161&&std::isfinite(stats->FIT_RMS_KM())&&stats->FIT_RMS_KM()<=cfg.max_rms&&std::isfinite(stats->FIT_MAX_KM())&&stats->FIT_MAX_KM()<=cfg.max_error&&catalog_epoch::matches(text(GetSizePrefixedOMM(seed.data.data())->EPOCH()),text(stats->FIT_START()),-216000)&&catalog_epoch::matches(text(GetSizePrefixedOMM(seed.data.data())->EPOCH()),text(stats->FIT_STOP()),432000))use=candidate;else reason="fit-statistics refusal fallback";
 }else if(run_fit){const auto code=text(q->ERROR_CODE());reason="fit refusal fallback: "+code;
  if(transient_refusal(code)){retry_fallback=true;reason+="; retry-fit;";}
 }
 flatbuffers::Verifier ov(use->payload,use->payload_length);if(!VerifyOCMBuffer(ov))return fail_object("Invalid selected orbit.",true);
 Bytes framed;
 if(use==candidate){
  // Keep the fit's entire original buffer at an eight-byte-aligned offset.
  framed.resize(use->payload_length+16);std::memcpy(framed.data()+16,use->payload,use->payload_length);
  flatbuffers::WriteScalar<uint32_t>(framed.data(),framed.size()-4);
  flatbuffers::WriteScalar<uint32_t>(framed.data()+4,flatbuffers::ReadScalar<uint32_t>(use->payload)+12);
  std::memcpy(framed.data()+8,"$OCM",4);
 }else{
  auto record=std::unique_ptr<OCMT>(GetOCM(use->payload)->UnPack());if(!record->HEADER)record->HEADER=std::make_unique<HeaderT>();record->HEADER->COMMENT.push_back(reason);
  flatbuffers::FlatBufferBuilder b;FinishSizePrefixedOCMBuffer(b,OCM::Pack(b,record.get()));framed.assign(b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
 }
 if(retry_fallback){fallback_annotation=std::move(framed);return save_attempt(false,"transient fit refusal");}
 if(push("annotate_orbit","OCM",framed)||push("annotate_seed","OMM",seed.data))return fail_object("Cannot queue population annotation.");phase=Phase::Annotate;return 0;
}
int storage_failure(const std::string& message){if(++storage_failures>=3)return stop("Storage circuit breaker after three consecutive object failures.");return fail_object(message);}
int advance() {
 if(input("tick")){
  if(!configure())return stop("Invalid catalog ModuleConfig.");const auto* f=input("tick");flatbuffers::Verifier v(f->payload,f->payload_length);if(!R::VerifyTimerTickBuffer(v))return stop("Invalid timer tick.");now=R::GetTimerTick(f->payload)->FIRED_MS();if(now<=0)return stop("Timer requires a positive UTC time.");
  staged.clear();product_batches.clear();generation_index.clear();staged_bytes=product_batch_at=pending_count=0;checked_batches.clear();lookup_cursor.clear();fallback_annotation.clear();diagnostics=Diagnostics{};state_complete=true;scan_exhausted=false;state_rows=state_appends=0;state_history_oversized=false;state_sequence=0;state_evicted=false;interruption_suspect=0;storage_failures=0;clock_reported=false;tick_start=Clock::now();allowance=cfg.allowance_ms;complete_scan=true;capacity_limited=false;seed_complete=identity_complete=index_complete=weather_complete=true;removal_guard=false;index_defects=false;poisons.clear();poison_seen.clear();poison_updates.clear();dropped.clear();seeds.clear();identities.clear();index.clear();weather.clear();products.clear();attempts.clear();dirty_attempts.clear();scans={{"NEV",cfg.provider,state_source()},{"CAT",cfg.provider,"catalog-index"}};scans.insert(scans.end(),cfg.seeds.begin(),cfg.seeds.end());scans.push_back({"CAT",cfg.identity_provider,cfg.identity_source});scans.push_back({"SPW",cfg.weather_provider,cfg.weather_source});scan_at=pages=seen=retained=done=at=0;cursor.clear();return query();
 }
 if(const auto* f=input("query_status")){flatbuffers::Verifier v(f->payload,f->payload_length);if(!VerifyQRPBuffer(v)||GetQRP(f->payload)->KIND()==qrpKind::Error){if(phase==Phase::Lookup)return storage_failure("Product lookup host failure.");return stop("Complete read failed; no partial sweep is committed.");}}
 if(const auto* f=input("page")){
  if(phase!=Phase::Lookup)return page(f);
  if(f->payload_length<12)return fail_object("Truncated product lookup.");const auto n=size_t(flatbuffers::ReadScalar<uint32_t>(f->payload))+4;
  if(n>f->payload_length)return fail_object("Truncated product lookup header.");flatbuffers::Verifier v(f->payload,n);
  if(!VerifySizePrefixedQRPBuffer(v))return fail_object("Invalid product lookup.");const auto* q=GetSizePrefixedQRP(f->payload);
  if(q->STATUS()!=qrpStatus::Ok||q->KIND()!=qrpKind::Page||text(q->BATCH_ID())!=lookup_batch||text(q->PROVIDER_ID())!=cfg.provider||text(q->SOURCE_NAME())!="catalog-products"||text(q->SCHEMA_NAME())!="OCM.fbs")return fail_object("Product lookup did not acknowledge its batch.");
  size_t off=n,count=0;while(off<f->payload_length){if(f->payload_length-off<4)return fail_object("Truncated product lookup record.");const auto len=size_t(flatbuffers::ReadScalar<uint32_t>(f->payload+off))+4;if(len>f->payload_length-off)return fail_object("Truncated product lookup record.");flatbuffers::Verifier ov(f->payload+off,len);if(!VerifySizePrefixedOCMBuffer(ov))return fail_object("Invalid product lookup record.");products.insert(cid(Bytes(f->payload+off,f->payload+off+len)));off+=len;++count;}
  if(count!=q->RECORD_COUNT())return fail_object("Product lookup count mismatch.");
  const auto next=text(q->NEXT_CURSOR());if(!next.empty()){if(!count||next==lookup_cursor)return fail_object("Product lookup did not advance.");lookup_cursor=next;return lookup_product();}
  checked_batches.insert(lookup_batch);chosen_stored=products.count(cid(chosen));return compose();
 }
 if(input("query_status"))return 0;
 if(input("chain_status"))return chain();
 if(const auto* f=input("annotation_status")){
  if(phase!=Phase::Annotate)return stop("Unexpected annotation outcome.");flatbuffers::Verifier v(f->payload,f->payload_length);if(!VerifyQRPBuffer(v))return fail_object("Invalid annotation outcome.",true);const auto* q=GetQRP(f->payload);return fail_object("annotation: "+text(q->ERROR_CODE())+" "+text(q->MESSAGE()),!transient_refusal(text(q->ERROR_CODE())));
 }
 if(const auto* f=input("annotated")){
  if(phase!=Phase::Annotate)return stop("Unexpected annotation.");flatbuffers::Verifier v(f->payload,f->payload_length);if(!VerifySizePrefixedOCMBuffer(v))return fail_object("Invalid annotation.",true);chosen=bytes(f);const auto* o=GetSizePrefixedOCM(chosen.data());if(o->COV_REALISM())for(const auto* l:*o->COV_REALISM())if(text(l->EVIDENCE()).rfind("no population covariance",0)==0)reason+="; "+text(l->EVIDENCE());chosen_stored=products.count(cid(chosen));if(chosen_stored)return compose();
  lookup_batch=recovery_batch.empty()?"catalog-"+digest(chosen):recovery_batch;lookup_cursor.clear();
  if(checked_batches.count(lookup_batch))return compose();return lookup_product();
 }
 if(const auto* f=input("compose_status")){
  if(phase!=Phase::Compose)return stop("Unexpected composition outcome.");flatbuffers::Verifier v(f->payload,f->payload_length);
  if(!VerifyQRPBuffer(v))return fail_object("Invalid composition outcome.",true);const auto* q=GetQRP(f->payload);
  if(q->STATUS()!=qrpStatus::Ok)return fail_object("compose: "+text(q->ERROR_CODE())+" "+text(q->MESSAGE()),!transient_refusal(text(q->ERROR_CODE())));
 }
 if(const auto* f=input("replacement")){if(phase!=Phase::Compose)return stop("Unexpected index replacement.");return stage_selection(bytes(f));}
 if(const auto* f=input("stored")){
  flatbuffers::Verifier v(f->payload,f->payload_length);if(!R::VerifyIngestResultBuffer(v))return stop("Invalid storage acknowledgment.");const auto* r=R::GetIngestResult(f->payload);
  if(phase==Phase::AttemptStored||phase==Phase::FailureStored||phase==Phase::PoisonStored||phase==Phase::SuccessStored||phase==Phase::GenerationPrepared){
   if(!text(r->REFUSED()).empty()||text(r->SCHEMA())!="NEV.fbs"||text(r->PROVIDER_ID())!=cfg.provider||text(r->SOURCE_NAME())!=state_source()||text(r->BATCH_ID())!=pending_batch||(phase!=Phase::PoisonStored&&r->INSERTED()>1))return stop("Attempt storage refused; object processing stopped.");
   if(phase==Phase::PoisonStored)return build_work();
   if(phase==Phase::SuccessStored)return finished();
   if(phase==Phase::GenerationPrepared)return store_generation_part();
   if(phase==Phase::AttemptStored)return start_chain();
   if(retry_fallback&&!fallback_annotation.empty()){auto framed=std::move(fallback_annotation);fallback_annotation.clear();if(push("annotate_orbit","OCM",framed)||push("annotate_seed","OMM",seeds.at(work[at]).data))return stop("Cannot queue retry fallback annotation.");phase=Phase::Annotate;return 0;}++at;return next_object();
  }
  if((phase!=Phase::ProductStored&&phase!=Phase::IndexStored)||!text(r->REFUSED()).empty()||text(r->SCHEMA())!=pending_schema+".fbs"||text(r->PROVIDER_ID())!=cfg.provider||text(r->BATCH_ID())!=pending_batch||text(r->SOURCE_NAME())!=(phase==Phase::ProductStored?"catalog-products":"catalog-index")||r->INSERTED()>pending_count)return stop("Storage refused or did not acknowledge the complete generation batch; prior selection preserved.");
  if(phase==Phase::ProductStored){++product_batch_at;return store_generation_part();}
  done=staged.size();for(const auto& item:staged){if(!item.retry)attempts.erase(item.id);else mark_product_batch(item.id,"");}return persist_events(Phase::SuccessStored);
 }
 return stop("Incomplete controller response.");
}
}
extern "C" int advance(){return catalog_control::advance();}
