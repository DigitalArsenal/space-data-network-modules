// Native unit test for the secp256k1/BIP32 xpub identity crypto.
// Build (native): see tests/run-native.sh. Uses BIP32 Test Vector 1.

#include "xpub_auth.h"

#include <cryptopp/eccrypto.h>
#include <cryptopp/ecp.h>
#include <cryptopp/integer.h>
#include <cryptopp/oids.h>
#include <cryptopp/osrng.h>
#include <cryptopp/sha.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace protection_key_server;

// Test-only Base58Check encoder, to build a synthetic xpub around a fresh key.
static std::string Base58CheckEncode(std::vector<uint8_t> data) {
  uint8_t h1[CryptoPP::SHA256::DIGESTSIZE];
  uint8_t h2[CryptoPP::SHA256::DIGESTSIZE];
  CryptoPP::SHA256().CalculateDigest(h1, data.data(), data.size());
  CryptoPP::SHA256().CalculateDigest(h2, h1, sizeof(h1));
  data.insert(data.end(), h2, h2 + 4);

  std::size_t zeros = 0;
  while (zeros < data.size() && data[zeros] == 0) ++zeros;

  static const char* kAlphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  CryptoPP::Integer num(data.data(), data.size());
  const CryptoPP::Integer base(static_cast<long>(58));
  const CryptoPP::Integer zero(static_cast<long>(0));
  std::string out;
  while (num > zero) {
    const CryptoPP::Integer q = num / base;
    const CryptoPP::Integer rem = num - q * base;
    out.push_back(kAlphabet[rem.ConvertToLong()]);
    num = q;
  }
  for (std::size_t i = 0; i < zeros; ++i) out.push_back('1');
  std::reverse(out.begin(), out.end());
  return out;
}

// Build a depth-0 mainnet xpub (version 0x0488B21E) around a compressed pubkey.
static std::string MakeXpub(const uint8_t pub33[33], const uint8_t cc32[32]) {
  std::vector<uint8_t> p = {0x04, 0x88, 0xB2, 0x1E, 0x00, 0, 0, 0, 0, 0, 0, 0, 0};
  p.insert(p.end(), cc32, cc32 + 32);
  p.insert(p.end(), pub33, pub33 + 33);
  return Base58CheckEncode(p);
}

static int g_fail = 0;
#define CHECK(cond, name)                                  \
  do {                                                     \
    if (cond) {                                            \
      std::printf("  ok    %s\n", name);                   \
    } else {                                               \
      std::printf("  FAIL  %s\n", name);                   \
      ++g_fail;                                            \
    }                                                      \
  } while (0)

int main() {
  // BIP32 Test Vector 1: m/0H and its non-hardened child m/0H/1.
  const std::string parent =
      "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
  const std::string child =
      "xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ";

  std::printf("BIP32 derivation:\n");
  uint8_t child_pub[kCompressedPubKeyBytes];
  uint8_t child_cc[kChainCodeBytes];
  CHECK(ParseXpub(child, child_pub, child_cc), "ParseXpub(child) ok");

  CHECK(XpubDerivesSigner(parent, {1u}, child_pub),
        "m/0H derives m/0H/1 at index 1");
  CHECK(!XpubDerivesSigner(parent, {2u}, child_pub),
        "wrong index (2) does not derive child");
  CHECK(!XpubDerivesSigner(parent, {0x80000000u}, child_pub),
        "hardened index rejected");

  uint8_t junk_pub[kCompressedPubKeyBytes];
  uint8_t junk_cc[kChainCodeBytes];
  CHECK(!ParseXpub("xpubThisIsNotValid", junk_pub, junk_cc),
        "malformed xpub rejected (checksum)");

  // secp256k1 ECDSA verify: sign with a fresh derived key, verify via our path.
  std::printf("secp256k1 verify:\n");
  {
    using namespace CryptoPP;
    AutoSeededRandomPool prng;
    ECDSA<ECP, SHA256>::PrivateKey priv;
    priv.Initialize(prng, ASN1::secp256k1());
    ECDSA<ECP, SHA256>::PublicKey pub;
    priv.MakePublicKey(pub);

    uint8_t pub_c[kCompressedPubKeyBytes];
    pub.GetGroupParameters().GetCurve().EncodePoint(pub_c, pub.GetPublicElement(), true);

    const char* msg = "module-delivery-challenge-0xdeadbeef";
    const auto msg_len = std::strlen(msg);

    ECDSA<ECP, SHA256>::Signer signer(priv);
    std::vector<uint8_t> sig(signer.MaxSignatureLength());
    const auto sig_len =
        signer.SignMessage(prng, reinterpret_cast<const byte*>(msg), msg_len, sig.data());
    sig.resize(sig_len);

    CHECK(VerifySecp256k1(pub_c, reinterpret_cast<const uint8_t*>(msg), msg_len,
                          sig.data(), sig.size()),
          "valid signature verifies");

    std::vector<uint8_t> bad = sig;
    bad[10] ^= 0xff;
    CHECK(!VerifySecp256k1(pub_c, reinterpret_cast<const uint8_t*>(msg), msg_len,
                           bad.data(), bad.size()),
          "tampered signature rejected");

    const char* other = "different-challenge";
    CHECK(!VerifySecp256k1(pub_c, reinterpret_cast<const uint8_t*>(other),
                           std::strlen(other), sig.data(), sig.size()),
          "signature over a different message rejected");
  }

  // Identity block: build a real one around a fresh key (empty path), verify the
  // full authorize path + allowlist / tamper / truncation negatives.
  std::printf("identity block:\n");
  {
    using namespace CryptoPP;
    AutoSeededRandomPool prng;
    ECDSA<ECP, SHA256>::PrivateKey priv;
    priv.Initialize(prng, ASN1::secp256k1());
    ECDSA<ECP, SHA256>::PublicKey pub;
    priv.MakePublicKey(pub);

    uint8_t pub33[kCompressedPubKeyBytes];
    pub.GetGroupParameters().GetCurve().EncodePoint(pub33, pub.GetPublicElement(), true);
    uint8_t cc[kChainCodeBytes] = {0};
    const std::string xpub = MakeXpub(pub33, cc);

    // bound message = challenge_id(16) || client_pub(65) shape (content arbitrary here)
    std::vector<uint8_t> bound(16 + 65);
    for (std::size_t i = 0; i < bound.size(); ++i) bound[i] = static_cast<uint8_t>(i * 7 + 1);

    ECDSA<ECP, SHA256>::Signer signer(priv);
    std::vector<uint8_t> sig(signer.MaxSignatureLength());
    sig.resize(signer.SignMessage(prng, bound.data(), bound.size(), sig.data()));

    std::vector<uint8_t> block;
    block.push_back(static_cast<uint8_t>(xpub.size() >> 8));
    block.push_back(static_cast<uint8_t>(xpub.size() & 0xff));
    block.insert(block.end(), xpub.begin(), xpub.end());
    block.push_back(0);  // path_len = 0 (sign with the xpub key itself)
    block.push_back(static_cast<uint8_t>(sig.size()));
    block.insert(block.end(), sig.begin(), sig.end());

    std::string got;
    CHECK(AuthorizeIdentityBlock(block.data(), block.size(), bound.data(), bound.size(),
                                 {xpub}, &got) && got == xpub,
          "valid identity block authorized + xpub returned");
    CHECK(!AuthorizeIdentityBlock(block.data(), block.size(), bound.data(), bound.size(),
                                  {"xpub6OtherNotAllowed"}, nullptr),
          "xpub not in allowlist rejected");

    std::vector<uint8_t> tampered = block;
    tampered.back() ^= 0xff;
    CHECK(!AuthorizeIdentityBlock(tampered.data(), tampered.size(), bound.data(),
                                  bound.size(), {xpub}, nullptr),
          "tampered identity signature rejected");
    CHECK(!AuthorizeIdentityBlock(block.data(), block.size() - 5, bound.data(),
                                  bound.size(), {xpub}, nullptr),
          "truncated identity block rejected");

    std::vector<uint8_t> wrong_bound = bound;
    wrong_bound[0] ^= 0xff;
    CHECK(!AuthorizeIdentityBlock(block.data(), block.size(), wrong_bound.data(),
                                  wrong_bound.size(), {xpub}, nullptr),
          "signature over wrong bound message rejected");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
