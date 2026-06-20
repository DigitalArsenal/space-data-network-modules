#ifndef SDN_SENSOR_SHAPE_MODEL_H
#define SDN_SENSOR_SHAPE_MODEL_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

struct SCVSensor;

namespace sdn_hypersonics {

struct SensorVec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

enum class SensorShapeKind : uint8_t {
  Conic,
  Rectangular,
  SarAnnularSector,
  CustomPolygon,
};

struct SensorClockRange {
  double startRad = 0.0;
  double stopRad = 0.0;
  double spanRad = 6.28318530717958647692;
  bool fullCircle = true;
  bool wrapped = false;
};

struct SensorShapeContract {
  SensorShapeKind kind = SensorShapeKind::Conic;
  double outerHalfAngleRad = 0.0;
  double innerHalfAngleRad = 0.0;
  double crossTrackHalfAngleRad = 0.0;
  double alongTrackHalfAngleRad = 0.0;
  double minRangeM = 0.0;
  double maxRangeM = 0.0;
  SensorClockRange clockRange;
  std::vector<SensorVec3> polygonVertices;
  std::vector<std::string> conformanceLabels;
  std::string unsupportedReason;
  int boundarySamples = 64;
  bool supported = true;
};

struct SensorClassification {
  bool supported = true;
  bool inside = false;
  bool rangeAccepted = true;
  bool clockAccepted = true;
  double lookRangeM = 0.0;
  double boresightAngleRad = 0.0;
  double crossTrackAngleRad = 0.0;
  double alongTrackAngleRad = 0.0;
  double clockAngleRad = 0.0;
  std::vector<std::string> conformanceLabels;
  std::string label;
  std::string reason;
};

SensorVec3 add_vectors(SensorVec3 left, SensorVec3 right);
SensorVec3 subtract_vectors(SensorVec3 left, SensorVec3 right);
SensorVec3 scale_vector(SensorVec3 value, double scalar);
SensorVec3 cross_vectors(SensorVec3 left, SensorVec3 right);
double dot_vectors(SensorVec3 left, SensorVec3 right);
double vector_magnitude(SensorVec3 value);
SensorVec3 normalize_vector(SensorVec3 value, SensorVec3 fallback = {0.0, 0.0, 1.0});

double normalize_angle_rad(double angleRad);
SensorClockRange normalize_clock_range_rad(double startRad, double stopRad);
bool clock_angle_in_range(double angleRad, const SensorClockRange& range);

SensorShapeContract make_conic_shape(
    double outerHalfAngleRad,
    double innerHalfAngleRad = 0.0,
    double clockStartRad = 0.0,
    double clockStopRad = 6.28318530717958647692,
    double minRangeM = 0.0,
    double maxRangeM = 0.0);
SensorShapeContract make_rectangular_shape(
    double crossTrackHalfAngleRad,
    double alongTrackHalfAngleRad,
    double minRangeM = 0.0,
    double maxRangeM = 0.0);
SensorShapeContract make_sar_annular_sector_shape(
    double innerLookAngleRad,
    double outerLookAngleRad,
    double clockStartRad,
    double clockStopRad,
    double minRangeM = 0.0,
    double maxRangeM = 0.0);
SensorShapeContract make_custom_polygon_unsupported_shape(
    const std::vector<SensorVec3>& vertices);

SensorShapeContract parse_sensor_shape_contract(const ::SCVSensor* sensor);
SensorShapeContract parse_sensor_shape_contract(const SensorShapeContract& contract);

SensorClassification classify_local_look(
    const SensorShapeContract& contract,
    SensorVec3 localLook);
std::vector<SensorVec3> generate_sensor_boundary_directions(
    const SensorShapeContract& contract);

}  // namespace sdn_hypersonics

#endif  // SDN_SENSOR_SHAPE_MODEL_H
