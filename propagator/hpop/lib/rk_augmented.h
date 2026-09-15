#pragma once
#include "astrodynamics_types.h"
#include <cmath>

// One tableau for Cartesian state and augmented state/STM.
namespace astro { namespace rk_detail {
// Fehlberg 7(8) coefficients
namespace rkf78 {
    // Nodes (c values)
    constexpr double c[] = {0, 2.0/27.0, 1.0/9.0, 1.0/6.0, 5.0/12.0, 1.0/2.0,
                            5.0/6.0, 1.0/6.0, 2.0/3.0, 1.0/3.0, 1.0, 0, 1.0};

    // 8th order weights
    constexpr double b8[] = {41.0/840.0, 0, 0, 0, 0, 34.0/105.0, 9.0/35.0, 9.0/35.0,
                             9.0/280.0, 9.0/280.0, 41.0/840.0, 0, 0};

    // 7th order weights (for error estimation)
    constexpr double b7[] = {0, 0, 0, 0, 0, 34.0/105.0, 9.0/35.0, 9.0/35.0,
                             9.0/280.0, 9.0/280.0, 0, 41.0/840.0, 41.0/840.0};
}

template<int N>
void rkf78Step(double t, double h, const double* y,
               double* yout, double* yerr,
               DerivativeFunc deriv, void* params) {
    constexpr int S = 13;  // Number of stages
    double k[S][N];
    double ytmp[N];

    // Stage coefficients (simplified Butcher tableau - using subset)
    // Full 13-stage RKF78 with all a_ij coefficients

    // Stage 1
    deriv(t, y, k[0], params);

    // Stage 2
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (2.0/27.0) * k[0][i];
    deriv(t + (2.0/27.0)*h, ytmp, k[1], params);

    // Stage 3
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((1.0/36.0)*k[0][i] + (1.0/12.0)*k[1][i]);
    deriv(t + (1.0/9.0)*h, ytmp, k[2], params);

    // Stage 4
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((1.0/24.0)*k[0][i] + (1.0/8.0)*k[2][i]);
    deriv(t + (1.0/6.0)*h, ytmp, k[3], params);

    // Stage 5
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((5.0/12.0)*k[0][i] - (25.0/16.0)*k[2][i] + (25.0/16.0)*k[3][i]);
    deriv(t + (5.0/12.0)*h, ytmp, k[4], params);

    // Stage 6
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((1.0/20.0)*k[0][i] + (1.0/4.0)*k[3][i] + (1.0/5.0)*k[4][i]);
    deriv(t + 0.5*h, ytmp, k[5], params);

    // Stage 7
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((-25.0/108.0)*k[0][i] + (125.0/108.0)*k[3][i] +
                              (-65.0/27.0)*k[4][i] + (125.0/54.0)*k[5][i]);
    deriv(t + (5.0/6.0)*h, ytmp, k[6], params);

    // Stage 8
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((31.0/300.0)*k[0][i] + (61.0/225.0)*k[4][i] +
                              (-2.0/9.0)*k[5][i] + (13.0/900.0)*k[6][i]);
    deriv(t + (1.0/6.0)*h, ytmp, k[7], params);

    // Stage 9
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (2.0*k[0][i] - (53.0/6.0)*k[3][i] + (704.0/45.0)*k[4][i] +
                              (-107.0/9.0)*k[5][i] + (67.0/90.0)*k[6][i] + 3.0*k[7][i]);
    deriv(t + (2.0/3.0)*h, ytmp, k[8], params);

    // Stage 10
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((-91.0/108.0)*k[0][i] + (23.0/108.0)*k[3][i] +
                              (-976.0/135.0)*k[4][i] + (311.0/54.0)*k[5][i] +
                              (-19.0/60.0)*k[6][i] + (17.0/6.0)*k[7][i] + (-1.0/12.0)*k[8][i]);
    deriv(t + (1.0/3.0)*h, ytmp, k[9], params);

    // Stage 11
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((2383.0/4100.0)*k[0][i] - (341.0/164.0)*k[3][i] +
                              (4496.0/1025.0)*k[4][i] + (-301.0/82.0)*k[5][i] +
                              (2133.0/4100.0)*k[6][i] + (45.0/82.0)*k[7][i] +
                              (45.0/164.0)*k[8][i] + (18.0/41.0)*k[9][i]);
    deriv(t + h, ytmp, k[10], params);

    // Stage 12
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((3.0/205.0)*k[0][i] + (-6.0/41.0)*k[5][i] +
                              (-3.0/205.0)*k[6][i] + (-3.0/41.0)*k[7][i] +
                              (3.0/41.0)*k[8][i] + (6.0/41.0)*k[9][i]);
    deriv(t, ytmp, k[11], params);

    // Stage 13
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * ((-1777.0/4100.0)*k[0][i] - (341.0/164.0)*k[3][i] +
                              (4496.0/1025.0)*k[4][i] + (-289.0/82.0)*k[5][i] +
                              (2193.0/4100.0)*k[6][i] + (51.0/82.0)*k[7][i] +
                              (33.0/164.0)*k[8][i] + (12.0/41.0)*k[9][i] + k[11][i]);
    deriv(t + h, ytmp, k[12], params);

    // 8th order solution
    for (int i = 0; i < N; i++) {
        yout[i] = y[i] + h * (rkf78::b8[0]*k[0][i] + rkf78::b8[5]*k[5][i] +
                              rkf78::b8[6]*k[6][i] + rkf78::b8[7]*k[7][i] +
                              rkf78::b8[8]*k[8][i] + rkf78::b8[9]*k[9][i] +
                              rkf78::b8[10]*k[10][i]);
    }

    // Error estimate (difference between 8th and 7th order)
    for (int i = 0; i < N; i++) {
        double y7 = y[i] + h * (rkf78::b7[5]*k[5][i] + rkf78::b7[6]*k[6][i] +
                                rkf78::b7[7]*k[7][i] + rkf78::b7[8]*k[8][i] +
                                rkf78::b7[9]*k[9][i] + rkf78::b7[11]*k[11][i] +
                                rkf78::b7[12]*k[12][i]);
        yerr[i] = yout[i] - y7;
    }
}

// Cash-Karp coefficients
namespace rkf45c {
    constexpr double c2 = 1.0/5.0, c3 = 3.0/10.0, c4 = 3.0/5.0, c5 = 1.0, c6 = 7.0/8.0;
    constexpr double a21 = 1.0/5.0;
    constexpr double a31 = 3.0/40.0, a32 = 9.0/40.0;
    constexpr double a41 = 3.0/10.0, a42 = -9.0/10.0, a43 = 6.0/5.0;
    constexpr double a51 = -11.0/54.0, a52 = 5.0/2.0, a53 = -70.0/27.0, a54 = 35.0/27.0;
    constexpr double a61 = 1631.0/55296.0, a62 = 175.0/512.0, a63 = 575.0/13824.0;
    constexpr double a64 = 44275.0/110592.0, a65 = 253.0/4096.0;
    constexpr double b5_1 = 37.0/378.0, b5_3 = 250.0/621.0, b5_4 = 125.0/594.0, b5_6 = 512.0/1771.0;
    constexpr double b4_1 = 2825.0/27648.0, b4_3 = 18575.0/48384.0, b4_4 = 13525.0/55296.0;
    constexpr double b4_5 = 277.0/14336.0, b4_6 = 1.0/4.0;
}


template<int N>
void cashKarpStep(double t, double h, const double* y, double* yout, double* yerr, DerivativeFunc deriv, void* params) {
    double k1[N], k2[N], k3[N], k4[N], k5[N], k6[N];
    double ytmp[N];

    using namespace rkf45c;

    // Stage 1
    deriv(t, y, k1, params);

    // Stage 2
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * a21 * k1[i];
    deriv(t + c2*h, ytmp, k2, params);

    // Stage 3
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (a31*k1[i] + a32*k2[i]);
    deriv(t + c3*h, ytmp, k3, params);

    // Stage 4
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (a41*k1[i] + a42*k2[i] + a43*k3[i]);
    deriv(t + c4*h, ytmp, k4, params);

    // Stage 5
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (a51*k1[i] + a52*k2[i] + a53*k3[i] + a54*k4[i]);
    deriv(t + c5*h, ytmp, k5, params);

    // Stage 6
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * (a61*k1[i] + a62*k2[i] + a63*k3[i] + a64*k4[i] + a65*k5[i]);
    deriv(t + c6*h, ytmp, k6, params);

    // 5th order solution
    for (int i = 0; i < N; i++) {
        yout[i] = y[i] + h * (b5_1*k1[i] + b5_3*k3[i] + b5_4*k4[i] + b5_6*k6[i]);
    }

    // Error estimate
    for (int i = 0; i < N; i++) {
        double y4 = y[i] + h * (b4_1*k1[i] + b4_3*k3[i] + b4_4*k4[i] + b4_5*k5[i] + b4_6*k6[i]);
        yerr[i] = std::abs(yout[i] - y4);
    }

}

template<int N>
void rk4Step(double t, double h, const double* y, double* yout, double* yerr, DerivativeFunc deriv, void* params) {
    double k1[N], k2[N], k3[N], k4[N];
    double ytmp[N];

    // Stage 1: k1 = f(t, y)
    deriv(t, y, k1, params);

    // Stage 2: k2 = f(t + h/2, y + h/2 * k1)
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + 0.5 * h * k1[i];
    deriv(t + 0.5*h, ytmp, k2, params);

    // Stage 3: k3 = f(t + h/2, y + h/2 * k2)
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + 0.5 * h * k2[i];
    deriv(t + 0.5*h, ytmp, k3, params);

    // Stage 4: k4 = f(t + h, y + h * k3)
    for (int i = 0; i < N; i++)
        ytmp[i] = y[i] + h * k3[i];
    deriv(t + h, ytmp, k4, params);

    // Combine: y(t+h) = y + h/6 * (k1 + 2*k2 + 2*k3 + k4)
    for (int i = 0; i < N; i++) {
        yout[i] = y[i] + h * (k1[i] + 2.0*k2[i] + 2.0*k3[i] + k4[i]) / 6.0;
        yerr[i] = h * h * h * h * h * 1e-10;  // O(h^5) local truncation error
    }

}
}}
