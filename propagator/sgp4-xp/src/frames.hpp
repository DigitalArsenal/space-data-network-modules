// propagator/sgp4-xp: the axes. The library works in TEME; ephemerides come in inertial and Earth-fixed axes.
//
// One chain, as propagator/sgp4 and analysis/epoch-state have it: foundation/frames' axis engine over the vendored
// ERFA (IAU 2006/2000A precession-nutation, the equation of the equinoxes for TEME). GCRF, ICRF and J2000A are
// the same axes; J2000 and EME2000 are the mean equator and equinox of J2000, which differ from GCRF by the frame
// bias (23 mas, 0.8 m at low Earth orbit), as analysis/gp-error-model takes them.
// Earth-fixed axes (ITRF, WGS84, ECEF) rotate by the CIO-based IAU 2006/2000A chain with the Earth orientation
// supplied; without it UT1 = UTC and the pole is at its mean position, which turns the whole orbit about the Earth's
// axis by a constant angle and so cannot be told from a different node by a fit.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "engine.hpp"

namespace sgp4xp {

namespace fr = sdn::frames;

// Earth orientation by MJD, linearly interpolated, held at the ends.
struct EopRow {
  double mjd = 0, dut1 = 0, xPole = 0, yPole = 0, dX = 0, dY = 0, lod = 0;
};
class EopTable {
 public:
  void add(const EopRow& row) { rows_.push_back(row); }
  void finish() {
    std::sort(rows_.begin(), rows_.end(), [](const EopRow& a, const EopRow& b) { return a.mjd < b.mjd; });
  }
  bool empty() const { return rows_.empty(); }
  fr::EarthOrientation at(const Instant& t) const {
    fr::EarthOrientation eop;
    if (rows_.empty()) return eop;
    const double mjd = static_cast<double>(t.day) + t.seconds / kSecondsPerDay;
    size_t hi = 0;
    while (hi < rows_.size() && rows_[hi].mjd < mjd) ++hi;
    if (hi == 0 || hi == rows_.size()) {
      const EopRow& r = rows_[hi == 0 ? 0 : rows_.size() - 1];
      eop.dut1 = r.dut1; eop.xPole = r.xPole; eop.yPole = r.yPole; eop.dX = r.dX; eop.dY = r.dY; eop.lengthOfDay = r.lod;
      return eop;
    }
    const EopRow& a = rows_[hi - 1];
    const EopRow& b = rows_[hi];
    const double w = (b.mjd > a.mjd) ? (mjd - a.mjd) / (b.mjd - a.mjd) : 0.0;
    auto lerp = [&](double x, double y) { return x + (y - x) * w; };
    eop.dut1 = lerp(a.dut1, b.dut1);
    eop.xPole = lerp(a.xPole, b.xPole);
    eop.yPole = lerp(a.yPole, b.yPole);
    eop.dX = lerp(a.dX, b.dX);
    eop.dY = lerp(a.dY, b.dY);
    eop.lengthOfDay = lerp(a.lod, b.lod);
    return eop;
  }

 private:
  std::vector<EopRow> rows_;
};

inline bool frameEpoch(const Instant& t, const fr::EarthOrientation& eop, fr::Epoch* out) {
  int64_t y, m, d;
  civilFromDays(t.day - kMjdOfUnixEpoch, &y, &m, &d);
  double s = t.seconds;
  const int hh = static_cast<int>(s / 3600.0);
  s -= hh * 3600.0;
  const int mi = static_cast<int>(s / 60.0);
  s -= mi * 60.0;
  return fr::epochFromUtc(static_cast<int>(y), static_cast<int>(m), static_cast<int>(d), hh, mi, s, eop, out);
}

inline bool finite3(const fr::Vec3& v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

// A position (km) in `frame` at UTC instant t, in TEME. false when ERFA refuses the date.
inline bool positionToTeme(Frame frame, const Instant& t, const EopTable& eop, const double r[3], double out[3]) {
  if (frame == Frame::Teme) {
    out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
    return true;
  }
  const fr::EarthOrientation orientation = eop.at(t);
  fr::Epoch epoch;
  if (!frameEpoch(t, orientation, &epoch)) return false;
  fr::Vec3 v{r[0], r[1], r[2]};
  if (frame == Frame::Itrf) v = fr::apply(fr::transpose(fr::gcrfToItrf(epoch, orientation)), v);
  if (frame == Frame::Eme2000) v = fr::apply(fr::transpose(fr::gcrfToMj2000Eq(epoch)), v);
  const fr::Vec3 teme = fr::apply(fr::gcrfToTeme(epoch), v);
  out[0] = teme.x; out[1] = teme.y; out[2] = teme.z;
  return finite3(teme);
}

// A TEME state (km, km/s) in GCRF (or in EME2000, the frame bias further): R = gcrfToTeme at TT, its rate by a +/-600 s
// central difference (the shortest nutation periods are days, so the difference is exact to double rounding),
// r_g = R' r_t, v_g = R' (v_t - Rdot r_g).
inline bool stateTemeToGcrf(const Instant& t, const double rTeme[3], const double vTeme[3], double rGcrf[3],
                            double vGcrf[3], bool eme2000 = false) {
  constexpr double kHalfStepSeconds = 600.0;
  fr::EarthOrientation none;
  fr::Epoch epoch;
  if (!frameEpoch(t, none, &epoch)) return false;
  const fr::Epoch before = fr::shiftEpoch(epoch, -kHalfStepSeconds);
  const fr::Epoch after = fr::shiftEpoch(epoch, kHalfStepSeconds);
  const fr::Mat3 R = fr::gcrfToTeme(epoch);
  const fr::Mat3 Rb = fr::gcrfToTeme(before);
  const fr::Mat3 Ra = fr::gcrfToTeme(after);
  fr::Mat3 Rdot;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) Rdot.m[i][j] = (Ra.m[i][j] - Rb.m[i][j]) * (1.0 / (2.0 * kHalfStepSeconds));
  const fr::Mat3 Rt = fr::transpose(R);
  const fr::Vec3 r = fr::apply(Rt, fr::Vec3{rTeme[0], rTeme[1], rTeme[2]});
  const fr::Vec3 v = fr::apply(Rt, fr::sub(fr::Vec3{vTeme[0], vTeme[1], vTeme[2]}, fr::apply(Rdot, r)));
  fr::Vec3 rr = r, vv = v;
  if (eme2000) {
    const fr::Mat3 bias = fr::gcrfToMj2000Eq(epoch);
    rr = fr::apply(bias, r);
    vv = fr::apply(bias, v);
  }
  rGcrf[0] = rr.x; rGcrf[1] = rr.y; rGcrf[2] = rr.z;
  vGcrf[0] = vv.x; vGcrf[1] = vv.y; vGcrf[2] = vv.z;
  return finite3(rr) && finite3(vv);
}

// Greenwich mean sidereal time (IAU 1982, UT1 = UTC) in radians, from a UTC Julian date: the rotation the propagator
// ABI's Earth-fixed output uses (the reference module's: docs/propagator-abi.md, section Frames).
inline double gmstRadians(double julianDate) {
  const double tut1 = (julianDate - 2451545.0) / 36525.0;
  const double seconds = 67310.54841 + (876600.0 * 3600.0 + 8640184.812866) * tut1 + 0.093104 * tut1 * tut1 -
                         6.2e-6 * tut1 * tut1 * tut1;
  double g = std::fmod(seconds * (2.0 * kPi / kSecondsPerDay), 2.0 * kPi);
  if (g < 0) g += 2.0 * kPi;
  return g;
}

}  // namespace sgp4xp
