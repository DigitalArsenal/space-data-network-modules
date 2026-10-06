#pragma once
#include "conjunction/ephemeris_source.h"
#include <array>
#include <vector>

namespace conjunction {
struct EarthOrientation {
  double jd = 0, dut1 = 0, xp = 0, yp = 0, dx = 0, dy = 0, lod = 0;
};
// Row values: UTC JD, seconds (dut1/lod), radians (polar motion/CIP).
// 6x6 Jacobian includes the velocity/position coupling from Earth rotation.
bool earth_orientation_at(const std::vector<EarthOrientation>&, double, EarthOrientation&);
bool itrf_to_inertial(double jd, const EarthOrientation&, bool eme2000, double jacobian[6][6]);
void transform_ephemeris_point(EphemerisPoint&, const double jacobian[6][6]);
void transform_ephemeris_covariance(std::array<double, 21>&, const double jacobian[6][6]);
}
