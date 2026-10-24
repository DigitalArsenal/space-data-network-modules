#pragma once
// The Moon and Mars as central bodies: their embedded harmonic gravity fields, their body-fixed axes, and the
// constants a force set needs about them. One unit holds everything FFM knows about a planet other than the Earth.
//
//   Moon (NAIF 301)  GRGM660PRIM (Lemoine et al. 2013, doi:10.1002/jgre.20118), degree and order 660, fully
//                    normalized, reference radius 1738.0 km, in the principal-axes frame; the axes are DE440's
//                    lunar libration (Park et al. 2021), the Chebyshev records of moon_pa_de440_200625.bpc for
//                    2000-01-01 to 2050-01-01.
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
};
FieldInfo fieldInfo(int naifId);

/// The embedded field truncated to `degree` and `order`, with the tesseral and sectorial terms (order >= 1) of
/// degrees above `tesseralDegree` zeroed (as the Earth fields' "mmZ,nnT"). Cached until the selection changes.
/// Degree 2 to the embedded degree, order 0 to the degree.
const ExtendedGravityField& embeddedField(int naifId, int degree, int order, int tesseralDegree);

/// True when the body's orientation model holds the instant (the Moon's libration covers 2000 to 2050).
bool orientationCovers(int naifId, const timesys::Instant& tt);

/// The rotation GCRF -> body-fixed (row-major) at a two-part TT instant. False outside the orientation
/// model's span (m is then the identity).
bool bodyFixedRotation(int naifId, const timesys::Instant& tt, double m[3][3]);

} // namespace planetary
} // namespace astro
