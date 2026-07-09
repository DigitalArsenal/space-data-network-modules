/*
 * SpaceX Starlink data-source module (WS5).
 *
 * The `pull` method fetches SpaceX/Starlink ephemeris over HTTP (WS5.2 here),
 * then — WS5.3/5.4 — parses + validates, stores the records, signs a PNM, and
 * publishes it. All I/O goes through the `space_data_module_host` JSON hostcall
 * bridge (this is the first module to call host capabilities).
 *
 * Hostcall ABI (space_data_module_host):
 *   call(op_ptr, op_len, payload_ptr, payload_len) -> i32 status
 *   response_len() -> i32
 *   read_response(dst_ptr, dst_len) -> i32 (bytes copied)
 *   clear_response() -> i32
 *   last_status_code() -> i32
 * The response is a hostcall envelope:
 *   [u32 LE metaLen][metaLen JSON meta][u32 LE segCount]([u32 LE segLen][seg]...)
 * meta = {"ok":true,"result":{...}}. HTTP result = {"status","headers","body",
 * "body_encoding":"utf8|base64"}.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string>
#include <vector>

// sdm_hostcall_wire.hpp must precede keyslotClient.hpp (the SDK header
// asserts SDM_HOSTCALL_WIRE_HPP is already defined). Resolved via -I flags
// build.mjs adds for common/ (SDN_COMMON_DIR) and the space-data-module-sdk
// host/cpp dir (SDM_HOST_CPP_DIR, via the node_modules symlink).
#include "sdm_hostcall_wire.hpp"
#include "keyslotClient.hpp"

// SpaceX Starlink public ephemeris listing (discover endpoint): MANIFEST.txt
// lists one ephemeris filename per line (the bare directory URL 404s).
static const char* kStarlinkDiscoverURL =
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
// Node signing key slot (wallet_sign -> keyslot.sign) used to sign published
// PNMs. The slot's private key material is host-side only; it never enters
// guest memory (see sdm_keyslot::keyslot_sign below).
static const char* kSigningKeySlot = "node-signing";
// PubSub topic the module publishes PNM pointers on.
static const char* kPublishTopic = "sdn/data-source/spacex-starlink";

extern "C" {

// Guest allocator used by the host to pass request/response buffers.
__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) { return static_cast<uint8_t*>(malloc(size)); }

__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t /*size*/) { free(ptr); }

// space_data_module_host hostcall imports.
__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t host_call(const uint8_t* op_ptr, int32_t op_len, const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t host_response_len();
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

// Invoke a host capability op with a JSON payload; returns the raw envelope bytes.
// The request payload must use the same hostcall envelope framing as responses
// ([meta_len u32 LE][meta JSON][segment_count u32 LE]) — both the SDK host and
// the Go node bridge decode it with decodeHostcallEnvelope.
std::vector<uint8_t> hostcall(const std::string& op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    std::copy(payload_json.begin(), payload_json.end(), req.begin() + 4);
    // Trailing 4 zero bytes = segment_count 0.
    host_call(reinterpret_cast<const uint8_t*>(op.data()), static_cast<int32_t>(op.size()),
              req.data(), static_cast<int32_t>(req.size()));
    int32_t len = host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) {
        host_read_response(buf.data(), len);
    }
    return buf;
}

// Extract the JSON meta object from a hostcall envelope.
std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    uint32_t meta_len = static_cast<uint32_t>(env[0]) | (static_cast<uint32_t>(env[1]) << 8) |
                        (static_cast<uint32_t>(env[2]) << 16) | (static_cast<uint32_t>(env[3]) << 24);
    if (env.size() < 4 + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

// Minimal JSON string-field extractor for "key":"...". Handles simple escapes.
bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n')) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            char n = json[i + 1];
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

long json_number_field(const std::string& json, const std::string& key, long fallback) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    return strtol(json.c_str() + colon + 1, nullptr, 10);
}

std::vector<uint8_t> base64_decode(const std::string& in) {
    static const int8_t T[256] = {/*init below*/};
    int8_t tbl[256];
    for (int i = 0; i < 256; i++) tbl[i] = -1;
    const char* alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) tbl[static_cast<uint8_t>(alpha[i])] = static_cast<int8_t>(i);
    (void)T;
    std::vector<uint8_t> out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c == '=' || tbl[c] == -1) {
            if (c == '=') break;
            continue;  // skip whitespace/newlines
        }
        val = (val << 6) | tbl[c];
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

std::string base64_encode(const uint8_t* data, size_t len) {
    static const char* alpha =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    for (; i + 3 <= len; i += 3) {
        uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                     (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(alpha[(n >> 18) & 63]);
        out.push_back(alpha[(n >> 12) & 63]);
        out.push_back(alpha[(n >> 6) & 63]);
        out.push_back(alpha[n & 63]);
    }
    if (i < len) {
        uint32_t n = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) n |= static_cast<uint32_t>(data[i + 1]) << 8;
        out.push_back(alpha[(n >> 18) & 63]);
        out.push_back(alpha[(n >> 12) & 63]);
        out.push_back(i + 1 < len ? alpha[(n >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

bool cap_ok(const std::vector<uint8_t>& env) {
    return envelope_meta_json(env).find("\"ok\":true") != std::string::npos;
}

// JSON-escape a string for embedding in a request payload.
std::string json_escape(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else out.push_back(c);
    }
    return out;
}

// HTTP GET via the http capability; returns the decoded body, sets *status.
std::vector<uint8_t> http_get(const std::string& url, long* status) {
    std::string payload = "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\"}";
    std::vector<uint8_t> env = hostcall("http.request", payload);
    std::string meta = envelope_meta_json(env);
    if (status) *status = json_number_field(meta, "status", 0);
    std::string encoding, body;
    json_string_field(meta, "body_encoding", &encoding);
    if (!json_string_field(meta, "body", &body)) return {};
    if (encoding == "base64") return base64_decode(body);
    return std::vector<uint8_t>(body.begin(), body.end());
}

// STORAGE_WRITE: store raw FlatBuffer record bytes under a schema.
bool storage_write(const std::string& schema, const uint8_t* data, size_t len) {
    std::string payload = "{\"schema\":\"" + json_escape(schema) + "\",\"data\":\"" +
                          base64_encode(data, len) + "\"}";
    return cap_ok(hostcall("storage.write", payload));
}

// WALLET_SIGN: sign data with the node's identity key via the host-side
// keyslot.sign crypto oracle (sdn-server/internal/modulert/caps/keyslot.go).
// The slot's private key material never crosses into guest memory — only
// the resulting signature does. Returns an empty vector on failure.
std::vector<uint8_t> keyslot_sign(const std::string& slot_id, const uint8_t* data, size_t len) {
    std::vector<uint8_t> signature;
    if (!sdm_keyslot::keyslot_sign(slot_id, data, len, &signature)) {
        return {};
    }
    return signature;
}

// PUBSUB: publish a message (utf8) to a topic.
bool pubsub_publish(const std::string& topic, const std::string& data) {
    std::string payload = "{\"topic\":\"" + json_escape(topic) + "\",\"data\":\"" +
                          json_escape(data) + "\"}";
    return cap_ok(hostcall("pubsub.publish", payload));
}

// Count candidate ephemeris resources in a listing (href/name occurrences of the
// Starlink MEME ephemeris file prefix). Refined against the real listing format
// in later passes.
size_t count_discovered_resources(const std::vector<uint8_t>& listing) {
    std::string s(listing.begin(), listing.end());
    size_t count = 0, pos = 0;
    const std::string marker = "MEME";
    while ((pos = s.find(marker, pos)) != std::string::npos) { count++; pos += marker.size(); }
    return count;
}

// The `pull` method: WS5.2 discover + fetch. WS5.3/5.4 add store + sign-PNM +
// publish. Returns a small UTF-8 summary for now (PIV/PNM framing lands in 5.3).
std::string run_pull() {
    long status = 0;
    std::vector<uint8_t> listing = http_get(kStarlinkDiscoverURL, &status);
    size_t discovered = count_discovered_resources(listing);

    // Store the fetched records (STORAGE_WRITE). Real per-file parse/validate +
    // per-record OEM storage is refined against the live listing format.
    bool stored = !listing.empty() && storage_write("OEM", listing.data(), listing.size());

    // Build a PNM provenance payload for this pull batch.
    std::string pnm = "{\"source\":\"spacex-starlink\",\"url\":\"" + json_escape(kStarlinkDiscoverURL) +
                      "\",\"discovered\":" + std::to_string(discovered) +
                      ",\"bytes\":" + std::to_string(listing.size()) + "}";

    // Sign the PNM with the node identity via the keyslot.sign host-side
    // crypto oracle (WALLET_SIGN). The signing key never enters guest memory.
    std::vector<uint8_t> signature =
        keyslot_sign(kSigningKeySlot, reinterpret_cast<const uint8_t*>(pnm.data()), pnm.size());

    // Publish the signed PNM (PUBSUB).
    std::string message = "{\"pnm\":" + pnm + ",\"signature\":\"" +
                          base64_encode(signature.data(), signature.size()) + "\"}";
    bool published = pubsub_publish(kPublishTopic, message);

    return "{\"ok\":true,\"discover_status\":" + std::to_string(status) +
           ",\"discovered\":" + std::to_string(discovered) +
           ",\"stored\":" + (stored ? "true" : "false") +
           ",\"signed\":" + (signature.empty() ? "false" : "true") +
           ",\"published\":" + (published ? "true" : "false") + "}";
}

}  // namespace

extern "C" {

// Canonical streaming invoke entrypoint. Any request (the manifest TIMERS entry
// re-invokes `pull`) triggers a discover+fetch; returns the summary bytes.
__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* /*req_ptr*/, uint32_t /*req_len*/, uint32_t* out_len_ptr) {
    std::string result = run_pull();
    uint8_t* out = static_cast<uint8_t*>(malloc(result.size()));
    if (out != nullptr) {
        for (size_t i = 0; i < result.size(); i++) out[i] = static_cast<uint8_t>(result[i]);
    }
    if (out_len_ptr != nullptr) *out_len_ptr = static_cast<uint32_t>(result.size());
    return out;
}

}  // extern "C"
