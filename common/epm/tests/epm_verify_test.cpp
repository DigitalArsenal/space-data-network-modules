// EPM attestation verify tests. ed25519 and secp256k1 verification are injected
// (host calls in the wasm module; Crypto++ here). The secp256k1 callback mirrors
// the host contract: ECDSA-DER signature, sha256(message) + DER-verify internally.
#include "epm_verify.h"

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

// secp256k1 verify mirroring the host op: DER signature + sha256(message)
// internally (Crypto++ VerifyMessage hashes with SHA256; DER is converted to the
// fixed-length P1363 r||s it expects).
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
    const std::size_t p1363_len = verifier.SignatureLength();  // 64
    if (sl == p1363_len) return verifier.VerifyMessage(m, ml, s, sl);
    std::vector<uint8_t> p1363(p1363_len, 0);
    const std::size_t produced = DSAConvertSignatureFormat(
        p1363.data(), p1363.size(), DSA_P1363, s, sl, DSA_DER);
    if (produced == 0) return false;
    return verifier.VerifyMessage(m, ml, p1363.data(), p1363.size());
  };
}

// Sign `content` with secp256k1 ECDSA and return a DER signature (the on-wire form).
static std::vector<uint8_t> SignSecpDer(CryptoPP::ECDSA<CryptoPP::ECP, CryptoPP::SHA256>::Signer& signer,
                                        const std::string& content) {
  using namespace CryptoPP;
  AutoSeededRandomPool prng;
  std::vector<uint8_t> p1363(signer.MaxSignatureLength());
  p1363.resize(signer.SignMessage(prng, reinterpret_cast<const byte*>(content.data()),
                                  content.size(), p1363.data()));
  std::vector<uint8_t> der(p1363.size() + 8, 0);
  const std::size_t der_len = DSAConvertSignatureFormat(
      der.data(), der.size(), DSA_DER, p1363.data(), p1363.size(), DSA_P1363);
  der.resize(der_len);
  return der;
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
  epm.signature_algorithm = "ed25519";
  CryptoKey k;
  k.public_key = ToHex(pub32, 32);
  k.address_type = "ed25519";
  k.key_type = "Signing";
  k.key_path = "m/44'/0'/0'/0'/0'";
  k.algorithm = "ed25519";
  k.encoding = "raw-ed25519";
  epm.keys.push_back(k);
  CryptoKey account;
  account.xpub = "xpub6DHmTESTidentity";
  account.address_type = "p2pkh";
  account.key_type = "Signing";
  account.key_path = "m/44'/0'/0'";
  account.algorithm = "secp256k1";
  account.encoding = "compressed-sec1";
  epm.keys.push_back(account);

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
  {
    EpmFields no_account = epm;
    no_account.keys.pop_back();
    const std::string changed = SigningContentBytes(no_account);
    std::vector<CryptoPP::byte> changed_sig(signer.MaxSignatureLength());
    changed_sig.resize(signer.SignMessage(
        prng, reinterpret_cast<const CryptoPP::byte*>(changed.data()), changed.size(),
        changed_sig.data()));
    auto r = VerifyEpm(no_account, changed_sig.data(), changed_sig.size(), pub32, cpp_verify);
    CHECK(!r.ok && r.error.find("no canonical") != std::string::npos,
          "verified Ed25519 EPM without separate account xpub rejected");
  }
  {
    EpmFields ambiguous = epm;
    CryptoKey second = account;
    second.xpub = "xpubSECOND";
    second.key_path = "m/44'/0'/1'";
    ambiguous.keys.push_back(second);
    const std::string changed = SigningContentBytes(ambiguous);
    std::vector<CryptoPP::byte> changed_sig(signer.MaxSignatureLength());
    changed_sig.resize(signer.SignMessage(
        prng, reinterpret_cast<const CryptoPP::byte*>(changed.data()), changed.size(),
        changed_sig.data()));
    auto r = VerifyEpm(ambiguous, changed_sig.data(), changed_sig.size(), pub32, cpp_verify);
    CHECK(!r.ok && r.error.find("ambiguous") != std::string::npos,
          "multiple canonical account xpub entries rejected");
  }

  // ---- secp256k1-signed EPM ----
  std::printf("EPM verify (secp256k1):\n");
  Secp256k1Verify cpp_secp_verify = MakeSecpVerify();
  {
    ECDSA<ECP, SHA256>::PrivateKey sk;
    sk.Initialize(prng, ASN1::secp256k1());
    ECDSA<ECP, SHA256>::PublicKey spk;
    sk.MakePublicKey(spk);
    uint8_t pub33[33];
    spk.GetGroupParameters().GetCurve().EncodePoint(pub33, spk.GetPublicElement(), true);
    ECDSA<ECP, SHA256>::Signer ssigner(sk);

    EpmFields sepm;
    sepm.entity_type = "Individual";
    sepm.legal_name = "Acme & Co";
    sepm.signature_timestamp = 1782470000;
    sepm.signature_algorithm = "secp256k1";
    CryptoKey sk_key;
    sk_key.public_key = ToHex(pub33, sizeof(pub33));
    sk_key.xpub = "xpubSECPidentity";
    sk_key.address_type = "secp256k1";
    sk_key.key_type = "Signing";
    sk_key.key_path = "m/44'/0'/0'";
    sk_key.algorithm = "secp256k1";
    sk_key.encoding = "der";
    sepm.keys.push_back(sk_key);

    const std::string scontent = SigningContentBytes(sepm);
    const std::vector<uint8_t> sder = SignSecpDer(ssigner, scontent);
    // DER is variable length and not 64 — the verifier must accept it.
    CHECK(sder.size() != 64, "secp256k1 signature is DER (not 64 bytes)");

    {
      auto r = VerifyEpm(sepm, sder.data(), sder.size(), nullptr, cpp_verify, cpp_secp_verify);
      CHECK(r.ok && r.xpub == "xpubSECPidentity",
            "valid secp256k1 EPM verifies + xpub extracted");
      if (!r.ok) std::printf("    err: %s\n", r.error.c_str());
    }
    {
      // A module-delivery proof authenticates this Ed25519 key; a secp-only EPM
      // must not bypass that proof merely because its xpub is allowlisted.
      auto r = VerifyEpm(sepm, sder.data(), sder.size(), pub32, cpp_verify, cpp_secp_verify);
      CHECK(!r.ok, "secp256k1 EPM cannot bypass proven ed25519 binding");
    }
    {
      auto bad = sder;
      bad[bad.size() / 2] ^= 0x01;
      auto r = VerifyEpm(sepm, bad.data(), bad.size(), nullptr, cpp_verify, cpp_secp_verify);
      CHECK(!r.ok, "tampered secp256k1 signature rejected");
    }
    {
      EpmFields modified = sepm;
      modified.signature_timestamp = 1782470001;  // content changes -> old sig invalid
      auto r = VerifyEpm(modified, sder.data(), sder.size(), nullptr, cpp_verify, cpp_secp_verify);
      CHECK(!r.ok, "modified secp256k1 EPM content rejected");
    }
    {
      // Without a secp256k1 verifier, a secp256k1 signing key is skipped -> reject.
      auto r = VerifyEpm(sepm, sder.data(), sder.size(), nullptr, cpp_verify);
      CHECK(!r.ok, "secp256k1 EPM rejected when no secp256k1 verifier supplied");
    }
  }

  // ---- mixed keys: ed25519 tried first ----
  {
    // EPM carrying both an ed25519 and a secp256k1 signing key, signed with ed25519.
    ECDSA<ECP, SHA256>::PrivateKey sk;
    sk.Initialize(prng, ASN1::secp256k1());
    ECDSA<ECP, SHA256>::PublicKey spk;
    sk.MakePublicKey(spk);
    uint8_t pub33[33];
    spk.GetGroupParameters().GetCurve().EncodePoint(pub33, spk.GetPublicElement(), true);

    EpmFields mixed;
    mixed.entity_type = "Individual";
    mixed.signature_timestamp = 1782470000;
    mixed.signature_algorithm = "ed25519";
    CryptoKey ed_key;
    ed_key.public_key = ToHex(pub32, 32);
    ed_key.address_type = "ed25519";
    ed_key.key_type = "Signing";
    ed_key.key_path = "m/44'/0'/0'/0'/0'";
    ed_key.algorithm = "ed25519";
    ed_key.encoding = "raw-ed25519";
    mixed.keys.push_back(ed_key);
    CryptoKey secp_key;
    secp_key.public_key = ToHex(pub33, sizeof(pub33));
    secp_key.xpub = "xpubSECPidentity";
    secp_key.address_type = "secp256k1";
    secp_key.key_type = "Signing";
    secp_key.key_path = "m/44'/0'/0'";
    secp_key.algorithm = "secp256k1";
    secp_key.encoding = "compressed-sec1";
    mixed.keys.push_back(secp_key);

    const std::string mcontent = SigningContentBytes(mixed);
    std::vector<CryptoPP::byte> msig(signer.MaxSignatureLength());
    msig.resize(signer.SignMessage(prng, reinterpret_cast<const CryptoPP::byte*>(mcontent.data()),
                                   mcontent.size(), msig.data()));
    auto r = VerifyEpm(mixed, msig.data(), msig.size(), pub32, cpp_verify, cpp_secp_verify);
    CHECK(r.ok && r.xpub == "xpubSECPidentity",
          "mixed EPM: proven Ed25519 signature binds separate account xpub");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
