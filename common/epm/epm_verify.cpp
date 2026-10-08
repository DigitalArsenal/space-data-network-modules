#include "epm_verify.h"

#include <cctype>
#include <cstring>
#include <vector>

namespace sdn::epm {
namespace {

constexpr std::size_t kEd25519PublicKeyBytes = 32;
constexpr std::size_t kEd25519SignatureBytes = 64;
constexpr std::size_t kSecp256k1CompressedBytes = 33;
constexpr std::size_t kSecp256k1UncompressedBytes = 65;

enum class Curve { kEd25519, kSecp256k1, kUnsupported };

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

bool IsCanonicalAccountPath(const std::string& value) {
  const std::string path = Trim(value);
  constexpr const char* prefix = "m/44'/0'/";
  if (path.rfind(prefix, 0) != 0 || path.size() <= std::strlen(prefix) + 1 ||
      path.back() != '\'') {
    return false;
  }
  const std::size_t begin = std::strlen(prefix);
  for (std::size_t i = begin; i + 1 < path.size(); ++i) {
    if (!std::isdigit(static_cast<unsigned char>(path[i]))) return false;
  }
  return true;
}

bool IsCanonicalAccountXpubKey(const CryptoKey& key) {
  return Lower(Trim(key.algorithm)) == "secp256k1" &&
         !Trim(key.xpub).empty() && IsCanonicalAccountPath(key.key_path);
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
                       const Ed25519Verify& verify,
                       const Secp256k1Verify& verify_secp256k1) {
  VerifyResult r;
  if (signature == nullptr || signature_len == 0) {
    r.error = "missing or malformed signature";
    return r;
  }

  const auto curve_of = [](const std::string& algorithm) -> Curve {
    const std::string alg = Lower(Trim(algorithm));
    if (alg.empty() || alg == "ed25519") return Curve::kEd25519;
    if (alg == "secp256k1") return Curve::kSecp256k1;
    return Curve::kUnsupported;
  };
  const std::string declared_algorithm = Lower(Trim(epm.signature_algorithm));
  const Curve declared_curve = curve_of(declared_algorithm);
  if (!declared_algorithm.empty() && declared_curve == Curve::kUnsupported) {
    r.error = "unsupported EPM signature algorithm";
    return r;
  }

  const std::string content = SigningContentBytes(epm);
  const uint8_t* msg = reinterpret_cast<const uint8_t*>(content.data());
  const std::size_t msg_len = content.size();

  const CryptoKey* verified = nullptr;
  bool any_signing_key = false;
  std::string last_error = "no signing key in EPM";

  // Two ordered passes so ed25519 signing keys are tried first (preserving the
  // 25519 default), then secp256k1. Accept the first key that verifies.
  for (const Curve want : {Curve::kEd25519, Curve::kSecp256k1}) {
    if (!declared_algorithm.empty() && want != declared_curve) continue;
    for (const auto& k : epm.keys) {
      if (k.key_type != "Signing") continue;
      if (curve_of(k.algorithm) != want) continue;
      any_signing_key = true;

      std::vector<uint8_t> pub;
      if (!HexDecode(k.public_key, &pub)) {
        last_error = "malformed signing public key";
        continue;
      }

      if (want == Curve::kEd25519) {
        if (pub.size() != kEd25519PublicKeyBytes) {
          last_error = "malformed ed25519 signing key";
          continue;
        }
        if (signature_len != kEd25519SignatureBytes) {
          last_error = "malformed ed25519 signature";
          continue;
        }
        // Bind to the key the requester proved control of, if supplied.
        if (expected_signing_pubkey != nullptr &&
            std::memcmp(pub.data(), expected_signing_pubkey, kEd25519PublicKeyBytes) != 0) {
          last_error = "EPM signing key does not match the proven signing key";
          continue;
        }
        if (!verify) {
          last_error = "no ed25519 verifier available";
          continue;
        }
        if (verify(msg, msg_len, signature, signature_len, pub.data())) {
          verified = &k;
          break;
        }
        last_error = "EPM signature invalid";
      } else {  // Curve::kSecp256k1
        // A module-delivery proof authenticates an Ed25519 challenge key. When
        // that binding is supplied, a secp256k1-signed EPM cannot substitute
        // for it; the account xpub is instead cross-curve bound by the verified
        // Ed25519 signature over the complete EPM.
        if (expected_signing_pubkey != nullptr) {
          last_error = "EPM does not authenticate the proven ed25519 signing key";
          continue;
        }
        if (pub.size() != kSecp256k1CompressedBytes &&
            pub.size() != kSecp256k1UncompressedBytes) {
          last_error = "malformed secp256k1 signing key";
          continue;
        }
        if (!verify_secp256k1) {
          last_error = "no secp256k1 verifier available";
          continue;
        }
        // The DER signature is variable length (up to ~72 bytes); do NOT require 64.
        // The cross-curve proven-key binding (expected_signing_pubkey, a 32-byte
        // ed25519 key) does not apply here — identity is bound downstream via the
        // xpub gate.
        if (verify_secp256k1(msg, msg_len, signature, signature_len,
                             pub.data(), pub.size())) {
          verified = &k;
          break;
        }
        last_error = "EPM signature invalid";
      }
    }
    if (verified != nullptr) break;
  }

  if (verified == nullptr) {
    r.error = any_signing_key ? last_error : "no signing key in EPM";
    return r;
  }

  const CryptoKey* account_key = nullptr;
  for (const auto& key : epm.keys) {
    if (!IsCanonicalAccountXpubKey(key)) continue;
    if (account_key != nullptr) {
      r.error = "EPM carries ambiguous canonical account xpub keys";
      return r;
    }
    account_key = &key;
  }
  if (account_key == nullptr) {
    r.error = "EPM carries no canonical secp256k1 account xpub key";
    return r;
  }

  r.ok = true;
  r.xpub = Trim(account_key->xpub);
  r.account_key_path = Trim(account_key->key_path);
  return r;
}

}  // namespace sdn::epm
