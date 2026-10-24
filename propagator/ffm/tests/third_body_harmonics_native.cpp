// The extended third-body gravity (lib/central_body.cpp, ThirdBodyHarmonics) against the point mass it adds to, driven by
// tests/planetary.e2e.mjs.
//
//   third_body_harmonics_native <kernel.bsp> <central 399|301> <degree> <order> <et TDB s> x y z
//
// prints, at the satellite position x y z (km, GCRF about the central body): the harmonic term, the other body's point-mass
// third-body term (direct minus indirect, DE440 GM), and the kernel's position of the other body relative to the central body.
#include "ephemeris.h"
#include "force_models.h"
#include "planetary_fields.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

using namespace astro;

int main(int argc, char** argv) {
    if (argc < 9) return 2;
    std::ifstream stream(argv[1], std::ios::binary);
    const std::vector<uint8_t> kernel((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    if (kernel.empty() || !Ephemeris::loadEphemerisBuffer(kernel.data(), kernel.size())) { std::fprintf(stderr, "kernel: %s\n", Ephemeris::ephemerisError().c_str()); return 3; }
    const int central = std::atoi(argv[2]);
    ForceModel::ThirdBodyFieldConfig config;
    config.degree = uint16_t(std::atoi(argv[3])); config.order = uint16_t(std::atoi(argv[4]));
    const auto at = timesys::Instant::fromTdb(2451545.0 + std::atof(argv[5]) / 86400.0);
    const Vec3 sat(std::atof(argv[6]), std::atof(argv[7]), std::atof(argv[8]));
    const Vec3 harmonics = ForceModel::ThirdBodyHarmonics(central, config, sat, at);
    const int other = central == 399 ? planetary::MOON : 399;
    const auto row = Ephemeris::getKernelState(other, central, at);
    const double gm = planetary::thirdBodyGmKm3S2(other);
    const Vec3 toBody = row.position - sat;
    const double d = toBody.magnitude(), r = row.position.magnitude();
    const Vec3 pointMass = toBody * (gm / (d * d * d)) - row.position * (gm / (r * r * r));
    std::printf("%.17g %.17g %.17g\n%.17g %.17g %.17g\n%.17g %.17g %.17g\n", harmonics.x, harmonics.y, harmonics.z,
                pointMass.x, pointMass.y, pointMass.z, row.position.x, row.position.y, row.position.z);
    return 0;
}
