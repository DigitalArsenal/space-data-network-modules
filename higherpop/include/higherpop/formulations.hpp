// higherpop/formulations.hpp — special-perturbation formulations sharing one
// force model and one adaptive integrator.
//
// Implemented:
//   Cowell         : integrate ECI (r,v) with total acceleration.
//   Encke          : integrate deviation from an osculating conic; rectify.
//   Equinoctial VOP: Gauss variational eqns in modified equinoctial elements
//                    (singularity-free except true retrograde equatorial).
//
// All expose: propagate(r0, v0, tf, cfg, tol) -> {rf, vf, stats}.
#pragma once
#include "vec3.hpp"
#include "forces.hpp"
#include "integrator.hpp"
#include "kepler.hpp"
#include "ks.hpp"
#include "dromo.hpp"
#include <cmath>

namespace hp {

struct PropResult {
    Vec3 r, v;
    StepStats stats;
};

// --------------------------------------------------------------------------
// COWELL
// --------------------------------------------------------------------------
inline PropResult propagateCowell(const Vec3& r0, const Vec3& v0, double tf,
                                  const ForceConfig& c, double rtol, double atol) {
    State<6> y{r0.x,r0.y,r0.z, v0.x,v0.y,v0.z};
    auto f = [&](double /*t*/, const State<6>& s) -> State<6> {
        const Vec3 r{s[0],s[1],s[2]}, v{s[3],s[4],s[5]};
        const Vec3 a = totalAccel(r, v, c);
        return {s[3],s[4],s[5], a.x,a.y,a.z};
    };
    StepStats st;
    y = integrate<6>(f, y, 0.0, tf, rtol, atol, st);
    return {{y[0],y[1],y[2]}, {y[3],y[4],y[5]}, st};
}

// --------------------------------------------------------------------------
// ENCKE — integrate deviation (dr,dv) from an osculating two-body reference,
// rectifying whenever |dr|/|r| exceeds a threshold. Battin's f(q) keeps the
// difference-of-large-numbers term numerically stable.
// --------------------------------------------------------------------------
inline double enckeFq(const Vec3& dr, const Vec3& r_osc) noexcept {
    const Vec3 r = r_osc + dr;
    const double q = dot(dr, dr - 2.0*r) / dot(r, r);
    return q*(3.0 + 3.0*q + q*q) / (1.0 + std::pow(1.0+q, 1.5));
}

inline PropResult propagateEncke(const Vec3& r0, const Vec3& v0, double tf,
                                 const ForceConfig& c, double rtol, double atol,
                                 double rectFrac = 0.01) {
    Vec3 r_ref = r0, v_ref = v0;   // osculating reference at start of segment
    double t_ref = 0.0;            // physical time of current reference
    StepStats total;
    const double mu = c.mu;

    // Rectification cadence: a coarse check interval. Within a segment the
    // adaptive integrator takes as few steps as accuracy allows; at each
    // interval boundary we test |dr|/|r| and rectify (reset reference to the
    // osculating total state) when it exceeds rectFrac.
    const double sma0 = 1.0/(2.0/norm(r0) - dot(v0,v0)/mu);
    const double P = TWO_PI*std::sqrt(sma0*sma0*sma0/mu);
    const double interval = P/8.0;     // check 8×/orbit

    Vec3 s_dr{0,0,0}, s_dv{0,0,0};
    double tau = 0.0;                  // time since current reference
    while (t_ref + tau < tf - 1e-9) {
        auto refState = [&](double dt){ return keplerUniversal(r_ref, v_ref, dt, mu); };
        auto f = [&](double t, const State<6>& st) -> State<6> {
            const Vec3 d_r{st[0],st[1],st[2]}, d_v{st[3],st[4],st[5]};
            auto rv = refState(t);
            const Vec3 r_osc = rv.first, v_osc = rv.second;
            const Vec3 r = r_osc + d_r;
            const double ro = norm(r_osc);
            const double fq = enckeFq(d_r, r_osc);   // = (r_osc/r)^3 - 1
            const Vec3 a_p = perturbation(r, v_osc + d_v, c);
            // δa = a_pert - (mu/r_osc^3)(δr + fq·r)   [Battin, sign-consistent]
            const Vec3 a_delta = a_p - (mu/(ro*ro*ro))*(d_r + fq*r);
            return {st[3],st[4],st[5], a_delta.x,a_delta.y,a_delta.z};
        };
        double tend = std::min(tau + interval, tf - t_ref);
        State<6> s{s_dr.x,s_dr.y,s_dr.z, s_dv.x,s_dv.y,s_dv.z};
        StepStats st;
        s = integrate<6>(f, s, tau, tend, rtol, atol, st);
        total.nsteps += st.nsteps; total.nrejected += st.nrejected; total.nfev += st.nfev;
        tau = tend;
        s_dr = {s[0],s[1],s[2]}; s_dv = {s[3],s[4],s[5]};

        auto rv = refState(tau);
        const Vec3 r_tot = rv.first + s_dr, v_tot = rv.second + s_dv;
        if (norm(s_dr)/norm(rv.first) > rectFrac || tau >= tf - t_ref - 1e-9) {
            // rectify
            r_ref = r_tot; v_ref = v_tot;
            t_ref += tau; tau = 0.0;
            s_dr = {0,0,0}; s_dv = {0,0,0};
        }
    }
    // final osculating total
    auto rv = keplerUniversal(r_ref, v_ref, tau, mu);
    return {rv.first + s_dr, rv.second + s_dv, total};
}

// --------------------------------------------------------------------------
// EQUINOCTIAL VOP (modified equinoctial elements p,f,g,h,k,L; Gauss form).
// RTN perturbation → element rates. Independent variable = physical time.
// --------------------------------------------------------------------------
inline State<6> rvToMee(const Vec3& r, const Vec3& v, double mu) {
    const double rn = norm(r);
    const Vec3 hvec = cross(r, v);
    const double hn = norm(hvec);
    const Vec3 hhat = hvec / hn;
    const double p = hn*hn/mu;
    const double k = hhat.x/(1.0+hhat.z);
    const double h = -hhat.y/(1.0+hhat.z);
    const Vec3 evec = cross(v, hvec)/mu - r/rn;
    const double denom = 1.0 + h*h + k*k;
    const Vec3 fhat{(1-k*k+h*h)/denom, (2*k*h)/denom, (-2*k)/denom};
    const Vec3 ghat{(2*k*h)/denom, (1+k*k-h*h)/denom, (2*h)/denom};
    const double f = dot(evec, fhat);
    const double g = dot(evec, ghat);
    const double L = std::atan2(dot(r,ghat), dot(r,fhat));
    return {p,f,g,h,k,L};
}

inline void meeToRv(const State<6>& m, double mu, Vec3& r, Vec3& v) {
    const double p=m[0],f=m[1],g=m[2],h=m[3],k=m[4],L=m[5];
    const double a2=h*h-k*k, s2=1+h*h+k*k, w=1+f*std::cos(L)+g*std::sin(L);
    const double rr=p/w, sL=std::sin(L), cL=std::cos(L);
    r = { (rr/s2)*(cL+a2*cL+2*h*k*sL),
          (rr/s2)*(sL-a2*sL+2*h*k*cL),
          (2*rr/s2)*(h*sL-k*cL) };
    const double sq=std::sqrt(mu/p);
    v = { -(1/s2)*sq*( sL+a2*sL-2*h*k*cL+g-2*f*h*k+a2*g),
          -(1/s2)*sq*(-cL+a2*cL+2*h*k*sL-f+2*g*h*k+a2*f),
           (2/s2)*sq*(h*cL+k*sL+f*h+g*k) };
}

inline PropResult propagateMee(const Vec3& r0, const Vec3& v0, double tf,
                               const ForceConfig& c, double rtol, double atol) {
    const double mu = c.mu;
    State<6> m = rvToMee(r0, v0, mu);
    auto f = [&](double /*t*/, const State<6>& s) -> State<6> {
        Vec3 r, v; meeToRv(s, mu, r, v);
        const Vec3 a = perturbation(r, v, c);           // RTN basis
        const Vec3 rhat = unit(r);
        const Vec3 nhat = unit(cross(r, v));
        const Vec3 that = cross(nhat, rhat);
        const double ar=dot(a,rhat), at=dot(a,that), an=dot(a,nhat);
        const double p=s[0],ff=s[1],gg=s[2],hh=s[3],kk=s[4],L=s[5];
        const double sL=std::sin(L), cL=std::cos(L), w=1+ff*cL+gg*sL, s2=1+hh*hh+kk*kk;
        const double sq=std::sqrt(p/mu);
        const double dp=(2*p/w)*sq*at;
        const double df= sq*( ar*sL + ((w+1)*cL+ff)*at/w - (hh*sL-kk*cL)*gg*an/w);
        const double dg= sq*(-ar*cL + ((w+1)*sL+gg)*at/w + (hh*sL-kk*cL)*ff*an/w);
        const double dh= sq*s2*cL/(2*w)*an;
        const double dk= sq*s2*sL/(2*w)*an;
        const double dL= std::sqrt(mu*p)*(w/p)*(w/p) + (1.0/w)*sq*(hh*sL-kk*cL)*an;
        return {dp,df,dg,dh,dk,dL};
    };
    StepStats st;
    m = integrate<6>(f, m, 0.0, tf, rtol, atol, st);
    Vec3 r, v; meeToRv(m, mu, r, v);
    return {r, v, st};
}

// --------------------------------------------------------------------------
// KS (Kustaanheimo-Stiefel) regularized propagation.
// Integrate the 10-state in fictitious time s; the physical time t is a
// component of the state (dt/ds = r). We advance in s-chunks and, on the
// step that overshoots tf in physical time, bisect s to land on tf exactly.
// --------------------------------------------------------------------------
inline PropResult propagateKS(const Vec3& r0, const Vec3& v0, double tf,
                              const ForceConfig& c, double rtol, double atol) {
    const double mu = c.mu;
    KSState ks = ksFromCartesian(r0, v0, mu);
    State<10> y{ks.u[0],ks.u[1],ks.u[2],ks.u[3],
                ks.up[0],ks.up[1],ks.up[2],ks.up[3], 0.0, ks.E};
    auto f = [&](double s, const State<10>& yy){ return ksRhs(s, yy, c); };

    // Estimate total fictitious-time span. For a Kepler ellipse ds = dt/r and
    // over one period Δs = 2π/√(-2E)·(1/√...) ; simplest: pick an s-chunk of
    // ~ (period)/(a) and iterate, refining the last step by bisection on t.
    const double sma0 = 1.0/(2.0/norm(r0) - dot(v0,v0)/mu);
    // mean radius ~ a, so ds_per_dt ~ 1/a ; step ~ tf/a split into pieces
    double s = 0.0;
    StepStats st;
    const double dsGuess = (tf / std::max(sma0,1.0)) / 200.0; // ~200 chunks
    int guard = 0;
    while (y[8] < tf - 1e-9 && guard++ < 1000000) {
        double s_end = s + dsGuess;
        State<10> ytry = integrate<10>(f, y, s, s_end, rtol, atol, st);
        if (ytry[8] < tf) { y = ytry; s = s_end; continue; }
        // Overshoot within [s, s_end]. Safeguarded Newton on the physical-time
        // residual g(σ)=t(σ)-tf, with dt/ds = r (a state component) available
        // directly from the RHS. Steps leaving the bracket fall back to
        // bisection (robust on eccentric orbits where r varies strongly).
        double lo=s, hi=s_end, sguess=0.5*(lo+hi);
        for (int it=0; it<60; ++it) {
            State<10> ym = integrate<10>(f, y, s, sguess, rtol, atol, st);
            double resid = ym[8] - tf;
            if (resid < 0) lo = sguess; else hi = sguess;
            if (std::abs(resid) < 1e-9) break;
            std::array<double,4> uu{ym[0],ym[1],ym[2],ym[3]};
            double drate = ksRadius(uu);           // dt/ds = r > 0
            double snew = sguess - resid/drate;
            sguess = (snew>lo && snew<hi) ? snew : 0.5*(lo+hi);
        }
        y = integrate<10>(f, y, s, sguess, rtol, atol, st);
        break;
    }
    std::array<double,4> u{y[0],y[1],y[2],y[3]}, up{y[4],y[5],y[6],y[7]};
    Vec3 r = ksPosition(u), v = ksVelocity(u, up);
    return {r, v, st};
}

// --------------------------------------------------------------------------
// DROMO regularized element propagation. Independent variable is the ideal
// anomaly sigma; physical time tau is a state component (non-dimensional).
// We advance in sigma and bisect the final step to land on tf.
// --------------------------------------------------------------------------
inline PropResult propagateDromo(const Vec3& r0, const Vec3& v0, double tf,
                                 const ForceConfig& c, double rtol, double atol) {
    DromoSetup S = dromoInit(r0, v0, c.mu);
    const double tau_target = tf / S.Tc;               // non-dim target time
    State<8> y = S.y0;
    double sigma = S.sigma0;
    auto f = [&](double sg, const State<8>& yy){ return dromoRhs(sg, yy, S, c); };
    StepStats st;
    // Advance a full revolution per outer chunk (the adaptive DP54 stepper
    // subdivides internally), checkpointing (sigma,y) each time so a bisection
    // for the final tau only re-integrates ONE chunk, not the whole arc.
    const double dsig = TWO_PI;
    int guard = 0;
    double sigma_prev = sigma; State<8> y_prev = y;
    while (y[0] < tau_target - 1e-12 && guard++ < 2000000) {
        sigma_prev = sigma; y_prev = y;
        double s_end = sigma + dsig;
        State<8> ytry = integrate<8>(f, y, sigma, s_end, rtol, atol, st);
        if (ytry[0] < tau_target) { y = ytry; sigma = s_end; continue; }
        // Overshoot: safeguarded Newton on tau(σ)-tau_target from the chunk
        // start. dtau/dσ = 1/(z3^3 s^2) comes straight from the state. Newton
        // steps that leave the bracket [lo,hi] fall back to bisection — this
        // matters on eccentric orbits where dtau/dσ varies strongly over a rev.
        double lo=sigma_prev, hi=s_end, sguess=0.5*(lo+hi);
        for (int it=0; it<60; ++it) {
            State<8> ym = integrate<8>(f, y_prev, sigma_prev, sguess, rtol, atol, st);
            double resid = ym[0] - tau_target;
            if (resid < 0) lo = sguess; else hi = sguess;   // maintain bracket
            if (std::abs(resid) < 1e-12) break;
            double z3=ym[3], cs=std::cos(sguess), sn=std::sin(sguess);
            double ss = 1.0 + ym[1]*cs + ym[2]*sn;
            double drate = 1.0/(z3*z3*z3*ss*ss);            // > 0
            double snew = sguess - resid/drate;
            sguess = (snew>lo && snew<hi) ? snew : 0.5*(lo+hi);  // safeguard
        }
        y = integrate<8>(f, y_prev, sigma_prev, sguess, rtol, atol, st);
        sigma = sguess; break;
    }
    Vec3 r, v; dromoToCartesian(S, sigma, y, r, v);
    return {r, v, st};
}

} // namespace hp
