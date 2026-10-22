#include "space_data_module_invoke.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
#include "TimerTick_generated.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {
namespace R = sdn::runtime;
using Json = nlohmann::json;
constexpr size_t budget = 8 * 1024 * 1024;
const char* urls[] = {
 "https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_since_1932.txt",
 "https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_nowcast.txt",
 "https://services.swpc.noaa.gov/text/45-day-forecast.txt",
 "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"
};
const char* credit = "GFZ Helmholtz Centre for Geosciences; Matzka et al. (2021), doi:10.1029/2020SW002641; F10.7: DRAO/Natural Resources Canada. NOAA SWPC. Center81 includes forecasts; GFZ preferred, NOAA fills gaps; SN excluded.";
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
struct Row {
 int bsr=0,nd=0,ap=-1;std::array<int,8> kp,aps;double flux=-1,adj=-1;bool predicted=false;
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
bool forecast(const std::string& text,Rows& rows,int64_t today) {
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
   auto& r=rows[at];if(section==1){if(value<0||value>400)return false;if(r.ap<0)r.ap=int(value);}
   else {if(value<40||value>1000)return false;if(r.flux<0){r.flux=value;r.predicted=true;}}
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
bool mean(const Rows& rows,int64_t start,int n,bool adjusted,double& out) {
 double sum=0;for(int i=0;i<n;++i){auto p=rows.find(start+i);if(p==rows.end())return false;double v=adjusted?p->second.adj:p->second.flux;if(v<=0||!std::isfinite(v))return false;sum+=v;}out=sum/n;return true;
}
void encode(const Row& r,int64_t at,double center,double trailing,double adjCenter,double adjTrailing,std::vector<uint8_t>& stream) {
 flatbuffers::FlatBufferBuilder b(512);auto date=b.CreateString(iso(at));SPWBuilder s(b);
 s.add_DATE(date);s.add_BSRN(r.bsr);s.add_ND(r.nd);
 s.add_KP1(r.kp[0]);s.add_KP2(r.kp[1]);s.add_KP3(r.kp[2]);s.add_KP4(r.kp[3]);s.add_KP5(r.kp[4]);s.add_KP6(r.kp[5]);s.add_KP7(r.kp[6]);s.add_KP8(r.kp[7]);
 int sum=0;for(int k:r.kp)sum+=k;s.add_KP_SUM(sum);
 s.add_AP1(r.aps[0]);s.add_AP2(r.aps[1]);s.add_AP3(r.aps[2]);s.add_AP4(r.aps[3]);s.add_AP5(r.aps[4]);s.add_AP6(r.aps[5]);s.add_AP7(r.aps[6]);s.add_AP8(r.aps[7]);s.add_AP_AVG(r.ap);
 s.add_F107_OBS(r.flux);s.add_F107_ADJ(r.adj);s.add_F107_DATA_TYPE(r.predicted?F107DataType::PRD:F107DataType::OBS);
 s.add_F107_OBS_CENTER81(center);s.add_F107_OBS_LAST81(trailing);s.add_F107_ADJ_CENTER81(adjCenter);s.add_F107_ADJ_LAST81(adjTrailing);
 FinishSizePrefixedSPWBuffer(b,s.Finish());stream.insert(stream.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
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
  CHECK(plugin_get_input_count()==4,"Exactly four source responses required.");std::array<std::string,4> bodies;std::array<bool,4> seen{};uint64_t retrieved=0;ephem::Sha256 batch;
  for(uint32_t i=0;i<4;++i) {
   const auto* f=plugin_get_input_frame(i);CHECK(f&&f->payload&&f->payload_length<=budget+65536,"Response exceeds budget.");
   flatbuffers::Verifier v(f->payload,f->payload_length);CHECK(R::VerifyHttpResponseBuffer(v),"Expected HRSP.");const auto* h=R::GetHttpResponse(f->payload);
   int index=-1;for(int k=0;k<4;++k)if(h->URL()&&h->URL()->str()==urls[k])index=k;
   CHECK(index>=0&&!seen[index],"Unknown or duplicate source URL.");seen[index]=true;
   CHECK(h->STATUS()==200&&h->BODY()&&h->BODY()->size()>0,"Source did not return a complete 200 body; keep previous batch.");
   CHECK(h->RETRIEVED_MS()>0,"Missing authenticated retrieval epoch.");
   if(!retrieved)retrieved=h->RETRIEVED_MS();CHECK(h->RETRIEVED_MS()/86400000==retrieved/86400000,"Sources straddle UTC day; retry.");
   bodies[index]=std::string(reinterpret_cast<const char*>(h->BODY()->data()),h->BODY()->size());
  }
  // Hash canonical source order (independent of fan-in ordering), with URL separators.
  for(int k=0;k<4;++k){batch.update(reinterpret_cast<const uint8_t*>(urls[k]),std::strlen(urls[k])+1);batch.update(reinterpret_cast<const uint8_t*>(bodies[k].data()),bodies[k].size());}
  const int64_t today=retrieved/86400000;Rows rows;CHECK(gfz(bodies[0],rows)&&gfz(bodies[1],rows),"Invalid GFZ columns or license header.");
  CHECK(forecast(bodies[2],rows,today),"Invalid or stale NOAA 45-day forecast.");CHECK(kpForecast(bodies[3],rows),"Invalid NOAA Kp forecast.");
  std::vector<uint8_t> stream;uint64_t count=0;bool current=false;
  for(const auto& [at,r]:rows) {
   if(at<today-40||at>today+4||r.ap<0||r.flux<=0)continue;
   bool complete=true;for(int k:r.kp)if(k<0)complete=false;if(!complete)continue;
   double center=0,trailing=0,ac=-1,al=-1;if(!mean(rows,at-40,81,false,center)||!mean(rows,at-80,81,false,trailing))continue;
   mean(rows,at-40,81,true,ac);mean(rows,at-80,81,true,al);encode(r,at,center,trailing,ac,al,stream);++count;current|=at==today;
  }
  CHECK(current&&count>=40,"Today's complete drivers and history unavailable; keep previous batch.");
  R::IngestRequestT meta;meta.SCHEMA="SPW.fbs";meta.RECONCILE=R::reconcileMode_Current;meta.TAGS=std::make_unique<R::SourceTagsT>();
  auto& tags=*meta.TAGS;tags.PROVIDER_ID="space-weather";tags.SOURCE_NAME="gfz-noaa";tags.BATCH_ID=batch.hex();tags.SOURCE_URL=urls[0];
  tags.LICENSE="CC-BY-4.0 (GFZ); public domain (NOAA SWPC)";tags.LICENSE_URL="https://creativecommons.org/licenses/by/4.0/";tags.CITATION=credit;
  meta.PROVENANCE=std::make_unique<R::ProvenanceT>();auto& p=*meta.PROVENANCE;p.SOURCE_URL=urls[0];p.HTTP_STATUS=200;p.RETRIEVED_MS=retrieved;p.PARSER="space-weather";p.PARSER_VERSION="space-weather/0.1.0";p.SOURCE_SHA256=batch.hex();p.NORMALIZED_COUNT=count;p.SCHEMAS={"SPW.fbs"};p.SCHEMA_COUNTS={count};
  flatbuffers::FlatBufferBuilder mb(2048);R::FinishIngestRequestBuffer(mb,R::IngestRequest::Pack(mb,&meta));
  R::FlowNoticeT report;report.KIND=R::flowNoticeKind_Info;report.SCHEMA="SPW.fbs";report.PROVIDER_ID=tags.PROVIDER_ID;report.SOURCE_NAME=tags.SOURCE_NAME;report.BATCH_ID=tags.BATCH_ID;report.COUNT=count;report.AT_MS=retrieved;report.REASON="licensed-mixed-observed-forecast";
  for(int k=0;k<4;++k)report.ITEMS.push_back(std::string(urls[k])+" sha256="+ephem::sha256_hex(reinterpret_cast<const uint8_t*>(bodies[k].data()),bodies[k].size()));
  flatbuffers::FlatBufferBuilder rb(2048);R::FinishFlowNoticeBuffer(rb,R::FlowNotice::Pack(rb,&report));
  CHECK(push("meta","IngestRequest.fbs","INGQ","IngestRequest",mb)>=0&&push("report","FlowNotice.fbs","FNTC","FlowNotice",rb)>=0,"Metadata emission failed.");
  return plugin_push_output_ex("records","SPW.fbs","$SPW",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"SPW",0,0,stream.data(),stream.size())<0?1:0;
}
