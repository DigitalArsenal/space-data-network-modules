// Module-delivery gate tests: full AuthorizeModuleRequest decision over a real
// signed $EPM FlatBuffer (allowlist / freshness / binding / tamper).
#include "epm_authorize.h"

#include <flatbuffers/flatbuffers.h>

#ifdef DOMAIN
#undef DOMAIN
#endif
#include "EPM_generated.h"

#include <cryptopp/asn.h>
#include <cryptopp/dsa.h>
#include <cryptopp/eccrypto.h>
#include <cryptopp/ecp.h>
#include <cryptopp/oids.h>
#include <cryptopp/osrng.h>
#include <cryptopp/sha.h>
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

// secp256k1 verify mirroring the host op (DER + sha256 internally).
static Secp256k1Verify MakeSecpVerify() {
  return [](const uint8_t* m, std::size_t ml, const uint8_t* s, std::size_t sl,
            const uint8_t* p, std::size_t pl) -> bool {
    using namespace CryptoPP;
    static const DL_GroupParameters_EC<ECP> params(ASN1::secp256k1());
    ECP::Point point;
    if (!params.GetCurve().DecodePoint(point, p, pl)) return false;
    ECDSA<ECP, SHA256>::PublicKey publicKey;
    publicKey.Initialize(ASN1::secp256k1(), point);
    ECDSA<ECP, SHA256>::Verifier verifier(publicKey);
    const std::size_t p1363_len = verifier.SignatureLength();
    if (sl == p1363_len) return verifier.VerifyMessage(m, ml, s, sl);
    std::vector<uint8_t> p1363(p1363_len, 0);
    const std::size_t produced = DSAConvertSignatureFormat(
        p1363.data(), p1363.size(), DSA_P1363, s, sl, DSA_DER);
    if (produced == 0) return false;
    return verifier.VerifyMessage(m, ml, p1363.data(), p1363.size());
  };
}

// Build a signed, size-prefixed $EPM with one secp256k1 signing key (DER signature).
static std::vector<uint8_t> BuildSignedSecpEpm(const std::string& xpub, int64_t ts) {
  using namespace CryptoPP;
  AutoSeededRandomPool prng;
  ECDSA<ECP, SHA256>::PrivateKey sk;
  sk.Initialize(prng, ASN1::secp256k1());
  ECDSA<ECP, SHA256>::PublicKey spk;
  sk.MakePublicKey(spk);
  uint8_t pub33[33];
  spk.GetGroupParameters().GetCurve().EncodePoint(pub33, spk.GetPublicElement(), true);

  EpmFields f;
  f.entity_type = "User";
  f.signature_timestamp = ts;
  f.signature_algorithm = "secp256k1";
  sdn::epm::CryptoKey k;
  k.public_key = ToHex(pub33, sizeof(pub33));
  k.xpub = xpub;
  k.address_type = "secp256k1";
  k.key_type = "Signing";
  k.key_path = "m/44'/0'/0'";
  k.algorithm = "secp256k1";
  k.encoding = "der";
  f.keys.push_back(k);

  const std::string content = SigningContentBytes(f);
  ECDSA<ECP, SHA256>::Signer signer(sk);
  std::vector<uint8_t> p1363(signer.MaxSignatureLength());
  p1363.resize(signer.SignMessage(prng, reinterpret_cast<const byte*>(content.data()),
                                  content.size(), p1363.data()));
  std::vector<uint8_t> der(p1363.size() + 8, 0);
  der.resize(DSAConvertSignatureFormat(der.data(), der.size(), DSA_DER,
                                       p1363.data(), p1363.size(), DSA_P1363));

  flatbuffers::FlatBufferBuilder b(1024);
  const auto pk = b.CreateString(k.public_key);
  const auto xp = b.CreateString(xpub);
  const auto at = b.CreateString("secp256k1");
  const auto kp = b.CreateString(k.key_path);
  const auto alg = b.CreateString(k.algorithm);
  const auto enc = b.CreateString(k.encoding);
  CryptoKeyBuilder ckb(b);
  ckb.add_PUBLIC_KEY(pk);
  ckb.add_XPUB(xp);
  ckb.add_ADDRESS_TYPE(at);
  ckb.add_KEY_TYPE(KeyType::Signing);
  ckb.add_KEY_PATH(kp);
  ckb.add_ALGORITHM(alg);
  ckb.add_ENCODING(enc);
  const auto ck = ckb.Finish();
  const auto keys = b.CreateVector(std::vector<flatbuffers::Offset<::CryptoKey>>{ck});
  const auto so = b.CreateString(ToHex(der.data(), der.size()));
  const auto signature_algorithm = b.CreateString(f.signature_algorithm);
  EPMBuilder eb(b);
  eb.add_KEYS(keys);
  eb.add_SIGNATURE(so);
  eb.add_SIGNATURE_TIMESTAMP(ts);
  eb.add_SIGNATURE_ALGORITHM(signature_algorithm);
  eb.add_ENTITY_TYPE(EntityType::User);
  FinishSizePrefixedEPMBuffer(b, eb.Finish());
  return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// Build a signed, size-prefixed $EPM whose proven Ed25519 key signs a separate
// canonical secp256k1 account-xpub entry.
static std::vector<uint8_t> BuildSignedEpm(CryptoPP::ed25519::Signer& signer,
                                           const uint8_t pub32[32],
                                           const std::string& xpub, int64_t ts) {
  EpmFields f;
  f.entity_type = "User";
  f.signature_timestamp = ts;
  f.signature_algorithm = "ed25519";
  sdn::epm::CryptoKey k;
  k.public_key = ToHex(pub32, 32);
  k.address_type = "ed25519";
  k.key_type = "Signing";
  k.key_path = "m/44'/0'/0'/0'/0'";
  k.algorithm = "ed25519";
  k.encoding = "raw-ed25519";
  f.keys.push_back(k);
  sdn::epm::CryptoKey account;
  account.xpub = xpub;
  account.address_type = "p2pkh";
  account.key_type = "Signing";
  account.key_path = "m/44'/0'/0'";
  account.algorithm = "secp256k1";
  account.encoding = "compressed-sec1";
  f.keys.push_back(account);

  const std::string content = SigningContentBytes(f);
  CryptoPP::AutoSeededRandomPool prng;
  std::vector<CryptoPP::byte> sig(signer.MaxSignatureLength());
  sig.resize(signer.SignMessage(prng, reinterpret_cast<const CryptoPP::byte*>(content.data()),
                                content.size(), sig.data()));

  flatbuffers::FlatBufferBuilder b(1024);
  const auto pk = b.CreateString(k.public_key);
  const auto at = b.CreateString("ed25519");
  const auto kp = b.CreateString(k.key_path);
  const auto alg = b.CreateString(k.algorithm);
  const auto enc = b.CreateString(k.encoding);
  CryptoKeyBuilder ckb(b);
  ckb.add_PUBLIC_KEY(pk);
  ckb.add_ADDRESS_TYPE(at);
  ckb.add_KEY_TYPE(KeyType::Signing);
  ckb.add_KEY_PATH(kp);
  ckb.add_ALGORITHM(alg);
  ckb.add_ENCODING(enc);
  const auto ed_ck = ckb.Finish();
  const auto xp = b.CreateString(xpub);
  const auto account_at = b.CreateString(account.address_type);
  const auto account_kp = b.CreateString(account.key_path);
  const auto account_alg = b.CreateString(account.algorithm);
  const auto account_enc = b.CreateString(account.encoding);
  CryptoKeyBuilder account_builder(b);
  account_builder.add_XPUB(xp);
  account_builder.add_ADDRESS_TYPE(account_at);
  account_builder.add_KEY_TYPE(KeyType::Signing);
  account_builder.add_KEY_PATH(account_kp);
  account_builder.add_ALGORITHM(account_alg);
  account_builder.add_ENCODING(account_enc);
  const auto account_ck = account_builder.Finish();
  const auto keys = b.CreateVector(
      std::vector<flatbuffers::Offset<::CryptoKey>>{ed_ck, account_ck});
  const auto so = b.CreateString(ToHex(sig.data(), sig.size()));
  const auto signature_algorithm = b.CreateString(f.signature_algorithm);
  EPMBuilder eb(b);
  eb.add_KEYS(keys);
  eb.add_SIGNATURE(so);
  eb.add_SIGNATURE_TIMESTAMP(ts);
  eb.add_SIGNATURE_ALGORITHM(signature_algorithm);
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
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, {"xpubOTHER"}, ts + 10, 300, verify);
    CHECK(!r.ok, "xpub not in allowlist -> deny");
  }
  {
    auto r = AuthorizeModuleRequest(epm.data(), epm.size(), pub32, allow, ts + 1000, 300, verify);
    CHECK(!r.ok, "stale EPM -> deny");
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

  // ---- secp256k1-signed EPM: a secp256k1-identity requester passing the gate ----
  std::printf("module-delivery gate (secp256k1 identity):\n");
  Secp256k1Verify verify_secp = MakeSecpVerify();
  const auto sepm = BuildSignedSecpEpm("xpubSECPALLOWED", ts);
  const std::vector<std::string> secp_allow = {"xpubSECPALLOWED", "xpubANOTHER"};
  {
    // A secp-only EPM cannot replace the Ed25519 key authenticated by LPF.
    auto r = AuthorizeModuleRequest(sepm.data(), sepm.size(), pub32, secp_allow,
                                    ts + 10, 300, verify, verify_secp);
    CHECK(!r.ok, "secp256k1 EPM cannot bypass proven Ed25519 proof key");
  }
  {
    auto r = AuthorizeModuleRequest(sepm.data(), sepm.size(), nullptr, {"xpubOTHER"},
                                    ts + 10, 300, verify, verify_secp);
    CHECK(!r.ok, "secp256k1 EPM: xpub not in allowlist -> deny");
  }
  {
    auto r = AuthorizeModuleRequest(sepm.data(), sepm.size(), nullptr, secp_allow,
                                    ts + 1000, 300, verify, verify_secp);
    CHECK(!r.ok, "secp256k1 EPM: stale -> deny");
  }
  {
    // No secp256k1 verifier supplied -> the secp256k1 signing key is skipped -> deny.
    auto r = AuthorizeModuleRequest(sepm.data(), sepm.size(), nullptr, secp_allow,
                                    ts + 10, 300, verify);
    CHECK(!r.ok, "secp256k1 EPM without secp256k1 verifier -> deny");
  }
  {
    auto bad = sepm;
    bad[bad.size() / 2] ^= 0xFF;
    auto r = AuthorizeModuleRequest(bad.data(), bad.size(), nullptr, secp_allow,
                                    ts + 10, 300, verify, verify_secp);
    CHECK(!r.ok, "tampered secp256k1 EPM bytes -> deny");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
