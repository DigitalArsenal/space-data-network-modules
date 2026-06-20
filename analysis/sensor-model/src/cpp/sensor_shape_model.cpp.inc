#ifndef SDN_SENSOR_SHAPE_MODEL_CPP_INC
#define SDN_SENSOR_SHAPE_MODEL_CPP_INC

#include <algorithm>
#include <cmath>
#include <limits>

namespace sdn_hypersonics {

namespace {

constexpr double kSensorPi = 3.14159265358979323846;
constexpr double kSensorTwoPi = 2.0 * kSensorPi;
constexpr double kSensorDegreesToRadians = kSensorPi / 180.0;
constexpr double kSensorEpsilon = 1.0e-12;

double sensor_clamp(double value, double minValue, double maxValue) {
  return std::max(minValue, std::min(maxValue, value));
}

double finite_or_zero(double value) {
  return std::isfinite(value) ? value : 0.0;
}

void append_label(std::vector<std::string>& labels, const char* label) {
  if (std::find(labels.begin(), labels.end(), label) == labels.end()) {
    labels.emplace_back(label);
  }
}

void rebuild_conformance_labels(SensorShapeContract& contract) {
  contract.conformanceLabels.clear();
  switch (contract.kind) {
    case SensorShapeKind::Conic:
      append_label(contract.conformanceLabels, "solid-conic");
      break;
    case SensorShapeKind::Rectangular:
      append_label(contract.conformanceLabels, "rectangular");
      break;
    case SensorShapeKind::SarAnnularSector:
      append_label(contract.conformanceLabels, "sar-annular-sector");
      break;
    case SensorShapeKind::CustomPolygon:
      append_label(contract.conformanceLabels, "custom-polygon-unsupported");
      break;
  }
  if (contract.innerHalfAngleRad > kSensorEpsilon) {
    append_label(contract.conformanceLabels, "inner-cutout");
  }
  if (!contract.clockRange.fullCircle) {
    append_label(contract.conformanceLabels, "partial-clock-sector");
  }
  if (contract.clockRange.wrapped) {
    append_label(contract.conformanceLabels, "wrapped-clock-sector");
  }
}

SensorVec3 direction_from_cone_clock(double coneAngleRad, double clockAngleRad) {
  const double radial = std::sin(coneAngleRad);
  return normalize_vector(
      {
          radial * std::cos(clockAngleRad),
          radial * std::sin(clockAngleRad),
          std::cos(coneAngleRad),
      });
}

SensorVec3 rectangular_direction(double crossTrackAngleRad, double alongTrackAngleRad) {
  return normalize_vector({
      std::tan(crossTrackAngleRad),
      std::tan(alongTrackAngleRad),
      1.0,
  });
}

std::vector<double> sample_clock_angles(const SensorClockRange& range, int sampleCount) {
  const int count = std::max(sampleCount, 4);
  std::vector<double> clocks;
  clocks.reserve(static_cast<size_t>(count));
  if (range.fullCircle) {
    for (int index = 0; index < count; ++index) {
      clocks.push_back(normalize_angle_rad(kSensorTwoPi * static_cast<double>(index) / count));
    }
    return clocks;
  }
  for (int index = 0; index < count; ++index) {
    const double fraction = count == 1 ? 0.0 : static_cast<double>(index) / (count - 1);
    clocks.push_back(normalize_angle_rad(range.startRad + range.spanRad * fraction));
  }
  return clocks;
}

bool range_is_accepted(const SensorShapeContract& contract, double rangeM) {
  if (contract.minRangeM > 0.0 && rangeM + kSensorEpsilon < contract.minRangeM) {
    return false;
  }
  if (contract.maxRangeM > 0.0 && rangeM - kSensorEpsilon > contract.maxRangeM) {
    return false;
  }
  return true;
}

SensorShapeContract with_range_boundary(
    SensorShapeContract contract,
    SensorRangeBoundaryKind rangeBoundary) {
  contract.rangeBoundary = rangeBoundary;
  return contract;
}

}  // namespace

SensorVec3 add_vectors(SensorVec3 left, SensorVec3 right) {
  return {left.x + right.x, left.y + right.y, left.z + right.z};
}

SensorVec3 subtract_vectors(SensorVec3 left, SensorVec3 right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

SensorVec3 scale_vector(SensorVec3 value, double scalar) {
  return {value.x * scalar, value.y * scalar, value.z * scalar};
}

SensorVec3 cross_vectors(SensorVec3 left, SensorVec3 right) {
  return {
      left.y * right.z - left.z * right.y,
      left.z * right.x - left.x * right.z,
      left.x * right.y - left.y * right.x,
  };
}

double dot_vectors(SensorVec3 left, SensorVec3 right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

double vector_magnitude(SensorVec3 value) {
  return std::sqrt(dot_vectors(value, value));
}

SensorVec3 normalize_vector(SensorVec3 value, SensorVec3 fallback) {
  const double length = vector_magnitude(value);
  if (!(length > 0.0) || !std::isfinite(length)) {
    return fallback;
  }
  return scale_vector(value, 1.0 / length);
}

double normalize_angle_rad(double angleRad) {
  if (!std::isfinite(angleRad)) {
    return 0.0;
  }
  double normalized = std::fmod(angleRad, kSensorTwoPi);
  if (normalized < 0.0) {
    normalized += kSensorTwoPi;
  }
  if (normalized >= kSensorTwoPi) {
    normalized -= kSensorTwoPi;
  }
  return normalized;
}

SensorClockRange normalize_clock_range_rad(double startRad, double stopRad) {
  SensorClockRange range{};
  const double safeStart = finite_or_zero(startRad);
  const double safeStop = std::isfinite(stopRad) ? stopRad : kSensorTwoPi;
  const double rawSpan = safeStop - safeStart;
  range.startRad = normalize_angle_rad(safeStart);
  range.stopRad = normalize_angle_rad(safeStop);
  range.fullCircle =
      std::fabs(rawSpan) >= kSensorTwoPi - kSensorEpsilon ||
      std::fabs(range.startRad - range.stopRad) <= kSensorEpsilon;
  if (range.fullCircle) {
    range.startRad = 0.0;
    range.stopRad = 0.0;
    range.spanRad = kSensorTwoPi;
    range.wrapped = false;
    return range;
  }
  range.wrapped = range.stopRad < range.startRad;
  range.spanRad = range.wrapped
      ? (kSensorTwoPi - range.startRad + range.stopRad)
      : (range.stopRad - range.startRad);
  return range;
}

bool clock_angle_in_range(double angleRad, const SensorClockRange& range) {
  if (range.fullCircle) {
    return true;
  }
  const double angle = normalize_angle_rad(angleRad);
  if (range.wrapped) {
    return angle + kSensorEpsilon >= range.startRad ||
        angle <= range.stopRad + kSensorEpsilon;
  }
  return angle + kSensorEpsilon >= range.startRad &&
      angle <= range.stopRad + kSensorEpsilon;
}

SensorShapeContract make_conic_shape(
    double outerHalfAngleRad,
    double innerHalfAngleRad,
    double clockStartRad,
    double clockStopRad,
    double minRangeM,
    double maxRangeM) {
  SensorShapeContract contract{};
  contract.kind = SensorShapeKind::Conic;
  contract.outerHalfAngleRad = std::max(0.0, finite_or_zero(outerHalfAngleRad));
  contract.innerHalfAngleRad = std::max(0.0, finite_or_zero(innerHalfAngleRad));
  contract.minRangeM = std::max(0.0, finite_or_zero(minRangeM));
  contract.maxRangeM = std::max(0.0, finite_or_zero(maxRangeM));
  contract.clockRange = normalize_clock_range_rad(clockStartRad, clockStopRad);
  rebuild_conformance_labels(contract);
  return contract;
}

SensorShapeContract make_rectangular_shape(
    double crossTrackHalfAngleRad,
    double alongTrackHalfAngleRad,
    double minRangeM,
    double maxRangeM) {
  SensorShapeContract contract{};
  contract.kind = SensorShapeKind::Rectangular;
  contract.crossTrackHalfAngleRad = std::max(0.0, finite_or_zero(crossTrackHalfAngleRad));
  contract.alongTrackHalfAngleRad = std::max(0.0, finite_or_zero(alongTrackHalfAngleRad));
  contract.minRangeM = std::max(0.0, finite_or_zero(minRangeM));
  contract.maxRangeM = std::max(0.0, finite_or_zero(maxRangeM));
  contract.clockRange = normalize_clock_range_rad(0.0, kSensorTwoPi);
  rebuild_conformance_labels(contract);
  return contract;
}

SensorShapeContract make_sar_annular_sector_shape(
    double innerLookAngleRad,
    double outerLookAngleRad,
    double clockStartRad,
    double clockStopRad,
    double minRangeM,
    double maxRangeM) {
  SensorShapeContract contract = make_conic_shape(
      outerLookAngleRad,
      innerLookAngleRad,
      clockStartRad,
      clockStopRad,
      minRangeM,
      maxRangeM);
  contract.kind = SensorShapeKind::SarAnnularSector;
  rebuild_conformance_labels(contract);
  return contract;
}

SensorShapeContract make_custom_polygon_unsupported_shape(
    const std::vector<SensorVec3>& vertices) {
  SensorShapeContract contract{};
  contract.kind = SensorShapeKind::CustomPolygon;
  contract.polygonVertices = vertices;
  contract.supported = false;
  contract.unsupportedReason = "unsupported shape: custom polygon sensor contracts are not evaluated by the shared C++ core yet";
  rebuild_conformance_labels(contract);
  return contract;
}

SensorShapeContract parse_sensor_shape_contract(const SensorShapeContract& contract) {
  SensorShapeContract normalized = contract;
  normalized.outerHalfAngleRad = std::max(0.0, finite_or_zero(normalized.outerHalfAngleRad));
  normalized.innerHalfAngleRad = std::max(0.0, finite_or_zero(normalized.innerHalfAngleRad));
  normalized.crossTrackHalfAngleRad = std::max(0.0, finite_or_zero(normalized.crossTrackHalfAngleRad));
  normalized.alongTrackHalfAngleRad = std::max(0.0, finite_or_zero(normalized.alongTrackHalfAngleRad));
  normalized.minRangeM = std::max(0.0, finite_or_zero(normalized.minRangeM));
  normalized.maxRangeM = std::max(0.0, finite_or_zero(normalized.maxRangeM));
  normalized.clockRange = normalize_clock_range_rad(
      normalized.clockRange.startRad,
      normalized.clockRange.fullCircle ? kSensorTwoPi : normalized.clockRange.stopRad);
  if (normalized.kind == SensorShapeKind::CustomPolygon) {
    normalized.supported = false;
    normalized.unsupportedReason = "unsupported shape: custom polygon sensor contracts are not evaluated by the shared C++ core yet";
  }
  rebuild_conformance_labels(normalized);
  return normalized;
}

#ifdef FLATBUFFERS_GENERATED_MAIN_H_
namespace {

SensorRangeBoundaryKind parse_sensor_range_boundary(
    scvSensorRangeBoundaryKind rangeBoundary) {
  switch (rangeBoundary) {
    case scvSensorRangeBoundaryKind_LOCAL_Z_PLANE:
      return SensorRangeBoundaryKind::LocalZPlane;
    case scvSensorRangeBoundaryKind_RADIAL_SPHERICAL:
    default:
      return SensorRangeBoundaryKind::RadialSpherical;
  }
}

std::vector<SensorVec3> parse_polygon_vertices(
    const flatbuffers::Vector<flatbuffers::Offset<SCVVec3>>* vertices) {
  std::vector<SensorVec3> parsed;
  if (!vertices) {
    return parsed;
  }
  parsed.reserve(vertices->size());
  for (flatbuffers::uoffset_t index = 0; index < vertices->size(); ++index) {
    const SCVVec3* vertex = vertices->Get(index);
    if (vertex) {
      parsed.push_back({vertex->X(), vertex->Y(), vertex->Z()});
    }
  }
  return parsed;
}

}  // namespace

SensorShapeContract parse_sensor_shape_contract(const ::SCVSensor* sensor) {
  if (!sensor) {
    return make_conic_shape(0.0);
  }

  const SCVSensorShapeContract* shape = sensor->SHAPE_CONTRACT();
  const double halfAngle = sensor->HALF_ANGLE_DEG() * kSensorDegreesToRadians;
  const double crossTrack = sensor->CROSS_TRACK_HALF_ANGLE_DEG() * kSensorDegreesToRadians;
  const double alongTrack = sensor->ALONG_TRACK_HALF_ANGLE_DEG() * kSensorDegreesToRadians;
  const double minRange = sensor->MIN_RANGE_M();
  const double maxRange = sensor->MAX_RANGE_M();
  if (!shape) {
    switch (sensor->SHAPE()) {
      case scvSensorShapeKind_RECTANGULAR:
        return make_rectangular_shape(crossTrack, alongTrack, minRange, maxRange);
      case scvSensorShapeKind_CUSTOM_POLYGON:
        return make_custom_polygon_unsupported_shape(parse_polygon_vertices(sensor->POLYGON_VERTICES()));
      case scvSensorShapeKind_SAR_ANNULAR_SECTOR:
      case scvSensorShapeKind_CONIC:
      default:
        return make_conic_shape(halfAngle, 0.0, 0.0, kSensorTwoPi, minRange, maxRange);
    }
  }

  const double outer = shape->OUTER_HALF_ANGLE_DEG() * kSensorDegreesToRadians;
  const double inner = shape->INNER_HALF_ANGLE_DEG() * kSensorDegreesToRadians;
  const double minClock = shape->MIN_CLOCK_ANGLE_DEG() * kSensorDegreesToRadians;
  const double maxClock = shape->MAX_CLOCK_ANGLE_DEG() * kSensorDegreesToRadians;
  const SensorRangeBoundaryKind rangeBoundary =
      parse_sensor_range_boundary(shape->RANGE_BOUNDARY());
  switch (shape->SHAPE_KIND()) {
    case scvSensorShapeKind_RECTANGULAR:
      return with_range_boundary(
          make_rectangular_shape(
              shape->X_HALF_ANGLE_DEG() * kSensorDegreesToRadians,
              shape->Y_HALF_ANGLE_DEG() * kSensorDegreesToRadians,
              shape->MIN_RANGE_M(),
              shape->MAX_RANGE_M()),
          rangeBoundary);
    case scvSensorShapeKind_CUSTOM_POLYGON:
      return with_range_boundary(
          make_custom_polygon_unsupported_shape(parse_polygon_vertices(shape->POLYGON_VERTICES())),
          rangeBoundary);
    case scvSensorShapeKind_SAR_ANNULAR_SECTOR:
      return with_range_boundary(
          make_sar_annular_sector_shape(
              shape->INNER_LOOK_ANGLE_DEG() * kSensorDegreesToRadians,
              shape->OUTER_LOOK_ANGLE_DEG() * kSensorDegreesToRadians,
              minClock,
              maxClock,
              shape->MIN_RANGE_M(),
              shape->MAX_RANGE_M()),
          rangeBoundary);
    case scvSensorShapeKind_CONIC:
    default:
      return with_range_boundary(
          make_conic_shape(outer, inner, minClock, maxClock, shape->MIN_RANGE_M(), shape->MAX_RANGE_M()),
          rangeBoundary);
  }
}
#else
SensorShapeContract parse_sensor_shape_contract(const ::SCVSensor*) {
  return make_conic_shape(0.0);
}
#endif

SensorClassification classify_local_look(
    const SensorShapeContract& inputContract,
    SensorVec3 localLook) {
  const SensorShapeContract contract = parse_sensor_shape_contract(inputContract);
  SensorClassification classification{};
  classification.supported = contract.supported;
  classification.conformanceLabels = contract.conformanceLabels;
  classification.label = contract.conformanceLabels.empty()
      ? ""
      : contract.conformanceLabels.front();
  classification.lookRangeM = vector_magnitude(localLook);
  classification.rangeAccepted = range_is_accepted(contract, classification.lookRangeM);

  if (!contract.supported) {
    classification.inside = false;
    classification.reason = contract.unsupportedReason.empty()
        ? "unsupported shape"
        : contract.unsupportedReason;
    return classification;
  }

  const SensorVec3 unitLook = normalize_vector(localLook);
  classification.boresightAngleRad =
      std::acos(sensor_clamp(unitLook.z, -1.0, 1.0));
  classification.crossTrackAngleRad = std::atan2(unitLook.x, unitLook.z);
  classification.alongTrackAngleRad = std::atan2(unitLook.y, unitLook.z);
  classification.clockAngleRad = normalize_angle_rad(std::atan2(unitLook.y, unitLook.x));
  classification.clockAccepted =
      clock_angle_in_range(classification.clockAngleRad, contract.clockRange);

  switch (contract.kind) {
    case SensorShapeKind::Rectangular:
      classification.inside =
          classification.rangeAccepted &&
          unitLook.z >= -kSensorEpsilon &&
          std::fabs(classification.crossTrackAngleRad) <= contract.crossTrackHalfAngleRad + kSensorEpsilon &&
          std::fabs(classification.alongTrackAngleRad) <= contract.alongTrackHalfAngleRad + kSensorEpsilon;
      break;
    case SensorShapeKind::SarAnnularSector:
    case SensorShapeKind::Conic:
      classification.inside =
          classification.rangeAccepted &&
          classification.clockAccepted &&
          classification.boresightAngleRad <= contract.outerHalfAngleRad + kSensorEpsilon &&
          classification.boresightAngleRad + kSensorEpsilon >= contract.innerHalfAngleRad;
      break;
    case SensorShapeKind::CustomPolygon:
      classification.supported = false;
      classification.inside = false;
      classification.reason = "unsupported shape";
      break;
  }

  if (!classification.rangeAccepted) {
    classification.reason = "range rejected";
  } else if (!classification.clockAccepted) {
    classification.reason = "clock angle rejected";
  }
  return classification;
}

std::vector<SensorVec3> generate_sensor_boundary_directions(
    const SensorShapeContract& inputContract) {
  const SensorShapeContract contract = parse_sensor_shape_contract(inputContract);
  std::vector<SensorVec3> directions;
  if (!contract.supported) {
    return directions;
  }

  if (contract.kind == SensorShapeKind::Rectangular) {
    directions.reserve(4);
    directions.push_back(rectangular_direction(-contract.crossTrackHalfAngleRad, -contract.alongTrackHalfAngleRad));
    directions.push_back(rectangular_direction(contract.crossTrackHalfAngleRad, -contract.alongTrackHalfAngleRad));
    directions.push_back(rectangular_direction(contract.crossTrackHalfAngleRad, contract.alongTrackHalfAngleRad));
    directions.push_back(rectangular_direction(-contract.crossTrackHalfAngleRad, contract.alongTrackHalfAngleRad));
    return directions;
  }

  const std::vector<double> clocks =
      sample_clock_angles(contract.clockRange, contract.boundarySamples);
  directions.reserve(clocks.size() * (contract.innerHalfAngleRad > kSensorEpsilon ? 2 : 1));
  for (double clock : clocks) {
    directions.push_back(direction_from_cone_clock(contract.outerHalfAngleRad, clock));
  }
  if (contract.innerHalfAngleRad > kSensorEpsilon) {
    for (auto it = clocks.rbegin(); it != clocks.rend(); ++it) {
      directions.push_back(direction_from_cone_clock(contract.innerHalfAngleRad, *it));
    }
  }
  return directions;
}

}  // namespace sdn_hypersonics

#endif  // SDN_SENSOR_SHAPE_MODEL_CPP_INC
