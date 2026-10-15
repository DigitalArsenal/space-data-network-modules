/*
 * foundation/http-route — the HTTP edge's parser (typed contracts 1.0).
 *
 * One $HTQ HttpRequest envelope (the SDK's WASM-served HTTP request) in, exactly ONE typed routing decision out. Pure
 * compute: no capabilities, no hostcalls. Every HTTP semantic lives here (path routing, query-string parsing,
 * If-None-Match, representation negotiation, request-body parsing); nothing downstream re-parses the transport.
 *
 *   route               (data retrieval)  -> "bulk"    $QRP Request  "/<code>/bulk": a whole-record read of one standard
 *                                            "query"   $QRP Request  "/query": SQL from the request body
 *                                            "refusal" $QRP Error    anything else, or a request that cannot be served
 *   discover            (network discovery) -> "decision" $APR       peers_list | peer_get | pnm_history | latest_dataset
 *                                                                    | standards, or a refusal (STATUS set)
 *   route_public_query  (public query)    -> "query"   $QRP Request  POST: sandboxed SQL or a named time profile
 *                                            "surface" $QRP Request  GET/HEAD: the queryable surface
 *                                            "refusal" $QRP Error
 *   route_node_status   -> "decision" $APR  route "status" (GET/HEAD) or STATUS 405
 *   route_node_activity -> "decision" $APR  route "activity" + parameter limit (clamped [1,256], default 50) or 405
 *
 * The query/data routes are decided as $QRP, the others as $APR; a method that can decide more than one way answers
 * on more than one port so that every port carries exactly one type. A refusal is a decision too: the responder
 * answers it (QRP ERROR_CODE / APR STATUS), so a request is never dropped.
 *
 * JSON appears only where the CLIENT sent it: the body of POST /query and of the public query is the external request
 * representation, parsed here into typed fields. No JSON leaves this node.
 *
 * Representation: ?format=json (or an Accept header naming application/json and no FlatBuffers type) asks for Json;
 * ?format=flatbuffer|flatbuffers|fb (or an Accept header naming x-flatbuffers / vnd.sdn.flatbuffers) asks for
 * FlatBuffer; otherwise Default (the service default, FlatBuffers). ?format wins over Accept.
 *
 * The SDK HTTP ABI header (HttpRequestAbi_generated.h), the SDS APR and QRP headers and src/bulk_route.h are inlined by
 * build.mjs; this file holds the method bodies.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

bool ends_with(const std::string& value, const char* suffix) {
    const size_t n = std::strlen(suffix);
    return value.size() >= n && std::memcmp(value.data() + value.size() - n, suffix, n) == 0;
}

std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// application/x-www-form-urlencoded component decoding: %XX and '+' -> ' '.
std::string percent_decode(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); i++) {
        const char c = in[i];
        if (c == '+') {
            out.push_back(' ');
        } else if (c == '%' && i + 2 < in.size() && hex_nibble(in[i + 1]) >= 0 && hex_nibble(in[i + 2]) >= 0) {
            out.push_back(static_cast<char>((hex_nibble(in[i + 1]) << 4) | hex_nibble(in[i + 2])));
            i += 2;
        } else {
            out.push_back(c);
        }
    }
    return out;
}

struct QueryParam {
    std::string key;
    std::string value;
};

std::vector<QueryParam> parse_query_string(const std::string& raw) {
    std::vector<QueryParam> params;
    size_t start = 0;
    while (start <= raw.size()) {
        size_t end = raw.find('&', start);
        if (end == std::string::npos) end = raw.size();
        if (end > start) {
            const std::string pair = raw.substr(start, end - start);
            const size_t eq = pair.find('=');
            if (eq == std::string::npos) params.push_back({percent_decode(pair), std::string()});
            else params.push_back({percent_decode(pair.substr(0, eq)), percent_decode(pair.substr(eq + 1))});
        }
        if (end == raw.size()) break;
        start = end + 1;
    }
    return params;
}

const std::string* find_param(const std::vector<QueryParam>& params, const char* key) {
    for (const auto& p : params) if (p.key == key) return &p.value;
    return nullptr;
}

// Full-string integer parse (garbage or partial values are not numbers).
bool parse_long(const std::string& text, long* out) {
    if (text.empty()) return false;
    char* end = nullptr;
    const long v = std::strtol(text.c_str(), &end, 10);
    if (end == text.c_str() || !end || *end != '\0') return false;
    *out = v;
    return true;
}

// ---------------------------------------------------------------------------
// Epoch: unix seconds (integer or fractional) or RFC3339 UTC "YYYY-MM-DDTHH:MM:SS(.frac)Z". Proleptic-Gregorian
// civil days (Howard Hinnant, "chrono-Compatible Low-Level Date Algorithms"); no clock or zone database.
// ---------------------------------------------------------------------------

int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2u) / 5u + d - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097LL + static_cast<int64_t>(doe) - 719468LL;
}

bool parse_epoch_seconds(const std::string& value, double* out) {
    if (value.empty()) return false;
    if (value.find('T') == std::string::npos) {
        char* end = nullptr;
        const double numeric = std::strtod(value.c_str(), &end);
        if (end == value.c_str() || !end || *end != '\0' || !std::isfinite(numeric)) return false;
        *out = numeric;
        return true;
    }
    int year = 0;
    unsigned month = 0, day = 0, hour = 0, minute = 0;
    double seconds = 0.0;
    int consumed = 0;
    if (std::sscanf(value.c_str(), "%d-%u-%uT%u:%u:%lf%n", &year, &month, &day, &hour, &minute, &seconds, &consumed) != 6) {
        return false;
    }
    if (value[static_cast<size_t>(consumed)] != 'Z' || static_cast<size_t>(consumed) + 1 != value.size()) return false;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || seconds < 0.0 || seconds >= 61.0) {
        return false;
    }
    *out = static_cast<double>(days_from_civil(year, month, day)) * 86400.0 + hour * 3600.0 + minute * 60.0 + seconds;
    return true;
}

int64_t epoch_ms(double seconds) { return static_cast<int64_t>(std::llround(seconds * 1000.0)); }

// ---------------------------------------------------------------------------
// A small JSON reader for the CLIENT's request bodies (the external representation; nothing here is emitted).
// ---------------------------------------------------------------------------

struct Json {
    enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
    bool boolean = false;
    double number = 0.0;
    std::string text;  // String value, or the number's source text (exact integers)
    std::vector<Json> items;
    std::vector<std::pair<std::string, Json>> members;

    const Json* get(const char* key) const {
        if (kind != Object) return nullptr;
        for (const auto& m : members) if (m.first == key) return &m.second;
        return nullptr;
    }
};

class JsonReader {
 public:
    explicit JsonReader(const std::string& s) : s_(s) {}
    bool parse(Json* out) {
        if (!value(out, 0)) return false;
        ws();
        return i_ == s_.size();
    }

 private:
    void ws() { while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) i_++; }
    bool lit(const char* word) {
        const size_t n = std::strlen(word);
        if (s_.compare(i_, n, word) != 0) return false;
        i_ += n;
        return true;
    }
    static void utf8(std::string* out, uint32_t cp) {
        if (cp < 0x80) out->push_back(static_cast<char>(cp));
        else if (cp < 0x800) { out->push_back(static_cast<char>(0xC0 | (cp >> 6))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
        else if (cp < 0x10000) { out->push_back(static_cast<char>(0xE0 | (cp >> 12))); out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
        else { out->push_back(static_cast<char>(0xF0 | (cp >> 18))); out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F))); out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    }
    bool hex4(uint32_t* cp) {
        if (i_ + 4 > s_.size()) return false;
        uint32_t v = 0;
        for (int k = 0; k < 4; k++) {
            const int n = hex_nibble(s_[i_ + k]);
            if (n < 0) return false;
            v = (v << 4) | static_cast<uint32_t>(n);
        }
        i_ += 4;
        *cp = v;
        return true;
    }
    bool string(std::string* out) {
        if (i_ >= s_.size() || s_[i_] != '"') return false;
        i_++;
        while (i_ < s_.size() && s_[i_] != '"') {
            const char c = s_[i_++];
            if (c != '\\') { out->push_back(c); continue; }
            if (i_ >= s_.size()) return false;
            const char e = s_[i_++];
            switch (e) {
                case '"': out->push_back('"'); break;
                case '\\': out->push_back('\\'); break;
                case '/': out->push_back('/'); break;
                case 'b': out->push_back('\b'); break;
                case 'f': out->push_back('\f'); break;
                case 'n': out->push_back('\n'); break;
                case 'r': out->push_back('\r'); break;
                case 't': out->push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!hex4(&cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00 && i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                        i_ += 2;
                        uint32_t low = 0;
                        if (!hex4(&low) || low < 0xDC00 || low > 0xDFFF) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    }
                    utf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
        if (i_ >= s_.size()) return false;
        i_++;
        return true;
    }
    bool value(Json* out, int depth) {
        if (depth > 32) return false;
        ws();
        if (i_ >= s_.size()) return false;
        const char c = s_[i_];
        if (c == '{') {
            out->kind = Json::Object;
            i_++;
            ws();
            if (i_ < s_.size() && s_[i_] == '}') { i_++; return true; }
            while (true) {
                ws();
                std::string key;
                if (!string(&key)) return false;
                ws();
                if (i_ >= s_.size() || s_[i_] != ':') return false;
                i_++;
                Json v;
                if (!value(&v, depth + 1)) return false;
                out->members.emplace_back(std::move(key), std::move(v));
                ws();
                if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
                if (i_ < s_.size() && s_[i_] == '}') { i_++; return true; }
                return false;
            }
        }
        if (c == '[') {
            out->kind = Json::Array;
            i_++;
            ws();
            if (i_ < s_.size() && s_[i_] == ']') { i_++; return true; }
            while (true) {
                Json v;
                if (!value(&v, depth + 1)) return false;
                out->items.push_back(std::move(v));
                ws();
                if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
                if (i_ < s_.size() && s_[i_] == ']') { i_++; return true; }
                return false;
            }
        }
        if (c == '"') { out->kind = Json::String; return string(&out->text); }
        if (lit("true")) { out->kind = Json::Bool; out->boolean = true; return true; }
        if (lit("false")) { out->kind = Json::Bool; out->boolean = false; return true; }
        if (lit("null")) { out->kind = Json::Null; return true; }
        const size_t start = i_;
        if (s_[i_] == '-') i_++;
        while (i_ < s_.size() && ((s_[i_] >= '0' && s_[i_] <= '9') || s_[i_] == '.' || s_[i_] == 'e' || s_[i_] == 'E' || s_[i_] == '+' || s_[i_] == '-')) i_++;
        if (i_ == start) return false;
        out->kind = Json::Number;
        out->text = s_.substr(start, i_ - start);
        char* end = nullptr;
        out->number = std::strtod(out->text.c_str(), &end);
        return end && *end == '\0';
    }

    const std::string& s_;
    size_t i_ = 0;
};

bool body_is_object(const std::string& body) {
    for (const char c : body) {
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
        return c == '{';
    }
    return false;
}

std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\n' || s[a] == '\r')) a++;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\n' || s[b - 1] == '\r')) b--;
    return s.substr(a, b - a);
}

bool base64_decode(const std::string& in, std::vector<uint8_t>* out) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+' || c == '-') return 62;
        if (c == '/' || c == '_') return 63;
        return -1;
    };
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : in) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        const int v = val(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return true;
}

// One client parameter -> a typed QRPValue. Tagged {"t":"i64|f64|str|bool|null|bytes","v":...} (the node API's tagged
// form; bytes are base64) or a bare JSON scalar. false + why when the value has no typed reading.
bool parameter_value(const Json& p, QRPValueT* out, std::string* why) {
    const Json* tag = p.kind == Json::Object ? p.get("t") : nullptr;
    if (tag && tag->kind == Json::String) {
        const Json* v = p.get("v");
        const std::string& t = tag->text;
        if (t == "null") { out->KIND = qrpValueKind_Null; return true; }
        if (!v) { *why = "tagged parameter has no \"v\""; return false; }
        if (t == "bool" && v->kind == Json::Bool) { out->KIND = qrpValueKind_Bool; out->BOOL_VALUE = v->boolean; return true; }
        if (t == "i64" && (v->kind == Json::Number || v->kind == Json::String)) {
            char* end = nullptr;
            const long long n = std::strtoll(v->text.c_str(), &end, 10);
            if (!end || *end != '\0' || v->text.empty()) { *why = "i64 parameter is not an integer"; return false; }
            out->KIND = qrpValueKind_Int;
            out->INT_VALUE = n;
            return true;
        }
        if (t == "f64" && v->kind == Json::Number) { out->KIND = qrpValueKind_Float; out->FLOAT_VALUE = v->number; return true; }
        if (t == "str" && v->kind == Json::String) { out->KIND = qrpValueKind_Text; out->TEXT_VALUE = v->text; return true; }
        if (t == "bytes" && v->kind == Json::String) {
            out->KIND = qrpValueKind_Bytes;
            if (!base64_decode(v->text, &out->BYTES_VALUE)) { *why = "bytes parameter is not base64"; return false; }
            return true;
        }
        *why = "parameter tag \"" + t + "\" does not match its value";
        return false;
    }
    switch (p.kind) {
        case Json::Null: out->KIND = qrpValueKind_Null; return true;
        case Json::Bool: out->KIND = qrpValueKind_Bool; out->BOOL_VALUE = p.boolean; return true;
        case Json::String: out->KIND = qrpValueKind_Text; out->TEXT_VALUE = p.text; return true;
        case Json::Number: {
            const bool integral = p.text.find_first_of(".eE") == std::string::npos;
            if (integral) {
                char* end = nullptr;
                const long long n = std::strtoll(p.text.c_str(), &end, 10);
                if (end && *end == '\0') { out->KIND = qrpValueKind_Int; out->INT_VALUE = n; return true; }
            }
            out->KIND = qrpValueKind_Float;
            out->FLOAT_VALUE = p.number;
            return true;
        }
        default: *why = "a parameter must be a scalar or a tagged {\"t\",\"v\"} object"; return false;
    }
}

bool parameters_from(const Json* params, std::vector<std::unique_ptr<QRPValueT>>* out, std::string* why) {
    if (!params || params->kind == Json::Null) return true;
    if (params->kind != Json::Array) { *why = "\"params\" must be an array"; return false; }
    for (size_t i = 0; i < params->items.size(); i++) {
        auto value = std::make_unique<QRPValueT>();
        std::string detail;
        if (!parameter_value(params->items[i], value.get(), &detail)) {
            *why = "params[" + std::to_string(i) + "]: " + detail;
            return false;
        }
        out->push_back(std::move(value));
    }
    return true;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

struct Request {
    std::string method;
    std::string path;
    std::vector<QueryParam> query;
    std::string body;
    std::string if_none_match;
    std::string accept_header;
};

aprMethod method_of(const std::string& m) {
    if (m == "GET") return aprMethod_GET;
    if (m == "HEAD") return aprMethod_HEAD;
    if (m == "POST") return aprMethod_POST;
    if (m == "PUT") return aprMethod_PUT;
    if (m == "PATCH") return aprMethod_PATCH;
    if (m == "DELETE") return aprMethod_DELETE;
    if (m == "OPTIONS") return aprMethod_OPTIONS;
    return aprMethod_Unspecified;
}

// 0 Default, 1 FlatBuffer, 2 Json (aprRepresentation and qrpRepresentation share these values).
int representation_of(const Request& r, const std::string* body_format = nullptr) {
    auto from_format = [](const std::string& f) -> int {
        const std::string v = lower(f);
        if (v == "json") return 2;
        if (v == "flatbuffer" || v == "flatbuffers" || v == "fb") return 1;
        return -1;
    };
    if (const std::string* f = find_param(r.query, "format")) {
        const int v = from_format(*f);
        if (v >= 0) return v;
        if (!f->empty()) return 0;
    }
    if (body_format) {
        const int v = from_format(*body_format);
        if (v >= 0) return v;
    }
    const std::string accept = lower(r.accept_header);
    if (accept.find("flatbuffers") != std::string::npos) return 1;
    if (accept.find("application/json") != std::string::npos) return 2;
    return 0;
}

// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`. The compiled flow runtime fills an
// invocation by popping the node's queue PORT-BLIND (drain budget 64); maxStreams / maxBatch / drainPolicy are
// declarative only. Every method here answers ONE HTTP request, so a second request frame is refused by name rather
// than silently destroyed (an answer from whichever frame the queue held first is arbitrary and looks correct).
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id || std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

// Read the one $HTQ request. Returns 0, or the invoke status after setting the node error.
int read_request(const char* method_name, Request* out) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof batch_message)) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length < 8) {
        const std::string message = std::string(method_name) + " requires a $HTQ HttpRequest frame on port \"request\".";
        plugin_set_error("missing-request-frame", message.c_str());
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::HttpRequestBufferHasIdentifier(frame->payload) || !sdn::http::VerifyHttpRequestBuffer(verifier)) {
        const std::string message = std::string(method_name) + " input frame is not a valid $HTQ HttpRequest buffer.";
        plugin_set_error("invalid-request-frame", message.c_str());
        return 400;
    }
    const sdn::http::HttpRequest* request = sdn::http::GetHttpRequest(frame->payload);
    if (request->METHOD()) out->method = request->METHOD()->str();
    if (request->PATH()) out->path = request->PATH()->str();
    if (request->QUERY()) out->query = parse_query_string(request->QUERY()->str());
    if (request->BODY()) out->body.assign(reinterpret_cast<const char*>(request->BODY()->data()), request->BODY()->size());
    if (const auto* headers = request->HEADERS()) {
        for (const auto* header : *headers) {
            if (!header || !header->NAME()) continue;
            const std::string name = lower(header->NAME()->str());
            const std::string value = header->VALUE() ? header->VALUE()->str() : std::string();
            if (name == "if-none-match" && out->if_none_match.empty()) out->if_none_match = value;
            if (name == "accept" && out->accept_header.empty()) out->accept_header = value;
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Emitting decisions
// ---------------------------------------------------------------------------

int push_apr(const APRT& apr) {
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &apr));
    return plugin_push_output_ex("decision", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

int push_qrp(const char* port, const QRPT& qrp) {
    flatbuffers::FlatBufferBuilder b(512);
    FinishQRPBuffer(b, QRP::Pack(b, &qrp));
    return plugin_push_output_ex(port, "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

APRT apr_for(const Request& r) {
    APRT apr;
    apr.METHOD = method_of(r.method);
    apr.PATH = r.path;
    apr.IF_NONE_MATCH = r.if_none_match;
    apr.ACCEPT = static_cast<aprRepresentation>(representation_of(r));
    return apr;
}

void add_parameter(APRT* apr, const char* name, const std::string& value) {
    auto p = std::make_unique<APRParameterT>();
    p->NAME = name;
    p->VALUE = value;
    apr->PARAMETERS.push_back(std::move(p));
}

int apr_refusal(APRT apr, uint16_t status, const char* code, const std::string& message) {
    apr.STATUS = status;
    apr.ERROR_CODE = code;
    apr.ERROR_MESSAGE = message;
    return push_apr(apr);
}

QRPT qrp_request(const Request& r, int representation) {
    QRPT q;
    q.KIND = qrpKind_Request;
    q.REPRESENTATION = static_cast<qrpRepresentation>(representation);
    q.ETAG = r.if_none_match;
    return q;
}

// A refusal of a query/data route: one QRP Error on "refusal", carrying what the responder needs to render it.
int qrp_refusal(const Request& r, int representation, const char* code, const std::string& message) {
    QRPT q = qrp_request(r, representation);
    q.KIND = qrpKind_Error;
    q.STATUS = qrpStatus_Error;
    q.ERROR_CODE = code;
    q.MESSAGE = message;
    const std::string c(code);
    q.HTTP_STATUS = c == "no-route" ? 404 : c == "method-not-allowed" ? 405 : c == "not-acceptable" ? 406 : 400;
    return push_qrp("refusal", q);
}

// Time-profile names, as the HTTP API spells them ("epoch." prefix tolerated). -1 = not a profile.
int time_profile_of(const std::string& name) {
    std::string p = lower(name);
    if (p.rfind("epoch.", 0) == 0) p = p.substr(6);
    if (p == "nearest") return qrpTimeProfile_Nearest;
    if (p == "as_of" || p == "asof") return qrpTimeProfile_AsOf;
    if (p == "forward") return qrpTimeProfile_Forward;
    if (p == "latest") return qrpTimeProfile_Latest;
    if (p == "all") return qrpTimeProfile_All;
    return -1;
}

}  // namespace

extern "C" {

// route: one $HTQ -> exactly one of "bulk" / "query" / "refusal" (each a $QRP).
int route(void) {
    Request r;
    if (const int status = read_request("route", &r)) return status;
    const int representation = representation_of(r);

    // Per-schema bulk read: "<code>/bulk" names the standard (src/bulk_route.h decides only the path's SHAPE).
    const std::string bulk_schema = sdn_http_route::bulk_route_schema(r.path);
    if (!bulk_schema.empty()) {
        if (representation == 2 && !sdn_http_route::json_encode_available(bulk_schema)) {
            // The responder renders JSON for $OMM records only; rendering another standard's bytes as OMM would be
            // confident nonsense, so the request is refused and told which representation exists.
            return qrp_refusal(r, representation, "not-acceptable",
                               "json encoding is not available for " + bulk_schema + "; request format=flatbuffer");
        }
        const std::string code = bulk_schema.substr(0, bulk_schema.size() - 4);
        QRPT q = qrp_request(r, representation);
        q.SCHEMA_NAME = code;
        q.FILE_IDENTIFIER = "$" + code;
        if (const std::string* source = find_param(r.query, "source")) q.SOURCE_NAME = *source;
        const std::string* profile = find_param(r.query, "profile");  // "profile" wins over its "mode" alias
        if (!profile || profile->empty()) profile = find_param(r.query, "mode");
        if (profile && !profile->empty()) {
            const int tp = time_profile_of(*profile);
            if (tp < 0) {
                return qrp_refusal(r, representation, "invalid-profile",
                                   "unknown profile: " + *profile + " (nearest | as_of | forward | latest | all)");
            }
            q.TIME_PROFILE = static_cast<qrpTimeProfile>(tp);
        }
        if (const std::string* epoch = find_param(r.query, "epoch")) {
            double seconds = 0.0;
            if (!parse_epoch_seconds(*epoch, &seconds)) {
                return qrp_refusal(r, representation, "invalid-epoch",
                                   "epoch must be RFC3339 (YYYY-MM-DDTHH:MM:SSZ) or unix seconds: " + *epoch);
            }
            q.PROFILE_EPOCH_MS = epoch_ms(seconds);
        }
        if (const std::string* limit = find_param(r.query, "limit")) {
            long n = 0;
            if (parse_long(*limit, &n) && n > 0) q.LIMIT = static_cast<uint32_t>(n > 0xFFFFFFFFL ? 0xFFFFFFFFL : n);
        }
        return push_qrp("bulk", q);
    }

    if (ends_with(r.path, "/query")) {
        // The body is the client's request: a JSON object {"sql","params"} or raw SQL text.
        QRPT q = qrp_request(r, representation);
        if (body_is_object(r.body)) {
            Json body;
            if (!JsonReader(r.body).parse(&body)) {
                return qrp_refusal(r, representation, "invalid-body", "the request body is not valid JSON");
            }
            if (const Json* sql = body.get("sql"); sql && sql->kind == Json::String) q.SQL = sql->text;
            std::string why;
            if (!parameters_from(body.get("params"), &q.PARAMETERS, &why)) {
                return qrp_refusal(r, representation, "invalid-params", why);
            }
        } else {
            q.SQL = trim(r.body);
        }
        if (q.SQL.empty()) {
            return qrp_refusal(r, representation, "missing-sql",
                               "data_query requires a SQL request body ({\"sql\":\"SELECT ...\"} or raw SQL text)");
        }
        return push_qrp("query", q);
    }

    return qrp_refusal(r, representation, "no-route", "no route for " + r.method + " " + r.path);
}

// discover: one $HTQ -> exactly one $APR on "decision". Routes (suffix-matched, mount-agnostic, one trailing "/"
// tolerated): .../peers -> peers_list; .../peers/<id> -> peer_get (peerId); .../peers/<id>/pnm -> pnm_history (peerId,
// limit clamped [1,100], default 1 = the newest publication); .../peers/<id>/<standard>/latest -> latest_dataset
// (peerId, standard); .../standards -> standards. Only GET/HEAD are discovery reads.
int discover(void) {
    Request r;
    if (const int status = read_request("discover", &r)) return status;
    APRT apr = apr_for(r);

    if (r.method != "GET" && r.method != "HEAD") {
        return apr_refusal(std::move(apr), 404, "no-route", "no " + r.method + " route for " + r.path + " (discovery routes are GET)");
    }
    std::string path = r.path;
    if (path.size() > 1 && path.back() == '/') path.pop_back();

    if (ends_with(path, "/standards")) {
        apr.ROUTE = "standards";
        return push_apr(apr);
    }
    if (ends_with(path, "/peers")) {
        apr.ROUTE = "peers_list";
        return push_apr(apr);
    }
    const size_t peers_at = path.rfind("/peers/");
    if (peers_at != std::string::npos) {
        const std::string rest = path.substr(peers_at + 7);
        const size_t slash = rest.find('/');
        if (slash == std::string::npos) {
            apr.ROUTE = "peer_get";
            add_parameter(&apr, "peerId", percent_decode(rest));
            return push_apr(apr);
        }
        const std::string peer = rest.substr(0, slash);
        const std::string sub = rest.substr(slash + 1);
        const size_t sub_slash = sub.find('/');
        if (!peer.empty() && sub == "pnm") {
            long limit = 1;
            if (const std::string* text = find_param(r.query, "limit")) parse_long(*text, &limit);
            if (limit < 1) limit = 1;
            if (limit > 100) limit = 100;
            apr.ROUTE = "pnm_history";
            add_parameter(&apr, "peerId", percent_decode(peer));
            add_parameter(&apr, "limit", std::to_string(limit));
            return push_apr(apr);
        }
        if (!peer.empty() && sub_slash != std::string::npos && sub_slash > 0 && sub.substr(sub_slash + 1) == "latest") {
            apr.ROUTE = "latest_dataset";
            add_parameter(&apr, "peerId", percent_decode(peer));
            add_parameter(&apr, "standard", percent_decode(sub.substr(0, sub_slash)));
            return push_apr(apr);
        }
    }
    return apr_refusal(std::move(apr), 404, "no-route", "no route for " + r.path);
}

// route_public_query: the sandboxed public query surface (mount /api/v1/query). GET/HEAD -> "surface"; POST -> "query"
// (body: JSON {"sql","params","format","limit","sort","profile","epoch","source"} or raw SQL text; ?format wins over the
// body's "format"); anything else -> 405. Pure parsing: sort/limit/profile compose in hostcap/flatsql-query and every
// sandbox rule is enforced by the engine.
int route_public_query(void) {
    Request r;
    if (const int status = read_request("route_public_query", &r)) return status;

    if (r.method == "GET" || r.method == "HEAD") {
        return push_qrp("surface", qrp_request(r, representation_of(r)));
    }
    if (r.method != "POST") {
        return qrp_refusal(r, representation_of(r), "method-not-allowed",
                           "no " + r.method + " route for the public query surface (POST a query; GET the surface listing)");
    }

    Json body;
    const bool is_object = body_is_object(r.body);
    if (is_object && !JsonReader(r.body).parse(&body)) {
        return qrp_refusal(r, representation_of(r), "invalid-body", "the request body is not valid JSON");
    }
    const Json* body_format = is_object ? body.get("format") : nullptr;
    const int representation = representation_of(r, body_format && body_format->kind == Json::String ? &body_format->text : nullptr);
    QRPT q = qrp_request(r, representation);

    if (!is_object) {
        q.SQL = trim(r.body);
    } else {
        if (const Json* sql = body.get("sql"); sql && sql->kind == Json::String) q.SQL = sql->text;
        std::string why;
        if (!parameters_from(body.get("params"), &q.PARAMETERS, &why)) return qrp_refusal(r, representation, "invalid-params", why);
        if (const Json* sort = body.get("sort"); sort && sort->kind == Json::String && !trim(sort->text).empty()) {
            const std::string s = trim(sort->text);
            const size_t space = s.find(' ');
            q.SORT_FIELD = s.substr(0, space);
            if (space != std::string::npos) {
                const std::string dir = lower(trim(s.substr(space + 1)));
                if (dir == "desc") q.SORT_DESC = true;
                else if (dir != "asc" && !dir.empty()) {
                    return qrp_refusal(r, representation, "invalid-sort", "invalid sort: expected \"COLUMN [ASC|DESC]\"");
                }
            }
        }
        if (const Json* profile = body.get("profile"); profile && profile->kind == Json::String && !profile->text.empty()) {
            const int tp = time_profile_of(profile->text);
            if (tp < 0) {
                return qrp_refusal(r, representation, "invalid-profile", "unknown profile: " + profile->text + " (nearest | as_of | forward | all)");
            }
            q.TIME_PROFILE = static_cast<qrpTimeProfile>(tp);
            q.SCHEMA_NAME = "OMM";  // the profiles run over the unified OMM view
            q.FILE_IDENTIFIER = "$OMM";
        }
        if (const Json* source = body.get("source"); source && source->kind == Json::String) q.SOURCE_NAME = source->text;
        if (const Json* limit = body.get("limit"); limit && limit->kind == Json::Number && limit->number >= 1) {
            q.LIMIT = limit->number > 4294967295.0 ? 0xFFFFFFFFu : static_cast<uint32_t>(limit->number);
        }
        if (const Json* epoch = body.get("epoch")) {
            double seconds = 0.0;
            const bool ok = epoch->kind == Json::Number ? (seconds = epoch->number, true)
                          : epoch->kind == Json::String ? parse_epoch_seconds(epoch->text, &seconds) : epoch->kind == Json::Null;
            if (!ok) return qrp_refusal(r, representation, "invalid-epoch", "epoch must be RFC3339 or unix seconds");
            q.PROFILE_EPOCH_MS = epoch_ms(seconds);
        }
    }
    if (q.SQL.empty() && q.TIME_PROFILE == qrpTimeProfile_Unspecified) {
        return qrp_refusal(r, representation, "missing-sql",
                           "public query requires a SQL body ({\"sql\":\"SELECT ...\"} or raw SQL text) or a profile");
    }
    return push_qrp("query", q);
}

// route_node_status: GET/HEAD -> route "status"; anything else 405. The mount carries one resource; PATH is not
// inspected. No conditional GET: the snapshot changes on every call.
int route_node_status(void) {
    Request r;
    if (const int status = read_request("route_node_status", &r)) return status;
    APRT apr = apr_for(r);
    if (r.method != "GET" && r.method != "HEAD") {
        return apr_refusal(std::move(apr), 405, "method-not-allowed", "no " + r.method + " route for node status (GET only)");
    }
    apr.ROUTE = "status";
    return push_apr(apr);
}

// route_node_activity: GET/HEAD -> route "activity" + parameter limit (?limit clamped [1,256], default 50; a value
// that is not a whole integer falls back to the default); anything else 405.
int route_node_activity(void) {
    Request r;
    if (const int status = read_request("route_node_activity", &r)) return status;
    APRT apr = apr_for(r);
    if (r.method != "GET" && r.method != "HEAD") {
        return apr_refusal(std::move(apr), 405, "method-not-allowed", "no " + r.method + " route for node activity (GET only)");
    }
    long limit = 50;
    if (const std::string* text = find_param(r.query, "limit")) {
        long parsed = 0;
        if (parse_long(*text, &parsed)) limit = parsed;
    }
    if (limit < 1) limit = 1;
    if (limit > 256) limit = 256;
    apr.ROUTE = "activity";
    add_parameter(&apr, "limit", std::to_string(limit));
    return push_apr(apr);
}

}  // extern "C"
