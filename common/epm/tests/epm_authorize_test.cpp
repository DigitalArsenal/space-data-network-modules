// Module-delivery gate tests: full AuthorizeModuleRequest decision over a real
// signed $EPM FlatBuffer (allowlist / freshness / binding / tamper).
#include "epm_authorize.h"

#include <flatbuffers/flatbuffers.h>

#include "EPM_generated.h"

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

// Build a signed, size-prefixed $EPM (one ed25519 signing key) bound to `xpub`.
static std::vector<uint8_t> BuildSignedEpm(CryptoPP::ed25519::Signer& signer,
                                           const uint8_t pub32[32],
                                           const std::string& xpub, int64_t ts) {
  EpmFields f;
  f.entity_type = "User";
  f.signature_timestamp = ts;
  sdn::epm::CryptoKey k;
  k.public_key = ToHex(pub32, 32);
  k.xpub = xpub;
  k.address_type = "ed25519";
  k.key_type = "Signing";
  f.keys.push_back(k);

  const std::string content = SigningContentBytes(f);
  CryptoPP::AutoSeededRandomPool prng;
  std::vector<CryptoPP::byte> sig(signer.MaxSignatureLength());
  sig.resize(signer.SignMessage(prng, reinterpret_cast<const CryptoPP::byte*>(content.data()),
                                content.size(), sig.data()));

  flatbuffers::FlatBufferBuilder b(1024);
  const auto pk = b.CreateString(k.public_key);
  const auto xp = b.CreateString(xpub);
  const auto at = b.CreateString("ed25519");
  CryptoKeyBuilder ckb(b);
  ckb.add_PUBLIC_KEY(pk);
  ckb.add_XPUB(xp);
  ckb.add_ADDRESS_TYPE(at);
  ckb.add_KEY_TYPE(KeyType::Signing);
  const auto ck = ckb.Finish();
  const auto keys = b.CreateVector(std::vector<flatbuffers::Offset<::CryptoKey>>{ck});
  const auto so = b.CreateString(ToHex(sig.data(), sig.size()));
  EPMBuilder eb(b);
  eb.add_KEYS(keys);
  eb.add_SIGNATURE(so);
  eb.add_SIGNATURE_TIMESTAMP(ts);
  eb.add_ENTITY_TYPE(EntityType::User);
  FinishSizePrefixedEPMBuffer(b, eb.Finish());
  return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

int main() {
  using namespace CryptoPP;
  std::printf("module-delivery gate (AuthorizeModuleRequest):\n");

  AutoSeededRandomPool prng;
  ed25519PrivateKey priv;
  priv.GenerateRandom(prng, g_nullNameValuePairs);
  ed25519PublicKey pub;
  priv.MakePublicKey(pub);
  uint8_t pub32[32];
  std::memcpy(pub32, pub.GetPublicKeyBytePtr(), 32);
  ed25519::Signer signer(priv);

  Ed25519Verify verify = [](const uint8_t* m, std::size_t ml, const uint8_t* s,
                            std::size_t sl, const uint8_t* p) -> bool {
    CryptoPP::ed25519::Verifier v(p);
    return v.VerifyMessage(m, ml, s, sl);
  };

  const int64_t ts = 1782470000;
  const auto epm = BuildSignedEpm(signer, pub32, "xpubALLOWED", ts);
  const std::vector<std::string> allow = {"xpubALLOWED", "xpubANOTHER"};

  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, allow, ts + 10, 300, verify);
    CHECK(r.ok && r.xpub == "xpubALLOWED", "allowed xpub + fresh -> grant");
    if (!r.ok) std::printf("    err: %s\n", r.error.c_str());
  }
  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, {"xpubOTHER"}, ts + 10, 300, verify);
    CHECK(!r.ok, "xpub not in allowlist -> deny");
  }
  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, allow, ts + 1000, 300, verify);
    CHECK(!r.ok, "stale EPM -> deny");
  }
  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, allow, ts + 100000, 0, verify);
    CHECK(r.ok, "max_age=0 skips freshness -> grant");
  }
  {
    uint8_t wrong[32];
    std::memcpy(wrong, pub32, 32);
    wrong[0] ^= 0x01;
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), wrong, allow, ts + 10, 300, verify);
    CHECK(!r.ok, "wrong proven signing key -> deny");
  }
  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, {}, ts + 10, 300, verify);
    CHECK(r.ok && r.xpub == "xpubALLOWED", "empty allowlist -> open (no gate)");
  }
  {
    auto bad = epm;
    bad[bad.size() / 2] ^= 0xFF;
    auto r = AuthorizeModuleRequest(bad.data(), bad.size(), pub32, allow, ts + 10, 300, verify);
    CHECK(!r.ok, "tampered EPM bytes -> deny");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
