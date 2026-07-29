#include "lambert.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace star_search {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kSnapEps = 1e-7;

double sign_value(double value) {
    if (value > 0.0) {
        return 1.0;
    }
    if (value < 0.0) {
        return -1.0;
    }
    return 0.0;
}

double safe_div(double numerator, double denominator, double eps = 1e-15) {
    if (std::abs(denominator) < eps) {
        denominator = denominator >= 0.0 ? eps : -eps;
    }
    return numerator / denominator;
}

double clipped(double value, double lower, double upper) {
    return value < lower ? lower : (value > upper ? upper : value);
}

bool table7_w(double k, int revolutions, double* output) {
    const double sqrt2 = std::sqrt(2.0);
    if (std::abs(k - (-1.0 - 2.0 * sqrt2) / 3.0) <= kSnapEps) {
        *output = 27.25239909 + 27.75304668 * revolutions;
        return true;
    }
    if (std::abs(k + 1.0) <= kSnapEps) {
        *output = 5.71238898 + 2.0 * kPi * revolutions;
        return true;
    }
    if (std::abs(k + 0.5) <= kSnapEps) {
        *output = 1.95494660 + 2.71408094 * revolutions;
        return true;
    }
    if (std::abs(k) <= kSnapEps) {
        *output = (sqrt2 / 4.0) * (kPi + 2.0 * kPi * revolutions);
        return true;
    }
    if (std::abs(k - 0.5) <= kSnapEps) {
        *output = 0.75913433 + 2.71408094 * revolutions;
        return true;
    }
    if (std::abs(k - 1.0) <= kSnapEps) {
        *output = 0.57079632 + 2.0 * kPi * revolutions;
        return true;
    }
    if (std::abs(k - sqrt2) <= kSnapEps) {
        *output = 0.50064759 + 27.75304668 * revolutions;
        return true;
    }
    return false;
}

double tof_from_k(
    double k,
    double tau,
    double scale_s,
    int revolutions,
    double series_eps) {
    double W = 0.0;
    if (!table7_w(k, revolutions, &W)) {
        double dW = 0.0;
        double ddW = 0.0;
        w_and_derivatives(k, revolutions, series_eps, 1e-12, &W, &dW, &ddW);
    }
    double sqrt_arg = 1.0 - k * tau;
    if (sqrt_arg < 0.0) {
        sqrt_arg = 0.0;
    }
    return scale_s * std::sqrt(sqrt_arg) * (tau + sqrt_arg * W);
}

void tof_and_derivative(
    double k,
    double tau,
    double scale_s,
    int revolutions,
    double series_eps,
    double* tof,
    double* derivative) {
    double W = 0.0;
    double dW = 0.0;
    double ddW = 0.0;
    w_and_derivatives(k, revolutions, series_eps, 1e-12, &W, &dW, &ddW);
    (void)ddW;
    const double c = safe_div(1.0 - k * tau, tau);
    const double sqrt_arg_1 = std::max(1.0 - k * tau, 0.0);
    *tof = scale_s * std::sqrt(sqrt_arg_1) * (tau + (1.0 - k * tau) * W);
    const double sqrt_arg_2 = std::max(c * tau, 0.0);
    *derivative =
        -safe_div(*tof, 2.0 * c) +
        scale_s * tau * std::sqrt(sqrt_arg_2) * (dW * c - W);
}

bool halley_solve(
    double seed,
    double tau,
    double scale_s,
    double target_tof,
    int revolutions,
    double series_eps,
    double tolerance,
    double* output) {
    const double sqrt2 = std::sqrt(2.0);
    double k = seed;
    if (!std::isfinite(k) || k <= -sqrt2) {
        *output = k;
        return false;
    }
    bool converged = false;
    for (int iteration = 0; iteration < 15; ++iteration) {
        double W = 0.0;
        double dW = 0.0;
        double ddW = 0.0;
        w_and_derivatives(k, revolutions, series_eps, 1e-12, &W, &dW, &ddW);
        const double c = safe_div(1.0 - k * tau, tau);
        const double sqrt_arg_1 = std::max(1.0 - k * tau, 0.0);
        const double tof_k =
            scale_s * std::sqrt(sqrt_arg_1) * (tau + (1.0 - k * tau) * W);
        const double residual = tof_k - target_tof;
        if (std::abs(residual) <= tolerance * std::max(1.0, std::abs(target_tof))) {
            converged = true;
            break;
        }
        const double sqrt_arg_2 = std::max(c * tau, 0.0);
        const double dT =
            -safe_div(tof_k, 2.0 * c) +
            scale_s * tau * std::sqrt(sqrt_arg_2) * (dW * c - W);
        const double ddT =
            -safe_div(tof_k, 4.0 * c * c) +
            scale_s * tau * std::sqrt(sqrt_arg_2) *
                (safe_div(W, c) + c * ddW - 3.0 * dW);
        const double denominator = dT - safe_div(residual * ddT, 2.0 * dT);
        const double delta = safe_div(residual, denominator);
        if (!std::isfinite(delta) || !std::isfinite(residual) || !std::isfinite(dT) ||
            !std::isfinite(ddT)) {
            break;
        }
        k -= delta;
        if (!std::isfinite(k) || k <= -sqrt2) {
            converged = false;
            break;
        }
    }
    *output = k;
    return converged;
}

bool minimize_tof(
    double seed,
    double tau,
    double scale_s,
    int revolutions,
    double series_eps,
    double tolerance,
    double* k_output,
    double* tof_output) {
    const double sqrt2 = std::sqrt(2.0);
    double k = seed;
    double tof_k = std::numeric_limits<double>::quiet_NaN();
    if (!std::isfinite(k) || k <= -sqrt2) {
        *k_output = k;
        *tof_output = tof_k;
        return false;
    }
    bool converged = false;
    for (int iteration = 0; iteration < 20; ++iteration) {
        double W = 0.0;
        double dW = 0.0;
        double ddW = 0.0;
        w_and_derivatives(k, revolutions, series_eps, 1e-12, &W, &dW, &ddW);
        const double c = safe_div(1.0 - k * tau, tau);
        const double sqrt_arg_1 = std::max(1.0 - k * tau, 0.0);
        tof_k = scale_s * std::sqrt(sqrt_arg_1) * (tau + (1.0 - k * tau) * W);
        const double sqrt_arg_2 = std::max(c * tau, 0.0);
        const double dT =
            -safe_div(tof_k, 2.0 * c) +
            scale_s * tau * std::sqrt(sqrt_arg_2) * (dW * c - W);
        const double ddT =
            -safe_div(tof_k, 4.0 * c * c) +
            scale_s * tau * std::sqrt(sqrt_arg_2) *
                (safe_div(W, c) + c * ddW - 3.0 * dW);
        if (std::abs(dT) <= tolerance * std::max(1.0, std::abs(tof_k))) {
            converged = true;
            break;
        }
        if (!std::isfinite(dT) || !std::isfinite(ddT)) {
            break;
        }
        const double delta = safe_div(dT, ddT);
        if (!std::isfinite(delta)) {
            break;
        }
        k -= delta;
        if (!std::isfinite(k) || k <= -sqrt2 || k >= sqrt2) {
            converged = false;
            break;
        }
    }
    *k_output = k;
    *tof_output = tof_k;
    return converged;
}

bool bracketed_solve(
    double seed,
    double lower,
    double upper,
    double tau,
    double scale_s,
    double target_tof,
    int revolutions,
    double series_eps,
    double tolerance,
    double* output) {
    const double sqrt2 = std::sqrt(2.0);
    if (lower > upper) {
        std::swap(lower, upper);
    }
    if (!std::isfinite(lower) || !std::isfinite(upper) || !std::isfinite(seed) ||
        lower >= upper) {
        *output = seed;
        return false;
    }
    lower = std::max(lower, -sqrt2 + 1e-12);
    upper = std::min(upper, sqrt2 - 1e-12);
    double tof_lower = 0.0;
    double derivative = 0.0;
    tof_and_derivative(
        lower, tau, scale_s, revolutions, series_eps, &tof_lower, &derivative);
    double tof_upper = 0.0;
    tof_and_derivative(
        upper, tau, scale_s, revolutions, series_eps, &tof_upper, &derivative);
    double f_lower = tof_lower - target_tof;
    double f_upper = tof_upper - target_tof;
    if (!std::isfinite(f_lower) || !std::isfinite(f_upper)) {
        *output = seed;
        return false;
    }
    const double threshold = tolerance * std::max(1.0, std::abs(target_tof));
    if (std::abs(f_lower) <= threshold) {
        *output = lower;
        return true;
    }
    if (std::abs(f_upper) <= threshold) {
        *output = upper;
        return true;
    }
    if (f_lower * f_upper > 0.0) {
        *output = seed;
        return false;
    }

    double k = seed;
    if (!std::isfinite(k) || k <= lower || k >= upper) {
        k = 0.5 * (lower + upper);
    }
    double tof_k = 0.0;
    double dT = 0.0;
    tof_and_derivative(k, tau, scale_s, revolutions, series_eps, &tof_k, &dT);
    double f = tof_k - target_tof;
    if (!std::isfinite(f)) {
        k = 0.5 * (lower + upper);
        tof_and_derivative(k, tau, scale_s, revolutions, series_eps, &tof_k, &dT);
        f = tof_k - target_tof;
    }

    bool converged = false;
    for (int iteration = 0; iteration < 40; ++iteration) {
        if (std::abs(f) <= threshold) {
            converged = true;
            break;
        }
        double next = std::numeric_limits<double>::quiet_NaN();
        if (std::isfinite(dT) && std::abs(dT) > 1e-15) {
            next = k - f / dT;
        }
        if (!std::isfinite(next) || next <= lower || next >= upper) {
            next = 0.5 * (lower + upper);
        }
        double tof_next = 0.0;
        double dT_next = 0.0;
        tof_and_derivative(
            next, tau, scale_s, revolutions, series_eps, &tof_next, &dT_next);
        double f_next = tof_next - target_tof;
        if (!std::isfinite(f_next)) {
            next = 0.5 * (lower + upper);
            tof_and_derivative(
                next, tau, scale_s, revolutions, series_eps, &tof_next, &dT_next);
            f_next = tof_next - target_tof;
            if (!std::isfinite(f_next)) {
                break;
            }
        }
        if (f_lower * f_next <= 0.0) {
            upper = next;
            f_upper = f_next;
        } else {
            lower = next;
            f_lower = f_next;
        }
        (void)f_upper;
        k = next;
        f = f_next;
        dT = dT_next;
    }
    *output = k;
    return converged;
}

bool equation44(
    double normal_k,
    double terminal_k,
    double intermediate_k,
    double Z,
    double alpha,
    double F0,
    double F1,
    double Fi,
    double target,
    bool inverse,
    double* seed,
    double* lower,
    double* upper) {
    if (inverse) {
        F0 = safe_div(1.0, F0);
        F1 = safe_div(1.0, F1);
        Fi = safe_div(1.0, Fi);
        target = safe_div(1.0, target);
    }
    const double numerator = Z * (F0 - target) * (F1 - Fi);
    const double denominator =
        (Fi - target) * (F1 - F0) * Z + (F0 - Fi) * (F1 - target);
    double ratio = safe_div(numerator, denominator);
    ratio = clipped(ratio, 0.0, 1.0);
    const double x = std::pow(ratio, 1.0 / alpha);
    *seed = normal_k + (terminal_k - normal_k) * x;
    *lower = std::min(normal_k, terminal_k);
    *upper = std::max(normal_k, terminal_k);
    return std::isfinite(*seed) && std::isfinite(intermediate_k);
}

bool zero_rev_seed(
    double tau,
    double scale_s,
    double target,
    int hz,
    double Tp,
    double series_eps,
    double* seed) {
    const double sqrt2 = std::sqrt(2.0);
    const bool elliptic = target > Tp;
    if (!elliptic) {
        const double T20 =
            scale_s * std::sqrt(std::max(1.0 - 20.0 * tau, 0.0)) *
            (tau + 0.04940968903 * (1.0 - 20.0 * tau));
        const double T100 =
            scale_s * std::sqrt(std::max(1.0 - 100.0 * tau, 0.0)) *
            (tau + 0.00999209404 * (1.0 - 100.0 * tau));
        if (hz > 0) {
            const double kn = sqrt2;
            const double km = safe_div(1.0, tau, 1e-12);
            const double ki = std::max(0.5 * (kn + km), -sqrt2 + 1e-12);
            double W = 0.0;
            double dW = 0.0;
            double ddW = 0.0;
            w_and_derivatives(ki, 0, series_eps, 1e-12, &W, &dW, &ddW);
            const double root = std::max(1.0 - ki * tau, 0.0);
            const double Fi = scale_s * std::sqrt(root) * (tau + root * W);
            const double Z = 1.0 / sqrt2;
            const double numerator = Z * (Tp - target) * (0.0 - Fi);
            const double denominator =
                (Fi - target) * (0.0 - Tp) * Z + (Tp - Fi) * (0.0 - target);
            const double x = std::pow(numerator / denominator, 2.0);
            *seed = kn + (km - kn) * x;
        } else if (target >= T20) {
            const double kn = sqrt2;
            const double km = 20.0;
            const double ki = (2.0 * sqrt2 + 20.0) / 3.0;
            double W = 0.0;
            double dW = 0.0;
            double ddW = 0.0;
            w_and_derivatives(ki, 0, series_eps, 1e-12, &W, &dW, &ddW);
            const double root = std::max(1.0 - ki * tau, 0.0);
            const double Fi = scale_s * std::sqrt(root) * (tau + root * W);
            const double Z = 1.0 / 3.0;
            const double numerator = Z * (Tp - target) * (T20 - Fi);
            const double denominator =
                (Fi - target) * (T20 - Tp) * Z + (Tp - Fi) * (T20 - target);
            *seed = kn + (km - kn) * (numerator / denominator);
        } else {
            const double numerator =
                T100 * (T20 - target) * 10.0 -
                T20 * std::sqrt(20.0) * (T100 - target);
            const double denominator = target * (T20 - T100);
            *seed = std::pow(numerator / denominator, 2.0);
        }
        return std::isfinite(*seed);
    }

    const double k_values[5] = {-1.41, -1.38, -1.0, -0.5, 1.0 / sqrt2};
    const double w_values[5] = {
        4839.684497246, 212.087279879, 5.712388981, 1.954946607, 0.6686397730};
    double T[5]{};
    for (std::size_t index = 0U; index < 5U; ++index) {
        const double root = std::max(1.0 - k_values[index] * tau, 0.0);
        T[index] = scale_s * std::sqrt(root) * (tau + root * w_values[index]);
    }
    const double T0 = scale_s * (sqrt2 / 4.0 * kPi + tau);
    if (!(target < T[0])) {
        return false;
    }
    if (target <= T0) {
        const double numerator = 0.5 * (T0 - target) * (Tp - T[4]);
        const double denominator =
            (T[4] - target) * (Tp - T0) * 0.5 + (T0 - T[4]) * (Tp - target);
        const double x = clipped(safe_div(numerator, denominator), 0.0, 1.0);
        *seed = sqrt2 * x;
    } else if (target < T[2] && target > T0) {
        const double numerator = 0.5 * (T0 - target) * (T[2] - T[3]);
        const double denominator =
            (T[3] - target) * (T[2] - T0) * 0.5 + (T0 - T[3]) * (T[2] - target);
        const double x = clipped(safe_div(numerator, denominator), 0.0, 1.0);
        *seed = -x;
    } else if (target < T[1] && target > T[2]) {
        const double c1 = 540649.0 / 3125.0;
        const double c2 = 256.0;
        const double c3 = 1.0;
        const double c4 = 1.0;
        const double Fn = safe_div(1.0, T[2]);
        const double Fi = safe_div(1.0, T[1]);
        const double Fs = safe_div(1.0, target);
        const double g1 = Fi * (Fs - Fn);
        const double g2 = Fs * (Fn - Fi);
        const double g3 = Fn * (Fs - Fi);
        *seed = -c4 * std::pow(
                          safe_div(
                              (g1 * c1 - c3 * g3) * c2 + c3 * c1 * g2,
                              g3 * c1 - c3 * g1 - g2 * c2),
                          1.0 / 16.0);
    } else if (target < T[0] && target > T[1]) {
        const double c1 = 49267.0 / 27059.0;
        const double c2 = 67286.0 / 17897.0;
        const double c3 = 2813.0 / 287443.0;
        const double c4 = 4439.0 / 3156.0;
        const double Fn = safe_div(1.0, T[1]);
        const double Fi = safe_div(1.0, T[0]);
        const double Fs = safe_div(1.0, target);
        const double g1 = Fi * (Fs - Fn);
        const double g2 = Fs * (Fn - Fi);
        const double g3 = Fn * (Fs - Fi);
        *seed = -c4 * std::pow(
                          safe_div(
                              (g1 * c1 - c3 * g3) * c2 + c3 * c1 * g2,
                              g3 * c1 - c3 * g1 - g2 * c2),
                          1.0 / 243.0);
    } else {
        return false;
    }
    return std::isfinite(*seed);
}

bool multi_rev_seed(
    double tau,
    double scale_s,
    double target,
    int revolutions,
    int branch_sign,
    double series_eps,
    double tolerance,
    double* seed,
    double* lower,
    double* upper) {
    static const double eb_table[20] = {
        2.848574, 2.969742, 3.019580, 3.046927, 3.064234,
        3.076182, 3.084929, 3.091610, 3.096880, 3.101145,
        3.104666, 3.107623, 3.110142, 3.112312, 3.114203,
        3.115864, 3.117335, 3.118646, 3.119824, 3.120886,
    };
    const double sqrt2 = std::sqrt(2.0);
    const double v2 = revolutions <= 20 ? eb_table[revolutions - 1] : kPi;
    const double abs_tau = std::abs(tau);
    const double denominator = std::max(v2 * (sqrt2 - 2.0 * abs_tau), 1e-12);
    const double v1 = 8.0 * abs_tau / denominator;
    const double tau_sign = tau >= 0.0 ? 1.0 : -1.0;
    const double eb_tilde =
        v2 * (1.0 - tau_sign) +
        v2 * tau_sign * std::pow(1.0 / (1.0 + v1), 0.25);
    double kb =
        sign_value(kPi - eb_tilde) * std::sqrt(std::max(std::cos(eb_tilde) + 1.0, 0.0));
    kb = clipped(kb, -sqrt2 + 1e-10, sqrt2 - 1e-10);
    double Tb = tof_from_k(kb, tau, scale_s, revolutions, series_eps);
    if (target < Tb && target >= 0.8 * Tb) {
        double refined_k = kb;
        double refined_t = Tb;
        if (minimize_tof(
                kb,
                tau,
                scale_s,
                revolutions,
                series_eps,
                tolerance,
                &refined_k,
                &refined_t)) {
            kb = refined_k;
            Tb = refined_t;
        }
    }
    if (!(target >= Tb * (1.0 + 1e-6))) {
        return false;
    }

    const double Tm1 = tof_from_k(-1.0, tau, scale_s, revolutions, series_eps);
    const double T0 = tof_from_k(0.0, tau, scale_s, revolutions, series_eps);
    const double T1 = tof_from_k(1.0, tau, scale_s, revolutions, series_eps);
    const bool long_period = branch_sign > 0;
    const bool M1 = kb >= 1.0;
    const bool M2 = kb >= 0.0 && kb < 1.0;
    const bool M3 = kb >= -1.0 && kb < 0.0;
    const bool M4 = kb < -1.0;
    const double lp_target = (1.0 + 2.0 * sqrt2) / 3.0;
    const double sp_target = (-1.0 - 2.0 * sqrt2) / 3.0;
    const double alpha_mid = 6.0 / 5.0;
    const double z_mid = std::pow(0.5, alpha_mid);

    double kn = std::numeric_limits<double>::quiet_NaN();
    double km = kn;
    double ki = kn;
    double Z = kn;
    double alpha = kn;
    double F0 = kn;
    double F1 = kn;
    bool inverse = false;

    if (long_period) {
        if (M1) {
            kn = kb;
            km = sqrt2;
            ki = 0.5 * (kb + sqrt2);
            Z = 0.25;
            alpha = 2.0;
            F0 = Tb;
            F1 = 0.0;
            inverse = true;
        } else if (M2) {
            if (target > T1) {
                kn = 1.0;
                km = sqrt2;
                ki = lp_target;
                Z = 4.0 / 9.0;
                alpha = 2.0;
                F0 = T1;
                F1 = 0.0;
                inverse = true;
            } else {
                kn = kb;
                km = 1.0;
                ki = 0.5 * (1.0 + kb);
                Z = 0.25;
                alpha = 2.0;
                F0 = Tb;
                F1 = T1;
            }
        } else if (M3 || M4) {
            if (target <= T0) {
                kn = kb;
                km = 0.0;
                ki = 0.5 * kb;
                Z = 0.25;
                alpha = 2.0;
                F0 = Tb;
                F1 = T0;
            } else if (target <= T1) {
                kn = 0.0;
                km = 1.0;
                ki = 0.5;
                Z = z_mid;
                alpha = alpha_mid;
                F0 = T0;
                F1 = T1;
            } else {
                kn = 1.0;
                km = sqrt2;
                ki = lp_target;
                Z = 4.0 / 9.0;
                alpha = 2.0;
                F0 = T1;
                F1 = 0.0;
                inverse = true;
            }
        }
    } else {
        if (M1 || M2) {
            if (target <= T0) {
                kn = 0.0;
                km = kb;
                ki = 0.5 * kb;
                Z = z_mid;
                alpha = alpha_mid;
                F0 = T0;
                F1 = Tb;
            } else if (target <= Tm1) {
                kn = -1.0;
                km = 0.0;
                ki = -0.5;
                Z = 0.5;
                alpha = 1.0;
                F0 = Tm1;
                F1 = T0;
            } else {
                kn = -1.0;
                km = -sqrt2;
                ki = sp_target;
                Z = 4.0 / 9.0;
                alpha = 2.0;
                F0 = Tm1;
                F1 = 0.0;
                inverse = true;
            }
        } else if (M4) {
            kn = kb;
            km = -sqrt2;
            ki = 0.5 * (kb - sqrt2);
            Z = 0.25;
            alpha = 2.0;
            F0 = Tb;
            F1 = 0.0;
            inverse = true;
        } else if (M3) {
            if (target > Tm1) {
                kn = -1.0;
                km = -sqrt2;
                ki = sp_target;
                Z = 4.0 / 9.0;
                alpha = 2.0;
                F0 = Tm1;
                F1 = 0.0;
                inverse = true;
            } else {
                kn = kb;
                km = -1.0;
                ki = 0.5 * (-1.0 + kb);
                Z = 0.25;
                alpha = 2.0;
                F0 = Tb;
                F1 = Tm1;
            }
        }
    }
    if (!std::isfinite(kn)) {
        return false;
    }
    const double Fi = tof_from_k(ki, tau, scale_s, revolutions, series_eps);
    return equation44(kn, km, ki, Z, alpha, F0, F1, Fi, target, inverse, seed, lower, upper);
}

struct ExpandedTask {
    std::size_t input_index;
    int internal_hz;
    int nrev_signed;
};

struct WorkResult {
    bool valid;
    LambertSolution solution;
};

bool solve_expanded(
    const LambertInput& input,
    const ExpandedTask& task,
    double mu,
    double hz_tolerance,
    double series_eps,
    double tolerance,
    LambertSolution* output) {
    const int revolutions = std::abs(task.nrev_signed);
    const Vec3 cross12 = cross(input.r1_km, input.r2_km);
    const double r1_norm = norm(input.r1_km);
    const double r2_norm = norm(input.r2_km);
    if (!(r1_norm > 0.0) || !(r2_norm > 0.0) || !(input.tof_s > 0.0) ||
        !(mu > 0.0)) {
        return false;
    }
    const double theta = std::atan2(norm(cross12), dot(input.r1_km, input.r2_km));
    const double tau_abs =
        std::sqrt((r1_norm * r2_norm) * (1.0 + std::cos(theta))) / (r1_norm + r2_norm);
    const double scale_s = std::sqrt(std::pow(r1_norm + r2_norm, 3.0) / mu);
    const double tau = task.internal_hz * tau_abs;
    const double sqrt2 = std::sqrt(2.0);
    const double Tp =
        scale_s * std::sqrt(std::max(1.0 - sqrt2 * tau, 0.0)) * (tau + sqrt2) / 3.0;

    double seed = std::numeric_limits<double>::quiet_NaN();
    double lower = std::numeric_limits<double>::quiet_NaN();
    double upper = std::numeric_limits<double>::quiet_NaN();
    bool have_seed = false;
    if (revolutions == 0) {
        have_seed = zero_rev_seed(
            tau,
            scale_s,
            input.tof_s,
            task.internal_hz,
            Tp,
            series_eps,
            &seed);
    } else if (input.tof_s > Tp) {
        have_seed = multi_rev_seed(
            tau,
            scale_s,
            input.tof_s,
            revolutions,
            task.nrev_signed >= 0 ? 1 : -1,
            series_eps,
            tolerance,
            &seed,
            &lower,
            &upper);
    }
    if (!have_seed) {
        return false;
    }

    double k = seed;
    bool converged = halley_solve(
        seed,
        tau,
        scale_s,
        input.tof_s,
        revolutions,
        series_eps,
        tolerance,
        &k);
    if (!converged && revolutions > 0) {
        converged = bracketed_solve(
            seed,
            lower,
            upper,
            tau,
            scale_s,
            input.tof_s,
            revolutions,
            series_eps,
            tolerance,
            &k);
    }
    if (!converged) {
        return false;
    }

    const double sqrt_arg = std::max(1.0 - k * tau, 0.0);
    const double f = 1.0 - (r1_norm + r2_norm) * (1.0 - k * tau) / r1_norm;
    const double gdot = 1.0 - (r1_norm + r2_norm) * (1.0 - k * tau) / r2_norm;
    const double g = scale_s * tau * std::sqrt(sqrt_arg);
    if (!std::isfinite(f) || !std::isfinite(gdot) || !std::isfinite(g) ||
        std::abs(g) <= 1e-15) {
        return false;
    }
    const Vec3 v1 = scale(subtract(input.r2_km, scale(input.r1_km, f)), 1.0 / g);
    const Vec3 v2 = scale(subtract(scale(input.r2_km, gdot), input.r1_km), 1.0 / g);
    if (!std::isfinite(v1.x) || !std::isfinite(v1.y) || !std::isfinite(v1.z) ||
        !std::isfinite(v2.x) || !std::isfinite(v2.y) || !std::isfinite(v2.z)) {
        return false;
    }

    const double angular_z = cross(input.r1_km, v1).z;
    if ((input.hz == 1 && !(angular_z > hz_tolerance)) ||
        (input.hz == -1 && !(angular_z < -hz_tolerance))) {
        return false;
    }
    const double energy = 0.5 * dot(v1, v1) - mu / r1_norm;
    const double axis =
        std::abs(energy) > 1e-14 ? -mu / (2.0 * energy) : std::numeric_limits<double>::infinity();
    *output = LambertSolution{v1, v2, axis, task.nrev_signed, task.input_index};
    return true;
}

struct WorkerContext {
    const LambertInput* inputs;
    const ExpandedTask* tasks;
    WorkResult* results;
    double mu;
    double hz_tolerance;
    double series_eps;
    double tolerance;
};

void solve_range(std::size_t begin, std::size_t end, void* raw) {
    WorkerContext* context = static_cast<WorkerContext*>(raw);
    for (std::size_t row = begin; row < end; ++row) {
        context->results[row].valid = solve_expanded(
            context->inputs[context->tasks[row].input_index],
            context->tasks[row],
            context->mu,
            context->hz_tolerance,
            context->series_eps,
            context->tolerance,
            &context->results[row].solution);
    }
}

bool route_plus(const LambertInput& input, double hz_tolerance) {
    const double geometry_z = cross(input.r1_km, input.r2_km).z;
    const bool positive = geometry_z > hz_tolerance;
    const bool negative = geometry_z < -hz_tolerance;
    const bool ambiguous = !positive && !negative;
    return input.hz == 0 || (input.hz == 1 && positive) ||
           (input.hz == -1 && negative) || (input.hz != 0 && ambiguous);
}

bool route_minus(const LambertInput& input, double hz_tolerance) {
    const double geometry_z = cross(input.r1_km, input.r2_km).z;
    const bool positive = geometry_z > hz_tolerance;
    const bool negative = geometry_z < -hz_tolerance;
    const bool ambiguous = !positive && !negative;
    return input.hz == 0 || (input.hz == 1 && negative) ||
           (input.hz == -1 && positive) || (input.hz != 0 && ambiguous);
}

Status append_block(
    const LambertInput* inputs,
    std::size_t input_count,
    int internal_hz,
    int nrev_signed,
    double hz_tolerance,
    std::size_t row_cap,
    MemoryBudget* budget,
    Buffer<ExpandedTask>* tasks) {
    for (std::size_t index = 0U; index < input_count; ++index) {
        const bool routed = internal_hz > 0 ? route_plus(inputs[index], hz_tolerance)
                                           : route_minus(inputs[index], hz_tolerance);
        if (routed) {
            const ExpandedTask task{index, internal_hz, nrev_signed};
            const Status status = tasks->push_back(task, row_cap, budget);
            if (status != Status::Ok) {
                return status;
            }
        }
    }
    return Status::Ok;
}

}  // namespace

void w_and_derivatives(
    double k,
    int revolutions,
    double series_eps,
    double delta_m,
    double* W,
    double* dW,
    double* ddW) {
    const double sqrt2 = std::sqrt(2.0);
    const double m = 2.0 - k * k;
    const bool use_series =
        revolutions == 0 && std::abs(k - sqrt2) <= series_eps;
    const bool use_small_k = std::abs(k) < 1e-3;
    const bool elliptic =
        k < sqrt2 - series_eps && !use_series && !use_small_k;
    const bool hyperbolic =
        k > sqrt2 + series_eps && !use_series && !use_small_k;

    if (elliptic || (!hyperbolic && !use_series && !use_small_k)) {
        const double positive_m = m > delta_m ? m : delta_m;
        const double argument = clipped(1.0 - positive_m, -1.0, 1.0);
        const double denominator = std::sqrt(positive_m * positive_m * positive_m);
        const double sign = sign_value(k);
        *W =
            (((1.0 - sign) * kPi + sign * std::acos(argument) +
              2.0 * kPi * revolutions) /
             denominator) -
            k / positive_m;
        *dW = (-2.0 + 3.0 * *W * k) / positive_m;
        *ddW = (5.0 * *dW * k + 3.0 * *W) / positive_m;
        return;
    }
    if (hyperbolic) {
        const double magnitude = -m > delta_m ? -m : delta_m;
        const double argument = std::max(1.0 - m, 1.0);
        const double denominator = magnitude * std::sqrt(magnitude);
        *W = -std::acosh(argument) / denominator - k / m;
        *dW = (-2.0 + 3.0 * *W * k) / m;
        *ddW = (5.0 * *dW * k + 3.0 * *W) / m;
        return;
    }
    if (use_series) {
        const double v = k - sqrt2;
        *W =
            sqrt2 / 3.0 - v / 5.0 + 2.0 * sqrt2 / 35.0 * std::pow(v, 2.0) -
            2.0 / 63.0 * std::pow(v, 3.0) +
            2.0 * sqrt2 / 231.0 * std::pow(v, 4.0) -
            2.0 / 429.0 * std::pow(v, 5.0) +
            8.0 * sqrt2 / 6435.0 * std::pow(v, 6.0) -
            8.0 / 12155.0 * std::pow(v, 7.0) +
            8.0 * sqrt2 / 46189.0 * std::pow(v, 8.0);
        *dW =
            -1.0 / 5.0 + 4.0 * sqrt2 / 35.0 * v -
            6.0 / 63.0 * std::pow(v, 2.0) +
            8.0 * sqrt2 / 231.0 * std::pow(v, 3.0) -
            10.0 / 429.0 * std::pow(v, 4.0) +
            48.0 * sqrt2 / 6435.0 * std::pow(v, 5.0) -
            56.0 / 12155.0 * std::pow(v, 6.0) +
            64.0 * sqrt2 / 46189.0 * std::pow(v, 7.0);
        *ddW =
            4.0 / 35.0 - 12.0 / 63.0 * v +
            24.0 / 231.0 * std::pow(v, 2.0) -
            40.0 / 429.0 * std::pow(v, 3.0) +
            240.0 / 6435.0 * std::pow(v, 4.0) -
            336.0 / 12155.0 * std::pow(v, 5.0) +
            448.0 / 46189.0 * std::pow(v, 6.0);
        return;
    }

    const double coefficient = 2.0 * revolutions * kPi + kPi;
    *W =
        coefficient / 4.0 * sqrt2 - k +
        3.0 * coefficient / 16.0 * sqrt2 * std::pow(k, 2.0) -
        2.0 / 3.0 * std::pow(k, 3.0) +
        15.0 / 128.0 * coefficient * sqrt2 * std::pow(k, 4.0) -
        2.0 / 5.0 * std::pow(k, 5.0);
    *dW =
        -1.0 + 3.0 * coefficient / 8.0 * sqrt2 * k -
        2.0 * std::pow(k, 2.0) +
        15.0 / 32.0 * coefficient * sqrt2 * std::pow(k, 3.0) -
        2.0 * std::pow(k, 4.0);
    *ddW =
        3.0 * coefficient / 8.0 * sqrt2 - 4.0 * k +
        45.0 / 32.0 * coefficient * sqrt2 * std::pow(k, 2.0) -
        8.0 * std::pow(k, 3.0);
}

Status lambert_batch(
    const LambertInput* inputs,
    std::size_t input_count,
    double mu,
    int nrev_max,
    bool sweep_revolutions,
    double hz_tolerance,
    double series_eps,
    double tolerance,
    const ThreadOptions& thread_options,
    std::size_t row_cap,
    MemoryBudget* budget,
    Buffer<LambertSolution>* output) {
    if ((input_count > 0U && inputs == nullptr) || output == nullptr || budget == nullptr ||
        !(mu > 0.0) || nrev_max < 0 || hz_tolerance < 0.0 || row_cap == 0U) {
        return Status::InvalidInput;
    }
    output->clear();
    Buffer<ExpandedTask> tasks;
    const int first_revolution = sweep_revolutions ? 0 : nrev_max;
    for (int revolution = first_revolution; revolution <= nrev_max; ++revolution) {
        Status status = Status::Ok;
        if (revolution == 0) {
            status = append_block(
                inputs,
                input_count,
                1,
                0,
                hz_tolerance,
                row_cap,
                budget,
                &tasks);
            if (status == Status::Ok) {
                status = append_block(
                    inputs,
                    input_count,
                    -1,
                    0,
                    hz_tolerance,
                    row_cap,
                    budget,
                    &tasks);
            }
        } else {
            status = append_block(
                inputs,
                input_count,
                1,
                revolution,
                hz_tolerance,
                row_cap,
                budget,
                &tasks);
            if (status == Status::Ok) {
                status = append_block(
                    inputs,
                    input_count,
                    1,
                    -revolution,
                    hz_tolerance,
                    row_cap,
                    budget,
                    &tasks);
            }
            if (status == Status::Ok) {
                status = append_block(
                    inputs,
                    input_count,
                    -1,
                    revolution,
                    hz_tolerance,
                    row_cap,
                    budget,
                    &tasks);
            }
            if (status == Status::Ok) {
                status = append_block(
                    inputs,
                    input_count,
                    -1,
                    -revolution,
                    hz_tolerance,
                    row_cap,
                    budget,
                    &tasks);
            }
        }
        if (status != Status::Ok) {
            return status;
        }
        if (!sweep_revolutions) {
            break;
        }
    }
    if (tasks.empty()) {
        return Status::Ok;
    }

    Buffer<WorkResult> results;
    Status status = results.resize(tasks.size(), budget);
    if (status != Status::Ok) {
        return status;
    }
    WorkerContext context{
        inputs,
        tasks.data(),
        results.data(),
        mu,
        hz_tolerance,
        series_eps,
        tolerance,
    };
    status = parallel_for_fixed(tasks.size(), thread_options, solve_range, &context);
    if (status != Status::Ok) {
        return status;
    }
    for (std::size_t row = 0U; row < results.size(); ++row) {
        if (results[row].valid) {
            status = output->push_back(results[row].solution, row_cap, budget);
            if (status != Status::Ok) {
                return status;
            }
        }
    }
    return Status::Ok;
}

}  // namespace star_search
