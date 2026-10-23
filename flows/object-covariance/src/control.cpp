// Orchestration only. All orbit, frame and covariance math stays in gp-error-model.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "space_data_module_invoke.h"
#include "TimerTick_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
namespace {
namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;
constexpr size_t page_size = 128, max_history_bytes = 32 * 1024 * 1024;
constexpr const char* source = "celestrak-gp-object-covariance";
enum class Stage { Idle, Covariances, Candidates, History, Calculation, Ingest };
Stage stage = Stage::Idle;
uint64_t request_id = 0, covariance_offset = 0;
uint32_t after_object = 0;
size_t current = 0;
struct Object { uint32_t id; std::string epoch; };
std::vector<Object> objects;
std::map<uint32_t, std::string> newest_covariance;
std::string pending_epoch;
const char* str(const flatbuffers::String* s) { return s ? s->c_str() : ""; }
int fail(const std::string& message) {
 stage = Stage::Idle; objects.clear();
 plugin_set_error("covariance-reactor", message.c_str()); return 500;
}
const plugin_input_frame_t* input(const char* port) {
 const auto i = plugin_find_input_index(port, 0);
 return i < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(i));
}
int push(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* data, size_t size) {
 return plugin_push_output_ex(port,schema,identifier,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,data,size) < 0 ? fail("output queue refused frame") : 0;
}
// CelesTrak supplies UTC ISO epochs. Normalize fractional padding for ordering;
// do not confuse spelling differences (.0Z vs .000000) with a new epoch.
std::string epoch_key(const std::string& text) {
 if (text.size() < 19 || text[4]!='-' || text[7]!='-' || text[10]!='T' || text[13]!=':' || text[16]!=':') return {};
 std::string fraction; size_t at = 19;
 if (at < text.size() && text[at]=='.') {
  for (++at; at < text.size() && text[at]>='0' && text[at]<='9'; ++at) fraction += text[at];
 }
 if (at < text.size() && text[at]=='Z') ++at;
 if (at != text.size() || fraction.size() > 9) return {};
 fraction.resize(9,'0'); return text.substr(0,19)+'.'+fraction;
}
uint32_t object_id(const char* s) {
 uint64_t value=0; if (!s || !*s) return 0;
 for (; *s; ++s) { if (*s<'0'||*s>'9') return 0; value=value*10+(*s-'0'); if (value>UINT32_MAX) return 0; }
 return static_cast<uint32_t>(value);
}
int query(std::string sql, Stage next) {
 stage=next; ++request_id;
 FSOT control; control.OPERATION=flatSqlNodeOperation::QUERY_RECORDS; control.REQUEST_ID=request_id;
 control.QUERY.assign(sql.begin(),sql.end()); flatbuffers::FlatBufferBuilder b;
 FinishFSOBuffer(b,FSO::Pack(b,&control));
 return push("query","FSO.fbs","$FSO","FSO",b.GetBufferPointer(),b.GetSize());
}
int covariance_page() {
 return query("SELECT _data FROM OCM WHERE _source = '"+std::string(source)+"' ORDER BY _rowid LIMIT 128 OFFSET "+std::to_string(covariance_offset),Stage::Covariances);
}
int candidate_page() {
 return query("SELECT _data FROM (SELECT _data, NORAD_CAT_ID, ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY USER_DEFINED_EPOCH_TIMESTAMP DESC, _rowid DESC) AS rank FROM OMM WHERE _source = 'celestrak-gp' AND NORAD_CAT_ID > "+std::to_string(after_object)+") WHERE rank = 1 ORDER BY NORAD_CAT_ID LIMIT 128",Stage::Candidates);
}
int next_object() {
 while (current < objects.size()) {
  const auto& o=objects[current]; const auto key=epoch_key(o.epoch);
  if (key.empty()) return fail("OMM has a non-UTC or malformed epoch");
  auto found=newest_covariance.find(o.id);
  if (found!=newest_covariance.end() && found->second>=key) { ++current; continue; }
  // Read the complete object's history; the numerical module owns its causal
  // window and refuses sets after the selected epoch. Never cap it silently.
  return query("SELECT _data FROM OMM WHERE _source = 'celestrak-gp' AND NORAD_CAT_ID = "+std::to_string(o.id)+" ORDER BY USER_DEFINED_EPOCH_TIMESTAMP, _rowid",Stage::History);
 }
 if (objects.empty()) { stage=Stage::Idle; return 0; }
 after_object=objects.back().id; objects.clear(); current=0; return candidate_page();
}
bool unpack_chunks(Bytes& out, std::string& error) {
 std::vector<const FSB*> chunks;
 for (uint32_t i=0;i<plugin_get_input_count();++i) {
  const auto* f=plugin_get_input_frame(i); if (!f||!f->port_id||std::strcmp(f->port_id,"rows")) continue;
  flatbuffers::Verifier v(f->payload,f->payload_length);
  if (!VerifyFSBBuffer(v)) { error="invalid FSB chunk"; return false; }
  chunks.push_back(GetFSB(f->payload));
 }
 std::sort(chunks.begin(),chunks.end(),[](auto a,auto b){return a->CHUNK_SEQUENCE()<b->CHUNK_SEQUENCE();});
 if (chunks.empty()) { error="query completed without record chunks"; return false; }
 for (size_t i=0;i<chunks.size();++i) {
  const auto* c=chunks[i];
  if (c->REQUEST_ID()!=request_id || c->CHUNK_SEQUENCE()!=i || c->FINAL()!=(i+1==chunks.size())) { error="incomplete or mismatched query response"; return false; }
  if (c->TOTAL_BYTES()>max_history_bytes) { error="history exceeds 32 MiB; refusing truncation"; return false; }
  if (const auto* d=c->DATA()) out.insert(out.end(),d->begin(),d->end());
 }
 if (out.size()!=chunks.back()->TOTAL_BYTES()) { error="query byte count mismatch"; return false; }
 return true;
}
template<typename Fn> bool records(const Bytes& bytes, Fn each, size_t& count) {
 size_t at=0; count=0;
 while (at+4<=bytes.size()) {
  const uint32_t n=flatbuffers::ReadScalar<uint32_t>(bytes.data()+at);
  if (!n) { at+=4; continue; }
  if (n>bytes.size()-at-4) return false;
  if (!each(bytes.data()+at,static_cast<size_t>(n)+4)) return false;
  ++count; at+=n+4;
 }
 return at==bytes.size();
}
int handle_query() {
 const auto* frame=input("status"); if (!frame) return fail("query has no completion status");
 flatbuffers::Verifier v(frame->payload,frame->payload_length);
 if (!VerifyFSOBuffer(v)) return fail("invalid query status");
 const auto* status=GetFSO(frame->payload);
 if (status->REQUEST_ID()!=request_id) return fail("stale query status");
 if (status->STATUS()!=flatSqlNodeStatus::COMPLETE) {
  const auto* m=status->MESSAGE(); std::string message=m?std::string(m->begin(),m->end()):"query failed";
  // A new store need not have an OCM relation before its first OCM arrives.
  if (stage==Stage::Covariances && covariance_offset==0 && message.find("no such table: OCM")!=std::string::npos) return candidate_page();
  return fail(message);
 }
 Bytes bytes; std::string error; if (!unpack_chunks(bytes,error)) return fail(error);
 size_t count=0;
 if (stage==Stage::Covariances) {
  if (!records(bytes,[&](const uint8_t* p,size_t n){
   flatbuffers::Verifier check(p,n); if (!VerifySizePrefixedOCMBuffer(check)) return false;
   const auto* o=GetSizePrefixedOCM(p); const auto* m=o->METADATA();
   if (!m || !o->COVARIANCE_DATA() || !o->COV_REALISM() || !o->PROVENANCE()) return false;
   auto id=object_id(str(m->OBJECT_DESIGNATOR())); auto epoch=epoch_key(str(m->START_TIME()));
   if (!id||epoch.empty()) return false;
   auto& newest=newest_covariance[id]; if (epoch>newest) newest=epoch; return true;
  },count)) return fail("invalid OCM cursor stream");
  covariance_offset+=count; return count==page_size?covariance_page():candidate_page();
 }
 if (stage==Stage::Candidates) {
  objects.clear(); current=0;
  if (!records(bytes,[&](const uint8_t* p,size_t n){
   flatbuffers::Verifier check(p,n); if (!VerifySizePrefixedOMMBuffer(check)) return false;
   const auto* o=GetSizePrefixedOMM(p); if (!o->NORAD_CAT_ID()) return false;
   objects.push_back({o->NORAD_CAT_ID(),str(o->EPOCH())}); return true;
  },count)) return fail("invalid OMM candidate stream");
  return next_object();
 }
 if (stage!=Stage::History || current>=objects.size()) return fail("unexpected query response");
 const auto& object=objects[current];
 // Reject mixed histories and filter future epochs in WASM before invoking
 // the pure method. Canonical bytes pass through; no host schema conversion.
 Bytes causal;
 if (!records(bytes,[&](const uint8_t* p,size_t n){
  flatbuffers::Verifier check(p,n); if (!VerifySizePrefixedOMMBuffer(check)) return false;
  const auto* o=GetSizePrefixedOMM(p); auto epoch=epoch_key(str(o->EPOCH()));
  if (o->NORAD_CAT_ID()!=object.id || epoch.empty()) return false;
  if (epoch<=epoch_key(object.epoch)) causal.insert(causal.end(),p,p+n); return true;
 },count) || causal.empty()) return fail("invalid or empty causal history");
 ERMT request; request.CALIBRATED_COVARIANCES=std::make_unique<ERMCalibratedCovariancesT>();
 auto o=std::make_unique<ERMCalibrationObjectT>(); o->ID="NORAD:"+std::to_string(object.id);
 o->SET_NORAD_CAT_ID=object.id; o->SET_EPOCH=object.epoch; o->AGE_DAYS=0;
 request.CALIBRATED_COVARIANCES->OBJECTS.push_back(std::move(o));
 flatbuffers::FlatBufferBuilder b; FinishSizePrefixedERMBuffer(b,ERM::Pack(b,&request));
 stage=Stage::Calculation;
 int rc=push("elements","OMM.fbs","$OMM","OMM",causal.data(),causal.size());
 return rc?rc:push("request","ERM.fbs","$ERM","ERM",b.GetBufferPointer(),b.GetSize());
}
int handle_ocm(const plugin_input_frame_t* f) {
 if (stage!=Stage::Calculation||current>=objects.size()) return fail("unexpected covariance product");
 flatbuffers::Verifier check(f->payload,f->payload_length);
 if (!VerifySizePrefixedOCMBuffer(check)) return fail("expected one size-prefixed OCM");
 const auto* o=GetSizePrefixedOCM(f->payload); const auto* m=o->METADATA();
 const auto& object=objects[current];
 if (!m||object_id(str(m->OBJECT_DESIGNATOR()))!=object.id || std::string(str(m->START_TIME()))!=object.epoch ||
     !o->COVARIANCE_DATA()||o->COVARIANCE_DATA()->size()!=21 || !o->COV_REALISM()||o->COV_REALISM()->size()!=1 || !o->PROVENANCE()) return fail("OCM does not describe the selected object and epoch");
 R::IngestRequestT meta; meta.SCHEMA="OCM.fbs"; meta.TAGS=std::make_unique<R::SourceTagsT>();
 meta.TAGS->PROVIDER_ID="object-covariance"; meta.TAGS->SOURCE_NAME=source;
 meta.TAGS->BATCH_ID="NORAD:"+std::to_string(object.id)+"@"+object.epoch;
 meta.TAGS->LICENSE=str(o->PROVENANCE()->LICENSE_ID());
 meta.RECONCILE=R::reconcileMode_None;
 flatbuffers::FlatBufferBuilder b; R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&meta));
 stage=Stage::Ingest; pending_epoch=epoch_key(object.epoch);
 int rc=push("meta","IngestRequest.fbs","INGQ","IngestRequest",b.GetBufferPointer(),b.GetSize());
 return rc?rc:push("records","OCM.fbs","$OCM","OCM",f->payload,f->payload_length);
}
}
extern "C" int advance() {
 if (input("tick")) {
  if (stage!=Stage::Idle) return 0;
  newest_covariance.clear(); covariance_offset=0; after_object=0; current=0; objects.clear(); return covariance_page();
 }
 if (input("status")) return handle_query();
 if (const auto* o=input("ocm")) return handle_ocm(o);
 if (const auto* f=input("stored")) {
  if (stage!=Stage::Ingest||current>=objects.size()) return fail("unexpected storage completion");
  flatbuffers::Verifier check(f->payload,f->payload_length);
  if (!R::VerifyIngestResultBuffer(check)) return fail("invalid ingest result");
  const auto* result=R::GetIngestResult(f->payload);
  if (result->REFUSED() && result->REFUSED()->size()) return fail(str(result->REFUSED()));
  newest_covariance[objects[current].id]=pending_epoch; ++current; return next_object();
 }
 return fail("empty or incomplete controller invocation");
}
