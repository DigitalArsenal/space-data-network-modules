// One explicit Runge-Kutta engine for the published embedded pairs, each with its
// continuous extension, and the Runge-Kutta-Nystrom 12(10) pair for y'' = f(t, y).
//
// A pair is data (lib/rk_tableaus.h): the stage loop, the error estimate and the
// continuous extension are the same code for every pair. The state is the six
// numbers [r, v] of a body (kilometers and kilometers per second in FFM), so a
// derivative is f = [v, a].
//
// Continuous extension. A pair whose publication carries one evaluates it from
// its stages: y(t + theta h) = y + h sum_i k_i sum_p w[i][p] theta^p. A pair
// without one (RK65) and the older step kernels use the quintic Hermite
// polynomial of the position through r, v and a at both ends, which is the sixth-
// order accurate interpolant a second-order system allows without a Jacobian.
#pragma once

#include "astrodynamics_types.h"

namespace astro {
namespace rk {

constexpr int N = 6;
constexpr int kMaxStages = 26;

/// An explicit pair y' = f(t, y). Stage `core` - 1 is f(t + h, y1), which is also the
/// next step's first stage; the stages from `core` to `total` - 1 exist only for the
/// continuous extension and are evaluated on demand.
struct Pair {
    IntegrationMethod method;
    const char* name;
    int core;
    int total;
    int order;        ///< of the propagated solution
    int lowerOrder;   ///< of the embedded solution
    const double* c;  ///< total
    const double* a;  ///< total x total, strictly lower triangular, row-major
    const double* b;  ///< core: weights of the solution
    const double* e;  ///< core: weights of (solution - embedded solution)
    int degree;       ///< of the continuous extension in theta; 0 = quintic Hermite
    const double* w;  ///< total x degree: w[i * degree + p - 1] multiplies theta^p on k_i
};

/// The pair that integrates `method`, or nullptr when `method` is not a pair.
const Pair* pairFor(IntegrationMethod method);

struct Stages {
    double k[kMaxStages][N];
};

/// Stage 0 (k[0]) holds f(t, y) on entry. Evaluates the other core stages and writes
/// the solution and, per component, |solution - embedded solution|.
void solve(const Pair& pair, const DerivativeFunc& f, void* context, double t, double h,
           const double* y, Stages& stages, double* yOut, double* error);

/// The solution alone, from stage 0 and the other core stages already in `stages`.
void completeDense(const Pair& pair, const DerivativeFunc& f, void* context, double t,
                   double h, const double* y, Stages& stages);

/// y(t + theta h) of the step whose stages are `stages`. A pair with a continuous
/// extension needs completeDense() first.
void dense(const Pair& pair, const double* y, double h, const Stages& stages, double theta,
           double* out);

/// Quintic Hermite of the position through (r, v, a) at both ends and the velocity as its
/// derivative; f0 and f1 are [v, a] at the ends.
void hermite(const double* y0, const double* f0, const double* y1, const double* f1,
             double h, double theta, double* out);

// -----------------------------------------------------------------------------
// Runge-Kutta-Nystrom 12(10) in 17 stages (Dormand, El-Mikkawy and Prince 1987)
// -----------------------------------------------------------------------------

constexpr int kNystromStages = 17;

struct NystromStages {
    double acceleration[kNystromStages][3];
};

/// One step of y'' = f(t, y) from (r, v). `f` returns [v, a]; only the position of its
/// argument matters to the method, so the caller must pass a force model that does not
/// depend on velocity. a0 is the acceleration at the start.
void nystromSolve(const DerivativeFunc& f, void* context, double t, double h, const double* y,
                  NystromStages& stages, double* yOut, double* error);

/// The twelfth-order solution alone (no error estimate), for re-stepping.
void nystromSolution(const DerivativeFunc& f, void* context, double t, double h,
                     const double* y, double* yOut);

}  // namespace rk
}  // namespace astro
