// zonal_crossvalidation.cpp — computable-outcome gate for the hpop zonal
// gravity closed forms (gmat-01-defect-burn-down).
//
// Three independent implementations of the same physics live in this repo:
//
//   A. hpop closed forms          — ForceModel::J2Only / ForceModel::J2J4
//                                   (propagator/hpop/lib/force_models.cpp)
//   B. higherpop Legendre         — hp::zonalPert, P_n and P_n' by recurrence
//                                   (higherpop/include/higherpop/forces.hpp)
//   C. hpop normalized harmonics  — ForceModel::SphericalHarmonics, the
//                                   production path, normalized associated
//                                   Legendre with Cbar_n0 = -J_n/sqrt(2n+1)
//
// A and B share no algebra: B derives every term from the recurrence, A writes
// each term out by hand. C shares no algebra with either. Pointwise agreement
// of all three over a random-state corpus is therefore a real check, not a
// tautology.
//
// Gates (task acceptance):
//   * J2 only  : A vs B, max relative error <= 3e-12 over 20,000 random states
//   * J2-J4    : A vs B, max relative error <= 3e-12 over the same corpus
//   * J2-J4    : C vs B, max relative error <= 1e-8 (C truncates the field at
//                degree 4 here; its normalization path is a different
//                numerical route, so it is held to a looser but still tight
//                band)
//   * J2 secular regression: dOmega/orbit for a=7078 km, i=51.6 deg must be
//     -5.157e-3 rad to 1e-3 relative on BOTH the J2Only closed form and the
//     production SphericalHarmonics path (pre-fix the latter read -7.28e-7).
#include "higherpop/higherpop.hpp"
#include "force_models.h"
#include "astrodynamics.h"

#include <cstdio>
#include <cmath>
#include <random>
#include <algorithm>

namespace {

struct MaxErr { double abs = 0.0; double rel = 0.0; };

void accumulate(MaxErr& m, const hp::Vec3& ref, const astro::Vec3& got) {
    const hp::Vec3 g{got.x, got.y, got.z};
    const double d = hp::norm(ref - g);
    const double n = hp::norm(ref);
    m.abs = std::max(m.abs, d);
    if (n > 0.0) m.rel = std::max(m.rel, d / n);
}

// Truncated normalized-harmonics config: zonal-only, degree <= maxDeg.
astro::ForceModel::SphericalHarmonicsConfig zonalOnlyConfig(int maxDeg) {
    astro::ForceModel::SphericalHarmonicsConfig c;
    c.mu = astro::MU_EARTH;
    c.referenceRadius = astro::RE_EARTH;
    c.maxDegree = static_cast<uint16_t>(maxDeg);
    c.maxOrder = 0;  // zonal only
    return c;
}

}  // namespace

int main() {
    using hp::Vec3;

    // ---------------------------------------------------------------------
    // 1 + 2 + 3. Pointwise zonal agreement over 20,000 random states.
    // ---------------------------------------------------------------------
    std::mt19937_64 rng(12345);
    std::uniform_real_distribution<double> U(-1.0, 1.0);

    MaxErr j2_ab, j4_ab, j4_cb;
    const int N = 20000;
    int used = 0;
    for (int i = 0; i < N; ++i) {
        Vec3 dir{U(rng), U(rng), U(rng)};
        const double dn = hp::norm(dir);
        if (dn < 1e-6) continue;
        dir = dir / dn;
        const double rmag = hp::RE_EARTH + 200.0 + (U(rng) * 0.5 + 0.5) * 40000.0;
        const Vec3 r = dir * rmag;
        const astro::Vec3 rp(r.x, r.y, r.z);
        ++used;

        hp::ForceConfig c2; c2.zonalMax = 2;
        hp::ForceConfig c4; c4.zonalMax = 4;
        const Vec3 ref2 = hp::zonalPert(r, c2);
        const Vec3 ref4 = hp::zonalPert(r, c4);

        accumulate(j2_ab, ref2,
                   astro::ForceModel::J2Only(rp, astro::MU_EARTH,
                                             astro::J2_EARTH, astro::RE_EARTH));
        accumulate(j4_ab, ref4, astro::ForceModel::J2J4(rp, astro::MU_EARTH));

        // Production normalized-harmonics path, degree 4 zonal, central term
        // removed so it is comparable to the perturbation-only references.
        const astro::Vec3 shFull =
            astro::ForceModel::SphericalHarmonics(rp, zonalOnlyConfig(4));
        const astro::Vec3 pm = astro::ForceModel::PointMass(rp, astro::MU_EARTH);
        const astro::Vec3 shPert(shFull.x - pm.x, shFull.y - pm.y, shFull.z - pm.z);
        accumulate(j4_cb, ref4, shPert);
    }

    std::printf("zonal cross-validation over %d random states (200-40200 km):\n", used);
    std::printf("  A(J2Only)  vs B(recursion J2)    : max abs %.3e km/s^2  max rel %.3e\n",
                j2_ab.abs, j2_ab.rel);
    std::printf("  A(J2J4)    vs B(recursion J2-J4) : max abs %.3e km/s^2  max rel %.3e\n",
                j4_ab.abs, j4_ab.rel);
    std::printf("  C(SphHarm) vs B(recursion J2-J4) : max abs %.3e km/s^2  max rel %.3e\n",
                j4_cb.abs, j4_cb.rel);

    bool ok = true;
    ok &= (j2_ab.rel <= 3e-12);
    ok &= (j4_ab.rel <= 3e-12);
    ok &= (j4_cb.rel <= 1e-8);

    // ---------------------------------------------------------------------
    // 4. J2 secular nodal-regression regression test.
    // ---------------------------------------------------------------------
    // a = 7078 km, i = 51.6 deg, circular. Analytic secular rate per orbit:
    //   dOmega/dt = -1.5 n J2 (Re/p)^2 cos(i)   =>   per orbit x (2 pi / n)
    const double a = 7078.0;
    const double inc = 51.6 * M_PI / 180.0;
    const double n = std::sqrt(astro::MU_EARTH / (a * a * a));
    const double period = 2.0 * M_PI / n;
    const double ReOverP = astro::RE_EARTH / a;  // circular: p = a
    const double analytic = -3.0 * M_PI * astro::J2_EARTH * ReOverP * ReOverP * std::cos(inc);

    // Numerically integrate one revolution with RK4 and measure the shift of
    // the ascending node. The node is read from the angular-momentum vector,
    // which is exact for any state (no element-set assumptions).
    auto nodeLongitude = [](const astro::Vec3& r, const astro::Vec3& v) {
        const double hx = r.y * v.z - r.z * v.y;
        const double hy = r.z * v.x - r.x * v.z;
        // n_vec = z_hat x h = (-hy, hx, 0)
        return std::atan2(hx, -hy);
    };

    auto measureNodalRate = [&](int mode) {
        astro::Vec3 r(a * std::cos(0.0), a * std::sin(0.0) * std::cos(inc),
                      a * std::sin(0.0) * std::sin(inc));
        const double vc = std::sqrt(astro::MU_EARTH / a);
        astro::Vec3 v(-vc * std::sin(0.0), vc * std::cos(0.0) * std::cos(inc),
                      vc * std::cos(0.0) * std::sin(inc));

        auto accel = [&](const astro::Vec3& p) {
            astro::Vec3 acc = astro::ForceModel::PointMass(p, astro::MU_EARTH);
            if (mode == 0) {
                const astro::Vec3 j2 = astro::ForceModel::J2Only(
                    p, astro::MU_EARTH, astro::J2_EARTH, astro::RE_EARTH);
                acc.x += j2.x; acc.y += j2.y; acc.z += j2.z;
            } else {
                astro::ForceModel::SphericalHarmonicsConfig c = zonalOnlyConfig(2);
                const astro::Vec3 sh = astro::ForceModel::SphericalHarmonics(p, c);
                acc = sh;  // SphericalHarmonics already includes the central term
            }
            return acc;
        };

        const double raan0 = nodeLongitude(r, v);
        const int steps = 20000;
        const double dt = period / steps;
        for (int s = 0; s < steps; ++s) {
            // classic RK4 on (r, v)
            const astro::Vec3 k1v = accel(r);
            const astro::Vec3 k1r = v;
            const astro::Vec3 r2(r.x + 0.5 * dt * k1r.x, r.y + 0.5 * dt * k1r.y, r.z + 0.5 * dt * k1r.z);
            const astro::Vec3 v2(v.x + 0.5 * dt * k1v.x, v.y + 0.5 * dt * k1v.y, v.z + 0.5 * dt * k1v.z);
            const astro::Vec3 k2v = accel(r2);
            const astro::Vec3 k2r = v2;
            const astro::Vec3 r3(r.x + 0.5 * dt * k2r.x, r.y + 0.5 * dt * k2r.y, r.z + 0.5 * dt * k2r.z);
            const astro::Vec3 v3(v.x + 0.5 * dt * k2v.x, v.y + 0.5 * dt * k2v.y, v.z + 0.5 * dt * k2v.z);
            const astro::Vec3 k3v = accel(r3);
            const astro::Vec3 k3r = v3;
            const astro::Vec3 r4(r.x + dt * k3r.x, r.y + dt * k3r.y, r.z + dt * k3r.z);
            const astro::Vec3 v4(v.x + dt * k3v.x, v.y + dt * k3v.y, v.z + dt * k3v.z);
            const astro::Vec3 k4v = accel(r4);
            const astro::Vec3 k4r = v4;
            r = astro::Vec3(r.x + dt / 6.0 * (k1r.x + 2 * k2r.x + 2 * k3r.x + k4r.x),
                            r.y + dt / 6.0 * (k1r.y + 2 * k2r.y + 2 * k3r.y + k4r.y),
                            r.z + dt / 6.0 * (k1r.z + 2 * k2r.z + 2 * k3r.z + k4r.z));
            v = astro::Vec3(v.x + dt / 6.0 * (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x),
                            v.y + dt / 6.0 * (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y),
                            v.z + dt / 6.0 * (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z));
        }
        double d = nodeLongitude(r, v) - raan0;
        while (d > M_PI) d -= 2.0 * M_PI;
        while (d < -M_PI) d += 2.0 * M_PI;
        return d;
    };

    const double dOmegaJ2Only = measureNodalRate(0);
    const double dOmegaSphHarm = measureNodalRate(1);
    const double kExpected = -5.157e-3;

    std::printf("\nJ2 secular nodal regression (a=7078 km, i=51.6 deg, 1 rev, RK4):\n");
    std::printf("  analytic secular theory      : %.6e rad/orbit\n", analytic);
    std::printf("  J2Only closed form           : %.6e rad/orbit\n", dOmegaJ2Only);
    std::printf("  SphericalHarmonics (deg 2)   : %.6e rad/orbit\n", dOmegaSphHarm);

    const double relJ2Only = std::fabs(dOmegaJ2Only - kExpected) / std::fabs(kExpected);
    const double relSphHarm = std::fabs(dOmegaSphHarm - kExpected) / std::fabs(kExpected);
    std::printf("  rel vs -5.157e-3 : J2Only %.3e   SphericalHarmonics %.3e\n",
                relJ2Only, relSphHarm);
    ok &= (relJ2Only <= 1e-3);
    ok &= (relSphHarm <= 1e-3);

    std::printf("\n-> %s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}
