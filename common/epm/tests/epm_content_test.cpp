// EPM signing-content tests: pinned canonical bytes + ed25519 roundtrip.
#include "epm_content.h"

#include <cryptopp/osrng.h>
#include <cryptopp/xed25519.h>

#include <cstdio>
#include <string>
#include <vector>

using namespace sdn::epm;

static int g_fail = 0;
#define CHECK(cond, name)                                              \
  do {                                                                 \
    if (cond) std::printf("  ok    %s\n", name);                       \
    else { std::printf("  FAIL  %s\n", name); ++g_fail; }              \
  } while (0)

int main() {
  std::printf("EPM signing content:\n");

  // Machine identity: ENTITY_TYPE + one signing key + timestamp.
  EpmFields epm;
  epm.entity_type = "Individual";
  epm.signature_timestamp = 1782470000;
  CryptoKey k;
  k.public_key = "aabbcc";
  k.xpub = "xpubTEST";
  k.address_type = "ed25519";
  k.key_address = "";  // empty -> omitted
  k.key_type = "Signing";
  epm.keys.push_back(k);

  const std::string canon = SigningContentBytes(epm);
  const std::string expect =
      "{\"ENTITY_TYPE\":\"Individual\",\"KEYS\":[{\"ADDRESS_TYPE\":\"ed25519\","
      "\"KEY_TYPE\":\"Signing\",\"PUBLIC_KEY\":\"aabbcc\",\"XPUB\":\"xpubTEST\"}],"
      "\"SIGNATURE_TIMESTAMP\":1782470000}";
  CHECK(canon == expect, "canonical content: field set + recursive key sort + omit-empty");
  if (canon != expect) std::printf("    got: %s\n    exp: %s\n", canon.c_str(), expect.c_str());

  // Trim + no HTML escaping + omit-empty.
  EpmFields e2;
  e2.entity_type = "Organization";
  e2.legal_name = "  Acme & Co <Ltd>  ";
  const std::string c2 = SigningContentBytes(e2);
  const std::string e2x = "{\"ENTITY_TYPE\":\"Organization\",\"LEGAL_NAME\":\"Acme & Co <Ltd>\"}";
  CHECK(c2 == e2x, "trim whitespace, raw & < >, omit empties");
  if (c2 != e2x) std::printf("    got: %s\n", c2.c_str());

  // ed25519 sign/verify over the canonical content.
  std::printf("ed25519 over canonical content:\n");
  {
    using namespace CryptoPP;
    AutoSeededRandomPool prng;
    ed25519::Signer signer(prng);
    ed25519::Verifier verifier(signer);

    std::vector<CryptoPP::byte> sig(signer.MaxSignatureLength());
    const size_t sl = signer.SignMessage(
        prng, reinterpret_cast<const CryptoPP::byte*>(canon.data()), canon.size(), sig.data());
    sig.resize(sl);

    CHECK(verifier.VerifyMessage(reinterpret_cast<const CryptoPP::byte*>(canon.data()),
                                 canon.size(), sig.data(), sig.size()),
          "valid signature verifies");

    std::string tampered = canon;
    tampered[15] ^= 0x01;
    CHECK(!verifier.VerifyMessage(reinterpret_cast<const CryptoPP::byte*>(tampered.data()),
                                  tampered.size(), sig.data(), sig.size()),
          "tampered content rejected");
  }

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
