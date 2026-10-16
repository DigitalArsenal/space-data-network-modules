#ifndef CONJUNCTION_ENGINE_H
#define CONJUNCTION_ENGINE_H

/**
 * Conjunction Assessment Engine (v2) — Propagator & Pc-method agnostic
 *
 * Decoupled architecture:
 *   EphemerisSource → provides states at any time
 *   PcMethod        → computes collision probability
 *   ConjunctionEngine → orchestrates TCA finding + Pc computation
 *
 * The engine never knows or cares what propagator produced the states
 * or what method computed the probability.
 */

#include "conjunction/ephemeris_source.h"
#include "conjunction/pc_method.h"
#include "conjunction/pc_fallbacks.h"
#include <array>
#include <memory>
#include <string>
#include <vector>

namespace conjunction {

// ── Covariance ──

/// 3×3 position covariance matrix (km²), row-major
struct Covariance3x3 {
  double data[9] = {0};

  /// Construct from an RTN diagonal covariance (σ_R, σ_T, σ_N in km).
  /// The engine rotates this into inertial coordinates at TCA before Pc math.
  static Covariance3x3 from_rtn_diagonal(double sr, double st, double sn) {
    Covariance3x3 c;
    c.data[0] = sr * sr;
    c.data[4] = st * st;
    c.data[8] = sn * sn;
    return c;
  }

  /// Construct from full 3×3 matrix
  static Covariance3x3 from_matrix(const double m[9]) {
    Covariance3x3 c;
    for (int i = 0; i < 9; i++)
      c.data[i] = m[i];
    return c;
  }
};

/// A source's position-velocity covariance at its own epochs, as its message
/// (OEM, OCM) supplied it: the 21-element lower triangle of the 6x6 matrix
/// (CX_X, CY_X, CY_Y, CZ_X, ...) in km², km²/s and km²/s², in the axes the
/// message declared.
struct CovarianceSeries {
  enum class Axes { Rtn, Evaluation };
  Axes axes = Axes::Evaluation;
  std::vector<double> jd;
  std::vector<std::array<double, 21>> lower;
  /// The message's statement that this covariance was calibrated against
  /// independent reference states, and the evidence it names.
  bool calibrated = false;
  std::string calibration_reference;
  bool empty() const { return jd.empty(); }
};

/// The position-velocity covariance at jd in the object's RTN axes, as the
/// 21-element lower triangle, each element interpolated linearly between the
/// bracketing epochs; false when jd is outside the series. state is the
/// object's state at jd, which orients an evaluation-frame covariance
/// (position and velocity rotated alike).
bool covariance_rtn_at(const CovarianceSeries &series, double jd,
                       const StateVector &state, std::array<double, 21> &rtn);
/// Check the supplied symmetric lower triangle (3x3, 6x6 or 9x9), without
/// repairing it. Diagonal scaling makes the PSD roundoff tolerance unitless.
bool covariance_is_positive_semidefinite(const double *lower, size_t size);
/// The position block of a 21-element lower triangle.
Covariance3x3 position_block(const std::array<double, 21> &lower);

/// Rotate an RTN-frame covariance into inertial coordinates using the state at
/// jd.
Covariance3x3 covariance_rtn_to_inertial(const Covariance3x3 &rtn_covariance,
                                         const StateVector &state);

/// Rotate an inertial covariance into RTN coordinates using the state at jd.
Covariance3x3
covariance_inertial_to_rtn(const Covariance3x3 &inertial_covariance,
                           const StateVector &state);

// ── Conjunction Event (v2) ──

struct ConjunctionEvent2 {
  // Object identifiers
  std::string obj1_name, obj2_name;
  std::string obj1_id, obj2_id;
  int obj1_norad = 0, obj2_norad = 0;

  // Time of closest approach
  double tca_jd = 0;
  std::string tca_iso;

  // States at TCA (inertial frame)
  StateVector state1, state2;

  // Geometry
  double miss_distance_km = 0;
  double relative_speed_kms = 0;

  // RTN relative position/velocity
  double rel_r = 0, rel_t = 0, rel_n = 0;
  double rel_vr = 0, rel_vt = 0, rel_vn = 0;

  // B-plane geometry
  BPlaneGeometry bplane;

  // Mahalanobis distance
  double mahalanobis_2d = 0; // In encounter plane (from B-plane geometry)
  double mahalanobis_3d = 0; // Full 3D (from combined position covariance)

  // Collision probability. With has_covariance, the chosen method's result
  // from the covariance the caller supplied (cov1, cov2, inertial). Without,
  // only the Alfano maximum (pc.max_probability, pc.method "ALFANO-SPHERICAL-SMALL-HBR-MAX"):
  // no covariance is assumed, so no covariance-based probability exists.
  PcResult pc;
  PcUsageResult usage;
  bool has_covariance = false; // A covariance-based Pc was computed successfully.
    // Source availability is independent of whether Pc can be computed.
    bool has_covariance1 = false, has_covariance2 = false;
    std::string probability_failure;
  double dilution_threshold_km = 0;

  Covariance3x3 cov1, cov2;
  // With has_covariance1/2: each object's
  // position-velocity covariance at TCA in RTN (21-element lower triangle).
  std::array<double, 21> cov6_rtn1{}, cov6_rtn2{};
  double combined_radius_km = 0.01;
  double radius1_m = 5.0, radius2_m = 5.0;

  // Days since epoch
  double dse1 = 0, dse2 = 0;
};

// ── Engine ──

inline constexpr double kDefaultPcReportingFloor = 1e-7;
inline constexpr double kDefaultPcMonteCarloFloor = 1e-4;

/// Automatic usage-violation routing, based on the true Foster Pc2D (or the
/// shape-scaled maximum only if Pc2D is unavailable). Below reporting_floor,
/// retain Pc2D and its usage diagnostics; at monte_carlo_floor select Monte
/// Carlo directly. Intermediate events use 3D-Nc and its applicability checks.
struct PcTierOptions {
  double reporting_floor = kDefaultPcReportingFloor;
  double monte_carlo_floor = kDefaultPcMonteCarloFloor;
};

class ConjunctionEngine {
public:
  ConjunctionEngine();

  /// Set the Pc method (default: Foster-2D)
  void set_pc_method(std::unique_ptr<PcMethod> method);
  void set_pc_method(const std::string &name);

  /// Reference (default) preserves the authoritative calculations. Screening
  /// uses bounded disk quadrature, guarded quadratic-time Hall flux or 1e-2
  /// Nc convergence, and adaptive seeded MC
  /// (32768 minimum samples, 30-hit target, default cap 49152). An explicit
  /// sample budget supplied through set_pc_fallback is retained. The grade and
  /// actual Screening numerical policy are included in the usage_reason.
  void set_pc_grade(PcGrade grade) { pc_grade_ = grade; }

  /// Set default hard-body radii (meters)
  void set_combined_radius_m(double radius1, double radius2);

  /// Find TCA between two ephemeris sources
  /// Searches [start_jd, start_jd + duration_days]
  double find_tca(const EphemerisSource &obj1, const EphemerisSource &obj2,
                  double start_jd, double duration_days = 7.0,
                  double coarse_step_sec = 5.0,
                  double fine_tol_sec = 0.001) const;

  /// Full conjunction assessment. The Pc method applies only when both RTN
  /// covariances are supplied; otherwise the event carries the Alfano maximum.
  ConjunctionEvent2 assess(const EphemerisSource &obj1,
                           const EphemerisSource &obj2, double start_jd,
                           double duration_days = 7.0,
                           const Covariance3x3 *cov1 = nullptr,
                           const Covariance3x3 *cov2 = nullptr,
                           double coarse_step_sec = 5.0,
                           double fine_tol_sec = 0.001) const;

  /// The assessment at a TCA already found (states, geometry, probability).
  ConjunctionEvent2 assess_at(const EphemerisSource &obj1,
                              const EphemerisSource &obj2, double tca_jd,
                              const Covariance3x3 *cov1 = nullptr,
                              const Covariance3x3 *cov2 = nullptr) const;

  /// Assess near a known TCA
  ConjunctionEvent2 assess_near(const EphemerisSource &obj1,
                                const EphemerisSource &obj2, double tca_hint_jd,
                                double window_hours = 2.0,
                                const Covariance3x3 *cov1 = nullptr,
                                const Covariance3x3 *cov2 = nullptr) const;

  /// Compute Pc from pre-computed states and their RTN covariances (no
  /// propagation)
  ConjunctionEvent2 compute_pc(const StateVector &state1,
                               const StateVector &state2,
                               const Covariance3x3 &cov1,
                               const Covariance3x3 &cov2,
                               double combined_radius_km = 0.01) const;

  /// Full inertial 6-state covariance assessment, with optional between-object
  /// cross covariance. This preserves velocity uncertainty for usage checks.
  ConjunctionEvent2 compute_pc(const PcEncounter &encounter) const;

  /// Evaluate independent encounters on workers, returning results in input
  /// order. Monte Carlo seeds depend on the encounter and configured seed,
  /// never the worker or scheduling. Zero threads uses one worker. Engine
  /// configuration must remain unchanged while a batch is running.
  std::vector<ConjunctionEvent2> compute_pc_batch(
      const std::vector<PcEncounter> &encounters, unsigned threads = 1) const;

  /// Fallback policy for usage violations. Floors apply only to Automatic;
  /// explicit fallback selections retain their existing forced behavior.
  enum class Fallback { Automatic, TwoDimensionalNc, ThreeDimensionalNc, MonteCarlo };
  void set_pc_fallback(Fallback method) {
    fallback_ = method; fallback_options_ = {}; fallback_options_configured_ = false;
  }
  void set_pc_fallback(Fallback method, const PcFallbackOptions &options) {
    fallback_ = method; fallback_options_ = options; fallback_options_configured_ = true;
  }

  /// Set finite dimensionless floors with 0 <= reporting <= 1 and reporting
  /// <= Monte Carlo. A Monte Carlo floor > 1 disables direct MC; Nc's own
  /// applicability still requires MC. Invalid values preserve prior options.
  bool set_pc_tier_options(const PcTierOptions &options);

  /// Screen multiple objects
  std::vector<ConjunctionEvent2>
  screen(const std::vector<std::shared_ptr<EphemerisSource>> &primaries,
         const std::vector<std::shared_ptr<EphemerisSource>> &secondaries,
         double start_jd, double duration_days = 7.0,
         double threshold_km = 5.0) const;

  /// Get current Pc method name
  std::string pc_method_name() const;

private:
  std::unique_ptr<PcMethod> pc_method_;
  PcGrade pc_grade_ = PcGrade::Reference;
  bool fallback_options_configured_ = false;
  Fallback fallback_ = Fallback::Automatic;
  // Automatic Reference routing starts with fewer quadrature nodes, retaining
  // the same 1e-4 convergence budget and adaptive refinement. Explicit
  // set_pc_fallback calls preserve the caller's options (including {} defaults).
  PcFallbackOptions fallback_options_ = [] {
    PcFallbackOptions options;
    options.angular_order = 16;
    options.time_intervals = 128;
    return options;
  }();
  PcTierOptions tier_options_;
  ConjunctionEvent2 evaluate_encounter(const PcEncounter& encounter) const;
  double radius1_m_ = 5.0;
  double radius2_m_ = 5.0;

  /// Build B-plane geometry from states + covariance
  BPlaneGeometry build_bplane(const StateVector &s1, const StateVector &s2,
                              const Covariance3x3 &c1, const Covariance3x3 &c2,
                              double combined_radius_km) const;
};

} // namespace conjunction

#endif // CONJUNCTION_ENGINE_H
