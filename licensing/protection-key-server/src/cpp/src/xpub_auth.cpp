#include "xpub_auth.h"

#include <cryptopp/asn.h>
#include <cryptopp/dsa.h>
#include <cryptopp/eccrypto.h>
#include <cryptopp/ecp.h>
#include <cryptopp/hmac.h>
#include <cryptopp/integer.h>
#include <cryptopp/oids.h>
#include <cryptopp/pubkey.h>
#include <cryptopp/sha.h>

#include <cstring>

namespace protection_key_server {
namespace {

using CryptoPP::ECP;
using CryptoPP::Integer;

const char kBase58Alphabet[] =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Base58Check decode. Returns the payload (without the 4-byte checksum) on success.
bool Base58CheckDecode(const std::string& s, std::vector<uint8_t>& payload_out) {
  int8_t map[128];
  std::memset(map, -1, sizeof(map));
  for (int i = 0; i < 58; ++i) map[static_cast<uint8_t>(kBase58Alphabet[i])] = static_cast<int8_t>(i);

  Integer num(static_cast<long>(0));
  const Integer base(static_cast<long>(58));
  std::size_t leading_zeros = 0;
  bool counting = true;
  for (char ch : s) {
    const auto uc = static_cast<uint8_t>(ch);
    if (uc >= 128 || map[uc] < 0) return false;
    num = num * base + Integer(static_cast<long>(map[uc]));
    if (counting) {
      if (ch == '1') ++leading_zeros;
      else counting = false;
    }
  }

  std::vector<uint8_t> decoded(leading_zeros, 0);
  const std::size_t enc_size = num.MinEncodedSize();
  if (enc_size > 0) {
    std::vector<uint8_t> enc(enc_size);
    num.Encode(enc.data(), enc_size);
    decoded.insert(decoded.end(), enc.begin(), enc.end());
  }
  if (decoded.size() < 5) return false;

  const std::size_t body = decoded.size() - 4;
  uint8_t h1[CryptoPP::SHA256::DIGESTSIZE];
  uint8_t h2[CryptoPP::SHA256::DIGESTSIZE];
  CryptoPP::SHA256().CalculateDigest(h1, decoded.data(), body);
  CryptoPP::SHA256().CalculateDigest(h2, h1, sizeof(h1));
  if (std::memcmp(h2, decoded.data() + body, 4) != 0) return false;

  payload_out.assign(decoded.begin(), decoded.begin() + body);
  return true;
}

const CryptoPP::DL_GroupParameters_EC<ECP>& Secp256k1() {
  static const CryptoPP::DL_GroupParameters_EC<ECP> params(CryptoPP::ASN1::secp256k1());
  return params;
}

}  // namespace

bool ParseXpub(const std::string& xpub_base58,
               uint8_t out_pubkey[kCompressedPubKeyBytes],
               uint8_t out_chaincode[kChainCodeBytes]) {
  std::vector<uint8_t> payload;
  if (!Base58CheckDecode(xpub_base58, payload)) return false;
  // BIP32 serialization: version(4) depth(1) parentFP(4) childNum(4)
  //                      chaincode(32) pubkey(33) = 78 bytes.
  if (payload.size() != 78) return false;
  std::memcpy(out_chaincode, payload.data() + 13, kChainCodeBytes);
  std::memcpy(out_pubkey, payload.data() + 45, kCompressedPubKeyBytes);
  // Reject anything that is not a compressed public key (0x02/0x03 prefix).
  return out_pubkey[0] == 0x02 || out_pubkey[0] == 0x03;
}

bool DeriveChildPub(const uint8_t parent_pub[kCompressedPubKeyBytes],
                    const uint8_t parent_cc[kChainCodeBytes],
                    uint32_t index,
                    uint8_t out_pub[kCompressedPubKeyBytes],
                    uint8_t out_cc[kChainCodeBytes]) {
  if (index & 0x80000000u) return false;  // hardened derivation needs the private key

  const auto& params = Secp256k1();
  const ECP& ec = params.GetCurve();

  ECP::Point parent;
  if (!ec.DecodePoint(parent, parent_pub, kCompressedPubKeyBytes)) return false;

  // I = HMAC-SHA512(parent_cc, serP(parent_pub) || ser32(index))
  uint8_t data[kCompressedPubKeyBytes + 4];
  std::memcpy(data, parent_pub, kCompressedPubKeyBytes);
  data[33] = static_cast<uint8_t>(index >> 24);
  data[34] = static_cast<uint8_t>(index >> 16);
  data[35] = static_cast<uint8_t>(index >> 8);
  data[36] = static_cast<uint8_t>(index);

  uint8_t I[CryptoPP::SHA512::DIGESTSIZE];
  CryptoPP::HMAC<CryptoPP::SHA512> hmac(parent_cc, kChainCodeBytes);
  hmac.Update(data, sizeof(data));
  hmac.Final(I);

  const Integer il(I, kChainCodeBytes);
  if (il >= params.GetSubgroupOrder()) return false;  // invalid: caller should skip index

  // child = il*G + parent
  const ECP::Point child =
      ec.Add(ec.Multiply(il, params.GetSubgroupGenerator()), parent);
  if (child.identity) return false;  // invalid: caller should skip index

  ec.EncodePoint(out_pub, child, /*compressed=*/true);
  std::memcpy(out_cc, I + kChainCodeBytes, kChainCodeBytes);
  return true;
}

bool DeriveXpubChildPub(const std::string& xpub_base58,
                        const std::vector<uint32_t>& path,
                        uint8_t out_pub33[kCompressedPubKeyBytes]) {
  uint8_t pub[kCompressedPubKeyBytes];
  uint8_t cc[kChainCodeBytes];
  if (!ParseXpub(xpub_base58, pub, cc)) return false;

  for (uint32_t index : path) {
    uint8_t npub[kCompressedPubKeyBytes];
    uint8_t ncc[kChainCodeBytes];
    if (!DeriveChildPub(pub, cc, index, npub, ncc)) return false;
    std::memcpy(pub, npub, kCompressedPubKeyBytes);
    std::memcpy(cc, ncc, kChainCodeBytes);
  }
  std::memcpy(out_pub33, pub, kCompressedPubKeyBytes);
  return true;
}

bool XpubDerivesSigner(const std::string& xpub_base58,
                       const std::vector<uint32_t>& path,
                       const uint8_t signer_pub33[kCompressedPubKeyBytes]) {
  uint8_t derived[kCompressedPubKeyBytes];
  if (!DeriveXpubChildPub(xpub_base58, path, derived)) return false;
  return std::memcmp(derived, signer_pub33, kCompressedPubKeyBytes) == 0;
}

bool AuthorizeIdentityBlock(const uint8_t* block, std::size_t block_len,
                            const uint8_t* bound_msg, std::size_t bound_len,
                            const std::vector<std::string>& allowed_xpubs,
                            std::string* out_xpub) {
  std::size_t off = 0;
  const auto avail = [&](std::size_t n) { return off + n <= block_len; };

  if (!avail(2)) return false;
  const uint16_t xpub_len = static_cast<uint16_t>((block[off] << 8) | block[off + 1]);
  off += 2;
  if (xpub_len == 0 || !avail(xpub_len)) return false;
  const std::string xpub(reinterpret_cast<const char*>(block + off), xpub_len);
  off += xpub_len;

  if (!avail(1)) return false;
  const uint8_t path_len = block[off++];
  std::vector<uint32_t> path(path_len);
  if (!avail(static_cast<std::size_t>(path_len) * 4)) return false;
  for (uint8_t i = 0; i < path_len; ++i) {
    path[i] = (static_cast<uint32_t>(block[off]) << 24) |
              (static_cast<uint32_t>(block[off + 1]) << 16) |
              (static_cast<uint32_t>(block[off + 2]) << 8) |
              static_cast<uint32_t>(block[off + 3]);
    off += 4;
  }

  if (!avail(1)) return false;
  const uint8_t sig_len = block[off++];
  if (sig_len == 0 || !avail(sig_len)) return false;
  const uint8_t* sig = block + off;
  off += sig_len;

  // Reject trailing garbage (the block must be exactly consumed).
  if (off != block_len) return false;

  // Early allowlist check (cheap) before the EC work.
  if (!allowed_xpubs.empty()) {
    bool listed = false;
    for (const std::string& a : allowed_xpubs) {
      if (a == xpub) { listed = true; break; }
    }
    if (!listed) return false;
  }

  uint8_t derived[kCompressedPubKeyBytes];
  if (!DeriveXpubChildPub(xpub, path, derived)) return false;
  if (!VerifySecp256k1(derived, bound_msg, bound_len, sig, sig_len)) return false;

  if (out_xpub != nullptr) *out_xpub = xpub;
  return true;
}

bool VerifySecp256k1(const uint8_t pub33[kCompressedPubKeyBytes],
                     const uint8_t* msg, std::size_t msg_len,
                     const uint8_t* sig, std::size_t sig_len) {
  const auto& params = Secp256k1();
  ECP::Point point;
  if (!params.GetCurve().DecodePoint(point, pub33, kCompressedPubKeyBytes)) return false;

  CryptoPP::ECDSA<ECP, CryptoPP::SHA256>::PublicKey publicKey;
  publicKey.Initialize(CryptoPP::ASN1::secp256k1(), point);
  CryptoPP::ECDSA<ECP, CryptoPP::SHA256>::Verifier verifier(publicKey);

  const std::size_t p1363_len = verifier.SignatureLength();  // 64 for secp256k1

  if (sig_len == p1363_len) {
    return verifier.VerifyMessage(msg, msg_len, sig, sig_len);
  }

  // Accept a DER-encoded signature by converting to the fixed-length P1363 r||s.
  std::vector<uint8_t> p1363(p1363_len, 0);
  const std::size_t produced = CryptoPP::DSAConvertSignatureFormat(
      p1363.data(), p1363.size(), CryptoPP::DSA_P1363,
      sig, sig_len, CryptoPP::DSA_DER);
  if (produced == 0) return false;
  return verifier.VerifyMessage(msg, msg_len, p1363.data(), p1363.size());
}

}  // namespace protection_key_server
