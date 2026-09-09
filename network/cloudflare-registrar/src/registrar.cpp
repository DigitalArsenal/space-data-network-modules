// Deterministic DNS reconciliation. The authenticated caller supplies a fresh,
// verified discovery/origin snapshot and all observed DNS records. This guest
// never receives credentials. Its output is a plan, not evidence of application.
#include "space_data_module_invoke.h"
#include <algorithm>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>
using Json = nlohmann::json;
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
}
extern "C" int plan(void) {
  if (plugin_get_input_count() != 1) return fail("One routing snapshot is required.");
  const auto* frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || !frame->port_id || std::strcmp(frame->port_id,"snapshot") || frame->payload_length > 8*1024*1024) return fail("A bounded routing snapshot is required.");
  const Json snapshot = Json::parse(frame->payload, frame->payload+frame->payload_length, nullptr, false);
  const auto& nodes = field(snapshot,"nodes"); const auto& records = field(snapshot,"records"); const auto& owned = field(snapshot,"managedRecordIds");
  const auto zone = text(field(snapshot,"zoneId")), name = text(field(snapshot,"zoneName"));
  const auto& nowValue = field(snapshot,"now");
  if (snapshot.is_discarded() || !id(zone) || !domain(name) || !nowValue.is_number_unsigned() || !nodes.is_array() || nodes.size()>5000 || !records.is_array() || records.size()>10000 || !owned.is_object() || !yes(field(snapshot,"recordsComplete"))) return fail("Supply a valid zone, time, nodes, ownership and complete DNS snapshot.");
  const auto now = nowValue.get<uint64_t>();
  if (!now || now>9007199254740991ULL) return fail("Invalid snapshot time.");
  std::map<std::string,std::vector<const Json*>> byName;
  std::set<std::string> recordIds;
  for (const auto& record : records) {
    const auto recordId=text(field(record,"id")), recordName=text(field(record,"name"));
    if (!id(recordId) || !domain(recordName) || !recordIds.insert(recordId).second) return fail("Invalid or duplicate observed DNS record.");
    byName[recordName].push_back(&record);
  }
  Json actions=Json::array(), results=Json::array(); std::set<std::string> labels;
  for (const auto& node : nodes) {
    const auto peer=text(field(node,"peerId")), label=peerLabel(peer);
    if (label.empty() || !labels.insert(label).second || (!field(node,"included").is_null() && !field(node,"included").is_boolean())) return fail("Invalid or duplicate peer identity or inclusion setting.");
    const auto hostname=label+"."+name, marker="sdn-peer:"+label;
    const auto managed = owned.contains(label) ? text(owned[label]) : "";
    if (!managed.empty() && !id(managed)) return fail("Invalid managed record identity.");
    const auto found=byName.find(hostname);
    const Json* record=found!=byName.end() && found->second.size()==1 ? found->second[0] : nullptr;
    Json result={{"peerId",peer},{"hostname",hostname},{"included",yes(field(node,"included"))},{"status","excluded"}};
    if (found!=byName.end() && (found->second.size()!=1 || text(field(*record,"id"))!=managed || text(field(*record,"comment"))!=marker || text(field(*record,"type"))!="A")) {
      result["status"]="conflict"; result["message"]="An existing DNS record is not owned by this registrar."; results.push_back(result); continue;
    }
    if (!yes(field(node,"included"))) {
      if (record) {
        actions.push_back({{"peerId",peer},{"hostname",hostname},{"method","DELETE"},{"path","/zones/"+zone+"/dns_records/"+managed},{"recordId",managed}});
        result["status"]="pending-exclusion"; result["cachePurgeRequired"]=true;
      }
      results.push_back(result); continue;
    }
    const auto& verified=field(node,"verifiedAt");
    const auto ip=text(field(node,"originIpv4"));
    const bool fresh=verified.is_number_unsigned() && verified.get<uint64_t>()<=now && now-verified.get<uint64_t>()<=900;
    if (!yes(field(node,"profileVerified")) || !fresh || !yes(field(node,"originVerified")) || !yes(field(node,"publicArtifactsOnly")) || !publicIPv4(ip)) {
      result["status"]="blocked"; result["message"]="Verify the peer and its public origin and artifact admission before enabling DNS."; results.push_back(result); continue;
    }
    if (record && text(field(*record,"content"))==ip && yes(field(*record,"proxied")) && field(*record,"ttl")==1) result["status"]="included";
    else {
      Json action={{"peerId",peer},{"hostname",hostname},{"method",record?"PUT":"POST"},{"path","/zones/"+zone+"/dns_records"+(record?"/"+managed:"")},{"body",{{"type","A"},{"name",hostname},{"content",ip},{"proxied",true},{"ttl",1},{"comment",marker}}}};
      if (record) action["recordId"]=managed;
      actions.push_back(action); result["status"]="pending-inclusion";
    }
    results.push_back(result);
  }
  const auto output=Json({{"version",1},{"applied",false},{"actions",actions},{"nodes",results}}).dump();
  return plugin_push_output_ex("plan", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(output.data()), static_cast<uint32_t>(output.size())) < 0 ? 1 : 0;
}
