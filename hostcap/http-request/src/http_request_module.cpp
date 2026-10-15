/*
 * hostcap/http-request — the host http.request connector (typed contracts 1.0).
 *
 *   request — "request" frames, each an HttpRequest (HREQ, module-sdk runtime type)
 *             -> one http.request hostcall each (SDS $PIV: HttpParams aligned record + raw "url" /
 *                "headers" / "body" frames)
 *             -> one "response" frame each, an HttpResponse (HRSP), in input order.
 *
 * No JSON and no base64 anywhere: the request body, the response body and the request's CONTEXT travel verbatim.
 * A request the host refuses or fails (policy, timeout, a body over MAX_BYTES) still answers with an HttpResponse
 * whose STATUS is 0 and ERROR says why, so a downstream node always gets exactly one response per request.
 *
 * THIS IS A FAN-IN PORT: the flow runtime may deliver every queued request in one invocation; all are answered.
 */

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

std::string lower(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

// The request's headers as the hostcall's raw "headers" block ("name: value" lines).
std::string header_block(const R::HttpRequest& request) {
    std::string block;
    if (!request.HEADERS()) return block;
    for (const auto* header : *request.HEADERS()) {
        if (!header || !header->NAME()) continue;
        if (!block.empty()) block += "\r\n";
        block += header->NAME()->str();
        block += ": ";
        if (header->VALUE()) block += header->VALUE()->str();
    }
    return block;
}

// The host's raw "headers" block back as Header tables, lower-cased and sorted by NAME (a FlatBuffers key).
std::vector<flatbuffers::Offset<R::Header>> parse_headers(flatbuffers::FlatBufferBuilder& b, std::string_view block) {
    std::vector<std::pair<std::string, std::string>> pairs;
    size_t at = 0;
    while (at < block.size()) {
        size_t end = block.find('\n', at);
        if (end == std::string_view::npos) end = block.size();
        std::string_view line = block.substr(at, end - at);
        if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
        const size_t colon = line.find(':');
        if (colon != std::string_view::npos && colon > 0) {
            std::string_view value = line.substr(colon + 1);
            while (!value.empty() && value.front() == ' ') value.remove_prefix(1);
            pairs.emplace_back(lower(line.substr(0, colon)), std::string(value));
        }
        at = end + 1;
    }
    std::stable_sort(pairs.begin(), pairs.end(), [](const auto& l, const auto& r) { return l.first < r.first; });
    std::vector<flatbuffers::Offset<R::Header>> headers;
    for (const auto& [name, value] : pairs) headers.push_back(R::CreateHeaderDirect(b, name.c_str(), value.c_str()));
    return headers;
}

int push_response(flatbuffers::FlatBufferBuilder& b) {
    return plugin_push_output_ex("response", "HttpResponse.fbs", R::HttpResponseIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "HttpResponse", 0, 0, b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

// One request -> one response frame. Returns the output index, negative when the push was refused.
int answer(const R::HttpRequest& request) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto* context = request.CONTEXT();
    const auto echo = [&]() { return context ? b.CreateVector(context->data(), context->size()) : 0; };
    const std::string url = request.URL() ? request.URL()->str() : std::string();

    A::HttpParams params{};
    std::string method = request.METHOD() && request.METHOD()->size() ? request.METHOD()->str() : std::string("GET");
    if (!sdm_piv::put(params.METHOD, method)) {
        R::FinishHttpResponseBuffer(b, R::CreateHttpResponse(b, b.CreateString(url), 0, 0, 0, echo(), b.CreateString("method too long")));
        return push_response(b);
    }
    params.set_has_METHOD(true);
    params.TIMEOUT_MS = request.TIMEOUT_MS();
    params.MAX_BYTES = request.MAX_BYTES();

    const std::string headers = header_block(request);
    std::vector<sdm_piv::Frame> frames{sdm_piv::raw("url", url)};
    if (!headers.empty()) frames.push_back(sdm_piv::raw("headers", headers));
    if (request.BODY() && request.BODY()->size()) frames.push_back(sdm_piv::raw("body", request.BODY()->data(), request.BODY()->size()));

    std::vector<sdm_piv::Frame> all{{"params", reinterpret_cast<const uint8_t*>(&params), sizeof params, "HttpParams",
                                     static_cast<uint32_t>(sizeof params), static_cast<uint16_t>(alignof(A::HttpParams))}};
    all.insert(all.end(), frames.begin(), frames.end());
    const auto response = sdm_piv::call_frames("http.request", all);

    if (!response.ok()) {
        const std::string why = response.error_code() + ": " + response.error_message();
        R::FinishHttpResponseBuffer(b, R::CreateHttpResponse(b, b.CreateString(url), 0, 0, 0, echo(), b.CreateString(why)));
        return push_response(b);
    }
    const auto* result = response.result<A::HttpResult>("HttpResult");
    const std::string_view body = response.raw("body");
    const std::string_view answered = response.raw("url");
    const auto header_list = parse_headers(b, response.raw("headers"));
    const auto url_offset = b.CreateString(answered.empty() ? url : std::string(answered));
    const auto headers_offset = b.CreateVector(header_list);
    const auto body_offset = b.CreateVector(reinterpret_cast<const uint8_t*>(body.data()), body.size());
    const auto context_offset = echo();
    R::FinishHttpResponseBuffer(b, R::CreateHttpResponse(b, url_offset, result ? result->STATUS : 0, headers_offset, body_offset,
                                                         context_offset, 0, result ? result->RETRIEVED_MS : 0));
    return push_response(b);
}

}  // namespace

extern "C" {

// request: every "request" frame (HttpRequest) -> one "response" frame (HttpResponse), in input order. A frame
// that is not a valid HttpRequest is refused with an error; the requests before it keep their responses.
int request(void) {
    const uint32_t input_count = plugin_get_input_count();
    uint32_t answered = 0;
    for (uint32_t i = 0; i < input_count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id || std::strcmp(frame->port_id, "request") != 0) continue;
        flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (!R::VerifyHttpRequestBuffer(verifier) || !R::GetHttpRequest(frame->payload)->URL()) {
            plugin_set_error("invalid-request", "a request frame is not an HttpRequest (HREQ) with a URL");
            return 1;
        }
        if (answer(*R::GetHttpRequest(frame->payload)) < 0) return 1;  // the invoke glue set the error
        ++answered;
    }
    if (answered == 0) {
        plugin_set_error("missing-request-frame", "request needs at least one HttpRequest frame on \"request\"");
        return 1;
    }
    return 0;
}

}  // extern "C"
