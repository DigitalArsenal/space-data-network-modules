// SPDX-License-Identifier: Apache-2.0
//
// rf-antenna-pattern — antenna-pattern gain evaluation kernel.
//
// C++ port of the analytic and sampled-grid gain evaluators from
// packages/engine/Source/Scene/AntennaPattern.js. The JS evaluator is
// the semantic spec: every helper (besselJ1, normalizedAiryGain,
// gaussianGain, halfWaveDipoleGain, applyForwardBackMix, the analytic
// family switch, normalizeDegrees360, the wrapped/clamped axis
// interpolators, and the bilinear sampled-grid lookup) is ported
// coefficient-for-coefficient and branch-for-branch so a WASM call
// reproduces the JS result to within libm rounding (parity tests
// assert 1e-12 relative against fixtures generated from the JS).
//
// Three surfaces:
//   1. Analytic families — rf_ant_gain / rf_ant_gain_db take the
//      pattern type as an enum plus the seven shape parameters by
//      value (module convention: scalars as double arguments).
//   2. Sampled grids — rf_ant_load_sampled_pattern copies the caller's
//      float64 cone/clock/gain buffers (allocated with _malloc, the
//      plugin-memory convention) into an internal handle table;
//      rf_ant_evaluate_sampled_gain_db / rf_ant_evaluate_sampled_gain
//      evaluate against a handle; rf_ant_free_pattern releases it.
//   3. Geometry bridge — rf_ant_compute_cone_clock derives the
//      antenna-local (cone, clock) angles from antenna position,
//      boresight, up, and target vectors, writing two little-endian
//      doubles into a caller-allocated result buffer (same
//      result_bytes/result_size struct convention as rf-link-budget).
//
// Authority: packages/engine/Source/Scene/AntennaPattern.js @ the
// 1.143 baseline. besselJ1 is the Numerical Recipes §6.5 rational
// approximation, exactly as transcribed in the JS.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <vector>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kPiOverTwo = kPi / 2.0;
constexpr double kDegreesPerRadian = 180.0 / kPi;
// CesiumMath.EPSILON8 / EPSILON12 as used by the JS evaluator.
constexpr double kEpsilon8 = 1.0e-8;
constexpr double kEpsilon12 = 1.0e-12;

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

inline double clampD(double value, double min, double max) {
  return value < min ? min : (value > max ? max : value);
}

inline double clamp01(double value) { return clampD(value, 0.0, 1.0); }

// powPositive(value, exponent) = Math.pow(Math.max(value, 0.0), exponent)
inline double powPositive(double value, double exponent) {
  return std::pow(value > 0.0 ? value : 0.0, exponent);
}

// AntennaPattern.js pattern-type switch cases, in declaration order.
// Unknown values fall through to RINGED exactly like the JS `default:`.
enum PatternType : int32_t {
  PATTERN_ISOTROPIC = 0,
  PATTERN_HEMISPHERIC = 1,
  PATTERN_PARABOLIC = 2,
  PATTERN_GAUSSIAN = 3,
  PATTERN_PENCIL = 4,
  PATTERN_DIPOLE = 5,
  PATTERN_HELIX = 6,
  PATTERN_DISH = 7,
  PATTERN_RINGED = 8,
  PATTERN_TOROIDAL = 9,
  PATTERN_CARDIOID = 10,
  PATTERN_TEARDROP = 11,
};

// Numerical Recipes rational approximation of J1(x) — port of
// AntennaPattern.js besselJ1, coefficient-exact.
double besselJ1(double x) {
  const double absX = std::fabs(x);
  if (absX < 8.0) {
    const double y = x * x;
    const double numerator =
        x *
        (72362614232.0 +
         y * (-7895059235.0 +
              y * (242396853.1 +
                   y * (-2972611.439 + y * (15704.4826 + y * -30.16036606)))));
    const double denominator =
        144725228442.0 +
        y * (2300535178.0 +
             y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
    return numerator / denominator;
  }

  const double z = 8.0 / absX;
  const double y = z * z;
  const double shifted = absX - 2.356194491;
  const double ans1 =
      1.0 +
      y * (0.00183105 +
           y * (-0.00003516396496 +
                y * (0.000002457520174 + y * -0.000000240337019)));
  const double ans2 =
      0.04687499995 +
      y * (-0.0002002690873 +
           y * (0.000008449199096 +
                y * (-0.00000088228987 + y * 0.000000105787412)));
  double result = std::sqrt(0.636619772 / absX) *
                  (std::cos(shifted) * ans1 - z * std::sin(shifted) * ans2);
  if (x < 0.0) {
    result = -result;
  }
  return result;
}

double normalizedAiryGain(double theta, double apertureScale) {
  const double scaled = theta * apertureScale;
  const double scaledTheta = scaled > 0.0001 ? scaled : 0.0001;
  const double airyField = (2.0 * besselJ1(scaledTheta)) / scaledTheta;
  return clamp01(airyField * airyField);
}

double gaussianGain(double theta, double widthScale, double exponent) {
  const double e = exponent > 0.35 ? exponent : 0.35;
  return clamp01(std::exp(-std::pow(theta * widthScale, e)));
}

double halfWaveDipoleGain(double theta) {
  const double sinTheta = std::sin(theta);
  if (std::fabs(sinTheta) < kEpsilon8) {
    return 0.0;
  }
  const double field = std::cos(kPiOverTwo * std::cos(theta)) / sinTheta;
  return clamp01(field * field);
}

struct AnalyticParams {
  double mainLobeExponent;
  double sideLobeLevel;
  double sideLobeCount;
  double backLobeLevel;
  double backLobeExponent;
  double axialNullExponent;
  double angularScale;
};

double applyForwardBackMix(double baseGain, double coneAngle,
                           const AnalyticParams &p) {
  const double backLobe =
      clamp01(p.backLobeLevel) *
      powPositive(std::fmax(-std::cos(coneAngle), 0.0), p.backLobeExponent);
  return clamp01(baseGain + backLobe);
}

// Port of evaluatePatternGain (analytic switch only; sampled patterns
// use the handle path, custom gainFunction stays JS-side).
double evaluateAnalyticGain(int32_t patternType, const AnalyticParams &raw,
                            double coneAngle, double clockAngle) {
  AnalyticParams p = raw;
  const double mainLobeExponent = std::fmax(p.mainLobeExponent, 0.1);
  const double sideLobeCount = std::fmax(p.sideLobeCount, 1.0);
  const double sideLobeLevel = clamp01(p.sideLobeLevel);
  const double angularScale = std::fmax(p.angularScale, 0.05);
  const double theta = coneAngle * angularScale;

  switch (patternType) {
    case PATTERN_ISOTROPIC:
      return 1.0;
    case PATTERN_HEMISPHERIC: {
      const double frontHemisphere =
          coneAngle <= kPiOverTwo
              ? 0.84 + 0.16 * powPositive(std::cos(coneAngle), 2.0)
              : 0.0;
      return applyForwardBackMix(frontHemisphere, coneAngle, p);
    }
    case PATTERN_PARABOLIC:
    case PATTERN_DISH: {
      const double apertureScale =
          4.25 + sideLobeCount * 1.2 + mainLobeExponent * 0.25;
      const double mainLobe = normalizedAiryGain(theta, apertureScale);
      return applyForwardBackMix(mainLobe, coneAngle, p);
    }
    case PATTERN_GAUSSIAN: {
      const double mainLobe =
          gaussianGain(theta, 1.65 + mainLobeExponent * 0.22, 2.0);
      return applyForwardBackMix(mainLobe, coneAngle, p);
    }
    case PATTERN_PENCIL: {
      const double mainLobe =
          gaussianGain(theta, 2.9 + mainLobeExponent * 0.28, 4.0);
      return applyForwardBackMix(mainLobe, coneAngle, p);
    }
    case PATTERN_DIPOLE: {
      const double dipole = halfWaveDipoleGain(coneAngle);
      const double ripple =
          0.06 * sideLobeLevel * powPositive(std::sin(coneAngle), 2.0) *
          std::fabs(std::cos(sideLobeCount * clockAngle));
      return clamp01(dipole + ripple);
    }
    case PATTERN_HELIX: {
      const double mainLobe =
          gaussianGain(theta, 1.95 + mainLobeExponent * 0.18, 2.35);
      const double ringEnvelope = std::exp(-std::pow(theta * 1.3, 1.65));
      const double rings =
          sideLobeLevel * ringEnvelope *
          std::pow(std::fabs(std::sin((sideLobeCount + 1.0) * theta)), 0.9);
      return applyForwardBackMix(mainLobe + rings, coneAngle, p);
    }
    case PATTERN_TOROIDAL: {
      const double equatorialLobe = powPositive(
          std::sin(coneAngle), std::fmax(mainLobeExponent * 0.55, 0.4));
      const double axialNull =
          1.0 - powPositive(std::fabs(std::cos(coneAngle)),
                            std::fmax(p.axialNullExponent, 0.1));
      const double ripple =
          sideLobeLevel * equatorialLobe *
          std::pow(std::fabs(std::sin(sideLobeCount * coneAngle)), 0.7);
      return clamp01(equatorialLobe * axialNull + ripple);
    }
    case PATTERN_CARDIOID: {
      const double forwardBias = clamp01((1.0 + std::cos(coneAngle)) * 0.5);
      const double azimuthBias = 0.12 *
                                 (0.5 + 0.5 * std::cos(clockAngle)) *
                                 powPositive(std::sin(coneAngle), 2.0);
      const double forwardLobe =
          std::pow(forwardBias, std::fmax(mainLobeExponent, 1.0));
      return applyForwardBackMix(forwardLobe + azimuthBias, coneAngle, p);
    }
    case PATTERN_TEARDROP: {
      const double forward = clamp01((1.0 + std::cos(coneAngle)) * 0.5);
      const double body = 0.14 + 0.86 * std::pow(forward, 0.55);
      const double waist =
          0.34 * powPositive(std::sin(coneAngle), 1.85) *
          std::pow(forward, std::fmax(mainLobeExponent * 0.2, 0.45));
      const double skirt = sideLobeLevel *
                           powPositive(std::sin(coneAngle), 2.2) *
                           std::pow(forward, 0.8);
      const double tail = 0.04 *
                          powPositive(std::fmax(-std::cos(coneAngle), 0.0),
                                      0.45) *
                          (0.7 + 0.3 * std::cos(clockAngle));
      return clamp01(body - waist + skirt + tail);
    }
    case PATTERN_RINGED:
    default: {
      const double apertureScale =
          5.2 + sideLobeCount * 1.6 + mainLobeExponent * 0.3;
      const double airy = normalizedAiryGain(theta, apertureScale);
      const double ringLift = 0.26 + 0.74 * std::pow(airy, 0.48);
      const double envelope =
          std::pow(std::fmax(std::cos(coneAngle * 0.42), 0.0),
                   std::fmax(mainLobeExponent * 0.24, 0.65));
      return applyForwardBackMix(envelope * ringLift, coneAngle, p);
    }
  }
}

// ---------------------------------------------------------------------------
// Sampled-grid patterns (dense cone × clock dB grid, bilinear lookup).
// ---------------------------------------------------------------------------

struct SampledPattern {
  bool inUse = false;
  bool clockWrap = true;
  std::vector<double> coneAnglesDegrees;
  std::vector<double> clockAnglesDegrees;
  std::vector<double> gainDbValues;  // row-major by cone: [cone][clock]
  double maximumGainDb = 0.0;
  double minimumGainDb = 0.0;
};

// Handle table. Handles are 1-based indices into this vector; freed
// slots are reused. plugin_destroy clears everything.
std::vector<SampledPattern> g_patterns;

SampledPattern *resolvePattern(int32_t handle) {
  if (handle < 1 || static_cast<size_t>(handle) > g_patterns.size()) {
    return nullptr;
  }
  SampledPattern &pattern = g_patterns[static_cast<size_t>(handle) - 1];
  return pattern.inUse ? &pattern : nullptr;
}

struct AxisInterpolation {
  size_t lowerIndex;
  size_t upperIndex;
  double fraction;
};

// Port of AntennaPattern.js normalizeDegrees360 (JS `%` == fmod).
double normalizeDegrees360(double angle) {
  double normalized = std::fmod(angle, 360.0);
  if (normalized < 0.0) {
    normalized += 360.0;
  }
  return normalized;
}

// Port of getWrappedAxisInterpolation.
AxisInterpolation getWrappedAxisInterpolation(
    double value, const std::vector<double> &axisValues, double wrapDegrees) {
  const double minimum = axisValues[0];
  double normalized = value;

  while (normalized < minimum) {
    normalized += wrapDegrees;
  }
  while (normalized >= minimum + wrapDegrees) {
    normalized -= wrapDegrees;
  }

  for (size_t i = 0; i + 1 < axisValues.size(); i++) {
    const double start = axisValues[i];
    const double end = axisValues[i + 1];
    if (normalized <= end) {
      return {i, i + 1,
              end > start ? (normalized - start) / (end - start) : 0.0};
    }
  }

  const double lastStart = axisValues[axisValues.size() - 1];
  const double wrappedEnd = axisValues[0] + wrapDegrees;
  return {axisValues.size() - 1, 0,
          wrappedEnd > lastStart
              ? (normalized - lastStart) / (wrappedEnd - lastStart)
              : 0.0};
}

// Port of getClampedAxisInterpolation.
AxisInterpolation getClampedAxisInterpolation(
    double value, const std::vector<double> &axisValues) {
  if (value <= axisValues[0]) {
    return {0, 0, 0.0};
  }

  const size_t lastIndex = axisValues.size() - 1;
  if (value >= axisValues[lastIndex]) {
    return {lastIndex, lastIndex, 0.0};
  }

  for (size_t i = 0; i < lastIndex; i++) {
    const double start = axisValues[i];
    const double end = axisValues[i + 1];
    if (value <= end) {
      return {i, i + 1, end > start ? (value - start) / (end - start) : 0.0};
    }
  }

  return {lastIndex, lastIndex, 0.0};
}

inline double getSampledPatternValue(const SampledPattern &pattern,
                                     size_t coneIndex, size_t clockIndex) {
  return pattern
      .gainDbValues[coneIndex * pattern.clockAnglesDegrees.size() + clockIndex];
}

// Port of evaluateSampledPatternGainDb. Angles in radians; grid axes
// in degrees; result is the raw interpolated grid dB (no reference
// offset — matches AntennaPattern.evaluateGainDb which ignores
// referenceGainDb for sampled patterns).
double evaluateSampledGainDb(const SampledPattern &pattern, double coneAngle,
                             double clockAngle) {
  const double clockDegrees =
      normalizeDegrees360(clockAngle * kDegreesPerRadian);
  const double coneDegrees =
      clampD(coneAngle * kDegreesPerRadian, pattern.coneAnglesDegrees[0],
             pattern.coneAnglesDegrees[pattern.coneAnglesDegrees.size() - 1]);

  const AxisInterpolation clockInterpolation =
      pattern.clockWrap
          ? getWrappedAxisInterpolation(clockDegrees,
                                        pattern.clockAnglesDegrees, 360.0)
          : getClampedAxisInterpolation(clockDegrees,
                                        pattern.clockAnglesDegrees);
  const AxisInterpolation coneInterpolation =
      getClampedAxisInterpolation(coneDegrees, pattern.coneAnglesDegrees);

  const double v00 = getSampledPatternValue(
      pattern, coneInterpolation.lowerIndex, clockInterpolation.lowerIndex);
  const double v01 = getSampledPatternValue(
      pattern, coneInterpolation.lowerIndex, clockInterpolation.upperIndex);
  const double v10 = getSampledPatternValue(
      pattern, coneInterpolation.upperIndex, clockInterpolation.lowerIndex);
  const double v11 = getSampledPatternValue(
      pattern, coneInterpolation.upperIndex, clockInterpolation.upperIndex);

  const double clockFraction = clamp01(clockInterpolation.fraction);
  const double upperRow = v00 + (v01 - v00) * clockFraction;
  const double lowerRow = v10 + (v11 - v10) * clockFraction;
  return upperRow + (lowerRow - upperRow) * clamp01(coneInterpolation.fraction);
}

}  // namespace

extern "C" {

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t *data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_initialized = false;
  g_patterns.clear();
  g_patterns.shrink_to_fit();
}

// Analytic-family unit gain in [0, 1]. Mirrors
// AntennaPattern.evaluateGain for non-sampled, non-custom patterns.
// pattern_type: PatternType enum (unknown → RINGED, like the JS
// default case). The seven shape parameters follow the JS property
// names; the host applies the evaluateGain defaults before calling.
// Non-finite angles or parameters return 0.0 (guard convention).
ORBPRO_EXPORT
double rf_ant_gain(
    int32_t pattern_type,
    double main_lobe_exponent,
    double side_lobe_level,
    double side_lobe_count,
    double back_lobe_level,
    double back_lobe_exponent,
    double axial_null_exponent,
    double angular_scale,
    double cone_angle,
    double clock_angle) {
  if (!isFiniteD(main_lobe_exponent) || !isFiniteD(side_lobe_level) ||
      !isFiniteD(side_lobe_count) || !isFiniteD(back_lobe_level) ||
      !isFiniteD(back_lobe_exponent) || !isFiniteD(axial_null_exponent) ||
      !isFiniteD(angular_scale) || !isFiniteD(cone_angle) ||
      !isFiniteD(clock_angle)) {
    return 0.0;
  }
  const AnalyticParams params = {
      main_lobe_exponent, side_lobe_level,     side_lobe_count,
      back_lobe_level,    back_lobe_exponent,  axial_null_exponent,
      angular_scale,
  };
  return evaluateAnalyticGain(pattern_type, params, cone_angle, clock_angle);
}

// Analytic-family gain in dB:
//   reference_gain_db + 10·log10(max(gain, 1e-12))
// Mirrors AntennaPattern.evaluateGainDb for analytic patterns (the
// EPSILON12 floor caps the minimum at reference_gain_db − 120 dB).
ORBPRO_EXPORT
double rf_ant_gain_db(
    int32_t pattern_type,
    double main_lobe_exponent,
    double side_lobe_level,
    double side_lobe_count,
    double back_lobe_level,
    double back_lobe_exponent,
    double axial_null_exponent,
    double angular_scale,
    double cone_angle,
    double clock_angle,
    double reference_gain_db) {
  if (!isFiniteD(reference_gain_db)) {
    reference_gain_db = 0.0;
  }
  const double unitGain = std::fmax(
      rf_ant_gain(pattern_type, main_lobe_exponent, side_lobe_level,
                  side_lobe_count, back_lobe_level, back_lobe_exponent,
                  axial_null_exponent, angular_scale, cone_angle, clock_angle),
      kEpsilon12);
  return reference_gain_db + 10.0 * std::log10(unitGain);
}

// Load a sampled cone × clock gain grid. Buffers are float64 arrays in
// plugin memory (allocated with _malloc, written from the host,
// freeable immediately after this call — the data is copied):
//   cone_ptr   cone_count doubles   ascending cone angles, degrees
//   clock_ptr  clock_count doubles  ascending clock angles, degrees
//   gains_ptr  cone_count·clock_count doubles, row-major by cone
//              (value(coneIdx, clockIdx) = gains[coneIdx·clockCount + clockIdx])
//   clock_wrap nonzero → clock axis wraps at 360° (JS default true)
//   maximum_gain_db  reference peak for unit-gain conversion; pass NaN
//              to derive it from the grid maximum (JS default)
// Returns a handle ≥ 1, or a negative error code:
//   -1 null buffer, -2 axis too short (< 2 knots), -3 non-finite value.
ORBPRO_EXPORT
int32_t rf_ant_load_sampled_pattern(
    const double *cone_ptr,
    uint32_t cone_count,
    const double *clock_ptr,
    uint32_t clock_count,
    const double *gains_ptr,
    int32_t clock_wrap,
    double maximum_gain_db) {
  if (cone_ptr == nullptr || clock_ptr == nullptr || gains_ptr == nullptr) {
    return -1;
  }
  if (cone_count < 2 || clock_count < 2) {
    return -2;
  }

  SampledPattern pattern;
  pattern.inUse = true;
  pattern.clockWrap = clock_wrap != 0;
  pattern.coneAnglesDegrees.assign(cone_ptr, cone_ptr + cone_count);
  pattern.clockAnglesDegrees.assign(clock_ptr, clock_ptr + clock_count);
  const size_t valueCount =
      static_cast<size_t>(cone_count) * static_cast<size_t>(clock_count);
  pattern.gainDbValues.assign(gains_ptr, gains_ptr + valueCount);

  for (double v : pattern.coneAnglesDegrees) {
    if (!isFiniteD(v)) return -3;
  }
  for (double v : pattern.clockAnglesDegrees) {
    if (!isFiniteD(v)) return -3;
  }
  double maximumGainDb = -1.7976931348623157e308;
  double minimumGainDb = 1.7976931348623157e308;
  for (double v : pattern.gainDbValues) {
    if (!isFiniteD(v)) return -3;
    maximumGainDb = std::fmax(maximumGainDb, v);
    minimumGainDb = std::fmin(minimumGainDb, v);
  }
  pattern.maximumGainDb =
      isFiniteD(maximum_gain_db) ? maximum_gain_db : maximumGainDb;
  pattern.minimumGainDb = minimumGainDb;

  for (size_t i = 0; i < g_patterns.size(); i++) {
    if (!g_patterns[i].inUse) {
      g_patterns[i] = std::move(pattern);
      return static_cast<int32_t>(i + 1);
    }
  }
  g_patterns.push_back(std::move(pattern));
  return static_cast<int32_t>(g_patterns.size());
}

// Interpolated grid gain in dB at (cone_angle, clock_angle) radians.
// Bilinear over the grid: cone axis clamps to its extent, clock axis
// wraps at 360° when the pattern was loaded with clock_wrap. Returns
// NaN for an invalid handle or non-finite angles.
ORBPRO_EXPORT
double rf_ant_evaluate_sampled_gain_db(
    int32_t handle, double cone_angle, double clock_angle) {
  const SampledPattern *pattern = resolvePattern(handle);
  if (pattern == nullptr || !isFiniteD(cone_angle) ||
      !isFiniteD(clock_angle)) {
    return std::nan("");
  }
  return evaluateSampledGainDb(*pattern, cone_angle, clock_angle);
}

// Unit gain in [0, 1] relative to the pattern's maximum_gain_db:
//   clamp01(10^((gainDb − maximumGainDb) / 10))
// Mirrors evaluateSampledPatternGain. Returns NaN for an invalid
// handle or non-finite angles.
ORBPRO_EXPORT
double rf_ant_evaluate_sampled_gain(
    int32_t handle, double cone_angle, double clock_angle) {
  const SampledPattern *pattern = resolvePattern(handle);
  if (pattern == nullptr || !isFiniteD(cone_angle) ||
      !isFiniteD(clock_angle)) {
    return std::nan("");
  }
  const double gainDb =
      evaluateSampledGainDb(*pattern, cone_angle, clock_angle);
  return clamp01(std::pow(10.0, (gainDb - pattern->maximumGainDb) / 10.0));
}

// Release a sampled-pattern handle. Returns 0 on success, -1 for an
// invalid or already-freed handle.
ORBPRO_EXPORT
int32_t rf_ant_free_pattern(int32_t handle) {
  SampledPattern *pattern = resolvePattern(handle);
  if (pattern == nullptr) {
    return -1;
  }
  *pattern = SampledPattern();
  return 0;
}

// Geometry bridge: antenna-local (cone, clock) angles toward a target.
//
//   z = normalize(boresight)
//   x = cross(up, z); if |x|² < 1e-12 (up parallel to boresight)
//       helper = |z.x| < 0.9 ? UNIT_X : UNIT_Y; x = cross(helper, z)
//   x = normalize(x); y = cross(z, x)
//   dir = normalize(target − antenna)
//   cone  = acos(clamp(dot(dir, z), −1, 1))
//   clock = atan2(dot(dir, y), dot(dir, x))
//
// Writes two little-endian doubles into result_bytes:
//   offset 0  double cone_angle_rad
//   offset 8  double clock_angle_rad
// Returns 0 on success, -1 for an invalid output buffer, -2 for
// non-finite inputs or degenerate (zero-length) boresight/direction.
ORBPRO_EXPORT
int32_t rf_ant_compute_cone_clock(
    double ant_x, double ant_y, double ant_z,
    double boresight_x, double boresight_y, double boresight_z,
    double up_x, double up_y, double up_z,
    double target_x, double target_y, double target_z,
    uint8_t *result_bytes,
    uint32_t result_size) {
  if (result_bytes == nullptr || result_size < 16) return -1;
  const double inputs[12] = {ant_x, ant_y, ant_z, boresight_x, boresight_y,
                             boresight_z, up_x, up_y, up_z, target_x,
                             target_y, target_z};
  for (double v : inputs) {
    if (!isFiniteD(v)) return -2;
  }

  // z axis = normalized boresight.
  const double boresightMag = std::sqrt(
      boresight_x * boresight_x + boresight_y * boresight_y +
      boresight_z * boresight_z);
  if (!(boresightMag > 0.0)) return -2;
  const double zx = boresight_x / boresightMag;
  const double zy = boresight_y / boresightMag;
  const double zz = boresight_z / boresightMag;

  // x axis = cross(up, z), with an axis-helper fallback when up is
  // parallel to the boresight.
  double xx = up_y * zz - up_z * zy;
  double xy = up_z * zx - up_x * zz;
  double xz = up_x * zy - up_y * zx;
  if (xx * xx + xy * xy + xz * xz < 1.0e-12) {
    double hx = 1.0, hy = 0.0, hz = 0.0;
    if (!(std::fabs(zx) < 0.9)) {
      hx = 0.0;
      hy = 1.0;
    }
    xx = hy * zz - hz * zy;
    xy = hz * zx - hx * zz;
    xz = hx * zy - hy * zx;
  }
  const double xMag = std::sqrt(xx * xx + xy * xy + xz * xz);
  if (!(xMag > 0.0)) return -2;
  xx /= xMag;
  xy /= xMag;
  xz /= xMag;

  // y axis = cross(z, x).
  const double yx = zy * xz - zz * xy;
  const double yy = zz * xx - zx * xz;
  const double yz = zx * xy - zy * xx;

  // Direction to target.
  double dx = target_x - ant_x;
  double dy = target_y - ant_y;
  double dz = target_z - ant_z;
  const double dirMag = std::sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dirMag > 0.0)) return -2;
  dx /= dirMag;
  dy /= dirMag;
  dz /= dirMag;

  const double cone =
      std::acos(clampD(dx * zx + dy * zy + dz * zz, -1.0, 1.0));
  const double clock = std::atan2(dx * yx + dy * yy + dz * yz,
                                  dx * xx + dy * xy + dz * xz);

  std::memcpy(result_bytes + 0, &cone, sizeof(double));
  std::memcpy(result_bytes + 8, &clock, sizeof(double));
  return 0;
}

}  // extern "C"
