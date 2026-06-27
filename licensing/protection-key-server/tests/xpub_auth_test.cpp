// Native unit test for the secp256k1/BIP32 xpub identity crypto.
// Build (native): see tests/run-native.sh. Uses BIP32 Test Vector 1.

#include "xpub_auth.h"

#include <cryptopp/eccrypto.h>
#include <cryptopp/ecp.h>
#include <cryptopp/oids.h>
#include <cryptopp/osrng.h>
#include <cryptopp/sha.h>

#include <cstdio>
#include <cstring>
#include <vector>

using namespace protection_key_server;

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

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
