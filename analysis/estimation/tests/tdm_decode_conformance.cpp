// The $TDM decoder's arithmetic (src/tdm_decode.hpp), checked against values
// worked by hand and against the estimator's own measurement model for the
// same physical case. Exit status 0 only when every check holds.
#include "estimation.hpp"
#include "tdm_decode.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace sdn::estimation;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const char* what, const std::string& detail = "") {
  ++checks;
  if (!ok) {
    ++failures;
    std::fprintf(stderr, "FAIL %s %s\n", what, detail.c_str());
  }
}

bool near(double a, double b, double tolerance) { return std::abs(a - b) <= tolerance; }
std::string show(double v) { char b[64]; std::snprintf(b, sizeof b, "%.17g", v); return b; }

// The request epoch of the test campaign: 2026-10-11T00:00:00 UTC = 00:00:37 TAI.
constexpr double kJd = 2461324.5, kSeconds = 37.0;

tdm::Segment laser_segment() {
  tdm::Segment s;
  s.time_system = "UTC";
  s.timetag_ref = "TRANSMIT";
  s.path = "1,2,1";
  s.carrier_hz = kSpeedOfLight / 532e-9;
  return s;
}

bool decode_row(const tdm::Segment& segment, const char* keyword, const char* epoch, double value, Observation* out,
                std::string* error, const tdm::Weather& weather = {}, const tdm::Row* angle_2 = nullptr) {
  return tdm::decode(segment, {keyword, epoch, value}, angle_2, kJd, kSeconds, weather, out, error);
}

void time_systems() {
  struct Case { const char* system; const char* epoch; };
  // One instant, four labels.
  const Case cases[] = {{"UTC", "2026-10-11T00:00:10.250000000"}, {"TAI", "2026-10-11T00:00:47.250000000"},
                        {"GPS", "2026-10-11T00:00:28.250000000"}, {"TT", "2026-10-11T00:01:19.434000000"}};
  for (const Case& c : cases) {
    tdm::Segment segment = laser_segment();
    segment.time_system = c.system;
    segment.timetag_ref = "RECEIVE";
    Observation o;
    std::string error;
    const bool ok = decode_row(segment, "LASER_RANGE", c.epoch, 1.0, &o, &error);
    check(ok && near(o.epoch_seconds, 10.25, 1e-12), (std::string("time system ") + c.system).c_str(), ok ? show(o.epoch_seconds) : error);
  }
  // The leap second of 2016-12-31: 36 s before it, 37 s after.
  tdm::Instant before, after, tai;
  std::string error;
  tdm::parse_calendar("2016-12-31T23:59:59.000000000", &before);
  tdm::parse_calendar("2017-01-01T00:00:00.000000000", &after);
  tdm::to_tai("UTC", before, &tai, &error);
  check(tai.whole - before.whole == 36, "TAI-UTC is 36 s on 2016-12-31");
  tdm::to_tai("UTC", after, &tai, &error);
  check(tai.whole - after.whole == 37, "TAI-UTC is 37 s on 2017-01-01");
  tdm::parse_calendar("2012-06-30T23:59:60.500000000", &before);  // the leap second itself
  tdm::to_tai("UTC", before, &tai, &error);
  check(tai.whole - before.whole == 34 && near(tai.fraction, 0.5, 1e-12), "TAI-UTC is 34 s inside the 2012 leap second");

  // Refusals.
  tdm::Instant late, early;
  tdm::parse_calendar("2027-06-30T00:00:00", &late);
  tdm::parse_calendar("1971-12-31T23:59:59", &early);
  check(!tdm::to_tai("UTC", late, &tai, &error) && error.find("beyond the leap-second table") != std::string::npos, "UTC at the table horizon is refused", error);
  tdm::parse_calendar("2027-06-29T23:59:59", &late);
  check(tdm::to_tai("UTC", late, &tai, &error) && tai.whole - late.whole == 37, "UTC the day before the horizon is read");
  check(!tdm::to_tai("UTC", early, &tai, &error), "UTC before 1972 is refused", error);
  check(!tdm::to_tai("TDB", after, &tai, &error) && error.find("TDB") != std::string::npos, "TDB is refused", error);
  tdm::Segment none = laser_segment();
  none.time_system = "";
  Observation o;
  check(!decode_row(none, "LASER_RANGE", "2026-10-11T00:00:10", 1.0, &o, &error), "an empty TIME_SYSTEM is refused", error);
}

void time_tags() {
  Observation o;
  std::string error;
  const double r = 1500000.0;  // 1500 km
  // Laser, transmit tag, two-way (also without PATH): reception is the tag plus 2R/c.
  tdm::Segment laser = laser_segment();
  check(decode_row(laser, "LASER_RANGE", "2026-10-11T00:00:10.000000000", r, &o, &error) &&
            near(o.epoch_seconds, 10.0 + 2.0 * r / kSpeedOfLight, 1e-12), "laser transmit tag moves forward by 2R/c", error);
  laser.path.clear();
  check(decode_row(laser, "LASER_RANGE", "2026-10-11T00:00:10.000000000", r, &o, &error) &&
            near(o.epoch_seconds, 10.0 + 2.0 * r / kSpeedOfLight, 1e-12), "a laser range without PATH is two-way", error);
  laser.timetag_ref = "RECEIVE";
  check(decode_row(laser, "LASER_RANGE", "2026-10-11T00:00:10.000000000", r, &o, &error) && near(o.epoch_seconds, 10.0, 1e-12),
        "laser receive tag is the epoch", error);

  // RANGE in km: transmit tag with one-way and two-way PATH.
  tdm::Segment range;
  range.time_system = "UTC"; range.timetag_ref = "TRANSMIT"; range.range_units = "km"; range.path = "1,2,1";
  check(decode_row(range, "RANGE", "2026-10-11T00:00:10", 1500.0, &o, &error) && near(o.value[0], r, 1e-6) &&
            near(o.epoch_seconds, 10.0 + 2.0 * r / kSpeedOfLight, 1e-12), "RANGE km, two-way", error);
  range.path = "1,2";
  check(decode_row(range, "RANGE", "2026-10-11T00:00:10", 1500.0, &o, &error) && near(o.epoch_seconds, 10.0 + r / kSpeedOfLight, 1e-12),
        "RANGE km, one-way", error);
  range.path.clear();
  check(!decode_row(range, "RANGE", "2026-10-11T00:00:10", 1500.0, &o, &error) && error.find("PATH") != std::string::npos,
        "a transmit-tagged RANGE without PATH is refused", error);
  range.path = "1,2,3";
  check(!decode_row(range, "RANGE", "2026-10-11T00:00:10", 1500.0, &o, &error), "a three-way PATH is refused", error);
  range.path = "1,2,1"; range.range_units = "RU";
  check(!decode_row(range, "RANGE", "2026-10-11T00:00:10", 1500.0, &o, &error), "RANGE_UNITS RU is refused", error);

  // The tag itself.
  tdm::Segment tagless = laser_segment();
  tagless.timetag_ref = "";
  check(!decode_row(tagless, "LASER_RANGE", "2026-10-11T00:00:10", r, &o, &error) && error.find("TIMETAG_REF") != std::string::npos,
        "a missing TIMETAG_REF is refused", error);
  tagless.timetag_ref = "MIDDLE";
  check(!decode_row(tagless, "LASER_RANGE", "2026-10-11T00:00:10", r, &o, &error), "an unknown TIMETAG_REF is refused", error);
  tdm::Segment doppler = laser_segment();
  check(!decode_row(doppler, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error), "a transmit-tagged Doppler is refused", error);
}

// A satellite state and a station for the measurement-model checks.
CartesianState satellite() {
  CartesianState s;
  s.value = {7000000.0, 400000.0, 300000.0, -300.0, 7300.0, 1200.0};
  return s;
}

void doppler_and_integration() {
  Observation o;
  std::string error;
  tdm::Segment segment;
  segment.time_system = "UTC"; segment.timetag_ref = "RECEIVE"; segment.path = "1,2,1"; segment.carrier_hz = 2.2e9;
  segment.integration_interval = 10.0; segment.integration_ref = "START";
  check(decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && near(o.epoch_seconds, 15.0, 1e-12),
        "integration START places the epoch at the middle (+T/2)", error);
  segment.integration_ref = "END";
  check(decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && near(o.epoch_seconds, 5.0, 1e-12), "integration END (-T/2)", error);
  segment.integration_ref = "MIDDLE";
  check(decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && near(o.epoch_seconds, 10.0, 1e-12), "integration MIDDLE (0)", error);
  segment.integration_ref = "";
  check(!decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && error.find("INTEGRATION_REF") != std::string::npos,
        "an integration interval without INTEGRATION_REF is refused", error);
  segment.integration_interval = 0.0;

  // The Doppler shift follows the PATH: two-way is twice one-way, both the
  // shift the model predicts for the same state (-2 rate f / c).
  const CartesianState state = satellite();
  const Vec3 station{6378137.0, 0.0, 0.0};
  auto predicted = [&](const char* path) {
    tdm::Segment s = segment;
    s.path = path;
    Observation d;
    check(decode_row(s, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 0.0, &d, &error), "Doppler decodes", error);
    d.station_position_m = station;
    d.apply_light_time = false;
    d.apply_sagnac = false;
    return predict_measurement(d, state).value[0];
  };
  const Vec3 relative{state.value[0] - station.x, state.value[1] - station.y, state.value[2] - station.z};
  const double range = std::sqrt(relative.x * relative.x + relative.y * relative.y + relative.z * relative.z);
  const double rate = (relative.x * state.value[3] + relative.y * state.value[4] + relative.z * state.value[5]) / range;
  const double one_way = -rate * 2.2e9 / kSpeedOfLight;
  check(near(predicted("1,2"), one_way, 1e-9 * std::abs(one_way)), "one-way Doppler is -rate f / c", show(predicted("1,2")) + " vs " + show(one_way));
  check(near(predicted("1,2,1"), 2.0 * one_way, 1e-9 * std::abs(one_way)), "two-way Doppler is twice that", show(predicted("1,2,1")) + " vs " + show(2.0 * one_way));

  // No carrier, no default.
  segment.carrier_hz = 0.0;
  check(!decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && error.find("TRANSMIT_FREQ_1") != std::string::npos,
        "a Doppler without TRANSMIT_FREQ_1 is refused", error);
  segment.path.clear();
  segment.carrier_hz = 2.2e9;
  check(!decode_row(segment, "DOPPLER_INSTANTANEOUS", "2026-10-11T00:00:10", 1.0, &o, &error) && error.find("PATH") != std::string::npos,
        "a Doppler without PATH is refused", error);
}

void angles() {
  Observation o;
  std::string error;
  tdm::Segment segment;
  segment.time_system = "UTC"; segment.timetag_ref = "RECEIVE"; segment.angle_type = "AZEL";
  const tdm::Row dec{"ANGLE_2", "2026-10-11T00:00:10", 45.0};
  check(decode_row(segment, "ANGLE_1", "2026-10-11T00:00:10", 90.0, &o, &error, {}, &dec) && o.kind == MeasurementKind::AZIMUTH_ELEVATION &&
            near(o.value[0], 1.5707963267948966, 1e-15) && near(o.value[1], 0.7853981633974483, 1e-15) && o.value_count == 2,
        "AZEL degrees become radians", error);
  segment.angle_type = "RADEC";
  check(decode_row(segment, "ANGLE_1", "2026-10-11T00:00:10", -6.5, &o, &error, {}, &dec) && o.kind == MeasurementKind::RIGHT_ASCENSION_DECLINATION &&
            near(o.value[0], -6.5 * 3.141592653589793238 / 180.0, 1e-15), "RADEC degrees become radians", error);
  check(!decode_row(segment, "ANGLE_1", "2026-10-11T00:00:10", 10.0, &o, &error) && error.find("ANGLE_2") != std::string::npos,
        "ANGLE_1 without its ANGLE_2 is refused", error);
  segment.timetag_ref = "TRANSMIT";
  check(!decode_row(segment, "ANGLE_1", "2026-10-11T00:00:10", 10.0, &o, &error, {}, &dec), "transmit-tagged angles are refused", error);
}

void weather() {
  tdm::Segment segment = laser_segment();
  segment.timetag_ref = "RECEIVE";
  tdm::Weather weather;
  std::string error;
  const tdm::Row rows[] = {{"PRESSURE", "2026-10-11T00:00:00", 1008.3}, {"TEMPERATURE", "2026-10-11T00:00:00", 281.4}, {"RHUMIDITY", "2026-10-11T00:00:00", 62.0},
                           {"PRESSURE", "2026-10-11T00:16:40", 1002.1}, {"TEMPERATURE", "2026-10-11T00:16:40", 283.0}, {"RHUMIDITY", "2026-10-11T00:16:40", 55.0}};
  for (const tdm::Row& row : rows) check(tdm::add_weather(segment, row, kJd, kSeconds, &weather, &error), "weather row", error);
  Observation early, late;
  check(decode_row(segment, "LASER_RANGE", "2026-10-11T00:06:40", 1.0e6, &early, &error, weather), "early observation", error);   // 400 s: nearer the first
  check(decode_row(segment, "LASER_RANGE", "2026-10-11T00:10:00", 1.0e6, &late, &error, weather), "late observation", error);    // 600 s: nearer the second
  check(near(early.media.pressure_hpa, 1008.3, 0) && near(early.media.temperature_k, 281.4, 0) && near(early.media.relative_humidity, 0.62, 1e-15),
        "the nearer earlier weather row serves the early observation");
  check(near(late.media.pressure_hpa, 1002.1, 0) && near(late.media.temperature_k, 283.0, 0) && near(late.media.relative_humidity, 0.55, 1e-15),
        "the nearer later weather row serves the late observation");
  check(near(early.media.wavelength_m, 532e-9, 1e-15), "the laser wavelength is c over TRANSMIT_FREQ_1", show(early.media.wavelength_m));
  Observation bare;
  check(decode_row(segment, "LASER_RANGE", "2026-10-11T00:06:40", 1.0e6, &bare, &error), "no weather", error);
  check(near(bare.media.pressure_hpa, 1013.25, 0) && near(bare.media.relative_humidity, 0.5, 0), "without weather rows the media keep their defaults");
  tdm::Weather scratch;
  check(!tdm::add_weather(segment, {"RHUMIDITY", "2026-10-11T00:00:00", 120.0}, kJd, kSeconds, &scratch, &error), "humidity above 100 percent is refused", error);
  check(!tdm::add_weather(segment, {"PRESSURE", "2026-10-11T00:00:00", 0.0}, kJd, kSeconds, &scratch, &error), "zero pressure is refused", error);
  check(!tdm::add_weather(segment, {"TEMPERATURE", "2026-10-11T00:00:00", -3.0}, kJd, kSeconds, &scratch, &error), "negative kelvin is refused", error);

  // The troposphere the weather feeds: Marini-Murray at the station's
  // geodetic latitude and height and the signal's true elevation. The station
  // and the satellite are placed from a geodetic position and an east-north-up
  // direction, so the expected inputs come from construction, not from the
  // estimator's own inverse.
  const double lat = 52.0 * 3.141592653589793 / 180.0, lon = 13.0 * 3.141592653589793 / 180.0, height = 120.0;
  const double a = 6378137.0, f = 1.0 / 298.257223563, e2 = f * (2.0 - f);
  const double n = a / std::sqrt(1.0 - e2 * std::sin(lat) * std::sin(lat));
  const Vec3 station{(n + height) * std::cos(lat) * std::cos(lon), (n + height) * std::cos(lat) * std::sin(lon), (n * (1.0 - e2) + height) * std::sin(lat)};
  const Vec3 east{-std::sin(lon), std::cos(lon), 0.0};
  const Vec3 north{-std::sin(lat) * std::cos(lon), -std::sin(lat) * std::sin(lon), std::cos(lat)};
  const Vec3 up{std::cos(lat) * std::cos(lon), std::cos(lat) * std::sin(lon), std::sin(lat)};
  const double elevation = 37.0 * 3.141592653589793 / 180.0, azimuth = 70.0 * 3.141592653589793 / 180.0, range = 1.6e6;
  const double ce = std::cos(elevation);
  const Vec3 los{ce * std::sin(azimuth) * east.x + ce * std::cos(azimuth) * north.x + std::sin(elevation) * up.x,
                 ce * std::sin(azimuth) * east.y + ce * std::cos(azimuth) * north.y + std::sin(elevation) * up.y,
                 ce * std::sin(azimuth) * east.z + ce * std::cos(azimuth) * north.z + std::sin(elevation) * up.z};
  CartesianState state;
  state.value = {station.x + range * los.x, station.y + range * los.y, station.z + range * los.z, 0, 0, 0};
  Observation o = early;
  o.station_position_m = station;
  o.troposphere = TroposphereModel::MARINI;
  o.apply_light_time = false;
  o.apply_sagnac = false;
  const MeasurementPrediction fed = predict_measurement(o, state);
  MediaEnvironment truth;
  truth.latitude_rad = lat; truth.height_m = height; truth.elevation_rad = elevation; truth.wavelength_m = 532e-9;
  truth.pressure_hpa = 1008.3; truth.temperature_k = 281.4; truth.relative_humidity = 0.62;
  const double expected = marini_murray_delay_m(truth);
  check(expected > 3.0 && expected < 8.0, "the Marini-Murray delay at 37 degrees is metres", show(expected));
  check(near(fed.troposphere_m, expected, 2e-6), "the model's troposphere uses the station's latitude, height and the signal's elevation", show(fed.troposphere_m) + " vs " + show(expected));
  o.media.pressure_hpa = 1013.25; o.media.temperature_k = 293.15; o.media.relative_humidity = 0.5;
  check(std::abs(predict_measurement(o, state).troposphere_m - expected) > 1e-3, "other weather gives another delay");
}

}  // namespace

int main() {
  time_systems();
  time_tags();
  doppler_and_integration();
  angles();
  weather();
  std::printf("{\"checks\": %d, \"failures\": %d}\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
