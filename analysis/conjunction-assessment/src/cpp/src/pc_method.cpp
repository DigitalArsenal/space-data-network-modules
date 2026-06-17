/**
 * Pluggable Collision Probability Methods — Implementation
 *
 * Five methods, from simplest to most general:
 *   1. AlfanoMaxPc   — upper bound, no covariance needed
 *   2. Foster2D      — short-encounter approximation (CDM standard)
 *   3. Patera2001    — single-integral, good for elliptical covariance
 *   4. Chan1997      — zeroth-order analytical series
 *   5. Alfriend1999  — Orekit constant-density approximation
 *   6. Alfano2005    — Orekit Simpson-rule numerical integration
 *   7. Laas2015      — Orekit recurrent series with lower/upper bounds
 *   8. Alfriend2D    — brute-force 2D numerical integration
 *
 * All methods accept the same BPlaneGeometry and return PcResult.
 */

#include "conjunction/pc_method.h"
#include <cmath>
#include <algorithm>
#include <memory>
#include <limits>
#include <cstdint>
#include <cstring>

namespace conjunction {

static constexpr double PI = 3.14159265358979323846;
static constexpr double TWO_PI = 2.0 * PI;
static constexpr double SQRT_2 = 1.41421356237309504880;

struct OrekitPrincipalAxes {
    double xm = 0.0;
    double ym = 0.0;
    double sigma_x = 0.0;
    double sigma_y = 0.0;
};

static double square(double value) {
    return value * value;
}

static double high_part(double value) {
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    bits &= (std::numeric_limits<std::uint64_t>::max() << 27);
    double high = 0.0;
    std::memcpy(&high, &bits, sizeof(high));
    return high;
}

static double linear_combination(double a1, double b1, double a2, double b2) {
    const double a1_high = high_part(a1);
    const double a1_low = a1 - a1_high;
    const double b1_high = high_part(b1);
    const double b1_low = b1 - b1_high;
    const double prod1_high = a1 * b1;
    const double prod1_low =
        a1_low * b1_low - (((prod1_high - a1_high * b1_high) - a1_low * b1_high) - a1_high * b1_low);

    const double a2_high = high_part(a2);
    const double a2_low = a2 - a2_high;
    const double b2_high = high_part(b2);
    const double b2_low = b2 - b2_high;
    const double prod2_high = a2 * b2;
    const double prod2_low =
        a2_low * b2_low - (((prod2_high - a2_high * b2_high) - a2_low * b2_high) - a2_high * b2_low);

    const double s12_high = prod1_high + prod2_high;
    const double s12_prime = s12_high - prod2_high;
    const double s12_low = (prod2_high - (s12_high - s12_prime)) + (prod1_high - s12_prime);

    double result = s12_high + (prod1_low + prod2_low + s12_low);
    if (std::isnan(result) || result == 0.0) {
        result = a1 * b1 + a2 * b2;
    }
    return result;
}

static double gamma_q_continued_fraction(double a, double x, double epsilon, int max_iterations) {
    constexpr double small = 1.0e-50;
    auto cf_a = [a, x](int n) {
        return (2.0 * static_cast<double>(n) + 1.0) - a + x;
    };
    auto cf_b = [a](int n) {
        return static_cast<double>(n) * (a - static_cast<double>(n));
    };

    double h_prev = cf_a(0);
    if (std::abs(h_prev) <= small) {
        h_prev = small;
    }

    double d_prev = 0.0;
    double c_prev = h_prev;
    double h_n = h_prev;
    for (int n = 1; n < max_iterations; ++n) {
        const double a_n = cf_a(n);
        const double b_n = cf_b(n);

        double d_n = a_n + b_n * d_prev;
        if (std::abs(d_n) <= small) {
            d_n = small;
        }

        double c_n = a_n + b_n / c_prev;
        if (std::abs(c_n) <= small) {
            c_n = small;
        }

        d_n = 1.0 / d_n;
        const double delta_n = c_n * d_n;
        h_n = h_prev * delta_n;

        if (std::abs(delta_n - 1.0) < epsilon) {
            break;
        }

        d_prev = d_n;
        c_prev = c_n;
        h_prev = h_n;
    }

    return h_n;
}

static double regularized_gamma_p(double a, double x, double epsilon, int max_iterations);

static double regularized_gamma_q(double a, double x, double epsilon, int max_iterations) {
    if (std::isnan(a) || std::isnan(x) || a <= 0.0 || x < 0.0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    if (x == 0.0) {
        return 1.0;
    }
    if (x < a + 1.0) {
        return 1.0 - regularized_gamma_p(a, x, epsilon, max_iterations);
    }

    const double cf = gamma_q_continued_fraction(a, x, epsilon, max_iterations);
    return std::exp(-x + a * std::log(x) - std::lgamma(a)) / cf;
}

static double regularized_gamma_p(double a, double x, double epsilon, int max_iterations) {
    if (std::isnan(a) || std::isnan(x) || a <= 0.0 || x < 0.0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    if (x == 0.0) {
        return 0.0;
    }
    if (x >= a + 1.0) {
        return 1.0 - regularized_gamma_q(a, x, epsilon, max_iterations);
    }

    double n = 0.0;
    double an = 1.0 / a;
    double sum = an;
    while (std::abs(an / sum) > epsilon &&
           n < static_cast<double>(max_iterations) &&
           std::isfinite(sum)) {
        n += 1.0;
        an *= x / (a + n);
        sum += an;
    }

    if (std::isinf(sum)) {
        return 1.0;
    }

    return std::exp(-x + a * std::log(x) - std::lgamma(a)) * sum;
}

static double hipparchus_erf(double x) {
    if (std::abs(x) > 40.0) {
        return x > 0.0 ? 1.0 : -1.0;
    }

    const double ret = regularized_gamma_p(0.5, x * x, 1.0e-15, 10000);
    return x < 0.0 ? -ret : ret;
}

static OrekitPrincipalAxes orekit_principal_axes(const BPlaneGeometry& bp) {
    OrekitPrincipalAxes axes;

    double lambda_high, lambda_low;
    bp.eigenvalues(lambda_high, lambda_low);
    if (lambda_low <= 0.0 || lambda_high <= 0.0) {
        return axes;
    }

    axes.sigma_x = std::sqrt(lambda_low);
    axes.sigma_y = std::sqrt(lambda_high);

    double x_axis_x = 1.0;
    double x_axis_z = 0.0;
    if (std::abs(bp.sigma_xz) < 1.0e-30) {
        if (bp.sigma_xx > bp.sigma_zz) {
            x_axis_x = 0.0;
            x_axis_z = 1.0;
        }
    } else {
        x_axis_x = bp.sigma_xz;
        x_axis_z = lambda_low - bp.sigma_xx;
        double norm = std::hypot(x_axis_x, x_axis_z);
        if (norm < 1.0e-30) {
            x_axis_x = lambda_low - bp.sigma_zz;
            x_axis_z = bp.sigma_xz;
            norm = std::hypot(x_axis_x, x_axis_z);
        }
        if (norm >= 1.0e-30) {
            x_axis_x /= norm;
            x_axis_z /= norm;
        }
    }

    const double y_axis_x = -x_axis_z;
    const double y_axis_z = x_axis_x;
    axes.xm = x_axis_x * bp.xi + x_axis_z * bp.zeta;
    axes.ym = y_axis_x * bp.xi + y_axis_z * bp.zeta;

    return axes;
}

static int alfano2005_order(double xm, double ym, double sigma_x, double sigma_y, double radius) {
    const double denominator = std::min({sigma_x, sigma_y, std::hypot(xm, ym)});
    if (denominator <= 0.0 || !std::isfinite(denominator)) {
        return 100000;
    }

    const int order = static_cast<int>(5.0 * radius / denominator);
    return std::max(10, std::min(order, 100000));
}

static double alfano2005_recurrent_part(double x,
                                        double xm,
                                        double ym,
                                        double sigma_x,
                                        double sigma_y,
                                        double radius) {
    const double disk_height = std::sqrt(std::max(0.0, radius * radius - x * x));
    const double y_scale = 1.0 / (SQRT_2 * sigma_y);
    const double erf_difference = hipparchus_erf((-ym + disk_height) * y_scale) -
                                  hipparchus_erf((-ym - disk_height) * y_scale);
    const double x_variance_scale = 2.0 * sigma_x * sigma_x;
    return erf_difference *
           (std::exp(-square(x - xm) / x_variance_scale) +
            std::exp(-square(x + xm) / x_variance_scale));
}

// ============================================================================
// 1. Alfano Maximum Probability (AAS 03-548)
// ============================================================================

PcResult AlfanoMaxPc::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFANO-MAXPROB";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double d = bp.miss_distance();
    double Rc = bp.combined_radius;

    if (d < 1e-15 || Rc >= d) {
        r.probability = 1.0;
        r.max_probability = 1.0;
        return r;
    }

    // P_max = (Rc/d)² × e⁻¹
    r.probability = (Rc * Rc) / (d * d) * std::exp(-1.0);
    r.probability = std::min(r.probability, 1.0);
    r.max_probability = r.probability;
    return r;
}

// ============================================================================
// 2. Foster-Estes 2D Short-Encounter (1992)
// ============================================================================

PcResult Foster2D::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "FOSTER-2D";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        // Degenerate covariance — fall back to Alfano
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    // Rotate miss vector to principal axes
    double u, v;
    bp.rotated_miss(u, v);

    double Rc = bp.combined_radius;

    // P_c = (Rc² / (2σ₁σ₂)) × exp(-½(u²/σ₁² + v²/σ₂²))
    double Pc = (Rc * Rc) / (2.0 * s1 * s2) *
                std::exp(-0.5 * (u * u / (s1 * s1) + v * v / (s2 * s2)));

    r.probability = std::min(Pc, 1.0);

    // Also compute Alfano bound
    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// 3. Patera 2001 (Single-Integral Method)
// ============================================================================

PcResult Patera2001::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "PATERA-2001";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);

    double Rc = bp.combined_radius;

    // Direct 2D integration over the hard-body disk
    // using polar coordinates centered on the miss vector.
    // P_c = 1/(2πσ₁σ₂) ∫₀^Rc ∫₀^2π exp(-½((u+rcosθ)²/σ₁² + (v+rsinθ)²/σ₂²)) r dr dθ
    int Nr = std::max(8, n_quad_ / 8);
    int Ntheta = n_quad_;

    double sum = 0;
    double dr = Rc / Nr;
    double dtheta = TWO_PI / Ntheta;

    for (int ir = 0; ir < Nr; ir++) {
        double rc = (ir + 0.5) * dr;
        for (int it = 0; it < Ntheta; it++) {
            double theta = (it + 0.5) * dtheta;
            double px = u + rc * std::cos(theta);
            double py = v + rc * std::sin(theta);
            double md2 = px * px / (s1 * s1) + py * py / (s2 * s2);
            sum += rc * std::exp(-0.5 * md2);
        }
    }

    r.probability = sum * dr * dtheta / (TWO_PI * s1 * s2);
    r.probability = std::min(r.probability, 1.0);
    r.iterations = Nr * Ntheta;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// 4. Chan 1997 (Zeroth-Order Analytical Series)
// ============================================================================

PcResult Chan1997::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "CHAN-1997";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    double Rc = bp.combined_radius;

    // Orekit Chan1997 terms:
    //   u = R² / (σx σy)
    //   v = xm² / σx² + ym² / σy²
    // with the term count M recommended by Chan.
    const double chan_u = Rc * Rc / (s1 * s2);
    const double chan_v = (u * u / (s1 * s1)) + (v * v / (s2 * s2));
    int M;
    if (max_terms_ > 0) {
        M = max_terms_;
    } else if (chan_u <= 0.01 || chan_v <= 1.0) {
        M = 3;
    } else if ((chan_u > 0.01 && chan_u <= 1.0) ||
               (chan_v > 1.0 && chan_v <= 9.0)) {
        M = 10;
    } else if ((chan_u > 1.0 && chan_u <= 25.0) ||
               (chan_v > 9.0 && chan_v <= 25.0)) {
        M = 20;
    } else {
        M = 60;
    }

    double t = 1.0;
    double s = 1.0;
    double series_sum = 1.0;
    const double exp_v = std::exp(-0.5 * chan_v);
    const double exp_uv = std::exp(-0.5 * (chan_u + chan_v));

    double value = exp_v * t - exp_uv * t * series_sum;
    for (int i = 1; i < M; i++) {
        t *= (0.5 * chan_v) / static_cast<double>(i);
        s *= (0.5 * chan_u) / static_cast<double>(i);
        series_sum += s;
        value += exp_v * t - exp_uv * t * series_sum;
    }

    r.probability = std::min(std::max(value, 0.0), 1.0);
    r.converged = true;
    r.iterations = M;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// 5. Alfriend-Akella 1999 Constant-Density Approximation
// ============================================================================

PcResult Alfriend1999::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-1999";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    const double md2 = (u * u / (s1 * s1)) + (v * v / (s2 * s2));
    const double sqrt_det = s1 * s2;
    const double Rc = bp.combined_radius;

    const double pc = std::exp(-0.5 * md2) * Rc * Rc / (2.0 * sqrt_det);
    r.probability = std::min(std::max(pc, 0.0), 1.0);

    Alfriend1999Max max_method;
    r.max_probability = max_method.compute(bp).probability;

    return r;
}

// ============================================================================
// 6. Alfriend-Akella 1999 Maximum Probability
// ============================================================================

PcResult Alfriend1999Max::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-1999-MAX";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    const double md2 = (u * u / (s1 * s1)) + (v * v / (s2 * s2));
    const double sqrt_det = s1 * s2;
    const double Rc = bp.combined_radius;

    if (md2 <= 1e-30) {
        r.probability = 1.0;
    } else {
        const double pc = Rc * Rc / (md2 * sqrt_det * std::exp(1.0));
        r.probability = std::min(std::max(pc, 0.0), 1.0);
    }
    r.max_probability = r.probability;

    return r;
}

// ============================================================================
// 7. Alfano 2005 Numerical Integration
// ============================================================================

PcResult Alfano2005::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFANO-2005";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    const OrekitPrincipalAxes axes = orekit_principal_axes(bp);
    if (axes.sigma_x < 1e-30 || axes.sigma_y < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    const double xm = axes.xm;
    const double ym = axes.ym;
    const double sigma_x = axes.sigma_x;
    const double sigma_y = axes.sigma_y;
    const double radius = bp.combined_radius;
    const int order = alfano2005_order(xm, ym, sigma_x, sigma_y, radius);
    const double x_step = radius / (2.0 * static_cast<double>(order));

    const double m0_x = 0.015 * x_step - radius;
    const double m0 = 2.0 * alfano2005_recurrent_part(m0_x, xm, ym, sigma_x, sigma_y, radius);

    double even_sum = 0.0;
    for (int i = 1; i < order; ++i) {
        const double x = 2.0 * static_cast<double>(i) * x_step - radius;
        even_sum += alfano2005_recurrent_part(x, xm, ym, sigma_x, sigma_y, radius);
    }

    const double y_scale = 1.0 / (SQRT_2 * sigma_y);
    const double other_term = std::exp(-square(xm) / (2.0 * sigma_x * sigma_x)) *
                              (hipparchus_erf((-ym + radius) * y_scale) -
                               hipparchus_erf((-ym - radius) * y_scale));
    const double m_even = 2.0 * (even_sum + other_term);

    double odd_sum = 0.0;
    for (int i = 1; i <= order; ++i) {
        const double x = (2.0 * static_cast<double>(i) - 1.0) * x_step - radius;
        odd_sum += alfano2005_recurrent_part(x, xm, ym, sigma_x, sigma_y, radius);
    }
    const double m_odd = 4.0 * odd_sum;

    const double factor = x_step / (3.0 * sigma_x * std::sqrt(8.0 * PI));
    const double pc = factor * (m0 + m_even + m_odd);
    r.probability = std::min(std::max(pc, 0.0), 1.0);
    r.converged = true;
    r.iterations = order;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// 8. LAAS 2015 Recurrent Series
// ============================================================================

PcResult Laas2015::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "LAAS-2015";
    r.mahalanobis_2d = bp.mahalanobis_distance();

    const OrekitPrincipalAxes axes = orekit_principal_axes(bp);
    if (axes.sigma_x < 1e-30 || axes.sigma_y < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    const double xm = axes.xm;
    const double ym = axes.ym;
    const double sigma_x = axes.sigma_x;
    const double sigma_y = axes.sigma_y;
    const double radius = bp.combined_radius;

    const double xm_squared = xm * xm;
    const double ym_squared = ym * ym;
    const double sigma_x_sq = sigma_x * sigma_x;
    const double sigma_y_sq = sigma_y * sigma_y;
    const double radius_squared = radius * radius;

    const double p = 1.0 / (2.0 * sigma_x_sq);
    const double sigma_ratio = sigma_x / sigma_y;
    const double phi_y = 1.0 - sigma_ratio * sigma_ratio;
    const double omega_x = square(xm / (2.0 * sigma_x_sq));
    const double omega_y = square(ym / (2.0 * sigma_y_sq));
    const double omega_sum = omega_x + omega_y;
    const double big_omega = 0.5 * phi_y + omega_sum / p;

    const double alpha0 = 0.5 *
                          std::exp(-0.5 * (xm_squared / sigma_x_sq + ym_squared / sigma_y_sq)) /
                          (sigma_x * sigma_y);
    const double p_times_radius_squared = p * radius_squared;
    const double exp_minus_pr2 = std::exp(-p_times_radius_squared);
    const double l0 = alpha0 * (1.0 - exp_minus_pr2) / p;
    const double u0_temp = alpha0 *
                           (std::exp(p_times_radius_squared * big_omega) - exp_minus_pr2) /
                           (p * (1.0 + big_omega));
    const double u0 = std::min(std::max(u0_temp, 0.0), 1.0);
    r.lower_probability = std::min(std::max(l0, 0.0), 1.0);
    r.upper_probability = u0;

    if (r.upper_probability - r.lower_probability <= absolute_accuracy_) {
        r.probability = 0.5 * (r.upper_probability + r.lower_probability);
        r.converged = true;
        r.iterations = 0;
        AlfanoMaxPc alfano;
        r.max_probability = alfano.compute(bp).probability;
        return r;
    }

    const int n1 = static_cast<int>(2.0 * std::ceil(std::exp(1.0) * p_times_radius_squared * (1.0 + big_omega)));
    const double n2_inter = alpha0 * std::exp(p_times_radius_squared * big_omega) /
                            (absolute_accuracy_ * p * std::sqrt(TWO_PI * static_cast<double>(n1)) *
                             (1.0 + big_omega));
    const int n2 = static_cast<int>(std::ceil(std::log2(n2_inter)));
    int n_max = std::max(n1, n2) - 1;
    n_max = std::min(n_max, max_terms_);

    const double p_squared = p * p;
    const double p_cubed = p_squared * p;
    const double radius_fourth = radius_squared * radius_squared;
    const double radius_sixth = radius_fourth * radius_squared;
    const double phi_y_squared = phi_y * phi_y;
    const double p_phi_y = p * phi_y;
    const double p_sq_times_half_phi_sq_plus_one =
        p_squared * linear_combination(0.5, phi_y_squared, 1.0, 1.0);

    const double recurrent_term0 = linear_combination(0.5, phi_y, 1.0, 1.0);
    const double recurrent_term1 = linear_combination(p, recurrent_term0, 1.0, omega_sum);
    const double recurrent_term2 =
        linear_combination(1.0, p_sq_times_half_phi_sq_plus_one, 2.0, p_phi_y * omega_y);
    const double recurrent_term3 = recurrent_term1 * recurrent_term1;

    const double auxiliary_term0 = radius_sixth * p_cubed * phi_y_squared * omega_x;
    const double auxiliary_term1 = radius_fourth * p_squared * phi_y;
    const double auxiliary_term2 = 2.0 * omega_x * recurrent_term0;
    const double auxiliary_term3 =
        phi_y * linear_combination(2.0, omega_x, 1.5, p) + omega_sum;
    const double auxiliary_term4 = p_phi_y * recurrent_term0 * 2.0;
    const double auxiliary_term5 = p * (2.0 * phi_y + 1.0);

    double k_plus2 = 2.0;
    double k_plus3 = 3.0;
    double k_plus4 = 4.0;
    double k_plus5 = 5.0;
    double half_y = 2.5;

    double c0 = alpha0 * radius_squared;
    double c1 = c0 * radius_squared * 0.5 * recurrent_term1;
    double c2 = c0 * (radius_fourth / 12.0) * (recurrent_term3 + recurrent_term2);
    double c3 = c0 * (radius_sixth / 144.0) *
                (recurrent_term1 * (recurrent_term3 + 3.0 * recurrent_term2) +
                 2.0 * (p_cubed * (1.0 + phi_y_squared * phi_y * 0.5) +
                        3.0 * p_squared * phi_y_squared * omega_y));

    const double initial_coefficients[] = {c0, c1, c2, c3};
    double sum = 0.0;
    double rescaling_counter = 0.0;
    constexpr double scaling_threshold = 1.0e10;
    for (int i = 0; i < std::min(n_max, 4); ++i) {
        sum += initial_coefficients[i];
        if (sum > scaling_threshold) {
            rescaling_counter += std::log10(scaling_threshold);
            c0 /= scaling_threshold;
            c1 /= scaling_threshold;
            c2 /= scaling_threshold;
            c3 /= scaling_threshold;
            sum /= scaling_threshold;
        }
    }

    for (int k = 0; k < n_max - 4; ++k) {
        if (sum > scaling_threshold) {
            rescaling_counter += std::log10(scaling_threshold);
            c0 /= scaling_threshold;
            c1 /= scaling_threshold;
            c2 /= scaling_threshold;
            c3 /= scaling_threshold;
            sum /= scaling_threshold;
        }

        const double denominator = k_plus4 * k_plus3;
        double temp = c3 * linear_combination(1.0, recurrent_term1, k_plus3, auxiliary_term5);
        temp -= c2 * p_times_radius_squared *
                linear_combination(half_y, auxiliary_term4, 1.0, auxiliary_term3) / k_plus4;
        temp += c1 * auxiliary_term1 *
                linear_combination(half_y, p_phi_y, 1.0, auxiliary_term2) / denominator;
        temp -= c0 * auxiliary_term0 / (denominator * k_plus2);
        temp *= radius_squared / (k_plus4 * k_plus5);

        c0 = c1;
        c1 = c2;
        c2 = c3;
        c3 = temp;

        k_plus2 = k_plus3;
        k_plus3 = k_plus4;
        k_plus4 = k_plus5;
        k_plus5 += 1.0;
        half_y += 1.0;

        sum += c3;
    }

    const double pc = sum *
                      std::exp(linear_combination(std::log(10.0), rescaling_counter,
                                                  -p, radius_squared));
    r.probability = std::min(std::max(pc, 0.0), 1.0);
    r.converged = true;
    r.iterations = n_max;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// 9. Alfriend-Akella 2D Numerical Integration
// ============================================================================

PcResult Alfriend2D::compute(const BPlaneGeometry& bp) const {
    PcResult r;
    r.method = "ALFRIEND-2D";
    r.mahalanobis_2d = bp.mahalanobis_distance();
    double s1, s2;
    bp.eigen_sigmas(s1, s2);

    if (s1 < 1e-30 || s2 < 1e-30) {
        AlfanoMaxPc alfano;
        return alfano.compute(bp);
    }

    double u, v;
    bp.rotated_miss(u, v);
    double Rc = bp.combined_radius;

    // Direct 2D Gauss-Legendre over the hard-body disk
    // Using polar coordinates centered on the miss vector
    //
    // P_c = 1/(2πσ₁σ₂) ∫₀^Rc ∫₀^2π exp(-½((u+rcosθ)²/σ₁² + (v+rsinθ)²/σ₂²)) r dr dθ

    // Gauss-Legendre nodes for [0, Rc] (transformed from [-1,1])
    // For simplicity, use midpoint rule with sufficient density
    double sum = 0;
    double dr = Rc / n_r_;
    double dtheta = TWO_PI / n_theta_;

    for (int ir = 0; ir < n_r_; ir++) {
        double rc = (ir + 0.5) * dr;
        for (int it = 0; it < n_theta_; it++) {
            double theta = (it + 0.5) * dtheta;
            double px = u + rc * std::cos(theta);
            double py = v + rc * std::sin(theta);
            double md2 = px * px / (s1 * s1) + py * py / (s2 * s2);
            sum += rc * std::exp(-0.5 * md2);
        }
    }

    r.probability = sum * dr * dtheta / (TWO_PI * s1 * s2);
    r.probability = std::min(r.probability, 1.0);
    r.iterations = n_r_ * n_theta_;

    AlfanoMaxPc alfano;
    r.max_probability = alfano.compute(bp).probability;

    return r;
}

// ============================================================================
// Factory
// ============================================================================

std::unique_ptr<PcMethod> create_pc_method(const std::string& name) {
    if (name == "alfano" || name == "ALFANO-MAXPROB") return std::make_unique<AlfanoMaxPc>();
    if (name == "foster" || name == "FOSTER-2D") return std::make_unique<Foster2D>();
    if (name == "patera" || name == "PATERA-2001") return std::make_unique<Patera2001>(512);
    if (name == "chan" || name == "CHAN-1997" || name == "CHAN-2008") {
        return std::make_unique<Chan1997>();
    }
    if (name == "alfriend1999" || name == "alfriend-1999" ||
        name == "ALFRIEND-1999" || name == "ALFRIEND_1999") {
        return std::make_unique<Alfriend1999>();
    }
    if (name == "alfriend1999max" || name == "alfriend-1999-max" ||
        name == "ALFRIEND-1999-MAX" || name == "ALFRIEND_1999_MAX") {
        return std::make_unique<Alfriend1999Max>();
    }
    if (name == "alfano2005" || name == "alfano-2005" ||
        name == "ALFANO-2005" || name == "ALFANO_2005") {
        return std::make_unique<Alfano2005>();
    }
    if (name == "laas2015" || name == "laas-2015" ||
        name == "LAAS-2015" || name == "LAAS_2015") {
        return std::make_unique<Laas2015>();
    }
    if (name == "alfriend" || name == "ALFRIEND-2D") return std::make_unique<Alfriend2D>();
    // Default: Foster (industry standard)
    return std::make_unique<Foster2D>();
}

} // namespace conjunction
