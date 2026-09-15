#include "access_abi.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "ACW_generated.h"
#include "sds/PIV/main_generated.h"

namespace {

constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84E2 = 6.6943799901413165e-3;
constexpr size_t kStringFieldSize = 64;
constexpr const char* kComputeAccessWindowsMethod = "compute_access_windows";
constexpr const char* kAcwSchemaName = "ACW.fbs";
constexpr const char* kAcwFileIdentifier = "$ACW";
constexpr const char* kAcwRootType = "ACW";
constexpr const char* kAccessRequestPort = "request";
constexpr const char* kAccessResultsPort = "results";
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kOrekitStandardRefractionDefaultPressurePa = 101000.0;
constexpr double kOrekitStandardRefractionDefaultTemperatureK = 283.0;
constexpr double kOrekitStandardRefractionMinElevationDeg = -2.0;
constexpr double kOrekitStandardRefractionMaxElevationDeg = 89.89;
constexpr uint32_t kRefractionModelKindEarthStandardAtmosphere = 1u;
constexpr uint32_t kRefractionModelKindItuRP834 = 2u;
constexpr double kOrekitIturp834KmToM = 1000.0;
constexpr double kOrekitIturp834InvDegToInvRad = 180.0 / kPi;
constexpr double kOrekitIturp834EarthRayM =
    6370.0 * kOrekitIturp834KmToM;
constexpr std::array<double, 8> kOrekitIturp834TauZeroCoefficients = {
    kOrekitIturp834InvDegToInvRad * 1.728,
    kOrekitIturp834InvDegToInvRad * 0.5411,
    kOrekitIturp834InvDegToInvRad * 0.03723,
    kOrekitIturp834InvDegToInvRad * 0.1815 / kOrekitIturp834KmToM,
    kOrekitIturp834InvDegToInvRad * 0.06272 / kOrekitIturp834KmToM,
    kOrekitIturp834InvDegToInvRad * 0.011380 / kOrekitIturp834KmToM,
    kOrekitIturp834InvDegToInvRad * 0.01727 /
        (kOrekitIturp834KmToM * kOrekitIturp834KmToM),
    kOrekitIturp834InvDegToInvRad * 0.008288 /
        (kOrekitIturp834KmToM * kOrekitIturp834KmToM),
};

struct StateRecord {
  double julian_date;
  double x;
  double y;
  double z;
};

struct BlackoutWindowRecord {
  double start_julian_date;
  double end_julian_date;
};

struct GroundStationRecord {
  double latitude_rad;
  double longitude_rad;
  double altitude_m;
  double min_elevation_rad;
  uint32_t channel_capacity;
  uint32_t reserved;
  char id[kStringFieldSize];
  char name[kStringFieldSize];
};

struct AccessWindowRecord {
  double start_julian_date;
  double end_julian_date;
  double max_elevation_rad;
  uint32_t sample_count;
  uint32_t reserved;
};

struct ScheduleWindowRecord {
  double start_julian_date;
  double end_julian_date;
  double priority;
  double score;
  uint32_t station_index;
  uint32_t sort_index;
};

struct ScheduledContactRecord {
  double start_julian_date;
  double end_julian_date;
  uint32_t sort_index;
  uint32_t channel_index;
};

struct ElevationMaskPointRecord {
  double azimuth_rad;
  double elevation_rad;
};

struct RefractionModelRecord {
  double pressure_pa;
  double temperature_k;
  double station_altitude_m;
  double elevation_star_rad;
  double refraction_star_rad;
  uint32_t model_kind;
  uint32_t reserved;
};

struct Vec3 {
  double x;
  double y;
  double z;
};

struct AccessGeometry {
  double elevation_rad;
  double azimuth_rad;
};

struct VisibilitySample {
  double elevation_rad;
  double switching_value;
};

struct ElevationMaskPoint {
  double azimuth_rad;
  double elevation_rad;
};

struct ElevationMaskTable {
  std::vector<ElevationMaskPoint> points;
};

struct StoredGroundStation {
  double latitude_rad;
  double longitude_rad;
  double altitude_m;
  double min_elevation_rad;
  uint32_t channel_capacity;
  std::array<char, kStringFieldSize> id;
  std::array<char, kStringFieldSize> name;
  std::vector<BlackoutWindowRecord> blackout_windows;
};

struct ScheduledInterval {
  double start_julian_date;
  double end_julian_date;
};

static_assert(sizeof(StateRecord) == 32, "StateRecord layout changed.");
static_assert(
    sizeof(BlackoutWindowRecord) == 16,
    "BlackoutWindowRecord layout changed.");
static_assert(
    sizeof(GroundStationRecord) == 168,
    "GroundStationRecord layout changed.");
static_assert(
    sizeof(AccessWindowRecord) == 32,
    "AccessWindowRecord layout changed.");
static_assert(
    sizeof(ScheduleWindowRecord) == 40,
    "ScheduleWindowRecord layout changed.");
static_assert(
    sizeof(ScheduledContactRecord) == 24,
    "ScheduledContactRecord layout changed.");
static_assert(
    sizeof(ElevationMaskPointRecord) == 16,
    "ElevationMaskPointRecord layout changed.");
static_assert(
    sizeof(RefractionModelRecord) == 48,
    "RefractionModelRecord layout changed.");

bool g_initialized = false;
std::vector<StoredGroundStation> g_ground_stations;

double clampUnit(double value) {
  return std::max(-1.0, std::min(1.0, value));
}

bool isFinite(double value) {
  return std::isfinite(value);
}

double clampFraction(double value) {
  return std::max(0.0, std::min(1.0, value));
}

double degreesToRadians(double value) {
  return value * kPi / 180.0;
}

double radiansToDegrees(double value) {
  return value * 180.0 / kPi;
}

double normalizeAzimuthRad(double value) {
  double normalized = std::fmod(value, kTwoPi);
  if (normalized < 0.0) {
    normalized += kTwoPi;
  }
  return normalized;
}

uint32_t normalizeChannelCapacity(uint32_t value) {
  return value == 0u ? 1u : value;
}

void copyTextField(char* destination, const char* source) {
  if (destination == nullptr) {
    return;
  }
  std::memset(destination, 0, kStringFieldSize);
  if (source == nullptr) {
    return;
  }
  std::strncpy(destination, source, kStringFieldSize - 1);
}

void copyTextField(
    std::array<char, kStringFieldSize>& destination,
    const char* source) {
  copyTextField(destination.data(), source);
}

std::string textFieldToString(const std::array<char, kStringFieldSize>& value) {
  size_t length = 0;
  while (length < value.size() && value[length] != '\0') {
    length += 1;
  }
  return std::string(value.data(), length);
}

std::string flatbufferString(const ::flatbuffers::String* value) {
  return value == nullptr ? std::string() : value->str();
}

bool isAcwTypeRef(const FlatBufferTypeRef* typeRef) {
  if (typeRef == nullptr) {
    return false;
  }
  const std::string schemaName = flatbufferString(typeRef->SCHEMA_NAME());
  const std::string fileIdentifier = flatbufferString(typeRef->FILE_IDENTIFIER());
  const std::string rootType = flatbufferString(typeRef->ROOT_TYPE());
  const bool schemaMatches =
      schemaName.empty() || schemaName == kAcwSchemaName;
  const bool fileIdentifierMatches =
      fileIdentifier.empty() || fileIdentifier == kAcwFileIdentifier;
  const bool rootMatches =
      rootType.empty() || rootType == kAcwRootType;
  return schemaMatches && fileIdentifierMatches && rootMatches;
}

Vec3 geodeticToEcef(double latitudeRad, double longitudeRad, double altitudeM) {
  const double sinLat = std::sin(latitudeRad);
  const double cosLat = std::cos(latitudeRad);
  const double sinLon = std::sin(longitudeRad);
  const double cosLon = std::cos(longitudeRad);
  const double primeVertical =
      kWgs84A / std::sqrt(1.0 - kWgs84E2 * sinLat * sinLat);

  return {
      (primeVertical + altitudeM) * cosLat * cosLon,
      (primeVertical + altitudeM) * cosLat * sinLon,
      (primeVertical * (1.0 - kWgs84E2) + altitudeM) * sinLat,
  };
}

Vec3 geodeticUp(double latitudeRad, double longitudeRad) {
  const double cosLat = std::cos(latitudeRad);
  return {
      cosLat * std::cos(longitudeRad),
      cosLat * std::sin(longitudeRad),
      std::sin(latitudeRad),
  };
}

Vec3 geodeticEast(double longitudeRad) {
  return {
      -std::sin(longitudeRad),
      std::cos(longitudeRad),
      0.0,
  };
}

Vec3 geodeticNorth(double latitudeRad, double longitudeRad) {
  const double sinLat = std::sin(latitudeRad);
  const double cosLat = std::cos(latitudeRad);
  return {
      -sinLat * std::cos(longitudeRad),
      -sinLat * std::sin(longitudeRad),
      cosLat,
  };
}

double dot(const Vec3& left, const Vec3& right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

AccessGeometry computeAccessGeometryRad(
    const Vec3& stationEcef,
    const Vec3& stationEast,
    const Vec3& stationNorth,
    const Vec3& stationUp,
    const StateRecord& state) {
  const Vec3 los = {
      state.x - stationEcef.x,
      state.y - stationEcef.y,
      state.z - stationEcef.z,
  };
  const double range =
      std::sqrt(los.x * los.x + los.y * los.y + los.z * los.z);
  if (range <= 0.0 || !isFinite(range)) {
    return {
        -std::numeric_limits<double>::infinity(),
        0.0,
    };
  }

  const double east = dot(los, stationEast);
  const double north = dot(los, stationNorth);
  const double up = dot(los, stationUp);
  return {
      std::asin(clampUnit(up / range)),
      normalizeAzimuthRad(std::atan2(east, north)),
  };
}

double computeElevationRad(
    const Vec3& stationEcef,
    const Vec3& stationUp,
    const StateRecord& state) {
  const Vec3 stationEast{0.0, 1.0, 0.0};
  const Vec3 stationNorth{0.0, 0.0, 1.0};
  return computeAccessGeometryRad(
      stationEcef,
      stationEast,
      stationNorth,
      stationUp,
      state).elevation_rad;
}

bool normalizeElevationMask(
    const ElevationMaskPointRecord* records,
    uint32_t maskPointCount,
    ElevationMaskTable* outMask) {
  if (records == nullptr || maskPointCount == 0u || outMask == nullptr) {
    return false;
  }

  std::vector<ElevationMaskPoint> sorted;
  sorted.reserve(maskPointCount);
  for (uint32_t index = 0; index < maskPointCount; index += 1) {
    const ElevationMaskPointRecord& record = records[index];
    if (!isFinite(record.azimuth_rad) || !isFinite(record.elevation_rad)) {
      return false;
    }
    sorted.push_back({
        normalizeAzimuthRad(record.azimuth_rad),
        record.elevation_rad,
    });
  }

  std::sort(
      sorted.begin(),
      sorted.end(),
      [](const ElevationMaskPoint& left, const ElevationMaskPoint& right) {
        return left.azimuth_rad < right.azimuth_rad;
      });

  std::vector<ElevationMaskPoint> unique;
  unique.reserve(sorted.size());
  for (const ElevationMaskPoint& point : sorted) {
    if (!unique.empty() &&
        std::abs(unique.back().azimuth_rad - point.azimuth_rad) < 1.0e-15) {
      if (std::abs(unique.back().elevation_rad - point.elevation_rad) >
          1.0e-15) {
        return false;
      }
      continue;
    }
    unique.push_back(point);
  }
  if (unique.empty()) {
    return false;
  }

  ElevationMaskTable mask{};
  mask.points.reserve(unique.size() + 2u);
  mask.points.push_back({
      unique.back().azimuth_rad - kTwoPi,
      unique.back().elevation_rad,
  });
  mask.points.insert(mask.points.end(), unique.begin(), unique.end());
  mask.points.push_back({
      unique.front().azimuth_rad + kTwoPi,
      unique.front().elevation_rad,
  });
  *outMask = std::move(mask);
  return true;
}

double evaluateElevationMask(
    const ElevationMaskTable& mask,
    double azimuthRad) {
  if (mask.points.empty()) {
    return -std::numeric_limits<double>::infinity();
  }

  const double normalizedAzimuth = normalizeAzimuthRad(azimuthRad);
  for (size_t index = 1; index < mask.points.size(); index += 1) {
    if (normalizedAzimuth <= mask.points[index].azimuth_rad) {
      const ElevationMaskPoint& start = mask.points[index - 1];
      const ElevationMaskPoint& end = mask.points[index];
      const double span = end.azimuth_rad - start.azimuth_rad;
      if (std::abs(span) < 1.0e-15) {
        return end.elevation_rad;
      }
      return start.elevation_rad +
             (normalizedAzimuth - start.azimuth_rad) *
                 (end.elevation_rad - start.elevation_rad) / span;
    }
  }

  return mask.points.back().elevation_rad;
}

bool isValidEarthStandardAtmosphereRefractionModel(
    const RefractionModelRecord& model) {
  return model.model_kind == kRefractionModelKindEarthStandardAtmosphere &&
         isFinite(model.pressure_pa) && isFinite(model.temperature_k) &&
         model.temperature_k > 0.0;
}

bool isValidIturp834AtmosphericRefractionModel(
    const RefractionModelRecord& model) {
  return model.model_kind == kRefractionModelKindItuRP834 &&
         isFinite(model.station_altitude_m) &&
         model.station_altitude_m > -kOrekitIturp834EarthRayM + 1.0;
}

bool isValidRefractionModel(const RefractionModelRecord& model) {
  return isValidEarthStandardAtmosphereRefractionModel(model) ||
         isValidIturp834AtmosphericRefractionModel(model);
}

double computeEarthStandardAtmosphereRefractionRad(
    double trueElevationRad,
    const RefractionModelRecord& model) {
  if (!isFinite(trueElevationRad) ||
      !isValidEarthStandardAtmosphereRefractionModel(model)) {
    return 0.0;
  }

  const double trueElevationDeg = radiansToDegrees(trueElevationRad);
  if (trueElevationDeg <= kOrekitStandardRefractionMinElevationDeg ||
      trueElevationDeg >= kOrekitStandardRefractionMaxElevationDeg) {
    return 0.0;
  }

  const double refractionArgumentDeg =
      trueElevationDeg + 10.3 / (trueElevationDeg + 5.11);
  const double tangent =
      std::tan(degreesToRadians(refractionArgumentDeg));
  if (!isFinite(tangent) || std::abs(tangent) < 1.0e-15) {
    return 0.0;
  }

  const double refractionDeg = 1.02 / tangent / 60.0;
  const double correctionFactor =
      (model.pressure_pa / kOrekitStandardRefractionDefaultPressurePa) *
      (kOrekitStandardRefractionDefaultTemperatureK / model.temperature_k);
  return degreesToRadians(correctionFactor * refractionDeg);
}

double computeIturp834TauZeroRad(double elevationRad, double altitudeM) {
  const double elevationDeg = radiansToDegrees(elevationRad);
  const double tmp0 =
      kOrekitIturp834TauZeroCoefficients[0] +
      (kOrekitIturp834TauZeroCoefficients[1] +
       kOrekitIturp834TauZeroCoefficients[2] * elevationDeg) *
          elevationDeg;
  const double tmp1 =
      altitudeM *
      (kOrekitIturp834TauZeroCoefficients[3] +
       (kOrekitIturp834TauZeroCoefficients[4] +
        kOrekitIturp834TauZeroCoefficients[5] * elevationDeg) *
           elevationDeg);
  const double tmp2 =
      altitudeM * altitudeM *
      (kOrekitIturp834TauZeroCoefficients[6] +
       kOrekitIturp834TauZeroCoefficients[7] * elevationDeg);
  return 1.0 / (tmp0 + tmp1 + tmp2);
}

double computeIturp834AtmosphericRefractionElevationStarRad(double altitudeM) {
  double lower = -kPi / 30.0;
  double upper = kPi / 4.0;
  constexpr double kInverseGoldenRatio = 0.6180339887498948482;
  const auto objective = [altitudeM](double elevationRad) {
    return elevationRad + computeIturp834TauZeroRad(elevationRad, altitudeM);
  };

  double left = upper - kInverseGoldenRatio * (upper - lower);
  double right = lower + kInverseGoldenRatio * (upper - lower);
  double leftValue = objective(left);
  double rightValue = objective(right);

  for (uint32_t iteration = 0;
       iteration < 200u && std::abs(upper - lower) > 1.0e-12;
       iteration += 1u) {
    if (leftValue < rightValue) {
      upper = right;
      right = left;
      rightValue = leftValue;
      left = upper - kInverseGoldenRatio * (upper - lower);
      leftValue = objective(left);
    } else {
      lower = left;
      left = right;
      leftValue = rightValue;
      right = lower + kInverseGoldenRatio * (upper - lower);
      rightValue = objective(right);
    }
  }

  return (lower + upper) / 2.0;
}

bool prepareRefractionModel(RefractionModelRecord* model) {
  if (model == nullptr || !isValidRefractionModel(*model)) {
    return false;
  }

  if (model->model_kind == kRefractionModelKindItuRP834) {
    model->elevation_star_rad =
        computeIturp834AtmosphericRefractionElevationStarRad(
            model->station_altitude_m);
    model->refraction_star_rad = computeIturp834TauZeroRad(
        model->elevation_star_rad,
        model->station_altitude_m);
    return isFinite(model->elevation_star_rad) &&
           isFinite(model->refraction_star_rad);
  }

  model->station_altitude_m = 0.0;
  model->elevation_star_rad = 0.0;
  model->refraction_star_rad = 0.0;
  return true;
}

double computeIturp834AtmosphericRefractionRad(
    double trueElevationRad,
    const RefractionModelRecord& model) {
  if (!isFinite(trueElevationRad) ||
      !isValidIturp834AtmosphericRefractionModel(model)) {
    return 0.0;
  }
  if (trueElevationRad < model.elevation_star_rad) {
    return model.refraction_star_rad;
  }
  return computeIturp834TauZeroRad(
      trueElevationRad,
      model.station_altitude_m);
}

double computeRefractionRad(
    double trueElevationRad,
    const RefractionModelRecord* model) {
  if (model == nullptr) {
    return 0.0;
  }
  switch (model->model_kind) {
    case kRefractionModelKindEarthStandardAtmosphere:
      return computeEarthStandardAtmosphereRefractionRad(
          trueElevationRad,
          *model);
    case kRefractionModelKindItuRP834:
      return computeIturp834AtmosphericRefractionRad(
          trueElevationRad,
          *model);
    default:
      return 0.0;
  }
}

double interpolateCrossingTime(
    double previousTime,
    double previousValue,
    double currentTime,
    double currentValue) {
  const double delta = currentValue - previousValue;
  if (std::abs(delta) < 1.0e-12) {
    return previousTime;
  }
  const double fraction = clampFraction(-previousValue / delta);
  return previousTime + (currentTime - previousTime) * fraction;
}

VisibilitySample computeVisibilitySample(
    const Vec3& stationEcef,
    const Vec3& stationEast,
    const Vec3& stationNorth,
    const Vec3& stationUp,
    const StateRecord& state,
    double thresholdElevationRad,
    const ElevationMaskTable* elevationMask,
    const RefractionModelRecord* refractionModel) {
  const AccessGeometry geometry = computeAccessGeometryRad(
      stationEcef,
      stationEast,
      stationNorth,
      stationUp,
      state);
  const double threshold =
      elevationMask != nullptr
          ? evaluateElevationMask(*elevationMask, geometry.azimuth_rad)
          : thresholdElevationRad;
  const double apparentElevation =
      geometry.elevation_rad +
      computeRefractionRad(
          geometry.elevation_rad,
          refractionModel);
  return {
      geometry.elevation_rad,
      apparentElevation - threshold,
  };
}

std::vector<AccessWindowRecord> computeAccessWindows(
    const StateRecord* states,
    uint32_t stateCount,
    const StoredGroundStation& station,
    double thresholdElevationRad,
    const ElevationMaskTable* elevationMask = nullptr,
    const RefractionModelRecord* refractionModel = nullptr) {
  std::vector<AccessWindowRecord> windows;
  if (states == nullptr || stateCount < 2) {
    return windows;
  }

  const Vec3 stationEcef = geodeticToEcef(
      station.latitude_rad,
      station.longitude_rad,
      station.altitude_m);
  const Vec3 stationUp =
      geodeticUp(station.latitude_rad, station.longitude_rad);
  const Vec3 stationEast = geodeticEast(station.longitude_rad);
  const Vec3 stationNorth =
      geodeticNorth(station.latitude_rad, station.longitude_rad);

  VisibilitySample previousSample = computeVisibilitySample(
      stationEcef,
      stationEast,
      stationNorth,
      stationUp,
      states[0],
      thresholdElevationRad,
      elevationMask,
      refractionModel);
  double previousTime = states[0].julian_date;
  bool previousVisible = previousSample.switching_value >= 0.0;

  AccessWindowRecord activeWindow{};
  bool hasActiveWindow = previousVisible;
  if (hasActiveWindow) {
    activeWindow.start_julian_date = previousTime;
    activeWindow.end_julian_date = previousTime;
    activeWindow.max_elevation_rad = previousSample.elevation_rad;
    activeWindow.sample_count = 1;
    activeWindow.reserved = 0;
  }

  for (uint32_t index = 1; index < stateCount; index += 1) {
    const StateRecord& currentState = states[index];
    const VisibilitySample currentSample = computeVisibilitySample(
        stationEcef,
        stationEast,
        stationNorth,
        stationUp,
        currentState,
        thresholdElevationRad,
        elevationMask,
        refractionModel);
    const double currentTime = currentState.julian_date;
    const bool currentVisible = currentSample.switching_value >= 0.0;

    if (!previousVisible && currentVisible) {
      hasActiveWindow = true;
      activeWindow = {};
      activeWindow.start_julian_date = interpolateCrossingTime(
          previousTime,
          previousSample.switching_value,
          currentTime,
          currentSample.switching_value);
      activeWindow.end_julian_date = currentTime;
      activeWindow.max_elevation_rad = currentSample.elevation_rad;
      activeWindow.sample_count = 1;
      activeWindow.reserved = 0;
    } else if (previousVisible && currentVisible && hasActiveWindow) {
      activeWindow.end_julian_date = currentTime;
      activeWindow.max_elevation_rad =
          std::max(activeWindow.max_elevation_rad, currentSample.elevation_rad);
      activeWindow.sample_count += 1;
    } else if (previousVisible && !currentVisible && hasActiveWindow) {
      activeWindow.end_julian_date = interpolateCrossingTime(
          previousTime,
          previousSample.switching_value,
          currentTime,
          currentSample.switching_value);
      activeWindow.max_elevation_rad =
          std::max(activeWindow.max_elevation_rad, previousSample.elevation_rad);
      windows.push_back(activeWindow);
      hasActiveWindow = false;
      activeWindow = {};
    }

    previousSample = currentSample;
    previousTime = currentTime;
    previousVisible = currentVisible;
  }

  if (hasActiveWindow) {
    activeWindow.end_julian_date = states[stateCount - 1].julian_date;
    windows.push_back(activeWindow);
  }

  return windows;
}

uint8_t* copyAccessWindowRecordsToOutput(
    const std::vector<AccessWindowRecord>& windows,
    uint32_t* outWindowCount) {
  if (outWindowCount != nullptr) {
    *outWindowCount = static_cast<uint32_t>(windows.size());
  }
  if (windows.empty()) {
    return nullptr;
  }

  const size_t byteLength = windows.size() * sizeof(AccessWindowRecord);
  uint8_t* outBytes = static_cast<uint8_t*>(orbpro_malloc(byteLength));
  if (outBytes == nullptr) {
    if (outWindowCount != nullptr) {
      *outWindowCount = 0;
    }
    return nullptr;
  }

  std::memcpy(outBytes, windows.data(), byteLength);
  return outBytes;
}

std::vector<BlackoutWindowRecord> sortAndMergeBlackouts(
    std::vector<BlackoutWindowRecord> windows) {
  if (windows.empty()) {
    return windows;
  }

  std::sort(
      windows.begin(),
      windows.end(),
      [](const BlackoutWindowRecord& left, const BlackoutWindowRecord& right) {
        if (left.start_julian_date != right.start_julian_date) {
          return left.start_julian_date < right.start_julian_date;
        }
        return left.end_julian_date < right.end_julian_date;
      });

  std::vector<BlackoutWindowRecord> merged;
  merged.reserve(windows.size());
  merged.push_back(windows.front());

  for (size_t index = 1; index < windows.size(); index += 1) {
    BlackoutWindowRecord& last = merged.back();
    const BlackoutWindowRecord& current = windows[index];
    if (current.start_julian_date <= last.end_julian_date) {
      last.end_julian_date =
          std::max(last.end_julian_date, current.end_julian_date);
      continue;
    }
    merged.push_back(current);
  }

  return merged;
}

bool selectLongestAvailableSegment(
    double startJulianDate,
    double endJulianDate,
    const std::vector<BlackoutWindowRecord>& blackoutWindows,
    double* outStartJulianDate,
    double* outEndJulianDate) {
  if (!isFinite(startJulianDate) || !isFinite(endJulianDate) ||
      endJulianDate <= startJulianDate) {
    return false;
  }

  double bestStart = 0.0;
  double bestEnd = 0.0;
  double bestDuration = 0.0;
  double cursor = startJulianDate;

  for (const BlackoutWindowRecord& blackout : blackoutWindows) {
    if (blackout.end_julian_date <= startJulianDate) {
      continue;
    }
    if (blackout.start_julian_date >= endJulianDate) {
      break;
    }

    const double segmentEnd =
        std::min(blackout.start_julian_date, endJulianDate);
    if (segmentEnd > cursor) {
      const double duration = segmentEnd - cursor;
      if (duration > bestDuration) {
        bestStart = cursor;
        bestEnd = segmentEnd;
        bestDuration = duration;
      }
    }

    cursor = std::max(cursor, std::min(blackout.end_julian_date, endJulianDate));
    if (cursor >= endJulianDate) {
      break;
    }
  }

  if (endJulianDate > cursor) {
    const double duration = endJulianDate - cursor;
    if (duration > bestDuration) {
      bestStart = cursor;
      bestEnd = endJulianDate;
      bestDuration = duration;
    }
  }

  if (bestDuration <= 0.0) {
    return false;
  }

  if (outStartJulianDate != nullptr) {
    *outStartJulianDate = bestStart;
  }
  if (outEndJulianDate != nullptr) {
    *outEndJulianDate = bestEnd;
  }
  return true;
}

bool intervalsOverlap(
    double startJulianDate,
    double endJulianDate,
    const ScheduledInterval& interval) {
  return startJulianDate < interval.end_julian_date &&
         endJulianDate > interval.start_julian_date;
}

std::vector<ScheduledContactRecord> scheduleContacts(
    const ScheduleWindowRecord* windows,
    uint32_t windowCount) {
  std::vector<ScheduledContactRecord> scheduled;
  if (windows == nullptr || windowCount == 0) {
    return scheduled;
  }

  std::vector<ScheduleWindowRecord> candidates(windows, windows + windowCount);
  std::sort(
      candidates.begin(),
      candidates.end(),
      [](const ScheduleWindowRecord& left, const ScheduleWindowRecord& right) {
        if (left.priority != right.priority) {
          return left.priority > right.priority;
        }
        if (left.score != right.score) {
          return left.score > right.score;
        }
        if (left.start_julian_date != right.start_julian_date) {
          return left.start_julian_date < right.start_julian_date;
        }
        if (left.station_index != right.station_index) {
          return left.station_index < right.station_index;
        }
        return left.sort_index < right.sort_index;
      });

  std::vector<std::vector<std::vector<ScheduledInterval>>> stationChannels(
      g_ground_stations.size());
  for (size_t stationIndex = 0; stationIndex < g_ground_stations.size();
       stationIndex += 1) {
    stationChannels[stationIndex].resize(
        normalizeChannelCapacity(
            g_ground_stations[stationIndex].channel_capacity));
  }

  for (const ScheduleWindowRecord& candidate : candidates) {
    if (candidate.station_index >= g_ground_stations.size()) {
      continue;
    }

    const StoredGroundStation& station =
        g_ground_stations[candidate.station_index];
    double clippedStart = 0.0;
    double clippedEnd = 0.0;
    if (!selectLongestAvailableSegment(
            candidate.start_julian_date,
            candidate.end_julian_date,
            station.blackout_windows,
            &clippedStart,
            &clippedEnd)) {
      continue;
    }

    std::vector<std::vector<ScheduledInterval>>& channels =
        stationChannels[candidate.station_index];
    for (uint32_t channelIndex = 0;
         channelIndex < channels.size();
         channelIndex += 1) {
      bool blocked = false;
      for (const ScheduledInterval& interval : channels[channelIndex]) {
        if (intervalsOverlap(clippedStart, clippedEnd, interval)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }

      channels[channelIndex].push_back({clippedStart, clippedEnd});
      scheduled.push_back({
          clippedStart,
          clippedEnd,
          candidate.sort_index,
          channelIndex,
      });
      break;
    }
  }

  return scheduled;
}

struct AcwInputFrame {
  const uint8_t* payload = nullptr;
  size_t size = 0;
};

struct AcwWindowWithStation {
  std::string station_id;
  AccessWindowRecord window;
};

bool findAcwInputFrame(
    const PIVRequest& request,
    AcwInputFrame* outFrame,
    std::string* errorMessage) {
  const auto* inputFrames = request.INPUTS();
  const auto* payloadArena = request.PAYLOAD_ARENA();
  const uint64_t arenaSize = payloadArena != nullptr ? payloadArena->size() : 0u;
  const size_t inputCount = inputFrames != nullptr ? inputFrames->size() : 0u;
  for (size_t index = 0; index < inputCount; index += 1) {
    const auto* frame =
        inputFrames->Get(static_cast<::flatbuffers::uoffset_t>(index));
    if (frame == nullptr) {
      continue;
    }
    const std::string portId = flatbufferString(frame->PORT_ID());
    if (!portId.empty() && portId != kAccessRequestPort) {
      continue;
    }
    if (!isAcwTypeRef(frame->TYPE_REF())) {
      if (errorMessage != nullptr) {
        *errorMessage =
            "Access stream input frame must use ACW.fbs with file identifier "
            "$ACW and root ACW.";
      }
      return false;
    }
    const uint64_t start = frame->OFFSET();
    const uint64_t size = frame->SIZE();
    const uint64_t end = start + size;
    if (size == 0u || payloadArena == nullptr || end < start || end > arenaSize) {
      if (errorMessage != nullptr) {
        *errorMessage = "ACW request frame points outside the invoke arena.";
      }
      return false;
    }
    if (outFrame != nullptr) {
      outFrame->payload =
          payloadArena->data() + static_cast<std::ptrdiff_t>(start);
      outFrame->size = static_cast<size_t>(size);
    }
    return true;
  }

  if (errorMessage != nullptr) {
    *errorMessage = "Missing ACW request frame on the request port.";
  }
  return false;
}

bool parseAcwGroundStation(
    const ACWGroundStation* source,
    StoredGroundStation* outStation,
    std::string* errorMessage) {
  if (source == nullptr || outStation == nullptr) {
    if (errorMessage != nullptr) {
      *errorMessage = "ACW ground station entry is missing.";
    }
    return false;
  }

  const std::string stationId = flatbufferString(source->STATION_ID());
  const std::string stationName = flatbufferString(source->NAME());
  if (stationId.empty()) {
    if (errorMessage != nullptr) {
      *errorMessage = "ACW ground station STATION_ID is required.";
    }
    return false;
  }

  const double latitudeRad = source->LATITUDE_RAD();
  const double longitudeRad = source->LONGITUDE_RAD();
  const double altitudeM = source->ALTITUDE_M();
  const double minElevationRad = source->MIN_ELEVATION_RAD();
  if (!isFinite(latitudeRad) || !isFinite(longitudeRad) ||
      !isFinite(altitudeM) || !isFinite(minElevationRad)) {
    if (errorMessage != nullptr) {
      *errorMessage = "ACW ground station numeric fields must be finite.";
    }
    return false;
  }

  StoredGroundStation station{};
  station.latitude_rad = latitudeRad;
  station.longitude_rad = longitudeRad;
  station.altitude_m = altitudeM;
  station.min_elevation_rad = minElevationRad;
  station.channel_capacity = normalizeChannelCapacity(source->CHANNEL_CAPACITY());
  copyTextField(station.id, stationId.c_str());
  copyTextField(
      station.name,
      stationName.empty() ? stationId.c_str() : stationName.c_str());

  const auto* blackoutWindows = source->BLACKOUT_WINDOWS();
  std::vector<BlackoutWindowRecord> normalizedBlackouts;
  if (blackoutWindows != nullptr) {
    normalizedBlackouts.reserve(blackoutWindows->size());
    for (const auto* blackout : *blackoutWindows) {
      if (blackout == nullptr ||
          !isFinite(blackout->START_JULIAN_DATE_TT()) ||
          !isFinite(blackout->END_JULIAN_DATE_TT()) ||
          blackout->END_JULIAN_DATE_TT() <=
              blackout->START_JULIAN_DATE_TT()) {
        if (errorMessage != nullptr) {
          *errorMessage =
              "ACW blackout windows require finite start/end TT Julian dates "
              "with end greater than start.";
        }
        return false;
      }
      normalizedBlackouts.push_back({
          blackout->START_JULIAN_DATE_TT(),
          blackout->END_JULIAN_DATE_TT(),
      });
    }
  }
  station.blackout_windows = sortAndMergeBlackouts(std::move(normalizedBlackouts));
  *outStation = std::move(station);
  return true;
}

bool parseAcwStates(
    const ::flatbuffers::Vector<::flatbuffers::Offset<ACWStateSample>>* source,
    std::vector<StateRecord>* outStates,
    std::string* errorMessage) {
  if (source == nullptr || source->size() < 2u || outStates == nullptr) {
    if (errorMessage != nullptr) {
      *errorMessage = "ACW request requires at least two state samples.";
    }
    return false;
  }

  std::vector<StateRecord> states;
  states.reserve(source->size());
  for (const auto* sample : *source) {
    if (sample == nullptr ||
        !isFinite(sample->JULIAN_DATE_TT()) ||
        !isFinite(sample->POSITION_X_M()) ||
        !isFinite(sample->POSITION_Y_M()) ||
        !isFinite(sample->POSITION_Z_M())) {
      if (errorMessage != nullptr) {
        *errorMessage =
            "ACW state samples require finite TT Julian date and ECEF "
            "position components.";
      }
      return false;
    }
    states.push_back({
        sample->JULIAN_DATE_TT(),
        sample->POSITION_X_M(),
        sample->POSITION_Y_M(),
        sample->POSITION_Z_M(),
    });
  }

  *outStates = std::move(states);
  return true;
}

bool parseAcwElevationMask(
    const ::flatbuffers::Vector<::flatbuffers::Offset<ACWElevationMaskPoint>>*
        source,
    ElevationMaskTable* outMask,
    std::string* errorMessage) {
  if (source == nullptr || source->size() == 0u || outMask == nullptr) {
    if (errorMessage != nullptr) {
      *errorMessage = "ACW elevation mask requires at least one point.";
    }
    return false;
  }

  std::vector<ElevationMaskPointRecord> records;
  records.reserve(source->size());
  for (const auto* point : *source) {
    if (point == nullptr || !isFinite(point->AZIMUTH_RAD()) ||
        !isFinite(point->ELEVATION_RAD())) {
      if (errorMessage != nullptr) {
        *errorMessage =
            "ACW elevation mask points require finite azimuth and elevation "
            "radians.";
      }
      return false;
    }
    records.push_back({
        point->AZIMUTH_RAD(),
        point->ELEVATION_RAD(),
    });
  }

  if (!normalizeElevationMask(
          records.data(),
          static_cast<uint32_t>(records.size()),
          outMask)) {
    if (errorMessage != nullptr) {
      *errorMessage =
          "ACW elevation mask points must have finite azimuth/elevation values "
          "and duplicate azimuths must agree.";
    }
    return false;
  }

  return true;
}

bool parseAcwRefractionModel(
    const ACWRefractionModel* source,
    RefractionModelRecord* outModel,
    bool* outEnabled,
    std::string* errorMessage) {
  if (outEnabled != nullptr) {
    *outEnabled = false;
  }
  if (source == nullptr) {
    return true;
  }

  switch (source->MODEL_KIND()) {
    case acwRefractionModelKind_NONE:
      return true;
    case acwRefractionModelKind_EARTH_STANDARD_ATMOSPHERE:
      break;
    default:
      if (errorMessage != nullptr) {
        *errorMessage = "ACW refraction model kind is not supported.";
      }
      return false;
  }

  RefractionModelRecord model{};
  model.model_kind = kRefractionModelKindEarthStandardAtmosphere;
  model.pressure_pa = source->PRESSURE_PA();
  model.temperature_k = source->TEMPERATURE_K();
  if (!prepareRefractionModel(&model)) {
    if (errorMessage != nullptr) {
      *errorMessage =
          "ACW EarthStandardAtmosphereRefraction requires finite pressure and "
          "positive finite temperature.";
    }
    return false;
  }

  if (outModel != nullptr) {
    *outModel = model;
  }
  if (outEnabled != nullptr) {
    *outEnabled = true;
  }
  return true;
}

std::vector<uint8_t> serializeAcwResultPayload(
    acwResultStatus status,
    const std::vector<AcwWindowWithStation>& windows,
    const std::string& traceId,
    const char* errorMessage = nullptr) {
  ::flatbuffers::FlatBufferBuilder builder(1024);
  std::vector<::flatbuffers::Offset<ACWAccessWindow>> windowOffsets;
  windowOffsets.reserve(windows.size());
  for (const AcwWindowWithStation& entry : windows) {
    windowOffsets.push_back(CreateACWAccessWindowDirect(
        builder,
        entry.station_id.c_str(),
        entry.window.start_julian_date,
        entry.window.end_julian_date,
        entry.window.max_elevation_rad,
        entry.window.sample_count));
  }

  const auto windowsVector = builder.CreateVector(windowOffsets);
  const auto errorMessageOffset =
      errorMessage != nullptr && errorMessage[0] != '\0'
          ? builder.CreateString(errorMessage)
          : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto traceIdOffset =
      !traceId.empty() ? builder.CreateString(traceId)
                       : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto result = CreateACWResult(
      builder,
      status,
      errorMessageOffset,
      windowsVector,
      traceIdOffset);
  const auto envelope = CreateACW(builder, 0, result);
  FinishACWBuffer(builder, envelope);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

std::vector<uint8_t> serializePivResponse(
    int32_t statusCode,
    const char* errorCode,
    const std::string& errorMessage,
    const std::vector<uint8_t>* payload,
    uint64_t traceId) {
  ::flatbuffers::FlatBufferBuilder builder(
      1024 + (payload != nullptr ? payload->size() : 0u));

  std::vector<::flatbuffers::Offset<TAB>> outputFrames;
  ::flatbuffers::Offset<::flatbuffers::Vector<uint8_t>> payloadArena;
  if (payload != nullptr) {
    const auto typeRef = CreateFlatBufferTypeRefDirect(
        builder,
        kAcwSchemaName,
        kAcwFileIdentifier,
        nullptr,
        kAcwRootType);
    outputFrames.push_back(CreateTABDirect(
        builder,
        0,
        static_cast<uint32_t>(payload->size()),
        8,
        payloadWireFormat_FLATBUFFER,
        typeRef,
        bufferMutability_IMMUTABLE,
        bufferOwnership_HOST_OWNED,
        1,
        kAccessResultsPort));
    builder.ForceVectorAlignment(payload->size(), sizeof(uint8_t), 8);
    payloadArena = builder.CreateVector(*payload);
  }

  const auto outputVector = builder.CreateVector(outputFrames);
  const auto errorCodeOffset =
      errorCode != nullptr && errorCode[0] != '\0'
          ? builder.CreateString(errorCode)
          : ::flatbuffers::Offset<::flatbuffers::String>();
  const auto errorMessageOffset =
      !errorMessage.empty()
          ? builder.CreateString(errorMessage)
          : ::flatbuffers::Offset<::flatbuffers::String>();
  const pivStatus status =
      statusCode == 0
          ? pivStatus_OK
          : (statusCode == 404 ? pivStatus_NOT_FOUND : pivStatus_FAILED);
  const auto response = CreatePIVResponse(
      builder,
      statusCode,
      status,
      false,
      0,
      outputVector,
      payloadArena,
      errorCodeOffset,
      errorMessageOffset,
      traceId);
  const auto root = CreatePIV(builder, 0, response);
  FinishPIVBuffer(builder, root);
  return std::vector<uint8_t>(
      builder.GetBufferPointer(),
      builder.GetBufferPointer() + builder.GetSize());
}

std::vector<uint8_t> serializeInvokeResponse(
    int32_t statusCode,
    const char* errorCode,
    const std::string& errorMessage,
    uint64_t traceId = 0) {
  return serializePivResponse(
      statusCode,
      errorCode != nullptr ? errorCode : "invoke-error",
      errorMessage,
      nullptr,
      traceId);
}

std::vector<uint8_t> serializeInvokeSuccessWithAcwPayload(
    const std::vector<uint8_t>& payload,
    uint64_t traceId = 0) {
  return serializePivResponse(0, nullptr, "", &payload, traceId);
}

std::vector<uint8_t> dispatchAcwInput(
    const AcwInputFrame& inputFrame, uint64_t pivTraceId) {
  std::string errorMessage;
  ::flatbuffers::Verifier acwVerifier(inputFrame.payload, inputFrame.size);
  if (!VerifyACWBuffer(acwVerifier)) {
    return serializeInvokeResponse(
        400,
        "invalid-access-request",
        "ACW request FlatBuffer verification failed.",
        pivTraceId);
  }

  const ACW* acwEnvelope = GetACW(inputFrame.payload);
  const ACWRequest* acwRequest =
      acwEnvelope != nullptr ? acwEnvelope->REQUEST() : nullptr;
  if (acwRequest == nullptr) {
    return serializeInvokeResponse(
        400,
        "invalid-access-request",
        "ACW request envelope must carry REQUEST.",
        pivTraceId);
  }

  const std::string traceId = flatbufferString(acwRequest->TRACE_ID());
  if (acwRequest->OPERATION() != acwOperationCode_COMPUTE_ACCESS_WINDOWS) {
    const std::vector<uint8_t> payload = serializeAcwResultPayload(
        acwResultStatus_UNSUPPORTED_OPERATION,
        {},
        traceId,
        "ACW operation is not supported by analysis/access.");
    return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
  }

  std::vector<StateRecord> states;
  if (!parseAcwStates(acwRequest->STATES(), &states, &errorMessage)) {
    const std::vector<uint8_t> payload = serializeAcwResultPayload(
        acwResultStatus_INVALID_INPUT,
        {},
        traceId,
        errorMessage.c_str());
    return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
  }

  const auto* stationRecords = acwRequest->GROUND_STATIONS();
  if (stationRecords == nullptr || stationRecords->size() == 0u) {
    const std::vector<uint8_t> payload = serializeAcwResultPayload(
        acwResultStatus_INVALID_INPUT,
        {},
        traceId,
        "ACW request requires at least one ground station.");
    return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
  }

  std::vector<StoredGroundStation> stations;
  stations.reserve(stationRecords->size());
  for (const auto* stationRecord : *stationRecords) {
    StoredGroundStation station{};
    if (!parseAcwGroundStation(stationRecord, &station, &errorMessage)) {
      const std::vector<uint8_t> payload = serializeAcwResultPayload(
          acwResultStatus_INVALID_INPUT,
          {},
          traceId,
          errorMessage.c_str());
      return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
    }
    stations.push_back(std::move(station));
  }

  const std::string targetStationId =
      flatbufferString(acwRequest->TARGET_STATION_ID());
  const bool hasTargetStation = !targetStationId.empty();
  const double minElevationOverrideRad =
      acwRequest->MIN_ELEVATION_OVERRIDE_RAD();

  ElevationMaskTable elevationMask{};
  const ElevationMaskTable* elevationMaskPtr = nullptr;
  const auto* elevationMaskRecords = acwRequest->ELEVATION_MASK();
  if (elevationMaskRecords != nullptr && elevationMaskRecords->size() > 0u) {
    if (!parseAcwElevationMask(
            elevationMaskRecords,
            &elevationMask,
            &errorMessage)) {
      const std::vector<uint8_t> payload = serializeAcwResultPayload(
          acwResultStatus_INVALID_INPUT,
          {},
          traceId,
          errorMessage.c_str());
      return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
    }
    elevationMaskPtr = &elevationMask;
  }

  RefractionModelRecord refractionModel{};
  const RefractionModelRecord* refractionModelPtr = nullptr;
  bool hasRefractionModel = false;
  if (!parseAcwRefractionModel(
          acwRequest->REFRACTION_MODEL(),
          &refractionModel,
          &hasRefractionModel,
          &errorMessage)) {
    const std::vector<uint8_t> payload = serializeAcwResultPayload(
        acwResultStatus_INVALID_INPUT,
        {},
        traceId,
        errorMessage.c_str());
    return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
  }
  if (hasRefractionModel) {
    refractionModelPtr = &refractionModel;
  }

  std::vector<AcwWindowWithStation> allWindows;
  bool matchedTargetStation = false;
  for (const StoredGroundStation& station : stations) {
    const std::string stationId = textFieldToString(station.id);
    if (hasTargetStation && stationId != targetStationId) {
      continue;
    }
    matchedTargetStation = true;
    const double thresholdElevation =
        isFinite(minElevationOverrideRad) ? minElevationOverrideRad
                                          : station.min_elevation_rad;
    const std::vector<AccessWindowRecord> windows = computeAccessWindows(
        states.data(),
        static_cast<uint32_t>(states.size()),
        station,
        thresholdElevation,
        elevationMaskPtr,
        refractionModelPtr);
    for (const AccessWindowRecord& window : windows) {
      allWindows.push_back({stationId, window});
    }
  }

  if (hasTargetStation && !matchedTargetStation) {
    const std::vector<uint8_t> payload = serializeAcwResultPayload(
        acwResultStatus_INVALID_INPUT,
        {},
        traceId,
        "ACW TARGET_STATION_ID does not match any request ground station.");
    return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
  }

  const std::vector<uint8_t> payload = serializeAcwResultPayload(
      acwResultStatus_OK,
      allWindows,
      traceId);
  return serializeInvokeSuccessWithAcwPayload(payload, pivTraceId);
}

std::vector<uint8_t> dispatchInvokeRequest(
    const uint8_t* requestBytes,
    size_t requestLen) {
  if (requestBytes == nullptr || requestLen == 0u) {
    return serializeInvokeResponse(
        400,
        "invalid-request",
        "Invoke request bytes are empty.");
  }

  if (requestLen < 8u || !PIVBufferHasIdentifier(requestBytes)) {
    return serializeInvokeResponse(
        400,
        "invalid-request",
        "Invoke request must be an SDS PIV envelope.");
  }

  ::flatbuffers::Verifier verifier(requestBytes, requestLen);
  if (!VerifyPIVBuffer(verifier)) {
    return serializeInvokeResponse(
        400,
        "invalid-request",
        "SDS PIV invoke envelope verification failed.");
  }

  const auto* pivEnvelope = GetPIV(requestBytes);
  const auto* request = pivEnvelope != nullptr ? pivEnvelope->REQUEST() : nullptr;
  if (request == nullptr) {
    return serializeInvokeResponse(
        400,
        "invalid-request",
        "SDS PIV invoke envelope must carry REQUEST.");
  }
  const uint64_t pivTraceId = request->TRACE_ID();
  const std::string methodId = flatbufferString(request->METHOD_ID());
  if (methodId != kComputeAccessWindowsMethod) {
    return serializeInvokeResponse(
        404,
        "unknown-method",
        std::string("Unknown method: ") + methodId,
        pivTraceId);
  }

  AcwInputFrame inputFrame{};
  std::string errorMessage;
  if (!findAcwInputFrame(*request, &inputFrame, &errorMessage)) {
    return serializeInvokeResponse(
        400,
        "missing-access-request",
        errorMessage,
        pivTraceId);
  }

  return dispatchAcwInput(inputFrame, pivTraceId);
}

}  // namespace

extern "C" {

const uint8_t* access_plugin_manifest_bytes(void);
uint32_t access_plugin_manifest_size(void);

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t* data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_ground_stations.clear();
  g_ground_stations.shrink_to_fit();
  g_initialized = false;
}

ORBPRO_EXPORT
int32_t access_reset_ground_stations(void) {
  g_ground_stations.clear();
  return 0;
}

ORBPRO_EXPORT
int32_t access_add_ground_station(
    const uint8_t* recordBytes,
    uint32_t recordSize) {
  if (!g_initialized || recordBytes == nullptr ||
      recordSize != sizeof(GroundStationRecord)) {
    return -1;
  }

  GroundStationRecord record{};
  std::memcpy(&record, recordBytes, sizeof(GroundStationRecord));
  if (!isFinite(record.latitude_rad) || !isFinite(record.longitude_rad) ||
      !isFinite(record.altitude_m) ||
      !isFinite(record.min_elevation_rad)) {
    return -2;
  }

  StoredGroundStation station{};
  station.latitude_rad = record.latitude_rad;
  station.longitude_rad = record.longitude_rad;
  station.altitude_m = record.altitude_m;
  station.min_elevation_rad = record.min_elevation_rad;
  station.channel_capacity = normalizeChannelCapacity(record.channel_capacity);
  copyTextField(station.id, record.id);
  copyTextField(station.name, record.name);
  g_ground_stations.push_back(station);
  return static_cast<int32_t>(g_ground_stations.size() - 1);
}

ORBPRO_EXPORT
int32_t access_set_ground_station_blackouts(
    uint32_t stationIndex,
    const uint8_t* blackoutBytes,
    uint32_t blackoutCount) {
  if (!g_initialized || stationIndex >= g_ground_stations.size()) {
    return -1;
  }
  if (blackoutCount == 0) {
    g_ground_stations[stationIndex].blackout_windows.clear();
    return 0;
  }
  if (blackoutBytes == nullptr) {
    return -2;
  }

  const BlackoutWindowRecord* windows =
      reinterpret_cast<const BlackoutWindowRecord*>(blackoutBytes);
  std::vector<BlackoutWindowRecord> normalized;
  normalized.reserve(blackoutCount);
  for (uint32_t index = 0; index < blackoutCount; index += 1) {
    const BlackoutWindowRecord& window = windows[index];
    if (!isFinite(window.start_julian_date) ||
        !isFinite(window.end_julian_date) ||
        window.end_julian_date <= window.start_julian_date) {
      return -3;
    }
    normalized.push_back(window);
  }

  g_ground_stations[stationIndex].blackout_windows =
      sortAndMergeBlackouts(std::move(normalized));
  return 0;
}

ORBPRO_EXPORT
uint32_t access_get_ground_station_count(void) {
  return static_cast<uint32_t>(g_ground_stations.size());
}

ORBPRO_EXPORT
int32_t access_get_ground_station_record(
    uint32_t stationIndex,
    uint8_t* outRecordBytes,
    uint32_t outRecordSize) {
  if (outRecordBytes == nullptr ||
      outRecordSize != sizeof(GroundStationRecord) ||
      stationIndex >= g_ground_stations.size()) {
    return -1;
  }

  const StoredGroundStation& station = g_ground_stations[stationIndex];
  GroundStationRecord record{};
  record.latitude_rad = station.latitude_rad;
  record.longitude_rad = station.longitude_rad;
  record.altitude_m = station.altitude_m;
  record.min_elevation_rad = station.min_elevation_rad;
  record.channel_capacity = station.channel_capacity;
  record.reserved = 0u;
  copyTextField(record.id, station.id.data());
  copyTextField(record.name, station.name.data());
  std::memcpy(outRecordBytes, &record, sizeof(GroundStationRecord));
  return 0;
}

ORBPRO_EXPORT
uint32_t access_get_ground_station_blackout_count(uint32_t stationIndex) {
  if (stationIndex >= g_ground_stations.size()) {
    return 0;
  }
  return static_cast<uint32_t>(
      g_ground_stations[stationIndex].blackout_windows.size());
}

ORBPRO_EXPORT
int32_t access_get_ground_station_blackout_record(
    uint32_t stationIndex,
    uint32_t blackoutIndex,
    uint8_t* outRecordBytes,
    uint32_t outRecordSize) {
  if (outRecordBytes == nullptr ||
      outRecordSize != sizeof(BlackoutWindowRecord) ||
      stationIndex >= g_ground_stations.size()) {
    return -1;
  }

  const std::vector<BlackoutWindowRecord>& blackoutWindows =
      g_ground_stations[stationIndex].blackout_windows;
  if (blackoutIndex >= blackoutWindows.size()) {
    return -2;
  }

  std::memcpy(
      outRecordBytes,
      &blackoutWindows[blackoutIndex],
      sizeof(BlackoutWindowRecord));
  return 0;
}

ORBPRO_EXPORT
uint8_t* access_compute_access_windows(
    const uint8_t* stateBytes,
    uint32_t stateCount,
    uint32_t stationIndex,
    double minElevationOverrideRad,
    uint32_t* outWindowCount) {
  if (outWindowCount != nullptr) {
    *outWindowCount = 0;
  }

  if (!g_initialized || stateBytes == nullptr || stateCount == 0 ||
      stationIndex >= g_ground_stations.size()) {
    return nullptr;
  }

  const StateRecord* states =
      reinterpret_cast<const StateRecord*>(stateBytes);
  const StoredGroundStation& station = g_ground_stations[stationIndex];
  const double thresholdElevation =
      isFinite(minElevationOverrideRad) ? minElevationOverrideRad
                                        : station.min_elevation_rad;

  std::vector<AccessWindowRecord> windows = computeAccessWindows(
      states,
      stateCount,
      station,
      thresholdElevation);
  return copyAccessWindowRecordsToOutput(windows, outWindowCount);
}

ORBPRO_EXPORT
uint8_t* access_compute_access_windows_with_elevation_mask(
    const uint8_t* stateBytes,
    uint32_t stateCount,
    uint32_t stationIndex,
    const uint8_t* maskPointBytes,
    uint32_t maskPointCount,
    uint32_t* outWindowCount) {
  if (outWindowCount != nullptr) {
    *outWindowCount = 0;
  }

  if (!g_initialized || stateBytes == nullptr || stateCount == 0 ||
      stationIndex >= g_ground_stations.size() || maskPointBytes == nullptr ||
      maskPointCount == 0u) {
    return nullptr;
  }

  const ElevationMaskPointRecord* maskRecords =
      reinterpret_cast<const ElevationMaskPointRecord*>(maskPointBytes);
  ElevationMaskTable elevationMask{};
  if (!normalizeElevationMask(maskRecords, maskPointCount, &elevationMask)) {
    return nullptr;
  }

  const StateRecord* states =
      reinterpret_cast<const StateRecord*>(stateBytes);
  const StoredGroundStation& station = g_ground_stations[stationIndex];
  std::vector<AccessWindowRecord> windows = computeAccessWindows(
      states,
      stateCount,
      station,
      station.min_elevation_rad,
      &elevationMask);
  return copyAccessWindowRecordsToOutput(windows, outWindowCount);
}

// Legacy geometry API uses the same C++ frame, mask, and refraction functions
// as ACW; JS only copies this fixed-size result record.
ORBPRO_EXPORT
int32_t access_compute_geometry(
    const StateRecord* state, uint32_t stationIndex, double minElevation,
    const ElevationMaskPointRecord* maskPoints, uint32_t maskCount,
    const RefractionModelRecord* refractionInput, double* output) {
  if (!g_initialized || !state || !output || stationIndex >= g_ground_stations.size()) return 1;
  const auto& station = g_ground_stations[stationIndex];
  const auto origin = geodeticToEcef(station.latitude_rad, station.longitude_rad, station.altitude_m);
  const auto geometry = computeAccessGeometryRad(origin, geodeticEast(station.longitude_rad),
      geodeticNorth(station.latitude_rad, station.longitude_rad),
      geodeticUp(station.latitude_rad, station.longitude_rad), *state);
  const Vec3 los{state->x - origin.x, state->y - origin.y, state->z - origin.z};
  const double range = std::sqrt(dot(los, los));
  const double elevation = range > 0 ? geometry.elevation_rad : -kPi / 2;
  double threshold = isFinite(minElevation) ? minElevation : station.min_elevation_rad;
  if (maskCount) {
    ElevationMaskTable mask{};
    if (!maskPoints || !normalizeElevationMask(maskPoints, maskCount, &mask)) return 2;
    threshold = evaluateElevationMask(mask, geometry.azimuth_rad);
  }
  RefractionModelRecord refraction{};
  const RefractionModelRecord* model = nullptr;
  if (refractionInput) {
    refraction = *refractionInput;
    if (!prepareRefractionModel(&refraction)) return 3;
    model = &refraction;
  }
  const double correction = computeRefractionRad(elevation, model);
  const double values[]{range, elevation, geometry.azimuth_rad, los.x, los.y, los.z,
      threshold, correction, elevation + correction, elevation + correction >= threshold ? 1.0 : 0.0};
  std::memcpy(output, values, sizeof(values));
  return 0;
}

ORBPRO_EXPORT
uint8_t* access_compute_access_windows_with_effects(
    const uint8_t* stateBytes,
    uint32_t stateCount,
    uint32_t stationIndex,
    double minElevationOverrideRad,
    const uint8_t* maskPointBytes,
    uint32_t maskPointCount,
    const uint8_t* refractionModelBytes,
    uint32_t* outWindowCount) {
  if (outWindowCount != nullptr) {
    *outWindowCount = 0;
  }

  if (!g_initialized || stateBytes == nullptr || stateCount == 0 ||
      stationIndex >= g_ground_stations.size()) {
    return nullptr;
  }

  ElevationMaskTable elevationMask{};
  const ElevationMaskTable* elevationMaskPtr = nullptr;
  if (maskPointCount > 0u) {
    if (maskPointBytes == nullptr) {
      return nullptr;
    }
    const ElevationMaskPointRecord* maskRecords =
        reinterpret_cast<const ElevationMaskPointRecord*>(maskPointBytes);
    if (!normalizeElevationMask(maskRecords, maskPointCount, &elevationMask)) {
      return nullptr;
    }
    elevationMaskPtr = &elevationMask;
  }

  RefractionModelRecord refractionModel{};
  const RefractionModelRecord* refractionModelPtr = nullptr;
  if (refractionModelBytes != nullptr) {
    std::memcpy(
        &refractionModel,
        refractionModelBytes,
        sizeof(RefractionModelRecord));
    if (!prepareRefractionModel(&refractionModel)) {
      return nullptr;
    }
    refractionModelPtr = &refractionModel;
  }

  const StateRecord* states =
      reinterpret_cast<const StateRecord*>(stateBytes);
  const StoredGroundStation& station = g_ground_stations[stationIndex];
  const double thresholdElevation =
      isFinite(minElevationOverrideRad) ? minElevationOverrideRad
                                        : station.min_elevation_rad;
  std::vector<AccessWindowRecord> windows = computeAccessWindows(
      states,
      stateCount,
      station,
      thresholdElevation,
      elevationMaskPtr,
      refractionModelPtr);
  return copyAccessWindowRecordsToOutput(windows, outWindowCount);
}

ORBPRO_EXPORT
uint8_t* access_schedule_contacts(
    const uint8_t* windowBytes,
    uint32_t windowCount,
    uint32_t* outScheduledCount) {
  if (outScheduledCount != nullptr) {
    *outScheduledCount = 0;
  }

  if (!g_initialized || windowBytes == nullptr || windowCount == 0) {
    return nullptr;
  }

  const ScheduleWindowRecord* windows =
      reinterpret_cast<const ScheduleWindowRecord*>(windowBytes);
  std::vector<ScheduledContactRecord> scheduled =
      scheduleContacts(windows, windowCount);
  if (outScheduledCount != nullptr) {
    *outScheduledCount = static_cast<uint32_t>(scheduled.size());
  }
  if (scheduled.empty()) {
    return nullptr;
  }

  const size_t byteLength =
      scheduled.size() * sizeof(ScheduledContactRecord);
  uint8_t* outBytes = static_cast<uint8_t*>(orbpro_malloc(byteLength));
  if (outBytes == nullptr) {
    if (outScheduledCount != nullptr) {
      *outScheduledCount = 0;
    }
    return nullptr;
  }

  std::memcpy(outBytes, scheduled.data(), byteLength);
  return outBytes;
}

#ifndef ACCESS_SDK_BUILD
ORBPRO_EXPORT
const uint8_t* plugin_get_manifest_flatbuffer(void) {
  return access_plugin_manifest_bytes();
}

ORBPRO_EXPORT
uint32_t plugin_get_manifest_flatbuffer_size(void) {
  return access_plugin_manifest_size();
}

ORBPRO_EXPORT
uint32_t plugin_alloc(uint32_t size) {
  const size_t allocationSize = size > 0u ? size : 1u;
  void* pointer = std::malloc(allocationSize);
  return pointer ? static_cast<uint32_t>(reinterpret_cast<uintptr_t>(pointer)) : 0u;
}

ORBPRO_EXPORT
void plugin_free(uint32_t ptr, uint32_t size) {
  (void)size;
  if (ptr != 0u) {
    std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)));
  }
}

ORBPRO_EXPORT
uint32_t plugin_invoke_stream(
    uint32_t requestPtr,
    uint32_t requestLen,
    uint32_t responseLenOutPtr) {
  if (responseLenOutPtr != 0u) {
    *reinterpret_cast<uint32_t*>(static_cast<uintptr_t>(responseLenOutPtr)) = 0u;
  }

  const auto responseBytes = dispatchInvokeRequest(
      reinterpret_cast<const uint8_t*>(
          static_cast<uintptr_t>(requestPtr)),
      static_cast<size_t>(requestLen));
  const uint32_t responsePtr =
      plugin_alloc(static_cast<uint32_t>(responseBytes.size()));
  if (responsePtr == 0u) {
    return 0u;
  }
  if (!responseBytes.empty()) {
    std::memcpy(
        reinterpret_cast<void*>(static_cast<uintptr_t>(responsePtr)),
        responseBytes.data(),
        responseBytes.size());
  }
  if (responseLenOutPtr != 0u) {
    *reinterpret_cast<uint32_t*>(static_cast<uintptr_t>(responseLenOutPtr)) =
        static_cast<uint32_t>(responseBytes.size());
  }
  return responsePtr;
}

#endif  // ACCESS_SDK_BUILD

}  // extern "C"
