// End-to-end: build a size-prefixed $EPM FlatBuffer, map it to EpmFields, and
// verify the attestation through the full isomorphic pipeline (FB -> JCS -> ed25519).
#include "epm_fb.h"
#include "epm_verify.h"

#include <flatbuffers/flatbuffers.h>

#ifdef DOMAIN
#undef DOMAIN
#endif
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
static std::vector<uint8_t> FromHex(const std::string& s) {
  std::vector<uint8_t> out;
  const auto nib = [](char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; };
  for (size_t i = 0; i + 1 < s.size(); i += 2) out.push_back((nib(s[i]) << 4) | nib(s[i + 1]));
  return out;
}

int main() {
  using namespace CryptoPP;
  std::printf("EPM FlatBuffer -> verify (end-to-end):\n");

  AutoSeededRandomPool prng;
  ed25519PrivateKey priv;
  priv.GenerateRandom(prng, g_nullNameValuePairs);
  ed25519PublicKey pub;
  priv.MakePublicKey(pub);
  uint8_t pub32[32];
  std::memcpy(pub32, pub.GetPublicKeyBytePtr(), 32);
  ed25519::Signer signer(priv);

  Ed25519Verify cpp_verify = [](const uint8_t* m, std::size_t ml, const uint8_t* s,
                                std::size_t sl, const uint8_t* p) -> bool {
    CryptoPP::ed25519::Verifier v(p);
    return v.VerifyMessage(m, ml, s, sl);
  };

  // The content to sign (must match what the FB maps back to).
  EpmFields tosign;
  tosign.entity_type = "User";
  tosign.signature_timestamp = 1782470000;
  tosign.signature_algorithm = "ed25519";
  sdn::epm::CryptoKey k;
  k.public_key = ToHex(pub32, 32);
  k.address_type = "ed25519";
  k.key_type = "Signing";
  k.key_path = "m/44'/0'/0'/0'/0'";
  k.algorithm = "ed25519";
  k.encoding = "raw-ed25519";
  tosign.keys.push_back(k);
  sdn::epm::CryptoKey account;
  account.xpub = "xpub6DHmTESTidentity";
  account.address_type = "p2pkh";
  account.key_type = "Signing";
  account.key_path = "m/44'/0'/0'";
  account.algorithm = "secp256k1";
  account.encoding = "compressed-sec1";
  tosign.keys.push_back(account);

  const std::string content = SigningContentBytes(tosign);
  std::vector<CryptoPP::byte> sig(signer.MaxSignatureLength());
  sig.resize(signer.SignMessage(prng, reinterpret_cast<const CryptoPP::byte*>(content.data()),
                                content.size(), sig.data()));
  const std::string sig_hex = ToHex(sig.data(), sig.size());

  // Build the size-prefixed $EPM FlatBuffer with the same fields + SIGNATURE.
  flatbuffers::FlatBufferBuilder b(1024);
  const auto pk_off = b.CreateString(k.public_key);
  const auto at_off = b.CreateString(k.address_type);
  const auto kp_off = b.CreateString(k.key_path);
  const auto alg_off = b.CreateString(k.algorithm);
  const auto enc_off = b.CreateString(k.encoding);
  CryptoKeyBuilder ckb(b);
  ckb.add_PUBLIC_KEY(pk_off);
  ckb.add_ADDRESS_TYPE(at_off);
  ckb.add_KEY_TYPE(KeyType::Signing);
  ckb.add_KEY_PATH(kp_off);
  ckb.add_ALGORITHM(alg_off);
  ckb.add_ENCODING(enc_off);
  const auto ed_off = ckb.Finish();
  const auto xpub_off = b.CreateString(account.xpub);
  const auto account_at = b.CreateString(account.address_type);
  const auto account_kp = b.CreateString(account.key_path);
  const auto account_alg = b.CreateString(account.algorithm);
  const auto account_enc = b.CreateString(account.encoding);
  CryptoKeyBuilder account_builder(b);
  account_builder.add_XPUB(xpub_off);
  account_builder.add_ADDRESS_TYPE(account_at);
  account_builder.add_KEY_TYPE(KeyType::Signing);
  account_builder.add_KEY_PATH(account_kp);
  account_builder.add_ALGORITHM(account_alg);
  account_builder.add_ENCODING(account_enc);
  const auto account_off = account_builder.Finish();
  const auto keys_off = b.CreateVector(
      std::vector<flatbuffers::Offset<::CryptoKey>>{ed_off, account_off});
  const auto sig_off = b.CreateString(sig_hex);
  const auto sig_alg_off = b.CreateString(tosign.signature_algorithm);
  EPMBuilder eb(b);
  eb.add_KEYS(keys_off);
  eb.add_SIGNATURE(sig_off);
  eb.add_SIGNATURE_TIMESTAMP(1782470000);
  eb.add_SIGNATURE_ALGORITHM(sig_alg_off);
  eb.add_ENTITY_TYPE(EntityType::User);
  FinishSizePrefixedEPMBuffer(b, eb.Finish());

  // Map the FlatBuffer back and verify end-to-end.
  EpmFields mapped;
  std::string mapped_sig_hex;
  const bool parsed = EpmFieldsFromBytes(b.GetBufferPointer(), b.GetSize(), &mapped, &mapped_sig_hex);
  CHECK(parsed, "size-prefixed $EPM FlatBuffer parsed");
  CHECK(mapped_sig_hex == sig_hex, "SIGNATURE round-trips");
  CHECK(SigningContentBytes(mapped) == content, "mapped fields reproduce canonical content");

  const std::vector<uint8_t> sig_bytes = FromHex(mapped_sig_hex);
  auto r = VerifyEpm(mapped, sig_bytes.data(), sig_bytes.size(), pub32, cpp_verify);
  CHECK(r.ok && r.xpub == "xpub6DHmTESTidentity", "end-to-end: FB -> verify -> xpub bound");
  if (!r.ok) std::printf("    err: %s\n", r.error.c_str());

  std::printf(g_fail == 0 ? "\nALL PASS\n" : "\n%d FAILURE(S)\n", g_fail);
  return g_fail == 0 ? 0 : 1;
}
