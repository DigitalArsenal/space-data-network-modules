#pragma once
// Chebyshev series of degree 12 over a segment, fitted at the 13
// Gauss-Lobatto nodes (DCT-I) and evaluated by Clenshaw's recurrence: the
// segments HPOP's resident trajectories and exported PPE records hold.
#include <cmath>

namespace hpop {

inline constexpr int    CHEBY_N    = 12;           // Polynomial degree
inline constexpr int    CHEBY_NPTS = CHEBY_N + 1;  // 13 sample points per segment
inline constexpr double CHEBY_SEG_SEC  = 600.0;    // 10-minute segments
inline constexpr double CHEBY_SEG_DAYS = CHEBY_SEG_SEC / 86400.0;
// Keep a bounded moving window so long-running sessions can propagate indefinitely
// without unbounded ephemeris growth.
inline constexpr int    CHEBY_MAX_SEGMENTS = 2048;

struct ChebyshevSegment {
    double startJD, endJD;
    double midJD, halfSpanDays;
    double startPos[3], startVel[3];
    double endPos[3], endVel[3];
    double cx[CHEBY_NPTS], cy[CHEBY_NPTS], cz[CHEBY_NPTS];    // position (km)
    double cvx[CHEBY_NPTS], cvy[CHEBY_NPTS], cvz[CHEBY_NPTS]; // velocity (km/s)
};


/// Compute Chebyshev coefficients from values at Gauss-Lobatto nodes via DCT-I.
inline void chebyshevFit(const double* values, double* coeffs) {
    for (int j = 0; j <= CHEBY_N; j++) {
        double sum = 0.0;
        for (int k = 0; k <= CHEBY_N; k++) {
            double w = (k == 0 || k == CHEBY_N) ? 0.5 : 1.0;
            sum += w * values[k] * std::cos(j * k * M_PI / CHEBY_N);
        }
        coeffs[j] = 2.0 * sum / CHEBY_N;
    }
    coeffs[0]       *= 0.5;
    coeffs[CHEBY_N] *= 0.5;
}

/// Evaluate a Chebyshev polynomial at τ ∈ [-1, 1] using Clenshaw's algorithm.
inline double chebyshevEval(const double* c, double tau) {
    double b1 = 0.0, b2 = 0.0;
    for (int j = CHEBY_N; j >= 1; j--) {
        double b0 = 2.0 * tau * b1 - b2 + c[j];
        b2 = b1;
        b1 = b0;
    }
    return tau * b1 - b2 + c[0];
}


} // namespace hpop
