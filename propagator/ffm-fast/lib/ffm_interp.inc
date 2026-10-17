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
    double lastJd = NAN;
};
struct Window {
    bool valid = false;
    std::uint64_t used = 0;
    double lo = NAN, hi = NAN;
    std::array<double, Degree + 1> jd{};
    struct Coordinates {
        double middle = NAN, half = NAN, lastJd = NAN;
        std::array<double, Degree + 1> epoch{}, x{}, weight{}, terms{};
        int node = -1;
    } tdb, tt;
    std::array<ChannelData, Channels> channels;
    bool contains(double t) const { return valid && t >= lo && t < hi; }
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
inline double utcMidnightTt(double midnight) {
    double tai1, tai2, tt1, tt2;
    if (eraUtctai(midnight, 0.0, &tai1, &tai2) < 0 ||
        eraTaitt(tai1, tai2, &tt1, &tt2) != 0)
        throw std::runtime_error("interp UTC-midnight conversion failed");
    return tt1 + tt2;
}
inline void boundaries(double jd, double& lo, double& hi) {
    constexpr double epoch = 2451545.0, day = 86400.0;
    const double tt = timesys::tdbToTt(jd);
    const double seconds = (tt - epoch) * day;
    constexpr double width = 3600.0;
    const double requestedLo = std::floor(seconds / width) * width;
    const double hourLo = std::floor((tt - epoch) * 24.0) * 3600.0;
    // Keep the prototype arithmetic at TT-hour boundaries; UTC midnight
    // also splits the window at the EOP provider's daily-row boundary.
    double loTt = epoch + std::max(requestedLo, hourLo) / day;
    double hiTt = epoch + std::min(requestedLo + width, hourLo + 3600.0) / day;
    double tai1, tai2, utc1, utc2;
    if (eraTttai(epoch, tt - epoch, &tai1, &tai2) != 0 ||
        eraTaiutc(tai1, tai2, &utc1, &utc2) < 0)
        throw std::runtime_error("interp TT/UTC conversion failed");
    const double midnight = std::floor(utc1 + utc2 - 0.5) + 0.5;
    loTt = std::max(loTt, utcMidnightTt(midnight));
    hiTt = std::min(hiTt, utcMidnightTt(midnight + 1.0));
    lo = timesys::ttToTdb(loTt);
    hi = timesys::ttToTdb(hiTt);
    if (!(hi > lo) || jd < lo || jd > hi)
        throw std::runtime_error("invalid interpolation window");
}
inline void initialize(Window& w, double jd) {
    boundaries(jd, w.lo, w.hi);
    w.valid = true;
    w.tdb.middle = w.lo + (w.hi - w.lo) * 0.5;
    w.tdb.half = (w.hi - w.lo) * 0.5;
    w.tdb.lastJd = w.tt.lastJd = NAN;
    for (auto& c : w.channels) { c.fitted = false; c.rejected = false; c.lastJd = NAN; }
    const double ttLo = timesys::tdbToTt(w.lo), ttHi = timesys::tdbToTt(w.hi);
    w.tt.middle = ttLo + (ttHi - ttLo) * 0.5;
    w.tt.half = (ttHi - ttLo) * 0.5;
    constexpr double pi = 3.141592653589793238462643383279502884;
    for (int i = 0; i <= Degree; ++i) {
        const double tt = i == 0 ? ttHi : i == Degree ? ttLo :
                          w.tt.middle + w.tt.half * std::cos(pi * i / Degree);
        w.jd[i] = timesys::ttToTdb(tt);
        w.tdb.epoch[i] = w.jd[i];
        w.tt.epoch[i] = timesys::tdbToTt(w.jd[i]);
    }
    // Use each source's actual representable time argument: rotation, UT1
    // read TT, whereas ephemerides read TDB. A single-JD
    // TDB<->TT conversion has ~40 us quantization steps; fitting a TT
    // source against TDB would spread a numerical step across the window.
    // Both sets use the same exact-source CGL samples, without smoothing or
    // changing the source time conversions.
    for (auto* coordinates : {&w.tdb, &w.tt}) {
        auto& c = *coordinates;
        for (int i = 0; i <= Degree; ++i)
            c.x[i] = (c.epoch[i] - c.middle) / c.half;
        double largest = 0;
        for (int i = 0; i <= Degree; ++i) {
            long double product = 1;
            for (int j = 0; j <= Degree; ++j) if (i != j)
                product *= static_cast<long double>(c.x[i]) - c.x[j];
            if (product == 0) throw std::runtime_error("interp window too short for distinct Julian-date nodes");
            c.weight[i] = static_cast<double>(1 / product);
            largest = std::max(largest, std::abs(c.weight[i]));
        }
        for (int i = 0; i <= Degree; ++i) c.weight[i] /= largest;
    }
}
inline Window& window(double jd, const Forces& f) {
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
inline Window::Coordinates& evaluationWeights(Window& w, double jd, Channel channel) {
    const bool usesTt = channel == Rotation || channel == Ut1;
    auto& c = usesTt ? w.tt : w.tdb;
    if (c.lastJd == jd) return c;
    c.lastJd = jd;
    c.node = -1;
    const double epoch = usesTt ? timesys::tdbToTt(jd) : jd;
    const double x = (epoch - c.middle) / c.half;
    double sum = 0;
    for (int i = 0; i <= Degree; ++i) {
        if (epoch == c.epoch[i]) { c.node = i; return c; }
        c.terms[i] = c.weight[i] / (x - c.x[i]);
        sum += c.terms[i];
    }
    for (int i = 0; i <= Degree; ++i) c.terms[i] /= sum;
    return c;
}

template<class Fill>
bool interpolate(double jd, const Forces& f, Channel channel, int count, double* out, Fill exact) {
    if (!active(f)) return false;
    if (count < 1 || count > MaxComponents)
        throw std::runtime_error("invalid interpolation channel width");
    Window& w = window(jd, f);
    ChannelData& c = w.channels[channel];
    if (c.rejected) return false;
    if (!c.fitted || c.count != count) {
        // The requested epoch can be covered even when a fitting node is
        // outside a supplied provider's range. Reject that channel/window
        // once and let the caller evaluate its actual epoch exactly.
        try {
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
        } catch (const std::exception&) {
            c.rejected = true;
            return false;
        }
        c.fitted = true;
    }
    if (c.lastJd != jd) {
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
astro::EphemerisState body(double jd, const Forces& f, int slot, Exact exact) {
    if (!active(f)) return exact(jd);
    double out[9];
    if (!interpolate(jd, f, Channel(Sun + slot), 9, out, [&](double t, double* v) {
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
    state.epoch = jd;
    return state;
}

} // namespace ffm_interp
