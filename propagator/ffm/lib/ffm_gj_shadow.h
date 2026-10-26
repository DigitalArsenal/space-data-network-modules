#pragma once
#include "ffm_gj_core.h"
#include "ffm_gj_clock.h"
#include "ffm_gj_event_scan.h"
#include "ffm_gj_forces.h"
#include <utility>
#include <vector>

namespace ffm_fast::gjshadow {
using Point = gj::Point<3>;
using Core = gj::Integrator<3>;
using gjforces::Forces;
using astro::Vec3;
inline Vec3 vector(const gj::Vector<3>& x) { return {x[0], x[1], x[2]}; }
struct Path {
    double t0, h;
    Point left, right;
    void state(double u, Vec3& r, Vec3& v) const {
        double position[3], velocity[3];
        for (int j = 0; j < 3; ++j) {
            const double r0 = left.r[j], v0 = h*left.v[j], a0 = h*h*left.a[j];
            const double dr = right.r[j]-r0-v0-a0/2;
            const double dv = h*right.v[j]-v0-a0, da = h*h*right.a[j]-a0;
            const double c3 = 10*dr-4*dv+da/2, c4 = -15*dr+7*dv-da, c5 = 6*dr-3*dv+da/2;
            position[j] = r0+u*(v0+u*(a0/2+u*(c3+u*(c4+u*c5))));
            velocity[j] = (v0+u*(a0+u*(3*c3+u*(4*c4+5*u*c5))))/h;
        }
        r = {position[0], position[1], position[2]};
        v = {velocity[0], velocity[1], velocity[2]};
    }
};
inline Path path(const Point& a, const Point& b) { return {a.x, b.x-a.x, a, b}; }
inline gj::Vector<3> ordinateAt(const Core& core, double z) {
    gj::Vector<3> a{};
    for (int j = 0; j < 9; ++j) {
        double w = 1;
        for (int k = 0; k < 9; ++k) if (j != k) w *= (z-(k-8))/double(j-k);
        for (int d = 0; d < 3; ++d) a[d] += w*core.history[j].a[d];
    }
    return a;
}
inline gjforces::ShadowValues values(const Forces& f, const GjClock& clock, const Path& p, double u) {
    Vec3 r, v; p.state(u, r, v);
    return gjforces::shadowValues(f, clock.at(p.t0+u*p.h), r);
}
// True when no switching function can change sign along the path, so the scan
// can only find no root. Each function is the Sun-nadir angle less asin terms
// of |r| and |d| (d the Sun from the spacecraft); along the path none moves by
// more than L = turn of r + turn of d + change of asin(R_E/|r|) + change of
// asin(R_sun/|d|), each bounded from the path polynomial's coefficient sums
// (|r - r0| <= D and |dr/du| <= V on [0, 1]) and the Sun's motion relative to
// the Earth (under 40 km/s). Both end values must share their sign and exceed
// 2 L in size, for all three functions.
inline bool clearOfBoundaries(const Forces& f, const GjClock& clock, const Path& p) {
    double displacement[3], derivative[3];
    for (int j = 0; j < 3; ++j) {
        const double r0 = p.left.r[j], v0 = p.h*p.left.v[j], a0 = p.h*p.h*p.left.a[j];
        const double dr = p.right.r[j]-r0-v0-a0/2;
        const double dv = p.h*p.right.v[j]-v0-a0, da = p.h*p.h*p.right.a[j]-a0;
        const double q[5] = {v0, a0/2, 10*dr-4*dv+da/2, -15*dr+7*dv-da, 6*dr-3*dv+da/2};
        displacement[j] = derivative[j] = 0;
        for (int i = 0; i < 5; ++i) {
            displacement[j] += std::abs(q[i]);
            derivative[j] += (i+1)*std::abs(q[i]);
        }
    }
    const double D = std::sqrt(displacement[0]*displacement[0]+displacement[1]*displacement[1]+displacement[2]*displacement[2]);
    const double V = std::sqrt(derivative[0]*derivative[0]+derivative[1]*derivative[1]+derivative[2]*derivative[2]);
    const Vec3 r0 = vector(p.left.r);
    const double rMin = r0.magnitude()-D;
    if (!(rMin > 1.01*astro::RE_EARTH) || !std::isfinite(V)) return false;
    const double sunMove = 40.0*std::abs(p.h);
    const double dMin = (gjforces::sun(f, clock.at(p.t0))-r0).magnitude()-D-sunMove;
    if (!(dMin > 1.01*astro::shadow::SUN_RADIUS_KM)) return false;
    const double sb = astro::RE_EARTH/rMin, sa = astro::shadow::SUN_RADIUS_KM/dMin;
    const double bound = V/rMin + (V+sunMove)/dMin
        + astro::RE_EARTH*V/(rMin*rMin*std::sqrt(1-sb*sb))
        + astro::shadow::SUN_RADIUS_KM*(V+sunMove)/(dMin*dMin*std::sqrt(1-sa*sa));
    const auto start = values(f, clock, p, 0), end = values(f, clock, p, 1);
    for (int k = 0; k < 3; ++k)
        if (!(start[k]*end[k] > 0 && std::min(std::abs(start[k]), std::abs(end[k])) > 2*bound)) return false;
    return true;
}
inline std::vector<gjscan::Root> scan(const Forces& f, const GjClock& clock, const Path& p) {
    if (!f.useSRP) return {};
    if (clearOfBoundaries(f, clock, p)) return {};
    return gjscan::collect([&](double u) { return values(f, clock, p, u); }, p.h);
}
inline bool finalBranch(const Forces& f, const GjClock& clock, const Path& p,
                        const std::vector<gjscan::Root>& roots) {
    for (auto i = roots.rbegin(); i != roots.rend(); ++i)
        if (i->boundary == 2 && (1-i->u)*p.h < 1e-7) return !i->entering;
    return values(f, clock, p, 1).midpoint >= 0;
}
inline bool sameRoots(const Path& a, const std::vector<gjscan::Root>& x,
                      const Path& b, const std::vector<gjscan::Root>& y) {
    if (x.size() != y.size()) return false;
    for (size_t i = 0; i < x.size(); ++i)
        if (x[i].boundary != y[i].boundary || x[i].entering != y[i].entering ||
            std::abs(x[i].u*a.h-y[i].u*b.h) > 2e-6) return false;
    return true;
}
template<size_t N> inline const std::array<std::pair<double, double>, N>& rule() {
    static const auto nodes = [] {
        std::array<std::pair<double, double>, N> result{};
        const long double pi = std::acos(-1.L);
        for (size_t i = 0; i < N; ++i) {
            long double z = std::cos(pi*(i+.75L)/(N+.5L)), dp = 0;
            for (int k = 0; k < 30; ++k) {
                long double p = 1, q = 0;
                for (size_t j = 1; j <= N; ++j) { const auto old = p; p=((2*j-1)*z*p-(j-1)*q)/j; q=old; }
                dp=N*(z*p-q)/(z*z-1);
                const auto dz=p/dp; z-=dz;
                if (std::abs(dz)<2e-19L) break;
            }
            result[i] = {double(z), double(2/((1-z*z)*dp*dp))};
        }
        return result;
    }();
    return nodes;
}
struct Moments { Vec3 r, v; };
template<size_t N> inline Moments quadrature(const Forces& f, const GjClock& clock,
                                              const Path& p, bool sunlit, double lo, double hi) {
    Moments m;
    const double half=(hi-lo)/2, center=(hi+lo)/2;
    for (const auto& node : rule<N>()) {
        const double u=center+half*node.first;
        Vec3 r, v; p.state(u, r, v);
        const auto da=gjforces::srpCorrection(f, clock.at(p.t0+u*p.h), r, v, sunlit)*(-1);
        const double w=node.second*half*p.h;
        m.v+=da*w; m.r+=da*(w*(1-u)*p.h);
    }
    return m;
}
inline Moments integrate(const Forces& f, const GjClock& clock, const Path& p,
                         bool sunlit, double lo, double hi, int depth) {
    const auto g=values(f, clock, p, (lo+hi)/2);
    if ((sunlit && g.penumbra>=0) || (!sunlit && g.umbra<=0)) return {};
    const auto a=quadrature<8>(f,clock,p,sunlit,lo,hi), b=quadrature<16>(f,clock,p,sunlit,lo,hi);
    if (depth>=8 || ((a.v-b.v).magnitude()<2e-16 && (a.r-b.r).magnitude()<2e-13)) return b;
    const auto left=integrate(f,clock,p,sunlit,lo,(lo+hi)/2,depth+1);
    const auto right=integrate(f,clock,p,sunlit,(lo+hi)/2,hi,depth+1);
    return {left.r+right.r, left.v+right.v};
}
inline Moments moments(const Forces& f, const GjClock& clock, const Path& p,
                       const std::vector<gjscan::Root>& roots, bool sunlit) {
    if (!f.useSRP) return {};
    std::vector<double> cuts{0};
    for (const auto& root : roots) if (root.u>cuts.back()+1e-14 && root.u<1) cuts.push_back(root.u);
    cuts.push_back(1);
    Moments total;
    for (size_t i=1; i<cuts.size(); ++i) {
        const auto m=integrate(f,clock,p,sunlit,cuts[i-1],cuts[i],0);
        total.r+=m.r; total.v+=m.v;
    }
    return total;
}
// Corrected-path rescans are transactional: every trial restores the same
// history and branch. A midpoint enter/exit pair is retained even when the
// final branch equals the initial one, and no impulse is applied twice.
template<class Eval> inline Point step(Core& core, const Forces& f, const GjClock& clock,
                                      bool& sunlit, Eval&& eval) {
    const Core saved=core;
    const bool originalBranch=sunlit;
    const Point old=core.current();
    Point predicted=core.predict();
    predicted.a=ordinateAt(core, 1);
    auto trajectory=path(old,predicted);
    auto roots=scan(f,clock,trajectory);
    for (int trial=0; trial<6; ++trial) {
        core=saved; sunlit=originalBranch;
        auto changeBranch=[&](bool branch) {
            if (branch==sunlit) return;
            sunlit=branch; core.rebase(eval);
        };
        for (const auto& root: roots) if (root.boundary==2) changeBranch(!root.entering);
        changeBranch(finalBranch(f,clock,trajectory,roots));
        Point candidate=core.step(eval,false);
        const auto m=moments(f,clock,trajectory,roots,sunlit);
        const bool adjusted=m.r.magnitude()>0 || m.v.magnitude()>0;
        if (adjusted) {
            const auto r=vector(candidate.r)+m.r, v=vector(candidate.v)+m.v;
            candidate.r={r.x,r.y,r.z}; candidate.v={v.x,v.y,v.z}; candidate.a=eval(candidate);
        }
        auto corrected=path(old,candidate);
        auto correctedRoots=scan(f,clock,corrected);
        if (finalBranch(f,clock,corrected,correctedRoots)==sunlit && sameRoots(trajectory,roots,corrected,correctedRoots)) {
            core.current()=candidate;
            if (adjusted) core.resetSums();
            return candidate;
        }
        trajectory=corrected; roots=std::move(correctedRoots);
    }
    core=saved; sunlit=originalBranch;
    astro::flagIntegrationFailure("GJ corrected shadow events did not converge");
    return old;
}
} // namespace ffm_fast::gjshadow
