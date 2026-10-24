#include "rk_engine.h"
#include "rk_tableaus.h"

#include <cmath>

namespace astro {
namespace rk {
namespace {

const Pair kPairs[] = {
    {IntegrationMethod::DOPRI5, "DOPRI5", 7, 7, 5, 4, data::dopri5_c, data::dopri5_a,
     data::dopri5_b, data::dopri5_e, 4, data::dopri5_w},
    {IntegrationMethod::RK65, "RK65", 9, 9, 6, 5, data::rk65_c, data::rk65_a, data::rk65_b,
     data::rk65_e, 0, nullptr},
    {IntegrationMethod::RKDP87, "RKDP87", 14, 14, 8, 7, data::rk87_c, data::rk87_a,
     data::rk87_b, data::rk87_e, 6, data::rk87_w},
    {IntegrationMethod::RKV98, "RKV98", 17, 26, 9, 8, data::rkv98_c, data::rkv98_a,
     data::rkv98_b, data::rkv98_e, 9, data::rkv98_w},
};

// Stage i of a pair: the argument y + h sum_j a[i][j] k_j and the node.
inline void stageArgument(const Pair& pair, int i, double h, const double* y,
                          const Stages& stages, double* argument) {
    const double* row = pair.a + i * pair.total;
    for (int component = 0; component < N; ++component) {
        double sum = 0;
        for (int j = 0; j < i; ++j) sum += row[j] * stages.k[j][component];
        argument[component] = y[component] + h * sum;
    }
}

}  // namespace

const Pair* pairFor(IntegrationMethod method) {
    for (const Pair& pair : kPairs)
        if (pair.method == method) return &pair;
    return nullptr;
}

void solve(const Pair& pair, const DerivativeFunc& f, void* context, double t, double h,
           const double* y, Stages& stages, double* yOut, double* error) {
    double argument[N];
    for (int i = 1; i < pair.core - 1; ++i) {
        stageArgument(pair, i, h, y, stages, argument);
        f(t + pair.c[i] * h, argument, stages.k[i], context);
    }
    for (int component = 0; component < N; ++component) {
        double sum = 0;
        for (int j = 0; j < pair.core - 1; ++j) sum += pair.b[j] * stages.k[j][component];
        yOut[component] = y[component] + h * sum;
    }
    // The last core stage is f(t + h, y1): the next step's first stage.
    f(t + h, yOut, stages.k[pair.core - 1], context);
    for (int component = 0; component < N; ++component) {
        double difference = 0;
        for (int j = 0; j < pair.core; ++j) difference += pair.e[j] * stages.k[j][component];
        error[component] = std::abs(h * difference);
    }
}

void completeDense(const Pair& pair, const DerivativeFunc& f, void* context, double t, double h,
                   const double* y, Stages& stages) {
    double argument[N];
    for (int i = pair.core; i < pair.total; ++i) {
        stageArgument(pair, i, h, y, stages, argument);
        f(t + pair.c[i] * h, argument, stages.k[i], context);
    }
}

void hermite(const double* y0, const double* f0, const double* y1, const double* f1, double h,
             double theta, double* out) {
    const double s = theta, s2 = s * s, s3 = s2 * s, s4 = s3 * s, s5 = s4 * s;
    const double h0 = 1 - 10 * s3 + 15 * s4 - 6 * s5;
    const double h1 = s - 6 * s3 + 8 * s4 - 3 * s5;
    const double h2 = 0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5;
    const double h3 = 10 * s3 - 15 * s4 + 6 * s5;
    const double h4 = -4 * s3 + 7 * s4 - 3 * s5;
    const double h5 = 0.5 * s3 - s4 + 0.5 * s5;
    const double d0 = -30 * s2 + 60 * s3 - 30 * s4;
    const double d1 = 1 - 18 * s2 + 32 * s3 - 15 * s4;
    const double d2 = s - 4.5 * s2 + 6 * s3 - 2.5 * s4;
    const double d3 = 30 * s2 - 60 * s3 + 30 * s4;
    const double d4 = -12 * s2 + 28 * s3 - 15 * s4;
    const double d5 = 1.5 * s2 - 4 * s3 + 2.5 * s4;
    for (int i = 0; i < 3; ++i) {
        const double r0 = y0[i], v0 = y0[3 + i], a0 = f0[3 + i];
        const double r1 = y1[i], v1 = y1[3 + i], a1 = f1[3 + i];
        out[i] = r0 * h0 + h * v0 * h1 + h * h * a0 * h2 + r1 * h3 + h * v1 * h4 + h * h * a1 * h5;
        out[3 + i] = (r0 * d0 + h * v0 * d1 + h * h * a0 * d2 + r1 * d3 + h * v1 * d4 +
                      h * h * a1 * d5) / h;
    }
}

void dense(const Pair& pair, const double* y, double h, const Stages& stages, double theta,
           double* out) {
    if (pair.degree == 0) {
        // y1 is not stored: rebuild it from the solution weights (the same sum solve() made).
        double y1[N];
        for (int component = 0; component < N; ++component) {
            double sum = 0;
            for (int j = 0; j < pair.core - 1; ++j) sum += pair.b[j] * stages.k[j][component];
            y1[component] = y[component] + h * sum;
        }
        hermite(y, stages.k[0], y1, stages.k[pair.core - 1], h, theta, out);
        return;
    }
    double weight[kMaxStages];
    for (int i = 0; i < pair.total; ++i) {
        double sum = 0, power = theta;
        for (int p = 1; p <= pair.degree; ++p, power *= theta) sum += pair.w[i * pair.degree + p - 1] * power;
        weight[i] = sum;
    }
    for (int component = 0; component < N; ++component) {
        double sum = 0;
        for (int i = 0; i < pair.total; ++i) sum += weight[i] * stages.k[i][component];
        out[component] = y[component] + h * sum;
    }
}

// ---------------------------------------------------------------------------------------
// Runge-Kutta-Nystrom 12(10)
// ---------------------------------------------------------------------------------------

namespace {
// y_i = r + c_i h v + h^2 sum_j a_ij f_j for the position of stage i.
inline void nystromPosition(int i, double h, const double* y, const NystromStages& stages,
                            double* position) {
    const double* row = data::rkn1210_a + i * kNystromStages;
    for (int component = 0; component < 3; ++component) {
        double sum = 0;
        for (int j = 0; j < i; ++j) sum += row[j] * stages.acceleration[j][component];
        position[component] = y[component] + data::rkn1210_c[i] * h * y[3 + component] + h * h * sum;
    }
}
inline void nystromStage(const DerivativeFunc& f, void* context, double t, double h,
                         const double* y, int i, NystromStages& stages) {
    double argument[N], derivative[N];
    nystromPosition(i, h, y, stages, argument);
    // Only the position enters; the velocity slot carries the step's initial velocity.
    for (int component = 0; component < 3; ++component) argument[3 + component] = y[3 + component];
    f(t + data::rkn1210_c[i] * h, argument, derivative, context);
    for (int component = 0; component < 3; ++component)
        stages.acceleration[i][component] = derivative[3 + component];
}
}  // namespace

void nystromSolve(const DerivativeFunc& f, void* context, double t, double h, const double* y,
                  NystromStages& stages, double* yOut, double* error) {
    for (int i = 0; i < kNystromStages; ++i) nystromStage(f, context, t, h, y, i, stages);
    for (int component = 0; component < 3; ++component) {
        double position = 0, velocity = 0, positionDifference = 0, velocityDifference = 0;
        for (int j = 0; j < kNystromStages; ++j) {
            const double a = stages.acceleration[j][component];
            position += data::rkn1210_b[j] * a;
            velocity += data::rkn1210_bp[j] * a;
            positionDifference += data::rkn1210_bt[j] * a;
            velocityDifference += data::rkn1210_bpt[j] * a;
        }
        yOut[component] = y[component] + h * y[3 + component] + h * h * position;
        yOut[3 + component] = y[3 + component] + h * velocity;
        error[component] = std::abs(h * h * positionDifference);
        error[3 + component] = std::abs(h * velocityDifference);
    }
}

void nystromSolution(const DerivativeFunc& f, void* context, double t, double h, const double* y,
                     double* yOut) {
    NystromStages stages;
    double error[N];
    nystromSolve(f, context, t, h, y, stages, yOut, error);
}

}  // namespace rk
}  // namespace astro
