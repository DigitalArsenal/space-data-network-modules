#pragma once
// The parts of the $TDM decoder that are plain arithmetic on the record's
// text: time systems, PATH, and the weather rows. The FlatBuffers reading is
// in module.cpp; this header has no plugin or schema dependency, so the native
// conformance tests link it directly.
//
// Authority: CCSDS 503.0-B-2 (Tracking Data Message). Angles are degrees,
// TIME_SYSTEM names the scale of every epoch in the segment, TIMETAG_REF says
// whether an observation's epoch is the transmit or the receive instant, PATH
// is the participant sequence of the signal (1,2,1 is a two-way link from
// participant 1), INTEGRATION_REF places a count's epoch in its interval.
#include "estimation.hpp"

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <string>
#include <vector>

namespace sdn {
namespace estimation {
namespace tdm {

// A calendar instant read as if its scale were TAI, kept as whole seconds from
// 1970-01-01T00:00:00 plus a fraction so nanoseconds survive the subtraction of
// the request epoch.
struct Instant {
  std::int64_t whole{0};
  double fraction{0.0};
  bool leap{false};  // second 60 of a UTC day: the label equals the next midnight's
};

// Howard Hinnant's civil-date transform.
inline std::int64_t days_from_civil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(year - era * 400);
  const unsigned doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<std::int64_t>(era) * 146097 + static_cast<int>(doe) - 719468;
}

// "YYYY-MM-DDThh:mm:ss[.fff]" (a trailing Z is allowed); a leap second is
// second 60.
inline bool parse_calendar(const char* text, Instant* out) {
  if (text == nullptr || out == nullptr) return false;
  int year = 0, month = 0, day = 0, hour = 0, minute = 0;
  double second = 0.0;
  if (std::sscanf(text, "%d-%d-%dT%d:%d:%lf", &year, &month, &day, &hour, &minute, &second) != 6) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
      !(second >= 0.0 && second < 61.0)) return false;
  const double whole_second = std::floor(second);
  out->whole = days_from_civil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)) * 86400 +
               hour * 3600 + minute * 60 + static_cast<std::int64_t>(whole_second);
  out->fraction = second - whole_second;
  out->leap = whole_second >= 60.0;
  return true;
}

// TAI - UTC. IERS Bulletin C: the last leap second was inserted at the end of
// 2016-12-31 (37 s from 2017-01-01). The table is never extrapolated; a UTC
// instant from 2027-06-30 on is refused, as in analysis/od time_systems.h,
// because a leap second announced since would make 37 s wrong.
struct LeapStep {
  int year, month, day;
  int tai_utc;
};

inline bool tai_minus_utc(std::int64_t utc_label_seconds, int* seconds, std::string* error) {
  static const LeapStep steps[] = {
      {1972, 1, 1, 10}, {1972, 7, 1, 11}, {1973, 1, 1, 12}, {1974, 1, 1, 13}, {1975, 1, 1, 14},
      {1976, 1, 1, 15}, {1977, 1, 1, 16}, {1978, 1, 1, 17}, {1979, 1, 1, 18}, {1980, 1, 1, 19},
      {1981, 7, 1, 20}, {1982, 7, 1, 21}, {1983, 7, 1, 22}, {1985, 7, 1, 23}, {1988, 1, 1, 24},
      {1990, 1, 1, 25}, {1991, 1, 1, 26}, {1992, 7, 1, 27}, {1993, 7, 1, 28}, {1994, 7, 1, 29},
      {1996, 1, 1, 30}, {1997, 7, 1, 31}, {1999, 1, 1, 32}, {2006, 1, 1, 33}, {2009, 1, 1, 34},
      {2012, 7, 1, 35}, {2015, 7, 1, 36}, {2017, 1, 1, 37},
  };
  const std::int64_t horizon = days_from_civil(2027, 6, 30) * 86400;
  if (utc_label_seconds >= horizon) {
    if (error != nullptr) *error = "a UTC epoch on or after 2027-06-30 is beyond the leap-second table (IERS Bulletin C announces none through that date)";
    return false;
  }
  int current = -1;
  for (const LeapStep& step : steps) {
    if (utc_label_seconds >= days_from_civil(step.year, static_cast<unsigned>(step.month), static_cast<unsigned>(step.day)) * 86400) current = step.tai_utc;
  }
  if (current < 0) {
    if (error != nullptr) *error = "a UTC epoch before 1972-01-01 has no integer TAI - UTC offset";
    return false;
  }
  *seconds = current;
  return true;
}

// The instant in a TIME_SYSTEM as a TAI instant. UTC, TAI, GPS and TT only.
inline bool to_tai(const std::string& system, Instant in, Instant* out, std::string* error) {
  if (system == "TAI") {
    *out = in;
  } else if (system == "UTC") {
    int offset = 0;
    // The leap second belongs to the day it ends, so its offset is the one before the step.
    if (!tai_minus_utc(in.leap ? in.whole - 1 : in.whole, &offset, error)) return false;
    *out = {in.whole + offset, in.fraction, false};
  } else if (system == "GPS") {
    *out = {in.whole + 19, in.fraction};  // GPS = TAI - 19 s
  } else if (system == "TT") {
    // TAI = TT - 32.184 s
    Instant shifted{in.whole - 32, in.fraction - 0.184};
    if (shifted.fraction < 0.0) { shifted.fraction += 1.0; shifted.whole -= 1; }
    *out = shifted;
  } else {
    if (error != nullptr) *error = "TIME_SYSTEM '" + system + "' is not UTC, TAI, GPS or TT";
    return false;
  }
  return true;
}

// Seconds of an instant after the request epoch (jd_day + seconds, TAI).
inline double seconds_after(Instant tai, double reference_jd_day, double reference_seconds) {
  const double reference_label = (reference_jd_day - 2440587.5) * 86400.0;
  return (static_cast<double>(tai.whole) - reference_label) + (tai.fraction - reference_seconds);
}

// PATH "1,2,1": the legs the signal travels. Two participants are one leg, a
// return to the first participant is two. Other paths (three-way, relays) are
// not modelled.
inline bool path_legs(const std::string& path, int* legs, std::string* error) {
  std::vector<int> nodes;
  std::string token;
  for (std::size_t i = 0; i <= path.size(); ++i) {
    const char c = i < path.size() ? path[i] : ',';
    if (c == ',' || c == ' ') {
      if (!token.empty()) {
        char* end = nullptr;
        const long value = std::strtol(token.c_str(), &end, 10);
        if (end == token.c_str() || *end != '\0' || value < 1 || value > 5) {
          if (error != nullptr) *error = "PATH '" + path + "' is not a list of participant numbers 1 to 5";
          return false;
        }
        nodes.push_back(static_cast<int>(value));
        token.clear();
      }
    } else {
      token.push_back(c);
    }
  }
  if (nodes.size() == 2 && nodes[0] != nodes[1]) { *legs = 1; return true; }
  if (nodes.size() == 3 && nodes[0] == nodes[2] && nodes[0] != nodes[1]) { *legs = 2; return true; }
  if (error != nullptr) *error = "PATH '" + path + "' is not a one-way (a,b) or two-way (a,b,a) link";
  return false;
}

struct WeatherSample {
  double seconds{0.0};  // after the request epoch
  double value{0.0};
};

inline const WeatherSample* nearest(const std::vector<WeatherSample>& samples, double seconds) {
  const WeatherSample* best = nullptr;
  for (const WeatherSample& sample : samples) {
    if (best == nullptr || std::abs(sample.seconds - seconds) < std::abs(best->seconds - seconds)) best = &sample;
  }
  return best;
}

// One segment's metadata (the segment's value, else the record's) and one row.
struct Segment {
  std::string time_system, timetag_ref, path, angle_type, range_mode, range_units, integration_ref;
  double integration_interval{0.0};  // s
  double carrier_hz{0.0};            // TRANSMIT_FREQ_1
  double transmit_delay_s{0.0}, receive_delay_s{0.0};
  int turnaround_numerator{0}, turnaround_denominator{0};
};

struct Row {
  std::string keyword, epoch;
  double value{0.0};
};

struct Weather {
  std::vector<WeatherSample> pressure, temperature, humidity;
};

inline bool fail(std::string* error, const std::string& message) {
  if (error != nullptr) *error = message;
  return false;
}

inline bool is_range(MeasurementKind kind) {
  return kind == MeasurementKind::RANGE || kind == MeasurementKind::SEQUENTIAL_RANGE ||
         kind == MeasurementKind::PSEUDONOISE_RANGE || kind == MeasurementKind::LASER_RANGE;
}

inline bool is_angle(MeasurementKind kind) {
  return kind == MeasurementKind::AZIMUTH_ELEVATION || kind == MeasurementKind::X_EAST_Y_NORTH ||
         kind == MeasurementKind::X_SOUTH_Y_EAST || kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION;
}

// The measurement a row's keyword is; false for keywords this module does not
// turn into observations (ANGLE_2 rides with its ANGLE_1, weather has its own).
inline bool kind_of(const std::string& key, const Segment& segment, MeasurementKind* kind, std::uint8_t* count) {
  *count = 1;
  if (key == "RANGE") {
    *kind = segment.range_mode.find("PN") != std::string::npos ? MeasurementKind::PSEUDONOISE_RANGE
           : segment.range_mode.find("SEQUENTIAL") != std::string::npos ? MeasurementKind::SEQUENTIAL_RANGE
           : MeasurementKind::RANGE;
  } else if (key == "RANGE_RATE") *kind = MeasurementKind::RANGE_RATE;
  else if (key.find("DOPPLER") != std::string::npos) *kind = MeasurementKind::DOPPLER;
  else if (key.find("TRANSMIT_PHASE_CT") != std::string::npos) *kind = MeasurementKind::TIME_CORRELATED_PHASE;
  else if (key == "TDOA" || key == "VLBI_DELAY") *kind = MeasurementKind::TIME_DIFFERENCE_OF_ARRIVAL;
  else if (key == "FDOA") *kind = MeasurementKind::FREQUENCY_DIFFERENCE_OF_ARRIVAL;
  else if (key == "LASER_RANGE" || key == "SLR_RANGE") *kind = MeasurementKind::LASER_RANGE;
  else if (key == "CROSSLINK_RANGE") *kind = MeasurementKind::CROSSLINK_RANGE;
  else if (key == "CROSSLINK_RANGE_RATE") *kind = MeasurementKind::CROSSLINK_RANGE_RATE;
  else if (key == "BISTATIC_RANGE") *kind = MeasurementKind::BISTATIC_RANGE;
  else if (key == "SKIN_RANGE") *kind = MeasurementKind::SKIN_RANGE;
  else if (key == "ANGLE_1") {
    *count = 2;
    if (segment.angle_type == "RADEC") *kind = MeasurementKind::RIGHT_ASCENSION_DECLINATION;
    else if (segment.angle_type == "XEYN") *kind = MeasurementKind::X_EAST_Y_NORTH;
    else if (segment.angle_type == "XSYE") *kind = MeasurementKind::X_SOUTH_Y_EAST;
    else *kind = MeasurementKind::AZIMUTH_ELEVATION;
  } else return false;
  return true;
}

// Seconds after the request epoch (TAI) of a row's epoch in the segment's time system.
inline bool epoch_seconds(const Segment& segment, const std::string& epoch, double reference_jd_day,
                          double reference_seconds, double* out, std::string* error) {
  if (segment.time_system.empty()) return fail(error, "TIME_SYSTEM is required to read an epoch");
  Instant civil, tai;
  if (!parse_calendar(epoch.c_str(), &civil)) return fail(error, "an observation epoch is not YYYY-MM-DDThh:mm:ss");
  if (!to_tai(segment.time_system, civil, &tai, error)) return false;
  *out = seconds_after(tai, reference_jd_day, reference_seconds);
  return true;
}

// PRESSURE (hPa), TEMPERATURE (K) and RHUMIDITY (percent) rows; any other keyword is ignored.
inline bool add_weather(const Segment& segment, const Row& row, double reference_jd_day, double reference_seconds,
                        Weather* weather, std::string* error) {
  std::vector<WeatherSample>* target = row.keyword == "PRESSURE" ? &weather->pressure
      : row.keyword == "TEMPERATURE" ? &weather->temperature : row.keyword == "RHUMIDITY" ? &weather->humidity : nullptr;
  if (target == nullptr) return true;
  if (row.keyword == "RHUMIDITY" ? !(row.value >= 0.0 && row.value <= 100.0) : !(row.value > 0.0))
    return fail(error, row.keyword + " is out of range (hPa > 0, K > 0, percent 0 to 100)");
  double seconds = 0.0;
  if (!epoch_seconds(segment, row.epoch, reference_jd_day, reference_seconds, &seconds, error)) return false;
  target->push_back({seconds, row.value});
  return true;
}

// Reads one observation row (kind_of true) into an Observation on the request's
// time axis. `angle_2` is the ANGLE_2 row of the same epoch, null otherwise.
//
// Epochs are converted from the segment's TIME_SYSTEM to TAI, the scale of the
// request epoch. The estimator evaluates a range at the instant the signal is
// received (its light-time model looks back from there), so a range tagged
// TRANSMIT moves forward by the signal's travel time, legs x range / c (a
// laser range without PATH is two-way). Every other kind is placed only when
// tagged RECEIVE; a Doppler or range-rate count goes to the middle of its
// integration interval. PATH sets the legs of a Doppler: the shift is
// -(range rate) x frequency x turnaround x legs / c, so a two-way link doubles
// it. Angles are degrees in the record and radians in the estimator. A Doppler
// without TRANSMIT_FREQ_1 is refused: there is no default carrier. The station,
// the weather, the wavelength and the troposphere's geometry come with it.
inline bool decode(const Segment& segment, const Row& row, const Row* angle_2, double reference_jd_day,
                   double reference_seconds, const Weather& weather, Observation* out, std::string* error) {
  MeasurementKind kind{};
  std::uint8_t count = 0;
  if (!kind_of(row.keyword, segment, &kind, &count)) return fail(error, row.keyword + " is not an observation");
  double seconds = 0.0;
  if (!epoch_seconds(segment, row.epoch, reference_jd_day, reference_seconds, &seconds, error)) return false;
  const std::string& tag = segment.timetag_ref;
  if (tag != "TRANSMIT" && tag != "RECEIVE") return fail(error, row.keyword + " needs TIMETAG_REF TRANSMIT or RECEIVE");

  int legs = 0;
  if (kind == MeasurementKind::DOPPLER || (tag == "TRANSMIT" && kind != MeasurementKind::LASER_RANGE) || !segment.path.empty()) {
    if (segment.path.empty()) return fail(error, row.keyword + " needs PATH");
    if (!path_legs(segment.path, &legs, error)) return false;
  } else if (kind == MeasurementKind::LASER_RANGE) {
    legs = 2;
  }

  Observation observation;
  observation.id = row.keyword + ":" + row.epoch;
  observation.kind = kind;
  if (supports_two_way_light_time(kind)) observation.two_way = (legs == 2);
  observation.value_count = count;
  observation.value[0] = row.value;
  observation.media.frequency_hz = segment.carrier_hz > 0.0 ? segment.carrier_hz : 8.4e9;
  observation.media.geometry_from_station = true;
  if (kind == MeasurementKind::LASER_RANGE && segment.carrier_hz > 0.0)
    observation.media.wavelength_m = kSpeedOfLight / segment.carrier_hz;
  observation.hardware.transmitter_delay_seconds = segment.transmit_delay_s;
  observation.hardware.receiver_delay_seconds = segment.receive_delay_s;
  observation.hardware.turnaround_numerator = segment.turnaround_numerator > 0 ? static_cast<std::uint32_t>(segment.turnaround_numerator) : 1;
  observation.hardware.turnaround_denominator = segment.turnaround_denominator > 0 ? static_cast<std::uint32_t>(segment.turnaround_denominator) : 1;

  double travel_seconds = 0.0;
  if (kind == MeasurementKind::LASER_RANGE) {
    travel_seconds = legs * observation.value[0] / kSpeedOfLight;
  } else if (is_range(kind)) {
    const std::string& units = segment.range_units;
    if (!(units.empty() || units == "km" || units == "m" || units == "s")) return fail(error, "RANGE_UNITS '" + units + "' is not km, m or s");
    if (units == "s") {
      travel_seconds = observation.value[0];
      observation.value[0] *= kSpeedOfLight;
    } else {
      if (units != "m") observation.value[0] *= 1000.0;
      travel_seconds = legs * observation.value[0] / kSpeedOfLight;
    }
  }
  if (tag == "TRANSMIT") {
    if (!is_range(kind)) return fail(error, "TIMETAG_REF TRANSMIT places a range only; " + row.keyword + " needs RECEIVE");
    seconds += travel_seconds;
  }

  if (kind == MeasurementKind::DOPPLER) {
    if (!(segment.carrier_hz > 0.0)) return fail(error, row.keyword + " needs TRANSMIT_FREQ_1: there is no default carrier");
    observation.hardware.turnaround_numerator *= static_cast<std::uint32_t>(legs);
  }
  if ((kind == MeasurementKind::DOPPLER || kind == MeasurementKind::RANGE_RATE) && segment.integration_interval > 0.0) {
    if (segment.integration_ref == "START") seconds += 0.5 * segment.integration_interval;
    else if (segment.integration_ref == "END") seconds -= 0.5 * segment.integration_interval;
    else if (segment.integration_ref != "MIDDLE") return fail(error, "INTEGRATION_INTERVAL needs INTEGRATION_REF START, MIDDLE or END");
  }
  observation.epoch_seconds = seconds;

  if (const WeatherSample* sample = nearest(weather.pressure, seconds)) observation.media.pressure_hpa = sample->value;
  if (const WeatherSample* sample = nearest(weather.temperature, seconds)) observation.media.temperature_k = sample->value;
  if (const WeatherSample* sample = nearest(weather.humidity, seconds)) observation.media.relative_humidity = sample->value / 100.0;

  if (count == 2) {
    if (angle_2 == nullptr) return fail(error, "ANGLE_1 at " + row.epoch + " has no ANGLE_2 at the same epoch");
    constexpr double kRadiansPerDegree = 3.141592653589793238462643383279502884 / 180.0;
    observation.value[1] = angle_2->value * kRadiansPerDegree;
    observation.value[0] *= kRadiansPerDegree;
  }
  *out = observation;
  return true;
}

}  // namespace tdm
}  // namespace estimation
}  // namespace sdn
