// Native reference and numerical reduction for the rename E2E's targeting
// regression. This is a helper, not an independently registered test.
//
// Authority: unmodified ERFA C (BSD-3, derived from IAU SOFA), specifically
// utctai.c, taitt.c, pnm80.c, gst94.c, gmst82.c, rz.c and trxp.c. The input
// vectors below are explicit synthetic states, not outputs of this module.
// Units: ECEF position in meters, velocity in meters/second; epoch is UTC JD.
// Reference frame: the documented classical FK5 GCRF alias, without frame
// bias, UT1=UTC and zero polar motion. UTC->TAI->TT controls IAU 1976/1980
// precession/nutation; UT1 controls GAST. Velocity retains Earth rotation
// using the analytic GMST82 derivative, as the public coordinate contract
// specifies. Precession/nutation/equinox velocity rates are not included.
//
// Position tolerance: 1e-6 meter, permitting native/WASM floating-point
// roundoff and the provider's SI->kilometer->SI conversion at GEO distance.
// Velocity tolerance: 1e-8 meter/second for the same arithmetic differences.
// The real finish consumer is also checked: radius within 1e-6 meter and
// inclination within 1e-12 radian (acos conditioning near the equator).
// Neither reference calculation calls coords.cpp or targeting module code.

#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <string>

extern "C" {
#include "erfa.h"
#include "erfam.h"
}

namespace {
struct Fixture {
  const char* id;
  std::array<double, 7> state;
};

constexpr std::array<Fixture, 3> fixtures{{
    {"GEO-2026", {42164000.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2461283.0}},
    {"LEO-2006", {6524000.0, 1234000.0, -2345000.0, -345.0, 6543.0,
                   1234.0, 2453751.392100694}},
    {"OBLIQUE-J2000", {-21000000.0, 18000000.0, 30000000.0, -2400.0,
                        1800.0, 700.0, 2451545.0}},
}};
constexpr double position_limit_m = 1e-6;
constexpr double velocity_limit_m_s = 1e-8;
constexpr double inclination_limit_rad = 1e-12;

bool reference(const Fixture& fixture, std::array<double, 6>& output) {
  // MJD split is independent of the production midnight split. Both retain
  // the exact input UTC double, then let ERFA perform the time conversion.
  const double ut11 = ERFA_DJM0;
  const double ut12 = fixture.state[6] - ut11;
  double tai1, tai2, tt1, tt2;
  if (eraUtctai(ut11, ut12, &tai1, &tai2) < 0 ||
      eraTaitt(tai1, tai2, &tt1, &tt2) != 0) return false;
  double celestial_to_terrestrial[3][3];
  eraPnm80(tt1, tt2, celestial_to_terrestrial);
  eraRz(eraGst94(ut11, ut12), celestial_to_terrestrial);

  double position[3]{fixture.state[0], fixture.state[1], fixture.state[2]};
  double transformed_position[3];
  eraTrxp(celestial_to_terrestrial, position, transformed_position);

  // Derivative of the IAU 1982 GMST polynomial in ERFA gmst82.c.
  const double centuries = ((ut11 - ERFA_DJ00) + ut12) / ERFA_DJC;
  const double sidereal_derivative =
      8640184.812866 + 2.0 * 0.093104 * centuries -
      3.0 * 6.2e-6 * centuries * centuries;
  const double rotation_rate =
      ERFA_D2PI / ERFA_DAYSEC *
      (1.0 + sidereal_derivative / (ERFA_DJC * ERFA_DAYSEC));
  double inertial_velocity_in_ecef[3]{
      fixture.state[3] - rotation_rate * fixture.state[1],
      fixture.state[4] + rotation_rate * fixture.state[0], fixture.state[5]};
  double transformed_velocity[3];
  eraTrxp(celestial_to_terrestrial, inertial_velocity_in_ecef,
          transformed_velocity);
  for (int axis = 0; axis < 3; ++axis) {
    output[axis] = transformed_position[axis];
    output[axis + 3] = transformed_velocity[axis];
  }
  return true;
}

double norm(double x, double y, double z) {
  return std::sqrt(x * x + y * y + z * z);
}
}  // namespace

int main(int argc, char** argv) {
  std::cout << std::setprecision(17);
  if (argc == 2 && std::string(argv[1]) == "--fixtures") {
    std::cout << "[";
    for (std::size_t index = 0; index < fixtures.size(); ++index) {
      if (index) std::cout << ",";
      const auto& fixture = fixtures[index];
      std::cout << "{\"id\":\"" << fixture.id << "\",\"state\":[";
      for (std::size_t column = 0; column < fixture.state.size(); ++column) {
        if (column) std::cout << ",";
        std::cout << fixture.state[column];
      }
      std::cout << "]}";
    }
    std::cout << "]\n";
    return 0;
  }
  if (argc != 2 || std::string(argv[1]) != "--compare") {
    std::cerr << "Expected --fixtures or --compare.\n";
    return 2;
  }

  double maximum_position_error = 0.0, maximum_velocity_error = 0.0;
  double maximum_radius_error = 0.0, maximum_inclination_error = 0.0;
  bool pass = true;
  std::cout << "{\"cases\":[";
  for (std::size_t index = 0; index < fixtures.size(); ++index) {
    std::array<double, 6> measured{}, expected{};
    std::array<double, 11> finished{};
    for (double& value : measured) {
      if (!(std::cin >> value) || !std::isfinite(value)) return 2;
    }
    for (double& value : finished) {
      if (!(std::cin >> value) || !std::isfinite(value)) return 2;
    }
    if (!reference(fixtures[index], expected)) return 2;
    const double position_error = norm(measured[0] - expected[0],
                                       measured[1] - expected[1],
                                       measured[2] - expected[2]);
    const double velocity_error = norm(measured[3] - expected[3],
                                       measured[4] - expected[4],
                                       measured[5] - expected[5]);
    const double radius = norm(expected[0], expected[1], expected[2]);
    const double hx = expected[1] * expected[5] - expected[2] * expected[4];
    const double hy = expected[2] * expected[3] - expected[0] * expected[5];
    const double hz = expected[0] * expected[4] - expected[1] * expected[3];
    const double inclination = std::acos(
        std::clamp(hz / norm(hx, hy, hz), -1.0, 1.0));
    const double radius_error = std::fabs(finished[2] - radius);
    const double inclination_error = std::fabs(finished[1] - inclination);
    maximum_position_error = std::max(maximum_position_error, position_error);
    maximum_velocity_error = std::max(maximum_velocity_error, velocity_error);
    maximum_radius_error = std::max(maximum_radius_error, radius_error);
    maximum_inclination_error =
        std::max(maximum_inclination_error, inclination_error);
    pass = pass && position_error <= position_limit_m &&
           velocity_error <= velocity_limit_m_s &&
           radius_error <= position_limit_m &&
           inclination_error <= inclination_limit_rad;
    if (index) std::cout << ",";
    std::cout << "{\"id\":\"" << fixtures[index].id
              << "\",\"utcJd\":" << fixtures[index].state[6]
              << ",\"positionErrorM\":" << position_error
              << ",\"velocityErrorMPerS\":" << velocity_error << "}";
  }
  std::cout << "],\"pass\":" << (pass ? "true" : "false")
            << ",\"caseCount\":" << fixtures.size()
            << ",\"positionErrorM\":" << maximum_position_error
            << ",\"positionLimitM\":" << position_limit_m
            << ",\"velocityErrorMPerS\":" << maximum_velocity_error
            << ",\"velocityLimitMPerS\":" << velocity_limit_m_s
            << ",\"finishRadiusErrorM\":" << maximum_radius_error
            << ",\"finishInclinationErrorRad\":" << maximum_inclination_error
            << ",\"finishInclinationLimitRad\":" << inclination_limit_rad
            << "}\n";
  return 0;
}
