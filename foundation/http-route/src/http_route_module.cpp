/*
 * foundation/http-route (loop C.3b).
 *
 * Single-purpose flow node: one $HTQ HttpRequest envelope in, exactly one
 * routing-decision JSON frame out. Pure compute — no capabilities, no
 * hostcalls. All HTTP semantics live here (TRUE isomorphism; the host is a
 * dumb pipe):
 *
 *   - URL path suffix routing: "/omm/bulk" -> omm_bulk, "/query" ->
 *     data_query, anything else -> not_found.
 *   - Query-string parsing (module-owned, still URL-encoded on the wire):
 *     epoch (RFC3339 "YYYY-MM-DDTHH:MM:SSZ" or unix-seconds number),
 *     mode|profile ("profile" wins when both present), limit (positive
 *     integer), source, format ("json" | anything else -> default
 *     "flatbuffer").
 *   - If-None-Match extraction via case-insensitive header lookup.
 *   - data_query POST body passthrough: body is either a JSON object
 *     {"sql":"...","params":[...]} (forwarded verbatim) or raw SQL text.
 *     A data_query request without a SQL body degrades to not_found.
 *
 * Decision JSON contract (documented in plugin-manifest.json):
 *   {"route":"omm_bulk"|"data_query"|"not_found","format":"flatbuffer"|"json"}
 *   plus optional "ifNoneMatch", "query":{schema,source,profile,epoch,limit}
 *   (omm_bulk; absent keys defer to retrieval config/defaults),
 *   "sql"/"params" (data_query), "error" (not_found).
 *
 * The SDK HTTP ABI C++ header (src/generated/http/cpp/HttpRequestAbi_generated.h)
 * is prepended by build.mjs; this file contains only the method body.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// ---------------------------------------------------------------------------
// Small string helpers.
// ---------------------------------------------------------------------------

bool ends_with(const std::string& value, const char* suffix) {
    const size_t suffix_len = std::strlen(suffix);
    return value.size() >= suffix_len &&
           std::memcmp(value.data() + value.size() - suffix_len, suffix, suffix_len) == 0;
}

char ascii_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

bool iequals(const char* a, size_t a_len, const char* b) {
    const size_t b_len = std::strlen(b);
    if (a_len != b_len) return false;
    for (size_t i = 0; i < a_len; i++) {
        if (ascii_lower(a[i]) != ascii_lower(b[i])) return false;
    }
    return true;
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
        } else if (c == '%' && i + 2 < in.size()) {
            const int hi = hex_nibble(in[i + 1]);
            const int lo = hex_nibble(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
            } else {
                out.push_back(c);
            }
        } else {
            out.push_back(c);
        }
    }
    return out;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
            out += buf;
        } else out.push_back(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Query-string parsing.
// ---------------------------------------------------------------------------

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
            QueryParam param;
            if (eq == std::string::npos) {
                param.key = percent_decode(pair);
            } else {
                param.key = percent_decode(pair.substr(0, eq));
                param.value = percent_decode(pair.substr(eq + 1));
            }
            params.push_back(param);
        }
        if (end == raw.size()) break;
        start = end + 1;
    }
    return params;
}

const std::string* find_query_param(const std::vector<QueryParam>& params, const char* key) {
    for (const auto& param : params) {
        if (param.key == key) return &param.value;
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// Epoch parsing: unix seconds number OR RFC3339 "YYYY-MM-DDTHH:MM:SSZ"
// (fractional seconds accepted). Proleptic-Gregorian civil-days algorithm
// (Howard Hinnant, "chrono-Compatible Low-Level Date Algorithms") — no host
// clock or timezone database involved.
// ---------------------------------------------------------------------------

int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2u) / 5u + d - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097LL + static_cast<int64_t>(doe) - 719468LL;
}

bool parse_epoch(const std::string& value, double* out) {
    if (value.empty()) return false;
    // Unix seconds number (integer or fractional).
    if (value.find('T') == std::string::npos) {
        char* end = nullptr;
        const double numeric = strtod(value.c_str(), &end);
        if (end != value.c_str() && end && *end == '\0') {
            *out = numeric;
            return true;
        }
        return false;
    }
    // RFC3339 UTC: YYYY-MM-DDTHH:MM:SS(.frac)?Z
    int year = 0;
    unsigned month = 0, day = 0, hour = 0, minute = 0;
    double seconds = 0.0;
    int consumed = 0;
    const int matched = std::sscanf(value.c_str(), "%d-%u-%uT%u:%u:%lf%n",
                                    &year, &month, &day, &hour, &minute, &seconds, &consumed);
    if (matched != 6) return false;
    if (value[static_cast<size_t>(consumed)] != 'Z' ||
        static_cast<size_t>(consumed) + 1 != value.size()) {
        return false;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 ||
        seconds < 0.0 || seconds >= 61.0) {
        return false;
    }
    const int64_t days = days_from_civil(year, month, day);
    *out = static_cast<double>(days) * 86400.0 + hour * 3600.0 + minute * 60.0 + seconds;
    return true;
}

std::string format_number(double value) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.6f", value);
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Minimal JSON extraction for the data_query body ({"sql":"...","params":[...]}).
// Mirrors the retrieval module's helpers (control metadata only).
// ---------------------------------------------------------------------------

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

std::string json_array_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '[') return std::string();
    const size_t start = i;
    int depth = 0;
    bool in_string = false;
    for (; i < json.size(); i++) {
        const char c = json[i];
        if (in_string) {
            if (c == '\\') i++;
            else if (c == '"') in_string = false;
            continue;
        }
        if (c == '"') in_string = true;
        else if (c == '[') depth++;
        else if (c == ']') {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

int push_decision(const std::string& decision) {
    const int32_t pushed = plugin_push_output_ex(
        "decision", nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1,
        reinterpret_cast<const uint8_t*>(decision.data()),
        static_cast<uint32_t>(decision.size()));
    return pushed < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

// route: parse one $HTQ HttpRequest into exactly one decision JSON frame.
int route(void) {
    const int32_t input_index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length < 8) {
        plugin_set_error("missing-request-frame",
                         "route requires a $HTQ HttpRequest input frame on port \"request\".");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::HttpRequestBufferHasIdentifier(frame->payload) ||
        !sdn::http::VerifyHttpRequestBuffer(verifier)) {
        plugin_set_error("invalid-request-frame",
                         "route input frame is not a valid $HTQ HttpRequest buffer.");
        return 400;
    }
    const sdn::http::HttpRequest* request = sdn::http::GetHttpRequest(frame->payload);

    std::string method;
    if (request->METHOD()) method.assign(request->METHOD()->c_str(), request->METHOD()->size());
    std::string path;
    if (request->PATH()) path.assign(request->PATH()->c_str(), request->PATH()->size());
    std::string raw_query;
    if (request->QUERY()) raw_query.assign(request->QUERY()->c_str(), request->QUERY()->size());

    // If-None-Match: case-insensitive header lookup (host lower-cases names,
    // but do not rely on it).
    std::string if_none_match;
    bool has_if_none_match = false;
    if (const auto* headers = request->HEADERS()) {
        for (::flatbuffers::uoffset_t i = 0; i < headers->size(); i++) {
            const auto* header = headers->Get(i);
            if (!header || !header->NAME()) continue;
            if (iequals(header->NAME()->c_str(), header->NAME()->size(), "if-none-match")) {
                if (header->VALUE()) {
                    if_none_match.assign(header->VALUE()->c_str(), header->VALUE()->size());
                }
                has_if_none_match = true;
                break;
            }
        }
    }

    const std::vector<QueryParam> params = parse_query_string(raw_query);

    // format: "json" | default "flatbuffer".
    std::string format = "flatbuffer";
    if (const std::string* format_param = find_query_param(params, "format")) {
        if (*format_param == "json") format = "json";
    }

    std::string decision = "{";
    const auto append_common_tail = [&](std::string* out) {
        *out += "\"format\":\"" + format + "\"";
        if (has_if_none_match) {
            *out += ",\"ifNoneMatch\":\"" + json_escape(if_none_match) + "\"";
        }
    };

    if (ends_with(path, "/omm/bulk")) {
        decision += "\"route\":\"omm_bulk\",";
        append_common_tail(&decision);
        decision += ",\"query\":{\"schema\":\"OMM.fbs\"";
        if (const std::string* source = find_query_param(params, "source")) {
            if (!source->empty()) decision += ",\"source\":\"" + json_escape(*source) + "\"";
        }
        // "profile" wins over its "mode" alias when both are present.
        const std::string* profile = find_query_param(params, "profile");
        if (!profile) profile = find_query_param(params, "mode");
        if (profile && !profile->empty()) {
            decision += ",\"profile\":\"" + json_escape(*profile) + "\"";
        }
        if (const std::string* epoch_param = find_query_param(params, "epoch")) {
            double epoch = 0.0;
            if (parse_epoch(*epoch_param, &epoch)) {
                decision += ",\"epoch\":" + format_number(epoch);
            }
        }
        if (const std::string* limit_param = find_query_param(params, "limit")) {
            char* end = nullptr;
            const long limit = strtol(limit_param->c_str(), &end, 10);
            if (end != limit_param->c_str() && end && *end == '\0' && limit > 0) {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%ld", limit);
                decision += ",\"limit\":";
                decision += buf;
            }
        }
        decision += "}}";
        return push_decision(decision);
    }

    if (ends_with(path, "/query")) {
        // POST body passthrough: JSON {"sql","params"} or raw SQL text.
        std::string body;
        if (const auto* body_bytes = request->BODY()) {
            body.assign(reinterpret_cast<const char*>(body_bytes->data()), body_bytes->size());
        }
        size_t first = 0;
        while (first < body.size() && is_json_ws(body[first])) first++;
        std::string sql;
        std::string params_json = "[]";
        if (first < body.size() && body[first] == '{') {
            std::string sql_field;
            if (json_string_field(body, "sql", &sql_field) && !sql_field.empty()) {
                sql = sql_field;
                const std::string body_params = json_array_slice(body, "params");
                if (!body_params.empty()) params_json = body_params;
            }
        } else if (first < body.size()) {
            sql = body.substr(first);
        }
        if (sql.empty()) {
            decision += "\"route\":\"not_found\",";
            append_common_tail(&decision);
            decision += ",\"error\":\"data_query requires a SQL request body\"}";
            return push_decision(decision);
        }
        decision += "\"route\":\"data_query\",";
        append_common_tail(&decision);
        decision += ",\"sql\":\"" + json_escape(sql) + "\",\"params\":" + params_json + "}";
        return push_decision(decision);
    }

    decision += "\"route\":\"not_found\",";
    append_common_tail(&decision);
    decision += ",\"error\":\"no route for " + json_escape(method) + " " + json_escape(path) + "\"}";
    return push_decision(decision);
}

// discover: parse one $HTQ HttpRequest into exactly one discovery routing
// decision (gateway loop G.2). Routes (suffix-matched, mount-agnostic; one
// trailing "/" tolerated):
//   .../peers               -> peers_list
//   .../peers/<segment>     -> peer_get   (+"peerId": percent-decoded segment)
//   .../standards           -> standards
//   anything else           -> not_found
// Only GET/HEAD are discovery reads; other methods degrade to not_found.
// Decision JSON contract: {"route","format"} + optional "ifNoneMatch",
// "peerId", "error" — same envelope family as route().
int discover(void) {
    const int32_t input_index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        input_index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(input_index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length < 8) {
        plugin_set_error("missing-request-frame",
                         "discover requires a $HTQ HttpRequest input frame on port \"request\".");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sdn::http::HttpRequestBufferHasIdentifier(frame->payload) ||
        !sdn::http::VerifyHttpRequestBuffer(verifier)) {
        plugin_set_error("invalid-request-frame",
                         "discover input frame is not a valid $HTQ HttpRequest buffer.");
        return 400;
    }
    const sdn::http::HttpRequest* request = sdn::http::GetHttpRequest(frame->payload);

    std::string method;
    if (request->METHOD()) method.assign(request->METHOD()->c_str(), request->METHOD()->size());
    std::string path;
    if (request->PATH()) path.assign(request->PATH()->c_str(), request->PATH()->size());
    std::string raw_query;
    if (request->QUERY()) raw_query.assign(request->QUERY()->c_str(), request->QUERY()->size());

    std::string if_none_match;
    bool has_if_none_match = false;
    if (const auto* headers = request->HEADERS()) {
        for (::flatbuffers::uoffset_t i = 0; i < headers->size(); i++) {
            const auto* header = headers->Get(i);
            if (!header || !header->NAME()) continue;
            if (iequals(header->NAME()->c_str(), header->NAME()->size(), "if-none-match")) {
                if (header->VALUE()) {
                    if_none_match.assign(header->VALUE()->c_str(), header->VALUE()->size());
                }
                has_if_none_match = true;
                break;
            }
        }
    }

    const std::vector<QueryParam> params = parse_query_string(raw_query);
    std::string format = "flatbuffer";
    if (const std::string* format_param = find_query_param(params, "format")) {
        if (*format_param == "json") format = "json";
    }

    std::string decision = "{";
    const auto append_common_tail = [&](std::string* out) {
        *out += "\"format\":\"" + format + "\"";
        if (has_if_none_match) {
            *out += ",\"ifNoneMatch\":\"" + json_escape(if_none_match) + "\"";
        }
    };
    const auto not_found = [&](const std::string& message) {
        std::string out = "{\"route\":\"not_found\",";
        append_common_tail(&out);
        out += ",\"error\":\"" + json_escape(message) + "\"}";
        return push_decision(out);
    };

    if (method != "GET" && method != "HEAD") {
        return not_found("no " + method + " route for " + path + " (discovery routes are GET)");
    }

    // Tolerate exactly one trailing slash on the matchable path.
    std::string trimmed = path;
    if (trimmed.size() > 1 && trimmed.back() == '/') trimmed.pop_back();

    if (ends_with(trimmed, "/standards")) {
        decision += "\"route\":\"standards\",";
        append_common_tail(&decision);
        decision += "}";
        return push_decision(decision);
    }

    if (ends_with(trimmed, "/peers")) {
        decision += "\"route\":\"peers_list\",";
        append_common_tail(&decision);
        decision += "}";
        return push_decision(decision);
    }

    const size_t peers_at = trimmed.rfind("/peers/");
    if (peers_at != std::string::npos) {
        const std::string remainder = trimmed.substr(peers_at + std::strlen("/peers/"));
        if (remainder.empty()) {
            decision += "\"route\":\"peers_list\",";
            append_common_tail(&decision);
            decision += "}";
            return push_decision(decision);
        }
        if (remainder.find('/') != std::string::npos) {
            // Deeper per-peer surfaces (pnm, {standard}/latest) are G.3/G.4.
            return not_found("no route for " + path);
        }
        decision += "\"route\":\"peer_get\",";
        append_common_tail(&decision);
        decision += ",\"peerId\":\"" + json_escape(percent_decode(remainder)) + "\"}";
        return push_decision(decision);
    }

    return not_found("no route for " + path);
}

}  // extern "C"
