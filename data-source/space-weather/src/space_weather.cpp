#include "space_data_module_invoke.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {
namespace R = sdn::runtime;
using Json = nlohmann::json;
constexpr size_t budget = 8 * 1024 * 1024;
// The sources, in the canonical order a batch is hashed in; the constants below index them.
const char* urls[] = {
 "https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_since_1932.txt",
 "https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_nowcast.txt",
 "https://services.swpc.noaa.gov/text/45-day-forecast.txt",
 "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
 "https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json"
};
constexpr uint32_t kSources = sizeof(urls) / sizeof(urls[0]);
constexpr uint32_t GfzHistory = 0, GfzNowcast = 1, NoaaForecast = 2, NoaaKp = 3, NoaaCycle = 4;
static_assert(kSources == NoaaCycle + 1, "One URL per source.");
// A day's 81-day averages: centered (40 days each side) and trailing (the 80 days before it, and the day).
constexpr int kCenterHalf = 40, kTrailingBack = 80, kSpan = 81;
// A batch publishes the days from 40 before today through 400 after it. The last day's centered average reaches
// 40 days further, so the flux series runs to today + kAhead + kCenterHalf.
constexpr int kBefore = 40, kAhead = 400;
// Past the 45-day forecast, Ap is the mean of GFZ's daily Ap over this many days before today.
constexpr int kClimatologyDays = 365;
const char* producerId = "space-weather/0.3.0";
// The citation travels in the batch's ingest metadata, and the node's storage.ingest operation refuses a batch whose
// citation is longer than 255 bytes (hostops StorageIngestParams); nothing lands and no error reaches the flow.
constexpr char credit[] = "GFZ Helmholtz Centre for Geosciences; Matzka et al. (2021), doi:10.1029/2020SW002641; F10.7: DRAO/Natural Resources Canada. NOAA SWPC forecasts and predicted solar cycle. Center81 includes forecasts; GFZ preferred, NOAA fills gaps; SN excluded.";
static_assert(sizeof(credit) - 1 <= 255, "The citation must fit the node's 255-byte ingest field.");
int fail(const char* m) { plugin_set_error("space-weather-source", m); return 1; }
#define CHECK(c,m) do { if (!(c)) return fail(m); } while (0)
int push(const char* p,const char* s,const char* id,const char* root,const flatbuffers::FlatBufferBuilder& b) {
 return plugin_push_output_ex(p,s,id,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,b.GetBufferPointer(),b.GetSize());
}
// UTC Gregorian calendar, Howard Hinnant's civil-date algorithm. No local time.
int64_t day(int y,unsigned m,unsigned d) {
 y-=m<=2; const int era=(y>=0?y:y-399)/400; const unsigned yo=y-era*400;
 const unsigned doy=(153*(m+(m>2?-3:9))+2)/5+d-1;
 return int64_t(era)*146097+yo*365+yo/4-yo/100+doy-719468;
}
std::string iso(int64_t z) {
 z+=719468;const int64_t era=(z>=0?z:z-146096)/146097;const unsigned doe=z-era*146097;
 const unsigned yo=(doe-doe/1460+doe/36524-doe/146096)/365;int y=int(yo+era*400);
 const unsigned doy=doe-(365*yo+yo/4-yo/100),mp=(5*doy+2)/153,d=doy-(153*mp+2)/5+1,m=mp+(mp<10?3:-9);y+=m<=2;
 char b[16];std::snprintf(b,sizeof(b),"%04d-%02u-%02u",y,m,d);return b;
}
// One UTC day. `type` says where the flux came from: OBS (GFZ), PRD (NOAA's 45-day forecast) or PRM (the predicted
// solar cycle). `apClimatology` and `kpDerived` mark the values that are neither observed nor forecast.
struct Row {
 int bsr=0,nd=0,ap=-1;std::array<int,8> kp,aps;double flux=-1,adj=-1;F107DataType type=F107DataType::OBS;bool apClimatology=false,kpDerived=false;
 Row(){kp.fill(-1);aps.fill(-1);}
};
using Rows=std::map<int64_t,Row>;
bool gfz(const std::string& text,Rows& rows) {
 if(text.find("# LICENSE: CC BY 4.0, except for the sunspot numbers")==std::string::npos)return false;
 std::istringstream lines(text);std::string line;size_t count=0;
 while(std::getline(lines,line)) {
  if(line.empty()||line[0]=='#')continue;
  std::istringstream in(line);std::vector<double> v;double value;while(in>>value)v.push_back(value);
  if(v.size()!=28)return false;
  const int y=v[0],m=v[1],d=v[2];if(y<1932||m<1||m>12||d<1||d>31)return false;
  Row r;r.bsr=v[5];r.nd=v[6];r.ap=v[23];r.flux=v[25];r.adj=v[26];
  for(int k=0;k<8;++k){r.kp[k]=v[k+7]<0?-1:int(std::lround(v[k+7]*10));r.aps[k]=v[k+15];if(r.kp[k]>90||r.aps[k]>400)return false;}
  if(r.flux>1000||r.ap>400)return false;
  rows[day(y,m,d)]=r;++count; // Column 24 (SN) is deliberately never read into a record.
 }
 return count>0;
}
// NOAA's 45-day Ap and F10.7 forecast into the rows (GFZ's values stand); `last` is its final day.
bool forecast(const std::string& text,Rows& rows,int64_t today,int64_t& last) {
 std::istringstream lines(text);std::string line;int section=0,counts[2]={0,0};int64_t first=-1;
 while(std::getline(lines,line)) {
  if(line=="45-DAY AP FORECAST"){section=1;continue;}
  if(line=="45-DAY F10.7 CM FLUX FORECAST"){section=2;continue;}
  if(!section||line.size()<7||!std::isdigit(line[0]))continue;
  std::istringstream in(line);std::string date;double value;
  while(in>>date>>value) {
   if(date.size()!=7)return false;
   const auto pos=std::string("JanFebMarAprMayJunJulAugSepOctNovDec").find(date.substr(2,3));if(pos==std::string::npos)return false;
   int dd=std::stoi(date.substr(0,2)),yy=2000+std::stoi(date.substr(5,2));auto at=day(yy,pos/3+1,dd);
   if(first<0)first=at;
   if(at>last)last=at;
   auto& r=rows[at];if(section==1){if(value<0||value>400)return false;if(r.ap<0)r.ap=int(value);}
   else {if(value<40||value>1000)return false;if(r.flux<0){r.flux=value;r.type=F107DataType::PRD;}}
   ++counts[section-1];
  }
 }
 return counts[0]==45&&counts[1]==45&&first<=today&&first>=today-1;
}
bool kpForecast(const std::string& body,Rows& rows) {
 auto data=Json::parse(body,nullptr,false);if(!data.is_array()||data.empty())return false;
 for(const auto& entry:data) {
  if(!entry.is_object()||!entry.contains("time_tag")||!entry["time_tag"].is_string()||!entry.contains("kp")||!entry["kp"].is_number())return false;
  const auto date=entry["time_tag"].get<std::string>();int y,m,d,h;
  if(std::sscanf(date.c_str(),"%d-%d-%dT%d",&y,&m,&d,&h)!=4||h<0||h>21||h%3)return false;
  const double kp=entry["kp"];if(!std::isfinite(kp)||kp<0||kp>9)return false;
  auto& r=rows[day(y,m,d)];if(r.kp[h/3]<0)r.kp[h/3]=int(std::lround(kp*10));
 }
 return true;
}
// NOAA SWPC's predicted solar cycle: one F10.7 per month, read as the value at the month's midpoint.
struct Cycle {std::vector<std::pair<double,double>> months;};  // (UTC day number of the midpoint, F10.7)
bool predictedCycle(const std::string& body,Cycle& cycle) {
 auto data=Json::parse(body,nullptr,false);if(!data.is_array()||data.size()<2)return false;
 int previous=-1;
 for(const auto& entry:data) {
  if(!entry.is_object()||!entry.contains("time-tag")||!entry["time-tag"].is_string()||!entry.contains("predicted_f10.7")||!entry["predicted_f10.7"].is_number())return false;
  const auto tag=entry["time-tag"].get<std::string>();
  if(tag.size()!=7||tag[4]!='-')return false;
  for(size_t i:{0,1,2,3,5,6})if(!std::isdigit(static_cast<unsigned char>(tag[i])))return false;
  const int y=std::stoi(tag.substr(0,4)),m=std::stoi(tag.substr(5,2));if(m<1||m>12)return false;
  const double flux=entry["predicted_f10.7"];if(!std::isfinite(flux)||flux<40||flux>1000)return false;
  if(previous>=0&&y*12+m-1!=previous+1)return false;  // consecutive months: nothing to bridge silently
  previous=y*12+m-1;
  cycle.months.emplace_back((day(y,m,1)+day(m==12?y+1:y,m==12?1:m+1,1))/2.0,flux);
 }
 return true;
}
// The cycle's F10.7 at noon of UTC day z, linear in time between the months' midpoints. False outside the first and last midpoint.
bool cycleAt(const Cycle& cycle,int64_t z,double& out) {
 const double t=double(z)+0.5;const auto& m=cycle.months;
 if(t<m.front().first||t>m.back().first)return false;
 size_t i=1;while(m[i].first<t)++i;
 out=m[i-1].second+(m[i].second-m[i-1].second)*(t-m[i-1].first)/(m[i].first-m[i-1].first);return true;
}
// The mean of GFZ's daily Ap over the kClimatologyDays before today, rounded: the Ap of every day past the 45-day forecast.
bool apClimatology(const Rows& rows,int64_t today,int& out) {
 double sum=0;for(int64_t z=today-kClimatologyDays;z<today;++z){const auto p=rows.find(z);if(p==rows.end()||p->second.ap<0)return false;sum+=p->second.ap;}
 out=int(std::lround(sum/kClimatologyDays));return true;
}
// The standard Kp-ap table: the ap of each Kp from 0o to 9o in thirds (the pairs GFZ has published for every interval since 1932).
constexpr int kApOfKpThird[28]={0,2,3,4,5,6,7,9,12,15,18,22,27,32,39,48,56,67,80,94,111,132,154,179,207,236,300,400};
// The Kp (times ten, a third rounded as GFZ's files are) whose table ap is nearest to ap; a tie goes to the lower Kp.
int kpOfAp(int ap) {
 int best=0;for(int third=1;third<28;++third)if(std::abs(kApOfKpThird[third]-ap)<std::abs(kApOfKpThird[best]-ap))best=third;
 return int(std::lround(best*10.0/3.0));
}
bool mean(const Rows& rows,int64_t start,int n,bool adjusted,double& out) {
 double sum=0;for(int i=0;i<n;++i){auto p=rows.find(start+i);if(p==rows.end())return false;double v=adjusted?p->second.adj:p->second.flux;if(v<=0||!std::isfinite(v))return false;sum+=v;}out=sum/n;return true;
}
// A day's four 81-day averages (the adjusted two are -1 when a day of the window has no adjusted flux), and whether
// the window reaches into the predicted cycle.
struct Averages {double center=0,trailing=0,adjCenter=-1,adjTrailing=-1;bool cycle=false;};
// What a day's values descend from: the base sources, what only some days use, then the batch that named them.
std::string lineageOf(const Row& r,const Averages& a,const std::string& sourceHash) {
 std::string out="gfz-kp-ap;drao-f107;noaa-swpc";
 if(a.cycle)out+=";noaa-swpc-predicted-cycle";
 if(r.apClimatology)out+=";ap-climatology-gfz-365d";
 if(r.kpDerived)out+=";kp-derived-from-ap";
 return out+";canonical-source-batch-sha256="+sourceHash;
}
void encode(const Row& r,int64_t at,const Averages& a,const std::string& sourceHash,std::vector<uint8_t>& stream) {
 flatbuffers::FlatBufferBuilder b(1024);auto date=b.CreateString(iso(at));
 auto source=b.CreateString("gfz-noaa"),origin=b.CreateString(credit),provider=b.CreateString("space-weather");
 auto producer=b.CreateString(producerId),license=b.CreateString("CC-BY-4.0 (GFZ); public domain (NOAA SWPC)");
 auto lineage=b.CreateString(lineageOf(r,a,sourceHash));
 PVNBuilder p(b);p.add_SOURCE_ID(source);p.add_SOURCE_KIND(pvnSourceKind::Observation);
 p.add_ORIGINATOR(origin);p.add_PROVIDER_ID(provider);p.add_PRODUCER(producer);
 p.add_LICENSE_CLASS(pvnLicenseClass::Reproducible);p.add_LICENSE_ID(license);p.add_LINEAGE(lineage);
 auto provenance=p.Finish();
 SPWBuilder s(b);s.add_PROVENANCE(provenance);
 s.add_DATE(date);s.add_BSRN(r.bsr);s.add_ND(r.nd);
 s.add_KP1(r.kp[0]);s.add_KP2(r.kp[1]);s.add_KP3(r.kp[2]);s.add_KP4(r.kp[3]);s.add_KP5(r.kp[4]);s.add_KP6(r.kp[5]);s.add_KP7(r.kp[6]);s.add_KP8(r.kp[7]);
 int sum=0;for(int k:r.kp)sum+=k;s.add_KP_SUM(sum);
 s.add_AP1(r.aps[0]);s.add_AP2(r.aps[1]);s.add_AP3(r.aps[2]);s.add_AP4(r.aps[3]);s.add_AP5(r.aps[4]);s.add_AP6(r.aps[5]);s.add_AP7(r.aps[6]);s.add_AP8(r.aps[7]);s.add_AP_AVG(r.ap);
 s.add_F107_OBS(r.flux);s.add_F107_ADJ(r.adj);s.add_F107_DATA_TYPE(r.type);
 s.add_F107_OBS_CENTER81(a.center);s.add_F107_OBS_LAST81(a.trailing);s.add_F107_ADJ_CENTER81(a.adjCenter);s.add_F107_ADJ_LAST81(a.adjTrailing);
 FinishSizePrefixedSPWBuffer(b,s.Finish());stream.insert(stream.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
}
// One batch: the source bodies as retrieved (canonical order), the retrieval instant, and the hash that names the batch.
struct Batch {
 std::array<std::string,kSources> body;uint64_t retrieved=0;ephem::Sha256 hash;
 int64_t today() const {return int64_t(retrieved/86400000);}
};
// The response frames into the batch. Null, or why the batch cannot be built.
const char* readSources(Batch& b) {
 if(plugin_get_input_count()!=kSources)return "Exactly five source responses required.";
 std::array<bool,kSources> seen{};
 for(uint32_t i=0;i<kSources;++i) {
  const auto* f=plugin_get_input_frame(i);if(!(f&&f->payload&&f->payload_length<=budget+65536))return "Response exceeds budget.";
  flatbuffers::Verifier v(f->payload,f->payload_length);if(!R::VerifyHttpResponseBuffer(v))return "Expected HRSP.";const auto* h=R::GetHttpResponse(f->payload);
  int index=-1;for(uint32_t k=0;k<kSources;++k)if(h->URL()&&h->URL()->str()==urls[k])index=int(k);
  if(!(index>=0&&!seen[index]))return "Unknown or duplicate source URL.";seen[index]=true;
  if(!(h->STATUS()==200&&h->BODY()&&h->BODY()->size()>0))return "Source did not return a complete 200 body; keep previous batch.";
  if(!(h->RETRIEVED_MS()>0))return "Missing authenticated retrieval epoch.";
  if(!b.retrieved)b.retrieved=h->RETRIEVED_MS();if(h->RETRIEVED_MS()/86400000!=b.retrieved/86400000)return "Sources straddle UTC day; retry.";
  b.body[index]=std::string(reinterpret_cast<const char*>(h->BODY()->data()),h->BODY()->size());
 }
 // Hash canonical source order (independent of fan-in ordering), with URL separators.
 for(uint32_t k=0;k<kSources;++k){b.hash.update(reinterpret_cast<const uint8_t*>(urls[k]),std::strlen(urls[k])+1);b.hash.update(reinterpret_cast<const uint8_t*>(b.body[k].data()),b.body[k].size());}
 return nullptr;
}
// The merged days, and where NOAA's 45-day forecast ends (the predicted cycle takes over after it).
struct Series {Rows rows;int64_t lastForecast=-1;};
// The days after today that no source covers: Ap past the 45-day forecast is the climatology; a day without all eight
// Kp (NOAA's Kp forecast ends about two days out) gets all eight from its Ap, and its three-hour ap are that Ap.
void completeFuture(Series& s,int64_t today,int climatology) {
 for(int64_t z=today+1;z<=today+kAhead;++z) {
  Row& r=s.rows[z];
  if(r.ap<0){r.ap=climatology;r.apClimatology=true;}
  bool missing=false;for(int k:r.kp)if(k<0)missing=true;
  if(missing){r.kp.fill(kpOfAp(r.ap));r.aps.fill(r.ap);r.kpDerived=true;}
 }
}
// The day rows the sources describe: GFZ observations first, NOAA filling what GFZ lacks, then the predicted cycle for
// the flux past NOAA's forecast. Null, or why they cannot be built.
const char* assemble(const Batch& b,Series& s) {
 const int64_t today=b.today();
 if(!(gfz(b.body[GfzHistory],s.rows)&&gfz(b.body[GfzNowcast],s.rows)))return "Invalid GFZ columns or license header.";
 int climatology=0;if(!apClimatology(s.rows,today,climatology))return "GFZ daily Ap is incomplete for the 365 days before today.";
 if(!forecast(b.body[NoaaForecast],s.rows,today,s.lastForecast))return "Invalid or stale NOAA 45-day forecast.";
 if(!kpForecast(b.body[NoaaKp],s.rows))return "Invalid NOAA Kp forecast.";
 Cycle cycle;if(!predictedCycle(b.body[NoaaCycle],cycle))return "Invalid NOAA predicted solar cycle.";
 for(int64_t z=s.lastForecast+1;z<=today+kAhead+kCenterHalf;++z) {
  Row& r=s.rows[z];if(!cycleAt(cycle,z,r.flux))return "The NOAA predicted solar cycle does not cover the published horizon.";
  r.type=F107DataType::PRM;
 }
 completeFuture(s,today,climatology);
 return nullptr;
}
// The days a batch publishes, encoded: each has daily Ap, flux, all eight Kp and both full 81-day averages.
struct Published {std::vector<uint8_t> stream;uint64_t count=0,ahead=0;bool current=false;};
Published publishable(const Series& s,int64_t today,const std::string& hash) {
 Published out;
 for(const auto& [at,r]:s.rows) {
  if(at<today-kBefore||at>today+kAhead||r.ap<0||r.flux<=0)continue;
  bool complete=true;for(int k:r.kp)if(k<0)complete=false;if(!complete)continue;
  Averages a;a.cycle=at+kCenterHalf>s.lastForecast;
  if(!mean(s.rows,at-kCenterHalf,kSpan,false,a.center)||!mean(s.rows,at-kTrailingBack,kSpan,false,a.trailing))continue;
  mean(s.rows,at-kCenterHalf,kSpan,true,a.adjCenter);mean(s.rows,at-kTrailingBack,kSpan,true,a.adjTrailing);
  encode(r,at,a,hash,out.stream);++out.count;out.current|=at==today;if(at>today)++out.ahead;
 }
 return out;
}
// The ingest metadata and the flow notice of the batch, then its records.
int publish(const Batch& b,const Published& days,const std::string& hash) {
 R::IngestRequestT meta;meta.SCHEMA="SPW.fbs";meta.RECONCILE=R::reconcileMode_Current;meta.TAGS=std::make_unique<R::SourceTagsT>();
 auto& tags=*meta.TAGS;tags.PROVIDER_ID="space-weather";tags.SOURCE_NAME="gfz-noaa";tags.BATCH_ID=hash;tags.SOURCE_URL=urls[0];
 tags.LICENSE="CC-BY-4.0 (GFZ); public domain (NOAA SWPC)";tags.LICENSE_URL="https://creativecommons.org/licenses/by/4.0/";tags.CITATION=credit;
 meta.PROVENANCE=std::make_unique<R::ProvenanceT>();auto& p=*meta.PROVENANCE;p.SOURCE_URL=urls[0];p.HTTP_STATUS=200;p.RETRIEVED_MS=b.retrieved;p.PARSER="space-weather";p.PARSER_VERSION=producerId;p.SOURCE_SHA256=hash;p.NORMALIZED_COUNT=days.count;p.SCHEMAS={"SPW.fbs"};p.SCHEMA_COUNTS={days.count};
 flatbuffers::FlatBufferBuilder mb(2048);R::FinishIngestRequestBuffer(mb,R::IngestRequest::Pack(mb,&meta));
 R::FlowNoticeT report;report.KIND=R::flowNoticeKind_Info;report.SCHEMA="SPW.fbs";report.PROVIDER_ID=tags.PROVIDER_ID;report.SOURCE_NAME=tags.SOURCE_NAME;report.BATCH_ID=tags.BATCH_ID;report.COUNT=days.count;report.AT_MS=b.retrieved;report.REASON="licensed-mixed-observed-forecast";
 for(uint32_t k=0;k<kSources;++k)report.ITEMS.push_back(std::string(urls[k])+" sha256="+ephem::sha256_hex(reinterpret_cast<const uint8_t*>(b.body[k].data()),b.body[k].size()));
 flatbuffers::FlatBufferBuilder rb(2048);R::FinishFlowNoticeBuffer(rb,R::FlowNotice::Pack(rb,&report));
 CHECK(push("meta","IngestRequest.fbs","INGQ","IngestRequest",mb)>=0&&push("report","FlowNotice.fbs","FNTC","FlowNotice",rb)>=0,"Metadata emission failed.");
 return plugin_push_output_ex("records","SPW.fbs","$SPW",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"SPW",0,0,days.stream.data(),days.stream.size())<0?1:0;
}
}
extern "C" int plan_weather() {
 CHECK(plugin_get_input_count()==1,"Exactly one TimerTick required.");auto f=plugin_get_input_frame(0);
 CHECK(f&&f->payload&&f->payload_length<65536,"Invalid TimerTick.");flatbuffers::Verifier v(f->payload,f->payload_length);CHECK(R::VerifyTimerTickBuffer(v),"Expected TICK.");
 for(const auto* url:urls) {
  R::HttpRequestT r;r.METHOD="GET";r.URL=url;r.TIMEOUT_MS=60000;r.MAX_BYTES=budget;
  // Explicit validator avoids the host's cached ETag suppressing one input of a multi-source join.
  auto h=std::make_unique<R::HeaderT>();h->NAME="if-modified-since";h->VALUE="Thu, 01 Jan 1970 00:00:00 GMT";r.HEADERS.push_back(std::move(h));
  flatbuffers::FlatBufferBuilder b(1024);R::FinishHttpRequestBuffer(b,R::HttpRequest::Pack(b,&r));CHECK(push("request","HttpRequest.fbs","HREQ","HttpRequest",b)>=0,"Request emission failed.");
 }
 return 0;
}
extern "C" int parse_weather() {
 Batch batch;if(const char* why=readSources(batch))return fail(why);
 Series series;if(const char* why=assemble(batch,series))return fail(why);
 const std::string hash=batch.hash.hex();const Published days=publishable(series,batch.today(),hash);
 CHECK(days.current&&days.count>=40,"Today's complete drivers and history unavailable; keep previous batch.");
 CHECK(days.ahead==kAhead,"The published horizon is incomplete; keep previous batch.");
 return publish(batch,days,hash);
}
