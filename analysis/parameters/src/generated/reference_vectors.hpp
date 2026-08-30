// GENERATED FILE — DO NOT EDIT.
//
// Source of truth : fixtures/orekit-vectors.json
// Generator       : generate-reference-vectors.mjs
// Authority       : https://github.com/CS-SI/Orekit @ main
//
//   src/test/java/org/orekit/orbits/KeplerianOrbitTest.java
//   src/test/java/org/orekit/orbits/EquinoctialOrbitTest.java
//   src/test/java/org/orekit/bodies/OneAxisEllipsoidTest.java

#ifndef SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP
#define SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP

namespace sdn {
namespace parameters {
namespace reference {

// KeplerianOrbitTest.testKeplerianToCartesian
constexpr double kKeplerianMu = 398600470000000.0;
constexpr double kKeplerianSemiMajorAxis = 24464560.0;
constexpr double kKeplerianEccentricity = 0.7311;
constexpr double kKeplerianInclination = 0.122138;
constexpr double kKeplerianRaan = 1.00681;
constexpr double kKeplerianArgumentOfPeriapsis = 3.10686;
constexpr double kKeplerianMeanAnomaly = 0.048363;
constexpr double kKeplerianPosition[3] = {-1076225.32467967, -6765896.36432773, -332308.783350379};
constexpr double kKeplerianVelocity[3] = {9356.85775154103, -3312.34775037644, -1188.01577532701};

// KeplerianOrbitTest.testKeplerianToEquinoctial (the same orbit)
constexpr double kEquinoctialEx = -0.412036802887626;
constexpr double kEquinoctialEy = -0.603931190671706;
constexpr double kEquinoctialMeanLongitude = 4.162033;
constexpr double kEquinoctialInclinationIx = 0.0652494417368829;
constexpr double kEquinoctialInclinationIy = 0.103158450084864;

// EquinoctialOrbitTest.testEquinoctialToCartesian
constexpr double kGeoMu = 398600470000000.0;
constexpr double kGeoSemiMajorAxis = 42166712.0;
constexpr double kGeoEx = -0.0000079;
constexpr double kGeoEy = 0.00011;
constexpr double kGeoIx = 0.00012;
constexpr double kGeoIy = -0.000116;
constexpr double kGeoMeanLongitude = 5.3;
constexpr double kGeoPosition[3] = {23374566.8678733, -35099891.4352669, -1500.53723123334};
constexpr double kGeoVelocity[3] = {2558.7096558809967, 1704.1586039092576, 0.5013093577879};

// OneAxisEllipsoidTest — body-fixed position to geodetic longitude,
// latitude and altitude.
struct GeodeticCase {
  const char* name;
  double equatorialRadius;
  double flatteningDenominator;
  double position[3];
  double longitude;
  double latitude;
  double altitude;
  // One unit in the last place the source test PRINTS for each
  // expectation. Agreement is never asserted finer than this.
  double longitudePrinted;
  double latitudePrinted;
  double altitudePrinted;
};
constexpr int kGeodeticCaseCount = 6;
constexpr GeodeticCase kGeodeticCases[kGeodeticCaseCount] = {
    {"testStandard", 6378137.0, 298.257222101, {4637885.347, 121344.608, 4362452.869}, 0.026157811533131, 0.757987116290729, 260.455572965555, 1e-15, 1e-15, 1e-12},
    {"testLongitudeZero", 6378137.0, 298.257222101, {6378400.0, 0.0, 6379000.0}, 0.0, 0.787815771252351, 2653416.77864152, 0.1, 1e-15, 1e-8},
    {"testLongitudePi", 6378137.0, 298.257222101, {-6379999.0, 0.0, 6379000.0}, 3.14159265358979, 0.787690146758403, 2654544.7767725, 1e-14, 1e-15, 1e-7},
    {"testNorthPole", 6378137.0, 298.257222101, {0.0, 0.0, 7000000.0}, 0.0, 1.5707963267949, 643247.685859644, 0.1, 1e-14, 1e-9},
    {"testEquator", 6378137.0, 298.257222101, {6379888.0, 6377000.0, 0.0}, 0.785171775899913, 0.0, 2642345.24279301, 1e-15, 0.1, 1e-8},
    {"testOutside", 6378137.0, 298.257, {5722966.0, -3304156.0, -24621187.0}, 5.75958652642615, -1.3089969725151, 19134410.3342696, 1e-14, 1e-13, 1e-7},
};

// Vallado, Fundamentals of Astrodynamics and Applications, 4th ed., Example 3-5 (Finding GMST)
constexpr double kSiderealJulianDateUt1 = 2448855.009722222;
constexpr double kSiderealGreenwichMeanDegrees = 152.57878781;

}  // namespace reference
}  // namespace parameters
}  // namespace sdn

#endif  // SDN_ANALYSIS_PARAMETERS_REFERENCE_VECTORS_HPP
