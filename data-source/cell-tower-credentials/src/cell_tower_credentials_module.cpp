/*
 * data-source/cell-tower-credentials — the credential mediator for the
 * cellular-network-aggregate flow.
 *
 * OWNER DIRECTIVE 2026-08-08 #2, verbatim: "If it needs a login, it should have
 * somewhere to put a username / password, and if those are entered, it should
 * send them encrypted to the module, and then the module should store them
 * securely using our plugin secure storage."
 *
 * ─── WHY THIS IS ITS OWN PLUGIN ────────────────────────────────────────────
 * It exists so that `cell-tower-source` does not have to. That plugin parses
 * provider bodies, is instantiated by the SDK browser harness in its own tests,
 * and must stay `capabilities: []`. Two facts force the split rather than merely
 * suggest it (Janus ruling, 2026-08-09, from SDK source):
 *
 *   1. `wallet_sign` — the capability that gates `keyslot.unwrap`, because the
 *      host has NO separate `keyslot` capability name (caps/keyslot.go:26-31,
 *      capability_policy.go) — is in the SDK's
 *      `BrowserIncompatibleCapabilitySet` (pluginCompliance.js:52). Declaring it
 *      alongside a `browser` runtime target is a hard compile error.
 *   2. `secrets.*` has no browser-host implementation at all, so a method that
 *      calls it traps under the harness.
 *
 * The flow compiler validates each dependency's manifest separately and lets a
 * node's capability slice NARROW but never escalate (flowCompiler.js:1378-1392,
 * 1703-1726). So one wasmedge-only sibling holds every grant the operator makes
 * for credentials, and the code that touches provider payloads holds none. The
 * blast radius of a credential grant is this file.
 *
 * ─── THE ONE METHOD ────────────────────────────────────────────────────────
 *   mediate : task -> body + decision
 *
 * `task` is the control frame `route` emits. Three ops, and `route` has already
 * resolved the provider against its compiled registry and DERIVED the lane id,
 * so nothing a caller typed ever becomes a lane name:
 *
 *   {"op":"catalog","catalog":{...}}
 *       Finish the catalog: append `keySlot` and flip `credentialConfigured`
 *       (and `defaultSelected`) for each lane the node actually holds.
 *
 *   {"op":"put","providerId":"...","lane":"cell_...","envelope":{slotId,
 *    ephemeralPublicKey,nonce,ciphertext}}
 *       keyslot.unwrap -> secrets.put. The plaintext exists in this module's
 *       memory for the few instructions between the two and is never pushed to
 *       an output port, never logged, never returned.
 *
 *   {"op":"clear","providerId":"...","lane":"cell_..."}
 *       secrets.clear.
 *
 * ─── FIVE THINGS THIS DELIBERATELY DOES NOT DO ─────────────────────────────
 *   1. No plaintext branch. There is no code path that accepts an unsealed
 *      credential, so a browser that cannot seal cannot send.
 *   2. No echo. The reply says which lane is stored, never what is in it. A
 *      write grant must not become a read oracle by reflection.
 *   3. No invented key slot. `keySlot` is emitted ONLY when the host answers
 *      `node.publicKey`; absent it the catalog omits the field entirely and the
 *      GUI's own contract disables the form rather than collect into a void.
 *   4. No lane the caller named. `route` derives `cell_<providerId>` from its
 *      compiled registry; this node additionally refuses any lane that does not
 *      start with `cell_`, so a malformed frame cannot reach `secrets:spacetrack`
 *      or any other operator lane however the policy rows read.
 *   5. No presence oracle on clear. Clearing an absent lane answers exactly like
 *      clearing a present one.
 *
 * ─── ENVELOPE, COPIED FROM THE HOST, NOT INVENTED ──────────────────────────
 * `keyslot.unwrap` is ephemeral-sender ECIES: X25519(slotPrivate, ephemeralPub)
 * -> HKDF-SHA256 (info "sdn-server/keyslot.unwrap/v1") -> AES-256-GCM
 * (caps/keyslot.go:160-230). The browser half already speaks exactly this
 * (gallery/_shared/cellularSdnStream.js `sealToKeySlot`). This module performs
 * NO crypto of its own — it hands the envelope to the host oracle, which holds
 * the private half and returns only the plaintext.
 *
 * The published half is `node.publicKey`, which is the X25519 public half OF THE
 * SLOT SCALAR ITSELF (node.go `deriveX25519PublicKeyHex`) and is UNGATED on the
 * bridge. It arrives as HEX; the browser's WebCrypto import takes BASE64. The
 * conversion happens here, once, in the place that publishes the field, so the
 * two halves cannot disagree about the encoding — a published half nothing could
 * consume is precisely the defect that made this slot dead as shipped.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

extern "C" {

__attribute__((import_module("space_data_module_host"), import_name("call")))
int32_t sdm_host_call(const uint8_t* op_ptr, int32_t op_len,
                      const uint8_t* payload_ptr, int32_t payload_len);
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
int32_t sdm_host_response_len(void);
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
int32_t sdm_host_read_response(uint8_t* dst_ptr, int32_t dst_len);

}  // extern "C"

namespace {

// ── hostcall wire ──────────────────────────────────────────────────────────
// Envelope: u32 metaLen | meta JSON | u32 segCount | (u32 segLen | bytes)*.
// Mirrors space-data-module-sdk/src/host/hostcallWire.js. This module never
// sends a binary segment: every payload it hands the host is small JSON.

void wire_u32le(uint8_t* dst, uint32_t value) {
    dst[0] = static_cast<uint8_t>(value & 0xff);
    dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
    dst[2] = static_cast<uint8_t>((value >> 16) & 0xff);
    dst[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

uint32_t wire_rd32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

// ⛔ THE RETURN VALUE OF THIS FUNCTION CAN CARRY A SECRET: `keyslot.unwrap`'s
// meta holds the plaintext. It is never pushed to an output port, never
// concatenated into a reply and never printed. Every caller below extracts one
// field and lets the rest go out of scope.
std::string host_meta(const char* op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    wire_u32le(req.data(), static_cast<uint32_t>(payload_json.size()));
    if (!payload_json.empty()) {
        std::memcpy(req.data() + 4, payload_json.data(), payload_json.size());
    }
    wire_u32le(req.data() + 4 + payload_json.size(), 0u);
    sdm_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)),
                  req.data(), static_cast<int32_t>(req.size()));
    const int32_t len = sdm_host_response_len();
    if (len <= 0) return std::string();
    std::vector<uint8_t> buf(static_cast<size_t>(len), 0);
    sdm_host_read_response(buf.data(), len);
    if (buf.size() < 4) return std::string();
    const uint32_t meta_len = wire_rd32le(buf.data());
    if (buf.size() < 4u + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(buf.data() + 4), meta_len);
}

bool host_meta_ok(const std::string& meta) {
    return meta.find("\"ok\":true") != std::string::npos;
}

// ── minimal JSON (control frames only; never pointed at provider payloads) ──
std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

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

// Finds "key": and returns the raw value slice, unescaping a string value.
// Depth-aware enough for the flat control frames this node sees.
bool json_raw_field(const std::string& src, const std::string& key, std::string* out) {
    const std::string needle = "\"" + key + "\"";
    size_t at = src.find(needle);
    if (at == std::string::npos) return false;
    at = src.find(':', at + needle.size());
    if (at == std::string::npos) return false;
    ++at;
    while (at < src.size() && (src[at] == ' ' || src[at] == '\n' || src[at] == '\t')) ++at;
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

std::string json_string(const std::string& src, const std::string& key,
                        const std::string& fallback) {
    std::string raw;
    if (!json_raw_field(src, key, &raw)) return fallback;
    return raw;
}

// ── base64 ─────────────────────────────────────────────────────────────────
int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

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

std::string base64_encode(const uint8_t* data, size_t size) {
    static const char* kAlphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    size_t i = 0;
    while (i + 2 < size) {
        const uint32_t triple = (static_cast<uint32_t>(data[i]) << 16) |
                                (static_cast<uint32_t>(data[i + 1]) << 8) |
                                static_cast<uint32_t>(data[i + 2]);
        out += kAlphabet[(triple >> 18) & 0x3f];
        out += kAlphabet[(triple >> 12) & 0x3f];
        out += kAlphabet[(triple >> 6) & 0x3f];
        out += kAlphabet[triple & 0x3f];
        i += 3;
    }
    if (i + 1 == size) {
        const uint32_t triple = static_cast<uint32_t>(data[i]) << 16;
        out += kAlphabet[(triple >> 18) & 0x3f];
        out += kAlphabet[(triple >> 12) & 0x3f];
        out += "==";
    } else if (i + 2 == size) {
        const uint32_t triple = (static_cast<uint32_t>(data[i]) << 16) |
                                (static_cast<uint32_t>(data[i + 1]) << 8);
        out += kAlphabet[(triple >> 18) & 0x3f];
        out += kAlphabet[(triple >> 12) & 0x3f];
        out += kAlphabet[(triple >> 6) & 0x3f];
        out += '=';
    }
    return out;
}

bool hex_to_base64(const std::string& hex, std::string* out) {
    if (hex.empty() || (hex.size() % 2) != 0) return false;
    std::vector<uint8_t> bytes;
    bytes.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        int nibble[2] = {-1, -1};
        for (int pass = 0; pass < 2; ++pass) {
            const char c = hex[i + static_cast<size_t>(pass)];
            if (c >= '0' && c <= '9') nibble[pass] = c - '0';
            else if (c >= 'a' && c <= 'f') nibble[pass] = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') nibble[pass] = c - 'A' + 10;
            else return false;
        }
        bytes.push_back(static_cast<uint8_t>((nibble[0] << 4) | nibble[1]));
    }
    *out = base64_encode(bytes.data(), bytes.size());
    return true;
}

// ── the node's wrapping slot ───────────────────────────────────────────────
// `provider-wrapping` is the slot id declared in
// sdn-server/internal/node/licensing_bootstrap.go:35.
constexpr const char* kWrappingSlotId = "provider-wrapping";

// LANE PREFIX GUARD. `route` derives every lane as `cell_<providerId>` from its
// own compiled registry, so this can only fail on a malformed frame — which is
// exactly when it matters. An operator lane approved for something else must be
// unreachable through this flow even if a policy row is one day written too
// broadly.
constexpr const char* kLanePrefix = "cell_";

bool lane_is_ours(const std::string& lane) {
    return lane.size() > std::strlen(kLanePrefix) &&
           lane.compare(0, std::strlen(kLanePrefix), kLanePrefix) == 0 &&
           lane.find('"') == std::string::npos && lane.find('\\') == std::string::npos;
}

int push_json(const char* port, const std::string& json) {
    return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 nullptr, 0, 0, reinterpret_cast<const uint8_t*>(json.data()),
                                 static_cast<uint32_t>(json.size()));
}

// `route` MUST be the string "error" for any non-200: foundation/http-respond
// reads decision.status ONLY in that branch (http_respond_module.cpp:395-401),
// so naming anything else turns a refusal into a silent empty 200.
int emit(int status, const std::string& body_json) {
    const std::string decision =
        std::string("{\"route\":\"") + (status == 200 ? "cellular-credential" : "error") +
        "\",\"format\":\"json\",\"status\":" + std::to_string(status) + "}";
    if (push_json("decision", decision) < 0) return 500;
    if (push_json("body", body_json) < 0) return 500;
    return 0;
}

int emit_error(int status, const char* code, const std::string& message) {
    return emit(status, std::string("{\"code\":\"") + code + "\",\"error\":\"" +
                            json_escape(message) + "\"}");
}

bool credential_configured(const std::string& lane) {
    const std::string meta = host_meta("secrets.status", "{\"id\":\"" + json_escape(lane) + "\"}");
    if (!host_meta_ok(meta)) return false;
    return meta.find("\"configured\":true") != std::string::npos;
}

// ---------------------------------------------------------------------------
// op = catalog.
//
// Two edits to the catalog `route` built, both anchored on the provider object
// so neither can land on the wrong one:
//   - `"credentialLane":"<lane>"` is unique per provider and is the anchor. The
//     two flags that follow it in emission order (`authoritative`,
//     `defaultSelected`) and the one that precedes it (`credentialConfigured`)
//     are rewritten within that object only.
//   - `keySlot` is appended as a top-level sibling.
// A textual edit is used rather than re-serialising because the registry lives
// in the OTHER plugin: rebuilding the catalog here would mean a second copy of
// 13 providers' licences and attributions, and two copies drift.
// ---------------------------------------------------------------------------
int handle_catalog(const std::string& task) {
    std::string catalog = json_string(task, "catalog", "");
    if (catalog.empty() || catalog[0] != '{') {
        return emit_error(500, "no-catalog", "the router emitted no catalog to finish");
    }

    // Flip the flags for every lane the node actually holds. The lanes are read
    // OUT OF THE CATALOG, so this node needs no registry of its own; a lane it
    // is not approved for simply answers "not configured" and is left alone.
    size_t cursor = 0;
    const std::string lane_key = "\"credentialLane\":\"";
    for (;;) {
        const size_t lane_at = catalog.find(lane_key, cursor);
        if (lane_at == std::string::npos) break;
        const size_t lane_start = lane_at + lane_key.size();
        const size_t lane_end = catalog.find('"', lane_start);
        if (lane_end == std::string::npos) break;
        const std::string lane = catalog.substr(lane_start, lane_end - lane_start);
        cursor = lane_end;

        // Only ask about a provider that says it needs a login. The object
        // begins at the nearest preceding '{'.
        const size_t obj_start = catalog.rfind('{', lane_at);
        const size_t obj_end = catalog.find('}', lane_end);
        if (obj_start == std::string::npos || obj_end == std::string::npos) continue;
        const std::string object = catalog.substr(obj_start, obj_end - obj_start + 1);
        if (object.find("\"credentialRequired\":true") == std::string::npos) continue;
        if (!lane_is_ours(lane)) continue;
        if (!credential_configured(lane)) continue;

        std::string updated = object;
        const std::string configured_false = "\"credentialConfigured\":false";
        const size_t cf = updated.find(configured_false);
        if (cf != std::string::npos) {
            updated.replace(cf, configured_false.size(), "\"credentialConfigured\":true");
        }
        const std::string selected_false = "\"defaultSelected\":false";
        const size_t sf = updated.find(selected_false);
        if (sf != std::string::npos) {
            updated.replace(sf, selected_false.size(), "\"defaultSelected\":true");
        }
        catalog.replace(obj_start, obj_end - obj_start + 1, updated);
        // The object grew; resume after the rewritten object, never inside it.
        cursor = obj_start + updated.size();
    }

    // keySlot LAST, and only if the host answered. A placeholder would be worse
    // than omission: the GUI disables the form on an absent slot, but a form
    // that seals to a wrong key loses what is typed into it.
    const std::string node_key_meta = host_meta("node.publicKey", "{}");
    std::string slot_public_b64;
    if (host_meta_ok(node_key_meta)) {
        const std::string hex = json_string(node_key_meta, "result", "");
        if (!hex.empty() && hex_to_base64(hex, &slot_public_b64)) {
            const size_t close = catalog.rfind('}');
            if (close != std::string::npos) {
                catalog.insert(close, std::string(",\"keySlot\":{\"slotId\":\"") +
                                          kWrappingSlotId + "\",\"publicKey\":\"" +
                                          json_escape(slot_public_b64) +
                                          "\",\"algorithm\":\"X25519\"}");
            }
        }
    }

    if (push_json("decision",
                  "{\"route\":\"cellular-providers\",\"format\":\"json\",\"status\":200}") < 0) {
        return 500;
    }
    return push_json("body", catalog) < 0 ? 500 : 0;
}

// ---------------------------------------------------------------------------
// op = put. The whole of owner directive #2.
// ---------------------------------------------------------------------------
int handle_put(const std::string& task) {
    const std::string provider_id = json_string(task, "providerId", "");
    const std::string lane = json_string(task, "lane", "");
    if (!lane_is_ours(lane)) {
        return emit_error(400, "bad-lane",
                          "this node writes only cellular provider credential lanes");
    }

    const std::string envelope = json_string(task, "envelope", "");
    const std::string slot_id = json_string(envelope, "slotId", "");
    const std::string ephemeral = json_string(envelope, "ephemeralPublicKey", "");
    const std::string nonce = json_string(envelope, "nonce", "");
    const std::string ciphertext = json_string(envelope, "ciphertext", "");
    if (slot_id.empty() || ephemeral.empty() || ciphertext.empty()) {
        // There is NO plaintext branch anywhere in this file.
        return emit_error(400, "unsealed-credential",
                          "a credential must arrive as a sealed keyslot envelope "
                          "(slotId, ephemeralPublicKey, nonce, ciphertext)");
    }
    if (slot_id != kWrappingSlotId) {
        return emit_error(400, "unknown-key-slot",
                          std::string("this node seals provider credentials to the \"") +
                              kWrappingSlotId + "\" slot only");
    }

    const std::string unwrap_meta =
        host_meta("keyslot.unwrap",
                  std::string("{\"slotId\":\"") + kWrappingSlotId +
                      "\",\"ephemeralPublicKey\":\"" + json_escape(ephemeral) +
                      "\",\"nonce\":\"" + json_escape(nonce) + "\",\"ciphertext\":\"" +
                      json_escape(ciphertext) + "\"}");
    std::string plaintext;
    if (!host_meta_ok(unwrap_meta) ||
        !base64_decode(json_string(unwrap_meta, "plaintext", ""), &plaintext) ||
        plaintext.empty()) {
        // ONE reason for every failure mode. Distinguishing "wrong slot key"
        // from "corrupt ciphertext" from "not our envelope" tells a prober
        // something; it tells the operator nothing they cannot get from the
        // node's own log.
        return emit_error(400, "unwrap-failed", "the node could not open this envelope");
    }

    // The sealed document is {"username","secret"} — the browser's own shape
    // (cellularSdnStream.js sealAndStoreCredential). A username may legitimately
    // be empty (a token-only provider such as OpenCelliD); a secret may not,
    // because an empty secret would CLEAR the lane through a route whose caller
    // believes it is setting one.
    const std::string username = json_string(plaintext, "username", "");
    const std::string secret = json_string(plaintext, "secret", "");
    if (secret.empty()) {
        return emit_error(
            400, "empty-secret",
            "the sealed credential carried no secret; refusing to clear the lane through PUT");
    }

    const std::string put_meta =
        host_meta("secrets.put", "{\"id\":\"" + json_escape(lane) + "\",\"username\":\"" +
                                     json_escape(username) + "\",\"secret\":\"" +
                                     json_escape(secret) + "\"}");
    if (!host_meta_ok(put_meta)) {
        // The refusal names the MISSING GRANT, which is an operator-actionable
        // fact carrying no credential, so it travels.
        return emit(403, std::string("{\"code\":\"store-refused\",\"providerId\":\"") +
                             json_escape(provider_id) + "\",\"credentialLane\":\"" +
                             json_escape(lane) +
                             "\",\"error\":\"the node refused to store this credential; this "
                             "module needs an approved secrets:" +
                             json_escape(lane) + ":write policy row\"}");
    }

    return emit(200, std::string("{\"providerId\":\"") + json_escape(provider_id) +
                         "\",\"credentialLane\":\"" + json_escape(lane) +
                         "\",\"credentialConfigured\":true,\"stored\":true}");
}

int handle_clear(const std::string& task) {
    const std::string provider_id = json_string(task, "providerId", "");
    const std::string lane = json_string(task, "lane", "");
    if (!lane_is_ours(lane)) {
        return emit_error(400, "bad-lane",
                          "this node clears only cellular provider credential lanes");
    }
    const std::string meta = host_meta("secrets.clear", "{\"id\":\"" + json_escape(lane) + "\"}");
    if (!host_meta_ok(meta)) {
        return emit(403, std::string("{\"code\":\"clear-refused\",\"providerId\":\"") +
                             json_escape(provider_id) + "\",\"credentialLane\":\"" +
                             json_escape(lane) +
                             "\",\"error\":\"the node refused to clear this credential; this "
                             "module needs an approved secrets:" +
                             json_escape(lane) + ":write policy row\"}");
    }
    return emit(200, std::string("{\"providerId\":\"") + json_escape(provider_id) +
                         "\",\"credentialLane\":\"" + json_escape(lane) +
                         "\",\"credentialConfigured\":false,\"cleared\":true}");
}

}  // namespace

extern "C" {

int mediate(void) {
    const int32_t idx = plugin_find_input_index("task", 0);
    if (idx < 0) return 400;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload) return 400;
    const std::string task(reinterpret_cast<const char*>(frame->payload), frame->payload_length);

    const std::string op = json_string(task, "op", "");
    if (op == "catalog") return handle_catalog(task);
    if (op == "put") return handle_put(task);
    if (op == "clear") return handle_clear(task);
    return emit_error(500, "unknown-op", "the router emitted an operation this node does not know");
}

}  // extern "C"
