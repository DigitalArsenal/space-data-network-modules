// Full-force HPOP fit of an operator ephemeris: estimation's batch_fit
// (fit_batch v2, in-process) with propagator/hpop's PRW execution answering
// each round (state, STM and parameter sensitivities, in-process). Plain
// types only: the PRW and estimation headers stay inside hpop_fit.cpp.
//
// Units at this interface: GCRF metres and metres per second, SI parameters.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "time_frames.hpp"

namespace odhpop {

struct Point {
  UtcEpoch t;
  std::array<double, 3> r{};  // m, GCRF
  std::array<double, 3> v{};  // m/s, GCRF
  bool has_velocity = true;
};

// HPOP's environment inputs, each a complete size-prefixed $PRW record:
// EARTH_ORIENTATION, SPACE_WEATHER, JB2008_INDICES and the kernel's
// NATIVE_INPUT (NCD-described SPK). A null pointer means absent.
struct Environment {
  const uint8_t* earth_orientation = nullptr;
  std::size_t earth_orientation_size = 0;
  const uint8_t* space_weather = nullptr;
  std::size_t space_weather_size = 0;
  const uint8_t* jb2008_indices = nullptr;
  std::size_t jb2008_indices_size = 0;
  const uint8_t* kernel = nullptr;
  std::size_t kernel_size = 0;
};

enum class SrpModel : uint8_t { CANNONBALL = 0, GNSS_BOX_WING = 1 };
enum class Atmosphere : uint8_t { NRLMSISE00 = 0, JB2008 = 1 };
enum class GnssBlock : uint8_t { NONE = 0, GPS_IIR = 1, GPS_IIR_M = 2, GPS_IIF = 3 };

// The force model. HPOP means full force: the defaults are every force
// propagator/hpop carries. Cannonball drag and radiation pressure use
// area 1 m^2 and mass 1 kg, so Cd and Cr are Cd*A/m and Cr*A/m (the B and
// AGOM parameters). Box-wing uses the real mass.
struct ForceModel {
  int degree = 70;
  int order = 70;
  bool sun = true, moon = true, venus = true, mars = true, jupiter = true;
  bool srp = true;
  SrpModel srp_model = SrpModel::CANNONBALL;
  GnssBlock gnss_block = GnssBlock::NONE;
  double box_wing_mass_kg = 0.0;
  bool ecom2 = false;  // ECOM2 added to the a priori radiation model
  bool drag = true;
  Atmosphere atmosphere = Atmosphere::NRLMSISE00;
  bool solid_tides = true;
  int ocean_tide_degree = 30;  // 0: off (agreed with E4-A5: FES2004 30x30)
  bool relativity = true;
  bool earth_radiation = true;
  double earth_radiation_resolution_deg = 15.0;
  double gm = 3.986004415e14;  // EGM2008, TT-compatible
};

enum class Param : uint8_t {
  B = 0,         // Cd*A/m, m^2/kg
  BDOT = 1,      // its rate, m^2/kg/s
  AGOM = 2,      // Cr*A/m, m^2/kg
  IN_TRACK = 3,  // constant RTN T acceleration, m/s^2
  ECOM2_D0 = 4, ECOM2_Y0, ECOM2_B0, ECOM2_D2C, ECOM2_D2S, ECOM2_D4C, ECOM2_D4S,
  ECOM2_B1C, ECOM2_B1S, ECOM2_B3C, ECOM2_B3S,  // m/s^2
};
const char* param_name(Param p);

struct ParamValue {
  Param id = Param::B;
  double value = 0.0;
  double lower = std::numeric_limits<double>::quiet_NaN();
  double upper = std::numeric_limits<double>::quiet_NaN();
};

struct Integration {
  double relative_tolerance = 1e-13;
  double absolute_tolerance_m = 1e-7;
  double initial_step_s = 30.0;
  double minimum_step_s = 1e-3;
  // 0: resolve the gravity field's shortest wavelength at perigee,
  // 2 pi (r_p / v_p) / (3 degree), capped at 300 s (auto_maximum_step). A
  // longer step aliases the degree-70 field (79 s per wave in LEO): RK78's
  // embedded error estimate cannot see it, and 300 s steps then drift 4 cm
  // in 12 h while 30 s steps hold 0.4 mm (measured 2026-10-10).
  double maximum_step_s = 0.0;
  uint32_t maximum_steps = 20000000;
};

struct Solution {
  UtcEpoch epoch;
  std::array<double, 6> state{};  // m, m/s, GCRF
  std::vector<ParamValue> params;
  ForceModel forces;
};

struct FitOptions {
  int maximum_iterations = 25;
  // sqrt(dx' N dx / n) on whitened residuals (estimation's criterion).
  double correction_tolerance = 1e-4;  // 0.1 mm on 1 m sigmas
  bool levenberg_marquardt = true;
  std::size_t maximum_fit_points = 720;
  double sigma_m = 1.0;
};

struct FitResult {
  bool ok = false;
  std::string error;
  Solution solution;
  std::vector<double> covariance;         // (6+p)^2, SI, formal
  std::vector<double> scaled_covariance;  // times the reduced chi-square
  std::vector<double> covariance_rtn;     // the state block in RTN, then parameters
  std::vector<uint8_t> bound_status;      // per parameter: 0 free, 1 lower, 2 upper
  int iterations = 0;
  bool converged = false;
  double weighted_rms = 0.0;
  double chi_square = 0.0;
  double reduced_chi_square = 0.0;
  std::size_t fit_points = 0;
  std::size_t propagations = 0;
};

// Fits `initial` (its epoch, seed state and parameters) to the positions.
FitResult fit(const std::vector<Point>& points, const Solution& initial, const Environment& env,
              const Integration& integration, const FitOptions& options);

// States (m, m/s, GCRF) of `solution` at each epoch (any order, any side).
bool predict(const Solution& solution, const Environment& env, const Integration& integration,
             const std::vector<UtcEpoch>& epochs, std::vector<std::array<double, 6>>* states,
             std::string* error);

double auto_maximum_step(const std::array<double, 6>& state_gcrf_m, int degree);

// The parameter set the agreed algorithm estimates:
// Drag regime (perigee below 2500 km, where propagator/hpop applies drag): B and AGOM (lower bound 0) and a signed
// in-track acceleration; above: AGOM (lower bound 0) and ECOM2 D0, Y0, B0,
// all eleven when the span is a day or more.
// Sets forces->ecom2 to match.
std::vector<ParamValue> default_parameters(const std::array<double, 6>& state_gcrf_m, double span_s,
                                           ForceModel* forces);

}  // namespace odhpop
