/*
 * hostcap/p2p-discovery — the host p2p_read discovery connector (typed contracts 1.0).
 *
 * Every method takes ONE "decision" frame, an $APR (SDS API Request: the routing decision foundation/http-route
 * made) and answers with the "decision" $APR beside a typed body:
 *
 *   peers_snapshot      routes peers_list / peer_get  -> p2p.peers_snapshot      -> "peers"         $NST
 *   standards_snapshot  route  standards              -> p2p.standards_snapshot  -> "notices"       $PNV
 *   pnm_history         route  pnm_history            -> p2p.pnm_history         -> "notices"       $PNV
 *   latest_dataset      route  latest_dataset         -> p2p.latest_dataset      -> "availability"  $DAV
 *                                                                                  + "<code>_records" (the batch)
 *
 * The hostcalls are SDS $PIV invocations (P2pParams aligned record; P2pSummary / P2pLatestDataset results; list
 * ports peers / peer_addresses / peer_standards / entries; raw "records" / "stream").
 *
 * The decision passes through VERBATIM when the request is served. An APR that already carries a STATUS, or names a
 * route this method does not own, is passed on with NO hostcall (a route not owned becomes 404 "no-route"). A request
 * that cannot be served answers a copy of the APR with STATUS / ERROR_CODE / ERROR_MESSAGE set:
 *   400 invalid-parameter  a peerId / standard longer than the hostcall record holds (refused, never truncated)
 *   404 peer-unknown       peer_get for a peer the node does not know
 *   404 no-publications    pnm_history with no signed publications recorded
 *   404 not-published      latest_dataset: no publication of the lane is known (DAV beside it)
 *   404 not-served         latest_dataset: the standard has no record port here (DAV beside it)
 *   503 dataset-unavailable latest_dataset: known but not servable here (DAV with the newest PNM pointer)
 *   502 host-failed        the p2p hostcall failed
 *
 * $NST and $PNV carry an ETAG: a weak FNV-1a 64 over the record built without GENERATED_AT / ETAG, so identical
 * content carries the same tag on every call. Each PNVEntry carries the received $PNM verbatim (PNM) when the host
 * returns it. latest_dataset asks DELIVER Ref unless the request wants JSON; a host BodyRef rides DAV.BODY_REF_TOKEN /
 * BODY_REF_SIZE and no *_records frame is pushed (the responder answers it out of band).
 *
 * GENERATED_AT stamps come from clock.now (0 when the clock is refused). No JSON anywhere.
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
#include "APR_generated.h"  // spacedatastandards.org lib/cpp/<CODE>/main_generated.h, all inlined by build.mjs
#include "NST_generated.h"
#include "PNV_generated.h"
#include "DAV_generated.h"
#include "EPM_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;

// The record ports of latest_dataset (one per standard: a typed port names one type). Same list as
// hostcap/storage-ingest's *_records ports.
const char* const kRecordCodes[] = {"omm", "mpe", "cat", "spw", "eop", "csm", "egp", "sit", "lcc",
                                    "tbs", "gnp", "wxf", "cnp", "rfb", "iqc", "tct", "dtt"};

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// The compiled flow runtime fills an invocation by popping the node's queue PORT-BLIND up to a drain budget of 64;
// maxStreams / maxBatch / drainPolicy are declarative only. Each method answers ONE discovery request with ONE
// snapshot, so a second decision frame would be answered from the first one's hostcall or destroyed. It is refused.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
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

std::string lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return out;
}

// Weak FNV-1a 64 entity tag (word-folded: 8-byte little-endian words, then the tail bytes) - the algorithm of the
// gateway's other entity tags, so identical content carries identical tags.
std::string fnv1a64_etag(const uint8_t* data, size_t length) {
    constexpr uint64_t kPrime = 1099511628211ull;
    uint64_t hash = 1469598103934665603ull;
    size_t i = 0;
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
    std::snprintf(buf, sizeof buf, "W/\"fnv1a64-%016llx\"", static_cast<unsigned long long>(hash));
    return buf;
}

// --- output ----------------------------------------------------------------------------------------------------------

int push(const char* port, const char* code, flatbuffers::FlatBufferBuilder& b) {
    const std::string schema = std::string(code) + ".fbs";
    const std::string id = std::string("$") + code;
    return plugin_push_output_ex(port, schema.c_str(), id.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, code, 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0
               ? 500
               : 0;
}

struct Decision {
    const plugin_input_frame_t* frame = nullptr;
    const APR* apr = nullptr;
    std::string param(const char* name) const {
        if (!apr->PARAMETERS()) return std::string();
        for (const auto* p : *apr->PARAMETERS()) {
            if (p && p->NAME() && p->NAME()->str() == name) return p->VALUE() ? p->VALUE()->str() : std::string();
        }
        return std::string();
    }
    std::string route() const { return apr->ROUTE() ? apr->ROUTE()->str() : std::string(); }
};

// The decision verbatim (the request is being served as routed).
int pass(const Decision& d) {
    return plugin_push_output_ex("decision", "APR.fbs", "$APR", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 0,
                                 d.frame->payload, d.frame->payload_length) < 0
               ? 500
               : 0;
}

// A copy of the decision answering STATUS / ERROR_CODE / ERROR_MESSAGE.
int refuse(const Decision& d, uint16_t status, const char* code, const std::string& message) {
    APRT copy;
    d.apr->UnPackTo(&copy);
    copy.STATUS = status;
    copy.ERROR_CODE = code;
    copy.ERROR_MESSAGE = message;
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &copy));
    return push("decision", "APR", b);
}

// Reads the "decision" APR. Returns 0 and fills `out`, or the invoke status after setting the error.
int read_decision(Decision* out) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }
    const int32_t index = plugin_find_input_index("decision", 0);
    const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-decision-frame", "p2p-discovery requires an $APR frame on port \"decision\".");
        return 400;
    }
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!APRBufferHasIdentifier(frame->payload) || !VerifyAPRBuffer(verifier)) {
        plugin_set_error("invalid-decision-frame", "the \"decision\" frame is not an $APR.");
        return 400;
    }
    out->frame = frame;
    out->apr = GetAPR(frame->payload);
    return 0;
}

// Pass-through rules: a decided status, or a route this method does not own. Returns -1 when the method serves it.
int passthrough(const Decision& d, const char* route_a, const char* route_b) {
    if (d.apr->STATUS() != 0) return pass(d);
    const std::string route = d.route();
    if (route == route_a || (route_b && route == route_b)) return -1;
    return refuse(d, 404, "no-route", "route \"" + route + "\" is not served by this discovery flow");
}

// --- hostcall helpers ---------------------------------------------------------------------------------------------------

int64_t now_ms() {
    const auto r = sdm_piv::call("clock.now");
    const auto* v = r.ok() ? r.result<A::TimeValue>("TimeValue") : nullptr;
    return v ? static_cast<int64_t>(v->UNIX_MS) : 0;
}

std::string node_peer_id() {
    const auto r = sdm_piv::call("node.peerId");
    return r.ok() ? std::string(r.raw("value")) : std::string();
}

// P2pParams from the decision; false (and the decision refused 400) when a value exceeds its bound.
bool build_params(const Decision& d, A::P2pParams* params, bool with_peer, bool with_standard, int* status) {
    *params = A::P2pParams{};
    params->DELIVER = A::deliverMode_Inline;
    if (with_peer) {
        const std::string peer = d.param("peerId");
        if (!peer.empty()) {
            if (!sdm_piv::put(params->PEER_ID, peer)) {
                *status = refuse(d, 400, "invalid-parameter",
                                 "peerId is " + std::to_string(peer.size()) +
                                     " bytes; the p2p hostcall record holds at most 128 - refused, not truncated");
                return false;
            }
            params->set_has_PEER_ID(true);
        }
    }
    if (with_standard) {
        const std::string standard = d.param("standard");
        if (!standard.empty()) {
            if (!sdm_piv::put(params->STANDARD, standard)) {
                *status = refuse(d, 400, "invalid-parameter",
                                 "standard is " + std::to_string(standard.size()) +
                                     " bytes; the p2p hostcall record holds at most 16 - refused, not truncated");
                return false;
            }
            params->set_has_STANDARD(true);
        }
    }
    return true;
}

sdm_piv::Response call_p2p(const char* op, const A::P2pParams& params) {
    return sdm_piv::call(op, "P2pParams", params);
}

int host_failed(const Decision& d, const char* op, const sdm_piv::Response& r) {
    std::string message = r.error_message();
    if (message.empty()) message = std::string(op) + " hostcall failed.";
    return refuse(d, 502, "host-failed", r.error_code() + ": " + message);
}

// The size-prefixed frames of a raw record stream (zero-length prefixes skipped as padding).
std::vector<std::string_view> stream_frames(std::string_view stream) {
    std::vector<std::string_view> frames;
    size_t at = 0;
    while (at + 4 <= stream.size()) {
        uint32_t size;
        std::memcpy(&size, stream.data() + at, 4);
        at += 4;
        if (size == 0) continue;
        if (size > stream.size() - at) break;
        frames.push_back(stream.substr(at - 4, size + 4));  // with its prefix
        at += size;
    }
    return frames;
}

std::vector<uint8_t> hex_decode(std::string_view hex) {
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::vector<uint8_t> out;
    if (hex.size() >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex.remove_prefix(2);
    if (hex.size() % 2) return {};
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int hi = nib(hex[i]), lo = nib(hex[i + 1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return out;
}

// --- peers -------------------------------------------------------------------------------------------------------------

// One peer row before it is written ($NST has no generated object API, so rows are built with CreateNSTNodeDirect).
struct PeerRow {
    std::string peer_id, dn, organization, agent_version, source, signing_key, encryption_key;
    std::vector<std::string> addresses, standards;
    bool online = false, self = false;
};

const char* opt(const std::string& s) { return s.empty() ? nullptr : s.c_str(); }

// Fill identity fields from a stored $EPM frame ([u32 size][EPM], built size-prefixed or plain).
void apply_epm(std::string_view framed, PeerRow* row) {
    std::vector<uint8_t> scratch(framed.begin(), framed.end());  // an aligned copy for in-place reads
    const EPM* epm = nullptr;
    flatbuffers::Verifier prefixed(scratch.data(), scratch.size());
    if (VerifySizePrefixedEPMBuffer(prefixed)) {
        epm = GetSizePrefixedEPM(scratch.data());
    } else {
        scratch.erase(scratch.begin(), scratch.begin() + 4);
        flatbuffers::Verifier plain(scratch.data(), scratch.size());
        if (EPMBufferHasIdentifier(scratch.data()) && VerifyEPMBuffer(plain)) epm = GetEPM(scratch.data());
    }
    if (!epm) return;
    if (epm->DN()) row->dn = epm->DN()->str();
    if (epm->LEGAL_NAME()) row->organization = epm->LEGAL_NAME()->str();
    if (const auto* keys = epm->KEYS()) {
        for (const auto* key : *keys) {
            if (!key || !key->PUBLIC_KEY()) continue;
            if (key->KEY_TYPE() == KeyType_Signing && row->signing_key.empty()) row->signing_key = key->PUBLIC_KEY()->str();
            if (key->KEY_TYPE() == KeyType_Encryption && row->encryption_key.empty()) row->encryption_key = key->PUBLIC_KEY()->str();
        }
    }
}

int serve_peers() {
    Decision d;
    if (const int status = read_decision(&d)) return status;
    if (const int status = passthrough(d, "peers_list", "peer_get"); status >= 0) return status;
    const bool one = d.route() == "peer_get";
    A::P2pParams params;
    int status = 0;
    if (!build_params(d, &params, one, false, &status)) return status;

    const auto r = call_p2p("p2p.peers_snapshot", params);
    if (!r.ok()) return host_failed(d, "p2p.peers_snapshot", r);
    const auto* summary = r.result<A::P2pSummary>("P2pSummary");
    const auto [peers, peer_count] = r.list<A::P2pPeer>("peers", "P2pPeer");
    const auto [addresses, address_count] = r.list<A::P2pPeerValue>("peer_addresses", "P2pPeerValue");
    const auto [standards, standard_count] = r.list<A::P2pPeerValue>("peer_standards", "P2pPeerValue");
    const std::vector<std::string_view> epms = stream_frames(r.raw("records"));
    const std::string wanted = d.param("peerId");

    std::vector<PeerRow> rows;
    for (size_t i = 0; i < peer_count; i++) {
        const A::P2pPeer& peer = peers[i];
        PeerRow row;
        row.peer_id = peer.PEER_ID.str();
        if (one && row.peer_id != wanted) continue;
        row.agent_version = peer.AGENT_VERSION.str();
        row.online = peer.CONNECTED;
        row.self = peer.SELF;
        row.source = peer.CONNECTED ? "connected" : "";
        for (size_t k = 0; k < address_count; k++) {
            if (addresses[k].PEER_ID.str() == row.peer_id) row.addresses.push_back(addresses[k].VALUE.str());
        }
        for (size_t k = 0; k < standard_count; k++) {
            if (standards[k].PEER_ID.str() == row.peer_id) row.standards.push_back(standards[k].VALUE.str());
        }
        if (peer.EPM_INDEX >= 0 && static_cast<size_t>(peer.EPM_INDEX) < epms.size()) apply_epm(epms[peer.EPM_INDEX], &row);
        rows.push_back(std::move(row));
    }
    if (one && rows.empty()) return refuse(d, 404, "peer-unknown", "peer " + wanted + " unknown to this node");

    // The set as built twice: once without GENERATED_AT / ETAG (its content tag: identical peers, identical tag on
    // every call, whatever the clock says), then with both.
    const std::string self = summary ? summary->SELF.str() : std::string();
    const auto build_nst = [&](flatbuffers::FlatBufferBuilder& b, int64_t generated_at, const char* etag) {
        std::vector<flatbuffers::Offset<NSTNode>> nodes;
        for (const PeerRow& row : rows) {
            std::vector<flatbuffers::Offset<flatbuffers::String>> addrs, stds;
            for (const std::string& a : row.addresses) addrs.push_back(b.CreateString(a));
            for (const std::string& c : row.standards) stds.push_back(b.CreateString(c));
            nodes.push_back(CreateNSTNodeDirect(b, opt(row.peer_id), opt(row.dn), opt(row.organization), nullptr, nullptr,
                                                opt(row.agent_version), addrs.empty() ? nullptr : &addrs, 0, row.online,
                                                0.0f, nullptr, 0.0f, 0.0f, nullptr, nullptr, row.self, 0, nullptr, nullptr,
                                                opt(row.source), false, nullptr, nullptr, opt(row.signing_key),
                                                opt(row.encryption_key), nullptr, nullptr, nullptr,
                                                stds.empty() ? nullptr : &stds));
        }
        FinishNSTBuffer(b, CreateNSTDirect(b, &nodes, generated_at, opt(self), etag));
    };
    flatbuffers::FlatBufferBuilder content(1024);
    build_nst(content, 0, nullptr);
    const std::string etag = fnv1a64_etag(content.GetBufferPointer(), content.GetSize());
    flatbuffers::FlatBufferBuilder b(1024);
    build_nst(b, now_ms(), etag.c_str());
    if (const int s = pass(d)) return s;
    return push("peers", "NST", b);
}

// --- notices -----------------------------------------------------------------------------------------------------------

pnvAttribution attribution_of(const std::string& text, const std::string& publisher, const std::string& gossip,
                              const std::string& self) {
    const std::string a = lower(text);
    if (a == "self" || a == "own") return pnvAttribution_OwnNode;
    if (a == "signature") {
        if (!self.empty() && publisher == self) return pnvAttribution_OwnNode;
        return publisher == gossip ? pnvAttribution_Direct : pnvAttribution_Relayed;
    }
    if (a == "gossip") return pnvAttribution_Unattributed;
    return pnvAttribution_Unknown;
}

pnvKeySource key_source_of(const std::string& text) {
    const std::string k = lower(text);
    if (k == "epm-directory" || k == "epm") return pnvKeySource_IdentityRecord;
    if (k == "peer-id" || k == "peerid") return pnvKeySource_PeerIdentifier;
    if (k == "operator" || k == "config") return pnvKeySource_OperatorTrust;
    if (k == "pnm" || k == "self-asserted") return pnvKeySource_SelfAsserted;
    return pnvKeySource_None;
}

PNVT notices_of(const A::P2pPnmEntry* entries, size_t count, const std::string& verifier,
                const std::vector<std::string_view>& pnms) {
    PNVT pnv;
    pnv.VERIFIER_PEER_ID = verifier;
    for (size_t i = 0; i < count; i++) {
        const A::P2pPnmEntry& e = entries[i];
        auto entry = std::make_unique<PNVEntryT>();
        const std::string publisher = e.PUBLISHER_PEER_ID.length ? e.PUBLISHER_PEER_ID.str() : e.PEER_ID.str();
        entry->PUBLISHER_PEER_ID = publisher;
        entry->RECEIVED_FROM_PEER_ID = e.GOSSIP_PEER_ID.str();
        entry->STANDARD = e.STANDARD.str();
        entry->SCHEMA_NAME = e.SCHEMA.str();
        entry->FILE_ID = e.FILE_ID.str();
        entry->FILE_NAME = e.FILE_NAME.str();
        entry->CID = e.CID.str();
        entry->PUBLISHED_AT_MS = static_cast<int64_t>(e.PUBLISH_MS);
        entry->SIGNATURE_TYPE = e.SIGNATURE_TYPE.str();
        entry->SIGNATURE = hex_decode(e.SIGNATURE_HEX.str());
        entry->SIGNATURE_VERIFIED = e.SIGNATURE_VERIFIED;
        entry->ATTRIBUTION = attribution_of(e.ATTRIBUTION.str(), publisher, entry->RECEIVED_FROM_PEER_ID, verifier);
        entry->PUBLISHER_KEY = hex_decode(e.PUBLISHER_KEY_HEX.str());
        entry->KEY_SOURCE = key_source_of(e.PUBLISHER_KEY_SOURCE.str());
        // The notice itself, verbatim (size-prefixed), so a reader can verify the signature on its own.
        if (e.PNM_INDEX >= 0 && static_cast<size_t>(e.PNM_INDEX) < pnms.size()) {
            const std::string_view pnm = pnms[e.PNM_INDEX];
            entry->PNM.assign(pnm.begin(), pnm.end());
        }
        if (!e.SIGNATURE_VERIFIED) {
            const std::string a = e.ATTRIBUTION.str();
            entry->REASON = a.empty() ? "signature not verified" : "signature not verified (attribution: " + a + ")";
        }
        pnv.ENTRIES.push_back(std::move(entry));
    }
    return pnv;
}

int push_notices(const Decision& d, PNVT& pnv) {
    // Content tag first: built without GENERATED_AT_MS / ETAG, so identical verdicts carry identical tags.
    pnv.GENERATED_AT_MS = 0;
    pnv.ETAG.clear();
    flatbuffers::FlatBufferBuilder content(1024);
    FinishPNVBuffer(content, PNV::Pack(content, &pnv));
    pnv.ETAG = fnv1a64_etag(content.GetBufferPointer(), content.GetSize());
    pnv.GENERATED_AT_MS = now_ms();
    flatbuffers::FlatBufferBuilder b(1024);
    FinishPNVBuffer(b, PNV::Pack(b, &pnv));
    if (const int s = pass(d)) return s;
    return push("notices", "PNV", b);
}

int serve_standards() {
    Decision d;
    if (const int status = read_decision(&d)) return status;
    if (const int status = passthrough(d, "standards", nullptr); status >= 0) return status;
    A::P2pParams params;
    int status = 0;
    if (!build_params(d, &params, false, false, &status)) return status;
    const auto r = call_p2p("p2p.standards_snapshot", params);
    if (!r.ok()) return host_failed(d, "p2p.standards_snapshot", r);
    const auto [entries, count] = r.list<A::P2pPnmEntry>("entries", "P2pPnmEntry");
    PNVT pnv = notices_of(entries, count, node_peer_id(), stream_frames(r.raw("records")));
    return push_notices(d, pnv);
}

int serve_pnm_history() {
    Decision d;
    if (const int status = read_decision(&d)) return status;
    if (const int status = passthrough(d, "pnm_history", nullptr); status >= 0) return status;
    A::P2pParams params;
    int status = 0;
    if (!build_params(d, &params, true, false, &status)) return status;
    // The route node clamps ?limit to [1, 100]; re-clamped here, default 1 = the newest publication.
    long limit = 1;
    const std::string text = d.param("limit");
    if (!text.empty()) {
        char* end = nullptr;
        const long parsed = std::strtol(text.c_str(), &end, 10);
        if (end && *end == '\0') limit = parsed;
    }
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    params.LIMIT = static_cast<uint32_t>(limit);

    const auto r = call_p2p("p2p.pnm_history", params);
    if (!r.ok()) return host_failed(d, "p2p.pnm_history", r);
    const auto* summary = r.result<A::P2pSummary>("P2pSummary");
    const auto [entries, count] = r.list<A::P2pPnmEntry>("entries", "P2pPnmEntry");
    if (count == 0) {
        return refuse(d, 404, "no-publications", "no signed PNM publications recorded for peer " + d.param("peerId"));
    }
    PNVT pnv = notices_of(entries, count, summary && summary->SELF.length ? summary->SELF.str() : node_peer_id(),
                          stream_frames(r.raw("records")));
    return push_notices(d, pnv);
}

// --- latest dataset ----------------------------------------------------------------------------------------------------

davUnavailableReason reason_of(const std::string& text) {
    const std::string r = lower(text);
    if (r == "stale") return davUnavailableReason_Stale;
    if (r == "unverified") return davUnavailableReason_Unverified;
    if (r == "not-entitled") return davUnavailableReason_NotEntitled;
    return davUnavailableReason_NotHeld;  // not-pinned, not-materialized, not-held, and anything else held back
}

int serve_latest() {
    Decision d;
    if (const int status = read_decision(&d)) return status;
    if (const int status = passthrough(d, "latest_dataset", nullptr); status >= 0) return status;
    A::P2pParams params;
    int status = 0;
    if (!build_params(d, &params, true, true, &status)) return status;
    // Out-of-band delivery unless the client asked for JSON (the responder must then render the bytes in-flow).
    if (d.apr->ACCEPT() != aprRepresentation_Json) params.DELIVER = A::deliverMode_Ref;
    const auto r = call_p2p("p2p.latest_dataset", params);
    if (!r.ok()) return host_failed(d, "p2p.latest_dataset", r);
    const auto* latest = r.result<A::P2pLatestDataset>("P2pLatestDataset");
    if (!latest) return refuse(d, 502, "host-failed", "p2p.latest_dataset answered without a P2pLatestDataset result");

    DAVT dav;
    dav.STANDARD = latest->STANDARD.length ? latest->STANDARD.str() : d.param("standard");
    dav.SCHEMA_NAME = latest->SCHEMA.str();
    dav.PROVIDER_ID = latest->PROVIDER_ID.str();
    dav.SOURCE_NAME = latest->SOURCE_NAME.str();
    dav.KNOWN = latest->KNOWN;
    dav.SELF_PUBLISHED = latest->SELF;
    dav.PINNED = latest->PINNED;
    dav.FRESH = latest->FRESH;
    dav.BATCH_ID = latest->BATCH_ID.str();
    dav.RECORD_COUNT = latest->RECORD_COUNT;
    dav.BYTE_COUNT = latest->BYTE_COUNT;
    dav.PARTS = latest->PARTS;
    dav.PUBLISHED_AT_MS = static_cast<int64_t>(latest->PUBLISHED_MS);
    dav.PNM_CID = latest->PNM_CID.str();
    dav.PNM_FILE_ID = latest->PNM_FILE_ID.str();
    dav.PNM_PUBLISHED_AT_MS = static_cast<int64_t>(latest->PNM_PUBLISH_MS);
    dav.PNM_SIGNATURE_VERIFIED = latest->PNM_SIGNATURE_VERIFIED;
    dav.PUBLISHER_PEER_ID = d.param("peerId");
    if (latest->ETAG_FNV1A64.length) dav.ETAG = "W/\"fnv1a64-" + latest->ETAG_FNV1A64.str() + "\"";

    // A host that honoured Ref keeps the batch and hands back its reference: the responder answers it out of band.
    const std::string_view stream = r.raw("stream");
    const bool by_ref = latest->REF.TOKEN != 0 && stream.empty();
    if (by_ref) {
        dav.BODY_REF_TOKEN = latest->REF.TOKEN;
        dav.BODY_REF_SIZE = latest->REF.SIZE;
    }

    const std::string reason = latest->REASON.str();
    uint16_t answer = 0;
    const char* code = nullptr;
    std::string message;
    const char* records_port = nullptr;
    std::string port_name;
    if (!latest->KNOWN) {
        dav.UNAVAILABLE_REASON = davUnavailableReason_NotPublished;
        answer = 404, code = "not-published";
        message = "no publication of " + dav.STANDARD + " is known from peer " + dav.PUBLISHER_PEER_ID +
                  (reason.empty() ? "" : " (" + reason + ")");
    } else if (!reason.empty()) {
        dav.UNAVAILABLE_REASON = reason_of(reason);
        answer = 503, code = "dataset-unavailable";
        message = "the latest " + dav.STANDARD + " dataset of peer " + dav.PUBLISHER_PEER_ID +
                  " is known but not servable here: " + reason;
    } else {
        const std::string wanted = lower(dav.STANDARD);
        for (const char* c : kRecordCodes) {
            if (wanted == c) {
                port_name = std::string(c) + "_records";
                records_port = port_name.c_str();
            }
        }
        if (!records_port) {
            dav.UNAVAILABLE_REASON = davUnavailableReason_None;
            answer = 404, code = "not-served";
            message = "standard " + dav.STANDARD + " has no record port on this flow";
        } else {
            dav.AVAILABLE = true;
        }
    }

    flatbuffers::FlatBufferBuilder b(1024);
    FinishDAVBuffer(b, DAV::Pack(b, &dav));
    const int s = answer ? refuse(d, answer, code, message) : pass(d);
    if (s) return s;
    if (const int s2 = push("availability", "DAV", b)) return s2;
    if (!records_port || by_ref) return 0;
    const std::string code_upper = [&] {
        std::string u = dav.STANDARD;
        for (char& c : u) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        return u;
    }();
    const std::string schema = code_upper + ".fbs", id = "$" + code_upper;
    return plugin_push_output_ex(records_port, schema.c_str(), id.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 code_upper.c_str(), 0, 0, reinterpret_cast<const uint8_t*>(stream.data()),
                                 static_cast<uint32_t>(stream.size())) < 0
               ? 500
               : 0;
}

}  // namespace

extern "C" {

int peers_snapshot(void) { return serve_peers(); }
int standards_snapshot(void) { return serve_standards(); }
int pnm_history(void) { return serve_pnm_history(); }
int latest_dataset(void) { return serve_latest(); }

}  // extern "C"
