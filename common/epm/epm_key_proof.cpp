#include "epm_key_proof.h"

#include <array>
#include <cctype>
#include <vector>

namespace sdn::epm {
namespace {

constexpr const char* kStatementHeader = "sdn-module-delivery-key/1";
constexpr int64_t kMaxValiditySeconds = 31LL * 24 * 3600;
// BIP-32 serialization: version 4, depth 1, fingerprint 4, child 4,
// chain code 32, key 33, checksum 4.
constexpr std::size_t kXpubBytes = 82;
constexpr std::size_t kXpubKeyOffset = 45;
constexpr std::size_t kCompressedKeyBytes = 33;

std::string Trim(const std::string& s) {
  std::size_t b = 0, e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
  return s.substr(b, e - b);
}

std::string Lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool HexDecode(const std::string& in, std::vector<uint8_t>* out) {
  const std::string s = Trim(in);
  if (s.size() % 2 != 0) return false;
  const auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  out->clear();
  for (std::size_t i = 0; i + 1 < s.size(); i += 2) {
    const int hi = nib(s[i]), lo = nib(s[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return true;
}

std::string HexEncode(const uint8_t* data, std::size_t len) {
  static const char* kDigits = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (std::size_t i = 0; i < len; ++i) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0x0f]);
  }
  return out;
}

// Bitcoin base58 to bytes (leading '1's are zero bytes). The xpub's checksum is
// not needed here: the allowlist matches the xpub string exactly, and this only
// reads the key that string encodes.
bool Base58Decode(const std::string& in, std::vector<uint8_t>* out) {
  static const char* kAlphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  std::array<int, 128> index{};
  index.fill(-1);
  for (int i = 0; i < 58; ++i) index[static_cast<unsigned char>(kAlphabet[i])] = i;
  std::vector<uint8_t> bytes;  // big-endian magnitude
  std::size_t zeros = 0;
  while (zeros < in.size() && in[zeros] == '1') ++zeros;
  for (std::size_t i = zeros; i < in.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(in[i]);
    if (c >= 128 || index[c] < 0) return false;
    int carry = index[c];
    for (auto it = bytes.rbegin(); it != bytes.rend(); ++it) {
      carry += 58 * (*it);
      *it = static_cast<uint8_t>(carry & 0xff);
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.insert(bytes.begin(), static_cast<uint8_t>(carry & 0xff));
      carry >>= 8;
    }
  }
  out->assign(zeros, 0);
  out->insert(out->end(), bytes.begin(), bytes.end());
  return true;
}

// "name:value" on line `index` of the statement, or false.
// "https://host[:port][/...]" -> "host", lowercased; "" when malformed.
std::string OriginHost(const std::string& origin) {
  const std::size_t scheme = origin.find("://");
  if (scheme == std::string::npos) return "";
  const std::size_t start = scheme + 3;
  std::size_t end = start;
  while (end < origin.size() && origin[end] != ':' && origin[end] != '/') ++end;
  return Lower(origin.substr(start, end - start));
}

bool Field(const std::vector<std::string>& lines, std::size_t index,
           const char* name, std::string* value) {
  if (index >= lines.size()) return false;
  const std::string prefix = std::string(name) + ":";
  if (lines[index].rfind(prefix, 0) != 0) return false;
  *value = lines[index].substr(prefix.size());
  return !value->empty();
}

}  // namespace

std::string VerifySessionKeyProof(const EpmFields& epm,
                                  const std::string& xpub,
                                  const std::string& account_key_path,
                                  const uint8_t* proven_ed25519,
                                  int64_t now_unix,
                                  const Secp256k1Verify& verify_secp256k1,
                                  const std::string& requested_domain) {
  if (proven_ed25519 == nullptr) return "no proven session key";
  if (!verify_secp256k1) return "no secp256k1 verifier available";

  std::vector<uint8_t> xpub_bytes;
  if (!Base58Decode(Trim(xpub), &xpub_bytes) || xpub_bytes.size() != kXpubBytes) {
    return "malformed account xpub";
  }
  const std::string account_key =
      HexEncode(xpub_bytes.data() + kXpubKeyOffset, kCompressedKeyBytes);

  const ChainProof* proof = nullptr;
  for (const ChainProof& candidate : epm.chain_proofs) {
    if (Trim(candidate.key_path) != Trim(account_key_path)) continue;
    if (Lower(Trim(candidate.public_key)) != account_key) continue;
    if (proof != nullptr) return "ambiguous account key proofs";
    proof = &candidate;
  }
  if (proof == nullptr) return "no account key proof for the session key";
  if (Lower(Trim(proof->algorithm)) != "secp256k1") return "unsupported account key proof algorithm";

  std::vector<uint8_t> payload;
  std::vector<uint8_t> signature;
  std::vector<uint8_t> key;
  if (!HexDecode(proof->signed_payload, &payload) || payload.empty()) return "malformed account key proof statement";
  if (!HexDecode(proof->signature, &signature) || signature.empty()) return "malformed account key proof signature";
  HexDecode(account_key, &key);

  // Byte-replayed statement: exactly five LF-terminated lines.
  const std::string statement(payload.begin(), payload.end());
  if (statement.empty() || statement.back() != '\n') return "malformed account key proof statement";
  std::vector<std::string> lines;
  std::size_t start = 0;
  for (std::size_t i = 0; i < statement.size(); ++i) {
    if (statement[i] == '\n') {
      lines.push_back(statement.substr(start, i - start));
      start = i + 1;
    }
  }
  if (lines.size() != 5 || lines[0] != kStatementHeader) return "malformed account key proof statement";
  std::string session, stated_xpub, origin, expires;
  if (!Field(lines, 1, "ed25519", &session) || !Field(lines, 2, "xpub", &stated_xpub) ||
      !Field(lines, 3, "origin", &origin) || !Field(lines, 4, "expires", &expires)) {
    return "malformed account key proof statement";
  }
  if (Lower(session) != HexEncode(proven_ed25519, 32)) return "account key proof names another session key";
  if (stated_xpub != Trim(xpub)) return "account key proof names another xpub";
  // The statement is bound to the page origin the wallet signed for; a grant
  // for another domain cannot reuse it.
  if (!Trim(requested_domain).empty() &&
      OriginHost(origin) != Lower(Trim(requested_domain))) {
    return "account key proof is for another origin";
  }
  int64_t expires_at = 0;
  for (const char c : expires) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return "malformed account key proof expiry";
    expires_at = expires_at * 10 + (c - '0');
    if (expires_at > (int64_t{1} << 40)) return "malformed account key proof expiry";
  }
  if (expires_at <= now_unix) return "account key proof expired";
  if (expires_at - now_unix > kMaxValiditySeconds) return "account key proof valid for too long";

  if (!verify_secp256k1(payload.data(), payload.size(), signature.data(), signature.size(),
                        key.data(), key.size())) {
    return "account key proof signature invalid";
  }
  return "";
}

}  // namespace sdn::epm
