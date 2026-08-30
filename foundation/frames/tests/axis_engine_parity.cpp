// axis_engine_parity.cpp — computable-outcome parity measurements for the
// GMAT-parity axis engine (gmat-08-frames-and-state-representations).
//
// Every assertion here is a NUMBER with a stated authority:
//
//   * ERFA (BSD-3, derived with permission from IAU SOFA) for the "one chain"
//     criterion — the shipped chain and higherpop/frames.hpp reach the SAME
//     series evaluation, so the check is that this engine COMPOSES the chain
//     correctly against an independently assembled composition, not that two
//     series agree;
//   * the IAU/WGCCRE 2015 report's published rotation elements for the Mars
//     and Moon body-fixed pole directions;
//   * Hapgood (1992) for the GSE/GSM defining properties (x toward the Sun;
//     the geomagnetic dipole in the GSM x-z plane);
//   * the CR3BP collinear quintic for the Earth-Moon L1 location;
//   * orthonormality, determinant and involution identities, which are EXACT
//     properties of a rotation and so admit a machine-precision bound rather
//     than a negotiated one.
//
// The epoch is the one the IAU SOFA "Time Scales and Earth Rotation" cookbook
// works through (2007-04-05 12:00:00 UTC, with its xp/yp/UT1-UTC), because it
// is a well-exercised case — but the CIP X/Y/s/ERA values in section 1 are
// recorded from the VENDORED ERFA at this pin as a regression lock, and are
// NOT presented as independently published cookbook digits.
//
// Build:
//   c++ -std=c++17 -O2 -I../src -I<erfa> -o /tmp/axis axis_engine_parity.cpp <erfa objects>

#include "axis_engine.hpp"

#include <cstdio>
#include <cmath>
#include <vector>

using namespace sdn::frames;

namespace {

int failures = 0;
int checks = 0;

void report(const char* name, double measured, double tolerance, const char* authority) {
  ++checks;
  const bool ok = std::isfinite(measured) && std::fabs(measured) <= tolerance;
  if (!ok) {
    ++failures;
  }
  std::printf("  %-52s %12.4e  (tol %8.1e)  %-6s  %s\n", name, measured, tolerance,
              ok ? "PASS" : "FAIL", authority);
}

/// Largest absolute element difference between two matrices.
double maxElementDifference(const Mat3& a, const Mat3& b) {
  double worst = 0.0;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      const double difference = std::fabs(a.m[i][j] - b.m[i][j]);
      if (difference > worst) {
        worst = difference;
      }
    }
  }
  return worst;
}

/// How far a matrix is from orthonormal: max |R R^T - I| over all elements.
double orthonormalityDefect(const Mat3& r) {
  return maxElementDifference(multiply(r, transpose(r)), identity());
}

/// Determinant, which must be +1 for a proper rotation (not -1: a reflection
/// would silently mirror every state that crossed the frame).
double determinant(const Mat3& r) {
  return r.m[0][0] * (r.m[1][1] * r.m[2][2] - r.m[1][2] * r.m[2][1]) -
         r.m[0][1] * (r.m[1][0] * r.m[2][2] - r.m[1][2] * r.m[2][0]) +
         r.m[0][2] * (r.m[1][0] * r.m[2][1] - r.m[1][1] * r.m[2][0]);
}

}  // namespace

int main(void) {
  // ---- The SOFA cookbook epoch and EOP -----------------------------------
  // IAU SOFA "Time Scales and Earth Rotation" cookbook, worked example:
  //   UTC 2007 April 05, 12:00:00
  //   xp = 0.0349282", yp = 0.4833163", UT1-UTC = -0.072073685 s
  EarthOrientation eop;
  eop.dut1 = -0.072073685;
  eop.xPole = 0.0349282 * ERFA_DAS2R;
  eop.yPole = 0.4833163 * ERFA_DAS2R;

  Epoch epoch;
  if (!epochFromUtc(2007, 4, 5, 12, 0, 0.0, eop, &epoch)) {
    std::printf("FATAL: epochFromUtc refused the SOFA cookbook date\n");
    return 1;
  }

  std::printf("axis-engine parity — SOFA cookbook epoch 2007-04-05 12:00:00 UTC\n\n");

  // ---- 1. Series regression lock ------------------------------------------
  // These are the values the VENDORED ERFA produces at this pin, recorded so a
  // toolchain change, an optimisation flag, or a refresh of
  // higherpop/third_party/erfa is caught the moment it moves a digit. They are
  // deliberately NOT presented as independently published SOFA cookbook
  // numbers: the external-authority check is the composition test in section 2
  // and the exact rotation identities in sections 3-8. Asserting half-recalled
  // reference digits would be a fabricated authority, which is worse than none.
  std::printf("IAU-2006/2000A CIO series — regression lock on the vendored ERFA:\n");
  {
    double x = 0.0;
    double y = 0.0;
    eraXy06(epoch.tt1, epoch.tt2, &x, &y);
    const double s = eraS06(epoch.tt1, epoch.tt2, x, y);
    const double era = eraEra00(epoch.ut11, epoch.ut12);

    report("CIP X - vendored-ERFA baseline", x - 0.00071226388110126192, 1e-18,
           "ERFA pin");
    report("CIP Y - vendored-ERFA baseline", y - 4.4386344068803144e-05, 1e-18,
           "ERFA pin");
    report("CIO locator s - vendored-ERFA baseline", s - (-1.0668203203684741e-08), 1e-18,
           "ERFA pin");
    report("ERA - vendored-ERFA baseline", era - 0.23245155366208792, 1e-16, "ERFA pin");
  }

  // ---- 2. "One chain": the shipped GCRF<->ITRF vs the ERFA reference ------
  // The acceptance requires the shipped module agree with higherpop's ERFA
  // chain to <= 1e-14. Both reach the same series, so the measurement below is
  // the composition assembled independently here against the one the engine
  // returns — a real check that the engine composes the chain correctly, not a
  // tautology.
  std::printf("\n'one chain' — shipped GCRF->ITRF vs an independently composed ERFA chain:\n");
  {
    const Mat3 shipped = gcrfToItrf(epoch, eop);

    double x = 0.0;
    double y = 0.0;
    eraXy06(epoch.tt1, epoch.tt2, &x, &y);
    const double s = eraS06(epoch.tt1, epoch.tt2, x, y);
    double rc2i[3][3];
    eraC2ixys(x + eop.dX, y + eop.dY, s, rc2i);
    const double era = eraEra00(epoch.ut11, epoch.ut12);
    const double sp = eraSp00(epoch.tt1, epoch.tt2);
    double rpom[3][3];
    eraPom00(eop.xPole, eop.yPole, sp, rpom);
    double rc2t[3][3];
    eraC2tcio(rc2i, era, rpom, rc2t);
    Mat3 reference;
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j) {
        reference.m[i][j] = rc2t[i][j];
      }
    }
    report("max |GCRF->ITRF shipped - ERFA reference|", maxElementDifference(shipped, reference),
           1e-14, "ERFA");
  }

  // ---- 3. Every axis type: proper-rotation and involution identities ------
  // A rotation that is not orthonormal, or whose determinant is -1, silently
  // corrupts every state that crosses it. These identities are exact, so the
  // bound is machine precision rather than a physics tolerance.
  std::printf("\nevery Earth-chain axis type — proper-rotation identities:\n");
  {
    struct Named {
      const char* name;
      Mat3 matrix;
    };
    const std::vector<Named> axes = {
        {"ICRF->ITRF", gcrfToItrf(epoch, eop)},
        {"ICRF->MOD", gcrfToMod(epoch)},
        {"ICRF->TOD", gcrfToTod(epoch)},
        {"ICRF->MJ2000Eq", gcrfToMj2000Eq(epoch)},
        {"ICRF->MJ2000Ec", gcrfToMj2000Ec(epoch)},
        {"ICRF->MOE", gcrfToMoe(epoch)},
        {"ICRF->TOE", gcrfToToe(epoch)},
        {"ICRF->TEME", gcrfToTeme(epoch)},
        {"ICRF->MOD_FK5 (legacy)", gcrfToModFk5(epoch)},
        {"ICRF->TOD_FK5 (legacy)", gcrfToTodFk5(epoch)},
        {"ICRF->GSE", gcrfToGse(epoch)},
    };
    for (const Named& axis : axes) {
      char label[128];
      std::snprintf(label, sizeof(label), "%s orthonormality", axis.name);
      report(label, orthonormalityDefect(axis.matrix), 1e-14, "exact");
      std::snprintf(label, sizeof(label), "%s det - 1", axis.name);
      report(label, determinant(axis.matrix) - 1.0, 1e-14, "exact");
    }
  }

  // ---- 4. GSM with a supplied dipole -------------------------------------
  std::printf("\nGSE / GSM:\n");
  {
    // IGRF-2005 dipole: geographic colatitude 9.87 deg, east longitude
    // -71.78 deg. Supplied as a PARAMETER, per the header's contract.
    GeomagneticDipole dipole;
    dipole.colatitude = 9.87 * ERFA_DD2R;
    dipole.eastLongitude = -71.78 * ERFA_DD2R;

    const Mat3 gsm = gcrfToGsm(epoch, eop, dipole);
    report("GSM orthonormality", orthonormalityDefect(gsm), 1e-14, "exact");
    report("GSM det - 1", determinant(gsm) - 1.0, 1e-14, "exact");

    // Hapgood's defining property: in BOTH GSE and GSM the x axis points at
    // the Sun, so the two differ by a pure rotation about x.
    const Mat3 gse = gcrfToGse(epoch);
    const Vec3 sunHat = sunDirectionGcrf(epoch);
    const Vec3 gseX = apply(gse, sunHat);
    const Vec3 gsmX = apply(gsm, sunHat);
    report("GSE x-axis . Sun - 1 (Hapgood defining property)", gseX.x - 1.0, 1e-9, "Hapgood 1992");
    report("GSM x-axis . Sun - 1 (Hapgood defining property)", gsmX.x - 1.0, 1e-9, "Hapgood 1992");

    // And the dipole lies in the GSM x-z plane: its y component vanishes.
    const Vec3 dipoleFixed = {std::sin(dipole.colatitude) * std::cos(dipole.eastLongitude),
                              std::sin(dipole.colatitude) * std::sin(dipole.eastLongitude),
                              std::cos(dipole.colatitude)};
    const Mat3 itrfToGcrfMatrix = transpose(gcrfToItrf(epoch, eop));
    const Vec3 dipoleGcrf = unit(apply(itrfToGcrfMatrix, dipoleFixed));
    const Vec3 dipoleGsm = apply(gsm, dipoleGcrf);
    report("GSM dipole y-component (must vanish)", dipoleGsm.y, 1e-15, "Hapgood 1992");
  }

  // ---- 5. Non-Earth body-fixed: the IAU/WGCCRE rotation elements ---------
  std::printf("\nnon-Earth body-fixed (IAU/WGCCRE rotation elements):\n");
  {
    // IAU/WGCCRE 2015 report, Mars: alpha0 = 317.68143 - 0.1061 T,
    // delta0 = 52.88650 - 0.0609 T, W = 176.630 + 350.89198226 d.
    RotationElements mars;
    mars.alpha0 = 317.68143 * ERFA_DD2R;
    mars.alpha1 = -0.1061 * ERFA_DD2R;
    mars.delta0 = 52.88650 * ERFA_DD2R;
    mars.delta1 = -0.0609 * ERFA_DD2R;
    mars.w0 = 176.630 * ERFA_DD2R;
    mars.wDot = 350.89198226 * ERFA_DD2R;

    const Mat3 marsFixed = icrfToBodyFixed(epoch, mars);
    report("Mars body-fixed orthonormality", orthonormalityDefect(marsFixed), 1e-14, "exact");
    report("Mars body-fixed det - 1", determinant(marsFixed) - 1.0, 1e-14, "exact");

    // The third row of the ICRF->body-fixed matrix IS the body's north pole
    // expressed in the ICRF; check it against the published elements directly.
    const double centuries = ((epoch.tt1 - ERFA_DJ00) + epoch.tt2) / 36525.0;
    const double alpha = mars.alpha0 + mars.alpha1 * centuries;
    const double delta = mars.delta0 + mars.delta1 * centuries;
    const Vec3 publishedPole = {std::cos(delta) * std::cos(alpha),
                                std::cos(delta) * std::sin(alpha), std::sin(delta)};
    const Vec3 modelPole = {marsFixed.m[2][0], marsFixed.m[2][1], marsFixed.m[2][2]};
    const double poleAngle =
        std::acos(std::fmin(1.0, std::fmax(-1.0, dot(publishedPole, modelPole))));
    report("Mars pole vs WGCCRE published elements (rad)", poleAngle, 1e-9, "IAU/WGCCRE 2015");

    // IAU/WGCCRE Moon (the mean elements, not the full libration series):
    RotationElements moon;
    moon.alpha0 = 269.9949 * ERFA_DD2R;
    moon.delta0 = 66.5392 * ERFA_DD2R;
    moon.w0 = 38.3213 * ERFA_DD2R;
    moon.wDot = 13.17635815 * ERFA_DD2R;
    const Mat3 moonFixed = icrfToBodyFixed(epoch, moon);
    report("Moon body-fixed orthonormality", orthonormalityDefect(moonFixed), 1e-14, "exact");
    const Vec3 moonPublishedPole = {std::cos(moon.delta0) * std::cos(moon.alpha0),
                                    std::cos(moon.delta0) * std::sin(moon.alpha0),
                                    std::sin(moon.delta0)};
    const Vec3 moonModelPole = {moonFixed.m[2][0], moonFixed.m[2][1], moonFixed.m[2][2]};
    const double moonPoleAngle =
        std::acos(std::fmin(1.0, std::fmax(-1.0, dot(moonPublishedPole, moonModelPole))));
    report("Moon pole vs WGCCRE published elements (rad)", moonPoleAngle, 1e-9, "IAU/WGCCRE 2015");
  }

  // ---- 6. The one RTN convention -----------------------------------------
  std::printf("\nObjectReferenced — the single RTN/RIC/RSW convention:\n");
  {
    const Vec3 position = {7000000.0, 1200000.0, 300000.0};
    const Vec3 velocity = {-1500.0, 7100.0, 400.0};
    Mat3 rtn;
    if (!radialTransverseNormal(position, velocity, &rtn)) {
      std::printf("  FATAL: radialTransverseNormal refused a regular state\n");
      return 1;
    }
    report("RTN orthonormality", orthonormalityDefect(rtn), 1e-15, "exact");
    report("RTN det - 1", determinant(rtn) - 1.0, 1e-15, "exact");

    // Defining property: the radial axis carries the position exactly, so the
    // rotated position has zero in-track and cross-track components.
    const Vec3 rotated = apply(rtn, position);
    report("RTN rotated position y (must vanish)", rotated.y / norm(position), 1e-15, "exact");
    report("RTN rotated position z (must vanish)", rotated.z / norm(position), 1e-15, "exact");

    // And the general ObjectReferenced triad with RADIAL primary / VELOCITY
    // secondary must BE that same matrix — one convention, not three.
    Mat3 viaObjectReferenced;
    if (!objectReferencedTriad(OrbitalDirection::RADIAL, OrbitalDirection::VELOCITY, position,
                               velocity, &viaObjectReferenced)) {
      std::printf("  FATAL: objectReferencedTriad refused a regular state\n");
      return 1;
    }
    report("ObjectReferenced(R,V) identical to RTN",
           maxElementDifference(rtn, viaObjectReferenced), 1e-15, "exact");
  }

  // ---- 7. Arbitrary origins round-trip ------------------------------------
  std::printf("\narbitrary origins — translate to the origin and back:\n");
  {
    const StateVector spacecraft{{7000000.0, 1200000.0, 300000.0}, {-1500.0, 7100.0, 400.0}};

    // Earth-Moon barycentre. The mass ratio is a parameter (DE440 value).
    const double moonToEarthMassRatio = 0.0123000371;
    const Vec3 barycenter = earthMoonBarycenterGcrf(epoch, moonToEarthMassRatio);
    const StateVector barycenterState{barycenter, {0.0, 0.0, 0.0}};
    const StateVector aboutBarycenter = translateState(spacecraft, barycenterState);
    const StateVector backFromBarycenter =
        translateState(aboutBarycenter, {scale(barycenter, -1.0), {0.0, 0.0, 0.0}});
    report("barycentre-origin round-trip (relative)",
           norm(sub(backFromBarycenter.position, spacecraft.position)) / norm(spacecraft.position),
           1e-12, "exact");

    // Earth-Moon L1.
    const Vec3 moon = moonPositionGcrf(epoch);
    Vec3 l1;
    const double massRatio = moonToEarthMassRatio / (1.0 + moonToEarthMassRatio);
    if (!librationPoint(moon, massRatio, 1, &l1)) {
      std::printf("  FATAL: librationPoint refused the Earth-Moon pair\n");
      return 1;
    }
    // L1 must lie between the two primaries, on the line joining them.
    const double alongLine = dot(l1, unit(moon));
    const double offLine = norm(sub(l1, scale(unit(moon), alongLine)));
    report("L1 off-axis displacement (relative, must vanish)", offLine / norm(moon), 1e-15,
           "exact");
    // `librationPoint` returns the point relative to the BARYCENTRE, and the
    // Earth sits at -massRatio * d from it, so the classical "L1 is at 0.849 of
    // the Earth-Moon distance" figure is measured from EARTH, not from the
    // barycentre. Converting before comparing is the difference between a real
    // check and one that passes for the wrong reason.
    const double l1FractionFromEarth = (alongLine + massRatio * norm(moon)) / norm(moon);
    report("L1 fraction of the Earth-Moon distance from Earth - 0.8489",
           l1FractionFromEarth - 0.8489, 1e-3, "CR3BP quintic");

    const StateVector l1State{l1, {0.0, 0.0, 0.0}};
    const StateVector aboutL1 = translateState(spacecraft, l1State);
    const StateVector backFromL1 = translateState(aboutL1, {scale(l1, -1.0), {0.0, 0.0, 0.0}});
    report("L1-origin round-trip (relative)",
           norm(sub(backFromL1.position, spacecraft.position)) / norm(spacecraft.position), 1e-12,
           "exact");

    // Another spacecraft as the origin.
    const StateVector other{{6900000.0, 1300000.0, 250000.0}, {-1520.0, 7050.0, 380.0}};
    const StateVector relative = translateState(spacecraft, other);
    const StateVector restored = translateState(
        relative, {scale(other.position, -1.0), scale(other.velocity, -1.0)});
    report("spacecraft-origin round-trip (relative)",
           norm(sub(restored.position, spacecraft.position)) / norm(spacecraft.position), 1e-12,
           "exact");
  }

  // ---- 8. Full axis round-trip through every Earth-chain axis type -------
  std::printf("\nstate round-trip through every Earth-chain axis type:\n");
  {
    const StateVector spacecraft{{7000000.0, 1200000.0, 300000.0}, {-1500.0, 7100.0, 400.0}};
    struct Named {
      const char* name;
      Mat3 matrix;
    };
    const std::vector<Named> axes = {
        {"ITRF", gcrfToItrf(epoch, eop)},   {"MOD", gcrfToMod(epoch)},
        {"TOD", gcrfToTod(epoch)},          {"MJ2000Eq", gcrfToMj2000Eq(epoch)},
        {"MJ2000Ec", gcrfToMj2000Ec(epoch)},{"MOE", gcrfToMoe(epoch)},
        {"TOE", gcrfToToe(epoch)},          {"TEME", gcrfToTeme(epoch)},
        {"GSE", gcrfToGse(epoch)},
    };
    // Earth rotation rate for the ITRF case; a parameter, not a frozen
    // constant — every other axis pair here is non-rotating to the precision
    // this identity tests.
    for (const Named& axis : axes) {
      const StateVector forward = rotateState(axis.matrix, Vec3{0.0, 0.0, 0.0}, spacecraft);
      const StateVector back = rotateState(transpose(axis.matrix), Vec3{0.0, 0.0, 0.0}, forward);
      char label[128];
      std::snprintf(label, sizeof(label), "ICRF->%s->ICRF position (relative)", axis.name);
      report(label, norm(sub(back.position, spacecraft.position)) / norm(spacecraft.position),
             1e-15, "exact");
      std::snprintf(label, sizeof(label), "ICRF->%s->ICRF velocity (relative)", axis.name);
      report(label, norm(sub(back.velocity, spacecraft.velocity)) / norm(spacecraft.velocity),
             1e-15, "exact");
    }
  }

  // ---- 9. Angular RATES ---------------------------------------------------
  //
  // The acceptance asks for angular rates, not only orientations. The authority
  // for the Earth-rotation chain is the IERS Conventions (2010) nominal mean
  // angular velocity of the Earth, 7.292115e-5 rad/s: the differentiated
  // GCRF->ITRF chain must reproduce it, because that constant IS the ERA rate
  // the chain applies.
  std::printf("\nangular rates:\n");
  {
    const double kEarthRotationRate = 7.292115e-5;  // rad/s, IERS Conventions (2010) Table 1.1

    const RotationWithRate itrf =
        rotationWithRate([&](const Epoch& at) { return gcrfToItrf(at, eop); }, epoch);
    const double measured = norm(itrf.angularVelocitySource);
    report("GCRF->ITRF angular rate vs IERS nominal", measured - kEarthRotationRate, 1e-11,
           "IERS 2010");

    // The rate matrix and the angular velocity are two views of the same
    // quantity; reconstructing one from the other is an EXACT identity and so
    // takes a machine-precision bound. This is what catches a sign or a
    // transpose, which a magnitude check cannot.
    {
      const Vec3 omegaTarget = apply(itrf.rotation, itrf.angularVelocitySource);
      Mat3 skew;
      skew.m[0][0] = 0.0;             skew.m[0][1] = -omegaTarget.z;  skew.m[0][2] = omegaTarget.y;
      skew.m[1][0] = omegaTarget.z;   skew.m[1][1] = 0.0;             skew.m[1][2] = -omegaTarget.x;
      skew.m[2][0] = -omegaTarget.y;  skew.m[2][1] = omegaTarget.x;   skew.m[2][2] = 0.0;
      Mat3 reconstructed = multiply(skew, itrf.rotation);
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
          reconstructed.m[i][j] = -reconstructed.m[i][j];
        }
      }
      report("ITRF rate matrix vs -[omega]x R identity",
             maxElementDifference(reconstructed, itrf.rate) / kEarthRotationRate, 1e-9, "exact");
    }

    // Step independence: halving the central-difference step must not move the
    // answer beyond the numerical budget. A rate that changes with the step is
    // a rate that is measuring the step.
    //
    // BUDGET, and this is the number that bounds the METHOD rather than the
    // physics: truncation contributes (omega^3/6)(1 - 1/4)h^2 ~ 8e-15 rad/s at
    // h = 1 s, and differencing two O(1) matrices adds a round-off floor of
    // about 2 eps / (2h) ~ 2e-16 per element, amplified through the skew
    // extraction. MEASURED 4.5e-14 rad/s on this box at this pin; the bound is
    // set just above it and is the honest accuracy of the differentiated rate.
    const RotationWithRate itrfHalfStep = rotationWithRate(
        [&](const Epoch& at) { return gcrfToItrf(at, eop); }, epoch, 0.5);
    report("GCRF->ITRF angular rate, step 1.0 s vs 0.5 s",
           norm(sub(itrf.angularVelocitySource, itrfHalfStep.angularVelocitySource)), 1e-13,
           "exact");

    // The non-rotating chains: precession/nutation turn at ~10^-12 rad/s, the
    // published rate of general precession (about 50.3"/yr). Anything near the
    // Earth-rotation rate here would mean the chain had picked up ERA.
    struct NamedRate {
      const char* name;
      double bound;
      Mat3 (*fn)(const Epoch&);
    };
    const std::vector<NamedRate> slow = {
        {"MOD", 1e-11, gcrfToMod},
        {"TOD", 1e-11, gcrfToTod},
        {"MOE", 1e-11, gcrfToMoe},
        {"TOE", 1e-11, gcrfToToe},
        {"TEME", 1e-11, gcrfToTeme},
    };
    for (const NamedRate& entry : slow) {
      const RotationWithRate withRate =
          rotationWithRate([&](const Epoch& at) { return entry.fn(at); }, epoch);
      char label[128];
      std::snprintf(label, sizeof(label), "GCRF->%s angular rate is precession-scale",
                    entry.name);
      report(label, norm(withRate.angularVelocitySource), entry.bound, "IAU 2006 precession");
    }

    // GSE turns with the apparent motion of the Sun: one revolution per year,
    // 1.99e-7 rad/s. The bound is the eccentricity spread of that rate.
    {
      const RotationWithRate gse =
          rotationWithRate([&](const Epoch& at) { return gcrfToGse(at); }, epoch);
      const double annual = 2.0 * ERFA_DPI / (365.25 * 86400.0);
      report("GCRF->GSE angular rate vs the annual rate",
             norm(gse.angularVelocitySource) - annual, 8e-9, "Kepler, 1 yr period");
    }
  }

  // ---- 10. Machine-readable reference block -------------------------------
  //
  // Emitted so the SHIPPED WASM ARTIFACT can be compared against this native
  // build of the same header, at the same epoch and EOP, in the same run. That
  // comparison is the only thing that turns "one chain" from a claim about the
  // source into a measurement of the bytes that ship.
  {
    const Mat3 itrf = gcrfToItrf(epoch, eop);
    const Mat3 gse = gcrfToGse(epoch);
    const RotationWithRate itrfRate =
        rotationWithRate([&](const Epoch& at) { return gcrfToItrf(at, eop); }, epoch);
    std::printf("\nREFERENCE_JSON_BEGIN\n{\n");
    std::printf("  \"epochUtc\": \"2007-04-05T12:00:00\",\n");
    std::printf("  \"dut1\": %.17g,\n", eop.dut1);
    std::printf("  \"xPoleArcsec\": %.17g,\n", eop.xPole / ERFA_DAS2R);
    std::printf("  \"yPoleArcsec\": %.17g,\n", eop.yPole / ERFA_DAS2R);
    const char* names[2] = {"gcrfToItrf", "gcrfToGse"};
    const Mat3* matrices[2] = {&itrf, &gse};
    for (int m = 0; m < 2; ++m) {
      std::printf("  \"%s\": [", names[m]);
      for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
          std::printf("%s%.17g", (i == 0 && j == 0) ? "" : ", ", matrices[m]->m[i][j]);
        }
      }
      std::printf("],\n");
    }
    std::printf("  \"gcrfToItrfAngularVelocity\": [%.17g, %.17g, %.17g]\n",
                itrfRate.angularVelocitySource.x, itrfRate.angularVelocitySource.y,
                itrfRate.angularVelocitySource.z);
    std::printf("}\nREFERENCE_JSON_END\n");
  }

  std::printf("\n%d checks, %d failures\n", checks, failures);
  std::printf("%s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
