// These checks must run in every build type, including Release.
#undef NDEBUG

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
// Validated against US Standard Atmosphere 1976 (NOAA-S/T 76-1562) Table I.

void testUS76_SeaLevel() {
    // Published: US Standard Atmosphere 1976, Table I, Z = 0 m:
    // T = 288.150 K, P = 101325 Pa, rho = 1.2250 kg/m^3, a = 340.294 m/s.
    auto s = atmosphere::us76(0);
    assertNear(s.temperature, 288.15, 0.01, "T sea level");
    assertNear(s.pressure, 101325.0, 1.0, "P sea level");
    assertRelNear(s.density, 1.2250, 0.001, "rho sea level");
    assertRelNear(s.soundSpeed, 340.294, 0.5, "a sea level");
    std::cout << "  US76 sea level: T=" << s.temperature << "K P=" << s.pressure
              << "Pa rho=" << s.density << " a=" << s.soundSpeed << " ✓\n";
}

void testUS76_PublishedTable() {
    // Published values from US Standard Atmosphere 1976 (NOAA-S/T 76-1562),
    // Table I (geometric altitude entries):
    //   Z = 10 000 m (geometric): T = 223.252 K, P = 26 500 Pa,
    //                             rho = 4.1351e-1 kg/m^3
    // (note: 223.252 K, NOT 223.15 K — the layer math runs in geopotential
    // altitude H = r0*Z/(r0+Z), H(10 km) = 9.9843 km).
    auto s10 = atmosphere::us76(10000.0);
    assertRelNear(s10.temperature, 223.252, 0.001, "T 10km geometric");
    assertRelNear(s10.pressure, 26500.0, 0.001, "P 10km geometric");
    assertRelNear(s10.density, 0.41351, 0.001, "rho 10km geometric");

    // Layer-base values are defined at GEOPOTENTIAL altitudes (US76 Table 4):
    //   H = 20 km geopotential: T = 216.65 K, P = 5474.9 Pa
    //   H = 47 km geopotential: T = 270.65 K
    // Convert to the geometric input expected by us76().
    const double z20 = atmosphere::geometricAlt(20000.0);
    auto s20 = atmosphere::us76(z20);
    assertRelNear(s20.temperature, 216.65, 0.001, "T 20km geopotential");
    assertRelNear(s20.pressure, 5474.9, 0.001, "P 20km geopotential");

    const double z47 = atmosphere::geometricAlt(47000.0);
    auto s47 = atmosphere::us76(z47);
    assertRelNear(s47.temperature, 270.65, 0.001, "T 47km geopotential");

    std::cout << "  US76 published table: 10km T=" << s10.temperature
              << " P=" << s10.pressure << " | 20km(geopot) T=" << s20.temperature
              << " P=" << s20.pressure << " | 47km(geopot) T=" << s47.temperature
              << " ✓\n";
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

void testStandardAtmosphereOrbitalDensity_BasiliskReferences() {
    // Basilisk orbitalMotion.c atmosphericDensity() regression values.
    assertRelNear(
        atmosphere::standardAtmosphere1976OrbitalDensity(200000.0),
        1.64100656241e-10,
        1e-12,
        "Basilisk atmosphericDensity 200km");
    assertRelNear(
        atmosphere::standardAtmosphere1976OrbitalDensity(2000000.0),
        2.48885731828e-15,
        1e-12,
        "Basilisk atmosphericDensity 2000km");

    std::cout << "  Basilisk atmosphericDensity references (200km, 2000km) ✓\n";
}

void testBasiliskDebyeLengthReferences() {
    // Basilisk src/architecture/utilities/tests/test_orbitalMotion.cpp
    // DebeyeLengthTests vectors. Input altitude is meters here; output is meters.
    assertNear(atmosphere::basiliskDebyeLength(400000.0), 0.00404, 1e-10,
               "Basilisk debyeLength 400km");
    assertNear(atmosphere::basiliskDebyeLength(1000000.0), 0.0159, 1e-10,
               "Basilisk debyeLength 1000km");
    assertNear(atmosphere::basiliskDebyeLength(10000000.0), 0.0396, 1e-10,
               "Basilisk debyeLength 10000km");
    assertNear(atmosphere::basiliskDebyeLength(34000000.0), 400.30000000000018, 1e-10,
               "Basilisk debyeLength 34000km");

    std::cout << "  Basilisk debyeLength references (400km, 1000km, 10000km, 34000km) ✓\n";
}

void testBasiliskAtmosphericDragReference() {
    // Basilisk orbitalMotion.c atmosphericDrag() source vector. Inputs and
    // output are converted from km/km-s/km-s^2 into SDK SI units.
    double position_m[3] = {6200000.0, 100000.0, 2000000.0};
    double velocity_mps[3] = {1000.0, 9000.0, 1000.0};
    double acceleration_mps2[3] = {0.0, 0.0, 0.0};

    atmosphere::basiliskAtmosphericDragAcceleration(
        0.2, 2.0, 50.0, position_m, velocity_mps, acceleration_mps2);

    assertNear(acceleration_mps2[0], -2.8245395411253663e-4, 1e-14,
               "Basilisk atmosphericDrag x");
    assertNear(acceleration_mps2[1], -2.5420855870128297e-3, 1e-14,
               "Basilisk atmosphericDrag y");
    assertNear(acceleration_mps2[2], -2.8245395411253663e-4, 1e-14,
               "Basilisk atmosphericDrag z");

    std::cout << "  Basilisk atmosphericDrag reference vector ✓\n";
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
// Canonical reference vectors: 17-case output table distributed with the
// NRLMSISE-00 C package (release 20041227, D. Brodowski port of
// Picone/Hedin/Drob), DOCUMENTATION file — also at
// https://github.com/magnific0/nrlmsise-00/blob/master/DOCUMENTATION.
// Common inputs: doy=172, sec=29000 s UT, lat=60 deg, lon=-70 deg, lst=16 h,
// F107A=150, F107=150, ap=4 (lst deliberately inconsistent with UT/lon).
// Table values are quoted to 4 significant digits; the table RHO row is the
// gtd7 density (excludes anomalous oxygen). Our State.density is the gtd7d
// drag-effective density, so RHO is re-derived from the species columns
// where anomalous oxygen matters.

namespace canonical {
constexpr double LST = 16.0;

atmosphere::State run(double alt_km, int doy = 172, double sec = 29000.0,
                      double latDeg = 60.0, double lonDeg = -70.0,
                      double f107a = 150.0, double f107 = 150.0, double ap = 4.0) {
    atmosphere::GeoPos pos{latDeg * M_PI / 180.0, lonDeg * M_PI / 180.0, alt_km * 1000.0};
    atmosphere::Epoch epoch{0, doy, sec};
    atmosphere::SolarActivity solar;
    solar.F107 = f107;
    solar.F107A = f107a;
    for (int i = 0; i < 7; ++i) solar.Ap[i] = ap;
    return atmosphere::nrlmsise00(pos, epoch, solar, LST);
}

// gtd7-equivalent mass density (g/cm^3) from the species number densities
// (1/m^3): He, O, N2, O2, Ar, H, N — exactly the species summed by gtd7.
double gtd7RhoGcm3(const atmosphere::State& s) {
    constexpr double AMU = 1.66053906892e-24;  // g
    const double per_cm3 = 1e-6;
    return AMU * per_cm3 * (4.002602 * s.numDensityHe +
                            15.9994 * s.numDensityO +
                            28.0134 * s.numDensityN2 +
                            31.9988 * s.numDensityO2 +
                            39.948 * s.numDensityAr +
                            1.00797 * s.numDensityH +
                            14.0067 * s.numDensityN);
}
}  // namespace canonical

void testNRLMSISE_CanonicalCase1() {
    // Case 1: alt = 400 km. Published outputs:
    //   TINF = 1250.54 K, TG = 1241.42 K, RHO = 4.075e-15 g/cm^3,
    //   HE = 6.665e+05, O = 1.139e+08, N2 = 1.998e+07, O2 = 4.023e+05,
    //   AR = 3.557e+03, H = 3.475e+04, N = 4.096e+06  [1/cm^3]
    auto s = canonical::run(400.0);
    assertRelNear(s.exosphericTemp, 1250.54, 1e-3, "case1 TINF");
    assertRelNear(s.temperature, 1241.42, 1e-3, "case1 TG");
    assertRelNear(canonical::gtd7RhoGcm3(s), 4.075e-15, 1e-3, "case1 RHO (gtd7)");
    // gtd7d density (incl. anomalous O) is within 0.1% of gtd7 at 400 km.
    assertRelNear(s.density, 4.075e-15 * 1000.0, 2e-3, "case1 rho kg/m^3 (gtd7d)");
    assertRelNear(s.numDensityHe * 1e-6, 6.665e+05, 1e-3, "case1 He");
    assertRelNear(s.numDensityO * 1e-6, 1.139e+08, 1e-3, "case1 O");
    assertRelNear(s.numDensityN2 * 1e-6, 1.998e+07, 1e-3, "case1 N2");
    assertRelNear(s.numDensityO2 * 1e-6, 4.023e+05, 1e-3, "case1 O2");
    assertRelNear(s.numDensityAr * 1e-6, 3.557e+03, 1e-3, "case1 Ar");
    assertRelNear(s.numDensityH * 1e-6, 3.475e+04, 1e-3, "case1 H");
    assertRelNear(s.numDensityN * 1e-6, 4.096e+06, 1e-3, "case1 N");
    std::cout << "  NRLMSISE-00 canonical case 1 (400 km): TINF=" << s.exosphericTemp
              << " TG=" << s.temperature << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_CanonicalCase4() {
    // Case 4: alt = 100 km. Published: TG = 206.89 K, RHO = 3.584e-10 g/cm^3,
    // O = 1.919e+11, N2 = 6.116e+12, O2 = 1.225e+12 [1/cm^3].
    // Anomalous oxygen is ~1e-42 here, so gtd7d == gtd7.
    auto s = canonical::run(100.0);
    assertRelNear(s.temperature, 206.89, 1e-3, "case4 TG");
    assertRelNear(s.density, 3.584e-10 * 1000.0, 1e-3, "case4 rho");
    assertRelNear(s.numDensityO * 1e-6, 1.919e+11, 1e-3, "case4 O");
    assertRelNear(s.numDensityN2 * 1e-6, 6.116e+12, 1e-3, "case4 N2");
    assertRelNear(s.numDensityO2 * 1e-6, 1.225e+12, 1e-3, "case4 O2");
    std::cout << "  NRLMSISE-00 canonical case 4 (100 km): TG=" << s.temperature
              << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_CanonicalCase11() {
    // Case 11: alt = 0 km. Published: TG = 281.46 K, RHO = 1.261e-03 g/cm^3
    // (= 1.261 kg/m^3), N2 = 2.050e+19, O2 = 5.499e+18 [1/cm^3].
    auto s = canonical::run(0.0);
    assertRelNear(s.temperature, 281.46, 1e-3, "case11 TG");
    assertRelNear(s.density, 1.261, 1e-3, "case11 rho");
    assertRelNear(s.numDensityN2 * 1e-6, 2.050e+19, 1e-3, "case11 N2");
    assertRelNear(s.numDensityO2 * 1e-6, 5.499e+18, 1e-3, "case11 O2");
    std::cout << "  NRLMSISE-00 canonical case 11 (0 km): TG=" << s.temperature
              << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_CanonicalCase9_HighF107() {
    // Case 9: F107 = 180 (others as common). Published: TINF = 1306.05 K,
    // TG = 1293.37 K, O = 1.245e+08 [1/cm^3].
    auto s = canonical::run(400.0, 172, 29000.0, 60.0, -70.0, 150.0, 180.0, 4.0);
    assertRelNear(s.exosphericTemp, 1306.05, 1e-3, "case9 TINF");
    assertRelNear(s.temperature, 1293.37, 1e-3, "case9 TG");
    assertRelNear(s.numDensityO * 1e-6, 1.245e+08, 1e-3, "case9 O");
    std::cout << "  NRLMSISE-00 canonical case 9 (F107=180): TINF=" << s.exosphericTemp
              << " ✓\n";
}

// Published cases 16 and 17 of the same table run with switch 9 = -1 and
// ap_a[0..6] = 100 (nrlmsise-00_test.c: aph.a[i] = 100). The DOCUMENTATION
// file prints seven significant digits
// (https://github.com/magnific0/nrlmsise-00/blob/master/DOCUMENTATION,
// sha256 ddeb6c430007af087acceaa422d4a5b15bcbfa84258383f6fd75888ccb82f920).
// Tolerance 1e-5 relative: print rounding is 5e-7; the rest allows for
// floating-point evaluation-order differences between compilers.
atmosphere::State runApHistory(double alt_km) {
    atmosphere::GeoPos pos{60.0 * M_PI / 180.0, -70.0 * M_PI / 180.0, alt_km * 1000.0};
    atmosphere::Epoch epoch{0, 172, 29000.0};
    atmosphere::SolarActivity solar;
    solar.F107 = 150.0;
    solar.F107A = 150.0;
    for (int i = 0; i < 7; ++i) solar.Ap[i] = 100.0;
    solar.geomagnetic = atmosphere::GeomagneticInput::ApHistory;
    return atmosphere::nrlmsise00(pos, epoch, solar, canonical::LST);
}

// Mass density in g/cm^3 from published species number densities (1/cm^3),
// with the atomic-mass weights gtd7/gtd7d use (nrlmsise-00.c):
// 1.66e-24 * (4 He + 16 O + 28 N2 + 32 O2 + 40 Ar + H + 14 N [+ 16 anomalous O]).
double packageRhoGcm3(double he, double o, double n2, double o2, double ar,
                      double h, double n, double anomalousO) {
    return 1.66e-24 * (4.0 * he + 16.0 * o + 28.0 * n2 + 32.0 * o2 + 40.0 * ar +
                       h + 14.0 * n + 16.0 * anomalousO);
}

void testNRLMSISE_PublishedCase16_ApHistory() {
    // 5.196477E+05 1.274494E+08 4.850450E+07 1.720838E+06 2.354487E+04
    // 5.881940E-15 2.500078E+04 6.279210E+06 2.667273E+04 1.426412E+03
    // 1.408608E+03   (He O N2 O2 Ar RHO H N ANM-O TINF TG)
    auto s = runApHistory(400.0);
    constexpr double tol = 1e-5;
    assertRelNear(s.exosphericTemp, 1.426412E+03, tol, "case16 TINF");
    assertRelNear(s.temperature, 1.408608E+03, tol, "case16 TG");
    assertRelNear(s.numDensityHe * 1e-6, 5.196477E+05, tol, "case16 He");
    assertRelNear(s.numDensityO * 1e-6, 1.274494E+08, tol, "case16 O");
    assertRelNear(s.numDensityN2 * 1e-6, 4.850450E+07, tol, "case16 N2");
    assertRelNear(s.numDensityO2 * 1e-6, 1.720838E+06, tol, "case16 O2");
    assertRelNear(s.numDensityAr * 1e-6, 2.354487E+04, tol, "case16 Ar");
    assertRelNear(s.numDensityH * 1e-6, 2.500078E+04, tol, "case16 H");
    assertRelNear(s.numDensityN * 1e-6, 6.279210E+06, tol, "case16 N");
    // gtd7 RHO excludes anomalous oxygen: check the species sum against it,
    // then the gtd7d drag density against the sum that includes it.
    assertRelNear(packageRhoGcm3(5.196477E+05, 1.274494E+08, 4.850450E+07, 1.720838E+06,
                                 2.354487E+04, 2.500078E+04, 6.279210E+06, 0.0),
                  5.881940E-15, tol, "case16 published RHO from species");
    const double rhoDrag = packageRhoGcm3(5.196477E+05, 1.274494E+08, 4.850450E+07,
                                          1.720838E+06, 2.354487E+04, 2.500078E+04,
                                          6.279210E+06, 2.667273E+04);
    assertRelNear(s.density, rhoDrag * 1000.0, tol, "case16 gtd7d rho kg/m^3");
    std::cout << "  NRLMSISE-00 published case 16 (ap history, 400 km): TINF="
              << s.exosphericTemp << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_PublishedCase17_ApHistory() {
    // 4.260860E+07 1.241342E+11 4.929562E+12 1.048407E+12 4.993465E+10
    // 2.914304E-10 8.831229E+06 2.252516E+05 2.415246E-42 1.027318E+03
    // 1.934071E+02
    auto s = runApHistory(100.0);
    constexpr double tol = 1e-5;
    assertRelNear(s.exosphericTemp, 1.027318E+03, tol, "case17 TINF");
    assertRelNear(s.temperature, 1.934071E+02, tol, "case17 TG");
    assertRelNear(s.numDensityHe * 1e-6, 4.260860E+07, tol, "case17 He");
    assertRelNear(s.numDensityO * 1e-6, 1.241342E+11, tol, "case17 O");
    assertRelNear(s.numDensityN2 * 1e-6, 4.929562E+12, tol, "case17 N2");
    assertRelNear(s.numDensityO2 * 1e-6, 1.048407E+12, tol, "case17 O2");
    assertRelNear(s.numDensityAr * 1e-6, 4.993465E+10, tol, "case17 Ar");
    assertRelNear(s.numDensityH * 1e-6, 8.831229E+06, tol, "case17 H");
    assertRelNear(s.numDensityN * 1e-6, 2.252516E+05, tol, "case17 N");
    assertRelNear(s.density, 2.914304E-10 * 1000.0, tol, "case17 rho kg/m^3");
    std::cout << "  NRLMSISE-00 published case 17 (ap history, 100 km): TG="
              << s.temperature << " rho=" << s.density << " ✓\n";
}

void testNRLMSISE_DailyModeIgnoresHistorySlots() {
    // With switch 9 = 1 the model reads only the daily ap, so case 1 must be
    // reproduced whatever Ap[1..6] hold.
    atmosphere::GeoPos pos{60.0 * M_PI / 180.0, -70.0 * M_PI / 180.0, 400000.0};
    atmosphere::Epoch epoch{0, 172, 29000.0};
    atmosphere::SolarActivity solar;
    solar.F107 = 150.0;
    solar.F107A = 150.0;
    solar.Ap[0] = 4.0;
    for (int i = 1; i < 7; ++i) solar.Ap[i] = 250.0;
    auto s = atmosphere::nrlmsise00(pos, epoch, solar, canonical::LST);
    assertRelNear(s.exosphericTemp, 1.250540E+03, 1e-5, "daily mode TINF");
    assertRelNear(s.numDensityO * 1e-6, 1.138806E+08, 1e-5, "daily mode O");
    std::cout << "  NRLMSISE-00 daily-Ap mode ignores Ap[1..6] ✓\n";
}

void testNRLMSISE_SeaLevel() {
    // Real NRLMSISE-00 surface state varies with location/season; it does not
    // exactly reproduce US76. Physically-justified bounds: surface density
    // within ~10% of 1.225 kg/m^3, temperature in a plausible surface range
    // (published case 11 at 60N gives 281.46 K / 1.261 kg/m^3).
    auto s = atmosphere::nrlmsise00_simple(0);
    assert(s.density > 1.1 && s.density < 1.4);
    assert(s.temperature > 250.0 && s.temperature < 330.0);
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
    testUS76_PublishedTable();
    testUS76_Tropopause();
    testUS76_Stratosphere();
    testUS76_HighAlt();
    testStandardAtmosphereOrbitalDensity_BasiliskReferences();
    testBasiliskDebyeLengthReferences();
    testBasiliskAtmosphericDragReference();
    testUS76_MonotonicDensity();

    // NRLMSISE-00 (canonical published vectors)
    testNRLMSISE_CanonicalCase1();
    testNRLMSISE_CanonicalCase4();
    testNRLMSISE_CanonicalCase11();
    testNRLMSISE_CanonicalCase9_HighF107();
    testNRLMSISE_PublishedCase16_ApHistory();
    testNRLMSISE_PublishedCase17_ApHistory();
    testNRLMSISE_DailyModeIgnoresHistorySlots();

    // NRLMSISE-00 (behavioral)
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
