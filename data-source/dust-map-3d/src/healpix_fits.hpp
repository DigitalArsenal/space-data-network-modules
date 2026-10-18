#pragma once
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// HEALPix NESTED pixel centres and FITS header cards: the two formats of the
// published Edenhofer et al. (2024) HEALPix-times-distance map.
namespace dustmap {

// HEALPix pixel centre, NESTED ordering (Gorski et al. 2005, ApJ 622, 759;
// the healpix_base nest2xyf and pix2loc of the reference C++ library).
inline uint32_t compressBits(uint64_t v) {
  uint64_t raw = v & 0x5555555555555555ull;
  raw |= raw >> 1;  raw &= 0x3333333333333333ull;
  raw |= raw >> 2;  raw &= 0x0f0f0f0f0f0f0f0full;
  raw |= raw >> 4;  raw &= 0x00ff00ff00ff00ffull;
  raw |= raw >> 8;  raw &= 0x0000ffff0000ffffull;
  raw |= raw >> 16; raw &= 0x00000000ffffffffull;
  return uint32_t(raw);
}

// Unit vector of NESTED pixel `pix` at `nside` (a power of two): x toward
// theta=90, phi=0 (Galactic l=0, b=0), y toward phi=90, z toward theta=0.
inline void nestToVector(uint32_t nside, uint64_t pix, double out[3]) {
  static const int jrll[12] = {2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4};
  static const int jpll[12] = {1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7};
  int order = 0;
  while ((1u << order) < nside) ++order;
  const uint64_t npface = uint64_t(nside) * nside;
  const int face = int(pix >> (2 * order));
  const uint64_t local = pix & (npface - 1);
  const int64_t ix = compressBits(local), iy = compressBits(local >> 1);
  const int64_t ns = nside, nl4 = 4 * ns;
  const int64_t jr = int64_t(jrll[face]) * ns - ix - iy - 1;
  const double fact2 = 1.0 / (3.0 * double(ns) * double(ns)), fact1 = 2.0 * double(ns) * fact2;
  int64_t nr, kshift;
  double z;
  if (jr < ns) { nr = jr; z = 1 - double(nr * nr) * fact2; kshift = 0; }
  else if (jr > 3 * ns) { nr = nl4 - jr; z = double(nr * nr) * fact2 - 1; kshift = 0; }
  else { nr = ns; z = double(2 * ns - jr) * fact1; kshift = (jr - ns) & 1; }
  int64_t jp = (int64_t(jpll[face]) * nr + ix - iy + 1 + kshift) / 2;
  if (jp > nl4) jp -= nl4;
  if (jp < 1) jp += nl4;
  const double phi = (double(jp) - double(kshift + 1) * 0.5) * (1.5707963267948966 / double(nr));
  const double sth = std::sqrt(std::max(0.0, (1 - z) * (1 + z)));
  out[0] = sth * std::cos(phi);
  out[1] = sth * std::sin(phi);
  out[2] = z;
}

// One FITS header unit: 2880-byte blocks of 80-character cards to END.
struct FitsHeader {
  std::map<std::string, std::string> cards;
  size_t headerBytes = 0;  // whole blocks
  bool parse(const uint8_t* p, size_t n) {
    for (size_t i = 0; i + 80 <= n; i += 80) {
      const std::string card(reinterpret_cast<const char*>(p + i), 80);
      const std::string key = trim(card.substr(0, 8));
      if (key == "END") { headerBytes = (i / 2880 + 1) * 2880; return true; }
      if (card.size() > 10 && card[8] == '=' && card[9] == ' ') {
        std::string value = card.substr(10);
        if (!value.empty() && trim(value)[0] == '\'') {
          const size_t open = value.find('\''), close = value.find('\'', open + 1);
          value = close == std::string::npos ? value.substr(open + 1) : value.substr(open + 1, close - open - 1);
        } else {
          const size_t slash = value.find('/');
          if (slash != std::string::npos) value = value.substr(0, slash);
        }
        cards[key] = trim(value);
      }
    }
    return false;
  }
  std::string text(const char* key) const { const auto it = cards.find(key); return it == cards.end() ? "" : it->second; }
  long long integer(const char* key) const {
    const std::string v = text(key);
    if (v.empty()) return -1;
    char* end = nullptr;
    const long long n = std::strtoll(v.c_str(), &end, 10);
    return end && *end == 0 ? n : -1;
  }
  // Data bytes padded to whole blocks: |BITPIX|/8 x prod(NAXISn) + PCOUNT.
  size_t dataBytes() const {
    const long long bitpix = integer("BITPIX"), naxis = integer("NAXIS");
    if (bitpix == -1 || naxis < 0) return size_t(-1);
    size_t n = naxis == 0 ? 0 : size_t(std::llabs(bitpix) / 8);
    for (long long a = 1; a <= naxis; ++a) {
      const long long axis = integer(("NAXIS" + std::to_string(a)).c_str());
      if (axis < 0) return size_t(-1);
      n *= size_t(axis);
    }
    const long long pcount = integer("PCOUNT");
    if (pcount > 0) n += size_t(pcount);
    return (n + 2879) / 2880 * 2880;
  }
  static std::string trim(const std::string& s) {
    const size_t a = s.find_first_not_of(' '), b = s.find_last_not_of(' ');
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
  }
};

inline float bigEndianFloat(const uint8_t* p) {
  const uint32_t bits = uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3];
  float f;
  std::memcpy(&f, &bits, 4);
  return f;
}

}  // namespace dustmap
