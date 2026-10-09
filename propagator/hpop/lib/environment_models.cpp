// environment_models.cpp - Phase 8.6 Environment Models Implementation
// =============================================================================
// High-fidelity environment models for precision orbit determination and
// propagation. Implements EGM2008, GRGM1200A, JPL ephemerides, SRP,
// advanced atmosphere models, and space weather integration.
// =============================================================================

#include "environment_models.h"
#include "egm2008_data.h"
#include "egm96_data.h"
#include "astrodynamics.h"
#include <cmath>
#include <algorithm>
#include <numeric>
#include <cstdlib>
#include <cctype>
#include <sstream>
#include <string>

namespace astro {

// =============================================================================
// Mathematical Constants
// =============================================================================

static constexpr double SPEED_OF_LIGHT_M = 299792458.0;  // m/s
static constexpr double SOLAR_FLUX_1AU_W = 1361.0;       // W/m^2

// =============================================================================
// 8.6.1 High-Fidelity Gravity Field Models
// =============================================================================

// EGM2008 coefficients are now loaded from egm2008_data.h (degree 2-70, 2553 records)
// Generated from official ICGEM data by scripts/generate_egm2008.cjs

// GRGM1200A lunar coefficients (selected terms)
// Reference: Lemoine et al. (2014), GRGM1200A
namespace GRGM1200ACoefficients {
    static constexpr double C20 = -9.0878e-5;
    static constexpr double C22 =  3.4717e-5;
    static constexpr double S22 = -1.0095e-6;
    static constexpr double C30 = -7.1426e-6;
    static constexpr double C31 =  2.6167e-5;
    static constexpr double S31 =  5.8528e-6;
    static constexpr double C32 =  4.8892e-6;
    static constexpr double S32 =  1.6838e-6;
    static constexpr double C33 =  1.7062e-6;
    static constexpr double S33 = -2.7088e-7;
}

ExtendedGravityField initEGM2008Extended(const EGM2008Config& config) {
    ExtendedGravityField field;
    field.model = GravityModelType::EGM2008;
    // The model's own constants: its coefficients are scaled to them. (Until
    // 2026-10-08 the field used 398600.4418 and 6378.137, the TCG-compatible
    // GM and the WGS-84 radius.)
    field.mu = EGM2008_GM_KM3_S2;
    field.referenceRadius = EGM2008_RADIUS_KM;
    field.normalized = true;

    uint16_t maxDeg = std::min(config.maxDegree,
        static_cast<uint16_t>(std::min(static_cast<int>(MAX_GRAVITY_DEGREE),
                                       EGM2008Data::MAX_EMBEDDED_DEGREE)));
    uint16_t maxOrd = std::min(config.maxOrder, maxDeg);
    field.allocate(maxDeg, maxOrd);

    // Initialize with zeros
    for (uint16_t n = 0; n <= maxDeg; n++) {
        for (uint16_t m = 0; m <= std::min(n, maxOrd); m++) {
            field.Cnm[n][m] = 0.0;
            field.Snm[n][m] = 0.0;
        }
    }

    // C00 = 1 (normalization)
    field.Cnm[0][0] = 1.0;

    // Load from embedded EGM2008 data (degree 2 to maxDeg)
    for (int i = 0; i < EGM2008Data::NUM_COEFFICIENTS; i++) {
        const auto& rec = EGM2008Data::COEFFICIENTS[i];
        if (rec.n > maxDeg) break;
        if (rec.m > maxOrd) continue;
        field.Cnm[rec.n][rec.m] = rec.Cnm;
        field.Snm[rec.n][rec.m] = rec.Snm;
    }

    return field;
}

ExtendedGravityField initEGM96Extended(const EGM2008Config& config) {
    ExtendedGravityField field;
    field.model = GravityModelType::EGM96;
    field.mu = EGM96_GM_KM3_S2;
    field.referenceRadius = EGM96_RADIUS_KM;
    field.normalized = true;
    const uint16_t maxDeg = std::min<uint16_t>(config.maxDegree, EGM96Data::MAX_EMBEDDED_DEGREE);
    const uint16_t maxOrd = std::min(config.maxOrder, maxDeg);
    field.allocate(maxDeg, maxOrd);
    field.Cnm[0][0] = 1.0;
    for (int i = 0; i < EGM96Data::NUM_COEFFICIENTS; i++) {
        const auto& rec = EGM96Data::COEFFICIENTS[i];
        if (rec.n > maxDeg) break;
        if (rec.m > maxOrd) continue;
        field.Cnm[rec.n][rec.m] = rec.Cnm;
        field.Snm[rec.n][rec.m] = rec.Snm;
    }
    return field;
}

ExtendedGravityField initGRGM1200AExtended(const GRGM1200AConfig& config) {
    ExtendedGravityField field;
    field.model = GravityModelType::GRGM1200A;
    field.mu = MU_MOON;
    field.referenceRadius = RE_MOON;
    field.normalized = true;

    uint16_t maxDeg = std::min(config.maxDegree, static_cast<uint16_t>(MAX_GRAVITY_DEGREE));
    uint16_t maxOrd = std::min(config.maxOrder, maxDeg);
    field.allocate(maxDeg, maxOrd);

    // Initialize
    for (uint16_t n = 0; n <= maxDeg; n++) {
        for (uint16_t m = 0; m <= std::min(n, maxOrd); m++) {
            field.Cnm[n][m] = 0.0;
            field.Snm[n][m] = 0.0;
        }
    }

    field.Cnm[0][0] = 1.0;

    // Load GRGM1200A coefficients
    if (maxDeg >= 2) {
        field.Cnm[2][0] = GRGM1200ACoefficients::C20;
        if (maxOrd >= 2) {
            field.Cnm[2][2] = GRGM1200ACoefficients::C22;
            field.Snm[2][2] = GRGM1200ACoefficients::S22;
        }
    }

    if (maxDeg >= 3) {
        field.Cnm[3][0] = GRGM1200ACoefficients::C30;
        if (maxOrd >= 1) {
            field.Cnm[3][1] = GRGM1200ACoefficients::C31;
            field.Snm[3][1] = GRGM1200ACoefficients::S31;
        }
        if (maxOrd >= 2) {
            field.Cnm[3][2] = GRGM1200ACoefficients::C32;
            field.Snm[3][2] = GRGM1200ACoefficients::S32;
        }
        if (maxOrd >= 3) {
            field.Cnm[3][3] = GRGM1200ACoefficients::C33;
            field.Snm[3][3] = GRGM1200ACoefficients::S33;
        }
    }

    return field;
}

void computePinesLegendre(
    const Vec3& position,
    double referenceRadius,
    int maxDegree,
    int maxOrder,
    std::vector<std::vector<double>>& V,
    std::vector<std::vector<double>>& W)
{
    // Fully normalized Pines recursion for V̄/W̄.
    // Uses normalized ALF recursion coefficients (Holmes & Featherstone 2002)
    // so that V̄[n][n] stays O(1) at any degree, avoiding the (2n-1)!! overflow
    // that occurs with unnormalized recursion at degree >= ~20.
    // Each V̄[n][m] includes both (R/r)^{n+1} and the ALF normalization factor.

    double r = position.magnitude();
    if (r < 1e-10) {
        return;
    }

    double R = referenceRadius;
    double r2 = r * r;

    // Scaled direction cosines — absorb one power of (R/r) per recursion step
    double xRr2 = position.x * R / r2;
    double yRr2 = position.y * R / r2;
    double zRr2 = position.z * R / r2;
    double Rr_sq = (R / r) * (R / r);

    // Initialize arrays — need up to degree maxDegree+1 for acceleration formulas
    int N = maxDegree + 2;
    V.resize(N + 1);
    W.resize(N + 1);
    for (int n = 0; n <= N; n++) {
        V[n].assign(n + 2, 0.0);
        W[n].assign(n + 2, 0.0);
    }

    // Seed: V̄[0][0] = R/r
    V[0][0] = R / r;
    W[0][0] = 0.0;

    // Degree-1 seeds: factor √3 for normalization (P̄₁₀ = √3·sinφ, P̄₁₁ = √3·cosφ)
    double s3 = std::sqrt(3.0);
    V[1][0] = s3 * zRr2 * V[0][0];
    W[1][0] = 0.0;
    V[1][1] = s3 * xRr2 * V[0][0];
    W[1][1] = s3 * yRr2 * V[0][0];

    // Diagonal recursion: V̄[n][n]
    // Normalized factor √((2n+1)/(2n)) replaces unnormalized (2n-1)
    for (int n = 2; n <= maxDegree + 1; n++) {
        double cn = std::sqrt((2.0 * n + 1.0) / (2.0 * n));
        V[n][n] = cn * (xRr2 * V[n-1][n-1] - yRr2 * W[n-1][n-1]);
        W[n][n] = cn * (xRr2 * W[n-1][n-1] + yRr2 * V[n-1][n-1]);
    }

    // Sub-diagonal recursion: V̄[n][n-1]
    // Normalized factor √(2n+1) replaces unnormalized (2n-1)
    for (int n = 2; n <= maxDegree + 1; n++) {
        double cn = std::sqrt(2.0 * n + 1.0);
        V[n][n-1] = cn * zRr2 * V[n-1][n-1];
        W[n][n-1] = cn * zRr2 * W[n-1][n-1];
    }

    // Column recursion: V̄[n][m] for m <= n-2.
    // Normalized factors α, β from fully normalized ALF recursion.
    // The acceleration of a degree-n, order-m term reads V̄/W̄[n+1][m+1], so
    // the columns run to maxOrder + 1. They used to stop at maxOrder, which
    // dropped the x/y part of every term of order maxOrder whenever
    // maxOrder < maxDegree: a zonal-only field (order 0) lost the horizontal
    // pull of every zonal (a 290 km error in a day, found against Orekit).
    for (int m = 0; m <= std::min(maxOrder + 1, maxDegree + 1); m++) {
        for (int n = m + 2; n <= maxDegree + 1; n++) {
            double nm = (double)(n - m);
            double np = (double)(n + m);
            double alpha = std::sqrt((2.0*n - 1.0) * (2.0*n + 1.0) / (nm * np));
            double beta  = std::sqrt((2.0*n + 1.0) * (nm - 1.0) * (np - 1.0) /
                                     ((2.0*n - 3.0) * nm * np));
            V[n][m] = alpha * zRr2 * V[n-1][m] - beta * Rr_sq * V[n-2][m];
            W[n][m] = alpha * zRr2 * W[n-1][m] - beta * Rr_sq * W[n-2][m];
        }
    }
}

GravityAcceleration computeExtendedGravity(
    const Vec3& position,
    const ExtendedGravityField& field,
    double /* jd */)
{
    GravityAcceleration result;

    double r = position.magnitude();
    if (r < 100.0) {  // Safety check
        return result;
    }

    double mu = field.mu;
    double R = field.referenceRadius;

    // Point mass contribution
    double r3 = r * r * r;
    result.pointMass = position * (-mu / r3);
    result.total = result.pointMass;

    result.valid = true;  // Mark as valid after point mass computation

    if (field.maxDegree < 2) {
        return result;
    }

    // Compute fully normalized V̄/W̄ with embedded (R/r)^{n+1}
    std::vector<std::vector<double>> V, W;
    computePinesLegendre(position, R, field.maxDegree, field.maxOrder, V, W);

    Vec3 harmonicAcc;
    double muR2 = mu / (R * R);

    // Acceleration from fully normalized V̄/W̄ and C̄/S̄.
    // The M&G Eq. 3.33 formula is for unnormalized quantities. With normalized
    // V̄ and C̄, each term picks up a correction factor γ = N_{n,m}/N_{n+1,m'}
    // where N is the ALF normalization factor (Cunningham 1970).
    for (int n = 2; n <= field.maxDegree; n++) {
        double n2p1 = 2.0*n + 1.0;
        double n2p3 = 2.0*n + 3.0;

        for (int m = 0; m <= std::min(n, static_cast<int>(field.maxOrder)); m++) {
            double Cnm = field.getC(n, m);
            double Snm = field.getS(n, m);

            if (std::abs(Cnm) < 1e-30 && std::abs(Snm) < 1e-30) {
                continue;
            }

            if (m == 0) {
                // Zonal: correction factors for m=0 → m'=1 and m=0 → m'=0
                double gp = std::sqrt(n2p1 * (double)(n+1) * (double)(n+2) / (2.0 * n2p3));
                double gz = std::sqrt(n2p1 / n2p3);

                harmonicAcc.x += muR2 * (-Cnm * gp * V[n+1][1]);
                harmonicAcc.y += muR2 * (-Cnm * gp * W[n+1][1]);
                harmonicAcc.z += muR2 * (-(double)(n+1) * gz * Cnm * V[n+1][0]);
            } else {
                // Tesseral/sectoral: γ for m → m+1
                double gp = std::sqrt(n2p1 * (double)(n+m+1) * (double)(n+m+2) / n2p3);

                // f·γ combined for m → m-1 (absorbs (n-m+2)(n-m+1) factor)
                double fgm;
                if (m == 1) {
                    fgm = std::sqrt(2.0 * n2p1 * (double)n * (double)(n+1) / n2p3);
                } else {
                    fgm = std::sqrt(n2p1 * (double)(n-m+1) * (double)(n-m+2) / n2p3);
                }

                // (n-m+1)·γ for z-component (m → m)
                double nmz = (double)(n-m+1) * std::sqrt(n2p1 * (double)(n+m+1) /
                             (n2p3 * (double)(n-m+1)));

                harmonicAcc.x += muR2 * 0.5 * (
                    -gp * (Cnm * V[n+1][m+1] + Snm * W[n+1][m+1])
                    + fgm * (Cnm * V[n+1][m-1] + Snm * W[n+1][m-1])
                );
                // Montenbruck & Gill (2000) eq. 3.33: both terms of the y
                // component are (-C W + S V). The m-1 term carried the
                // opposite sign until 2026-10-08, which put every tesseral
                // term's y pull backwards (37 km in a day in LEO, against
                // Orekit and against the inline evaluator).
                harmonicAcc.y += muR2 * 0.5 * (
                    gp * (Snm * V[n+1][m+1] - Cnm * W[n+1][m+1])
                    + fgm * (Snm * V[n+1][m-1] - Cnm * W[n+1][m-1])
                );
                harmonicAcc.z += muR2 * (-nmz * (Cnm * V[n+1][m] + Snm * W[n+1][m]));
            }
        }
    }

    result.zonalHarmonics = harmonicAcc;  // Simplified - should separate zonal/tesseral
    result.total = result.pointMass + harmonicAcc;
    result.degreeUsed = field.maxDegree;
    result.orderUsed = field.maxOrder;

    return result;
}

Mat3 computeGravityGradient(
    const Vec3& position,
    const ExtendedGravityField& field)
{
    Mat3 gradient;

    double r = position.magnitude();
    if (r < 100.0) {
        return gradient;
    }

    double mu = field.mu;
    double r2 = r * r;
    double r5 = r2 * r2 * r;
    double r7 = r5 * r2;

    // Point mass contribution to gradient tensor
    double x = position.x;
    double y = position.y;
    double z = position.z;

    gradient.m[0][0] = mu * (3.0 * x * x - r2) / r5;
    gradient.m[0][1] = mu * 3.0 * x * y / r5;
    gradient.m[0][2] = mu * 3.0 * x * z / r5;
    gradient.m[1][0] = gradient.m[0][1];
    gradient.m[1][1] = mu * (3.0 * y * y - r2) / r5;
    gradient.m[1][2] = mu * 3.0 * y * z / r5;
    gradient.m[2][0] = gradient.m[0][2];
    gradient.m[2][1] = gradient.m[1][2];
    gradient.m[2][2] = mu * (3.0 * z * z - r2) / r5;

    // J2 contribution (approximate)
    if (field.maxDegree >= 2) {
        double C20 = field.getC(2, 0);
        double J2 = -C20 * std::sqrt(5.0);
        double R = field.referenceRadius;
        double R2 = R * R;

        double factor = 3.0 * mu * J2 * R2 / (2.0 * r7);

        gradient.m[0][0] += factor * (5.0 * (7.0 * z * z - r2) * x * x / r2 - (7.0 * z * z - r2));
        gradient.m[1][1] += factor * (5.0 * (7.0 * z * z - r2) * y * y / r2 - (7.0 * z * z - r2));
        gradient.m[2][2] += factor * (5.0 * (7.0 * z * z - 3.0 * r2) * z * z / r2 - (7.0 * z * z - r2));

        gradient.m[0][1] += factor * 5.0 * (7.0 * z * z - r2) * x * y / r2;
        gradient.m[1][0] = gradient.m[0][1];
        gradient.m[0][2] += factor * 5.0 * (7.0 * z * z - 3.0 * r2) * x * z / r2;
        gradient.m[2][0] = gradient.m[0][2];
        gradient.m[1][2] += factor * 5.0 * (7.0 * z * z - 3.0 * r2) * y * z / r2;
        gradient.m[2][1] = gradient.m[1][2];
    }

    return gradient;
}

// =============================================================================
// 8.6.2 JPL DE Ephemeris
// =============================================================================

bool JPLDEReader::load(const std::string& filename, JPLDEVersion version) {
    // Placeholder - actual implementation would read binary DE file
    // For now, we mark as not loaded and use analytical ephemerides
    header_.version = version;
    loaded_ = false;
    return false;
}

bool JPLDEReader::isValidEpoch(double jd) const {
    if (!loaded_) return false;
    return jd >= header_.startJD && jd <= header_.endJD;
}

EphemerisState JPLDEReader::getState(CelestialBody body, double jd, CelestialBody center) const {
    EphemerisState state;
    state.body = body;
    state.epoch = jd;
    state.valid = false;

    if (!loaded_) {
        // Fall back to analytical ephemeris
        switch (body) {
            case CelestialBody::Sun:
                return getSunPosition(jd);
            case CelestialBody::Moon:
                return getMoonPosition(jd);
            default:
                return getPlanetPosition(body, jd);
        }
    }

    // Would implement Chebyshev interpolation here
    return state;
}

Vec3 JPLDEReader::evaluateChebyshev(
    const std::vector<double>& coeffsX,
    const std::vector<double>& coeffsY,
    const std::vector<double>& coeffsZ,
    double normalizedTime) const
{
    Vec3 result;
    int n = static_cast<int>(coeffsX.size());

    if (n == 0) return result;

    // Clenshaw recursion for Chebyshev evaluation
    double bx2 = 0.0, bx1 = 0.0;
    double by2 = 0.0, by1 = 0.0;
    double bz2 = 0.0, bz1 = 0.0;

    for (int i = n - 1; i >= 1; i--) {
        double bx = 2.0 * normalizedTime * bx1 - bx2 + coeffsX[i];
        double by = 2.0 * normalizedTime * by1 - by2 + coeffsY[i];
        double bz = 2.0 * normalizedTime * bz1 - bz2 + coeffsZ[i];

        bx2 = bx1; bx1 = bx;
        by2 = by1; by1 = by;
        bz2 = bz1; bz1 = bz;
    }

    result.x = normalizedTime * bx1 - bx2 + coeffsX[0];
    result.y = normalizedTime * by1 - by2 + coeffsY[0];
    result.z = normalizedTime * bz1 - bz2 + coeffsZ[0];

    return result;
}

ThirdBodyAcceleration computeThirdBodyDE(
    const Vec3& satPosition,
    const ThirdBodyConfig& config,
    double jd,
    const JPLDEReader* deReader)
{
    // Use existing analytical function, but with optional DE reader
    return computeThirdBodyAcceleration(satPosition, config, jd);
}

// =============================================================================
// 8.6.3 Solar Radiation Pressure
// =============================================================================

SRPAcceleration computeSRPNPlate(
    const Vec3& satPosition,
    const Vec3& sunPosition,
    const Mat3& bodyToDcm,
    const NPlateSRPConfig& config)
{
    SRPAcceleration result;

    Vec3 satSun = sunPosition - satPosition;
    double sunDist = satSun.magnitude();
    Vec3 sunDir = satSun.normalized();

    // Shadow check
    ShadowGeometry shadow = computeShadowGeometry(
        satPosition, sunPosition, RE_EARTH, config.shadowModel);

    result.shadowFactor = 1.0 - shadow.shadowFraction;
    if (result.shadowFactor < 1e-6) {
        return result;
    }

    // Solar flux at satellite distance
    result.solarFlux = computeSolarFlux(sunDist);

    // Radiation pressure (N/m^2)
    double P = result.solarFlux / SPEED_OF_LIGHT_M;

    Vec3 totalForce;

    for (const auto& plate : config.plates) {
        // Transform plate normal to inertial frame
        Vec3 normalInertial;
        normalInertial.x = bodyToDcm.m[0][0] * plate.normal.x +
                           bodyToDcm.m[0][1] * plate.normal.y +
                           bodyToDcm.m[0][2] * plate.normal.z;
        normalInertial.y = bodyToDcm.m[1][0] * plate.normal.x +
                           bodyToDcm.m[1][1] * plate.normal.y +
                           bodyToDcm.m[1][2] * plate.normal.z;
        normalInertial.z = bodyToDcm.m[2][0] * plate.normal.x +
                           bodyToDcm.m[2][1] * plate.normal.y +
                           bodyToDcm.m[2][2] * plate.normal.z;

        // For sun-tracking panels, align normal with sun
        if (plate.isSolarPanel) {
            normalInertial = sunDir;
        }

        // Cosine of incidence angle
        double cosTheta = sunDir.dot(normalInertial);

        // Only illuminated if facing the sun
        if (cosTheta <= 0) {
            continue;
        }

        // Plate area (m^2)
        double effectiveArea = plate.area * cosTheta;

        // SRP force components (N)
        // Absorbed: in sun direction
        double absorbedForce = P * effectiveArea * plate.absorptionCoeff;

        // Specularly reflected: in reflected direction
        double specularForce = 2.0 * P * effectiveArea * cosTheta * plate.specularCoeff;

        // Diffusely reflected: 2/3 in normal direction
        double diffuseForce = (2.0 / 3.0) * P * effectiveArea * plate.diffuseCoeff;

        // Total force (negative = away from sun)
        Vec3 plateForce = sunDir * (-absorbedForce)
                        + normalInertial * (specularForce + diffuseForce);

        totalForce = totalForce + plateForce;
    }

    // Apply shadow factor
    totalForce = totalForce * result.shadowFactor;

    // Convert to acceleration (km/s^2)
    // Force is in Newtons, mass in kg
    // a = F/m (m/s^2) -> (km/s^2) = * 1e-3
    result.total = totalForce * (1.0e-3 / config.mass);

    double totalArea = 0.0;
    for (const auto& plate : config.plates) {
        totalArea += plate.area;
    }
    result.areaMassRatio = totalArea / config.mass;

    return result;
}

double estimateCr(double area, double mass, const std::string& surfaceType) {
    // Typical Cr values based on surface type
    double Cr = 1.0;

    if (surfaceType == "solar_panel") {
        Cr = 1.2;  // Mostly absorptive
    } else if (surfaceType == "mli" || surfaceType == "blanket") {
        Cr = 1.4;  // Diffuse reflective
    } else if (surfaceType == "specular" || surfaceType == "mirror") {
        Cr = 2.0;  // Fully specular
    } else if (surfaceType == "black" || surfaceType == "absorber") {
        Cr = 1.0;  // Fully absorptive
    } else {
        Cr = 1.5;  // Default mixed
    }

    return Cr;
}

std::vector<EclipseEvent> findEclipseEvents(
    const StateVector& initialState,
    double startJD,
    double endJD,
    double dtSearch)
{
    std::vector<EclipseEvent> events;

    StateVector state = initialState;
    double dt = dtSearch / 86400.0;  // Convert to days

    bool inEclipse = false;
    EclipseEvent currentEvent;

    for (double jd = startJD; jd <= endJD; jd += dt) {
        // Propagate state
        double propagateTime = (jd - initialState.epoch) * 86400.0;
        StateVector currentState = propagateKepler(initialState, propagateTime);

        // Get sun position
        EphemerisState sun = getSunPosition(jd);

        // Check shadow
        ShadowGeometry shadow = computeShadowGeometry(
            currentState.position, sun.position, RE_EARTH, ShadowModelType::Conical);

        bool nowInEclipse = shadow.shadowFraction > 0.01;

        if (nowInEclipse && !inEclipse) {
            // Eclipse entry
            currentEvent.epochEntry = jd;
            currentEvent.isUmbra = shadow.inUmbra;
            currentEvent.occultingBody = CelestialBody::Earth;
            inEclipse = true;
        } else if (!nowInEclipse && inEclipse) {
            // Eclipse exit
            currentEvent.epochExit = jd;
            currentEvent.duration = (currentEvent.epochExit - currentEvent.epochEntry) * 86400.0;
            events.push_back(currentEvent);
            inEclipse = false;
        }
    }

    // Handle case where eclipse extends past end
    if (inEclipse) {
        currentEvent.epochExit = endJD;
        currentEvent.duration = (currentEvent.epochExit - currentEvent.epochEntry) * 86400.0;
        events.push_back(currentEvent);
    }

    return events;
}

// =============================================================================
// 8.6.4 Advanced Atmosphere Models
// =============================================================================

AtmosphericDensity computeNRLMSISE00Full(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    const NRLMSISE00Config& config)
{
    AtmosphereConfig atmConfig;
    atmConfig.model = AtmosphereModelType::NRLMSISE00;
    atmConfig.minAltitude = config.minAltitude;
    atmConfig.maxAltitude = config.maxAltitude;
    atmConfig.diurnalVariation = config.flags.utEffects;

    return computeNRLMSISE00(position, jd, weather, atmConfig);
}

AtmosphericDensity computeDTM2020Full(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    DTM2020Mode mode)
{
    AtmosphericDensity result = computeDTM2020(position, jd, weather);

    // Apply mode-specific corrections
    if (mode == DTM2020Mode::Storm && weather.isStorm) {
        double stormFactor = stormDensityScaleFactor(weather, result.altitude);
        result.density *= stormFactor;
    }

    return result;
}

AtmosphericDensity computeJB2008Extended(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    const JB2008ExtendedConfig& config)
{
    AtmosphericDensity result = computeJB2008(position, jd, weather);

    // Apply Dst storm effect
    if (config.useDSTEffect && weather.Dst < -30.0) {
        double dstFactor = 1.0 + 0.005 * std::abs(weather.Dst + 30.0);
        result.density *= dstFactor;
    }

    return result;
}

AtmosphericDensity computeBestAtmosphere(
    const Vec3& position,
    double jd,
    const SpaceWeatherData& weather,
    AtmosphereModelType preferredModel)
{
    double lat, lon, alt;
    ecefToGeodetic(position, lat, lon, alt);

    // Select model based on altitude and requirements
    AtmosphereModelType selectedModel = preferredModel;

    if (alt < 90.0) {
        // Below 90 km, use USSA1976
        selectedModel = AtmosphereModelType::USSA1976;
    } else if (alt > 2000.0) {
        // Above 2000 km, use exponential
        selectedModel = AtmosphereModelType::Exponential;
    }

    // Compute with selected model
    switch (selectedModel) {
        case AtmosphereModelType::JB2008:
            return computeJB2008(position, jd, weather);
        case AtmosphereModelType::DTM2020:
            return computeDTM2020(position, jd, weather);
        case AtmosphereModelType::USSA1976:
            return computeUSSA1976(alt);
        case AtmosphereModelType::Exponential: {
            AtmosphericDensity result;
            result.altitude = alt;
            result.density = exponentialAtmosphereDensity(alt);
            return result;
        }
        case AtmosphereModelType::NRLMSISE00:
        default: {
            AtmosphereConfig atmConfig;
            atmConfig.model = AtmosphereModelType::NRLMSISE00;
            return computeNRLMSISE00(position, jd, weather, atmConfig);
        }
    }
}

// =============================================================================
// 8.6.5 Space Weather Integration
// =============================================================================

SpaceWeatherData SpaceWeatherTimeSeries::getAtEpoch(double jd) const {
    if (observed.empty()) {
        SpaceWeatherData defaultData;
        defaultData.epoch = jd;
        defaultData.F107 = 150.0;
        defaultData.F107a = 150.0;
        defaultData.Ap = 15.0;
        return defaultData;
    }

    // Find bracketing observations
    for (size_t i = 0; i < observed.size() - 1; i++) {
        if (jd >= observed[i].epoch && jd <= observed[i+1].epoch) {
            return interpolateSpaceWeather(jd, observed[i], observed[i+1]);
        }
    }

    // Check forecast data
    if (forecast.size() >= 2) {
        for (size_t i = 0; i < forecast.size() - 1; i++) {
            if (jd >= forecast[i].epoch && jd <= forecast[i+1].epoch) {
                return interpolateSpaceWeather(jd, forecast[i], forecast[i+1]);
            }
        }
    }

    // Return closest observation
    if (jd < observed.front().epoch) {
        return observed.front();
    }
    if (!forecast.empty() && jd > forecast.back().epoch) {
        return forecast.back();
    }

    return observed.back();
}

double SpaceWeatherTimeSeries::getF107A(double jd) const {
    // Find 81-day centered average
    double sum = 0.0;
    int count = 0;

    for (const auto& obs : observed) {
        double daysDiff = jd - obs.epoch;
        if (daysDiff >= -40.0 && daysDiff <= 40.0) {
            sum += obs.F107;
            count++;
        }
    }

    if (count > 0) {
        return sum / count;
    }

    // Fall back to F107a from nearest observation
    SpaceWeatherData nearest = getAtEpoch(jd);
    return nearest.F107a;
}

std::array<double, 7> SpaceWeatherTimeSeries::getApHistory(double jd) const {
    std::array<double, 7> ap = {15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0};

    // Ap history: current, 3hr ago, 6hr ago, 9hr ago, 12-33hr avg, 36-57hr avg, Ap daily
    for (int i = 0; i < 7; i++) {
        double targetJD = jd - i * 3.0 / 24.0;
        SpaceWeatherData data = getAtEpoch(targetJD);
        ap[i] = data.Ap;
    }

    return ap;
}

StormLevel classifyStorm(const SpaceWeatherData& weather) {
    if (weather.Kp >= 9.0 || weather.Ap >= 300.0) return StormLevel::G5;
    if (weather.Kp >= 8.0 || weather.Ap >= 179.0) return StormLevel::G4;
    if (weather.Kp >= 7.0 || weather.Ap >= 111.0) return StormLevel::G3;
    if (weather.Kp >= 6.0 || weather.Ap >= 67.0) return StormLevel::G2;
    if (weather.Kp >= 5.0 || weather.Ap >= 48.0) return StormLevel::G1;
    return StormLevel::None;
}

SolarCyclePhase estimateSolarPhase(double f107, double f107a) {
    // Estimate based on F10.7 levels
    // Solar minimum: F10.7 ~ 65-75
    // Solar maximum: F10.7 ~ 200-250

    double diff = f107 - f107a;

    if (f107a < 85.0) {
        return SolarCyclePhase::Minimum;
    } else if (f107a > 180.0) {
        return SolarCyclePhase::Maximum;
    } else if (diff > 10.0) {
        return SolarCyclePhase::Rising;
    } else if (diff < -10.0) {
        return SolarCyclePhase::Declining;
    }

    return (f107a < 130.0) ? SolarCyclePhase::Rising : SolarCyclePhase::Declining;
}

double stormDensityScaleFactor(const SpaceWeatherData& weather, double altitude) {
    if (!weather.isStorm) return 1.0;

    StormLevel level = classifyStorm(weather);
    double baseFactor = 1.0 + 0.5 * static_cast<int>(level);

    // Altitude dependence: effect is stronger at higher altitudes
    double altFactor = 1.0;
    if (altitude > 400.0) {
        altFactor = 1.0 + 0.3 * (altitude - 400.0) / 400.0;
    }

    return baseFactor * altFactor;
}

SpaceWeatherData predictSpaceWeather(
    const SpaceWeatherData& currentWeather,
    double hoursAhead)
{
    SpaceWeatherData predicted = currentWeather;
    predicted.epoch = currentWeather.epoch + hoursAhead / 24.0;

    // Simple persistence forecast for F10.7
    // (Real forecast would use solar rotation period ~27 days)

    // Ap/Kp decay toward quiet conditions
    double decayFactor = std::exp(-hoursAhead / 24.0);  // ~1 day decay

    double quietAp = 10.0;
    predicted.Ap = quietAp + (currentWeather.Ap - quietAp) * decayFactor;
    predicted.Kp = apToKp(predicted.Ap);

    predicted.isStorm = isGeomagneticStorm(predicted);

    return predicted;
}

// =============================================================================
// Combined Environment Model
// =============================================================================

Vec3 computeFullEnvironmentAcceleration(
    const StateVector& state,
    double jd,
    const FullEnvironmentConfig& config)
{
    AccelerationBreakdown breakdown = computeAccelerationBreakdown(state, jd, config);
    return breakdown.total;
}

AccelerationBreakdown computeAccelerationBreakdown(
    const StateVector& state,
    double jd,
    const FullEnvironmentConfig& config)
{
    AccelerationBreakdown result;
    result.jd = jd;
    result.valid = true;

    // Gravity
    if (config.useExtendedGravity && config.earthField.maxDegree > 0) {
        result.gravity = computeExtendedGravity(state.position, config.earthField, jd);
    } else {
        GravityFieldCoefficients simpleCoeffs = initEGM2008(
            config.egm2008Config.maxDegree, config.egm2008Config.maxOrder);
        result.gravity = computeSphericalHarmonicGravity(state.position, simpleCoeffs);
    }
    result.total = result.gravity.total;

    // Third body
    if (config.useJPLDE && config.deReader && config.deReader->isLoaded()) {
        result.thirdBody = computeThirdBodyDE(state.position, config.thirdBody, jd, config.deReader.get());
    } else {
        result.thirdBody = computeThirdBodyAcceleration(state.position, config.thirdBody, jd);
    }
    result.total = result.total + result.thirdBody.total;

    // SRP
    if (config.useSRP) {
        EphemerisState sun = getSunPosition(jd);
        if (sun.valid) {
            if (config.useNPlate) {
                Mat3 identity;  // Would use actual attitude
                identity.m[0][0] = identity.m[1][1] = identity.m[2][2] = 1.0;
                result.srp = computeSRPNPlate(state.position, sun.position, identity, config.nPlateConfig);
            } else {
                result.srp = computeSRPCannonball(state.position, sun.position, config.srpConfig);
            }
            result.total = result.total + result.srp.total;
        }
    }

    // Drag
    if (config.useDrag) {
        SpaceWeatherData weather = config.weatherTimeSeries.getAtEpoch(jd);
        result.drag = computeDragAcceleration(state.position, state.velocity, jd,
                                              config.dragConfig, weather);
        result.total = result.total + result.drag.total;
    }

    return result;
}


// =============================================================================
// 8.6.1b Generic potential-file loader                              (gmat-07)
// =============================================================================

namespace {

/// Scan every number out of a line, tolerating BOTH whitespace-separated and
/// fixed-column-concatenated records.
///
/// Fixed-column potential files routinely emit `2  0-0.484165371736E-03`: the
/// degree, the order and a negative coefficient with no separator, because the
/// columns are the separator. A whitespace tokenizer reads that as two numbers
/// and loses the field. This scanner starts a new number at any `+`/`-`/`.`/
/// digit that cannot continue the number in progress, so the same routine
/// reads both encodings. Fortran `D` exponents are accepted.
std::vector<double> scanNumbers(const std::string& line, size_t maxCount = 64) {
    std::vector<double> out;
    size_t i = 0;
    const size_t n = line.size();
    while (i < n && out.size() < maxCount) {
        char c = line[i];
        bool starts = (c >= '0' && c <= '9');
        if (!starts && (c == '+' || c == '-' || c == '.')) {
            // A sign or point only starts a number if a digit or point follows.
            size_t j = i + 1;
            if (c != '.' && j < n && line[j] == '.') j++;
            starts = (j < n && line[j] >= '0' && line[j] <= '9');
        }
        if (!starts) { i++; continue; }

        size_t start = i;
        if (line[i] == '+' || line[i] == '-') i++;
        bool sawDot = false, sawDigit = false;
        while (i < n) {
            char d = line[i];
            if (d >= '0' && d <= '9') { sawDigit = true; i++; continue; }
            if (d == '.' && !sawDot) { sawDot = true; i++; continue; }
            break;
        }
        if (!sawDigit) { i = start + 1; continue; }
        // Exponent
        if (i < n && (line[i] == 'e' || line[i] == 'E' ||
                      line[i] == 'd' || line[i] == 'D')) {
            size_t save = i;
            size_t j = i + 1;
            if (j < n && (line[j] == '+' || line[j] == '-')) j++;
            if (j < n && line[j] >= '0' && line[j] <= '9') {
                while (j < n && line[j] >= '0' && line[j] <= '9') j++;
                i = j;
            } else {
                i = save;
            }
        }
        std::string tok = line.substr(start, i - start);
        for (char& d : tok) if (d == 'd' || d == 'D') d = 'e';
        out.push_back(std::strtod(tok.c_str(), nullptr));
    }
    return out;
}

std::string lowerTrim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return {};
    size_t b = s.find_last_not_of(" \t\r\n");
    std::string t = s.substr(a, b - a + 1);
    for (char& c : t) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return t;
}

std::string firstToken(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return {};
    size_t b = s.find_first_of(" \t\r\n", a);
    return s.substr(a, (b == std::string::npos ? s.size() : b) - a);
}

/// Julian date at 00:00 UT of a Gregorian calendar date (Meeus, ch. 7).
double gregorianToJulianDay(int year, int month, int day) {
    if (month <= 2) { year -= 1; month += 12; }
    const int A = year / 100;
    const int B = 2 - A + A / 4;
    return std::floor(365.25 * (year + 4716)) +
           std::floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

std::vector<std::string> splitLines(const std::string& content) {
    std::vector<std::string> lines;
    std::string cur;
    for (char c : content) {
        if (c == '\n') { lines.push_back(cur); cur.clear(); }
        else if (c != '\r') cur.push_back(c);
    }
    if (!cur.empty()) lines.push_back(cur);
    return lines;
}

/// A potential file states GM and the reference radius in SI (m^3/s^2, m) or,
/// occasionally, already in km. Discriminate by magnitude rather than by
/// trusting a header keyword that may be absent: an Earth GM is ~4e14 in SI
/// and ~4e5 in km units, six orders apart, so there is no ambiguous middle.
void normalizeFieldUnits(double& gm, double& radius) {
    if (gm > 1.0e10) gm *= 1.0e-9;      // m^3/s^2 -> km^3/s^2
    if (radius > 1.0e5) radius *= 1.0e-3;  // m -> km
}

}  // namespace

GravityFileLoadResult loadGravityField(const std::string& content,
                                       uint16_t maxDegree,
                                       uint16_t maxOrder,
                                       GravityFileFormat format) {
    GravityFileLoadResult res;
    const std::vector<std::string> lines = splitLines(content);

    if (format == GravityFileFormat::Auto) {
        for (const std::string& raw : lines) {
            const std::string tok = lowerTrim(firstToken(raw));
            if (tok == "gfc" || tok == "gfct" || tok == "end_of_head" ||
                tok == "earth_gravity_constant" || tok == "product_type") {
                format = GravityFileFormat::ICGEM;
                break;
            }
            if (tok == "recoef" || tok == "potfield") {
                format = GravityFileFormat::COF;
                break;
            }
        }
    }
    if (format == GravityFileFormat::Auto) {
        res.status = GravityFileStatus::UnknownFormat;
        res.detail = "content matched neither an ICGEM nor a fixed-column record set";
        return res;
    }
    res.format = format;

    double gm = 0.0, radius = 0.0;
    uint16_t declaredMax = 0;
    // (degree, order) -> (C, S). Ordered so the highest degree present is
    // discoverable without a second pass.
    std::vector<std::array<double, 4>> records;  // n, m, C, S
    records.reserve(4096);

    for (const std::string& raw : lines) {
        const std::string key = lowerTrim(firstToken(raw));
        if (key.empty() || key[0] == '#' || key[0] == '!') continue;

        if (format == GravityFileFormat::ICGEM) {
            if (key == "modelname") {
                std::vector<std::string> parts;
                std::istringstream is(raw);
                std::string w;
                while (is >> w) parts.push_back(w);
                if (parts.size() > 1) res.modelName = parts[1];
                continue;
            }
            if (key == "tide_system") {
                std::istringstream is(raw);
                std::string w;
                is >> w;
                if (is >> w) res.tideSystem = w;
                continue;
            }
            if (key == "earth_gravity_constant" || key == "gravity_constant") {
                auto v = scanNumbers(raw.substr(key.size()));
                if (!v.empty()) gm = v[0];
                continue;
            }
            if (key == "radius" || key == "reference_radius") {
                auto v = scanNumbers(raw.substr(key.size()));
                if (!v.empty()) radius = v[0];
                continue;
            }
            if (key == "max_degree") {
                auto v = scanNumbers(raw.substr(key.size()));
                if (!v.empty()) declaredMax = static_cast<uint16_t>(v[0]);
                continue;
            }
            if (key != "gfc" && key != "gfct") continue;

            // `gfc n m C S [sigC sigS]`; `gfct` adds a reference epoch that we
            // read as the static part, which is what a fixed-epoch propagation
            // wants.
            auto v = scanNumbers(raw.substr(key.size()));
            if (v.size() < 4) {
                res.status = GravityFileStatus::MalformedRecord;
                res.detail = "coefficient record with fewer than four fields: " + raw;
                return res;
            }
            records.push_back({v[0], v[1], v[2], v[3]});
            continue;
        }

        // Fixed-column encoding.
        if (key == "potfield" || key == "potfieldm") {
            // `POTFIELD <deg> <ord> [flags...] <GM> <Re> [...]`. The flag
            // fields between the order and GM vary between producers, so the
            // header is read by MAGNITUDE rather than by position: a degree or
            // a flag is a small integer and a gravitational constant is not.
            auto v = scanNumbers(raw.substr(key.size()));
            if (!v.empty()) declaredMax = static_cast<uint16_t>(v[0]);
            for (size_t i = 2; i < v.size(); i++) {
                if (std::abs(v[i]) < 1.0e4) continue;
                gm = v[i];
                if (i + 1 < v.size()) radius = v[i + 1];
                break;
            }
            continue;
        }
        if (key != "recoef") continue;
        auto v = scanNumbers(raw.substr(key.size()));
        if (v.size() < 3) {
            res.status = GravityFileStatus::MalformedRecord;
            res.detail = "coefficient record with fewer than three fields: " + raw;
            return res;
        }
        // A zonal record may omit S entirely.
        records.push_back({v[0], v[1], v[2], v.size() > 3 ? v[3] : 0.0});
    }

    if (records.empty()) {
        res.status = GravityFileStatus::Empty;
        res.detail = "no coefficient records";
        return res;
    }

    uint16_t filePresentMax = 0;
    for (const auto& r : records) {
        filePresentMax = std::max(filePresentMax, static_cast<uint16_t>(r[0]));
    }
    res.fileMaxDegree = std::max(filePresentMax, declaredMax);
    res.recordsRead = records.size();

    if (gm <= 0.0 || radius <= 0.0) {
        res.status = GravityFileStatus::MissingHeader;
        res.detail = "file declares no gravitational constant and/or reference radius";
        return res;
    }
    normalizeFieldUnits(gm, radius);

    uint16_t deg = maxDegree > 0 ? std::min<uint16_t>(maxDegree, filePresentMax)
                                 : filePresentMax;
    deg = std::min<uint16_t>(deg, static_cast<uint16_t>(MAX_GRAVITY_DEGREE));
    uint16_t ord = maxOrder > 0 ? std::min<uint16_t>(maxOrder, deg) : deg;

    ExtendedGravityField& field = res.field;
    field.model = GravityModelType::Custom;
    field.mu = gm;
    field.referenceRadius = radius;
    field.normalized = true;
    field.allocate(deg, ord);
    field.Cnm[0][0] = 1.0;

    for (const auto& r : records) {
        const int n = static_cast<int>(r[0]);
        const int m = static_cast<int>(r[1]);
        if (n < 0 || m < 0 || m > n) continue;
        if (n > deg || m > ord) continue;
        if (n == 0 && m == 0) continue;  // C00 is the normalization, not data
        field.Cnm[n][m] = r[2];
        field.Snm[n][m] = r[3];
    }

    res.status = GravityFileStatus::Ok;
    return res;
}

namespace ForceModel {

Vec3 LoadedFieldGravity(const Vec3& position, const ExtendedGravityField& field) {
    return computeExtendedGravity(position, field, 0.0).total;
}

}  // namespace ForceModel

// =============================================================================
// 8.6.1c Polyhedron gravity — Werner & Scheeres (1997)               (gmat-07)
// =============================================================================

/// Newton's constant in the module's units: km^3 kg^-1 s^-2 (CODATA 2018).
static constexpr double G_KM3_PER_KG_S2 = 6.67430e-20;

double PolyhedronShape::volume() const {
    // Divergence theorem over the triangulation: each face contributes the
    // signed volume of the tetrahedron it makes with the origin.
    double v = 0.0;
    for (const auto& f : faces) {
        const Vec3& a = vertices[f[0]];
        const Vec3& b = vertices[f[1]];
        const Vec3& c = vertices[f[2]];
        v += a.dot(b.cross(c));
    }
    return v / 6.0;
}

PolyhedronShape makeBoxPolyhedron(double hx, double hy, double hz, double density) {
    PolyhedronShape s;
    s.density = density;
    s.vertices = {
        {-hx, -hy, -hz}, {+hx, -hy, -hz}, {+hx, +hy, -hz}, {-hx, +hy, -hz},
        {-hx, -hy, +hz}, {+hx, -hy, +hz}, {+hx, +hy, +hz}, {-hx, +hy, +hz},
    };
    // Every face wound counter-clockwise seen from OUTSIDE.
    s.faces = {
        {0, 3, 2}, {0, 2, 1},   // -z
        {4, 5, 6}, {4, 6, 7},   // +z
        {0, 1, 5}, {0, 5, 4},   // -y
        {2, 3, 7}, {2, 7, 6},   // +y
        {1, 2, 6}, {1, 6, 5},   // +x
        {0, 4, 7}, {0, 7, 3},   // -x
    };
    return s;
}

PolyhedronGravityResult computePolyhedronGravity(const Vec3& fieldPoint,
                                                 const PolyhedronShape& shape) {
    PolyhedronGravityResult out;
    const size_t nF = shape.faces.size();
    if (shape.vertices.empty() || nF == 0) return out;

    // ---- Face normals -------------------------------------------------------
    std::vector<Vec3> normals(nF);
    for (size_t i = 0; i < nF; i++) {
        const auto& f = shape.faces[i];
        const Vec3 e1 = shape.vertices[f[1]] - shape.vertices[f[0]];
        const Vec3 e2 = shape.vertices[f[2]] - shape.vertices[f[0]];
        normals[i] = e1.cross(e2).normalized();
    }

    // ---- Face sum: solid angles --------------------------------------------
    // Sum_f F_f r_f omega_f, with F_f = n_f (x) n_f.
    Vec3 faceAcc;
    double facePot = 0.0;
    double omegaSum = 0.0;

    for (size_t i = 0; i < nF; i++) {
        const auto& f = shape.faces[i];
        const Vec3 r1 = shape.vertices[f[0]] - fieldPoint;
        const Vec3 r2 = shape.vertices[f[1]] - fieldPoint;
        const Vec3 r3 = shape.vertices[f[2]] - fieldPoint;
        const double R1 = r1.magnitude(), R2 = r2.magnitude(), R3 = r3.magnitude();

        // Van Oosterom & Strackee: the signed solid angle of a triangle seen
        // from the origin. atan2 keeps it continuous across the half-turn where
        // an atan form flips sign.
        const double num = r1.dot(r2.cross(r3));
        const double den = R1 * R2 * R3 + R1 * r2.dot(r3) + R2 * r3.dot(r1) +
                           R3 * r1.dot(r2);
        const double omega = 2.0 * std::atan2(num, den);
        omegaSum += omega;

        // r_f: field point to any point of the face plane.
        const double rn = r1.dot(normals[i]);
        faceAcc += normals[i] * (rn * omega);
        facePot += rn * rn * omega;
    }

    // ---- Edge sum: edge dyads ----------------------------------------------
    // Each undirected edge is shared by exactly two faces in a closed mesh.
    // Walk the directed edges and pair (a,b) with (b,a).
    struct DirectedEdge { int a, b; size_t face; };
    std::vector<DirectedEdge> directed;
    directed.reserve(nF * 3);
    for (size_t i = 0; i < nF; i++) {
        const auto& f = shape.faces[i];
        directed.push_back({f[0], f[1], i});
        directed.push_back({f[1], f[2], i});
        directed.push_back({f[2], f[0], i});
    }

    Vec3 edgeAcc;
    double edgePot = 0.0;

    for (const DirectedEdge& e : directed) {
        if (e.a > e.b) continue;  // take each undirected edge once
        // Its partner is the reversed directed edge.
        size_t other = SIZE_MAX;
        for (const DirectedEdge& o : directed) {
            if (o.a == e.b && o.b == e.a) { other = o.face; break; }
        }
        if (other == SIZE_MAX) {
            // Not a closed mesh; refuse rather than answer with an open surface.
            return out;
        }

        const Vec3 va = shape.vertices[e.a];
        const Vec3 vb = shape.vertices[e.b];
        const Vec3 edge = vb - va;
        const double eLen = edge.magnitude();
        if (eLen <= 0.0) continue;
        const Vec3 eHat = edge / eLen;

        // In-plane edge normals, each pointing OUT of its own face.
        // Face A traverses a->b, so n_A x e_hat points away from A's interior.
        const Vec3& nA = normals[e.face];
        const Vec3& nB = normals[other];
        const Vec3 nAB = eHat.cross(nA);
        const Vec3 nBA = (-eHat).cross(nB);

        const Vec3 ra = va - fieldPoint;
        const Vec3 rb = vb - fieldPoint;
        const double Ra = ra.magnitude(), Rb = rb.magnitude();

        const double denom = Ra + Rb - eLen;
        if (denom <= 0.0) continue;  // field point on the edge line
        const double Le = std::log((Ra + Rb + eLen) / denom);

        // E_e = n_A (x) n_AB + n_B (x) n_BA, applied to r_e = ra.
        const Vec3 Ee_r = nA * (nAB.dot(ra)) + nB * (nBA.dot(ra));
        edgeAcc += Ee_r * Le;
        edgePot += ra.dot(Ee_r) * Le;
    }

    const double Gsigma = G_KM3_PER_KG_S2 * shape.density;
    out.potential = 0.5 * Gsigma * (edgePot - facePot);
    out.acceleration = (edgeAcc - faceAcc) * (-Gsigma);
    out.laplacian = -Gsigma * omegaSum;
    out.valid = true;
    return out;
}

// =============================================================================
// 8.6.4b Atmosphere label honesty                                    (gmat-07)
// =============================================================================

AtmosphereImplementation atmosphereImplementationOf(AtmosphereModelType model) {
    switch (model) {
        case AtmosphereModelType::Exponential:
        case AtmosphereModelType::USSA1976:
        case AtmosphereModelType::NRLMSISE00:
        case AtmosphereModelType::HarrisPriester:
        case AtmosphereModelType::JB2008:
            return AtmosphereImplementation::Published;
        case AtmosphereModelType::DTM2020:
        case AtmosphereModelType::GOST2004:
        default:
            return AtmosphereImplementation::NotImplemented;
    }
}

const char* atmosphereModelName(AtmosphereModelType model) {
    switch (model) {
        case AtmosphereModelType::Exponential:    return "Exponential";
        case AtmosphereModelType::USSA1976:       return "USSA1976";
        case AtmosphereModelType::NRLMSISE00:     return "NRLMSISE00";
        case AtmosphereModelType::JB2008:         return "JB2008";
        case AtmosphereModelType::DTM2020:        return "DTM2020";
        case AtmosphereModelType::GOST2004:       return "GOST2004";
        case AtmosphereModelType::HarrisPriester: return "HarrisPriester";
    }
    return "Unknown";
}

const char* atmosphereModelProvenance(AtmosphereModelType model) {
    switch (model) {
        case AtmosphereModelType::Exponential:
            return "Vallado, Fundamentals of Astrodynamics and Applications, Table 8-4";
        case AtmosphereModelType::USSA1976:
            return "U.S. Standard Atmosphere 1976, 0-86 km";
        case AtmosphereModelType::NRLMSISE00:
            return "NRLMSISE-00 gtd7d, full model, vendored reference C port";
        case AtmosphereModelType::HarrisPriester:
            return "Harris-Priester modified-exponential table, 100-1000 km, "
                   "mean solar activity";
        case AtmosphereModelType::JB2008:
            return "Jacchia-Bowman 2008 (Bowman et al., AIAA 2008-6438), port of "
                   "Orekit 13.1's JB2008 (lib/jb2008.h); drivers from "
                   "plugin_set_jb2008_indices";
        case AtmosphereModelType::DTM2020:
            return "not implemented: only a simplified stand-in exists, which is "
                   "not the published spherical-harmonic coefficient model";
        case AtmosphereModelType::GOST2004:
            return "not implemented: no implementation exists; the label "
                   "previously fell through to a different model";
    }
    return "unknown label";
}

namespace {

/// Harris-Priester tabulated density bounds at mean solar activity.
/// Altitude (km), minimum ("antapex") and maximum ("apex") density in
/// g/km^3 — the published units; 1 g/km^3 = 1e-12 kg/m^3.
struct HPRow { double h, rmin, rmax; };
constexpr HPRow HP_TABLE[] = {
    {100.0, 4.974e+05, 4.974e+05}, {120.0, 2.490e+04, 2.490e+04},
    {130.0, 8.377e+03, 8.710e+03}, {140.0, 3.899e+03, 4.059e+03},
    {150.0, 2.122e+03, 2.215e+03}, {160.0, 1.263e+03, 1.344e+03},
    {170.0, 8.008e+02, 8.758e+02}, {180.0, 5.283e+02, 6.010e+02},
    {190.0, 3.617e+02, 4.297e+02}, {200.0, 2.557e+02, 3.162e+02},
    {210.0, 1.839e+02, 2.396e+02}, {220.0, 1.341e+02, 1.853e+02},
    {230.0, 9.949e+01, 1.455e+02}, {240.0, 7.488e+01, 1.157e+02},
    {250.0, 5.709e+01, 9.308e+01}, {260.0, 4.403e+01, 7.555e+01},
    {270.0, 3.430e+01, 6.182e+01}, {280.0, 2.697e+01, 5.095e+01},
    {290.0, 2.139e+01, 4.226e+01}, {300.0, 1.708e+01, 3.526e+01},
    {320.0, 1.099e+01, 2.511e+01}, {340.0, 7.214e+00, 1.819e+01},
    {360.0, 4.824e+00, 1.337e+01}, {380.0, 3.274e+00, 9.955e+00},
    {400.0, 2.249e+00, 7.492e+00}, {420.0, 1.558e+00, 5.684e+00},
    {440.0, 1.091e+00, 4.355e+00}, {460.0, 7.701e-01, 3.362e+00},
    {480.0, 5.474e-01, 2.612e+00}, {500.0, 3.916e-01, 2.042e+00},
    {520.0, 2.819e-01, 1.605e+00}, {540.0, 2.042e-01, 1.267e+00},
    {560.0, 1.488e-01, 1.005e+00}, {580.0, 1.092e-01, 7.997e-01},
    {600.0, 8.070e-02, 6.390e-01}, {620.0, 6.012e-02, 5.123e-01},
    {640.0, 4.519e-02, 4.121e-01}, {660.0, 3.430e-02, 3.325e-01},
    {680.0, 2.632e-02, 2.691e-01}, {700.0, 2.043e-02, 2.185e-01},
    {720.0, 1.607e-02, 1.779e-01}, {740.0, 1.281e-02, 1.452e-01},
    {760.0, 1.036e-02, 1.190e-01}, {780.0, 8.496e-03, 9.776e-02},
    {800.0, 7.069e-03, 8.059e-02}, {840.0, 4.680e-03, 5.741e-02},
    {880.0, 3.200e-03, 4.210e-02}, {920.0, 2.210e-03, 3.130e-02},
    {960.0, 1.560e-03, 2.360e-02}, {1000.0, 1.150e-03, 1.810e-02},
};
constexpr int HP_ROWS = static_cast<int>(sizeof(HP_TABLE) / sizeof(HP_TABLE[0]));

/// The diurnal bulge lags the sub-solar point by this much in right ascension.
constexpr double HP_BULGE_LAG_RAD = 30.0 * PI / 180.0;

/// g/km^3 -> kg/m^3
constexpr double HP_UNIT = 1.0e-12;

}  // namespace

int harrisPriesterTableSize() { return HP_ROWS; }

void harrisPriesterTableRow(int i, double& altitudeKm, double& rhoMin, double& rhoMax) {
    if (i < 0 || i >= HP_ROWS) { altitudeKm = rhoMin = rhoMax = 0.0; return; }
    altitudeKm = HP_TABLE[i].h;
    rhoMin = HP_TABLE[i].rmin * HP_UNIT;
    rhoMax = HP_TABLE[i].rmax * HP_UNIT;
}

AtmosphericDensity computeHarrisPriester(const Vec3& position,
                                         const Vec3& sunPositionBodyFixed,
                                         double n) {
    AtmosphericDensity out;

    double lat, lon, alt;
    ecefToGeodetic(position, lat, lon, alt);
    out.latitude = lat;
    out.longitude = lon;
    out.altitude = alt;

    // The table has support from 100 to 1000 km and nothing outside it. A
    // model asked for a value it does not have returns zero as a REFUSAL to
    // extrapolate — not an assertion that the density is zero.
    //
    // The 1 mm tolerance is floating point, not extrapolation: a geodetic
    // altitude computed from a Cartesian position lands a few ulp either side
    // of a table endpoint, and refusing the boundary itself would make the
    // model's own tabulated values unreachable.
    constexpr double kEdgeToleranceKm = 1.0e-6;
    if (alt < HP_TABLE[0].h - kEdgeToleranceKm ||
        alt > HP_TABLE[HP_ROWS - 1].h + kEdgeToleranceKm) {
        return out;
    }
    alt = std::max(HP_TABLE[0].h, std::min(HP_TABLE[HP_ROWS - 1].h, alt));

    int i = 0;
    while (i < HP_ROWS - 2 && HP_TABLE[i + 1].h <= alt) i++;
    const HPRow& lo = HP_TABLE[i];
    const HPRow& hi = HP_TABLE[i + 1];

    // Scale heights from the tabulated bounds, then the published exponential
    // interpolation within the layer.
    const double Hmin = (lo.h - hi.h) / std::log(hi.rmin / lo.rmin);
    const double Hmax = (lo.h - hi.h) / std::log(hi.rmax / lo.rmax);
    const double rhoMin = lo.rmin * std::exp((lo.h - alt) / Hmin);
    const double rhoMax = lo.rmax * std::exp((lo.h - alt) / Hmax);

    // Diurnal bulge: the apex direction is the sun direction advanced in right
    // ascension by the lag, at the sun's declination.
    const double sunR = sunPositionBodyFixed.magnitude();
    double cosPsi = 0.0;
    if (sunR > 0.0) {
        const double ra = std::atan2(sunPositionBodyFixed.y, sunPositionBodyFixed.x) +
                          HP_BULGE_LAG_RAD;
        const double dec = std::asin(sunPositionBodyFixed.z / sunR);
        const Vec3 apex(std::cos(dec) * std::cos(ra),
                        std::cos(dec) * std::sin(ra),
                        std::sin(dec));
        cosPsi = position.normalized().dot(apex);
    }
    // cos^n(psi/2), written through the half-angle identity so the branch at
    // psi = pi is exact rather than a cancellation.
    const double half = std::max(0.0, 0.5 * (1.0 + cosPsi));
    const double weight = std::pow(half, 0.5 * n);

    out.density = (rhoMin + (rhoMax - rhoMin) * weight) * HP_UNIT;
    out.scaleHeight = Hmin;
    out.localSolarTime = computeLocalSolarTime(lon, 0.0);
    return out;
}

// =============================================================================
// 8.6.4c SPAD area tables                                            (gmat-07)
// =============================================================================

SpadLoadResult loadSpadFile(const std::string& content) {
    SpadLoadResult res;
    SpadTable& t = res.table;
    std::vector<std::vector<double>> rows;

    bool inData = false;
    for (const std::string& raw : splitLines(content)) {
        const std::string key = lowerTrim(firstToken(raw));
        if (key.empty() || key[0] == '#') continue;

        if (!inData) {
            if (key == "data") { inData = true; continue; }
            if (key == "name") {
                std::istringstream is(raw);
                std::string w; is >> w;
                if (is >> w) t.name = w;
                continue;
            }
            if (key == "quantity" || key == "spad_quantity") {
                const std::string v = lowerTrim(raw.substr(raw.find_first_of(" \t")));
                if (v.find("drag") != std::string::npos) t.quantity = SpadQuantity::DragArea;
                else if (v.find("srp") != std::string::npos ||
                         v.find("solar") != std::string::npos) t.quantity = SpadQuantity::SrpArea;
                continue;
            }
            if (key == "mass") {
                auto v = scanNumbers(raw.substr(key.size()));
                if (!v.empty()) t.mass = v[0];
                continue;
            }
            if (key == "azimuth") { t.azimuthDeg = scanNumbers(raw.substr(key.size()), 4096); continue; }
            if (key == "elevation") { t.elevationDeg = scanNumbers(raw.substr(key.size()), 4096); continue; }
            continue;
        }
        rows.push_back(scanNumbers(raw, 4096));
    }

    if (t.azimuthDeg.empty() || t.elevationDeg.empty()) {
        res.status = SpadFileStatus::MissingGrid;
        res.detail = "file declares no AZIMUTH and/or ELEVATION axis";
        return res;
    }
    if (rows.empty()) {
        res.status = SpadFileStatus::Empty;
        res.detail = "no DATA rows";
        return res;
    }
    if (rows.size() != t.elevationDeg.size()) {
        res.status = SpadFileStatus::RaggedTable;
        res.detail = "DATA row count does not match the ELEVATION axis";
        return res;
    }
    for (const auto& r : rows) {
        if (r.size() != t.azimuthDeg.size()) {
            res.status = SpadFileStatus::RaggedTable;
            res.detail = "a DATA row does not match the AZIMUTH axis";
            return res;
        }
        t.values.insert(t.values.end(), r.begin(), r.end());
    }

    res.status = SpadFileStatus::Ok;
    return res;
}

double spadInterpolate(const SpadTable& table, double azimuthDeg, double elevationDeg) {
    if (!table.valid()) return 0.0;
    const size_t nA = table.azimuthDeg.size();
    const size_t nE = table.elevationDeg.size();

    auto bracket = [](const std::vector<double>& axis, double v, size_t& i, double& f) {
        if (v <= axis.front() || axis.size() == 1) { i = 0; f = 0.0; return; }
        if (v >= axis.back()) { i = axis.size() - 2; f = 1.0; return; }
        i = 0;
        while (i + 2 < axis.size() && axis[i + 1] <= v) i++;
        const double span = axis[i + 1] - axis[i];
        // A repeated axis value has no interior; take the lower node rather
        // than dividing by zero.
        f = span > 0.0 ? (v - axis[i]) / span : 0.0;
    };

    size_t ia = 0, ie = 0;
    double fa = 0.0, fe = 0.0;
    bracket(table.azimuthDeg, azimuthDeg, ia, fa);
    bracket(table.elevationDeg, elevationDeg, ie, fe);

    const size_t ia1 = std::min(ia + 1, nA - 1);
    const size_t ie1 = std::min(ie + 1, nE - 1);
    const double v00 = table.values[ie * nA + ia];
    const double v10 = table.values[ie * nA + ia1];
    const double v01 = table.values[ie1 * nA + ia];
    const double v11 = table.values[ie1 * nA + ia1];

    // Written so that a node's exact value survives unaltered: at fa = fe = 0
    // this is v00 with no arithmetic applied to it at all.
    const double bottom = v00 + (v10 - v00) * fa;
    const double top    = v01 + (v11 - v01) * fa;
    return bottom + (top - bottom) * fe;
}

void spadDirectionToAzEl(const Vec3& d, double& azimuthDeg, double& elevationDeg) {
    const double m = d.magnitude();
    if (m <= 0.0) { azimuthDeg = elevationDeg = 0.0; return; }
    azimuthDeg = std::atan2(d.y, d.x) * 180.0 / PI;
    if (azimuthDeg < 0.0) azimuthDeg += 360.0;
    elevationDeg = std::asin(std::max(-1.0, std::min(1.0, d.z / m))) * 180.0 / PI;
}

// =============================================================================
// Schatten-class predicted solar activity                            (gmat-07)
// =============================================================================

const std::vector<SolarActivityPrediction>&
SolarActivityPredictionTable::band(SolarActivityBand b) const {
    switch (b) {
        case SolarActivityBand::Early: return early;
        case SolarActivityBand::Late:  return late;
        case SolarActivityBand::Nominal:
        default: return nominal;
    }
}

PredictionLoadResult loadSolarActivityPredictions(const std::string& content) {
    PredictionLoadResult res;
    SolarActivityPredictionTable& t = res.table;

    for (const std::string& raw : splitLines(content)) {
        const std::string key = lowerTrim(firstToken(raw));
        if (key.empty() || key[0] == '#') continue;
        if (key == "name") {
            std::istringstream is(raw);
            std::string w; is >> w;
            if (is >> w) t.name = w;
            continue;
        }

        std::istringstream is(raw);
        std::string yearTok, monthTok, bandTok;
        if (!(is >> yearTok >> monthTok >> bandTok)) {
            res.status = PredictionFileStatus::MalformedRecord;
            res.detail = "record is not `<year> <month> <band> <f107> <f107a> <ap>`: " + raw;
            return res;
        }
        double f107 = 0, f107a = 0, ap = 0;
        if (!(is >> f107 >> f107a >> ap)) {
            res.status = PredictionFileStatus::MalformedRecord;
            res.detail = "record carries fewer than three index values: " + raw;
            return res;
        }

        const int year = std::atoi(yearTok.c_str());
        const int month = std::atoi(monthTok.c_str());
        if (month < 1 || month > 12) {
            res.status = PredictionFileStatus::MalformedRecord;
            res.detail = "month out of range: " + raw;
            return res;
        }

        SolarActivityPrediction p;
        // Mid-month sample, the published cadence's own convention.
        p.epoch = gregorianToJulianDay(year, month, 15);
        p.f107 = f107;
        p.f107a = f107a;
        p.ap = ap;

        const std::string band = lowerTrim(bandTok);
        std::vector<SolarActivityPrediction>* dest =
            band == "early" ? &t.early : band == "late" ? &t.late :
            band == "nominal" ? &t.nominal : nullptr;
        if (!dest) {
            res.status = PredictionFileStatus::MalformedRecord;
            res.detail = "band is not EARLY / NOMINAL / LATE: " + raw;
            return res;
        }
        if (!dest->empty() && p.epoch <= dest->back().epoch) {
            res.status = PredictionFileStatus::NotMonotonic;
            res.detail = "samples are not ascending in epoch within a band";
            return res;
        }
        dest->push_back(p);
    }

    if (t.empty()) {
        res.status = PredictionFileStatus::Empty;
        res.detail = "no prediction records";
        return res;
    }
    res.status = PredictionFileStatus::Ok;
    return res;
}

bool predictSolarActivityAt(const SolarActivityPredictionTable& table,
                            SolarActivityBand band,
                            double jd,
                            SolarActivityPrediction& out) {
    const std::vector<SolarActivityPrediction>& s = table.band(band);
    if (s.empty()) return false;  // a refusal, not a default

    if (jd <= s.front().epoch) { out = s.front(); out.epoch = jd; return true; }
    if (jd >= s.back().epoch)  { out = s.back();  out.epoch = jd; return true; }

    size_t i = 0;
    while (i + 2 < s.size() && s[i + 1].epoch <= jd) i++;
    const SolarActivityPrediction& a = s[i];
    const SolarActivityPrediction& b = s[i + 1];
    const double span = b.epoch - a.epoch;
    const double f = span > 0.0 ? (jd - a.epoch) / span : 0.0;

    out.epoch = jd;
    out.f107  = a.f107  + (b.f107  - a.f107)  * f;
    out.f107a = a.f107a + (b.f107a - a.f107a) * f;
    out.ap    = a.ap    + (b.ap    - a.ap)    * f;
    return true;
}

} // namespace astro
