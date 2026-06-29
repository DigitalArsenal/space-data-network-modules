#include "epm_verify.h"

#include <cctype>
#include <cstring>
#include <vector>

namespace sdn::epm {
namespace {

constexpr std::size_t kEd25519PublicKeyBytes = 32;

std::string Trim(const std::string& s) {
  size_t b = 0, e = s.size();
  const auto ws = [](unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
  };
  while (b < e && ws(static_cast<unsigned char>(s[b]))) ++b;
  while (e > b && ws(static_cast<unsigned char>(s[e - 1]))) --e;
  return s.substr(b, e - b);
}

std::string Lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// Matches Go decodeHexString: trim, strip 0x/0X, hex-decode.
bool HexDecode(const std::string& in, std::vector<uint8_t>* out) {
  std::string s = Trim(in);
  if (s.size() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s = s.substr(2);
  if (s.size() % 2 != 0) return false;
  const auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  out->clear();
  out->reserve(s.size() / 2);
  for (size_t i = 0; i + 1 < s.size(); i += 2) {
    const int hi = nib(s[i]);
    const int lo = nib(s[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return true;
}

}  // namespace

VerifyResult VerifyEpm(const EpmFields& epm,
                       const uint8_t* signature, std::size_t signature_len,
                       const uint8_t* expected_signing_pubkey,
                       const Ed25519Verify& verify) {
  VerifyResult r;
  if (signature == nullptr || signature_len != 64) {
    r.error = "missing or malformed signature";
    return r;
  }

  // First Signing key whose address type is empty/ed25519 and whose public key is
  // a 32-byte ed25519 key (Go firstEPMSigningPublicKey).
  const CryptoKey* signing = nullptr;
  std::vector<uint8_t> signing_pub;
  for (const auto& k : epm.keys) {
    if (k.key_type != "Signing") continue;
    const std::string at = Lower(Trim(k.address_type));
    if (!at.empty() && at != "ed25519") continue;
    std::vector<uint8_t> pub;
    if (!HexDecode(k.public_key, &pub) || pub.size() != kEd25519PublicKeyBytes) continue;
    signing = &k;
    signing_pub = std::move(pub);
    break;
  }
  if (signing == nullptr) {
    r.error = "no ed25519 signing key in EPM";
    return r;
  }

  // Bind to the key the requester proved control of, if supplied.
  if (expected_signing_pubkey != nullptr) {
    if (std::memcmp(signing_pub.data(), expected_signing_pubkey, kEd25519PublicKeyBytes) != 0) {
      r.error = "EPM signing key does not match the proven signing key";
      return r;
    }
  }

  const std::string content = SigningContentBytes(epm);
  if (!verify(reinterpret_cast<const uint8_t*>(content.data()), content.size(),
              signature, signature_len, signing_pub.data())) {
    r.error = "EPM signature invalid";
    return r;
  }

  const std::string xpub = Trim(signing->xpub);
  if (xpub.empty()) {
    r.error = "EPM signing key carries no xpub";
    return r;
  }

  r.ok = true;
  r.xpub = xpub;
  return r;
}

}  // namespace sdn::epm
