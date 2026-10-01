#include "conjunction/error_status.h"
#include <limits>
/**
 * Conjunction Assessment Engine (v2) — Propagator-agnostic implementation
 *
 * TCA finding uses the same golden-section refinement as v1, but
 * through the EphemerisSource interface instead of TLE+SGP4 directly.
 *
 * B-plane projection follows Montenbruck & Gill Section 6.5.
 */

#include "conjunction/conjunction_engine.h"
#include "conjunction/conjunction_assessment.h"  // for inertial_to_rtn

#include <cmath>
#include <algorithm>
#include <stdexcept>

namespace conjunction {

// ── Constructor ──

ConjunctionEngine::ConjunctionEngine()
    : pc_method_(std::make_unique<Foster2D>()),
      default_cov_(Covariance3x3::socrates_default()) {}

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

void ConjunctionEngine::set_default_covariance(const Covariance3x3& cov) {
    default_cov_ = cov;
}

std::string ConjunctionEngine::pc_method_name() const {
    return pc_method_ ? pc_method_->name() : "NONE";
}

// ── Helpers ──

static double vec_norm(const double v[3]) {
    return std::sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
}

static void vec_normalize(double v[3]) {
    double n = vec_norm(v);
    if (n > 1e-15) { v[0] /= n; v[1] /= n; v[2] /= n; }
}

static double vec_dot(const double a[3], const double b[3]) {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

static bool state_is_finite(const StateVector& state) {
    return std::isfinite(state.x) &&
           std::isfinite(state.y) &&
           std::isfinite(state.z) &&
           std::isfinite(state.vx) &&
           std::isfinite(state.vy) &&
           std::isfinite(state.vz);
}

static void vec_cross(const double a[3], const double b[3], double c[3]) {
    c[0] = a[1]*b[2] - a[2]*b[1];
    c[1] = a[2]*b[0] - a[0]*b[2];
    c[2] = a[0]*b[1] - a[1]*b[0];
}

static bool build_rtn_basis(const StateVector& state, double basis[9]) {
    double radial[3] = {state.x, state.y, state.z};
    vec_normalize(radial);
    if (vec_norm(radial) <= 1e-12) {
        return false;
    }

    double angular_momentum[3];
    double velocity[3] = {state.vx, state.vy, state.vz};
    vec_cross(radial, velocity, angular_momentum);
    vec_normalize(angular_momentum);
    if (vec_norm(angular_momentum) <= 1e-12) {
        return false;
    }

    double along_track[3];
    vec_cross(angular_momentum, radial, along_track);
    vec_normalize(along_track);
    if (vec_norm(along_track) <= 1e-12) {
        return false;
    }

    basis[0] = radial[0];
    basis[1] = along_track[0];
    basis[2] = angular_momentum[0];
    basis[3] = radial[1];
    basis[4] = along_track[1];
    basis[5] = angular_momentum[1];
    basis[6] = radial[2];
    basis[7] = along_track[2];
    basis[8] = angular_momentum[2];
    return true;
}

// Matrix-vector multiply: out = M × v (3×3 × 3)
static void mat_vec(const double M[9], const double v[3], double out[3]) {
    out[0] = M[0]*v[0] + M[1]*v[1] + M[2]*v[2];
    out[1] = M[3]*v[0] + M[4]*v[1] + M[5]*v[2];
    out[2] = M[6]*v[0] + M[7]*v[1] + M[8]*v[2];
}

static Covariance3x3 rotate_covariance(
    const Covariance3x3& covariance,
    const double left[9],
    const double right[9]) {
    Covariance3x3 rotated;
    double intermediate[9] = {0};

    for (int row = 0; row < 3; row++) {
        for (int column = 0; column < 3; column++) {
            double value = 0.0;
            for (int axis = 0; axis < 3; axis++) {
                value += left[row * 3 + axis] * covariance.data[axis * 3 + column];
            }
            intermediate[row * 3 + column] = value;
        }
    }

    for (int row = 0; row < 3; row++) {
        for (int column = 0; column < 3; column++) {
            double value = 0.0;
            for (int axis = 0; axis < 3; axis++) {
                value += intermediate[row * 3 + axis] * right[axis * 3 + column];
            }
            rotated.data[row * 3 + column] = value;
        }
    }
    return rotated;
}

static Covariance3x3 resolve_inertial_covariance(
    const EphemerisSource& source,
    const StateVector& state,
    const Covariance3x3* explicit_covariance,
    const Covariance3x3& default_covariance) {
    if (explicit_covariance != nullptr) {
        return covariance_rtn_to_inertial(*explicit_covariance, state);
    }

    RtnCovarianceSigmas sigmas;
    if (source.covariance_rtn_sigma_at(state.epoch_jd, sigmas)) {
        return covariance_rtn_to_inertial(
            Covariance3x3::from_rtn_diagonal(
                sigmas.radial_km,
                sigmas.along_track_km,
                sigmas.cross_track_km),
            state);
    }

    return covariance_rtn_to_inertial(default_covariance, state);
}

Covariance3x3 covariance_rtn_to_inertial(
    const Covariance3x3& rtn_covariance,
    const StateVector& state) {
    double basis[9];
    if (!build_rtn_basis(state, basis)) {
        return rtn_covariance;
    }
    double basis_transpose[9] = {
        basis[0], basis[3], basis[6],
        basis[1], basis[4], basis[7],
        basis[2], basis[5], basis[8],
    };
    return rotate_covariance(rtn_covariance, basis, basis_transpose);
}

Covariance3x3 covariance_inertial_to_rtn(
    const Covariance3x3& inertial_covariance,
    const StateVector& state) {
    double basis[9];
    if (!build_rtn_basis(state, basis)) {
        return inertial_covariance;
    }
    double basis_transpose[9] = {
        basis[0], basis[3], basis[6],
        basis[1], basis[4], basis[7],
        basis[2], basis[5], basis[8],
    };
    return rotate_covariance(inertial_covariance, basis_transpose, basis);
}

// R^T × C × R for 3×3 rotation and covariance → 2×2 projection
// R is 3×2 (two columns = encounter-plane basis vectors)

// 3D Mahalanobis distance: Md = sqrt(Δr^T × C_combined⁻¹ × Δr)
static double mahalanobis_3d(const double dr[3], const Covariance3x3& c1, const Covariance3x3& c2) {
    // Combined covariance
    double C[9];
    for (int i = 0; i < 9; i++) C[i] = c1.data[i] + c2.data[i];

    // Invert 3×3 symmetric matrix
    double a = C[0], b = C[1], c = C[2];
    double d = C[3], e = C[4], f = C[5];
    double g = C[6], h = C[7], k = C[8];

    double det = a*(e*k - f*h) - b*(d*k - f*g) + c*(d*h - e*g);
    if (std::abs(det) < 1e-30) return 0;

    double inv[9];
    inv[0] = (e*k - f*h) / det;
    inv[1] = (c*h - b*k) / det;
    inv[2] = (b*f - c*e) / det;
    inv[3] = (f*g - d*k) / det;
    inv[4] = (a*k - c*g) / det;
    inv[5] = (c*d - a*f) / det;
    inv[6] = (d*h - e*g) / det;
    inv[7] = (b*g - a*h) / det;
    inv[8] = (a*e - b*d) / det;

    // Md² = Δr^T × C⁻¹ × Δr
    double Cinv_dr[3];
    Cinv_dr[0] = inv[0]*dr[0] + inv[1]*dr[1] + inv[2]*dr[2];
    Cinv_dr[1] = inv[3]*dr[0] + inv[4]*dr[1] + inv[5]*dr[2];
    Cinv_dr[2] = inv[6]*dr[0] + inv[7]*dr[1] + inv[8]*dr[2];

    double md2 = dr[0]*Cinv_dr[0] + dr[1]*Cinv_dr[1] + dr[2]*Cinv_dr[2];
    return (md2 > 0) ? std::sqrt(md2) : 0;
}

// ── TCA Finding ──

double ConjunctionEngine::find_tca(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days, double coarse_step_sec, double fine_tol_sec) const
{
    // One TCA search for every caller: 5 s range sampling brackets minima
    // that coarse-step sampling steps over at 10+ km/s (conjunction_assessment).
    return conjunction::find_tca(obj1, obj2, start_jd, duration_days, coarse_step_sec, fine_tol_sec);
}

// ── B-plane Construction ──

BPlaneGeometry ConjunctionEngine::build_bplane(
    const StateVector& s1, const StateVector& s2,
    const Covariance3x3& c1, const Covariance3x3& c2,
    double combined_radius_km) const
{
    BPlaneGeometry bp;
    bp.combined_radius = combined_radius_km;

    // Relative position and velocity
    double dr[3] = {s1.x - s2.x, s1.y - s2.y, s1.z - s2.z};
    double dv[3] = {s1.vx - s2.vx, s1.vy - s2.vy, s1.vz - s2.vz};
    double v_rel = vec_norm(dv);

    if (v_rel < 1e-10) {
        bp.xi = vec_norm(dr);
        bp.sigma_xx = 1e-6;
        bp.sigma_zz = 1e-6;
        return bp;
    }

    // Encounter-plane basis (⊥ to relative velocity)
    double zhat[3] = {dv[0]/v_rel, dv[1]/v_rel, dv[2]/v_rel};

    // Find xhat perpendicular to zhat
    double temp[3] = {1, 0, 0};
    if (std::abs(zhat[0]) > 0.9) { temp[0] = 0; temp[1] = 1; }

    double d_tz = vec_dot(temp, zhat);
    double xhat[3] = {temp[0] - d_tz*zhat[0], temp[1] - d_tz*zhat[1], temp[2] - d_tz*zhat[2]};
    vec_normalize(xhat);

    double yhat[3];
    vec_cross(zhat, xhat, yhat);

    // Project miss vector onto encounter plane
    bp.xi = vec_dot(dr, xhat);
    bp.zeta = vec_dot(dr, yhat);

    // Combined covariance
    double C[9];
    for (int i = 0; i < 9; i++) C[i] = c1.data[i] + c2.data[i];

    // Project covariance onto encounter plane (2×2)
    double Cx[3], Cy[3];
    mat_vec(C, xhat, Cx);
    mat_vec(C, yhat, Cy);

    bp.sigma_xx = vec_dot(xhat, Cx);
    bp.sigma_xz = vec_dot(xhat, Cy);
    bp.sigma_zz = vec_dot(yhat, Cy);

    return bp;
}

// ── Full Assessment ──

ConjunctionEvent2 ConjunctionEngine::assess(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double start_jd, double duration_days,
    const Covariance3x3* cov1, const Covariance3x3* cov2,
    double coarse_step_sec, double fine_tol_sec) const
{
    ConjunctionEvent2 event;

    // Metadata
    event.obj1_name = obj1.object_name();
    event.obj2_name = obj2.object_name();
    event.obj1_id = obj1.object_id();
    event.obj2_id = obj2.object_id();
    event.obj1_norad = obj1.norad_id();
    event.obj2_norad = obj2.norad_id();

    // Find TCA
    event.tca_jd = find_tca(obj1, obj2, start_jd, duration_days, coarse_step_sec, fine_tol_sec);
    if (has_error()) return {};
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

    // Covariance
    event.cov1 = resolve_inertial_covariance(
        obj1, event.state1, cov1, default_cov_);
    event.cov2 = resolve_inertial_covariance(
        obj2, event.state2, cov2, default_cov_);
    event.combined_radius_km = (radius1_m_ + radius2_m_) / 1000.0;

    // Build B-plane and compute Pc
    event.bplane = build_bplane(event.state1, event.state2,
                                 event.cov1, event.cov2,
                                 event.combined_radius_km);
    event.pc = pc_method_->compute(event.bplane);

    // Mahalanobis distances
    event.mahalanobis_2d = event.bplane.mahalanobis_distance();
    double dr[3] = {
        event.state1.x - event.state2.x,
        event.state1.y - event.state2.y,
        event.state1.z - event.state2.z
    };
    event.mahalanobis_3d = mahalanobis_3d(dr, event.cov1, event.cov2);

    return event;
}

ConjunctionEvent2 ConjunctionEngine::assess_near(
    const EphemerisSource& obj1, const EphemerisSource& obj2,
    double tca_hint_jd, double window_hours,
    const Covariance3x3* cov1, const Covariance3x3* cov2) const
{
    double window_days = window_hours / 24.0;
    return assess(obj1, obj2, tca_hint_jd - window_days, 2.0 * window_days,
                  cov1, cov2);
}

ConjunctionEvent2 ConjunctionEngine::compute_pc(
    const StateVector& state1, const StateVector& state2,
    const Covariance3x3& cov1, const Covariance3x3& cov2,
    double combined_radius_km) const
{
    ConjunctionEvent2 event;
    event.state1 = state1;
    event.state2 = state2;
    event.tca_jd = state1.epoch_jd;
    event.tca_iso = jd_to_iso(event.tca_jd);
    event.cov1 = covariance_rtn_to_inertial(cov1, state1);
    event.cov2 = covariance_rtn_to_inertial(cov2, state2);
    event.combined_radius_km = combined_radius_km;

    double dx = state1.x - state2.x;
    double dy = state1.y - state2.y;
    double dz = state1.z - state2.z;
    event.miss_distance_km = std::sqrt(dx*dx + dy*dy + dz*dz);

    double dvx = state1.vx - state2.vx;
    double dvy = state1.vy - state2.vy;
    double dvz = state1.vz - state2.vz;
    event.relative_speed_kms = std::sqrt(dvx*dvx + dvy*dvy + dvz*dvz);

    inertial_to_rtn(state1, state2,
                    event.rel_r, event.rel_t, event.rel_n,
                    event.rel_vr, event.rel_vt, event.rel_vn);

    event.bplane = build_bplane(state1, state2, cov1, cov2, combined_radius_km);
    event.pc = pc_method_->compute(event.bplane);

    // Mahalanobis distances
    event.mahalanobis_2d = event.bplane.mahalanobis_distance();
    double dr[3] = {state1.x - state2.x, state1.y - state2.y, state1.z - state2.z};
    event.mahalanobis_3d = mahalanobis_3d(dr, cov1, cov2);

    return event;
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
                if (event.miss_distance_km <= threshold_km) {
                    events.push_back(event);
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
