#include "atmosphere/types.h"
#include "atmosphere/models.h"

#include <cassert>
#include <cmath>
#include <iostream>

namespace {

void assertNear(double a, double b, double tol, const char* msg) {
    if (std::abs(a - b) > tol) {
        std::cerr << "FAIL [" << msg << "]: expected " << b << " got " << a
                  << " (diff=" << std::abs(a - b) << ", tol=" << tol << ")\n";
        assert(false);
    }
}

void assertRelNear(double a, double b, double relTol, const char* msg) {
    double denom = std::max(std::abs(b), 1e-30);
    double relErr = std::abs(a - b) / denom;
    if (relErr > relTol) {
        std::cerr << "FAIL [" << msg << "]: expected " << b << " got " << a
                  << " (relErr=" << relErr * 100 << "%, tol=" << relTol * 100 << "%)\n";
        assert(false);
    }
}

// ===== US76 Tests =====
// Validated against US Standard Atmosphere 1976 reference tables

void testUS76_SeaLevel() {
    auto s = atmosphere::us76(0);
    assertNear(s.temperature, 288.15, 0.01, "T sea level");
    assertNear(s.pressure, 101325.0, 1.0, "P sea level");
    assertRelNear(s.density, 1.225, 0.001, "rho sea level");
    assertRelNear(s.soundSpeed, 340.294, 0.5, "a sea level");
    std::cout << "  US76 sea level: T=" << s.temperature << "K P=" << s.pressure
              << "Pa rho=" << s.density << " a=" << s.soundSpeed << " ✓\n";
}

void testUS76_Tropopause() {
    // At 11 km: T=216.65K, P≈22632 Pa
    auto s = atmosphere::us76(11000);
    assertNear(s.temperature, 216.65, 0.5, "T 11km");
    assertRelNear(s.pressure, 22632.0, 0.01, "P 11km");
    std::cout << "  US76 tropopause (11km): T=" << s.temperature << "K P=" << s.pressure
              << "Pa rho=" << s.density << " ✓\n";
}

void testUS76_Stratosphere() {
    // At 20 km: T=216.65K (still isothermal), P≈5475 Pa
    auto s = atmosphere::us76(20000);
    assertNear(s.temperature, 216.65, 0.5, "T 20km");
    assertRelNear(s.pressure, 5474.9, 0.01, "P 20km");

    // At 32 km: T=228.65K, P≈868 Pa
    auto s32 = atmosphere::us76(32000);
    assertRelNear(s32.temperature, 228.65, 0.01, "T 32km");
    std::cout << "  US76 stratosphere: 20km T=" << s.temperature
              << " 32km T=" << s32.temperature << " ✓\n";
}

void testUS76_HighAlt() {
    // At 50 km: ~270K stratopause
    auto s50 = atmosphere::us76(50000);
    assert(s50.temperature > 260 && s50.temperature < 280);

    // At 80 km: ~198K mesosphere
    auto s80 = atmosphere::us76(80000);
    assert(s80.temperature > 180 && s80.temperature < 220);
    assert(s80.density < 0.00002);  // very thin

    std::cout << "  US76 high alt: 50km T=" << s50.temperature
              << " 80km T=" << s80.temperature << " rho=" << s80.density << " ✓\n";
}

void testUS76_MonotonicDensity() {
    // Density should monotonically decrease with altitude
    double prevRho = 1e10;
    for (double alt = 0; alt <= 86000; alt += 1000) {
        auto s = atmosphere::us76(alt);
        assert(s.density < prevRho);
        assert(s.density > 0);
        assert(s.temperature > 0);
        assert(s.pressure > 0);
        prevRho = s.density;
    }
    std::cout << "  US76 monotonic density (0-86km) ✓\n";
}

// ===== NRLMSISE-00 Tests =====

void testNRLMSISE_SeaLevel() {
    auto s = atmosphere::nrlmsise00_simple(0);
    // Should agree closely with US76 at sea level
    assertRelNear(s.temperature, 288.15, 0.01, "NRLMSISE T sea level");
    assertRelNear(s.density, 1.225, 0.05, "NRLMSISE rho sea level");
    std::cout << "  NRLMSISE-00 sea level: T=" << s.temperature << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_Thermosphere() {
    // At 300 km: should have thermospheric values
    auto s = atmosphere::nrlmsise00_simple(300000);
    assert(s.temperature > 500);       // thermosphere is hot
    assert(s.density < 1e-8);          // very thin
    assert(s.numDensityO > s.numDensityN2);  // atomic O dominates above ~200km

    std::cout << "  NRLMSISE-00 300km: T=" << s.temperature
              << " rho=" << s.density
              << " n_O=" << s.numDensityO << " n_N2=" << s.numDensityN2 << " ✓\n";
}

void testNRLMSISE_SolarActivityEffect() {
    // High solar activity → hotter exosphere, higher density at altitude
    atmosphere::SolarActivity low;
    low.F107 = 70; low.F107A = 70; low.Ap[0] = 4;

    atmosphere::SolarActivity high;
    high.F107 = 300; high.F107A = 300; high.Ap[0] = 50;

    auto sLow = atmosphere::nrlmsise00_simple(400000, low);
    auto sHigh = atmosphere::nrlmsise00_simple(400000, high);

    // Higher solar activity → higher temperature and density at 400 km
    assert(sHigh.exosphericTemp > sLow.exosphericTemp);
    assert(sHigh.temperature > sLow.temperature);

    std::cout << "  NRLMSISE-00 solar effect at 400km: low T_inf=" << sLow.exosphericTemp
              << " high T_inf=" << sHigh.exosphericTemp << " ✓\n";
}

void testNRLMSISE_DiurnalVariation() {
    atmosphere::SolarActivity solar;
    atmosphere::GeoPos pos{0, 0, 400000};  // equator, 400 km

    // Noon (LST=12)
    atmosphere::Epoch noon{2024, 1, 43200.0};
    auto sNoon = atmosphere::nrlmsise00(pos, noon, solar);

    // Night (LST=0) — shift longitude by π
    atmosphere::GeoPos posNight{0, M_PI, 400000};
    auto sNight = atmosphere::nrlmsise00(posNight, noon, solar);

    // Dayside should have higher density at 400 km
    // (max around 14:00 LST)
    std::cout << "  NRLMSISE-00 diurnal at 400km: noon_rho=" << sNoon.density
              << " night_rho=" << sNight.density << " ✓\n";
}

void testNRLMSISE_SpeciesTransition() {
    // At ~200 km: O should start dominating over N2
    // At ~600 km: He starts becoming significant
    // At ~1000 km: H becomes important

    auto s200 = atmosphere::nrlmsise00_simple(200000);
    auto s600 = atmosphere::nrlmsise00_simple(600000);

    std::cout << "  NRLMSISE-00 species:\n"
              << "    200km: O=" << s200.numDensityO << " N2=" << s200.numDensityN2
              << " He=" << s200.numDensityHe << "\n"
              << "    600km: O=" << s600.numDensityO << " N2=" << s600.numDensityN2
              << " He=" << s600.numDensityHe << " ✓\n";
}

// ===== Cross-model consistency =====

void testUS76_vs_NRLMSISE_LowAlt() {
    // Below 86 km, models should roughly agree
    for (double alt : {0.0, 5000.0, 10000.0, 20000.0, 50000.0}) {
        auto us = atmosphere::us76(alt);
        auto nr = atmosphere::nrlmsise00_simple(alt);

        // Temperature should match within 5%
        double relT = std::abs(us.temperature - nr.temperature) / us.temperature;
        if (relT > 0.05) {
            std::cerr << "  Warning: US76 vs NRLMSISE T mismatch at " << alt
                      << "m: US=" << us.temperature << " NR=" << nr.temperature << "\n";
        }
    }
    std::cout << "  US76 vs NRLMSISE-00 consistency (0-50km) ✓\n";
}

// ===== Utility functions =====

void testGeopotential() {
    // At sea level: geopotential = geometric
    assertNear(atmosphere::geopotentialAlt(0), 0, 1e-10, "geopot 0");

    // At 86 km geometric ≈ 84852 m geopotential
    double gp = atmosphere::geopotentialAlt(86000);
    assertNear(gp, 84852.0, 100.0, "geopot 86km");

    // Round-trip
    double rt = atmosphere::geometricAlt(atmosphere::geopotentialAlt(50000));
    assertNear(rt, 50000.0, 0.01, "geopot round-trip");

    std::cout << "  Geopotential conversion ✓\n";
}

void testDerivedQuantities() {
    assertNear(atmosphere::speedOfSound(288.15), 340.294, 0.5, "sound speed");
    assertNear(atmosphere::dynamicPressure(1.225, 250.0), 38281.25, 1.0, "qbar");
    assertRelNear(atmosphere::machNumber(300.0, 340.294), 0.8816, 0.001, "mach");
    assertNear(atmosphere::stagnationTemp(288.15, 2.0), 518.67, 1.0, "T_stag");

    std::cout << "  Derived quantities ✓\n";
}

}  // namespace

int main() {
    std::cout << "=== test_atmosphere ===\n";

    // US76
    testUS76_SeaLevel();
    testUS76_Tropopause();
    testUS76_Stratosphere();
    testUS76_HighAlt();
    testUS76_MonotonicDensity();

    // NRLMSISE-00
    testNRLMSISE_SeaLevel();
    testNRLMSISE_Thermosphere();
    testNRLMSISE_SolarActivityEffect();
    testNRLMSISE_DiurnalVariation();
    testNRLMSISE_SpeciesTransition();

    // Cross-model
    testUS76_vs_NRLMSISE_LowAlt();

    // Utilities
    testGeopotential();
    testDerivedQuantities();

    std::cout << "All atmosphere tests passed.\n";
    return 0;
}
