/*
 * foundation/discovery-shape (gateway loop G.2).
 *
 * Single-purpose flow node pair shaping the network-discovery responses.
 * Pure compute — no capabilities, no hostcalls. Inputs on both methods:
 *
 *   "decision" — the discovery routing decision JSON
 *                (foundation/http-route discover contract).
 *   "snapshot" — the raw p2p.*_snapshot hostcall response envelope
 *                ([u32le metaLen][{"ok","result"} JSON][u32le segCount]
 *                ([u32le segLen][bytes])*), segment 0 = the stored
 *                $EPM/$PNM record stream ({"$bin":0} in the result).
 *
 * Method "peers" (routes peers_list / peer_get):
 *   - fb body: one size-prefixed $EPM frame per selected peer — the stored
 *     profile spliced VERBATIM when the host has one (epm_index >= 0),
 *     otherwise a synthesized minimal unsigned EPM (DN = peer id,
 *     MULTIFORMAT_ADDRESS = ["/p2p/<peerId>", ...addrs], ENTITY_TYPE = Node)
 *     built with spacedatastandards.org generated code.
 *   - json body (format=json): bare array, one object per peer:
 *     {"peer_id","self","connected","agent_version","addrs","standards",
 *      "epm":{...}|null} — "epm" decodes the stored profile's dn/legal_name/
 *     alternate_names/multiformat_address/entity_type/signed.
 *   - peer_get with an unknown peer id rewrites the decision to
 *     route=not_found (http-respond answers 404).
 *
 * Method "standards" (route standards):
 *   - fb body: the newest signed $PNM per (peer, standard), spliced verbatim
 *     from the snapshot stream in entry order.
 *   - json body: bare array of {"peer_id","standard","schema","file_id",
 *     "file_name","cid","publish_timestamp"} from the snapshot entries.
 *
 * Method "pnm" (route pnm_history, gateway loop G.3):
 *   - fb body: the peer's stored signed $PNM publications spliced VERBATIM
 *     (signatures intact — the client verifies them against the publisher's
 *     Ed25519 key), newest first in entry order (host pre-sorted/limited).
 *   - json body: bare array of {"publisher_peer_id","gossip_peer_id",
 *     "standard","schema","file_id","file_name","cid","publish_timestamp",
 *     "signature_type","signature","signature_verified","attribution",
 *     "publisher_key"|null,"publisher_key_source"|null} — attribution
 *     honesty: the store records the GOSSIP-DELIVERING peer; the host
 *     attributes to the PUBLISHER by signature verification, and these
 *     fields expose exactly which claim each entry makes.
 *   - zero entries rewrite the decision to route=not_found (404: peer
 *     unknown here or no signed publications stored).
 *
 * Method "shape_latest" (route latest_dataset, gateway loop G.4):
 *   - inputs: decision + the p2p.latest_dataset hostcall envelope.
 *   - known=false rewrites the decision to route=not_found (404: the peer
 *     has no attributable publications for the standard, or the standard is
 *     unknown to the node).
 *   - known=true without "serving" (not pinned here / newest batch not yet
 *     materialized) rewrites the decision to route=error status=503 with
 *     the newest signed-PNM pointer object carried into the error body —
 *     the honest unavailability answer; NO silent proxy fetch.
 *   - serving present: etag = W/"fnv1a64-<serving.etag_fnv1a64>" (the host
 *     hashed the batch stream with the same word-folded algorithm, so both
 *     encodings share the tag). fb path: body = the batch stream — either
 *     the envelope's inline segment verbatim or the host's body-reference
 *     descriptor ({"$sdnbodyref":1,...}) forwarded for $HTR BODY_REF
 *     resolution. json path: the raw $OMM stream is emitted on the
 *     "stream" port for the downstream foundation/omm-json encoder;
 *     non-OMM standards answer route=error status=406 (no json adapter).
 *
 * Outputs (all methods): "decision" (forwarded, possibly rewritten to
 * not_found/error), "body" (absent on not_found/error and on the
 * shape_latest json path), "etag" (weak FNV-1a-64 over the fb-encoded
 * record stream — the SAME tag for both encodings, matching
 * foundation/decision-gate's algorithm so identical logical streams carry
 * identical tags across the whole gateway surface), and shape_latest's
 * "stream" (json path only).
 *
 * The EPM generated header (spacedatastandards.org lib/cpp/EPM) is prepended
 * by build.mjs; this file contains only the method bodies.
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
// Byte + JSON helpers (mirroring the other foundation nodes' control-metadata
// helpers; control metadata only, never record payloads).
// ---------------------------------------------------------------------------

uint32_t read_u32le(const uint8_t* src) {
    return static_cast<uint32_t>(src[0]) | (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[3]) << 24);
}

bool is_json_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
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

bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    // Colon-anchored: "key" alone can match a string VALUE (e.g. the pnm
    // entries carry "attribution":"signature" ahead of the "signature" key
    // in Go's alphabetical marshal order). All producers on this graph
    // (Go json.Marshal, JSON.stringify, the C++ nodes) emit no space
    // between the key quote and the colon.
    const std::string needle = "\"" + key + "\":";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
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

bool json_bool_field(const std::string& json, const std::string& key, bool* out) {
    const std::string needle = "\"" + key + "\":";  // colon-anchored (see json_string_field)
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (json.compare(i, 4, "true") == 0) { *out = true; return true; }
    if (json.compare(i, 5, "false") == 0) { *out = false; return true; }
    return false;
}

bool json_int_field(const std::string& json, const std::string& key, int64_t* out) {
    const std::string needle = "\"" + key + "\":";  // colon-anchored (see json_string_field)
    const size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t i = k + needle.size();
    while (i < json.size() && is_json_ws(json[i])) i++;
    bool negative = false;
    if (i < json.size() && json[i] == '-') { negative = true; i++; }
    if (i >= json.size() || json[i] < '0' || json[i] > '9') return false;
    int64_t value = 0;
    while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
        value = value * 10 + (json[i] - '0');
        i++;
    }
    *out = negative ? -value : value;
    return true;
}

// Slice "key":[...] (bracket-depth scan) out of an object.
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

// Iterate the top-level elements of an array slice ("[...]"); returns each
// element's raw substring (objects, strings, numbers, literals).
std::vector<std::string> json_array_elements(const std::string& array_slice) {
    std::vector<std::string> elements;
    if (array_slice.size() < 2 || array_slice.front() != '[') return elements;
    size_t i = 1;
    const size_t end = array_slice.size() - 1;  // closing ']'
    while (i < end) {
        while (i < end && (is_json_ws(array_slice[i]) || array_slice[i] == ',')) i++;
        if (i >= end) break;
        const size_t start = i;
        int depth = 0;
        bool in_string = false;
        for (; i < end; i++) {
            const char c = array_slice[i];
            if (in_string) {
                if (c == '\\') i++;
                else if (c == '"') in_string = false;
                continue;
            }
            if (c == '"') in_string = true;
            else if (c == '[' || c == '{') depth++;
            else if (c == ']' || c == '}') depth--;
            else if (c == ',' && depth == 0) break;
        }
        size_t element_end = i;
        while (element_end > start && is_json_ws(array_slice[element_end - 1])) element_end--;
        elements.push_back(array_slice.substr(start, element_end - start));
    }
    return elements;
}

// Decode a JSON string array slice into unescaped values.
std::vector<std::string> json_string_array(const std::string& array_slice) {
    std::vector<std::string> values;
    for (const std::string& element : json_array_elements(array_slice)) {
        if (element.size() < 2 || element.front() != '"') continue;
        std::string value;
        for (size_t i = 1; i + 1 < element.size();) {
            if (element[i] == '\\' && i + 2 < element.size()) {
                const char n = element[i + 1];
                if (n == 'n') value.push_back('\n');
                else if (n == 't') value.push_back('\t');
                else if (n == 'r') value.push_back('\r');
                else value.push_back(n);
                i += 2;
            } else {
                value.push_back(element[i]);
                i++;
            }
        }
        values.push_back(value);
    }
    return values;
}

// Re-encode a string vector as a JSON array.
std::string json_string_array_out(const std::vector<std::string>& values) {
    std::string out = "[";
    for (size_t i = 0; i < values.size(); i++) {
        if (i > 0) out += ",";
        out += "\"" + json_escape(values[i]) + "\"";
    }
    out += "]";
    return out;
}

// ---------------------------------------------------------------------------
// FNV-1a 64 etag — byte-for-byte the same algorithm and format as
// foundation/decision-gate (word-folded 8-byte main loop), so identical
// streams carry identical tags across all gateway flows.
// ---------------------------------------------------------------------------

std::string fnv1a64_etag(const uint8_t* data, uint32_t length) {
    constexpr uint64_t kPrime = 1099511628211ull;
    uint64_t hash = 1469598103934665603ull;
    uint32_t i = 0;
    for (; i + 8 <= length; i += 8) {
        uint64_t word;
        std::memcpy(&word, data + i, 8);
        hash ^= word;
        hash *= kPrime;
    }
    for (; i < length; i++) {
        hash ^= data[i];
        hash *= kPrime;
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "W/\"fnv1a64-%016llx\"",
                  static_cast<unsigned long long>(hash));
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Hostcall response envelope + record stream parsing.
// ---------------------------------------------------------------------------

struct Snapshot {
    std::string result;                 // the "result" object JSON slice
    const uint8_t* stream = nullptr;    // segment 0 (record stream), may be null
    uint32_t stream_length = 0;
};

std::string json_object_slice(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t k = json.find(needle);
    if (k == std::string::npos) return std::string();
    const size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return std::string();
    size_t i = colon + 1;
    while (i < json.size() && is_json_ws(json[i])) i++;
    if (i >= json.size() || json[i] != '{') return std::string();
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
        else if (c == '{') depth++;
        else if (c == '}') {
            depth--;
            if (depth == 0) return json.substr(start, i - start + 1);
        }
    }
    return std::string();
}

bool parse_snapshot(const uint8_t* payload, uint32_t length, Snapshot* out, std::string* error) {
    if (!payload || length < 8) {
        *error = "snapshot envelope frame is missing or truncated.";
        return false;
    }
    const uint32_t meta_len = read_u32le(payload);
    if (4u + meta_len + 4u > length) {
        *error = "snapshot envelope meta length overruns the frame.";
        return false;
    }
    const std::string meta(reinterpret_cast<const char*>(payload + 4), meta_len);
    if (meta.find("\"ok\":true") == std::string::npos) {
        std::string message;
        if (!json_string_field(meta, "message", &message) || message.empty()) {
            message = "discovery snapshot hostcall reported an error.";
        }
        *error = message;
        return false;
    }
    out->result = json_object_slice(meta, "result");
    size_t off = 4u + meta_len;
    const uint32_t seg_count = read_u32le(payload + off);
    off += 4;
    if (seg_count > 0) {
        if (off + 4 > length) {
            *error = "snapshot envelope segment table overruns the frame.";
            return false;
        }
        const uint32_t seg_len = read_u32le(payload + off);
        off += 4;
        if (off + seg_len > length) {
            *error = "snapshot envelope segment 0 overruns the frame.";
            return false;
        }
        out->stream = payload + off;
        out->stream_length = seg_len;
    }
    return true;
}

struct StreamFrame {
    const uint8_t* data;   // the WHOLE size-prefixed frame ([u32le n][bytes])
    uint32_t length;       // 4 + n
};

// Index the size-prefixed frames of a record stream (zero-length prefixes
// skipped as padding, mirroring http-respond's counting rule). Frames keep
// their prefix: FlatBuffer alignment (8-byte scalars like the EPM
// SIGNATURE_TIMESTAMP) is only valid relative to the PREFIXED buffer start,
// so verification/decoding must use the SizePrefixed accessors.
std::vector<StreamFrame> index_stream_frames(const uint8_t* data, uint32_t length) {
    std::vector<StreamFrame> frames;
    uint32_t offset = 0;
    while (offset + 4 <= length) {
        const uint32_t frame_size = read_u32le(data + offset);
        if (frame_size == 0) {
            offset += 4;
            continue;
        }
        if (frame_size > length - offset - 4) break;  // malformed tail: stop
        frames.push_back({data + offset, frame_size + 4});
        offset += 4 + frame_size;
    }
    return frames;
}

// Append an already-prefixed frame verbatim.
void append_frame(std::vector<uint8_t>* stream, const StreamFrame& frame) {
    stream->insert(stream->end(), frame.data, frame.data + frame.length);
}

// ---------------------------------------------------------------------------
// Frame IO.
// ---------------------------------------------------------------------------

const plugin_input_frame_t* find_input(const char* port_id) {
    const int32_t index = plugin_find_input_index(port_id, 0);
    return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}

std::string frame_as_string(const plugin_input_frame_t* frame) {
    if (!frame || !frame->payload || frame->payload_length == 0) return std::string();
    return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
}

int push_bytes(const char* port_id, const uint8_t* data, uint32_t length) {
    const int32_t pushed = plugin_push_output_ex(
        port_id, nullptr, nullptr,
        PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr,
        0, 1, data, length);
    return pushed < 0 ? 500 : 0;
}

int push_string(const char* port_id, const std::string& value) {
    return push_bytes(port_id, reinterpret_cast<const uint8_t*>(value.data()),
                      static_cast<uint32_t>(value.size()));
}

// ---------------------------------------------------------------------------
// Peer entry model (parsed from the peers_snapshot result).
// ---------------------------------------------------------------------------

struct PeerEntry {
    std::string peer_id;
    std::vector<std::string> addrs;
    std::vector<std::string> standards;
    bool connected = false;
    bool self = false;
    std::string agent_version;
    bool has_agent_version = false;
    int64_t epm_index = -1;
};

std::vector<PeerEntry> parse_peer_entries(const std::string& result) {
    std::vector<PeerEntry> entries;
    const std::string peers_slice = json_array_slice(result, "peers");
    if (peers_slice.empty()) return entries;
    for (const std::string& element : json_array_elements(peers_slice)) {
        if (element.empty() || element.front() != '{') continue;
        PeerEntry entry;
        json_string_field(element, "peer_id", &entry.peer_id);
        entry.addrs = json_string_array(json_array_slice(element, "addrs"));
        entry.standards = json_string_array(json_array_slice(element, "standards"));
        json_bool_field(element, "connected", &entry.connected);
        json_bool_field(element, "self", &entry.self);
        entry.has_agent_version = json_string_field(element, "agent_version", &entry.agent_version);
        json_int_field(element, "epm_index", &entry.epm_index);
        if (!entry.peer_id.empty()) entries.push_back(entry);
    }
    return entries;
}

// Synthesize a minimal unsigned $EPM for a peer without a stored profile:
// DN = peer id, MULTIFORMAT_ADDRESS = ["/p2p/<peerId>", ...addrs],
// ENTITY_TYPE = Node. spacedatastandards.org generated code only. Returned
// bytes are a SIZE-PREFIX-FINISHED buffer ([u32le n][buffer]) so stream
// consumers get correct scalar alignment.
std::vector<uint8_t> synthesize_epm(const PeerEntry& entry) {
    ::flatbuffers::FlatBufferBuilder builder(512);
    const auto dn = builder.CreateString(entry.peer_id);
    std::vector<::flatbuffers::Offset<::flatbuffers::String>> addr_offsets;
    addr_offsets.reserve(entry.addrs.size() + 1);
    addr_offsets.push_back(builder.CreateString("/p2p/" + entry.peer_id));
    for (const std::string& addr : entry.addrs) {
        addr_offsets.push_back(builder.CreateString(addr));
    }
    const auto addrs_vector = builder.CreateVector(addr_offsets);
    EPMBuilder epm(builder);
    epm.add_DN(dn);
    epm.add_MULTIFORMAT_ADDRESS(addrs_vector);
    epm.add_ENTITY_TYPE(EntityType_Node);
    const auto root = epm.Finish();
    FinishSizePrefixedEPMBuffer(builder, root);
    return std::vector<uint8_t>(builder.GetBufferPointer(),
                                builder.GetBufferPointer() + builder.GetSize());
}

// Decode a stored $EPM frame into the JSON presentation object; returns
// "null" when the frame does not verify as a $EPM buffer.
std::string epm_presentation_json(const StreamFrame& frame) {
    ::flatbuffers::Verifier verifier(frame.data, frame.length);
    if (!SizePrefixedEPMBufferHasIdentifier(frame.data) ||
        !VerifySizePrefixedEPMBuffer(verifier)) {
        return "null";
    }
    const EPM* epm = GetSizePrefixedEPM(frame.data);
    std::string out = "{";
    out += "\"dn\":";
    if (epm->DN()) out += "\"" + json_escape(epm->DN()->str()) + "\"";
    else out += "null";
    out += ",\"legal_name\":";
    if (epm->LEGAL_NAME()) out += "\"" + json_escape(epm->LEGAL_NAME()->str()) + "\"";
    else out += "null";
    out += ",\"alternate_names\":[";
    if (const auto* names = epm->ALTERNATE_NAMES()) {
        for (::flatbuffers::uoffset_t i = 0; i < names->size(); i++) {
            if (i > 0) out += ",";
            out += "\"" + json_escape(names->Get(i)->str()) + "\"";
        }
    }
    out += "],\"multiformat_address\":[";
    if (const auto* addrs = epm->MULTIFORMAT_ADDRESS()) {
        for (::flatbuffers::uoffset_t i = 0; i < addrs->size(); i++) {
            if (i > 0) out += ",";
            out += "\"" + json_escape(addrs->Get(i)->str()) + "\"";
        }
    }
    out += "],\"entity_type\":\"";
    out += (epm->ENTITY_TYPE() == EntityType_Node) ? "Node" : "User";
    out += "\",\"signed\":";
    out += (epm->SIGNATURE() && epm->SIGNATURE()->size() > 0) ? "true" : "false";
    out += "}";
    return out;
}

std::string peer_presentation_json(const PeerEntry& entry,
                                   const std::vector<StreamFrame>& frames) {
    std::string out = "{";
    out += "\"peer_id\":\"" + json_escape(entry.peer_id) + "\"";
    out += ",\"self\":";
    out += entry.self ? "true" : "false";
    out += ",\"connected\":";
    out += entry.connected ? "true" : "false";
    out += ",\"agent_version\":";
    if (entry.has_agent_version && !entry.agent_version.empty()) {
        out += "\"" + json_escape(entry.agent_version) + "\"";
    } else {
        out += "null";
    }
    out += ",\"addrs\":" + json_string_array_out(entry.addrs);
    out += ",\"standards\":" + json_string_array_out(entry.standards);
    out += ",\"epm\":";
    if (entry.epm_index >= 0 && entry.epm_index < static_cast<int64_t>(frames.size())) {
        out += epm_presentation_json(frames[static_cast<size_t>(entry.epm_index)]);
    } else {
        out += "null";
    }
    out += "}";
    return out;
}

// Rewrite a decision to not_found (unknown peer), preserving the format.
std::string not_found_decision(const std::string& format, const std::string& message) {
    return "{\"route\":\"not_found\",\"format\":\"" + format + "\",\"error\":\"" +
           json_escape(message) + "\"}";
}

// Rewrite a decision to route=error with an explicit status; pnm_slice
// (optional "{...}" object) rides into the error body so unavailability
// answers carry the newest publication pointer (gateway loop G.4).
std::string error_decision(const std::string& format, int status,
                           const std::string& message, const std::string& pnm_slice) {
    char status_buf[16];
    std::snprintf(status_buf, sizeof(status_buf), "%d", status);
    std::string out = "{\"route\":\"error\",\"format\":\"" + format + "\",\"status\":";
    out += status_buf;
    out += ",\"error\":\"" + json_escape(message) + "\"";
    if (!pnm_slice.empty()) {
        out += ",\"pnm\":" + pnm_slice;
    }
    out += "}";
    return out;
}

struct DecisionInfo {
    std::string raw;
    std::string route;
    std::string format = "flatbuffer";
    std::string peer_id;
};

int read_decision(DecisionInfo* out) {
    const plugin_input_frame_t* decision_frame = find_input("decision");
    if (!decision_frame || !decision_frame->payload || decision_frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame",
                         "discovery-shape requires a decision JSON frame on port \"decision\".");
        return 400;
    }
    out->raw = frame_as_string(decision_frame);
    if (!json_string_field(out->raw, "route", &out->route) || out->route.empty()) {
        plugin_set_error("invalid-decision-frame",
                         "Decision frame does not carry a \"route\" field.");
        return 400;
    }
    std::string format_field;
    if (json_string_field(out->raw, "format", &format_field) && format_field == "json") {
        out->format = "json";
    }
    json_string_field(out->raw, "peerId", &out->peer_id);
    return 0;
}

int forward_not_found(const DecisionInfo& decision) {
    return push_string("decision", decision.raw);
}

// Route-ownership guard: the discover router also emits routes served by
// SIBLING flows (peers / standards / pnm-history are separate mounts); a
// shape method answers 404 for routes it does not own instead of
// misinterpreting them.
int reject_unowned_route(const DecisionInfo& decision) {
    return push_string("decision",
                       not_found_decision(decision.format,
                                          "route " + decision.route +
                                              " is not served by this mount"));
}

}  // namespace

extern "C" {

// peers: decision + peers_snapshot envelope -> decision/body/etag.
int shape_peers(void) {
    DecisionInfo decision;
    if (const int status = read_decision(&decision)) return status;
    if (decision.route == "not_found") {
        return forward_not_found(decision);
    }
    if (decision.route != "peers_list" && decision.route != "peer_get") {
        return reject_unowned_route(decision);
    }

    const plugin_input_frame_t* snapshot_frame = find_input("snapshot");
    Snapshot snapshot;
    std::string error;
    if (!snapshot_frame ||
        !parse_snapshot(snapshot_frame->payload, snapshot_frame->payload_length, &snapshot, &error)) {
        plugin_set_error("invalid-snapshot", error.empty() ? "missing snapshot envelope." : error.c_str());
        return 502;
    }

    const std::vector<PeerEntry> all = parse_peer_entries(snapshot.result);
    const std::vector<StreamFrame> frames =
        index_stream_frames(snapshot.stream, snapshot.stream_length);

    std::vector<const PeerEntry*> selected;
    if (decision.route == "peer_get") {
        for (const PeerEntry& entry : all) {
            if (entry.peer_id == decision.peer_id) {
                selected.push_back(&entry);
                break;
            }
        }
        if (selected.empty()) {
            return push_string("decision",
                               not_found_decision(decision.format,
                                                  "peer " + decision.peer_id +
                                                      " unknown to this node"));
        }
    } else {
        selected.reserve(all.size());
        for (const PeerEntry& entry : all) selected.push_back(&entry);
    }

    // fb stream: stored profile verbatim, else synthesized minimal EPM. The
    // etag hashes THESE bytes for both encodings.
    std::vector<uint8_t> stream;
    for (const PeerEntry* entry : selected) {
        if (entry->epm_index >= 0 &&
            entry->epm_index < static_cast<int64_t>(frames.size())) {
            append_frame(&stream, frames[static_cast<size_t>(entry->epm_index)]);
        } else {
            const std::vector<uint8_t> synthesized = synthesize_epm(*entry);
            stream.insert(stream.end(), synthesized.begin(), synthesized.end());
        }
    }
    const std::string etag =
        fnv1a64_etag(stream.data(), static_cast<uint32_t>(stream.size()));

    if (push_string("decision", decision.raw) != 0 ||
        push_string("etag", etag) != 0) {
        plugin_set_error("push-failed", "failed to push decision/etag frames.");
        return 500;
    }
    if (decision.format == "json") {
        std::string body = "[";
        for (size_t i = 0; i < selected.size(); i++) {
            if (i > 0) body += ",";
            body += peer_presentation_json(*selected[i], frames);
        }
        body += "]";
        if (push_string("body", body) != 0) {
            plugin_set_error("push-failed", "failed to push the json body frame.");
            return 500;
        }
        return 0;
    }
    if (push_bytes("body", stream.data(), static_cast<uint32_t>(stream.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the stream body frame.");
        return 500;
    }
    return 0;
}

// standards: decision + standards_snapshot envelope -> decision/body/etag.
int shape_standards(void) {
    DecisionInfo decision;
    if (const int status = read_decision(&decision)) return status;
    if (decision.route == "not_found") {
        return forward_not_found(decision);
    }
    if (decision.route != "standards") {
        return reject_unowned_route(decision);
    }

    const plugin_input_frame_t* snapshot_frame = find_input("snapshot");
    Snapshot snapshot;
    std::string error;
    if (!snapshot_frame ||
        !parse_snapshot(snapshot_frame->payload, snapshot_frame->payload_length, &snapshot, &error)) {
        plugin_set_error("invalid-snapshot", error.empty() ? "missing snapshot envelope." : error.c_str());
        return 502;
    }

    const std::vector<StreamFrame> frames =
        index_stream_frames(snapshot.stream, snapshot.stream_length);
    const std::string entries_slice = json_array_slice(snapshot.result, "entries");
    const std::vector<std::string> entries = json_array_elements(entries_slice);

    // fb stream: the newest $PNM per (peer, standard), spliced verbatim in
    // entry order via each entry's pnm_index.
    std::vector<uint8_t> stream;
    std::string body = "[";
    size_t emitted = 0;
    for (const std::string& element : entries) {
        if (element.empty() || element.front() != '{') continue;
        int64_t pnm_index = -1;
        json_int_field(element, "pnm_index", &pnm_index);
        if (pnm_index < 0 || pnm_index >= static_cast<int64_t>(frames.size())) continue;
        append_frame(&stream, frames[static_cast<size_t>(pnm_index)]);

        if (emitted > 0) body += ",";
        std::string value;
        body += "{";
        body += "\"peer_id\":";
        body += json_string_field(element, "peer_id", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"standard\":";
        body += json_string_field(element, "standard", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"schema\":";
        body += json_string_field(element, "schema", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"file_id\":";
        body += json_string_field(element, "file_id", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"file_name\":";
        body += json_string_field(element, "file_name", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"cid\":";
        body += json_string_field(element, "cid", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += ",\"publish_timestamp\":";
        body += json_string_field(element, "publish_timestamp", &value)
                    ? "\"" + json_escape(value) + "\"" : "null";
        body += "}";
        emitted++;
    }
    body += "]";

    const std::string etag =
        fnv1a64_etag(stream.data(), static_cast<uint32_t>(stream.size()));
    if (push_string("decision", decision.raw) != 0 ||
        push_string("etag", etag) != 0) {
        plugin_set_error("push-failed", "failed to push decision/etag frames.");
        return 500;
    }
    if (decision.format == "json") {
        if (push_string("body", body) != 0) {
            plugin_set_error("push-failed", "failed to push the json body frame.");
            return 500;
        }
        return 0;
    }
    if (push_bytes("body", stream.data(), static_cast<uint32_t>(stream.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the stream body frame.");
        return 500;
    }
    return 0;
}

// pnm: decision + pnm_history envelope -> decision/body/etag (loop G.3).
int shape_pnm(void) {
    DecisionInfo decision;
    if (const int status = read_decision(&decision)) return status;
    if (decision.route == "not_found") {
        return forward_not_found(decision);
    }
    if (decision.route != "pnm_history") {
        return reject_unowned_route(decision);
    }

    const plugin_input_frame_t* snapshot_frame = find_input("snapshot");
    Snapshot snapshot;
    std::string error;
    if (!snapshot_frame ||
        !parse_snapshot(snapshot_frame->payload, snapshot_frame->payload_length, &snapshot, &error)) {
        plugin_set_error("invalid-snapshot", error.empty() ? "missing snapshot envelope." : error.c_str());
        return 502;
    }

    const std::vector<StreamFrame> frames =
        index_stream_frames(snapshot.stream, snapshot.stream_length);
    const std::string entries_slice = json_array_slice(snapshot.result, "entries");
    const std::vector<std::string> entries = json_array_elements(entries_slice);

    // fb stream: the publisher's signed $PNM frames VERBATIM, newest first
    // (host order), spliced via each entry's pnm_index. The json body is the
    // same records as a bare array with the provenance fields exposed.
    std::vector<uint8_t> stream;
    std::string body = "[";
    size_t emitted = 0;
    for (const std::string& element : entries) {
        if (element.empty() || element.front() != '{') continue;
        int64_t pnm_index = -1;
        json_int_field(element, "pnm_index", &pnm_index);
        if (pnm_index < 0 || pnm_index >= static_cast<int64_t>(frames.size())) continue;
        append_frame(&stream, frames[static_cast<size_t>(pnm_index)]);

        if (emitted > 0) body += ",";
        std::string value;
        bool flag = false;
        body += "{";
        const auto string_field = [&](const char* json_key, const char* out_key, bool leading_comma) {
            if (leading_comma) body += ",";
            body += "\"";
            body += out_key;
            body += "\":";
            body += json_string_field(element, json_key, &value)
                        ? "\"" + json_escape(value) + "\"" : "null";
        };
        string_field("publisher_peer_id", "publisher_peer_id", false);
        string_field("gossip_peer_id", "gossip_peer_id", true);
        string_field("standard", "standard", true);
        string_field("schema", "schema", true);
        string_field("file_id", "file_id", true);
        string_field("file_name", "file_name", true);
        string_field("cid", "cid", true);
        string_field("publish_timestamp", "publish_timestamp", true);
        string_field("signature_type", "signature_type", true);
        string_field("signature", "signature", true);
        body += ",\"signature_verified\":";
        body += (json_bool_field(element, "signature_verified", &flag) && flag) ? "true" : "false";
        string_field("attribution", "attribution", true);
        string_field("publisher_key", "publisher_key", true);
        string_field("publisher_key_source", "publisher_key_source", true);
        body += "}";
        emitted++;
    }
    body += "]";

    if (emitted == 0) {
        // Peer unknown here, no key + no gossip match, or nothing signed
        // stored: an empty publication history is a 404, not an empty 200.
        return push_string("decision",
                           not_found_decision(decision.format,
                                              "no signed PNM publications recorded for peer " +
                                                  decision.peer_id));
    }

    const std::string etag =
        fnv1a64_etag(stream.data(), static_cast<uint32_t>(stream.size()));
    if (push_string("decision", decision.raw) != 0 ||
        push_string("etag", etag) != 0) {
        plugin_set_error("push-failed", "failed to push decision/etag frames.");
        return 500;
    }
    if (decision.format == "json") {
        if (push_string("body", body) != 0) {
            plugin_set_error("push-failed", "failed to push the json body frame.");
            return 500;
        }
        return 0;
    }
    if (push_bytes("body", stream.data(), static_cast<uint32_t>(stream.size())) != 0) {
        plugin_set_error("push-failed", "failed to push the stream body frame.");
        return 500;
    }
    return 0;
}

// latest: decision + latest_dataset envelope -> decision/body|stream/etag
// (gateway loop G.4).
int shape_latest(void) {
    DecisionInfo decision;
    if (const int status = read_decision(&decision)) return status;
    if (decision.route == "not_found") {
        return forward_not_found(decision);
    }
    if (decision.route != "latest_dataset") {
        return reject_unowned_route(decision);
    }
    std::string standard;
    json_string_field(decision.raw, "standard", &standard);

    const plugin_input_frame_t* snapshot_frame = find_input("snapshot");
    Snapshot snapshot;
    std::string error;
    if (!snapshot_frame ||
        !parse_snapshot(snapshot_frame->payload, snapshot_frame->payload_length, &snapshot, &error)) {
        plugin_set_error("invalid-snapshot", error.empty() ? "missing snapshot envelope." : error.c_str());
        return 502;
    }

    bool known = false;
    json_bool_field(snapshot.result, "known", &known);
    // Top-level "pnm" = the NEWEST publication pointer. Go marshals the
    // result keys alphabetically, so the top-level "pnm" precedes "serving"
    // (whose nested pointer names the SERVED batch).
    const std::string pnm_slice = json_object_slice(snapshot.result, "pnm");

    if (!known) {
        // No attributable publications / unknown standard: an honest 404.
        return push_string("decision",
                           not_found_decision(decision.format,
                                              "no published dataset for standard " + standard +
                                                  " from peer " + decision.peer_id));
    }

    const std::string serving = json_object_slice(snapshot.result, "serving");
    if (serving.empty()) {
        // Known via signed PNM but not served here (not pinned, or the
        // pinned batch is not materialized yet): 503 + the PNM pointer so
        // the client can fetch the publication itself over p2p. NO silent
        // proxying (user decision, docs/gateway-api.md §10).
        std::string reason;
        json_string_field(snapshot.result, "reason", &reason);
        std::string message;
        if (reason == "not-pinned") {
            message = "dataset " + standard + " from peer " + decision.peer_id +
                      " is not pinned on this gateway (gateway.pin is opt-in); fetch the publication via the pnm pointer";
        } else {
            message = "dataset " + standard + " from peer " + decision.peer_id +
                      " is not materialized on this gateway yet; fetch the publication via the pnm pointer";
        }
        return push_string("decision", error_decision(decision.format, 503, message, pnm_slice));
    }

    std::string etag_hex;
    json_string_field(serving, "etag_fnv1a64", &etag_hex);
    const std::string etag = "W/\"fnv1a64-" + etag_hex + "\"";

    if (decision.format == "json") {
        std::string schema;
        json_string_field(snapshot.result, "schema", &schema);
        if (schema != "OMM.fbs") {
            // No json presentation adapter for this standard (v1 ships
            // foundation/omm-json only): answer 406, never a lossy guess.
            return push_string("decision",
                               error_decision(decision.format, 406,
                                              "format=json is not available for " + standard +
                                                  " on this surface; use the default flatbuffer stream",
                                              pnm_slice));
        }
        if (!snapshot.stream || snapshot.stream_length == 0) {
            plugin_set_error("missing-stream",
                             "latest_dataset json path requires the inline stream segment.");
            return 502;
        }
        if (push_string("decision", decision.raw) != 0 ||
            push_string("etag", etag) != 0 ||
            push_bytes("stream", snapshot.stream, snapshot.stream_length) != 0) {
            plugin_set_error("push-failed", "failed to push decision/etag/stream frames.");
            return 500;
        }
        return 0;
    }

    if (push_string("decision", decision.raw) != 0 ||
        push_string("etag", etag) != 0) {
        plugin_set_error("push-failed", "failed to push decision/etag frames.");
        return 500;
    }
    const std::string ref = json_object_slice(serving, "ref");
    if (!ref.empty()) {
        // Forward the host's body reference as the $HTR descriptor: the
        // stream bytes never enter this module's linear memory.
        int64_t token = 0, size = 0, frames = 0;
        std::string fnv;
        if (!json_int_field(ref, "token", &token) || !json_int_field(ref, "size", &size)) {
            plugin_set_error("invalid-ref", "latest_dataset ref is missing token/size.");
            return 502;
        }
        json_int_field(ref, "frames", &frames);
        json_string_field(ref, "fnv1a64", &fnv);
        char buf[160];
        std::snprintf(buf, sizeof(buf),
                      "{\"$sdnbodyref\":1,\"token\":%lld,\"size\":%lld,\"frames\":%lld,\"fnv1a64\":\"%s\"}",
                      static_cast<long long>(token), static_cast<long long>(size),
                      static_cast<long long>(frames), fnv.c_str());
        if (push_string("body", buf) != 0) {
            plugin_set_error("push-failed", "failed to push the body-reference frame.");
            return 500;
        }
        return 0;
    }
    if (!snapshot.stream || snapshot.stream_length == 0) {
        plugin_set_error("missing-stream",
                         "latest_dataset envelope carries neither a ref nor a stream segment.");
        return 502;
    }
    if (push_bytes("body", snapshot.stream, snapshot.stream_length) != 0) {
        plugin_set_error("push-failed", "failed to push the stream body frame.");
        return 500;
    }
    return 0;
}

}  // extern "C"
