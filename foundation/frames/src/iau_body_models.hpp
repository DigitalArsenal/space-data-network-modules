// IAU body-orientation models, evaluated in C++ in every runtime.
//
// Sources: Archinal et al., WGCCRE 2015, CMDA 130:22 (2018), Table 1,
// https://doi.org/10.1007/s10569-017-9805-5 ; numerical coefficients from
// https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc .
// The 2015 report does NOT tabulate lunar rotational elements. IAU_MOON below
// retains the WGCCRE 2009 trigonometric model, as does NAIF pck00011. It
// approximates the lunar Mean Earth/Polar Axis frame; it is not the binary-PCK
// MOON_PA or MOON_ME model. See the kernel's "Lunar orientation" section.
//
// Pole RA/Dec and prime meridian W are relative to ICRF (SPICE calls it J2000).
// The time argument is TDB, not UTC, UT1, or TT. All source coefficients are
// degrees; T = TDB days since J2000 / 36525.0. Pole polynomials use centuries,
// W uses days, and the periodic phase rates below use degrees/century exactly
// as in pck00011. Include every nonzero periodic term, including Mercury's
// libration, Mars's pole/W terms, Jupiter's pole terms, and lunar E1..E13.

#ifndef SDN_FOUNDATION_FRAMES_IAU_BODY_MODELS_HPP
#define SDN_FOUNDATION_FRAMES_IAU_BODY_MODELS_HPP

#include <cmath>

namespace sdn {
namespace frames {
namespace iau2015 {

namespace detail {

constexpr double kRadiansPerDegree = 0.017453292519943295769236907684886;

struct PeriodicTerm {
  double phase0;       // degrees
  double phaseRate;    // degrees / Julian century
  double alpha;        // coefficient of sin(phase), degrees
  double delta;        // coefficient of cos(phase), degrees
  double w;            // coefficient of sin(phase), degrees
};

template <unsigned N>
inline void addPeriodic(const PeriodicTerm (&terms)[N], double centuries,
                        double* alpha, double* delta, double* w) {
  for (unsigned i = 0; i < N; ++i) {
    const auto& term = terms[i];
    const double phase = (term.phase0 + term.phaseRate * centuries) * kRadiansPerDegree;
    *alpha += term.alpha * std::sin(phase);
    *delta += term.delta * std::cos(phase);
    *w += term.w * std::sin(phase);
  }
}

}  // namespace detail

/// Evaluate pole RA, pole declination, and prime meridian W in radians.
/// naifBody uses physical-body IDs (10, 199, 299, 301, 499, 599, 699), not
/// planetary barycentre IDs. W is reduced to [0, 2*pi). The result defines
/// ICRF -> body-fixed as R3(W) R1(pi/2-delta) R3(pi/2+alpha), using passive
/// rotations. Unsupported IDs, null outputs, or nonfinite time return false
/// without changing outputs. These are analytical IAU models, not ephemeris
/// binary-PCK orientations or precision mission reference frames.
inline bool orientation(int naifBody, double tdbDaysSinceJ2000,
                        double* alphaRadians, double* deltaRadians,
                        double* wRadians) {
  if (!alphaRadians || !deltaRadians || !wRadians ||
      !std::isfinite(tdbDaysSinceJ2000)) {
    return false;
  }
  const double d = tdbDaysSinceJ2000;
  const double t = d / 36525.0;
  double alpha = 0.0;
  double delta = 0.0;
  double w = 0.0;

  switch (naifBody) {
    case 10:  // Sun, WGCCRE 2015 Table 1 (unchanged from 2009).
      alpha = 286.13;
      delta = 63.87;
      w = 84.176 + 14.18440 * d;
      break;

    case 199: {  // Mercury, including all five longitudinal libration terms.
      alpha = 281.0103 - 0.0328 * t;
      delta = 61.4155 - 0.0049 * t;
      w = 329.5988 + 6.1385108 * d;
      static constexpr detail::PeriodicTerm terms[] = {
          {174.7910857, 149472.53587500003, 0.0, 0.0, 0.01067257},
          {349.5821714, 298945.07175000006, 0.0, 0.0, -0.00112309},
          {164.3732571, 448417.60762500006, 0.0, 0.0, -0.00011040},
          {339.1643429, 597890.14350000012, 0.0, 0.0, -0.00002539},
          {153.9554286, 747362.67937499995, 0.0, 0.0, -0.00000571},
      };
      detail::addPeriodic(terms, t, &alpha, &delta, &w);
      break;
    }

    case 299:  // Venus: negative W rate encodes retrograde rotation.
      alpha = 272.76;
      delta = 67.16;
      w = 160.20 - 1.4813688 * d;
      break;

    case 301: {  // Moon: retained WGCCRE 2009 model, E1 through E13.
      alpha = 269.9949 + 0.0031 * t;
      delta = 66.5392 + 0.0130 * t;
      w = 38.3213 + (13.17635815 - 1.4e-12 * d) * d;
      static constexpr detail::PeriodicTerm terms[] = {
          {125.045, -1935.5364525000, -3.8787, 1.5419, 3.5610},
          {250.089, -3871.0729050000, -0.1204, 0.0239, 0.1208},
          {260.008, 475263.3328725000, 0.0700, -0.0278, -0.0642},
          {176.625, 487269.6299850000, -0.0172, 0.0068, 0.0158},
          {357.529, 35999.0509575000, 0.0, 0.0, 0.0252},
          {311.589, 964468.4993100000, 0.0072, -0.0029, -0.0066},
          {134.963, 477198.8693250000, 0.0, 0.0009, -0.0047},
          {276.617, 12006.3007650000, 0.0, 0.0, -0.0046},
          {34.226, 63863.5132425000, 0.0, 0.0, 0.0028},
          {15.134, -5806.6093575000, -0.0052, 0.0008, 0.0052},
          {119.743, 131.8406400000, 0.0, 0.0, 0.0040},
          {239.961, 6003.1503825000, 0.0, 0.0, 0.0019},
          {25.053, 473327.7964200000, 0.0043, -0.0009, -0.0044},
      };
      detail::addPeriodic(terms, t, &alpha, &delta, &w);
      break;
    }

    case 499: {  // Mars, WGCCRE 2015 Table 1.
      alpha = 317.269202 - 0.10927547 * t;
      delta = 54.432516 - 0.05827105 * t;
      w = 176.049863 + 350.891982443297 * d;
      // Mars itself uses phases 11..26 of BODY4_NUT_PREC_ANGLES; all of
      // those phases are linear. The kernel's quadratic phase belongs to
      // Phobos and has zero coefficients in the Mars orientation model.
      static constexpr detail::PeriodicTerm terms[] = {
          {198.991226, 19139.4819985, 0.000068, 0.0, 0.0},
          {226.292679, 38280.8511281, 0.000238, 0.0, 0.0},
          {249.663391, 57420.7251593, 0.000052, 0.0, 0.0},
          {266.183510, 76560.6367950, 0.000009, 0.0, 0.0},
          {79.398797, 0.5042615, 0.419057, 0.0, 0.0},
          {122.433576, 19139.9407476, 0.0, 0.000051, 0.0},
          {43.058401, 38280.8753272, 0.0, 0.000141, 0.0},
          {57.663379, 57420.7517205, 0.0, 0.000031, 0.0},
          {79.476401, 76560.6495004, 0.0, 0.000005, 0.0},
          {166.325722, 0.5042615, 0.0, 1.591274, 0.0},
          {129.071773, 19140.0328244, 0.0, 0.0, 0.000145},
          {36.352167, 38281.0473591, 0.0, 0.0, 0.000157},
          {56.668646, 57420.9295360, 0.0, 0.0, 0.000040},
          {67.364003, 76560.2552215, 0.0, 0.0, 0.000001},
          {104.792680, 95700.4387578, 0.0, 0.0, 0.000001},
          {95.391654, 0.5042615, 0.0, 0.0, 0.584542},
      };
      detail::addPeriodic(terms, t, &alpha, &delta, &w);
      break;
    }

    case 599: {  // Jupiter, JA..JE pole terms; System III prime meridian.
      alpha = 268.056595 - 0.006499 * t;
      delta = 64.495303 + 0.002413 * t;
      w = 284.95 + 870.5360000 * d;
      static constexpr detail::PeriodicTerm terms[] = {
          {99.360714, 4850.4046, 0.000117, 0.000050, 0.0},
          {175.895369, 1191.9605, 0.000938, 0.000404, 0.0},
          {300.323162, 262.5475, 0.001432, 0.000617, 0.0},
          {114.012305, 6070.2476, 0.000030, -0.000013, 0.0},
          {49.511251, 64.3000, 0.002150, 0.000926, 0.0},
      };
      detail::addPeriodic(terms, t, &alpha, &delta, &w);
      break;
    }

    case 699:  // Saturn, WGCCRE 2015 Table 1 (unchanged from 2009).
      alpha = 40.589 - 0.036 * t;
      delta = 83.537 - 0.004 * t;
      w = 38.90 + 810.7939024 * d;
      break;

    default:
      return false;
  }

  // Reducing in degrees prevents precision loss in trigonometric consumers.
  w = std::fmod(w, 360.0);
  if (w < 0.0) w += 360.0;
  if (!std::isfinite(alpha) || !std::isfinite(delta) || !std::isfinite(w)) {
    return false;
  }
  *alphaRadians = alpha * detail::kRadiansPerDegree;
  *deltaRadians = delta * detail::kRadiansPerDegree;
  *wRadians = w * detail::kRadiansPerDegree;
  return true;
}

}  // namespace iau2015
}  // namespace frames
}  // namespace sdn

#endif  // SDN_FOUNDATION_FRAMES_IAU_BODY_MODELS_HPP
