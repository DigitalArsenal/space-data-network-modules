// higherpop/atmosphere.hpp — pluggable atmospheric density interface.
//
// The drag force depends on the atmosphere ONLY through a density query. We
// expose that as a small interface so any model — the built-in piecewise
// exponential here, or a high-fidelity model bridged in from propagator/hpop
// (NRLMSISE-00, US76, JB2008, DTM2020) — can be dropped in without touching
// the propagator or the force code.
//
//   DensityFn  : the plug point. kg/m^3 given a DragQuery.
//   IAtmosphere: optional OO base if you prefer a class with state (space
//                weather, cached epoch). `asFn()` adapts it to a DensityFn.
//
// Efficiency note: when drag is off there is zero indirection. When drag is on,
// one indirect call per RHS evaluation is negligible next to the density
// model's own arithmetic — and it buys full model interchangeability.
#pragma once
#include "vec3.hpp"
#include <functional>
#include <cmath>
#include <array>

namespace hp {

// Everything a density model could need for one evaluation.
struct DragQuery {
    Vec3   r_eci;      // ECI position, km
    double alt_km{0};  // geodetic-ish altitude above spherical Earth, km
    double lat_rad{0}; // latitude,  rad (0 if model ignores it)
    double lon_rad{0}; // longitude, rad
    double jd{0};      // Julian date (TDB) — for models with time/space-weather
};

// The plug point: return mass density in kg/m^3.
using DensityFn = std::function<double(const DragQuery&)>;

// Optional OO interface for stateful models (space weather, epoch caches).
struct IAtmosphere {
    virtual ~IAtmosphere() = default;
    virtual double density_si(const DragQuery& q) const = 0;   // kg/m^3
    virtual const char* name() const noexcept { return "IAtmosphere"; }
    // Adapt to the functional plug point (captures `this`; model must outlive use).
    DensityFn asFn() const { return [this](const DragQuery& q){ return density_si(q); }; }
};

// ---------------------------------------------------------------------------
// Built-in model 1: single-band exponential (fast default, Vallado eq. form).
// ---------------------------------------------------------------------------
struct SingleExpAtmosphere final : IAtmosphere {
    double rho0{3.614e-13}; // kg/m^3 at href
    double href{700.0};     // km
    double H{88.667};       // km
    double density_si(const DragQuery& q) const override {
        return rho0 * std::exp(-(q.alt_km - href) / H);
    }
    const char* name() const noexcept override { return "SingleExp"; }
};

// ---------------------------------------------------------------------------
// Built-in model 2: piecewise-exponential, Vallado "Fundamentals of
// Astrodynamics and Applications" 4th ed., Table 8-4 (0-1000 km). Honest,
// dependency-free, and the same table propagator/hpop's `Exponential` uses.
// ---------------------------------------------------------------------------
struct PiecewiseExpAtmosphere final : IAtmosphere {
    // {base altitude h0 [km], nominal density rho0 [kg/m^3], scale height H [km]}
    static constexpr int N = 28;
    static constexpr std::array<std::array<double,3>, N> BANDS{{
        {0,    1.225,     7.249}, {25,   3.899e-2,  6.349}, {30,   1.774e-2,  6.682},
        {40,   3.972e-3,  7.554}, {50,   1.057e-3,  8.382}, {60,   3.206e-4,  7.714},
        {70,   8.770e-5,  6.549}, {80,   1.905e-5,  5.799}, {90,   3.396e-6,  5.382},
        {100,  5.297e-7,  5.877}, {110,  9.661e-8,  7.263}, {120,  2.438e-8,  9.473},
        {130,  8.484e-9,  12.636},{140,  3.845e-9,  16.149},{150,  2.070e-9,  22.523},
        {180,  5.464e-10, 29.740},{200,  2.789e-10, 37.105},{250,  7.248e-11, 45.546},
        {300,  2.418e-11, 53.628},{350,  9.518e-12, 53.298},{400,  3.725e-12, 58.515},
        {450,  1.585e-12, 60.828},{500,  6.967e-13, 63.822},{600,  1.454e-13, 71.835},
        {700,  3.614e-14, 88.667},{800,  1.170e-14, 124.64},{900,  5.245e-15, 181.05},
        {1000, 3.019e-15, 268.00}
    }};
    double density_si(const DragQuery& q) const override {
        double h = q.alt_km;
        if (h < 0.0) h = 0.0;
        int i = N - 1;
        for (int k = 0; k < N - 1; ++k) {
            if (h < BANDS[k+1][0]) { i = k; break; }
        }
        const double h0 = BANDS[i][0], rho0 = BANDS[i][1], H = BANDS[i][2];
        return rho0 * std::exp(-(h - h0) / H);
    }
    const char* name() const noexcept override { return "PiecewiseExp(Vallado)"; }
};

// Convenience factories → DensityFn.
inline DensityFn makeSingleExp(double rho0=3.614e-13, double href=700, double H=88.667) {
    return [rho0,href,H](const DragQuery& q){ return rho0*std::exp(-(q.alt_km-href)/H); };
}
inline DensityFn makePiecewiseExp() {
    static const PiecewiseExpAtmosphere m; // stateless, safe to share
    return m.asFn();
}

} // namespace hp
