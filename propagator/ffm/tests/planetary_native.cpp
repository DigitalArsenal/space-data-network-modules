// Native checks of lib/planetary_fields.cpp, driven by tests/planetary.e2e.mjs.
//
//   planetary_native rotation <naif> <et TDB s>...        -> one line of nine numbers per epoch (GCRF -> body-fixed, row-major)
//   planetary_native gravity <naif> <degree> <order> <tesseral> x y z ...  -> harmonic acceleration (km/s^2) at each body-fixed
//                                                          position (km), by the shipped Pines recursion
//   planetary_native coefficient <naif> n m                -> C S as embedded (float32 widened)
#include "planetary_fields.h"
#include "ffm_gravity.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

using namespace astro;

int main(int argc, char** argv) {
    if (argc < 3) return 2;
    const std::string command = argv[1];
    const int naif = std::atoi(argv[2]);
    if (command == "rotation") {
        for (int i = 3; i < argc; ++i) {
            const double et = std::atof(argv[i]);
            // et is TDB seconds past J2000; the Instant is two-part TT, so convert through the TDB date.
            const auto instant = timesys::Instant::fromTdb(2451545.0 + et / 86400.0);
            double m[3][3];
            const bool ok = planetary::bodyFixedRotation(naif, instant, m);
            std::printf("%d", ok ? 1 : 0);
            for (int a = 0; a < 3; ++a) for (int b = 0; b < 3; ++b) std::printf(" %.17g", m[a][b]);
            std::printf("\n");
        }
        return 0;
    }
    if (command == "gravity") {
        const int degree = std::atoi(argv[3]), order = std::atoi(argv[4]), tesseral = std::atoi(argv[5]);
        const auto& field = planetary::embeddedField(naif, degree, order, tesseral);
        ffm::prepareGravity(degree, order);
        for (int i = 6; i + 2 < argc; i += 3) {
            const Vec3 p(std::atof(argv[i]), std::atof(argv[i + 1]), std::atof(argv[i + 2]));
            const auto g = ffm::computeGravity(p, field);
            std::printf("%.17g %.17g %.17g\n", g.zonalHarmonics.x, g.zonalHarmonics.y, g.zonalHarmonics.z);
        }
        return 0;
    }
    if (command == "coefficient") {
        const int n = std::atoi(argv[3]), m = std::atoi(argv[4]);
        const auto info = planetary::fieldInfo(naif);
        const auto& field = planetary::embeddedField(naif, info.degree, info.degree, info.degree);
        std::printf("%.17g %.17g gm=%.17g r=%.17g degree=%d\n", field.getC(n, m), field.getS(n, m), info.gmKm3S2, info.referenceRadiusKm, info.degree);
        return 0;
    }
    return 2;
}
