#include <cstring>
#include <string>
#include <vector>
#include "space_data_module_invoke.h"
namespace {
int reply(uint16_t status, const uint8_t* bytes, size_t length) {
 flatbuffers::FlatBufferBuilder b;
 std::vector<flatbuffers::Offset<sdn::http::HttpHeader>> h;
 h.push_back(sdn::http::CreateHttpHeader(b,b.CreateString("content-type"),b.CreateString(status==200?"application/vnd.sdn.flatbuffers.stream":"text/plain; charset=utf-8")));
 h.push_back(sdn::http::CreateHttpHeader(b,b.CreateString("cache-control"),b.CreateString("no-store")));
 h.push_back(sdn::http::CreateHttpHeader(b,b.CreateString("x-content-type-options"),b.CreateString("nosniff")));
 auto headers=b.CreateVectorOfSortedTables(&h); auto body=b.CreateVector(bytes,length);
 auto response=sdn::http::CreateHttpResponse(b,status,headers,body);
 sdn::http::FinishHttpResponseBuffer(b,response);
 return plugin_push_output_ex("response","HttpResponseAbi.fbs","$HTR",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpResponse",0,0,b.GetBufferPointer(),b.GetSize()) < 0 ? 500:0;
}
int error(uint16_t status,const char* text) {return reply(status,reinterpret_cast<const uint8_t*>(text),std::strlen(text));}
const plugin_input_frame_t* one(const char* port) {
 if(plugin_find_input_index(port,1)>=0) return nullptr;
 auto i=plugin_find_input_index(port,0);return i<0?nullptr:plugin_get_input_frame(i);
}
bool cqr(const uint8_t* p,size_t n) {return p&&n>=8&&std::memcmp(p+4,"$CQR",4)==0;}
}
extern "C" {
int route(void) {
 const auto* f=one("http");if(!f||!f->payload||f->payload_length<8)return error(400,"Expected one HTTP request");
 flatbuffers::Verifier v(f->payload,f->payload_length);
 if(!sdn::http::HttpRequestBufferHasIdentifier(f->payload)||!sdn::http::VerifyHttpRequestBuffer(v))return error(400,"Invalid HTTP request envelope");
 const auto* r=sdn::http::GetHttpRequest(f->payload);
 if(!r->METHOD()||r->METHOD()->str()!="POST")return error(405,"Use POST with a canonical CQR FlatBuffer");
 const auto* body=r->BODY();if(!body||!cqr(body->data(),body->size()))return error(400,"Expected a canonical CQR FlatBuffer");
 if(body->size()>4*1024*1024)return error(413,"Science request exceeds 4 MiB");
 // Full CQR verification and scientific limits belong to the connected module.
 return plugin_push_output_ex("request","CQR.fbs","$CQR",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"CQR",0,0,body->data(),body->size())<0?500:0;
}
int respond(void) {
 std::vector<uint8_t> stream;
 for(uint32_t index=0;;index++) {
  auto i=plugin_find_input_index("result",index);if(i<0)break;
  const auto* f=plugin_get_input_frame(i);
  if(!f||!cqr(f->payload,f->payload_length))return error(502,"Invalid CQR result from science module");
  const uint32_t n=f->payload_length; const size_t start=stream.size();
  stream.resize(start+((size_t(n)+4+7)&~size_t(7)),0);
  for(int j=0;j<4;j++)stream[start+j]=uint8_t(n>>(8*j));
  std::memcpy(stream.data()+start+4,f->payload,n);
 }
 if(stream.empty())return error(502,"Missing CQR result from science module");
 return reply(200,stream.data(),stream.size());
}
}
