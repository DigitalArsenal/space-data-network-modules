#include "conjunction/encounter_geometry.h"
#include <cmath>
#include <algorithm>
#include <limits>

namespace conjunction {
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

bool covariance_is_positive_semidefinite(const double* lower, size_t size) {
    const size_t n = size >= 45 ? 9 : size >= 21 ? 6 : size >= 6 ? 3 : 0;
    if (!lower || n == 0) return false;
    double a[9][9] = {}, scale[9] = {};
    for (size_t r = 0; r < n; ++r) {
        const double diagonal = lower[r * (r + 1) / 2 + r];
        if (!std::isfinite(diagonal) || diagonal < 0) return false;
        scale[r] = std::sqrt(diagonal);
    }
    for (size_t r = 0, k = 0; r < n; ++r) {
        for (size_t c = 0; c <= r; ++c, ++k) {
            if (!std::isfinite(lower[k])) return false;
            if (scale[r] == 0 || scale[c] == 0) {
                if (lower[k] != 0) return false;
            } else {
                a[r][c] = a[c][r] = lower[k] / scale[r] / scale[c];
                if (!std::isfinite(a[r][c])) return false;
            }
        }
    }
    // Pivoted Schur complements of the correlation matrix. A zero pivot
    // requires a zero residual row; tolerate only floating-point roundoff.
    const double tolerance = 64 * n * std::numeric_limits<double>::epsilon();
    for (size_t k = 0; k < n; ++k) {
        size_t pivot = k;
        for (size_t i = k; i < n; ++i) {
            if (a[i][i] < -tolerance) return false;
            if (a[i][i] > a[pivot][pivot]) pivot = i;
        }
        if (a[pivot][pivot] <= tolerance) {
            for (size_t i = k; i < n; ++i)
                for (size_t j = k; j < n; ++j)
                    if (std::abs(a[i][j]) > tolerance) return false;
            return true;
        }
        for (size_t j = 0; j < n; ++j) std::swap(a[k][j], a[pivot][j]);
        for (size_t i = 0; i < n; ++i) std::swap(a[i][k], a[i][pivot]);
        for (size_t i = k + 1; i < n; ++i)
            for (size_t j = k + 1; j < n; ++j)
                a[i][j] -= a[i][k] * a[k][j] / a[k][k];
    }
    return true;
}

Covariance3x3 position_block(const std::array<double, 21>& e) {
    Covariance3x3 c;
    c.data[0] = e[0];
    c.data[1] = c.data[3] = e[1];
    c.data[4] = e[2];
    c.data[2] = c.data[6] = e[3];
    c.data[5] = c.data[7] = e[4];
    c.data[8] = e[5];
    return c;
}

bool covariance_rtn_at(const CovarianceSeries& series, double jd,
                       const StateVector& state, std::array<double, 21>& rtn) {
    if (series.jd.empty() || series.jd.size() != series.lower.size()) return false;
    const double slack = 1e-9;
    if (jd < series.jd.front() - slack || jd > series.jd.back() + slack) return false;
    const size_t above = static_cast<size_t>(
        std::upper_bound(series.jd.begin(), series.jd.end(), jd) - series.jd.begin());
    const size_t i = above == 0 ? 0 : std::min(above - 1, series.jd.size() - 1);
    const size_t j = std::min(i + 1, series.jd.size() - 1);
    const double f = j == i ? 0.0 : std::clamp((jd - series.jd[i]) / (series.jd[j] - series.jd[i]), 0.0, 1.0);
    std::array<double, 21> e{};
    for (int n = 0; n < 21; ++n) e[n] = (1.0 - f) * series.lower[i][n] + f * series.lower[j][n];
    if (series.axes == CovarianceSeries::Axes::Rtn) {
        rtn = e;
        return true;
    }
    // Evaluation axes to RTN: C' = M C M^T with M = diag(B^T, B^T), B's
    // columns the R, T, N unit vectors (build_rtn_basis).
    double basis[9];
    if (!build_rtn_basis(state, basis)) return false;
    double full[6][6];
    for (int r = 0, k = 0; r < 6; ++r)
        for (int c = 0; c <= r; ++c, ++k) full[r][c] = full[c][r] = e[k];
    double m[6][6] = {};
    for (int b = 0; b < 2; ++b)
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) m[3 * b + r][3 * b + c] = basis[3 * c + r];
    double mc[6][6] = {};
    for (int r = 0; r < 6; ++r)
        for (int c = 0; c < 6; ++c)
            for (int k = 0; k < 6; ++k) mc[r][c] += m[r][k] * full[k][c];
    for (int r = 0, k = 0; r < 6; ++r)
        for (int c = 0; c <= r; ++c, ++k) {
            double v = 0;
            for (int q = 0; q < 6; ++q) v += mc[r][q] * m[c][q];
            rtn[k] = v;
        }
    return true;
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
double encounter_mahalanobis_3d(const double dr[3], const Covariance3x3& c1, const Covariance3x3& c2) {
    // Cholesky solve in correlation coordinates. No covariance repair and no
    // determinant cutoff in physical units: an unavailable inverse is not Md=0.
    const double unavailable = std::numeric_limits<double>::quiet_NaN();
    double scale[3], l[3][3] = {}, y[3] = {};
    for (int i = 0; i < 3; ++i) {
        const double diagonal = c1.data[4*i] + c2.data[4*i];
        if (!(diagonal > 0) || !std::isfinite(diagonal) || !std::isfinite(dr[i]))
            return unavailable;
        scale[i] = std::sqrt(diagonal);
    }
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j <= i; ++j) {
            double value = (c1.data[3*i+j] + c2.data[3*i+j]) / scale[i] / scale[j];
            const double transpose = (c1.data[3*j+i] + c2.data[3*j+i]) / scale[i] / scale[j];
            if (!std::isfinite(value) || !std::isfinite(transpose) ||
                std::abs(value - transpose) > 64 * std::numeric_limits<double>::epsilon() *
                    std::max({1.0, std::abs(value), std::abs(transpose)})) return unavailable;
            for (int k = 0; k < j; ++k) value -= l[i][k] * l[j][k];
            if (i == j) {
                if (!(value > 0)) return unavailable;
                l[i][j] = std::sqrt(value);
            } else l[i][j] = value / l[j][j];
        }
        double value = dr[i] / scale[i];
        for (int j = 0; j < i; ++j) value -= l[i][j] * y[j];
        y[i] = value / l[i][i];
    }
    return std::hypot(y[0], y[1], y[2]);
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
        // No encounter plane exists. Caller reports the usage violation;
        // do not manufacture a 1 m covariance or return a 2D probability.
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

}
