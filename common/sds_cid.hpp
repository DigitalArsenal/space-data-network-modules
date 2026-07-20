// Shared CIDv1(raw, sha2-256) helper — the content id both the OD node and the
// FlatSQL store derive over an SDS record's bytes, so the store's provenance
// sidecar (keyed by cid) and its stored row (keyed by cid) agree byte-for-byte.
// Byte-identical to common/provider_source.hpp::cid_v1_raw_sha256; factored here
// (no keyslot dependency) so the OD-flow guest-links share ONE definition.
#ifndef SDN_SDS_CID_HPP
#define SDN_SDS_CID_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace sdn_cid {

inline void sha256_raw(const uint8_t* data, size_t len, uint8_t out[32]) {
  static const uint32_t K[64] = {
      0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
      0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
      0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
      0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
      0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
      0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
      0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
      0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
  uint32_t h[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
  std::vector<uint8_t> msg(data, data + len);
  uint64_t bl = static_cast<uint64_t>(len) * 8u;
  msg.push_back(0x80);
  while (msg.size() % 64 != 56) msg.push_back(0);
  for (int i = 7; i >= 0; --i) msg.push_back(static_cast<uint8_t>((bl >> (i * 8)) & 0xff));
  auto rotr = [](uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); };
  for (size_t off = 0; off < msg.size(); off += 64) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i)
      w[i] = (uint32_t(msg[off+i*4])<<24)|(uint32_t(msg[off+i*4+1])<<16)|(uint32_t(msg[off+i*4+2])<<8)|uint32_t(msg[off+i*4+3]);
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>3);
      uint32_t s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>10);
      w[i] = w[i-16]+s0+w[i-7]+s1;
    }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
      uint32_t t1=hh+S1+ch+K[i]+w[i];
      uint32_t S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c);
      uint32_t t2=S0+maj;
      hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
    }
    h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
  }
  for (int i = 0; i < 8; ++i) {
    out[i*4]=uint8_t((h[i]>>24)&0xff); out[i*4+1]=uint8_t((h[i]>>16)&0xff);
    out[i*4+2]=uint8_t((h[i]>>8)&0xff); out[i*4+3]=uint8_t(h[i]&0xff);
  }
}

inline std::string base32_lower_nopad(const uint8_t* data, size_t len) {
  static const char* alpha = "abcdefghijklmnopqrstuvwxyz234567";
  std::string out;
  int buffer = 0, bits = 0;
  for (size_t i = 0; i < len; ++i) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push_back(alpha[(buffer >> bits) & 0x1f]); }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out.push_back(alpha[(buffer << (5 - bits)) & 0x1f]);
  return out;
}

// CIDv1(raw, sha2-256), multibase-'b' base32 — the exact string the host stores.
inline std::string cid_v1_raw_sha256(const uint8_t* data, size_t len) {
  uint8_t digest[32];
  sha256_raw(data, len, digest);
  uint8_t frame[36] = {0x01, 0x55, 0x12, 0x20};
  for (int i = 0; i < 32; ++i) frame[4 + i] = digest[i];
  return std::string("b") + base32_lower_nopad(frame, sizeof(frame));
}

}  // namespace sdn_cid

#endif  // SDN_SDS_CID_HPP
