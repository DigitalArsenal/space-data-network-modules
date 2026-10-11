// data-source/ilrs-crd-source: ILRS Consolidated Laser Ranging Data (CRD, version 2) normal points as SDS tracking data.
//
//   read_crd   a CRD v2 file of normal points -> one $TDM per pass (LASER_RANGE observations), and a report
//
// The observation source of the catalog pipeline: the tracking data analysis/estimation takes on `tracking_data`
// (run_estimation reads a segment's LASER_RANGE rows as laser ranges). Pure bytes in, pure bytes out: the download from
// the data centre (EDC, CDDIS), the schedule and the archive belong to the SDN host flow. Errors are flags (an invoke
// error code and message), never exceptions.
//
// Authority: the ILRS Consolidated Laser Ranging Data Format, version 2.01 (https://ilrs.gsfc.nasa.gov/docs/2022/
// crd_v2.01e3.pdf). Record types are read in either case (h4, H4). A file is a stream of passes: H1 (format), H2
// (station), H3 (target), H4 (session) with its configuration and data records, H8 (end of session), and one H9 at the
// end; a file without H9 is truncated and refused whole.
//
// A normal point (record 11) is a two-way time of flight in seconds with the station system delay applied and no
// refraction or centre-of-mass correction. Its observation is the one-way range c x time-of-flight / 2 in metres
// (c = 299 792 458 m/s, exact), the unit analysis/estimation's LASER_RANGE takes, on the epoch the record gives in UTC.
// Which instant the epoch is (the CRD epoch event) is the segment's TIMETAG_REF: ground transmit time (2) is TRANSMIT,
// ground receive time (0) is RECEIVE. Spacecraft bounce time (1) and the one-way events have no TDM time-tag reference,
// so their passes are not read and are counted. Only two-way normal points of a good or suspect pass on a UTC station
// time scale (CRD 3, 4 or 7) are read; every other pass is counted by reason.
//
// A CRD file carries no station coordinates: the pass names its station by the CDP pad, system and occupancy numbers
// (OBSERVER_ID, the SOD), and the host supplies the station's coordinates ($CRD, run_estimation's `laser_tracking`) from the
// ILRS station solution. Meteorological records (20) ride on the first segment as PRESSURE (hPa), TEMPERATURE (K) and
// RHUMIDITY (%), the keywords CCSDS 503.0-B-2 gives them; the statistics of each normal point (raw ranges, bin RMS,
// window) are in the report, where a host takes the range's sigma from them.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using Json = nlohmann::json;

namespace {

constexpr size_t kMaxBytes = 64u * 1024 * 1024;
constexpr size_t kMaxPasses = 4096;
constexpr size_t kMaxPoints = 200000;
constexpr double kSpeedOfLight = 299792458.0;  // m/s, exact

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::vector<std::string> tokens(const std::string& line) {
  std::vector<std::string> out;
  std::istringstream stream(line);
  for (std::string t; stream >> t;) out.push_back(t);
  return out;
}

std::string upper(std::string s) {
  for (char& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return s;
}

bool whole(const std::string& s, long* out) {
  if (s.empty() || s.size() > 9) return false;
  size_t i = s[0] == '-' || s[0] == '+' ? 1 : 0;
  if (i == s.size()) return false;
  for (size_t k = i; k < s.size(); ++k) {
    if (s[k] < '0' || s[k] > '9') return false;
  }
  *out = std::strtol(s.c_str(), nullptr, 10);
  return true;
}

bool real(const std::string& s, double* out) {
  if (s.empty() || s.size() > 40 || s == "na") return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' || c == 'E')) return false;
  }
  char* end = nullptr;
  const double v = std::strtod(s.c_str(), &end);
  if (end != s.c_str() + s.size() || !std::isfinite(v)) return false;
  *out = v;
  return true;
}

// "SSSSS.ffffffffffff" seconds of day, kept as text: the digits the station wrote become the epoch's, with no rounding.
struct SecondsOfDay {
  long whole = 0;
  std::string fraction;  // digits after the point
  double value = 0;
};
bool seconds_of_day(const std::string& s, SecondsOfDay* out) {
  const auto dot = s.find('.');
  const std::string head = s.substr(0, dot);
  if (head.empty() || head.size() > 5 || !sdn_alpha5::is_digits(head, 0, head.size())) return false;
  std::string frac = dot == std::string::npos ? std::string() : s.substr(dot + 1);
  if (!frac.empty() && !sdn_alpha5::is_digits(frac, 0, frac.size())) return false;
  out->whole = std::strtol(head.c_str(), nullptr, 10);
  if (out->whole >= 86400) return false;
  out->fraction = frac;
  out->value = static_cast<double>(out->whole) + (frac.empty() ? 0.0 : std::strtod(("0." + frac).c_str(), nullptr));
  return true;
}

struct Station { std::string name, pad, system, occupancy, network; long time_scale = 0; };
struct Target { std::string name, ilrs_id, sic, norad; long clazz = 0; };
struct Session {
  long data_type = -1, range_type = -1, quality = 0, release = 0;
  bool troposphere = false, centre_of_mass = false, receive_amplitude = false, station_delay = false, spacecraft_delay = false;
  long start[6] = {0, 0, 0, 0, 0, 0};
  bool open = false;
};
struct Point {
  SecondsOfDay sod;
  std::string tof_text, config;
  double tof = 0, window = 0, rms_ps = 0;
  long event = -1, raw = 0;
  bool has_window = false, has_rms = false, has_raw = false;
};
struct Meteo { SecondsOfDay sod; double pressure = 0, temperature = 0, humidity = 0; };
struct Pass {
  Station station;
  Target target;
  Session session;
  std::string created;
  std::map<std::string, double> wavelength_nm;  // by system configuration id
  std::vector<Point> points;
  std::vector<Meteo> meteo;
};

// "YYYY-MM-DDTHH:MM:SS.fffffffff": the pass's start date plus the seconds of day (a pass is under a day long; a time of day
// before the pass's start, beyond a minute of slack, is the next day's), with the station's own fraction digits (nine kept).
std::string epoch_text(const Pass& pass, const SecondsOfDay& sod) {
  const long start_sod = pass.session.start[3] * 3600 + pass.session.start[4] * 60 + pass.session.start[5];
  int64_t day = sdn_time::days_from_civil(pass.session.start[0], pass.session.start[1], pass.session.start[2]);
  if (sod.value < static_cast<double>(start_sod) - 60.0) ++day;
  int64_t y, m, d;
  sdn_time::civil_from_days(day, &y, &m, &d);
  std::string frac = sod.fraction;
  frac.resize(9, '0');
  char out[64];
  std::snprintf(out, sizeof(out), "%04lld-%02lld-%02lldT%02ld:%02ld:%02ld.%s", static_cast<long long>(y), static_cast<long long>(m), static_cast<long long>(d), sod.whole / 3600,
                sod.whole / 60 % 60, sod.whole % 60, frac.c_str());
  return out;
}

std::unique_ptr<TDMObservationT> observation(const char* keyword, const std::string& epoch, double value) {
  auto o = std::make_unique<TDMObservationT>();
  o->KEYWORD = keyword;
  o->EPOCH = epoch;
  o->VALUE = value;
  return o;
}

}  // namespace

extern "C" int read_crd(void) {
  if (plugin_get_input_count() != 1) return fail("invalid-crd", "Exactly one CRD file is required.");
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length || input->payload_length > kMaxBytes) {
    return fail("invalid-crd", "The source must be one bounded CRD version 2 file.");
  }
  const std::string text(reinterpret_cast<const char*>(input->payload), input->payload_length);
  if (text.find('\0') != std::string::npos) return fail("invalid-crd", "The CRD file contains an embedded NUL.");

  std::vector<Pass> passes;
  std::map<std::string, size_t> skipped;  // by reason
  size_t sessions = 0, points = 0, meteo_records = 0;
  Station station;
  Target target;
  std::string created;
  Pass* current = nullptr;
  bool seen_h1 = false, seen_h9 = false;
  std::set<std::string> unknown_types;

  auto close_session = [&]() { current = nullptr; };

  std::istringstream stream(text);
  std::string line;
  size_t line_no = 0;
  while (std::getline(stream, line)) {
    ++line_no;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const auto f = tokens(line);
    if (f.empty()) continue;
    const std::string type = upper(f[0]);
    if (seen_h9 && type != "H9") return fail("invalid-crd", "Records follow the end-of-file footer (line " + std::to_string(line_no) + ").");
    if (type == "H1") {
      long version = 0, y = 0, mo = 0, d = 0, h = 0;
      if (f.size() < 7 || upper(f[1]) != "CRD" || !whole(f[2], &version) || !whole(f[3], &y) || !whole(f[4], &mo) || !whole(f[5], &d) || !whole(f[6], &h)) {
        return fail("invalid-crd", "Line " + std::to_string(line_no) + " is not a CRD format header (H1 CRD <version> <year> <month> <day> <hour>).");
      }
      if (version != 2) return fail("invalid-crd", "Only CRD version 2 is read (line " + std::to_string(line_no) + " states version " + f[2] + ").");
      char buf[32];
      std::snprintf(buf, sizeof(buf), "%04ld-%02ld-%02ldT%02ld:00:00", y, mo, d, h);
      created = buf;
      seen_h1 = true;
      close_session();
    } else if (!seen_h1 && type != "00") {
      return fail("invalid-crd", "The file does not begin with a CRD format header.");
    } else if (type == "H2") {
      long scale = 0;
      if (f.size() < 7 || !whole(f[5], &scale)) return fail("invalid-crd", "Malformed station header at line " + std::to_string(line_no) + ".");
      station = Station{f[1], f[2], f[3], f[4], f[6], scale};
      close_session();
    } else if (type == "H3") {
      long cls = 0;
      if (f.size() < 8 || !whole(f[6], &cls)) return fail("invalid-crd", "Malformed target header at line " + std::to_string(line_no) + ".");
      target = Target{f[1], f[2], f[3], f[4], cls};
      close_session();
    } else if (type == "H4") {
      Session s;
      if (f.size() < 22 || !whole(f[1], &s.data_type)) return fail("invalid-crd", "Malformed session header at line " + std::to_string(line_no) + ".");
      for (int k = 0; k < 6; ++k) {
        if (!whole(f[2 + k], &s.start[k])) return fail("invalid-crd", "The session start time at line " + std::to_string(line_no) + " is unreadable.");
      }
      if (!sdn_time::valid_date(s.start[0], s.start[1], s.start[2]) || s.start[3] > 23 || s.start[4] > 59 || s.start[5] > 60) {
        return fail("invalid-crd", "The session start time at line " + std::to_string(line_no) + " is not a time.");
      }
      long flags[8] = {0, 0, 0, 0, 0, 0, 0, 0};
      for (int k = 0; k < 8; ++k) {
        if (!whole(f[14 + k], &flags[k])) return fail("invalid-crd", "A session flag at line " + std::to_string(line_no) + " is unreadable.");
      }
      s.release = flags[0];
      s.troposphere = flags[1] == 1;
      s.centre_of_mass = flags[2] == 1;
      s.receive_amplitude = flags[3] == 1;
      s.station_delay = flags[4] == 1;
      s.spacecraft_delay = flags[5] == 1;
      s.range_type = flags[6];
      s.quality = flags[7];
      s.open = true;
      ++sessions;
      // The pass is read only when its normal points are usable as laser ranges; the reason it is not is counted.
      const char* why = nullptr;
      if (s.data_type != 1) why = "not a normal point session (full rate or sampled engineering)";
      else if (s.range_type != 2) why = "not two-way ranging";
      else if (station.time_scale != 3 && station.time_scale != 4 && station.time_scale != 7) why = "station time scale is not UTC (CRD 3, 4 or 7)";
      else if (!s.station_delay) why = "station system delay not applied";
      else if (s.quality >= 2) why = "poor or unknown data quality";
      if (why) {
        ++skipped[why];
        current = nullptr;
      } else {
        if (passes.size() >= kMaxPasses) return fail("invalid-crd", "The file has more than 4,096 passes.");
        passes.push_back(Pass{station, target, s, created, {}, {}, {}});
        current = &passes.back();
      }
    } else if (type == "C0") {
      double nm = 0;
      if (current && f.size() >= 4 && real(f[2], &nm) && nm > 0) current->wavelength_nm[f[3]] = nm;
    } else if (type == "11") {
      ++points;
      if (!current) continue;
      if (f.size() < 14) return fail("invalid-crd", "Malformed normal point at line " + std::to_string(line_no) + ".");
      Point p;
      if (!seconds_of_day(f[1], &p.sod) || !real(f[2], &p.tof) || !(p.tof > 0 && p.tof < 10) || !whole(f[4], &p.event)) {
        return fail("invalid-crd", "Malformed normal point at line " + std::to_string(line_no) + ": seconds of day, time of flight and epoch event are required.");
      }
      p.tof_text = f[2];
      p.config = f[3];
      p.has_window = real(f[5], &p.window);
      long raw = 0;
      p.has_raw = whole(f[6], &raw);
      p.raw = raw;
      p.has_rms = real(f[7], &p.rms_ps);
      if (p.event != 0 && p.event != 2) {
        // One pass has one time-tag reference: a normal point with another epoch event drops its pass, counted.
        ++skipped["epoch event is not ground transmit (2) or ground receive (0)"];
        passes.pop_back();
        current = nullptr;
        continue;
      }
      if (!current->points.empty() && current->points.front().event != p.event) {
        ++skipped["a pass mixes epoch events"];
        passes.pop_back();
        current = nullptr;
        continue;
      }
      if (current->points.size() >= kMaxPoints) return fail("invalid-crd", "A pass has more than 200,000 normal points.");
      current->points.push_back(std::move(p));
    } else if (type == "20") {
      if (!current) continue;
      Meteo m;
      if (f.size() >= 5 && seconds_of_day(f[1], &m.sod) && real(f[2], &m.pressure) && real(f[3], &m.temperature) && real(f[4], &m.humidity) && m.pressure > 0 && m.temperature > 0) {
        current->meteo.push_back(m);
        ++meteo_records;
      }
    } else if (type == "H8") {
      close_session();
    } else if (type == "H9") {
      seen_h9 = true;
      close_session();
    } else if (type == "H5" || type == "C1" || type == "C2" || type == "C3" || type == "C4" || type == "C5" || type == "C6" || type == "C7" || type == "10" || type == "12" || type == "21" ||
               type == "30" || type == "40" || type == "41" || type == "42" || type == "50" || type == "60" || type == "00") {
      continue;
    } else {
      unknown_types.insert(type);
    }
  }
  if (!seen_h1) return fail("invalid-crd", "The file has no CRD format header.");
  if (!seen_h9) return fail("invalid-crd", "The file has no end-of-file footer (H9): it is truncated.");

  // One TDM per pass; a pass with several system configurations (wavelengths) has one segment each.
  std::vector<std::vector<uint8_t>> messages;
  Json summary = Json::array();
  size_t read_points = 0;
  Json normal_points = Json::array();
  for (const Pass& pass : passes) {
    if (pass.points.empty()) {
      ++skipped["no normal points"];
      continue;
    }
    TDMT tdm;
    // The CDDIS site occupancy designator: the CDP pad (4 digits), system (2) and occupancy (2), each zero-padded.
    auto padded = [](const std::string& value, size_t width) { return value.size() >= width ? value : std::string(width - value.size(), '0') + value; };
    tdm.OBSERVER_ID = padded(pass.station.pad, 4) + padded(pass.station.system, 2) + padded(pass.station.occupancy, 2);
    tdm.CCSDS_TDM_VERS = "2.0";
    tdm.CREATION_DATE = pass.created;
    tdm.ORIGINATOR = pass.station.name + " (" + pass.station.network + ")";
    std::vector<std::string> configs;
    for (const Point& p : pass.points) {
      if (std::find(configs.begin(), configs.end(), p.config) == configs.end()) configs.push_back(p.config);
    }
    const std::string first = epoch_text(pass, pass.points.front().sod);
    const std::string last = epoch_text(pass, pass.points.back().sod);
    char start_buf[40];
    std::snprintf(start_buf, sizeof(start_buf), "%04ld-%02ld-%02ldT%02ld:%02ld:%02ld", pass.session.start[0], pass.session.start[1], pass.session.start[2], pass.session.start[3], pass.session.start[4],
                  pass.session.start[5]);
    const long event = pass.points.front().event;
    for (const std::string& config : configs) {
      auto segment = std::make_unique<TDMSegmentT>();
      segment->TIME_SYSTEM = "UTC";
      segment->PARTICIPANT_1 = pass.station.name;
      segment->PARTICIPANT_2 = pass.target.name;
      segment->MODE = "SINGLE_TRACK";
      segment->PATH = "1,2,1";
      segment->TIMETAG_REF = event == 2 ? "TRANSMIT" : "RECEIVE";
      segment->DATA_QUALITY = pass.session.quality == 0 ? "VALIDATED" : "DEGRADED";
      segment->TRACK_ID = pass.station.name + " " + pass.target.name + " " + start_buf;
      segment->DATA_TYPES = "LASER_RANGE";
      const auto wl = pass.wavelength_nm.find(config);
      if (wl != pass.wavelength_nm.end()) segment->TRANSMIT_FREQ_1 = kSpeedOfLight / (wl->second * 1.0e-9);
      segment->COMMENT = {
          "CRD " + pass.station.name + " CDP pad " + pass.station.pad + " system " + pass.station.system + " occupancy " + pass.station.occupancy + ", station time scale " +
              std::to_string(pass.station.time_scale) + " (UTC); target " + pass.target.name + " ILRS id " + pass.target.ilrs_id + " NORAD " + pass.target.norad +
              (wl != pass.wavelength_nm.end() ? "; wavelength " + std::to_string(static_cast<long>(std::llround(wl->second * 1000.0))) + " pm" : std::string()),
          std::string("LASER_RANGE: one-way range in metres = c x two-way time of flight / 2, c = 299792458 m/s; station system delay applied, tropospheric refraction applied: ") +
              (pass.session.troposphere ? "yes" : "no") + ", centre of mass applied: " + (pass.session.centre_of_mass ? "yes" : "no"),
          "System configuration " + config + "; the station coordinates are not in a CRD file: supply the SLRF/ITRF solution of the pad as laser_tracking"};
      for (const Point& p : pass.points) {
        if (p.config != config) continue;
        segment->OBSERVATIONS.push_back(observation("LASER_RANGE", epoch_text(pass, p.sod), p.tof * kSpeedOfLight / 2.0));
        ++read_points;
        normal_points.push_back({pass.station.name + "/" + pass.target.name + "/" + start_buf, epoch_text(pass, p.sod), p.tof_text, p.has_raw ? Json(p.raw) : Json(nullptr), p.has_rms ? Json(p.rms_ps) : Json(nullptr),
                                 p.has_window ? Json(p.window) : Json(nullptr), config});
      }
      if (&config == &configs.front()) {
        for (const Meteo& m : pass.meteo) {
          const std::string at = epoch_text(pass, m.sod);
          segment->OBSERVATIONS.push_back(observation("PRESSURE", at, m.pressure));
          segment->OBSERVATIONS.push_back(observation("TEMPERATURE", at, m.temperature));
          segment->OBSERVATIONS.push_back(observation("RHUMIDITY", at, m.humidity));
        }
      }
      segment->START_TIME = first;
      segment->STOP_TIME = last;
      tdm.SEGMENTS.push_back(std::move(segment));
    }
    flatbuffers::FlatBufferBuilder fbb(4096);
    FinishTDMBuffer(fbb, CreateTDM(fbb, &tdm));
    messages.emplace_back(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    summary.push_back({{"station", pass.station.name}, {"sod", tdm.OBSERVER_ID}, {"target", pass.target.name}, {"norad", pass.target.norad}, {"start", start_buf},
                       {"normalPoints", pass.points.size()}, {"configurations", configs.size()}, {"epochEvent", event}, {"meteorologicalRecords", pass.meteo.size()}});
  }
  if (messages.empty()) return fail("invalid-crd", "The file has no normal point pass that can be read as laser ranges.");
  Json reasons = Json::object();
  for (const auto& entry : skipped) reasons[entry.first] = entry.second;
  Json unknown = Json::array();
  for (const auto& t : unknown_types) unknown.push_back(t);
  const Json report = {{"version", 1}, {"source", "ilrs-crd"}, {"format", "CRD 2"}, {"sessions", sessions}, {"passesRead", messages.size()}, {"normalPointsInFile", points}, {"normalPointsRead", read_points},
                       {"meteorologicalRecords", meteo_records}, {"sessionsSkipped", reasons}, {"unknownRecordTypes", unknown}, {"speedOfLightMetresPerSecond", kSpeedOfLight},
                       {"passes", summary}, {"normalPointColumns", {"pass", "epoch", "timeOfFlightSeconds", "rawRanges", "binRmsPs", "windowSeconds", "configuration"}}, {"normalPoints", normal_points}};
  const std::string report_text = report.dump();
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(report_text.data()),
                            static_cast<uint32_t>(report_text.size())) < 0) {
    return 1;
  }
  for (const auto& message : messages) {
    if (plugin_push_output_ex("observations", "TDM.fbs", "$TDM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "TDM", 0, 0, message.data(), static_cast<uint32_t>(message.size())) < 0) return 1;
  }
  return 0;
}
