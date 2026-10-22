#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "TimerTick_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
namespace {
namespace R=sdn::runtime;namespace fb=flatbuffers;
constexpr int64_t DAY=86400000;
const std::set<std::string> fleet={"24ae","24d1","24da","24dc","24dd","24de","24df","24eb","24f6","24fd","2501","250a","2515","251b","251e","251f","2526","252b","252d","2534","2538","253b","253c","2545","2546","2547","2549","254a","254f","2553","255e","2563","2571","300a","300b","4001"};
const char* planet="https://ephemerides.planet-labs.com/planet_";
const char* kernelUrl="https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp";
int fail(const std::string& text){plugin_set_error("operator-states-public",text.c_str());return 1;}
#define NEED(c,m) do{if(!(c))return fail(m);}while(0)
int push(const char* port,const char* schema,const char* id,const char* root,const fb::FlatBufferBuilder& b){return plugin_push_output_ex(port,schema,id,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,b.GetBufferPointer(),b.GetSize())<0?1:0;}
// Calendar formatting only; no time-scale or orbit computation here.
std::string date(int64_t z){z+=719468;const int64_t era=(z>=0?z:z-146096)/146097;const unsigned doe=z-era*146097,yo=(doe-doe/1460+doe/36524-doe/146096)/365;int y=int(yo+era*400);const unsigned doy=doe-(365*yo+yo/4-yo/100),mp=(5*doy+2)/153,d=doy-(153*mp+2)/5+1,m=mp+(mp<10?3:-9);y+=m<=2;char b[16];std::snprintf(b,sizeof(b),"%04d-%02u-%02u",y,m,d);return b;}
std::string iso(int64_t ms){auto day=ms/DAY,rem=ms%DAY;char b[24];std::snprintf(b,sizeof(b),"T%02lld:%02lld:%02lld.%03lldZ",(long long)(rem/3600000),(long long)(rem/60000%60),(long long)(rem/1000%60),(long long)(rem%1000));return date(day)+b;}
const plugin_input_frame_t* input(const char* port){int i=plugin_find_input_index(port,0);return i<0?nullptr:plugin_get_input_frame(i);}
uint64_t issue_of(const R::HttpResponse* r){if(!r->CONTEXT())return 0;fb::Verifier v(r->CONTEXT()->data(),r->CONTEXT()->size());return R::VerifySizePrefixedTimerTickBuffer(v)?R::GetSizePrefixedTimerTick(r->CONTEXT()->data())->FIRED_MS():0;}
template<class Object,class Verify,class Get> bool stream(const plugin_input_frame_t* f,std::vector<std::unique_ptr<Object>>& out,Verify verify,Get get,bool transportPrefix=false){if(!f)return false;size_t at=0;while(at<f->payload_length){if(f->payload_length-at<12)return false;auto n=fb::ReadScalar<uint32_t>(f->payload+at);if(n<8||n+4>f->payload_length-at)return false;const size_t offset=transportPrefix?4:0;fb::Verifier v(f->payload+at+offset,n+4-offset);if(!verify(v))return false;out.emplace_back(get(f->payload+at+offset)->UnPack());at+=n+4;}return !out.empty();}
}
extern "C" int plan_operator(){
  const auto* f=input("tick");NEED(f,"TimerTick required");fb::Verifier v(f->payload,f->payload_length);NEED(R::VerifyTimerTickBuffer(v),"Invalid TimerTick");auto tick=R::GetTimerTick(f->payload);const auto issue=tick->FIRED_MS();NEED(issue>0,"Explicit issue time required");auto native=std::unique_ptr<R::TimerTickT>(tick->UnPack());fb::FlatBufferBuilder context;R::FinishSizePrefixedTimerTickBuffer(context,R::TimerTick::Pack(context,native.get()));
  // Today is eligible after 22:55 UTC, following Planet's final daily file.
  const int64_t last=int64_t(issue)/DAY-(issue%DAY<82500000?1:0);std::vector<std::string> urls;for(int d=31;d>=0;--d){auto day=date(last-d);day.erase(std::remove(day.begin(),day.end(),'-'),day.end());urls.push_back(std::string(planet)+day+".states");}urls.push_back(kernelUrl);
  for(const auto& url:urls){R::HttpRequestT r;r.METHOD="GET";r.URL=url;r.TIMEOUT_MS=90000;r.MAX_BYTES=url==kernelUrl?40*1024*1024:8*1024*1024;r.CONTEXT.assign(context.GetBufferPointer(),context.GetBufferPointer()+context.GetSize());auto h=std::make_unique<R::HeaderT>();h->NAME="if-modified-since";h->VALUE="Thu, 01 Jan 1970 00:00:00 GMT";r.HEADERS.push_back(std::move(h));fb::FlatBufferBuilder b;R::FinishHttpRequestBuffer(b,R::HttpRequest::Pack(b,&r));if(push("request","HttpRequest.fbs","HREQ","HttpRequest",b))return 1;}return 0;
}
extern "C" int parse_operator(){
  NEED(plugin_get_input_count()==33,"A complete 32-day operator batch and kernel is required");std::map<std::string,std::map<int64_t,std::array<double,6>>> series;std::set<std::string> urls;uint64_t issue=0;std::string lineage;const R::HttpResponse* kernel=nullptr;
  for(uint32_t i=0;i<plugin_get_input_count();++i){auto f=plugin_get_input_frame(i);fb::Verifier v(f->payload,f->payload_length);NEED(R::VerifyHttpResponseBuffer(v),"Invalid HttpResponse");auto r=R::GetHttpResponse(f->payload);NEED(r->URL()&&r->STATUS()==200&&r->BODY(),"All operator/environment requests must succeed");auto url=r->URL()->str();NEED(urls.insert(url).second,"Duplicate source URL");auto at=issue_of(r);NEED(at>0&&(!issue||at==issue),"Mixed or missing issue time");issue=at;if(url==kernelUrl){kernel=r;continue;}
    NEED(url.rfind(planet,0)==0&&url.size()==std::strlen(planet)+15,"Unexpected operator source");NEED(r->BODY()->size()<1024*1024,"Operator source exceeds budget");lineage+=url.substr(std::strlen(planet))+"="+ephem::sha256_hex(r->BODY()->data(),r->BODY()->size())+";";
    std::istringstream lines(std::string(reinterpret_cast<const char*>(r->BODY()->data()),r->BODY()->size()));std::string line;size_t count=0;while(std::getline(lines,line)){std::istringstream row(line);std::string id;double tt,bc;std::string srp;std::array<double,6> x;if(!(row>>id))continue;if(!fleet.count(id))continue;NEED(bool(row>>tt>>x[0]>>x[1]>>x[2]>>x[3]>>x[4]>>x[5]>>bc>>srp),"Malformed calibration Dove state");NEED(std::isfinite(tt)&&bc>0,"Invalid operator epoch/coefficient");for(double value:x)NEED(std::isfinite(value),"Non-finite operator state");series[id][946728000000LL+int64_t(std::llround(tt*1000))]=x;++count;}NEED(count>=6,"Operator day lacks six calibration Doves");}
  NEED(kernel&&series.size()>=6,"Incomplete operator/environment batch");OEMT o;o.CCSDS_OEM_VERS=3;o.CREATION_DATE=iso(issue);o.ORIGINATOR="Planet Labs PBC; private local calibration input; CC BY-NC 4.0";o.COMMENT=lineage;o.MESSAGE_ID="open-dca-input-"+std::to_string(issue);
  for(const auto& [id,states]:series){auto block=std::make_unique<ephemerisDataBlockT>();block->OBJECT=std::make_unique<CATT>();block->OBJECT->OBJECT_ID=id;block->CENTER_NAME="EARTH";block->TIME_SYSTEM=timingStandard::TT;block->REFERENCE_FRAME=std::make_unique<RFMT>();block->REFERENCE_FRAME->NAME="EME2000";CelestialFrameWrapperT frame;frame.frame=CelestialFrame::EME2000;block->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(frame));for(const auto& [t,x]:states){auto line=std::make_unique<ephemerisDataLineT>();line->EPOCH=iso(t);line->X=x[0]/1000;line->Y=x[1]/1000;line->Z=x[2]/1000;line->X_DOT=x[3]/1000;line->Y_DOT=x[4]/1000;line->Z_DOT=x[5]/1000;block->EPHEMERIS_DATA_LINES.push_back(std::move(line));}o.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));}
  fb::FlatBufferBuilder ob;FinishSizePrefixedOEMBuffer(ob,OEM::Pack(ob,&o));if(push("operator_states","OEM.fbs","$OEM","OEM",ob))return 1;
  PRWT p;p.NATIVE_INPUT=std::make_unique<PRWNativeInputT>();p.NATIVE_INPUT->DESCRIPTOR=std::make_unique<NCDT>();p.NATIVE_INPUT->DESCRIPTOR->FORMAT=ncdContainerFormat::SPK_DAF;p.NATIVE_INPUT->DESCRIPTOR->SOURCE_BYTE_LENGTH=kernel->BODY()->size();p.NATIVE_INPUT->DESCRIPTOR->SOURCE_SHA256=ephem::sha256_hex(kernel->BODY()->data(),kernel->BODY()->size());p.NATIVE_INPUT->CONTENT.assign(kernel->BODY()->begin(),kernel->BODY()->end());fb::FlatBufferBuilder kb;FinishSizePrefixedPRWBuffer(kb,PRW::Pack(kb,&p));if(push("kernel","PRW.fbs","$PRW","PRW",kb))return 1;
  return 0;
}
extern "C" int wrap_weather(){PRWT p;p.SPACE_WEATHER=std::make_unique<PRWSpaceWeatherTableT>();NEED((stream(input("records"),p.SPACE_WEATHER->ROWS,[](fb::Verifier& v){return VerifySizePrefixedSPWBuffer(v);},[](const uint8_t* p){return GetSizePrefixedSPW(p);})),"Invalid licensed SPW stream");fb::FlatBufferBuilder b;FinishSizePrefixedPRWBuffer(b,PRW::Pack(b,&p));return push("space_weather","PRW.fbs","$PRW","PRW",b);}
extern "C" int wrap_eop(){PRWT p;p.EARTH_ORIENTATION=std::make_unique<PRWEarthOrientationT>();NEED((stream(input("records"),p.EARTH_ORIENTATION->ROWS,[](fb::Verifier& v){return VerifyEOPBuffer(v);},[](const uint8_t* p){return GetEOP(p);},true)),"Invalid EOP stream");fb::FlatBufferBuilder b;FinishSizePrefixedPRWBuffer(b,PRW::Pack(b,&p));return push("earth_orientation","PRW.fbs","$PRW","PRW",b);}
extern "C" int publish_correction(){
  auto f=input("calibration");NEED(f,"Correction required");fb::Verifier v(f->payload,f->payload_length);NEED(VerifyDCLBuffer(v),"Invalid DCL");auto r=GetDCL(f->payload);NEED(r->STATUS()==dclStatus::Solved&&r->PROVENANCE()&&r->CORRECTION()&&r->CORRECTION()->FORM()==dclCorrectionForm::LogDensityNodes&&(!r->OBJECTS()||r->OBJECTS()->size()==0)&&!r->STATES(),"Only aggregate solved log-density corrections may be published");
  auto native=std::unique_ptr<DCLT>(r->UnPack());fb::FlatBufferBuilder b;FinishSizePrefixedDCLBuffer(b,DCL::Pack(b,native.get()));R::IngestRequestT meta;meta.SCHEMA="DCL.fbs";meta.RECONCILE=R::reconcileMode_Current;meta.TAGS=std::make_unique<R::SourceTagsT>();auto& tags=*meta.TAGS;tags.PROVIDER_ID="open-dca";tags.SOURCE_NAME="planet-nrlmsise00";tags.BATCH_ID=ephem::sha256_hex(b.GetBufferPointer(),b.GetSize());tags.SOURCE_URL="https://ephemerides.planet-labs.com/";tags.LICENSE="CC-BY-NC-4.0";tags.LICENSE_URL="https://creativecommons.org/licenses/by-nc/4.0/";tags.CITATION="E13 aggregate; Planet Labs PBC CC BY-NC 4.0; GFZ CC BY 4.0; NOAA public domain; full attribution in DCL.PVN.";
  meta.PROVENANCE=std::make_unique<R::ProvenanceT>();meta.PROVENANCE->PARSER="open-dca";meta.PROVENANCE->PARSER_VERSION="0.1.0";meta.PROVENANCE->RETRIEVED_MS=r->CREATED_AT_MS();meta.PROVENANCE->NORMALIZED_COUNT=1;meta.PROVENANCE->SCHEMAS={"DCL.fbs"};meta.PROVENANCE->SCHEMA_COUNTS={1};meta.PROVENANCE->NORMALIZED_SHA256=tags.BATCH_ID;fb::FlatBufferBuilder mb;R::FinishIngestRequestBuffer(mb,R::IngestRequest::Pack(mb,&meta));if(push("meta","IngestRequest.fbs","INGQ","IngestRequest",mb))return 1;return push("records","DCL.fbs","$DCL","DCL",b);
}

// Optional node-owned archive mirror, following retrieval modules' typed CONFIG
// convention. Original request bytes travel in CONTEXT; restore the source URL
// and parser job before any parser sees the response. No raw inputs are stored.
extern "C" int route_request(){
  auto config=sdm_piv::get_config();
  const auto* entry=config.entry("open_dca_archive_url");
  const std::string base=entry&&entry->STRING_VALUE()?entry->STRING_VALUE()->str():"";
  NEED(base.empty()||base.rfind("http://127.0.0.1:",0)==0||base.rfind("https://",0)==0,"Archive mirror requires loopback or HTTPS");
  for(uint32_t i=0;i<plugin_get_input_count();++i){
    const auto* f=plugin_get_input_frame(i);fb::Verifier v(f->payload,f->payload_length);
    NEED(R::VerifyHttpRequestBuffer(v),"Expected request to route");
    auto q=std::unique_ptr<R::HttpRequestT>(R::GetHttpRequest(f->payload)->UnPack());
    // An explicit validator prevents a previous day's 304 from dropping an EOP join.
    auto h=std::make_unique<R::HeaderT>();h->NAME="if-modified-since";h->VALUE="Thu, 01 Jan 1970 00:00:00 GMT";q->HEADERS.push_back(std::move(h));
    if(!base.empty()){
      q->URL=base+"/"+ephem::sha256_hex(reinterpret_cast<const uint8_t*>(q->URL.data()),q->URL.size());
      q->CONTEXT.assign(f->payload,f->payload+f->payload_length);
    }
    fb::FlatBufferBuilder b;R::FinishHttpRequestBuffer(b,R::HttpRequest::Pack(b,q.get()));if(push("request","HttpRequest.fbs","HREQ","HttpRequest",b))return 1;
  }return 0;
}
extern "C" int restore_response(){
  for(uint32_t i=0;i<plugin_get_input_count();++i){
    const auto* f=plugin_get_input_frame(i);fb::Verifier v(f->payload,f->payload_length);
    NEED(R::VerifyHttpResponseBuffer(v),"Expected response to restore");
    auto r=std::unique_ptr<R::HttpResponseT>(R::GetHttpResponse(f->payload)->UnPack());
    fb::Verifier context(r->CONTEXT.data(),r->CONTEXT.size());
    if(r->CONTEXT.size()>8&&R::VerifyHttpRequestBuffer(context)){
      auto q=std::unique_ptr<R::HttpRequestT>(R::GetHttpRequest(r->CONTEXT.data())->UnPack());r->URL=q->URL;r->CONTEXT=q->CONTEXT;
    }
    fb::FlatBufferBuilder b;R::FinishHttpResponseBuffer(b,R::HttpResponse::Pack(b,r.get()));if(push("response","HttpResponse.fbs","HRSP","HttpResponse",b))return 1;
  }return 0;
}
