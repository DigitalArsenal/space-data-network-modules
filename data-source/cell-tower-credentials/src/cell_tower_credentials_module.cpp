/*
 * data-source/cell-tower-credentials — the credential mediator for the
 * cellular-network-aggregate flow (typed contracts 1.0: FlatBuffers only, every
 * hostcall an SDS $PIV invocation through sdm_piv).
 *
 * OWNER DIRECTIVE 2026-08-08 #2, verbatim: "If it needs a login, it should have
 * somewhere to put a username / password, and if those are entered, it should
 * send them encrypted to the module, and then the module should store them
 * securely using our plugin secure storage."
 *
 * ─── WHY THIS IS ITS OWN PLUGIN ────────────────────────────────────────────
 * It exists so that `cell-tower-source` does not have to. That plugin parses
 * provider bodies, is instantiated by the SDK browser harness in its own tests,
 * and must stay `capabilities: []`. `wallet_sign` (which gates keyslot.unwrap —
 * the host has NO separate `keyslot` capability name) is browser-incompatible by
 * SDK compliance, and `secrets.*` has no browser-host implementation. So one
 * wasmedge-only sibling holds every grant the operator makes for credentials,
 * and the code that touches provider payloads holds none.
 *
 * ─── THE ONE METHOD ────────────────────────────────────────────────────────
 *   mediate : catalog ($QRP page) | credential ($APR) | requests (HREQ)
 *          -> decision ($QRP) + page ($QRP) | requests (HREQ) + status (FNTC)
 *
 *   catalog     Finish the router's $QRP projection page: fill the key slot
 *               cells (node.publicKey) and flip credentialConfigured /
 *               defaultSelected for each lane secrets.status reports held.
 *   credential  ROUTE credential-put: keyslot.unwrap -> secrets.put. The
 *               plaintext exists in this module's memory for the few
 *               instructions between the two and is never pushed to an output
 *               port, never logged, never returned, and wiped afterwards.
 *               ROUTE credential-clear: secrets.clear.
 *   requests    secrets.get -> substitute `{{credential}}` into the provider
 *               fetches the router could not finish. Attribution downstream is
 *               by each request's CONTEXT, so dropping one cannot misattribute
 *               another (the old positional correlation list is gone).
 *
 * ─── FIVE THINGS THIS DELIBERATELY DOES NOT DO ─────────────────────────────
 *   1. No plaintext branch. There is no code path that accepts an unsealed
 *      credential, so a browser that cannot seal cannot send.
 *   2. No echo. The page says which lane is stored, never what is in it.
 *   3. No invented key slot. The key slot cells are filled ONLY when the host
 *      answers node.publicKey; absent it they stay Null and the GUI's own
 *      contract disables the form.
 *   4. No lane the caller named. `route` derives `cell_<providerId>` from its
 *      compiled registry; this node additionally refuses any lane that does not
 *      start with `cell_`.
 *   5. No presence oracle on clear. Clearing an absent lane answers exactly like
 *      clearing a present one.
 *
 * ─── ENVELOPE ──────────────────────────────────────────────────────────────
 * `keyslot.unwrap` is ephemeral-sender ECIES: X25519(slotPrivate, ephemeralPub)
 * -> HKDF-SHA256 (info "sdn-server/keyslot.unwrap/v1") -> AES-256-GCM. The
 * browser seals {"username","secret"} and sends {slotId, ephemeralPublicKey,
 * nonce, ciphertext} (base64 fields) as the PUT body — the client's own JSON
 * representation, which arrives here verbatim as the $APR BODY and is decoded at
 * this edge into the raw ephemeral_public_key / nonce / ciphertext frames of the
 * hostcall. This module performs NO crypto of its own.
 *
 * The published half is node.publicKey (the X25519 public half of the slot
 * scalar), which the host answers as hex text on raw "value". It travels as raw
 * key bytes in a Bytes cell; foundation/http-respond renders a Bytes cell as
 * base64 in the Json representation, which is what the browser's WebCrypto
 * import takes.
 */

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
#include "HttpRequest_generated.h"
#include "FlowNotice_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

constexpr const char* kWrappingSlotId = "provider-wrapping";
constexpr const char* kLanePrefix = "cell_";

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

void substitute_all(std::string* text, const std::string& token, const std::string& value) {
    if (!text || token.empty()) return;
    size_t at = 0;
    while ((at = text->find(token, at)) != std::string::npos) {
        text->replace(at, token.size(), value);
        at += value.size();
    }
}

std::string url_encode(const std::string& in) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(in.size() * 3);
    for (const unsigned char c : in) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
            c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

// Overwrite before release: the secret must not linger in the guest heap.
void wipe(std::string* s) {
    if (!s) return;
    for (char& c : *s) c = '\0';
    s->clear();
}

bool lane_is_ours(const std::string& lane) {
    return lane.size() > std::strlen(kLanePrefix) && lane.compare(0, std::strlen(kLanePrefix), kLanePrefix) == 0 &&
           lane.find('"') == std::string::npos && lane.find('\\') == std::string::npos;
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

// A success: a $QRP Request decision + a one-row projection page describing the lane's new state.
int emit_lane_state(qrpRepresentation representation, const std::string& provider_id, const std::string& lane,
                    bool configured, const char* verb_column) {
    QRPT decision;
    decision.KIND = qrpKind_Request;
    decision.REPRESENTATION = representation;
    if (push_qrp("decision", decision, false) < 0) return 500;
    QRPT page;
    page.KIND = qrpKind_Page;
    page.STATUS = qrpStatus_Ok;
    page.REPRESENTATION = representation;
    page.COLUMNS.push_back(column("providerId", "string"));
    page.COLUMNS.push_back(column("credentialLane", "string"));
    page.COLUMNS.push_back(column("credentialConfigured", "bool"));
    page.COLUMNS.push_back(column(verb_column, "bool"));
    auto row = std::make_unique<QRPRowT>();
    row->CELLS.push_back(text_cell(provider_id));
    row->CELLS.push_back(text_cell(lane));
    row->CELLS.push_back(bool_cell(configured));
    row->CELLS.push_back(bool_cell(true));
    page.ROWS.push_back(std::move(row));
    return push_qrp("page", page, true) < 0 ? 500 : 0;
}

A::SecretParams secret_params(const std::string& lane) {
    A::SecretParams p{};
    sdm_piv::put(p.ID, lane);  // cell_<id>: the router's registry ids are far below the 128-byte bound
    p.set_has_ID(true);
    return p;
}

bool credential_configured(const std::string& lane) {
    const auto response = sdm_piv::call("secrets.status", "SecretParams", secret_params(lane));
    const auto* result = response.result<A::SecretResult>("SecretResult");
    return response.ok() && result && result->CONFIGURED;
}

int column_index(const QRPT& page, const char* name) {
    for (size_t i = 0; i < page.COLUMNS.size(); ++i)
        if (page.COLUMNS[i] && page.COLUMNS[i]->NAME == name) return static_cast<int>(i);
    return -1;
}

// ---------------------------------------------------------------------------
// catalog: the router's projection page -> the finished page.
// ---------------------------------------------------------------------------
int handle_catalog(const plugin_input_frame_t* frame) {
    const auto frames = stream_frames(frame->payload, frame->payload_length);
    // The page header is a size-prefixed record: written with FinishSizePrefixed (alignment relative to the prefix,
    // as foundation/http-respond reads pages) or finished plainly and prefixed. Both are accepted.
    const QRP* root = nullptr;
    Aligned header;
    if (!frames.empty() && has_identifier(frames[0].first, frames[0].second, "$QRP")) {
        header.assign(frames[0].first - 4, frames[0].second + 4);
        flatbuffers::Verifier prefixed(header.data(), header.size);
        if (VerifySizePrefixedQRPBuffer(prefixed)) {
            root = GetSizePrefixedQRP(header.data());
        } else {
            header.assign(frames[0].first, frames[0].second);
            flatbuffers::Verifier plain(header.data(), header.size);
            if (VerifyQRPBuffer(plain)) root = GetQRP(header.data());
        }
    }
    if (!root) {
        return emit_error(qrpRepresentation_Default, 500, "no-catalog",
                          "the router emitted no $QRP catalog page to finish");
    }
    QRPT page;
    root->UnPackTo(&page);

    auto ensure = [&](const char* name, const char* type) {
        int at = column_index(page, name);
        if (at >= 0) return at;
        page.COLUMNS.push_back(column(name, type));
        for (auto& row : page.ROWS) {
            if (!row) continue;
            while (row->CELLS.size() + 1 < page.COLUMNS.size()) row->CELLS.push_back(std::make_unique<QRPValueT>());
            row->CELLS.push_back(std::make_unique<QRPValueT>());
        }
        return static_cast<int>(page.COLUMNS.size() - 1);
    };
    const int c_required = column_index(page, "credentialRequired");
    const int c_lane = column_index(page, "credentialLane");
    const int c_configured = ensure("credentialConfigured", "bool");
    const int c_selected = ensure("defaultSelected", "bool");
    const int c_slot = ensure("keySlotId", "string");
    const int c_key = ensure("keySlotPublicKey", "bytes");
    const int c_alg = ensure("keySlotAlgorithm", "string");

    auto cell = [](QRPRowT& row, int at) -> QRPValueT& {
        while (row.CELLS.size() <= static_cast<size_t>(at)) row.CELLS.push_back(std::make_unique<QRPValueT>());
        if (!row.CELLS[static_cast<size_t>(at)]) row.CELLS[static_cast<size_t>(at)] = std::make_unique<QRPValueT>();
        return *row.CELLS[static_cast<size_t>(at)];
    };

    // A lane is flipped only when the row says a credential is required AND secrets.status says one is held. That
    // is presence only; no value is read here.
    for (auto& row_ptr : page.ROWS) {
        if (!row_ptr || c_required < 0 || c_lane < 0) continue;
        QRPRowT& row = *row_ptr;
        const QRPValueT& required = cell(row, c_required);
        const QRPValueT& lane_cell = cell(row, c_lane);
        if (required.KIND != qrpValueKind_Bool || !required.BOOL_VALUE) continue;
        if (lane_cell.KIND != qrpValueKind_Text) continue;
        const std::string lane = lane_cell.TEXT_VALUE;
        if (!lane_is_ours(lane) || !credential_configured(lane)) continue;
        QRPValueT& configured = cell(row, c_configured);
        configured.KIND = qrpValueKind_Bool;
        configured.BOOL_VALUE = true;
        QRPValueT& selected = cell(row, c_selected);
        selected.KIND = qrpValueKind_Bool;
        selected.BOOL_VALUE = true;
    }

    // The wrapping key slot, ONLY when the host published one. node.publicKey answers hex text on raw "value"; a
    // value that is already 32 raw bytes is taken as it is. Anything else leaves the cells Null: never invented.
    const auto key_response = sdm_piv::call("node.publicKey");
    std::vector<uint8_t> key;
    if (key_response.ok()) {
        const std::string_view value = key_response.raw("value");
        if (!hex_decode(value, &key)) {
            key.clear();
            if (value.size() == 32) key.assign(value.begin(), value.end());
        }
        if (key.size() != 32) key.clear();
    }
    if (!key.empty()) {
        for (auto& row_ptr : page.ROWS) {
            if (!row_ptr) continue;
            QRPValueT& slot = cell(*row_ptr, c_slot);
            slot = QRPValueT();
            slot.KIND = qrpValueKind_Text;
            slot.TEXT_VALUE = kWrappingSlotId;
            QRPValueT& public_key = cell(*row_ptr, c_key);
            public_key = QRPValueT();
            public_key.KIND = qrpValueKind_Bytes;
            public_key.BYTES_VALUE = key;
            QRPValueT& algorithm = cell(*row_ptr, c_alg);
            algorithm = QRPValueT();
            algorithm.KIND = qrpValueKind_Text;
            algorithm.TEXT_VALUE = "X25519";
        }
    }

    page.KIND = qrpKind_Page;
    QRPT decision;
    decision.KIND = qrpKind_Request;
    decision.REPRESENTATION = page.REPRESENTATION;
    decision.SCHEMA_NAME = page.SCHEMA_NAME;
    if (push_qrp("decision", decision, false) < 0) return 500;
    return push_qrp("page", page, true) < 0 ? 500 : 0;
}

std::string parameter(const APRT& apr, const char* name) {
    for (const auto& p : apr.PARAMETERS)
        if (p && p->NAME == name) return p->VALUE;
    return std::string();
}

// ---------------------------------------------------------------------------
// put: keyslot.unwrap -> secrets.put. The plaintext is never pushed anywhere.
// ---------------------------------------------------------------------------
int handle_put(const APRT& task, qrpRepresentation representation) {
    const std::string provider_id = parameter(task, "providerId");
    const std::string lane = parameter(task, "credentialLane");
    if (!lane_is_ours(lane)) {
        return emit_error(representation, 400, "bad-lane", "this node writes only cellular provider credential lanes");
    }
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
                          std::string("this node seals provider credentials to the \"") + kWrappingSlotId +
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
    if (secret.empty()) {
        wipe(&username);
        return emit_error(representation, 400, "empty-secret",
                          "the sealed credential carried no secret; refusing to clear the lane through PUT");
    }
    A::SecretParams sp = secret_params(lane);
    if (!username.empty()) {
        if (!sdm_piv::put(sp.USERNAME, username)) {
            wipe(&username);
            wipe(&secret);
            return emit_error(representation, 400, "username-too-long",
                              "the sealed username is longer than the 255 bytes the credential store holds; "
                              "refused rather than stored truncated");
        }
        sp.set_has_USERNAME(true);
    }
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
                          "the node refused to store the credential for provider \"" + provider_id + "\" on lane " +
                              lane + "; this module needs an approved secrets:" + lane + ":write policy row");
    }
    return emit_lane_state(representation, provider_id, lane, true, "stored");
}

// clear: answers identically whether or not a credential was there.
int handle_clear(const APRT& task, qrpRepresentation representation) {
    const std::string provider_id = parameter(task, "providerId");
    const std::string lane = parameter(task, "credentialLane");
    if (!lane_is_ours(lane)) {
        return emit_error(representation, 400, "bad-lane", "this node clears only cellular provider credential lanes");
    }
    const auto clear = sdm_piv::call("secrets.clear", "SecretParams", secret_params(lane));
    if (!clear.ok()) {
        return emit_error(representation, 403, "clear-refused",
                          "the node refused to clear the credential for provider \"" + provider_id + "\" on lane " +
                              lane + "; this module needs an approved secrets:" + lane + ":write policy row");
    }
    return emit_lane_state(representation, provider_id, lane, false, "cleared");
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
    return emit_error(representation, 500, "unknown-op", "the router emitted an operation this node does not know");
}

// The run contract a provider fetch carries in CONTEXT: the first $APR of the size-prefixed stream.
bool context_contract(const flatbuffers::Vector<uint8_t>* context, APRT* out) {
    if (!context) return false;
    for (const auto& [p, n] : stream_frames(context->data(), context->size())) {
        Aligned buffer;
        buffer.assign(p, n);
        flatbuffers::Verifier verifier(buffer.data(), buffer.size);
        if (!has_identifier(buffer.data(), buffer.size, "$APR") || !VerifyAPRBuffer(verifier)) continue;
        GetAPR(buffer.data())->UnPackTo(out);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// requests: fill {{credential}} from secrets.get; drop what cannot be filled.
// ---------------------------------------------------------------------------
int handle_requests(const std::vector<const plugin_input_frame_t*>& frames) {
    std::vector<std::string> skipped;
    for (const plugin_input_frame_t* frame : frames) {
        if (!frame->payload) continue;
        Aligned buffer;
        buffer.assign(frame->payload, frame->payload_length);
        flatbuffers::Verifier verifier(buffer.data(), buffer.size);
        if (!R::VerifyHttpRequestBuffer(verifier)) {
            plugin_set_error("invalid-request-frame", "a requests frame is not an HttpRequest (HREQ).");
            return 400;
        }
        const R::HttpRequest* request = R::GetHttpRequest(buffer.data());
        const std::string url = request->URL() ? request->URL()->str() : std::string();
        if (url.find("{{credential") == std::string::npos) {
            if (plugin_push_output_ex("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(),
                                      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpRequest", 0, 8, frame->payload,
                                      frame->payload_length) < 0) {
                return 500;
            }
            continue;
        }
        APRT contract;
        const bool has_contract = context_contract(request->CONTEXT(), &contract);
        const std::string provider_id = has_contract ? parameter(contract, "provider") : std::string();
        const std::string lane = has_contract ? parameter(contract, "credentialLane") : std::string();
        const std::string who = provider_id.empty() ? std::string("unknown") : provider_id;
        if (!lane_is_ours(lane)) {
            skipped.push_back(who + "=not-a-cellular-lane");
            continue;
        }
        std::string secret, username;
        {
            const auto get = sdm_piv::call("secrets.get", "SecretParams", secret_params(lane));
            if (get.ok()) {
                secret.assign(get.raw("secret"));
                if (const auto* result = get.result<A::SecretResult>("SecretResult")) username = result->USERNAME.str();
            }
        }
        if (secret.empty()) {
            wipe(&username);
            skipped.push_back(who + "=no-credential");
            continue;
        }
        std::string filled = url;
        std::string encoded_secret = url_encode(secret);
        std::string encoded_user = url_encode(username);
        substitute_all(&filled, "{{credential}}", encoded_secret);
        substitute_all(&filled, "{{credential_user}}", encoded_user);
        wipe(&secret);
        wipe(&username);
        wipe(&encoded_secret);
        wipe(&encoded_user);
        if (filled.find("{{credential") != std::string::npos) {
            wipe(&filled);
            skipped.push_back(who + "=unfilled-placeholder");
            continue;
        }
        R::HttpRequestT rebuilt;
        request->UnPackTo(&rebuilt);
        rebuilt.URL = filled;
        wipe(&filled);
        flatbuffers::FlatBufferBuilder b(1024 + rebuilt.URL.size() + rebuilt.BODY.size() + rebuilt.CONTEXT.size());
        R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &rebuilt));
        wipe(&rebuilt.URL);
        const int32_t pushed =
            plugin_push_output_ex("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(),
                                  PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpRequest", 0, 8, b.GetBufferPointer(),
                                  static_cast<uint32_t>(b.GetSize()));
        std::memset(b.GetBufferPointer(), 0, b.GetSize());
        if (pushed < 0) return 500;
    }
    if (!skipped.empty()) {
        R::FlowNoticeT notice;
        notice.KIND = R::flowNoticeKind_Skipped;
        notice.SCHEMA = "TBS.fbs";
        notice.REASON = "credential-unavailable";
        notice.COUNT = skipped.size();
        notice.ITEMS = skipped;
        flatbuffers::FlatBufferBuilder b(256);
        R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
        if (plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(),
                                  PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(),
                                  static_cast<uint32_t>(b.GetSize())) < 0) {
            return 500;
        }
    }
    return 0;
}

}  // namespace

extern "C" {

int mediate(void) {
    const auto catalog = frames_on("catalog");
    const auto credential = frames_on("credential");
    const auto requests = frames_on("requests");
    // catalog and credential answer ONE HTTP exchange each: a surplus is refused by name, never merged.
    for (const auto* list : {&catalog, &credential}) {
        if (list->size() > 1) {
            char message[256];
            std::snprintf(message, sizeof message,
                          "This invocation carries %zu frames on single-stream input port \"%s\"; the surplus is "
                          "refused rather than silently discarded.",
                          list->size(), list == &catalog ? "catalog" : "credential");
            plugin_set_error("batched-input-frames", message);
            return 500;
        }
    }
    const int kinds = (catalog.empty() ? 0 : 1) + (credential.empty() ? 0 : 1) + (requests.empty() ? 0 : 1);
    if (kinds == 0) {
        plugin_set_error("missing-task", "mediate requires a frame on catalog, credential or requests.");
        return 400;
    }
    if (kinds > 1) {
        plugin_set_error("ambiguous-task", "mediate received more than one task kind; one invocation has one task.");
        return 500;
    }
    if (!catalog.empty()) return handle_catalog(catalog[0]);
    if (!credential.empty()) return handle_credential(credential[0]);
    return handle_requests(requests);
}

}  // extern "C"
