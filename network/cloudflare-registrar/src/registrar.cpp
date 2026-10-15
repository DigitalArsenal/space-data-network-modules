// Deterministic Cloudflare DNS reconciliation for peer-ID hostnames (typed contracts 1.0: FlatBuffers only).
//   in : dns_records  HttpResponse (HRSP)  - every page of GET /zones/<zone>/dns_records, Cloudflare's JSON body
//                                            (an external API body, parsed here as the weather parsers parse theirs)
//        peers        $NST                 - the peers the node knows (discovery: never a route by itself)
//        verifications $PNV                - the node's verdicts on peers' signed publication notices
//        config       sdm_piv::get_config()- operator choices: zone, inclusion/exclusion, operator-attested origin
//                                            facts, managed record ids
//   out: requests     HttpRequest (HREQ)   - POST/PUT/DELETE dns_records, CONTEXT one size-prefixed $APR naming the
//                                            peer and the action; never executed or credentialed here
//        status       FlowNotice (FNTC)    - one per peer: its hostname and reconciliation status
// The guest never receives credentials; its output is a plan, not evidence of application.
#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "FlowNotice_generated.h"
#include <algorithm>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>
using Json = nlohmann::json;
namespace R = sdn::runtime;
namespace {
const Json& field(const Json& value, const char* key) {
  static const Json absent;
  return value.is_object() && value.contains(key) ? value[key] : absent;
}
std::string text(const Json& value) { return value.is_string() ? value.get<std::string>() : ""; }
bool yes(const Json& value) { return value.is_boolean() && value.get<bool>(); }
bool id(const std::string& value) {
  return value.size() == 32 && std::all_of(value.begin(), value.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
bool domain(const std::string& value) {
  if (value.empty() || value.size() > 189 || value.find('.') == std::string::npos) return false;
  size_t begin = 0;
  while (begin < value.size()) {
    const auto end = value.find('.', begin), stop = end == std::string::npos ? value.size() : end;
    if (stop == begin || stop - begin > 63 || value[begin] == '-' || value[stop-1] == '-') return false;
    for (size_t i = begin; i < stop; ++i) if (!((value[i] >= 'a' && value[i] <= 'z') || (value[i] >= '0' && value[i] <= '9') || value[i] == '-')) return false;
    if (end == std::string::npos) return true;
    begin = end + 1;
  }
  return false;
}
bool decode(const std::string& encoded, const std::string& alphabet, std::vector<uint8_t>& bytes) {
  if (encoded.empty() || encoded.size() > 128) return false;
  bytes = {0};
  for (char c : encoded) {
    const auto digit = alphabet.find(c);
    if (digit == std::string::npos) return false;
    unsigned carry = static_cast<unsigned>(digit);
    for (auto it = bytes.rbegin(); it != bytes.rend(); ++it) { carry += *it * alphabet.size(); *it = carry & 255; carry >>= 8; }
    while (carry) { bytes.insert(bytes.begin(), carry & 255); carry >>= 8; }
  }
  size_t zeros = 0;
  while (zeros < encoded.size() && encoded[zeros] == alphabet[0]) ++zeros;
  if (bytes.size() == 1 && bytes[0] == 0) bytes.clear();
  bytes.insert(bytes.begin(), zeros, 0);
  return true;
}
std::string encode(std::vector<uint8_t> bytes, const std::string& alphabet) {
  size_t zeros = 0;
  while (zeros < bytes.size() && bytes[zeros] == 0) ++zeros;
  std::string output;
  for (size_t start = zeros; start < bytes.size();) {
    unsigned remainder = 0;
    for (size_t i = start; i < bytes.size(); ++i) { unsigned value = (remainder << 8) + bytes[i]; bytes[i] = value / alphabet.size(); remainder = value % alphabet.size(); }
    output += alphabet[remainder];
    while (start < bytes.size() && bytes[start] == 0) ++start;
  }
  output.append(zeros, alphabet[0]); std::reverse(output.begin(), output.end()); return output;
}
std::string peerLabel(const std::string& peer) {
  const std::string b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", b36 = "0123456789abcdefghijklmnopqrstuvwxyz";
  std::vector<uint8_t> bytes;
  if (peer.empty()) return "";
  if (peer[0] == 'k') {
    if (!decode(peer.substr(1), b36, bytes) || bytes.size() < 4 || bytes[0] != 1 || bytes[1] != 0x72 || "k" + encode(bytes, b36) != peer) return "";
    bytes.erase(bytes.begin(), bytes.begin()+2);
  } else if (!decode(peer, b58, bytes) || encode(bytes, b58) != peer) return "";
  // Supported libp2p identity multihashes: Ed25519 and compressed secp256k1;
  // legacy SHA-256 peer IDs remain valid too. Reject arbitrary CIDs/digests.
  const bool hashed = bytes.size() == 34 && bytes[0] == 0x12 && bytes[1] == 0x20;
  const bool ed = bytes.size() == 38 && bytes[0] == 0 && bytes[1] == 36 && bytes[2] == 8 && bytes[3] == 1 && bytes[4] == 18 && bytes[5] == 32;
  const bool secp = bytes.size() == 39 && bytes[0] == 0 && bytes[1] == 37 && bytes[2] == 8 && bytes[3] == 2 && bytes[4] == 18 && bytes[5] == 33 && (bytes[6] == 2 || bytes[6] == 3);
  if (!hashed && !ed && !secp) return "";
  bytes.insert(bytes.begin(), {1, 0x72});
  const auto label = "k" + encode(bytes, b36);
  return label.size() <= 63 ? label : "";
}
bool publicIPv4(const std::string& ip) {
  unsigned octets[4] = {}; size_t begin = 0;
  for (size_t part = 0; part < 4; ++part) {
    const auto end = ip.find('.', begin), stop = end == std::string::npos ? ip.size() : end;
    if (stop == begin || stop-begin > 3 || (stop-begin > 1 && ip[begin] == '0') || (part == 3) != (end == std::string::npos)) return false;
    for (size_t i = begin; i < stop; ++i) { if (ip[i] < '0' || ip[i] > '9') return false; octets[part] = octets[part]*10 + ip[i]-'0'; }
    if (octets[part] > 255) return false; begin = stop+1;
  }
  const auto a=octets[0], b=octets[1], c=octets[2];
  return a != 0 && a != 10 && a != 127 && a < 224 && !(a==100 && b>=64 && b<=127) && !(a==169 && b==254) && !(a==172 && b>=16 && b<=31) && !(a==192 && (b==168 || b==0 || (b==88 && c==99))) && !(a==198 && (b==18 || b==19 || (b==51 && c==100))) && !(a==203 && b==0 && c==113);
}
int fail(const char* message) { plugin_set_error("invalid-routing-snapshot", message); return 1; }
template <typename T, bool (*Verify)(flatbuffers::Verifier&), const T* (*Get)(const void*)>
const T* verified(const plugin_input_frame_t* frame, std::vector<uint8_t>& scratch) {
  if (!frame || !frame->payload) return nullptr;
  scratch.assign(frame->payload, frame->payload + frame->payload_length);  // aligned copy for the verifier
  flatbuffers::Verifier verifier(scratch.data(), scratch.size());
  return Verify(verifier) ? Get(scratch.data()) : nullptr;
}
std::string str(const flatbuffers::String* s) { return s ? s->str() : ""; }
struct Node { std::string peer, ipv4; bool hasIncluded = false, included = false, originVerified = false, publicOnly = false; };
int push_notice(const std::string& peer, const std::string& hostname, const std::string& status, bool included, const std::string& message, bool purge, uint64_t now) {
  R::FlowNoticeT n;
  n.KIND = status == "included" ? R::flowNoticeKind_Unchanged : status.rfind("pending-", 0) == 0 ? R::flowNoticeKind_Info : R::flowNoticeKind_Skipped;
  n.PROVIDER_ID = "cloudflare"; n.SOURCE_NAME = hostname; n.BATCH_ID = peer; n.REASON = status; n.COUNT = included ? 1 : 0; n.AT_MS = now * 1000;
  if (!message.empty()) n.ITEMS.push_back(message);
  if (purge) n.ITEMS.push_back("cache-purge-required");
  flatbuffers::FlatBufferBuilder b(256);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
  return plugin_push_output_ex("status", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0, b.GetBufferPointer(), b.GetSize());
}
int push_request(const std::string& base, const std::string& method, const std::string& path, const std::string& peer, const std::string& label,
                 const std::string& hostname, const std::string& recordId, const Json* body, uint32_t timeoutMs, uint64_t now) {
  APRT apr;  // CONTEXT: one size-prefixed $APR identifying the peer and the action
  apr.REQUEST_ID = method + " " + hostname; apr.RECEIVED_AT_MS = static_cast<int64_t>(now) * 1000;
  apr.METHOD = method == "POST" ? aprMethod_POST : method == "PUT" ? aprMethod_PUT : aprMethod_DELETE;
  apr.PATH = path; apr.ROUTE = "cloudflare-dns-record";
  for (const auto& [k, v] : std::vector<std::pair<std::string, std::string>>{{"peerId", peer}, {"label", label}, {"hostname", hostname}, {"recordId", recordId}})
    if (!v.empty()) { auto p = std::make_unique<APRParameterT>(); p->NAME = k; p->VALUE = v; apr.PARAMETERS.push_back(std::move(p)); }
  if (body) apr.CONTENT_TYPE = "application/json";
  flatbuffers::FlatBufferBuilder cb(512);
  FinishSizePrefixedAPRBuffer(cb, APR::Pack(cb, &apr));
  const std::vector<uint8_t> context(cb.GetBufferPointer(), cb.GetBufferPointer() + cb.GetSize());
  const std::string payload = body ? body->dump() : "";
  const std::vector<uint8_t> bodyBytes(payload.begin(), payload.end());
  flatbuffers::FlatBufferBuilder b(1024 + payload.size());
  std::vector<flatbuffers::Offset<R::Header>> headers;
  if (body) headers.push_back(R::CreateHeaderDirect(b, "content-type", "application/json"));
  const std::string url = base + path;
  R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, method.c_str(), url.c_str(), &headers, body ? &bodyBytes : nullptr, timeoutMs, 0, &context));
  return plugin_push_output_ex("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpRequest", 0, 0, b.GetBufferPointer(), b.GetSize());
}
}  // namespace

extern "C" int plan(void) {
  std::vector<const plugin_input_frame_t*> pages; const plugin_input_frame_t *peersFrame = nullptr, *pnvFrame = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || f->payload_length > 8*1024*1024) return fail("A bounded typed input frame is required.");
    if (!std::strcmp(f->port_id, "dns_records")) pages.push_back(f);
    else if (!std::strcmp(f->port_id, "peers")) { if (peersFrame) return fail("One $NST peer set is required."); peersFrame = f; }
    else if (!std::strcmp(f->port_id, "verifications")) { if (pnvFrame) return fail("One $PNV verification set is required."); pnvFrame = f; }
    else return fail("Unknown input port.");
  }
  if (pages.empty() || pages.size() > 64 || !peersFrame || !pnvFrame) return fail("Supply every DNS listing page, one $NST and one $PNV.");
  std::vector<uint8_t> nstScratch, pnvScratch, pageScratch;
  const NST* nst = verified<NST, VerifyNSTBuffer, GetNST>(peersFrame, nstScratch);
  const PNV* pnv = verified<PNV, VerifyPNVBuffer, GetPNV>(pnvFrame, pnvScratch);
  if (!nst || !pnv) return fail("The peers frame must be an $NST and the verifications frame a $PNV.");

  auto config = sdm_piv::get_config();
  if (!config.ok()) { plugin_set_error("config-unavailable", config.error_message().c_str()); return 1; }
  const std::string zone(config.string("cloudflare_zone_id")), name(config.string("cloudflare_zone_name"));
  const std::string base(config.string("cloudflare_api_base", "https://api.cloudflare.com/client/v4"));
  const auto timeoutMs = static_cast<uint32_t>(config.number("request_timeout_ms", 30000));
  if (!id(zone) || !domain(name)) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");

  // The complete DNS listing: every page 1..total_pages exactly once, counts adding up to total_count.
  Json records = Json::array(); uint64_t nowMs = 0, totalPages = 0, totalCount = 0; std::set<uint64_t> seenPages;
  const std::string listPath = "/zones/" + zone + "/dns_records";
  for (const auto* f : pages) {
    const auto* r = verified<R::HttpResponse, R::VerifyHttpResponseBuffer, R::GetHttpResponse>(f, pageScratch);
    if (!r) return fail("A dns_records frame is not an HttpResponse (HRSP).");
    const std::string url = str(r->URL());
    const auto at = url.find(listPath);
    if (r->STATUS() != 200 || (r->ERROR() && r->ERROR()->size()) || at == std::string::npos || (at + listPath.size() < url.size() && url[at + listPath.size()] != '?'))
      return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
    const auto* body = r->BODY();
    const Json page = body ? Json::parse(body->begin(), body->end(), nullptr, false) : Json();
    const auto& info = field(page, "result_info"); const auto& result = field(page, "result");
    const auto& pageNo = field(info, "page"); const auto& pagesNo = field(info, "total_pages"); const auto& countNo = field(info, "total_count");
    if (page.is_discarded() || !yes(field(page, "success")) || !result.is_array() || !pageNo.is_number_unsigned() || !pagesNo.is_number_unsigned() || !countNo.is_number_unsigned())
      return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
    const auto p = pageNo.get<uint64_t>(), tp = std::max<uint64_t>(pagesNo.get<uint64_t>(), 1), tc = countNo.get<uint64_t>();
    if ((totalPages && (tp != totalPages || tc != totalCount)) || p < 1 || p > tp || !seenPages.insert(p).second) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
    totalPages = tp; totalCount = tc; nowMs = std::max<uint64_t>(nowMs, r->RETRIEVED_MS());
    for (const auto& record : result) records.push_back(record);
  }
  if (seenPages.size() != totalPages || records.size() != totalCount) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
  const uint64_t now = nowMs / 1000;
  if (!now || now > 9007199254740991ULL) return fail("Invalid snapshot time.");
  if (records.size() > 10000) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");

  // Operator choices: the declared peers first (in config order), then peers only discovered in $NST (undeclared).
  std::vector<Node> nodes; std::set<std::string> declared;
  const size_t declaredCount = config.tables("peers");
  if (config.has("peers") && config.kind("peers") != R::configValueKind_TableList && config.count("peers") > 0) return fail("Invalid or duplicate peer identity or inclusion setting.");
  for (size_t i = 0; i < declaredCount; ++i) {
    const auto t = config.table("peers", i);
    Node n; n.peer = std::string(t.string("peer_id"));
    if (t.has("included")) { if (t.kind("included") != R::configValueKind_Bool) return fail("Invalid or duplicate peer identity or inclusion setting."); n.hasIncluded = true; n.included = t.boolean("included"); }
    n.ipv4 = std::string(t.string("origin_ipv4")); n.originVerified = t.boolean("origin_verified"); n.publicOnly = t.boolean("public_artifacts_only");
    declared.insert(peerLabel(n.peer)); nodes.push_back(n);
  }
  if (nst->NODES()) for (const auto* row : *nst->NODES()) {
    const auto label = peerLabel(str(row->PEER_ID()));
    if (label.empty() || !declared.insert(label).second) continue;  // undecodable or already listed: nothing to route
    Node n; n.peer = str(row->PEER_ID()); nodes.push_back(n);
  }
  if (nodes.size() > 5000) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
  std::map<std::string, std::string> owned;
  for (size_t i = 0; i < config.tables("managed_records"); ++i) {
    const auto t = config.table("managed_records", i);
    owned[std::string(t.string("label"))] = std::string(t.string("record_id"));
  }
  // Peer verification: the latest signature-verified notice per publisher, checked against a key from its identity
  // record, its peer identifier or operator trust (a self-asserted key proves integrity, not identity).
  std::map<std::string, uint64_t> verifiedAt;
  if (pnv->ENTRIES()) for (const auto* e : *pnv->ENTRIES()) {
    const auto source = e->KEY_SOURCE();
    if (!e->SIGNATURE_VERIFIED() || e->RECEIVED_AT_MS() <= 0 || (source != pnvKeySource_IdentityRecord && source != pnvKeySource_PeerIdentifier && source != pnvKeySource_OperatorTrust)) continue;
    const auto label = peerLabel(str(e->PUBLISHER_PEER_ID()));
    if (label.empty()) continue;
    auto& at = verifiedAt[label]; at = std::max<uint64_t>(at, static_cast<uint64_t>(e->RECEIVED_AT_MS()) / 1000);
  }

  std::map<std::string,std::vector<const Json*>> byName;
  std::set<std::string> recordIds;
  for (const auto& record : records) {
    const auto recordId=text(field(record,"id")), recordName=text(field(record,"name"));
    if (!id(recordId) || !domain(recordName) || !recordIds.insert(recordId).second) return fail("Invalid or duplicate observed DNS record.");
    byName[recordName].push_back(&record);
  }
  std::set<std::string> labels;
  for (const auto& node : nodes) {  // validate everything before the first frame goes out
    const auto l = peerLabel(node.peer);
    if (l.empty() || !labels.insert(l).second) return fail("Invalid or duplicate peer identity or inclusion setting.");
    if (const auto m = owned.find(l); m != owned.end() && !m->second.empty() && !id(m->second)) return fail("Invalid managed record identity.");
  }
  for (const auto& node : nodes) {
    const auto& peer = node.peer; const auto label = peerLabel(peer);
    const auto hostname=label+"."+name, marker="sdn-peer:"+label;
    const auto it = owned.find(label); const auto managed = it == owned.end() ? std::string() : it->second;
    const auto found=byName.find(hostname);
    const Json* record=found!=byName.end() && found->second.size()==1 ? found->second[0] : nullptr;
    const bool included = node.hasIncluded && node.included;
    if (found!=byName.end() && (found->second.size()!=1 || text(field(*record,"id"))!=managed || text(field(*record,"comment"))!=marker || text(field(*record,"type"))!="A")) {
      if (push_notice(peer, hostname, "conflict", included, "An existing DNS record is not owned by this registrar.", false, now) < 0) return 1; continue;
    }
    if (!included) {
      if (record) {
        if (push_request(base, "DELETE", "/zones/"+zone+"/dns_records/"+managed, peer, label, hostname, managed, nullptr, timeoutMs, now) < 0) return 1;
        if (push_notice(peer, hostname, "pending-exclusion", false, "", true, now) < 0) return 1;
      } else if (push_notice(peer, hostname, "excluded", false, "", false, now) < 0) return 1;
      continue;
    }
    const auto v = verifiedAt.find(label);
    const bool fresh = v != verifiedAt.end() && v->second <= now && now - v->second <= 900;
    if (!fresh || !node.originVerified || !node.publicOnly || !publicIPv4(node.ipv4)) {
      if (push_notice(peer, hostname, "blocked", true, "Verify the peer and its public origin and artifact admission before enabling DNS.", false, now) < 0) return 1; continue;
    }
    if (record && text(field(*record,"content"))==node.ipv4 && yes(field(*record,"proxied")) && field(*record,"ttl")==1) { if (push_notice(peer, hostname, "included", true, "", false, now) < 0) return 1; continue; }
    const Json body={{"type","A"},{"name",hostname},{"content",node.ipv4},{"proxied",true},{"ttl",1},{"comment",marker}};
    if (push_request(base, record?"PUT":"POST", "/zones/"+zone+"/dns_records"+(record?"/"+managed:""), peer, label, hostname, record?managed:"", &body, timeoutMs, now) < 0) return 1;
    if (push_notice(peer, hostname, "pending-inclusion", true, "", false, now) < 0) return 1;
  }
  return 0;
}
