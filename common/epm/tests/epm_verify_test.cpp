// EPM attestation verify tests (ed25519 via Crypto++ as the injected verifier).
#include "epm_verify.h"

#include <cryptopp/osrng.h>
#include <cryptopp/xed25519.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace sdn::epm;

static int g_fail = 0;
#define CHECK(cond, name)                                       \
  do {                                                          \
    if (cond) std::printf("  ok    %s\n", name);                \
    else { std::printf("  FAIL  %s\n", name); ++g_fail; }       \
  } while (0)

static std::string ToHex(const uint8_t* b, size_t n) {
  static const char* h = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; ++i) { s += h[b[i] >> 4]; s += h[b[i] & 0xF]; }
  return s;
}

int main() {
  using namespace CryptoPP;
  std::printf("EPM verify:\n");

  AutoSeededRandomPool prng;
  ed25519PrivateKey priv;
  priv.GenerateRandom(prng, CryptoPP::g_nullNameValuePairs);
  ed25519PublicKey pub;
  priv.MakePublicKey(pub);
  uint8_t pub32[32];
  std::memcpy(pub32, pub.GetPublicKeyBytePtr(), 32);
  ed25519::Signer signer(priv);

  // ed25519 verify injected (host call in the wasm module; Crypto++ here).
  Ed25519Verify cpp_verify = [](const uint8_t* m, std::size_t ml, const uint8_t* s,
                                std::size_t sl, const uint8_t* p) -> bool {
    CryptoPP::ed25519::Verifier v(p);
    return v.VerifyMessage(m, ml, s, sl);
  };

  EpmFields epm;
  epm.entity_type = "Individual";
  epm.legal_name = "Acme & Co";
  epm.signature_timestamp = 1782470000;
  CryptoKey k;
  k.public_key = ToHex(pub32, 32);
  k.xpub = "xpub6DHmTESTidentity";
  k.address_type = "ed25519";
  k.key_type = "Signing";
  epm.keys.push_back(k);

  const std::string content = SigningContentBytes(epm);
  std::vector<CryptoPP::byte> sig(signer.MaxSignatureLength());
  sig.resize(signer.SignMessage(prng, reinterpret_cast<const CryptoPP::byte*>(content.data()),
                                content.size(), sig.data()));

  {
    auto r = VerifyEpm(epm, sig.data(), sig.size(), pub32, cpp_verify);
    CHECK(r.ok && r.xpub == "xpub6DHmTESTidentity", "valid EPM verifies + xpub extracted");
    if (!r.ok) std::printf("    err: %s\n", r.error.c_str());
  }
  {
    auto r = VerifyEpm(epm, sig.data(), sig.size(), nullptr, cpp_verify);
    CHECK(r.ok && r.xpub == "xpub6DHmTESTidentity", "verify without explicit binding");
  }
  {
    uint8_t wrong[32];
    std::memcpy(wrong, pub32, 32);
    wrong[0] ^= 0x01;
    auto r = VerifyEpm(epm, sig.data(), sig.size(), wrong, cpp_verify);
    CHECK(!r.ok, "EPM signing key != proven key rejected");
  }
  {
    auto bad = sig;
    bad[5] ^= 0x01;
    auto r = VerifyEpm(epm, bad.data(), bad.size(), pub32, cpp_verify);
    CHECK(!r.ok, "tampered signature rejected");
  }
  {
    EpmFields modified = epm;
    modified.signature_timestamp = 1782470001;  // content changes -> old sig invalid
    auto r = VerifyEpm(modified, sig.data(), sig.size(), pub32, cpp_verify);
    CHECK(!r.ok, "modified EPM content rejected");
  }
  {
    EpmFields no_key;
    no_key.entity_type = "Organization";
    auto r = VerifyEpm(no_key, sig.data(), sig.size(), pub32, cpp_verify);
    CHECK(!r.ok, "EPM without signing key rejected");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
