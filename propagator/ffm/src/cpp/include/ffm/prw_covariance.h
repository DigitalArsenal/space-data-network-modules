#pragma once
// PRW covariance and process noise, shared by the execution and resident paths:
// SI records to the integrator's km units and back.
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "ffm/prw_codec.h"
#include "variational.h"

namespace ffm {

// The covariance check's one tolerance, on the correlation matrix (unit
// diagonal), so it does not depend on units or variance scale. FFM's own output
// is exactly symmetric and passed the positive-semidefinite test at 1e-16 in
// every relay measured (to 4 d + 4 d), so the tolerance gates only foreign or
// unsymmetrized producers (other modules'
// transports, the od and calibration hand-offs). Their transport roundoff,
// measured as the asymmetry of FFM 2.0.3's unsymmetrized transport over relays
// of fitted ISS, LARES and COSMIC-2 covariances, grows about as t^2.6: 5.8e-12
// at 1 d + 1 d, 1.6e-11 at 3 d + 3 d and 2.1e-10 at 4 d + 4 d, about 1e-9
// extrapolated to two-week relays, which 1e-7 clears about 100 times. A genuine
// error (a sign error, a correlation above 1) sits at 0.01 to 1, five orders
// above it.
constexpr double kCovarianceTolerance = 1e-7;

// A row-major SI covariance (m, m/s; then mass in kg or dynamic parameters in
// their SI units, unscaled) in km units, verified finite, symmetric and
// positive semidefinite to kCovarianceTolerance on its dimensionless
// correlation matrix, not on the mixed km / km/s / dynamic-parameter
// magnitudes. The covariance carried is the symmetric part (P + P^T)/2, the
// matrix the check validates (the input itself when it is symmetric), and is
// otherwise kept as is: a negative pivot inside the tolerance is not clipped
// (clipping would make a valid near-singular covariance overconfident). An
// indefinite input inside the tolerance stays indefinite through transport (a
// congruence keeps the inertia); only PROCESS_NOISE can lift it.
inline bool prwCovariance(const PRWStateMatrix* in, unsigned n, double* out, std::string& error) {
    if (!in || in->DIMENSION() != n || !in->VALUES() || in->VALUES()->size() != n * n) {
        error = "invalid-covariance: Covariance dimension and row-major values must agree.";
        return false;
    }
    std::vector<double> sigma(n), correlation(n * n, 0.0);
    for (unsigned i = 0; i < n; ++i) {
        const double variance = in->VALUES()->Get(i * n + i);
        if (!std::isfinite(variance) || variance < 0) {
            error = "invalid-covariance: Variances must be finite and nonnegative.";
            return false;
        }
        sigma[i] = std::sqrt(variance);
    }
    for (unsigned i = 0; i < n; ++i)
        for (unsigned j = 0; j < n; ++j) {
            const double a = in->VALUES()->Get(i * n + j), b = in->VALUES()->Get(j * n + i);
            if (!std::isfinite(a) || !std::isfinite(b)) {
                error = "invalid-covariance: Covariance must be finite and symmetric.";
                return false;
            }
            out[i * n + j] = 0.5 * (a + b) * (i < 6 ? 0.001 : 1) * (j < 6 ? 0.001 : 1);
            if (sigma[i] == 0 || sigma[j] == 0) {
                if (a != 0 || b != 0) {
                    error = "invalid-covariance: Zero variance has a nonzero cross term.";
                    return false;
                }
                continue;
            }
            const double x = a / sigma[i] / sigma[j], y = b / sigma[i] / sigma[j];
            if (!std::isfinite(x) || !std::isfinite(y) || std::abs(x - y) > kCovarianceTolerance) {
                error = "invalid-covariance: Covariance must be finite and symmetric.";
                return false;
            }
            correlation[i * n + j] = 0.5 * x + 0.5 * y;
        }
    // Complete diagonal pivoting, as in LAPACK DPSTRF, with the tolerance
    // relative to the unit diagonal. Unlike a rank-only factorization,
    // validate the whole residual block at a small pivot: a zero diagonal
    // with a nonzero cross term is indefinite, not low rank.
    constexpr double tol = kCovarianceTolerance;
    for (unsigned i = 0; i < n; ++i) {
        unsigned pivot = i;
        for (unsigned j = i; j < n; ++j) {
            if (correlation[j * n + j] < -tol) {
                error = "invalid-covariance: Covariance must be positive semidefinite.";
                return false;
            }
            if (correlation[j * n + j] > correlation[pivot * n + pivot]) pivot = j;
        }
        const double p = correlation[pivot * n + pivot];
        if (p <= tol) {
            for (unsigned j = i; j < n; ++j) for (unsigned k = i; k < n; ++k) {
                if (std::abs(correlation[j * n + k]) > tol) {
                    error = "invalid-covariance: Singular covariance has an inconsistent cross term.";
                    return false;
                }
            }
            return true;
        }
        if (pivot != i) {
            for (unsigned k = 0; k < n; ++k) std::swap(correlation[i * n + k], correlation[pivot * n + k]);
            for (unsigned k = 0; k < n; ++k) std::swap(correlation[k * n + i], correlation[k * n + pivot]);
        }
        for (unsigned j = i + 1; j < n; ++j) for (unsigned k = j; k < n; ++k) {
            const double value = correlation[j * n + k] - correlation[j * n + i] * correlation[k * n + i] / p;
            correlation[j * n + k] = correlation[k * n + j] = value;
        }
    }
    return true;
}

// PRWProcessNoise to the integrator's (km^2/s^3); absent or NONE is none.
inline bool prwProcessNoise(const PRWProcessNoise* in, astro::Integrator::ProcessNoise& out, std::string& error) {
    out = {};
    if (!in || in->MODEL() == prwProcessNoiseModel::NONE) return true;
    const auto* q = in->SPECTRAL_DENSITY_M2_S3();
    if (in->MODEL() != prwProcessNoiseModel::WHITE_ACCELERATION ||
        (in->AXES() != prwProcessNoiseAxes::INERTIAL && in->AXES() != prwProcessNoiseAxes::RADIAL_TRANSVERSE_NORMAL) ||
        !q || q->size() != 3 || !(in->DISCRETIZATION_SECONDS() > 0) || !std::isfinite(in->DISCRETIZATION_SECONDS())) {
        error = "invalid-process-noise: WHITE_ACCELERATION needs INERTIAL or RADIAL_TRANSVERSE_NORMAL axes, "
                "three spectral densities and a positive DISCRETIZATION_SECONDS.";
        return false;
    }
    for (unsigned k = 0; k < 3; ++k) {
        if (!(q->Get(k) >= 0) || !std::isfinite(q->Get(k))) {
            error = "invalid-process-noise: Spectral densities must be finite and nonnegative.";
            return false;
        }
        out.q[k] = q->Get(k) * 1e-6;  // m^2/s^3 -> km^2/s^3
    }
    out.enabled = true;
    out.rtn = in->AXES() == prwProcessNoiseAxes::RADIAL_TRANSVERSE_NORMAL;
    out.interval = in->DISCRETIZATION_SECONDS();
    return true;
}

// The process noise a propagated covariance includes, in SI, for output.
inline std::unique_ptr<PRWProcessNoiseT> prwProcessNoiseRecord(const astro::Integrator::ProcessNoise& noise) {
    if (!noise.enabled) return nullptr;
    auto out = std::make_unique<PRWProcessNoiseT>();
    out->MODEL = prwProcessNoiseModel::WHITE_ACCELERATION;
    out->AXES = noise.rtn ? prwProcessNoiseAxes::RADIAL_TRANSVERSE_NORMAL : prwProcessNoiseAxes::INERTIAL;
    out->SPECTRAL_DENSITY_M2_S3 = {noise.q[0] * 1e6, noise.q[1] * 1e6, noise.q[2] * 1e6};
    out->DISCRETIZATION_SECONDS = noise.interval;
    return out;
}

}  // namespace ffm
