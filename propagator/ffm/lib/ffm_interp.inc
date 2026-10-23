#pragma once

// Time-only interpolation lives in the force set's OceanTideCache, so ingest
// creates a fresh cache and every object sharing that environment reuses it.
// Include before ephemeris redirects: exact callbacks must reach the standard
// source functions while ExactScope prevents recursive cache use.
#include "erfa.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <exception>
#include <stdexcept>

namespace ffm_interp {
using Forces = astro::ForceModel::ForceModelSet;
using Instant = timesys::Instant;
inline bool same(const Instant& a, const Instant& b) { return a.jd1 == b.jd1 && a.jd2 == b.jd2; }
enum Channel { Rotation, Ut1, Sun, Moon, Venus, Mars, Jupiter, Channels };
constexpr int Degree = 12;
constexpr int MaxComponents = 9;
inline thread_local unsigned bypassDepth = 0;
struct ExactScope {
    ExactScope() { ++bypassDepth; }
    ~ExactScope() { --bypassDepth; }
    ExactScope(const ExactScope&) = delete;
    ExactScope& operator=(const ExactScope&) = delete;
};
inline bool active(const Forces& f) { return f.oceanTideCache && f.earthFixedRotation && !bypassDepth; }

struct ChannelData {
    bool fitted = false, rejected = false;
    int count = 0;
    // Values at CGL nodes; barycentric evaluation is the polynomial through
    // these nodes, and avoids an additional DCT/Clenshaw roundoff layer.
    std::array<std::array<double, MaxComponents>, Degree + 1> samples{};
    std::array<double, MaxComponents> last{};
    Instant lastJd{NAN, NAN};
};
struct Window {
    bool valid = false;
    std::uint64_t used = 0;
    Instant lo{NAN, NAN}, hi{NAN, NAN};
    std::array<Instant, Degree + 1> jd{};
    struct Coordinates {
        double half = NAN;
        Instant lastJd{NAN, NAN};
        std::array<double, Degree + 1> x{}, weight{}, terms{};
        int node = -1;
    } tt;
    std::array<ChannelData, Channels> channels;
    bool contains(const Instant& t) const { return valid && t.secondsSince(lo) >= 0 && t.secondsSince(hi) < 0; }
};
struct Cache {
    std::uint64_t tick = 0;
    std::array<Window, 8> windows;
    Window* previous = nullptr;
};
// Defined after OceanTideCache in force_models.cpp. Callers enter only when
// active(f) is true; the shared_ptr owns all cross-evaluation validity.
Cache& cache(const Forces& f);

// ERFA is the supplied EOP provider's own UTC/TT conversion, including its
// leap-second convention. The split lies at the same daily-row boundary.
inline Instant utcMidnightTt(double midnight) {
    double tai1, tai2, tt1, tt2;
    if (eraUtctai(midnight, 0.0, &tai1, &tai2) < 0 ||
        eraTaitt(tai1, tai2, &tt1, &tt2) != 0)
        {
#if defined(__cpp_exceptions)
        throw std::runtime_error("interp UTC-midnight conversion failed");
#else
        astro::flagForceFailure(); return {NAN, NAN};
#endif
    }
    return {tt1, tt2};
}
inline void boundaries(const Instant& jd, Instant& lo, Instant& hi) {
    const double day = std::floor(jd.jd1 - 2451545.0);
    const double hour = day * 24.0 + std::floor(((jd.jd1 - 2451545.0 - day) + jd.jd2) * 24.0);
    lo = Instant::fromTTSeconds(hour * 3600.0, 0);
    hi = lo.plusSeconds(3600.0);
    const auto utc = jd.utc();
    const double utcDay1 = std::floor(utc.jd1 - 0.5) + 0.5;
    const double midnight = utcDay1 + std::floor((utc.jd1 - utcDay1) + utc.jd2);
    const auto dayLo = utcMidnightTt(midnight), dayHi = utcMidnightTt(midnight + 1.0);
    if (dayLo.secondsSince(lo) > 0) lo = dayLo;
    if (dayHi.secondsSince(hi) < 0) hi = dayHi;
    if (!(hi.secondsSince(lo) > 0) || jd.secondsSince(lo) < 0 || jd.secondsSince(hi) > 0)
        {
#if defined(__cpp_exceptions)
        throw std::runtime_error("invalid interpolation window");
#else
        astro::flagForceFailure(); return;
#endif
    }
}
inline void initialize(Window& w, const Instant& jd) {
    boundaries(jd, w.lo, w.hi);
    if (astro::propagationStop().active) { w.valid=false; return; }
    w.valid = true;
    w.tt.half = w.hi.secondsSince(w.lo) * 0.5;
    w.tt.lastJd = {NAN, NAN};
    for (auto& c : w.channels) { c.fitted = false; c.rejected = false; c.lastJd = {NAN, NAN}; }
    constexpr double pi = 3.141592653589793238462643383279502884;
    for (int i = 0; i <= Degree; ++i) {
        const double offset = i == 0 ? 2 * w.tt.half : i == Degree ? 0 :
                              w.tt.half * (1 + std::cos(pi * i / Degree));
        w.jd[i] = w.lo.plusSeconds(offset);
        w.tt.x[i] = w.jd[i].secondsSince(w.lo) / w.tt.half - 1;
    }
    // Local two-part TT differences retain the standard clock's precision.
    // Ephemeris callbacks convert each Instant to TDB without a large-JD sum.
    auto& c = w.tt;
    double largest = 0;
    for (int i = 0; i <= Degree; ++i) {
        long double product = 1;
        for (int j = 0; j <= Degree; ++j) if (i != j)
            product *= static_cast<long double>(c.x[i]) - c.x[j];
        if (product == 0) {
#if defined(__cpp_exceptions)
        throw std::runtime_error("interp window too short for distinct time nodes");
#else
        astro::flagForceFailure(); w.valid=false; return;
#endif
    }
        c.weight[i] = static_cast<double>(1 / product);
        largest = std::max(largest, std::abs(c.weight[i]));
    }
    for (int i = 0; i <= Degree; ++i) c.weight[i] /= largest;
}
inline Window& window(const Instant& jd, const Forces& f) {
    Cache& c = cache(f);
    if (c.previous && c.previous->contains(jd)) return *c.previous;
    for (auto& w : c.windows) if (w.contains(jd)) {
        w.used = ++c.tick;
        c.previous = &w;
        return w;
    }
    Window* replace = &c.windows.front();
    for (auto& w : c.windows) {
        if (!w.valid) { replace = &w; break; }
        if (w.used < replace->used) replace = &w;
    }
    initialize(*replace, jd);
    replace->used = ++c.tick;
    c.previous = replace;
    return *replace;
}
inline Window::Coordinates& evaluationWeights(Window& w, const Instant& jd, Channel channel) {
    auto& c = w.tt;
    if (same(c.lastJd, jd)) return c;
    c.lastJd = jd;
    c.node = -1;
    const double x = jd.secondsSince(w.lo) / c.half - 1;
    double sum = 0;
    for (int i = 0; i <= Degree; ++i) {
        if (x == c.x[i]) { c.node = i; return c; }
        c.terms[i] = c.weight[i] / (x - c.x[i]);
        sum += c.terms[i];
    }
    for (int i = 0; i <= Degree; ++i) c.terms[i] /= sum;
    return c;
}

template<class Fill>
bool interpolate(const Instant& jd, const Forces& f, Channel channel, int count, double* out, Fill exact) {
    if (!active(f)) return false;
    if (count < 1 || count > MaxComponents)
        {
#if defined(__cpp_exceptions)
        throw std::runtime_error("invalid interpolation channel width");
#else
        astro::flagForceFailure(); return false;
#endif
    }
    Window& w = window(jd, f);
    if (!w.valid || astro::propagationStop().active) return false;
    ChannelData& c = w.channels[channel];
    if (c.rejected) return false;
    if (!c.fitted || c.count != count) {
        // The requested epoch can be covered even when a fitting node is
        // outside a supplied provider's range. Reject that channel/window
        // once and let the caller evaluate its actual epoch exactly.
#if defined(__cpp_exceptions)
        try
#endif
        {
            ExactScope exactScope;
            c.count = count;
            for (int i = 0; i <= Degree; ++i) {
                exact(w.jd[i], c.samples[i].data());
                const auto& sample = c.samples[i];
                for (int j = 0; j < count; ++j) {
                    if (!std::isfinite(sample[j])) { c.rejected = true; return false; }
                }
                if (channel >= Sun &&
                    (sample[6] != 1.0 || sample[7] != c.samples[0][7] ||
                     sample[8] != c.samples[0][8])) {
                    c.rejected = true;
                    return false;
                }
            }
        }
#if defined(__cpp_exceptions)
        catch (const std::exception&) {
            c.rejected = true;
            return false;
        }
#endif
        if (astro::propagationStop().active) return false;
        c.fitted = true;
    }
    if (!same(c.lastJd, jd)) {
        const auto& weights = evaluationWeights(w, jd, channel);
        if (weights.node >= 0) {
            std::copy_n(c.samples[weights.node].data(), count, c.last.data());
        } else {
            // Interpolate deviations from a nearby sample. This preserves
            // large constant offsets (UT1 JD, body positions) accurately.
            const int reference = Degree / 2;
            for (int j = 0; j < count; ++j) {
                const double offset = c.samples[reference][j];
                double delta = 0;
                for (int i = 0; i <= Degree; ++i)
                    delta += weights.terms[i] * (c.samples[i][j] - offset);
                c.last[j] = offset + delta;
            }
        }
        c.lastJd = jd;
    }
    std::copy_n(c.last.data(), count, out);
    return true;
}

template<class Exact>
astro::EphemerisState body(const Instant& jd, const Forces& f, int slot, Exact exact) {
    if (!active(f)) return exact(jd);
    double out[9];
    if (!interpolate(jd, f, Channel(Sun + slot), 9, out, [&](const Instant& t, double* v) {
        const auto state = exact(t);
        v[0] = state.position.x; v[1] = state.position.y; v[2] = state.position.z;
        v[3] = state.velocity.x; v[4] = state.velocity.y; v[5] = state.velocity.z;
        v[6] = state.valid ? 1.0 : 0.0;
        v[7] = static_cast<double>(state.source);
        v[8] = static_cast<double>(state.body);
    })) return exact(jd);
    astro::EphemerisState state;
    state.position = astro::Vec3(out[0], out[1], out[2]);
    state.velocity = astro::Vec3(out[3], out[4], out[5]);
    state.valid = out[6] >= 0.5;
    state.source = static_cast<astro::Ephemeris::EphemerisSource>(std::lround(out[7]));
    state.body = static_cast<astro::CelestialBody>(std::lround(out[8]));
    state.epoch = jd.jdTdb();
    return state;
}

} // namespace ffm_interp
