#pragma once

// Opt-in innovation recovery for full-state observations (extension v5).
//
// Policy only, with no dynamics: a filter forms its prediction and raw NIS,
// asks this controller for a decision, and applies it. The controller keeps
// the bounded two-hypothesis state of a suspicious observation (the held
// track, and a candidate track started at the observation) and never uses a
// future observation or a retrospective replay.
//
// A persistent discrepancy is evidence of a changed track, not proof of a
// maneuver; nothing here declares one. The NIS gate and the two strategies
// follow the published description of full-state innovation recovery (OEL
// docs/innovation-recovery.md, Apache-2.0); this is an independent
// implementation.

#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

namespace sdn::estimation {

enum class RecoveryStrategy : std::uint8_t { PREDICTIVE_CONSISTENCY = 0, PERSISTENCE = 1 };

enum class RecoveryClassification : std::uint8_t {
  NOMINAL = 0,
  PENDING_DISCREPANCY = 1,
  UNRESOLVED_DISCREPANCY = 2,
  TRANSIENT_DISCREPANCY = 3,
  PERSISTENT_DISCREPANCY = 4
};

enum class RecoveryAction : std::uint8_t { ACCEPTED = 0, HELD = 1, REINITIALIZED = 2 };

struct RecoveryConfig {
  bool enabled{false};
  RecoveryStrategy strategy{RecoveryStrategy::PREDICTIVE_CONSISTENCY};
  double nis_probability{0.999};
  int confirmation_count{2};
  double covariance_inflation{4.0};
  double max_gap_seconds{120.0};
};

inline bool valid_recovery_config(const RecoveryConfig& c) {
  return (c.strategy == RecoveryStrategy::PREDICTIVE_CONSISTENCY ||
          c.strategy == RecoveryStrategy::PERSISTENCE) &&
         std::isfinite(c.nis_probability) && c.nis_probability > 0.0 && c.nis_probability < 1.0 &&
         c.confirmation_count >= 2 && std::isfinite(c.covariance_inflation) &&
         c.covariance_inflation >= 1.0 && std::isfinite(c.max_gap_seconds) && c.max_gap_seconds > 0.0;
}

// Chi-square quantile for an even number of degrees of freedom k = 2m: the
// distribution function is 1 - exp(-x/2) sum_{j<m} (x/2)^j / j!. Bisection on
// the bracket from the Wilson-Hilferty start, then Newton polishing.
inline double chi_square_cdf_even(int dof, double x) {
  const double half = 0.5 * x;
  double term = 1.0, sum = 1.0;
  for (int j = 1; j < dof / 2; ++j) { term *= half / j; sum += term; }
  return 1.0 - std::exp(-half) * sum;
}

inline double chi_square_quantile_even(int dof, double probability) {
  double low = 0.0, high = static_cast<double>(dof);
  while (chi_square_cdf_even(dof, high) < probability) high *= 2.0;
  for (int i = 0; i < 200; ++i) {
    const double mid = 0.5 * (low + high);
    if (chi_square_cdf_even(dof, mid) < probability) low = mid; else high = mid;
  }
  return 0.5 * (low + high);
}

// A track belief over the six-component full state.
struct RecoveryBelief {
  std::array<double, 6> state{};
  std::array<double, 36> covariance{};
};

struct RecoveryDecision {
  RecoveryClassification classification{RecoveryClassification::NOMINAL};
  RecoveryAction action{RecoveryAction::ACCEPTED};
  double nis{0.0};
  double threshold{0.0};
  bool has_candidate{false};
  double candidate_nis{0.0};
  int consecutive_exceedances{0};
  double acquisition_seconds{0.0};
  double decision_seconds{0.0};
};

class InnovationRecovery {
 public:
  explicit InnovationRecovery(const RecoveryConfig& config)
      : config_(config),
        threshold_(chi_square_quantile_even(6, config.nis_probability)) {}

  double threshold() const { return threshold_; }

  // A pending discrepancy that the maximum observation gap has outlived is
  // dropped; the observation at `epoch_seconds` is then judged on its own.
  bool pending_at(double epoch_seconds) {
    if (pending_ && epoch_seconds - last_seconds_ > config_.max_gap_seconds) pending_ = false;
    return pending_;
  }

  // The candidate track as it stood at the previous observation; the caller
  // propagates it with its own dynamics. Valid while pending_at() is true.
  const RecoveryBelief& candidate() const { return candidate_; }

  // `candidate_nis` is consulted only for PREDICTIVE_CONSISTENCY with a
  // pending discrepancy (pass has_candidate = true then). A non-finite NIS
  // counts as an exceedance.
  RecoveryDecision decide(double epoch_seconds, double nis, bool has_candidate, double candidate_nis) {
    const bool was_pending = pending_at(epoch_seconds);
    RecoveryDecision d;
    d.nis = nis;
    d.threshold = threshold_;
    d.has_candidate = was_pending && config_.strategy == RecoveryStrategy::PREDICTIVE_CONSISTENCY && has_candidate;
    d.candidate_nis = d.has_candidate ? candidate_nis : 0.0;
    d.decision_seconds = epoch_seconds;
    if (std::isfinite(nis) && nis <= threshold_) {
      d.classification = was_pending ? RecoveryClassification::TRANSIENT_DISCREPANCY
                                     : RecoveryClassification::NOMINAL;
      d.action = RecoveryAction::ACCEPTED;
      d.acquisition_seconds = was_pending ? first_seconds_ : epoch_seconds;
      reset();
      return d;
    }
    const bool consistent =
        was_pending && (config_.strategy == RecoveryStrategy::PERSISTENCE ||
                        (d.has_candidate && std::isfinite(candidate_nis) && candidate_nis <= threshold_));
    d.consecutive_exceedances = consistent ? count_ + 1 : 1;
    d.acquisition_seconds = consistent ? first_seconds_ : epoch_seconds;
    if (d.consecutive_exceedances >= config_.confirmation_count) {
      d.classification = RecoveryClassification::PERSISTENT_DISCREPANCY;
      d.action = RecoveryAction::REINITIALIZED;
      reset();
      return d;
    }
    d.classification = was_pending ? RecoveryClassification::UNRESOLVED_DISCREPANCY
                                   : RecoveryClassification::PENDING_DISCREPANCY;
    d.action = RecoveryAction::HELD;
    pending_ = true;
    first_seconds_ = d.acquisition_seconds;
    last_seconds_ = epoch_seconds;
    count_ = d.consecutive_exceedances;
    return d;
  }

  // After a HELD decision: the candidate track restarts at this observation
  // (never at truth), to be propagated to the next one.
  void set_candidate(const RecoveryBelief& belief) { candidate_ = belief; }

  void reset() { pending_ = false; count_ = 0; }

 private:
  RecoveryConfig config_;
  double threshold_;
  bool pending_{false};
  int count_{0};
  double first_seconds_{0.0}, last_seconds_{0.0};
  RecoveryBelief candidate_{};
};

}  // namespace sdn::estimation
