// higherpop/integrator.hpp — adaptive Runge-Kutta on a fixed-size state.
//
// A single templated adaptive stepper works for every formulation because they
// all reduce to y' = f(t, y) on a small std::array<double, N>:
//   Cowell        N=6   (r, v)
//   Encke         N=6   (dr, dv)
//   Equinoctial   N=6   (p, f, g, h, k, L)
//   KS/Stiefel    N=10  (u[4], u'[4], t, tau)   (added later)
//
// Method: Dormand-Prince 5(4) (RK45) with PI step control. DP54 is the right
// default — 7 stages, FSAL, dense-capable, and for the tolerances used in
// benchmarking it is competitive with higher-order pairs while being far
// simpler to audit. A DOP853 pair can be swapped in behind the same interface.
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>

namespace hp {

struct StepStats {
    std::uint32_t nsteps{0};
    std::uint32_t nrejected{0};
    std::uint32_t nfev{0};
    bool ok{true};
};

template <std::size_t N>
using State = std::array<double, N>;

// Dormand-Prince 5(4) Butcher tableau (the classic RKDP / MATLAB ode45).
namespace dp54 {
inline constexpr double c2=1.0/5, c3=3.0/10, c4=4.0/5, c5=8.0/9, c6=1.0, c7=1.0;
inline constexpr double a21=1.0/5;
inline constexpr double a31=3.0/40,      a32=9.0/40;
inline constexpr double a41=44.0/45,     a42=-56.0/15,     a43=32.0/9;
inline constexpr double a51=19372.0/6561,a52=-25360.0/2187,a53=64448.0/6561,a54=-212.0/729;
inline constexpr double a61=9017.0/3168, a62=-355.0/33,    a63=46732.0/5247,a64=49.0/176,   a65=-5103.0/18656;
inline constexpr double a71=35.0/384,    a72=0.0,          a73=500.0/1113,  a74=125.0/192,  a75=-2187.0/6784, a76=11.0/84;
// 5th order solution weights == a7* (FSAL). 4th order (error) weights:
inline constexpr double b1=35.0/384, b2=0.0, b3=500.0/1113, b4=125.0/192, b5=-2187.0/6784, b6=11.0/84, b7=0.0;
inline constexpr double e1=5179.0/57600, e2=0.0, e3=7571.0/16695, e4=393.0/640,
                        e5=-92097.0/339200, e6=187.0/2100, e7=1.0/40;
}

// Integrate y from t0 to t1. `f(t, y) -> yprime`. rtol/atol are scalar.
// Returns final state; fills stats. Independent variable need not be physical
// time (regularized methods pass fictitious time and event on physical time).
template <std::size_t N, class F>
State<N> integrate(F&& f, State<N> y, double t0, double t1,
                   double rtol, double atol, StepStats& st,
                   double h_init = 0.0, double h_max = 0.0) {
    using S = State<N>;
    auto axpy = [](double a, const S& x, const S& y_) {
        S r; for (std::size_t i=0;i<N;++i) r[i]=a*x[i]+y_[i]; return r; };

    const double dir = (t1 >= t0) ? 1.0 : -1.0;
    double t = t0;
    double h = (h_init > 0.0 ? h_init : std::fabs(t1 - t0) * 1e-3) * dir;
    if (h_max <= 0.0) h_max = std::fabs(t1 - t0);

    S k1 = f(t, y);  st.nfev++;
    bool have_k1 = true;

    const int MAX_STEPS = 5'000'000;
    double err_prev = 1.0;
    for (int it = 0; it < MAX_STEPS; ++it) {
        if ((t - t1)*dir >= -1e-14) { st.ok = true; return y; }
        if ((t + h - t1)*dir > 0.0) h = t1 - t;   // don't overshoot

        if (!have_k1) { k1 = f(t, y); st.nfev++; }
        using namespace dp54;
        S k2 = f(t + c2*h, axpy(h*a21, k1, y)); 
        S tmp;
        for (std::size_t i=0;i<N;++i) tmp[i]=y[i]+h*(a31*k1[i]+a32*k2[i]);
        S k3 = f(t + c3*h, tmp);
        for (std::size_t i=0;i<N;++i) tmp[i]=y[i]+h*(a41*k1[i]+a42*k2[i]+a43*k3[i]);
        S k4 = f(t + c4*h, tmp);
        for (std::size_t i=0;i<N;++i) tmp[i]=y[i]+h*(a51*k1[i]+a52*k2[i]+a53*k3[i]+a54*k4[i]);
        S k5 = f(t + c5*h, tmp);
        for (std::size_t i=0;i<N;++i) tmp[i]=y[i]+h*(a61*k1[i]+a62*k2[i]+a63*k3[i]+a64*k4[i]+a65*k5[i]);
        S k6 = f(t + c6*h, tmp);
        S y5;
        for (std::size_t i=0;i<N;++i) y5[i]=y[i]+h*(a71*k1[i]+a73*k3[i]+a74*k4[i]+a75*k5[i]+a76*k6[i]);
        S k7 = f(t + h, y5);
        st.nfev += 6;

        // error estimate = (b - e)·k
        double err = 0.0;
        for (std::size_t i=0;i<N;++i) {
            const double e = h*((b1-e1)*k1[i]+(b3-e3)*k3[i]+(b4-e4)*k4[i]
                                +(b5-e5)*k5[i]+(b6-e6)*k6[i]+(b7-e7)*k7[i]);
            const double sc = atol + rtol*std::max(std::fabs(y[i]), std::fabs(y5[i]));
            const double ratio = e / sc;
            err += ratio*ratio;
        }
        err = std::sqrt(err / N);

        if (err <= 1.0) {                 // accept
            t += h;
            y = y5;
            k1 = k7; have_k1 = true;      // FSAL
            st.nsteps++;
            // PI controller (Gustafsson)
            const double alpha = 0.7/5.0, beta = 0.4/5.0;
            double fac = 0.92 * std::pow(std::max(err,1e-10), -alpha)
                              * std::pow(std::max(err_prev,1e-10), beta);
            fac = std::min(5.0, std::max(0.2, fac));
            h *= fac;
            err_prev = err;
        } else {                          // reject
            st.nrejected++;
            have_k1 = true;               // k1 still valid at old t
            double fac = std::max(0.2, 0.92*std::pow(err, -0.2));
            h *= fac;
        }
        if (std::fabs(h) > h_max) h = h_max*dir;
        if (std::fabs(h) < 1e-13) { st.ok = false; return y; }
    }
    st.ok = false;
    return y;
}

} // namespace hp
