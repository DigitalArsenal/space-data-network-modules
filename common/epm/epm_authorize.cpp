#include "epm_authorize.h"

#include "epm_fb.h"
#include "epm_key_proof.h"

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
                                       const Ed25519Verify& verify,
                                       const Secp256k1Verify& verify_secp256k1,
                                       const std::string& requested_domain) {
  AuthorizeResult r;

  EpmFields fields;
  std::string signature_hex;
  if (!EpmFieldsFromBytes(epm_bytes, epm_len, &fields, &signature_hex)) {
    r.error = "invalid or unparseable EPM";
    return r;
  }

  // The signature length is scheme-dependent (64 for ed25519, variable DER for
  // secp256k1); VerifyEpm validates it per signing key, so only reject an empty one.
  const std::vector<uint8_t> signature = HexDecode(signature_hex);
  if (signature.empty()) {
    r.error = "missing or malformed EPM signature";
    return r;
  }

  const VerifyResult v = VerifyEpm(fields, signature.data(), signature.size(),
                                   proven_signing_pubkey, verify, verify_secp256k1);
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
    // An allowlist is only as strong as the proof that the requester holds the
    // xpub: the account key itself must have authorised this session key.
    const std::string proof_error = VerifySessionKeyProof(
        fields, v.xpub, v.account_key_path, proven_signing_pubkey, now_unix, verify_secp256k1,
        requested_domain);
    if (!proof_error.empty()) {
      r.error = proof_error;
      return r;
    }
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
