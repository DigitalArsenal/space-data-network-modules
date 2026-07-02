// match_accel.cpp — verify higherpop zonal accelerations == hpop's, pointwise.
// Links against hpop's real force_models.cpp (compiled natively).
#include "higherpop/higherpop.hpp"
#include "force_models.h"          // hpop
#include <cstdio>
#include <cmath>
#include <random>

int main() {
    using namespace hp;
    std::mt19937_64 rng(12345);
    std::uniform_real_distribution<double> U(-1,1);

    double maxrel_j2 = 0, maxrel_j4 = 0, maxabs_j2 = 0, maxabs_j4 = 0;
    const int N = 20000;
    for (int i = 0; i < N; ++i) {
        // random position, altitude 200..40000 km
        Vec3 dir{U(rng),U(rng),U(rng)};
        double dn = norm(dir); if (dn < 1e-6) continue; dir = dir/dn;
        double rmag = RE_EARTH + 200.0 + (U(rng)*0.5+0.5)*40000.0;
        Vec3 r = dir * rmag;

        // hpop J2-only (its own constants)
        ::astro::Vec3 rp(r.x, r.y, r.z);
        ::astro::Vec3 a_hpop_j2 = ::astro::ForceModel::J2Only(rp, MU_EARTH,
                                    1.08262668e-3, RE_EARTH);
        ::astro::Vec3 a_hpop_j4 = ::astro::ForceModel::J2J4(rp, MU_EARTH);

        // higherpop zonal-perturbation (central term excluded), so compare to
        // hpop's J2Only/J2J4 which are ALSO perturbation-only (no point mass).
        ForceConfig c2; c2.zonalMax = 2;
        ForceConfig c4; c4.zonalMax = 4;
        Vec3 a_hp_j2 = zonalPert(r, c2);
        Vec3 a_hp_j4 = zonalPert(r, c4);

        auto rel = [](const Vec3& a, ::astro::Vec3 b){
            Vec3 bb{b.x,b.y,b.z}; double d = norm(a-bb); double m = norm(bb);
            return std::pair<double,double>{d, m>0? d/m : 0}; };
        auto [d2,r2] = rel(a_hp_j2, a_hpop_j2);
        auto [d4,r4] = rel(a_hp_j4, a_hpop_j4);
        maxabs_j2 = std::max(maxabs_j2, d2); maxrel_j2 = std::max(maxrel_j2, r2);
        maxabs_j4 = std::max(maxabs_j4, d4); maxrel_j4 = std::max(maxrel_j4, r4);
    }
    std::printf("zonal accel match over %d random states:\n", N);
    std::printf("  J2  : max abs = %.3e km/s^2   max rel = %.3e\n", maxabs_j2, maxrel_j2);
    std::printf("  J2-J4: max abs = %.3e km/s^2   max rel = %.3e\n", maxabs_j4, maxrel_j4);
    bool ok = (maxrel_j2 < 1e-12) && (maxrel_j4 < 1e-10);
    std::printf("  -> %s\n", ok ? "MATCH" : "MISMATCH");
    return ok?0:1;
}
