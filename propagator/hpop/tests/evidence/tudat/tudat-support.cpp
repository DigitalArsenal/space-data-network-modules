// Numerical adapters for the Tudat evidence runner.  Python owns I/O and
// model wiring; all unit conversion, frame rotation and error arithmetic
// stays here.  This is a native support library, not a published SDN module.
#include <algorithm>
#include <cmath>
#include <limits>

namespace {
// IERS Conventions (2010), equation 5.21, second-order frame bias.
// EME2000 = B * GCRF; identical convention to evidence/gmat/run-gmat.mjs.
constexpr double mas = 3.141592653589793238462643383279502884 / 180.0 / 3600000.0;
constexpr double xi0 = -16.617 * mas;
constexpr double eta0 = -6.819 * mas;
constexpr double da0 = -14.6 * mas;
constexpr double bias[3][3] = {
    {1.0 - (da0 * da0 + xi0 * xi0) / 2.0, da0, -xi0},
    {-da0 - eta0 * xi0, 1.0 - (da0 * da0 + eta0 * eta0) / 2.0, -eta0},
    {xi0 - eta0 * da0, eta0 + xi0 * da0, 1.0 - (eta0 * eta0 + xi0 * xi0) / 2.0},
};

void rotate(const double* input, double* output, bool transpose) {
    double result[6] = {};
    for (int block = 0; block < 2; ++block)
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                result[3 * block + i] +=
                    (transpose ? bias[j][i] : bias[i][j]) * input[3 * block + j];
    std::copy(result, result + 6, output);
}
}

extern "C" {

double quotient(double numerator, double denominator) {
    return numerator / denominator;
}

// Both states are [x,y,z,vx,vy,vz] in SI.  Nonzero to_gcrf applies B^T;
// zero applies B.  In-place calls are supported.
void transform_state(const double* input, double* output, int to_gcrf) {
    rotate(input, output, to_gcrf != 0);
}

// Input and output are row-major 6x6 orbit STMs.  Q = diag(B,B).
// Nonzero eme2000 returns Q * Phi * Q^T; otherwise this is an exact copy.
void transform_phi(const double* input, double* output, int eme2000) {
    double result[36] = {};
    if (eme2000) {
        for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 6; ++j)
                for (int k = 0; k < 3; ++k)
                    for (int l = 0; l < 3; ++l)
                        result[6 * i + j] += bias[i % 3][k] *
                            input[6 * (3 * (i / 3) + k) + 3 * (j / 3) + l] *
                            bias[j % 3][l];
    } else {
        std::copy(input, input + 36, result);
    }
    std::copy(result, result + 36, output);
}

// A parameter derivative is a six-vector, not an STM: only its output axes
// rotate.  scale converts a Tudat Cd/Cr derivative to per-unit Cd*A/m or
// Cr*A/m (scale = mass/area).  All components remain in SI units.
void scale_column(const double* input, double* output, double scale, int eme2000) {
    double result[6];
    for (int i = 0; i < 6; ++i) result[i] = input[i] * scale;
    if (eme2000) rotate(result, output, false);
    else std::copy(result, result + 6, output);
}

// Hourly samples are contiguous six-vectors.  Return the largest position
// separation in metres.  Invalid sample counts or states fail closed.
double worst_positions(const double* a, const double* b, int count) {
    if (count <= 0) return std::numeric_limits<double>::quiet_NaN();
    double worst = 0.0;
    for (int sample = 0; sample < count; ++sample) {
        double squared = 0.0;
        for (int axis = 0; axis < 3; ++axis) {
            const double delta = a[6 * sample + axis] - b[6 * sample + axis];
            if (!std::isfinite(delta)) return std::numeric_limits<double>::quiet_NaN();
            squared += delta * delta;
        }
        worst = std::max(worst, std::sqrt(squared));
    }
    return worst;
}

double ballistic_coefficient(double cd, double area, double mass) {
    return cd * area / mass;
}

// Parameterize the aerodynamic model directly in the neutral export's
// b(t) = Cd*A/m = b0 + bdot*(t-t0), rather than Tudat's dimensionless Cd.
double drag_from_ballistic(double t, double t0, double b0, double bdot,
                           double mass, double area) {
    return (b0 + bdot * (t - t0)) * mass / area;
}

// Exact explicit parameter partial at a fixed spacecraft state.  Tudat's
// aerodynamic state Jacobian remains responsible for the implicit state
// dependence.  acceleration must contain only the aerodynamic term.
void ballistic_partial(const double* acceleration, double* output,
                       double t, double t0, double b0, double bdot, int rate) {
    const double elapsed = t - t0;
    const double factor = (rate ? elapsed : 1.0) / (b0 + bdot * elapsed);
    for (int axis = 0; axis < 3; ++axis) output[axis] = acceleration[axis] * factor;
}

} // extern "C"
