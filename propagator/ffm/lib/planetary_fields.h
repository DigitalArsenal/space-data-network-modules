#pragma once
// The Moon and Mars as central bodies: their embedded harmonic gravity fields, their body-fixed axes, and the
// constants a force set needs about them. One unit holds everything FFM knows about a planet other than the Earth.
//
//   Moon (NAIF 301)  GRGM660PRIM (Lemoine et al. 2013, doi:10.1002/jgre.20118), degree and order 660 of which the
//                    default artifact embeds the first lib/data/planetary/grgm660prim.bin's degree (the size
//                    budget; a request above it is refused by name), fully normalized, reference radius 1738.0
//                    km, in the principal-axes frame; the axes are DE440's lunar libration (Park et al. 2021),
//                    the Chebyshev records of moon_pa_de440_200625.bpc for the window in the data file.
//   Mars (NAIF 499)  MRO120F (Konopliv et al. 2020, doi:10.1029/2020GL090568), degree and order 120, fully
//                    normalized, reference radius 3396.0 km, in the Mars-fixed frame its PDS label defines by
//                    Euler angles (N, J fixed; PSI, I secular; PHI secular plus seasonal spin terms).
//
// The data are lib/data/planetary/*.bin, reduced from the pinned public sources by
// scripts/generate-planetary-data.mjs (provenance in lib/data/planetary/SOURCES.json).
#include "environment_models.h"
#include "time_types.h"

namespace astro {
namespace planetary {

constexpr int MOON = 301;
constexpr int MARS = 499;

/// A central body with an embedded field and orientation model.
bool supportedCentralBody(int naifId);
const char* bodyName(int naifId);

/// The radius of the body's occulting disk and of its surface for the impact stop (km): the IAU 2015 mean
/// radius of the Moon (1737.4 km) and the equatorial radius of Mars (3396.19 km).
double bodyRadiusKm(int naifId);

/// The NAIF ID whose ephemeris position stands for the body's center in a DE440 short kernel, which carries
/// the Mars system barycenter (4) and not Mars's center; the two differ by under 0.2 m (Phobos and Deimos).
int kernelCenterId(int naifId);

/// GM (km^3/s^2) of a third body by NAIF ID, DE440's (gm_de440.tpc): the Sun 10, the planets' systems 1-9
/// (Earth 399 and the Moon 301 separately). Negative for an ID with no entry.
double thirdBodyGmKm3S2(int naifId);

struct FieldInfo {
    double gmKm3S2 = 0;           ///< the field's own GM, which scales its harmonics
    double referenceRadiusKm = 0;
    int degree = 0;               ///< highest degree (and order) embedded
    int sourceDegree = 0;         ///< the published field's degree (GRGM660PRIM: 660, of which `degree` is embedded)
    const char* name = "";        ///< the published field's name
};
FieldInfo fieldInfo(int naifId);

/// The embedded field truncated to `degree` and `order`, with the tesseral and sectorial terms (order >= 1) of
/// degrees above `tesseralDegree` zeroed (as the Earth fields' "mmZ,nnT"). Cached until the selection changes.
/// Degree 2 to the embedded degree, order 0 to the degree.
const ExtendedGravityField& embeddedField(int naifId, int degree, int order, int tesseralDegree);

/// Mars's banded-exponential atmosphere (lib/mars_atmosphere_data.h, the table NASA GMAT R2026a ships; the model
/// form is Vallado 8.6): the density (kg/m^3) at an altitude above the reference ellipsoid (km), rho_i exp(-(h - h_i)/H_i)
/// in the band whose bottom h_i is the highest at or below h; below the table's first band the first band answers, above
/// its last the last band continues. A single mean profile: no solar-cycle, seasonal, diurnal, latitude or dust variation.
double marsDensityKgM3(double altitudeKm);

/// The altitude (km) of a Mars-fixed position (km) above Mars's reference ellipsoid (radii 3396.19 and 3376.20 km,
/// NAIF pck00011.tpc): the position's distance minus the ellipsoid's radius at its geocentric latitude.
double marsAltitudeKm(double x, double y, double z);

/// The body's spin rate about its pole (rad/s): Mars's 350.891985314 degrees a day of the MRO120F frame.
double spinRateRadPerSec(int naifId);

/// The span the body's orientation model covers, TDB seconds past J2000 (the Moon's embedded libration records; Mars's
/// label model has none). False for a body whose model is not bounded.
bool orientationSpan(int naifId, double& startSeconds, double& stopSeconds);

/// True when the body's orientation model holds the instant (the Moon's libration covers 2000 to 2050).
bool orientationCovers(int naifId, const timesys::Instant& tt);

/// The rotation GCRF -> body-fixed (row-major) at a two-part TT instant. False outside the orientation
/// model's span (m is then the identity).
bool bodyFixedRotation(int naifId, const timesys::Instant& tt, double m[3][3]);

} // namespace planetary
} // namespace astro
