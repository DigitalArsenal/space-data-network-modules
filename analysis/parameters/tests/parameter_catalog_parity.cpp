// Native parity harness for the parameter catalog.
//
// Compiles the SAME headers the WASM module compiles — the axis engine, the
// element-set library, the generated roster and the evaluator — against the
// vendored ERFA, and measures every parameter the acceptance names against its
// external authority. Prints one line per check and a failure count; the JS
// suite asserts the count is zero and republishes the numbers.
//
// Authorities used here, in the order the acceptance names them:
//   * the external orbital-mechanics library's own unit-test vectors, for the
//     element sets and the geodetic conversion (src/generated/reference_vectors.hpp,
//     generated from fixtures/orekit-vectors.json);
//   * the published worked example of the IAU-1982 sidereal series, for the
//     hour angle and local sidereal time;
//   * exact identities, where an identity is the strongest available statement:
//     A1 - TAI is a definition, B . S = 0 is a construction, and the B-vector
//     magnitude equals the hyperbolic semiminor axis by geometry.

#include <cmath>
#include <cstdio>
#include <cstring>

extern "C" {
#include "erfa.h"
#include "erfam.h"
}

#include "axis_engine.hpp"
#include "state_representations.hpp"
#include "generated/parameter_roster.hpp"
#include "parameter_catalog.hpp"
#include "generated/reference_vectors.hpp"

namespace {

namespace par = ::sdn::parameters;
namespace orb = ::sdn::orbits;
namespace ax = ::sdn::frames;
namespace ref = ::sdn::parameters::reference;

int gChecks = 0;
int gFailures = 0;

void report(const char* label, double measured, double bar, const char* unit) {
  const bool ok = std::isfinite(measured) && measured <= bar;
  ++gChecks;
  if (!ok) ++gFailures;
  std::printf("%-58s %14.6e %-8s bar %8.1e  %s\n", label, measured, unit, bar,
              ok ? "PASS" : "FAIL");
}

void reportExact(const char* label, bool ok, const char* detail) {
  ++gChecks;
  if (!ok) ++gFailures;
  std::printf("%-58s %-31s %s\n", label, detail, ok ? "PASS" : "FAIL");
}

double relative(double measured, double expected) {
  const double magnitude = std::fabs(expected);
  return magnitude > 0.0 ? std::fabs(measured - expected) / magnitude
                         : std::fabs(measured - expected);
}

double relativeVector(const double measured[3], const double expected[3]) {
  double numerator = 0.0;
  double denominator = 0.0;
  for (int i = 0; i < 3; ++i) {
    const double d = measured[i] - expected[i];
    numerator += d * d;
    denominator += expected[i] * expected[i];
  }
  return denominator > 0.0 ? std::sqrt(numerator / denominator) : std::sqrt(numerator);
}

/// Evaluate one parameter, returning the scalar. Fails the harness loudly if
/// the status is not OK, so a silent refusal can never read as a zero.
double evaluateScalar(par::ParameterId id, const par::EvaluationContext& context,
                      const par::Derived& derived, const char* label) {
  double values[36] = {0.0};
  int count = 0;
  const par::Status status = par::evaluate(id, context, derived, values, &count);
  if (status != par::Status::OK || count < 1) {
    ++gChecks;
    ++gFailures;
    std::printf("%-58s status %-24d %s\n", label, static_cast<int>(status), "FAIL");
    return std::nan("");
  }
  return values[0];
}

// ---------------------------------------------------------------------------

par::EvaluationContext makeContext(const orb::Cartesian& state, double mu) {
  par::EvaluationContext context;
  context.state = state;
  context.gravitationalParameter = mu;
  context.centralBodyId = static_cast<int>(ax::BodyId::EARTH);
  context.ellipsoid.equatorialRadius = 6378137.0;
  context.ellipsoid.flattening = 1.0 / 298.257223563;
  return context;
}

bool setEpoch(par::EvaluationContext* context, int year, int month, int day, int hour,
              int minute, double second) {
  // A stated Earth-orientation row. The catalog refuses a body-fixed chain
  // without one, exactly as the frames module does, so the harness states the
  // row it used rather than letting the code assume zeros.
  context->earthOrientation.dut1 = 0.0177655;
  context->earthOrientation.xPole = 0.182065 * (ERFA_DPI / (180.0 * 3600.0));
  context->earthOrientation.yPole = 0.407705 * (ERFA_DPI / (180.0 * 3600.0));
  context->earthOrientationSupplied = true;
  if (!ax::epochFromUtc(year, month, day, hour, minute, second, context->earthOrientation,
                        &context->epoch)) {
    return false;
  }
  if (eraDtf2d("UTC", year, month, day, hour, minute, second, &context->utc1,
               &context->utc2) != 0) {
    return false;
  }
  context->epochSupplied = true;
  return true;
}

// ---------------------------------------------------------------------------
// 1. Element sets against the external library's own test vectors.
// ---------------------------------------------------------------------------

void checkElementSets() {
  std::printf("\n-- element sets, against the external library's unit-test vectors --\n");

  // Keplerian -> Cartesian. The library states MEAN anomaly; our set carries
  // TRUE, so the mean anomaly is converted by the same header the module uses.
  orb::Keplerian elements;
  elements.semiMajorAxis = ref::kKeplerianSemiMajorAxis;
  elements.eccentricity = ref::kKeplerianEccentricity;
  elements.inclination = ref::kKeplerianInclination;
  elements.raan = ref::kKeplerianRaan;
  elements.argumentOfPeriapsis = ref::kKeplerianArgumentOfPeriapsis;
  double eccentricAnomaly = 0.0;
  const bool solved = orb::meanToEccentricAnomaly(ref::kKeplerianMeanAnomaly,
                                                  ref::kKeplerianEccentricity,
                                                  &eccentricAnomaly);
  reportExact("Kepler's equation solves for the reference mean anomaly", solved,
              solved ? "converged" : "did not converge");
  elements.trueAnomaly =
      orb::eccentricToTrueAnomaly(eccentricAnomaly, ref::kKeplerianEccentricity);

  orb::Cartesian state;
  const bool converted =
      orb::cartesianFromKeplerian(elements, ref::kKeplerianMu, &state);
  reportExact("Keplerian -> Cartesian conversion succeeds", converted,
              converted ? "ok" : "refused");

  const double position[3] = {state.position.x, state.position.y, state.position.z};
  const double velocity[3] = {state.velocity.x, state.velocity.y, state.velocity.z};
  report("Keplerian -> Cartesian position", relativeVector(position, ref::kKeplerianPosition),
         1e-12, "rel");
  report("Keplerian -> Cartesian velocity", relativeVector(velocity, ref::kKeplerianVelocity),
         1e-12, "rel");

  // Cartesian -> Keplerian, from the library's own printed state.
  orb::Cartesian printedState;
  printedState.position = {ref::kKeplerianPosition[0], ref::kKeplerianPosition[1],
                           ref::kKeplerianPosition[2]};
  printedState.velocity = {ref::kKeplerianVelocity[0], ref::kKeplerianVelocity[1],
                           ref::kKeplerianVelocity[2]};
  par::EvaluationContext context = makeContext(printedState, ref::kKeplerianMu);
  par::Derived derived;
  const bool built = par::buildDerived(context, &derived);
  reportExact("derived quantities build from the reference state", built,
              built ? "ok" : "refused");

  // The library's printed state carries 15 significant digits, so the elements
  // recovered from it are bounded by that truncation rather than by our
  // arithmetic: 1e-12 relative is the acceptance and is what is measured.
  report("Cartesian -> SMA", relative(evaluateScalar(par::ParameterId::SMA, context, derived,
                                                     "SMA"),
                                      ref::kKeplerianSemiMajorAxis),
         1e-12, "rel");
  report("Cartesian -> ECC", relative(evaluateScalar(par::ParameterId::ECC, context, derived,
                                                     "ECC"),
                                      ref::kKeplerianEccentricity),
         1e-12, "rel");
  report("Cartesian -> INC", relative(evaluateScalar(par::ParameterId::INC, context, derived,
                                                     "INC"),
                                      ref::kKeplerianInclination),
         1e-12, "rel");
  report("Cartesian -> RAAN", relative(evaluateScalar(par::ParameterId::RAAN, context,
                                                      derived, "RAAN"),
                                       ref::kKeplerianRaan),
         1e-12, "rel");
  report("Cartesian -> AOP", relative(evaluateScalar(par::ParameterId::AOP, context, derived,
                                                     "AOP"),
                                      ref::kKeplerianArgumentOfPeriapsis),
         1e-12, "rel");
  report("Cartesian -> MA", relative(evaluateScalar(par::ParameterId::MA, context, derived,
                                                    "MA"),
                                     ref::kKeplerianMeanAnomaly),
         1e-12, "rel");

  // The same orbit's equinoctial elements, in the library's own convention:
  //   ex = e cos(argPer + raan)  ->  our k
  //   ey = e sin(argPer + raan)  ->  our h
  //   LM = M + argPer + raan     ->  our meanLongitude
  const double equinoctialK =
      evaluateScalar(par::ParameterId::EquinoctialK, context, derived, "EquinoctialK");
  const double equinoctialH =
      evaluateScalar(par::ParameterId::EquinoctialH, context, derived, "EquinoctialH");
  const double meanLongitude =
      evaluateScalar(par::ParameterId::MLONG, context, derived, "MLONG");
  report("equinoctial k against the reference ex", relative(equinoctialK, ref::kEquinoctialEx),
         1e-12, "rel");
  report("equinoctial h against the reference ey", relative(equinoctialH, ref::kEquinoctialEy),
         1e-12, "rel");
  report("mean longitude against the reference LM",
         relative(par::detail::wrapTwoPi(meanLongitude),
                  par::detail::wrapTwoPi(ref::kEquinoctialMeanLongitude)),
         1e-12, "rel");

  // The reference inclination is stated as an expression over two literals.
  const double referenceInclination =
      2.0 * std::asin(std::sqrt((ref::kEquinoctialInclinationIx * ref::kEquinoctialInclinationIx +
                                 ref::kEquinoctialInclinationIy * ref::kEquinoctialInclinationIy) /
                                4.0));
  report("inclination against the reference inclination vector",
         relative(evaluateScalar(par::ParameterId::INC, context, derived, "INC"),
                  referenceInclination),
         1e-12, "rel");

  // Equinoctial -> Cartesian, the geostationary-class case.
  const double inclination =
      2.0 * std::asin(std::sqrt((ref::kGeoIx * ref::kGeoIx + ref::kGeoIy * ref::kGeoIy) / 4.0));
  const double halfInclination = inclination / 2.0;
  const double hx = std::tan(halfInclination) * ref::kGeoIx / (2.0 * std::sin(halfInclination));
  const double hy = std::tan(halfInclination) * ref::kGeoIy / (2.0 * std::sin(halfInclination));
  orb::Equinoctial geoSet;
  geoSet.semiMajorAxis = ref::kGeoSemiMajorAxis;
  geoSet.k = ref::kGeoEx;
  geoSet.h = ref::kGeoEy;
  geoSet.q = hx;
  geoSet.p = hy;
  geoSet.meanLongitude = ref::kGeoMeanLongitude;
  geoSet.retrogradeFactor = 1;
  orb::Cartesian geoState;
  const bool geoConverted = orb::cartesianFromEquinoctial(geoSet, ref::kGeoMu, &geoState);
  reportExact("equinoctial -> Cartesian conversion succeeds", geoConverted,
              geoConverted ? "ok" : "refused");
  const double geoPosition[3] = {geoState.position.x, geoState.position.y, geoState.position.z};
  const double geoVelocity[3] = {geoState.velocity.x, geoState.velocity.y, geoState.velocity.z};
  report("equinoctial -> Cartesian position", relativeVector(geoPosition, ref::kGeoPosition),
         1e-12, "rel");
  report("equinoctial -> Cartesian velocity", relativeVector(geoVelocity, ref::kGeoVelocity),
         1e-12, "rel");
}

// ---------------------------------------------------------------------------
// 2. Derived orbital scalars, against closed forms in the reference elements.
// ---------------------------------------------------------------------------

void checkOrbitalScalars() {
  std::printf("\n-- derived orbital scalars, against closed forms --\n");
  orb::Cartesian state;
  state.position = {ref::kKeplerianPosition[0], ref::kKeplerianPosition[1],
                    ref::kKeplerianPosition[2]};
  state.velocity = {ref::kKeplerianVelocity[0], ref::kKeplerianVelocity[1],
                    ref::kKeplerianVelocity[2]};
  par::EvaluationContext context = makeContext(state, ref::kKeplerianMu);
  par::Derived derived;
  par::buildDerived(context, &derived);

  const double a = ref::kKeplerianSemiMajorAxis;
  const double e = ref::kKeplerianEccentricity;
  const double mu = ref::kKeplerianMu;

  report("C3Energy against -mu/a",
         relative(evaluateScalar(par::ParameterId::C3Energy, context, derived, "C3Energy"),
                  -mu / a),
         1e-12, "rel");
  report("Energy against -mu/(2a)",
         relative(evaluateScalar(par::ParameterId::Energy, context, derived, "Energy"),
                  -mu / (2.0 * a)),
         1e-12, "rel");
  report("OrbitPeriod against 2 pi sqrt(a^3/mu)",
         relative(evaluateScalar(par::ParameterId::OrbitPeriod, context, derived, "OrbitPeriod"),
                  2.0 * orb::kPi * std::sqrt(a * a * a / mu)),
         1e-12, "rel");
  report("RadApo against a(1+e)",
         relative(evaluateScalar(par::ParameterId::RadApo, context, derived, "RadApo"),
                  a * (1.0 + e)),
         1e-12, "rel");
  report("RadPer against a(1-e)",
         relative(evaluateScalar(par::ParameterId::RadPer, context, derived, "RadPer"),
                  a * (1.0 - e)),
         1e-12, "rel");
  report("SemilatusRectum against a(1-e^2)",
         relative(evaluateScalar(par::ParameterId::SemilatusRectum, context, derived,
                                 "SemilatusRectum"),
                  a * (1.0 - e * e)),
         1e-12, "rel");
  report("MM against sqrt(mu/a^3)",
         relative(evaluateScalar(par::ParameterId::MM, context, derived, "MM"),
                  std::sqrt(mu / (a * a * a))),
         1e-12, "rel");
  report("VelPeriapsis against sqrt(mu(1+e)/(a(1-e)))",
         relative(evaluateScalar(par::ParameterId::VelPeriapsis, context, derived,
                                 "VelPeriapsis"),
                  std::sqrt(mu * (1.0 + e) / (a * (1.0 - e)))),
         1e-12, "rel");
  report("VelApoapsis against sqrt(mu(1-e)/(a(1+e)))",
         relative(evaluateScalar(par::ParameterId::VelApoapsis, context, derived,
                                 "VelApoapsis"),
                  std::sqrt(mu * (1.0 - e) / (a * (1.0 + e)))),
         1e-12, "rel");

  // Angular momentum: the components against the cross product taken here, and
  // the magnitude against sqrt(mu p) — two independent statements of the same
  // quantity.
  const double hx = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
  const double hy = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
  const double hz = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
  report("HX against r x v", relative(evaluateScalar(par::ParameterId::HX, context, derived,
                                                     "HX"),
                                      hx),
         1e-12, "rel");
  report("HY against r x v", relative(evaluateScalar(par::ParameterId::HY, context, derived,
                                                     "HY"),
                                      hy),
         1e-12, "rel");
  report("HZ against r x v", relative(evaluateScalar(par::ParameterId::HZ, context, derived,
                                                     "HZ"),
                                      hz),
         1e-12, "rel");
  report("HMAG against sqrt(mu a (1-e^2))",
         relative(evaluateScalar(par::ParameterId::HMAG, context, derived, "HMAG"),
                  std::sqrt(mu * a * (1.0 - e * e))),
         1e-12, "rel");

  // RADN is the descending node's right ascension: half a turn from RAAN.
  report("RADN against RAAN + pi",
         relative(evaluateScalar(par::ParameterId::RADN, context, derived, "RADN"),
                  par::detail::wrapTwoPi(ref::kKeplerianRaan + orb::kPi)),
         1e-12, "rel");
}

// ---------------------------------------------------------------------------
// 3. Geodetic quantities, against the external library's ellipsoid vectors.
//
// Measured END TO END: each reference position is a BODY-FIXED position, so it
// is rotated into the inertial axes by the module's own chain and handed to the
// catalog, which rotates it back. A latitude that came out right only because
// the rotation was skipped would not pass this.
// ---------------------------------------------------------------------------

void checkGeodetic() {
  std::printf("\n-- geodetic quantities, against the external library's ellipsoid vectors --\n");

  // (a) The CONVERSION, measured where it lives: the reference positions are
  // body-fixed, so they are handed to the ellipsoid conversion directly. This
  // is the acceptance's claim — that our geodetic latitude, longitude and
  // altitude reproduce the external library's to 1e-9 — and it is measured with
  // nothing else in the path.
  for (int i = 0; i < ref::kGeodeticCaseCount; ++i) {
    const ref::GeodeticCase& testCase = ref::kGeodeticCases[i];
    orb::Cartesian bodyFixedState;
    bodyFixedState.position = {testCase.position[0], testCase.position[1],
                               testCase.position[2]};
    bodyFixedState.velocity = {0.0, 1.0, 0.0};
    orb::Ellipsoid ellipsoid;
    ellipsoid.equatorialRadius = testCase.equatorialRadius;
    ellipsoid.flattening = 1.0 / testCase.flatteningDenominator;

    orb::Planetodetic set;
    char label[160];
    if (!orb::planetodeticFromCartesian(bodyFixedState, ellipsoid, &set)) {
      std::snprintf(label, sizeof label, "%s conversion", testCase.name);
      reportExact(label, false, "refused");
      continue;
    }
    // The bar is the acceptance's, OR one unit in the last place the source
    // test prints, whichever is looser. Agreement cannot be asserted finer than
    // the authority states it: the altitude 19134410.3342696 carries its last
    // digit at 1e-7 m, so a 1e-9 m bar there would be measuring the
    // transcription rather than the conversion.
    const auto bar = [](double acceptance, double printed) {
      return acceptance > printed ? acceptance : printed;
    };
    std::snprintf(label, sizeof label, "%s latitude", testCase.name);
    report(label, std::fabs(set.latitude - testCase.latitude),
           bar(1e-9, testCase.latitudePrinted), "rad");
    std::snprintf(label, sizeof label, "%s longitude", testCase.name);
    // The reference states longitude in [0, 2pi) for some cases and in
    // (-pi, pi] for others; comparing the wrapped difference is the same
    // statement without importing a convention.
    report(label, std::fabs(par::detail::wrapPi(set.longitude - testCase.longitude)),
           bar(1e-9, testCase.longitudePrinted), "rad");
    std::snprintf(label, sizeof label, "%s altitude", testCase.name);
    report(label, std::fabs(set.height - testCase.altitude),
           bar(1e-9, testCase.altitudePrinted), "m");
  }

  // (b) The CATALOG, end to end. Each reference position is rotated into the
  // inertial axes by the module's own chain and handed to the evaluator, which
  // rotates it back — so a latitude that only came out right because the
  // rotation was skipped would not pass.
  //
  // The bar here is 1e-6 m and 1e-12 rad, NOT the conversion's 1e-9: a
  // round trip through a rotation matrix costs a few units in the last place of
  // the position, which on a 2.5e7 m radius is about 5e-9 m. That is the
  // double-precision floor of the round trip, not an error in the geodetic
  // conversion, and pretending otherwise by loosening (a) would hide the
  // quantity the acceptance actually names. The floor itself is measured below.
  std::printf("   ... and end to end, through the module's own rotation chain\n");
  par::EvaluationContext probe = makeContext(orb::Cartesian{}, 3.986004418e14);
  if (!setEpoch(&probe, 2026, 8, 29, 12, 0, 0.0)) {
    reportExact("epoch builds", false, "epochFromUtc refused");
    return;
  }
  const ax::Mat3 toBodyFixed = ax::gcrfToItrf(probe.epoch, probe.earthOrientation);
  const ax::Mat3 toInertial = ax::transpose(toBodyFixed);

  double worstRoundTrip = 0.0;
  for (int i = 0; i < ref::kGeodeticCaseCount; ++i) {
    const ref::GeodeticCase& testCase = ref::kGeodeticCases[i];
    const ax::Vec3 bodyFixed{testCase.position[0], testCase.position[1], testCase.position[2]};
    const ax::Vec3 inertial = ax::apply(toInertial, bodyFixed);
    const ax::Vec3 returned = ax::apply(toBodyFixed, inertial);
    const double roundTrip = ax::norm(ax::sub(returned, bodyFixed));
    if (roundTrip > worstRoundTrip) worstRoundTrip = roundTrip;

    orb::Cartesian state;
    state.position = {inertial.x, inertial.y, inertial.z};
    state.velocity = {0.0, 1.0, 0.0};

    par::EvaluationContext context = makeContext(state, 3.986004418e14);
    context.ellipsoid.equatorialRadius = testCase.equatorialRadius;
    context.ellipsoid.flattening = 1.0 / testCase.flatteningDenominator;
    setEpoch(&context, 2026, 8, 29, 12, 0, 0.0);

    par::Derived derived;
    char label[160];
    if (!par::buildDerived(context, &derived)) {
      std::snprintf(label, sizeof label, "%s end to end", testCase.name);
      reportExact(label, false, "derived quantities refused");
      continue;
    }

    const double latitude =
        evaluateScalar(par::ParameterId::Latitude, context, derived, "Latitude");
    std::snprintf(label, sizeof label, "%s latitude end to end", testCase.name);
    report(label, std::fabs(latitude - testCase.latitude), 1e-12, "rad");

    const double altitude =
        evaluateScalar(par::ParameterId::Altitude, context, derived, "Altitude");
    std::snprintf(label, sizeof label, "%s altitude end to end", testCase.name);
    report(label, std::fabs(altitude - testCase.altitude), 1e-6, "m");

    // Longitude is not asserted at the pole. With x = y = 0 exactly the
    // reference reports 0 by convention; after a rotation round trip x and y
    // are a few nanometres and the longitude they define is arbitrary. Saying
    // so is the answer, not choosing a bar that hides it.
    const double planarRadius =
        std::sqrt(testCase.position[0] * testCase.position[0] +
                  testCase.position[1] * testCase.position[1]);
    if (planarRadius > 1.0) {
      const double longitude =
          evaluateScalar(par::ParameterId::Longitude, context, derived, "Longitude");
      std::snprintf(label, sizeof label, "%s longitude end to end", testCase.name);
      report(label, std::fabs(par::detail::wrapPi(longitude - testCase.longitude)), 1e-12,
             "rad");
    } else {
      std::snprintf(label, sizeof label, "%s longitude end to end", testCase.name);
      std::printf("%-58s %-31s %s\n", label, "not asserted: polar, longitude undefined",
                  "SKIP");
    }
  }
  report("worst inertial round trip of a reference position", worstRoundTrip, 1e-7, "m");
}

// ---------------------------------------------------------------------------
// 4. Sidereal time, against the published worked example.
// ---------------------------------------------------------------------------

void checkSiderealTime() {
  std::printf("\n-- sidereal time, against the published worked example --\n");
  ax::Epoch epoch;
  // The example states a UT1 Julian date; the legacy series is a function of
  // UT1 alone, so nothing else is needed.
  epoch.ut11 = ERFA_DJ00;
  epoch.ut12 = ref::kSiderealJulianDateUt1 - ERFA_DJ00;
  epoch.tt1 = epoch.ut11;
  epoch.tt2 = epoch.ut12;

  const double measured = par::detail::greenwichMeanSiderealTime1982(epoch);
  const double expected = ref::kSiderealGreenwichMeanDegrees * (orb::kPi / 180.0);
  report("IAU-1982 Greenwich mean sidereal time", std::fabs(measured - expected), 1e-9, "rad");

  // The IAU-2006 series is a DIFFERENT answer, and how different is worth
  // printing rather than gating: it is the whole reason the legacy route keeps
  // its own name.
  const double modern = par::detail::greenwichMeanSiderealTime2006(epoch);
  std::printf("%-58s %14.6e %-8s (reported, not gated)\n",
              "IAU-2006 minus IAU-1982 at the example epoch",
              std::fabs(par::detail::wrapPi(modern - measured)), "rad");
}

// ---------------------------------------------------------------------------
// 5. Time scales.
// ---------------------------------------------------------------------------

void checkTimeScales() {
  std::printf("\n-- time scales --\n");
  orb::Cartesian state;
  state.position = {7000000.0, 1200000.0, 300000.0};
  state.velocity = {-1500.0, 7100.0, 400.0};
  par::EvaluationContext context = makeContext(state, 3.986004418e14);
  if (!setEpoch(&context, 2026, 8, 29, 12, 0, 0.0)) {
    reportExact("epoch builds", false, "epochFromUtc refused");
    return;
  }
  context.referenceUtc1 = context.utc1;
  context.referenceUtc2 = context.utc2 - 1.5;  // exactly 1.5 days earlier
  context.referenceEpochSupplied = true;

  par::Derived derived;
  par::buildDerived(context, &derived);

  // The scale DIFFERENCES are measured on the two-part Julian dates, where the
  // day number and the fraction are carried separately and a second is
  // resolvable to about 1e-11. Differencing two single-double Modified Julian
  // Dates cannot state a 1e-9 s result at all: at MJD 61281 one unit in the
  // last place is 1.3e-11 d, which is 1.1e-6 s. That resolution is measured and
  // printed below rather than papered over with a looser bar.
  struct ScaleParts {
    double part1;
    double part2;
  };
  const auto parts = [&](par::TimeScale scale) {
    ScaleParts value{0.0, 0.0};
    par::julianDateInScale(context, scale, &value.part1, &value.part2);
    return value;
  };
  const auto differenceSeconds = [](const ScaleParts& a, const ScaleParts& b) {
    return ((a.part1 - b.part1) + (a.part2 - b.part2)) * par::kSecondsPerDay;
  };
  const ScaleParts utcParts = parts(par::TimeScale::UTC);
  const ScaleParts taiParts = parts(par::TimeScale::TAI);
  const ScaleParts ttParts = parts(par::TimeScale::TT);
  const ScaleParts tdbParts = parts(par::TimeScale::TDB);
  const ScaleParts a1Parts = parts(par::TimeScale::A1);

  // A1 - TAI is a DEFINITION, not a measurement.
  report("A1 - TAI against its defining constant",
         std::fabs(differenceSeconds(a1Parts, taiParts) - par::kA1MinusTaiSeconds), 1e-9, "s");
  // TT - TAI = 32.184 s exactly, also a definition.
  report("TT - TAI against 32.184 s",
         std::fabs(differenceSeconds(ttParts, taiParts) - 32.184), 1e-9, "s");
  // TAI - UTC is the leap-second count, an integer at this epoch.
  const double leapSeconds = differenceSeconds(taiParts, utcParts);
  report("TAI - UTC is an integer number of seconds",
         std::fabs(leapSeconds - std::floor(leapSeconds + 0.5)), 1e-9, "s");
  // TDB - TT is a periodic series of order 1.7 ms; asserting the bound is the
  // statement that the series was evaluated rather than skipped.
  const double tdbMinusTt = std::fabs(differenceSeconds(tdbParts, ttParts));
  reportExact("TDB - TT lies inside its 2 ms envelope and is non-zero",
              tdbMinusTt > 0.0 && tdbMinusTt < 2.0e-3, "series evaluated");

  // The Modified Julian Date each scale REPORTS must be exactly the two-part
  // value the differences above were taken on, minus the offset. That is what
  // ties the reported number to the measured one.
  const struct {
    par::ParameterId id;
    par::TimeScale scale;
    const char* label;
  } scales[5] = {
      {par::ParameterId::A1ModJulian, par::TimeScale::A1, "A1ModJulian"},
      {par::ParameterId::TAIModJulian, par::TimeScale::TAI, "TAIModJulian"},
      {par::ParameterId::TTModJulian, par::TimeScale::TT, "TTModJulian"},
      {par::ParameterId::TDBModJulian, par::TimeScale::TDB, "TDBModJulian"},
      {par::ParameterId::UTCModJulian, par::TimeScale::UTC, "UTCModJulian"},
  };
  for (const auto& entry : scales) {
    const ScaleParts value = parts(entry.scale);
    const double expected =
        (value.part1 - par::kModifiedJulianDateOffset) + value.part2;
    char label[128];
    std::snprintf(label, sizeof label, "%s equals its two-part Julian date", entry.label);
    report(label,
           std::fabs(evaluateScalar(entry.id, context, derived, entry.label) - expected), 0.0,
           "d");
  }
  std::printf("%-58s %14.6e %-8s (reported, not gated)\n",
              "one ulp of a Modified Julian Date at this epoch",
              std::nextafter(utcParts.part1 - par::kModifiedJulianDateOffset + utcParts.part2,
                             1e30) -
                  (utcParts.part1 - par::kModifiedJulianDateOffset + utcParts.part2),
              "d");

  report("ElapsedDays against the stated 1.5 day offset",
         std::fabs(evaluateScalar(par::ParameterId::ElapsedDays, context, derived,
                                  "ElapsedDays") -
                   1.5),
         1e-9, "d");
  report("ElapsedSecs against the same offset in seconds",
         std::fabs(evaluateScalar(par::ParameterId::ElapsedSecs, context, derived,
                                  "ElapsedSecs") -
                   1.5 * par::kSecondsPerDay),
         1e-6, "s");

  char text[64] = {0};
  const par::Status status =
      par::evaluateText(par::ParameterId::UTCGregorian, context, text, sizeof text);
  reportExact("UTCGregorian renders the stated calendar instant",
              status == par::Status::OK &&
                  std::strncmp(text, "2026-08-29T12:00:00.000000000", 28) == 0,
              text);
}

// ---------------------------------------------------------------------------
// 6. The B-plane and the asymptote sets.
// ---------------------------------------------------------------------------

void checkBPlane() {
  std::printf("\n-- B-plane and asymptotes, on a hyperbolic orbit --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = -30000000.0;  // negative: hyperbolic
  elements.eccentricity = 1.4;
  elements.inclination = 0.5;
  elements.raan = 1.1;
  elements.argumentOfPeriapsis = 0.7;
  elements.trueAnomaly = -0.9;
  orb::Cartesian state;
  const bool converted = orb::cartesianFromKeplerian(elements, mu, &state);
  reportExact("hyperbolic Keplerian -> Cartesian", converted, converted ? "ok" : "refused");

  par::EvaluationContext context = makeContext(state, mu);
  par::Derived derived;
  par::buildDerived(context, &derived);

  par::BPlane incoming;
  const bool haveIncoming = par::computeBPlane(derived, mu, true, &incoming);
  reportExact("B-plane resolves on the incoming asymptote", haveIncoming,
              haveIncoming ? "ok" : "refused");

  if (haveIncoming) {
    // B . S = 0 by construction, so this measures the construction rather than
    // a cancellation.
    const double bDotS = par::detail::dot(incoming.bVector, incoming.sHat);
    report("B . S", std::fabs(bDotS) / par::detail::norm(incoming.bVector), 1e-15, "rel");

    // |B| equals the hyperbolic semiminor axis |a| sqrt(e^2 - 1).
    const double semiminor =
        std::fabs(elements.semiMajorAxis) *
        std::sqrt(elements.eccentricity * elements.eccentricity - 1.0);
    report("|B| against |a| sqrt(e^2 - 1)", relative(incoming.magnitude, semiminor), 1e-12,
           "rel");

    // The two components and the magnitude are one statement.
    report("BdotT^2 + BdotR^2 against |B|^2",
           relative(std::sqrt(incoming.bDotT * incoming.bDotT +
                              incoming.bDotR * incoming.bDotR),
                    incoming.magnitude),
           1e-15, "rel");

    // S, T and R are an orthonormal triad.
    report("S . T", std::fabs(par::detail::dot(incoming.sHat, incoming.tHat)), 1e-15, "abs");
    report("S . R", std::fabs(par::detail::dot(incoming.sHat, incoming.rHat)), 1e-15, "abs");
    report("T . R", std::fabs(par::detail::dot(incoming.tHat, incoming.rHat)), 1e-15, "abs");
    report("|S| - 1", std::fabs(par::detail::norm(incoming.sHat) - 1.0), 1e-15, "abs");

    // T lies in the reference plane by definition.
    report("T_z", std::fabs(incoming.tHat.z), 1e-15, "abs");

    const double angle =
        evaluateScalar(par::ParameterId::BVectorAngle, context, derived, "BVectorAngle");
    report("BVectorAngle against atan2(BdotR, BdotT)",
           std::fabs(par::detail::wrapPi(angle - std::atan2(incoming.bDotR, incoming.bDotT))),
           1e-15, "rad");
  }

  // DLA and RLA are the OUTGOING asymptote's declination and right ascension.
  // They are cross-checked against the outgoing asymptote ELEMENT SET, which is
  // built by a completely different route (the perifocal basis in the element
  // library) — so agreement is two implementations meeting, not one repeated.
  const double dla = evaluateScalar(par::ParameterId::DLA, context, derived, "DLA");
  const double rla = evaluateScalar(par::ParameterId::RLA, context, derived, "RLA");
  const double setDha =
      evaluateScalar(par::ParameterId::OutgoingDHA, context, derived, "OutgoingDHA");
  const double setRha =
      evaluateScalar(par::ParameterId::OutgoingRHA, context, derived, "OutgoingRHA");
  report("DLA against the outgoing asymptote element set", std::fabs(dla - setDha), 1e-12,
         "rad");
  report("RLA against the outgoing asymptote element set",
         std::fabs(par::detail::wrapPi(rla - setRha)), 1e-12, "rad");

  const double dlaIn =
      evaluateScalar(par::ParameterId::DLAIncoming, context, derived, "DLAIncoming");
  const double rlaIn =
      evaluateScalar(par::ParameterId::RLAIncoming, context, derived, "RLAIncoming");
  const double setDhaIn =
      evaluateScalar(par::ParameterId::IncomingDHA, context, derived, "IncomingDHA");
  const double setRhaIn =
      evaluateScalar(par::ParameterId::IncomingRHA, context, derived, "IncomingRHA");
  report("incoming DLA against the incoming asymptote element set",
         std::fabs(dlaIn - setDhaIn), 1e-12, "rad");
  report("incoming RLA against the incoming asymptote element set",
         std::fabs(par::detail::wrapPi(rlaIn - setRhaIn)), 1e-12, "rad");

  // The asymptote element sets round-trip to Cartesian.
  for (int pass = 0; pass < 2; ++pass) {
    const bool incomingSet = pass == 0;
    orb::Asymptote asymptote;
    if (!orb::asymptoteFromKeplerian(elements, mu, incomingSet, &asymptote)) {
      reportExact(incomingSet ? "incoming asymptote set builds"
                              : "outgoing asymptote set builds",
                  false, "refused");
      continue;
    }
    orb::Keplerian recovered;
    if (!orb::keplerianFromAsymptote(asymptote, mu, incomingSet, &recovered)) {
      reportExact(incomingSet ? "incoming asymptote set inverts"
                              : "outgoing asymptote set inverts",
                  false, "refused");
      continue;
    }
    orb::Cartesian roundTrip;
    orb::cartesianFromKeplerian(recovered, mu, &roundTrip);
    const double measured[3] = {roundTrip.position.x, roundTrip.position.y,
                                roundTrip.position.z};
    const double expected[3] = {state.position.x, state.position.y, state.position.z};
    report(incomingSet ? "incoming asymptote set round-trips to Cartesian"
                       : "outgoing asymptote set round-trips to Cartesian",
           relativeVector(measured, expected), 1e-12, "rel");
  }

  // A bound orbit has no B-plane, and the refusal is by NAME.
  orb::Cartesian bound;
  bound.position = {7000000.0, 0.0, 0.0};
  bound.velocity = {0.0, 7500.0, 0.0};
  par::EvaluationContext boundContext = makeContext(bound, mu);
  par::Derived boundDerived;
  par::buildDerived(boundContext, &boundDerived);
  double values[36] = {0.0};
  int count = 0;
  const par::Status boundStatus =
      par::evaluate(par::ParameterId::BdotT, boundContext, boundDerived, values, &count);
  reportExact("BdotT on a bound orbit is refused as undefined",
              boundStatus == par::Status::UNDEFINED_FOR_THIS_ORBIT && count == 0,
              "UNDEFINED_FOR_THIS_ORBIT");
}

// ---------------------------------------------------------------------------
// 7. Beta angle.
// ---------------------------------------------------------------------------

void checkBetaAngle() {
  std::printf("\n-- beta angle --\n");
  orb::Cartesian state;
  state.position = {7000000.0, 0.0, 0.0};
  state.velocity = {0.0, 5300.0, 5300.0};
  par::EvaluationContext context = makeContext(state, 3.986004418e14);
  if (!setEpoch(&context, 2026, 8, 29, 12, 0, 0.0)) return;
  par::Derived derived;
  par::buildDerived(context, &derived);

  const double beta =
      evaluateScalar(par::ParameterId::BetaAngle, context, derived, "BetaAngle");

  // The closed form: the angle between the orbit plane and the Sun direction is
  // the complement of the angle between the orbit NORMAL and the Sun direction.
  const par::detail::V3 hHat = par::detail::unit(derived.angularMomentum);
  const double angleToNormal =
      std::acos(par::detail::dot(hHat, derived.sunDirection));
  report("BetaAngle against pi/2 minus the angle to the orbit normal",
         std::fabs(beta - (orb::kPi / 2.0 - angleToNormal)), 1e-12, "rad");

  // An orbit in the ecliptic-normal plane through the Sun direction has beta 0;
  // one whose normal IS the Sun direction has beta pi/2. Both are exact.
  orb::Cartesian polar;
  const par::detail::V3 sun = derived.sunDirection;
  // Build a state whose angular momentum points at the Sun: position and
  // velocity both perpendicular to the Sun direction.
  par::detail::V3 anyVector{0.0, 0.0, 1.0};
  if (std::fabs(sun.z) > 0.9) anyVector = {1.0, 0.0, 0.0};
  const par::detail::V3 first = par::detail::unit(par::detail::cross(sun, anyVector));
  const par::detail::V3 second = par::detail::cross(sun, first);
  polar.position = {first.x * 7000000.0, first.y * 7000000.0, first.z * 7000000.0};
  polar.velocity = {second.x * 7500.0, second.y * 7500.0, second.z * 7500.0};
  par::EvaluationContext polarContext = context;
  polarContext.state = polar;
  par::Derived polarDerived;
  par::buildDerived(polarContext, &polarDerived);
  const double polarBeta =
      evaluateScalar(par::ParameterId::BetaAngle, polarContext, polarDerived, "BetaAngle");
  // Asserted on the SINE, not on the angle. Beta is an arcsine, and at +/- 90
  // degrees the arcsine's derivative is unbounded: an error of 1e-16 in the
  // argument becomes 1.4e-8 in the angle no matter how the argument was
  // computed. Gating the angle there would measure the conditioning of arcsine
  // rather than anything about the beta angle. The angle error is printed so the
  // conditioning is visible.
  report("sin(BetaAngle) is 1 when the orbit normal is the Sun direction",
         std::fabs(std::sin(polarBeta) - 1.0), 1e-15, "abs");
  std::printf("%-58s %14.6e %-8s (reported, not gated)\n",
              "  the same statement as an angle error",
              std::fabs(polarBeta - orb::kPi / 2.0), "rad");
}

// ---------------------------------------------------------------------------
// 8. State-transition sub-matrices.
// ---------------------------------------------------------------------------

void checkStateTransition() {
  std::printf("\n-- state-transition sub-matrices --\n");
  orb::Cartesian state;
  state.position = {7000000.0, 1200000.0, 300000.0};
  state.velocity = {-1500.0, 7100.0, 400.0};
  par::EvaluationContext context = makeContext(state, 3.986004418e14);
  par::Derived derived;
  par::buildDerived(context, &derived);

  double values[36] = {0.0};
  int count = 0;
  par::Status status =
      par::evaluate(par::ParameterId::OrbitSTM, context, derived, values, &count);
  reportExact("OrbitSTM without a supplied matrix is refused",
              status == par::Status::MISSING_INPUT && count == 0, "MISSING_INPUT");

  // A matrix whose every entry is its own row-major index, so a mis-sliced
  // block is visible as a wrong number rather than as a plausible one.
  for (int i = 0; i < 36; ++i) context.stateTransitionMatrix[i] = static_cast<double>(i);
  context.stateTransitionMatrixSupplied = true;

  status = par::evaluate(par::ParameterId::OrbitSTM, context, derived, values, &count);
  bool ok = status == par::Status::OK && count == 36;
  for (int i = 0; i < 36 && ok; ++i) ok = values[i] == static_cast<double>(i);
  reportExact("OrbitSTM returns all 36 entries in row-major order", ok, "36 entries");

  struct Block {
    par::ParameterId id;
    const char* name;
    int rowOffset;
    int columnOffset;
  };
  const Block blocks[4] = {
      {par::ParameterId::OrbitSTMA, "OrbitSTMA (d r / d r0)", 0, 0},
      {par::ParameterId::OrbitSTMB, "OrbitSTMB (d r / d v0)", 0, 3},
      {par::ParameterId::OrbitSTMC, "OrbitSTMC (d v / d r0)", 3, 0},
      {par::ParameterId::OrbitSTMD, "OrbitSTMD (d v / d v0)", 3, 3},
  };
  for (const Block& block : blocks) {
    status = par::evaluate(block.id, context, derived, values, &count);
    bool blockOk = status == par::Status::OK && count == 9;
    for (int row = 0; row < 3 && blockOk; ++row) {
      for (int column = 0; column < 3 && blockOk; ++column) {
        const double expected =
            static_cast<double>((row + block.rowOffset) * 6 + column + block.columnOffset);
        blockOk = values[row * 3 + column] == expected;
      }
    }
    reportExact(block.name, blockOk, "9 entries at the right offsets");
  }
}

// ---------------------------------------------------------------------------
// 9. Roster totality. Every parameter the roster marks as answerable must be
// answered or refused BY NAME — never fall through to the default arm.
// ---------------------------------------------------------------------------

void checkRosterTotality() {
  std::printf("\n-- roster totality --\n");
  orb::Cartesian state;
  state.position = {7000000.0, 1200000.0, 300000.0};
  state.velocity = {-1500.0, 7100.0, 400.0};
  par::EvaluationContext context = makeContext(state, 3.986004418e14);
  setEpoch(&context, 2026, 8, 29, 12, 0, 0.0);
  context.referenceUtc1 = context.utc1;
  context.referenceUtc2 = context.utc2 - 1.0;
  context.referenceEpochSupplied = true;
  context.properties.hasDryMass = true;
  context.properties.dryMass = 850.0;
  context.properties.hasTotalMass = true;
  context.properties.totalMass = 1000.0;
  context.properties.hasDragCoefficient = true;
  context.properties.dragCoefficient = 2.2;
  context.properties.hasReflectivityCoefficient = true;
  context.properties.reflectivityCoefficient = 1.8;
  context.properties.hasDragArea = true;
  context.properties.dragArea = 15.0;
  context.properties.hasSolarRadiationPressureArea = true;
  context.properties.solarRadiationPressureArea = 20.0;
  context.properties.hasDragScaleFactor = true;
  context.properties.dragScaleFactor = 1.0;
  context.properties.hasSolarRadiationPressureScaleFactor = true;
  context.properties.solarRadiationPressureScaleFactor = 1.0;
  context.properties.hasAtmosphericDensityScaleFactor = true;
  context.properties.atmosphericDensityScaleFactor = 1.0;
  for (int i = 0; i < 36; ++i) context.stateTransitionMatrix[i] = static_cast<double>(i);
  context.stateTransitionMatrixSupplied = true;

  par::Derived derived;
  par::buildDerived(context, &derived);

  int answerable = 0;
  int answered = 0;
  int namedRefusals = 0;
  int fellThrough = 0;
  int declared = 0;
  for (int i = 0; i < par::kCatalogSize; ++i) {
    const par::Descriptor& descriptor = par::kCatalog[i];
    if (descriptor.kind == par::ValueKind::CONTAINER) continue;
    if (descriptor.availability != par::Availability::IMPLEMENTED &&
        descriptor.availability != par::Availability::CALLER_SUPPLIED) {
      ++declared;
      double values[36] = {0.0};
      int count = 0;
      const par::Status status =
          par::evaluate(descriptor.id, context, derived, values, &count);
      if (status != par::Status::NOT_IMPLEMENTED || count != 0) {
        std::printf("  %s: declared parameter did not refuse cleanly (status %d)\n",
                    descriptor.name, static_cast<int>(status));
        ++fellThrough;
      }
      continue;
    }
    ++answerable;
    if (descriptor.kind == par::ValueKind::EPOCH_TEXT) {
      char text[64] = {0};
      const par::Status status = par::evaluateText(descriptor.id, context, text, sizeof text);
      if (status == par::Status::OK) {
        ++answered;
      } else {
        std::printf("  %s: epoch text refused (status %d)\n", descriptor.name,
                    static_cast<int>(status));
        ++fellThrough;
      }
      continue;
    }
    double values[36] = {0.0};
    int count = 0;
    const par::Status status = par::evaluate(descriptor.id, context, derived, values, &count);
    if (status == par::Status::OK) {
      ++answered;
    } else if (status == par::Status::NOT_IMPLEMENTED) {
      std::printf("  %s: marked implemented but the evaluator has no arm\n",
                  descriptor.name);
      ++fellThrough;
    } else {
      // A named refusal on a state where the quantity genuinely does not exist
      // (a B-plane on this bound orbit) is the correct answer.
      ++namedRefusals;
    }
  }
  std::printf("  answerable %d, answered %d, named refusals %d, declared-and-refusing %d\n",
              answerable, answered, namedRefusals, declared);
  reportExact("every answerable parameter has an evaluator arm", fellThrough == 0,
              fellThrough == 0 ? "no fall-through" : "fell through");

  // An unknown name is refused rather than guessed at.
  reportExact("an unknown parameter name resolves to nothing",
              par::findByName("NotAParameter") == nullptr, "nullptr");
  reportExact("a known parameter name resolves to its descriptor",
              par::findByName("BdotT") != nullptr &&
                  par::findByName("BdotT")->id == par::ParameterId::BdotT,
              "BdotT");
  // The roster carries the angle and its conjugate momentum as DIFFERENT
  // parameters; a case-insensitive lookup would collide them.
  reportExact("Delaunayl and DelaunayL are different parameters",
              par::findByName("Delaunayl") != nullptr &&
                  par::findByName("DelaunayL") != nullptr &&
                  par::findByName("Delaunayl")->id != par::findByName("DelaunayL")->id,
              "distinct ids");
}

}  // namespace

int main() {
  std::printf("parameter catalog parity harness\n");
  std::printf("roster: %d parameters\n", par::kCatalogSize);

  checkElementSets();
  checkOrbitalScalars();
  checkGeodetic();
  checkSiderealTime();
  checkTimeScales();
  checkBPlane();
  checkBetaAngle();
  checkStateTransition();
  checkRosterTotality();

  std::printf("\n%d checks, %d failures\n", gChecks, gFailures);
  return gFailures == 0 ? 0 : 1;
}
