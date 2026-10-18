// G-band extinction to a star, from analysis/milky-way-model's analytic dust:
// the optical depth per kpc its literature() field returns (kappa: the
// Drimmel & Spergel 2001 disk, arms and local segment, through dust_map's
// blend, which is DS2001 alone because no dust-map rows are loaded here), and
// its extinction_to() quadrature (midpoint steps of at most 0.02 kpc from the
// Sun, A_G = 2.5 / ln 10 * tau, E(BP - RP) = (A_BP/A_G - A_RP/A_G) A_G).
//
// Ten million stars would take ten million ray marches; the march is instead
// done once per direction, along the center of each HEALPix order-6 pixel
// (0.92 deg), and tau is kept at 160 distances, logarithmic from 1 pc to the
// farthest star. A star takes its pixel's tau at its distance, linear
// between the two nearest kept distances. The dust field varies on scales of
// 0.1 kpc and more, so at the distances where extinction matters (beyond
// ~100 pc) one pixel is a few pc across or less.
#pragma once
#include <cmath>
#include <vector>

namespace gaia_octree::extinction {

constexpr int kOrder = 6;
constexpr int kNodes = 160;

struct Table {
  double farPc = 0;
  std::vector<float> tau;  // [pixel * kNodes + node], G optical depth from the Sun
  double nodePc(int i) const { return std::exp(std::log(1.0) + (std::log(farPc) - std::log(1.0)) * i / (kNodes - 1)); }
};

// The heliocentric ICRS unit vector u at d kpc -> milky_way's Galactocentric kpc.
inline milky_way::Vec3 galactocentric(const double m[9], const double u[3], double kpc) {
  const double gx = m[0] * u[0] + m[1] * u[1] + m[2] * u[2], gy = m[3] * u[0] + m[4] * u[1] + m[5] * u[2],
               gz = m[6] * u[0] + m[7] * u[1] + m[8] * u[2];
  const milky_way::Vec3 sun{-milky_way::galactic_constants::solar_radius_kpc, 0, milky_way::galactic_constants::solar_height_kpc};
  return sun + milky_way::Vec3{gx, gy, gz} * kpc;
}

inline double kappa(milky_way::Vec3 p) { return milky_way::dust_map::blend(p, milky_way::drimmel2001::dust(p)); }

inline Table build(double farPc) {
  Table t;
  t.farPc = std::max(1000.0, farPc * 1.001);
  double m[9];
  sdn::frames::galactic::icrs_to_galactic(m);
  const uint64_t pixels = 12ull << (2 * kOrder);
  t.tau.assign(pixels * kNodes, 0.f);
  const double step = 0.02;  // kpc, extinction_to's maximum step
  for (uint64_t p = 0; p < pixels; ++p) {
    double u[3];
    healpix::pix2vec(kOrder, p, u);
    double tau = 0, at = 0;  // kpc reached
    for (int i = 0; i < kNodes; ++i) {
      const double to = t.nodePc(i) / 1000.0;
      const unsigned steps = unsigned(std::max(1.0, std::ceil((to - at) / step)));
      const double ds = (to - at) / steps;
      for (unsigned k = 0; k < steps; ++k) tau += std::max(0.0, kappa(galactocentric(m, u, at + ds * (k + 0.5)))) * ds;
      at = to;
      t.tau[p * kNodes + i] = float(tau);
    }
  }
  return t;
}

struct Reddening { double aG = NAN, eBpRp = NAN; };

inline Reddening at(const Table& t, const double u[3], double distancePc) {
  if (!(distancePc > 0) || t.tau.empty()) return {};
  const uint64_t p = healpix::vec2pix(kOrder, u[0], u[1], u[2]);
  const double x = std::log(std::max(1.0, std::min(distancePc, t.farPc))) / std::log(t.farPc) * (kNodes - 1);
  const int i = std::min(kNodes - 2, int(x));
  const double f = x - i;
  const double tau = t.tau[p * kNodes + i] * (1 - f) + t.tau[p * kNodes + i + 1] * f;
  const double aG = (2.5 / std::log(10.0)) * tau;
  return {aG, (milky_way::model_choices::bp_to_g_extinction - milky_way::model_choices::rp_to_g_extinction) * aG};
}

}  // namespace gaia_octree::extinction
