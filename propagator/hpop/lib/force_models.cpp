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
#include <cmath>
#include <algorithm>
#include <stdexcept>

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

/// Earth's angular momentum factor for Lense-Thirring (G*J/c^2 in km^3/s)
/// J_earth = 5.86e33 kg*m^2/s = 5.86e27 kg*km^2/s
/// G = 6.674e-11 m^3/(kg*s^2) = 6.674e-20 km^3/(kg*s^2)
/// c^2 = (2.998e5 km/s)^2 = 8.99e10 km^2/s^2
/// G*J/c^2 = 6.674e-20 * 5.86e27 / 8.99e10 = 4.35e-3 km^3/s
constexpr double EARTH_GJ_C2 = 4.35e-3;  // km^3/s (G*J/c^2 for Earth)

Vec3 atmosphereCoRotationVelocity(const Vec3& position, bool coRotatingAtmosphere) {
    if (!coRotatingAtmosphere) {
        return Vec3();
    }
    return Vec3(-OMEGA_EARTH * position.y, OMEGA_EARTH * position.x, 0.0);
}


// The force set integrates GCRF, while the geodetic density models
// (computeNRLMSISE00, computeJB2008, computeDTM2020 and computeDragAcceleration)
// take an Earth-fixed position (astrodynamics.h). Rotating about the GCRF z
// axis by GMST supplies the Earth-fixed longitude that sets local solar time
// and the longitude terms. Precession, nutation and polar motion are not
// applied: together they tilt the pole by well under a degree since J2000,
// below the horizontal resolution of these empirical models, and the
// co-rotation term below already uses the same axis. UT1-UTC (< 0.9 s) is
// likewise negligible here.
} // anonymous namespace

Vec3 EarthFixedForDensity(const Vec3& gcrf, double jdUt) {
    const double theta = timesys::ut1ToGmst(jdUt);
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    return Vec3(c * gcrf.x + s * gcrf.y, -s * gcrf.x + c * gcrf.y, gcrf.z);
}

namespace {
Vec3 GcrfFromEarthFixed(const Vec3& earthFixed, double jdUt) {
    const double theta = timesys::ut1ToGmst(jdUt);
    const double c = std::cos(theta);
    const double s = std::sin(theta);
    return Vec3(c * earthFixed.x - s * earthFixed.y, s * earthFixed.x + c * earthFixed.y, earthFixed.z);
}

// Velocity of the air relative to GCRF: co-rotation plus, when requested, the
// HWM14 horizontal wind, evaluated in the same Earth-fixed axes as the density
// and rotated back. Winds without weather are refused (Harris-Priester and the
// exponential helper carry none).
Vec3 relativeAtmosphereVelocity(const Vec3& position, const Vec3& velocity, double jd,
                                bool coRotatingAtmosphere, bool includeWinds,
                                const SpaceWeatherData* weather = nullptr, bool windDisturbance = true) {
    Vec3 vAtm = atmosphereCoRotationVelocity(position, coRotatingAtmosphere);
    if (includeWinds) {
        if (weather == nullptr) {
            throw std::invalid_argument("includeWinds: this drag model has no space-weather input for HWM14");
        }
        vAtm += GcrfFromEarthFixed(
            HorizontalWindEarthFixed(EarthFixedForDensity(position, jd), jd, *weather, windDisturbance), jd);
    }
    return velocity - vAtm;
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

Vec3 EGM2008(const Vec3& position, const EGM2008ForceConfig& config) {
    // Use extended gravity field with embedded EGM2008 coefficients (degree 2-70)
    static ExtendedGravityField field;
    static uint16_t cachedDegree = 0;
    static uint16_t cachedOrder = 0;

    // Re-initialize only if degree/order changed
    if (cachedDegree != config.truncationDegree || cachedOrder != config.truncationOrder) {
        EGM2008Config extConfig;
        extConfig.maxDegree = config.truncationDegree;
        extConfig.maxOrder = config.truncationOrder;
        field = initEGM2008Extended(extConfig);
        cachedDegree = config.truncationDegree;
        cachedOrder = config.truncationOrder;
    }

    GravityAcceleration result = computeExtendedGravity(position, field);
    return result.total;
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

Vec3 SolarRadiation(const Vec3& satPosition, const Vec3& sunPosition,
                    const SRPForceConfig& config) {
    if (config.model == SRPModelType::Cannonball) {
        double shadowFactor;
        return SolarRadiationCannonball(satPosition, sunPosition,
                                        config.mass, config.area, config.Cr, shadowFactor);
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
    Vec3 vRel = relativeAtmosphereVelocity(position, velocity, 0.0, true, false);
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
    }
    return AtmosphereModelType::NRLMSISE00;
}

Vec3 HarrisPriester(const Vec3& position, const Vec3& velocity, double jd,
                    const DragForceConfig& dragConfig, double bulgeExponent,
                    const SpaceWeatherData* weather, double windJdUtc) {
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
    Vec3 vRel = relativeAtmosphereVelocity(position, velocity, windJdUtc > 0.0 ? windJdUtc : jd,
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
                     const SpaceWeatherData& weather, const DragForceConfig& config) {
    double alt = position.magnitude() - RE_EARTH;

    if (alt < config.minAltitude || alt > config.maxAltitude) {
        return Vec3();
    }

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
    DragAccelerationResult result = computeDragAcceleration(
        EarthFixedForDensity(position, jd), EarthFixedForDensity(velocity, jd), jd,
        dragCfg, weather);
    return GcrfFromEarthFixed(result.total, jd);
}

// =============================================================================
// 8. NRLMSISE-00 - Full Atmospheric Model
// =============================================================================

Vec3 NRLMSISE00(const Vec3& position, const Vec3& velocity, double jd,
                const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
                const NRLMSISE00Config& nrlmsiseConfig) {
    AtmosphereConfig atmConfig;
    atmConfig.model = AtmosphereModelType::NRLMSISE00;
    atmConfig.includeWinds = dragConfig.includeWinds;
    atmConfig.coRotatingAtmosphere = dragConfig.coRotatingAtmosphere;
    atmConfig.diurnalVariation = nrlmsiseConfig.diurnalVariation;
    atmConfig.geomagneticEffects = nrlmsiseConfig.geomagneticActivity;
    atmConfig.minAltitude = dragConfig.minAltitude;
    atmConfig.maxAltitude = dragConfig.maxAltitude;

    AtmosphericDensity density =
        computeNRLMSISE00(EarthFixedForDensity(position, jd), jd, weather, atmConfig);

    if (density.density < 1e-20) {
        return Vec3();
    }

    // Compute drag in atmosphere-relative velocity convention.
    Vec3 vRel = relativeAtmosphereVelocity(
        position,
        velocity,
        jd,
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

Vec3 JB2008(const Vec3& position, const Vec3& velocity, double jd,
            const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
            const JB2008Config& jb2008Config) {
    AtmosphericDensity density = computeJB2008(EarthFixedForDensity(position, jd), jd, weather);

    if (density.density < 1e-20) {
        return Vec3();
    }

    Vec3 vRel = relativeAtmosphereVelocity(
        position,
        velocity,
        jd,
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

AtmosphericDensity JB2008Density(const Vec3& position, double jd,
                                 const SpaceWeatherData& weather,
                                 const JB2008Config& config) {
    return computeJB2008(EarthFixedForDensity(position, jd), jd, weather);
}

// =============================================================================
// 10. DTM2020 - Drag Temperature Model 2020
// =============================================================================

Vec3 DTM2020(const Vec3& position, const Vec3& velocity, double jd,
             const SpaceWeatherData& weather, const DragForceConfig& dragConfig,
             const DTM2020Config& dtmConfig) {
    AtmosphericDensity density = computeDTM2020(EarthFixedForDensity(position, jd), jd, weather);

    if (density.density < 1e-20) {
        return Vec3();
    }

    Vec3 vRel = relativeAtmosphereVelocity(
        position,
        velocity,
        jd,
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
                            double mu, const RelativisticConfig& config) {
    Vec3 totalAcc;

    double c2 = config.c * config.c;

    if (config.schwarzschild) {
        totalAcc += SchwarzschildCorrection(position, velocity, mu);
    }

    if (config.lenseThirring) {
        // Lense-Thirring (frame dragging) effect
        // IERS Conventions 2010, Eq. 10.12 second term
        // a_LT = (2*G*J/(c^2*r^3)) * [3/r^2 * (r × v)(r · Ŝ) + (v × Ŝ)]
        double r = position.magnitude();
        double r2 = r * r;
        double r3 = r2 * r;

        // Earth's spin axis (along z in J2000/GCRF)
        Vec3 spinAxis(0, 0, 1);

        double rDotSpin = position.dot(spinAxis);
        Vec3 rCrossV = position.cross(velocity);
        Vec3 vCrossSpin = velocity.cross(spinAxis);

        double factor = 2.0 * EARTH_GJ_C2 / r3;
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
                totalAcc += vE_cross_aE.cross(velocity) * (-3.0 / (2.0 * c2));
            }
        }
    }

    return totalAcc;
}

// =============================================================================
// 12. Earth Albedo - Earth Radiation Pressure
// =============================================================================

Vec3 EarthAlbedo(const Vec3& satPosition, const Vec3& sunPosition,
                 const EarthAlbedoConfig& config) {
    // Knocke, Ries, Tapley (1988) Earth radiation pressure model
    // Discretizes visible Earth surface into lat/lon grid cells,
    // computing reflected sunlight (albedo) and thermal IR per cell.

    double r = satPosition.magnitude();
    double alt = r - RE_EARTH;
    if (alt < 100.0 || alt > 100000.0) return Vec3();

    Vec3 satDir = satPosition.normalized();
    Vec3 sunDir = sunPosition.normalized();

    // Satellite nadir angle limit (max angle from sub-satellite point that is visible)
    double sinRho = RE_EARTH / r;
    double cosRho = std::sqrt(1.0 - sinRho * sinRho);

    // Grid parameters
    int nLat = std::max(4, std::min(static_cast<int>(config.gridResolution), 72));
    int nLon = 2 * nLat;
    double dLat = M_PI / nLat;
    double dLon = 2.0 * M_PI / nLon;

    // Area-to-mass ratio in km^2/kg
    double AmRatio = config.area / config.mass * 1e-6;
    double c_inv = 1.0 / (SPEED_OF_LIGHT * 1000.0); // 1/(m/s -> km/s)

    // Stefan-Boltzmann for IR: Earth equilibrium temperature ~255K
    // Total IR power = σT⁴ = ~240 W/m². We use emissivity model directly.
    // IR flux from a cell = ε(ϕ) · σT⁴_earth, where σT⁴ ≈ 240 W/m²
    static constexpr double EARTH_IR_TOTAL = 240.0; // W/m² average

    Vec3 totalAcc;

    for (int iLat = 0; iLat < nLat; iLat++) {
        double lat = -M_PI / 2.0 + (iLat + 0.5) * dLat;
        double cosLat = std::cos(lat);
        double sinLat = std::sin(lat);
        double sin2Lat = sinLat * sinLat;

        // Knocke latitude-dependent albedo and emissivity
        double albedo = config.a0 + config.a1 * sin2Lat;
        double emissivity = config.e0 + config.e1 * sin2Lat;

        // Cell area on unit sphere = cos(lat) * dLat * dLon
        double cellArea = cosLat * dLat * dLon; // steradians
        // Actual area on Earth surface (km^2)
        double cellAreaKm2 = RE_EARTH * RE_EARTH * cellArea;

        for (int iLon = 0; iLon < nLon; iLon++) {
            double lon = (iLon + 0.5) * dLon;

            // Cell center position on Earth surface (unit sphere)
            Vec3 cellNormal;
            cellNormal.x = cosLat * std::cos(lon);
            cellNormal.y = cosLat * std::sin(lon);
            cellNormal.z = sinLat;

            // Check visibility from satellite: cell normal · satellite direction > cos(rho)
            double cosAngle = cellNormal.dot(satDir);
            if (cosAngle < cosRho) continue; // cell not visible from satellite

            // Vector from cell to satellite
            Vec3 cellPos = cellNormal * RE_EARTH;
            Vec3 cellToSat = satPosition - cellPos;
            double dist = cellToSat.magnitude();
            Vec3 cellToSatDir = cellToSat * (1.0 / dist);

            // Cosine of emission angle (cell normal vs direction to satellite)
            double cosEmit = cellNormal.dot(cellToSatDir);
            if (cosEmit <= 0.0) continue;

            // --- Albedo (reflected sunlight) ---
            // Cell is illuminated if Sun is above local horizon
            double cosSunCell = cellNormal.dot(sunDir);
            double albedoFlux = 0.0;
            if (cosSunCell > 0.0) {
                // Reflected flux = (solar flux) × albedo × cos(sun zenith) × Lambertian
                // Lambertian: reflected intensity ∝ cos(emission angle) / π
                albedoFlux = config.solarFlux * albedo * cosSunCell * cosEmit / M_PI;
            }

            // --- Thermal IR ---
            // All cells emit IR regardless of illumination (Lambertian)
            double irFlux = EARTH_IR_TOTAL * emissivity * cosEmit / M_PI;

            // Total flux from this cell at satellite distance
            // dF = flux × (cell area) / distance² [W/m²]
            double dFlux = (albedoFlux + irFlux) * cellAreaKm2 / (dist * dist);

            // Radiation pressure acceleration from this cell
            // Direction: cell-to-satellite (away from cell)
            double dAccMag = dFlux * c_inv * config.Cr * AmRatio;
            totalAcc += cellToSatDir * dAccMag;
        }
    }

    return totalAcc;
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

/// Compute solid tide contribution from a single body (IERS 2010 Eq. 6.6)
/// Uses degree-2 and degree-3 Love numbers to compute ΔCnm/ΔSnm
/// then converts to acceleration perturbation on the satellite.
static Vec3 solidTideSingleBody(const Vec3& satPosition, const Vec3& bodyPosition,
                                 double muBody, double k20, double k21, double k22, double k30) {
    Vec3 totalAcc;
    double r = satPosition.magnitude();
    double rBody = bodyPosition.magnitude();
    if (r < RE_EARTH || rBody < 1.0) return Vec3();

    double Re = RE_EARTH;
    double Re2 = Re * Re;
    double r2 = r * r;
    double r3 = r2 * r;
    double rBody2 = rBody * rBody;
    double rBody3 = rBody2 * rBody;

    // Unit vectors
    Vec3 rHat = satPosition.normalized();
    Vec3 rBodyHat = bodyPosition.normalized();

    // Geocentric latitude and longitude of satellite
    double sinLatSat = satPosition.z / r;
    double cosLatSat = std::sqrt(satPosition.x * satPosition.x + satPosition.y * satPosition.y) / r;
    double lonSat = std::atan2(satPosition.y, satPosition.x);

    // Geocentric latitude and longitude of perturbing body
    double sinLatBody = bodyPosition.z / rBody;
    double cosLatBody = std::sqrt(bodyPosition.x * bodyPosition.x + bodyPosition.y * bodyPosition.y) / rBody;
    double lonBody = std::atan2(bodyPosition.y, bodyPosition.x);

    // Degree-2 solid tide: ΔC₂ₘ and ΔS₂ₘ from IERS 2010 Eq. 6.6
    // The effect on potential coefficients is:
    // ΔC₂ₘ - iΔS₂ₘ = k₂ₘ/(2n+1) * (μⱼ/μ_E) * (Re/rⱼ)³ * P₂ₘ(sinφⱼ) * e^(-imλⱼ)

    double bodyRatio3 = muBody / MU_EARTH * std::pow(Re / rBody, 3);

    // m=0: ΔC₂₀ = k₂₀/5 * (μⱼ/μ_E)(Re/rⱼ)³ * P₂₀(sinφⱼ)
    double P20_body = 0.5 * (3.0 * sinLatBody * sinLatBody - 1.0);
    double dC20 = k20 / 5.0 * bodyRatio3 * P20_body;

    // m=1: ΔC₂₁ = k₂₁/5 * (μⱼ/μ_E)(Re/rⱼ)³ * P₂₁(sinφⱼ) * cos(λⱼ)
    //       ΔS₂₁ = k₂₁/5 * (μⱼ/μ_E)(Re/rⱼ)³ * P₂₁(sinφⱼ) * sin(λⱼ)
    double P21_body = 3.0 * sinLatBody * cosLatBody;
    double dC21 = k21 / 5.0 * bodyRatio3 * P21_body * std::cos(lonBody);
    double dS21 = k21 / 5.0 * bodyRatio3 * P21_body * std::sin(lonBody);

    // m=2: ΔC₂₂ = k₂₂/5 * (μⱼ/μ_E)(Re/rⱼ)³ * P₂₂(sinφⱼ) * cos(2λⱼ)
    //       ΔS₂₂ = k₂₂/5 * (μⱼ/μ_E)(Re/rⱼ)³ * P₂₂(sinφⱼ) * sin(2λⱼ)
    double P22_body = 3.0 * cosLatBody * cosLatBody;
    double dC22 = k22 / 5.0 * bodyRatio3 * P22_body * std::cos(2.0 * lonBody);
    double dS22 = k22 / 5.0 * bodyRatio3 * P22_body * std::sin(2.0 * lonBody);

    // Degree-3 solid tide: ΔC₃₀
    double bodyRatio4 = muBody / MU_EARTH * std::pow(Re / rBody, 4);
    double P30_body = 0.5 * sinLatBody * (5.0 * sinLatBody * sinLatBody - 3.0);
    double dC30 = k30 / 7.0 * bodyRatio4 * P30_body;

    // Convert ΔCnm/ΔSnm to acceleration perturbation on satellite
    // Using gradient of the disturbing potential R = μ/r Σ(Re/r)^n Σ(ΔCnm cos(mλ) + ΔSnm sin(mλ)) Pnm(sinφ)
    // Radial: dR/dr, Latitude: (1/r)dR/dφ, Longitude: (1/r cosφ)dR/dλ

    double Re_r = Re / r;
    double Re_r2 = Re_r * Re_r;
    double Re_r3 = Re_r2 * Re_r;
    double mu_r2 = MU_EARTH / r2;

    // --- Degree 2 contributions ---
    // P20, P21, P22 at satellite position
    double P20_sat = 0.5 * (3.0 * sinLatSat * sinLatSat - 1.0);
    double P21_sat = 3.0 * sinLatSat * cosLatSat;
    double P22_sat = 3.0 * cosLatSat * cosLatSat;

    // dP20/dφ = -3 sinφ cosφ, dP21/dφ = 3(cos²φ - sin²φ), dP22/dφ = -6 sinφ cosφ
    double dP20_dphi = -3.0 * sinLatSat * cosLatSat;
    double dP21_dphi = 3.0 * (cosLatSat * cosLatSat - sinLatSat * sinLatSat);
    double dP22_dphi = -6.0 * sinLatSat * cosLatSat;

    double cosLon = std::cos(lonSat);
    double sinLon = std::sin(lonSat);
    double cos2Lon = std::cos(2.0 * lonSat);
    double sin2Lon = std::sin(2.0 * lonSat);

    // Radial acceleration: ar = -μ/r² Σ (n+1)(Re/r)^n [ΔCnm cos(mλ) + ΔSnm sin(mλ)] Pnm
    double ar = -mu_r2 * Re_r2 * 3.0 * (
        dC20 * P20_sat +
        (dC21 * cosLon + dS21 * sinLon) * P21_sat +
        (dC22 * cos2Lon + dS22 * sin2Lon) * P22_sat
    );
    // Degree-3 radial: evaluate P₃₀ at satellite position, not at body
    double P30_sat = 0.5 * sinLatSat * (5.0 * sinLatSat * sinLatSat - 3.0);
    ar -= mu_r2 * Re_r3 * 4.0 * dC30 * P30_sat;

    // Latitude acceleration: aφ = μ/r² (Re/r)^n [ΔCnm cos(mλ) + ΔSnm sin(mλ)] dPnm/dφ
    double aphi = mu_r2 * Re_r2 * (
        dC20 * dP20_dphi +
        (dC21 * cosLon + dS21 * sinLon) * dP21_dphi +
        (dC22 * cos2Lon + dS22 * sin2Lon) * dP22_dphi
    );

    // Longitude acceleration: aλ = μ/(r² cosφ) (Re/r)^n m [-ΔCnm sin(mλ) + ΔSnm cos(mλ)] Pnm
    double safe_cosLat = std::max(cosLatSat, 1e-10);
    double alon = mu_r2 / safe_cosLat * Re_r2 * (
        1.0 * (-dC21 * sinLon + dS21 * cosLon) * P21_sat +
        2.0 * (-dC22 * sin2Lon + dS22 * cos2Lon) * P22_sat
    );

    // Convert spherical to Cartesian acceleration
    double cosLat = cosLatSat;
    double sinLat = sinLatSat;
    double cLon = cosLon;
    double sLon = sinLon;

    Vec3 rHatLocal(cosLat * cLon, cosLat * sLon, sinLat);
    Vec3 phiHat(-sinLat * cLon, -sinLat * sLon, cosLat);
    Vec3 lonHat(-sLon, cLon, 0.0);

    totalAcc = rHatLocal * ar + phiHat * aphi + lonHat * alon;

    return totalAcc;
}

Vec3 SolidTides(const Vec3& satPosition, double jd, const SolidTideConfig& config) {
    Vec3 totalAcc;

    double r = satPosition.magnitude();
    if (r < RE_EARTH) return Vec3();

    if (config.includeMoonTide) {
        EphemerisState moon = getMoonPosition(jd);
        if (moon.valid) {
            totalAcc += solidTideSingleBody(satPosition, moon.position,
                MU_MOON, config.k20, config.k21, config.k22, config.k30);
        }
    }

    if (config.includeSunTide) {
        EphemerisState sun = getSunPosition(jd);
        if (sun.valid) {
            totalAcc += solidTideSingleBody(satPosition, sun.position,
                MU_SUN, config.k20, config.k21, config.k22, config.k30);
        }
    }

    // Frequency-dependent corrections (Step 2 of IERS 2010)
    // K1 tide correction to C21/S21
    if (config.frequencyDependent) {
        // GMST approximation for K1 frequency argument
        double T = (jd - 2451545.0) / 36525.0;
        double gmst = 4.894961212823059 + 6.300388098984957 * (jd - 2451545.0);
        gmst = std::fmod(gmst, TWO_PI);
        if (gmst < 0) gmst += TWO_PI;

        // K1 correction amplitudes from IERS 2010 Table 6.5a
        // ΔC₂₁ = 470.9e-12 * sin(θ+π) - 30.2e-12 * cos(θ+π)
        // ΔS₂₁ = -470.9e-12 * cos(θ+π) - 30.2e-12 * sin(θ+π)
        double theta_pi = gmst + PI;
        double dC21_k1 = 470.9e-12 * std::sin(theta_pi) - 30.2e-12 * std::cos(theta_pi);
        double dS21_k1 = -470.9e-12 * std::cos(theta_pi) - 30.2e-12 * std::sin(theta_pi);

        // Convert to acceleration (same as degree-2 pattern above)
        double r2 = r * r;
        double Re_r = RE_EARTH / r;
        double Re_r2 = Re_r * Re_r;
        double mu_r2 = MU_EARTH / r2;

        double sinLatSat = satPosition.z / r;
        double cosLatSat = std::sqrt(satPosition.x * satPosition.x + satPosition.y * satPosition.y) / r;
        double lonSat = std::atan2(satPosition.y, satPosition.x);

        double P21_sat = 3.0 * sinLatSat * cosLatSat;
        double cosLon = std::cos(lonSat);
        double sinLon = std::sin(lonSat);

        double ar_k1 = -mu_r2 * Re_r2 * 3.0 *
            (dC21_k1 * cosLon + dS21_k1 * sinLon) * P21_sat;

        double dP21_dphi = 3.0 * (cosLatSat * cosLatSat - sinLatSat * sinLatSat);
        double aphi_k1 = mu_r2 * Re_r2 *
            (dC21_k1 * cosLon + dS21_k1 * sinLon) * dP21_dphi;

        double safe_cosLat = std::max(cosLatSat, 1e-10);
        double alon_k1 = mu_r2 / safe_cosLat * Re_r2 *
            (-dC21_k1 * sinLon + dS21_k1 * cosLon) * P21_sat;

        Vec3 rHat(cosLatSat * cosLon, cosLatSat * sinLon, sinLatSat);
        Vec3 phiHat(-sinLatSat * cosLon, -sinLatSat * sinLon, cosLatSat);
        Vec3 lonHat(-sinLon, cosLon, 0.0);

        totalAcc += rHat * ar_k1 + phiHat * aphi_k1 + lonHat * alon_k1;
    }

    return totalAcc;
}

// =============================================================================
// 15. Ocean Tides - Ocean Loading
// =============================================================================

/// Ocean tide constituent data: Doodson multipliers and FES2004 prograde/retrograde coefficients
/// Each constituent produces ΔCnm± and ΔSnm± that vary with Doodson arguments
struct OceanTideConstituent {
    const char* name;
    // Doodson multipliers [τ, s, h, p, N', p_s] (encoded as integers)
    int doodson[6];
    // Degree-2 amplitude coefficients (prograde C+, S+ and retrograde C-, S-) in 1e-12
    // For (n=2,m=0): only C20+, S20+
    // For (n=2,m=1): C21+, S21+, C21-, S21-
    // For (n=2,m=2): C22+, S22+, C22-, S22-
    double C20p, S20p;       // (2,0) prograde
    double C21p, S21p, C21m, S21m;  // (2,1) prograde/retrograde
    double C22p, S22p, C22m, S22m;  // (2,2) prograde/retrograde
};

/// Compute Doodson fundamental arguments from Julian date
/// Returns [τ, s, h, p, N', ps] in radians
static void computeDoodsonArguments(double jd, double args[6]) {
    double T = (jd - 2451545.0) / 36525.0;

    // Mean lunar longitude (s) - IERS 2010
    double s = 218.3164477 + 481267.88123421 * T
               - 0.0015786 * T * T + T * T * T / 538841.0;

    // Mean solar longitude (h)
    double h = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;

    // Mean lunar perigee (p)
    double p = 83.3532465 + 4069.0137287 * T
               - 0.0103200 * T * T - T * T * T / 80053.0;

    // Mean lunar node (N')
    double N = 125.04452 - 1934.13626 * T + 0.00207 * T * T;

    // Mean solar perigee (ps)
    double ps = 282.93735 + 1.71946 * T + 0.00046 * T * T;

    // GMST (τ = GMST + π - s)
    double gmst_deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
                      + 0.000387933 * T * T;

    double tau = gmst_deg + 180.0 - s;

    // Convert to radians and normalize
    args[0] = std::fmod(tau * DEG_TO_RAD, TWO_PI);
    args[1] = std::fmod(s * DEG_TO_RAD, TWO_PI);
    args[2] = std::fmod(h * DEG_TO_RAD, TWO_PI);
    args[3] = std::fmod(p * DEG_TO_RAD, TWO_PI);
    args[4] = std::fmod(N * DEG_TO_RAD, TWO_PI);
    args[5] = std::fmod(ps * DEG_TO_RAD, TWO_PI);
}

Vec3 OceanTides(const Vec3& satPosition, double jd, const OceanTideConfig& config) {
    // FES2004-based ocean tide model
    // Computes time-varying ΔCnm/ΔSnm from tidal constituents using Doodson arguments
    // Then converts to gravity acceleration perturbation

    Vec3 totalAcc;
    double r = satPosition.magnitude();
    if (r < RE_EARTH) return Vec3();

    // Compute Doodson fundamental arguments
    double doodArgs[6];
    computeDoodsonArguments(jd, doodArgs);

    // FES2004 ocean tide coefficients for degree 2 (in units of 1e-12)
    // Format: name, Doodson[6], C20p/S20p, C21p/S21p/C21m/S21m, C22p/S22p/C22m/S22m
    // These are representative amplitudes from FES2004 model
    // Doodson encoding: [τ, s, h, p, N', ps] multiplicative integers

    struct TideEntry {
        int doodson[6];     // Doodson multipliers
        double dC20, dC21, dS21, dC22, dS22;  // Amplitude (normalized, ×1e-12)
        bool enabled;
    };

    // Major tide constituents with their Doodson arguments and FES2004 C20 amplitudes
    TideEntry tides[] = {
        // M2: Principal lunar semidiurnal  τ=2 s=0 h=0 p=0 N'=0 ps=0
        {{2, 0, 0, 0, 0, 0}, -30.16, 0.0, 0.0, -2.76, -0.24, config.includeM2},
        // S2: Principal solar semidiurnal  τ=2 s=2 h=-2 p=0 N'=0 ps=0
        {{2, 2, -2, 0, 0, 0}, -12.94, 0.0, 0.0, -1.25, -0.57, config.includeS2},
        // N2: Larger lunar elliptic  τ=2 s=-1 h=0 p=1 N'=0 ps=0
        {{2, -1, 0, 1, 0, 0}, -6.33, 0.0, 0.0, -0.53, -0.08, config.includeN2},
        // K2: Lunisolar semidiurnal  τ=2 s=2 h=0 p=0 N'=0 ps=0
        {{2, 2, 0, 0, 0, 0}, -3.51, 0.0, 0.0, -0.37, -0.15, config.includeK2},
        // K1: Lunar-solar diurnal  τ=1 s=0 h=1 p=0 N'=0 ps=0
        {{1, 0, 1, 0, 0, 0}, -0.45, -4.72, 0.91, 0.0, 0.0, config.includeK1},
        // O1: Principal lunar diurnal  τ=1 s=-1 h=0 p=0 N'=0 ps=0
        {{1, -1, 0, 0, 0, 0}, 0.94, -3.42, 0.75, 0.0, 0.0, config.includeO1},
        // P1: Principal solar diurnal  τ=1 s=1 h=-2 p=0 N'=0 ps=0
        {{1, 1, -2, 0, 0, 0}, -0.22, -1.54, 0.31, 0.0, 0.0, config.includeP1},
        // Q1: Larger lunar elliptic diurnal  τ=1 s=-2 h=0 p=1 N'=0 ps=0
        {{1, -2, 0, 1, 0, 0}, 0.19, -0.64, 0.15, 0.0, 0.0, config.includeQ1},
    };

    // Satellite position in spherical coordinates
    double sinLat = satPosition.z / r;
    double xyDist = std::sqrt(satPosition.x * satPosition.x + satPosition.y * satPosition.y);
    double cosLat = xyDist / r;
    double lon = std::atan2(satPosition.y, satPosition.x);

    double Re = RE_EARTH;
    double Re_r = Re / r;
    double Re_r2 = Re_r * Re_r;
    double mu_r2 = MU_EARTH / (r * r);

    // Associated Legendre functions at satellite
    double P20 = 0.5 * (3.0 * sinLat * sinLat - 1.0);
    double P21 = 3.0 * sinLat * cosLat;
    double P22 = 3.0 * cosLat * cosLat;

    double dP20 = -3.0 * sinLat * cosLat;
    double dP21 = 3.0 * (cosLat * cosLat - sinLat * sinLat);
    double dP22 = -6.0 * sinLat * cosLat;

    double cosLon = std::cos(lon);
    double sinLon = std::sin(lon);
    double cos2Lon = std::cos(2.0 * lon);
    double sin2Lon = std::sin(2.0 * lon);
    double safe_cosLat = std::max(cosLat, 1e-10);

    for (const auto& tide : tides) {
        if (!tide.enabled) continue;

        // Compute tidal argument θ = Σ(doodson[i] * doodArgs[i])
        double theta = 0.0;
        for (int i = 0; i < 6; i++) {
            theta += tide.doodson[i] * doodArgs[i];
        }
        double cosTheta = std::cos(theta);
        double sinTheta = std::sin(theta);

        // Time-varying Stokes coefficient changes (×1e-12)
        double dC20 = tide.dC20 * 1e-12 * cosTheta;
        double dC21 = tide.dC21 * 1e-12 * cosTheta - tide.dS21 * 1e-12 * sinTheta;
        double dS21 = tide.dC21 * 1e-12 * sinTheta + tide.dS21 * 1e-12 * cosTheta;
        double dC22 = tide.dC22 * 1e-12 * cosTheta - tide.dS22 * 1e-12 * sinTheta;
        double dS22 = tide.dC22 * 1e-12 * sinTheta + tide.dS22 * 1e-12 * cosTheta;

        // Radial acceleration: -μ/r² (n+1)(Re/r)^n Σ [ΔCnm cos(mλ) + ΔSnm sin(mλ)] Pnm
        double ar = -mu_r2 * Re_r2 * 3.0 * (
            dC20 * P20 +
            (dC21 * cosLon + dS21 * sinLon) * P21 +
            (dC22 * cos2Lon + dS22 * sin2Lon) * P22
        );

        // Latitude acceleration
        double aphi = mu_r2 * Re_r2 * (
            dC20 * dP20 +
            (dC21 * cosLon + dS21 * sinLon) * dP21 +
            (dC22 * cos2Lon + dS22 * sin2Lon) * dP22
        );

        // Longitude acceleration
        double alon = mu_r2 / safe_cosLat * Re_r2 * (
            1.0 * (-dC21 * sinLon + dS21 * cosLon) * P21 +
            2.0 * (-dC22 * sin2Lon + dS22 * cos2Lon) * P22
        );

        // Spherical to Cartesian
        Vec3 rHat(cosLat * cosLon, cosLat * sinLon, sinLat);
        Vec3 phiHat(-sinLat * cosLon, -sinLat * sinLon, cosLat);
        Vec3 lonHat(-sinLon, cosLon, 0.0);

        totalAcc += rHat * ar + phiHat * aphi + lonHat * alon;
    }

    return totalAcc;
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
    GcrfToEarthFixed(jd, m);
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

        case GravityMode::EGM2008:
            return EGM2008(position, forceSet.egm2008);
        case GravityMode::LoadedField:
            if (forceSet.loadedField) return LoadedFieldGravity(position, *forceSet.loadedField);
            return PointMass(position, forceSet.mu);
        case GravityMode::SphericalHarmonics:
        default:
            return SphericalHarmonics(position, forceSet.sphericalHarmonics);
    }
}

Vec3 ComputeTotalAcceleration(const Vec3& position, const Vec3& velocity, double jd,
                              ForceModelSet& forceSet) {
    Vec3 totalAcc;

    // Get Sun position if needed and not provided
    Vec3 sunPos;
    if (forceSet.useSRP || forceSet.useEarthAlbedo || forceSet.useThermalReradiation) {
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
        totalAcc += SolarRadiation(position, sunPos, forceSet.srp);
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
        const double atmosphereJD = forceSet.explicitEpochContract
            ? timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(jd))) : jd;
        switch (forceSet.dragModel) {
            case DragModelType::NRLMSISE00:
                totalAcc += NRLMSISE00(position, velocity, atmosphereJD, forceSet.weather,
                                       forceSet.drag, forceSet.nrlmsise00);
                break;
            case DragModelType::HarrisPriester:
                totalAcc += HarrisPriester(position, velocity, jd, forceSet.drag,
                                           forceSet.harrisPriesterExponent, &forceSet.weather,
                                           atmosphereJD);
                break;
            case DragModelType::USSA1976:
                totalAcc += AtmosphericDrag(position, velocity, atmosphereJD,
                                            forceSet.weather, forceSet.drag);
                break;
            case DragModelType::JB2008:
                totalAcc += JB2008(position, velocity, atmosphereJD, forceSet.weather,
                                   forceSet.drag, forceSet.jb2008);
                break;
            case DragModelType::DTM2020:
                totalAcc += DTM2020(position, velocity, atmosphereJD, forceSet.weather,
                                    forceSet.drag, forceSet.dtm2020);
                break;
            case DragModelType::Exponential:
                totalAcc += AtmosphericDragExponential(position, velocity,
                                                       forceSet.drag.mass,
                                                       forceSet.drag.area,
                                                       forceSet.drag.Cd);
                break;
        }
    }

    // 11. Relativistic Correction
    if (forceSet.useRelativisticCorrection) {
        totalAcc += RelativisticCorrection(position, velocity, jd, forceSet.mu,
                                           forceSet.relativistic);
    }

    // 12. Earth Albedo
    if (forceSet.useEarthAlbedo) {
        totalAcc += EarthAlbedo(position, sunPos, forceSet.earthAlbedo);
    }

    // 13. Thermal Reradiation
    if (forceSet.useThermalReradiation) {
        totalAcc += ThermalReradiation(position, sunPos, forceSet.thermal);
    }

    // 14. Solid Tides
    if (forceSet.useSolidTides) {
        totalAcc += SolidTides(position, jd, forceSet.solidTides);
    }

    // 15. Ocean Tides
    if (forceSet.useOceanTides) {
        totalAcc += OceanTides(position, jd, forceSet.oceanTides);
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

    fs.useEarthAlbedo = true;
    fs.earthAlbedo.mass = mass;
    fs.earthAlbedo.area = area;

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
