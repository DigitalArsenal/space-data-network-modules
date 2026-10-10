// force_models.cpp - Phase 11.1.2 Force Models Implementation
// =============================================================================
// Phase 11: Astrodynamics Framework (Basilisk + TudatPy Port)
// Implements 18 force models for high-fidelity orbit propagation.
// =============================================================================

#include "force_models.h"
#include "environment_models.h"
#include "astrodynamics.h"
#include "atmosphere.h"
#include "atmosphere_winds.h"
#include "time_convert.h"
#include "coords.h"
#include "egm2008_data.h"
#include "iers2010_tides.h"
#include "jb2008.h"
#include "jacchia_roberts.h"
#include "earth_radiation.h"
#include "fes2004_data.h"
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <cstring>

namespace astro {
namespace ForceModel {

// =============================================================================
// Internal Helper Functions
// =============================================================================

namespace {

/// G * speed of light^2 for relativistic calculations
constexpr double G_C2 = 8.87e-10;  // km^3/kg/s^2 / c^2

/// Stefan-Boltzmann constant (W/m^2/K^4)
constexpr double STEFAN_BOLTZMANN = 5.670374419e-8;

/// Earth's angular momentum per unit mass for Lense-Thirring, |J| = 9.8e8
/// m^2/s (IERS Conventions 2010, section 10.3, eq. 10.12), in km^2/s. The
/// term's coefficient is (1 + gamma) GM |J| / c^2 with the request's GM.
/// Until 2026-10-08 a fixed G*J/c^2 of 4.35e-3 km^3/s about the GCRF z axis
/// was used (0.08 % from GM*9.8e8/c^2, and the pole off by the precession
/// since J2000).
constexpr double EARTH_J_PER_MASS_KM2_S = 9.8e2;

// The force set integrates GCRF, while the geodetic density models
// (computeNRLMSISE00, computeJB2008, computeDTM2020 and computeDragAcceleration)
// take an Earth-fixed position (astrodynamics.h). EarthAxes carries the one
// rotation a force evaluation uses for all of them, for the co-rotating
// atmosphere, and for the gravity field: the force set's GcrfToEarthFixed
// (IERS EOP through the earth_orientation input when supplied).
} // anonymous namespace

Vec3 EarthAxes::fixed(const Vec3& v) const {
    return Vec3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
                m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
                m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z);
}

Vec3 EarthAxes::inertial(const Vec3& v) const {
    return Vec3(m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z,
                m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z,
                m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z);
}

Vec3 EarthAxes::spin() const { return Vec3(m[2][0], m[2][1], m[2][2]); }

EarthAxes EarthAxesAt(double jdTdb, const ForceModelSet& forceSet) {
    EarthAxes axes;
    GcrfToEarthFixed(jdTdb, forceSet, axes.m);
    return axes;
}

SpaceWeatherData WeatherAt(double jdUtc, const ForceModelSet& forceSet) {
    if (!forceSet.weatherAt) return forceSet.weather;
    SpaceWeatherData weather = forceSet.weather;
    forceSet.weatherAt(jdUtc, weather);
    return weather;
}

DragForceConfig DragAt(double jdTdb, const ForceModelSet& forceSet) {
    DragForceConfig drag = forceSet.drag;
    if (forceSet.dragAreaOverMassRate != 0.0 && drag.area > 0.0 && drag.mass > 0.0) {
        const double seconds = (jdTdb - forceSet.dragRateEpochTdb) * 86400.0;
        const double areaOverMass = drag.Cd * drag.area / drag.mass + forceSet.dragAreaOverMassRate * seconds;
        drag.Cd = areaOverMass * drag.mass / drag.area;
    }
    return drag;
}

// GMST about the GCRF z axis. Precession, nutation and polar motion are not
// applied (the pole is off by the precession since J2000, ~0.35 deg in 2026),
// so this serves only direct callers of the density functions that pass no
// axes; force-set evaluation always passes EarthAxesAt.
EarthAxes GmstAxes(double jdUt) {
    const double theta = timesys::ut1ToGmst(jdUt);
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    EarthAxes axes;
    const double m[3][3] = {{c, s, 0}, {-s, c, 0}, {0, 0, 1}};
    std::memcpy(axes.m, m, sizeof m);
    return axes;
}

Vec3 EarthFixedForDensity(const Vec3& gcrf, double jdUt) {
    return GmstAxes(jdUt).fixed(gcrf);
}

namespace {
// Velocity of the air relative to GCRF: co-rotation about the Earth's spin
// axis plus, when requested, the HWM14 horizontal wind, evaluated in the same
// Earth-fixed axes as the density and rotated back. Winds without weather are
// refused (Harris-Priester and the exponential helper carry none).
Vec3 relativeAtmosphereVelocity(const Vec3& position, const Vec3& velocity, double jdUt,
                                const EarthAxes& axes, bool coRotatingAtmosphere,
                                bool includeWinds, const SpaceWeatherData* weather = nullptr,
                                bool windDisturbance = true) {
    Vec3 vAtm = coRotatingAtmosphere ? axes.spin().cross(position) * OMEGA_EARTH : Vec3();
    if (includeWinds) {
        if (weather == nullptr) {
            throw std::invalid_argument("includeWinds: this drag model has no space-weather input for HWM14");
        }
        vAtm += axes.inertial(
            HorizontalWindEarthFixed(axes.fixed(position), jdUt, *weather, windDisturbance));
    }
    return velocity - vAtm;
}

const EarthAxes& axesOr(const EarthAxes* axes, EarthAxes& fallback, double jdUt) {
    if (axes) return *axes;
    fallback = GmstAxes(jdUt);
    return fallback;
}
}  // namespace

// =============================================================================
// 1. Point Mass - Central Body Gravity
// =============================================================================

Vec3 PointMass(const Vec3& position, double mu) {
    double r = position.magnitude();
    if (r < 1.0) r = 1.0;  // Safety check
    double r3 = r * r * r;
    return position * (-mu / r3);
}

// =============================================================================
// 2. Spherical Harmonics - J2-Jn Zonal/Tesseral
// =============================================================================

Vec3 J2Only(const Vec3& position, double mu, double J2, double Re) {
    double r = position.magnitude();
    double r2 = r * r;
    double r5 = r2 * r2 * r;
    double z2 = position.z * position.z;

    double factor = 1.5 * J2 * mu * Re * Re / r5;

    double ax = position.x * factor * (5.0 * z2 / r2 - 1.0);
    double ay = position.y * factor * (5.0 * z2 / r2 - 1.0);
    double az = position.z * factor * (5.0 * z2 / r2 - 3.0);

    return Vec3(ax, ay, az);
}

// Zonal J2-J4 perturbing acceleration (central point-mass term EXCLUDED).
//
// All three terms are the gradient of the standard zonal potential
//
//     U_n = -mu * J_n * Re^n * P_n(z/r) / r^(n+1)
//
// with P_2 = (3u^2-1)/2, P_3 = (5u^3-3u)/2, P_4 = (35u^4-30u^2+3)/8, u = z/r.
// Written out per term the gradient is
//
//   J3:  a_xy = +(5/2) J3 mu Re^3 / r^7 * {x,y} * z * (7 z^2/r^2 - 3)
//        a_z  = -(5/2) J3 mu Re^3 / r^7 * (6 z^2 - 7 z^4/r^2 - 3/5 r^2)
//   J4:  a_xy = +(5/8) J4 mu Re^4 / r^7 * {x,y} * (63 z^4/r^4 - 42 z^2/r^2 + 3)
//        a_z  = +(5/8) J4 mu Re^4 / r^7 * z * (63 z^4/r^4 - 70 z^2/r^2 + 15)
//
// Two defects lived here and are fixed above (gmat-01-defect-burn-down):
//
//   1. The J3 z-component carried the WRONG SIGN. The x/y components absorb
//      the leading minus of grad(U_3) into the rearranged (7z^2/r^2 - 3)
//      bracket; the z-component's bracket is not rearranged, so it needs the
//      minus written out. It was '+factor3 * (...)'.
//   2. The J4 scale factor was 1.875 * J4 * mu * Re^4 / r^9, which is
//      3/r^2 times the correct 0.625 * J4 * mu * Re^4 / r^7 (the bracket is
//      dimensionless, so only r^7 balances mu*Re^4 into an acceleration).
//      At LEO that is a factor ~6e-8: the J4 term was effectively absent.
//
// Cross-validated pointwise against higherpop's independent Legendre-recursion
// zonal reference (hp::zonalPert) in tests/zonal_crossvalidation.cpp.
Vec3 J2J4(const Vec3& position, double mu) {
    Vec3 acc = J2Only(position, mu, J2_EARTH, RE_EARTH);

    double r = position.magnitude();
    double r2 = r * r;
    double z = position.z;
    double z2 = z * z;
    double r7 = r2 * r2 * r2 * r;

    // J3 contribution
    double factor3 = 2.5 * J3_EARTH * mu * RE_EARTH * RE_EARTH * RE_EARTH / r7;

    double term3 = 7.0 * z2 / r2 - 3.0;
    acc.x += position.x * z * factor3 * term3;
    acc.y += position.y * z * factor3 * term3;
    acc.z -= factor3 * (6.0 * z2 - 7.0 * z2 * z2 / r2 - 0.6 * r2);

    // J4 contribution
    double Re4 = RE_EARTH * RE_EARTH * RE_EARTH * RE_EARTH;
    double factor4 = 0.625 * J4_EARTH * mu * Re4 / r7;

    double z4 = z2 * z2;
    double term4 = 63.0 * z4 / (r2 * r2) - 42.0 * z2 / r2 + 3.0;
    acc.x += position.x * factor4 * term4;
    acc.y += position.y * factor4 * term4;
    acc.z += z * factor4 * (63.0 * z4 / (r2 * r2) - 70.0 * z2 / r2 + 15.0);

    return acc;
}

GravityFieldCoefficients InlineFieldCoefficients(const SphericalHarmonicsConfig& config) {
    GravityFieldCoefficients coeffs;
    coeffs.mu = config.mu;
    coeffs.referenceRadius = config.referenceRadius;
    coeffs.maxDegree = std::min(config.maxDegree, (uint16_t)20);
    coeffs.maxOrder = std::min(config.maxOrder, coeffs.maxDegree);

    // A caller-supplied field REPLACES the built-in set. Until gmat-07 a
    // non-null Cnm only skipped the defaults and was never copied, so every
    // custom field evaluated as identically zero — which is why nothing in the
    // tree ever passed one.
    if (config.Cnm != nullptr && config.Snm != nullptr) {
        constexpr int S = SphericalHarmonicsConfig::CUSTOM_STRIDE;
        for (int n = 0; n <= coeffs.maxDegree; n++) {
            for (int m = 0; m <= std::min<int>(n, coeffs.maxOrder); m++) {
                coeffs.Cnm[n][m] = config.Cnm[n * S + m];
                coeffs.Snm[n][m] = config.Snm[n * S + m];
            }
        }
        return coeffs;
    }

    // The built-in field: EGM2008 (fully normalized, egm2008_data.h) to the
    // requested degree and order, with J2-J4 from the constants the closed
    // forms use (tests/zonal_crossvalidation.cpp holds them together).
    // The gates are honored: a zonal the caller did not ask for is ABSENT.
    // Before gmat-07 the whole J2-J6 set plus the tesserals loaded
    // unconditionally, so `includeJ2 = true, includeJ3 = includeJ4 = false`
    // — the plugin's "J2 only" setting — returned a J2-J6 tesseral field.
    // Until 2026-10-02 this field held only J2-J6 and the tesserals through
    // degree 4, whatever the degree asked, and J5 and J6 were unnormalized
    // values with the wrong sign (C60 +5.4e-7 for EGM2008's -1.5e-7).
    if (config.includeJ2) coeffs.Cnm[2][0] = -J2_EARTH / std::sqrt(5.0);
    if (config.includeJ3) coeffs.Cnm[3][0] = -J3_EARTH / std::sqrt(7.0);
    if (config.includeJ4) coeffs.Cnm[4][0] = -J4_EARTH / 3.0;
    for (const auto& c : EGM2008Data::COEFFICIENTS) {
        if (c.n > coeffs.maxDegree) break;
        if (c.m > coeffs.maxOrder) continue;
        if (c.m == 0 && (c.n <= 4 || !config.includeHigherZonals)) continue;
        coeffs.Cnm[c.n][c.m] = c.Cnm;
        coeffs.Snm[c.n][c.m] = c.Snm;
    }
    return coeffs;
}

Vec3 SphericalHarmonics(const Vec3& position, const SphericalHarmonicsConfig& config) {
    GravityAcceleration result = computeSphericalHarmonicGravity(position, InlineFieldCoefficients(config));
    return result.total;
}

// =============================================================================
// 3. EGM2008 - Earth Gravitational Model 2008
// =============================================================================

// The embedded EGM2008 or EGM96 coefficients (degree 2-70) at the configured
// truncation, re-initialized only when it changes. Tesseral and sectorial
// terms above maxTesseralDegree are zeroed, which the evaluation (and the
// partials' copy of it) then skips.
const ExtendedGravityField& EmbeddedEarthGravityField(const EGM2008ForceConfig& config) {
    static ExtendedGravityField field;
    static bool cached = false;
    static uint16_t cachedDegree = 0, cachedOrder = 0, cachedTesseral = 0;
    static EmbeddedEarthField cachedField = EmbeddedEarthField::EGM2008;
    if (!cached || cachedDegree != config.truncationDegree || cachedOrder != config.truncationOrder ||
        cachedTesseral != config.maxTesseralDegree || cachedField != config.field) {
        EGM2008Config extConfig;
        extConfig.maxDegree = config.truncationDegree;
        extConfig.maxOrder = config.truncationOrder;
        field = config.field == EmbeddedEarthField::EGM96 ? initEGM96Extended(extConfig)
                                                          : initEGM2008Extended(extConfig);
        for (uint16_t n = 0; n <= field.maxDegree; ++n)
            for (uint16_t m = 1; m <= std::min(n, field.maxOrder); ++m)
                if (n > config.maxTesseralDegree) field.Cnm[n][m] = field.Snm[n][m] = 0.0;
        cached = true;
        cachedDegree = config.truncationDegree;
        cachedOrder = config.truncationOrder;
        cachedTesseral = config.maxTesseralDegree;
        cachedField = config.field;
    }
    return field;
}

namespace {
const ExtendedGravityField& egm2008Field(const EGM2008ForceConfig& config) {
    return EmbeddedEarthGravityField(config);
}
}  // namespace

Vec3 EGM2008(const Vec3& position, const EGM2008ForceConfig& config) {
    return computeExtendedGravity(position, egm2008Field(config)).total;
}

Vec3 EGM2008Harmonics(const Vec3& position, const EGM2008ForceConfig& config) {
    return computeExtendedGravity(position, egm2008Field(config)).zonalHarmonics;
}

// =============================================================================
// 4. GRGM1200A - Lunar Gravity Model
// =============================================================================

Vec3 GRGM1200A(const Vec3& position, const GRGM1200AForceConfig& config) {
    GravityFieldCoefficients coeffs = initGRGM1200A(
        std::min(config.truncationDegree, static_cast<uint16_t>(20)),
        std::min(config.truncationOrder, static_cast<uint16_t>(20)));

    GravityAcceleration result = computeSphericalHarmonicGravity(position, coeffs);
    return result.total;
}

// =============================================================================
// 5. Third Body - Sun/Moon/Planet Perturbations
// =============================================================================

Vec3 ThirdBodySingle(const Vec3& satPosition, const Vec3& bodyPosition, double muBody) {
    Vec3 rSatBody = bodyPosition - satPosition;
    double rSatBodyMag = rSatBody.magnitude();
    double rBodyMag = bodyPosition.magnitude();

    if (rSatBodyMag < 1.0 || rBodyMag < 1.0) {
        return Vec3();
    }

    // Direct term
    Vec3 direct = rSatBody * (muBody / (rSatBodyMag * rSatBodyMag * rSatBodyMag));

    // Indirect term
    Vec3 indirect = bodyPosition * (-muBody / (rBodyMag * rBodyMag * rBodyMag));

    return direct + indirect;
}

Vec3 ThirdBody(const Vec3& satPosition, double jd, const ThirdBodyPerturbConfig& config) {
    Vec3 totalAcc;

    if (config.includeSun) {
        EphemerisState sun = getSunPosition(jd);
        if (sun.valid) {
            totalAcc += ThirdBodySingle(satPosition, sun.position, MU_SUN);
        }
    }

    if (config.includeMoon) {
        EphemerisState moon = getMoonPosition(jd);
        if (moon.valid) {
            totalAcc += ThirdBodySingle(satPosition, moon.position, MU_MOON);
        }
    }

    // Planet third-body perturbations:
    // getPlanetPosition() returns heliocentric positions (Sun→Planet).
    // getSunPosition() returns geocentric Sun (Earth→Sun).
    // Geocentric planet = heliocentric planet + geocentric Sun
    //   planet_geo = (Planet - Sun) + (Sun - Earth) = Planet - Earth

    if (config.includeVenus) {
        EphemerisState venus = getPlanetPosition(CelestialBody::Venus, jd);
        if (venus.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 venusGeo = venus.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, venusGeo, MU_VENUS);
        }
    }

    if (config.includeMars) {
        EphemerisState mars = getPlanetPosition(CelestialBody::Mars, jd);
        if (mars.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 marsGeo = mars.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, marsGeo, MU_MARS);
        }
    }

    if (config.includeJupiter) {
        EphemerisState jupiter = getPlanetPosition(CelestialBody::Jupiter, jd);
        if (jupiter.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 jupiterGeo = jupiter.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, jupiterGeo, MU_JUPITER);
        }
    }

    if (config.includeSaturn) {
        EphemerisState saturn = getPlanetPosition(CelestialBody::Saturn, jd);
        if (saturn.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 saturnGeo = saturn.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, saturnGeo, MU_SATURN);
        }
    }

    if (config.includeMercury) {
        EphemerisState mercury = getPlanetPosition(CelestialBody::Mercury, jd);
        if (mercury.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 mercuryGeo = mercury.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, mercuryGeo, MU_MERCURY);
        }
    }

    if (config.includeUranus) {
        EphemerisState uranus = getPlanetPosition(CelestialBody::Uranus, jd);
        if (uranus.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 uranusGeo = uranus.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, uranusGeo, MU_URANUS);
        }
    }

    if (config.includeNeptune) {
        EphemerisState neptune = getPlanetPosition(CelestialBody::Neptune, jd);
        if (neptune.valid) {
            EphemerisState sun = getSunPosition(jd);
            Vec3 neptuneGeo = neptune.position + sun.position;
            totalAcc += ThirdBodySingle(satPosition, neptuneGeo, MU_NEPTUNE);
        }
    }

    return totalAcc;
}

// =============================================================================
// 6. Solar Radiation Pressure - Cannonball/Box-Wing
// =============================================================================

Vec3 SolarRadiationCannonball(const Vec3& satPosition, const Vec3& sunPosition,
                              double mass, double area, double Cr, double& shadowFactor) {
    Vec3 satSun = sunPosition - satPosition;
    double sunDist = satSun.magnitude();
    Vec3 sunDir = satSun.normalized();

    // Shadow check
    ShadowGeometry shadow = computeShadowGeometry(satPosition, sunPosition,
                                                   RE_EARTH, ShadowModelType::Conical);
    shadowFactor = 1.0 - shadow.shadowFraction;

    if (shadowFactor < 1e-6) {
        return Vec3();
    }

    // Solar flux and radiation pressure at satellite distance
    // flux is in W/m^2, c is in m/s for correct pressure calculation
    double flux = computeSolarFlux(sunDist);  // W/m^2
    constexpr double SPEED_OF_LIGHT_MS = 299792458.0;  // m/s
    double P = flux / SPEED_OF_LIGHT_MS;  // N/m^2 (radiation pressure)

    // Acceleration: a = P * Cr * A / m
    // P is N/m^2, area is m^2, mass is kg -> a in m/s^2
    // Convert to km/s^2 by multiplying by 1e-3
    double aMag = P * Cr * area / mass * 1e-3 * shadowFactor;  // km/s^2

    return sunDir * (-aMag);
}

namespace {
// The configured model without ECOM2 (each applies the Earth's shadow).
Vec3 SolarRadiationModel(const Vec3& satPosition, const Vec3& sunPosition, const SRPForceConfig& config) {
    if (config.model == SRPModelType::Cannonball) {
        double shadowFactor;
        return SolarRadiationCannonball(satPosition, sunPosition,
                                        config.mass, config.area, config.Cr, shadowFactor);
    }
    if (config.model == SRPModelType::GnssBoxWing) {
        // lib/gnss_srp.h, under the conical shadow of lib/shadow.h.
        using gnss_srp::V3;
        const V3<double> r(satPosition.x, satPosition.y, satPosition.z), sun(sunPosition.x, sunPosition.y, sunPosition.z);
        const double lit = gnss_srp::Lit(r, sun, RE_EARTH);
        if (lit < 1e-6) return Vec3();
        const double pressure = computeSolarFlux(gnss_srp::norm(sun - r)) / 299792458.0;  // N/m^2
        const V3<double> a = gnss_srp::BoxWingAcceleration(r, sun, pressure, config.mass, config.gnssBoxWing);
        return Vec3(a.x * lit, a.y * lit, a.z * lit);
    }

    // Box-wing model
    SRPConfig srpConfig;
    srpConfig.mass = config.mass;
    srpConfig.crossSectionArea = config.area;
    srpConfig.reflectivityCr = config.Cr;
    srpConfig.busArea = config.busArea;
    srpConfig.solarPanelArea = config.solarPanelArea;
    srpConfig.specularReflection = config.specularReflection;
    srpConfig.diffuseReflection = config.diffuseReflection;
    srpConfig.absorption = config.absorption;
    srpConfig.sunPointingPanels = config.sunTrackingPanels;
    srpConfig.shadowModel = config.shadowModel;

    if (config.model == SRPModelType::BoxWing) {
        SRPAcceleration result = computeSRPBoxWing(satPosition, sunPosition,
                                                    config.sunPointingAxis, srpConfig);
        return result.total;
    }

    // Default to cannonball
    SRPAcceleration result = computeSRPCannonball(satPosition, sunPosition, srpConfig);
    return result.total;
}
}  // namespace

Vec3 SolarRadiation(const Vec3& satPosition, const Vec3& satVelocity, const Vec3& sunPosition,
                    const SRPForceConfig& config) {
    Vec3 a = SolarRadiationModel(satPosition, sunPosition, config);
    if (config.ecom2.enabled) {
        // CODE's empirical accelerations on top, under the same conical shadow.
        using gnss_srp::V3;
        const V3<double> r(satPosition.x, satPosition.y, satPosition.z), v(satVelocity.x, satVelocity.y, satVelocity.z),
            sun(sunPosition.x, sunPosition.y, sunPosition.z);
        const double lit = gnss_srp::Lit(r, sun, RE_EARTH);
        if (lit >= 1e-6) {
            const V3<double> e = gnss_srp::Ecom2Acceleration(r, v, sun, config.ecom2);
            a += Vec3(e.x * lit, e.y * lit, e.z * lit);
        }
    }
    return a;
}

// =============================================================================
// 7. Atmospheric Drag - Exponential/NRLMSISE-00
// =============================================================================

Vec3 AtmosphericDragExponential(const Vec3& position, const Vec3& velocity,
                                double mass, double area, double Cd) {
    double alt = position.magnitude() - RE_EARTH;
    if (alt < 0) alt = 0;
    if (alt > 2500) return Vec3();

    double density = exponentialAtmosphereDensity(alt);

    // Exponential helper keeps legacy co-rotating atmosphere behavior.
    // Co-rotation about the GCRF z axis; this helper carries no epoch.
    Vec3 vRel = velocity - Vec3(0.0, 0.0, 1.0).cross(position) * OMEGA_EARTH;
    double vRelMag = vRel.magnitude();

    if (vRelMag < 1e-6 || density < 1e-20) {
        return Vec3();
    }

    // Drag acceleration
    double vRel_ms = vRelMag * 1000.0;
    double B = Cd * area / mass;  // m^2/kg
    double aMag = 0.5 * density * vRel_ms * vRel_ms * B * 1e-3;  // km/s^2

    return vRel.normalized() * (-aMag);
}

AtmosphereModelType AtmosphereModelForDrag(DragModelType model) {
    // Written out one member at a time, because it used to be a
    // `static_cast<AtmosphereModelType>(config.model)` — and the two enums do
    // not share an ordering. `DragModelType` runs
    // Exponential, USSA1976, HarrisPriester, NRLMSISE00, JB2008, DTM2020
    // while `AtmosphereModelType` runs
    // Exponential, USSA1976, NRLMSISE00, JB2008, DTM2020, GOST2004,
    // HarrisPriester.
    // From index 2 on, every value therefore named a DIFFERENT model:
    // Harris-Priester selected NRLMSISE-00, NRLMSISE-00 selected JB2008,
    // JB2008 selected DTM2020, and DTM2020 selected GOST2004, which no
    // dispatch handles and which fell through to NRLMSISE-00 again. A cast
    // between two enums is not a conversion; it is a coincidence, and this one
    // had stopped being true.
    switch (model) {
        case DragModelType::Exponential:    return AtmosphereModelType::Exponential;
        case DragModelType::USSA1976:       return AtmosphereModelType::USSA1976;
        case DragModelType::HarrisPriester: return AtmosphereModelType::HarrisPriester;
        case DragModelType::NRLMSISE00:     return AtmosphereModelType::NRLMSISE00;
        case DragModelType::JB2008:         return AtmosphereModelType::JB2008;
        case DragModelType::DTM2020:        return AtmosphereModelType::DTM2020;
        case DragModelType::JacchiaRoberts:      break;  // force-set path only (DragAccelerationWith)
    }
    return AtmosphereModelType::NRLMSISE00;
}

Vec3 HarrisPriester(const Vec3& position, const Vec3& velocity, double jd,
                    const DragForceConfig& dragConfig, double bulgeExponent,
                    const SpaceWeatherData* weather, double windJdUtc,
                    const EarthAxes* axes) {
    // The apex direction needs the Sun in the same frame as `position`: both
    // are GCRF here, and the bulge geometry depends only on their relative
    // direction.
    EphemerisState sun = getSunPosition(jd);
    AtmosphericDensity density =
        computeHarrisPriester(position, sun.valid ? sun.position : Vec3(1.0, 0.0, 0.0),
                              bulgeExponent);

    // Zero density here means the field point is outside the table's 100-1000
    // km support, where the model declines to answer. Declining is not the
    // same as asserting a vacuum, but for an acceleration the two agree.
    if (density.density < 1e-20) return Vec3();

    // jd is TDB for the Sun; the winds need the UTC day and time.
    const double windJd = windJdUtc > 0.0 ? windJdUtc : jd;
    EarthAxes fallback;
    Vec3 vRel = relativeAtmosphereVelocity(position, velocity, windJd,
                                           axesOr(axes, fallback, windJd),
                                           dragConfig.coRotatingAtmosphere,
                                           dragConfig.includeWinds, weather,
                                           dragConfig.windDisturbance);
    double vRelMag = vRel.magnitude();
    if (vRelMag < 1e-6) return Vec3();

    double vRel_ms = vRelMag * 1000.0;
    double B = dragConfig.Cd * dragConfig.area / dragConfig.mass;
    double aMag = 0.5 * density.density * vRel_ms * vRel_ms * B * 1e-3;
    return vRel.normalized() * (-aMag);
}

Vec3 AtmosphericDrag(const Vec3& position, const Vec3& velocity, double jd,
                     const SpaceWeatherData& weather, const DragForceConfig& config,
                     const EarthAxes* axes) {
    double alt = position.magnitude() - RE_EARTH;

    if (alt < config.minAltitude || alt > config.maxAltitude) {
        return Vec3();
    }

    // JB2008 needs the Sun in the same Earth-fixed axes as the point.
    if (config.model == DragModelType::JB2008) return JB2008(position, velocity, jd, weather, config, JB2008Config(), axes);

    DragConfig dragCfg;
    dragCfg.mass = config.mass;
    dragCfg.dragArea = config.area;
    dragCfg.Cd = config.Cd;
    dragCfg.atmosphere.model = AtmosphereModelForDrag(config.model);
    dragCfg.atmosphere.includeWinds = config.includeWinds;
    dragCfg.atmosphere.windDisturbance = config.windDisturbance;
    dragCfg.atmosphere.coRotatingAtmosphere = config.coRotatingAtmosphere;
    dragCfg.atmosphere.minAltitude = config.minAltitude;
    dragCfg.atmosphere.maxAltitude = config.maxAltitude;

    // computeDragAcceleration takes Earth-fixed axes: rotate the GCRF state in
    // (the inertial velocity is only re-expressed; co-rotation is subtracted
    // inside) and the acceleration back out.
    EarthAxes fallback;
    const EarthAxes& e = axesOr(axes, fallback, jd);
    DragAccelerationResult result = computeDragAcceleration(
        e.fixed(position), e.fixed(velocity), jd, dragCfg, weather);
    return e.inertial(result.total);
}

// =============================================================================
// 8. NRLMSISE-00 - Full Atmospheric Model
// =============================================================================

Vec3 NRLMSISE00(const Vec3& position, const Vec3& velocity, double jd,
                const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
                const NRLMSISE00Config& nrlmsiseConfig, const EarthAxes* axes) {
    AtmosphereConfig atmConfig;
    atmConfig.model = AtmosphereModelType::NRLMSISE00;
    atmConfig.includeWinds = dragConfig.includeWinds;
    atmConfig.coRotatingAtmosphere = dragConfig.coRotatingAtmosphere;
    atmConfig.diurnalVariation = nrlmsiseConfig.diurnalVariation;
    atmConfig.geomagneticEffects = nrlmsiseConfig.geomagneticActivity;
    atmConfig.minAltitude = dragConfig.minAltitude;
    atmConfig.maxAltitude = dragConfig.maxAltitude;

    EarthAxes fallback;
    const EarthAxes& e = axesOr(axes, fallback, jd);
    AtmosphericDensity density = computeNRLMSISE00(e.fixed(position), jd, weather, atmConfig);

    if (density.density < 1e-20) {
        return Vec3();
    }

    // Compute drag in atmosphere-relative velocity convention.
    Vec3 vRel = relativeAtmosphereVelocity(
        position,
        velocity,
        jd,
        e,
        dragConfig.coRotatingAtmosphere,
        dragConfig.includeWinds,
        &weather,
        dragConfig.windDisturbance
    );
    double vRelMag = vRel.magnitude();

    if (vRelMag < 1e-6) {
        return Vec3();
    }

    double vRel_ms = vRelMag * 1000.0;
    double B = dragConfig.Cd * dragConfig.area / dragConfig.mass;
    double aMag = 0.5 * density.density * vRel_ms * vRel_ms * B * 1e-3;

    return vRel.normalized() * (-aMag);
}

AtmosphericDensity NRLMSISE00Density(const Vec3& position, double jd,
                                     const SpaceWeatherData& weather,
                                     const NRLMSISE00Config& config) {
    AtmosphereConfig atmConfig;
    atmConfig.model = AtmosphereModelType::NRLMSISE00;
    atmConfig.diurnalVariation = config.diurnalVariation;
    atmConfig.geomagneticEffects = config.geomagneticActivity;

    return computeNRLMSISE00(EarthFixedForDensity(position, jd), jd, weather, atmConfig);
}

// =============================================================================
// 9. JB2008 - Jacchia-Bowman 2008
// =============================================================================

double JB2008DensityAt(const Vec3& position, double jdTdb, double jdUtc,
                       const EarthAxes& axes, const SpaceWeatherData& weather) {
    double lat = 0, lon = 0, alt = 0, sunLat = 0, sunLon = 0, sunAlt = 0;
    ecefToGeodetic(axes.fixed(position), lat, lon, alt);
    const EphemerisState sun = getSunPosition(jdTdb);
    if (!sun.valid) return 0.0;
    ecefToGeodetic(axes.fixed(sun.position), sunLat, sunLon, sunAlt);
    const jb2008::Inputs in{weather.F107, weather.F107a, weather.S107, weather.S107a,
                            weather.M107, weather.M107a, weather.Y107, weather.Y107a, weather.dTc};
    return jb2008::density(jdUtc - 2400000.5, sunLon, sunLat, lon, lat, alt * 1000.0, in);
}

// Drag from a density at the point: the air's velocity (co-rotation and
// winds as configured, in the same axes) and 1/2 rho v^2 Cd A/m along -v_rel.
static Vec3 DragFromDensity(double rho, const Vec3& position, const Vec3& velocity, double jdUt,
                     const EarthAxes& axes, const DragForceConfig& drag,
                     const SpaceWeatherData& weather) {
    const Vec3 vRel = relativeAtmosphereVelocity(position, velocity, jdUt, axes,
        drag.coRotatingAtmosphere, drag.includeWinds, &weather, drag.windDisturbance);
    const double vRelMag = vRel.magnitude();
    if (rho < 1e-20 || vRelMag < 1e-6) return Vec3();
    const double vRelMs = vRelMag * 1000.0;
    return vRel.normalized() * (-0.5 * rho * vRelMs * vRelMs * drag.Cd * drag.area / drag.mass * 1e-3);
}

// The published model (JB2008DensityAt), on the given axes or GMST axes.
// The Sun is taken at jd as given (UTC here; 69 s from TDB moves it 0.0008
// degrees).
Vec3 JB2008(const Vec3& position, const Vec3& velocity, double jd,
            const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
            const JB2008Config&, const EarthAxes* axes) {
    EarthAxes fallback;
    const EarthAxes& e = axesOr(axes, fallback, jd);
    return DragFromDensity(JB2008DensityAt(position, jd, jd, e, weather), position, velocity, jd, e, dragConfig, weather);
}

AtmosphericDensity JB2008Density(const Vec3& position, double jd,
                                 const SpaceWeatherData& weather,
                                 const JB2008Config&) {
    return computeJB2008(EarthFixedForDensity(position, jd), jd, weather);
}

// =============================================================================
// 10. DTM2020 - Drag Temperature Model 2020
// =============================================================================

Vec3 DTM2020(const Vec3& position, const Vec3& velocity, double jd,
             const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
             const DTM2020Config& dtmConfig, const EarthAxes* axes) {
    EarthAxes fallback;
    const EarthAxes& e = axesOr(axes, fallback, jd);
    AtmosphericDensity density = computeDTM2020(e.fixed(position), jd, weather);

    if (density.density < 1e-20) {
        return Vec3();
    }

    Vec3 vRel = relativeAtmosphereVelocity(
        position,
        velocity,
        jd,
        e,
        dragConfig.coRotatingAtmosphere,
        dragConfig.includeWinds,
        &weather,
        dragConfig.windDisturbance
    );
    double vRelMag = vRel.magnitude();

    if (vRelMag < 1e-6) {
        return Vec3();
    }

    double vRel_ms = vRelMag * 1000.0;
    double B = dragConfig.Cd * dragConfig.area / dragConfig.mass;
    double aMag = 0.5 * density.density * vRel_ms * vRel_ms * B * 1e-3;

    return vRel.normalized() * (-aMag);
}

AtmosphericDensity DTM2020Density(const Vec3& position, double jd,
                                  const SpaceWeatherData& weather,
                                  const DTM2020Config& config) {
    return computeDTM2020(EarthFixedForDensity(position, jd), jd, weather);
}

// =============================================================================
// 11. Relativistic Correction - General Relativity Effects
// =============================================================================

Vec3 SchwarzschildCorrection(const Vec3& position, const Vec3& velocity, double mu) {
    // Schwarzschild (mass monopole) relativistic correction
    // From IERS Conventions 2010, Eq. 10.12

    double r = position.magnitude();
    double r2 = r * r;
    double v2 = velocity.magnitudeSq();
    double c2 = SPEED_OF_LIGHT * SPEED_OF_LIGHT;

    double rdotv = position.dot(velocity);

    // Schwarzschild term
    double factor = mu / (c2 * r2 * r);

    Vec3 term1 = position * ((4.0 * mu / r - v2) * factor);
    Vec3 term2 = velocity * (4.0 * rdotv * factor);

    return term1 + term2;
}

Vec3 RelativisticCorrection(const Vec3& position, const Vec3& velocity, double jd,
                            double mu, const RelativisticConfig& config,
                            const EarthAxes* axes) {
    Vec3 totalAcc;

    double c2 = config.c * config.c;

    if (config.schwarzschild) {
        totalAcc += SchwarzschildCorrection(position, velocity, mu);
    }

    if (config.lenseThirring) {
        // Lense-Thirring (frame dragging), IERS Conventions 2010 eq. 10.12
        // second term with gamma = 1:
        // a_LT = 2 GM/(c^2 r^3) [3/r^2 (r x v)(r . J) + v x J],
        // J = |J| times the Earth's spin axis: the Earth-fixed z axis of the
        // force set's Earth orientation (EOP when supplied), in GCRF.
        double r = position.magnitude();
        double r2 = r * r;
        double r3 = r2 * r;

        Vec3 spinAxis = axes ? axes->spin() : Vec3(0, 0, 1);

        double rDotSpin = position.dot(spinAxis);
        Vec3 rCrossV = position.cross(velocity);
        Vec3 vCrossSpin = velocity.cross(spinAxis);

        double factor = 2.0 * mu * EARTH_J_PER_MASS_KM2_S / (c2 * r3);
        Vec3 term1 = rCrossV * (3.0 * rDotSpin / r2);
        Vec3 term2 = vCrossSpin;

        totalAcc += (term1 + term2) * factor;
    }

    if (config.deSitter) {
        // de Sitter (geodetic precession) effect
        // IERS Conventions 2010, Eq. 10.12 third term
        // a_dS = -(1+2γ)/(2c²) · (v_E × a_E) × v_sat
        // γ = 1 (GR), so factor = 3/(2c²)
        // v_E = Earth heliocentric velocity, a_E = Sun's gravitational accel on Earth
        EphemerisState sun = getSunPosition(jd);
        if (sun.valid) {
            // getSunPosition returns geocentric Sun position/velocity
            // Earth heliocentric = negative of geocentric Sun
            Vec3 rES = sun.position;   // Earth→Sun vector
            double rES_mag = rES.magnitude();
            if (rES_mag > 1e3) {
                Vec3 vE = sun.velocity * (-1.0); // Earth heliocentric velocity

                // Acceleration of Earth due to Sun: a_E = μ_S/|r_ES|³ · r_ES
                double rES3 = rES_mag * rES_mag * rES_mag;
                Vec3 aE = rES * (MU_SUN / rES3);

                // de Sitter: a = -3/(2c²) · (v_E × a_E) × v_sat
                Vec3 vE_cross_aE = vE.cross(aE);
                // IERS Conventions (2010) eq. 10.12, third term with gamma = 1:
                // (1 + 2 gamma) [Rdot x (-GM_S R / (c^2 R^3))] x v, R the Earth
                // from the Sun. aE is that bracket's -GM_S R / R^3. Until
                // 2026-10-08 the coefficient was -3/2 instead of 3.
                totalAcc += vE_cross_aE.cross(velocity) * (3.0 / c2);
            }
        }
    }

    return totalAcc;
}

// =============================================================================
// 12. Earth Radiation Pressure - albedo and infrared (Knocke 1988)
// =============================================================================

// Orekit 13.1 KnockeRediffusedForceModel (lib/earth_radiation.h), in metres:
// the pressure vector times Cr*A/m. The annual term reads the time since
// 1981-12-22T00:00:00 UTC on TT (TDB differs by under 2 ms).
Vec3 EarthRadiation(const Vec3& satPosition, const Vec3& sunPosition, double jd,
                    const EarthRadiationConfig& config) {
    if (!(config.crAreaOverMass > 0) || satPosition.magnitude() <= config.radiusKm) return Vec3();
    const double deltaT = (timesys::tdbToTt(jd) - knocke::REFERENCE_EPOCH_JD_TT) * 86400.0;
    const Vec3 pressure = knocke::pressure<Vec3, double>(satPosition * 1000.0, sunPosition * 1000.0, deltaT,
                                                         config.resolutionDeg * DEG_TO_RAD, config.radiusKm * 1000.0);
    return pressure * (config.crAreaOverMass * 1e-3);
}

double EarthRadiationCoefficient(const ForceModelSet& forceSet) {
    const EarthRadiationConfig& c = forceSet.earthRadiation;
    if (!c.sharesSrpCoefficient) return c.crAreaOverMass;
    const SRPForceConfig& s = forceSet.srp;
    return s.mass > 0 ? s.Cr * s.area / s.mass : 0.0;
}

// =============================================================================
// 13. Thermal Reradiation - Yarkovsky-like Effect
// =============================================================================

Vec3 ThermalReradiation(const Vec3& satPosition, const Vec3& sunPosition,
                        const ThermalReradiationConfig& config) {
    // Yarkovsky-like thermal reradiation effect
    // Asymmetric thermal emission creates net force

    Vec3 sunDir = (sunPosition - satPosition).normalized();
    double sunDist = (sunPosition - satPosition).magnitude();

    // Absorbed solar power
    double solarFlux = SOLAR_FLUX_1AU * (AU_KM / sunDist) * (AU_KM / sunDist);
    double absorbedPower = solarFlux * config.surfaceArea * (1.0 - 0.3);  // Assume 0.3 albedo

    // Equilibrium temperature (simplified)
    double T4 = absorbedPower / (config.emissivity * STEFAN_BOLTZMANN * config.surfaceArea);
    double T = std::pow(T4, 0.25);

    // Thermal lag creates asymmetric emission
    // For spinning body, thermal force is perpendicular to Sun direction
    Vec3 forceDir;
    if (config.spinPeriod > 0) {
        // Diurnal Yarkovsky: force along orbit
        forceDir = sunDir.cross(config.spinAxis).normalized();
    } else {
        // Seasonal Yarkovsky: force along spin axis
        forceDir = config.spinAxis;
    }

    // Thermal recoil force (very small, ~1e-12 km/s^2 for typical spacecraft)
    double thermalParam = config.thermalInertia / std::sqrt(config.spinPeriod > 0 ? config.spinPeriod : 1e6);
    double aMag = STEFAN_BOLTZMANN * T * T * T * T * config.surfaceArea * config.emissivity
                  / (config.mass * SPEED_OF_LIGHT * 1e9) * thermalParam * 1e-6;

    return forceDir * aMag;
}

// =============================================================================
// 14. Solid Tides - Solid Earth Tides
// =============================================================================

namespace {

constexpr double ARCSEC_TO_RAD = PI / 648000.0;

// GMST, IERS Conventions (2010) eq. 5.32: the Earth rotation angle (eq.
// 5.15) at UT1 plus the IAU 2006 polynomial in TT (ERFA eraGmst06).
double gmst2006(double jdUt1, double jdTt) {
    const double du = jdUt1 - 2451545.0;
    const double era = TWO_PI * (std::fmod(jdUt1, 1.0) + 0.7790572732640 + 0.00273781191135448 * du);
    const double t = (jdTt - 2451545.0) / 36525.0;
    const double poly = 0.014506 + t * (4612.156534 + t * (1.3915817 + t * (-0.00000044 +
                        t * (-0.000029956 + t * -0.0000000368))));
    return std::fmod(era, TWO_PI) + poly * ARCSEC_TO_RAD;
}

// Delaunay arguments l, l', F, D, Omega (IERS Conventions 2010 eq. 5.43;
// ERFA eraFal03, eraFalp03, eraFaf03, eraFad03, eraFaom03), radians.
void delaunayArguments(double jdTt, double a[5]) {
    const double t = (jdTt - 2451545.0) / 36525.0;
    const double turn = 1296000.0;
    a[0] = std::fmod(485868.249036 + t * (1717915923.2178 + t * (31.8792 + t * (0.051635 + t * -0.00024470))), turn);
    a[1] = std::fmod(1287104.793048 + t * (129596581.0481 + t * (-0.5532 + t * (0.000136 + t * -0.00001149))), turn);
    a[2] = std::fmod(335779.526232 + t * (1739527262.8478 + t * (-12.7512 + t * (-0.001037 + t * 0.00000417))), turn);
    a[3] = std::fmod(1072260.703692 + t * (1602961601.2090 + t * (-6.3706 + t * (0.006593 + t * -0.00003169))), turn);
    a[4] = std::fmod(450160.398036 + t * (-6962890.5431 + t * (7.4722 + t * (0.007702 + t * -0.00005939))), turn);
    for (int i = 0; i < 5; ++i) a[i] *= ARCSEC_TO_RAD;
}

// Fully normalized associated Legendre functions of degrees 2 and 3 at
// t = sin(latitude), u = cos(latitude): the geodetic normalization
// sqrt((2 - delta_m0)(2n + 1)(n - m)!/(n + m)!), no Condon-Shortley phase.
void normalizedLegendre3(double t, double u, double p[4][4]) {
    p[2][0] = std::sqrt(5.0) * 0.5 * (3.0 * t * t - 1.0);
    p[2][1] = std::sqrt(15.0) * t * u;
    p[2][2] = std::sqrt(15.0) * 0.5 * u * u;
    p[3][0] = std::sqrt(7.0) * 0.5 * t * (5.0 * t * t - 3.0);
    p[3][1] = std::sqrt(42.0) * 0.25 * (5.0 * t * t - 1.0) * u;
    p[3][2] = std::sqrt(105.0) * 0.5 * t * u * u;
    p[3][3] = std::sqrt(70.0) * 0.25 * u * u * u;
}

double ut1At(double jd, const ForceModelSet& forceSet) {
    if (forceSet.jdUt1At) return forceSet.jdUt1At(jd);
    return timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(jd)));
}

}  // namespace

// IERS Conventions (2010) section 6.2.1. Until 2026-10-08 this was degree 2
// and 3 only, with unnormalized P21/P22 weighted as if normalized (dC21/dS21
// off by 5/3, dC22/dS22 by 5/12), real Love numbers, no k+ degree-4 terms,
// step 2 as the K1 line alone on an approximate GMST, and the pole and
// longitudes taken in GCRF rather than in the Earth-fixed frame.
ExtendedGravityField SolidTideField(double jd, const ForceModelSet& forceSet,
                                    const EarthAxes& axes) {
    using namespace iers2010;
    const SolidTideConfig& config = forceSet.solidTides;
    ExtendedGravityField field;
    field.mu = forceSet.mu;
    field.referenceRadius = EGM2008_RADIUS_KM;
    field.allocate(4, 4);

    // Step 1 (eqs. 6.6, 6.7): each body's degree-2 and -3 tide with the
    // complex anelastic k_nm, and degree 4 through k+_2m.
    for (int body = 0; body < 2; ++body) {
        if (body == 0 ? !config.includeMoonTide : !config.includeSunTide) continue;
        const EphemerisState state = body == 0 ? getMoonPosition(jd) : getSunPosition(jd);
        if (!state.valid) continue;
        const double gm = body == 0 ? MU_MOON : MU_SUN;
        const Vec3 p = axes.fixed(state.position);
        const double r = p.magnitude(), rho = std::sqrt(p.x * p.x + p.y * p.y);
        if (r <= 0.0 || rho <= 0.0) continue;
        double legendre[4][4] = {};
        normalizedLegendre3(p.z / r, rho / r, legendre);
        const double ratio = field.referenceRadius / r;
        const double cosL = p.x / rho, sinL = p.y / rho;
        for (int n = 2; n <= 3; ++n) {
            double cm = 1.0, sm = 0.0;
            for (int m = 0; m <= n; ++m) {
                const double coeff = gm / field.mu * std::pow(ratio, n + 1) * legendre[n][m] / (2.0 * n + 1.0);
                const double kR = LOVE_RE[n][m], kI = LOVE_IM[n][m];
                field.Cnm[n][m] += coeff * (kR * cm + kI * sm);
                field.Snm[n][m] += coeff * (kR * sm - kI * cm);
                if (n == 2) {
                    field.Cnm[4][m] += LOVE_PLUS[m] * coeff * cm;
                    field.Snm[4][m] += LOVE_PLUS[m] * coeff * sm;
                }
                const double next = cm * cosL - sm * sinL;
                sm = sm * cosL + cm * sinL;
                cm = next;
            }
        }
    }

    // Step 2 (eq. 6.8): frequency dependence of k20, k21, k22, with
    // theta_f = m (GMST + pi) - N . F.
    if (config.frequencyDependent) {
        const double jdTt = timesys::tdbToTt(jd);
        const double gamma = gmst2006(ut1At(jd, forceSet), jdTt) + PI;
        double fundamental[5];
        delaunayArguments(jdTt, fundamental);
        auto theta = [&](const TideFrequencyTerm& w) {
            double a = w.m * gamma;
            for (int i = 0; i < 5; ++i) a -= w.delaunay[i] * fundamental[i];
            return a;
        };
        constexpr double PICO = 1e-12;
        for (const auto& w : K20_TERMS) {
            const double a = theta(w);
            field.Cnm[2][0] += (w.inPhase * std::cos(a) - w.outOfPhase * std::sin(a)) * PICO;
        }
        for (const auto& w : K21_TERMS) {
            const double a = theta(w), c = std::cos(a), s = std::sin(a);
            field.Cnm[2][1] += (w.inPhase * s + w.outOfPhase * c) * PICO;
            field.Snm[2][1] += (w.inPhase * c - w.outOfPhase * s) * PICO;
        }
        for (const auto& w : K22_TERMS) {
            const double a = theta(w);
            field.Cnm[2][2] += w.inPhase * std::cos(a) * PICO;
            field.Snm[2][2] -= w.inPhase * std::sin(a) * PICO;
        }
    }

    // A zero-tide central field already holds the permanent tide (eq. 6.13).
    if (config.zeroTideField) field.Cnm[2][0] -= 4.4228e-8 * -0.31460 * LOVE_RE[2][0];
    return field;
}

Vec3 SolidTideAcceleration(const Vec3& satPosition, double jd, const ForceModelSet& forceSet) {
    if (satPosition.magnitude() < RE_EARTH) return Vec3();
    const EarthAxes axes = EarthAxesAt(jd, forceSet);
    const ExtendedGravityField field = SolidTideField(jd, forceSet, axes);
    return axes.inertial(computeExtendedGravity(axes.fixed(satPosition), field).zonalHarmonics);
}

Vec3 SolidTides(const Vec3& satPosition, double jd, const SolidTideConfig& config) {
    ForceModelSet forceSet;
    forceSet.solidTides = config;
    return SolidTideAcceleration(satPosition, jd, forceSet);
}

// =============================================================================
// 15. Ocean Tides - IERS Conventions (2010) section 6.3, FES2004
// =============================================================================

// Orekit 13.1 OceanTidesField / OceanTidesWave.addContribution: each wave's
// Doodson number gives the multipliers of gamma = GMST + pi and the Delaunay
// arguments (IERS 2010 eq. 5.43, the solid tides' delaunayArguments), and
//   dCnm += (C+ + C-) cos(theta) + (S+ + S-) sin(theta)
//   dSnm += (S+ - S-) cos(theta) - (C+ - C-) sin(theta)
// summed from degree 2. No ocean pole tide.
ExtendedGravityField OceanTideField(double jd, const ForceModelSet& forceSet) {
    const OceanTideConfig& config = forceSet.oceanTides;
    const int maxDegree = std::max(2, std::min<int>(config.maxDegree, fes2004::MAX_DEGREE));
    const int maxOrder = std::max(0, std::min<int>(config.maxOrder, maxDegree));
    ExtendedGravityField field;
    field.mu = forceSet.mu;
    field.referenceRadius = EGM2008_RADIUS_KM;
    field.allocate(maxDegree, maxOrder);
    const double jdTt = timesys::tdbToTt(jd);
    const double gamma = gmst2006(ut1At(jd, forceSet), jdTt) + PI;
    double fundamental[5];  // l, l', F, D, Omega
    delaunayArguments(jdTt, fundamental);
    for (int k = 0; k < fes2004::WAVE_COUNT; ++k) {
        const fes2004::Wave& wave = fes2004::WAVES[k];
        const int d = wave.doodson;
        const int cPs = (d % 10) - 5, cNPrime = ((d / 10) % 10) - 5, cP = ((d / 100) % 10) - 5;
        const int cH = ((d / 1000) % 10) - 5, cS = ((d / 10000) % 10) - 5, cTau = (d / 100000) % 10;
        const double theta = cTau * gamma - cP * fundamental[0] - cPs * fundamental[1] +
                             (-cTau + cS + cH + cP + cPs) * fundamental[2] + (-cH - cPs) * fundamental[3] +
                             (-cTau + cS + cH + cP - cNPrime + cPs) * fundamental[4];
        const double c = std::cos(theta), s = std::sin(theta);
        for (int i = 0; i < wave.count; ++i) {
            const fes2004::Row& row = wave.rows[i];
            if (row.n > maxDegree || row.m > maxOrder) continue;
            const double cp = row.cPlus, sp = row.sPlus, cm = row.cMinus, sm = row.sMinus;
            field.Cnm[row.n][row.m] += ((cp + cm) * c + (sp + sm) * s) * fes2004::UNIT;
            field.Snm[row.n][row.m] += ((sp - sm) * c - (cp - cm) * s) * fes2004::UNIT;
        }
    }
    return field;
}

Vec3 OceanTideAcceleration(const Vec3& satPosition, double jd, const ForceModelSet& forceSet) {
    if (satPosition.magnitude() < RE_EARTH) return Vec3();
    const EarthAxes axes = EarthAxesAt(jd, forceSet);
    const ExtendedGravityField field = OceanTideField(jd, forceSet);
    return axes.inertial(computeExtendedGravity(axes.fixed(satPosition), field).zonalHarmonics);
}

// =============================================================================
// 16. Pole Tide - Polar Motion Correction
// =============================================================================

Vec3 PoleTide(const Vec3& satPosition, const PoleTideConfig& config) {
    // Pole tide from polar motion
    // IERS Conventions 2010, Section 7.1.4

    double r = satPosition.magnitude();
    if (r < RE_EARTH) return Vec3();

    // Polar motion difference from mean pole (arcsec -> rad)
    double m1 = (config.xp - config.xp_mean) * 4.848136811e-6;
    double m2 = (config.yp - config.yp_mean) * 4.848136811e-6;

    // Geodetic coordinates
    double lat, lon, alt;
    ecefToGeodetic(satPosition, lat, lon, alt);

    // Pole tide potential (degree 2, order 1)
    constexpr double k2 = 0.30;  // Love number
    constexpr double gamma2 = 0.609;  // Load Love number

    double omega = OMEGA_EARTH;
    double factor = k2 * RE_EARTH * RE_EARTH * omega * omega / MU_EARTH;

    // Pole tide acceleration components
    double sinLat = std::sin(lat);
    double cosLat = std::cos(lat);
    double sin2Lat = std::sin(2.0 * lat);

    double ar = factor * sin2Lat * (m1 * std::cos(lon) + m2 * std::sin(lon)) * MU_EARTH / (r * r);
    double alat = factor * cosLat * 2.0 * (m1 * std::cos(lon) + m2 * std::sin(lon)) * MU_EARTH / (r * r);
    double alon = factor * sinLat * (m1 * std::sin(lon) - m2 * std::cos(lon)) * MU_EARTH / (r * r);

    // Convert to Cartesian
    double cosLon = std::cos(lon);
    double sinLon = std::sin(lon);

    Vec3 rHat(cosLat * cosLon, cosLat * sinLon, sinLat);
    Vec3 latHat(-sinLat * cosLon, -sinLat * sinLon, cosLat);
    Vec3 lonHat(-sinLon, cosLon, 0.0);

    return rHat * ar + latHat * alat + lonHat * alon;
}

// =============================================================================
// 17. Finite Maneuver - Continuous Thrust
// =============================================================================

double FiniteManeuverMassRate(const FiniteManeuverConfig& config) {
    if (config.massFlowRate > 0) {
        return config.massFlowRate;
    }
    // Compute from thrust and Isp: mdot = F / (Isp * g0)
    constexpr double g0 = 9.80665e-3;  // km/s^2
    return config.thrustMagnitude / (config.Isp * g0 * 1000.0);  // kg/s
}

Vec3 FiniteManeuver(const Vec3& position, const Vec3& velocity, double currentTime,
                    const FiniteManeuverConfig& config) {
    // Check if maneuver is active
    double t_start = config.startTime;
    double t_end = t_start + config.duration / 86400.0;

    if (currentTime < t_start || currentTime > t_end) {
        return Vec3();  // Maneuver not active
    }

    // Determine thrust direction
    Vec3 thrustDir;

    if (config.velocityAligned) {
        thrustDir = velocity.normalized();
        if (config.antiVelocity) {
            thrustDir = thrustDir * (-1.0);
        }
    } else if (config.sunPointing) {
        EphemerisState sun = getSunPosition(currentTime);
        thrustDir = (sun.position - position).normalized();
    } else if (config.inertialDirection) {
        thrustDir = config.thrustDirection.normalized();
    } else {
        // Body-fixed direction - convert to inertial using velocity frame
        thrustDir = RTNToInertial(config.thrustDirection, position, velocity).normalized();
    }

    // Thrust acceleration: a = F / m (convert N to km/s^2)
    double aMag = config.thrustMagnitude / config.mass * 1e-3;  // km/s^2

    return thrustDir * aMag;
}

// =============================================================================
// 18. Impulsive Maneuver - Delta-V Events
// =============================================================================

Vec3 RTNToInertial(const Vec3& deltaV_RTN, const Vec3& position, const Vec3& velocity) {
    // RTN frame unit vectors
    Vec3 R = position.normalized();
    Vec3 N = position.cross(velocity).normalized();
    Vec3 T = N.cross(R);

    // Transform RTN to inertial
    return R * deltaV_RTN.x + T * deltaV_RTN.y + N * deltaV_RTN.z;
}

bool ImpulsiveManeuverDue(double currentTime, double previousTime,
                          const ImpulsiveManeuverDef& maneuver) {
    if (maneuver.executed) return false;

    // Check if maneuver epoch falls within time step
    return (maneuver.epoch > previousTime && maneuver.epoch <= currentTime) ||
           (maneuver.epoch < previousTime && maneuver.epoch >= currentTime);  // Backward propagation
}

Vec3 ImpulsiveManeuver(const Vec3& velocity, const Vec3& position,
                       const ImpulsiveManeuverDef& maneuver) {
    Vec3 dv = maneuver.deltaV;

    if (maneuver.inRTN) {
        dv = RTNToInertial(dv, position, velocity);
    }

    return velocity + dv;
}

// =============================================================================
// 19. Empirical Accelerations
// =============================================================================

Vec3 EmpiricalAcceleration(const Vec3& position, const Vec3& velocity,
                            const EmpiricalAccelConfig& config) {
    Vec3 totalAcc;

    if (config.numTerms <= 0) return totalAcc;

    // Compute RTN frame unit vectors
    double r_mag = position.magnitude();
    double v_mag = velocity.magnitude();
    if (r_mag < 1.0 || v_mag < 1e-10) return totalAcc;

    Vec3 rHat = position.normalized();                      // Radial
    Vec3 hHat = position.cross(velocity).normalized();      // Cross-track (angular momentum dir)
    Vec3 tHat = hHat.cross(rHat);                           // Along-track (completes RTN)

    // Compute argument of latitude u: the angle of the position vector
    // measured from the ascending node within the orbital plane.
    // u = ω + ν (argument of periapsis + true anomaly)
    //
    // Method: project position onto the nodal reference frame.
    // Node vector N = ẑ × h (ascending node direction)
    // u = atan2(r · ĥ×N̂, r · N̂)  where ĥ = angular momentum direction
    Vec3 h = position.cross(velocity);  // angular momentum
    double h_mag = h.magnitude();
    Vec3 zAxis(0.0, 0.0, 1.0);
    Vec3 nodeVec = zAxis.cross(h);  // ascending node direction
    double node_mag = nodeVec.magnitude();

    double u;
    if (node_mag > 1e-10) {
        // Non-equatorial orbit: compute u from nodal frame
        Vec3 nHat = nodeVec * (1.0 / node_mag);
        Vec3 hHatLocal = h * (1.0 / h_mag);
        Vec3 nPerp = hHatLocal.cross(nHat);  // in-plane perpendicular to node

        double cosU = position.dot(nHat) / r_mag;
        double sinU = position.dot(nPerp) / r_mag;
        u = std::atan2(sinU, cosU);
    } else {
        // Near-equatorial orbit: u ≈ atan2(y, x) (longitude of position)
        u = std::atan2(position.y, position.x);
    }

    for (int i = 0; i < config.numTerms && i < EmpiricalAccelConfig::MAX_TERMS; i++) {
        const EmpiricalAccelTerm& term = config.terms[i];

        // Determine direction unit vector
        Vec3 dir;
        switch (term.direction) {
            case EmpiricalDirection::Radial:     dir = rHat; break;
            case EmpiricalDirection::AlongTrack: dir = tHat; break;
            case EmpiricalDirection::CrossTrack: dir = hHat; break;
            case EmpiricalDirection::Inertial:   dir = term.inertialDir.normalized(); break;
        }

        // Compute magnitude based on model
        double accelMag = 0.0;
        switch (term.model) {
            case EmpiricalModel::Constant:
                accelMag = term.magnitude;
                break;
            case EmpiricalModel::OncePerRev:
                accelMag = term.cosMagnitude * std::cos(u) + term.sinMagnitude * std::sin(u);
                break;
            case EmpiricalModel::TwicePerRev:
                accelMag = term.cosMagnitude * std::cos(2.0 * u) + term.sinMagnitude * std::sin(2.0 * u);
                break;
        }

        totalAcc += dir * accelMag;
    }

    return totalAcc;
}

// =============================================================================
// Combined Force Model Evaluation
// =============================================================================

Vec3 ZonalHarmonic(const Vec3& position, double mu, double Re, int n, double Jn) {
    if (n < 2) return Vec3();
    const double r = position.magnitude();
    if (r <= 0.0) return Vec3();
    const double u = position.z / r;

    // P_n(u) and P_n'(u) by the standard recursions. No term of this shares
    // algebra with J2Only()/J2J4(), which is the point: agreement between the
    // two is a cross-validation.
    double pPrev = 1.0;   // P_0
    double pCur  = u;     // P_1
    for (int k = 2; k <= n; k++) {
        const double pNext = ((2.0 * k - 1.0) * u * pCur - (k - 1.0) * pPrev) / k;
        pPrev = pCur;
        pCur = pNext;
    }
    const double Pn = (n == 0) ? 1.0 : (n == 1 ? u : pCur);
    // P_n'(u) = n (u P_n - P_{n-1}) / (u^2 - 1); the removable singularity at
    // the poles is taken by the equivalent recurrence limit.
    double dPn;
    const double denom = u * u - 1.0;
    if (std::abs(denom) < 1e-14) {
        // On the axis P_n'(±1) = ±^(n+1) n(n+1)/2.
        dPn = 0.5 * n * (n + 1.0) * ((u > 0.0 || (n % 2 == 1)) ? 1.0 : -1.0);
        if (u < 0.0 && (n % 2 == 0)) dPn = -0.5 * n * (n + 1.0);
    } else {
        dPn = n * (u * Pn - pPrev) / denom;
    }

    // U_n = -(mu/r) (Re/r)^n J_n P_n(u)
    const double ratio = std::pow(Re / r, static_cast<double>(n));
    const double common = mu * Jn * ratio / r;
    const double dUdr = (n + 1.0) * common * Pn / r;   // d/dr of -(mu/r)(Re/r)^n...
    const double dUdu = -common * dPn;

    // grad u = (zhat - u rhat) / r
    const Vec3 rhat = position / r;
    const Vec3 gradU_r = rhat * dUdr;
    const Vec3 gradU_u = (Vec3(0.0, 0.0, 1.0) - rhat * u) * (dUdu / r);
    return gradU_r + gradU_u;
}

Vec3 EvaluateContribution(const ForceContribution& c,
                          const Vec3& position, const Vec3& velocity) {
    if (!c.enabled) return Vec3();
    switch (c.kind) {
        case ContributionKind::ConstantInertial:
            return Vec3(c.p[0], c.p[1], c.p[2]);
        case ContributionKind::ConstantRTN: {
            const Vec3 R = position.normalized();
            const Vec3 h = position.cross(velocity);
            if (h.magnitude() <= 0.0) return Vec3();
            const Vec3 N = h.normalized();
            const Vec3 T = N.cross(R);
            return R * c.p[0] + T * c.p[1] + N * c.p[2];
        }
        case ContributionKind::ZonalHarmonic:
            return ZonalHarmonic(position, c.p[0], c.p[1],
                                 static_cast<int>(c.p[2]), c.p[3]);
        case ContributionKind::PointMassAt: {
            const Vec3 body(c.p[1], c.p[2], c.p[3]);
            const Vec3 d = position - body;
            const double dm = d.magnitude();
            if (dm <= 0.0) return Vec3();
            return d * (-c.p[0] / (dm * dm * dm));
        }
        case ContributionKind::None:
        default:
            return Vec3();
    }
}

Vec3 EvaluateContributions(const ContributionSet& set,
                           const Vec3& position, const Vec3& velocity) {
    Vec3 sum;
    const int n = std::min(set.count, ContributionSet::MAX_SLOTS);
    for (int i = 0; i < n; i++) {
        sum += EvaluateContribution(set.slots[i], position, velocity);
    }
    return sum;
}

void GcrfToEarthFixed(double jd, double m[3][3]) {
    // Precession and nutation move < 0.01 arcsec in an hour; the rotation
    // angle is evaluated at every call.
    static double cachedTt = -1e300, eqeq = 0;
    static coords::Matrix3x3 np;
    const double jdTt = timesys::tdbToTt(jd);
    if (std::abs(jdTt - cachedTt) > 1.0 / 24.0) {
        cachedTt = jdTt;
        np = coords::nutationMatrix(jdTt) * coords::precession(jdTt);  // GCRF -> MOD -> TOD
        eqeq = coords::equationOfEquinoxes(jdTt);
    }
    const double jdUt = timesys::taiToUtc(timesys::ttToTai(jdTt));
    const coords::Matrix3x3 r = coords::Matrix3x3::rotateZ(coords::gmst(jdUt) + eqeq) * np;
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) m[i][j] = r.at(i, j);
}

void GcrfToEarthFixed(double jd, const ForceModelSet& forceSet, double m[3][3]) {
    if (forceSet.earthFixedRotation) forceSet.earthFixedRotation(jd, m);
    else GcrfToEarthFixed(jd, m);
}

bool EarthFixedField(const ForceModelSet& forceSet) {
    switch (forceSet.gravityMode) {
        case GravityMode::Infer:
            return (forceSet.useLoadedField && forceSet.loadedField) || forceSet.useEGM2008 || forceSet.useSphericalHarmonics;
        case GravityMode::SphericalHarmonics:
        case GravityMode::EGM2008:
        case GravityMode::LoadedField:
            return true;
        default:
            return false;  // the point mass, and the J2 / J2-J4 closed forms about inertial z
    }
}

Vec3 CentralBodyGravity(const Vec3& position, double jd, const ForceModelSet& forceSet) {
    if (!EarthFixedField(forceSet)) return EarthFixedGravity(position, forceSet);
    double m[3][3];
    GcrfToEarthFixed(jd, forceSet, m);
    const Vec3 fixed(m[0][0] * position.x + m[0][1] * position.y + m[0][2] * position.z,
                     m[1][0] * position.x + m[1][1] * position.y + m[1][2] * position.z,
                     m[2][0] * position.x + m[2][1] * position.y + m[2][2] * position.z);
    const Vec3 a = EarthFixedGravity(fixed, forceSet);
    return Vec3(m[0][0] * a.x + m[1][0] * a.y + m[2][0] * a.z,
                m[0][1] * a.x + m[1][1] * a.y + m[2][1] * a.z,
                m[0][2] * a.x + m[1][2] * a.y + m[2][2] * a.z);
}

Vec3 EarthFixedGravity(const Vec3& position, const ForceModelSet& forceSet) {
    // A stated mode wins outright. `Infer` reproduces the pre-gmat-07
    // precedence exactly, so existing callers are unmoved.
    GravityMode mode = forceSet.gravityMode;
    if (mode == GravityMode::Infer) {
        if (forceSet.useLoadedField && forceSet.loadedField) mode = GravityMode::LoadedField;
        else if (forceSet.useEGM2008) mode = GravityMode::EGM2008;
        else if (forceSet.useSphericalHarmonics) mode = GravityMode::SphericalHarmonics;
        else if (forceSet.usePointMass) mode = GravityMode::PointMass;
        else return Vec3();
    }

    switch (mode) {
        case GravityMode::PointMass:
            return PointMass(position, forceSet.mu);

        // J2Only() and J2J4() return the PERTURBING acceleration only — the
        // central term is excluded (see their definitions above) — so the
        // point mass is added explicitly. These are the closed forms
        // tests/zonal_crossvalidation.cpp validates against an independent
        // Legendre recursion to 1.4e-15; before gmat-07 nothing outside that
        // harness could reach them.
        case GravityMode::J2Only:
            return PointMass(position, forceSet.mu) +
                   J2Only(position, forceSet.mu, J2_EARTH, RE_EARTH);
        case GravityMode::J2J4:
            return PointMass(position, forceSet.mu) + J2J4(position, forceSet.mu);

        // The central term with the force set's GM, the harmonics with the
        // field's own (EGM2008's TT-compatible 398600.4415 km^3/s^2), as
        // Orekit separates NewtonianAttraction from HolmesFeatherstone.
        case GravityMode::EGM2008:
            return PointMass(position, forceSet.mu) + EGM2008Harmonics(position, forceSet.egm2008);
        case GravityMode::LoadedField:
            if (forceSet.loadedField) return LoadedFieldGravity(position, *forceSet.loadedField);
            return PointMass(position, forceSet.mu);
        case GravityMode::SphericalHarmonics:
        default:
            return SphericalHarmonics(position, forceSet.sphericalHarmonics);
    }
}

Vec3 DragAccelerationWith(const Vec3& position, const Vec3& velocity, double jd,
                          const ForceModelSet& forceSet, const DragForceConfig& drag) {
    Vec3 totalAcc;
    const double atmosphereJD = forceSet.explicitEpochContract
        ? timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(jd))) : jd;
    // The field's Earth-fixed axes, so density, co-rotation and gravity
    // share one Earth orientation; the weather of this instant.
    const EarthAxes axes = EarthAxesAt(jd, forceSet);
    const SpaceWeatherData weather = WeatherAt(atmosphereJD, forceSet);
    switch (forceSet.dragModel) {
        case DragModelType::NRLMSISE00:
            totalAcc += NRLMSISE00(position, velocity, atmosphereJD, weather,
                                   drag, forceSet.nrlmsise00, &axes);
            break;
        case DragModelType::HarrisPriester:
            totalAcc += HarrisPriester(position, velocity, jd, drag,
                                       forceSet.harrisPriesterExponent, &weather,
                                       atmosphereJD, &axes);
            break;
        case DragModelType::USSA1976:
            totalAcc += AtmosphericDrag(position, velocity, atmosphereJD,
                                        weather, drag, &axes);
            break;
        case DragModelType::JB2008:
        case DragModelType::JacchiaRoberts: {
            // JB2008 (lib/jb2008.h) and Jacchia-Roberts (lib/jacchia_roberts.h).
            const double rho = forceSet.dragModel == DragModelType::JB2008
                ? JB2008DensityAt(position, jd, atmosphereJD, axes, weather)
                : JacchiaRobertsDensityAt(position, jd, atmosphereJD, axes, weather);
            totalAcc += DragFromDensity(rho, position, velocity, atmosphereJD, axes, drag, weather);
            break;
        }
        case DragModelType::DTM2020:
            totalAcc += DTM2020(position, velocity, atmosphereJD, weather,
                                drag, forceSet.dtm2020, &axes);
            break;
        case DragModelType::Exponential:
            totalAcc += AtmosphericDragExponential(position, velocity,
                                                   drag.mass, drag.area, drag.Cd);
            break;
    }
    return totalAcc;
}

double JacchiaRobertsDensityAt(const Vec3& position, double jdTdb, double jdUtc,
                          const EarthAxes& axes, const SpaceWeatherData& weather) {
    double lat = 0, lon = 0, alt = 0;
    const Vec3 fixed = axes.fixed(position);
    ecefToGeodetic(fixed, lat, lon, alt);
    const EphemerisState sun = getSunPosition(jdTdb);
    if (!sun.valid) return 0.0;
    const Vec3 s = axes.fixed(sun.position);
    const double point[3] = {fixed.x, fixed.y, fixed.z}, sunv[3] = {s.x, s.y, s.z};
    const double polarRadius = RE_EARTH * (1.0 - 1.0 / 298.257223563);  // WGS84
    const jacchia_roberts::Inputs in{weather.F107,
        weather.f107aPreviousDay >= 0 ? weather.f107aPreviousDay : weather.F107a,
        weather.kpLag67h >= 0 ? weather.kpLag67h : weather.Kp};
    const double rho = jacchia_roberts::density(alt, lat, point, sunv, jdUtc - 2400000.5, polarRadius, in);
    return rho > 0 ? rho : 0.0;
}

Vec3 SrpAcceleration(const Vec3& position, const Vec3& velocity, double jd, const ForceModelSet& forceSet,
                     const SRPForceConfig& srp) {
    const Vec3 sunPos = forceSet.sunPositionProvided ? forceSet.sunPosition : getSunPosition(jd).position;
    return SolarRadiation(position, velocity, sunPos, srp);
}

Vec3 ComputeTotalAcceleration(const Vec3& position, const Vec3& velocity, double jd,
                              ForceModelSet& forceSet) {
    Vec3 totalAcc;

    // Get Sun position if needed and not provided
    Vec3 sunPos;
    if (forceSet.useSRP || forceSet.useEarthRadiation || forceSet.useThermalReradiation) {
        if (forceSet.sunPositionProvided) {
            sunPos = forceSet.sunPosition;
        } else {
            EphemerisState sun = getSunPosition(jd);
            sunPos = sun.position;
            forceSet.sunPosition = sunPos;
        }
    }

    // Central-body gravity: exactly one model answers, and which one is the
    // caller's stated choice whenever it made one.
    totalAcc += CentralBodyGravity(position, jd, forceSet);

    // Lunar gravity (separate body, doesn't include Earth point mass)
    if (forceSet.useGRGM1200A) {
        totalAcc += GRGM1200A(position, forceSet.grgm1200a);
    }

    // 5. Third Body
    if (forceSet.useThirdBody) {
        totalAcc += ThirdBody(position, jd, forceSet.thirdBody);
    }

    // 6. Solar Radiation Pressure
    if (forceSet.useSRP) {
        totalAcc += SolarRadiation(position, velocity, sunPos, forceSet.srp);
    }

    // 7-10. Atmospheric Drag
    //
    // Every enumerator has a case. `USSA1976` and `HarrisPriester` had none
    // and fell through `default:` to the exponential model, so two of the six
    // drag settings answered with a model the caller did not ask for. The
    // plugin ABI additionally REFUSES the labels that no published
    // implementation stands behind, so JB2008 and DTM2020 are unreachable from
    // there; the two cases below remain for direct C++ callers, and the
    // functions they reach carry their own "simplified stand-in, not the
    // published model" banner at their definitions.
    if (forceSet.useDrag) {
        totalAcc += DragAccelerationWith(position, velocity, jd, forceSet, DragAt(jd, forceSet));
    }

    // 11. Relativistic Correction
    if (forceSet.useRelativisticCorrection) {
        // The Lense-Thirring spin axis is the field's Earth-fixed z axis.
        const EarthAxes axes = EarthAxesAt(jd, forceSet);
        totalAcc += RelativisticCorrection(position, velocity, jd, forceSet.mu,
                                           forceSet.relativistic, &axes);
    }

    // 12. Earth radiation pressure (albedo and infrared)
    if (forceSet.useEarthRadiation) {
        EarthRadiationConfig config = forceSet.earthRadiation;
        config.crAreaOverMass = EarthRadiationCoefficient(forceSet);
        totalAcc += EarthRadiation(position, sunPos, jd, config);
    }

    // 13. Thermal Reradiation
    if (forceSet.useThermalReradiation) {
        totalAcc += ThermalReradiation(position, sunPos, forceSet.thermal);
    }

    // 14. Solid Tides
    if (forceSet.useSolidTides) {
        totalAcc += SolidTideAcceleration(position, jd, forceSet);
    }

    // 15. Ocean Tides
    if (forceSet.useOceanTides) {
        totalAcc += OceanTideAcceleration(position, jd, forceSet);
    }

    // 16. Pole Tide
    if (forceSet.usePoleTide) {
        totalAcc += PoleTide(position, forceSet.poleTide);
    }

    // 19. Empirical Accelerations
    if (forceSet.useEmpiricalAccel) {
        totalAcc += EmpiricalAcceleration(position, velocity, forceSet.empiricalAccel);
    }

    // 16b. Registered third-party contributions, in the same integration as
    // everything above — not a post-hoc correction applied to the answer.
    if (forceSet.useContributions) {
        totalAcc += EvaluateContributions(forceSet.contributions, position, velocity);
    }

    // 17. Finite Maneuver
    if (forceSet.hasFiniteManeuver) {
        totalAcc += FiniteManeuver(position, velocity, jd, forceSet.finiteManeuver);
    }

    return totalAcc;
}

void ForceModelDerivative(double t, const double* y, double* dydt, void* params) {
    ForceModelSet* forceSet = static_cast<ForceModelSet*>(params);

    Vec3 position(y[0], y[1], y[2]);
    Vec3 velocity(y[3], y[4], y[5]);

    // Convert time offset to JD
    double jd = (forceSet->explicitEpochContract ? forceSet->integrationEpochTDB : forceSet->weather.epoch) + t / 86400.0;

    Vec3 acc = ComputeTotalAcceleration(position, velocity, jd, *forceSet);

    // Derivatives: [vx, vy, vz, ax, ay, az]
    dydt[0] = velocity.x;
    dydt[1] = velocity.y;
    dydt[2] = velocity.z;
    dydt[3] = acc.x;
    dydt[4] = acc.y;
    dydt[5] = acc.z;
}

// =============================================================================
// Preset Force Model Configurations
// =============================================================================

ForceModelSet CreateLEOForceModel(double mass, double area) {
    ForceModelSet fs;

    fs.usePointMass = true;
    fs.mu = MU_EARTH;

    fs.useSphericalHarmonics = true;
    fs.sphericalHarmonics.maxDegree = 20;
    fs.sphericalHarmonics.maxOrder = 20;

    fs.useThirdBody = true;
    fs.thirdBody.includeSun = true;
    fs.thirdBody.includeMoon = true;

    fs.useSRP = true;
    fs.srp.mass = mass;
    fs.srp.area = area;
    fs.srp.Cr = 1.5;

    fs.useDrag = true;
    fs.dragModel = DragModelType::NRLMSISE00;
    fs.drag.mass = mass;
    fs.drag.area = area;
    fs.drag.Cd = 2.2;
    fs.drag.minAltitude = 100.0;
    fs.drag.maxAltitude = 1000.0;

    return fs;
}

ForceModelSet CreateGEOForceModel(double mass, double area) {
    ForceModelSet fs;

    fs.usePointMass = true;
    fs.mu = MU_EARTH;

    fs.useSphericalHarmonics = true;
    fs.sphericalHarmonics.maxDegree = 10;
    fs.sphericalHarmonics.maxOrder = 10;

    fs.useThirdBody = true;
    fs.thirdBody.includeSun = true;
    fs.thirdBody.includeMoon = true;

    fs.useSRP = true;
    fs.srp.mass = mass;
    fs.srp.area = area;
    fs.srp.Cr = 1.5;
    fs.srp.model = SRPModelType::BoxWing;  // More accurate for GEO

    fs.useDrag = false;  // No drag at GEO

    return fs;
}

ForceModelSet CreateCislunarForceModel(double mass, double area) {
    ForceModelSet fs;

    fs.usePointMass = true;
    fs.mu = MU_EARTH;

    fs.useSphericalHarmonics = true;
    fs.sphericalHarmonics.maxDegree = 8;
    fs.sphericalHarmonics.maxOrder = 8;

    fs.useThirdBody = true;
    fs.thirdBody.includeSun = true;
    fs.thirdBody.includeMoon = true;
    fs.thirdBody.includeVenus = true;
    fs.thirdBody.includeJupiter = true;

    fs.useSRP = true;
    fs.srp.mass = mass;
    fs.srp.area = area;
    fs.srp.Cr = 1.5;

    fs.useDrag = false;

    fs.useRelativisticCorrection = true;
    fs.relativistic.schwarzschild = true;

    return fs;
}

ForceModelSet CreateHighFidelityForceModel(double mass, double area) {
    ForceModelSet fs;

    fs.usePointMass = true;
    fs.mu = MU_EARTH;

    fs.useEGM2008 = true;
    fs.egm2008.truncationDegree = 70;
    fs.egm2008.truncationOrder = 70;

    fs.useThirdBody = true;
    fs.thirdBody.includeSun = true;
    fs.thirdBody.includeMoon = true;
    fs.thirdBody.includeVenus = true;
    fs.thirdBody.includeMars = true;
    fs.thirdBody.includeJupiter = true;
    fs.thirdBody.includeSaturn = true;
    fs.thirdBody.includeMercury = true;
    fs.thirdBody.includeUranus = true;
    fs.thirdBody.includeNeptune = true;

    fs.useSRP = true;
    fs.srp.mass = mass;
    fs.srp.area = area;
    fs.srp.Cr = 1.5;
    fs.srp.model = SRPModelType::BoxWing;

    fs.useDrag = true;
    fs.dragModel = DragModelType::JB2008;
    fs.drag.mass = mass;
    fs.drag.area = area;
    fs.drag.Cd = 2.2;

    fs.useRelativisticCorrection = true;
    fs.relativistic.schwarzschild = true;
    fs.relativistic.lenseThirring = true;
    fs.relativistic.deSitter = true;

    fs.useEarthRadiation = true;
    fs.earthRadiation.sharesSrpCoefficient = true;

    fs.useSolidTides = true;
    fs.solidTides.includeSunTide = true;
    fs.solidTides.includeMoonTide = true;
    fs.solidTides.frequencyDependent = true;

    fs.useOceanTides = true;

    fs.usePoleTide = true;

    return fs;
}

} // namespace ForceModel
} // namespace astro
