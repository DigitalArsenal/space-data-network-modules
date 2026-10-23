// Lane glue of the Earth-orientation publication flow: one typed frame in, one typed frame out. No parsing, network,
// clock or physics here; every decision about the file stays in eop-request and eop-parser.
//
//   route_request     The request for the file, with an explicit validator so a full response comes back. The host
//                     presents the validators of the last fetch of a URL, and the open-DCA flow on the same node fetches
//                     this very file: a conditional request could be answered "not modified" for a copy this lane never
//                     stored. When the node keeps a mirror of the file (config eop_archive_url, loopback or HTTPS), the
//                     request is aimed at it.
//   restore_response  The mirror's response carries the request it answered; the parser sees the response of the file.
//   attribute_lane    The parser's IngestRequest names the batch and the file. The lane's identity and the licence the
//                     host publishes with the batch are added, and a newer edition replaces the stored one.
//
// Method names avoid the words of libc++'s pragmas: the SDK renames every method symbol with a -D macro of the same name.
#include <memory>
#include <string>
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
namespace {
namespace R = sdn::runtime;
namespace fb = flatbuffers;
// Full response, whatever any other flow on this node fetched last: nothing was modified before 1970.
constexpr const char* validator = "Thu, 01 Jan 1970 00:00:00 GMT";
constexpr const char* source_prefix = "https://maia.usno.navy.mil/";
constexpr const char* provider = "eop";
constexpr const char* source = "usno-finals2000a";
// 17 U.S.C. 105: a work of the United States Government has no copyright protection.
constexpr const char* license = "LicenseRef-US-Government-Work-Public-Domain";
constexpr const char* license_url = "https://www.copyright.gov/title17/92chap1.html#105";
constexpr const char* citation =
    "U.S. Naval Observatory, IERS Rapid Service/Prediction Center: finals2000A (Bulletin A columns), "
    "https://maia.usno.navy.mil/ser7/finals2000A.all. U.S. Government work, public domain.";
int fail(const char* text) {
  plugin_set_error("eop-lane", text);
  return 1;
}
#define NEED(condition, text) \
  do { if (!(condition)) return fail(text); } while (0)
const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
}
int push(const char* port, const char* schema, const char* identifier, const char* root, const fb::FlatBufferBuilder& b) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                               b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 1 : 0;
}
}  // namespace
extern "C" int route_request() {
  const auto* frame = input("request");
  NEED(frame && frame->payload, "An HttpRequest is required.");
  fb::Verifier verifier(frame->payload, frame->payload_length);
  NEED(R::VerifyHttpRequestBuffer(verifier), "Expected an HttpRequest.");
  auto request = std::unique_ptr<R::HttpRequestT>(R::GetHttpRequest(frame->payload)->UnPack());
  auto header = std::make_unique<R::HeaderT>();
  header->NAME = "if-modified-since";
  header->VALUE = validator;
  request->HEADERS.push_back(std::move(header));
  auto config = sdm_piv::get_config();
  const auto* entry = config.entry("eop_archive_url");
  const std::string mirror = entry && entry->STRING_VALUE() ? entry->STRING_VALUE()->str() : "";
  NEED(mirror.empty() || mirror.rfind("http://127.0.0.1:", 0) == 0 || mirror.rfind("https://", 0) == 0,
       "The archive mirror must be loopback or HTTPS.");
  if (!mirror.empty()) {
    request->URL = mirror + "/" + ephem::sha256_hex(reinterpret_cast<const uint8_t*>(request->URL.data()), request->URL.size());
    request->CONTEXT.assign(frame->payload, frame->payload + frame->payload_length);
  }
  fb::FlatBufferBuilder b;
  R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, request.get()));
  return push("request", "HttpRequest.fbs", "HREQ", "HttpRequest", b);
}
extern "C" int restore_response() {
  const auto* frame = input("response");
  NEED(frame && frame->payload, "An HttpResponse is required.");
  fb::Verifier verifier(frame->payload, frame->payload_length);
  NEED(R::VerifyHttpResponseBuffer(verifier), "Expected an HttpResponse.");
  auto response = std::unique_ptr<R::HttpResponseT>(R::GetHttpResponse(frame->payload)->UnPack());
  // Only a mirrored request put its own bytes in CONTEXT; the parser's job (a size-prefixed $ICN) is never an HttpRequest.
  if (response->CONTEXT.size() > 8) {
    fb::Verifier context(response->CONTEXT.data(), response->CONTEXT.size());
    if (R::VerifyHttpRequestBuffer(context)) {
      auto original = std::unique_ptr<R::HttpRequestT>(R::GetHttpRequest(response->CONTEXT.data())->UnPack());
      response->URL = original->URL;
      response->CONTEXT = original->CONTEXT;
    }
  }
  fb::FlatBufferBuilder b;
  R::FinishHttpResponseBuffer(b, R::HttpResponse::Pack(b, response.get()));
  return push("response", "HttpResponse.fbs", "HRSP", "HttpResponse", b);
}
extern "C" int attribute_lane() {
  const auto* frame = input("meta");
  NEED(frame && frame->payload, "An IngestRequest is required.");
  fb::Verifier verifier(frame->payload, frame->payload_length);
  NEED(R::VerifyIngestRequestBuffer(verifier), "Expected an IngestRequest.");
  auto meta = std::unique_ptr<R::IngestRequestT>(R::GetIngestRequest(frame->payload)->UnPack());
  // The licence below is the Rapid Service's, and only its finals2000A batch may carry it.
  NEED(meta->SCHEMA == "EOP.fbs" && meta->TAGS && meta->PROVENANCE && meta->PROVENANCE->PARSER == "eop-parser" &&
           meta->PROVENANCE->PARSER_VERSION == "finals2000a" && meta->TAGS->SOURCE_URL.rfind(source_prefix, 0) == 0,
       "Only eop-parser's finals2000A batch from the U.S. Naval Observatory is published on this lane.");
  meta->RECONCILE = R::reconcileMode_Current;
  auto& tags = *meta->TAGS;
  tags.PROVIDER_ID = provider;
  tags.SOURCE_NAME = source;
  tags.LICENSE = license;
  tags.LICENSE_URL = license_url;
  tags.CITATION = citation;
  fb::FlatBufferBuilder b;
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, meta.get()));
  return push("meta", "IngestRequest.fbs", "INGQ", "IngestRequest", b);
}
