// Orchestration only. All orbit, frame and covariance math stays in gp-error-model.
//
// A run: the objects whose newest OMM arrived after the position the newest record carries, in arrival order; then, for up
// to batches_per_run batches of batch_size such objects, ONE scan of the OMM lane for the whole batch's histories (the lane
// is not indexed by object: a scan per object would cost a pass over the lane each), gp-error-model object_covariance per
// object, and ONE ingest of the batch's records. The position is an OMM row id: every record of a batch carries the row id
// of the batch's last OMM in its message id, so the newest record is the cursor and a run that stops anywhere resumes from
// what the lane holds. Module SQL sees the engine's resident window of a lane, not all of it; a position needs only the
// newest record of its own lane and the OMM rows after it.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "space_data_module_invoke.h"
#include "TimerTick_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "FlowNotice_generated.h"
namespace {
namespace R = sdn::runtime;
using Bytes = std::vector<uint8_t>;
constexpr const char* source = "celestrak-gp-object-covariance";
// The store's relations, one per source: <CODE>@<source>.
constexpr const char* omm_table = "\"OMM@celestrak-gp\"";
constexpr const char* ocm_table = "\"OCM@celestrak-gp-object-covariance\"";
// The record's rows: the covariance at these ages (days) past the set's epoch. Age 0 is the first row, so the record's
// START_TIME is the OMM's epoch; the later rows carry the growth of the covariance with the set's age.
constexpr double ages[] = {0, 0.5, 1, 2, 3, 5, 7};
constexpr size_t age_count = sizeof ages / sizeof ages[0];
constexpr size_t stale_rows = 4096, batch_size = 256, batches_per_run = 4;
constexpr size_t max_result_bytes = 32 * 1024 * 1024;
constexpr const char* position_key = "omm-rowid:";
enum class Stage { Idle, Mark, Max, Stale, History, Calculation, Ingest };
Stage stage = Stage::Idle;
uint64_t request_id = 0, position = 0, position_after = 0, stored_this_run = 0;
size_t next_stale = 0, batches = 0, at = 0;
struct Object { uint64_t row; uint32_t id; std::string epoch, key; };
std::vector<Object> stale;                // objects whose newest OMM arrived after the position, in arrival order
std::vector<Object> batch;                // the batch in hand
std::map<uint32_t, Bytes> histories;      // its objects' OMM records, size-prefixed, oldest first
Bytes produced;                           // the batch's records so far
size_t produced_count = 0;
std::string batch_license;                // the licence the batch's records carry in their provenance
const char* str(const flatbuffers::String* s) { return s ? s->c_str() : ""; }
// A pass's account to the flow's egress and the node's ledger: Unchanged is a success without a batch (the node does not
// count it as a failed retrieval), Info carries a refusal's reason, which the status code alone cannot.
void notice(R::flowNoticeKind kind, const std::string& reason, uint64_t count = 0) {
 R::FlowNoticeT n; n.KIND = kind; n.SCHEMA = "OCM.fbs"; n.PROVIDER_ID = "object-covariance"; n.SOURCE_NAME = source;
 n.REASON = reason; n.COUNT = count;
 flatbuffers::FlatBufferBuilder b; R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
 plugin_push_output_ex("notice", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(), b.GetSize());
}
int fail(const std::string& message) {
 stage = Stage::Idle; stale.clear(); batch.clear(); histories.clear(); produced.clear(); produced_count = 0;
 plugin_set_error("covariance-reactor", message.c_str()); notice(R::flowNoticeKind_Info, message); return 500;
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
 std::string fraction; size_t p = 19;
 if (p < text.size() && text[p]=='.') {
  for (++p; p < text.size() && text[p]>='0' && text[p]<='9'; ++p) fraction += text[p];
 }
 if (p < text.size() && text[p]=='Z') ++p;
 if (p != text.size() || fraction.size() > 9) return {};
 fraction.resize(9,'0'); return text.substr(0,19)+'.'+fraction;
}
bool digits(const std::string& t, size_t& p, uint64_t& value) {
 value = 0; size_t n = 0;
 for (; p < t.size() && t[p]>='0' && t[p]<='9'; ++p, ++n) { value = value*10 + (t[p]-'0'); if (value > (UINT64_MAX - 9) / 10) return false; }
 return n > 0;
}
int query(const std::string& sql, Stage next) {
 stage=next; ++request_id;
 FSOT control; control.OPERATION=flatSqlNodeOperation::QUERY_RECORDS; control.REQUEST_ID=request_id;
 control.QUERY.assign(sql.begin(),sql.end()); flatbuffers::FlatBufferBuilder b;
 FinishFSOBuffer(b,FSO::Pack(b,&control));
 return push("query","FSO.fbs","$FSO","FSO",b.GetBufferPointer(),b.GetSize());
}
// The position: the newest record's message id ("object-covariance|<object key>|<first epoch>|<method>|<request id>"),
// found in the record's bytes. The store exposes a record's body, not its header's fields; only the id leaves the store.
int mark_query() {
 return query("SELECT CAST(substr(_data, instr(_data, CAST('object-covariance|' AS BLOB)), 160) AS BLOB) FROM "+std::string(ocm_table)+
  " ORDER BY _rowid DESC LIMIT 1",Stage::Mark);
}
int max_query() { return query("SELECT CAST(COALESCE(MAX(_rowid), 0) AS BLOB) FROM "+std::string(omm_table),Stage::Max); }
// The objects whose newest OMM (by epoch) arrived after the position: "<row id> <NORAD id> <epoch>" in arrival order.
int stale_query() {
 return query("SELECT CAST(COALESCE(rid, 0) || ' ' || COALESCE(norad, 0) || ' ' || COALESCE(epoch, '') AS BLOB) FROM (SELECT _rowid AS rid, NORAD_CAT_ID AS norad, EPOCH AS epoch, "
  "ROW_NUMBER() OVER (PARTITION BY NORAD_CAT_ID ORDER BY EPOCH DESC, _rowid DESC) AS rn FROM "+std::string(omm_table)+") WHERE rn = 1 AND rid > "+
  std::to_string(position)+" ORDER BY rid LIMIT "+std::to_string(stale_rows),Stage::Stale);
}
bool sql_safe(const std::string& text) {
 for (const char c : text) if (!((c>='0'&&c<='9')||c=='-'||c==':'||c=='.'||c=='T'||c=='Z')) return false;
 return !text.empty();
}
// The histories of the whole batch in one pass, windowed by the batch's extreme epochs.
int history_query() {
 std::string ids, low = batch[0].epoch, high = batch[0].epoch;
 std::string low_key = batch[0].key, high_key = batch[0].key;
 for (const auto& o : batch) {
  ids += (ids.empty() ? "" : ",") + std::to_string(o.id);
  if (o.key < low_key) { low_key = o.key; low = o.epoch; }
  if (o.key > high_key) { high_key = o.key; high = o.epoch; }
 }
 if (!sql_safe(low) || !sql_safe(high)) return fail("OMM epoch has characters outside an ISO UTC time");
 return query("SELECT _data FROM "+std::string(omm_table)+" WHERE NORAD_CAT_ID IN ("+ids+") AND julianday(EPOCH) >= julianday('"+low+
  "') - 31.0 AND julianday(EPOCH) <= julianday('"+high+"') + 1.0/86400.0 ORDER BY NORAD_CAT_ID, julianday(EPOCH), _rowid",Stage::History);
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
  if (c->TOTAL_BYTES()>max_result_bytes) { error="query result exceeds 32 MiB; refusing truncation"; return false; }
  if (const auto* d=c->DATA()) out.insert(out.end(),d->begin(),d->end());
 }
 if (out.size()!=chunks.back()->TOTAL_BYTES()) { error="query byte count mismatch"; return false; }
 return true;
}
// The store frames every result cell as [u32 size][bytes]: a record is its size-prefixed buffer, a text cell its bytes.
template<typename Fn> bool cells(const Bytes& bytes, Fn each, size_t& count) {
 size_t p=0; count=0;
 while (p+4<=bytes.size()) {
  const uint32_t n=flatbuffers::ReadScalar<uint32_t>(bytes.data()+p);
  if (!n) { p+=4; continue; }
  if (n>bytes.size()-p-4) return false;
  if (!each(bytes.data()+p,static_cast<size_t>(n)+4)) return false;
  ++count; p+=n+4;
 }
 return p==bytes.size();
}
std::string text_of(const uint8_t* cell, size_t size) { return std::string(reinterpret_cast<const char*>(cell)+4, size-4); }
int start_batch();
int finish_run(const char* reason = "every object's newest OMM has its covariance") {
 stage = Stage::Idle;
 if (!stored_this_run) notice(R::flowNoticeKind_Unchanged, reason);
 return 0;
}
int next_batch() {
 if (next_stale < stale.size() && batches < batches_per_run) return start_batch();
 return finish_run();
}
int start_batch() {
 batch.clear(); histories.clear(); produced.clear(); produced_count = 0; at = 0;
 for (; next_stale < stale.size() && batch.size() < batch_size; ++next_stale) batch.push_back(stale[next_stale]);
 position_after = batch.back().row;
 return history_query();
}
// The next object of the batch with a history: its elements and its ages go to gp-error-model. Every entry's id is the
// position the batch reaches, which the module carries into the record's message id.
int next_object() {
 while (at < batch.size()) {
  const auto& object = batch[at];
  const auto found = histories.find(object.id);
  if (found == histories.end() || found->second.empty()) { ++at; continue; }
  ERMT request; request.CALIBRATED_COVARIANCES=std::make_unique<ERMCalibratedCovariancesT>();
  for (const double age:ages) {
   auto o=std::make_unique<ERMCalibrationObjectT>(); o->ID=std::string(position_key)+std::to_string(position_after);
   o->SET_NORAD_CAT_ID=object.id; o->SET_EPOCH=object.epoch; o->AGE_DAYS=age;
   request.CALIBRATED_COVARIANCES->OBJECTS.push_back(std::move(o));
  }
  flatbuffers::FlatBufferBuilder b; FinishSizePrefixedERMBuffer(b,ERM::Pack(b,&request));
  stage=Stage::Calculation;
  int rc=push("elements","OMM.fbs","$OMM","OMM",found->second.data(),found->second.size());
  return rc?rc:push("request","ERM.fbs","$ERM","ERM",b.GetBufferPointer(),b.GetSize());
 }
 // The batch's records go to the store together, or none do. Duplicates are dropped: the records are a pure function of
 // the history, so a batch stored twice (a run that stopped before it learned of the first) holds one copy.
 if (produced.empty()) { position = position_after; return next_batch(); }
 R::IngestRequestT meta; meta.SCHEMA="OCM.fbs"; meta.TAGS=std::make_unique<R::SourceTagsT>();
 meta.TAGS->PROVIDER_ID="object-covariance"; meta.TAGS->SOURCE_NAME=source;
 meta.TAGS->BATCH_ID=std::string(position_key)+std::to_string(position_after);
 meta.TAGS->LICENSE=batch_license;
 meta.RECONCILE=R::reconcileMode_Duplicates;
 flatbuffers::FlatBufferBuilder b; R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&meta));
 stage=Stage::Ingest;
 int rc=push("meta","IngestRequest.fbs","INGQ","IngestRequest",b.GetBufferPointer(),b.GetSize());
 return rc?rc:push("records","OCM.fbs","$OCM","OCM",produced.data(),produced.size());
}
int handle_query() {
 const auto* frame=input("status"); if (!frame) return fail("query has no completion status");
 flatbuffers::Verifier v(frame->payload,frame->payload_length);
 if (!VerifyFSOBuffer(v)) return fail("invalid query status");
 const auto* status=GetFSO(frame->payload);
 if (status->REQUEST_ID()!=request_id) return fail("stale query status");
 if (status->STATUS()!=flatSqlNodeStatus::COMPLETE) {
  const auto* m=status->MESSAGE(); const std::string message=m?std::string(m->begin(),m->end()):"query failed";
  // A record lane has no relation until its first record is stored: no record, no position.
  if (stage==Stage::Mark && message.find("no such table")!=std::string::npos) return max_query();
  // ...and an OMM lane has none before its first ingest: nothing to derive from yet.
  if ((stage==Stage::Max || stage==Stage::Stale) && message.find("no such table")!=std::string::npos) return finish_run("no OMM lane yet");
  return fail(message);
 }
 Bytes bytes; std::string error; if (!unpack_chunks(bytes,error)) return fail(error);
 size_t count=0;
 if (stage==Stage::Mark) {
  position=0;
  if (!cells(bytes,[&](const uint8_t* p,size_t n){
   const std::string t=text_of(p,n); const size_t q=t.find(position_key);
   if (q==std::string::npos) return false;
   size_t d=q+std::strlen(position_key); return digits(t,d,position);
  },count)) return fail("the newest record carries no position");
  return max_query();
 }
 if (stage==Stage::Max) {
  uint64_t newest=0;
  if (!cells(bytes,[&](const uint8_t* p,size_t n){ const std::string t=text_of(p,n); size_t d=0; return digits(t,d,newest); },count) || count!=1) return fail("the OMM lane's newest row id is unreadable");
  // Row ids that restarted below the position name no later OMM: start over (the records are idempotent).
  if (newest<position) position=0;
  return stale_query();
 }
 if (stage==Stage::Stale) {
  stale.clear(); next_stale=0;
  if (!cells(bytes,[&](const uint8_t* p,size_t n){
   const std::string t=text_of(p,n); size_t q=0; uint64_t row=0, id=0;
   if (!digits(t,q,row) || q>=t.size() || t[q]!=' ') return false;
   ++q; if (!digits(t,q,id) || id==0 || id>UINT32_MAX || q>=t.size() || t[q]!=' ') return false;
   const std::string epoch=t.substr(q+1), key=epoch_key(epoch);
   if (key.empty()) return false;
   stale.push_back({row,static_cast<uint32_t>(id),epoch,key});
   return true;
  },count)) return fail("an OMM row is unreadable");
  if (stale.empty()) return finish_run();
  return next_batch();
 }
 if (stage==Stage::History) {
  std::map<uint32_t,std::string> newest;
  for (const auto& o : batch) newest[o.id]=o.key;
  if (!cells(bytes,[&](const uint8_t* p,size_t n){
   flatbuffers::Verifier check(p,n); if (!VerifySizePrefixedOMMBuffer(check)) return false;
   const auto* o=GetSizePrefixedOMM(p); const auto found=newest.find(o->NORAD_CAT_ID());
   if (found==newest.end()) return false;
   const std::string key=epoch_key(str(o->EPOCH())); if (key.empty()) return false;
   // Causal: nothing after the set in force.
   if (key<=found->second) histories[o->NORAD_CAT_ID()].insert(histories[o->NORAD_CAT_ID()].end(),p,p+n);
   return true;
  },count)) return fail("invalid OMM history stream");
  at=0; return next_object();
 }
 return fail("unexpected query response");
}
int handle_ocm(const plugin_input_frame_t* f) {
 if (stage!=Stage::Calculation||at>=batch.size()) return fail("unexpected covariance product");
 flatbuffers::Verifier check(f->payload,f->payload_length);
 if (!VerifySizePrefixedOCMBuffer(check)) return fail("expected one size-prefixed OCM");
 const auto* o=GetSizePrefixedOCM(f->payload); const auto* m=o->METADATA();
 const auto& object=batch[at];
 const std::string designator=m?str(m->OBJECT_DESIGNATOR()):"";
 size_t q=0; uint64_t id=0;
 if (!m||!digits(designator,q,id)||id!=object.id||epoch_key(str(m->START_TIME()))!=object.key||!o->STATE_EPOCHS()||o->STATE_EPOCHS()->size()!=age_count||
     !o->COVARIANCE_DATA()||o->COVARIANCE_DATA()->size()!=21*age_count||!o->COV_REALISM()||o->COV_REALISM()->size()!=age_count||!o->PROVENANCE())
  return fail("OCM does not describe the selected object, epoch and ages");
 if (!produced_count) batch_license=str(o->PROVENANCE()->LICENSE_ID());
 produced.insert(produced.end(),f->payload,f->payload+f->payload_length); ++produced_count;
 ++at; return next_object();
}
}
extern "C" int advance() {
 if (input("tick")) {
  if (stage!=Stage::Idle) return 0;
  stale.clear(); batch.clear(); histories.clear(); produced.clear(); produced_count=0;
  position=0; position_after=0; stored_this_run=0; next_stale=0; batches=0; at=0;
  return mark_query();
 }
 if (input("status")) return handle_query();
 if (const auto* o=input("ocm")) return handle_ocm(o);
 if (const auto* f=input("stored")) {
  if (stage!=Stage::Ingest) return fail("unexpected storage completion");
  flatbuffers::Verifier check(f->payload,f->payload_length);
  if (!R::VerifyIngestResultBuffer(check)) return fail("invalid ingest result");
  const auto* result=R::GetIngestResult(f->payload);
  if (result->REFUSED() && result->REFUSED()->size()) return fail(str(result->REFUSED()));
  position=position_after; stored_this_run+=produced_count; ++batches;
  return next_batch();
 }
 return fail("empty or incomplete controller invocation");
}
