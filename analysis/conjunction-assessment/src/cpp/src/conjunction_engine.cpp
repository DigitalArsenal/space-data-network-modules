#include "conjunction/error_status.h"
#include <limits>
/**
 * Conjunction Assessment Engine (v2) — Propagator-agnostic implementation
 *
 * TCA finding is screen_catalog's minimum search through the
 * EphemerisSource interface (closest_approach_in_window).
 *
 * B-plane projection follows Montenbruck & Gill Section 6.5.
 */

#include "conjunction/conjunction_engine.h"
#include "conjunction/encounter_geometry.h"
#include "conjunction/conjunction_assessment.h"  // closest_approach_in_window, inertial_to_rtn

#include <cmath>
#include <algorithm>
#include <stdexcept>

namespace conjunction {

// ── Constructor ──

ConjunctionEngine::ConjunctionEngine()
    : pc_method_(std::make_unique<Foster2D>()) {}

void ConjunctionEngine::set_pc_method(std::unique_ptr<PcMethod> method) {
    pc_method_ = std::move(method);
}

void ConjunctionEngine::set_pc_method(const std::string& name) {
    pc_method_ = create_pc_method(name);
}

void ConjunctionEngine::set_combined_radius_m(double r1, double r2) {
    radius1_m_ = r1;
    radius2_m_ = r2;
}

std::string ConjunctionEngine::pc_method_name() const {
    return pc_method_ ? pc_method_->name() : "NONE";
}

static bool state_is_finite(const StateVector& state) {
    return std::isfinite(state.x) &&
           std::isfinite(state.y) &&
           std::isfinite(state.z) &&
           std::isfinite(state.vx) &&
           std::isfinite(state.vy) &&
           std::isfinite(state.vz);
}

// ── TCA Finding ──

std::optional<double> ConjunctionEngine::find_tca(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days, double fine_tol_sec) const
{
    // The minimum search screen_catalog runs (conjunction_assessment), so a
    // pair's TCA here is that of its catalog event.
    const auto found = closest_approach_in_window(obj1, obj2, start_jd, duration_days, fine_tol_sec);
    if (!found) return std::nullopt;
    return found->tca_jd;
}

// ── Full Assessment ──

std::optional<ConjunctionEvent2> ConjunctionEngine::assess(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days,
    const Covariance3x3* cov1, const Covariance3x3* cov2,
    double fine_tol_sec) const
{
    const auto tca_jd = find_tca(obj1, obj2, start_jd, duration_days, fine_tol_sec);
    if (!tca_jd) return std::nullopt;
    auto event = assess_at(obj1, obj2, *tca_jd, cov1, cov2);
    if (has_error()) return std::nullopt;
    return event;
}

ConjunctionEvent2 ConjunctionEngine::assess_at(
    const EphemerisSource& obj1, const EphemerisSource& obj2, double tca_jd,
    const Covariance3x3* cov1, const Covariance3x3* cov2) const
{
    ConjunctionEvent2 event;

    // Metadata
    event.obj1_name = obj1.object_name();
    event.obj2_name = obj2.object_name();
    event.obj1_id = obj1.object_id();
    event.obj2_id = obj2.object_id();
    event.obj1_norad = obj1.norad_id();
    event.obj2_norad = obj2.norad_id();

    event.tca_jd = tca_jd;
    event.tca_iso = jd_to_iso(event.tca_jd);

    // Get states at TCA
    event.state1 = obj1.state_at(event.tca_jd);
    event.state2 = obj2.state_at(event.tca_jd);
    if (!state_is_finite(event.state1) || !state_is_finite(event.state2)) {
        set_error("Invalid propagated state at TCA."); return {};
    }

    // Geometry
    double dx = event.state1.x - event.state2.x;
    double dy = event.state1.y - event.state2.y;
    double dz = event.state1.z - event.state2.z;
    event.miss_distance_km = std::sqrt(dx*dx + dy*dy + dz*dz);

    double dvx = event.state1.vx - event.state2.vx;
    double dvy = event.state1.vy - event.state2.vy;
    double dvz = event.state1.vz - event.state2.vz;
    event.relative_speed_kms = std::sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
    if (!std::isfinite(event.miss_distance_km) || !std::isfinite(event.relative_speed_kms)) {
        set_error("Invalid conjunction geometry at TCA."); return {};
    }

    // RTN
    inertial_to_rtn(event.state1, event.state2,
                    event.rel_r, event.rel_t, event.rel_n,
                    event.rel_vr, event.rel_vt, event.rel_vn);

    // DSE
    event.dse1 = event.tca_jd - obj1.epoch_jd();
    event.dse2 = event.tca_jd - obj2.epoch_jd();

    event.radius1_m = radius1_m_;
    event.radius2_m = radius2_m_;
    event.combined_radius_km = (radius1_m_ + radius2_m_) / 1000.0;
    if (!cov1 || !cov2) {
        const auto bound = alfano_max_probability(event.miss_distance_km, event.combined_radius_km);
        event.pc.method = "ALFANO-SPHERICAL-SMALL-HBR-MAX";
        event.pc.max_probability = bound.max_probability;
        event.pc.probability = bound.max_probability;
        event.dilution_threshold_km = bound.dilution_threshold_km;
        return event;
    }

    // Preserve one covariance calculation/routing path for all callers.
    const auto computed = compute_pc(event.state1, event.state2, *cov1, *cov2,
                                     event.combined_radius_km);
    event.pc = computed.pc;
    event.usage = computed.usage;
    event.has_covariance = computed.has_covariance;
    event.probability_failure = computed.probability_failure;
    event.cov1 = computed.cov1;
    event.cov2 = computed.cov2;
    event.bplane = computed.bplane;
    event.mahalanobis_2d = computed.mahalanobis_2d;
    event.mahalanobis_3d = computed.mahalanobis_3d;
    event.has_mahalanobis_3d = computed.has_mahalanobis_3d;

    return event;
}

std::optional<ConjunctionEvent2> ConjunctionEngine::assess_near(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double tca_hint_jd, double window_hours,
    const Covariance3x3* cov1, const Covariance3x3* cov2) const
{
    double window_days = window_hours / 24.0;
    return assess(obj1, obj2, tca_hint_jd - window_days, 2.0 * window_days,
                  cov1, cov2);
}

std::vector<ConjunctionEvent2> ConjunctionEngine::screen(
    const std::vector<std::shared_ptr<EphemerisSource>>& primaries,
    const std::vector<std::shared_ptr<EphemerisSource>>& secondaries,
    double start_jd, double duration_days, double threshold_km) const
{
    std::vector<ConjunctionEvent2> events;

    for (const auto& primary : primaries) {
        for (const auto& secondary : secondaries) {
            if (primary->norad_id() != 0 && primary->norad_id() == secondary->norad_id())
                continue;

            {
                auto event = assess(*primary, *secondary, start_jd, duration_days);
                if (has_error()) return {};
                if (event && event->miss_distance_km <= threshold_km) {
                    events.push_back(*event);
                }
            }
        }
    }

    std::sort(events.begin(), events.end(),
              [](const ConjunctionEvent2& a, const ConjunctionEvent2& b) {
                  return a.pc.probability > b.pc.probability;
              });

    return events;
}

} // namespace conjunction
