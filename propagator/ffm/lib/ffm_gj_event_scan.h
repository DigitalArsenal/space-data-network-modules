#pragma once

// Root collection for the three smooth conical-shadow switching functions.
// This is a geometric scan: it never evaluates an acceleration. The caller
// supplies a predicted or corrected interpolating trajectory in eval(u).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <map>
#include "reentry.h"
#include <string>
#include <utility>
#include <vector>

namespace ffm_fast::gjscan {

struct Options {
    int min_intervals = 16;
    double max_interval_seconds = 30;
    double time_tolerance = 1e-7;
    bool include_left = false;
};

struct Root {
    double u = 0;
    int boundary = -1; // penumbra=0, umbra=1, angular midpoint=2
    double g_before = 0, g_after = 0;
    bool entering = false;
    double lo = 0, hi = 0;
};

namespace detail {

// Bounded Brent minimization. An extremum inserted into the common sample
// table reveals two crossings even when every original grid sample has the
// same sign. The parabolic steps make ordinary quadratic grazes inexpensive.
template<class F>
double minimum(F&& f, double a, double b, double initial, double tolerance) {
    constexpr double golden = 0.3819660112501051518;
    double x = std::max(a, std::min(b, initial)), w = x, v = x;
    double fx = f(x), fw = fx, fv = fx, movement = 0, previous = 0;
    for (int iteration = 0; iteration < 96; ++iteration) {
        const double middle = (a+b)*0.5;
        const double tol = tolerance + 8*std::numeric_limits<double>::epsilon()*std::abs(x);
        const double twice = 2*tol;
        if (std::abs(x-middle) <= twice-(b-a)*0.5) break;
        bool parabolic = false;
        if (std::abs(previous) > tol) {
            double r = (x-w)*(fx-fv), q = (x-v)*(fx-fw);
            double p = (x-v)*q-(x-w)*r;
            q = 2*(q-r);
            if (q > 0) p = -p;
            else q = -q;
            const double old = previous;
            previous = movement;
            if (q > 0 && std::abs(p) < std::abs(0.5*q*old)
                && p > q*(a-x) && p < q*(b-x)) {
                movement = p/q;
                const double trial = x+movement;
                if (trial-a < twice || b-trial < twice)
                    movement = std::copysign(tol, middle-x);
                parabolic = true;
            }
        }
        if (!parabolic) {
            previous = x < middle ? b-x : a-x;
            movement = golden*previous;
        }
        const double u = x+(std::abs(movement) >= tol ? movement : std::copysign(tol,movement));
        const double fu = f(u);
        if (fu <= fx) {
            if (u < x) b = x; else a = x;
            v = w; fv = fw; w = x; fw = fx; x = u; fx = fu;
        } else {
            if (u < x) a = u; else b = u;
            if (fu <= fw || w == x) { v = w; fv = fw; w = u; fw = fu; }
            else if (fu <= fv || v == x || v == w) { v = u; fv = fu; }
        }
    }
    return x;
}

inline bool opposite(double a, double b) { return (a < 0 && b > 0) || (a > 0 && b < 0); }

} // namespace detail

// At least 16 subintervals are inspected, with additional samples around every
// resolved turning point. Shadow geometry on a polynomial orbit interpolant is
// smooth on an orbital scale; this does not claim to find all roots of an
// arbitrary adversarial/high-frequency callback. Exact tangencies have no
// branch change and are deliberately omitted. A root exactly at the left
// endpoint belongs to the previous step unless include_left is requested.
template<class Eval>
std::vector<Root> collect(Eval&& eval, double duration_seconds,
                          const Options& options = {}, std::size_t* evaluations = nullptr) {
    if (!(duration_seconds > 0) || !std::isfinite(duration_seconds)) return {};
    if (!(options.time_tolerance > 0) || !(options.max_interval_seconds > 0))
        { astro::flagIntegrationFailure("invalid shadow scan tolerance or interval"); return {}; }
    const int intervals = std::max(16, std::max(options.min_intervals,
        int(std::ceil(duration_seconds/options.max_interval_seconds))));
    const double u_tolerance = options.time_tolerance/duration_seconds;
    // The memo of evaluated samples, ascending in u with exact-key lookup: the
    // order and lookup of an ordered map, in one contiguous block.
    struct Sample { double u; std::array<double,3> g; };
    std::vector<Sample> samples;
    samples.reserve(4*(intervals+1));
    auto sample = [&](double u) -> std::array<double,3> {
        const auto at = std::lower_bound(samples.begin(), samples.end(), u,
                                         [](const Sample& s, double x) { return s.u < x; });
        if (at != samples.end() && !(u < at->u)) return at->g;
        const auto raw = eval(u);
        const std::array<double,3> g{{raw[0],raw[1],raw[2]}};
        if (!std::isfinite(g[0]) || !std::isfinite(g[1]) || !std::isfinite(g[2]))
            astro::flagIntegrationFailure("nonfinite shadow switching function");
        if (evaluations) ++*evaluations;
        samples.insert(at, Sample{u, g});
        return g;
    };
    std::vector<double> grid(intervals+1);
    for (int i=0; i<=intervals; ++i) { grid[i] = double(i)/intervals; sample(grid[i]); }
    if (astro::propagationStop().active) return {};
    for (int k=0; k<3; ++k) {
        std::vector<std::pair<double,double>> searched;
        auto extremum = [&](double a, double b, double initial, double sign) {
            for (const auto& old : searched)
                if (std::abs(old.first-a) < 1e-14 && std::abs(old.second-b) < 1e-14) return;
            searched.emplace_back(a,b);
            const double u = detail::minimum([&](double x){ return sign*sample(x)[k]; },
                                               a,b,initial,u_tolerance*0.125);
            sample(u);
        };
        for (int i=1; i<intervals; ++i) {
            const double a=grid[i-1], x=grid[i], b=grid[i+1];
            const double ya=sample(a)[k], yx=sample(x)[k], yb=sample(b)[k];
            if (yx<=ya && yx<=yb && (yx<ya || yx<yb)) extremum(a,b,x,1);
            if (yx>=ya && yx>=yb && (yx>ya || yx>yb)) extremum(a,b,x,-1);
            // A narrow graze in the first or last grid cell need not have a
            // sampled local extremum. The end triplet's quadratic vertex
            // provides a bracket and starting point for that case.
            if (i==1 || i==intervals-1) {
                const double curvature=ya-2*yx+yb;
                if (curvature != 0) {
                    const double vertex=x+0.5*(x-a)*(ya-yb)/curvature;
                    const bool endCell=(i==1 && vertex>a && vertex<x)
                        || (i==intervals-1 && vertex>x && vertex<b);
                    if (endCell) extremum(a,b,vertex,curvature>0 ? 1 : -1);
                }
            }
        }
    }

    std::vector<Root> roots;
    if (astro::propagationStop().active) return {};
    for (int k=0; k<3; ++k) {
        // Freeze the sample coordinates before bisection adds more samples.
        std::vector<std::pair<double,double>> values;
        values.reserve(samples.size());
        for (const auto& s : samples) values.emplace_back(s.u,s.g[k]);
        for (std::size_t i=0; i+1<values.size(); ++i) {
            double lo=values[i].first, hi=values[i+1].first;
            double gl=values[i].second, gh=values[i+1].second;
            if (!detail::opposite(gl,gh)) continue;
            for (int iteration=0; iteration<96 && hi-lo>u_tolerance; ++iteration) {
                const double middle=(lo+hi)*0.5;
                const double gm=sample(middle)[k];
                if (gm==0) {
                    lo=hi=middle;
                    break;
                }
                if (detail::opposite(gl,gm)) { hi=middle; gh=gm; }
                else { lo=middle; gl=gm; }
            }
            roots.push_back({(lo+hi)*0.5,k,gl,gh,gl>gh,lo,hi});
        }
        // Exact zeros at samples require signs on both sides: a tangent is
        // not an event. At an endpoint extrapolate the limiting branch from
        // the nearest nonzero interior value. No tolerance band discards a
        // small-but-positive root near u=0.
        for (std::size_t i=0; i<values.size(); ++i) if (values[i].second==0) {
            std::size_t l=i, r=i;
            while (l>0 && values[l].second==0) --l;
            while (r+1<values.size() && values[r].second==0) ++r;
            const bool left=i==0, right=i+1==values.size();
            if (left && !options.include_left) continue;
            double gl=values[l].second, gh=values[r].second;
            if (left && gh!=0) gl=-gh;
            if (right && gl!=0) gh=-gl;
            if (detail::opposite(gl,gh)) roots.push_back({values[i].first,k,gl,gh,gl>gh,
                                                        values[i].first,values[i].first});
        }
    }
    std::sort(roots.begin(),roots.end(),[](const Root& a,const Root& b) {
        return a.u<b.u || (a.u==b.u && a.boundary<b.boundary);
    });
    std::vector<Root> unique;
    for (const auto& root : roots) {
        bool duplicate=false;
        for (auto it=unique.rbegin(); it!=unique.rend(); ++it) {
            if ((root.u-it->u)*duration_seconds > 2*options.time_tolerance) break;
            // An entering/exiting pair is never deduplicated, even if its
            // separation is below the requested root-position tolerance.
            if (root.boundary==it->boundary && root.entering==it->entering) { duplicate=true; break; }
        }
        if (!duplicate) unique.push_back(root);
    }
    if (astro::propagationStop().active) return {};
    return unique;
}

} // namespace ffm_fast::gjscan
