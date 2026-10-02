#pragma once
// PRW covariance and process noise, shared by the execution and resident paths:
// SI records to the integrator's km units and back.
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>

#include "hpop/prw_codec.h"
#include "variational.h"

namespace hpop {

// A row-major SI covariance (m, m/s; mass in kg) in km units, verified finite,
// symmetric and positive semidefinite (LDL^T; a zero pivot requires the
// residual column to vanish).
inline bool prwCovariance(const PRWStateMatrix* in, unsigned n, double* out, std::string& error) {
    if (!in || in->DIMENSION() != n || !in->VALUES() || in->VALUES()->size() != n * n) {
        error = "invalid-covariance: Covariance dimension and row-major values must agree.";
        return false;
    }
    double scale = 0;
    for (unsigned i = 0; i < n; ++i)
        for (unsigned j = 0; j < n; ++j) {
            const double a = in->VALUES()->Get(i * n + j), b = in->VALUES()->Get(j * n + i);
            if (!std::isfinite(a) || !std::isfinite(b) || std::abs(a - b) > 1e-12 * std::max({1.0, std::abs(a), std::abs(b)})) {
                error = "invalid-covariance: Covariance must be finite and symmetric.";
                return false;
            }
            out[i * n + j] = a * (i < 6 ? 0.001 : 1) * (j < 6 ? 0.001 : 1);
            scale = std::max(scale, std::abs(out[i * n + j]));
        }
    double l[49]{}, d[7]{};
    const double tol = std::max(1e-30, scale * 1e-12);
    for (unsigned i = 0; i < n; ++i) {
        double p = out[i * n + i];
        for (unsigned k = 0; k < i; ++k) p -= l[i * n + k] * l[i * n + k] * d[k];
        if (p < -tol) {
            error = "invalid-covariance: Covariance must be positive semidefinite.";
            return false;
        }
        d[i] = p > tol ? p : 0;
        l[i * n + i] = 1;
        for (unsigned j = i + 1; j < n; ++j) {
            double r = out[j * n + i];
            for (unsigned k = 0; k < i; ++k) r -= l[j * n + k] * l[i * n + k] * d[k];
            if (d[i] == 0 && std::abs(r) > tol) {
                error = "invalid-covariance: Singular covariance has an inconsistent cross term.";
                return false;
            }
            l[j * n + i] = d[i] == 0 ? 0 : r / d[i];
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

}  // namespace hpop
