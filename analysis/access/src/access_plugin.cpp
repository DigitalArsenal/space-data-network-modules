#include "orbpro_plugin.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84E2 = 6.6943799901413165e-3;
constexpr size_t kStringFieldSize = 64;

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

struct Vec3 {
  double x;
  double y;
  double z;
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

double computeElevationRad(
    const Vec3& stationEcef,
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
    return -std::numeric_limits<double>::infinity();
  }

  const double dot =
      (los.x * stationUp.x + los.y * stationUp.y + los.z * stationUp.z) /
      range;
  return std::asin(clampUnit(dot));
}

double interpolateCrossingTime(
    double previousTime,
    double previousElevation,
    double currentTime,
    double currentElevation,
    double thresholdElevation) {
  const double delta = currentElevation - previousElevation;
  if (std::abs(delta) < 1.0e-12) {
    return previousTime;
  }
  const double fraction =
      clampFraction((thresholdElevation - previousElevation) / delta);
  return previousTime + (currentTime - previousTime) * fraction;
}

std::vector<AccessWindowRecord> computeAccessWindows(
    const StateRecord* states,
    uint32_t stateCount,
    const StoredGroundStation& station,
    double thresholdElevationRad) {
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

  double previousElevation =
      computeElevationRad(stationEcef, stationUp, states[0]);
  double previousTime = states[0].julian_date;
  bool previousVisible = previousElevation >= thresholdElevationRad;

  AccessWindowRecord activeWindow{};
  bool hasActiveWindow = previousVisible;
  if (hasActiveWindow) {
    activeWindow.start_julian_date = previousTime;
    activeWindow.end_julian_date = previousTime;
    activeWindow.max_elevation_rad = previousElevation;
    activeWindow.sample_count = 1;
    activeWindow.reserved = 0;
  }

  for (uint32_t index = 1; index < stateCount; index += 1) {
    const StateRecord& currentState = states[index];
    const double currentElevation =
        computeElevationRad(stationEcef, stationUp, currentState);
    const double currentTime = currentState.julian_date;
    const bool currentVisible = currentElevation >= thresholdElevationRad;

    if (!previousVisible && currentVisible) {
      hasActiveWindow = true;
      activeWindow = {};
      activeWindow.start_julian_date = interpolateCrossingTime(
          previousTime,
          previousElevation,
          currentTime,
          currentElevation,
          thresholdElevationRad);
      activeWindow.end_julian_date = currentTime;
      activeWindow.max_elevation_rad = currentElevation;
      activeWindow.sample_count = 1;
      activeWindow.reserved = 0;
    } else if (previousVisible && currentVisible && hasActiveWindow) {
      activeWindow.end_julian_date = currentTime;
      activeWindow.max_elevation_rad =
          std::max(activeWindow.max_elevation_rad, currentElevation);
      activeWindow.sample_count += 1;
    } else if (previousVisible && !currentVisible && hasActiveWindow) {
      activeWindow.end_julian_date = interpolateCrossingTime(
          previousTime,
          previousElevation,
          currentTime,
          currentElevation,
          thresholdElevationRad);
      activeWindow.max_elevation_rad =
          std::max(activeWindow.max_elevation_rad, previousElevation);
      windows.push_back(activeWindow);
      hasActiveWindow = false;
      activeWindow = {};
    }

    previousElevation = currentElevation;
    previousTime = currentTime;
    previousVisible = currentVisible;
  }

  if (hasActiveWindow) {
    activeWindow.end_julian_date = states[stateCount - 1].julian_date;
    windows.push_back(activeWindow);
  }

  return windows;
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

}  // namespace

extern "C" {

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

}  // extern "C"
