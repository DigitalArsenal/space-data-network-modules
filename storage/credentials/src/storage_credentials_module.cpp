/*
 * storage/credentials - the credential mediator for the object-store modules (typed contracts 1.0: FlatBuffers only,
 * every hostcall an SDS $PIV invocation through sdm_piv).
 *
 * OWNER 2026-10-21, verbatim: "we need nodes to do that as well using modules that can be loaded (and credentials) into
 * SDN nodes, to update R2 but also any other storage, storage modules if they don't exist yet need to be separate and
 * then we do flows".
 *
 * The pattern is data-source/cell-tower-credentials: the browser seals {username, secret} to the node's wrapping key
 * slot, the node opens it with keyslot.unwrap (gated by wallet_sign, the host has no separate keyslot capability name)
 * and stores it with secrets.put on the lane storage_<store>. For an S3-compatible store username is the access key id
 * and secret is the secret access key. This module holds the WRITE grant (secrets:storage_<store>:write) and the READ
 * grant only to report presence (secrets.status); storage/object-s3 holds the READ grant alone. The two grants are
 * separate policy rows, so the signer cannot overwrite a credential and this module never signs anything.
 *
 * TWO METHODS, ONE TASK EACH:
 *   serve   : request ($HTQ, the HTTP edge) -> decision ($QRP) + page ($QRP). GET|PUT|POST|DELETE .../credentials/<store>
 *             becomes the $APR task of the routes below; the host mounts ONE http trigger per flow, so the path is
 *             matched on the segment here. The flow marks the mount NOT anonymous (an admin session).
 *   mediate : credential ($APR) -> decision ($QRP) + page ($QRP), for a flow that already routed the request.
 *   ROUTE credential-put     keyslot.unwrap -> secrets.put. The plaintext exists for the few instructions between the
 *                            two, is never pushed, logged or returned, and is wiped after use.
 *   ROUTE credential-clear   secrets.clear, answered identically whether or not a credential was held.
 *   ROUTE credential-status  secrets.status plus node.publicKey: the one-row page the browser needs to seal (key slot
 *                            id, X25519 public key as raw bytes) and whether the lane is configured. No value is read.
 *
 * DOES NOT: accept a plaintext credential, echo a value, invent a key slot, take the lane from the caller (the lane is
 * storage_ + the validated store name), leak presence on clear, or substitute a credential into any request (that is
 * the exfiltration lane cell-tower-credentials needs and this module deliberately lacks).
 */

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"

namespace {

namespace A = sdn::runtime::Aligned;

constexpr const char* kWrappingSlotId = "provider-wrapping";
constexpr const char* kLanePrefix = "storage_";

// ── client-JSON readers (the browser's own request representation only) ─────
std::string json_unescape(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] != '\\') { out += in[i]; continue; }
        if (++i >= in.size()) break;
        switch (in[i]) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'u': {
                if (i + 4 < in.size()) {
                    const long cp = std::strtol(in.substr(i + 1, 4).c_str(), nullptr, 16);
                    i += 4;
                    out += (cp < 0x80) ? static_cast<char>(cp) : '?';
                }
                break;
            }
            default: out += in[i];
        }
    }
    return out;
}

bool json_raw_field(const std::string& src, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    size_t at = src.find(needle);
    if (at == std::string::npos) return false;
    at = src.find(':', at + needle.size());
    if (at == std::string::npos) return false;
    ++at;
    while (at < src.size() && (src[at] == ' ' || src[at] == '\n' || src[at] == '\t' || src[at] == '\r')) ++at;
    if (at >= src.size()) return false;
    size_t end = at;
    if (src[at] == '"') {
        end = at + 1;
        while (end < src.size() && !(src[end] == '"' && src[end - 1] != '\\')) ++end;
        if (end >= src.size()) return false;
        *out = json_unescape(src.substr(at + 1, end - at - 1));
        return true;
    }
    int depth = 0;
    while (end < src.size()) {
        const char c = src[end];
        if (c == '[' || c == '{') ++depth;
        if (c == ']' || c == '}') {
            if (depth == 0) break;
            --depth;
        }
        if (c == ',' && depth == 0) break;
        ++end;
    }
    *out = src.substr(at, end - at);
    return true;
}

std::string json_string(const std::string& src, const std::string& key) {
    std::string raw;
    return json_raw_field(src, key, &raw) ? raw : std::string();
}

int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

// The browser's base64 envelope fields -> raw bytes (decoded at the client edge, never re-encoded).
bool base64_decode(const std::string& text, std::string* out) {
    out->clear();
    out->reserve((text.size() / 4) * 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        const int v = b64_value(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<char>((acc >> bits) & 0xff));
        }
    }
    return true;
}

bool hex_decode(std::string_view hex, std::vector<uint8_t>* out) {
    if (hex.empty() || (hex.size() % 2) != 0) return false;
    out->clear();
    for (size_t i = 0; i < hex.size(); i += 2) {
        int nibble[2] = {-1, -1};
        for (int pass = 0; pass < 2; ++pass) {
            const char c = hex[i + static_cast<size_t>(pass)];
            if (c >= '0' && c <= '9') nibble[pass] = c - '0';
            else if (c >= 'a' && c <= 'f') nibble[pass] = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') nibble[pass] = c - 'A' + 10;
            else return false;
        }
        out->push_back(static_cast<uint8_t>((nibble[0] << 4) | nibble[1]));
    }
    return true;
}

// Overwrite before release: the secret must not linger in the guest heap.
void wipe(std::string* s) {
    if (!s) return;
    for (char& c : *s) c = '\0';
    s->clear();
}

// ── frames ───────────────────────────────────────────────────────────────────
std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        if (f) out.push_back(f);
    }
    return out;
}

// A buffer copied into 8-aligned storage (frames inside a stream may sit at any 4-byte boundary).
struct Aligned {
    std::vector<uint64_t> words;
    size_t size = 0;
    const uint8_t* data() const { return reinterpret_cast<const uint8_t*>(words.data()); }
    void assign(const uint8_t* p, size_t n) {
        words.assign((n + 7) / 8, 0);
        if (n) std::memcpy(words.data(), p, n);
        size = n;
    }
};

// The frames of a size-prefixed stream (zero-length prefixes are padding and skipped).
std::vector<std::pair<const uint8_t*, size_t>> stream_frames(const uint8_t* data, size_t length) {
    std::vector<std::pair<const uint8_t*, size_t>> out;
    size_t at = 0;
    while (data && at + 4 <= length) {
        const uint32_t n = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                           (static_cast<uint32_t>(data[at + 2]) << 16) | (static_cast<uint32_t>(data[at + 3]) << 24);
        at += 4;
        if (n == 0) continue;
        if (at + n > length) break;
        out.push_back({data + at, n});
        at += n;
    }
    return out;
}

bool has_identifier(const uint8_t* p, size_t n, const char* id) { return n >= 8 && std::memcmp(p + 4, id, 4) == 0; }

qrpRepresentation representation_from(aprRepresentation a) {
    if (a == aprRepresentation_FlatBuffer) return qrpRepresentation_FlatBuffer;
    if (a == aprRepresentation_Json) return qrpRepresentation_Json;
    return qrpRepresentation_Default;
}

int push_qrp(const char* port, const QRPT& q, bool size_prefixed) {
    flatbuffers::FlatBufferBuilder b(1024);
    const auto root = QRP::Pack(b, &q);
    if (size_prefixed) FinishSizePrefixedQRPBuffer(b, root);
    else FinishQRPBuffer(b, root);
    return plugin_push_output_ex(port, "QRP.fbs", QRPIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "QRP", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

// A refusal: one $QRP KIND Error decision, no page. http-respond respond_query answers HTTP_STATUS with it.
int emit_error(qrpRepresentation representation, uint16_t status, const char* code, const std::string& message) {
    QRPT q;
    q.KIND = qrpKind_Error;
    q.STATUS = qrpStatus_Error;
    q.HTTP_STATUS = status;
    q.ERROR_CODE = code;
    q.MESSAGE = message;
    q.REPRESENTATION = representation;
    return push_qrp("decision", q, false) < 0 ? 500 : 0;
}

std::unique_ptr<QRPColumnT> column(const char* name, const char* type) {
    auto c = std::make_unique<QRPColumnT>();
    c->NAME = name;
    c->TYPE = type;
    return c;
}
std::unique_ptr<QRPValueT> text_cell(const std::string& v) {
    auto c = std::make_unique<QRPValueT>();
    c->KIND = qrpValueKind_Text;
    c->TEXT_VALUE = v;
    return c;
}
std::unique_ptr<QRPValueT> bool_cell(bool v) {
    auto c = std::make_unique<QRPValueT>();
    c->KIND = qrpValueKind_Bool;
    c->BOOL_VALUE = v;
    return c;
}
std::unique_ptr<QRPValueT> bytes_cell(const std::vector<uint8_t>& v) {
    auto c = std::make_unique<QRPValueT>();
    c->KIND = qrpValueKind_Bytes;
    c->BYTES_VALUE = v;
    return c;
}


// A store name is a short lowercase token; the lane is derived from it here, never taken from the caller.
bool store_is_valid(const std::string& store) {
    if (store.empty() || store.size() > 24) return false;
    for (const char c : store)
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
    return true;
}

std::string parameter(const APRT& apr, const char* name) {
    for (const auto& p : apr.PARAMETERS)
        if (p && p->NAME == name) return p->VALUE;
    return std::string();
}

A::SecretParams secret_params(const std::string& lane) {
    A::SecretParams p{};
    sdm_piv::put(p.ID, lane);
    p.set_has_ID(true);
    return p;
}

bool credential_configured(const std::string& lane) {
    const auto response = sdm_piv::call("secrets.status", "SecretParams", secret_params(lane));
    const auto* result = response.result<A::SecretResult>("SecretResult");
    return response.ok() && result && result->CONFIGURED;
}

// A success: a $QRP Request decision + a one-row projection page describing the lane's state.
int emit_lane_state(qrpRepresentation representation, const std::string& store, const std::string& lane,
                    bool configured, const char* verb_column, const std::vector<uint8_t>* key) {
    QRPT decision;
    decision.KIND = qrpKind_Request;
    decision.REPRESENTATION = representation;
    if (push_qrp("decision", decision, false) < 0) return 500;
    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    page.REPRESENTATION = representation;
    page.COLUMNS.push_back(column("store", "string"));
    page.COLUMNS.push_back(column("credentialLane", "string"));
    page.COLUMNS.push_back(column("credentialConfigured", "bool"));
    page.COLUMNS.push_back(column(verb_column, "bool"));
    if (key) {
        page.COLUMNS.push_back(column("keySlotId", "string"));
        page.COLUMNS.push_back(column("keySlotPublicKey", "bytes"));
        page.COLUMNS.push_back(column("keySlotAlgorithm", "string"));
    }
    auto row = std::make_unique<QRPRowT>();
    row->CELLS.push_back(text_cell(store));
    row->CELLS.push_back(text_cell(lane));
    row->CELLS.push_back(bool_cell(configured));
    row->CELLS.push_back(bool_cell(true));
    if (key) {
        row->CELLS.push_back(text_cell(kWrappingSlotId));
        row->CELLS.push_back(bytes_cell(*key));
        row->CELLS.push_back(text_cell("X25519"));
    }
    page.ROWS.push_back(std::move(row));
    return push_qrp("page", page, true) < 0 ? 500 : 0;
}

// put: keyslot.unwrap -> secrets.put. The plaintext is never pushed anywhere.
int handle_put(const APRT& task, qrpRepresentation representation) {
    const std::string store = parameter(task, "store");
    if (!store_is_valid(store)) {
        return emit_error(representation, 400, "bad-store", "the store name must be 1-24 characters of a-z, 0-9, _");
    }
    const std::string lane = kLanePrefix + store;
    const std::string envelope(task.BODY.begin(), task.BODY.end());
    const std::string slot_id = json_string(envelope, "slotId");
    std::string ephemeral, nonce, ciphertext;
    const bool decoded = base64_decode(json_string(envelope, "ephemeralPublicKey"), &ephemeral) &&
                         base64_decode(json_string(envelope, "nonce"), &nonce) &&
                         base64_decode(json_string(envelope, "ciphertext"), &ciphertext);
    if (slot_id.empty() || !decoded || ephemeral.empty() || ciphertext.empty()) {
        return emit_error(representation, 400, "unsealed-credential",
                          "a credential must arrive as a sealed keyslot envelope "
                          "(slotId, ephemeralPublicKey, nonce, ciphertext)");
    }
    if (slot_id != kWrappingSlotId) {
        return emit_error(representation, 400, "unknown-key-slot",
                          std::string("this node seals storage credentials to the \"") + kWrappingSlotId +
                              "\" slot only");
    }

    A::KeyslotParams kp{};
    sdm_piv::put(kp.SLOT_ID, kWrappingSlotId);
    kp.set_has_SLOT_ID(true);
    kp.ALGORITHM = A::cryptoAlgorithm_X25519;
    std::string plaintext;
    {
        const auto unwrap = sdm_piv::call("keyslot.unwrap", "KeyslotParams", kp,
                                          {sdm_piv::raw("ephemeral_public_key", ephemeral),
                                           sdm_piv::raw("nonce", nonce), sdm_piv::raw("ciphertext", ciphertext)});
        if (unwrap.ok()) plaintext.assign(unwrap.raw("data"));
    }
    if (plaintext.empty()) {
        return emit_error(representation, 400, "unwrap-failed", "the node could not open this envelope");
    }
    std::string username = json_string(plaintext, "username");
    std::string secret = json_string(plaintext, "secret");
    wipe(&plaintext);
    if (secret.empty() || username.empty()) {
        wipe(&username);
        wipe(&secret);
        return emit_error(representation, 400, "empty-secret",
                          "an object-store credential needs both an access key id (username) and a secret; "
                          "refusing to clear the lane through PUT");
    }
    A::SecretParams sp = secret_params(lane);
    if (!sdm_piv::put(sp.USERNAME, username)) {
        wipe(&username);
        wipe(&secret);
        return emit_error(representation, 400, "username-too-long",
                          "the sealed username is longer than the 255 bytes the credential store holds; "
                          "refused rather than stored truncated");
    }
    sp.set_has_USERNAME(true);
    bool stored = false;
    {
        const auto put = sdm_piv::call("secrets.put", "SecretParams", sp, {sdm_piv::raw("secret", secret)});
        stored = put.ok();
    }
    wipe(&secret);
    wipe(&username);
    sp.USERNAME.clear();
    if (!stored) {
        return emit_error(representation, 403, "store-refused",
                          "the node refused to store the credential for store \"" + store + "\" on lane " + lane +
                              "; this module needs an approved secrets:" + lane + ":write policy row");
    }
    return emit_lane_state(representation, store, lane, true, "stored", nullptr);
}

// clear: answers identically whether or not a credential was there.
int handle_clear(const APRT& task, qrpRepresentation representation) {
    const std::string store = parameter(task, "store");
    if (!store_is_valid(store)) {
        return emit_error(representation, 400, "bad-store", "the store name must be 1-24 characters of a-z, 0-9, _");
    }
    const std::string lane = kLanePrefix + store;
    const auto clear = sdm_piv::call("secrets.clear", "SecretParams", secret_params(lane));
    if (!clear.ok()) {
        return emit_error(representation, 403, "clear-refused",
                          "the node refused to clear the credential for store \"" + store + "\" on lane " + lane +
                              "; this module needs an approved secrets:" + lane + ":write policy row");
    }
    return emit_lane_state(representation, store, lane, false, "cleared", nullptr);
}

// status: presence only (secrets.status) and the node's wrapping key, ONLY when the host published one (never invented).
int handle_status(const APRT& task, qrpRepresentation representation) {
    const std::string store = parameter(task, "store");
    if (!store_is_valid(store)) {
        return emit_error(representation, 400, "bad-store", "the store name must be 1-24 characters of a-z, 0-9, _");
    }
    const std::string lane = kLanePrefix + store;
    std::vector<uint8_t> key;
    const auto key_response = sdm_piv::call("node.publicKey");
    if (key_response.ok()) {
        const std::string_view value = key_response.raw("value");
        if (!hex_decode(value, &key)) {
            key.clear();
            if (value.size() == 32) key.assign(value.begin(), value.end());
        }
        if (key.size() != 32) key.clear();
    }
    return emit_lane_state(representation, store, lane, credential_configured(lane), "checked",
                           key.empty() ? nullptr : &key);
}

int handle_credential(const plugin_input_frame_t* frame) {
    Aligned buffer;
    buffer.assign(frame->payload, frame->payload_length);
    flatbuffers::Verifier verifier(buffer.data(), buffer.size);
    if (!has_identifier(buffer.data(), buffer.size, "$APR") || !VerifyAPRBuffer(verifier)) {
        return emit_error(qrpRepresentation_Default, 500, "invalid-task",
                          "the credential task is not an $APR record");
    }
    APRT task;
    GetAPR(buffer.data())->UnPackTo(&task);
    const qrpRepresentation representation = representation_from(task.ACCEPT);
    if (task.ROUTE == "credential-put") return handle_put(task, representation);
    if (task.ROUTE == "credential-clear") return handle_clear(task, representation);
    if (task.ROUTE == "credential-status") return handle_status(task, representation);
    return emit_error(representation, 500, "unknown-op", "the router emitted an operation this node does not know");
}

// ── $HTQ: the host is a dumb pipe; routing lives here ──────────────────────────────────────────────────────────
std::string url_decode(const std::string& in) {
    std::string out;
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size() + 0 && std::isxdigit(static_cast<unsigned char>(in[i + 1])) &&
            std::isxdigit(static_cast<unsigned char>(in[i + 2]))) {
            out += static_cast<char>(std::strtol(in.substr(i + 1, 2).c_str(), nullptr, 16));
            i += 2;
        } else if (in[i] == '+') {
            out += ' ';
        } else {
            out += in[i];
        }
    }
    return out;
}

std::string upper_ascii(std::string s) {
    for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

int serve_htq(const plugin_input_frame_t* frame) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (frame->payload_length < 8 || !sdn::http::HttpRequestBufferHasIdentifier(frame->payload) ||
        !sdn::http::VerifyHttpRequestBuffer(verifier)) {
        return emit_error(qrpRepresentation_Default, 400, "invalid-request", "the request is not an $HTQ envelope");
    }
    const sdn::http::HttpRequest* r = sdn::http::GetHttpRequest(frame->payload);
    const std::string method = upper_ascii(r->METHOD() ? r->METHOD()->str() : std::string());
    const std::string path = r->PATH() ? r->PATH()->str() : std::string();
    const std::string query = r->QUERY() ? r->QUERY()->str() : std::string();
    std::string accept;
    if (const auto* headers = r->HEADERS()) {
        for (const auto* h : *headers) {
            if (!h || !h->NAME()) continue;
            std::string name = h->NAME()->str();
            for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (name == "accept") accept = h->VALUE() ? h->VALUE()->str() : std::string();
        }
    }
    qrpRepresentation representation = qrpRepresentation_Default;
    if (query.find("format=json") != std::string::npos || accept.find("/json") != std::string::npos) {
        representation = qrpRepresentation_Json;
    } else if (query.find("format=flatbuffer") != std::string::npos || accept.find("flatbuffers") != std::string::npos) {
        representation = qrpRepresentation_FlatBuffer;
    }
    // Matched on the SEGMENT, not a suffix: "/credentials" with no store is a 404, never a prefix match.
    constexpr const char* kSegment = "/credentials/";
    const size_t at = path.rfind(kSegment);
    if (at == std::string::npos) {
        return emit_error(representation, 404, "no-route", "the credential route is /credentials/<store>");
    }
    const std::string store = url_decode(path.substr(at + std::strlen(kSegment)));
    if (store.empty() || store.find('/') != std::string::npos) {
        return emit_error(representation, 404, "no-store", "the credential route addresses one store: /credentials/<store>");
    }
    APRT task;
    task.PATH = path;
    task.ACCEPT = representation == qrpRepresentation_Json ? aprRepresentation_Json
                  : representation == qrpRepresentation_FlatBuffer ? aprRepresentation_FlatBuffer
                                                                   : aprRepresentation_Default;
    auto p = std::make_unique<APRParameterT>();
    p->NAME = "store";
    p->VALUE = store;
    task.PARAMETERS.push_back(std::move(p));
    if (method == "PUT" || method == "POST") {
        task.ROUTE = "credential-put";
        task.METHOD = aprMethod_PUT;
        if (r->BODY()) task.BODY.assign(r->BODY()->begin(), r->BODY()->end());
        return handle_put(task, representation);
    }
    if (method == "DELETE") {
        task.ROUTE = "credential-clear";
        task.METHOD = aprMethod_DELETE;
        return handle_clear(task, representation);
    }
    if (method == "GET" || method == "HEAD") {
        task.ROUTE = "credential-status";
        task.METHOD = aprMethod_GET;
        return handle_status(task, representation);
    }
    return emit_error(representation, 405, "method-not-allowed",
                      "the credential route takes PUT (store), DELETE (clear) and GET (status); a credential is never readable back");
}

}  // namespace

extern "C" {

int serve(void) {
    const auto request = frames_on("request");
    if (request.empty()) {
        plugin_set_error("missing-request", "serve requires an $HTQ frame on request.");
        return 400;
    }
    if (request.size() > 1) {
        plugin_set_error("batched-input-frames",
                         "This invocation carries more than one frame on single-stream input port \"request\"; the surplus is refused rather than silently discarded.");
        return 500;
    }
    return serve_htq(request[0]);
}

int mediate(void) {
    const auto credential = frames_on("credential");
    if (credential.empty()) {
        plugin_set_error("missing-task", "mediate requires a frame on credential.");
        return 400;
    }
    // One task answers ONE HTTP exchange: a surplus is refused by name, never merged.
    if (credential.size() > 1) {
        char message[256];
        std::snprintf(message, sizeof message,
                      "This invocation carries %zu frames on single-stream input port \"credential\"; the surplus is "
                      "refused rather than silently discarded.",
                      credential.size());
        plugin_set_error("batched-input-frames", message);
        return 500;
    }
    return handle_credential(credential[0]);
}

}  // extern "C"
