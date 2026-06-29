#include "epm_authorize.h"

#include "epm_fb.h"

namespace sdn::epm {
namespace {

std::vector<uint8_t> HexDecode(const std::string& in) {
  std::string s = in;
  if (s.size() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s = s.substr(2);
  std::vector<uint8_t> out;
  if (s.size() % 2 != 0) return out;
  const auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  out.reserve(s.size() / 2);
  for (size_t i = 0; i + 1 < s.size(); i += 2) {
    const int hi = nib(s[i]);
    const int lo = nib(s[i + 1]);
    if (hi < 0 || lo < 0) return {};
    out.push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return out;
}

}  // namespace

AuthorizeResult AuthorizeModuleRequest(const uint8_t* epm_bytes, std::size_t epm_len,
                                       const uint8_t* proven_signing_pubkey,
                                       const std::vector<std::string>& allowed_xpubs,
                                       int64_t now_unix, int64_t max_age_seconds,
                                       const Ed25519Verify& verify) {
  AuthorizeResult r;

  EpmFields fields;
  std::string signature_hex;
  if (!EpmFieldsFromBytes(epm_bytes, epm_len, &fields, &signature_hex)) {
    r.error = "invalid or unparseable EPM";
    return r;
  }

  const std::vector<uint8_t> signature = HexDecode(signature_hex);
  if (signature.size() != 64) {
    r.error = "missing or malformed EPM signature";
    return r;
  }

  const VerifyResult v = VerifyEpm(fields, signature.data(), signature.size(),
                                   proven_signing_pubkey, verify);
  if (!v.ok) {
    r.error = v.error;
    return r;
  }

  if (max_age_seconds > 0) {
    int64_t age = now_unix - fields.signature_timestamp;
    if (age < 0) age = -age;
    if (age > max_age_seconds) {
      r.error = "stale EPM (re-send a fresh attestation)";
      return r;
    }
  }

  if (!allowed_xpubs.empty()) {
    bool listed = false;
    for (const std::string& a : allowed_xpubs) {
      if (a == v.xpub) { listed = true; break; }
    }
    if (!listed) {
      r.error = "xpub not in module allowlist";
      return r;
    }
  }

  r.ok = true;
  r.xpub = v.xpub;
  return r;
}

}  // namespace sdn::epm
