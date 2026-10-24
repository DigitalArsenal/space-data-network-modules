#pragma once

// Relative-navigation extended Kalman filters on the full relative state
// (extension v5). The state is the deputy about the chief on the chief's CCSDS
// RTN axes, [R, T, N, Rdot, Tdot, Ndot] in metres and metres per second, the
// rates being those of the rotating frame. The four models are the filter's
// own linear dynamics and never a truth model:
//
//  - HILL_CLOHESSY_WILTSHIRE: Clohessy and Wiltshire 1960, circular chief.
//  - SCHWEIGHART_SEDWICK_J2: Schweighart and Sedwick 2002, J2-modified
//    circular chief (J. Guid. Control Dyn. 25(6):1073).
//  - TSCHAUNER_HEMPEL: Tschauner and Hempel 1965, eccentric Keplerian chief;
//    the linear equations are integrated in true anomaly.
//  - YAMANAKA_ANKERSEN: Yamanaka and Ankersen 2002 (J. Guid. Control Dyn.
//    25(1):60), the closed-form state transition matrix of the same equations.
//
// Every observation is the full relative state with its covariance and the
// chief's osculating reference at its epoch. Innovation recovery (recovery.hpp)
// is opt-in; with it off the numerics are the plain EKF's.

#include "estimation.hpp"
#include "recovery.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace sdn::estimation {

enum class RelativeModel : std::uint8_t {
  HILL_CLOHESSY_WILTSHIRE = 0,
  SCHWEIGHART_SEDWICK_J2 = 1,
  TSCHAUNER_HEMPEL = 2,
  YAMANAKA_ANKERSEN = 3
};

// Osculating Keplerian chief at an epoch.
struct ChiefReference {
  double semi_major_axis_m{0.0};
  double eccentricity{0.0};
  double inclination_rad{0.0};
  double true_anomaly_rad{0.0};
};

struct RelativeConstants {
  double gravitational_parameter_m3_s2{0.0};
  double j2{0.0};
  double equatorial_radius_m{0.0};
};

struct RelativeObservation {
  double epoch_seconds{0.0};
  Vector6 state{};
  Matrix6 covariance{};
  ChiefReference chief{};
};

struct RelativeConfig {
  RelativeModel model{RelativeModel::HILL_CLOHESSY_WILTSHIRE};
  RelativeConstants constants{};
  double epoch_seconds{0.0};
  Vector6 state{};
  Matrix6 covariance{};
  ChiefReference chief{};
  bool white_acceleration{false};
  std::array<double, 3> acceleration_psd{{0.0, 0.0, 0.0}};
  RecoveryConfig recovery{};
};

struct RelativeEpoch {
  double epoch_seconds{0.0};
  Vector6 predicted_state{};
  Matrix6 predicted_covariance{};
  Vector6 filtered_state{};
  Matrix6 filtered_covariance{};
  Vector6 innovation{};
  double normalized_innovation_squared{0.0};
  bool has_recovery{false};
  RecoveryDecision recovery{};
};

struct RelativeResult {
  bool valid{false};
  std::string error;
  std::vector<RelativeEpoch> epochs;
};

// State transition matrix of the model over `elapsed_seconds`, from the chief
// reference at the start of the interval to the one at its end.
bool relative_transition(RelativeModel model, const RelativeConstants& constants,
                         const ChiefReference& from, const ChiefReference& to,
                         double elapsed_seconds, Matrix6* transition, std::string* error);

RelativeResult relative_filter(const RelativeConfig& config,
                               const std::vector<RelativeObservation>& observations);

// RTN relative state of a deputy about a chief, both inertial [r, v] in SI,
// with the chief's osculating reference about mu.
bool inertial_to_rtn(double mu, const Vector6& chief, const Vector6& deputy,
                     Vector6* relative, ChiefReference* reference);

}  // namespace sdn::estimation
