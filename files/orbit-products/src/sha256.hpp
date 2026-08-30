/*
 * files/orbit-products — SHA-256, for proving a descriptor belongs to a file.
 *
 * `$NCD.SOURCE_SHA256` is the field that makes the native-container descriptor
 * CHECKABLE rather than merely asserted: a consumer holding a descriptor and a
 * buffer can prove they are the same file. Both ends of that check live in this
 * package's family — the open reader verifies an incoming pairing, the signed
 * closed exporter stamps an outgoing one — so the digest is ONE implementation
 * included by whoever needs it, the same rule the container readers follow. Two
 * copies of a hash is two ways to disagree about whether a file matched.
 *
 * FIPS 180-4, written out rather than pulled in: these modules link no runtime
 * beyond the SDK's invoke glue, and the one thing they need a hash for is this.
 */

#ifndef ORBIT_PRODUCTS_SHA256_HPP
#define ORBIT_PRODUCTS_SHA256_HPP

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace ephem {

class Sha256 {
  public:
    Sha256() { reset(); }

    void reset() {
        length_ = 0;
        buffered_ = 0;
        static const uint32_t kInit[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                                          0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
        std::memcpy(h_, kInit, sizeof(h_));
    }

    void update(const uint8_t* data, size_t len) {
        length_ += static_cast<uint64_t>(len);
        while (len > 0) {
            const size_t take = (64 - buffered_) < len ? (64 - buffered_) : len;
            std::memcpy(block_ + buffered_, data, take);
            buffered_ += take;
            data += take;
            len -= take;
            if (buffered_ == 64) {
                compress(block_);
                buffered_ = 0;
            }
        }
    }

    /* Padding runs on a COPY, so this does not consume the accumulator: a
     * caller that digests and then keeps feeding gets the arithmetic it asked
     * for rather than a silently poisoned state. */
    std::string hex() const {
        Sha256 copy(*this);
        const uint64_t bits = copy.length_ * 8u;
        copy.block_[copy.buffered_++] = 0x80u;
        if (copy.buffered_ > 56) {
            std::memset(copy.block_ + copy.buffered_, 0, 64 - copy.buffered_);
            copy.compress(copy.block_);
            copy.buffered_ = 0;
        }
        std::memset(copy.block_ + copy.buffered_, 0, 56 - copy.buffered_);
        for (int i = 0; i < 8; ++i) {
            copy.block_[56 + i] = static_cast<uint8_t>((bits >> (56 - 8 * i)) & 0xFFu);
        }
        copy.compress(copy.block_);

        char out[72];
        for (int i = 0; i < 8; ++i) {
            std::snprintf(out + i * 8, 9, "%08x", copy.h_[i]);
        }
        return std::string(out, 64);
    }

  private:
    static uint32_t rotr(uint32_t v, int n) { return (v >> n) | (v << (32 - n)); }

    void compress(const uint8_t* block) {
        static const uint32_t k[64] = {
            0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
            0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
            0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
            0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
            0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
            0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
            0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
            0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
            0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
            0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
            0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
                   (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
                   static_cast<uint32_t>(block[i * 4 + 3]);
        }
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3];
        uint32_t e = h_[4], f = h_[5], g = h_[6], hh = h_[7];
        for (int i = 0; i < 64; ++i) {
            const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + s1 + ch + k[i] + w[i];
            const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = s0 + maj;
            hh = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }
        h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d;
        h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += hh;
    }

    uint32_t h_[8];
    uint8_t block_[64];
    size_t buffered_;
    uint64_t length_;
};

inline std::string sha256_hex(const uint8_t* data, size_t len) {
    Sha256 s;
    s.update(data, len);
    return s.hex();
}

}  // namespace ephem

#endif  // ORBIT_PRODUCTS_SHA256_HPP
