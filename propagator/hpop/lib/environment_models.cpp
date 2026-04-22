// environment_models.cpp - Phase 8.6 Environment Models Implementation
// =============================================================================
// High-fidelity environment models for precision orbit determination and
// propagation. Implements EGM2008, GRGM1200A, JPL ephemerides, SRP,
// advanced atmosphere models, and space weather integration.
// =============================================================================

#include "environment_models.h"
#include "egm2008_data.h"
#include "astrodynamics.h"
#include <cmath>
#include <algorithm>
#include <numeric>

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
    field.mu = MU_EARTH;
    field.referenceRadius = RE_EARTH;
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

    // Column recursion: V̄[n][m] for m <= n-2
    // Normalized factors α, β from fully normalized ALF recursion
    for (int m = 0; m <= std::min(maxOrder, maxDegree); m++) {
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
                harmonicAcc.y += muR2 * 0.5 * (
                    gp * (Snm * V[n+1][m+1] - Cnm * W[n+1][m+1])
                    + fgm * (Cnm * W[n+1][m-1] - Snm * V[n+1][m-1])
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

} // namespace astro
