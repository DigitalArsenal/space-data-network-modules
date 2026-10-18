// HEALPix in the NESTED scheme (Gorski et al. 2005, ApJ 622, 759): a unit
// vector to its pixel at an order, a pixel's center, and the largest angle
// from a pixel's center to any point inside it (for a conservative cone).
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace gaia_octree::healpix {

constexpr double kPi = 3.14159265358979323846;
constexpr int kJrll[12] = {2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4};
constexpr int kJpll[12] = {1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7};

inline uint64_t spread(uint64_t v) {  // the bits of v to the even bits
  uint64_t r = 0;
  for (int b = 0; b < 32; ++b) r |= ((v >> b) & 1u) << (2 * b);
  return r;
}
inline uint64_t compress(uint64_t v) {  // the even bits of v
  uint64_t r = 0;
  for (int b = 0; b < 32; ++b) r |= ((v >> (2 * b)) & 1u) << b;
  return r;
}

// Nested pixel of the unit vector (x, y, z) at `order` (NSIDE = 2^order).
inline uint64_t vec2pix(int order, double x, double y, double z) {
  const int64_t nside = int64_t(1) << order;
  const double za = std::fabs(z);
  double phi = std::atan2(y, x);
  if (phi < 0) phi += 2 * kPi;
  double tt = phi * (2 / kPi);
  if (tt >= 4) tt -= 4;
  int64_t face, ix, iy;
  if (za <= 2.0 / 3.0) {
    const double t1 = nside * (0.5 + tt), t2 = nside * (z * 0.75);
    const int64_t jp = int64_t(t1 - t2), jm = int64_t(t1 + t2);
    const int64_t ifp = jp >> order, ifm = jm >> order;
    face = ifp == ifm ? (ifp | 4) : (ifp < ifm ? ifp : ifm + 8);
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const int64_t ntt = std::min<int64_t>(3, int64_t(tt));
    const double tp = tt - ntt;
    // sqrt(3 (1 - |z|)), with 1 - |z| = s^2 / (1 + |z|) near the poles.
    const double s2 = x * x + y * y;
    const double tmp = nside * std::sqrt(3 * s2 / (1 + za));
    const int64_t jp = std::min<int64_t>(nside - 1, int64_t(tp * tmp));
    const int64_t jm = std::min<int64_t>(nside - 1, int64_t((1 - tp) * tmp));
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; }
    else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return uint64_t(face) * uint64_t(nside * nside) + (spread(uint64_t(ix)) | (spread(uint64_t(iy)) << 1));
}

inline uint64_t radec2pix(int order, double raDeg, double decDeg) {
  const double ra = raDeg * kPi / 180, dec = decDeg * kPi / 180;
  return vec2pix(order, std::cos(dec) * std::cos(ra), std::cos(dec) * std::sin(ra), std::sin(dec));
}

// The center of nested pixel `pix` at `order`, as a unit vector.
inline void pix2vec(int order, uint64_t pix, double out[3]) {
  const int64_t nside = int64_t(1) << order, npface = nside * nside;
  const int64_t face = int64_t(pix / uint64_t(npface)), within = int64_t(pix % uint64_t(npface));
  const int64_t ix = int64_t(compress(uint64_t(within))), iy = int64_t(compress(uint64_t(within) >> 1));
  const int64_t jr = kJrll[face] * nside - ix - iy - 1;
  int64_t nr, kshift;
  double z;
  if (jr < nside) { nr = jr; z = 1 - double(nr * nr) / (3.0 * double(npface)); kshift = 0; }
  else if (jr > 3 * nside) { nr = 4 * nside - jr; z = double(nr * nr) / (3.0 * double(npface)) - 1; kshift = 0; }
  else { nr = nside; z = double(2 * nside - jr) * 2 / (3.0 * double(nside)); kshift = (jr - nside) & 1; }
  int64_t jp = (kJpll[face] * nr + ix - iy + 1 + kshift) / 2;
  if (jp > 4 * nside) jp -= 4 * nside;
  if (jp < 1) jp += 4 * nside;
  const double phi = (double(jp) - (kshift + 1) * 0.5) * (kPi / 2) / double(nr);
  const double s = std::sqrt(std::max(0.0, (1 - z) * (1 + z)));
  out[0] = s * std::cos(phi); out[1] = s * std::sin(phi); out[2] = z;
}

inline double angle(const double a[3], const double b[3]) {
  const double cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  return std::atan2(std::sqrt(cx * cx + cy * cy + cz * cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

// For every pixel at `order`: the largest angle (rad) from its center to a
// point inside it, bounded above by the farthest center of its descendants
// `depth` orders down plus a descendant's own bound (the descendant's
// diagonal, 2.5x its mean side, is a generous cover at any depth >= 4).
inline std::vector<double> pixelRadii(int order, int depth = 5) {
  const uint64_t n = 12ull << (2 * order), sub = 1ull << (2 * depth);
  const double childSide = std::sqrt(4 * kPi / double(12ull << (2 * (order + depth))));
  std::vector<double> radii(n, 0);
  for (uint64_t p = 0; p < n; ++p) {
    double c[3], d[3], worst = 0;
    pix2vec(order, p, c);
    for (uint64_t k = 0; k < sub; ++k) {
      pix2vec(order + depth, p * sub + k, d);
      worst = std::max(worst, angle(c, d));
    }
    radii[p] = worst + 2.5 * childSide;
  }
  return radii;
}

}  // namespace gaia_octree::healpix
